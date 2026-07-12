use crate::config::GatewayConfig;
use crate::db::GatewayDb;
use crate::http_clients::HttpClients;
use anyhow::Result;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const CHUNK_CHARS: usize = 1200;
const CHUNK_OVERLAP: usize = 150;

#[derive(Debug, Serialize)]
pub struct IndexResult {
    pub collection_id: String,
    pub name: String,
    pub root_path: String,
    pub file_count: i64,
    pub indexed_files: i64,
    pub chunk_count: i64,
    pub dense_chunk_count: i64,
    pub status: String,
    pub warnings: Vec<String>,
}

pub async fn index_collection(
    db: &GatewayDb,
    http: &HttpClients,
    cfg: &GatewayConfig,
    name: &str,
    rebuild: bool,
) -> Result<IndexResult> {
    let root = cfg.collections_dir.join(name);
    if !root.is_dir() {
        anyhow::bail!(
            "Collection folder not found: {}. Copy files to {}/<name>/ first.",
            root.display(),
            cfg.collections_dir.display()
        );
    }
    let root_str = root.to_string_lossy().to_string();
    let collection = db.upsert_collection(name, &root_str)?;
    if rebuild {
        db.clear_collection_content(&collection.id)?;
    }

    let mut warnings = Vec::new();
    let mut indexed_files = 0i64;
    let mut chunk_count = 0i64;
    let mut dense_count = 0i64;

    let files = collect_files(&root)?;
    let file_count = files.len() as i64;

    for file in files {
        let Ok(meta) = fs::metadata(&file.absolute) else {
            warnings.push(format!("skip unreadable {}", file.relative));
            continue;
        };
        if meta.len() > MAX_FILE_BYTES {
            warnings.push(format!("skip oversized {}", file.relative));
            continue;
        }
        let Ok(raw) = fs::read_to_string(&file.absolute) else {
            warnings.push(format!("skip binary/unreadable {}", file.relative));
            continue;
        };
        let text = raw.replace('\r', "");
        if text.trim().is_empty() {
            continue;
        }
        let hash = hex_sha256(text.as_bytes());
        let file_id = db.insert_file(
            &collection.id,
            &file.relative,
            &file.file_name,
            &hash,
            &file.partition,
        )?;
        indexed_files += 1;

        let chunks = chunk_text(&file.file_name, &text);
        let texts: Vec<String> = chunks.iter().map(|c| c.body.clone()).collect();
        let embed_base = if file.partition == "code" {
            &cfg.embed_code_url
        } else {
            &cfg.embed_knowledge_url
        };

        let vectors = match http.embed(embed_base, &texts).await {
            Ok(v) => v,
            Err(err) => {
                warnings.push(format!("embed failed for {}: {err}", file.relative));
                vec![Vec::new(); texts.len()]
            }
        };

        for (idx, chunk) in chunks.into_iter().enumerate() {
            let dense = vectors.get(idx).filter(|v| !v.is_empty()).cloned();
            if dense.is_some() {
                dense_count += 1;
            }
            db.insert_chunk(
                &collection.id,
                &file_id,
                idx as i64,
                &chunk.title,
                &chunk.body,
                &file.partition,
                dense.as_deref(),
            )?;
            chunk_count += 1;
        }
    }

    let dense_status = if dense_count > 0 { "ready" } else { "failed" };
    let status = if chunk_count > 0 { "ready" } else { "failed" };
    let err = if chunk_count == 0 {
        Some("No indexable text chunks found")
    } else {
        None
    };
    db.finalize_collection(
        &collection.id,
        file_count,
        indexed_files,
        chunk_count,
        dense_count,
        status,
        dense_status,
        err,
    )?;

    Ok(IndexResult {
        collection_id: collection.id,
        name: name.to_string(),
        root_path: root_str,
        file_count,
        indexed_files,
        chunk_count,
        dense_chunk_count: dense_count,
        status: status.to_string(),
        warnings,
    })
}

struct FileEntry {
    absolute: PathBuf,
    relative: String,
    file_name: String,
    partition: String,
}

struct TextChunk {
    title: String,
    body: String,
}

fn collect_files(root: &Path) -> Result<Vec<FileEntry>> {
    let mut out = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !is_text_ext(&ext) {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        let partition = partition_for(&relative, &ext);
        out.push(FileEntry {
            absolute: path.to_path_buf(),
            relative,
            file_name,
            partition,
        });
    }
    Ok(out)
}

fn is_text_ext(ext: &str) -> bool {
    matches!(
        ext,
        "txt"
            | "md"
            | "markdown"
            | "rst"
            | "csv"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
            | "xml"
            | "html"
            | "rs"
            | "py"
            | "js"
            | "ts"
            | "tsx"
            | "jsx"
            | "go"
            | "java"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "cs"
            | "sh"
            | "ps1"
            | "sql"
            | "log"
    )
}

fn partition_for(relative: &str, ext: &str) -> String {
    let lower = relative.to_ascii_lowercase();
    if lower.contains("/code/")
        || matches!(
            ext,
            "rs" | "py" | "js" | "ts" | "tsx" | "jsx" | "go" | "java" | "c" | "h" | "cpp" | "hpp" | "cs"
        )
    {
        "code".into()
    } else if lower.contains("runbook") {
        "runbooks".into()
    } else if lower.contains("/docs/") || matches!(ext, "md" | "markdown" | "rst") {
        "documentation".into()
    } else {
        "general".into()
    }
}

fn chunk_text(file_name: &str, text: &str) -> Vec<TextChunk> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut idx = 0usize;
    while start < chars.len() {
        let end = (start + CHUNK_CHARS).min(chars.len());
        let body: String = chars[start..end].iter().collect();
        let title = format!("{file_name}#{}", idx + 1);
        out.push(TextChunk { title, body });
        idx += 1;
        if end >= chars.len() {
            break;
        }
        start = end.saturating_sub(CHUNK_OVERLAP);
    }
    out
}

fn hex_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}
