use crate::knowledge_chat::lexical::{build_lexical_vector, cosine_similarity, tokenize};
use crate::knowledge_chat::types::{KcSearchFilters, KcSearchHit};
use std::collections::{HashMap, HashSet};

const FUSED_WEIGHT: f64 = 0.32;
const INTERACTION_WEIGHT: f64 = 0.38;
const LEXICAL_WEIGHT: f64 = 0.22;
const PHRASE_WEIGHT: f64 = 0.08;

/// Local interaction reranker (offline cross-encoder substitute).
/// Scores query–document term interaction with corpus IDF from the candidate pool.
pub fn cross_rerank_hits(query: &str, hits: &mut [KcSearchHit], filters: &Option<KcSearchFilters>) {
    if hits.is_empty() {
        return;
    }

    let idf = build_idf_map(hits);
    let query_tokens = tokenize(query);
    let query_vector = build_lexical_vector(query);
    let preferred_doc_types: HashSet<String> = filters
        .as_ref()
        .and_then(|f| f.preferred_doc_types.as_ref())
        .map(|types| types.iter().map(|t| t.to_lowercase()).collect())
        .unwrap_or_default();

    for hit in hits.iter_mut() {
        let doc_text = document_text(hit);
        let doc_tokens: HashSet<String> = tokenize(&doc_text).into_iter().collect();

        let mut interaction = 0.0f64;
        for token in &query_tokens {
            if doc_tokens.contains(token) {
                interaction += idf.get(token).copied().unwrap_or(1.0);
            }
        }
        if !query_tokens.is_empty() {
            interaction /= query_tokens.len() as f64;
        }
        interaction += proximity_bonus(&query_tokens, &doc_text);
        interaction = interaction.min(3.5) / 3.5;

        let doc_vector = build_lexical_vector(&doc_text);
        let lexical_sim = cosine_similarity(&query_vector, &doc_vector);

        let phrase = phrase_overlap_score(query, &doc_text);

        let mut cross_score =
            interaction * INTERACTION_WEIGHT + lexical_sim * LEXICAL_WEIGHT + phrase * PHRASE_WEIGHT;

        if let Some(doc_type) = hit.chunk.doc_type.as_deref() {
            if preferred_doc_types.contains(&doc_type.to_lowercase()) {
                cross_score += 0.04;
            }
        }

        hit.rerank_score = hit.fused_score * FUSED_WEIGHT + cross_score;
    }

    hits.sort_by(|a, b| {
        b.rerank_score
            .partial_cmp(&a.rerank_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    for (idx, hit) in hits.iter_mut().enumerate() {
        hit.rank = idx + 1;
    }
}

fn document_text(hit: &KcSearchHit) -> String {
    format!(
        "{} {} {} {}",
        hit.chunk.file_name,
        hit.chunk.title,
        hit.chunk.section_path.as_deref().unwrap_or(""),
        hit.chunk.context_text.as_deref().unwrap_or(&hit.chunk.text)
    )
}

fn build_idf_map(hits: &[KcSearchHit]) -> HashMap<String, f64> {
    let n = hits.len() as f64;
    let mut df: HashMap<String, usize> = HashMap::new();
    for hit in hits {
        let tokens: HashSet<String> = tokenize(&document_text(hit)).into_iter().collect();
        for token in tokens {
            *df.entry(token).or_default() += 1;
        }
    }
    df.into_iter()
        .map(|(term, count)| {
            let idf = ((n + 1.0) / (count as f64 + 1.0)).ln() + 1.0;
            (term, idf)
        })
        .collect()
}

fn proximity_bonus(query_tokens: &[String], doc_text: &str) -> f64 {
    if query_tokens.len() < 2 {
        return 0.0;
    }
    let lower = doc_text.to_lowercase();
    let mut bonus = 0.0f64;
    for pair in query_tokens.windows(2) {
        if let (Some(a_pos), Some(b_pos)) = (lower.find(&pair[0]), lower.find(&pair[1])) {
            let distance = a_pos.abs_diff(b_pos);
            if distance <= 48 {
                bonus += 0.12;
            } else if distance <= 120 {
                bonus += 0.05;
            }
        }
    }
    bonus.min(0.35)
}

fn phrase_overlap_score(query: &str, doc_text: &str) -> f64 {
    let lower_q = query.to_lowercase();
    let lower_d = doc_text.to_lowercase();
    let words: Vec<&str> = lower_q.split_whitespace().collect();
    let mut score = 0.0f64;
    if lower_d.contains(&lower_q) {
        score += 0.35;
    }
    for size in (2..=4).rev() {
        for window in words.windows(size) {
            let phrase = window.join(" ");
            if phrase.len() > 5 && lower_d.contains(&phrase) {
                score += 0.08;
            }
        }
    }
    score.min(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge_chat::types::{KcChunkRecord, KcRetrievalMode};

    fn sample_hit(text: &str, file: &str, fused: f64) -> KcSearchHit {
        KcSearchHit {
            chunk: KcChunkRecord {
                id: "1".to_string(),
                collection_id: "c".to_string(),
                file_id: "f".to_string(),
                file_name: file.to_string(),
                file_path: format!("/data/{file}"),
                chunk_index: 0,
                title: file.to_string(),
                start_char: 0,
                end_char: 100,
                text: text.to_string(),
                top_terms: vec![],
                has_dense: false,
                parent_text: None,
                section_path: None,
                doc_type: Some("document".to_string()),
                partition_id: Some("knowledge".to_string()),
                context_text: None,
                line_start: None,
                line_end: None,
                page_start: None,
                page_end: None,
                source_type: "chunk".to_string(),
                entity_kind: None,
                entity_name: None,
                source_confidence: None,
                parse_mode: None,
            },
            retrieval_mode: KcRetrievalMode::HybridDense,
            keyword_score: 0.0,
            lexical_score: 0.0,
            dense_score: 0.0,
            fts_score: 0.0,
            rerank_score: fused,
            fused_score: fused,
            rank: 1,
            relevant_snippet: None,
        }
    }

    #[test]
    fn promotes_matching_document() {
        let mut hits = vec![
            sample_hit("lunch menu and cafeteria hours", "menu.txt", 0.2),
            sample_hit(
                "VPN brute force escalation requires manager approval within one hour",
                "vpn-sop.md",
                0.18,
            ),
        ];
        cross_rerank_hits("VPN escalation manager approval", &mut hits, &None);
        assert!(hits[0].chunk.file_name.contains("vpn"));
    }
}
