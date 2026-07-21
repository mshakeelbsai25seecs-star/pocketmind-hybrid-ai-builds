//! Optional local-LLM OCR correction (Phase 3). Offline only; raw sidecar preserved by caller.

use crate::error::{AppError, AppResult};
use crate::knowledge_chat::ingest_enrich::{apply_optional_ocr_repair, repair_acceptable};
use std::path::Path;
use std::process::Stdio;

/// Apply optional OCR repair. Always keeps `raw_path` untouched when provided.
/// Prefer offline heuristic repair; optionally shell out to a local repair command
/// if `NEXUS_OCR_LLM_REPAIR_CMD` is set (must read stdin, write repaired markdown stdout).
pub fn maybe_repair_ocr_markdown(raw: &str, enabled: bool, repaired_sidecar: Option<&Path>) -> String {
    if !enabled || raw.trim().is_empty() {
        return raw.to_string();
    }
    // Pathological sizes: skip repair to avoid OOM / long stalls.
    if raw.len() > 2_000_000 {
        return raw.to_string();
    }

    let mut candidate = if let Ok(cmd) = std::env::var("NEXUS_OCR_LLM_REPAIR_CMD") {
        if cmd.trim().is_empty() {
            apply_optional_ocr_repair(raw, true).0
        } else {
            match run_external_repair(&cmd, raw) {
                Ok(text) if !text.trim().is_empty() && text.len() < raw.len().saturating_mul(3) => text,
                _ => apply_optional_ocr_repair(raw, true).0,
            }
        }
    } else {
        apply_optional_ocr_repair(raw, true).0
    };

    if !repair_acceptable(raw, &candidate) {
        candidate = raw.to_string();
    }

    if let Some(path) = repaired_sidecar {
        let _ = std::fs::write(path, &candidate);
    }
    candidate
}

fn run_external_repair(cmd: &str, raw: &str) -> AppResult<String> {
    // Format: executable + optional args separated by spaces; document content on stdin.
    let mut parts = cmd.split_whitespace();
    let program = parts
        .next()
        .ok_or_else(|| AppError::Unknown("Empty NEXUS_OCR_LLM_REPAIR_CMD".into()))?;
    let args: Vec<&str> = parts.collect();
    let mut child = std::process::Command::new(program)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| AppError::Unknown(format!("OCR repair command failed to start: {e}")))?;
    use std::io::Write;
    if let Some(mut stdin) = child.stdin.take() {
        let prompt = format!(
            "Fix obvious OCR split words and spelling. Do not add facts. Keep markdown tables and ## Page headers.\n\n{raw}"
        );
        let _ = stdin.write_all(prompt.as_bytes());
    }
    let output = child
        .wait_with_output()
        .map_err(|e| AppError::Unknown(format!("OCR repair command failed: {e}")))?;
    if !output.status.success() {
        return Err(AppError::Unknown("OCR repair command exited non-zero".into()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_returns_raw() {
        let raw = "## Page 1\n\nhello\n";
        assert_eq!(maybe_repair_ocr_markdown(raw, false, None), raw);
    }
}
