//! Tauri invoke wrappers for tooling, code workspace, and power features.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;

use crate::code_workspace;
use crate::cw_checkpoints;
use crate::cw_ocr;
use crate::cw_pdf_pages;
use crate::cw_plans;
use crate::cw_symbol_index;
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

/// `for_ui = true` allows the editor preview line cap; agent calls must leave it false/None.
#[tauri::command]
pub async fn cw_read_file(
    workspace_root: String,
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    for_ui: Option<bool>,
) -> AppResult<String> {
    let line_cap = if for_ui.unwrap_or(false) {
        Some(code_workspace::READ_UI_MAX_LINES)
    } else {
        Some(code_workspace::READ_MAX_LINES)
    };
    // Missing/0 limit → default window inside read_file (never whole file).
    code_workspace::read_file(
        Path::new(workspace_root.trim()),
        &path,
        offset.unwrap_or(0),
        limit.unwrap_or(0),
        line_cap,
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
    language: Option<String>,
    script: Option<String>,
    args: Option<Vec<String>>,
    argv: Option<Vec<String>>,
) -> AppResult<code_workspace::SandboxRunResult> {
    code_workspace::run_sandbox_request(
        Path::new(workspace_root.trim()),
        language,
        script,
        args,
        argv,
    )
    .await
}

#[tauri::command]
pub async fn cw_list_runners() -> AppResult<code_workspace::RunnersStatus> {
    Ok(code_workspace::list_runners())
}

#[tauri::command]
pub async fn cw_delete_file(workspace_root: String, path: String) -> AppResult<()> {
    code_workspace::delete_file(Path::new(workspace_root.trim()), &path)
}

#[tauri::command]
pub async fn cw_checkpoint_begin(workspace_root: String) -> AppResult<String> {
    cw_checkpoints::begin_checkpoint(Path::new(workspace_root.trim()))
}

#[tauri::command]
pub async fn cw_checkpoint_snapshot_write(
    workspace_root: String,
    run_id: String,
    path: String,
) -> AppResult<()> {
    cw_checkpoints::snapshot_before_write(Path::new(workspace_root.trim()), &run_id, &path)
}

#[tauri::command]
pub async fn cw_checkpoint_snapshot_delete(
    workspace_root: String,
    run_id: String,
    path: String,
) -> AppResult<()> {
    cw_checkpoints::snapshot_before_delete(Path::new(workspace_root.trim()), &run_id, &path)
}

#[tauri::command]
pub async fn cw_list_checkpoints(
    workspace_root: String,
) -> AppResult<Vec<cw_checkpoints::CheckpointSummary>> {
    cw_checkpoints::list_checkpoints(Path::new(workspace_root.trim()))
}

#[tauri::command]
pub async fn cw_restore_checkpoint(workspace_root: String, run_id: String) -> AppResult<usize> {
    cw_checkpoints::restore_checkpoint(Path::new(workspace_root.trim()), &run_id)
}

#[tauri::command]
pub async fn cw_restore_checkpoint_file(
    workspace_root: String,
    run_id: String,
    path: String,
) -> AppResult<()> {
    cw_checkpoints::restore_file(Path::new(workspace_root.trim()), &run_id, &path)
}

#[tauri::command]
pub async fn cw_checkpoint_manifest(
    workspace_root: String,
    run_id: String,
) -> AppResult<cw_checkpoints::CheckpointManifest> {
    cw_checkpoints::get_manifest(Path::new(workspace_root.trim()), &run_id)
}

#[tauri::command]
pub async fn cw_ensure_symbol_index(workspace_root: String) -> AppResult<(usize, usize)> {
    cw_symbol_index::ensure_index(Path::new(workspace_root.trim()))
}

#[tauri::command]
pub async fn cw_repo_map(workspace_root: String) -> AppResult<String> {
    cw_symbol_index::repo_map(Path::new(workspace_root.trim()))
}

#[tauri::command]
pub async fn cw_find_symbol(
    workspace_root: String,
    query: String,
) -> AppResult<Vec<cw_symbol_index::SymbolHit>> {
    cw_symbol_index::find_symbol(Path::new(workspace_root.trim()), &query)
}

#[tauri::command]
pub async fn cw_read_symbol(
    workspace_root: String,
    path: String,
    name: String,
    line_start: Option<i32>,
) -> AppResult<String> {
    cw_symbol_index::read_symbol(
        Path::new(workspace_root.trim()),
        &path,
        &name,
        line_start,
    )
}

#[tauri::command]
pub async fn cw_plan_write(
    workspace_root: String,
    id: Option<String>,
    title: String,
    markdown: String,
    todos: Vec<String>,
    status: Option<String>,
) -> AppResult<cw_plans::PocketCodePlan> {
    cw_plans::write_plan(
        Path::new(workspace_root.trim()),
        id,
        title,
        markdown,
        todos,
        status,
    )
}

#[tauri::command]
pub async fn cw_plan_read(workspace_root: String, id: String) -> AppResult<cw_plans::PocketCodePlan> {
    cw_plans::read_plan(Path::new(workspace_root.trim()), &id)
}

#[tauri::command]
pub async fn cw_plan_list(workspace_root: String) -> AppResult<Vec<cw_plans::PlanSummary>> {
    cw_plans::list_plans(Path::new(workspace_root.trim()))
}

#[tauri::command]
pub async fn cw_plan_update_markdown(
    workspace_root: String,
    id: String,
    markdown: String,
    todos: Option<Vec<cw_plans::PlanTodo>>,
) -> AppResult<cw_plans::PocketCodePlan> {
    cw_plans::update_plan_markdown(Path::new(workspace_root.trim()), &id, markdown, todos)
}

#[tauri::command]
pub async fn cw_plan_update_status(
    workspace_root: String,
    id: String,
    status: String,
    checkpoint_run_id: Option<String>,
) -> AppResult<cw_plans::PocketCodePlan> {
    cw_plans::update_plan_status(
        Path::new(workspace_root.trim()),
        &id,
        &status,
        checkpoint_run_id,
    )
}

#[tauri::command]
pub async fn cw_ocr_image(path: String) -> AppResult<cw_ocr::OcrResult> {
    cw_ocr::ocr_image(&path).await
}

#[tauri::command]
pub async fn cw_image_base64(path: String) -> AppResult<(String, String)> {
    cw_ocr::image_to_base64(&path)
}

#[tauri::command]
pub async fn cw_pdf_page_images(
    path: String,
    max_pages: Option<u32>,
) -> AppResult<Vec<cw_pdf_pages::PdfPageImage>> {
    let n = max_pages.unwrap_or(3) as usize;
    tauri::async_runtime::spawn_blocking(move || cw_pdf_pages::pdf_page_images(&path, n))
        .await
        .map_err(|e| AppError::Unknown(format!("PDF page render task failed: {e}")))?
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalVisionReady {
    pub path: String,
    pub mmproj: Option<String>,
    pub ready: bool,
}

#[tauri::command]
pub async fn local_model_vision_ready(path: String) -> AppResult<LocalVisionReady> {
    let mmproj = crate::llm::local::find_mmproj_for_model(&path);
    Ok(LocalVisionReady {
        ready: mmproj.is_some(),
        mmproj,
        path,
    })
}

/// Transcribe short audio via OpenAI Whisper (`whisper-1`) using the stored OpenAI API key.
#[tauri::command]
pub async fn cw_whisper_transcribe(
    state: State<'_, AppState>,
    audio_base64: String,
    mime: Option<String>,
    language: Option<String>,
) -> AppResult<String> {
    use base64::Engine as _;
    let encrypted = {
        let db = state.db.lock().await;
        db.get_api_key("openai")
            .map_err(|e| AppError::Unknown(format!("OpenAI key lookup failed: {e}")))?
            .ok_or_else(|| {
                AppError::Unknown(
                    "No OpenAI API key saved. Add one in Settings → Providers, or use browser voice.".to_string(),
                )
            })?
    };
    let api_key = state.crypto.decrypt(&encrypted)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.trim())
        .map_err(|e| AppError::Unknown(format!("Invalid audio base64: {e}")))?;
    if bytes.len() < 400 {
        return Err(AppError::Unknown("Audio clip too short.".to_string()));
    }
    if bytes.len() > 25 * 1024 * 1024 {
        return Err(AppError::Unknown("Audio clip too large for Whisper.".to_string()));
    }
    let mime = mime.unwrap_or_else(|| "audio/webm".to_string());
    let ext = if mime.contains("wav") {
        "wav"
    } else if mime.contains("mp4") || mime.contains("m4a") {
        "m4a"
    } else if mime.contains("mpeg") || mime.contains("mp3") {
        "mp3"
    } else {
        "webm"
    };
    let lang = language.unwrap_or_else(|| "en".to_string());
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(format!("dictate.{ext}"))
        .mime_str(if mime.trim().is_empty() { "audio/webm" } else { mime.as_str() })
        .map_err(|e| AppError::Unknown(format!("Audio mime error: {e}")))?;

    let form = reqwest::multipart::Form::new()
        .text("model", "whisper-1")
        .text("language", lang)
        .text("response_format", "json")
        .part("file", part);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| AppError::Unknown(format!("HTTP client error: {e}")))?;

    let response = client
        .post("https://api.openai.com/v1/audio/transcriptions")
        .bearer_auth(api_key.trim())
        .multipart(form)
        .send()
        .await
        .map_err(|e| AppError::Unknown(format!("Whisper request failed: {e}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(AppError::Unknown(format!("Whisper HTTP {status}: {text}")));
    }
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| AppError::Unknown(format!("Whisper response parse failed: {e}")))?;
    let text = json
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        return Err(AppError::Unknown("Whisper returned empty transcript.".to_string()));
    }
    Ok(text)
}

#[tauri::command]
pub async fn cw_list_skills(workspace_root: Option<String>) -> AppResult<Vec<crate::cw_skills::SkillInfo>> {
    tauri::async_runtime::spawn_blocking(move || crate::cw_skills::list_skills(workspace_root))
        .await
        .map_err(|e| AppError::Unknown(format!("list skills task failed: {e}")))?
}

#[tauri::command]
pub async fn cw_read_skill(path: String) -> AppResult<crate::cw_skills::SkillInfo> {
    tauri::async_runtime::spawn_blocking(move || crate::cw_skills::read_skill(path))
        .await
        .map_err(|e| AppError::Unknown(format!("read skill task failed: {e}")))?
}

#[tauri::command]
pub async fn cw_skills_dirs(workspace_root: Option<String>) -> AppResult<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || crate::cw_skills::skills_dir_paths(workspace_root))
        .await
        .map_err(|e| AppError::Unknown(format!("skills dirs task failed: {e}")))?
}

#[tauri::command]
pub async fn mcp_list_servers() -> AppResult<Vec<crate::mcp_host::McpServerStatus>> {
    Ok(crate::mcp_host::global_mcp_host().list_servers().await)
}

#[tauri::command]
pub async fn mcp_get_config() -> AppResult<crate::mcp_host::McpConfigFile> {
    Ok(crate::mcp_host::global_mcp_host().get_config().await)
}

#[tauri::command]
pub async fn mcp_save_config(config: crate::mcp_host::McpConfigFile) -> AppResult<()> {
    crate::mcp_host::global_mcp_host().save_config(config).await
}

#[tauri::command]
pub async fn mcp_list_tools(enabled_ids: Vec<String>) -> AppResult<Vec<crate::mcp_host::McpToolInfo>> {
    Ok(crate::mcp_host::global_mcp_host().list_tools(&enabled_ids).await)
}

#[tauri::command]
pub async fn mcp_call_tool(
    server: String,
    tool: String,
    arguments: Option<serde_json::Value>,
) -> AppResult<String> {
    crate::mcp_host::global_mcp_host()
        .call_tool(
            &server,
            &tool,
            arguments.unwrap_or(serde_json::json!({})),
        )
        .await
}

#[tauri::command]
pub async fn mcp_test_server(id: String) -> AppResult<Vec<crate::mcp_host::McpToolInfo>> {
    crate::mcp_host::global_mcp_host().test_server(&id).await
}

#[tauri::command]
pub async fn mcp_config_path() -> AppResult<String> {
    Ok(crate::mcp_host::mcp_config_path_string())
}

#[tauri::command]
pub async fn mcp_setup_cursor_bridge(
    workspace_root: String,
) -> AppResult<crate::mcp_host::McpCursorBridgeResult> {
    crate::mcp_host::setup_cursor_bridge(workspace_root).await
}

#[tauri::command]
pub async fn mcp_export_to_cursor(workspace_root: String) -> AppResult<String> {
    crate::mcp_host::export_to_cursor(workspace_root).await
}

#[tauri::command]
pub async fn mcp_cursor_paths(workspace_root: Option<String>) -> AppResult<Vec<String>> {
    Ok(crate::mcp_host::cursor_mcp_paths(workspace_root))
}
