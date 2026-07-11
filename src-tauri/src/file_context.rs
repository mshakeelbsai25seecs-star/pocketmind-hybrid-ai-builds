use crate::error::{AppError, AppResult};
use crate::knowledge_chat::types::KC_MAX_FILE_BYTES;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct AttachmentChunk {
    pub index: usize,
    pub title: String,
    pub start_char: usize,
    pub end_char: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AttachmentContext {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size_bytes: u64,
    /// Small preview kept for backward compatibility and UI display.
    /// The full attachment is indexed into `chunks`; the frontend sends only
    /// the most relevant chunks to the model for each question.
    pub text: String,
    pub warnings: Vec<String>,
    pub chunk_count: usize,
    pub indexed_chars: usize,
    pub chunks: Vec<AttachmentChunk>,
}

const DEFAULT_MAX_CHARS_PER_FILE: usize = 120_000;
const DEFAULT_MAX_TOTAL_CHARS: usize = 240_000;
const CHUNK_TARGET_CHARS: usize = 1_450;
const CHUNK_HARD_LIMIT_CHARS: usize = 1_950;
const CHUNK_OVERLAP_CHARS: usize = 150;
const PREVIEW_CHARS: usize = 3_200;

pub fn process_files(
    paths: Vec<String>,
    max_chars_per_file: Option<usize>,
    max_total_chars: Option<usize>,
) -> AppResult<Vec<AttachmentContext>> {
    let per_file = max_chars_per_file.unwrap_or(DEFAULT_MAX_CHARS_PER_FILE).clamp(8_000, 250_000);
    let max_total = max_total_chars.unwrap_or(DEFAULT_MAX_TOTAL_CHARS).clamp(12_000, 500_000);
    let mut used = 0usize;
    let mut out = Vec::new();

    for raw in paths {
        if used >= max_total { break; }
        let path = PathBuf::from(&raw);
        let remaining = max_total.saturating_sub(used);
        if remaining < 1_000 { break; }
        let limit_for_file = per_file.min(remaining);
        let mut ctx = process_one(&path, limit_for_file)?;
        used = used.saturating_add(ctx.indexed_chars);
        if used >= max_total {
            ctx.warnings.push("App-wide attachment index limit reached. Further files may need to be attached separately for best speed.".to_string());
        }
        out.push(ctx);
    }

    Ok(out)
}

fn process_one(path: &Path, per_file_limit: usize) -> AppResult<AttachmentContext> {
    if !path.exists() {
        return Err(AppError::MissingFile(path.display().to_string()));
    }
    if !path.is_file() {
        return Err(AppError::Unknown(format!("Attachment is not a file: {}", path.display())));
    }
    let meta = std::fs::metadata(path)?;
    if meta.len() > KC_MAX_FILE_BYTES {
        return Err(AppError::Unknown(format!(
            "File is too large for local attachment indexing: {} ({:.2} MB). Limit: {:.0} MB",
            path.display(),
            meta.len() as f64 / 1_048_576.0,
            KC_MAX_FILE_BYTES as f64 / 1_048_576.0
        )));
    }

    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("attachment").to_string();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let mut warnings = Vec::new();

    let (kind, raw_text) = match ext.as_str() {
        "txt" | "md" | "markdown" | "csv" | "json" | "jsonl" | "xml" | "html" | "htm" | "log" |
        "rs" | "py" | "js" | "jsx" | "ts" | "tsx" | "java" | "kt" | "kts" | "cpp" | "c" | "h" |
        "hpp" | "cs" | "go" | "rb" | "php" | "sql" | "yaml" | "yml" | "toml" | "ini" | "css" => {
            (format!("text/{ext}"), read_text_lossy(path)?)
        }
        "docx" => {
            warnings.push("DOCX text is extracted locally from word/document.xml. Complex formatting, comments, and embedded images may not be represented.".to_string());
            ("docx".to_string(), extract_docx_text(path)?)
        }
        "pptx" => {
            warnings.push("PPTX text is extracted locally from slide XML. Speaker notes, charts, and embedded images may be incomplete.".to_string());
            ("pptx".to_string(), extract_pptx_text(path)?)
        }
        "xlsx" | "xlsm" => {
            warnings.push("Spreadsheet extraction is lightweight and focuses on shared strings/sheet XML text. Formulas and formatting are not fully evaluated.".to_string());
            ("spreadsheet".to_string(), extract_xlsx_text(path)?)
        }
        "pdf" => {
            let (pdf_text, pdf_warnings) = extract_pdf_enhanced(path)?;
            warnings.extend(pdf_warnings);
            ("pdf".to_string(), pdf_text)
        }
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif" | "tiff" => {
            warnings.push("Image attachment is processed offline as metadata only in this phase. True image understanding/OCR requires a vision/OCR backend.".to_string());
            ("image".to_string(), image_summary(path)?)
        }
        _ => {
            warnings.push(format!("Unsupported or unknown extension '.{}'. NexusAI included basic metadata only.", ext));
            ("unknown".to_string(), format!("File attached: {}\nSize: {} bytes\nNo text extractor is available for this file type yet.", name, meta.len()))
        }
    };

    let raw_text = if matches!(ext.as_str(), "html" | "htm") {
        strip_html_tags(&raw_text)
    } else {
        raw_text
    };

    let preserve_layout = should_preserve_layout(&ext);
    let mut cleaned = if preserve_layout {
        clean_text_preserve_layout(&raw_text)
    } else {
        clean_document_text(&raw_text)
    };

    if cleaned.trim().is_empty() {
        warnings.push("No extractable text was found.".to_string());
        cleaned = format!("No extractable text found in {}.", name);
    }

    let original_chars = cleaned.chars().count();
    let mut indexed_text = cleaned;
    if original_chars > per_file_limit {
        indexed_text = truncate_chars(&indexed_text, per_file_limit);
        warnings.push(format!(
            "Large document indexed with a safe local limit: {} of {} characters are available for retrieval.",
            per_file_limit, original_chars
        ));
    }

    let chunks = chunk_text(&indexed_text);
    let chunk_count = chunks.len();
    let indexed_chars = indexed_text.chars().count();
    if chunk_count > 1 {
        warnings.push(format!(
            "Indexed into {} searchable section(s). For speed, NexusAI sends only the most relevant sections to the model for each question.",
            chunk_count
        ));
    }

    let text = build_preview(&indexed_text, PREVIEW_CHARS, chunk_count, indexed_chars);

    Ok(AttachmentContext {
        path: path.to_string_lossy().to_string(),
        name,
        kind,
        size_bytes: meta.len(),
        text,
        warnings,
        chunk_count,
        indexed_chars,
        chunks,
    })
}

fn should_preserve_layout(ext: &str) -> bool {
    matches!(ext,
        "txt" | "md" | "markdown" | "csv" | "json" | "jsonl" | "xml" | "html" | "htm" | "log" |
        "rs" | "py" | "js" | "jsx" | "ts" | "tsx" | "java" | "kt" | "kts" | "cpp" | "c" | "h" |
        "hpp" | "cs" | "go" | "rb" | "php" | "sql" | "yaml" | "yml" | "toml" | "ini" | "css"
    )
}

fn read_text_lossy(path: &Path) -> AppResult<String> {
    let bytes = std::fs::read(path)?;
    Ok(decode_text_bytes(&bytes))
}

fn decode_text_bytes(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).to_string();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    bytes.iter().map(|byte| *byte as char).collect()
}

fn strip_html_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars { return s.to_string(); }
    let mut out: String = s.chars().take(max_chars).collect();
    out.push_str("\n\n[...truncated by NexusAI attachment index limit...]\n");
    out
}

fn build_preview(indexed_text: &str, max_chars: usize, chunk_count: usize, indexed_chars: usize) -> String {
    let mut preview: String = indexed_text.chars().take(max_chars).collect();
    if indexed_text.chars().count() > max_chars {
        preview.push_str("\n\n[Preview only. Full available attachment text is indexed into searchable sections.]\n");
    }
    format!(
        "Indexed attachment preview\nSections: {}\nIndexed characters: {}\n\n{}",
        chunk_count,
        indexed_chars,
        preview.trim()
    )
}


fn strip_problematic_control_chars(input: &str) -> String {
    input
        .chars()
        .map(|c| {
            if c == '\n' || c == '\r' || c == '\t' {
                c
            } else if c.is_control() {
                ' '
            } else {
                c
            }
        })
        .collect()
}

fn clean_text_preserve_layout(input: &str) -> String {
    let text = strip_problematic_control_chars(input).replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::new();
    let mut blank_count = 0usize;
    for raw_line in text.lines() {
        let line = raw_line.trim_end();
        if line.trim().is_empty() {
            blank_count += 1;
            if blank_count <= 2 { out.push('\n'); }
        } else {
            blank_count = 0;
            out.push_str(line);
            out.push('\n');
        }
    }
    out.trim().to_string()
}

fn clean_document_text(input: &str) -> String {
    let stripped = strip_problematic_control_chars(input);
    let text = stripped
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace("-\n", "");

    let mut line_counts = BTreeMap::<String, usize>::new();
    for raw in text.lines() {
        let line = normalize_line_ws(raw);
        if is_probable_repeated_header_footer(&line) {
            *line_counts.entry(line.to_lowercase()).or_default() += 1;
        }
    }

    let mut out = String::new();
    let mut previous_blank = false;
    for raw in text.lines() {
        let line = normalize_line_ws(raw);
        if line.is_empty() {
            if !previous_blank {
                out.push('\n');
                previous_blank = true;
            }
            continue;
        }
        if is_page_marker(&line) { continue; }
        if is_probable_repeated_header_footer(&line) && line_counts.get(&line.to_lowercase()).copied().unwrap_or(0) > 3 {
            continue;
        }
        previous_blank = false;
        out.push_str(&line);
        out.push('\n');
    }

    out.trim().to_string()
}

fn normalize_line_ws(s: &str) -> String {
    let mut out = String::new();
    let mut last_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !last_space { out.push(' '); }
            last_space = true;
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out.trim().to_string()
}

fn is_page_marker(line: &str) -> bool {
    let lower = line.to_lowercase();
    if lower.starts_with("page ") && lower.len() <= 32 { return true; }
    if lower.contains(" page ") && lower.len() <= 40 { return true; }
    if lower.starts_with("p. ") && lower.len() <= 16 { return true; }
    if lower.starts_with("pg. ") && lower.len() <= 16 { return true; }
    !line.is_empty() && line.len() <= 8 && line.chars().all(|c| c.is_ascii_digit() || c == '-' || c == '/')
}

fn is_probable_repeated_header_footer(line: &str) -> bool {
    if line.len() < 4 || line.len() > 90 { return false; }
    if line.contains('.') && line.split_whitespace().count() > 10 { return false; }
    true
}

fn chunk_text(text: &str) -> Vec<AttachmentChunk> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_start = 0usize;
    let mut cursor = 0usize;

    for para in text.split("\n\n") {
        let para = para.trim();
        if para.is_empty() {
            cursor = cursor.saturating_add(2);
            continue;
        }

        if para.chars().count() > CHUNK_HARD_LIMIT_CHARS {
            if !current.trim().is_empty() {
                push_chunk(&mut chunks, &current, current_start, cursor);
                current.clear();
            }
            for segment in split_long_text(para, CHUNK_TARGET_CHARS) {
                let seg_chars = segment.chars().count();
                push_chunk(&mut chunks, &segment, cursor, cursor.saturating_add(seg_chars));
                cursor = cursor.saturating_add(seg_chars);
            }
            continue;
        }

        let para_chars = para.chars().count();
        let current_chars = current.chars().count();
        if !current.is_empty() && current_chars + para_chars + 2 > CHUNK_TARGET_CHARS {
            push_chunk(&mut chunks, &current, current_start, cursor);
            let overlap = overlap_tail(&current, CHUNK_OVERLAP_CHARS);
            current_start = cursor.saturating_sub(overlap.chars().count());
            current = overlap;
        }
        if !current.is_empty() { current.push_str("\n\n"); }
        current.push_str(para);
        cursor = cursor.saturating_add(para_chars + 2);
    }

    if !current.trim().is_empty() {
        push_chunk(&mut chunks, &current, current_start, cursor);
    }

    if chunks.is_empty() && !text.trim().is_empty() {
        push_chunk(&mut chunks, text.trim(), 0, text.chars().count());
    }

    chunks
}

fn split_long_text(text: &str, target: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let mut end = (start + target).min(chars.len());
        if end < chars.len() {
            let min_end = (start + target / 2).min(chars.len());
            for i in (min_end..end).rev() {
                if chars[i].is_whitespace() {
                    end = i + 1;
                    break;
                }
            }
        }
        let segment: String = chars[start..end].iter().collect::<String>().trim().to_string();
        if !segment.is_empty() { out.push(segment); }
        start = end;
    }
    out
}

fn push_chunk(chunks: &mut Vec<AttachmentChunk>, text: &str, start_char: usize, end_char: usize) {
    let clean = text.trim();
    if clean.is_empty() { return; }
    let index = chunks.len();
    let title = chunk_title(clean, index + 1);
    chunks.push(AttachmentChunk {
        index,
        title,
        start_char,
        end_char,
        text: clean.to_string(),
    });
}

fn chunk_title(text: &str, section_number: usize) -> String {
    for line in text.lines() {
        let candidate = line.trim();
        if candidate.len() >= 4 {
            let mut title: String = candidate.chars().take(82).collect();
            if candidate.chars().count() > 82 { title.push('…'); }
            return title;
        }
    }
    format!("Section {}", section_number)
}

fn extract_docx_text(path: &Path) -> AppResult<String> {
    let xml = read_zip_text(path, "word/document.xml")?;
    Ok(xml_to_text(&xml))
}

fn extract_pptx_text(path: &Path) -> AppResult<String> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| AppError::Unknown(e.to_string()))?;
    let mut slides = Vec::new();
    for i in 0..archive.len() {
        let name = archive.by_index(i).map_err(|e| AppError::Unknown(e.to_string()))?.name().to_string();
        if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
            slides.push(name);
        }
    }
    slides.sort();
    let mut out = String::new();
    for slide in slides.into_iter().take(80) {
        let mut f = archive.by_name(&slide).map_err(|e| AppError::Unknown(e.to_string()))?;
        let mut xml = String::new();
        f.read_to_string(&mut xml).map_err(|e| AppError::Unknown(e.to_string()))?;
        out.push_str(&format!("\n--- {} ---\n{}\n", slide, xml_to_text(&xml)));
    }
    Ok(out)
}

fn extract_xlsx_text(path: &Path) -> AppResult<String> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| AppError::Unknown(e.to_string()))?;
    let mut out = String::new();
    if let Ok(mut f) = archive.by_name("xl/sharedStrings.xml") {
        let mut xml = String::new();
        f.read_to_string(&mut xml).map_err(|e| AppError::Unknown(e.to_string()))?;
        out.push_str("--- Shared strings ---\n");
        out.push_str(&xml_to_text(&xml));
        out.push('\n');
    }
    let mut sheets = Vec::new();
    for i in 0..archive.len() {
        let name = archive.by_index(i).map_err(|e| AppError::Unknown(e.to_string()))?.name().to_string();
        if name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml") {
            sheets.push(name);
        }
    }
    sheets.sort();
    for sheet in sheets.into_iter().take(20) {
        let mut f = archive.by_name(&sheet).map_err(|e| AppError::Unknown(e.to_string()))?;
        let mut xml = String::new();
        f.read_to_string(&mut xml).map_err(|e| AppError::Unknown(e.to_string()))?;
        out.push_str(&format!("\n--- {} ---\n{}\n", sheet, xml_to_text(&xml)));
    }
    Ok(out)
}

fn read_zip_text(path: &Path, inner: &str) -> AppResult<String> {
    let file = File::open(path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| AppError::Unknown(e.to_string()))?;
    let mut f = archive.by_name(inner).map_err(|e| AppError::Unknown(e.to_string()))?;
    let mut xml = String::new();
    f.read_to_string(&mut xml).map_err(|e| AppError::Unknown(e.to_string()))?;
    Ok(xml)
}

fn xml_to_text(xml: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in xml.chars() {
        match c {
            '<' => { in_tag = true; out.push(' '); }
            '>' => { in_tag = false; out.push(' '); }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let decoded = out
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'");
    clean_document_text(&decoded)
}

fn normalize_ws(s: &str) -> String {
    let mut out = String::new();
    let mut last_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !last_space { out.push(' '); }
            last_space = true;
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out.trim().to_string()
}

fn overlap_tail(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() || max_chars == 0 {
        return String::new();
    }
    let tail: String = trimmed.chars().rev().take(max_chars).collect::<Vec<_>>().into_iter().rev().collect();
    if tail.is_empty() {
        return String::new();
    }
    format!("[...continued...]\n{tail}")
}

fn meaningful_pdf_text(text: &str) -> bool {
    text.chars().filter(|c| c.is_alphabetic()).count() >= 120
}

pub fn extract_pdf_enhanced(path: &Path) -> AppResult<(String, Vec<String>)> {
    let mut warnings = Vec::new();

    match pdf_extract::extract_text(path) {
        Ok(text) if meaningful_pdf_text(&text) => {
            warnings.push("PDF text extracted with structured parser.".to_string());
            return Ok((text, warnings));
        }
        Ok(_) => warnings.push("PDF text layer was sparse. Scanned pages may need OCR.".to_string()),
        Err(err) => warnings.push(format!("Structured PDF parser could not read all streams: {err}")),
    }

    let basic = extract_pdf_basic(path)?;
    if meaningful_pdf_text(&basic) {
        warnings.push("PDF text recovered with basic stream parser.".to_string());
        return Ok((basic, warnings));
    }

    warnings.push(
        "PDF appears image/scanned with little extractable text. Use OCR PDF in SOC Knowledge Base for full indexing.".to_string(),
    );
    Ok((basic, warnings))
}

fn extract_pdf_basic(path: &Path) -> AppResult<String> {
    let bytes = std::fs::read(path)?;
    let raw = String::from_utf8_lossy(&bytes);
    let mut texts = Vec::new();
    let mut current = String::new();
    let mut in_paren = false;
    let mut escape = false;
    for c in raw.chars() {
        if in_paren {
            if escape {
                match c {
                    'n' => current.push('\n'),
                    'r' => current.push('\r'),
                    't' => current.push('\t'),
                    _ => current.push(c),
                }
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == ')' {
                let t = normalize_ws(&current);
                if t.len() > 2 && t.chars().any(|ch| ch.is_alphabetic()) {
                    texts.push(t);
                }
                current.clear();
                in_paren = false;
            } else {
                current.push(c);
            }
        } else if c == '(' {
            in_paren = true;
            current.clear();
        }
    }
    if texts.is_empty() {
        Ok("No text was extracted by the basic PDF reader. This may be a scanned PDF, encrypted PDF, or a compressed text stream.".to_string())
    } else {
        Ok(texts.join("\n"))
    }
}

fn image_summary(path: &Path) -> AppResult<String> {
    let reader = image::io::Reader::open(path).map_err(|e| AppError::Unknown(e.to_string()))?;
    let format = reader.format().map(|f| format!("{:?}", f)).unwrap_or_else(|| "unknown".to_string());
    let img = reader.decode().map_err(|e| AppError::Unknown(e.to_string()))?;
    Ok(format!(
        "Image attached: {}\nFormat: {}\nDimensions: {} x {} pixels\nColor type: {:?}\nNote: visual understanding/OCR is not enabled in this phase; only metadata is available to the chat model.",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("image"),
        format,
        img.width(),
        img.height(),
        img.color()
    ))
}
