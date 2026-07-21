//! Session debug NDJSON logger (agent instrumentation). Do not log secrets/PII.
use serde_json::json;
use std::fs::OpenOptions;
use std::io::Write;

const LOG_PATHS: &[&str] = &[
    r"D:\nexus-ai-deep-fixed\.cursor\debug-7d5a77.log",
    r"D:\nexus-ai-deep-fixed\debug-7d5a77.log",
];
const SESSION_ID: &str = "7d5a77";

pub fn agent_log(hypothesis_id: &str, location: &str, message: &str, data: serde_json::Value) {
    let payload = json!({
        "sessionId": SESSION_ID,
        "hypothesisId": hypothesis_id,
        "location": location,
        "message": message,
        "data": data,
        "timestamp": chrono_like_ms(),
        "runId": "online-kc-1",
    });
    for path in LOG_PATHS {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{payload}");
        }
    }
}

fn chrono_like_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
