use crate::knowledge_chat::lexical::{clean_text, tokenize};
use std::collections::HashSet;

const DEFAULT_SNIPPET_CHARS: usize = 1400;

fn looks_like_source_code(text: &str) -> bool {
    text.contains("const ")
        || text.contains("function ")
        || text.contains("=>")
        || text.contains("pub fn")
        || text.contains("def ")
        || text.contains("class ")
        || text.contains("import ")
}

/// For code chunks, keep matching lines plus nearby context instead of sentence splitting.
fn compress_code_for_query(query: &str, text: &str, max_chars: usize) -> String {
    let query_terms: HashSet<String> = tokenize(query).into_iter().collect();
    if query_terms.is_empty() {
        return truncate_chars(text, max_chars);
    }

    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return truncate_chars(text, max_chars);
    }

    let mut selected = vec![false; lines.len()];
    for (idx, line) in lines.iter().enumerate() {
        let lower = line.to_lowercase();
        if query_terms.iter().any(|term| lower.contains(term.as_str())) {
            let start = idx.saturating_sub(2);
            let end = (idx + 10).min(lines.len());
            for slot in start..end {
                selected[slot] = true;
            }
        }
    }

    if !selected.iter().any(|flag| *flag) {
        return truncate_chars(text, max_chars);
    }

    let mut out = String::new();
    for (idx, line) in lines.iter().enumerate() {
        if !selected[idx] {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
        if out.chars().count() >= max_chars {
            break;
        }
    }

    truncate_chars(out.trim(), max_chars)
}

/// Extract query-relevant sentences from a chunk, preserving original order.
pub fn compress_text_for_query(query: &str, text: &str, max_chars: usize) -> String {
    let cleaned = clean_text(text);
    if looks_like_source_code(text) {
        return compress_code_for_query(query, text, max_chars);
    }
    let query_terms: HashSet<String> = tokenize(query).into_iter().collect();
    if query_terms.is_empty() {
        return truncate_chars(&cleaned, max_chars);
    }
    if cleaned.chars().count() <= max_chars {
        let sentences = split_sentences(&cleaned);
        let has_query_overlap = sentences.iter().any(|sentence| {
            let lower = sentence.to_lowercase();
            query_terms.iter().any(|term| lower.contains(term.as_str()))
        });
        if !has_query_overlap {
            return cleaned;
        }
    }

    let sentences = split_sentences(&cleaned);
    if sentences.is_empty() {
        return truncate_chars(&cleaned, max_chars);
    }

    let scored: Vec<(usize, f64)> = sentences
        .iter()
        .enumerate()
        .map(|(idx, sentence)| {
            let lower = sentence.to_lowercase();
            let mut score = query_terms
                .iter()
                .filter(|term| lower.contains(term.as_str()))
                .count() as f64;
            if score > 0.0 {
                score += phrase_coverage_bonus(query, sentence);
            }
            (idx, score)
        })
        .collect();

    let has_matches = scored.iter().any(|(_, score)| *score > 0.0);
    let selected_indices: Vec<usize> = if has_matches {
        scored
            .iter()
            .filter(|(_, score)| *score > 0.0)
            .map(|(idx, _)| *idx)
            .collect()
    } else {
        scored
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(idx, _)| vec![idx])
            .unwrap_or_default()
    };

    let mut out = String::new();
    for idx in selected_indices {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(sentences[idx].trim());
        if out.chars().count() >= max_chars {
            break;
        }
    }

    if out.trim().is_empty() {
        truncate_chars(&cleaned, max_chars)
    } else {
        truncate_chars(out.trim(), max_chars)
    }
}

pub fn default_snippet_chars() -> usize {
    DEFAULT_SNIPPET_CHARS
}

const INJECTION_PATTERNS: &[&str] = &[
    "ignore previous instructions",
    "ignore all previous",
    "disregard prior",
    "system prompt",
    "you are now",
    "developer message",
    "jailbreak",
    "### instruction",
    "<|im_start|>",
    "[INST]",
];

/// Strip common prompt-injection phrases from retrieved chunks before LLM context.
pub fn sanitize_retrieved_text(text: &str) -> String {
    let mut out = text.replace('\0', " ");
    for pattern in INJECTION_PATTERNS {
        out = replace_ascii_ci(&out, pattern, "[filtered]");
    }
    out
}

fn replace_ascii_ci(haystack: &str, needle: &str, replacement: &str) -> String {
    let lower_hay = haystack.to_lowercase();
    let lower_needle = needle.to_lowercase();
    let mut result = String::new();
    let mut start = 0usize;
    while let Some(rel) = lower_hay[start..].find(&lower_needle) {
        let idx = start + rel;
        result.push_str(&haystack[start..idx]);
        result.push_str(replacement);
        start = idx + needle.len();
    }
    result.push_str(&haystack[start..]);
    result
}

fn phrase_coverage_bonus(query: &str, sentence: &str) -> f64 {
    let lower_q = query.to_lowercase();
    let lower_s = sentence.to_lowercase();
    let words: Vec<&str> = lower_q.split_whitespace().collect();
    let mut bonus = 0.0;
    for size in (2..=4).rev() {
        for window in words.windows(size) {
            let phrase = window.join(" ");
            if phrase.len() > 5 && lower_s.contains(&phrase) {
                bonus += 0.35;
            }
        }
    }
    bonus
}

fn split_sentences(text: &str) -> Vec<String> {
    let normalized = text.replace('\n', " ");
    let mut sentences: Vec<String> = normalized
        .split(". ")
        .map(|part| part.trim().trim_end_matches('.').to_string())
        .filter(|part| !part.is_empty())
        .collect();

    if sentences.is_empty() {
        sentences.push(text.trim().to_string());
    }
    sentences
}

fn truncate_chars(text: &str, max: usize) -> String {
    let chars: String = text.chars().take(max).collect();
    let trimmed = chars.trim().to_string();
    if trimmed.chars().count() < text.chars().count() {
        format!("{trimmed}…")
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_relevant_sentences_in_order() {
        let text = "General introduction with no matching terms. Escalation requires manager approval within one hour. Lunch menu rotates weekly.";
        let out = compress_text_for_query("escalation approval manager", text, 200);
        let lower = out.to_lowercase();
        assert!(lower.contains("escalation"), "unexpected output: {out}");
        assert!(!lower.contains("lunch"), "unexpected output: {out}");
    }

    #[test]
    fn code_compression_keeps_matching_function_block() {
        let text = "const handleCopy = async () => {};\n\nconst handleSend = async () => {\n  if (!input.trim()) return;\n  setInput('');\n};\n";
        let out = compress_text_for_query("handleSend ChatView", text, 400);
        assert!(out.contains("handleSend"), "unexpected output: {out}");
        assert!(out.contains("setInput"), "unexpected output: {out}");
    }
}
