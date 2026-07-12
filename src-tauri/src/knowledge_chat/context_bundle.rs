//! Bundles evidence hits into LLM context: whole file when ≤ 5 KB, indexed excerpts otherwise.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::knowledge_chat::types::{KcFileCatalogEntry, KcGroundedContextSource, KcSearchHit};

pub const MIN_LLM_BUNDLE_CONFIDENCE: f64 = 0.18;
/// Accuracy-first whole-file attach budget (was 5 KB; too small for most source files).
pub const MAX_WHOLE_FILE_BYTES: usize = 24_576;
/// Demo-profile attach budget — still larger than the old 5 KB laptop cap.
pub const MAX_WHOLE_FILE_BYTES_DEMO: usize = 12_288;

pub struct BundleOptions {
    pub collection_name: String,
    pub max_whole_file_bytes: usize,
}

pub struct BundleOutcome {
    pub sources: Vec<KcGroundedContextSource>,
    pub context_block: String,
    pub bundled_count: usize,
    pub omitted_oversize: Vec<String>,
}

struct FileEvidence {
    file_id: String,
    file_name: String,
    file_path: String,
    best_confidence: f64,
    line_start: i32,
    line_end: i32,
    entity_kind: Option<String>,
    entity_name: Option<String>,
    source_type: String,
    parse_mode: Option<String>,
}

pub fn bundle_hits_for_llm(hits: &[KcSearchHit], options: &BundleOptions) -> BundleOutcome {
    bundle_hits_for_llm_with_pins(hits, options, &[], "")
}

pub fn bundle_hits_for_llm_with_pins(
    hits: &[KcSearchHit],
    options: &BundleOptions,
    pinned_relative_paths: &[String],
    collection_root: &str,
) -> BundleOutcome {
    let mut files = collect_pinned_file_evidence(pinned_relative_paths, collection_root, hits);
    for file in collect_unique_file_evidence(hits) {
        if !files.iter().any(|existing| existing.file_name == file.file_name) {
            files.push(file);
        }
    }
    files.sort_by(|a, b| {
        b.best_confidence
            .partial_cmp(&a.best_confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut sources = Vec::new();
    let mut sections = Vec::new();
    let mut omitted_oversize = Vec::new();

    for file in files {
        if let Some(content) = read_whole_file(&file.file_path, options.max_whole_file_bytes) {
            let block = format_file_attachment(&file, &content, "whole_file");
            sources.push(KcGroundedContextSource {
                file_name: file.file_name.clone(),
                entity_kind: file.entity_kind.clone(),
                entity_name: file.entity_name.clone(),
                line_start: file.line_start,
                line_end: file.line_end,
                source_confidence: file.best_confidence,
                text: content,
                parse_mode: file.parse_mode.clone(),
                source_type: "whole_file".to_string(),
            });
            sections.push(block);
            continue;
        }

        let excerpt = build_excerpt_from_hits(hits, &file.file_id);
        if excerpt.is_empty() {
            omitted_oversize.push(file.file_name.clone());
            continue;
        }

        let block = format_excerpt_attachment(&file, &excerpt);
        sources.push(KcGroundedContextSource {
            file_name: file.file_name.clone(),
            entity_kind: file.entity_kind.clone(),
            entity_name: file.entity_name.clone(),
            line_start: file.line_start,
            line_end: file.line_end,
            source_confidence: file.best_confidence,
            text: excerpt.clone(),
            parse_mode: file.parse_mode.clone(),
            source_type: "excerpt".to_string(),
        });
        sections.push(block);
    }

    let bundled_count = sources.len();
    let context_block = build_context_block(
        &options.collection_name,
        bundled_count,
        &omitted_oversize,
        &sections,
    );

    BundleOutcome {
        sources,
        context_block,
        bundled_count,
        omitted_oversize,
    }
}

/// Attach whole files explicitly chosen by the LLM from the indexed catalog (pass 2).
pub fn bundle_catalog_entries(
    entries: &[KcFileCatalogEntry],
    collection_name: &str,
) -> BundleOutcome {
    let mut sources = Vec::new();
    let mut sections = Vec::new();
    let mut omitted_oversize = Vec::new();

    for entry in entries {
        if !entry.attachable {
            omitted_oversize.push(entry.relative_path.clone());
            continue;
        }
        match read_whole_file(&entry.absolute_path, MAX_WHOLE_FILE_BYTES) {
            Some(content) => {
                let block = format!(
                    "### File: {} | {} | {} bytes\n\
                     Full file contents (selected from catalog):\n\
                     ```{}\n{}\n```",
                    entry.relative_path,
                    entry.summary,
                    content.len(),
                    fence_lang_for_path(&entry.absolute_path),
                    content.trim_end()
                );
                sources.push(KcGroundedContextSource {
                    file_name: entry.file_name.clone(),
                    entity_kind: Some("file".to_string()),
                    entity_name: Some(entry.relative_path.clone()),
                    line_start: 1,
                    line_end: content.lines().count().max(1) as i32,
                    source_confidence: 1.0,
                    text: content,
                    parse_mode: None,
                    source_type: "whole_file".to_string(),
                });
                sections.push(block);
            }
            None => {
                omitted_oversize.push(entry.relative_path.clone());
            }
        }
    }

    let bundled_count = sources.len();
    let mut header = format!(
        "Collection: {collection_name}\n\n\
         ATTACHED SOURCE FILES ({bundled_count} LLM-selected file(s), each <= {} bytes)\n\
         These are COMPLETE file contents chosen from the indexed folder catalog.",
        MAX_WHOLE_FILE_BYTES
    );
    if !omitted_oversize.is_empty() {
        header.push_str(&format!(
            "\nOmitted (> {} bytes or unreadable): {}.",
            MAX_WHOLE_FILE_BYTES,
            omitted_oversize.join(", ")
        ));
    }

    let context_block = if bundled_count == 0 {
        format!(
            "{header}\n\nNo selected files could be attached. Pick attachable paths from the catalog."
        )
    } else {
        format!("{header}\n\n---\n\n{}", sections.join("\n\n---\n\n"))
    };

    BundleOutcome {
        sources,
        context_block,
        bundled_count,
        omitted_oversize,
    }
}

pub fn filter_hits_for_bundle(hits: &[KcSearchHit]) -> Vec<KcSearchHit> {
    hits.iter()
        .filter(|hit| hit.chunk.source_confidence.unwrap_or(0.0) >= MIN_LLM_BUNDLE_CONFIDENCE)
        .cloned()
        .collect()
}

pub fn bundle_options_for_profile(collection_name: &str, server_profile: bool) -> BundleOptions {
    BundleOptions {
        collection_name: collection_name.to_string(),
        max_whole_file_bytes: if server_profile {
            MAX_WHOLE_FILE_BYTES
        } else {
            MAX_WHOLE_FILE_BYTES_DEMO
        },
    }
}

fn collect_pinned_file_evidence(
    pinned_relative_paths: &[String],
    collection_root: &str,
    hits: &[KcSearchHit],
) -> Vec<FileEvidence> {
    if pinned_relative_paths.is_empty() || collection_root.trim().is_empty() {
        return Vec::new();
    }
    let root = Path::new(collection_root);
    let mut out = Vec::new();
    for rel in pinned_relative_paths {
        let trimmed = rel.trim_start_matches(['/', '\\']);
        let abs = root.join(trimmed);
        if !abs.is_file() {
            continue;
        }
        let abs_str = abs.to_string_lossy().to_string();
        let file_name = abs
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(trimmed)
            .to_string();
        if out.iter().any(|f: &FileEvidence| f.file_name == file_name) {
            continue;
        }
        if let Some(hit) = hits.iter().find(|hit| {
            hit.chunk.file_name == file_name
                || hit.chunk.file_path == abs_str
                || hit.chunk.file_path.ends_with(trimmed)
        }) {
            let mut evidence = file_evidence_from_hit(hit, hit.chunk.source_confidence.unwrap_or(0.9).max(0.9));
            evidence.best_confidence = evidence.best_confidence.max(0.95);
            out.push(evidence);
        } else {
            out.push(FileEvidence {
                file_id: format!("pin-{file_name}"),
                file_name,
                file_path: abs_str,
                best_confidence: 1.0,
                line_start: 0,
                line_end: 0,
                entity_kind: Some("file".to_string()),
                entity_name: Some(trimmed.to_string()),
                source_type: "pinned_file".to_string(),
                parse_mode: None,
            });
        }
    }
    out
}

fn collect_unique_file_evidence(hits: &[KcSearchHit]) -> Vec<FileEvidence> {
    let mut by_file: HashMap<String, FileEvidence> = HashMap::new();

    for hit in hits {
        let confidence = hit.chunk.source_confidence.unwrap_or(0.0);
        if confidence < MIN_LLM_BUNDLE_CONFIDENCE {
            continue;
        }

        let file_id = hit.chunk.file_id.clone();
        by_file
            .entry(file_id.clone())
            .and_modify(|entry| {
                if confidence > entry.best_confidence {
                    merge_hit_into_file_evidence(entry, hit, confidence);
                }
            })
            .or_insert_with(|| file_evidence_from_hit(hit, confidence));
    }

    let mut files: Vec<FileEvidence> = by_file.into_values().collect();
    files.sort_by(|a, b| {
        b.best_confidence
            .partial_cmp(&a.best_confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    files
}

fn file_evidence_from_hit(hit: &KcSearchHit, confidence: f64) -> FileEvidence {
    FileEvidence {
        file_id: hit.chunk.file_id.clone(),
        file_name: hit.chunk.file_name.clone(),
        file_path: hit.chunk.file_path.clone(),
        best_confidence: confidence,
        line_start: hit.chunk.line_start.unwrap_or(0),
        line_end: hit.chunk.line_end.unwrap_or(0),
        entity_kind: hit.chunk.entity_kind.clone(),
        entity_name: hit.chunk.entity_name.clone(),
        source_type: hit.chunk.source_type.clone(),
        parse_mode: hit.chunk.parse_mode.clone(),
    }
}

fn merge_hit_into_file_evidence(entry: &mut FileEvidence, hit: &KcSearchHit, confidence: f64) {
    entry.best_confidence = confidence;
    entry.line_start = hit.chunk.line_start.unwrap_or(entry.line_start);
    entry.line_end = hit.chunk.line_end.unwrap_or(entry.line_end);
    entry.entity_kind = hit.chunk.entity_kind.clone().or_else(|| entry.entity_kind.clone());
    entry.entity_name = hit.chunk.entity_name.clone().or_else(|| entry.entity_name.clone());
    entry.source_type = hit.chunk.source_type.clone();
    entry.parse_mode = hit.chunk.parse_mode.clone();
}

fn read_whole_file(path: &str, max_bytes: usize) -> Option<String> {
    if path.trim().is_empty() {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() as usize > max_bytes {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > max_bytes {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn build_excerpt_from_hits(hits: &[KcSearchHit], file_id: &str) -> String {
    let mut file_hits: Vec<&KcSearchHit> = hits
        .iter()
        .filter(|hit| hit.chunk.file_id == file_id)
        .filter(|hit| hit.chunk.source_confidence.unwrap_or(0.0) >= MIN_LLM_BUNDLE_CONFIDENCE)
        .collect();
    file_hits.sort_by_key(|hit| hit.chunk.line_start.unwrap_or(0));

    let mut seen = HashSet::new();
    let mut parts = Vec::new();
    for hit in file_hits {
        let text = hit
            .chunk
            .context_text
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(hit.chunk.text.as_str());
        let trimmed = text.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            continue;
        }
        let anchor = line_anchor(
            hit.chunk.line_start.unwrap_or(0),
            hit.chunk.line_end.unwrap_or(0),
        );
        let lang = fence_lang_for_path(&hit.chunk.file_path);
        parts.push(format!(
            "Indexed excerpt{anchor} (confidence {:.0}%):\n```{lang}\n{trimmed}\n```",
            hit.chunk.source_confidence.unwrap_or(0.0) * 100.0
        ));
    }

    parts.join("\n\n")
}

fn format_excerpt_attachment(file: &FileEvidence, excerpt: &str) -> String {
    let label = source_label(file);
    let anchor = line_anchor(file.line_start, file.line_end);
    format!(
        "### File: {} | {} | retrieval confidence {:.0}%{}\n\
         Indexed excerpts from this file (>{MAX_WHOLE_FILE_BYTES} bytes — whole file omitted, excerpts attached):\n\
         {excerpt}",
        file.file_name,
        label,
        file.best_confidence * 100.0,
        anchor,
    )
}

fn format_file_attachment(file: &FileEvidence, content: &str, kind: &str) -> String {
    let label = source_label(file);
    let anchor = line_anchor(file.line_start, file.line_end);
    let lang = fence_lang_for_path(&file.file_path);
    let kind_label = if kind == "whole_file" {
        "Full file contents"
    } else {
        "Attached contents"
    };
    format!(
        "### File: {} | {} | retrieval confidence {:.0}%{}\n\
         {kind_label} ({} bytes, limit {} bytes):\n\
         ```{lang}\n{}\n```",
        file.file_name,
        label,
        file.best_confidence * 100.0,
        anchor,
        content.len(),
        MAX_WHOLE_FILE_BYTES,
        content.trim_end()
    )
}

fn build_context_block(
    collection_name: &str,
    bundled_count: usize,
    omitted_oversize: &[String],
    sections: &[String],
) -> String {
    if bundled_count == 0 {
        let mut msg = format!(
            "Collection: {collection_name}\n\n\
             ATTACHED SOURCE FILES: none.\n\
             No indexed sources met the bundle rules (retrieval confidence >= {:.0}%).",
            MIN_LLM_BUNDLE_CONFIDENCE * 100.0,
        );
        if !omitted_oversize.is_empty() {
            msg.push_str(&format!(
                "\n\nFiles found by retrieval but had no attachable content: {}.",
                omitted_oversize.join(", ")
            ));
        }
        return msg;
    }

    let mut header = format!(
        "Collection: {collection_name}\n\n\
         ATTACHED SOURCE FILES ({bundled_count} source file(s))\n\
         Each block is either the COMPLETE file (<= {} bytes) or indexed excerpts from retrieval \
         when the file is larger. Use ONLY these blocks to answer.",
        MAX_WHOLE_FILE_BYTES,
    );
    if !omitted_oversize.is_empty() {
        header.push_str(&format!(
            "\nNo excerpt available for: {}.",
            omitted_oversize.join(", ")
        ));
    }

    format!("{header}\n\n---\n\n{}", sections.join("\n\n---\n\n"))
}

fn source_label(file: &FileEvidence) -> String {
    if let (Some(kind), Some(name)) = (&file.entity_kind, &file.entity_name) {
        return format!("{kind} {name}");
    }
    if let Some(name) = &file.entity_name {
        return name.clone();
    }
    "file".to_string()
}

fn line_anchor(line_start: i32, line_end: i32) -> String {
    match (line_start, line_end) {
        (start, end) if start > 0 && end >= start => format!(" | L{start}-L{end}"),
        (start, _) if start > 0 => format!(" | L{start}"),
        _ => String::new(),
    }
}

fn fence_lang_for_path(path: &str) -> &'static str {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| match ext.to_ascii_lowercase().as_str() {
            "py" => "python",
            "rs" => "rust",
            "ts" | "tsx" => "typescript",
            "js" | "jsx" => "javascript",
            "md" => "markdown",
            "json" => "json",
            "go" => "go",
            "java" => "java",
            "cs" => "csharp",
            "cpp" | "cc" | "cxx" | "h" | "hpp" => "cpp",
            "c" => "c",
            "sql" => "sql",
            "yaml" | "yml" => "yaml",
            "toml" => "toml",
            "sh" | "bash" => "bash",
            _ => "",
        })
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge_chat::types::{KcChunkRecord, KcRetrievalMode, KcSearchHit};
    use std::io::Write;

    fn hit(
        confidence: f64,
        file: &str,
        path: &str,
        file_id: &str,
        text: &str,
    ) -> KcSearchHit {
        KcSearchHit {
            chunk: KcChunkRecord {
                id: format!("{file_id}-1"),
                collection_id: "c".into(),
                file_id: file_id.into(),
                file_name: file.into(),
                file_path: path.into(),
                chunk_index: 0,
                title: file.into(),
                start_char: 0,
                end_char: 0,
                text: text.into(),
                top_terms: vec![],
                has_dense: true,
                parent_text: None,
                section_path: Some("Three layers".into()),
                doc_type: Some("markdown".into()),
                partition_id: Some("documentation".into()),
                context_text: None,
                line_start: Some(5),
                line_end: Some(9),
                page_start: None,
                page_end: None,
                source_type: "chunk".into(),
                entity_kind: None,
                entity_name: None,
                source_confidence: Some(confidence),
                parse_mode: None,
            },
            retrieval_mode: KcRetrievalMode::HybridDense,
            keyword_score: 10.0,
            lexical_score: 10.0,
            dense_score: 10.0,
            fts_score: 1.0,
            rerank_score: 0.4,
            fused_score: 0.4,
            rank: 1,
            relevant_snippet: None,
        }
    }

    #[test]
    fn attaches_whole_small_file() {
        let dir = std::env::temp_dir().join("kc_bundle_test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("small.md");
        let content = "# Title\n\nPresentation layer — React UI\n";
        {
            let mut f = std::fs::File::create(&path).unwrap();
            f.write_all(content.as_bytes()).unwrap();
        }

        let hits = vec![hit(
            0.31,
            "small.md",
            path.to_str().unwrap(),
            "f1",
            "snippet only",
        )];
        let outcome = bundle_hits_for_llm(
            &hits,
            &BundleOptions {
                collection_name: "QA".into(),
                max_whole_file_bytes: MAX_WHOLE_FILE_BYTES,
            },
        );
        assert_eq!(outcome.bundled_count, 1);
        assert!(outcome.context_block.contains("ATTACHED SOURCE FILES"));
        assert!(outcome.context_block.contains("Presentation layer"));
        assert!(outcome.sources[0].text.contains("Presentation layer"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dedupes_multiple_hits_same_file() {
        let dir = std::env::temp_dir().join("kc_bundle_dedupe");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("a.py");
        let content = "import os\n\ndef foo():\n    pass\n";
        std::fs::write(&path, content).unwrap();

        let hits = vec![
            hit(0.25, "a.py", path.to_str().unwrap(), "same", "chunk1"),
            hit(0.40, "a.py", path.to_str().unwrap(), "same", "chunk2"),
        ];
        let outcome = bundle_hits_for_llm(
            &hits,
            &BundleOptions {
                collection_name: "QA".into(),
                max_whole_file_bytes: MAX_WHOLE_FILE_BYTES,
            },
        );
        assert_eq!(outcome.bundled_count, 1);
        assert!(outcome.sources[0].text.contains("import os"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn attaches_excerpt_when_file_too_large() {
        let dir = std::env::temp_dir().join("kc_bundle_large");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("ChatView.tsx");
        let content = "export default function ChatView() {\n  const handleSend = async () => {\n    if (!input.trim()) return;\n  };\n}\n";
        std::fs::write(&path, content.repeat(400)).unwrap();

        let mut hits = vec![hit(
            0.83,
            "ChatView.tsx",
            path.to_str().unwrap(),
            "f-chat",
            "const handleSend = async () => {",
        )];
        hits[0].chunk.context_text = Some(
            "const handleSend = async () => {\n  if (!input.trim()) return;\n  const content = input.trim();\n  setInput('');\n  await invoke('add_message', ...);\n}".to_string(),
        );
        hits[0].chunk.line_start = Some(10);
        hits[0].chunk.line_end = Some(16);

        let outcome = bundle_hits_for_llm(
            &hits,
            &BundleOptions {
                collection_name: "QA".into(),
                max_whole_file_bytes: MAX_WHOLE_FILE_BYTES,
            },
        );
        assert_eq!(outcome.bundled_count, 1);
        assert!(outcome.context_block.contains("Indexed excerpts"));
        assert!(outcome.sources[0].text.contains("handleSend"));
        assert_eq!(outcome.sources[0].source_type, "excerpt");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn excludes_hits_below_bundle_floor() {
        let dir = std::env::temp_dir().join("kc_bundle_floor");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("noise.md");
        std::fs::write(&path, "noise").unwrap();

        let hits = vec![hit(0.12, "noise.md", path.to_str().unwrap(), "n1", "noise")];
        let outcome = bundle_hits_for_llm(
            &hits,
            &BundleOptions {
                collection_name: "QA".into(),
                max_whole_file_bytes: MAX_WHOLE_FILE_BYTES,
            },
        );
        assert_eq!(outcome.bundled_count, 0);
        let _ = std::fs::remove_dir_all(dir);
    }
}
