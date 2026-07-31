//! Lightweight workspace symbol index for PocketCode (retrieve-then-read).
//! Uses Knowledge Chat Tree-sitter / heuristic parsers; cache under `.pocketmind-index/`.

use crate::code_workspace::{resolve_under_root, standardize, READ_MAX_BYTES};
use crate::error::{AppError, AppResult};
use pocketcode_workspace::WorkspaceSidecar;
use crate::knowledge_chat::code_languages::is_code_extension;
use crate::knowledge_chat::code_parser::parse_code_file;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

const INDEX_DIR: &str = ".pocketmind-index";
const INDEX_FILE: &str = "symbols.json";
const MAX_SYMBOLS_PER_FILE: usize = 16;
const MAX_ENTITY_BODY_CHARS: usize = 8_000;
const MAX_INDEX_FILES: usize = 2_000;
const MAX_FIND_RESULTS: usize = 40;
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".pocketmind-checkpoints",
    ".pocketmind-sandbox",
    ".pocketmind-index",
    "__pycache__",
    ".venv",
    "venv",
];

/// Docs/config/data files indexed as text anchors (headings, XML ids, JSON keys).
const TEXT_DOC_EXTS: &[&str] = &["xml", "md", "markdown", "json", "yml", "yaml", "txt", "csv", "toml"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedSymbol {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub line_start: i32,
    pub line_end: i32,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileIndexEntry {
    path: String,
    mtime_secs: u64,
    size_bytes: u64,
    symbols: Vec<IndexedSymbol>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SymbolIndex {
    version: u32,
    root: String,
    updated_at: u64,
    files: BTreeMap<String, FileIndexEntry>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn index_path(workspace_root: &Path) -> AppResult<PathBuf> {
    Ok(WorkspaceSidecar::for_workspace(workspace_root)
        .map_err(|e| AppError::Unknown(e.to_string()))?
        .index_file())
}

fn file_mtime_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn load_index(workspace_root: &Path) -> SymbolIndex {
    let path = index_path(workspace_root).unwrap_or_else(|_| workspace_root.join(INDEX_FILE));
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => SymbolIndex {
            version: 1,
            root: workspace_root.to_string_lossy().to_string(),
            updated_at: 0,
            files: BTreeMap::new(),
        },
    }
}

fn save_index(workspace_root: &Path, index: &SymbolIndex) -> AppResult<()> {
    let sidecar = WorkspaceSidecar::for_workspace(workspace_root)
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    fs::create_dir_all(sidecar.index_dir())
        .map_err(|e| AppError::Unknown(format!("Cannot create index dir: {e}")))?;
    let path = sidecar.index_file();
    let raw = serde_json::to_string(index)
        .map_err(|e| AppError::Unknown(format!("Cannot serialize index: {e}")))?;
    fs::write(&path, raw).map_err(|e| AppError::Unknown(format!("Cannot write index: {e}")))?;
    Ok(())
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn should_skip_dir(name: &str) -> bool {
    SKIP_DIRS.iter().any(|s| *s == name)
}

fn is_indexable_extension(ext: &str) -> bool {
    is_code_extension(ext) || TEXT_DOC_EXTS.iter().any(|e| *e == ext)
}

fn line_of(source: &str, byte_offset: usize) -> i32 {
    (source[..byte_offset.min(source.len())]
        .bytes()
        .filter(|b| *b == b'\n')
        .count()
        + 1) as i32
}

fn push_text_symbol(
    out: &mut Vec<IndexedSymbol>,
    seen: &mut std::collections::HashSet<String>,
    rel: &str,
    name: String,
    kind: &str,
    line_start: i32,
) -> bool {
    if name.is_empty() || name.len() > 120 || !seen.insert(name.clone()) {
        return out.len() >= 64;
    }
    out.push(IndexedSymbol {
        path: rel.to_string(),
        name: name.clone(),
        kind: kind.to_string(),
        line_start,
        line_end: line_start + 4,
        signature: format!("{kind} {name}"),
    });
    out.len() >= 64
}

fn parse_text_doc_symbols(source: &str, ext: &str, rel: &str) -> Vec<IndexedSymbol> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();

    match ext {
        "md" | "markdown" => {
            static RE: OnceLock<Regex> = OnceLock::new();
            let re = RE.get_or_init(|| Regex::new(r"(?m)^(#{1,6})\s+(.+?)\s*$").unwrap());
            for caps in re.captures_iter(source) {
                let name = caps.get(2).map(|m| m.as_str().trim()).unwrap_or("").to_string();
                let start = caps.get(0).map(|m| m.start()).unwrap_or(0);
                if push_text_symbol(
                    &mut out,
                    &mut seen,
                    rel,
                    name,
                    "heading",
                    line_of(source, start),
                ) {
                    break;
                }
            }
        }
        "xml" => {
            static RE_ID: OnceLock<Regex> = OnceLock::new();
            static RE_NAME: OnceLock<Regex> = OnceLock::new();
            let re_id = RE_ID.get_or_init(|| {
                Regex::new(r#"(?i)<([A-Za-z_][\w:-]*)\b[^>]*\bid\s*=\s*["']([^"']+)["']"#).unwrap()
            });
            let re_name =
                RE_NAME.get_or_init(|| Regex::new(r"(?i)<name>\s*([^<]{2,80})\s*</name>").unwrap());
            for caps in re_id.captures_iter(source) {
                let tag = caps.get(1).map(|m| m.as_str()).unwrap_or("tag");
                let id = caps.get(2).map(|m| m.as_str()).unwrap_or("").to_string();
                let start = caps.get(0).map(|m| m.start()).unwrap_or(0);
                let kind = format!("xml-{tag}");
                if push_text_symbol(&mut out, &mut seen, rel, id, &kind, line_of(source, start)) {
                    break;
                }
            }
            for caps in re_name.captures_iter(source) {
                let name = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("").to_string();
                let start = caps.get(0).map(|m| m.start()).unwrap_or(0);
                if push_text_symbol(
                    &mut out,
                    &mut seen,
                    rel,
                    name,
                    "xml-name",
                    line_of(source, start),
                ) {
                    break;
                }
            }
        }
        "json" => {
            static RE: OnceLock<Regex> = OnceLock::new();
            let re =
                RE.get_or_init(|| Regex::new(r#"(?m)^\s{0,4}"([A-Za-z_][\w.-]{1,60})"\s*:"#).unwrap());
            for caps in re.captures_iter(source) {
                let name = caps.get(1).map(|m| m.as_str()).unwrap_or("").to_string();
                let start = caps.get(0).map(|m| m.start()).unwrap_or(0);
                if push_text_symbol(
                    &mut out,
                    &mut seen,
                    rel,
                    name,
                    "json-key",
                    line_of(source, start),
                ) {
                    break;
                }
            }
        }
        "yml" | "yaml" | "toml" => {
            static RE: OnceLock<Regex> = OnceLock::new();
            let re =
                RE.get_or_init(|| Regex::new(r"(?m)^\s{0,4}([A-Za-z_][\w.-]{1,60})\s*:").unwrap());
            for caps in re.captures_iter(source) {
                let name = caps.get(1).map(|m| m.as_str()).unwrap_or("").to_string();
                let start = caps.get(0).map(|m| m.start()).unwrap_or(0);
                if push_text_symbol(
                    &mut out,
                    &mut seen,
                    rel,
                    name,
                    "config-key",
                    line_of(source, start),
                ) {
                    break;
                }
            }
        }
        "txt" | "csv" => {
            for (i, line) in source.lines().enumerate() {
                let t = line.trim();
                if t.len() >= 4 && t.len() <= 100 {
                    let _ = push_text_symbol(
                        &mut out,
                        &mut seen,
                        rel,
                        t.to_string(),
                        "doc-line",
                        (i + 1) as i32,
                    );
                    break;
                }
            }
        }
        _ => {}
    }
    out
}

fn parse_file_symbols(abs: &Path, rel: &str) -> Vec<IndexedSymbol> {
    let ext = extension_of(abs);
    if !is_indexable_extension(&ext) {
        return Vec::new();
    }
    let meta = match fs::metadata(abs) {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    if meta.len() as usize > READ_MAX_BYTES {
        return Vec::new();
    }
    let source = match fs::read_to_string(abs) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    if !is_code_extension(&ext) {
        return parse_text_doc_symbols(&source, &ext, rel);
    }
    let name = abs
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(rel);
    let parsed = parse_code_file(&source, &ext, Some(name));
    parsed
        .entities
        .into_iter()
        .map(|e| IndexedSymbol {
            path: rel.to_string(),
            name: e.name,
            kind: e.kind.as_str().to_string(),
            line_start: e.line_start,
            line_end: e.line_end,
            signature: e.signature,
        })
        .collect()
}

/// Refresh stale/missing entries; returns (files_touched, symbols_total).
pub fn ensure_index(workspace_root: &Path) -> AppResult<(usize, usize)> {
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    if !root.is_dir() {
        return Err(AppError::Unknown("Workspace root is not a directory.".to_string()));
    }

    let mut index = load_index(&root);
    index.version = 1;
    index.root = root.to_string_lossy().to_string();

    let mut touched = 0usize;
    let mut seen: BTreeMap<String, ()> = BTreeMap::new();
    let mut file_count = 0usize;

    for entry in WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                !should_skip_dir(&name)
            } else {
                true
            }
        })
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let abs = entry.path();
        let ext = extension_of(abs);
        if !is_indexable_extension(&ext) {
            continue;
        }
        file_count += 1;
        if file_count > MAX_INDEX_FILES {
            break;
        }
        let rel = abs
            .strip_prefix(&root)
            .map(|p| standardize(&p.to_string_lossy()))
            .unwrap_or_else(|_| standardize(&abs.to_string_lossy()));
        seen.insert(rel.clone(), ());

        let mtime = file_mtime_secs(abs);
        let size = fs::metadata(abs).map(|m| m.len()).unwrap_or(0);
        let stale = match index.files.get(&rel) {
            Some(prev) => prev.mtime_secs != mtime || prev.size_bytes != size,
            None => true,
        };
        if !stale {
            continue;
        }
        let symbols = parse_file_symbols(abs, &rel);
        index.files.insert(
            rel.clone(),
            FileIndexEntry {
                path: rel,
                mtime_secs: mtime,
                size_bytes: size,
                symbols,
            },
        );
        touched += 1;
    }

    // Drop deleted files from cache.
    let stale_keys: Vec<String> = index
        .files
        .keys()
        .filter(|k| !seen.contains_key(k.as_str()))
        .cloned()
        .collect();
    for k in stale_keys {
        index.files.remove(&k);
    }

    index.updated_at = now_secs();
    let symbol_total: usize = index.files.values().map(|f| f.symbols.len()).sum();
    save_index(&root, &index)?;
    Ok((touched, symbol_total))
}

const MAX_INVENTORY_FILES: usize = 400;

/// Folder/file inventory used when the tree has no parseable code symbols
/// (XML/Markdown/JSON/config workspaces), so repo_map is never an empty answer.
fn non_code_inventory(root: &Path) -> (usize, BTreeMap<String, Vec<(String, u64)>>, BTreeMap<String, usize>) {
    let mut by_folder: BTreeMap<String, Vec<(String, u64)>> = BTreeMap::new();
    let mut ext_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut total = 0usize;

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                !should_skip_dir(&name)
            } else {
                true
            }
        })
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let abs = entry.path();
        let ext = extension_of(abs);
        let label = if ext.is_empty() {
            "(no ext)".to_string()
        } else {
            format!(".{ext}")
        };
        *ext_counts.entry(label).or_insert(0) += 1;
        total += 1;
        if total > MAX_INVENTORY_FILES * 8 {
            break;
        }
        let rel = abs
            .strip_prefix(root)
            .map(|p| standardize(&p.to_string_lossy()))
            .unwrap_or_else(|_| standardize(&abs.to_string_lossy()));
        let size = fs::metadata(abs).map(|m| m.len()).unwrap_or(0);
        let folder = top_folder(&rel);
        let bucket = by_folder.entry(folder).or_default();
        if bucket.len() < MAX_INVENTORY_FILES {
            bucket.push((rel, size));
        }
    }

    (total, by_folder, ext_counts)
}

fn inventory_map_text(root: &Path) -> String {
    let (total, by_folder, ext_counts) = non_code_inventory(root);
    let mut exts: Vec<(String, usize)> = ext_counts.into_iter().collect();
    exts.sort_by(|a, b| b.1.cmp(&a.1));
    let ext_line = exts
        .iter()
        .take(10)
        .map(|(e, n)| format!("{e} x{n}"))
        .collect::<Vec<_>>()
        .join(", ");

    let mut sections = vec![format!(
        "# Repo map (no code symbols)\n\nRoot: `{}`\nFiles: {} | File types: {}\n\n\
         This workspace has no parseable source symbols, so there is nothing for find_symbol/read_symbol to return.\n\
         Use one grep / codebase_search from the root (add a glob to narrow file types), then read_file a small window around the hits.\n\
         PDFs: PocketCode extracts/OCR (Unlimited-OCR preferred) into app sidecars — call read_file on a `.pdf` path or run prepare after opening the folder.\n",
        root.to_string_lossy(),
        total,
        if ext_line.is_empty() { "(none)".to_string() } else { ext_line }
    )];

    for (folder, files) in by_folder {
        sections.push(format!("## {folder}/"));
        for (path, size) in files.iter().take(MAX_INVENTORY_FILES) {
            sections.push(format!("- `{path}` ({size} B)"));
        }
        sections.push(String::new());
    }

    let mut text = sections.join("\n");
    const MAX_MAP_CHARS: usize = 24_000;
    if text.len() > MAX_MAP_CHARS {
        text.truncate(MAX_MAP_CHARS);
        text.push_str("\n…[inventory truncated — use grep with a glob to narrow down]");
    }
    text
}

/// Compact repo map text for the agent.
pub fn repo_map(workspace_root: &Path) -> AppResult<String> {
    let _ = ensure_index(workspace_root)?;
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let index = load_index(&root);
    let indexed_symbols: usize = index.files.values().map(|f| f.symbols.len()).sum();
    if indexed_symbols == 0 {
        return Ok(inventory_map_text(&root));
    }

    let mut by_folder: BTreeMap<String, Vec<&FileIndexEntry>> = BTreeMap::new();
    for file in index.files.values() {
        let folder = top_folder(&file.path);
        by_folder.entry(folder).or_default().push(file);
    }

    let symbol_count: usize = index.files.values().map(|f| f.symbols.len()).sum();
    let mut sections = Vec::new();
    sections.push(format!(
        "# Repo map\n\nRoot: `{}`\nIndexed files: {} | Symbols: {}\n\n\
         Each line is `path (N symbols): name1, name2, ...`. Use find_symbol / read_symbol / read_file with small windows — never dump whole files.\n",
        root.to_string_lossy(),
        index.files.len(),
        symbol_count
    ));

    for (folder, files) in by_folder {
        sections.push(format!("## {folder}/"));
        for file in files {
            if file.symbols.is_empty() {
                sections.push(format!("- `{}` ({} B)", file.path, file.size_bytes));
            } else {
                let names: Vec<&str> = file
                    .symbols
                    .iter()
                    .take(MAX_SYMBOLS_PER_FILE)
                    .map(|s| s.name.as_str())
                    .collect();
                let more = file.symbols.len().saturating_sub(names.len());
                let suffix = if more > 0 {
                    format!(", +{more} more")
                } else {
                    String::new()
                };
                sections.push(format!(
                    "- `{}` ({} symbols): {}{}",
                    file.path,
                    file.symbols.len(),
                    names.join(", "),
                    suffix
                ));
            }
        }
        sections.push(String::new());
    }

    let mut text = sections.join("\n");
    // Keep repo_map prompt-friendly.
    const MAX_MAP_CHARS: usize = 24_000;
    if text.len() > MAX_MAP_CHARS {
        text.truncate(MAX_MAP_CHARS);
        text.push_str("\n…[repo_map truncated — use find_symbol for specific names]");
    }
    Ok(text)
}

fn top_folder(rel: &str) -> String {
    let n = rel.replace('\\', "/");
    match n.split('/').next() {
        Some(first) if !first.is_empty() && n.contains('/') => first.to_string(),
        _ => ".".to_string(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolHit {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub line_start: i32,
    pub line_end: i32,
    pub signature: String,
}

/// Find symbols by name substring (case-insensitive).
pub fn find_symbol(workspace_root: &Path, query: &str) -> AppResult<Vec<SymbolHit>> {
    let q = query.trim();
    if q.is_empty() {
        return Err(AppError::Unknown("find_symbol requires a non-empty query.".to_string()));
    }
    let _ = ensure_index(workspace_root)?;
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let index = load_index(&root);
    let q_lower = q.to_ascii_lowercase();

    let mut exact = Vec::new();
    let mut partial = Vec::new();
    for file in index.files.values() {
        for sym in &file.symbols {
            let name_l = sym.name.to_ascii_lowercase();
            if name_l == q_lower {
                exact.push(to_hit(sym));
            } else if name_l.contains(&q_lower) {
                partial.push(to_hit(sym));
            }
        }
    }
    exact.extend(partial);
    exact.truncate(MAX_FIND_RESULTS);
    Ok(exact)
}

fn to_hit(sym: &IndexedSymbol) -> SymbolHit {
    SymbolHit {
        path: sym.path.clone(),
        name: sym.name.clone(),
        kind: sym.kind.clone(),
        line_start: sym.line_start,
        line_end: sym.line_end,
        signature: sym.signature.clone(),
    }
}

/// Read one symbol body by path + name (optional line hint). Cap ~8KB.
pub fn read_symbol(
    workspace_root: &Path,
    path: &str,
    name: &str,
    line_start: Option<i32>,
) -> AppResult<String> {
    let name = name.trim();
    let path = standardize(path);
    if name.is_empty() || path.is_empty() {
        return Err(AppError::Unknown(
            "read_symbol requires path and name.".to_string(),
        ));
    }
    let _ = ensure_index(workspace_root)?;
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let index = load_index(&root);
    let file_entry = index.files.get(&path).ok_or_else(|| {
        AppError::Unknown(format!(
            "File not in symbol index: {path}. Call repo_map or find_symbol first."
        ))
    })?;

    let mut candidates: Vec<&IndexedSymbol> = file_entry
        .symbols
        .iter()
        .filter(|s| s.name.eq_ignore_ascii_case(name))
        .collect();
    if candidates.is_empty() {
        candidates = file_entry
            .symbols
            .iter()
            .filter(|s| s.name.to_ascii_lowercase().contains(&name.to_ascii_lowercase()))
            .collect();
    }
    if let Some(ls) = line_start {
        if let Some(hit) = candidates.iter().find(|s| s.line_start == ls) {
            candidates = vec![*hit];
        }
    }
    let sym = candidates.first().copied().ok_or_else(|| {
        AppError::Unknown(format!("Symbol `{name}` not found in {path}"))
    })?;

    let abs = resolve_under_root(&root, &path)?;
    let source = fs::read_to_string(&abs)
        .map_err(|e| AppError::Unknown(format!("Cannot read file: {e}")))?;
    let lines: Vec<&str> = source.lines().collect();
    let start = (sym.line_start.max(1) as usize).saturating_sub(1);
    let end = (sym.line_end.max(1) as usize).min(lines.len());
    if start >= lines.len() {
        return Err(AppError::Unknown("Symbol line range out of bounds.".to_string()));
    }
    let end = end.max(start + 1);
    let mut body = lines[start..end].join("\n");
    if body.len() > MAX_ENTITY_BODY_CHARS {
        body.truncate(MAX_ENTITY_BODY_CHARS);
        body.push_str("\n…[symbol body truncated]");
    }
    Ok(format!(
        "### {} `{}` — {} (L{}-L{})\n```\n{}\n```",
        sym.kind, sym.name, sym.path, sym.line_start, sym.line_end, body
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn find_and_read_symbol_from_index() {
        let dir = std::env::temp_dir().join(format!("pm_sym_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("demo.py");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(
            f,
            "def alpha():\n    return 1\n\ndef beta_helper():\n    return 2\n"
        )
        .unwrap();

        let (touched, total) = ensure_index(&dir).unwrap();
        assert!(touched >= 1);
        assert!(total >= 1);

        let hits = find_symbol(&dir, "alpha").unwrap();
        assert!(!hits.is_empty(), "expected alpha symbol");
        assert!(hits.iter().any(|h| h.name == "alpha"));

        let body = read_symbol(&dir, "demo.py", "alpha", None).unwrap();
        assert!(body.contains("def alpha"));
        assert!(body.contains("return 1"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
