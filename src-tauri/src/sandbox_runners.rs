//! Allowlisted Code Workspace runners (Cursor-like, no freeform shell).
//!
//! - Script mode: language + code → write under `.pocketmind-sandbox/<uuid>/`, argv-only exec
//! - CLI mode: allowlisted `argv[0]` from bundled tooling or host PATH
//! - Never `cmd /c`, `powershell -Command`, or `bash -c` with agent strings

use crate::error::{AppError, AppResult};
use pocketcode_workspace::WorkspaceSidecar;
use crate::tooling;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::process::Command;

const SCRIPT_TIMEOUT_SECS: u64 = 120;
const CLI_TIMEOUT_SECS: u64 = 300;
const MAX_STREAM_BYTES: usize = 200 * 1024;

const SENSITIVE_ENV_KEYS: &[&str] = &[
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "HF_TOKEN",
    "HUGGING_FACE_HUB_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AZURE_OPENAI_API_KEY",
    "AZURE_API_KEY",
    "API_KEY",
    "API_TOKEN",
    "AUTH_TOKEN",
    "ACCESS_TOKEN",
    "SECRET_KEY",
    "PRIVATE_KEY",
];

/// Allowlisted CLI basenames (case-insensitive; Windows extensions stripped).
const CLI_ALLOWLIST: &[&str] = &[
    "python", "python3", "node", "npm", "npx", "yarn", "pnpm", "bun", "deno", "cargo", "rustc",
    "go", "java", "javac", "mvn", "gradle", "dotnet", "ruby", "php", "perl", "lua", "rscript",
    "pytest", "pip", "pip3", "uv", "poetry", "tsc", "tsx", "ts-node", "dart", "flutter",
    "kotlin", "kotlinc", "swift", "zig", "julia", "make", "cmake", "gcc", "g++", "clang",
    "clang++", "rg", "elixir", "mix", "nim", "crystal", "phpunit", "composer", "git",
];

/// git is allowed only for inspection: the agent may verify its own edits, never rewrite
/// history, move refs, or touch a remote.
const GIT_SUBCOMMAND_ALLOWLIST: &[&str] = &[
    "status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog",
    "branch", "remote", "config", "stash", "grep", "cat-file", "symbolic-ref", "count-objects",
];

/// Flags that turn an otherwise read-only git subcommand into a mutation.
fn git_args_are_read_only(sub: &str, rest: &[String]) -> bool {
    let flags: Vec<String> = rest.iter().map(|a| a.to_ascii_lowercase()).collect();
    let has = |needle: &str| flags.iter().any(|f| f == needle);
    match sub {
        "branch" => !(has("-d") || has("-D") || has("--delete") || has("-m") || has("--move")
            || has("-c") || has("--copy") || has("--set-upstream-to") || has("-f")
            || has("--force")),
        // `git remote` alone lists; subverbs add/remove/set-url mutate config.
        "remote" => flags.first().map(|f| f == "-v" || f == "--verbose" || f == "show").unwrap_or(true),
        // Reading config is fine; writing (`--add`, `--unset`, or key value pairs) is not.
        "config" => (has("--get") || has("--get-all") || has("--list") || has("-l"))
            && !(has("--add") || has("--unset") || has("--unset-all") || has("--replace-all")),
        "stash" => flags.first().map(|f| f == "list" || f == "show").unwrap_or(false),
        _ => true,
    }
}

fn check_git_argv(argv: &[String]) -> AppResult<()> {
    let sub = argv
        .iter()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if sub.is_empty() {
        return Err(AppError::Unknown(
            "git needs a read-only subcommand, e.g. [\"git\",\"status\",\"--short\"].".to_string(),
        ));
    }
    if !GIT_SUBCOMMAND_ALLOWLIST.iter().any(|a| *a == sub) {
        return Err(AppError::Unknown(format!(
            "git {sub} is not allowed. Inspection only: {}. Use apply_edit for changes; commits and pushes stay with the user.",
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
        return Err(AppError::Unknown(format!(
            "git {sub} with those flags would modify the repository. Only read-only inspection is allowed."
        )));
    }
    Ok(())
}

const LONG_TIMEOUT_CLIS: &[&str] = &[
    "cargo", "npm", "npx", "yarn", "pnpm", "bun", "deno", "go", "mvn", "gradle", "dotnet",
    "pip", "pip3", "uv", "poetry", "flutter", "cmake", "make", "composer",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxRunResult {
    pub ok: bool,
    pub language: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerInfo {
    pub id: String,
    pub kind: String,
    pub available: bool,
    pub binary: Option<String>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnersStatus {
    pub runners: Vec<RunnerInfo>,
    pub message: String,
}

fn reject_shell_metacharacters(s: &str) -> AppResult<()> {
    const BAD: &[char] = &['|', '&', ';', '`', '\n', '\r', '<', '>', '(', ')', '$'];
    if s.chars().any(|c| BAD.contains(&c)) {
        return Err(AppError::Unknown(
            "Shell metacharacters are not allowed in sandbox argv/language.".to_string(),
        ));
    }
    Ok(())
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

fn scrub_env(cmd: &mut Command) {
    for key in SENSITIVE_ENV_KEYS {
        cmd.env_remove(key);
    }
    let keys: Vec<String> = std::env::vars()
        .map(|(k, _)| k)
        .filter(|k| {
            let u = k.to_ascii_uppercase();
            u.contains("API_KEY")
                || u.contains("SECRET")
                || u.contains("TOKEN")
                || u.contains("PASSWORD")
                || u.contains("CREDENTIAL")
        })
        .collect();
    for k in keys {
        cmd.env_remove(k);
    }
    cmd.env("PYTHONNOUSERSITE", "1");
    cmd.env("PYTHONDONTWRITEBYTECODE", "1");
}

fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    let _ = s;
    path
}

fn path_is_under(root: &Path, candidate: &Path) -> bool {
    let root = strip_verbatim_prefix(root.to_path_buf());
    let candidate = strip_verbatim_prefix(candidate.to_path_buf());
    #[cfg(target_os = "windows")]
    {
        let root_l = root.to_string_lossy().to_ascii_lowercase();
        let cand_l = candidate.to_string_lossy().to_ascii_lowercase();
        cand_l == root_l
            || cand_l.starts_with(&(root_l.clone() + "\\"))
            || cand_l.starts_with(&(root_l + "/"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        candidate == root || candidate.starts_with(root)
    }
}

fn canonicalize_root(root: &Path) -> AppResult<PathBuf> {
    if !root.exists() {
        return Err(AppError::Unknown(format!(
            "Workspace root does not exist: {}",
            root.display()
        )));
    }
    root.canonicalize()
        .map(strip_verbatim_prefix)
        .map_err(|e| AppError::Unknown(format!("Cannot canonicalize workspace root: {e}")))
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
    // Windows Node/npm ship extensionless shims that PowerShell can run but CreateProcess
    // cannot — prefer real executables (.exe/.cmd/.bat) before bare names.
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

/// Prefer bundled tooling for python/node/rg; otherwise PATH.
pub fn resolve_binary(name: &str) -> Option<PathBuf> {
    let n = normalize_bin_name(name);
    match n.as_str() {
        "python" | "python3" => tooling::python_path().or_else(|| {
            which_in_path("python3").or_else(|| which_in_path("python"))
        }),
        "node" => tooling::node_path().or_else(|| which_in_path("node")),
        "rg" => tooling::rg_path().or_else(|| which_in_path("rg")),
        "rscript" => which_in_path("Rscript").or_else(|| which_in_path("rscript")),
        "g++" => which_in_path("g++").or_else(|| which_in_path("g++.exe")),
        "clang++" => which_in_path("clang++"),
        other => which_in_path(other),
    }
}

fn is_cli_allowed(name: &str) -> bool {
    let n = normalize_bin_name(name);
    CLI_ALLOWLIST.iter().any(|a| *a == n)
}

fn cli_timeout_secs(bin: &str) -> u64 {
    let n = normalize_bin_name(bin);
    if LONG_TIMEOUT_CLIS.iter().any(|a| *a == n) {
        CLI_TIMEOUT_SECS
    } else {
        SCRIPT_TIMEOUT_SECS
    }
}

#[derive(Debug)]
pub struct PreparedCmd {
    pub label: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub timeout_secs: u64,
}

impl PreparedCmd {
    /// Display form for terminal UI / agent messages (never the resolved absolute program path).
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

/// Same allowlist/gating as [`run`], but hands back the command instead of executing it.
/// Used by the streaming terminal so background processes obey identical rules.
pub fn prepare_command(
    workspace_root: &Path,
    language: Option<&str>,
    code: Option<String>,
    args: Option<Vec<String>>,
    argv: Option<Vec<String>>,
) -> AppResult<PreparedCmd> {
    let root = canonicalize_root(workspace_root)?;
    let extra = args.unwrap_or_default();

    if let Some(argv) = argv {
        if !argv.is_empty() {
            return prepare_cli(&root, &argv);
        }
    }

    let lang = language
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::Unknown(
                "Provide language+code for script mode, or argv for CLI mode.".to_string(),
            )
        })?;
    // Compile-then-run languages need two commands; the one-shot runner handles those.
    if matches!(lang.as_str(), "rust" | "java" | "csharp" | "cs" | "c#") {
        return Err(AppError::Unknown(format!(
            "Language '{lang}' compiles before running and cannot stream in a terminal session. Run it without background mode."
        )));
    }
    let code = code.ok_or_else(|| {
        AppError::Unknown("Script mode requires a non-empty code/script body.".to_string())
    })?;
    prepare_script(&root, &lang, &code, &extra)
}

/// Apply the same env scrubbing the one-shot sandbox uses.
pub fn apply_sandbox_env(cmd: &mut Command) {
    scrub_env(cmd);
}

/// Build argv for script languages.
fn prepare_script(
    root: &Path,
    language: &str,
    code: &str,
    extra_args: &[String],
) -> AppResult<PreparedCmd> {
    let lang = language.trim().to_ascii_lowercase();
    reject_shell_metacharacters(&lang)?;
    for a in extra_args {
        reject_shell_metacharacters(a)?;
    }

    let run_id = uuid::Uuid::new_v4();
    let sidecar = WorkspaceSidecar::for_workspace(root)
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    let work = sidecar.sandbox_dir().join(run_id.to_string());
    std::fs::create_dir_all(&work)
        .map_err(|e| AppError::Unknown(format!("Cannot create sandbox dir: {e}")))?;
    let work_canon = strip_verbatim_prefix(
        work.canonicalize()
            .map_err(|e| AppError::Unknown(format!("Cannot canonicalize sandbox dir: {e}")))?,
    );

    let missing = |tool: &str| -> AppError {
        AppError::Unknown(format!(
            "Runner '{lang}' needs `{tool}` on PATH (or bundled tooling for python/node). Install it and retry."
        ))
    };

    let mut label = lang.clone();
    let (program, mut args, script_rel): (PathBuf, Vec<String>, Option<&str>) = match lang.as_str() {
        "python" => {
            let p = resolve_binary("python").ok_or_else(|| missing("python"))?;
            (p, vec![], Some("script.py"))
        }
        "javascript" | "js" | "node" => {
            label = "javascript".into();
            let p = resolve_binary("node").ok_or_else(|| missing("node"))?;
            (p, vec![], Some("script.js"))
        }
        "typescript" | "ts" => {
            label = "typescript".into();
            if let Some(bun) = resolve_binary("bun") {
                (bun, vec!["run".into()], Some("script.ts"))
            } else if let Some(deno) = resolve_binary("deno") {
                (deno, vec!["run".into(), "--quiet".into()], Some("script.ts"))
            } else if let Some(npx) = resolve_binary("npx") {
                (npx, vec!["--yes".into(), "tsx".into()], Some("script.ts"))
            } else {
                return Err(missing("bun, deno, or npx (for tsx)"));
            }
        }
        "ruby" => {
            let p = resolve_binary("ruby").ok_or_else(|| missing("ruby"))?;
            (p, vec![], Some("script.rb"))
        }
        "php" => {
            let p = resolve_binary("php").ok_or_else(|| missing("php"))?;
            (p, vec![], Some("script.php"))
        }
        "perl" => {
            let p = resolve_binary("perl").ok_or_else(|| missing("perl"))?;
            (p, vec![], Some("script.pl"))
        }
        "lua" => {
            let p = resolve_binary("lua").ok_or_else(|| missing("lua"))?;
            (p, vec![], Some("script.lua"))
        }
        "r" | "rscript" => {
            label = "r".into();
            let p = resolve_binary("Rscript").ok_or_else(|| missing("Rscript"))?;
            (p, vec![], Some("script.R"))
        }
        "go" => {
            let p = resolve_binary("go").ok_or_else(|| missing("go"))?;
            (p, vec!["run".into()], Some("main.go"))
        }
        "rust" => {
            // Compile step only — `run_rust_script` runs the binary next.
            let rustc = resolve_binary("rustc").ok_or_else(|| missing("rustc"))?;
            let script_path = work_canon.join("main.rs");
            std::fs::write(&script_path, code)
                .map_err(|e| AppError::Unknown(format!("Cannot write sandbox script: {e}")))?;
            let out_name = if cfg!(windows) { "main.exe" } else { "main" };
            let out_path = work_canon.join(out_name);
            return Ok(PreparedCmd {
                label: "rust".into(),
                program: rustc,
                args: vec![
                    script_path.to_string_lossy().to_string(),
                    "-o".into(),
                    out_path.to_string_lossy().to_string(),
                ],
                cwd: work_canon,
                timeout_secs: SCRIPT_TIMEOUT_SECS,
            });
        }
        "java" => {
            let javac = resolve_binary("javac").ok_or_else(|| missing("javac"))?;
            let _java = resolve_binary("java").ok_or_else(|| missing("java"))?;
            let script_path = work_canon.join("Main.java");
            let body = if code.contains("class Main") {
                code.to_string()
            } else {
                format!("public class Main {{\n  public static void main(String[] args) {{\n{code}\n  }}\n}}\n")
            };
            std::fs::write(&script_path, body)
                .map_err(|e| AppError::Unknown(format!("Cannot write sandbox script: {e}")))?;
            return Ok(PreparedCmd {
                label: "java".into(),
                program: javac,
                args: vec!["Main.java".into()],
                cwd: work_canon,
                timeout_secs: SCRIPT_TIMEOUT_SECS,
            });
        }
        "csharp" | "cs" | "c#" => {
            label = "csharp".into();
            let dotnet = resolve_binary("dotnet").ok_or_else(|| missing("dotnet"))?;
            let script_path = work_canon.join("Program.csx");
            // Prefer `dotnet script` if available; else write a tiny console project.
            if which_in_path("dotnet-script").is_some()
                || {
                    let mut dotnet_probe = std::process::Command::new(&dotnet);
                    crate::process_util::no_window_std(&mut dotnet_probe);
                    dotnet_probe
                        .args(["script", "--help"])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map(|s| s.success())
                        .unwrap_or(false)
                }
            {
                std::fs::write(&script_path, code)
                    .map_err(|e| AppError::Unknown(format!("Cannot write sandbox script: {e}")))?;
                (dotnet, vec!["script".into()], Some("Program.csx"))
            } else {
                // Minimal `dotnet new` is heavy; write Program.cs + project file.
                let csproj = r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
"#;
                std::fs::write(work_canon.join("Sandbox.csproj"), csproj)
                    .map_err(|e| AppError::Unknown(format!("Cannot write csproj: {e}")))?;
                let prog = if code.contains("class Program") || code.contains("Main(") {
                    code.to_string()
                } else {
                    format!("Console.WriteLine(\"start\");\n{code}\n")
                };
                // top-level statements
                std::fs::write(work_canon.join("Program.cs"), prog)
                    .map_err(|e| AppError::Unknown(format!("Cannot write Program.cs: {e}")))?;
                // Project files live in the sandbox uuid dir — must run there.
                return Ok(PreparedCmd {
                    label: "csharp".into(),
                    program: dotnet,
                    args: vec![
                        "run".into(),
                        "--project".into(),
                        "Sandbox.csproj".into(),
                    ],
                    cwd: work_canon,
                    timeout_secs: SCRIPT_TIMEOUT_SECS,
                });
            }
        }
        "kotlin" => {
            let kotlinc = resolve_binary("kotlinc").ok_or_else(|| missing("kotlinc"))?;
            (kotlinc, vec!["-script".into()], Some("script.kts"))
        }
        "dart" => {
            let p = resolve_binary("dart").ok_or_else(|| missing("dart"))?;
            (p, vec!["run".into()], Some("script.dart"))
        }
        "julia" => {
            let p = resolve_binary("julia").ok_or_else(|| missing("julia"))?;
            (p, vec![], Some("script.jl"))
        }
        "zig" => {
            let p = resolve_binary("zig").ok_or_else(|| missing("zig"))?;
            (p, vec!["run".into()], Some("main.zig"))
        }
        "bash" | "sh" => {
            label = "bash".into();
            let p = resolve_binary("bash")
                .or_else(|| resolve_binary("sh"))
                .ok_or_else(|| missing("bash or sh"))?;
            (p, vec![], Some("script.sh"))
        }
        "powershell" | "ps1" | "pwsh" => {
            label = "powershell".into();
            let p = resolve_binary("pwsh")
                .or_else(|| resolve_binary("powershell"))
                .ok_or_else(|| missing("pwsh or powershell"))?;
            // File-only execution — never -Command with agent text
            (
                p,
                vec![
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-File".into(),
                ],
                Some("script.ps1"),
            )
        }
        other => {
            return Err(AppError::Unknown(format!(
                "Unsupported script language '{other}'. Use a known language or CLI mode with allowlisted argv (e.g. [\"cargo\",\"test\"])."
            )));
        }
    };

    if let Some(rel) = script_rel {
        let script_path = work_canon.join(rel);
        std::fs::write(&script_path, code)
            .map_err(|e| AppError::Unknown(format!("Cannot write sandbox script: {e}")))?;
        args.push(script_path.to_string_lossy().to_string());
    }
    for a in extra_args {
        args.push(a.clone());
    }

    // Script file lives under .pocketmind-sandbox/<uuid>/, but cwd is the
    // workspace root so relative paths (mkdir, open, cargo, …) hit the project.
    Ok(PreparedCmd {
        label,
        program,
        args,
        cwd: root.to_path_buf(),
        timeout_secs: SCRIPT_TIMEOUT_SECS,
    })
}

fn prepare_cli(root: &Path, argv: &[String]) -> AppResult<PreparedCmd> {
    if argv.is_empty() {
        return Err(AppError::Unknown(
            "CLI mode requires non-empty argv (e.g. [\"cargo\",\"test\"]).".to_string(),
        ));
    }
    for a in argv {
        reject_shell_metacharacters(a)?;
    }
    let bin_name = &argv[0];
    if !is_cli_allowed(bin_name) {
        return Err(AppError::Unknown(format!(
            "Binary '{}' is not on the Code Workspace allowlist. Use an allowlisted tool or script language.",
            normalize_bin_name(bin_name)
        )));
    }
    // Reject path separators in argv[0] — basename only
    if bin_name.contains('/') || bin_name.contains('\\') || bin_name.contains("..") {
        return Err(AppError::Unknown(
            "CLI argv[0] must be a bare allowlisted binary name, not a path.".to_string(),
        ));
    }
    if normalize_bin_name(bin_name) == "git" {
        check_git_argv(argv)?;
    }
    let program = resolve_binary(bin_name).ok_or_else(|| {
        AppError::Unknown(format!(
            "Allowlisted binary '{}' not found on PATH (or bundled tooling).",
            normalize_bin_name(bin_name)
        ))
    })?;
    let args = argv[1..].to_vec();
    let timeout_secs = cli_timeout_secs(bin_name);
    Ok(PreparedCmd {
        label: format!("cli:{}", normalize_bin_name(bin_name)),
        program,
        args,
        cwd: root.to_path_buf(),
        timeout_secs,
    })
}

async fn spawn_and_wait(prep: PreparedCmd) -> AppResult<SandboxRunResult> {
    let started = Instant::now();
    let mut cmd = Command::new(&prep.program);
    for a in &prep.args {
        cmd.arg(a);
    }
    cmd.current_dir(&prep.cwd);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    scrub_env(&mut cmd);
    crate::process_util::no_window_tokio(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Ok(SandboxRunResult {
                ok: false,
                language: prep.label,
                exit_code: None,
                stdout: String::new(),
                stderr: format!("Failed to spawn sandbox process: {e}"),
                timed_out: false,
                duration_ms: started.elapsed().as_millis() as u64,
            });
        }
    };

    let timed = tokio::time::timeout(
        Duration::from_secs(prep.timeout_secs),
        child.wait_with_output(),
    )
    .await;

    let duration_ms = started.elapsed().as_millis() as u64;
    match timed {
        Err(_) => Ok(SandboxRunResult {
            ok: false,
            language: prep.label,
            exit_code: None,
            stdout: String::new(),
            stderr: format!(
                "Sandbox timed out after {}s (process killed).",
                prep.timeout_secs
            ),
            timed_out: true,
            duration_ms,
        }),
        Ok(Err(e)) => Ok(SandboxRunResult {
            ok: false,
            language: prep.label,
            exit_code: None,
            stdout: String::new(),
            stderr: format!("Sandbox process error: {e}"),
            timed_out: false,
            duration_ms,
        }),
        Ok(Ok(output)) => {
            let code = output.status.code();
            let stdout = truncate_stream(String::from_utf8_lossy(&output.stdout).to_string());
            let stderr = truncate_stream(String::from_utf8_lossy(&output.stderr).to_string());
            Ok(SandboxRunResult {
                ok: output.status.success(),
                language: prep.label,
                exit_code: code,
                stdout,
                stderr,
                timed_out: false,
                duration_ms,
            })
        }
    }
}

async fn run_rust_script(root: &Path, code: &str, extra_args: &[String]) -> AppResult<SandboxRunResult> {
    let compile = prepare_script(root, "rust", code, &[])?;
    let out_name = if cfg!(windows) { "main.exe" } else { "main" };
    let out_path = compile.cwd.join(out_name);
    let compile_result = spawn_and_wait(compile).await?;
    if !compile_result.ok {
        return Ok(SandboxRunResult {
            ok: false,
            language: "rust".into(),
            exit_code: compile_result.exit_code,
            stdout: compile_result.stdout,
            stderr: format!("rustc failed:\n{}", compile_result.stderr),
            timed_out: compile_result.timed_out,
            duration_ms: compile_result.duration_ms,
        });
    }
    for a in extra_args {
        reject_shell_metacharacters(a)?;
    }
    let run = PreparedCmd {
        label: "rust".into(),
        program: out_path,
        args: extra_args.to_vec(),
        cwd: root.join(".pocketmind-sandbox"), // overwritten below
        timeout_secs: SCRIPT_TIMEOUT_SECS,
    };
    // cwd should be the sandbox work dir (parent of binary)
    let work = run.program.parent().unwrap().to_path_buf();
    spawn_and_wait(PreparedCmd {
        cwd: work,
        ..run
    })
    .await
}

async fn run_java_script(root: &Path, code: &str, extra_args: &[String]) -> AppResult<SandboxRunResult> {
    let compile = prepare_script(root, "java", code, &[])?;
    let work = compile.cwd.clone();
    let compile_result = spawn_and_wait(compile).await?;
    if !compile_result.ok {
        return Ok(SandboxRunResult {
            ok: false,
            language: "java".into(),
            exit_code: compile_result.exit_code,
            stdout: compile_result.stdout,
            stderr: format!("javac failed:\n{}", compile_result.stderr),
            timed_out: compile_result.timed_out,
            duration_ms: compile_result.duration_ms,
        });
    }
    let java = resolve_binary("java").ok_or_else(|| {
        AppError::Unknown("java not found on PATH after javac succeeded.".to_string())
    })?;
    for a in extra_args {
        reject_shell_metacharacters(a)?;
    }
    let mut args = vec!["Main".into()];
    args.extend(extra_args.iter().cloned());
    spawn_and_wait(PreparedCmd {
        label: "java".into(),
        program: java,
        args,
        cwd: work,
        timeout_secs: SCRIPT_TIMEOUT_SECS,
    })
    .await
}

/// Unified entry: script mode and/or CLI mode.
pub async fn run(
    workspace_root: &Path,
    language: Option<&str>,
    code: Option<String>,
    args: Option<Vec<String>>,
    argv: Option<Vec<String>>,
) -> AppResult<SandboxRunResult> {
    let root = canonicalize_root(workspace_root)?;
    let extra = args.unwrap_or_default();

    if let Some(argv) = argv {
        if !argv.is_empty() {
            let prep = prepare_cli(&root, &argv)?;
            return spawn_and_wait(prep).await;
        }
    }

    let lang = language
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::Unknown(
                "Provide language+code for script mode, or argv for CLI mode.".to_string(),
            )
        })?;
    let code = code.ok_or_else(|| {
        AppError::Unknown("Script mode requires a non-empty code/script body.".to_string())
    })?;

    match lang.as_str() {
        "rust" => run_rust_script(&root, &code, &extra).await,
        "java" => run_java_script(&root, &code, &extra).await,
        _ => {
            let prep = prepare_script(&root, &lang, &code, &extra)?;
            spawn_and_wait(prep).await
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_cli_binary() {
        let root = std::env::temp_dir();
        let err = prepare_cli(&root, &["totally-not-allowed-bin".into()]).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("allowlist") || msg.contains("Allowlisted"), "{msg}");
    }

    #[test]
    fn rejects_shell_metacharacters_in_argv() {
        let root = std::env::temp_dir();
        let err = prepare_cli(&root, &["cargo".into(), "test;rm".into()]).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("metacharacter") || msg.contains("Shell"), "{msg}");
    }

    #[test]
    fn normalizes_windows_exe_suffix() {
        assert_eq!(normalize_bin_name("cargo.exe"), "cargo");
        assert!(is_cli_allowed("NPM.CMD"));
    }

    #[test]
    fn allows_read_only_git_inspection() {
        for argv in [
            vec!["git".to_string(), "status".to_string(), "--short".to_string()],
            vec!["git".to_string(), "diff".to_string(), "--stat".to_string()],
            vec!["git".to_string(), "log".to_string(), "-n".to_string(), "5".to_string()],
            vec!["git".to_string(), "branch".to_string(), "--list".to_string()],
            vec!["git".to_string(), "remote".to_string(), "-v".to_string()],
            vec!["git".to_string(), "config".to_string(), "--get".to_string(), "user.name".to_string()],
        ] {
            assert!(check_git_argv(&argv).is_ok(), "expected allowed: {argv:?}");
        }
    }

    #[test]
    fn blocks_git_mutations() {
        for argv in [
            vec!["git".to_string(), "push".to_string()],
            vec!["git".to_string(), "commit".to_string(), "-m".to_string(), "x".to_string()],
            vec!["git".to_string(), "reset".to_string(), "--hard".to_string()],
            vec!["git".to_string(), "checkout".to_string(), "main".to_string()],
            vec!["git".to_string(), "clean".to_string(), "-fdx".to_string()],
            vec!["git".to_string(), "branch".to_string(), "-D".to_string(), "old".to_string()],
            vec!["git".to_string(), "config".to_string(), "--add".to_string(), "k".to_string(), "v".to_string()],
            vec!["git".to_string(), "stash".to_string(), "pop".to_string()],
            vec!["git".to_string()],
        ] {
            assert!(check_git_argv(&argv).is_err(), "expected blocked: {argv:?}");
        }
    }

    #[test]
    fn terminal_prepare_rejects_compile_then_run_languages() {
        let root = std::env::temp_dir();
        let err = prepare_command(&root, Some("rust"), Some("fn main(){}".into()), None, None)
            .unwrap_err();
        assert!(format!("{err}").contains("background"), "{err}");
    }

    #[cfg(windows)]
    #[test]
    fn resolves_npm_to_spawnable_binary() {
        let root = std::env::temp_dir();
        let prep = prepare_cli(&root, &["npm".into(), "--version".into()]).expect("npm prepare");
        let ext = prep
            .program
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        assert!(
            ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("exe"),
            "npm must resolve to .cmd/.exe for CreateProcess, got {}",
            prep.program.display()
        );
    }
}

pub fn list_runners() -> RunnersStatus {
    let mut runners = vec![
        runner_row("python", "script", &["python"], "Bundled preferred, else PATH"),
        runner_row("javascript", "script", &["node"], "Bundled preferred, else PATH"),
        runner_row(
            "typescript",
            "script",
            &["bun", "deno", "npx"],
            "bun → deno → npx tsx",
        ),
        runner_row("ruby", "script", &["ruby"], "Host PATH"),
        runner_row("php", "script", &["php"], "Host PATH"),
        runner_row("perl", "script", &["perl"], "Host PATH"),
        runner_row("lua", "script", &["lua"], "Host PATH"),
        runner_row("r", "script", &["Rscript"], "Host PATH"),
        runner_row("go", "script", &["go"], "go run"),
        runner_row("rust", "script", &["rustc"], "rustc then run"),
        runner_row("java", "script", &["javac", "java"], "javac + java"),
        runner_row("csharp", "script", &["dotnet"], "dotnet run / script"),
        runner_row("kotlin", "script", &["kotlinc"], "kotlinc -script"),
        runner_row("dart", "script", &["dart"], "dart run"),
        runner_row("julia", "script", &["julia"], "Host PATH"),
        runner_row("zig", "script", &["zig"], "zig run"),
        runner_row("bash", "script", &["bash", "sh"], "File only (no -c)"),
        runner_row(
            "powershell",
            "script",
            &["pwsh", "powershell"],
            "File only (-NoProfile -File)",
        ),
        runner_row("rg", "cli", &["rg"], "Bundled preferred"),
        runner_row("cargo", "cli", &["cargo"], "Host PATH"),
        runner_row("npm", "cli", &["npm"], "Host PATH"),
        runner_row("npx", "cli", &["npx"], "Host PATH"),
        runner_row("yarn", "cli", &["yarn"], "Host PATH"),
        runner_row("pnpm", "cli", &["pnpm"], "Host PATH"),
        runner_row("bun", "cli", &["bun"], "Host PATH"),
        runner_row("deno", "cli", &["deno"], "Host PATH"),
        runner_row("pytest", "cli", &["pytest"], "Host PATH"),
        runner_row("pip", "cli", &["pip", "pip3"], "Host PATH"),
        runner_row("uv", "cli", &["uv"], "Host PATH"),
        runner_row("mvn", "cli", &["mvn"], "Host PATH"),
        runner_row("gradle", "cli", &["gradle"], "Host PATH"),
        runner_row("dotnet", "cli", &["dotnet"], "Host PATH"),
        runner_row("tsc", "cli", &["tsc"], "Host PATH"),
        runner_row("make", "cli", &["make"], "Host PATH"),
        runner_row("cmake", "cli", &["cmake"], "Host PATH"),
    ];

    // Also surface other allowlisted CLIs briefly
    for name in ["gcc", "g++", "clang", "flutter", "swift", "poetry", "composer"] {
        if !runners.iter().any(|r| r.id == name) {
            runners.push(runner_row(name, "cli", &[name], "Host PATH"));
        }
    }

    let available = runners.iter().filter(|r| r.available).count();
    let message = format!(
        "{available}/{} runners available. Allowlisted argv-only execution — not a freeform shell.",
        runners.len()
    );
    RunnersStatus { runners, message }
}
