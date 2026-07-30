//! Simplified regex-based symbol index for agent-host.

use crate::error::{Error, Result};
use crate::path::{resolve_under_root, standardize};
use crate::store::WorkspaceSidecar;
use crate::tools::READ_MAX_BYTES;
use crate::types::SymbolHit;
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

const CODE_EXTS: &[&str] = &[
    "rs", "py", "js", "jsx", "ts", "tsx", "go", "java", "kt", "cs", "cpp", "c", "h", "hpp", "rb",
    "php", "swift", "scala", "lua", "r", "dart", "zig",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IndexedSymbol {
    path: String,
    name: String,
    kind: String,
    line_start: i32,
    line_end: i32,
    signature: String,
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

fn index_path(workspace_root: &Path) -> Result<PathBuf> {
    Ok(WorkspaceSidecar::for_workspace(workspace_root)?.index_file())
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
    let path = index_path(workspace_root).unwrap_or_else(|_| {
        WorkspaceSidecar::for_workspace(workspace_root)
            .map(|s| s.index_file())
            .unwrap_or_else(|_| workspace_root.join(INDEX_FILE))
    });
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

fn save_index(workspace_root: &Path, index: &SymbolIndex) -> Result<()> {
    let sidecar = WorkspaceSidecar::for_workspace(workspace_root)?;
    fs::create_dir_all(sidecar.index_dir())
        .map_err(|e| Error::msg(format!("Cannot create index dir: {e}")))?;
    let path = sidecar.index_file();
    let raw = serde_json::to_string(index)
        .map_err(|e| Error::msg(format!("Cannot serialize index: {e}")))?;
    fs::write(&path, raw).map_err(|e| Error::msg(format!("Cannot write index: {e}")))?;
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

fn is_code_extension(ext: &str) -> bool {
    CODE_EXTS.iter().any(|e| *e == ext)
}

fn symbol_patterns() -> &'static [(Regex, &'static str)] {
    static PATS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATS.get_or_init(|| {
        vec![
            (
                Regex::new(r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)")
                    .unwrap(),
                "function",
            ),
            (
                Regex::new(r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_][\w]*)")
                    .unwrap(),
                "type",
            ),
            (
                Regex::new(r"(?m)^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w]*)").unwrap(),
                "function",
            ),
            (
                Regex::new(r"(?m)^\s*(?:export\s+)?(?:class|interface|type|enum)\s+([A-Za-z_][\w]*)")
                    .unwrap(),
                "type",
            ),
            (
                Regex::new(r"(?m)^\s*def\s+([A-Za-z_][\w]*)\s*\(").unwrap(),
                "function",
            ),
            (
                Regex::new(r"(?m)^\s*class\s+([A-Za-z_][\w]*)").unwrap(),
                "class",
            ),
            (
                Regex::new(r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)|^\s*func\s+([A-Za-z_][\w]*)\s*\(")
                    .unwrap(),
                "function",
            ),
        ]
    })
}

fn parse_file_symbols(abs: &Path, rel: &str) -> Vec<IndexedSymbol> {
    let ext = extension_of(abs);
    if !is_code_extension(&ext) {
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

    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (re, kind) in symbol_patterns() {
        for caps in re.captures_iter(&source) {
            let name = caps
                .get(1)
                .or_else(|| caps.get(2))
                .map(|m| m.as_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() || !seen.insert(name.clone()) {
                continue;
            }
            let start = caps.get(0).map(|m| m.start()).unwrap_or(0);
            let line_start = (source[..start].bytes().filter(|b| *b == b'\n').count() + 1) as i32;
            out.push(IndexedSymbol {
                path: rel.to_string(),
                name: name.clone(),
                kind: kind.to_string(),
                line_start,
                line_end: line_start + 20,
                signature: format!("{kind} {name}"),
            });
            if out.len() >= 64 {
                return out;
            }
        }
    }
    out
}

pub fn ensure_index(workspace_root: &Path) -> Result<(usize, usize)> {
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    if !root.is_dir() {
        return Err(Error::msg("Workspace root is not a directory.".to_string()));
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
        if !is_code_extension(&ext) {
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
        let rel = rel.replace('\\', "/");
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
fn non_code_inventory(
    root: &Path,
) -> (
    usize,
    BTreeMap<String, Vec<(String, u64)>>,
    BTreeMap<String, usize>,
) {
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
         Use one grep from the root (add a glob to narrow file types), then read_file a small window around the hits.\n",
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

pub fn repo_map(workspace_root: &Path) -> Result<String> {
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
        "# Repo map\n\nRoot: `{}`\nIndexed files: {} | Symbols: {}\n",
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

pub fn find_symbol(workspace_root: &Path, query: &str) -> Result<Vec<SymbolHit>> {
    let q = query.trim();
    if q.is_empty() {
        return Err(Error::msg(
            "find_symbol requires a non-empty query.".to_string(),
        ));
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

pub fn read_symbol(
    workspace_root: &Path,
    path: &str,
    name: &str,
    line_start: Option<i32>,
) -> Result<String> {
    let name = name.trim();
    let path = standardize(path).replace('\\', "/");
    if name.is_empty() || path.is_empty() {
        return Err(Error::msg(
            "read_symbol requires path and name.".to_string(),
        ));
    }
    let _ = ensure_index(workspace_root)?;
    let root = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    let index = load_index(&root);
    let file_entry = index.files.get(&path).ok_or_else(|| {
        Error::msg(format!(
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
            .filter(|s| {
                s.name
                    .to_ascii_lowercase()
                    .contains(&name.to_ascii_lowercase())
            })
            .collect();
    }
    if let Some(ls) = line_start {
        if let Some(hit) = candidates.iter().find(|s| s.line_start == ls) {
            candidates = vec![*hit];
        }
    }
    let sym = candidates
        .first()
        .copied()
        .ok_or_else(|| Error::msg(format!("Symbol `{name}` not found in {path}")))?;

    let abs = resolve_under_root(&root, &path)?;
    let source =
        fs::read_to_string(&abs).map_err(|e| Error::msg(format!("Cannot read file: {e}")))?;
    let lines: Vec<&str> = source.lines().collect();
    let start = (sym.line_start.max(1) as usize).saturating_sub(1);
    let end = (sym.line_end.max(1) as usize).min(lines.len());
    if start >= lines.len() {
        return Err(Error::msg("Symbol line range out of bounds.".to_string()));
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
