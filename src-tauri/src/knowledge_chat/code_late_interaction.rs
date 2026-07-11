//! ColBERT-style late interaction for the code partition (offline, no extra model).
//! MaxSim over identifier tokens boosts symbol/file lookups when dense embeddings miss.

use crate::knowledge_chat::lexical::tokenize;
use crate::knowledge_chat::query_intent::extract_camel_symbols;
use crate::knowledge_chat::types::KcChunkRecord;

const MIN_TOKEN_LEN: usize = 2;

/// Extract retrieval tokens from code text: identifiers, camelCase splits, and lexer tokens.
pub fn code_document_tokens(record: &KcChunkRecord) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    if let Some(name) = &record.entity_name {
        tokens.extend(split_identifier(name));
    }
    tokens.extend(split_identifier(&record.title));
    tokens.extend(split_identifier(&record.file_name));
    for term in &record.top_terms {
        tokens.extend(split_identifier(term));
    }
    for token in tokenize(&record.text) {
        if token.len() >= MIN_TOKEN_LEN {
            tokens.push(token);
        }
    }
    dedupe_tokens(tokens)
}

pub fn code_query_tokens(query: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    for symbol in extract_camel_symbols(query) {
        tokens.extend(split_identifier(&symbol));
    }
    if let Some(file_hint) = crate::knowledge_chat::query_intent::extract_file_hint(query) {
        tokens.extend(split_identifier(&file_hint));
    }
    for token in tokenize(query) {
        if token.len() >= MIN_TOKEN_LEN {
            tokens.push(token);
        }
    }
    dedupe_tokens(tokens)
}

/// MaxSim-style score: average of best token matches (query → document).
pub fn code_maxsim_score(query: &str, record: &KcChunkRecord) -> f64 {
    let query_tokens = code_query_tokens(query);
    if query_tokens.is_empty() {
        return 0.0;
    }
    let doc_tokens = code_document_tokens(record);
    if doc_tokens.is_empty() {
        return 0.0;
    }

    let mut sum = 0.0;
    for qt in &query_tokens {
        let best = doc_tokens
            .iter()
            .map(|dt| token_match_score(qt, dt))
            .fold(0.0f64, f64::max);
        sum += best;
    }
    (sum / query_tokens.len() as f64).clamp(0.0, 1.0)
}

pub fn is_code_retrieval_record(record: &KcChunkRecord) -> bool {
    record.partition_id.as_deref() == Some("code")
        || record.source_type == "code_entity"
        || record.doc_type.as_deref() == Some("code")
}

fn token_match_score(query: &str, doc: &str) -> f64 {
    if query == doc {
        return 1.0;
    }
    if query.eq_ignore_ascii_case(doc) {
        return 0.92;
    }
    if doc.contains(query) || query.contains(doc) {
        return 0.65;
    }
    0.0
}

fn split_identifier(value: &str) -> Vec<String> {
    let cleaned = value
        .trim()
        .trim_matches(|c: char| c == '`' || c == '\'' || c == '"')
        .to_string();
    if cleaned.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    let base = cleaned.to_lowercase();
    out.push(base.clone());

    let mut current = String::new();
    for ch in cleaned.chars() {
        if ch.is_uppercase() && !current.is_empty() {
            out.push(current.to_lowercase());
            current.clear();
        }
        if ch.is_ascii_alphanumeric() || ch == '_' {
            current.push(ch);
        } else if !current.is_empty() {
            out.push(current.to_lowercase());
            current.clear();
        }
    }
    if !current.is_empty() {
        out.push(current.to_lowercase());
    }

    for part in cleaned.split(|c: char| !c.is_ascii_alphanumeric() && c != '_') {
        if part.len() >= MIN_TOKEN_LEN {
            out.push(part.to_lowercase());
        }
    }

    dedupe_tokens(out)
}

fn dedupe_tokens(tokens: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    tokens
        .into_iter()
        .filter(|t| t.len() >= MIN_TOKEN_LEN && seen.insert(t.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge_chat::types::KcChunkRecord;

    fn code_record(name: &str, file: &str, body: &str) -> KcChunkRecord {
        KcChunkRecord {
            id: "e1".into(),
            collection_id: "c".into(),
            file_id: "f".into(),
            file_name: file.into(),
            file_path: file.into(),
            chunk_index: 0,
            title: name.into(),
            start_char: 0,
            end_char: 0,
            text: body.into(),
            top_terms: vec![name.to_lowercase()],
            has_dense: false,
            parent_text: None,
            section_path: None,
            doc_type: Some("code".into()),
            partition_id: Some("code".into()),
            context_text: None,
            line_start: Some(1),
            line_end: Some(10),
            page_start: None,
            page_end: None,
            source_type: "code_entity".into(),
            entity_kind: Some("function".into()),
            entity_name: Some(name.into()),
            source_confidence: None,
            parse_mode: None,
        }
    }

    #[test]
    fn handlesend_maxsim_high() {
        let record = code_record(
            "handleSend",
            "ChatView.tsx",
            "const handleSend = () => { setInput(''); }",
        );
        let score = code_maxsim_score("What does handleSend do in ChatView.tsx?", &record);
        assert!(score >= 0.5, "score={score}");
    }

    #[test]
    fn unrelated_query_scores_low() {
        let record = code_record("handleSend", "ChatView.tsx", "const handleSend = () => {}");
        let score = code_maxsim_score("VPN brute force first step", &record);
        assert!(score < 0.3, "score={score}");
    }
}
