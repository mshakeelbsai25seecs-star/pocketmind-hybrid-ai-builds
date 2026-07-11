use crate::error::AppResult;
use crate::knowledge_chat::embedding_profiles::{self, EmbeddingProfileId};
use crate::knowledge_chat::embeddings::EMBED_BATCH_SIZE;
use crate::knowledge_chat::partitions::KcPartitionId;
use crate::knowledge_chat::runtime::KcEmbedPool;
use crate::knowledge_chat::types::{KcEmbedTextsRequest, KcSearchHit};
use std::sync::Arc;

/// Accuracy-first: longer passage text for pair scoring (still capped for embed memory).
const SNIPPET_CHARS: usize = 2200;

/// Outcome of a partitioned dense pair rerank attempt.
#[derive(Debug, Clone, Default)]
pub struct DensePairRerankResult {
    pub applied: bool,
    /// Human-readable reasons when nothing was applied (or partial failure).
    pub failure_notes: Vec<String>,
}

/// Format a query for a given embedding profile.
pub fn format_query_text(profile: EmbeddingProfileId, query: &str) -> String {
    embedding_profiles::format_query(profile, query)
}

/// Format a hit as a document string for rerank embedding (must match the
/// index-time `format_chunk_for_dense_index` layout for the same profile).
pub fn format_document_text(profile: EmbeddingProfileId, hit: &KcSearchHit) -> String {
    let body = hit
        .chunk
        .context_text
        .as_deref()
        .unwrap_or(&hit.chunk.text);
    let snippet = truncate_chars(body, SNIPPET_CHARS);
    let section_path = hit
        .chunk
        .section_path
        .as_deref()
        .unwrap_or(&hit.chunk.title);
    embedding_profiles::format_document(
        profile,
        &hit.chunk.file_name,
        &hit.chunk.title,
        section_path,
        &snippet,
    )
}

/// Text passed to the embedding model at index time (must match rerank document format).
pub fn format_chunk_for_dense_index(
    profile: EmbeddingProfileId,
    file_name: &str,
    title: &str,
    section_path: &str,
    parent_text: &str,
    text: &str,
) -> String {
    let body = if parent_text.len() > text.len() {
        parent_text
    } else {
        text
    };
    let snippet = truncate_chars(body, SNIPPET_CHARS);
    embedding_profiles::format_document(profile, file_name, title, section_path, &snippet)
}

pub fn apply_dense_rerank_scores(
    hits: &mut [KcSearchHit],
    dense_scores: &[f64],
    blend_self: f64,
    blend_new: f64,
) {
    if hits.is_empty() || dense_scores.is_empty() {
        return;
    }
    let max_score = dense_scores.iter().copied().fold(0.0f64, f64::max);
    for (hit, raw) in hits.iter_mut().zip(dense_scores.iter()) {
        let normalized = if max_score > 0.0 { raw / max_score } else { 0.0 };
        hit.rerank_score = hit.rerank_score * blend_self + normalized * blend_new;
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

pub fn dense_scores_from_vectors(query_vector: &[f32], passage_vectors: &[Vec<f32>]) -> Vec<f64> {
    use crate::knowledge_chat::lexical::cosine_similarity;
    passage_vectors
        .iter()
        .map(|passage| cosine_similarity(query_vector, passage))
        .collect()
}

/// One partition's embedding model + profile used for pair reranking.
#[derive(Debug, Clone)]
pub struct PartitionRerankModel {
    pub partition: KcPartitionId,
    pub model_path: String,
    pub profile: EmbeddingProfileId,
}

fn hit_partition(hit: &KcSearchHit) -> KcPartitionId {
    hit.chunk
        .partition_id
        .as_deref()
        .map(KcPartitionId::from_value)
        .unwrap_or(KcPartitionId::General)
}

/// Pair-rerank the top hits using each partition's own embedding model.
/// Hits are grouped by partition; each group is embedded with its model and
/// scored independently (normalized within the group) before a single combined
/// rerank pass.
pub async fn apply_dense_pair_rerank_partitioned(
    pool: &Arc<KcEmbedPool>,
    partitions: &[PartitionRerankModel],
    query: &str,
    hits: &mut [KcSearchHit],
    top_n: usize,
    blend_self: f64,
    blend_new: f64,
) -> AppResult<DensePairRerankResult> {
    if hits.is_empty() {
        return Ok(DensePairRerankResult {
            applied: false,
            failure_notes: vec!["no retrieval hits".to_string()],
        });
    }
    if partitions.is_empty() {
        return Ok(DensePairRerankResult {
            applied: false,
            failure_notes: vec![
                "no partition embed models resolved for this scope".to_string(),
            ],
        });
    }
    let capped = hits.len().min(top_n.max(1));
    let mut combined = vec![0.0f64; capped];
    let mut any = false;
    let mut failure_notes = Vec::new();
    let mut attempted = 0usize;

    for part in partitions {
        if part.model_path.trim().is_empty() {
            failure_notes.push(format!(
                "{}: empty embedding model path",
                part.partition.as_str()
            ));
            continue;
        }
        let indices: Vec<usize> = (0..capped)
            .filter(|&i| hit_partition(&hits[i]) == part.partition)
            .collect();
        if indices.is_empty() {
            continue;
        }
        attempted += 1;

        let mut texts = Vec::with_capacity(indices.len() + 1);
        texts.push(embedding_profiles::format_query(part.profile, query));
        for &i in &indices {
            texts.push(format_document_text(part.profile, &hits[i]));
        }

        let embedded = pool
            .embed(KcEmbedTextsRequest {
                model_path: part.model_path.clone(),
                texts,
                context_size: Some(embedding_profiles::context_size_for(part.profile)),
                batch_size: Some(EMBED_BATCH_SIZE),
            })
            .await;
        let embedded = match embedded {
            Ok(v) => v,
            Err(err) => {
                failure_notes.push(format!(
                    "{}: embed failed ({err})",
                    part.partition.as_str()
                ));
                continue;
            }
        };
        if embedded.vectors.len() != indices.len() + 1 {
            failure_notes.push(format!(
                "{}: embed returned {} vectors, expected {}",
                part.partition.as_str(),
                embedded.vectors.len(),
                indices.len() + 1
            ));
            continue;
        }

        let query_vector = &embedded.vectors[0];
        let passage_vectors = &embedded.vectors[1..];
        let scores = dense_scores_from_vectors(query_vector, passage_vectors);
        let group_max = scores.iter().copied().fold(0.0f64, f64::max);
        for (k, &i) in indices.iter().enumerate() {
            combined[i] = if group_max > 0.0 { scores[k] / group_max } else { 0.0 };
        }
        any = true;
    }

    if !any {
        if failure_notes.is_empty() {
            if attempted == 0 {
                failure_notes.push(
                    "no top hits matched resolved partition models".to_string(),
                );
            } else {
                failure_notes.push("all partition embed attempts failed".to_string());
            }
        }
        return Ok(DensePairRerankResult {
            applied: false,
            failure_notes,
        });
    }
    apply_dense_rerank_scores(&mut hits[..capped], &combined, blend_self, blend_new);
    Ok(DensePairRerankResult {
        applied: true,
        failure_notes,
    })
}

fn truncate_chars(text: &str, max: usize) -> String {
    let chars: String = text.chars().take(max).collect();
    chars.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge_chat::types::{KcChunkRecord, KcRetrievalMode};

    #[test]
    fn nomic_query_and_document_prefixes_match_index_format() {
        let profile = EmbeddingProfileId::NomicV15;
        let query = format_query_text(profile, "vpn brute force triage");
        assert!(query.starts_with("search_query: "));
        let indexed = format_chunk_for_dense_index(
            profile,
            "sop.md",
            "VPN Triage",
            "Procedure",
            "parent",
            "escalate to tier 2",
        );
        assert!(indexed.starts_with("search_document: "));
        assert!(indexed.contains("Procedure"));

        let hit = sample_hit("sop.md", 0.5);
        let rerank_doc = format_document_text(profile, &hit);
        assert_eq!(
            rerank_doc,
            format_chunk_for_dense_index(
                profile,
                "sop.md",
                "sop.md",
                "sop.md",
                "content for sop.md",
                "content for sop.md"
            )
        );
    }

    #[test]
    fn bge_m3_documents_have_no_prefix() {
        let profile = EmbeddingProfileId::BgeM3;
        assert_eq!(format_query_text(profile, "vpn triage"), "vpn triage");
        let indexed =
            format_chunk_for_dense_index(profile, "a.md", "Title", "Section", "parent", "child");
        assert!(!indexed.starts_with("search_document: "));
        assert!(indexed.starts_with("a.md | Title | Section | "));
    }

    #[test]
    fn dense_rerank_reorders_hits() {
        let mut hits = vec![sample_hit("a", 0.2), sample_hit("b", 0.19)];
        apply_dense_rerank_scores(&mut hits, &[0.1, 0.95], 0.52, 0.48);
        assert_eq!(hits[0].chunk.file_name, "b");
    }

    fn sample_hit(name: &str, fused: f64) -> KcSearchHit {
        KcSearchHit {
            chunk: KcChunkRecord {
                id: name.to_string(),
                collection_id: "c".to_string(),
                file_id: "f".to_string(),
                file_name: name.to_string(),
                file_path: format!("/{name}"),
                chunk_index: 0,
                title: name.to_string(),
                start_char: 0,
                end_char: 10,
                text: format!("content for {name}"),
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
}
