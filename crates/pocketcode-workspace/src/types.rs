use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub is_dir: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditPreview {
    pub original: String,
    pub modified: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxRunResult {
    pub ok: bool,
    pub language: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerInfo {
    pub id: String,
    pub kind: String,
    pub available: bool,
    pub binary: Option<String>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnersStatus {
    pub runners: Vec<RunnerInfo>,
    pub message: String,
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolHit {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub line_start: i32,
    pub line_end: i32,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanTodo {
    pub id: String,
    pub text: String,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PocketCodePlan {
    pub id: String,
    pub title: String,
    pub markdown: String,
    pub todos: Vec<PlanTodo>,
    pub status: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub checkpoint_run_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanSummary {
    pub id: String,
    pub title: String,
    pub status: String,
    pub updated_at: u64,
    pub todo_count: usize,
}
