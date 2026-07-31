//! App-side storage for PocketCode workspace metadata (index, checkpoints, plans, sandbox, skills).
//! Nothing under these paths is written into the user's project folder.

use crate::error::{Error, Result};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static STORE_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Configure the global PocketCode app-data root (call once at process startup).
pub fn init_store_root(root: PathBuf) {
    if STORE_ROOT.set(root.clone()).is_ok() {
        let _ = fs::create_dir_all(&root);
    }
}

pub fn store_root() -> PathBuf {
    STORE_ROOT
        .get()
        .cloned()
        .or_else(|| {
            std::env::var("POCKETCODE_STORE_ROOT")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .map(|s| PathBuf::from(s.trim()))
        })
        .unwrap_or_else(|| PathBuf::from("./pocketcode-data"))
}

fn workspace_key(workspace_root: &Path) -> String {
    let canon = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let mut normalized = canon.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        normalized = normalized.to_lowercase();
    }
    let digest = Sha256::digest(normalized.as_bytes());
    format!("ws_{}", hex::encode(&digest[..16]))
}

#[derive(Debug, Clone)]
pub struct WorkspaceSidecar {
    pub workspace_root: PathBuf,
    pub base: PathBuf,
}

impl WorkspaceSidecar {
    pub fn for_workspace(workspace_root: &Path) -> Result<Self> {
        let canon = workspace_root
            .canonicalize()
            .unwrap_or_else(|_| workspace_root.to_path_buf());
        if !canon.is_dir() {
            return Err(Error::msg(
                "Workspace root is not a directory.".to_string(),
            ));
        }
        let key = workspace_key(&canon);
        let base = store_root().join("workspaces").join(&key);
        fs::create_dir_all(&base)
            .map_err(|e| Error::msg(format!("Cannot create workspace store: {e}")))?;
        write_meta(&base, &canon)?;
        migrate_legacy(&canon, &base)?;
        Ok(Self {
            workspace_root: canon,
            base,
        })
    }

    pub fn index_dir(&self) -> PathBuf {
        self.base.join("index")
    }

    pub fn index_file(&self) -> PathBuf {
        self.index_dir().join("symbols.json")
    }

    pub fn checkpoints_dir(&self) -> PathBuf {
        self.base.join("checkpoints")
    }

    pub fn plans_dir(&self) -> PathBuf {
        self.base.join("plans")
    }

    pub fn sandbox_dir(&self) -> PathBuf {
        self.base.join("sandbox")
    }

    pub fn skills_dir(&self) -> PathBuf {
        self.base.join("skills")
    }

    /// OCR / extracted PDF text sidecars (never written into the user's project).
    pub fn ocr_dir(&self) -> PathBuf {
        self.base.join("ocr")
    }

    pub fn rules_file(&self) -> PathBuf {
        self.base.join("rules.md")
    }
}

fn write_meta(base: &Path, workspace_root: &Path) -> Result<()> {
    let meta_path = base.join("meta.json");
    if meta_path.is_file() {
        return Ok(());
    }
    let payload = serde_json::json!({
        "workspace_root": workspace_root.to_string_lossy(),
        "created_at": now_secs(),
    });
    let raw = serde_json::to_string_pretty(&payload)
        .map_err(|e| Error::msg(format!("Cannot serialize workspace meta: {e}")))?;
    fs::write(&meta_path, raw)
        .map_err(|e| Error::msg(format!("Cannot write workspace meta: {e}")))?;
    Ok(())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn migrate_tree(from: &Path, to: &Path) -> Result<()> {
    if !from.is_dir() {
        return Ok(());
    }
    if to.exists() {
        return Ok(());
    }
    fs::create_dir_all(to.parent().unwrap_or(to))
        .map_err(|e| Error::msg(format!("Cannot create migration parent: {e}")))?;
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_dir_recursive(from, to)?;
            let _ = fs::remove_dir_all(from);
            Ok(())
        }
    }
}

fn copy_dir_recursive(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to).map_err(|e| Error::msg(format!("Cannot create dir: {e}")))?;
    for entry in fs::read_dir(from).map_err(|e| Error::msg(e.to_string()))? {
        let entry = entry.map_err(|e| Error::msg(e.to_string()))?;
        let dest = to.join(entry.file_name());
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), dest).map_err(|e| Error::msg(e.to_string()))?;
        }
    }
    Ok(())
}

fn migrate_legacy(workspace_root: &Path, base: &Path) -> Result<()> {
    // Best-effort: a locked legacy folder must not block sandbox/index writes.
    let steps: [(&str, PathBuf, PathBuf); 5] = [
        (
            ".pocketmind-index",
            workspace_root.join(".pocketmind-index"),
            base.join("index"),
        ),
        (
            ".pocketmind-checkpoints",
            workspace_root.join(".pocketmind-checkpoints"),
            base.join("checkpoints"),
        ),
        (
            ".pocketmind-plans",
            workspace_root.join(".pocketmind-plans"),
            base.join("plans"),
        ),
        (
            ".pocketmind-sandbox",
            workspace_root.join(".pocketmind-sandbox"),
            base.join("sandbox"),
        ),
        (
            ".pocketcode/skills",
            workspace_root.join(".pocketcode").join("skills"),
            base.join("skills"),
        ),
    ];
    for (label, from, to) in steps {
        if let Err(e) = migrate_tree(&from, &to) {
            eprintln!("pocketcode: skipped legacy migration for {label}: {e}");
        }
    }
    let legacy_rules = workspace_root.join(".pocketmind").join("rules.md");
    let new_rules = base.join("rules.md");
    if legacy_rules.is_file() && !new_rules.exists() {
        if let Some(parent) = new_rules.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::copy(&legacy_rules, &new_rules);
    }
    Ok(())
}

pub fn read_project_rules(workspace_root: &Path) -> Result<String> {
    let sidecar = WorkspaceSidecar::for_workspace(workspace_root)?;
    match fs::read_to_string(sidecar.rules_file()) {
        Ok(raw) => Ok(raw.trim().to_string()),
        Err(_) => Ok(String::new()),
    }
}

pub fn write_project_rules(workspace_root: &Path, markdown: &str) -> Result<()> {
    let sidecar = WorkspaceSidecar::for_workspace(workspace_root)?;
    fs::write(&sidecar.rules_file(), markdown.trim())
        .map_err(|e| Error::msg(format!("Cannot write project rules: {e}")))?;
    Ok(())
}
