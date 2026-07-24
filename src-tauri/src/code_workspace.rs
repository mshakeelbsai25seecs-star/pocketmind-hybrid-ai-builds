//! Cursor-technique local Code Workspace tools.
//!
//! All process tools use **only** bundled binaries from
//! `crate::tooling::{rg_path, python_path, node_path}` — never system shell.

use crate::error::{AppError, AppResult};
use crate::tooling;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::process::Command;
use walkdir::WalkDir;

const GREP_TIMEOUT_SECS: u64 = 20;
const GREP_MAX_OUTPUT_BYTES: usize = 200 * 1024;
const READ_MAX_BYTES: usize = 256 * 1024;
const GLOB_MAX_RESULTS: usize = 500;
const SANDBOX_TIMEOUT_SECS: u64 = 30;
const SANDBOX_MAX_STREAM_BYTES: usize = 200 * 1024;

const SKIP_DIR_NAMES: &[&str] = &[".git", "node_modules", "target"];

const LARGE_ONLINE_IDS: &[&str] = &[
    "gpt-4o",
    "gpt-4.1",
    "gpt-4-turbo",
    "claude-3.5-sonnet",
    "claude-3-opus",
    "claude-sonnet-4",
    "claude-opus",
    "deepseek-chat",
    "deepseek-reasoner",
    "deepseek-v3",
    "deepseek-chat-v3",
    "llama-3.3-70b",
    "llama-3.1-70b",
    "llama-3.1-405b",
    "meta-llama-3.1-405b",
    "qwen2.5-72b",
    "qwen-2.5-72b",
    "command-r-plus",
    "glm-5.2",
    "glm-5",
    "z-ai/glm",
];

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

// ── Public result types ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub is_dir: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditPreview {
    pub original: String,
    pub modified: String,
}

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

// ── Path safety ─────────────────────────────────────────────────────────────

fn contains_parent_traversal(path: &str) -> bool {
    path.replace('\\', "/")
        .split('/')
        .any(|segment| segment == "..")
}

/// Normalize separators and trim; does not resolve `.` / `..` (those are rejected).
pub fn standardize(path: &str) -> String {
    let trimmed = path.trim().trim_matches('"');
    #[cfg(target_os = "windows")]
    {
        trimmed.replace('/', "\\")
    }
    #[cfg(not(target_os = "windows"))]
    {
        trimmed.replace('\\', "/")
    }
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
        candidate == root || candidate.starts_with(&root)
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

/// Resolve `rel` under `workspace_root`, rejecting `..` escape. Canonicalizes when the path exists.
pub fn resolve_under_root(workspace_root: &Path, rel: &str) -> AppResult<PathBuf> {
    let root_canon = canonicalize_root(workspace_root)?;
    let rel = rel.trim();
    if rel.is_empty() || rel == "." {
        return Ok(root_canon);
    }
    if contains_parent_traversal(rel) {
        return Err(AppError::Unknown(
            "Path escapes workspace root (contains ..).".to_string(),
        ));
    }
    // Reject absolute paths that are not under root.
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        let abs = if rel_path.exists() {
            strip_verbatim_prefix(rel_path.canonicalize().map_err(|e| {
                AppError::Unknown(format!("Cannot canonicalize path: {e}"))
            })?)
        } else {
            PathBuf::from(standardize(rel))
        };
        if !path_is_under(&root_canon, &abs) {
            return Err(AppError::Unknown(
                "Path is outside the workspace root.".to_string(),
            ));
        }
        return Ok(abs);
    }

    let joined = root_canon.join(standardize(rel));
    // Normalize logical components without allowing `..` (already rejected).
    let mut clean = PathBuf::new();
    for comp in joined.components() {
        match comp {
            Component::ParentDir => {
                return Err(AppError::Unknown(
                    "Path escapes workspace root (contains ..).".to_string(),
                ));
            }
            Component::CurDir => {}
            other => clean.push(other.as_os_str()),
        }
    }

    if clean.exists() {
        let canon = strip_verbatim_prefix(clean.canonicalize().map_err(|e| {
            AppError::Unknown(format!("Cannot canonicalize path: {e}"))
        })?);
        if !path_is_under(&root_canon, &canon) {
            return Err(AppError::Unknown(
                "Path is outside the workspace root.".to_string(),
            ));
        }
        return Ok(canon);
    }

    // Non-existent path (e.g. write target): ensure parent is under root.
    if let Some(parent) = clean.parent() {
        if parent.as_os_str().is_empty() {
            // fall through
        } else if parent.exists() {
            let parent_canon = strip_verbatim_prefix(parent.canonicalize().map_err(|e| {
                AppError::Unknown(format!("Cannot canonicalize parent path: {e}"))
            })?);
            if !path_is_under(&root_canon, &parent_canon) {
                return Err(AppError::Unknown(
                    "Path is outside the workspace root.".to_string(),
                ));
            }
            let name = clean.file_name().ok_or_else(|| {
                AppError::Unknown("Invalid file path.".to_string())
            })?;
            return Ok(parent_canon.join(name));
        } else if !path_is_under(&root_canon, parent) {
            return Err(AppError::Unknown(
                "Path is outside the workspace root.".to_string(),
            ));
        }
    }

    if !path_is_under(&root_canon, &clean) {
        return Err(AppError::Unknown(
            "Path is outside the workspace root.".to_string(),
        ));
    }
    Ok(clean)
}

fn to_rel_display(root: &Path, absolute: &Path) -> String {
    let root = strip_verbatim_prefix(root.to_path_buf());
    let absolute = strip_verbatim_prefix(absolute.to_path_buf());
    absolute
        .strip_prefix(&root)
        .map(|p| {
            let s = p.to_string_lossy().replace('\\', "/");
            if s.is_empty() {
                ".".to_string()
            } else {
                s
            }
        })
        .unwrap_or_else(|_| absolute.to_string_lossy().replace('\\', "/"))
}

fn should_skip_dir(name: &str) -> bool {
    SKIP_DIR_NAMES.iter().any(|n| *n == name)
}

// ── Simple glob matcher (*, ?, **) ──────────────────────────────────────────

fn glob_match(pattern: &str, path: &str) -> bool {
    let pattern = pattern.replace('\\', "/");
    let path = path.replace('\\', "/");
    glob_match_recursive(pattern.as_bytes(), path.as_bytes())
}

fn glob_match_recursive(pat: &[u8], text: &[u8]) -> bool {
    if pat.is_empty() {
        return text.is_empty();
    }
    if pat.starts_with(b"**") {
        let rest = if pat.len() > 2 && pat[2] == b'/' {
            &pat[3..]
        } else {
            &pat[2..]
        };
        if rest.is_empty() {
            return true;
        }
        for i in 0..=text.len() {
            if glob_match_recursive(rest, &text[i..]) {
                return true;
            }
        }
        return false;
    }
    if pat[0] == b'*' {
        let rest = &pat[1..];
        let mut i = 0usize;
        loop {
            if glob_match_recursive(rest, &text[i..]) {
                return true;
            }
            if i >= text.len() || text[i] == b'/' {
                return false;
            }
            i += 1;
        }
    }
    if text.is_empty() {
        return false;
    }
    if pat[0] == b'?' || pat[0] == text[0] {
        return glob_match_recursive(&pat[1..], &text[1..]);
    }
    false
}

// ── Tools ───────────────────────────────────────────────────────────────────

/// List entries in `rel` under `workspace_root`.
pub fn list_dir(workspace_root: &Path, rel: &str) -> AppResult<Vec<DirEntryInfo>> {
    let dir = resolve_under_root(workspace_root, rel)?;
    if !dir.is_dir() {
        return Err(AppError::Unknown(format!(
            "Not a directory: {}",
            to_rel_display(workspace_root, &dir)
        )));
    }
    let root_canon = canonicalize_root(workspace_root)?;
    let mut out = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| AppError::Unknown(format!("Cannot list directory: {e}")))?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "." || name == ".." {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let abs = entry.path();
        let path = to_rel_display(&root_canon, &abs);
        out.push(DirEntryInfo { name, is_dir, path });
    }
    Ok(out)
}

/// Walk workspace for files matching `pattern` (glob). Skips `.git` / `node_modules` / `target`.
pub fn glob_file_search(workspace_root: &Path, pattern: &str) -> AppResult<Vec<String>> {
    let root_canon = canonicalize_root(workspace_root)?;
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Err(AppError::Unknown("glob pattern is required.".to_string()));
    }
    if contains_parent_traversal(pattern) {
        return Err(AppError::Unknown(
            "glob pattern cannot contain parent traversal (..).".to_string(),
        ));
    }

    let mut results = Vec::new();
    let walker = WalkDir::new(&root_canon).follow_links(false).into_iter();
    for entry in walker.filter_entry(|e| {
        if e.depth() == 0 {
            return true;
        }
        let name = e.file_name().to_string_lossy();
        !(e.file_type().is_dir() && should_skip_dir(&name))
    }) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = to_rel_display(&root_canon, entry.path());
        let base = entry
            .path()
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if glob_match(pattern, &rel) || glob_match(pattern, &base) {
            results.push(rel);
            if results.len() >= GLOB_MAX_RESULTS {
                break;
            }
        }
    }
    Ok(results)
}

/// Run bundled ripgrep. Returns stdout (truncated) or an error via `AppResult`.
pub async fn grep(
    workspace_root: &Path,
    pattern: &str,
    path: Option<&str>,
    glob: Option<&str>,
    case_insensitive: bool,
) -> AppResult<String> {
    let root_canon = canonicalize_root(workspace_root)?;
    let search_path = match path {
        Some(p) if !p.trim().is_empty() => resolve_under_root(workspace_root, p)?,
        _ => root_canon.clone(),
    };

    let rg = tooling::rg_path().ok_or_else(|| {
        AppError::Unknown(
            "Bundled ripgrep not found. Run Repair tooling / scripts/fetch-tooling.".to_string(),
        )
    })?;

    if pattern.is_empty() {
        return Err(AppError::Unknown("grep pattern is required.".to_string()));
    }

    let mut cmd = Command::new(&rg);
    cmd.arg("--line-number")
        .arg("--with-filename")
        .arg("--color")
        .arg("never")
        .arg("--no-heading")
        .arg("--max-columns")
        .arg("500")
        .arg("--max-columns-preview");
    if case_insensitive {
        cmd.arg("-i");
    }
    if let Some(g) = glob {
        let g = g.trim();
        if !g.is_empty() {
            if contains_parent_traversal(g) || g.contains('|') || g.contains(';') {
                return Err(AppError::Unknown(
                    "Invalid glob for grep.".to_string(),
                ));
            }
            cmd.arg("--glob").arg(g);
        }
    }
    // Skip heavy dirs
    cmd.arg("--glob")
        .arg("!.git/**")
        .arg("--glob")
        .arg("!node_modules/**")
        .arg("--glob")
        .arg("!target/**");
    cmd.arg("--").arg(pattern).arg(&search_path);
    cmd.current_dir(&root_canon);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Unknown(format!("Failed to spawn ripgrep: {e}")))?;

    let output = match tokio::time::timeout(
        Duration::from_secs(GREP_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Err(AppError::Unknown(format!("ripgrep failed: {e}")));
        }
        Err(_) => {
            return Err(AppError::Unknown(
                "grep timed out after 20s.".to_string(),
            ));
        }
    };

    let mut stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.len() > GREP_MAX_OUTPUT_BYTES {
        stdout.truncate(GREP_MAX_OUTPUT_BYTES);
        stdout.push_str("\n…[truncated at 200KB]");
    }

    // rg exits 1 when no matches — treat as empty success.
    if output.status.success() || output.status.code() == Some(1) {
        return Ok(stdout);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(AppError::Unknown(format!(
        "ripgrep error (exit {:?}): {stderr}",
        output.status.code()
    )))
}

/// Read file with line `offset` (0-based) and `limit` lines. Cap 256KB.
pub fn read_file(
    workspace_root: &Path,
    path: &str,
    offset: usize,
    limit: usize,
) -> AppResult<String> {
    let file = resolve_under_root(workspace_root, path)?;
    if !file.is_file() {
        return Err(AppError::MissingFile(format!(
            "Not a file: {}",
            to_rel_display(workspace_root, &file)
        )));
    }
    let meta = std::fs::metadata(&file)
        .map_err(|e| AppError::Unknown(format!("Cannot stat file: {e}")))?;
    if meta.len() as usize > READ_MAX_BYTES * 4 {
        // Allow large files but only return a window; still cap bytes read.
    }
    let raw = std::fs::read(&file)
        .map_err(|e| AppError::Unknown(format!("Cannot read file: {e}")))?;
    if raw.len() > READ_MAX_BYTES && offset == 0 && limit == 0 {
        let mut s = String::from_utf8_lossy(&raw[..READ_MAX_BYTES]).to_string();
        s.push_str("\n…[truncated at 256KB]");
        return Ok(s);
    }

    let text = String::from_utf8_lossy(&raw);
    let lines: Vec<&str> = text.lines().collect();
    let start = offset.min(lines.len());
    let end = if limit == 0 {
        lines.len()
    } else {
        (start + limit).min(lines.len())
    };
    let mut out = lines[start..end].join("\n");
    if out.len() > READ_MAX_BYTES {
        out.truncate(READ_MAX_BYTES);
        out.push_str("\n…[truncated at 256KB]");
    }
    Ok(out)
}

/// Preview a unique search-replace edit. `old_string` must match exactly once.
pub fn apply_edit_preview(
    workspace_root: &Path,
    path: &str,
    old_string: &str,
    new_string: &str,
) -> AppResult<EditPreview> {
    let file = resolve_under_root(workspace_root, path)?;
    if !file.is_file() {
        return Err(AppError::MissingFile(format!(
            "Not a file: {}",
            to_rel_display(workspace_root, &file)
        )));
    }
    let original = std::fs::read_to_string(&file)
        .map_err(|e| AppError::Unknown(format!("Cannot read file for edit: {e}")))?;
    if original.len() > READ_MAX_BYTES * 8 {
        return Err(AppError::Unknown(
            "File too large to edit via apply_edit.".to_string(),
        ));
    }
    if old_string.is_empty() {
        return Err(AppError::Unknown(
            "old_string must not be empty.".to_string(),
        ));
    }
    let matches: Vec<_> = original.match_indices(old_string).collect();
    if matches.is_empty() {
        return Err(AppError::Unknown(
            "old_string not found in file.".to_string(),
        ));
    }
    if matches.len() > 1 {
        return Err(AppError::Unknown(format!(
            "old_string matched {} times; must be unique.",
            matches.len()
        )));
    }
    let modified = original.replacen(old_string, new_string, 1);
    Ok(EditPreview { original, modified })
}

/// Write full file contents (after DiffViewer accept). Creates parent dirs as needed.
pub fn apply_edit_write(workspace_root: &Path, path: &str, content: &str) -> AppResult<()> {
    let file = resolve_under_root(workspace_root, path)?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Unknown(format!("Cannot create parent dirs: {e}")))?;
        let root_canon = canonicalize_root(workspace_root)?;
        let parent_check = if parent.exists() {
            strip_verbatim_prefix(parent.canonicalize().unwrap_or_else(|_| parent.to_path_buf()))
        } else {
            parent.to_path_buf()
        };
        if !path_is_under(&root_canon, &parent_check) {
            return Err(AppError::Unknown(
                "Refusing to write outside workspace root.".to_string(),
            ));
        }
    }
    std::fs::write(&file, content)
        .map_err(|e| AppError::Unknown(format!("Cannot write file: {e}")))?;
    Ok(())
}

fn scrub_sandbox_env(cmd: &mut Command) {
    for key in SENSITIVE_ENV_KEYS {
        cmd.env_remove(key);
    }
    // Also clear any env whose name looks like a secret.
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

fn reject_shell_metacharacters(s: &str) -> AppResult<()> {
    const BAD: &[char] = &['|', '&', ';', '`', '\n', '\r', '<', '>', '(', ')', '$'];
    if s.chars().any(|c| BAD.contains(&c)) {
        return Err(AppError::Unknown(
            "Shell metacharacters are not allowed in sandbox language/path.".to_string(),
        ));
    }
    Ok(())
}

fn truncate_stream(s: String) -> String {
    if s.len() <= SANDBOX_MAX_STREAM_BYTES {
        s
    } else {
        let mut t = s;
        t.truncate(SANDBOX_MAX_STREAM_BYTES);
        t.push_str("\n…[truncated]");
        t
    }
}

/// Run Python or JavaScript in `workspace/.pocketmind-sandbox/<uuid>/` via bundled tooling only.
pub async fn run_sandbox(
    workspace_root: &Path,
    language: &str,
    code: String,
    args: Option<Vec<String>>,
) -> AppResult<SandboxRunResult> {
    let root_canon = canonicalize_root(workspace_root)?;
    let lang = language.trim().to_ascii_lowercase();
    reject_shell_metacharacters(&lang)?;

    let (bin, script_name) = match lang.as_str() {
        "python" => {
            let p = tooling::python_path().ok_or_else(|| {
                AppError::Unknown(
                    "Bundled Python not found. Run Repair tooling / scripts/fetch-tooling."
                        .to_string(),
                )
            })?;
            (p, "script.py")
        }
        "javascript" | "js" => {
            let p = tooling::node_path().ok_or_else(|| {
                AppError::Unknown(
                    "Bundled Node not found. Run Repair tooling / scripts/fetch-tooling."
                        .to_string(),
                )
            })?;
            (p, "script.js")
        }
        _ => {
            return Err(AppError::Unknown(
                "language must be python or javascript.".to_string(),
            ));
        }
    };

    let run_id = uuid::Uuid::new_v4();
    let work = root_canon
        .join(".pocketmind-sandbox")
        .join(run_id.to_string());
    std::fs::create_dir_all(&work)
        .map_err(|e| AppError::Unknown(format!("Cannot create sandbox dir: {e}")))?;

    // Ensure sandbox stays under root.
    let work_canon = strip_verbatim_prefix(work.canonicalize().map_err(|e| {
        AppError::Unknown(format!("Cannot canonicalize sandbox dir: {e}"))
    })?);
    if !path_is_under(&root_canon, &work_canon) {
        return Err(AppError::Unknown(
            "Sandbox path escaped workspace root.".to_string(),
        ));
    }

    let script_path = work_canon.join(script_name);
    std::fs::write(&script_path, &code)
        .map_err(|e| AppError::Unknown(format!("Cannot write sandbox script: {e}")))?;

    let started = Instant::now();
    let mut cmd = Command::new(&bin);
    // argv only: [bin, script, ...args] — no shell
    cmd.arg(&script_path);
    if let Some(extra) = args {
        for arg in extra {
            reject_shell_metacharacters(&arg)?;
            cmd.arg(arg);
        }
    }
    cmd.current_dir(&work_canon);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    scrub_sandbox_env(&mut cmd);

    let language_label = if lang == "js" {
        "javascript".to_string()
    } else {
        lang.clone()
    };

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Ok(SandboxRunResult {
                ok: false,
                language: language_label,
                exit_code: None,
                stdout: String::new(),
                stderr: format!("Failed to spawn sandbox process: {e}"),
                timed_out: false,
                duration_ms: started.elapsed().as_millis() as u64,
            });
        }
    };

    let timed = tokio::time::timeout(
        Duration::from_secs(SANDBOX_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await;

    let duration_ms = started.elapsed().as_millis() as u64;

    match timed {
        Err(_) => Ok(SandboxRunResult {
            ok: false,
            language: language_label,
            exit_code: None,
            stdout: String::new(),
            stderr: "Sandbox timed out after 30s (process killed).".to_string(),
            timed_out: true,
            duration_ms,
        }),
        Ok(Err(e)) => Ok(SandboxRunResult {
            ok: false,
            language: language_label,
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
                language: language_label,
                exit_code: code,
                stdout,
                stderr,
                timed_out: false,
                duration_ms,
            })
        }
    }
}

// ── Model capability gate (mirrors src/modelCapability.ts) ──────────────────

/// Parse parameter count in billions from a model name / path (e.g. `70B`, `-72b-`).
pub fn parse_params_billions(name: &str) -> Option<f32> {
    let lower = name.to_ascii_lowercase();
    let bytes = lower.as_bytes();

    // Pattern 1: `(\d+(?:\.\d+)?)\s*b\b`
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b'.' {
                i += 1;
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
            }
            let num = &lower[start..i];
            // skip whitespace
            let mut j = i;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'b' {
                let after = j + 1;
                let boundary = after >= bytes.len()
                    || !bytes[after].is_ascii_alphanumeric();
                if boundary {
                    if let Ok(v) = num.parse::<f32>() {
                        return Some(v);
                    }
                }
            }
            continue;
        }
        i += 1;
    }

    // Pattern 2: `[-_](\d+(?:\.\d+)?)b(?:[-_.]|$)`
    for (idx, ch) in lower.char_indices() {
        if ch != '-' && ch != '_' {
            continue;
        }
        let rest = &lower[idx + ch.len_utf8()..];
        let rb = rest.as_bytes();
        if rb.is_empty() || !rb[0].is_ascii_digit() {
            continue;
        }
        let mut k = 0usize;
        while k < rb.len() && rb[k].is_ascii_digit() {
            k += 1;
        }
        if k < rb.len() && rb[k] == b'.' {
            k += 1;
            while k < rb.len() && rb[k].is_ascii_digit() {
                k += 1;
            }
        }
        if k < rb.len() && rb[k] == b'b' {
            let after = k + 1;
            let ok_end = after >= rb.len()
                || matches!(rb[after], b'-' | b'_' | b'.');
            if ok_end {
                if let Ok(v) = rest[..k].parse::<f32>() {
                    return Some(v);
                }
            }
        }
    }
    None
}

fn is_large_online_model(model_path: &str) -> bool {
    let lower = model_path.to_ascii_lowercase();
    if lower.contains("capabilities.code_workspace=true") {
        return true;
    }
    LARGE_ONLINE_IDS.iter().any(|id| lower.contains(id))
}

/// Gate Code Workspace write/run tools to ≥70B local or known large online models.
pub fn can_use_code_workspace(model_path: &str, params: Option<f32>) -> (bool, String) {
    let model_path = model_path.trim();
    if model_path.is_empty() {
        return (
            false,
            "Select a model of 70B+ parameters (or a large online model) for Code Workspace."
                .to_string(),
        );
    }
    if model_path.starts_with("remote:") || model_path.starts_with("enterprise:") {
        if is_large_online_model(model_path) {
            return (true, "Large online / org model".to_string());
        }
        return (
            false,
            "This online model is not tagged as large enough for Code Workspace edit/run tools. Use Folder Q&A / Codebase Explorer instead, or pick a 70B-class / frontier model.".to_string(),
        );
    }
    let params = params.or_else(|| parse_params_billions(model_path));
    if let Some(p) = params {
        if p >= 70.0 {
            return (true, format!("Local model ≈ {p}B"));
        }
        return (
            false,
            format!(
                "Local model ≈ {p}B is below the 70B Code Workspace gate. Use Knowledge Chat Codebase Explorer (read-only) or switch to a 70B+ GGUF."
            ),
        );
    }
    (
        false,
        "Could not determine model size. Code Workspace requires an explicit ≥70B local GGUF or a known large online model.".to_string(),
    )
}
