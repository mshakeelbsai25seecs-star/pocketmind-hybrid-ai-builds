//! End-to-end checks for streaming terminal sessions against real processes.
//!
//! Skipped automatically when python is not on PATH.

use pocketcode_workspace as pc;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn python_available() -> bool {
    let path = match std::env::var_os("PATH") {
        Some(p) => p,
        None => return false,
    };
    let names: Vec<String> = if cfg!(windows) {
        vec!["python.exe".into(), "python3.exe".into()]
    } else {
        vec!["python3".into(), "python".into()]
    };
    std::env::split_paths(&path).any(|dir| names.iter().any(|n| dir.join(n).is_file()))
}

fn temp_root(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pocketcode-term-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp workspace");
    dir
}

fn wait_until(
    id: &str,
    limit: Duration,
    done: impl Fn(&pc::TerminalSnapshot) -> bool,
) -> pc::TerminalSnapshot {
    let started = Instant::now();
    loop {
        let snap = pc::terminal_read(id, None).expect("session should exist");
        if done(&snap) || started.elapsed() > limit {
            return snap;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn streams_output_then_reports_exit_code() {
    if !python_available() {
        eprintln!("skipping: python not on PATH");
        return;
    }
    let root = temp_root("stream");
    let code = r#"
import sys, time
for i in range(3):
    print(f"tick {i}")
    sys.stdout.flush()
    time.sleep(0.1)
"#;
    let info = pc::terminal_start(&root, Some("python"), Some(code.to_string()), None, None, false)
        .expect("start session");

    let snap = wait_until(&info.id, Duration::from_secs(30), |s| !s.running);
    assert!(!snap.running, "process should have exited: {snap:?}");
    assert_eq!(snap.exit_code, Some(0), "output was: {}", snap.output);
    for i in 0..3 {
        assert!(
            snap.output.contains(&format!("tick {i}")),
            "missing tick {i} in: {}",
            snap.output
        );
    }
    assert!(snap.duration_ms > 0);
    assert!(
        pc::terminal_list().iter().any(|s| s.id == info.id),
        "session should appear in the run history",
    );
}

#[test]
fn nonzero_exit_is_reported() {
    if !python_available() {
        eprintln!("skipping: python not on PATH");
        return;
    }
    let root = temp_root("fail");
    let info = pc::terminal_start(
        &root,
        Some("python"),
        Some("import sys; sys.stderr.write('boom\\n'); sys.exit(3)\n".to_string()),
        None,
        None,
        false,
    )
    .expect("start session");
    let snap = wait_until(&info.id, Duration::from_secs(30), |s| !s.running);
    assert_eq!(snap.exit_code, Some(3), "output was: {}", snap.output);
    assert!(snap.output.contains("boom"), "stderr should stream: {}", snap.output);
}

#[test]
fn background_process_keeps_running_until_killed() {
    if !python_available() {
        eprintln!("skipping: python not on PATH");
        return;
    }
    let root = temp_root("background");
    let code = r#"
import sys, time
while True:
    print("serving")
    sys.stdout.flush()
    time.sleep(0.1)
"#;
    let info = pc::terminal_start(&root, Some("python"), Some(code.to_string()), None, None, true)
        .expect("start background session");
    assert!(info.background);
    assert!(info.timeout_secs >= 600, "background runs get a long leash");

    // Still alive after output has appeared — a one-shot runner would have blocked here.
    let alive = wait_until(&info.id, Duration::from_secs(15), |s| s.output.contains("serving"));
    assert!(alive.running, "background process should still be running");
    assert!(alive.output.contains("serving"));

    pc::terminal_kill(&info.id).expect("kill request");
    let dead = wait_until(&info.id, Duration::from_secs(20), |s| !s.running);
    assert!(!dead.running, "kill should stop the process");
    assert!(dead.killed, "snapshot should record the kill: {dead:?}");
}

#[test]
fn git_mutations_are_rejected_before_spawn() {
    let root = temp_root("git");
    let err = pc::terminal_start(
        &root,
        None,
        None,
        None,
        Some(vec!["git".into(), "push".into()]),
        false,
    )
    .expect_err("git push must be rejected");
    let msg = err.to_string();
    assert!(msg.contains("not allowed"), "unexpected message: {msg}");

    // Read-only inspection is fine (git may be absent on the host; only gating is asserted).
    match pc::terminal_start(
        &root,
        None,
        None,
        None,
        Some(vec!["git".into(), "status".into(), "--short".into()]),
        false,
    ) {
        Ok(info) => {
            let _ = wait_until(&info.id, Duration::from_secs(20), |s| !s.running);
        }
        Err(e) => {
            let m = e.to_string();
            assert!(
                m.contains("not found"),
                "git status should only fail when git is missing: {m}"
            );
        }
    }
}
