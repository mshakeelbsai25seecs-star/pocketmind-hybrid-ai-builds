//! Optional session debug NDJSON logger. Disabled unless `NEXUS_AGENT_DEBUG=1`.
//! Never writes to hardcoded developer repo paths. Do not log secrets/PII.
use serde_json::json;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

fn debug_enabled() -> bool {
    match std::env::var("NEXUS_AGENT_DEBUG") {
        Ok(v) => {
            let t = v.trim();
            t == "1" || t.eq_ignore_ascii_case("true") || t.eq_ignore_ascii_case("yes")
        }
        Err(_) => false,
    }
}

fn log_path() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("NEXUS_AGENT_DEBUG_LOG") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    let dir = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("PocketMind")
        .join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    Some(dir.join("agent-debug.ndjson"))
}

static SESSION_ID: OnceLock<String> = OnceLock::new();

fn session_id() -> &'static str {
    SESSION_ID.get_or_init(|| {
        std::env::var("NEXUS_AGENT_DEBUG_SESSION")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "pocketmind".to_string())
    })
}

pub fn agent_log(hypothesis_id: &str, location: &str, message: &str, data: serde_json::Value) {
    if !debug_enabled() {
        return;
    }
    let Some(path) = log_path() else {
        return;
    };
    let payload = json!({
        "sessionId": session_id(),
        "hypothesisId": hypothesis_id,
        "location": location,
        "message": message,
        "data": data,
        "timestamp": chrono_like_ms(),
        "runId": "agent-debug",
    });
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{payload}");
    }
}

fn chrono_like_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
