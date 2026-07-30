//! Allowlisted sandbox runners (pragmatic python/node/cmd subset).

use crate::error::{Error, Result};
use crate::store::WorkspaceSidecar;
use crate::path::{canonicalize_root, strip_verbatim};
use crate::types::{RunnerInfo, RunnersStatus, SandboxRunResult};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const SCRIPT_TIMEOUT_SECS: u64 = 120;
/// Build/test tools legitimately run for minutes.
const CLI_TIMEOUT_SECS: u64 = 300;
const MAX_STREAM_BYTES: usize = 200 * 1024;

/// Kept in step with the desktop allowlist so a workspace behaves the same in server mode.
const CLI_ALLOWLIST: &[&str] = &[
    "python", "python3", "node", "npm", "npx", "yarn", "pnpm", "bun", "deno", "cargo", "rustc",
    "go", "java", "javac", "mvn", "gradle", "dotnet", "ruby", "php", "perl", "lua", "pytest",
    "pip", "pip3", "uv", "poetry", "tsc", "tsx", "ts-node", "make", "cmake", "gcc", "g++",
    "clang", "clang++", "rg", "cmd", "git", "phpunit", "composer",
];

const LONG_TIMEOUT_CLIS: &[&str] = &[
    "cargo", "npm", "npx", "yarn", "pnpm", "bun", "deno", "go", "mvn", "gradle", "dotnet", "pip",
    "pip3", "uv", "poetry", "cmake", "make", "composer", "pytest",
];

/// git is inspection-only: verify edits, never rewrite history or touch a remote.
const GIT_SUBCOMMAND_ALLOWLIST: &[&str] = &[
    "status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog",
    "branch", "remote", "config", "stash", "grep", "cat-file", "symbolic-ref", "count-objects",
];

fn git_args_are_read_only(sub: &str, rest: &[String]) -> bool {
    let flags: Vec<String> = rest.iter().map(|a| a.to_ascii_lowercase()).collect();
    let has = |needle: &str| flags.iter().any(|f| f == needle);
    match sub {
        "branch" => !(has("-d") || has("-D") || has("--delete") || has("-m") || has("--move")
            || has("-c") || has("--copy") || has("--set-upstream-to") || has("-f")
            || has("--force")),
        "remote" => flags
            .first()
            .map(|f| f == "-v" || f == "--verbose" || f == "show")
            .unwrap_or(true),
        "config" => (has("--get") || has("--get-all") || has("--list") || has("-l"))
            && !(has("--add") || has("--unset") || has("--unset-all") || has("--replace-all")),
        "stash" => flags.first().map(|f| f == "list" || f == "show").unwrap_or(false),
        _ => true,
    }
}

fn check_git_argv(argv: &[String]) -> Result<()> {
    let sub = argv
        .iter()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if sub.is_empty() {
        return Err(Error::msg(
            "git needs a read-only subcommand, e.g. [\"git\",\"status\",\"--short\"].".to_string(),
        ));
    }
    if !GIT_SUBCOMMAND_ALLOWLIST.iter().any(|a| *a == sub) {
        return Err(Error::msg(format!(
            "git {sub} is not allowed. Inspection only: {}.",
            GIT_SUBCOMMAND_ALLOWLIST.join(", ")
        )));
    }
    let rest: Vec<String> = argv
        .iter()
        .skip(1)
        .skip_while(|a| a.to_ascii_lowercase() != sub)
        .skip(1)
        .cloned()
        .collect();
    if !git_args_are_read_only(&sub, &rest) {
        return Err(Error::msg(format!(
            "git {sub} with those flags would modify the repository. Read-only inspection only."
        )));
    }
    Ok(())
}

fn cli_timeout_secs(bin: &str) -> u64 {
    let n = normalize_bin_name(bin);
    if LONG_TIMEOUT_CLIS.iter().any(|a| *a == n) {
        CLI_TIMEOUT_SECS
    } else {
        SCRIPT_TIMEOUT_SECS
    }
}

fn truncate_stream(s: String) -> String {
    if s.len() <= MAX_STREAM_BYTES {
        s
    } else {
        let mut t = s;
        t.truncate(MAX_STREAM_BYTES);
        t.push_str("\n…[truncated]");
        t
    }
}

fn reject_shell_metacharacters(s: &str) -> Result<()> {
    const BAD: &[char] = &['|', '&', ';', '`', '\n', '\r', '<', '>', '(', ')', '$'];
    if s.chars().any(|c| BAD.contains(&c)) {
        return Err(Error::msg(
            "Shell metacharacters are not allowed in sandbox argv/language.".to_string(),
        ));
    }
    Ok(())
}

fn normalize_bin_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(name)
        .to_ascii_lowercase();
    base.trim_end_matches(".exe")
        .trim_end_matches(".cmd")
        .trim_end_matches(".bat")
        .to_string()
}

fn which_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let candidates = if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };
    for dir in std::env::split_paths(&path) {
        for c in &candidates {
            let candidate = dir.join(c);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn resolve_binary(name: &str) -> Option<PathBuf> {
    let n = normalize_bin_name(name);
    match n.as_str() {
        "python" | "python3" => which_in_path("python3").or_else(|| which_in_path("python")),
        "cmd" => which_in_path("cmd"),
        other => which_in_path(other),
    }
}

fn is_cli_allowed(name: &str) -> bool {
    let n = normalize_bin_name(name);
    CLI_ALLOWLIST.iter().any(|a| *a == n)
}

fn scrub_env(cmd: &mut Command) {
    for key in [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "API_KEY",
        "API_TOKEN",
        "AUTH_TOKEN",
        "ACCESS_TOKEN",
    ] {
        cmd.env_remove(key);
    }
    cmd.env("PYTHONNOUSERSITE", "1");
    cmd.env("PYTHONDONTWRITEBYTECODE", "1");
}

fn run_command(
    program: &Path,
    args: &[String],
    cwd: &Path,
    label: &str,
    timeout_secs: u64,
) -> SandboxRunResult {
    let started = Instant::now();
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    scrub_env(&mut cmd);

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return SandboxRunResult {
                ok: false,
                language: label.to_string(),
                exit_code: None,
                stdout: String::new(),
                stderr: format!("Failed to spawn sandbox process: {e}"),
                timed_out: false,
                duration_ms: started.elapsed().as_millis() as u64,
            };
        }
    };

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    match rx.recv_timeout(Duration::from_secs(timeout_secs)) {
        Ok(Ok(output)) => SandboxRunResult {
            ok: output.status.success(),
            language: label.to_string(),
            exit_code: output.status.code(),
            stdout: truncate_stream(String::from_utf8_lossy(&output.stdout).to_string()),
            stderr: truncate_stream(String::from_utf8_lossy(&output.stderr).to_string()),
            timed_out: false,
            duration_ms: started.elapsed().as_millis() as u64,
        },
        Ok(Err(e)) => SandboxRunResult {
            ok: false,
            language: label.to_string(),
            exit_code: None,
            stdout: String::new(),
            stderr: format!("Sandbox process error: {e}"),
            timed_out: false,
            duration_ms: started.elapsed().as_millis() as u64,
        },
        Err(_) => SandboxRunResult {
            ok: false,
            language: label.to_string(),
            exit_code: None,
            stdout: String::new(),
            stderr: format!("Sandbox timed out after {timeout_secs}s."),
            timed_out: true,
            duration_ms: started.elapsed().as_millis() as u64,
        },
    }
}

/// A gated, ready-to-spawn command. Shared by the one-shot runner and terminal sessions.
#[derive(Debug, Clone)]
pub struct PreparedCmd {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub label: String,
    pub timeout_secs: u64,
}

impl PreparedCmd {
    pub fn display_command(&self) -> String {
        let bin = self
            .program
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("command");
        if self.args.is_empty() {
            bin.to_string()
        } else {
            format!("{bin} {}", self.args.join(" "))
        }
    }
}

/// Same gating as [`run`], without executing — used by terminal sessions.
pub fn prepare(
    workspace_root: &Path,
    language: Option<&str>,
    code: Option<String>,
    args: Option<Vec<String>>,
    argv: Option<Vec<String>>,
) -> Result<PreparedCmd> {
    let root = canonicalize_root(workspace_root)?;
    let extra = args.unwrap_or_default();
    if let Some(argv) = argv {
        if !argv.is_empty() {
            let (program, args, cwd, label) = prepare_cli(&root, &argv)?;
            return Ok(PreparedCmd {
                program,
                args,
                cwd,
                timeout_secs: cli_timeout_secs(&argv[0]),
                label,
            });
        }
    }
    let lang = language
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::msg("Provide language+code for script mode, or argv for CLI mode.".to_string())
        })?;
    let code = code.ok_or_else(|| {
        Error::msg("Script mode requires a non-empty code/script body.".to_string())
    })?;
    let (program, args, cwd, label) = prepare_script(&root, &lang, &code, &extra)?;
    Ok(PreparedCmd {
        program,
        args,
        cwd,
        label,
        timeout_secs: SCRIPT_TIMEOUT_SECS,
    })
}

pub(crate) fn scrub_child_env(cmd: &mut Command) {
    scrub_env(cmd);
}

fn prepare_script(
    root: &Path,
    language: &str,
    code: &str,
    extra_args: &[String],
) -> Result<(PathBuf, Vec<String>, PathBuf, String)> {
    let lang = language.trim().to_ascii_lowercase();
    reject_shell_metacharacters(&lang)?;
    for a in extra_args {
        reject_shell_metacharacters(a)?;
    }

    let run_id = uuid::Uuid::new_v4();
    let sidecar = WorkspaceSidecar::for_workspace(root)?;
    let work = sidecar.sandbox_dir().join(run_id.to_string());
    std::fs::create_dir_all(&work)
        .map_err(|e| Error::msg(format!("Cannot create sandbox dir: {e}")))?;
    let work_canon = strip_verbatim(
        work.canonicalize()
            .map_err(|e| Error::msg(format!("Cannot canonicalize sandbox dir: {e}")))?,
    );

    let (program, mut args, script_name, label): (PathBuf, Vec<String>, &str, String) =
        match lang.as_str() {
            "python" => {
                let p = resolve_binary("python").ok_or_else(|| {
                    Error::msg("Runner 'python' needs `python` on PATH.".to_string())
                })?;
                (p, vec![], "script.py", "python".into())
            }
            "javascript" | "js" | "node" => {
                let p = resolve_binary("node")
                    .ok_or_else(|| Error::msg("Runner 'node' needs `node` on PATH.".to_string()))?;
                (p, vec![], "script.js", "javascript".into())
            }
            "cmd" | "bat" => {
                #[cfg(windows)]
                {
                    let p = resolve_binary("cmd").ok_or_else(|| {
                        Error::msg("Runner 'cmd' needs `cmd` on PATH.".to_string())
                    })?;
                    (
                        p,
                        vec!["/C".into()],
                        "script.bat",
                        "cmd".into(),
                    )
                }
                #[cfg(not(windows))]
                {
                    return Err(Error::msg(
                        "cmd runner is only available on Windows.".to_string(),
                    ));
                }
            }
            other => {
                return Err(Error::msg(format!(
                    "Unsupported script language '{other}'. Use python, node/javascript, or cmd (Windows)."
                )));
            }
        };

    let script_path = work_canon.join(script_name);
    std::fs::write(&script_path, code)
        .map_err(|e| Error::msg(format!("Cannot write sandbox script: {e}")))?;
    args.push(script_path.to_string_lossy().to_string());
    for a in extra_args {
        args.push(a.clone());
    }
    Ok((program, args, root.to_path_buf(), label))
}

fn prepare_cli(root: &Path, argv: &[String]) -> Result<(PathBuf, Vec<String>, PathBuf, String)> {
    if argv.is_empty() {
        return Err(Error::msg(
            "CLI mode requires non-empty argv (e.g. [\"python\",\"-V\"]).".to_string(),
        ));
    }
    for a in argv {
        reject_shell_metacharacters(a)?;
    }
    let bin_name = &argv[0];
    if !is_cli_allowed(bin_name) {
        return Err(Error::msg(format!(
            "Binary '{}' is not on the Code Workspace allowlist.",
            normalize_bin_name(bin_name)
        )));
    }
    if bin_name.contains('/') || bin_name.contains('\\') || bin_name.contains("..") {
        return Err(Error::msg(
            "CLI argv[0] must be a bare allowlisted binary name, not a path.".to_string(),
        ));
    }
    if normalize_bin_name(bin_name) == "git" {
        check_git_argv(argv)?;
    }
    let program = resolve_binary(bin_name).ok_or_else(|| {
        Error::msg(format!(
            "Allowlisted binary '{}' not found on PATH.",
            normalize_bin_name(bin_name)
        ))
    })?;
    Ok((
        program,
        argv[1..].to_vec(),
        root.to_path_buf(),
        format!("cli:{}", normalize_bin_name(bin_name)),
    ))
}

/// Unified sandbox entry: script and/or CLI mode.
pub fn run(
    workspace_root: &Path,
    language: Option<&str>,
    code: Option<String>,
    args: Option<Vec<String>>,
    argv: Option<Vec<String>>,
) -> Result<SandboxRunResult> {
    let root = canonicalize_root(workspace_root)?;
    let extra = args.unwrap_or_default();

    if let Some(argv) = argv {
        if !argv.is_empty() {
            let (program, args, cwd, label) = prepare_cli(&root, &argv)?;
            return Ok(run_command(
                &program,
                &args,
                &cwd,
                &label,
                cli_timeout_secs(&argv[0]),
            ));
        }
    }

    let lang = language
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::msg(
                "Provide language+code for script mode, or argv for CLI mode.".to_string(),
            )
        })?;
    let code = code.ok_or_else(|| {
        Error::msg("Script mode requires a non-empty code/script body.".to_string())
    })?;
    let (program, args, cwd, label) = prepare_script(&root, &lang, &code, &extra)?;
    Ok(run_command(
        &program,
        &args,
        &cwd,
        &label,
        SCRIPT_TIMEOUT_SECS,
    ))
}

fn runner_row(id: &str, kind: &str, bin_names: &[&str], note: &str) -> RunnerInfo {
    let mut found: Option<PathBuf> = None;
    for n in bin_names {
        if let Some(p) = resolve_binary(n) {
            found = Some(p);
            break;
        }
    }
    RunnerInfo {
        id: id.into(),
        kind: kind.into(),
        available: found.is_some(),
        binary: found.map(|p| p.display().to_string()),
        note: note.into(),
    }
}

pub fn list_runners() -> RunnersStatus {
    let runners = vec![
        runner_row("python", "script", &["python"], "Host PATH"),
        runner_row("javascript", "script", &["node"], "Host PATH"),
        runner_row("cmd", "script", &["cmd"], "Windows cmd /C file only"),
        runner_row("npm", "cli", &["npm"], "Host PATH"),
        runner_row("npx", "cli", &["npx"], "Host PATH"),
        runner_row("cargo", "cli", &["cargo"], "Host PATH"),
        runner_row("rg", "cli", &["rg"], "Host PATH"),
        runner_row("git", "cli", &["git"], "Host PATH"),
        runner_row("pip", "cli", &["pip", "pip3"], "Host PATH"),
    ];
    let available = runners.iter().filter(|r| r.available).count();
    let message = format!(
        "{available}/{} runners available. Allowlisted argv-only execution — not a freeform shell.",
        runners.len()
    );
    RunnersStatus { runners, message }
}
