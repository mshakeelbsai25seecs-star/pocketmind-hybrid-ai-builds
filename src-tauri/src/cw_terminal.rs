//! Streaming terminal sessions for PocketCode.
//!
//! The one-shot sandbox (`sandbox_runners::run`) only returns output after a process exits, so a
//! test suite or dev server was invisible while it ran. Sessions keep a live output buffer that
//! the UI and the agent can poll, and background sessions survive until they exit or are killed.
//!
//! Gating is unchanged: every session goes through `sandbox_runners::prepare_command`, so the
//! allowlist, git restrictions, metacharacter rejection and env scrubbing all still apply.

use crate::error::{AppError, AppResult};
use crate::sandbox_runners::{apply_sandbox_env, prepare_command};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;

/// Keep the newest slice of output per session; long builds can print megabytes.
const MAX_SESSION_BUFFER: usize = 400 * 1024;
/// Background processes (dev servers, watchers) get a long leash but never forever.
const BACKGROUND_MAX_SECS: u64 = 30 * 60;
/// Retain a bounded run history so the terminal panel can show earlier commands.
const MAX_SESSIONS: usize = 24;
const POLL_INTERVAL_MS: u64 = 150;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalStartInfo {
    pub id: String,
    pub label: String,
    pub command: String,
    pub background: bool,
    pub timeout_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSnapshot {
    pub id: String,
    pub label: String,
    pub command: String,
    pub background: bool,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub killed: bool,
    pub started_at: u64,
    pub duration_ms: u64,
    pub output: String,
    pub total_bytes: u64,
    /// True when `output` is only the tail of a longer stream.
    pub truncated: bool,
}

struct Session {
    id: String,
    label: String,
    command: String,
    background: bool,
    started_at: u64,
    started_instant: std::time::Instant,
    buffer: Mutex<String>,
    total_bytes: AtomicU64,
    dropped_bytes: AtomicU64,
    running: AtomicBool,
    killed: AtomicBool,
    kill_requested: AtomicBool,
    timed_out: AtomicBool,
    exit_code: Mutex<Option<i32>>,
    duration_ms: AtomicU64,
}

impl Session {
    fn append(&self, chunk: &str) {
        self.total_bytes
            .fetch_add(chunk.len() as u64, Ordering::Relaxed);
        let mut buf = self.buffer.lock().unwrap_or_else(|e| e.into_inner());
        buf.push_str(chunk);
        if buf.len() > MAX_SESSION_BUFFER {
            let cut = buf.len() - MAX_SESSION_BUFFER;
            // Trim on a char boundary so the buffer stays valid UTF-8.
            let mut idx = cut;
            while idx < buf.len() && !buf.is_char_boundary(idx) {
                idx += 1;
            }
            let _ = buf.drain(..idx);
            self.dropped_bytes.fetch_add(idx as u64, Ordering::Relaxed);
        }
    }

    fn snapshot(&self, tail_bytes: Option<usize>) -> TerminalSnapshot {
        let buf = self.buffer.lock().unwrap_or_else(|e| e.into_inner());
        let (output, tail_trimmed) = match tail_bytes {
            Some(limit) if buf.len() > limit => {
                let mut start = buf.len() - limit;
                while start < buf.len() && !buf.is_char_boundary(start) {
                    start += 1;
                }
                (buf[start..].to_string(), true)
            }
            _ => (buf.clone(), false),
        };
        let running = self.running.load(Ordering::Relaxed);
        TerminalSnapshot {
            id: self.id.clone(),
            label: self.label.clone(),
            command: self.command.clone(),
            background: self.background,
            running,
            exit_code: *self.exit_code.lock().unwrap_or_else(|e| e.into_inner()),
            timed_out: self.timed_out.load(Ordering::Relaxed),
            killed: self.killed.load(Ordering::Relaxed),
            started_at: self.started_at,
            duration_ms: if running {
                self.started_instant.elapsed().as_millis() as u64
            } else {
                self.duration_ms.load(Ordering::Relaxed)
            },
            output,
            total_bytes: self.total_bytes.load(Ordering::Relaxed),
            truncated: tail_trimmed || self.dropped_bytes.load(Ordering::Relaxed) > 0,
        }
    }
}

fn registry() -> &'static Mutex<Vec<Arc<Session>>> {
    static SESSIONS: OnceLock<Mutex<Vec<Arc<Session>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(Vec::new()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn insert_session(session: Arc<Session>) {
    let mut list = registry().lock().unwrap_or_else(|e| e.into_inner());
    list.push(session);
    while list.len() > MAX_SESSIONS {
        // Only trim finished runs: evicting a live one would make it unkillable.
        match list
            .iter()
            .position(|s| !s.running.load(Ordering::Relaxed))
        {
            Some(victim) => {
                list.remove(victim);
            }
            None => break,
        }
    }
}

fn find_session(id: &str) -> Option<Arc<Session>> {
    let list = registry().lock().unwrap_or_else(|e| e.into_inner());
    list.iter().find(|s| s.id == id).cloned()
}

fn pump(session: Arc<Session>, reader: impl tokio::io::AsyncRead + Unpin + Send + 'static) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            session.append(&line);
            session.append("\n");
        }
    });
}

async fn supervise(session: Arc<Session>, child: Child, timeout_secs: u64) {
    let child = Arc::new(AsyncMutex::new(child));
    loop {
        {
            let mut guard = child.lock().await;
            match guard.try_wait() {
                Ok(Some(status)) => {
                    let mut code = session
                        .exit_code
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    *code = status.code();
                    break;
                }
                Ok(None) => {}
                Err(e) => {
                    session.append(&format!("\n[terminal] wait failed: {e}\n"));
                    break;
                }
            }
            let expired = session.started_instant.elapsed().as_secs() >= timeout_secs;
            if session.kill_requested.load(Ordering::Relaxed) || expired {
                if expired {
                    session.timed_out.store(true, Ordering::Relaxed);
                    session.append(&format!(
                        "\n[terminal] timed out after {timeout_secs}s — process killed.\n"
                    ));
                } else {
                    session.killed.store(true, Ordering::Relaxed);
                    session.append("\n[terminal] killed by user/agent.\n");
                }
                let _ = guard.start_kill();
                // Give the OS a moment, then reap on the next iteration.
            }
        }
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
    session
        .duration_ms
        .store(session.started_instant.elapsed().as_millis() as u64, Ordering::Relaxed);
    session.running.store(false, Ordering::Relaxed);
}

/// Spawn a command as a live session. Returns immediately; poll with [`read`].
pub fn start(
    workspace_root: &Path,
    language: Option<&str>,
    code: Option<String>,
    args: Option<Vec<String>>,
    argv: Option<Vec<String>>,
    background: bool,
) -> AppResult<TerminalStartInfo> {
    let prep = prepare_command(workspace_root, language, code, args, argv)?;
    let timeout_secs = if background {
        BACKGROUND_MAX_SECS
    } else {
        prep.timeout_secs
    };

    let mut cmd = Command::new(&prep.program);
    for a in &prep.args {
        cmd.arg(a);
    }
    cmd.current_dir(&prep.cwd);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    apply_sandbox_env(&mut cmd);
    crate::process_util::no_window_tokio(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Unknown(format!("Failed to start terminal process: {e}")))?;

    let session = Arc::new(Session {
        id: uuid::Uuid::new_v4().to_string(),
        label: prep.label.clone(),
        command: prep.display_command(),
        background,
        started_at: now_secs(),
        started_instant: std::time::Instant::now(),
        buffer: Mutex::new(String::new()),
        total_bytes: AtomicU64::new(0),
        dropped_bytes: AtomicU64::new(0),
        running: AtomicBool::new(true),
        killed: AtomicBool::new(false),
        kill_requested: AtomicBool::new(false),
        timed_out: AtomicBool::new(false),
        exit_code: Mutex::new(None),
        duration_ms: AtomicU64::new(0),
    });

    if let Some(out) = child.stdout.take() {
        pump(session.clone(), out);
    }
    if let Some(err) = child.stderr.take() {
        pump(session.clone(), err);
    }

    let info = TerminalStartInfo {
        id: session.id.clone(),
        label: session.label.clone(),
        command: session.command.clone(),
        background,
        timeout_secs,
    };
    insert_session(session.clone());
    tokio::spawn(supervise(session, child, timeout_secs));
    Ok(info)
}

pub fn read(id: &str, tail_bytes: Option<usize>) -> AppResult<TerminalSnapshot> {
    find_session(id)
        .map(|s| s.snapshot(tail_bytes))
        .ok_or_else(|| AppError::Unknown(format!("Unknown terminal session: {id}")))
}

pub fn kill(id: &str) -> AppResult<TerminalSnapshot> {
    let session = find_session(id)
        .ok_or_else(|| AppError::Unknown(format!("Unknown terminal session: {id}")))?;
    if session.running.load(Ordering::Relaxed) {
        session.kill_requested.store(true, Ordering::Relaxed);
    }
    Ok(session.snapshot(Some(4_000)))
}

/// Newest first, without output bodies — for the terminal panel's session list.
pub fn list() -> Vec<TerminalSnapshot> {
    let list = registry().lock().unwrap_or_else(|e| e.into_inner());
    let mut out: Vec<TerminalSnapshot> = list.iter().map(|s| s.snapshot(Some(0))).collect();
    out.reverse();
    out
}

/// Kill everything still running (workspace switch / app shutdown).
pub fn kill_all() {
    let list = registry().lock().unwrap_or_else(|e| e.into_inner());
    for s in list.iter() {
        if s.running.load(Ordering::Relaxed) {
            s.kill_requested.store(true, Ordering::Relaxed);
        }
    }
}

/// How many sessions are still live (diagnostics / shutdown checks).
pub fn running_count() -> usize {
    let list = registry().lock().unwrap_or_else(|e| e.into_inner());
    list.iter()
        .filter(|s| s.running.load(Ordering::Relaxed))
        .count()
}
