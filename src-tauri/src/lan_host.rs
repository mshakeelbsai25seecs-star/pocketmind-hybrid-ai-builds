//! In-app OpenAI-compatible LAN gateway (host mode).
//!
//! Binds 0.0.0.0 by default, proxies chat to the local llama-server, and exposes
//! read-only PocketCode workspace tools plus downloadable DOCX artifacts.

use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Method, Request, Response, Server, StatusCode};
use pocketcode_workspace as pc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use crate::commands::AppState;
use crate::deployment;
use crate::doc_export::{self, DocFormat};
use crate::error::{AppError, AppResult};
use crate::llm::InferenceBackend;
use tauri::Manager;

const KEY_ENABLED: &str = "lan_host.enabled";
const KEY_PORT: &str = "lan_host.port";
const KEY_API_KEY: &str = "lan_host.api_key";
const DEFAULT_PORT: u16 = 8787;
const HOST_WORKSPACE_ID: &str = "host-workspace";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanHostConfig {
    pub enabled: bool,
    pub port: u16,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanHostStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub api_key: String,
    pub lan_ips: Vec<String>,
    pub base_urls: Vec<String>,
    pub workspace_root: Option<String>,
    pub workspace_id: String,
    pub model_loaded: bool,
    pub model_path: Option<String>,
    pub error: Option<String>,
}

struct ArtifactEntry {
    path: PathBuf,
    filename: String,
    mime: String,
}

struct RuntimeInner {
    config: LanHostConfig,
    running: bool,
    last_error: Option<String>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    artifacts: HashMap<String, ArtifactEntry>,
}

pub struct LanHostRuntime {
    inner: RwLock<RuntimeInner>,
    app: Mutex<Option<tauri::AppHandle>>,
}

impl LanHostRuntime {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: RwLock::new(RuntimeInner {
                config: LanHostConfig {
                    enabled: true,
                    port: DEFAULT_PORT,
                    api_key: String::new(),
                },
                running: false,
                last_error: None,
                shutdown: None,
                artifacts: HashMap::new(),
            }),
            app: Mutex::new(None),
        })
    }
}

fn runtime() -> &'static Arc<LanHostRuntime> {
    static CELL: OnceLock<Arc<LanHostRuntime>> = OnceLock::new();
    CELL.get_or_init(LanHostRuntime::new)
}

fn generate_api_key() -> String {
    format!("pm_{}", Uuid::new_v4().simple())
}

pub fn load_config_from_db(db: &crate::database::Database) -> LanHostConfig {
    let enabled = db
        .get_setting(KEY_ENABLED)
        .ok()
        .flatten()
        .map(|v| v != "0" && !v.eq_ignore_ascii_case("false"))
        .unwrap_or(true);
    let port = db
        .get_setting(KEY_PORT)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(DEFAULT_PORT);
    let api_key = db
        .get_setting(KEY_API_KEY)
        .ok()
        .flatten()
        .filter(|k| !k.trim().is_empty())
        .unwrap_or_else(generate_api_key);
    LanHostConfig {
        enabled,
        port,
        api_key,
    }
}

fn save_config_to_db(db: &crate::database::Database, cfg: &LanHostConfig) -> AppResult<()> {
    db.set_setting(KEY_ENABLED, if cfg.enabled { "1" } else { "0" })
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(KEY_PORT, &cfg.port.to_string())
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(KEY_API_KEY, &cfg.api_key)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}

fn list_lan_ips() -> Vec<String> {
    let mut ips = Vec::new();
    if let Ok(adapters) = list_ipv4_adapters() {
        for ip in adapters {
            if ip.starts_with("127.") {
                continue;
            }
            if !ips.contains(&ip) {
                ips.push(ip);
            }
        }
    }
    if ips.is_empty() {
        if let Some(ip) = primary_outbound_ipv4() {
            ips.push(ip);
        }
    }
    ips
}

fn primary_outbound_ipv4() -> Option<String> {
    use std::net::UdpSocket;
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    let addr = sock.local_addr().ok()?;
    let ip = addr.ip();
    if ip.is_loopback() {
        return None;
    }
    Some(ip.to_string())
}

fn list_ipv4_adapters() -> Result<Vec<String>, ()> {
    #[cfg(target_os = "linux")]
    {
        let out = std::process::Command::new("ip")
            .args(["-o", "-4", "addr", "show"])
            .output()
            .map_err(|_| ())?;
        let text = String::from_utf8_lossy(&out.stdout);
        let mut ips = Vec::new();
        for line in text.lines() {
            for part in line.split_whitespace() {
                if let Some(cidr) = part.split('/').next() {
                    if cidr.parse::<std::net::Ipv4Addr>().is_ok() {
                        ips.push(cidr.to_string());
                    }
                }
            }
        }
        return Ok(ips);
    }
    #[cfg(windows)]
    {
        let out = std::process::Command::new("ipconfig")
            .output()
            .map_err(|_| ())?;
        let text = String::from_utf8_lossy(&out.stdout);
        let mut ips = Vec::new();
        for line in text.lines() {
            let lower = line.to_ascii_lowercase();
            if !(lower.contains("ipv4") || lower.contains("ip address")) {
                continue;
            }
            if let Some(idx) = line.rfind(':') {
                let cand = line[idx + 1..].trim();
                if cand.parse::<std::net::Ipv4Addr>().is_ok() {
                    ips.push(cand.to_string());
                }
            }
        }
        return Ok(ips);
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        Ok(Vec::new())
    }
}

fn workspace_root_from_db(db: &crate::database::Database) -> Option<String> {
    db.get_setting("cw.workspace_root")
        .ok()
        .flatten()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[derive(Clone)]
struct HttpState {
    app_state: Arc<SharedAppBits>,
    api_key: String,
}

struct SharedAppBits {
    db: Arc<tokio::sync::Mutex<crate::database::Database>>,
    local_backend: Arc<crate::llm::local::LlamaCppBackend>,
    http: reqwest::Client,
}

fn json_response(status: StatusCode, value: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
        .header(
            "access-control-allow-headers",
            "authorization, content-type, accept",
        )
        .header(
            "access-control-allow-methods",
            "GET, POST, OPTIONS",
        )
        .body(Body::from(value.to_string()))
        .unwrap_or_else(|_| Response::new(Body::from("{\"error\":\"encode\"}")))
}

fn err_json(status: StatusCode, msg: impl Into<String>) -> Response<Body> {
    json_response(
        status,
        json!({ "error": { "message": msg.into(), "type": "lan_host_error" } }),
    )
}

fn extract_bearer(req: &Request<Body>) -> Option<String> {
    let auth = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())?;
    auth.strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
        .map(|s| s.trim().to_string())
}

fn require_auth(state: &HttpState, req: &Request<Body>) -> Result<(), Response<Body>> {
    let token = extract_bearer(req).unwrap_or_default();
    if token.is_empty() || token != state.api_key {
        return Err(err_json(StatusCode::UNAUTHORIZED, "Invalid or missing API key"));
    }
    Ok(())
}

fn resolve_active_local_model_path(db: &crate::database::Database) -> Option<String> {
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
                && (m.ends_with(".gguf") || FsPath::new(m).is_file())
        })
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
    root: &FsPath,
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
        "list_runners" => Ok(serde_json::to_value(pc::list_runners()).unwrap()),
        "list_checkpoints" => {
            let out = pc::list_checkpoints(root).map_err(map_err)?;
            Ok(serde_json::to_value(out).unwrap())
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
        "plan_read" => {
            let id = str_field(extra, "id").unwrap_or_default();
            let out = pc::read_plan(root, &id).map_err(map_err)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        "plan_list" => {
            let out = pc::list_plans(root).map_err(map_err)?;
            Ok(serde_json::to_value(out).unwrap())
        }
        other => Err((
            StatusCode::NOT_FOUND,
            format!("Unknown or unsupported read-only tool: {other}"),
        )),
    }
}

async fn handle(req: Request<Body>, state: HttpState) -> Result<Response<Body>, Infallible> {
    if req.method() == Method::OPTIONS {
        return Ok(json_response(StatusCode::NO_CONTENT, json!({})));
    }

    let path = req.uri().path().to_string();
    let method = req.method().clone();

    // Public health
    if method == Method::GET
        && (path == "/health" || path == "/v1/health" || path == "/v1/agent/health")
    {
        return Ok(json_response(
            StatusCode::OK,
            json!({
                "ok": true,
                "service": "pocketmind-lan-host",
                "read_only": true,
                "workspace_id": HOST_WORKSPACE_ID,
                "version": env!("CARGO_PKG_VERSION")
            }),
        ));
    }

    if let Err(resp) = require_auth(&state, &req) {
        return Ok(resp);
    }

    if method == Method::GET && path == "/v1/models" {
        let loaded = state.app_state.local_backend.loaded_model_path().await;
        let mut data = Vec::new();
        if let Some(p) = loaded.clone() {
            let id = FsPath::new(&p)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("local-model")
                .to_string();
            data.push(json!({
                "id": id,
                "object": "model",
                "owned_by": "pocketmind-local",
                "root": p,
            }));
        }
        data.push(json!({
            "id": "pocketmind-host",
            "object": "model",
            "owned_by": "pocketmind",
        }));
        return Ok(json_response(
            StatusCode::OK,
            json!({ "object": "list", "data": data }),
        ));
    }

    if method == Method::GET && (path == "/v1/workspaces" || path == "/v1/workspaces/host") {
        let root = {
            let db = state.app_state.db.lock().await;
            workspace_root_from_db(&db)
        };
        let row = json!({
            "id": HOST_WORKSPACE_ID,
            "read_only": true,
            "root_path": root,
        });
        if path.ends_with("/host") {
            return Ok(json_response(StatusCode::OK, row));
        }
        return Ok(json_response(StatusCode::OK, json!([row])));
    }

    if method == Method::POST && path == "/v1/chat/completions" {
        return Ok(proxy_chat(state, req).await);
    }

    if method == Method::POST && path.starts_with("/v1/agent/tools/") {
        let tool = path.trim_start_matches("/v1/agent/tools/").to_string();
        return Ok(handle_tool(state, tool, req).await);
    }

    if method == Method::POST && path == "/v1/artifacts/export" {
        return Ok(handle_export(req).await);
    }

    if method == Method::GET && path.starts_with("/v1/artifacts/") {
        let id = path.trim_start_matches("/v1/artifacts/").to_string();
        if id != "export" {
            return Ok(handle_download(&id).await);
        }
    }

    Ok(err_json(StatusCode::NOT_FOUND, format!("No route for {method} {path}")))
}

async fn proxy_chat(state: HttpState, req: Request<Body>) -> Response<Body> {
    if !state.app_state.local_backend.is_loaded() {
        let model = {
            let db = state.app_state.db.lock().await;
            resolve_active_local_model_path(&db)
        };
        if let Some(path) = model {
            let params = crate::llm::GenerationParams::default();
            if let Err(e) = state
                .app_state
                .local_backend
                .load_model(&path, &params)
                .await
            {
                return err_json(
                    StatusCode::SERVICE_UNAVAILABLE,
                    format!(
                        "LAN host has no local model loaded and could not start one: {e}. Load a GGUF in Models on the host PC first."
                    ),
                );
            }
        } else {
            return err_json(
                StatusCode::SERVICE_UNAVAILABLE,
                "LAN host has no local model loaded. On the host PC, open Models, select a GGUF, and start a chat so llama-server is warm.",
            );
        }
    }

    let port = state.app_state.local_backend.local_openai_port();
    let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
    let body_bytes = match hyper::body::to_bytes(req.into_body()).await {
        Ok(b) => b,
        Err(e) => {
            return err_json(
                StatusCode::BAD_REQUEST,
                format!("Invalid request body: {e}"),
            )
        }
    };

    let upstream = match state
        .app_state
        .http
        .post(&url)
        .header("content-type", "application/json")
        .body(body_bytes.to_vec())
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return err_json(
                StatusCode::BAD_GATEWAY,
                format!("LAN host could not reach local llama-server on 127.0.0.1:{port}: {e}"),
            )
        }
    };

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();

    // Stream SSE / JSON body through.
    let stream = upstream.bytes_stream();
    let body = Body::wrap_stream(stream);
    Response::builder()
        .status(status)
        .header("content-type", content_type)
        .header("access-control-allow-origin", "*")
        .body(body)
        .unwrap_or_else(|e| {
            err_json(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to build proxy response: {e}"),
            )
        })
}

async fn handle_tool(state: HttpState, tool: String, req: Request<Body>) -> Response<Body> {
    if MUTATING_TOOLS.contains(&tool.as_str()) {
        return err_json(
            StatusCode::FORBIDDEN,
            format!("Remote LAN sessions are read-only; tool '{tool}' rejected"),
        );
    }
    let bytes = match hyper::body::to_bytes(req.into_body()).await {
        Ok(b) => b,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, format!("Bad body: {e}")),
    };
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, format!("Invalid JSON: {e}")),
    };
    let root = {
        let db = state.app_state.db.lock().await;
        workspace_root_from_db(&db)
    };
    let root = match root {
        Some(r) => r,
        None => {
            return err_json(
                StatusCode::BAD_REQUEST,
                "Host has no PocketCode workspace folder set. On the host PC open PocketCode and choose a workspace folder.",
            )
        }
    };
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return err_json(
            StatusCode::BAD_REQUEST,
            format!("Host workspace folder missing on disk: {root}"),
        );
    }
    let tool_name = tool.clone();
    let result = match tokio::task::spawn_blocking(move || dispatch_tool(&tool_name, &root_path, &body))
        .await
    {
        Ok(Ok(v)) => v,
        Ok(Err((code, msg))) => return err_json(code, msg),
        Err(e) => {
            return err_json(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        }
    };
    json_response(StatusCode::OK, result)
}

#[derive(Debug, Deserialize)]
struct ExportArtifactBody {
    pub title: Option<String>,
    pub markdown: Option<String>,
    pub content: Option<String>,
    pub filename: Option<String>,
    pub spec: Option<Value>,
}

async fn handle_export(req: Request<Body>) -> Response<Body> {
    let bytes = match hyper::body::to_bytes(req.into_body()).await {
        Ok(b) => b,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, format!("Bad body: {e}")),
    };
    let body: ExportArtifactBody = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => return err_json(StatusCode::BAD_REQUEST, format!("Invalid JSON: {e}")),
    };

    let filename = body
        .filename
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            let base = body
                .title
                .clone()
                .unwrap_or_else(|| "export".into())
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                .collect::<String>();
            format!("{base}.docx")
        });
    let filename = if filename.to_ascii_lowercase().ends_with(".docx") {
        filename
    } else {
        format!("{filename}.docx")
    };

    let spec = if let Some(spec) = body.spec {
        spec
    } else {
        let md = body
            .markdown
            .or(body.content)
            .unwrap_or_else(|| "# Export\n\n(empty)".into());
        let title = body.title.unwrap_or_else(|| "Export".into());
        json!({
            "title": title,
            "body_markdown": md,
            "sections": [{ "heading": "", "body_markdown": md, "bullets": [] }]
        })
    };

    let id = Uuid::new_v4().to_string();
    let out_dir = deployment::process_temp_dir().join("lan-artifacts");
    if let Err(e) = std::fs::create_dir_all(&out_dir) {
        return err_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Cannot create artifact dir: {e}"),
        );
    }
    let out_path = out_dir.join(format!("{id}.docx"));
    let out_path_clone = out_path.clone();
    match tokio::task::spawn_blocking(move || {
        doc_export::run_python_exporter(&spec, &DocFormat::Docx, &out_path_clone)
    })
    .await
    {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => return err_json(StatusCode::BAD_REQUEST, e.to_string()),
        Err(e) => return err_json(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }

    {
        let mut guard = runtime().inner.write().await;
        guard.artifacts.insert(
            id.clone(),
            ArtifactEntry {
                path: out_path,
                filename: filename.clone(),
                mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    .into(),
            },
        );
    }

    json_response(
        StatusCode::OK,
        json!({
            "id": id,
            "filename": filename,
            "mime": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "url": format!("/v1/artifacts/{id}"),
            "download_url": format!("/v1/artifacts/{id}"),
        }),
    )
}

async fn handle_download(id: &str) -> Response<Body> {
    let entry = {
        let guard = runtime().inner.read().await;
        guard.artifacts.get(id).map(|e| {
            (
                e.path.clone(),
                e.filename.clone(),
                e.mime.clone(),
            )
        })
    };
    let (path, filename, mime) = match entry {
        Some(e) => e,
        None => return err_json(StatusCode::NOT_FOUND, format!("Artifact not found: {id}")),
    };
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) => {
            return err_json(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Cannot read artifact: {e}"),
            )
        }
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", mime)
        .header(
            "content-disposition",
            format!("attachment; filename=\"{filename}\""),
        )
        .header("access-control-allow-origin", "*")
        .body(Body::from(bytes))
        .unwrap_or_else(|e| {
            err_json(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to build download: {e}"),
            )
        })
}

async fn stop_inner(rt: &LanHostRuntime) {
    let mut guard = rt.inner.write().await;
    if let Some(tx) = guard.shutdown.take() {
        let _ = tx.send(());
    }
    guard.running = false;
}

async fn start_inner(
    rt: &Arc<LanHostRuntime>,
    app_state: &AppState,
    cfg: LanHostConfig,
) -> Result<(), String> {
    stop_inner(rt).await;

    if !cfg.enabled {
        let mut guard = rt.inner.write().await;
        guard.config = cfg;
        guard.running = false;
        guard.last_error = None;
        return Ok(());
    }

    let bits = Arc::new(SharedAppBits {
        db: app_state.db.clone(),
        local_backend: app_state.local_backend.clone(),
        http: reqwest::Client::new(),
    });
    let http_state = HttpState {
        app_state: bits,
        api_key: cfg.api_key.clone(),
    };
    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));

    let make_svc = make_service_fn(move |_conn| {
        let state = http_state.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |req| {
                let state = state.clone();
                handle(req, state)
            }))
        }
    });

    let server = Server::try_bind(&addr).map_err(|e| {
        format!(
            "LAN host failed to bind 0.0.0.0:{} — {e}. Another process may be using that port, or the OS blocked the bind. Try a different port or allow PocketMind through the firewall.",
            cfg.port
        )
    })?;

    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut guard = rt.inner.write().await;
        guard.config = cfg.clone();
        guard.running = true;
        guard.last_error = None;
        guard.shutdown = Some(tx);
    }

    let rt_err = rt.clone();
    tauri::async_runtime::spawn(async move {
        let graceful = server.serve(make_svc).with_graceful_shutdown(async move {
            let _ = rx.await;
        });
        if let Err(e) = graceful.await {
            let mut guard = rt_err.inner.write().await;
            guard.running = false;
            guard.last_error = Some(format!("LAN host server stopped: {e}"));
            log::error!("LAN host server error: {e}");
        } else {
            let mut guard = rt_err.inner.write().await;
            guard.running = false;
        }
    });

    log::info!("PocketMind LAN host listening on 0.0.0.0:{}", cfg.port);
    Ok(())
}

pub async fn bootstrap(app: tauri::AppHandle) {
    {
        let mut slot = runtime().app.lock().await;
        *slot = Some(app.clone());
    }
    let state = app.state::<AppState>();
    let cfg = {
        let db = state.db.lock().await;
        let mut cfg = load_config_from_db(&db);
        if cfg.api_key.trim().is_empty() {
            cfg.api_key = generate_api_key();
        }
        let _ = save_config_to_db(&db, &cfg);
        cfg
    };
    {
        let mut guard = runtime().inner.write().await;
        guard.config = cfg.clone();
    }
    if let Err(e) = start_inner(runtime(), state.inner(), cfg).await {
        let mut guard = runtime().inner.write().await;
        guard.running = false;
        guard.last_error = Some(e.clone());
        log::error!("LAN host failed to start: {e}");
    }
}

#[tauri::command]
pub async fn get_lan_host_status(
    state: tauri::State<'_, AppState>,
) -> AppResult<LanHostStatus> {
    let (cfg, running, err) = {
        let guard = runtime().inner.read().await;
        (
            guard.config.clone(),
            guard.running,
            guard.last_error.clone(),
        )
    };
    let workspace_root = {
        let db = state.db.lock().await;
        workspace_root_from_db(&db)
    };
    let lan_ips = list_lan_ips();
    let base_urls: Vec<String> = lan_ips
        .iter()
        .map(|ip| format!("http://{ip}:{}/v1", cfg.port))
        .collect();
    let model_path = state.local_backend.loaded_model_path().await;
    Ok(LanHostStatus {
        enabled: cfg.enabled,
        running,
        port: cfg.port,
        api_key: cfg.api_key,
        lan_ips,
        base_urls,
        workspace_root,
        workspace_id: HOST_WORKSPACE_ID.into(),
        model_loaded: state.local_backend.is_loaded(),
        model_path,
        error: err,
    })
}

#[tauri::command]
pub async fn set_lan_host_config(
    state: tauri::State<'_, AppState>,
    enabled: bool,
    port: u16,
    regenerate_key: Option<bool>,
) -> AppResult<LanHostStatus> {
    if port == 0 {
        return Err(AppError::Unknown(
            "LAN host port must be between 1 and 65535.".into(),
        ));
    }
    let mut cfg = {
        let guard = runtime().inner.read().await;
        guard.config.clone()
    };
    cfg.enabled = enabled;
    cfg.port = port;
    if regenerate_key.unwrap_or(false) || cfg.api_key.trim().is_empty() {
        cfg.api_key = generate_api_key();
    }
    {
        let db = state.db.lock().await;
        save_config_to_db(&db, &cfg)?;
    }
    if let Err(e) = start_inner(runtime(), state.inner(), cfg).await {
        let mut guard = runtime().inner.write().await;
        guard.last_error = Some(e.clone());
        guard.running = false;
        log::error!("LAN host restart failed: {e}");
    }
    get_lan_host_status(state).await
}

#[tauri::command]
pub async fn restart_lan_host(
    state: tauri::State<'_, AppState>,
) -> AppResult<LanHostStatus> {
    let cfg = {
        let guard = runtime().inner.read().await;
        guard.config.clone()
    };
    if let Err(e) = start_inner(runtime(), state.inner(), cfg).await {
        let mut guard = runtime().inner.write().await;
        guard.last_error = Some(e);
        guard.running = false;
    }
    get_lan_host_status(state).await
}
