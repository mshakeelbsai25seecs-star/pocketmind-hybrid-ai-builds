//! Interactive PTY terminals for PocketCode (Cursor-style).
//!
//! The agent sandbox stays allowlisted. This module drives the *user's* real
//! shells: PowerShell (default) and cmd.exe on Windows, with host-shell
//! fallbacks so the same code can be exercised on Linux.

use crate::error::{AppError, AppResult};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MAX_SESSIONS: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyShellInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub path: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtySessionInfo {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub running: bool,
    pub started_at: u64,
    pub exit_code: Option<i32>,
}

struct LivePty {
    info: PtySessionInfo,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
}

fn registry() -> &'static Mutex<HashMap<String, Arc<LivePty>>> {
    static REG: OnceLock<Mutex<HashMap<String, Arc<LivePty>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn first_existing(candidates: &[&str]) -> Option<PathBuf> {
    for c in candidates {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    for c in candidates {
        let name = Path::new(c)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(c);
        if which_in_path(name) {
            return Some(PathBuf::from(name));
        }
    }
    None
}

fn which_in_path(name: &str) -> bool {
    let Ok(path) = std::env::var("PATH") else {
        return false;
    };
    let sep = if cfg!(windows) { ';' } else { ':' };
    let exts: &[&str] = if cfg!(windows) {
        &["", ".exe", ".cmd", ".bat"]
    } else {
        &[""]
    };
    for dir in path.split(sep) {
        for ext in exts {
            let p = Path::new(dir).join(format!("{name}{ext}"));
            if p.exists() {
                return true;
            }
        }
    }
    false
}

pub fn list_shells() -> Vec<PtyShellInfo> {
    let pwsh = first_existing(&[
        r"C:\Program Files\PowerShell\7\pwsh.exe",
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        "pwsh",
        "powershell",
        "powershell.exe",
        "pwsh.exe",
    ]);
    let cmd = first_existing(&[r"C:\Windows\System32\cmd.exe", "cmd.exe", "cmd"]);
    let host = first_existing(&["/bin/bash", "/usr/bin/bash", "bash", "zsh"]);

    vec![
        PtyShellInfo {
            id: "powershell".into(),
            label: "PowerShell".into(),
            available: pwsh.is_some(),
            path: pwsh.as_ref().map(|p| p.display().to_string()),
            note: if pwsh.is_none() {
                Some(
                    "PowerShell was not found. On Windows, PocketMind uses powershell.exe or pwsh.exe."
                        .into(),
                )
            } else {
                None
            },
        },
        PtyShellInfo {
            id: "cmd".into(),
            label: "Command Prompt".into(),
            available: cmd.is_some(),
            path: cmd.as_ref().map(|p| p.display().to_string()),
            note: if cmd.is_none() {
                Some("cmd.exe is only available on Windows.".into())
            } else {
                None
            },
        },
        PtyShellInfo {
            id: "host".into(),
            label: "Host shell".into(),
            available: host.is_some() && !cfg!(windows),
            path: host.as_ref().map(|p| p.display().to_string()),
            note: Some("Used on non-Windows machines for local development.".into()),
        },
    ]
}

fn resolve_shell(kind: &str) -> AppResult<(String, PathBuf, Vec<String>)> {
    let shells = list_shells();
    let id = if kind.trim().is_empty() {
        "powershell"
    } else {
        kind.trim()
    };
    let info = shells
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| AppError::Unknown(format!("Unknown shell '{id}'.")))?;
    if !info.available {
        return Err(AppError::Unknown(
            info.note
                .clone()
                .unwrap_or_else(|| format!("{} is not available on this machine.", info.label)),
        ));
    }
    let path = PathBuf::from(info.path.clone().unwrap());
    let args = match info.id.as_str() {
        "powershell" => vec!["-NoLogo".into()],
        "cmd" => vec![],
        _ => vec![],
    };
    Ok((info.id.clone(), path, args))
}

#[derive(Clone, Serialize)]
struct PtyDataEvent {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExitEvent {
    id: String,
    code: Option<i32>,
}

pub fn spawn(
    app: AppHandle,
    shell: &str,
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
) -> AppResult<PtySessionInfo> {
    let (shell_id, program, extra_args) = resolve_shell(shell)?;
    let cwd_path = cwd
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| std::env::current_dir().ok())
        .or_else(|| dirs::home_dir())
        .ok_or_else(|| AppError::Unknown("No working directory for the terminal.".into()))?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(8),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Unknown(format!("Failed to allocate terminal: {e}")))?;

    let mut cmd = CommandBuilder::new(program);
    for a in extra_args {
        cmd.arg(a);
    }
    cmd.cwd(&cwd_path);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::Unknown(format!("Failed to start {shell_id}: {e}")))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::Unknown(format!("Failed to read terminal output: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::Unknown(format!("Failed to attach terminal input: {e}")))?;

    let id = uuid::Uuid::new_v4().to_string();
    let info = PtySessionInfo {
        id: id.clone(),
        shell: shell_id,
        cwd: cwd_path.display().to_string(),
        running: true,
        started_at: now_secs(),
        exit_code: None,
    };

    let session = Arc::new(LivePty {
        info: info.clone(),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        master: Mutex::new(pair.master),
    });

    {
        let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
        // Drop finished sessions if we hit the cap.
        if map.len() >= MAX_SESSIONS {
            let dead: Vec<String> = map
                .iter()
                .filter(|(_, s)| !s.info.running)
                .map(|(k, _)| k.clone())
                .collect();
            for k in dead {
                map.remove(&k);
            }
        }
        map.insert(id.clone(), session.clone());
    }

    let emit_id = id.clone();
    let emit_app = app.clone();
    thread::Builder::new()
        .name(format!("pty-read-{emit_id}"))
        .spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = emit_app.emit_all(
                            "pty-data",
                            PtyDataEvent {
                                id: emit_id.clone(),
                                data,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
            {
                let mut child = session.child.lock().unwrap_or_else(|e| e.into_inner());
                let _ = child.wait();
            }
            let _ = emit_app.emit_all(
                "pty-exit",
                PtyExitEvent {
                    id: emit_id.clone(),
                    code: None,
                },
            );
        })
        .map_err(|e| AppError::Unknown(format!("Failed to start terminal reader: {e}")))?;

    crate::cw_output::push(
        &app,
        "Terminal",
        &format!("Started {} in {}", info.shell, info.cwd),
    );
    Ok(info)
}

pub fn write(id: &str, data: &str) -> AppResult<()> {
    let map = registry().lock().unwrap_or_else(|e| e.into_inner());
    let session = map
        .get(id)
        .ok_or_else(|| AppError::Unknown("That terminal session is no longer running.".into()))?;
    let mut writer = session.writer.lock().unwrap_or_else(|e| e.into_inner());
    writer
        .write_all(data.as_bytes())
        .map_err(|e| AppError::Unknown(format!("Failed to send input to the terminal: {e}")))?;
    writer
        .flush()
        .map_err(|e| AppError::Unknown(format!("Failed to flush terminal input: {e}")))?;
    Ok(())
}

pub fn resize(id: &str, cols: u16, rows: u16) -> AppResult<()> {
    let map = registry().lock().unwrap_or_else(|e| e.into_inner());
    let session = map
        .get(id)
        .ok_or_else(|| AppError::Unknown("Unknown terminal session.".into()))?;
    let master = session.master.lock().unwrap_or_else(|e| e.into_inner());
    master
        .resize(PtySize {
            rows: rows.max(8),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Unknown(format!("Failed to resize terminal: {e}")))?;
    Ok(())
}

pub fn kill(id: &str) -> AppResult<PtySessionInfo> {
    let map = registry().lock().unwrap_or_else(|e| e.into_inner());
    let session = map
        .get(id)
        .ok_or_else(|| AppError::Unknown("Unknown terminal session.".into()))?;
    {
        let mut child = session.child.lock().unwrap_or_else(|e| e.into_inner());
        let _ = child.kill();
    }
    Ok(session.info.clone())
}

pub fn list() -> Vec<PtySessionInfo> {
    let map = registry().lock().unwrap_or_else(|e| e.into_inner());
    let mut rows: Vec<PtySessionInfo> = map
        .values()
        .map(|s| {
            let running = s
                .child
                .lock()
                .ok()
                .and_then(|mut c| c.try_wait().ok())
                .flatten()
                .is_none();
            PtySessionInfo {
                running,
                ..s.info.clone()
            }
        })
        .collect();
    rows.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    rows
}

#[cfg(test)]
mod tests {
    use super::list_shells;

    #[test]
    fn powershell_is_default_id() {
        let shells = list_shells();
        assert_eq!(shells[0].id, "powershell");
        assert!(shells.iter().any(|s| s.id == "cmd"));
    }
}
