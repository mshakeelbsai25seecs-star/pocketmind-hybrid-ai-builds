//! Normalize OCR-export markdown before chunking/indexing.

const DIAGRAM_FRAGMENTATION_THRESHOLD: f64 = 0.16;
const MIN_TOKENS_FOR_FRAGMENTATION: usize = 8;

const DIAGRAM_PAGE_NOTE: &str = "Visual table-of-contents or diagram page. Full policy text begins on the following pages.";

const COMMON_SHORT: &[&str] = &[
    "a", "an", "as", "at", "be", "by", "do", "go", "he", "if", "in", "is", "it",
    "me", "my", "no", "of", "on", "or", "so", "to", "up", "us", "we",
    "the", "and", "for", "with", "that", "this", "from", "into", "when", "then",
    "are", "was", "were", "will", "has", "have", "had", "not", "you", "your",
    "our", "their", "there", "can", "may", "all", "any", "each", "both", "data",
    "use", "via", "per", "its", "who", "how", "new", "one", "two", "end", "log",
];

fn is_common_short(token: &str) -> bool {
    COMMON_SHORT.contains(&token.to_ascii_lowercase().as_str())
}

pub fn is_ocr_markdown_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    (lower.ends_with(".md") || lower.ends_with(".markdown"))
        && (lower.contains("-ocr") || lower.contains("_ocr") || lower.contains("ocr-"))
}

pub fn repair_ocr_markdown(text: &str) -> String {
    let normalized = text.replace('\r', "\n");
    let mut out = Vec::new();
    let mut current_page: Option<String> = None;
    let mut body_lines: Vec<String> = Vec::new();

    let flush = |out: &mut Vec<String>, page: &Option<String>, body_lines: &mut Vec<String>| {
        let Some(page_title) = page else {
            body_lines.clear();
            return;
        };
        let raw_body = body_lines.join("\n").trim().to_string();
        body_lines.clear();
        let repaired = repair_page_body(&raw_body);
        out.push(page_title.clone());
        out.push(String::new());
        out.push(repaired);
        out.push(String::new());
    };

    for line in normalized.lines() {
        let trimmed = line.trim();
        let page_title = if let Some(page_num) = trimmed.strip_prefix("## Page ") {
            Some(format!("## Page {page_num}"))
        } else if let Some(page_num) = trimmed.strip_prefix("# Page ") {
            Some(format!("## Page {page_num}"))
        } else if trimmed.len() <= 40
            && trimmed.to_ascii_lowercase().starts_with("page ")
            && trimmed[5..]
                .trim()
                .chars()
                .next()
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
        {
            Some(format!("## {trimmed}"))
        } else {
            None
        };

        if let Some(title) = page_title {
            flush(&mut out, &current_page, &mut body_lines);
            current_page = Some(title);
            continue;
        }
        if current_page.is_some() {
            body_lines.push(line.to_string());
        } else {
            out.push(line.to_string());
        }
    }
    flush(&mut out, &current_page, &mut body_lines);

    strip_training_watermarks(&out.join("\n"))
}

fn repair_page_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if ocr_fragmentation_score(trimmed) >= DIAGRAM_FRAGMENTATION_THRESHOLD {
        return String::new();
    }
    merge_split_words(trimmed)
}

pub fn ocr_fragmentation_score(text: &str) -> f64 {
    let tokens: Vec<&str> = text.split_whitespace().collect();
    if tokens.len() < MIN_TOKENS_FOR_FRAGMENTATION {
        return 0.0;
    }
    let mut bad = 0.0f64;
    for (index, token) in tokens.iter().enumerate() {
        let core = token.trim_matches(|c: char| c == ',' || c == '.' || c == ';' || c == ':');
        if core.len() == 1 && core.chars().all(|c| c.is_alphabetic()) {
            let lower = core.to_ascii_lowercase();
            if lower != "a" && lower != "i" {
                bad += 1.0;
            }
        } else if core.len() <= 4
            && core
                .chars()
                .next()
                .map(|c| c.is_ascii_uppercase())
                .unwrap_or(false)
            && index + 1 < tokens.len()
        {
            let next = tokens[index + 1].trim_matches(|c: char| c == ',' || c == '.' || c == ';' || c == ':');
            if let Some(first) = next.chars().next() {
                if first.is_ascii_lowercase() && next.len() <= 6 {
                    bad += 0.75;
                }
            }
        } else if core.len() <= 3 && core.chars().all(|c| c.is_ascii_lowercase()) {
            bad += 0.5;
        }
    }
    bad / tokens.len() as f64
}

fn merge_split_words(text: &str) -> String {
    let mut out_lines = Vec::new();
    for line in text.lines() {
        out_lines.push(merge_split_words_in_line(line));
    }
    out_lines.join("\n")
}

fn merge_split_words_in_line(line: &str) -> String {
    let tokens: Vec<String> = line.split_whitespace().map(str::to_string).collect();
    if tokens.is_empty() {
        return String::new();
    }
    let mut merged = Vec::new();
    let mut index = 0usize;
    while index < tokens.len() {
        let mut token = tokens[index].clone();
        while index + 1 < tokens.len() && should_merge_tokens(&token, &tokens[index + 1]) {
            index += 1;
            let next = &tokens[index];
            let (core, suffix) = split_token_suffix(next);
            if token.chars().last().map(|c| c.is_alphabetic()).unwrap_or(false)
                && core.chars().next().map(|c| c.is_ascii_lowercase()).unwrap_or(false)
            {
                token.push_str(core);
                token.push_str(suffix);
            } else {
                token = format!("{token} {next}");
            }
        }
        merged.push(token);
        index += 1;
    }
    merged.join(" ")
}

fn split_token_suffix(token: &str) -> (&str, &str) {
    let end = token
        .char_indices()
        .rev()
        .find(|(_, ch)| ch.is_alphabetic())
        .map(|(idx, ch)| idx + ch.len_utf8())
        .unwrap_or(token.len());
    token.split_at(end)
}

fn should_merge_tokens(left: &str, right: &str) -> bool {
    let (left_core, _) = split_token_suffix(left);
    let (right_core, _) = split_token_suffix(right);
    if left_core.is_empty() || right_core.is_empty() {
        return false;
    }
    if !left_core.chars().last().map(|c| c.is_alphabetic()).unwrap_or(false) {
        return false;
    }
    if !right_core.chars().next().map(|c| c.is_alphabetic()).unwrap_or(false) {
        return false;
    }
    if is_common_short(left_core) || is_common_short(right_core) {
        return false;
    }
    if right_core.len() == 1 && right_core.chars().all(|c| c.is_alphabetic()) {
        return !matches!(right_core.to_ascii_lowercase().as_str(), "a" | "i");
    }
    if left_core.len() == 1 && left_core.chars().all(|c| c.is_alphabetic()) {
        return !matches!(left_core.to_ascii_lowercase().as_str(), "a" | "i");
    }
    if left_core.chars().all(|c| c.is_ascii_lowercase())
        && right_core.chars().all(|c| c.is_ascii_lowercase())
    {
        return (4..=5).contains(&left_core.len()) && (2..=8).contains(&right_core.len());
    }
    if left_core.len() <= 4
        && left_core
            .chars()
            .next()
            .map(|c| c.is_ascii_uppercase())
            .unwrap_or(false)
        && left_core.chars().skip(1).all(|c| c.is_ascii_lowercase())
        && right_core.chars().all(|c| c.is_ascii_lowercase())
    {
        return (2..=8).contains(&right_core.len());
    }
    false
}

fn strip_training_watermarks(text: &str) -> String {
    let cleaned = text
        .replace("GENERIC TRAINING copy", "")
        .replace("GENERIC TRAINING", "");
    let cleaned = cleaned.replace(" COPY", "");
    cleaned
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .replace("\n\n\n", "\n\n")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagram_page_is_replaced() {
        let body = "Incl ent Response Metho o ogy Digita Forensics Malware Ana Vulnerability Management Integration Security Use Case Development Log Source On oar Ing an Management Reporting Executive, Operationa , Comp lance Incident handling";
        assert!(ocr_fragmentation_score(body) >= DIAGRAM_FRAGMENTATION_THRESHOLD);
        let repaired = repair_ocr_markdown(&format!("## Page 1\n\n{body}\n"));
        assert!(!repaired.contains(DIAGRAM_PAGE_NOTE));
        assert!(repaired.contains("## Page 1"));
    }

    #[test]
    fn prose_splits_are_merged() {
        let body = "The framework ensu res comprehensive coverage and tech nical accuracy.";
        let repaired = repair_page_body(body);
        assert!(repaired.contains("ensures"));
        assert!(repaired.contains("technical"));
        assert!(repaired.contains("The framework"));
    }
}
