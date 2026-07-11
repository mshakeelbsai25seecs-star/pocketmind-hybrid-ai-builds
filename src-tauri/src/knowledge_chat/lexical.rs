use crate::knowledge_chat::types::KC_VECTOR_DIMENSIONS;
use std::collections::HashSet;

const STOPWORDS: &[&str] = &[
    "the", "and", "for", "with", "that", "this", "from", "into", "when", "then", "than", "are",
    "was", "were", "will", "would", "should", "can", "could", "has", "have", "had", "not", "you",
    "your", "our", "their", "there", "here", "about", "after", "before", "within", "using", "used",
    "use", "guide", "page", "section", "table", "content", "html", "http", "https", "com", "www",
];

pub fn clean_text(text: &str) -> String {
    text.replace('\0', " ")
        .replace('\r', "\n")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

/// Preserve paragraph breaks for stored chunks; collapse only intra-line whitespace.
pub fn normalize_chunk_text(text: &str) -> String {
    let normalized = text.replace('\0', " ").replace('\r', "\n");
    let paragraphs: Vec<String> = normalized
        .split("\n\n")
        .map(|paragraph| {
            paragraph
                .lines()
                .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|paragraph| !paragraph.is_empty())
        .collect();
    paragraphs.join("\n\n").trim().to_string()
}

pub fn tokenize(text: &str) -> Vec<String> {
    clean_text(text)
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-' && c != '.' && c != ':')
        .map(str::trim)
        .filter(|term| {
            term.len() > 1
                && term.len() < 48
                && !STOPWORDS.contains(&term.as_ref())
        })
        .map(str::to_string)
        .collect()
}

fn hash_term(term: &str) -> usize {
    let mut hash: u32 = 2166136261;
    for byte in term.bytes() {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(16777619);
    }
    hash as usize
}

pub fn build_lexical_vector(text: &str) -> Vec<f32> {
    let mut vector = vec![0.0f32; KC_VECTOR_DIMENSIONS];
    let tokens = tokenize(text);
    if tokens.is_empty() {
        return vector;
    }

    let mut counts = std::collections::HashMap::<String, usize>::new();
    for token in tokens {
        *counts.entry(token).or_default() += 1;
    }

    for (term, count) in counts {
        let index = hash_term(&term) % KC_VECTOR_DIMENSIONS;
        let weight = 1.0 + (count as f32).ln();
        vector[index] += weight;
    }

    let magnitude = vector.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>().sqrt();
    if magnitude > 0.0 {
        vector.iter_mut().for_each(|v| *v = (*v as f64 / magnitude) as f32);
    }
    vector
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut mag_a = 0.0f64;
    let mut mag_b = 0.0f64;
    for (left, right) in a.iter().zip(b.iter()) {
        dot += (*left as f64) * (*right as f64);
        mag_a += (*left as f64) * (*left as f64);
        mag_b += (*right as f64) * (*right as f64);
    }
    if mag_a <= 0.0 || mag_b <= 0.0 {
        return 0.0;
    }
    dot / (mag_a.sqrt() * mag_b.sqrt())
}

pub fn top_terms(text: &str, limit: usize) -> Vec<String> {
    let mut counts = std::collections::HashMap::<String, usize>::new();
    for token in tokenize(text) {
        *counts.entry(token).or_default() += 1;
    }
    let mut ranked: Vec<(String, usize)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    ranked.into_iter().take(limit).map(|(term, _)| term).collect()
}

pub fn keyword_score(query: &str, chunk_text: &str, file_name: &str, title: &str) -> f64 {
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return 0.0;
    }

    let terms: Vec<String> = normalized_query
        .split_whitespace()
        .filter(|term| term.len() > 1)
        .take(16)
        .map(str::to_string)
        .collect();
    if terms.is_empty() {
        return 0.0;
    }

    let title_lower = title.to_lowercase();
    let file_lower = file_name.to_lowercase();
    let text_lower = clean_text(chunk_text).to_lowercase();
    let mut score = 0.0f64;

    if text_lower.contains(&normalized_query) {
        score += 18.0;
    }

    for term in &terms {
        if title_lower.contains(term) {
            score += 10.0;
        }
        if file_lower.contains(term) {
            score += 5.0;
        }
        let escaped = regex_escape(term);
        let pattern = format!(r"\b{escaped}\b");
        if let Some(re) = regex_lite_match_count(&pattern, &text_lower) {
            score += (re.min(10) as f64) * 1.5;
        }
    }

    score
}

fn regex_escape(term: &str) -> String {
    term.chars()
        .flat_map(|c| {
            if ".^$|()[]{}*+?\\".contains(c) {
                vec!['\\', c]
            } else {
                vec![c]
            }
        })
        .collect()
}

fn regex_lite_match_count(pattern: &str, haystack: &str) -> Option<usize> {
    // Lightweight word-boundary count without adding regex crate dependency.
    let needle = pattern.trim_start_matches("\\b").trim_end_matches("\\b");
    if needle.is_empty() {
        return Some(0);
    }
    Some(
        haystack
            .split_whitespace()
            .filter(|word| word.contains(needle))
            .count(),
    )
}

pub fn query_terms(query: &str) -> HashSet<String> {
    tokenize(query).into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_vector_is_normalized() {
        let vector = build_lexical_vector("FortiSIEM parser extraction test");
        let magnitude = vector.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>().sqrt();
        assert!(magnitude > 0.99 && magnitude < 1.01);
    }

    #[test]
    fn keyword_score_prefers_title_matches() {
        let score = keyword_score(
            "parser extraction",
            "some body text",
            "parser.xml",
            "Parser extraction guide",
        );
        assert!(score > 10.0);
    }
}
