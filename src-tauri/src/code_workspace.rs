//! Cursor-technique local Code Workspace tools.
//!
//! Process tools use allowlisted runners (bundled python/node/rg preferred,
//! then host PATH for languages/frameworks). Never a freeform system shell.

use crate::error::{AppError, AppResult};
use crate::sandbox_runners;
use crate::tooling;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use walkdir::WalkDir;

const GREP_TIMEOUT_SECS: u64 = 20;
const GREP_MAX_OUTPUT_BYTES: usize = 200 * 1024;
pub const READ_MAX_BYTES: usize = 2 * 1024 * 1024;
const GLOB_MAX_RESULTS: usize = 500;
/// Cap list_dir entries so huge roots (models/, indexes/) do not flood agent context.
const LIST_DIR_MAX_ENTRIES: usize = 80;
const BINARY_PEEK_BYTES: usize = 8 * 1024;
/// Default lines when the agent omits limit or passes 0 (never "whole file").
pub const READ_DEFAULT_LINES: usize = 120;
/// Hard cap on lines returned by a single agent read_file call.
pub const READ_MAX_LINES: usize = 400;
/// Cap for UI preview reads (editor pane), not for the agent tool loop.
pub const READ_UI_MAX_LINES: usize = 4_000;

const BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "jar", "exe", "dll", "wasm", "pdf",
    "zip", "7z", "gguf", "bin", "so", "dylib", "class", "o", "a", "lib", "pdb", "woff",
    "woff2", "ttf", "otf", "mp3", "mp4", "wav", "webm", "avi",
];

pub use sandbox_runners::{RunnerInfo, RunnersStatus, SandboxRunResult};

const SKIP_DIR_NAMES: &[&str] = &[".git", "node_modules", "target"];

const LARGE_ONLINE_IDS: &[&str] = &[
    "gpt-4o",
    "gpt-4.1",
    "gpt-4-turbo",
    "claude-3.5-sonnet",
    "claude-3-opus",
    "claude-sonnet-4",
    "claude-opus",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
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
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "pixtral",
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
/// Sorted dirs-first then name; capped at [`LIST_DIR_MAX_ENTRIES`] with a truncation hint.
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
    // Dirs first, then name (case-insensitive).
    entries.sort_by(|a, b| {
        let a_dir = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let b_dir = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
        match (a_dir, b_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a
                .file_name()
                .to_string_lossy()
                .to_lowercase()
                .cmp(&b.file_name().to_string_lossy().to_lowercase()),
        }
    });

    let mut total = 0usize;
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "." || name == ".." {
            continue;
        }
        total += 1;
        if out.len() >= LIST_DIR_MAX_ENTRIES {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let abs = entry.path();
        let path = to_rel_display(&root_canon, &abs);
        out.push(DirEntryInfo { name, is_dir, path });
    }
    if total > LIST_DIR_MAX_ENTRIES {
        out.push(DirEntryInfo {
            name: format!(
                "…[truncated: showing {} of {} entries — use glob_file_search with a pattern when looking for a named file]",
                LIST_DIR_MAX_ENTRIES, total
            ),
            is_dir: false,
            path: String::new(),
        });
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
    crate::process_util::no_window_tokio(&mut cmd);
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

    let child = cmd
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

    // Also search OCR/extract PDF sidecars when grepping the workspace root.
    let searching_root = path.map(|p| p.trim().is_empty()).unwrap_or(true)
        || path.map(|p| p.trim() == "." || p.trim() == "./").unwrap_or(false);
    if searching_root {
        if let Some(ocr_dir) = crate::cw_pdf_prepare::ocr_corpus_dir(&root_canon) {
            let mut ocr_cmd = Command::new(&rg);
            ocr_cmd
                .arg("--line-number")
                .arg("--with-filename")
                .arg("--color")
                .arg("never")
                .arg("--no-heading")
                .arg("--max-columns")
                .arg("500")
                .arg("--max-columns-preview")
                .arg("--glob")
                .arg("*.md");
            if case_insensitive {
                ocr_cmd.arg("-i");
            }
            ocr_cmd.arg("--").arg(pattern).arg(&ocr_dir);
            ocr_cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
            ocr_cmd.kill_on_drop(true);
            if let Ok(child) = ocr_cmd.spawn() {
                if let Ok(Ok(ocr_out)) = tokio::time::timeout(
                    Duration::from_secs(GREP_TIMEOUT_SECS),
                    child.wait_with_output(),
                )
                .await
                {
                    if ocr_out.status.success() || ocr_out.status.code() == Some(1) {
                        let ocr_stdout = String::from_utf8_lossy(&ocr_out.stdout);
                        for line in ocr_stdout.lines() {
                            // Rewrite sidecar filename → original PDF relative path when possible.
                            let rewritten = rewrite_ocr_grep_line(&root_canon, line);
                            stdout.push_str(&rewritten);
                            stdout.push('\n');
                        }
                    }
                }
            }
        }
    }

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

fn path_is_pdf(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

/// Rewrite an OCR-corpus ripgrep hit so the agent sees the original PDF path.
fn rewrite_ocr_grep_line(workspace_root: &Path, line: &str) -> String {
    // Prefer matching `*.md:` near the start after an optional Windows drive.
    let md_idx = line.find(".md:");
    let Some(idx) = md_idx else {
        return line.to_string();
    };
    let file_part = &line[..=idx + 2]; // include .md
    let rest = &line[idx + 3..]; // after .md
    let name = Path::new(file_part)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if let Some(pdf_rel) = crate::cw_pdf_prepare::pdf_rel_for_sidecar_name(workspace_root, name) {
        format!("{pdf_rel}{rest}")
    } else {
        line.to_string()
    }
}

fn path_has_binary_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| BINARY_EXTENSIONS.iter().any(|x| e.eq_ignore_ascii_case(x)))
        .unwrap_or(false)
}

fn path_is_gzip(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("gz") || e.eq_ignore_ascii_case("gzip"))
        .unwrap_or(false)
}

fn decompress_gzip_text(file: &Path, display: &str) -> AppResult<String> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    let fh = std::fs::File::open(file)
        .map_err(|e| AppError::Unknown(format!("Cannot open gzip file: {e}")))?;
    let mut decoder = GzDecoder::new(fh);
    let mut buf = String::new();
    decoder
        .read_to_string(&mut buf)
        .map_err(|e| AppError::Unknown(format!("Cannot decompress gzip `{display}`: {e}")))?;
    if buf.as_bytes().contains(&0) {
        return Err(AppError::Unknown(format!(
            "Gzip content is binary, not text: {display}"
        )));
    }
    Ok(buf)
}

fn reject_if_binary_file(file: &Path, display: &str) -> AppResult<()> {
    if path_has_binary_extension(file) {
        return Err(AppError::Unknown(format!(
            "Not a text file: {display}. Do not call read_file on images/binaries; use OCR/attachment text for screenshots."
        )));
    }
    use std::io::Read;
    let mut fh = std::fs::File::open(file)
        .map_err(|e| AppError::Unknown(format!("Cannot open file: {e}")))?;
    let mut buf = vec![0u8; BINARY_PEEK_BYTES];
    let n = fh
        .read(&mut buf)
        .map_err(|e| AppError::Unknown(format!("Cannot read file: {e}")))?;
    if buf[..n].contains(&0) {
        return Err(AppError::Unknown(format!(
            "Not a text file (binary content detected): {display}. Do not call read_file on binaries."
        )));
    }
    Ok(())
}

fn normalize_newlines(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

fn dominant_eol(s: &str) -> &'static str {
    if s.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn escape_for_error(s: &str) -> String {
    let n = normalize_newlines(s);
    let preview: String = n.chars().take(120).collect();
    let mut out = preview.replace('\n', "\\n");
    if n.chars().count() > 120 {
        out.push_str("…");
    }
    out
}

fn read_text_window_from_string(
    body: &str,
    display: &str,
    offset: usize,
    limit: usize,
    line_cap: Option<usize>,
) -> AppResult<String> {
    let hard_cap = line_cap
        .unwrap_or(READ_MAX_LINES)
        .clamp(READ_DEFAULT_LINES, READ_UI_MAX_LINES);
    let want = if limit == 0 {
        READ_DEFAULT_LINES.min(hard_cap)
    } else {
        limit.min(hard_cap)
    };
    let start = offset;
    let normalized = normalize_newlines(body);
    let lines: Vec<&str> = normalized.lines().collect();
    let slice = if start >= lines.len() {
        &[][..]
    } else {
        let end = (start + want).min(lines.len());
        &lines[start..end]
    };
    let end_excl = start + slice.len();
    let end_inclusive = if slice.is_empty() {
        start
    } else {
        end_excl.saturating_sub(1)
    };
    let mut total_bytes = 0usize;
    let mut collected = Vec::new();
    let mut truncated_bytes = false;
    for line in slice {
        let add = line.len() + 1;
        if total_bytes + add > READ_MAX_BYTES {
            truncated_bytes = true;
            break;
        }
        total_bytes += add;
        collected.push(*line);
    }
    let header = format!(
        "// PocketCode PDF text: `{display}` lines {start}-{end_inclusive} (offset={start}, window={want})\n",
    );
    let mut out = format!("{header}{}", collected.join("\n"));
    if truncated_bytes {
        out.push_str("\n…[truncated at byte cap — use a smaller window or offset]");
    } else if end_excl < lines.len() {
        out.push_str(&format!(
            "\n…[more lines after {end_inclusive} — call read_file with offset={end_excl}]"
        ));
    }
    Ok(out)
}

/// Read file with line `offset` (0-based) and `limit` lines.
/// `limit == 0` means default window ([`READ_DEFAULT_LINES`]), never the whole file.
/// Hard-capped at `line_cap` (default [`READ_MAX_LINES`]) and [`READ_MAX_BYTES`] bytes.
pub fn read_file(
    workspace_root: &Path,
    path: &str,
    offset: usize,
    limit: usize,
    line_cap: Option<usize>,
) -> AppResult<String> {
    let file = resolve_under_root(workspace_root, path)?;
    if !file.is_file() {
        return Err(AppError::MissingFile(format!(
            "Not a file: {}",
            to_rel_display(workspace_root, &file)
        )));
    }
    let display = to_rel_display(workspace_root, &file);

    // PDFs: serve OCR/extract sidecar text (Unlimited-OCR preferred) instead of rejecting as binary.
    if path_is_pdf(&file) {
        let (body, _item) = crate::cw_pdf_prepare::ensure_pdf_text(workspace_root, &display)?;
        return read_text_window_from_string(&body, &display, offset, limit, line_cap);
    }

    // gzip / .log.gz / .csv.gz / .jsonl.gz / syslog.gz
    if path_is_gzip(&file) {
        let body = decompress_gzip_text(&file, &display)?;
        return read_text_window_from_string(&body, &display, offset, limit, line_cap);
    }

    reject_if_binary_file(&file, &display)?;

    let hard_cap = line_cap
        .unwrap_or(READ_MAX_LINES)
        .clamp(READ_DEFAULT_LINES, READ_UI_MAX_LINES);
    let want = if limit == 0 {
        READ_DEFAULT_LINES.min(hard_cap)
    } else {
        limit.min(hard_cap)
    };
    let start = offset;

    // Stream lines so multi-MB files are not fully loaded for a small window.
    use std::io::{BufRead, BufReader};
    let fh = std::fs::File::open(&file)
        .map_err(|e| AppError::Unknown(format!("Cannot open file: {e}")))?;
    let reader = BufReader::new(fh);
    let mut collected: Vec<String> = Vec::with_capacity(want.min(256));
    let mut line_no = 0usize;
    let mut total_bytes = 0usize;
    let mut truncated_bytes = false;
    let mut more_after = false;

    for line_res in reader.lines() {
        let line = line_res.map_err(|e| AppError::Unknown(format!("Cannot read file: {e}")))?;
        if line_no < start {
            line_no += 1;
            continue;
        }
        if collected.len() >= want {
            more_after = true;
            break;
        }
        let add = line.len() + 1;
        if total_bytes + add > READ_MAX_BYTES {
            truncated_bytes = true;
            break;
        }
        total_bytes += add;
        collected.push(line);
        line_no += 1;
    }

    let end_excl = start + collected.len();
    let end_inclusive = if collected.is_empty() {
        start
    } else {
        end_excl.saturating_sub(1)
    };
    let header = format!(
        "// PocketCode read: lines {start}-{end_inclusive} (offset={start}, window={want})\n",
    );
    let mut out = format!("{header}{}", collected.join("\n"));
    if truncated_bytes {
        out.push_str("\n…[truncated at byte cap — use a smaller window or offset]");
    } else if more_after {
        out.push_str(&format!(
            "\n…[more lines after {end_inclusive} — call read_file with offset={end_excl}]"
        ));
    }
    Ok(out)
}

/// Preview a unique search-replace edit, or create a new file when it does not exist.
///
/// New file: path missing + `old_string` empty → preview shows empty → full `new_string`.
/// Existing file: `old_string` must match exactly once.
pub fn apply_edit_preview(
    workspace_root: &Path,
    path: &str,
    old_string: &str,
    new_string: &str,
) -> AppResult<EditPreview> {
    let file = resolve_under_root(workspace_root, path)?;
    if !file.exists() {
        if !old_string.is_empty() {
            return Err(AppError::Unknown(format!(
                "File does not exist: {}. To create it, use apply_edit with empty old_string and the full file in new_string.",
                to_rel_display(workspace_root, &file)
            )));
        }
        if new_string.is_empty() {
            return Err(AppError::Unknown(
                "Cannot create an empty file; put file contents in new_string.".to_string(),
            ));
        }
        return Ok(EditPreview {
            original: String::new(),
            modified: new_string.to_string(),
        });
    }
    if !file.is_file() {
        return Err(AppError::MissingFile(format!(
            "Not a file: {}",
            to_rel_display(workspace_root, &file)
        )));
    }
    let original = std::fs::read_to_string(&file)
        .map_err(|e| AppError::Unknown(format!("Cannot read file for edit: {e}")))?;
    if original.len() > READ_MAX_BYTES * 4 {
        return Err(AppError::Unknown(
            "File too large to edit via apply_edit (~8MB cap).".to_string(),
        ));
    }
    if old_string.is_empty() {
        return Err(AppError::Unknown(
            "old_string must not be empty when editing an existing file (use a unique snippet to replace).".to_string(),
        ));
    }
    // Match on LF-normalized text so model copies from read_file (LF) work on Windows CRLF files.
    let eol = dominant_eol(&original);
    let norm_file = normalize_newlines(&original);
    let norm_old = normalize_newlines(old_string);
    let norm_new = normalize_newlines(new_string);
    let matches: Vec<_> = norm_file.match_indices(&norm_old).collect();
    if matches.is_empty() {
        return Err(AppError::Unknown(format!(
            "old_string not found in file (after CRLF/LF normalization). Preview of old_string: \"{}\". Hint: re-read_file the target lines and copy old_string exactly; if a prior edit already changed the file, re-read before editing again.",
            escape_for_error(old_string)
        )));
    }
    if matches.len() > 1 {
        return Err(AppError::Unknown(format!(
            "old_string matched {} times after CRLF/LF normalization; must be unique. Use a longer unique snippet.",
            matches.len()
        )));
    }
    let norm_modified = norm_file.replacen(&norm_old, &norm_new, 1);
    let modified = if eol == "\r\n" {
        norm_modified.replace('\n', "\r\n")
    } else {
        norm_modified
    };
    Ok(EditPreview { original, modified })
}

/// Write full file contents. Creates parent dirs as needed.
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

fn is_protected_delete_path(rel: &str) -> bool {
    let n = rel.replace('\\', "/").to_ascii_lowercase();
    n == ".git"
        || n.starts_with(".git/")
        || n == ".pocketmind-checkpoints"
        || n.starts_with(".pocketmind-checkpoints/")
        || n == ".pocketmind-sandbox"
        || n.starts_with(".pocketmind-sandbox/")
}

/// Delete a single file under the workspace root (not directories). Protected paths refused.
pub fn delete_file(workspace_root: &Path, path: &str) -> AppResult<()> {
    let rel = standardize(path);
    if is_protected_delete_path(&rel) {
        return Err(AppError::Unknown(
            "Refusing to delete protected path (.git / checkpoints / sandbox).".to_string(),
        ));
    }
    let file = resolve_under_root(workspace_root, &rel)?;
    if !file.exists() {
        return Err(AppError::MissingFile(format!(
            "File not found: {}",
            to_rel_display(workspace_root, &file)
        )));
    }
    if file.is_dir() {
        return Err(AppError::Unknown(
            "delete_file only removes files, not directories.".to_string(),
        ));
    }
    std::fs::remove_file(&file)
        .map_err(|e| AppError::Unknown(format!("Cannot delete file: {e}")))?;
    Ok(())
}

/// Allowlisted script and/or CLI run (no freeform shell).
pub async fn run_sandbox(
    workspace_root: &Path,
    language: &str,
    code: String,
    args: Option<Vec<String>>,
) -> AppResult<SandboxRunResult> {
    sandbox_runners::run(
        workspace_root,
        Some(language),
        Some(code),
        args,
        None,
    )
    .await
}

/// Allowlisted argv CLI run under the workspace root.
pub async fn run_sandbox_cli(
    workspace_root: &Path,
    argv: Vec<String>,
) -> AppResult<SandboxRunResult> {
    sandbox_runners::run(workspace_root, None, None, None, Some(argv)).await
}

/// Unified sandbox entry used by the Tauri command.
pub async fn run_sandbox_request(
    workspace_root: &Path,
    language: Option<String>,
    script: Option<String>,
    args: Option<Vec<String>>,
    argv: Option<Vec<String>>,
) -> AppResult<SandboxRunResult> {
    sandbox_runners::run(
        workspace_root,
        language.as_deref(),
        script,
        args,
        argv,
    )
    .await
}

pub fn list_runners() -> RunnersStatus {
    sandbox_runners::list_runners()
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

/// Minimum local model size (billions of parameters) for PocketCode write/run tools.
pub const POCKETCODE_MIN_LOCAL_B: f32 = 20.0;

/// ~18 GiB+ files pass the gate when the filename has no reliable Nb marker (e.g. a ~22 GB GGUF).
pub const POCKETCODE_MIN_LOCAL_BYTES: u64 = 18 * 1024 * 1024 * 1024;

/// Gate PocketCode write/run tools to ≥20B local, local VL+mmproj, large online, or org enterprise.
pub fn can_use_code_workspace(model_path: &str, params: Option<f32>) -> (bool, String) {
    let model_path = model_path.trim();
    if model_path.is_empty() {
        return (
            false,
            "Select a 20B+ local model, a local vision GGUF with mmproj, an online model, or an org server model for PocketCode."
                .to_string(),
        );
    }
    // Org-hosted models run on enterprise hardware — always allowed for PocketCode.
    if model_path.starts_with("enterprise:") {
        return (true, "Organization server model".to_string());
    }
    if model_path.starts_with("remote:") {
        // User-selected online models are always allowed (Gemini 2.5 Flash, etc.).
        return (
            true,
            if is_large_online_model(model_path) {
                "Online model".to_string()
            } else {
                "Online model (user selected)".to_string()
            },
        );
    }
    // Offline vision: any local GGUF with a paired mmproj projector is PocketCode-eligible
    // (screenshot/debugging workflows). Text-only locals still need ≥20B (or ~18 GB+ file).
    if let Some(mm) = crate::llm::local::find_mmproj_for_model(model_path) {
        let leaf = std::path::Path::new(&mm)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("mmproj");
        return (
            true,
            format!("Local vision model (mmproj: {leaf})"),
        );
    }
    let params = params.or_else(|| parse_params_billions(model_path));
    if let Some(p) = params {
        if p >= POCKETCODE_MIN_LOCAL_B {
            return (true, format!("Local model ≈ {p}B"));
        }
        return (
            false,
            format!(
                "Local model ≈ {p}B is below the {POCKETCODE_MIN_LOCAL_B}B PocketCode gate. Use a ≥{POCKETCODE_MIN_LOCAL_B}B GGUF for coding tools, or place an mmproj next to a VL GGUF for offline vision. Text chat still works with this model."
            ),
        );
    }
    if let Ok(meta) = std::fs::metadata(model_path) {
        if meta.is_file() && meta.len() >= POCKETCODE_MIN_LOCAL_BYTES {
            return (
                true,
                "Local GGUF ≥ ~18 GB (treated as PocketCode-capable)".to_string(),
            );
        }
    }
    (
        false,
        format!(
            "Could not determine model size. PocketCode requires a ≥{POCKETCODE_MIN_LOCAL_B}B local GGUF (~18 GB+), a local VL GGUF with mmproj beside it, an online model, or an org server model."
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_temp_workspace(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pm_cw_test_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_file_limit_zero_is_default_window_not_whole_file() {
        let dir = make_temp_workspace("limit0");
        let path = dir.join("big.rs");
        let mut f = std::fs::File::create(&path).unwrap();
        for i in 0..500 {
            writeln!(f, "line_{i}").unwrap();
        }
        // limit=0 must not return all 500 lines
        let out = read_file(&dir, "big.rs", 0, 0, Some(READ_MAX_LINES)).unwrap();
        let body_lines = out
            .lines()
            .filter(|l| !l.starts_with("// PocketCode read"))
            .filter(|l| !l.starts_with('…'))
            .count();
        assert!(
            body_lines <= READ_DEFAULT_LINES + 1,
            "expected ~{READ_DEFAULT_LINES} lines, got {body_lines}"
        );
        assert!(out.contains("more lines after") || body_lines == READ_DEFAULT_LINES);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_file_caps_at_max_lines() {
        let dir = make_temp_workspace("cap");
        let path = dir.join("big.rs");
        let mut f = std::fs::File::create(&path).unwrap();
        for i in 0..1000 {
            writeln!(f, "line_{i}").unwrap();
        }
        let out = read_file(&dir, "big.rs", 0, 9000, Some(READ_MAX_LINES)).unwrap();
        let body_lines = out
            .lines()
            .filter(|l| !l.starts_with("// PocketCode read"))
            .filter(|l| !l.starts_with('…'))
            .count();
        assert!(body_lines <= READ_MAX_LINES + 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_edit_preview_matches_lf_old_string_on_crlf_file() {
        let dir = make_temp_workspace("crlf_edit");
        let path = dir.join("auth.rs");
        let disk = "fn a() {\r\n    let x = 1;\r\n    let y = 2;\r\n}\r\n";
        std::fs::write(&path, disk).unwrap();
        let old = "    let x = 1;\n    let y = 2;";
        let new = "    let x = 10;\n    let y = 20;";
        let preview = apply_edit_preview(&dir, "auth.rs", old, new).unwrap();
        assert!(preview.modified.contains("\r\n"));
        assert!(preview.modified.contains("let x = 10;"));
        assert!(preview.modified.contains("let y = 20;"));
        assert!(!preview.modified.contains("let x = 1;"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_edit_preview_lf_file_still_works() {
        let dir = make_temp_workspace("lf_edit");
        let path = dir.join("a.rs");
        std::fs::write(&path, "hello\nworld\n").unwrap();
        let preview = apply_edit_preview(&dir, "a.rs", "hello\nworld", "hi\nthere").unwrap();
        assert_eq!(preview.modified, "hi\nthere\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_edit_preview_single_line_on_crlf() {
        let dir = make_temp_workspace("crlf_one");
        let path = dir.join("a.txt");
        std::fs::write(&path, "aaa\r\nbbb\r\n").unwrap();
        let preview = apply_edit_preview(&dir, "a.txt", "bbb", "ccc").unwrap();
        assert_eq!(preview.modified, "aaa\r\nccc\r\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_edit_preview_not_found() {
        let dir = make_temp_workspace("nf");
        let path = dir.join("a.txt");
        std::fs::write(&path, "aaa\r\nbbb\r\n").unwrap();
        let err = apply_edit_preview(&dir, "a.txt", "zzz", "q").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("old_string not found"), "{msg}");
        assert!(msg.contains("CRLF/LF"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_edit_preview_new_file_empty_old() {
        let dir = make_temp_workspace("newf");
        let preview = apply_edit_preview(&dir, "new.py", "", "print(1)\n").unwrap();
        assert!(preview.original.is_empty());
        assert_eq!(preview.modified, "print(1)\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_file_rejects_png_extension() {
        let dir = make_temp_workspace("bin_png");
        let path = dir.join("pic.png");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\n\0fake").unwrap();
        let err = read_file(&dir, "pic.png", 0, 20, Some(READ_MAX_LINES)).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("Not a text file"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_file_rejects_nul_bytes() {
        let dir = make_temp_workspace("bin_nul");
        let path = dir.join("blob.dat");
        std::fs::write(&path, b"hello\0world").unwrap();
        let err = read_file(&dir, "blob.dat", 0, 20, Some(READ_MAX_LINES)).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("binary"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_dir_caps_and_hints() {
        let dir = make_temp_workspace("listdir");
        for i in 0..100 {
            std::fs::write(dir.join(format!("f{i}.txt")), b"x").unwrap();
        }
        let entries = list_dir(&dir, ".").unwrap();
        assert!(
            entries.len() == LIST_DIR_MAX_ENTRIES + 1,
            "expected {} entries + hint, got {}",
            LIST_DIR_MAX_ENTRIES,
            entries.len()
        );
        assert!(entries.last().unwrap().name.contains("truncated"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
