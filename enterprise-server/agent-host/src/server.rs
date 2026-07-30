use crate::auth::require_bearer;
use crate::config::AgentHostConfig;
use crate::provision::{
    provision_git, provision_preloaded, provision_sync, provision_sync_chunk, GitBody, PreloadedBody,
    SyncBody, SyncChunkBody,
};
use crate::store::WorkspaceStore;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::middleware;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use pocketcode_workspace as pc;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<WorkspaceStore>,
}

pub async fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cfg = AgentHostConfig::from_env()?;
    pc::init_store_root(cfg.data_root.join("pocketcode-stores"));
    let store = Arc::new(WorkspaceStore::new(cfg.clone())?);
    let token = cfg.token.clone();
    let state = AppState { store };

    let public = Router::new().route("/v1/agent/health", get(health));

    let protected = Router::new()
        .route("/v1/workspaces", get(list_workspaces).post(create_workspace))
        .route(
            "/v1/workspaces/provision/preloaded",
            post(provision_preloaded_handler),
        )
        .route("/v1/workspaces/provision/sync", post(provision_sync_handler))
        .route(
            "/v1/workspaces/provision/sync/chunk",
            post(provision_sync_chunk_handler),
        )
        .route("/v1/workspaces/provision/git", post(provision_git_handler))
        .route("/v1/agent/tools/:tool", post(tool_handler))
        .layer(middleware::from_fn(move |req, next| {
            let expected = token.clone();
            require_bearer(expected, req, next)
        }));

    let app = public
        .merge(protected)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&cfg.bind).await?;
    tracing::info!("pocketcode-agent-host listening on {}", cfg.bind);
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "service": "pocketcode-agent-host",
        "version": env!("CARGO_PKG_VERSION")
    }))
}

fn err_json(status: StatusCode, msg: impl Into<String>) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": msg.into() })))
}

async fn list_workspaces(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let rows = state
        .store
        .list()
        .map_err(|e| err_json(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
struct CreateBody {
    pub id: Option<String>,
}

async fn create_workspace(
    State(state): State<AppState>,
    Json(body): Json<CreateBody>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let result = state
        .store
        .create_empty(body.id)
        .map_err(|e| err_json(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(result))
}

async fn provision_preloaded_handler(
    State(state): State<AppState>,
    Json(body): Json<PreloadedBody>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let result = provision_preloaded(&state.store, body)
        .map_err(|e| err_json(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(result))
}

async fn provision_sync_handler(
    State(state): State<AppState>,
    Json(body): Json<SyncBody>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let result = tokio::task::spawn_blocking(move || provision_sync(&state.store, body))
        .await
        .map_err(|e| err_json(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| err_json(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(result))
}

async fn provision_sync_chunk_handler(
    State(state): State<AppState>,
    Json(body): Json<SyncChunkBody>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let result = tokio::task::spawn_blocking(move || provision_sync_chunk(&state.store, body))
        .await
        .map_err(|e| err_json(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| err_json(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(result))
}

async fn provision_git_handler(
    State(state): State<AppState>,
    Json(body): Json<GitBody>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let result = tokio::task::spawn_blocking(move || provision_git(&state.store, body))
        .await
        .map_err(|e| err_json(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| err_json(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(result))
}

#[derive(Debug, Deserialize)]
struct ToolBody {
    pub workspace_id: String,
    /// Accepted from TS clients; server resolves root from workspace metadata.
    #[serde(default)]
    #[allow(dead_code)]
    pub workspace_root: Option<String>,
    #[serde(flatten)]
    pub extra: Value,
}

const MUTATING_TOOLS: &[&str] = &[
    "apply_edit_preview",
    "apply_edit_write",
    "delete_file",
    "run_sandbox",
    "terminal_start",
    "checkpoint_begin",
    "checkpoint_snapshot_write",
    "checkpoint_snapshot_delete",
    "restore_checkpoint",
    "restore_checkpoint_file",
    "plan_write",
    "plan_update_markdown",
    "plan_update_status",
];

async fn tool_handler(
    State(state): State<AppState>,
    Path(tool): Path<String>,
    Json(body): Json<ToolBody>,
) -> Result<impl IntoResponse, (StatusCode, Json<Value>)> {
    let workspace_id = body.workspace_id.trim().to_string();
    if workspace_id.is_empty() {
        return Err(err_json(
            StatusCode::BAD_REQUEST,
            "workspace_id is required",
        ));
    }
    let meta = state
        .store
        .load_meta(&workspace_id)
        .map_err(|e| err_json(StatusCode::NOT_FOUND, e.to_string()))?;
    let root = PathBuf::from(&meta.root_path);
    if !root.exists() {
        return Err(err_json(
            StatusCode::BAD_REQUEST,
            format!("Workspace root missing on disk: {}", root.display()),
        ));
    }
    if meta.read_only && MUTATING_TOOLS.contains(&tool.as_str()) {
        return Err(err_json(
            StatusCode::FORBIDDEN,
            format!("Workspace {workspace_id} is read_only; tool '{tool}' rejected"),
        ));
    }

    let extra = body.extra;
    let tool_name = tool.clone();
    let result = tokio::task::spawn_blocking(move || dispatch_tool(&tool_name, &root, &extra))
        .await
        .map_err(|e| err_json(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|(code, msg)| err_json(code, msg))?;
    Ok(Json(result))
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

fn bool_field(v: &Value, key: &str, default: bool) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(default)
}

fn usize_field(v: &Value, key: &str, default: usize) -> usize {
    v.get(key)
        .and_then(|x| x.as_u64())
        .map(|n| n as usize)
        .unwrap_or(default)
}

fn i32_field(v: &Value, key: &str) -> Option<i32> {
    v.get(key).and_then(|x| {
        x.as_i64()
            .map(|n| n as i32)
            .or_else(|| x.as_u64().map(|n| n as i32))
    })
}

fn dispatch_tool(
    tool: &str,
    root: &std::path::Path,
    extra: &Value,
) -> Result<Value, (StatusCode, String)> {
    let map_err = |e: pc::Error| (StatusCode::BAD_REQUEST, e.to_string());

    match tool {
        "list_dir" => {
            let path = str_field(extra, "path").unwrap_or_else(|| ".".into());
            let out = pc::list_dir(root, &path).map_err(map_err)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "glob" => {
            let pattern = str_field(extra, "pattern").unwrap_or_default();
            let out = pc::glob_file_search(root, &pattern).map_err(map_err)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "grep" => {
            let pattern = str_field(extra, "pattern").unwrap_or_default();
            let path = str_field(extra, "path");
            let glob = str_field(extra, "glob");
            let case_insensitive = bool_field(extra, "case_insensitive", false);
            let out = pc::grep(
                root,
                &pattern,
                path.as_deref(),
                glob.as_deref(),
                case_insensitive,
            )
            .map_err(map_err)?;
            Ok(Value::String(out))
        }
        "read_file" => {
            let path = str_field(extra, "path").unwrap_or_default();
            let offset = usize_field(extra, "offset", 0);
            let limit = usize_field(extra, "limit", 0);
            let for_ui = bool_field(extra, "for_ui", false);
            let out = pc::read_file(root, &path, offset, limit, for_ui).map_err(map_err)?;
            Ok(Value::String(out))
        }
        "apply_edit_preview" => {
            let path = str_field(extra, "path").unwrap_or_default();
            let old = str_field(extra, "old_string").unwrap_or_default();
            let new = str_field(extra, "new_string").unwrap_or_default();
            let out = pc::apply_edit_preview(root, &path, &old, &new).map_err(map_err)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "apply_edit_write" => {
            let path = str_field(extra, "path").unwrap_or_default();
            let content = str_field(extra, "content").unwrap_or_default();
            pc::apply_edit_write(root, &path, &content).map_err(map_err)?;
            Ok(json!({ "ok": true }))
        }
        "delete_file" => {
            let path = str_field(extra, "path").unwrap_or_default();
            pc::delete_file(root, &path).map_err(map_err)?;
            Ok(json!({ "ok": true }))
        }
        "run_sandbox" => {
            let mode = str_field(extra, "mode").unwrap_or_else(|| "script".into());
            let result = if mode == "cli" {
                let argv: Vec<String> = extra
                    .get("argv")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                pc::run_sandbox(root, None, None, None, Some(argv)).map_err(map_err)?
            } else {
                let language = str_field(extra, "language");
                let script = str_field(extra, "script");
                let args: Option<Vec<String>> = extra.get("args").and_then(|v| {
                    if v.is_null() {
                        None
                    } else {
                        v.as_array().map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                    }
                });
                pc::run_sandbox(root, language.as_deref(), script, args, None).map_err(map_err)?
            };
            Ok(serde_json::to_value(result).unwrap())
        }
        "list_runners" => {
            let out = pc::list_runners();
            Ok(serde_json::to_value(out).unwrap())
        }
        // Streaming/background commands: start returns immediately, the client polls terminal_read.
        "terminal_start" => {
            let argv: Option<Vec<String>> = extra
                .get("argv")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .filter(|v: &Vec<String>| !v.is_empty());
            let language = str_field(extra, "language");
            let script = str_field(extra, "script");
            let args: Option<Vec<String>> = extra.get("args").and_then(|v| {
                v.as_array().map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
            });
            let background = bool_field(extra, "background", false);
            let out = pc::terminal_start(
                root,
                language.as_deref(),
                script,
                args,
                argv,
                background,
            )
            .map_err(map_err)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "terminal_read" => {
            let id = str_field(extra, "id").unwrap_or_default();
            let tail = extra
                .get("tail_bytes")
                .and_then(|v| v.as_u64())
                .map(|n| n as usize);
            let out = pc::terminal_read(id.trim(), tail).map_err(map_err)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "terminal_kill" => {
            let id = str_field(extra, "id").unwrap_or_default();
            let out = pc::terminal_kill(id.trim()).map_err(map_err)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "terminal_list" => Ok(serde_json::to_value(pc::terminal_list()).unwrap()),
        "ensure_symbol_index" => {
            let (touched, total) = pc::ensure_index(root).map_err(map_err)?;
            Ok(json!([touched, total]))
        }
        "repo_map" => {
            let out = pc::repo_map(root).map_err(map_err)?;
            Ok(Value::String(out))
        }
        "find_symbol" => {
            let query = str_field(extra, "query").unwrap_or_default();
            let out = pc::find_symbol(root, &query).map_err(map_err)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "read_symbol" => {
            let path = str_field(extra, "path").unwrap_or_default();
            let name = str_field(extra, "name").unwrap_or_default();
            let line_start = i32_field(extra, "line_start");
            let out = pc::read_symbol(root, &path, &name, line_start).map_err(map_err)?;
            Ok(Value::String(out))
        }
        "checkpoint_begin" => {
            let out = pc::begin_checkpoint(root).map_err(map_err)?;
            Ok(Value::String(out))
        }
        "checkpoint_snapshot_write" => {
            let run_id = str_field(extra, "run_id").unwrap_or_default();
            let path = str_field(extra, "path").unwrap_or_default();
            pc::snapshot_before_write(root, &run_id, &path).map_err(map_err)?;
            Ok(json!({ "ok": true }))
        }
        "checkpoint_snapshot_delete" => {
            let run_id = str_field(extra, "run_id").unwrap_or_default();
            let path = str_field(extra, "path").unwrap_or_default();
            pc::snapshot_before_delete(root, &run_id, &path).map_err(map_err)?;
            Ok(json!({ "ok": true }))
        }
        "list_checkpoints" => {
            let out = pc::list_checkpoints(root).map_err(map_err)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "restore_checkpoint" => {
            let run_id = str_field(extra, "run_id").unwrap_or_default();
            let n = pc::restore_checkpoint(root, &run_id).map_err(map_err)?;
            Ok(json!(n))
        }
        "restore_checkpoint_file" => {
            let run_id = str_field(extra, "run_id").unwrap_or_default();
            let path = str_field(extra, "path").unwrap_or_default();
            pc::restore_file(root, &run_id, &path).map_err(map_err)?;
            Ok(json!({ "ok": true }))
        }
        "checkpoint_manifest" => {
            let run_id = str_field(extra, "run_id").unwrap_or_default();
            let out = pc::get_manifest(root, &run_id).map_err(map_err)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "project_rules" => {
            let out = pc::read_project_rules(root).map_err(map_err)?;
            Ok(Value::String(out))
        }
        "plan_write" => {
            let id = str_field(extra, "id");
            let title = str_field(extra, "title").unwrap_or_else(|| "Plan".into());
            let markdown = str_field(extra, "markdown").unwrap_or_default();
            let todos: Vec<String> = extra
                .get("todos")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| {
                            if let Some(s) = x.as_str() {
                                Some(s.to_string())
                            } else {
                                x.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            let status = str_field(extra, "status");
            let out = pc::write_plan(root, id, title, markdown, todos, status).map_err(map_err)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "plan_read" => {
            let id = str_field(extra, "id").unwrap_or_default();
            let out = pc::read_plan(root, &id).map_err(map_err)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "plan_list" => {
            let out = pc::list_plans(root).map_err(map_err)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "plan_update_markdown" => {
            let id = str_field(extra, "id").unwrap_or_default();
            let markdown = str_field(extra, "markdown").unwrap_or_default();
            let todos: Option<Vec<pc::PlanTodo>> = extra.get("todos").and_then(|v| {
                if v.is_null() {
                    None
                } else {
                    serde_json::from_value(v.clone()).ok()
                }
            });
            let out =
                pc::update_plan_markdown(root, &id, markdown, todos).map_err(map_err)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "plan_update_status" => {
            let id = str_field(extra, "id").unwrap_or_default();
            let status = str_field(extra, "status").unwrap_or_default();
            let checkpoint_run_id = str_field(extra, "checkpoint_run_id");
            let out =
                pc::update_plan_status(root, &id, &status, checkpoint_run_id).map_err(map_err)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        other => Err((
            StatusCode::NOT_FOUND,
            format!("Unknown tool: {other}"),
        )),
    }
}
