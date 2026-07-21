//! Expand top search hits with same-file neighboring chunks (`chunk_index ± 1`).
//!
//! When related evidence is split across adjacent children, the primary hit often
//! ranks alone. Pulling neighbors into context (with a mild score penalty) recovers
//! the missing half without requiring a re-query.

use crate::database::Database;
use crate::error::AppResult;
use crate::knowledge_chat::db::{self, LoadedChunk};
use crate::knowledge_chat::types::{KcRetrievalMode, KcSearchHit};

/// How many top hits (by current order) to expand from.
const EXPAND_TOP_N: usize = 5;
/// Maximum neighbor hits injected per search.
const MAX_EXPANDED: usize = 6;
/// Score multiplier so neighbors enter context but rarely outrank primaries.
const NEIGHBOR_SCORE_FACTOR: f64 = 0.82;

/// Load `chunk_index ± 1` for leading hits and append missing neighbors.
/// Returns `(hits, expand_applied)`.
pub fn expand_adjacent_chunk_hits(
    db: &Database,
    collection_id: &str,
    hits: &[KcSearchHit],
) -> AppResult<(Vec<KcSearchHit>, bool)> {
    if hits.is_empty() {
        return Ok((hits.to_vec(), false));
    }

    let mut out = hits.to_vec();
    let mut seen: std::collections::HashSet<String> =
        hits.iter().map(|h| h.chunk.id.clone()).collect();
    let mut added = 0usize;
    let mode = hits
        .first()
        .map(|h| h.retrieval_mode.clone())
        .unwrap_or(KcRetrievalMode::HybridLexical);

    for hit in hits.iter().take(EXPAND_TOP_N) {
        if added >= MAX_EXPANDED {
            break;
        }
        // Entity rows are not file chunk neighbors.
        if hit.chunk.source_type == "entity"
            || crate::knowledge_chat::db_entities::is_entity_id(&hit.chunk.id)
        {
            continue;
        }
        let neighbors = db::load_adjacent_file_chunks(
            db,
            collection_id,
            &hit.chunk.file_id,
            hit.chunk.chunk_index,
        )?;
        for neighbor in neighbors {
            if added >= MAX_EXPANDED {
                break;
            }
            if !seen.insert(neighbor.record.id.clone()) {
                continue;
            }
            out.push(neighbor_to_hit(&neighbor, hit, mode.clone()));
            added += 1;
        }
    }

    // Re-rank by fused_score so injected neighbors sit near their source.
    out.sort_by(|a, b| {
        b.fused_score
            .partial_cmp(&a.fused_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for (idx, hit) in out.iter_mut().enumerate() {
        hit.rank = idx + 1;
    }

    Ok((out, added > 0))
}

fn neighbor_to_hit(neighbor: &LoadedChunk, source: &KcSearchHit, mode: KcRetrievalMode) -> KcSearchHit {
    let mut chunk = neighbor.record.clone();
    chunk.source_type = "adjacent_expand".to_string();
    let score = source.fused_score * NEIGHBOR_SCORE_FACTOR;
    KcSearchHit {
        chunk,
        retrieval_mode: mode,
        keyword_score: source.keyword_score * NEIGHBOR_SCORE_FACTOR,
        lexical_score: source.lexical_score * NEIGHBOR_SCORE_FACTOR,
        dense_score: source.dense_score * NEIGHBOR_SCORE_FACTOR,
        fts_score: source.fts_score * NEIGHBOR_SCORE_FACTOR,
        rerank_score: score,
        fused_score: score,
        rank: source.rank,
        relevant_snippet: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge_chat::types::KcChunkRecord;

    fn sample_hit(id: &str, file_id: &str, idx: i64, score: f64) -> KcSearchHit {
        KcSearchHit {
            chunk: KcChunkRecord {
                id: id.to_string(),
                collection_id: "c1".to_string(),
                file_id: file_id.to_string(),
                file_name: "doc.xml".to_string(),
                file_path: "/tmp/doc.xml".to_string(),
                chunk_index: idx,
                title: "Block".to_string(),
                start_char: 0,
                end_char: 10,
                text: format!("chunk body {idx} with enough text for tests"),
                top_terms: vec![],
                has_dense: false,
                parent_text: None,
                section_path: Some("XML > Block".to_string()),
                doc_type: Some("structured".to_string()),
                partition_id: Some("general".to_string()),
                context_text: None,
                line_start: Some(1),
                line_end: Some(2),
                page_start: None,
                page_end: None,
                source_type: "chunk".to_string(),
                entity_kind: None,
                entity_name: None,
                source_confidence: None,
                parse_mode: None,
            },
            retrieval_mode: KcRetrievalMode::HybridDense,
            keyword_score: score,
            lexical_score: score,
            dense_score: score,
            fts_score: score,
            rerank_score: score,
            fused_score: score,
            rank: 1,
            relevant_snippet: None,
        }
    }

    #[test]
    fn neighbor_hit_uses_adjacent_expand_source_type() {
        let source = sample_hit("a::chunk-0", "file-a", 0, 1.0);
        let neighbor = LoadedChunk {
            record: sample_hit("a::chunk-1", "file-a", 1, 0.0).chunk,
            lexical_vector: vec![],
            dense_vector: None,
        };
        let hit = neighbor_to_hit(&neighbor, &source, KcRetrievalMode::HybridDense);
        assert_eq!(hit.chunk.source_type, "adjacent_expand");
        assert!(hit.fused_score < source.fused_score);
    }
}
