//! Debug Console: a real interpreter REPL attached to the workspace.
//!
//! Starts Node, Python, or PowerShell as an interactive process with stdin
//! hooked so evaluate() sends expressions and stdout is streamed to the UI.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugSessionInfo {
    pub id: String,
    pub runtime: String,
    pub running: bool,
    pub cwd: String,
}

struct LiveDebug {
    info: DebugSessionInfo,
    child: Mutex<Child>,
    stdin: Mutex<std::process::ChildStdin>,
}

fn slot() -> &'static Mutex<Option<Arc<LiveDebug>>> {
    static S: OnceLock<Mutex<Option<Arc<LiveDebug>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

fn pick_runtime(requested: &str, cwd: &std::path::Path) -> AppResult<(String, String, Vec<String>)> {
    let req = requested.trim().to_ascii_lowercase();
    let try_node = || -> Option<(String, String, Vec<String>)> {
        let prog = if cfg!(windows) { "node.exe" } else { "node" };
        Command::new(prog)
            .arg("-v")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()
            .filter(|s| s.success())
            .map(|_| (prog.to_string(), "node".into(), vec!["-i".into()]))
    };
    let try_python = || -> Option<(String, String, Vec<String>)> {
        for prog in ["python", "python3", "py"] {
            if Command::new(prog)
                .arg("-c")
                .arg("import sys")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .ok()
                .filter(|s| s.success())
                .is_some()
            {
                return Some((
                    prog.into(),
                    "python".into(),
                    vec!["-u".into(), "-i".into()],
                ));
            }
        }
        None
    };
    let try_pwsh = || -> Option<(String, String, Vec<String>)> {
        for prog in ["pwsh", "powershell", "powershell.exe"] {
            if Command::new(prog)
                .arg("-NoLogo")
                .arg("-Command")
                .arg("1")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .ok()
                .is_some()
            {
                return Some((
                    prog.into(),
                    "powershell".into(),
                    vec!["-NoLogo".into(), "-NoExit".into()],
                ));
            }
        }
        None
    };

    let chosen = match req.as_str() {
        "python" => try_python(),
        "powershell" | "pwsh" => try_pwsh(),
        "node" | "javascript" | "typescript" => try_node(),
        "" | "auto" => {
            if cwd.join("package.json").exists() {
                try_node().or_else(try_python).or_else(try_pwsh)
            } else if cwd.join("pyproject.toml").exists() || cwd.join("requirements.txt").exists() {
                try_python().or_else(try_node).or_else(try_pwsh)
            } else {
                try_node().or_else(try_python).or_else(try_pwsh)
            }
        }
        other => {
            return Err(AppError::Unknown(format!(
                "Unknown debug runtime '{other}'. Use node, python, or powershell."
            )))
        }
    };
    chosen.ok_or_else(|| {
        AppError::Unknown(
            "No debug runtime found. Install Node.js, Python, or PowerShell to use the Debug Console."
                .into(),
        )
    })
}

#[derive(Clone, serde::Serialize)]
struct DebugOut {
    id: String,
    stream: String,
    text: String,
}

pub fn start(app: AppHandle, workspace_root: &str, runtime: &str) -> AppResult<DebugSessionInfo> {
    stop()?;
    let cwd = std::path::PathBuf::from(workspace_root);
    if !cwd.is_dir() {
        return Err(AppError::Unknown(
            "Open a workspace folder before starting the Debug Console.".into(),
        ));
    }
    let (program, runtime_id, args) = pick_runtime(runtime, &cwd)?;
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        AppError::Unknown(format!("Failed to start {runtime_id} debug session: {e}"))
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::Unknown("Debug session stdin is unavailable.".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Unknown("Debug session stdout is unavailable.".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Unknown("Debug session stderr is unavailable.".into()))?;

    let id = uuid::Uuid::new_v4().to_string();
    let info = DebugSessionInfo {
        id: id.clone(),
        runtime: runtime_id.clone(),
        running: true,
        cwd: cwd.display().to_string(),
    };
    let live = Arc::new(LiveDebug {
        info: info.clone(),
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
    });
    *slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(live.clone());

    let pump = |app: AppHandle, id: String, stream: &'static str, reader: Box<dyn std::io::Read + Send>| {
        thread::spawn(move || {
            let buf = BufReader::new(reader);
            for line in buf.lines() {
                match line {
                    Ok(text) => {
                        let _ = app.emit_all(
                            "cw-debug-output",
                            DebugOut {
                                id: id.clone(),
                                stream: stream.into(),
                                text,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        });
    };
    pump(app.clone(), id.clone(), "stdout", Box::new(stdout));
    pump(app.clone(), id.clone(), "stderr", Box::new(stderr));
    crate::cw_output::push(
        &app,
        "Debug",
        &format!("Debug Console started ({runtime_id}) in {}", cwd.display()),
    );
    Ok(info)
}

pub fn eval_expr(expr: &str) -> AppResult<()> {
    let g = slot().lock().unwrap_or_else(|e| e.into_inner());
    let live = g
        .as_ref()
        .ok_or_else(|| AppError::Unknown("Debug Console is not running. Click Start first.".into()))?;
    let mut stdin = live.stdin.lock().unwrap_or_else(|e| e.into_inner());
    writeln!(stdin, "{expr}").map_err(|e| AppError::Unknown(format!("Failed to evaluate: {e}")))?;
    stdin
        .flush()
        .map_err(|e| AppError::Unknown(format!("Failed to flush debug input: {e}")))?;
    Ok(())
}

pub fn current() -> Option<DebugSessionInfo> {
    slot()
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|l| l.info.clone()))
}

pub fn stop() -> AppResult<()> {
    let mut g = slot().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(live) = g.take() {
        let mut child = live.child.lock().unwrap_or_else(|e| e.into_inner());
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}
