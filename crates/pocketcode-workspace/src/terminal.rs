//! Streaming terminal sessions for agent-host (server mode).
//!
//! Mirrors the desktop `cw_terminal` module so a remote workspace behaves the same: live output
//! while a command runs, background processes that outlive the request, and kill control. Gating
//! is delegated to [`crate::sandbox::prepare`], so the allowlist and git rules still apply.

use crate::error::{Error, Result};
use crate::sandbox::{prepare, scrub_child_env};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_SESSION_BUFFER: usize = 400 * 1024;
const BACKGROUND_MAX_SECS: u64 = 30 * 60;
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
    pub truncated: bool,
}

struct Session {
    id: String,
    label: String,
    command: String,
    background: bool,
    started_at: u64,
    started_instant: Instant,
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
            let mut idx = buf.len() - MAX_SESSION_BUFFER;
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
        match list.iter().position(|s| !s.running.load(Ordering::Relaxed)) {
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

fn pump(session: Arc<Session>, reader: impl Read + Send + 'static) {
    std::thread::spawn(move || {
        let mut lines = BufReader::new(reader).lines();
        while let Some(Ok(line)) = lines.next() {
            session.append(&line);
            session.append("\n");
        }
    });
}

fn supervise(session: Arc<Session>, mut child: Child, timeout_secs: u64) {
    std::thread::spawn(move || {
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let mut code = session.exit_code.lock().unwrap_or_else(|e| e.into_inner());
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
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        }
        session.duration_ms.store(
            session.started_instant.elapsed().as_millis() as u64,
            Ordering::Relaxed,
        );
        session.running.store(false, Ordering::Relaxed);
    });
}

pub fn start(
    workspace_root: &Path,
    language: Option<&str>,
    code: Option<String>,
    args: Option<Vec<String>>,
    argv: Option<Vec<String>>,
    background: bool,
) -> Result<TerminalStartInfo> {
    let prep = prepare(workspace_root, language, code, args, argv)?;
    let timeout_secs = if background {
        BACKGROUND_MAX_SECS
    } else {
        prep.timeout_secs
    };

    let mut cmd = std::process::Command::new(&prep.program);
    cmd.args(&prep.args)
        .current_dir(&prep.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    scrub_child_env(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| Error::msg(format!("Failed to start terminal process: {e}")))?;

    let session = Arc::new(Session {
        id: uuid::Uuid::new_v4().to_string(),
        label: prep.label.clone(),
        command: prep.display_command(),
        background,
        started_at: now_secs(),
        started_instant: Instant::now(),
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
    supervise(session, child, timeout_secs);
    Ok(info)
}

pub fn read(id: &str, tail_bytes: Option<usize>) -> Result<TerminalSnapshot> {
    find_session(id)
        .map(|s| s.snapshot(tail_bytes))
        .ok_or_else(|| Error::msg(format!("Unknown terminal session: {id}")))
}

pub fn kill(id: &str) -> Result<TerminalSnapshot> {
    let session =
        find_session(id).ok_or_else(|| Error::msg(format!("Unknown terminal session: {id}")))?;
    if session.running.load(Ordering::Relaxed) {
        session.kill_requested.store(true, Ordering::Relaxed);
    }
    Ok(session.snapshot(Some(4_000)))
}

pub fn list() -> Vec<TerminalSnapshot> {
    let list = registry().lock().unwrap_or_else(|e| e.into_inner());
    let mut out: Vec<TerminalSnapshot> = list.iter().map(|s| s.snapshot(Some(0))).collect();
    out.reverse();
    out
}

pub fn kill_all() {
    let list = registry().lock().unwrap_or_else(|e| e.into_inner());
    for s in list.iter() {
        if s.running.load(Ordering::Relaxed) {
            s.kill_requested.store(true, Ordering::Relaxed);
        }
    }
}
