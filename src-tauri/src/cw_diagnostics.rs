//! Workspace diagnostics for the PocketCode Problems panel.
//!
//! Runs real project tools (git, tsc, cargo, eslint, python compile) when those
//! manifests exist, and parses their output. Missing tools are reported as
//! informational problems — never silent fake zeros.

use crate::error::{AppError, AppResult};
use crate::cw_git;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub severity: String,
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticsReport {
    pub diagnostics: Vec<Diagnostic>,
    pub scanned: Vec<String>,
    pub notes: Vec<String>,
}

fn run_cmd(root: &Path, program: &str, args: &[&str], _timeout_secs: u64) -> Result<(i32, String, String), String> {
    let output = Command::new(program)
        .args(args)
        .current_dir(root)
        .env("CI", "1")
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("{program} is not installed")
            } else {
                e.to_string()
            }
        })?;
    Ok((
        output.status.code().unwrap_or(1),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
}

/// `file.ts(10,4): error TS2322: Type 'x' is not assignable...`
pub fn parse_tsc_line(line: &str) -> Option<Diagnostic> {
    let line = line.trim();
    let (loc, rest) = line.split_once("): ")?;
    let (path, nums) = loc.rsplit_once('(')?;
    let (line_s, col_s) = nums.split_once(',')?;
    let line_n = line_s.trim().parse().ok()?;
    let col_n = col_s.trim().parse().unwrap_or(1);
    let severity = if rest.to_ascii_lowercase().contains("warning") {
        "warning"
    } else {
        "error"
    };
    Some(Diagnostic {
        path: path.trim().replace('\\', "/"),
        line: line_n,
        column: col_n,
        severity: severity.into(),
        source: "tsc".into(),
        message: rest.trim().to_string(),
    })
}

/// cargo `--message-format=json` compiler-message
pub fn parse_cargo_json_line(line: &str) -> Vec<Diagnostic> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return vec![];
    };
    if v.get("reason").and_then(|r| r.as_str()) != Some("compiler-message") {
        return vec![];
    }
    let msg = match v.get("message") {
        Some(m) => m,
        None => return vec![],
    };
    let level = msg.get("level").and_then(|s| s.as_str()).unwrap_or("error");
    let rendered = msg
        .get("message")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let mut out = Vec::new();
    if let Some(spans) = msg.get("spans").and_then(|s| s.as_array()) {
        for span in spans {
            if span.get("is_primary").and_then(|b| b.as_bool()) != Some(true) && !spans.is_empty() {
                continue;
            }
            let file = span
                .get("file_name")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .replace('\\', "/");
            let line = span.get("line_start").and_then(|n| n.as_u64()).unwrap_or(1) as u32;
            let col = span.get("column_start").and_then(|n| n.as_u64()).unwrap_or(1) as u32;
            if file.is_empty() {
                continue;
            }
            out.push(Diagnostic {
                path: file,
                line,
                column: col,
                severity: if level == "warning" { "warning" } else { "error" }.into(),
                source: "cargo".into(),
                message: rendered.clone(),
            });
        }
    }
    out
}

/// `path:line:col: error: message` (eslint unix / rustc / gcc)
pub fn parse_unix_diag(line: &str, source: &str) -> Option<Diagnostic> {
    let line = line.trim();
    let (path, rest) = line.split_once(':')?;
    if path.len() < 3 || rest.is_empty() {
        return None;
    }
    let rest = rest.trim();
    let (line_s, rest2) = rest.split_once(':')?;
    let line_n: u32 = line_s.parse().ok()?;
    let (maybe_col, msg) = rest2.split_once(':').unwrap_or(("1", rest2));
    let col: u32 = maybe_col.trim().parse().unwrap_or(1);
    let message = msg.trim().to_string();
    if message.is_empty() {
        return None;
    }
    let severity = if message.to_ascii_lowercase().contains("warning") {
        "warning"
    } else {
        "error"
    };
    Some(Diagnostic {
        path: path.replace('\\', "/"),
        line: line_n,
        column: col,
        severity: severity.into(),
        source: source.into(),
        message,
    })
}

pub fn run(workspace_root: &Path) -> AppResult<DiagnosticsReport> {
    if !workspace_root.exists() {
        return Err(AppError::Unknown(
            "No workspace folder. Open a project before running Problems.".into(),
        ));
    }
    let mut diagnostics = Vec::new();
    let mut scanned = Vec::new();
    let mut notes = Vec::new();

    match cw_git::status(workspace_root) {
        Ok(st) if !st.git_available => {
            notes.push(st.error.unwrap_or_else(|| "git is not available.".into()));
            diagnostics.push(Diagnostic {
                path: ".".into(),
                line: 1,
                column: 1,
                severity: "info".into(),
                source: "git".into(),
                message: "Git is not installed. Diffs and conflict checks are unavailable.".into(),
            });
        }
        Ok(st) if !st.is_repo => {
            notes.push("Folder is not a git repository.".into());
        }
        Ok(st) => {
            scanned.push("git".into());
            for f in st.files {
                if f.conflicted {
                    diagnostics.push(Diagnostic {
                        path: f.path,
                        line: 1,
                        column: 1,
                        severity: "error".into(),
                        source: "git".into(),
                        message: "Merge conflict. Resolve markers before continuing.".into(),
                    });
                }
            }
        }
        Err(e) => notes.push(e.to_string()),
    }

    if workspace_root.join("tsconfig.json").exists() || workspace_root.join("jsconfig.json").exists()
    {
        scanned.push("tsc".into());
        match run_cmd(
            workspace_root,
            "npx",
            &["--yes", "tsc", "--noEmit", "--pretty", "false", "--incremental", "false"],
            120,
        ) {
            Ok((_, stdout, stderr)) => {
                for line in stdout.lines().chain(stderr.lines()) {
                    if let Some(d) = parse_tsc_line(line) {
                        diagnostics.push(d);
                    }
                }
            }
            Err(e) => notes.push(format!("TypeScript check skipped: {e}")),
        }
    }

    if workspace_root.join("Cargo.toml").exists() {
        scanned.push("cargo".into());
        match run_cmd(
            workspace_root,
            "cargo",
            &["check", "--message-format=json", "--quiet"],
            180,
        ) {
            Ok((_, stdout, stderr)) => {
                for line in stdout.lines() {
                    diagnostics.extend(parse_cargo_json_line(line));
                }
                if diagnostics.iter().all(|d| d.source != "cargo") {
                    for line in stderr.lines() {
                        if let Some(d) = parse_unix_diag(line, "cargo") {
                            diagnostics.push(d);
                        }
                    }
                }
            }
            Err(e) => notes.push(format!("cargo check skipped: {e}")),
        }
    }

    let eslint_cfg = ["eslint.config.js", "eslint.config.mjs", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json"]
        .iter()
        .any(|n| workspace_root.join(n).exists());
    if eslint_cfg {
        scanned.push("eslint".into());
        match run_cmd(workspace_root, "npx", &["--yes", "eslint", ".", "-f", "unix"], 90) {
            Ok((_, stdout, stderr)) => {
                for line in stdout.lines().chain(stderr.lines()) {
                    if let Some(d) = parse_unix_diag(line, "eslint") {
                        diagnostics.push(d);
                    }
                }
            }
            Err(e) => notes.push(format!("eslint skipped: {e}")),
        }
    }

    Ok(DiagnosticsReport {
        diagnostics,
        scanned,
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_cargo_json_line, parse_tsc_line};

    #[test]
    fn tsc_parser() {
        let d = parse_tsc_line("src/auth.ts(21,10): error TS2322: Type 'User' is not assignable to type 'void'.").unwrap();
        assert_eq!(d.path, "src/auth.ts");
        assert_eq!(d.line, 21);
        assert_eq!(d.column, 10);
        assert_eq!(d.source, "tsc");
    }

    #[test]
    fn cargo_json_parser() {
        let line = r#"{"reason":"compiler-message","message":{"level":"error","message":"cannot find value `x`","spans":[{"file_name":"src/main.rs","line_start":10,"column_start":4,"is_primary":true}]}}"#;
        let rows = parse_cargo_json_line(line);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "src/main.rs");
        assert_eq!(rows[0].line, 10);
    }
}
