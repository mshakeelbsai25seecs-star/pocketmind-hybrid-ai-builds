use crate::config::AgentHostConfig;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceMeta {
    pub id: String,
    pub root_path: String,
    pub provision: String,
    pub read_only: bool,
    pub created_at: DateTime<Utc>,
}

/// Matches TS `listRemoteWorkspaces` snake_case fields.
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceListItem {
    pub id: String,
    pub root_path: String,
    pub provision: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionResult {
    pub workspace_id: String,
    pub root_path: String,
    pub message: String,
}

pub struct WorkspaceStore {
    cfg: AgentHostConfig,
}

impl WorkspaceStore {
    pub fn new(cfg: AgentHostConfig) -> anyhow::Result<Self> {
        fs::create_dir_all(&cfg.workspaces_dir)?;
        fs::create_dir_all(&cfg.meta_dir)?;
        fs::create_dir_all(&cfg.uploads_dir)?;
        Ok(Self { cfg })
    }

    fn meta_path(&self, id: &str) -> PathBuf {
        self.cfg.meta_dir.join(format!("{id}.json"))
    }

    pub fn workspace_dir(&self, id: &str) -> PathBuf {
        self.cfg.workspaces_dir.join(id)
    }

    pub fn validate_id(id: &str) -> anyhow::Result<()> {
        let id = id.trim();
        if id.is_empty()
            || id.contains("..")
            || id.contains('/')
            || id.contains('\\')
            || id.len() > 128
        {
            anyhow::bail!("Invalid workspace id");
        }
        if !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            anyhow::bail!("Invalid workspace id characters");
        }
        Ok(())
    }

    pub fn new_id() -> String {
        Uuid::new_v4().to_string()
    }

    pub fn save_meta(&self, meta: &WorkspaceMeta) -> anyhow::Result<()> {
        Self::validate_id(&meta.id)?;
        let raw = serde_json::to_string_pretty(meta)?;
        fs::write(self.meta_path(&meta.id), raw)?;
        Ok(())
    }

    pub fn load_meta(&self, id: &str) -> anyhow::Result<WorkspaceMeta> {
        Self::validate_id(id)?;
        let path = self.meta_path(id);
        let raw = fs::read_to_string(&path)
            .map_err(|_| anyhow::anyhow!("Workspace not found: {id}"))?;
        Ok(serde_json::from_str(&raw)?)
    }

    pub fn list(&self) -> anyhow::Result<Vec<WorkspaceListItem>> {
        let mut out = Vec::new();
        for entry in fs::read_dir(&self.cfg.meta_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(raw) = fs::read_to_string(&path) {
                if let Ok(meta) = serde_json::from_str::<WorkspaceMeta>(&raw) {
                    out.push(WorkspaceListItem {
                        id: meta.id,
                        root_path: meta.root_path,
                        provision: meta.provision,
                        read_only: meta.read_only,
                    });
                }
            }
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    pub fn create_empty(&self, id: Option<String>) -> anyhow::Result<ProvisionResult> {
        let id = id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(Self::new_id);
        Self::validate_id(&id)?;
        if self.meta_path(&id).exists() {
            anyhow::bail!("Workspace already exists: {id}");
        }
        let root = self.workspace_dir(&id);
        fs::create_dir_all(&root)?;
        let meta = WorkspaceMeta {
            id: id.clone(),
            root_path: root.to_string_lossy().to_string(),
            provision: "empty".into(),
            read_only: false,
            created_at: Utc::now(),
        };
        self.save_meta(&meta)?;
        Ok(ProvisionResult {
            workspace_id: id,
            root_path: meta.root_path,
            message: "Empty workspace created".into(),
        })
    }

    pub fn ensure_workspace_root(&self, id: &str) -> anyhow::Result<PathBuf> {
        let root = self.workspace_dir(id);
        fs::create_dir_all(&root)?;
        Ok(root)
    }

    pub fn uploads_dir(&self) -> &Path {
        &self.cfg.uploads_dir
    }
}
