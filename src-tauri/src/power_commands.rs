//! Tauri invoke wrappers for tooling, code workspace, and power features.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;

use crate::code_workspace;
use crate::commands::{self, AppState, BackupData};
use crate::deployment;
use crate::error::{AppError, AppResult};
use crate::power_features::{
    self, BatchFileResult, IntegrityResult, OrphanItem, WorkspaceProfile,
};
use crate::tooling::{self, ToolingStatus};

#[derive(Debug, Clone, Serialize)]
pub struct CwCanUseResult {
    pub allowed: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupScheduleConfig {
    pub enabled: bool,
    pub hours: u64,
    pub dest_dir: String,
    pub last_run_unix: Option<u64>,
    pub last_status: Option<String>,
}

fn backup_timestamp_filename() -> String {
    format!(
        "pocketmind-backup-{}.pmbak",
        chrono::Local::now().format("%Y%m%d-%H%M")
    )
}

fn resolve_active_local_model(db: &crate::database::Database) -> Option<String> {
    let conv_id = db.get_last_active_conversation().ok().flatten()?;
    db.conn()
        .query_row(
            "SELECT model_id FROM conversations WHERE id = ?1",
            rusqlite::params![conv_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
        .filter(|m| {
            let m = m.trim();
            !m.is_empty()
                && !m.starts_with("remote:")
                && !m.starts_with("enterprise:")
                && (m.ends_with(".gguf") || Path::new(m).is_file())
        })
}

pub(crate) fn run_encrypted_backup_to_dir(
    db: &crate::database::Database,
    dest_dir: &str,
    passphrase: &str,
) -> AppResult<String> {
    let dest = dest_dir.trim();
    if dest.is_empty() {
        return Err(AppError::Unknown("Backup destination directory is required.".into()));
    }
    let backup = commands::build_backup_data(db)?;
    let json = serde_json::to_string(&backup)
        .map_err(|e| AppError::Unknown(format!("Failed to serialize backup: {e}")))?;
    let path = PathBuf::from(dest).join(backup_timestamp_filename());
    power_features::write_encrypted_backup(&path, &json, passphrase)
}

pub async fn tick_backup_scheduler(db: Arc<Mutex<crate::database::Database>>) {
    let tick = async {
        let db = db.lock().await;
        let (enabled, hours, dest) = power_features::backup_schedule_get(&db)?;
        if !enabled {
            return Ok::<(), AppError>(());
        }
        if dest.trim().is_empty() {
            log::info!("Scheduled backup skipped: backup.dest_dir is not set.");
            return Ok(());
        }
        let passphrase = match db.get_setting("backup.passphrase")? {
            Some(p) if p.trim().len() >= 8 => p,
            _ => {
                log::info!("Scheduled backup skipped: backup.passphrase not configured.");
                return Ok(());
            }
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let last_run = db
            .get_setting("backup.last_run_unix")?
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let interval_secs = hours.max(1) * 3600;
        if now.saturating_sub(last_run) < interval_secs {
            return Ok(());
        }
        let out_path = run_encrypted_backup_to_dir(&db, &dest, &passphrase)?;
        db.set_setting("backup.last_run_unix", &now.to_string())?;
        db.set_setting("backup.last_status", &format!("ok:{out_path}"))?;
        log::info!("Scheduled encrypted backup written to {out_path}");
        Ok(())
    };

    if let Err(err) = tick.await {
        log::warn!("Scheduled backup failed: {err}");
        let db = db.lock().await;
        let _ = db.set_setting("backup.last_status", &format!("error:{err}"));
    }
}

// ── Tooling ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn tooling_status() -> AppResult<ToolingStatus> {
    Ok(tooling::status())
}

#[tauri::command]
pub async fn tooling_repair() -> AppResult<ToolingStatus> {
    tooling::repair_tooling().map_err(|e| AppError::Unknown(e))
}

// ── Workspace profiles ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_workspace_profiles(
    state: State<'_, AppState>,
) -> AppResult<Vec<WorkspaceProfile>> {
    let db = state.db.lock().await;
    power_features::list_profiles(&db)
}

#[tauri::command]
pub async fn create_workspace_profile(
    state: State<'_, AppState>,
    name: String,
) -> AppResult<WorkspaceProfile> {
    let db = state.db.lock().await;
    power_features::create_profile(&db, &name)
}

#[tauri::command]
pub async fn switch_workspace_profile(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let db = state.db.lock().await;
    power_features::set_active_profile(&db, &id)
}

#[tauri::command]
pub async fn delete_workspace_profile(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let db = state.db.lock().await;
    power_features::delete_profile(&db, &id)
}

#[tauri::command]
pub async fn get_active_workspace_profile(
    state: State<'_, AppState>,
) -> AppResult<String> {
    let db = state.db.lock().await;
    power_features::active_profile_id(&db)
}

// ── Backup schedule & encrypted backup ──────────────────────────────────────

#[tauri::command]
pub async fn configure_backup_schedule(
    state: State<'_, AppState>,
    enabled: bool,
    hours: u64,
    dest_dir: String,
) -> AppResult<()> {
    let db = state.db.lock().await;
    power_features::backup_schedule_set(&db, enabled, hours, &dest_dir)
}

#[tauri::command]
pub async fn get_backup_schedule(state: State<'_, AppState>) -> AppResult<BackupScheduleConfig> {
    let db = state.db.lock().await;
    let (enabled, hours, dest_dir) = power_features::backup_schedule_get(&db)?;
    let last_run_unix = db
        .get_setting("backup.last_run_unix")?
        .and_then(|v| v.parse().ok());
    let last_status = db.get_setting("backup.last_status")?;
    Ok(BackupScheduleConfig {
        enabled,
        hours,
        dest_dir,
        last_run_unix,
        last_status,
    })
}

#[tauri::command]
pub async fn run_encrypted_backup(
    state: State<'_, AppState>,
    dest_dir: String,
    passphrase: String,
) -> AppResult<String> {
    let db = state.db.lock().await;
    let path = run_encrypted_backup_to_dir(&db, &dest_dir, &passphrase)?;
    drop(db);
    commands::record_audit(
        &state,
        "backup.encrypted_export",
        "backup",
        "Encrypted backup written",
        Some(path.clone()),
        None,
        true,
    )
    .await;
    Ok(path)
}

#[tauri::command]
pub async fn restore_encrypted_backup(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> AppResult<String> {
    let json = power_features::read_encrypted_backup(Path::new(path.trim()), &passphrase)?;
    let backup: BackupData = serde_json::from_str(&json)
        .map_err(|e| AppError::Unknown(format!("Invalid backup JSON: {e}")))?;
    let db = state.db.lock().await;
    let summary = commands::apply_backup_data(&db, &backup)?;
    drop(db);
    commands::record_audit(
        &state,
        "backup.encrypted_import",
        "backup",
        "Encrypted backup restored",
        Some(summary.clone()),
        None,
        true,
    )
    .await;
    Ok(summary)
}

// ── Model integrity & orphan cleanup ────────────────────────────────────────

#[tauri::command]
pub async fn verify_local_model_integrity(
    state: State<'_, AppState>,
    path: String,
    expected_hex: Option<String>,
) -> AppResult<IntegrityResult> {
    let result = power_features::verify_model_integrity(
        Path::new(path.trim()),
        expected_hex.as_deref(),
    )?;
    // Persist computed hash for future drift checks when the path matches a library model.
    let db = state.db.lock().await;
    let _ = power_features::ensure_profile_schema(&db);
    let _ = db.conn().execute(
        "UPDATE models SET sha256 = ?1 WHERE path = ?2",
        rusqlite::params![&result.sha256, path.trim()],
    );
    Ok(result)
}

#[tauri::command]
pub async fn scan_orphan_files(state: State<'_, AppState>) -> AppResult<Vec<OrphanItem>> {
    let db = state.db.lock().await;
    let config = deployment::load_deployment_config(&db);
    let models_dir = PathBuf::from(&config.models_dir);
    let known_paths: Vec<String> = db
        .get_models()?
        .into_iter()
        .map(|m| m.path)
        .collect();
    let active_model = resolve_active_local_model(&db);
    power_features::scan_orphans(
        &models_dir,
        &known_paths,
        active_model.as_deref(),
    )
}

#[tauri::command]
pub async fn delete_orphan_files(paths: Vec<String>) -> AppResult<usize> {
    power_features::delete_orphan_paths(&paths)
}

#[tauri::command]
pub async fn batch_process_folder(
    root: String,
    max_files: usize,
) -> AppResult<Vec<BatchFileResult>> {
    let max_files = max_files.clamp(1, 500);
    power_features::batch_extract_summaries(Path::new(root.trim()), max_files)
}

// ── Code workspace ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn cw_can_use(model_path: String, params: Option<f32>) -> AppResult<CwCanUseResult> {
    let (allowed, message) = code_workspace::can_use_code_workspace(&model_path, params);
    Ok(CwCanUseResult { allowed, message })
}

#[tauri::command]
pub async fn cw_list_dir(
    workspace_root: String,
    rel: String,
) -> AppResult<Vec<code_workspace::DirEntryInfo>> {
    code_workspace::list_dir(Path::new(workspace_root.trim()), &rel)
}

#[tauri::command]
pub async fn cw_glob(workspace_root: String, pattern: String) -> AppResult<Vec<String>> {
    code_workspace::glob_file_search(Path::new(workspace_root.trim()), &pattern)
}

#[tauri::command]
pub async fn cw_grep(
    workspace_root: String,
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    case_insensitive: bool,
) -> AppResult<String> {
    code_workspace::grep(
        Path::new(workspace_root.trim()),
        &pattern,
        path.as_deref(),
        glob.as_deref(),
        case_insensitive,
    )
    .await
}

#[tauri::command]
pub async fn cw_read_file(
    workspace_root: String,
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> AppResult<String> {
    code_workspace::read_file(
        Path::new(workspace_root.trim()),
        &path,
        offset.unwrap_or(0),
        limit.unwrap_or(0),
    )
}

#[tauri::command]
pub async fn cw_apply_edit_preview(
    workspace_root: String,
    path: String,
    old_string: String,
    new_string: String,
) -> AppResult<code_workspace::EditPreview> {
    code_workspace::apply_edit_preview(
        Path::new(workspace_root.trim()),
        &path,
        &old_string,
        &new_string,
    )
}

#[tauri::command]
pub async fn cw_apply_edit_write(
    workspace_root: String,
    path: String,
    content: String,
) -> AppResult<()> {
    code_workspace::apply_edit_write(Path::new(workspace_root.trim()), &path, &content)
}

#[tauri::command]
pub async fn cw_run_sandbox(
    workspace_root: String,
    language: String,
    script: String,
    args: Option<Vec<String>>,
) -> AppResult<code_workspace::SandboxRunResult> {
    code_workspace::run_sandbox(
        Path::new(workspace_root.trim()),
        &language,
        script,
        args,
    )
    .await
}
