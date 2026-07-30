//! Filesystem workspace tools (list/glob/grep/read/edit/delete).

use crate::error::{Error, Result};
use crate::path::{canonicalize_root, resolve_under_root, standardize, to_rel_display};
use crate::types::{DirEntryInfo, EditPreview};
use regex::RegexBuilder;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub const READ_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const READ_DEFAULT_LINES: usize = 120;
pub const READ_MAX_LINES: usize = 400;
pub const READ_UI_MAX_LINES: usize = 4_000;

const LIST_DIR_MAX_ENTRIES: usize = 80;
const GLOB_MAX_RESULTS: usize = 500;
const GREP_MAX_OUTPUT_BYTES: usize = 200 * 1024;
const BINARY_PEEK_BYTES: usize = 8 * 1024;

const SKIP_DIR_NAMES: &[&str] = &[".git", "node_modules", "target"];

const BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "jar", "exe", "dll", "wasm", "pdf", "zip",
    "7z", "gguf", "bin", "so", "dylib", "class", "o", "a", "lib", "pdb", "woff", "woff2", "ttf",
    "otf", "mp3", "mp4", "wav", "webm", "avi",
];

fn should_skip_dir(name: &str) -> bool {
    SKIP_DIR_NAMES.iter().any(|n| *n == name)
}

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

pub fn list_dir(workspace_root: &Path, rel: &str) -> Result<Vec<DirEntryInfo>> {
    let dir = resolve_under_root(workspace_root, rel)?;
    if !dir.is_dir() {
        return Err(Error::msg(format!(
            "Not a directory: {}",
            to_rel_display(workspace_root, &dir)
        )));
    }
    let root_canon = canonicalize_root(workspace_root)?;
    let mut out = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| Error::msg(format!("Cannot list directory: {e}")))?
        .filter_map(|e| e.ok())
        .collect();
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
                "…[truncated: showing {} of {} entries — use glob with a pattern when looking for a named file]",
                LIST_DIR_MAX_ENTRIES, total
            ),
            is_dir: false,
            path: String::new(),
        });
    }
    Ok(out)
}

pub fn glob_file_search(workspace_root: &Path, pattern: &str) -> Result<Vec<String>> {
    let root_canon = canonicalize_root(workspace_root)?;
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Err(Error::msg("glob pattern is required.".to_string()));
    }
    if pattern.replace('\\', "/").split('/').any(|s| s == "..") {
        return Err(Error::msg(
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

/// Pure-Rust grep (no ripgrep dependency). Returns `path:line:text` lines.
pub fn grep(
    workspace_root: &Path,
    pattern: &str,
    path: Option<&str>,
    glob: Option<&str>,
    case_insensitive: bool,
) -> Result<String> {
    if pattern.is_empty() {
        return Err(Error::msg("grep pattern is required.".to_string()));
    }
    let root_canon = canonicalize_root(workspace_root)?;
    let search_path = match path {
        Some(p) if !p.trim().is_empty() => resolve_under_root(workspace_root, p)?,
        _ => root_canon.clone(),
    };
    let re = RegexBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .build()
        .map_err(|e| Error::msg(format!("Invalid grep pattern: {e}")))?;

    let glob_pat = glob.map(|g| g.trim().to_string()).filter(|g| !g.is_empty());
    if let Some(g) = &glob_pat {
        if g.replace('\\', "/").split('/').any(|s| s == "..")
            || g.contains('|')
            || g.contains(';')
        {
            return Err(Error::msg("Invalid glob for grep.".to_string()));
        }
    }

    let mut out = String::new();
    let mut walk_roots: Vec<PathBuf> = Vec::new();
    if search_path.is_file() {
        walk_roots.push(search_path);
    } else {
        for entry in WalkDir::new(&search_path)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                if e.depth() == 0 {
                    return true;
                }
                let name = e.file_name().to_string_lossy();
                !(e.file_type().is_dir() && should_skip_dir(&name))
            })
        {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if entry.file_type().is_file() {
                walk_roots.push(entry.path().to_path_buf());
            }
        }
    }

    for file in walk_roots {
        let rel = to_rel_display(&root_canon, &file);
        if let Some(g) = &glob_pat {
            let base = file
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if !glob_match(g, &rel) && !glob_match(g, &base) {
                continue;
            }
        }
        if path_has_binary_extension(&file) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        if text.as_bytes().contains(&0) {
            continue;
        }
        for (i, line) in text.lines().enumerate() {
            if re.is_match(line) {
                let row = format!("{rel}:{}:{line}\n", i + 1);
                if out.len() + row.len() > GREP_MAX_OUTPUT_BYTES {
                    out.push_str("…[truncated at 200KB]");
                    return Ok(out);
                }
                out.push_str(&row);
            }
        }
    }
    Ok(out)
}

fn path_has_binary_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| BINARY_EXTENSIONS.iter().any(|x| e.eq_ignore_ascii_case(x)))
        .unwrap_or(false)
}

fn reject_if_binary_file(file: &Path, display: &str) -> Result<()> {
    if path_has_binary_extension(file) {
        return Err(Error::msg(format!(
            "Not a text file: {display}. Do not call read_file on images/binaries."
        )));
    }
    let mut fh = std::fs::File::open(file)
        .map_err(|e| Error::msg(format!("Cannot open file: {e}")))?;
    let mut buf = vec![0u8; BINARY_PEEK_BYTES];
    let n = fh
        .read(&mut buf)
        .map_err(|e| Error::msg(format!("Cannot read file: {e}")))?;
    if buf[..n].contains(&0) {
        return Err(Error::msg(format!(
            "Not a text file (binary content detected): {display}."
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
        out.push('…');
    }
    out
}

pub fn read_file(
    workspace_root: &Path,
    path: &str,
    offset: usize,
    limit: usize,
    for_ui: bool,
) -> Result<String> {
    let file = resolve_under_root(workspace_root, path)?;
    if !file.is_file() {
        return Err(Error::MissingFile(format!(
            "Not a file: {}",
            to_rel_display(workspace_root, &file)
        )));
    }
    let display = to_rel_display(workspace_root, &file);
    reject_if_binary_file(&file, &display)?;

    let hard_cap = if for_ui {
        READ_UI_MAX_LINES
    } else {
        READ_MAX_LINES
    };
    let want = if limit == 0 {
        READ_DEFAULT_LINES.min(hard_cap)
    } else {
        limit.min(hard_cap)
    };
    let start = offset;

    let fh = std::fs::File::open(&file)
        .map_err(|e| Error::msg(format!("Cannot open file: {e}")))?;
    let reader = BufReader::new(fh);
    let mut collected: Vec<String> = Vec::with_capacity(want.min(256));
    let mut line_no = 0usize;
    let mut total_bytes = 0usize;
    let mut truncated_bytes = false;
    let mut more_after = false;

    for line_res in reader.lines() {
        let line = line_res.map_err(|e| Error::msg(format!("Cannot read file: {e}")))?;
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

pub fn apply_edit_preview(
    workspace_root: &Path,
    path: &str,
    old_string: &str,
    new_string: &str,
) -> Result<EditPreview> {
    let file = resolve_under_root(workspace_root, path)?;
    if !file.exists() {
        if !old_string.is_empty() {
            return Err(Error::msg(format!(
                "File does not exist: {}. To create it, use apply_edit with empty old_string and the full file in new_string.",
                to_rel_display(workspace_root, &file)
            )));
        }
        if new_string.is_empty() {
            return Err(Error::msg(
                "Cannot create an empty file; put file contents in new_string.".to_string(),
            ));
        }
        return Ok(EditPreview {
            original: String::new(),
            modified: new_string.to_string(),
        });
    }
    if !file.is_file() {
        return Err(Error::MissingFile(format!(
            "Not a file: {}",
            to_rel_display(workspace_root, &file)
        )));
    }
    let original = std::fs::read_to_string(&file)
        .map_err(|e| Error::msg(format!("Cannot read file for edit: {e}")))?;
    if original.len() > READ_MAX_BYTES * 4 {
        return Err(Error::msg(
            "File too large to edit via apply_edit (~8MB cap).".to_string(),
        ));
    }
    if old_string.is_empty() {
        return Err(Error::msg(
            "old_string must not be empty when editing an existing file.".to_string(),
        ));
    }
    let eol = dominant_eol(&original);
    let norm_file = normalize_newlines(&original);
    let norm_old = normalize_newlines(old_string);
    let norm_new = normalize_newlines(new_string);
    let matches: Vec<_> = norm_file.match_indices(&norm_old).collect();
    if matches.is_empty() {
        return Err(Error::msg(format!(
            "old_string not found in file (after CRLF/LF normalization). Preview of old_string: \"{}\".",
            escape_for_error(old_string)
        )));
    }
    if matches.len() > 1 {
        return Err(Error::msg(format!(
            "old_string matched {} times after CRLF/LF normalization; must be unique.",
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

pub fn apply_edit_write(workspace_root: &Path, path: &str, content: &str) -> Result<()> {
    let file = resolve_under_root(workspace_root, path)?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| Error::msg(format!("Cannot create parent dirs: {e}")))?;
        let root_canon = canonicalize_root(workspace_root)?;
        let parent_check = if parent.exists() {
            crate::path::strip_verbatim(
                parent.canonicalize().unwrap_or_else(|_| parent.to_path_buf()),
            )
        } else {
            parent.to_path_buf()
        };
        if !crate::path::path_is_under(&root_canon, &parent_check) {
            return Err(Error::msg(
                "Refusing to write outside workspace root.".to_string(),
            ));
        }
    }
    std::fs::write(&file, content)
        .map_err(|e| Error::msg(format!("Cannot write file: {e}")))?;
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

pub fn delete_file(workspace_root: &Path, path: &str) -> Result<()> {
    let rel = standardize(path);
    if is_protected_delete_path(&rel) {
        return Err(Error::msg(
            "Refusing to delete protected path (.git / checkpoints / sandbox).".to_string(),
        ));
    }
    let file = resolve_under_root(workspace_root, &rel)?;
    if !file.exists() {
        return Err(Error::MissingFile(format!(
            "File not found: {}",
            to_rel_display(workspace_root, &file)
        )));
    }
    if file.is_dir() {
        return Err(Error::msg(
            "delete_file only removes files, not directories.".to_string(),
        ));
    }
    std::fs::remove_file(&file).map_err(|e| Error::msg(format!("Cannot delete file: {e}")))?;
    Ok(())
}
