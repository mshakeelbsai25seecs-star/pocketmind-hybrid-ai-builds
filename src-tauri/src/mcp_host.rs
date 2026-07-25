//! Stdio MCP client host for PocketCode (JSON-RPC over newline-delimited stdin/stdout).

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::deployment;
use crate::error::{AppError, AppResult};

const PROTOCOL_VERSION: &str = "2024-11-05";
const MAX_RESULT_CHARS: usize = 24_000;
const RPC_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct McpConfigFile {
    #[serde(default, rename = "mcpServers", alias = "mcp_servers")]
    pub mcp_servers: HashMap<String, McpServerConfig>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpServerStatus {
    pub id: String,
    pub command: String,
    pub disabled: bool,
    pub running: bool,
    pub tool_count: usize,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpToolInfo {
    pub server: String,
    pub name: String,
    pub description: String,
}

struct LiveServer {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    tools: Vec<McpToolInfo>,
    last_error: Option<String>,
}

pub struct McpHost {
    inner: Mutex<HostState>,
}

struct HostState {
    config: McpConfigFile,
    live: HashMap<String, LiveServer>,
}

impl McpHost {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HostState {
                config: load_config_file().unwrap_or_default(),
                live: HashMap::new(),
            }),
        }
    }

    pub async fn list_servers(&self) -> Vec<McpServerStatus> {
        let state = self.inner.lock().await;
        let mut out = Vec::new();
        for (id, cfg) in &state.config.mcp_servers {
            let live = state.live.get(id);
            out.push(McpServerStatus {
                id: id.clone(),
                command: cfg.command.clone(),
                disabled: cfg.disabled,
                running: live.is_some(),
                tool_count: live.map(|l| l.tools.len()).unwrap_or(0),
                last_error: live.and_then(|l| l.last_error.clone()),
            });
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    pub async fn get_config(&self) -> McpConfigFile {
        self.inner.lock().await.config.clone()
    }

    pub async fn save_config(&self, config: McpConfigFile) -> AppResult<()> {
        save_config_file(&config)?;
        let mut state = self.inner.lock().await;
        let keep: Vec<String> = config
            .mcp_servers
            .iter()
            .filter(|(_, c)| !c.disabled)
            .map(|(k, _)| k.clone())
            .collect();
        let stop_ids: Vec<String> = state
            .live
            .keys()
            .filter(|k| !keep.contains(k))
            .cloned()
            .collect();
        for id in stop_ids {
            if let Some(mut live) = state.live.remove(&id) {
                let _ = live.child.kill().await;
            }
        }
        state.config = config;
        Ok(())
    }

    pub async fn ensure_server(&self, id: &str) -> AppResult<Vec<McpToolInfo>> {
        {
            let state = self.inner.lock().await;
            if let Some(live) = state.live.get(id) {
                return Ok(live.tools.clone());
            }
            let cfg = state
                .config
                .mcp_servers
                .get(id)
                .cloned()
                .ok_or_else(|| AppError::Unknown(format!("Unknown MCP server: {id}")))?;
            if cfg.disabled {
                return Err(AppError::Unknown(format!(
                    "MCP server '{id}' is disabled in config."
                )));
            }
            drop(state);
            let live = spawn_and_initialize(id, &cfg).await?;
            let tools = live.tools.clone();
            let mut state = self.inner.lock().await;
            state.live.insert(id.to_string(), live);
            return Ok(tools);
        }
    }

    pub async fn stop_server(&self, id: &str) -> AppResult<()> {
        let mut state = self.inner.lock().await;
        if let Some(mut live) = state.live.remove(id) {
            let _ = live.child.kill().await;
        }
        Ok(())
    }

    pub async fn list_tools(&self, enabled_ids: &[String]) -> Vec<McpToolInfo> {
        let mut all = Vec::new();
        for id in enabled_ids {
            match self.ensure_server(id).await {
                Ok(tools) => all.extend(tools),
                Err(err) => {
                    let mut state = self.inner.lock().await;
                    if let Some(cfg) = state.config.mcp_servers.get(id) {
                        // Record error on a stub entry by storing a dead live with error — skip.
                        let _ = (cfg, err);
                    }
                }
            }
        }
        all
    }

    pub async fn test_server(&self, id: &str) -> AppResult<Vec<McpToolInfo>> {
        self.stop_server(id).await?;
        self.ensure_server(id).await
    }

    pub async fn call_tool(
        &self,
        server: &str,
        tool: &str,
        arguments: Value,
    ) -> AppResult<String> {
        self.ensure_server(server).await?;
        let mut state = self.inner.lock().await;
        let live = state
            .live
            .get_mut(server)
            .ok_or_else(|| AppError::Unknown(format!("MCP server '{server}' not running.")))?;
        match rpc_request(
            live,
            "tools/call",
            json!({
                "name": tool,
                "arguments": arguments,
            }),
        )
        .await
        {
            Ok(value) => Ok(truncate_result(format_tool_result(&value))),
            Err(err) => {
                live.last_error = Some(err.to_string());
                if let Some(mut dead) = state.live.remove(server) {
                    let _ = dead.child.kill().await;
                }
                Err(err)
            }
        }
    }
}

fn config_path() -> PathBuf {
    let dir = deployment::app_database_dir();
    let _ = std::fs::create_dir_all(&dir);
    dir.join("mcp.json")
}

fn load_config_file() -> AppResult<McpConfigFile> {
    let path = config_path();
    if !path.exists() {
        let empty = McpConfigFile::default();
        save_config_file(&empty)?;
        return Ok(empty);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| AppError::Unknown(format!("Read mcp.json failed: {e}")))?;
    if raw.trim().is_empty() {
        return Ok(McpConfigFile::default());
    }
    serde_json::from_str(&raw).map_err(|e| AppError::Unknown(format!("Invalid mcp.json: {e}")))
}

fn save_config_file(config: &McpConfigFile) -> AppResult<()> {
    let path = config_path();
    let raw = serde_json::to_string_pretty(config)
        .map_err(|e| AppError::Unknown(format!("Serialize mcp.json failed: {e}")))?;
    std::fs::write(&path, raw).map_err(|e| AppError::Unknown(format!("Write mcp.json failed: {e}")))
}

pub fn mcp_config_path_string() -> String {
    config_path().to_string_lossy().to_string()
}

pub fn global_mcp_host() -> Arc<McpHost> {
    static HOST: OnceLock<Arc<McpHost>> = OnceLock::new();
    HOST.get_or_init(|| Arc::new(McpHost::new())).clone()
}

async fn spawn_and_initialize(id: &str, cfg: &McpServerConfig) -> AppResult<LiveServer> {
    if cfg.command.trim().is_empty() {
        return Err(AppError::Unknown(format!("MCP server '{id}' has empty command.")));
    }
    let mut cmd = Command::new(&cfg.command);
    cmd.args(&cfg.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for (k, v) in &cfg.env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Unknown(format!("Failed to start MCP '{id}': {e}")))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::Unknown("MCP stdin missing".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Unknown("MCP stdout missing".into()))?;
    let mut live = LiveServer {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        next_id: 1,
        tools: Vec::new(),
        last_error: None,
    };

    rpc_request(
        &mut live,
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "pocketmind-pocketcode", "version": "0.1.0" }
        }),
    )
    .await
    .map_err(|e| AppError::Unknown(format!("MCP '{id}' initialize failed: {e}")))?;

    let note = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
    });
    write_message(&mut live.stdin, &note).await?;

    let tools_val = rpc_request(&mut live, "tools/list", json!({}))
        .await
        .map_err(|e| AppError::Unknown(format!("MCP '{id}' tools/list failed: {e}")))?;
    live.tools = parse_tools_list(id, &tools_val);
    Ok(live)
}

fn parse_tools_list(server: &str, value: &Value) -> Vec<McpToolInfo> {
    let arr = value
        .get("tools")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();
    arr.into_iter()
        .filter_map(|t| {
            let name = t.get("name")?.as_str()?.to_string();
            let description = t
                .get("description")
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .to_string();
            Some(McpToolInfo {
                server: server.to_string(),
                name,
                description,
            })
        })
        .collect()
}

async fn rpc_request(live: &mut LiveServer, method: &str, params: Value) -> AppResult<Value> {
    let id = live.next_id;
    live.next_id += 1;
    let req = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    write_message(&mut live.stdin, &req).await?;
    match timeout(RPC_TIMEOUT, read_response(&mut live.stdout, id)).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(AppError::Unknown(format!("MCP RPC timeout on {method}"))),
    }
}

async fn write_message(stdin: &mut ChildStdin, value: &Value) -> AppResult<()> {
    let mut line = serde_json::to_string(value)
        .map_err(|e| AppError::Unknown(format!("MCP encode error: {e}")))?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| AppError::Unknown(format!("MCP write failed: {e}")))?;
    stdin
        .flush()
        .await
        .map_err(|e| AppError::Unknown(format!("MCP flush failed: {e}")))?;
    Ok(())
}

async fn read_response(stdout: &mut BufReader<ChildStdout>, expect_id: u64) -> AppResult<Value> {
    let mut line = String::new();
    loop {
        line.clear();
        let n = stdout
            .read_line(&mut line)
            .await
            .map_err(|e| AppError::Unknown(format!("MCP read failed: {e}")))?;
        if n == 0 {
            return Err(AppError::Unknown("MCP server closed stdout.".into()));
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.to_ascii_lowercase().starts_with("content-length:") {
            let len: usize = trimmed
                .split(':')
                .nth(1)
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0);
            let mut blank = String::new();
            let _ = stdout.read_line(&mut blank).await;
            let mut buf = vec![0u8; len];
            stdout
                .read_exact(&mut buf)
                .await
                .map_err(|e| AppError::Unknown(format!("MCP framed read failed: {e}")))?;
            let msg: Value = serde_json::from_slice(&buf)
                .map_err(|e| AppError::Unknown(format!("MCP JSON error: {e}")))?;
            if let Some(result) = handle_rpc_message(&msg, expect_id)? {
                return Ok(result);
            }
            continue;
        }
        let msg: Value = serde_json::from_str(trimmed)
            .map_err(|e| AppError::Unknown(format!("MCP JSON error: {e}")))?;
        if let Some(result) = handle_rpc_message(&msg, expect_id)? {
            return Ok(result);
        }
    }
}

fn handle_rpc_message(msg: &Value, expect_id: u64) -> AppResult<Option<Value>> {
    if msg.get("method").is_some() && msg.get("id").is_none() {
        return Ok(None);
    }
    let id = msg
        .get("id")
        .and_then(|v| v.as_u64())
        .or_else(|| msg.get("id").and_then(|v| v.as_i64()).map(|i| i as u64));
    if id != Some(expect_id) {
        return Ok(None);
    }
    if let Some(err) = msg.get("error") {
        let message = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("MCP error");
        return Err(AppError::Unknown(message.to_string()));
    }
    Ok(Some(msg.get("result").cloned().unwrap_or(Value::Null)))
}

fn format_tool_result(value: &Value) -> String {
    if let Some(content) = value.get("content").and_then(|c| c.as_array()) {
        let texts: Vec<String> = content
            .iter()
            .filter_map(|part| {
                if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                    part.get("text")
                        .and_then(|t| t.as_str())
                        .map(|s| s.to_string())
                } else {
                    Some(part.to_string())
                }
            })
            .collect();
        if !texts.is_empty() {
            return texts.join("\n");
        }
    }
    value.to_string()
}

fn truncate_result(s: String) -> String {
    if s.len() <= MAX_RESULT_CHARS {
        return s;
    }
    format!(
        "{}…\n\n[truncated MCP result — {} chars total]",
        &s[..MAX_RESULT_CHARS],
        s.len()
    )
}

#[derive(Debug, Clone, Serialize)]
pub struct McpCursorBridgeResult {
    pub imported: Vec<String>,
    pub skipped: Vec<String>,
    pub sources: Vec<String>,
    pub cursor_project_path: Option<String>,
    pub ensured_project_config: bool,
}

fn cursor_global_mcp_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".cursor").join("mcp.json"))
}

fn cursor_project_mcp_path(workspace_root: &str) -> PathBuf {
    PathBuf::from(workspace_root).join(".cursor").join("mcp.json")
}

fn expand_workspace_vars(s: &str, workspace_root: Option<&str>) -> String {
    let Some(root) = workspace_root else {
        return s.to_string();
    };
    let root = root.trim_end_matches(['/', '\\']);
    s.replace("${workspaceFolder}", root)
        .replace("${workspaceRoot}", root)
        .replace("${PWD}", root)
}

fn expand_server_config(mut cfg: McpServerConfig, workspace_root: Option<&str>) -> McpServerConfig {
    cfg.command = expand_workspace_vars(&cfg.command, workspace_root);
    cfg.args = cfg
        .args
        .into_iter()
        .map(|a| expand_workspace_vars(&a, workspace_root))
        .collect();
    cfg.env = cfg
        .env
        .into_iter()
        .map(|(k, v)| (k, expand_workspace_vars(&v, workspace_root)))
        .collect();
    cfg
}

/// Parse Cursor-compatible mcp.json; keep only stdio servers (`command` present).
fn parse_cursor_mcp_file(path: &PathBuf) -> AppResult<McpConfigFile> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| AppError::Unknown(format!("Read {} failed: {e}", path.display())))?;
    if raw.trim().is_empty() {
        return Ok(McpConfigFile::default());
    }
    let value: Value = serde_json::from_str(&raw)
        .map_err(|e| AppError::Unknown(format!("Invalid {}: {e}", path.display())))?;
    let servers = value
        .get("mcpServers")
        .or_else(|| value.get("mcp_servers"))
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let mut out = McpConfigFile::default();
    for (id, entry) in servers {
        let Some(command) = entry.get("command").and_then(|c| c.as_str()) else {
            continue;
        };
        if command.trim().is_empty() {
            continue;
        }
        let args = entry
            .get("args")
            .and_then(|a| a.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let mut env = HashMap::new();
        if let Some(obj) = entry.get("env").and_then(|e| e.as_object()) {
            for (k, v) in obj {
                if let Some(s) = v.as_str() {
                    env.insert(k.clone(), s.to_string());
                }
            }
        }
        let disabled = entry
            .get("disabled")
            .and_then(|d| d.as_bool())
            .unwrap_or(false);
        out.mcp_servers.insert(
            id,
            McpServerConfig {
                command: command.to_string(),
                args,
                env,
                disabled,
            },
        );
    }
    Ok(out)
}

fn default_project_cursor_mcp(workspace_root: &str) -> McpConfigFile {
    let mut mcp_servers = HashMap::new();
    mcp_servers.insert(
        "workspace-fs".to_string(),
        McpServerConfig {
            command: "npx".to_string(),
            args: vec![
                "-y".to_string(),
                "@modelcontextprotocol/server-filesystem".to_string(),
                workspace_root.trim_end_matches(['/', '\\']).to_string(),
            ],
            env: HashMap::new(),
            disabled: false,
        },
    );
    McpConfigFile { mcp_servers }
}

fn write_cursor_mcp_file(path: &PathBuf, config: &McpConfigFile) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::Unknown(format!("Create {} failed: {e}", parent.display()))
        })?;
    }
    let body = json!({ "mcpServers": config.mcp_servers });
    let raw = serde_json::to_string_pretty(&body)
        .map_err(|e| AppError::Unknown(format!("Serialize Cursor mcp.json failed: {e}")))?;
    std::fs::write(path, raw)
        .map_err(|e| AppError::Unknown(format!("Write {} failed: {e}", path.display())))
}

/// Ensure project `.cursor/mcp.json` exists, then import Cursor (global + project) stdio
/// servers into PocketCode's mcp.json without overwriting existing ids.
pub async fn setup_cursor_bridge(workspace_root: String) -> AppResult<McpCursorBridgeResult> {
    let root = workspace_root.trim().to_string();
    if root.is_empty() {
        return Err(AppError::Unknown("workspace_root is required".into()));
    }
    let project_path = cursor_project_mcp_path(&root);
    let mut ensured = false;
    if !project_path.exists() {
        write_cursor_mcp_file(&project_path, &default_project_cursor_mcp(&root))?;
        ensured = true;
    }

    let mut sources = Vec::new();
    let mut incoming = HashMap::new();
    let mut skipped = Vec::new();

    if let Some(global) = cursor_global_mcp_path() {
        if global.exists() {
            match parse_cursor_mcp_file(&global) {
                Ok(cfg) => {
                    sources.push(global.to_string_lossy().to_string());
                    for (id, srv) in cfg.mcp_servers {
                        incoming.insert(id, expand_server_config(srv, Some(&root)));
                    }
                }
                Err(err) => skipped.push(format!("global: {err}")),
            }
        }
    }

    if project_path.exists() {
        match parse_cursor_mcp_file(&project_path) {
            Ok(cfg) => {
                sources.push(project_path.to_string_lossy().to_string());
                for (id, srv) in cfg.mcp_servers {
                    incoming.insert(id, expand_server_config(srv, Some(&root)));
                }
            }
            Err(err) => skipped.push(format!("project: {err}")),
        }
    }

    let host = global_mcp_host();
    let mut current = host.get_config().await;
    let mut imported = Vec::new();
    for (id, srv) in incoming {
        if current.mcp_servers.contains_key(&id) {
            skipped.push(format!("{id} (already in PocketCode)"));
            continue;
        }
        current.mcp_servers.insert(id.clone(), srv);
        imported.push(id);
    }
    imported.sort();
    if !imported.is_empty() {
        host.save_config(current).await?;
    }

    Ok(McpCursorBridgeResult {
        imported,
        skipped,
        sources,
        cursor_project_path: Some(project_path.to_string_lossy().to_string()),
        ensured_project_config: ensured,
    })
}

/// Write PocketCode MCP config into the project's `.cursor/mcp.json` (Cursor format).
pub async fn export_to_cursor(workspace_root: String) -> AppResult<String> {
    let root = workspace_root.trim().to_string();
    if root.is_empty() {
        return Err(AppError::Unknown("workspace_root is required".into()));
    }
    let path = cursor_project_mcp_path(&root);
    let config = global_mcp_host().get_config().await;
    write_cursor_mcp_file(&path, &config)?;
    Ok(path.to_string_lossy().to_string())
}

pub fn cursor_mcp_paths(workspace_root: Option<String>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(global) = cursor_global_mcp_path() {
        out.push(global.to_string_lossy().to_string());
    }
    if let Some(root) = workspace_root {
        let root = root.trim();
        if !root.is_empty() {
            out.push(
                cursor_project_mcp_path(root)
                    .to_string_lossy()
                    .to_string(),
            );
        }
    }
    out
}
