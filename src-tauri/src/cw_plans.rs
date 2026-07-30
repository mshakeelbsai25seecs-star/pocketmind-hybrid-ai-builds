//! PocketCode Plan mode artifacts under `.pocketmind-plans/`.

use crate::error::{AppError, AppResult};
use pocketcode_workspace::WorkspaceSidecar;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const PLAN_DIR: &str = ".pocketmind-plans";

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

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn plans_dir(root: &Path) -> AppResult<PathBuf> {
    Ok(WorkspaceSidecar::for_workspace(root)
        .map_err(|e| AppError::Unknown(e.to_string()))?
        .plans_dir())
}

fn plan_json_path(root: &Path, id: &str) -> AppResult<PathBuf> {
    let id = id.trim();
    if id.is_empty() || id.contains("..") || id.contains('/') || id.contains('\\') {
        return Err(AppError::Unknown("Invalid plan id.".to_string()));
    }
    Ok(plans_dir(root)?.join(format!("{id}.json")))
}

fn plan_md_path(root: &Path, id: &str) -> AppResult<PathBuf> {
    let id = id.trim();
    if id.is_empty() || id.contains("..") || id.contains('/') || id.contains('\\') {
        return Err(AppError::Unknown("Invalid plan id.".to_string()));
    }
    Ok(plans_dir(root)?.join(format!("{id}.md")))
}

fn ensure_dir(root: &Path) -> AppResult<()> {
    fs::create_dir_all(plans_dir(root)?)
        .map_err(|e| AppError::Unknown(format!("Cannot create plans dir: {e}")))
}

fn simple_id() -> String {
    format!("plan-{}", now_secs())
}

pub fn write_plan(
    workspace_root: &Path,
    id: Option<String>,
    title: String,
    markdown: String,
    todos: Vec<String>,
    status: Option<String>,
) -> AppResult<PocketCodePlan> {
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    ensure_dir(&root)?;
    let id = id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(simple_id);
    let now = now_secs();
    let existing = read_plan(&root, &id).ok();
    let created_at = existing.as_ref().map(|p| p.created_at).unwrap_or(now);
    let todo_structs: Vec<PlanTodo> = if let Some(prev) = existing.as_ref() {
        if todos.is_empty() {
            prev.todos.clone()
        } else {
            todos
                .into_iter()
                .enumerate()
                .map(|(i, text)| PlanTodo {
                    id: format!("t{i}"),
                    text,
                    done: false,
                })
                .collect()
        }
    } else {
        todos
            .into_iter()
            .enumerate()
            .map(|(i, text)| PlanTodo {
                id: format!("t{i}"),
                text,
                done: false,
            })
            .collect()
    };

    let plan = PocketCodePlan {
        id: id.clone(),
        title: title.trim().chars().take(120).collect::<String>(),
        markdown,
        todos: todo_structs,
        status: status.unwrap_or_else(|| "draft".to_string()),
        created_at,
        updated_at: now,
        checkpoint_run_id: existing.and_then(|p| p.checkpoint_run_id),
    };

    let json_path = plan_json_path(&root, &id)?;
    let md_path = plan_md_path(&root, &id)?;
    let raw = serde_json::to_string_pretty(&plan)
        .map_err(|e| AppError::Unknown(format!("Cannot serialize plan: {e}")))?;
    fs::write(&json_path, raw).map_err(|e| AppError::Unknown(format!("Cannot write plan: {e}")))?;
    fs::write(&md_path, &plan.markdown)
        .map_err(|e| AppError::Unknown(format!("Cannot write plan markdown: {e}")))?;
    Ok(plan)
}

pub fn read_plan(workspace_root: &Path, id: &str) -> AppResult<PocketCodePlan> {
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let path = plan_json_path(&root, id)?;
    let raw = fs::read_to_string(&path)
        .map_err(|e| AppError::Unknown(format!("Cannot read plan: {e}")))?;
    serde_json::from_str(&raw).map_err(|e| AppError::Unknown(format!("Invalid plan JSON: {e}")))
}

pub fn list_plans(workspace_root: &Path) -> AppResult<Vec<PlanSummary>> {
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let dir = plans_dir(&root)?;
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| AppError::Unknown(e.to_string()))? {
        let entry = entry.map_err(|e| AppError::Unknown(e.to_string()))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(plan) = serde_json::from_str::<PocketCodePlan>(&raw) {
                out.push(PlanSummary {
                    id: plan.id,
                    title: plan.title,
                    status: plan.status,
                    updated_at: plan.updated_at,
                    todo_count: plan.todos.len(),
                });
            }
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

pub fn update_plan_status(
    workspace_root: &Path,
    id: &str,
    status: &str,
    checkpoint_run_id: Option<String>,
) -> AppResult<PocketCodePlan> {
    let mut plan = read_plan(workspace_root, id)?;
    plan.status = status.to_string();
    plan.updated_at = now_secs();
    if checkpoint_run_id.is_some() {
        plan.checkpoint_run_id = checkpoint_run_id;
    }
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let json_path = plan_json_path(&root, id)?;
    let raw = serde_json::to_string_pretty(&plan)
        .map_err(|e| AppError::Unknown(format!("Cannot serialize plan: {e}")))?;
    fs::write(&json_path, raw).map_err(|e| AppError::Unknown(format!("Cannot write plan: {e}")))?;
    Ok(plan)
}

pub fn update_plan_markdown(
    workspace_root: &Path,
    id: &str,
    markdown: String,
    todos: Option<Vec<PlanTodo>>,
) -> AppResult<PocketCodePlan> {
    let mut plan = read_plan(workspace_root, id)?;
    plan.markdown = markdown;
    if let Some(t) = todos {
        plan.todos = t;
    }
    plan.updated_at = now_secs();
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let json_path = plan_json_path(&root, &plan.id)?;
    let md_path = plan_md_path(&root, &plan.id)?;
    let raw = serde_json::to_string_pretty(&plan)
        .map_err(|e| AppError::Unknown(format!("Cannot serialize plan: {e}")))?;
    fs::write(&json_path, raw).map_err(|e| AppError::Unknown(format!("Cannot write plan: {e}")))?;
    fs::write(&md_path, &plan.markdown)
        .map_err(|e| AppError::Unknown(format!("Cannot write plan markdown: {e}")))?;
    Ok(plan)
}
