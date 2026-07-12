//! Codebase Explorer mode: repo map + symbol-first retrieval over the same local index.
//!
//! Unlike Folder Q&A (document-oriented grounded RAG), this mode is tuned for
//! engineering questions like "what does handleSend do?" or "where is hybrid search?".
//! It builds a compact repo map from the file catalog plus Tree-sitter symbols, and
//! hard-pins matching code entities (whole function/class bodies) ahead of chunk RAG.

use std::collections::BTreeMap;

use rusqlite::params;

use crate::database::Database;
use crate::error::{AppError, AppResult};
use crate::knowledge_chat::db;
use crate::knowledge_chat::query_intent::{
    extract_camel_symbols, extract_file_hint, extract_snake_case_symbols,
};
use crate::knowledge_chat::types::{
    KcCodebaseContext, KcGroundedContextSource, KcRepoMap, KcSymbolEntity,
};

/// Max symbols listed per file in the repo map (keeps the prompt compact).
const MAX_SYMBOLS_PER_FILE: usize = 16;
/// Max code entities pinned as primary context for a single query.
const MAX_PINNED_ENTITIES: usize = 12;
/// Max characters of a single entity body attached to context.
const MAX_ENTITY_BODY_CHARS: usize = 8_000;

struct RepoFileRow {
    relative_path: String,
    size_bytes: i64,
    code_entity_count: i64,
}

struct RepoSymbolRow {
    relative_path: String,
    entity_kind: String,
    entity_name: String,
    line_start: i32,
    line_end: i32,
}

/// Build a compact repo map: one line per file with its top symbols, grouped by folder.
pub fn build_repo_map(db: &Database, collection_id: &str) -> AppResult<KcRepoMap> {
    let collection = db::get_collection(db, collection_id)?;
    let files = load_repo_files(db, collection_id)?;
    let symbols_by_file = load_repo_symbols(db, collection_id)?;
    let symbol_count: i64 = symbols_by_file.values().map(|v| v.len() as i64).sum();

    let mut by_folder: BTreeMap<String, Vec<&RepoFileRow>> = BTreeMap::new();
    for file in &files {
        by_folder.entry(top_folder(&file.relative_path)).or_default().push(file);
    }

    let mut sections = Vec::new();
    sections.push(format!(
        "# Repo map\n\nCollection: **{}**\nRoot: `{}`\nIndexed files: {} | Code symbols: {}\n",
        collection.name,
        collection.root_path,
        files.len(),
        symbol_count
    ));
    sections.push(
        "Each line is `relative_path (N symbols): symbol1, symbol2, ...`. \
         Use it to decide which files to read; ask for a file by relative path if you need its full contents.\n"
            .to_string(),
    );

    for (folder, folder_files) in by_folder {
        sections.push(format!("## {folder}/"));
        for file in folder_files {
            let symbols = symbols_by_file.get(&file.relative_path);
            let line = match symbols {
                Some(syms) if !syms.is_empty() => {
                    let names: Vec<String> = syms
                        .iter()
                        .take(MAX_SYMBOLS_PER_FILE)
                        .map(|s| s.entity_name.clone())
                        .collect();
                    let more = syms.len().saturating_sub(names.len());
                    let suffix = if more > 0 { format!(", +{more} more") } else { String::new() };
                    format!(
                        "- `{}` ({} symbols): {}{}",
                        file.relative_path,
                        syms.len(),
                        names.join(", "),
                        suffix
                    )
                }
                _ => format!("- `{}` ({} B)", file.relative_path, file.size_bytes),
            };
            sections.push(line);
        }
        sections.push(String::new());
    }

    Ok(KcRepoMap {
        collection_id: collection_id.to_string(),
        collection_name: collection.name,
        root_path: collection.root_path,
        map_text: sections.join("\n"),
        file_count: files.len() as i64,
        symbol_count,
    })
}

/// Assemble symbol-first context for a query: repo map + pinned entity bodies.
pub fn build_codebase_context(
    db: &Database,
    collection_id: &str,
    query: &str,
) -> AppResult<KcCodebaseContext> {
    let repo_map = build_repo_map(db, collection_id)?;
    let symbols = query_symbols(query);
    let entities = find_symbol_entities(db, collection_id, &symbols)?;

    let mut sources = Vec::new();
    let mut pinned_paths = Vec::new();
    let mut blocks = Vec::new();
    for entity in &entities {
        if !pinned_paths.contains(&entity.relative_path) {
            pinned_paths.push(entity.relative_path.clone());
        }
        let body = truncate_chars(&entity.body, MAX_ENTITY_BODY_CHARS);
        blocks.push(format!(
            "### {} `{}` — {} (L{}-L{})\n```\n{}\n```",
            entity.entity_kind,
            entity.entity_name,
            entity.relative_path,
            entity.line_start,
            entity.line_end,
            body
        ));
        sources.push(KcGroundedContextSource {
            file_name: entity.file_name.clone(),
            entity_kind: Some(entity.entity_kind.clone()),
            entity_name: Some(entity.entity_name.clone()),
            line_start: entity.line_start,
            line_end: entity.line_end,
            source_confidence: 0.95,
            text: body,
            parse_mode: Some(entity.parse_mode.clone()),
            source_type: "code_entity".to_string(),
        });
    }

    let context_block = if blocks.is_empty() {
        String::new()
    } else {
        format!(
            "## Pinned code symbols\n\nThese function/class bodies match symbols in the question. Cite them with file and line numbers.\n\n{}",
            blocks.join("\n\n")
        )
    };

    Ok(KcCodebaseContext {
        repo_map: repo_map.map_text,
        context_block,
        sources,
        pinned_symbols: symbols,
        pinned_paths,
    })
}

/// Resolve the code entities (with Tree-sitter bodies) for any symbols named in the
/// query. Shared by Codebase Explorer context assembly and the standard search path so
/// extractive answers can quote indexed bodies instead of re-parsing chunk text.
pub fn symbol_entities_for_query(
    db: &Database,
    collection_id: &str,
    query: &str,
) -> AppResult<Vec<KcSymbolEntity>> {
    let symbols = query_symbols(query);
    if symbols.is_empty() {
        return Ok(Vec::new());
    }
    find_symbol_entities(db, collection_id, &symbols)
}

fn query_symbols(query: &str) -> Vec<String> {
    let mut symbols = Vec::new();
    for sym in extract_camel_symbols(query) {
        push_unique(&mut symbols, sym);
    }
    for sym in extract_snake_case_symbols(query) {
        push_unique(&mut symbols, sym);
    }
    if let Some(file) = extract_file_hint(query) {
        if let Some(stem) = file.split('.').next() {
            if stem.len() > 2 {
                push_unique(&mut symbols, stem.to_string());
            }
        }
    }
    symbols
}

fn push_unique(symbols: &mut Vec<String>, value: String) {
    if !symbols.iter().any(|s| s.eq_ignore_ascii_case(&value)) {
        symbols.push(value);
    }
}

fn find_symbol_entities(
    db: &Database,
    collection_id: &str,
    symbols: &[String],
) -> AppResult<Vec<KcSymbolEntity>> {
    let mut out: Vec<KcSymbolEntity> = Vec::new();
    for symbol in symbols {
        if out.len() >= MAX_PINNED_ENTITIES {
            break;
        }
        let exact = load_entities_for_symbol(db, collection_id, symbol, true)?;
        let hits = if exact.is_empty() {
            load_entities_for_symbol(db, collection_id, symbol, false)?
        } else {
            exact
        };
        for hit in hits {
            if out.len() >= MAX_PINNED_ENTITIES {
                break;
            }
            let already = out
                .iter()
                .any(|e| e.relative_path == hit.relative_path && e.entity_name == hit.entity_name);
            if !already {
                out.push(hit);
            }
        }
    }
    Ok(out)
}

fn load_entities_for_symbol(
    db: &Database,
    collection_id: &str,
    symbol: &str,
    exact: bool,
) -> AppResult<Vec<KcSymbolEntity>> {
    let (clause, value) = if exact {
        ("lower(e.entity_name) = lower(?2)", symbol.to_string())
    } else {
        ("lower(e.entity_name) LIKE ?2", format!("%{}%", symbol.to_lowercase()))
    };
    let sql = format!(
        "SELECT f.name, f.relative_path, e.entity_kind, e.entity_name, e.line_start, e.line_end, e.parse_mode, e.body
         FROM kc_code_entities e
         JOIN kc_files f ON f.id = e.file_id
         WHERE e.collection_id = ?1 AND {clause}
         ORDER BY length(e.body) DESC
         LIMIT ?3"
    );
    let mut stmt = db
        .conn()
        .prepare(&sql)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = stmt
        .query_map(params![collection_id, value, MAX_PINNED_ENTITIES as i64], |row| {
            Ok(KcSymbolEntity {
                file_name: row.get(0)?,
                relative_path: row.get(1)?,
                entity_kind: row.get(2)?,
                entity_name: row.get(3)?,
                line_start: row.get(4)?,
                line_end: row.get(5)?,
                parse_mode: row.get(6)?,
                body: row.get(7)?,
            })
        })
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))
}

fn load_repo_files(db: &Database, collection_id: &str) -> AppResult<Vec<RepoFileRow>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT relative_path, size_bytes, code_entity_count
             FROM kc_files
             WHERE collection_id = ?1 AND status = 'indexed'
             ORDER BY relative_path ASC",
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = stmt
        .query_map(params![collection_id], |row| {
            Ok(RepoFileRow {
                relative_path: row.get(0)?,
                size_bytes: row.get(1)?,
                code_entity_count: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
            })
        })
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))
}

fn load_repo_symbols(
    db: &Database,
    collection_id: &str,
) -> AppResult<BTreeMap<String, Vec<RepoSymbolRow>>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT f.relative_path, e.entity_kind, e.entity_name, e.line_start, e.line_end
             FROM kc_code_entities e
             JOIN kc_files f ON f.id = e.file_id
             WHERE e.collection_id = ?1
             ORDER BY f.relative_path ASC, e.entity_index ASC",
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = stmt
        .query_map(params![collection_id], |row| {
            Ok(RepoSymbolRow {
                relative_path: row.get(0)?,
                entity_kind: row.get(1)?,
                entity_name: row.get(2)?,
                line_start: row.get(3)?,
                line_end: row.get(4)?,
            })
        })
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    let mut by_file: BTreeMap<String, Vec<RepoSymbolRow>> = BTreeMap::new();
    for row in rows {
        by_file.entry(row.relative_path.clone()).or_default().push(row);
    }
    Ok(by_file)
}

fn top_folder(relative_path: &str) -> String {
    let normalized = relative_path.replace('\\', "/");
    match normalized.split_once('/') {
        Some((folder, _)) if !folder.is_empty() => folder.to_string(),
        _ => ".".to_string(),
    }
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_chars).collect();
    format!("{truncated}\n… (truncated)")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn top_folder_extracts_first_segment() {
        assert_eq!(top_folder("code/ChatView.tsx"), "code");
        assert_eq!(top_folder("src\\components\\Foo.tsx"), "src");
        assert_eq!(top_folder("README.md"), ".");
    }

    #[test]
    fn query_symbols_extracts_camel_snake_and_file_stem() {
        let syms = query_symbols("What does handleSend do in ChatView.tsx and load_config?");
        assert!(syms.iter().any(|s| s == "handleSend"));
        assert!(syms.iter().any(|s| s == "load_config"));
        assert!(syms.iter().any(|s| s.eq_ignore_ascii_case("ChatView")));
    }

    #[test]
    fn truncate_chars_caps_long_bodies() {
        let body = "x".repeat(100);
        let out = truncate_chars(&body, 10);
        assert!(out.starts_with(&"x".repeat(10)));
        assert!(out.contains("truncated"));
    }

    /// Acceptance guard for the handleSend extractive answer: behavior must be
    /// derived from executable code, not the `invoke(...)` mention in the comment.
    /// The extractive answer stage strips line comments before describing the body,
    /// so the fixture's executable lines must contain `console.log` and must NOT
    /// contain `invoke(`.
    #[test]
    fn handlesend_fixture_has_log_and_no_invoke_in_code() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../test-fixtures/kc-qa-corpus/code/ChatView.tsx"
        );
        let source = std::fs::read_to_string(path).expect("read ChatView.tsx fixture");

        // Isolate the handleSend body (between its declaration and the next `};`).
        let start = source.find("const handleSend").expect("handleSend present");
        let body: String = source[start..]
            .lines()
            .take_while(|line| !line.trim_start().starts_with("const handleKeyDown"))
            .collect::<Vec<_>>()
            .join("\n");

        // Strip line comments, matching the TS `describeFunctionBody` pre-processing.
        let executable: String = body
            .lines()
            .map(|line| line.split("//").next().unwrap_or("").trim())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n");

        assert!(body.contains("invoke('add_message'"), "comment mentions invoke");
        assert!(
            executable.contains("console.log"),
            "executable lines should log the message"
        );
        assert!(
            !executable.contains("invoke("),
            "invoke(...) lives only in a comment and must not be treated as executable"
        );
    }
}
