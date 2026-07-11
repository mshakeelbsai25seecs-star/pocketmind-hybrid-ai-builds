//! Document and code chunking for Knowledge Chat indexing.
//!
//! ## Contract (Rust ports of common OSS chunkers — no Python dependency)
//!
//! - **Code (LanguageParser):** Tree-sitter entity extraction in `code_parser` /
//!   `indexer` is the primary path — equivalent to LlamaIndex `LanguageParser`
//!   (AST-aware function/class bodies stored in `kc_code_entities`).
//! - **Code (CodeSplitter):** [`chunk_code_splitter`] is the LlamaIndex
//!   `CodeSplitter`-style fallback (fixed line windows with overlap) when
//!   Tree-sitter yields no entities.
//! - **Docs (Chonkie):** [`recursive_split_with_offsets`] implements Chonkie OSS
//!   recursive character splitting (paragraph → line → sentence → …) and is used
//!   by [`split_child_slices_with_offsets`] for all non-code documents.

use crate::knowledge_chat::lexical::normalize_chunk_text;

pub struct StructuredChunk {
    pub index: i64,
    pub title: String,
    pub section_path: String,
    pub start_char: i64,
    pub end_char: i64,
    pub line_start: i32,
    pub line_end: i32,
    pub page_start: Option<i32>,
    pub page_end: Option<i32>,
    pub text: String,
    pub parent_text: String,
    pub doc_type: String,
}

const CHILD_TARGET: usize = 900;
const CHILD_OVERLAP: usize = 120;
const PARENT_WINDOW: usize = 2400;
const SEMANTIC_CHILD_TARGET: usize = 1200;
const SEMANTIC_CHILD_OVERLAP: usize = 160;
/// LlamaIndex CodeSplitter-style defaults (line windows with overlap).
const CODE_SPLITTER_LINES: usize = 40;
const CODE_SPLITTER_OVERLAP_LINES: usize = 15;
/// Chonkie-style recursive separators (richest → finest).
const CHONKIE_SEPARATORS: &[&str] = &["\n\n", "\n", ". ", "; ", ", ", " ", ""];

pub struct ChunkIndexOptions {
    pub semantic_chunking: bool,
    pub contextual_indexing: bool,
}

impl Default for ChunkIndexOptions {
    fn default() -> Self {
        Self {
            semantic_chunking: true,
            contextual_indexing: true,
        }
    }
}

pub fn chunk_document_for_index(
    text: &str,
    extension: &str,
    file_name: Option<&str>,
    options: &ChunkIndexOptions,
) -> Vec<StructuredChunk> {
    let (target, overlap) = if options.semantic_chunking {
        (SEMANTIC_CHILD_TARGET, SEMANTIC_CHILD_OVERLAP)
    } else {
        (CHILD_TARGET, CHILD_OVERLAP)
    };
    chunk_document_with_sizes(text, extension, file_name, target, overlap)
}

fn chunk_document_with_sizes(
    text: &str,
    extension: &str,
    file_name: Option<&str>,
    child_target: usize,
    child_overlap: usize,
) -> Vec<StructuredChunk> {
    let normalized = normalize_line_endings(text);
    if normalized.trim().is_empty() {
        return Vec::new();
    }

    let doc_type = infer_doc_type(extension);
    let sections = annotate_section_offsets(&normalized, split_sections(&normalized, extension, file_name));
    let mut out = Vec::new();
    let mut index = 0i64;

    for section in sections {
        let parent_blocks = split_parent_blocks(&section.body, child_target * 2);
        for parent in parent_blocks {
            let parent_text = normalize_chunk_text(&parent);
            let child_slices = split_child_slices_with_offsets(&parent, child_target, child_overlap);
            for (child, rel_start, rel_end) in child_slices {
                let chunk_text = normalize_chunk_text(&child);
                if chunk_text.len() < 40 {
                    continue;
                }
                let abs_start = section.start_char + rel_start;
                let abs_end = section.start_char + rel_end;
                let (title, section_path) =
                    refine_section_labels(&section.title, &section.path, &child);
                out.push(StructuredChunk {
                    index,
                    title,
                    section_path,
                    start_char: abs_start as i64,
                    end_char: abs_end as i64,
                    line_start: line_number_at(&normalized, abs_start),
                    line_end: line_number_at(&normalized, abs_end),
                    page_start: section.page_start,
                    page_end: section.page_end,
                    text: chunk_text,
                    parent_text: parent_text.clone(),
                    doc_type: doc_type.clone(),
                });
                index += 1;
            }
        }
    }

    if out.is_empty() {
        let body = normalize_chunk_text(&normalized);
        let snippet = truncate_chars(&body, child_target);
        let (title, section_path) = refine_section_labels("Document", "Document", &snippet);
        let end = body.chars().count();
        out.push(StructuredChunk {
            index: 0,
            title,
            section_path,
            start_char: 0,
            end_char: end as i64,
            line_start: 1,
            line_end: line_number_at(&normalized, end),
            page_start: None,
            page_end: None,
            text: snippet,
            parent_text: body,
            doc_type: doc_type.clone(),
        });
    }

    out
}

fn normalize_line_endings(text: &str) -> String {
    text.replace('\0', " ").replace('\r', "\n")
}

pub fn chunk_document(text: &str, extension: &str, file_name: Option<&str>) -> Vec<StructuredChunk> {
    chunk_document_with_sizes(text, extension, file_name, CHILD_TARGET, CHILD_OVERLAP)
}

fn refine_section_labels(fallback_title: &str, fallback_path: &str, chunk_text: &str) -> (String, String) {
    let generic = fallback_title == "Document" || fallback_path == "Document";
    if !generic {
        return (fallback_title.to_string(), fallback_path.to_string());
    }
    if let Some(inferred) = infer_label_from_text(chunk_text) {
        return (inferred.clone(), inferred);
    }
    (fallback_title.to_string(), fallback_path.to_string())
}

fn infer_label_from_text(text: &str) -> Option<String> {
    for line in text.lines().take(12) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('#') {
            return Some(truncate_title(trimmed.trim_start_matches('#').trim()));
        }
        if trimmed.len() <= 40 && trimmed.to_ascii_lowercase().starts_with("page ") {
            let rest = trimmed[5..].trim();
            if rest.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                return Some(truncate_title(trimmed));
            }
        }
        if trimmed.len() <= 100 && trimmed.chars().nth(1).map(|c| c == '.').unwrap_or(false) {
            return Some(truncate_title(trimmed));
        }
        if trimmed.len() <= 90
            && trimmed
                .to_ascii_lowercase()
                .split_whitespace()
                .any(|word| matches!(word, "policy" | "policies" | "procedure" | "process" | "termination" | "security" | "filter" | "remediation" | "sharing"))
        {
            return Some(truncate_title(trimmed));
        }
    }
    None
}

struct Section {
    title: String,
    path: String,
    body: String,
}

struct AnnotatedSection {
    title: String,
    path: String,
    body: String,
    start_char: usize,
    page_start: Option<i32>,
    page_end: Option<i32>,
}

pub(crate) fn line_number_at(text: &str, char_offset: usize) -> i32 {
    text.char_indices()
        .take_while(|(idx, _)| *idx < char_offset)
        .filter(|(_, c)| *c == '\n')
        .count() as i32
        + 1
}

fn parse_page_number(label: &str) -> Option<i32> {
    let lower = label.to_ascii_lowercase();
    let rest = lower.strip_prefix("page ")?;
    rest.trim()
        .split_whitespace()
        .next()?
        .parse::<i32>()
        .ok()
        .filter(|value| *value > 0)
}

fn annotate_section_offsets(full: &str, sections: Vec<Section>) -> Vec<AnnotatedSection> {
    let mut cursor = 0usize;
    sections
        .into_iter()
        .map(|section| {
            let needle: String = section.body.chars().take(120).collect();
            let start = if needle.is_empty() {
                cursor
            } else if let Some(pos) = full[cursor..].find(&needle) {
                cursor + pos
            } else if let Some(pos) = full.find(&needle) {
                pos
            } else {
                cursor
            };
            cursor = start.saturating_add(1);
            let page_start = parse_page_number(&section.path)
                .or_else(|| parse_page_number(&section.title));
            AnnotatedSection {
                title: section.title,
                path: section.path,
                body: section.body,
                start_char: start,
                page_start,
                page_end: page_start,
            }
        })
        .collect()
}

fn split_child_slices_with_offsets(
    text: &str,
    target: usize,
    overlap: usize,
) -> Vec<(String, usize, usize)> {
    // Prefer Chonkie-style recursive splitting so docs break on paragraph /
    // sentence boundaries before falling back to character windows.
    let recursive = recursive_split_with_offsets(text, target, overlap, CHONKIE_SEPARATORS);
    if !recursive.is_empty() {
        return recursive;
    }
    char_window_slices_with_offsets(text, target, overlap)
}

/// Chonkie-inspired recursive character splitter: try each separator in order,
/// keep pieces under `target`, and re-split oversized pieces with the next separator.
fn recursive_split_with_offsets(
    text: &str,
    target: usize,
    overlap: usize,
    separators: &[&str],
) -> Vec<(String, usize, usize)> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let char_len = trimmed.chars().count();
    if char_len <= target {
        // Map back to offsets in the original `text` when possible.
        if let Some(rel) = text.find(trimmed) {
            return vec![(trimmed.to_string(), rel, rel + trimmed.len())];
        }
        return vec![(trimmed.to_string(), 0, text.len())];
    }
    if separators.is_empty() {
        return char_window_slices_with_offsets(text, target, overlap);
    }

    let sep = separators[0];
    let rest = &separators[1..];
    if sep.is_empty() {
        return char_window_slices_with_offsets(text, target, overlap);
    }

    let parts: Vec<&str> = text.split(sep).collect();
    if parts.len() <= 1 {
        return recursive_split_with_offsets(text, target, overlap, rest);
    }

    let mut out = Vec::new();
    let mut current = String::new();
    let mut current_start = 0usize;
    let mut cursor = 0usize;

    for (i, part) in parts.iter().enumerate() {
        let part_start = cursor;
        let piece = if i + 1 < parts.len() {
            format!("{part}{sep}")
        } else {
            (*part).to_string()
        };
        cursor += piece.len();

        if piece.chars().count() > target {
            if !current.trim().is_empty() {
                out.push((current.trim().to_string(), current_start, part_start));
                current.clear();
            }
            out.extend(recursive_split_with_offsets(&piece, target, overlap, rest));
            current_start = cursor;
            continue;
        }

        let next_len = current.chars().count() + piece.chars().count();
        if !current.is_empty() && next_len > target {
            out.push((current.trim().to_string(), current_start, part_start));
            // Overlap: keep a tail of the previous block when starting the next.
            let overlap_tail = overlap_tail_chars(&current, overlap);
            current = overlap_tail;
            current_start = part_start.saturating_sub(current.len());
        }
        if current.is_empty() {
            current_start = part_start;
        }
        current.push_str(&piece);
    }
    if !current.trim().is_empty() {
        out.push((current.trim().to_string(), current_start, text.len()));
    }
    out.retain(|(s, _, _)| s.chars().count() >= 40);
    out
}

fn overlap_tail_chars(text: &str, overlap: usize) -> String {
    if overlap == 0 || text.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= overlap {
        return text.to_string();
    }
    chars[chars.len() - overlap..].iter().collect()
}

fn char_window_slices_with_offsets(
    text: &str,
    target: usize,
    overlap: usize,
) -> Vec<(String, usize, usize)> {
    let char_count = text.chars().count();
    if text.is_empty() {
        return Vec::new();
    }
    if char_count <= target {
        return vec![(text.to_string(), 0, text.len())];
    }

    let mut out = Vec::new();
    let mut start_char = 0usize;
    while start_char < char_count {
        let mut end_char = (start_char + target).min(char_count);
        let start_byte = byte_offset_for_char(text, start_char);
        let mut end_byte = byte_offset_for_char(text, end_char);
        if end_char < char_count {
            let preview = &text[start_byte..end_byte];
            if let Some(rel) = preview.rfind(|c| matches!(c, '.' | '!' | '?' | '\n' | ';' | ' ')) {
                let candidate = start_byte + rel + 1;
                let candidate_chars = text[start_byte..candidate].chars().count();
                if candidate_chars > target / 3 {
                    end_byte = candidate;
                    end_char = start_char + candidate_chars;
                }
            }
        }
        let slice = text[start_byte..end_byte].to_string();
        out.push((slice, start_byte, end_byte));
        if end_char >= char_count {
            break;
        }
        start_char = end_char.saturating_sub(overlap);
        if start_char >= end_char {
            start_char = end_char;
        }
    }
    out
}

fn byte_offset_for_char(text: &str, char_idx: usize) -> usize {
    text.char_indices()
        .nth(char_idx)
        .map(|(i, _)| i)
        .unwrap_or(text.len())
}

/// LlamaIndex CodeSplitter-style line windows: fixed line count with overlap.
/// Used as a fallback when Tree-sitter produces no entities, and for tests.
pub fn chunk_code_splitter(
    source: &str,
    extension: &str,
    file_name: Option<&str>,
) -> Vec<StructuredChunk> {
    chunk_code_splitter_with_sizes(
        source,
        extension,
        file_name,
        CODE_SPLITTER_LINES,
        CODE_SPLITTER_OVERLAP_LINES,
    )
}

pub fn chunk_code_splitter_with_sizes(
    source: &str,
    extension: &str,
    file_name: Option<&str>,
    chunk_lines: usize,
    overlap_lines: usize,
) -> Vec<StructuredChunk> {
    let normalized = normalize_line_endings(source);
    let lines: Vec<&str> = normalized.lines().collect();
    if lines.is_empty() {
        return Vec::new();
    }
    let chunk_lines = chunk_lines.max(8);
    let overlap_lines = overlap_lines.min(chunk_lines / 2);
    let doc_type = infer_doc_type(extension);
    let label = file_name.unwrap_or("code");

    let mut out = Vec::new();
    let mut index = 0i64;
    let mut start_line = 0usize;
    while start_line < lines.len() {
        let end_line = (start_line + chunk_lines).min(lines.len());
        let body = lines[start_line..end_line].join("\n");
        let text = normalize_chunk_text(&body);
        if text.chars().count() >= 40 {
            let abs_start = line_byte_offset(&normalized, start_line);
            let abs_end = if end_line >= lines.len() {
                normalized.len()
            } else {
                line_byte_offset(&normalized, end_line)
            };
            let title = lines[start_line]
                .trim()
                .chars()
                .take(72)
                .collect::<String>();
            let title = if title.is_empty() {
                format!("{label} L{}", start_line + 1)
            } else {
                title
            };
            out.push(StructuredChunk {
                index,
                title: title.clone(),
                section_path: format!("Code > {title}"),
                start_char: abs_start as i64,
                end_char: abs_end as i64,
                line_start: (start_line + 1) as i32,
                line_end: end_line as i32,
                page_start: None,
                page_end: None,
                text,
                parent_text: normalize_chunk_text(&body),
                doc_type: doc_type.clone(),
            });
            index += 1;
        }
        if end_line >= lines.len() {
            break;
        }
        let next = end_line.saturating_sub(overlap_lines);
        start_line = if next <= start_line { end_line } else { next };
    }
    out
}

fn line_byte_offset(text: &str, line_idx: usize) -> usize {
    if line_idx == 0 {
        return 0;
    }
    let mut seen = 0usize;
    for (offset, ch) in text.char_indices() {
        if ch == '\n' {
            seen += 1;
            if seen == line_idx {
                return offset + 1;
            }
        }
    }
    text.len()
}

pub(crate) fn is_code_extension(extension: &str) -> bool {
    crate::knowledge_chat::code_languages::is_code_extension(extension)
}

fn is_code_boundary_line(line: &str, extension: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') {
        return false;
    }
    match extension.to_lowercase().as_str() {
        "rs" => trimmed.starts_with("pub fn ")
            || trimmed.starts_with("fn ")
            || trimmed.starts_with("impl ")
            || trimmed.starts_with("pub struct ")
            || trimmed.starts_with("struct ")
            || trimmed.starts_with("pub enum ")
            || trimmed.starts_with("enum ")
            || trimmed.starts_with("pub trait ")
            || trimmed.starts_with("trait "),
        "py" => trimmed.starts_with("def ") || trimmed.starts_with("class ") || trimmed.starts_with("async def "),
        "java" | "kt" | "kts" => trimmed.starts_with("class ")
            || trimmed.starts_with("interface ")
            || trimmed.starts_with("enum ")
            || trimmed.contains('(') && (trimmed.starts_with("public ") || trimmed.starts_with("private ") || trimmed.starts_with("protected ")),
        "go" => trimmed.starts_with("func ") || trimmed.starts_with("type "),
        "cs" => trimmed.starts_with("class ") || trimmed.starts_with("interface ") || trimmed.starts_with("public ") || trimmed.starts_with("private "),
        _ => trimmed.starts_with("export function ")
            || trimmed.starts_with("function ")
            || trimmed.starts_with("export class ")
            || trimmed.starts_with("class ")
            || trimmed.starts_with("export const ")
            || trimmed.starts_with("const ")
            || trimmed.starts_with("export interface ")
            || trimmed.starts_with("interface "),
    }
}

fn split_code_sections(text: &str, extension: &str) -> Vec<Section> {
    let mut sections = Vec::new();
    let mut current_title = "Module".to_string();
    let mut current_path = "Code".to_string();
    let mut buffer = String::new();

    for line in text.lines() {
        if is_code_boundary_line(line, extension) && !buffer.trim().is_empty() {
            sections.push(Section {
                title: current_title.clone(),
                path: current_path.clone(),
                body: buffer.trim().to_string(),
            });
            buffer.clear();
            current_title = truncate_title(line.trim());
            current_path = format!("Code > {current_title}");
        }
        buffer.push_str(line);
        buffer.push('\n');
    }

    if !buffer.trim().is_empty() {
        sections.push(Section {
            title: current_title,
            path: current_path,
            body: buffer.trim().to_string(),
        });
    }

    if sections.is_empty() {
        sections.push(Section {
            title: "Code".to_string(),
            path: "Code".to_string(),
            body: text.to_string(),
        });
    }
    sections
}

fn infer_doc_type(extension: &str) -> String {
    let ext = extension.to_lowercase();
    if is_code_extension(&ext) {
        return "code".to_string();
    }
    match ext.as_str() {
        "md" | "markdown" => "markdown".to_string(),
        "pdf" | "docx" | "pptx" => "document".to_string(),
        "csv" | "xlsx" | "xlsm" => "tabular".to_string(),
        "json" | "yaml" | "yml" | "xml" => "structured".to_string(),
        "log" => "log".to_string(),
        _ => "document".to_string(),
    }
}

fn split_sections(text: &str, extension: &str, file_name: Option<&str>) -> Vec<Section> {
    if is_ocr_export(text, file_name) {
        return split_ocr_markdown_sections(text);
    }
    match extension.to_lowercase().as_str() {
        "md" | "markdown" => split_markdown_sections(text),
        "xml" => split_xml_sections(text),
        "json" => split_json_sections(text),
        "yaml" | "yml" => split_yaml_sections(text),
        "log" | "csv" => split_line_grouped_sections(text, extension),
        ext if is_code_extension(ext) => split_code_sections(text, ext),
        _ => vec![Section {
            title: "Document".to_string(),
            path: "Document".to_string(),
            body: text.to_string(),
        }],
    }
}

fn is_ocr_export(text: &str, file_name: Option<&str>) -> bool {
    if file_name
        .map(|name| name.to_ascii_lowercase().contains("ocr"))
        .unwrap_or(false)
    {
        return true;
    }
    if text.contains("OCR/text extract:") || text.contains("## Page ") || text.contains("# Page ") {
        return true;
    }
    text.lines().any(|line| {
        let trimmed = line.trim();
        trimmed.starts_with("## Page ")
            || trimmed.starts_with("# Page ")
            || (trimmed.len() <= 40
                && trimmed.to_ascii_lowercase().starts_with("page ")
                && trimmed[5..]
                    .trim()
                    .chars()
                    .next()
                    .map(|c| c.is_ascii_digit())
                    .unwrap_or(false))
    })
}

fn page_section_path(title: &str) -> String {
    if title.to_ascii_lowercase().starts_with("page ") {
        title.to_string()
    } else {
        format!("Page > {title}")
    }
}

fn split_ocr_markdown_sections(text: &str) -> Vec<Section> {
    let mut sections = Vec::new();
    let mut current_title = "Overview".to_string();
    let mut current_path = "Overview".to_string();
    let mut buffer = String::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("## Page ") || trimmed.starts_with("# Page ") {
            if !buffer.trim().is_empty() {
                sections.push(Section {
                    title: truncate_title(&current_title),
                    path: current_path.clone(),
                    body: buffer.trim().to_string(),
                });
                buffer.clear();
            }
            current_title = trimmed.trim_start_matches('#').trim().to_string();
            current_path = page_section_path(&current_title);
            continue;
        }
        if trimmed.len() <= 40
            && trimmed.to_ascii_lowercase().starts_with("page ")
            && trimmed[5..]
                .trim()
                .chars()
                .next()
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
        {
            if !buffer.trim().is_empty() {
                sections.push(Section {
                    title: truncate_title(&current_title),
                    path: current_path.clone(),
                    body: buffer.trim().to_string(),
                });
                buffer.clear();
            }
            current_title = trimmed.to_string();
            current_path = page_section_path(&current_title);
            continue;
        }
        if trimmed.starts_with("# OCR/text extract:") {
            current_title = trimmed.trim_start_matches('#').trim().to_string();
            current_path = "Document header".to_string();
            continue;
        }
        buffer.push_str(line);
        buffer.push('\n');
    }

    if !buffer.trim().is_empty() {
        sections.push(Section {
            title: truncate_title(&current_title),
            path: current_path,
            body: buffer.trim().to_string(),
        });
    }

    if sections.is_empty() {
        sections.push(Section {
            title: "Document".to_string(),
            path: "Document".to_string(),
            body: text.to_string(),
        });
    }

    sections
}

pub fn truncate_title(title: &str) -> String {
    let clean = title.replace('\n', " ").trim().to_string();
    if clean.chars().count() <= 120 {
        return clean;
    }
    format!("{}…", clean.chars().take(117).collect::<String>().trim())
}

fn split_xml_sections(text: &str) -> Vec<Section> {
    let markers = [
        "<Rule ",
        "<Rule>",
        "<Parser ",
        "<Parser>",
        "<EventGroup",
        "<Event ",
        "<event ",
        "<pattern",
        "<Pattern",
    ];
    let mut split_at: Vec<usize> = vec![0];
    let lower = text.to_lowercase();
    for marker in markers {
        let mut start = 0usize;
        while let Some(rel) = lower[start..].find(&marker.to_lowercase()) {
            let pos = start + rel;
            if pos > 0 && !split_at.contains(&pos) {
                split_at.push(pos);
            }
            start = pos + marker.len();
        }
    }
    split_at.sort_unstable();
    split_at.dedup();

    if split_at.len() <= 1 {
        return vec![Section {
            title: "XML document".to_string(),
            path: "XML".to_string(),
            body: text.to_string(),
        }];
    }

    let mut sections = Vec::new();
    for window in split_at.windows(2) {
        let body = text[window[0]..window[1]].trim().to_string();
        if body.len() < 40 {
            continue;
        }
        let title = xml_section_title(&body);
        sections.push(Section {
            title: title.clone(),
            path: format!("XML > {title}"),
            body,
        });
    }
    if let Some(&last) = split_at.last() {
        let body = text[last..].trim().to_string();
        if body.len() >= 40 {
            let title = xml_section_title(&body);
            sections.push(Section {
                title: title.clone(),
                path: format!("XML > {title}"),
                body,
            });
        }
    }

    if sections.is_empty() {
        sections.push(Section {
            title: "XML document".to_string(),
            path: "XML".to_string(),
            body: text.to_string(),
        });
    }
    sections
}

fn xml_section_title(body: &str) -> String {
    for line in body.lines().take(6) {
        let trimmed = line.trim();
        if let Some(name) = attribute_value(trimmed, "name") {
            return truncate_title(&name);
        }
        if let Some(id) = attribute_value(trimmed, "id") {
            return truncate_title(&format!("Rule {id}"));
        }
    }
    truncate_title(body.lines().next().unwrap_or("XML block").trim())
}

fn attribute_value(line: &str, key: &str) -> Option<String> {
    let pattern = format!("{key}=\"");
    let start = line.find(&pattern)? + pattern.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn split_json_sections(text: &str) -> Vec<Section> {
    if text.contains("\"steps\"") || text.contains("\"workflow\"") || text.contains("\"playbook\"") {
        return split_json_object_blocks(text, "Playbook");
    }
    if text.contains("\"rules\"") || text.contains("\"correlation\"") {
        return split_json_object_blocks(text, "Rules");
    }
    split_json_object_blocks(text, "JSON")
}

fn split_json_object_blocks(text: &str, label: &str) -> Vec<Section> {
    let mut sections = Vec::new();
    let mut depth = 0i32;
    let mut block_start: Option<usize> = None;
    let chars: Vec<char> = text.chars().collect();

    for (idx, ch) in chars.iter().enumerate() {
        match ch {
            '{' => {
                if depth == 0 {
                    block_start = Some(idx);
                }
                depth += 1;
            }
            '}' => {
                depth -= 1;
                if depth == 0 {
                    if let Some(start) = block_start {
                        let body: String = chars[start..=idx].iter().collect();
                        if body.len() >= 40 {
                            let title = json_block_title(&body, sections.len() + 1);
                            sections.push(Section {
                                title: title.clone(),
                                path: format!("{label} > {title}"),
                                body,
                            });
                        }
                    }
                    block_start = None;
                }
            }
            _ => {}
        }
    }

    if sections.is_empty() {
        sections.push(Section {
            title: label.to_string(),
            path: label.to_string(),
            body: text.to_string(),
        });
    }
    sections
}

fn json_block_title(body: &str, index: usize) -> String {
    for key in ["name", "stepName", "title", "id", "label"] {
        if let Some(value) = json_string_value(body, key) {
            return truncate_title(&value);
        }
    }
    truncate_title(&format!("Block {index}"))
}

fn json_string_value(body: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{key}\"");
    let start = body.find(&pattern)? + pattern.len();
    let rest = body[start..].trim_start();
    if !rest.starts_with(':') {
        return None;
    }
    let rest = rest[1..].trim_start();
    if !rest.starts_with('"') {
        return None;
    }
    let inner = &rest[1..];
    let end = inner.find('"')?;
    Some(inner[..end].to_string())
}

fn split_yaml_sections(text: &str) -> Vec<Section> {
    if text.contains("\n---\n") {
        return text
            .split("\n---\n")
            .enumerate()
            .filter_map(|(idx, block)| {
                let body = block.trim().to_string();
                if body.len() < 40 {
                    return None;
                }
                let title = yaml_section_title(&body, idx + 1);
                Some(Section {
                    title: title.clone(),
                    path: format!("YAML > {title}"),
                    body,
                })
            })
            .collect();
    }

    let mut sections = Vec::new();
    let mut current_title = "YAML document".to_string();
    let mut current_path = current_title.clone();
    let mut buffer = String::new();

    for line in text.lines() {
        let is_top_level_key = !line.starts_with(' ') && !line.starts_with('\t') && line.contains(':') && !line.trim().starts_with('#');
        if is_top_level_key && !buffer.trim().is_empty() {
            sections.push(Section {
                title: current_title.clone(),
                path: current_path.clone(),
                body: buffer.trim().to_string(),
            });
            buffer.clear();
            current_title = truncate_title(line.split(':').next().unwrap_or("Section").trim());
            current_path = format!("YAML > {current_title}");
        }
        buffer.push_str(line);
        buffer.push('\n');
    }

    if !buffer.trim().is_empty() {
        sections.push(Section {
            title: current_title,
            path: current_path,
            body: buffer.trim().to_string(),
        });
    }

    if sections.is_empty() {
        sections.push(Section {
            title: "YAML document".to_string(),
            path: "YAML".to_string(),
            body: text.to_string(),
        });
    }
    sections
}

fn yaml_section_title(body: &str, index: usize) -> String {
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((key, _)) = trimmed.split_once(':') {
            return truncate_title(key.trim());
        }
    }
    truncate_title(&format!("Section {index}"))
}

fn split_line_grouped_sections(text: &str, extension: &str) -> Vec<Section> {
    let lines: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    if lines.is_empty() {
        return vec![Section {
            title: "Document".to_string(),
            path: "Document".to_string(),
            body: text.to_string(),
        }];
    }

    let group_size = if extension == "csv" { 32 } else { 48 };
    let header = if extension == "csv" { lines.first().copied() } else { None };
    let data_lines: Vec<&str> = if header.is_some() {
        lines.iter().copied().skip(1).collect()
    } else {
        lines.clone()
    };

    let mut sections = Vec::new();
    for (group_idx, chunk_lines) in data_lines.chunks(group_size).enumerate() {
        let mut body = String::new();
        if let Some(header_line) = header {
            body.push_str(header_line);
            body.push('\n');
        }
        for line in chunk_lines {
            body.push_str(line);
            body.push('\n');
        }
        let title = if extension == "csv" {
            format!("Rows {}-{}", group_idx * group_size + 1, group_idx * group_size + chunk_lines.len())
        } else {
            format!("Log lines {}-{}", group_idx * group_size + 1, group_idx * group_size + chunk_lines.len())
        };
        sections.push(Section {
            title: truncate_title(&title),
            path: format!("{} > {}", extension.to_uppercase(), title),
            body: body.trim().to_string(),
        });
    }

    sections
}

fn split_markdown_sections(text: &str) -> Vec<Section> {
    let mut sections = Vec::new();
    let mut current_title = "Introduction".to_string();
    let mut current_path = current_title.clone();
    let mut buffer = String::new();

    for line in text.lines() {
        if let Some(level) = heading_level(line) {
            if !buffer.trim().is_empty() {
                sections.push(Section {
                    title: current_title.clone(),
                    path: current_path.clone(),
                    body: buffer.trim().to_string(),
                });
                buffer.clear();
            }
            current_title = line.trim_start_matches('#').trim().to_string();
            current_path = current_title.clone();
        }
        buffer.push_str(line);
        buffer.push('\n');
    }

    if !buffer.trim().is_empty() {
        sections.push(Section {
            title: current_title,
            path: current_path,
            body: buffer.trim().to_string(),
        });
    }

    if sections.is_empty() {
        sections.push(Section {
            title: "Document".to_string(),
            path: "Document".to_string(),
            body: text.to_string(),
        });
    }
    sections
}

fn heading_level(line: &str) -> Option<usize> {
    let trimmed = line.trim();
    if !trimmed.starts_with('#') {
        return None;
    }
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    if trimmed.len() <= hashes {
        return None;
    }
    Some(hashes)
}

fn split_parent_blocks(text: &str, target: usize) -> Vec<String> {
    let paragraphs: Vec<&str> = text.split("\n\n").filter(|p| !p.trim().is_empty()).collect();
    if paragraphs.is_empty() {
        return vec![text.to_string()];
    }

    let mut blocks = Vec::new();
    let mut current = String::new();
    for paragraph in paragraphs {
        if current.chars().count() + paragraph.chars().count() + 2 > target && !current.is_empty() {
            blocks.push(current.trim().to_string());
            current.clear();
        }
        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(paragraph);
    }
    if !current.trim().is_empty() {
        blocks.push(current.trim().to_string());
    }
    blocks
}

fn split_child_slices(text: &str, target: usize, overlap: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= target {
        return vec![text.trim().to_string()];
    }
    let mut slices = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let mut end = (start + target).min(chars.len());
        if end < chars.len() {
            let slice_preview: String = chars[start..end].iter().collect();
            if let Some(rel) = slice_preview.rfind(|ch: char| ch.is_whitespace() || ch == '.' || ch == ';') {
                let byte_len = slice_preview[..=rel].chars().count();
                if byte_len > target / 2 {
                    end = start + byte_len;
                }
            }
        }
        let slice: String = chars[start..end].iter().collect();
        let trimmed = slice.trim().to_string();
        if !trimmed.is_empty() {
            slices.push(trimmed);
        }
        if end >= chars.len() {
            break;
        }
        let next_start = end.saturating_sub(overlap);
        start = if next_start <= start { end } else { next_start };
    }
    slices
}

fn truncate_chars(text: &str, max: usize) -> String {
    let chars: String = text.chars().take(max).collect();
    chars.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_sections_create_multiple_chunks() {
        let md = "# Title\n\nIntro paragraph with enough text to pass minimum length requirements here.\n\n## Section\n\nMore detailed content that should become its own chunk with parent context preserved.";
        let chunks = chunk_document(md, "md", None);
        assert!(chunks.len() >= 2);
    }

    #[test]
    fn ocr_filename_splits_by_page_markers() {
        let text = "Overview section with enough text to pass minimum chunk length requirements for indexing.\n\nPage 2\n\nTermination Process details with enough text to pass minimum chunk length requirements for indexing.\n\nPage 3\n\nSecurity filter policy details with enough text to pass minimum chunk length requirements for indexing.";
        let chunks = chunk_document(text, "txt", Some("Policies-OCR.md"));
        assert!(chunks.len() >= 2);
        assert!(chunks.iter().any(|chunk| chunk.title.contains("Page") || chunk.title.contains("Termination")));
    }

    #[test]
    fn xml_splits_rule_blocks() {
        let xml = r#"<RuleGroup><Rule id="1" name="VPN Brute Force"><pattern>failed-login</pattern><description>Detect repeated VPN failures followed by success within 15 minutes for escalation to SOC tier 2.</description></Rule><Rule id="2" name="Data Exfil"><pattern>large upload</pattern><description>Detect unusual outbound transfer volume exceeding baseline thresholds for investigation.</description></Rule></RuleGroup>"#;
        let chunks = chunk_document(xml, "xml", Some("rules.xml"));
        assert!(chunks.len() >= 2);
        assert!(chunks.iter().any(|c| c.title.to_lowercase().contains("vpn")));
    }

    #[test]
    fn code_splits_on_function_boundaries() {
        let source = "import x\n\nexport function alpha() {\n  return 'alpha value with enough text for chunking minimums';\n}\n\nexport function beta() {\n  return 'beta value with enough text for chunking minimums';\n}\n";
        let chunks = chunk_document(source, "ts", Some("api.ts"));
        assert!(chunks.len() >= 2);
        assert!(chunks.iter().any(|c| c.title.contains("alpha")));
        assert!(chunks.iter().any(|c| c.line_start > 0));
    }

    #[test]
    fn log_groups_lines() {
        let log = (0..60)
            .map(|i| format!("2026-06-10T18:{i:02}:00Z device=FGT-DEMO type=vpn event.action=failed-login user=demo{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let chunks = chunk_document(&log, "log", Some("vpn.log"));
        assert!(chunks.len() >= 2);
    }

    #[test]
    fn code_extensions_infer_code_doc_type() {
        for ext in ["kt", "php", "sql", "css", "rs", "py", "ts"] {
            assert_eq!(infer_doc_type(ext), "code", "ext={ext}");
        }
        assert_eq!(infer_doc_type("md"), "markdown");
        assert_eq!(infer_doc_type("pdf"), "document");
        assert_eq!(infer_doc_type("log"), "log");
    }

    #[test]
    fn code_splitter_uses_overlapping_line_windows() {
        let source: String = (0..100)
            .map(|i| format!("line_{i:03} const value = {i}; // padding for minimum length"))
            .collect::<Vec<_>>()
            .join("\n");
        let chunks = chunk_code_splitter_with_sizes(&source, "ts", Some("big.ts"), 40, 15);
        assert!(chunks.len() >= 3);
        assert_eq!(chunks[0].line_start, 1);
        assert!(chunks[0].line_end <= 40);
        assert!(chunks[1].line_start < chunks[0].line_end);
    }

    #[test]
    fn chonkie_recursive_prefers_paragraph_breaks() {
        let text = "Paragraph one has enough characters to clear the minimum length gate for indexing purposes.\n\nParagraph two also has enough characters to clear the minimum length gate for indexing purposes.\n\nParagraph three continues with enough characters to clear the minimum length gate for indexing.";
        let slices = recursive_split_with_offsets(text, 120, 20, CHONKIE_SEPARATORS);
        assert!(slices.len() >= 2);
        assert!(slices.iter().any(|(s, _, _)| s.contains("Paragraph one")));
        assert!(slices.iter().any(|(s, _, _)| s.contains("Paragraph two")));
    }
}
