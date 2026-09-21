//! Output-channel log for PocketCode (Git, Tasks, Diagnostics, Agent).

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

const MAX_LINES: usize = 2000;

#[derive(Debug, Clone, Serialize)]
pub struct OutputLine {
    pub ts: u64,
    pub channel: String,
    pub text: String,
}

fn buf() -> &'static Mutex<VecDeque<OutputLine>> {
    static B: OnceLock<Mutex<VecDeque<OutputLine>>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn push(app: &AppHandle, channel: &str, text: &str) {
    let line = OutputLine {
        ts: now_ms(),
        channel: channel.to_string(),
        text: text.to_string(),
    };
    {
        let mut g = buf().lock().unwrap_or_else(|e| e.into_inner());
        g.push_back(line.clone());
        while g.len() > MAX_LINES {
            g.pop_front();
        }
    }
    let _ = app.emit_all("cw-output", line);
}

pub fn snapshot(channel: Option<&str>) -> Vec<OutputLine> {
    let g = buf().lock().unwrap_or_else(|e| e.into_inner());
    g.iter()
        .filter(|l| channel.map(|c| l.channel.eq_ignore_ascii_case(c)).unwrap_or(true))
        .cloned()
        .collect()
}

pub fn clear(channel: Option<&str>) {
    let mut g = buf().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(c) = channel {
        g.retain(|l| !l.channel.eq_ignore_ascii_case(c));
    } else {
        g.clear();
    }
}
