//! PocketCode agent run checkpoints — pre-images for revert.

use crate::code_workspace::{resolve_under_root, standardize};
use crate::error::{AppError, AppResult};
use pocketcode_workspace::WorkspaceSidecar;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const CHECKPOINT_DIR: &str = ".pocketmind-checkpoints";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointAction {
    Write,
    Create,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointFileEntry {
    pub path: String,
    pub action: CheckpointAction,
    pub existed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_rel: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointManifest {
    pub run_id: String,
    pub created_at: u64,
    pub workspace_root: String,
    pub files: Vec<CheckpointFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointSummary {
    pub run_id: String,
    pub created_at: u64,
    pub file_count: usize,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn checkpoint_root(workspace_root: &Path) -> AppResult<PathBuf> {
    Ok(WorkspaceSidecar::for_workspace(workspace_root)
        .map_err(|e| AppError::Unknown(e.to_string()))?
        .checkpoints_dir())
}

fn run_dir(workspace_root: &Path, run_id: &str) -> AppResult<PathBuf> {
    let id = run_id.trim();
    if id.is_empty() || id.contains("..") || id.contains('/') || id.contains('\\') {
        return Err(AppError::Unknown("Invalid checkpoint run id.".to_string()));
    }
    Ok(checkpoint_root(workspace_root)?.join(id))
}

fn load_manifest(dir: &Path) -> AppResult<CheckpointManifest> {
    let path = dir.join("manifest.json");
    let raw = fs::read_to_string(&path)
        .map_err(|e| AppError::Unknown(format!("Cannot read checkpoint manifest: {e}")))?;
    serde_json::from_str(&raw)
        .map_err(|e| AppError::Unknown(format!("Invalid checkpoint manifest: {e}")))
}

fn save_manifest(dir: &Path, manifest: &CheckpointManifest) -> AppResult<()> {
    let path = dir.join("manifest.json");
    let raw = serde_json::to_string_pretty(manifest)
        .map_err(|e| AppError::Unknown(format!("Cannot serialize checkpoint: {e}")))?;
    fs::write(&path, raw).map_err(|e| AppError::Unknown(format!("Cannot write checkpoint: {e}")))?;
    Ok(())
}

fn safe_snapshot_name(rel: &str) -> String {
    rel.replace(['/', '\\', ':'], "__")
}

/// Start a new checkpoint run under `.pocketmind-checkpoints/<runId>/`.
pub fn begin_checkpoint(workspace_root: &Path) -> AppResult<String> {
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    if !root.is_dir() {
        return Err(AppError::Unknown("Workspace root is not a directory.".to_string()));
    }
    let run_id = format!(
        "{}-{}",
        now_secs(),
        &uuid_simple()[..8]
    );
    let dir = run_dir(&root, &run_id)?;
    fs::create_dir_all(dir.join("files"))
        .map_err(|e| AppError::Unknown(format!("Cannot create checkpoint dir: {e}")))?;
    let manifest = CheckpointManifest {
        run_id: run_id.clone(),
        created_at: now_secs(),
        workspace_root: root.to_string_lossy().to_string(),
        files: vec![],
    };
    save_manifest(&dir, &manifest)?;
    Ok(run_id)
}

fn uuid_simple() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    now_secs().hash(&mut h);
    std::thread::current().id().hash(&mut h);
    format!("{:x}", h.finish())
}

/// Snapshot file before mutation (no-op if already snapshotted for this run).
pub fn snapshot_before_write(workspace_root: &Path, run_id: &str, path: &str) -> AppResult<()> {
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let dir = run_dir(&root, run_id)?;
    let mut manifest = load_manifest(&dir)?;
    let rel = standardize(path);
    if manifest.files.iter().any(|f| f.path == rel) {
        return Ok(());
    }
    let file = resolve_under_root(&root, &rel)?;
    if file.exists() && file.is_file() {
        let snap_name = safe_snapshot_name(&rel);
        let snap_path = dir.join("files").join(&snap_name);
        fs::copy(&file, &snap_path)
            .map_err(|e| AppError::Unknown(format!("Cannot snapshot file: {e}")))?;
        manifest.files.push(CheckpointFileEntry {
            path: rel,
            action: CheckpointAction::Write,
            existed: true,
            snapshot_rel: Some(format!("files/{snap_name}")),
        });
    } else {
        manifest.files.push(CheckpointFileEntry {
            path: rel,
            action: CheckpointAction::Create,
            existed: false,
            snapshot_rel: None,
        });
    }
    save_manifest(&dir, &manifest)
}

/// Record intent to delete; snapshot existing content first.
pub fn snapshot_before_delete(workspace_root: &Path, run_id: &str, path: &str) -> AppResult<()> {
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let dir = run_dir(&root, run_id)?;
    let mut manifest = load_manifest(&dir)?;
    let rel = standardize(path);
    if manifest.files.iter().any(|f| f.path == rel) {
        return Ok(());
    }
    let file = resolve_under_root(&root, &rel)?;
    if file.exists() && file.is_file() {
        let snap_name = safe_snapshot_name(&rel);
        let snap_path = dir.join("files").join(&snap_name);
        fs::copy(&file, &snap_path)
            .map_err(|e| AppError::Unknown(format!("Cannot snapshot file: {e}")))?;
        manifest.files.push(CheckpointFileEntry {
            path: rel,
            action: CheckpointAction::Delete,
            existed: true,
            snapshot_rel: Some(format!("files/{snap_name}")),
        });
    } else {
        return Err(AppError::MissingFile(format!("Nothing to delete: {rel}")));
    }
    save_manifest(&dir, &manifest)
}

pub fn list_checkpoints(workspace_root: &Path) -> AppResult<Vec<CheckpointSummary>> {
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let base = checkpoint_root(&root)?;
    if !base.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&base)
        .map_err(|e| AppError::Unknown(format!("Cannot list checkpoints: {e}")))?
    {
        let entry = entry.map_err(|e| AppError::Unknown(e.to_string()))?;
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir = entry.path();
        if let Ok(m) = load_manifest(&dir) {
            out.push(CheckpointSummary {
                run_id: m.run_id,
                created_at: m.created_at,
                file_count: m.files.len(),
            });
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

pub fn restore_checkpoint(workspace_root: &Path, run_id: &str) -> AppResult<usize> {
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let dir = run_dir(&root, run_id)?;
    let manifest = load_manifest(&dir)?;
    let mut n = 0usize;
    for entry in manifest.files.iter().rev() {
        restore_one(&root, &dir, entry)?;
        n += 1;
    }
    Ok(n)
}

pub fn restore_file(workspace_root: &Path, run_id: &str, path: &str) -> AppResult<()> {
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let dir = run_dir(&root, run_id)?;
    let manifest = load_manifest(&dir)?;
    let rel = standardize(path);
    let entry = manifest
        .files
        .iter()
        .find(|f| f.path == rel)
        .ok_or_else(|| AppError::Unknown(format!("Path not in checkpoint: {rel}")))?;
    restore_one(&root, &dir, entry)
}

fn restore_one(root: &Path, dir: &Path, entry: &CheckpointFileEntry) -> AppResult<()> {
    let file = resolve_under_root(root, &entry.path)?;
    match entry.action {
        CheckpointAction::Create => {
            if file.exists() {
                fs::remove_file(&file)
                    .map_err(|e| AppError::Unknown(format!("Cannot remove created file: {e}")))?;
            }
        }
        CheckpointAction::Write | CheckpointAction::Delete => {
            let snap = entry
                .snapshot_rel
                .as_ref()
                .ok_or_else(|| AppError::Unknown("Missing snapshot for restore.".to_string()))?;
            let snap_path = dir.join(snap);
            if let Some(parent) = file.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| AppError::Unknown(format!("Cannot create parent: {e}")))?;
            }
            fs::copy(&snap_path, &file)
                .map_err(|e| AppError::Unknown(format!("Cannot restore file: {e}")))?;
        }
    }
    Ok(())
}

pub fn get_manifest(workspace_root: &Path, run_id: &str) -> AppResult<CheckpointManifest> {
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let dir = run_dir(&root, run_id)?;
    load_manifest(&dir)
}
