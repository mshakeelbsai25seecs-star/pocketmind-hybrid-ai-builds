//! Index-time enrichment: table/figure tagging and optional OCR repair helpers.

/// Wrap markdown tables / figure-like blocks for retrieval when caption_figures is on.
/// Offline-only: uses nearby headings as captions (no network, no LLM required).
pub fn enrich_tables_and_figures(text: &str) -> String {
    if text.trim().is_empty() {
        return String::new();
    }
    // Idempotent: already enriched.
    if text.contains("<table>") || text.contains("<figure>") {
        return text.to_string();
    }
    let mut out = Vec::new();
    let mut lines = text.lines().peekable();
    let mut last_heading = String::new();
    let mut table_idx = 0usize;
    let mut figure_idx = 0usize;

    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            last_heading = trimmed.trim_start_matches('#').trim().chars().take(120).collect();
            out.push(line.to_string());
            continue;
        }

        if looks_like_figure_placeholder(trimmed) {
            figure_idx += 1;
            let caption = if last_heading.is_empty() {
                format!("Figure {figure_idx}")
            } else {
                last_heading.clone()
            };
            out.push(format!("<figure> [{caption}]"));
            out.push(line.to_string());
            out.push("</figure>".to_string());
            continue;
        }

        if is_md_table_line(trimmed) {
            let mut block = vec![line.to_string()];
            while let Some(next) = lines.peek() {
                let nt = next.trim();
                if is_md_table_line(nt) {
                    block.push(lines.next().unwrap().to_string());
                    if block.len() > 500 {
                        break; // pathological table — keep what we have
                    }
                } else if nt.is_empty() && block.len() > 1 {
                    let _ = lines.next(); // consume blank after table
                    break;
                } else {
                    break;
                }
            }
            table_idx += 1;
            let caption = if last_heading.is_empty() {
                format!("Table {table_idx}")
            } else {
                last_heading.clone()
            };
            out.push(format!("<table> [{caption}]"));
            out.extend(block);
            out.push("</table>".to_string());
            continue;
        }

        out.push(line.to_string());
    }

    out.join("\n")
}

fn is_md_table_line(line: &str) -> bool {
    let t = line.trim();
    t.starts_with('|') && t.matches('|').count() >= 2
}

fn looks_like_figure_placeholder(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    // Avoid tagging every prose sentence that mentions "figure".
    if lower.contains("![") || lower.contains("[image]") || lower.contains("<!-- image") {
        return true;
    }
    let short = line.chars().count() <= 80;
    short
        && (lower.starts_with("figure ")
            || lower.starts_with("fig.")
            || lower.starts_with("fig "))
}

/// Optional stronger OCR repair when `ocr.llm_repair` is enabled.
/// Preserves page headers and table pipe structure; falls back to unrepaired on failure.
pub fn apply_optional_ocr_repair(raw: &str, enabled: bool) -> (String, bool) {
    if !enabled || raw.trim().is_empty() {
        return (raw.to_string(), false);
    }
    // Never run aggressive merge on Docling / table-heavy text.
    if raw.contains("Engine: docling") || raw.matches('|').count() >= 12 {
        return (raw.to_string(), false);
    }
    let repaired = crate::knowledge_chat::ocr_repair::repair_ocr_markdown(raw);
    let repaired = merge_split_ocr_tokens_linewise(&repaired);
    if !repair_acceptable(raw, &repaired) {
        return (raw.to_string(), false);
    }
    (repaired, true)
}

fn merge_split_ocr_tokens_linewise(text: &str) -> String {
    text.lines()
        .map(|line| {
            if is_md_table_line(line) || line.contains('|') {
                line.to_string()
            } else {
                merge_split_ocr_tokens(line)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn merge_split_ocr_tokens(text: &str) -> String {
    // Conservative: join letter-letter splits like "docu ment" → "document" when both parts short.
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == ' '
            && i > 0
            && i + 1 < chars.len()
            && chars[i - 1].is_ascii_alphabetic()
            && chars[i + 1].is_ascii_alphabetic()
        {
            let mut left = i;
            while left > 0 && chars[left - 1].is_ascii_alphabetic() {
                left -= 1;
            }
            let mut right = i + 1;
            while right < chars.len() && chars[right].is_ascii_alphabetic() {
                right += 1;
            }
            let left_len = i - left;
            let right_len = right - (i + 1);
            if left_len >= 2 && left_len <= 4 && right_len >= 2 && right_len <= 6 {
                i += 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

pub(crate) fn repair_acceptable(raw: &str, repaired: &str) -> bool {
    if repaired.trim().is_empty() {
        return false;
    }
    let raw_pages = raw.matches("## Page ").count();
    let new_pages = repaired.matches("## Page ").count();
    if raw_pages > 0 && new_pages < raw_pages {
        return false;
    }
    let raw_pipes = raw.matches('|').count();
    let new_pipes = repaired.matches('|').count();
    if raw_pipes >= 8 {
        let lo = (raw_pipes as f64 * 0.7) as usize;
        let hi = (raw_pipes as f64 * 1.3) as usize + 2;
        if new_pipes < lo || new_pipes > hi {
            return false;
        }
    }
    true
}

/// Inject lightweight provenance for OCR-derived chunks into section path.
pub fn provenance_section_path(section_path: &str, ocr_engine: Option<&str>) -> String {
    match ocr_engine {
        Some(engine) if !engine.is_empty() => {
            if section_path.is_empty() {
                format!("ocr:{engine}")
            } else if section_path.contains("ocr:") {
                section_path.to_string()
            } else {
                format!("{section_path} | ocr:{engine}")
            }
        }
        _ => section_path.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_markdown_table() {
        let src = "# Rates\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nDone.\n";
        let out = enrich_tables_and_figures(src);
        assert!(out.contains("<table> [Rates]"));
        assert!(out.contains("</table>"));
        assert!(out.contains("| 1 | 2 |"));
    }

    #[test]
    fn repair_keeps_page_headers() {
        let raw = "## Page 1\n\nHel lo world\n\n## Page 2\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
        let (out, applied) = apply_optional_ocr_repair(raw, true);
        assert!(applied);
        assert_eq!(out.matches("## Page ").count(), 2);
    }
}
