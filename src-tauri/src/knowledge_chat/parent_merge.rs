//! Sibling child → parent auto-merge for Knowledge Chat retrieval.
//!
//! Search ranks precise child chunks; when ≥2 hits share the same parent body,
//! collapse them into one hit whose text/context is the full parent so the LLM
//! (or extractive path) sees wider context without duplicate siblings.

use std::collections::HashMap;

use crate::knowledge_chat::types::KcSearchHit;

/// Minimum sibling children that must share a parent before merging.
const MIN_SIBLINGS_TO_MERGE: usize = 2;

/// Collapse sibling child hits that share the same `(file_id, parent_text)` into
/// a single parent-sized hit. Returns `(merged_hits, merge_applied)`.
pub fn auto_merge_parent_hits(hits: &[KcSearchHit]) -> (Vec<KcSearchHit>, bool) {
    if hits.len() < MIN_SIBLINGS_TO_MERGE {
        return (hits.to_vec(), false);
    }

    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, hit) in hits.iter().enumerate() {
        let key = parent_group_key(hit);
        groups.entry(key).or_default().push(idx);
    }

    let mut merge_applied = false;
    let mut consumed = vec![false; hits.len()];
    let mut out: Vec<KcSearchHit> = Vec::with_capacity(hits.len());

    // Preserve original rank order: walk hits in order, emit merged or singleton.
    for (idx, hit) in hits.iter().enumerate() {
        if consumed[idx] {
            continue;
        }
        let key = parent_group_key(hit);
        let Some(members) = groups.get(&key) else {
            out.push(hit.clone());
            continue;
        };
        if members.len() < MIN_SIBLINGS_TO_MERGE || !has_usable_parent(hit) {
            out.push(hit.clone());
            continue;
        }

        merge_applied = true;
        let mut best = hit.clone();
        for &member_idx in members {
            consumed[member_idx] = true;
            let sibling = &hits[member_idx];
            if sibling.rerank_score > best.rerank_score
                || (sibling.rerank_score == best.rerank_score
                    && sibling.fused_score > best.fused_score)
            {
                best = sibling.clone();
            }
            // Expand line range across siblings.
            let ls = sibling.chunk.line_start.or(best.chunk.line_start);
            let le = sibling.chunk.line_end.or(best.chunk.line_end);
            if let (Some(a), Some(b)) = (best.chunk.line_start, ls) {
                best.chunk.line_start = Some(a.min(b));
            } else {
                best.chunk.line_start = ls.or(best.chunk.line_start);
            }
            if let (Some(a), Some(b)) = (best.chunk.line_end, le) {
                best.chunk.line_end = Some(a.max(b));
            } else {
                best.chunk.line_end = le.or(best.chunk.line_end);
            }
        }

        let parent = best
            .chunk
            .parent_text
            .clone()
            .filter(|p| p.trim().len() > best.chunk.text.trim().len())
            .or_else(|| best.chunk.context_text.clone())
            .unwrap_or_else(|| best.chunk.text.clone());
        best.chunk.text = parent.clone();
        best.chunk.context_text = Some(parent);
        best.chunk.source_type = "parent_merged".to_string();
        out.push(best);
    }

    for (rank, hit) in out.iter_mut().enumerate() {
        hit.rank = rank + 1;
    }
    (out, merge_applied)
}

fn has_usable_parent(hit: &KcSearchHit) -> bool {
    hit.chunk
        .parent_text
        .as_deref()
        .map(|p| p.trim().len() > hit.chunk.text.trim().len())
        .unwrap_or(false)
}

fn parent_group_key(hit: &KcSearchHit) -> String {
    let parent = hit
        .chunk
        .parent_text
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .unwrap_or("");
    if parent.is_empty() {
        // No parent → unique key so the hit never merges.
        return format!("{}::chunk::{}", hit.chunk.file_id, hit.chunk.id);
    }
    // Fingerprint: file + first/last chars of parent (stable, cheap).
    let head: String = parent.chars().take(64).collect();
    let tail: String = parent
        .chars()
        .rev()
        .take(32)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("{}::{}::{}::{}", hit.chunk.file_id, parent.len(), head, tail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge_chat::types::{KcChunkRecord, KcRetrievalMode, KcSearchHit};

    fn child_hit(id: &str, file_id: &str, text: &str, parent: &str, score: f64) -> KcSearchHit {
        KcSearchHit {
            chunk: KcChunkRecord {
                id: id.to_string(),
                collection_id: "c".to_string(),
                file_id: file_id.to_string(),
                file_name: "doc.md".to_string(),
                file_path: "/docs/doc.md".to_string(),
                chunk_index: 0,
                title: id.to_string(),
                start_char: 0,
                end_char: text.len() as i64,
                text: text.to_string(),
                top_terms: vec![],
                has_dense: false,
                parent_text: Some(parent.to_string()),
                section_path: Some("Section".to_string()),
                doc_type: Some("markdown".to_string()),
                partition_id: Some("documentation".to_string()),
                context_text: Some(parent.to_string()),
                line_start: Some(1),
                line_end: Some(2),
                page_start: None,
                page_end: None,
                source_type: "chunk".to_string(),
                entity_kind: None,
                entity_name: None,
                source_confidence: Some(0.7),
                parse_mode: None,
            },
            retrieval_mode: KcRetrievalMode::HybridDense,
            keyword_score: 0.0,
            lexical_score: 0.0,
            dense_score: 0.0,
            fts_score: 0.0,
            rerank_score: score,
            fused_score: score,
            rank: 1,
            relevant_snippet: None,
        }
    }

    #[test]
    fn three_siblings_collapse_to_one_parent() {
        let parent = "Parent block with enough context for the LLM to answer accurately about the marketing budget in 2025.";
        let hits = vec![
            child_hit("c1", "f1", "budget increased by 20%", parent, 0.5),
            child_hit("c2", "f1", "marketing department limits", parent, 0.8),
            child_hit("c3", "f1", "year 2025 figures", parent, 0.6),
        ];
        let (merged, applied) = auto_merge_parent_hits(&hits);
        assert!(applied);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].chunk.source_type, "parent_merged");
        assert!(merged[0].chunk.text.contains("marketing budget"));
        assert!((merged[0].rerank_score - 0.8).abs() < 1e-9);
    }

    #[test]
    fn singleton_children_unchanged() {
        let parent_a = "Parent A is a long enough string that exceeds the child text length for merge eligibility.";
        let parent_b = "Parent B is a different long enough string that exceeds the child text length for merge.";
        let hits = vec![
            child_hit("c1", "f1", "child a", parent_a, 0.5),
            child_hit("c2", "f1", "child b", parent_b, 0.6),
        ];
        let (merged, applied) = auto_merge_parent_hits(&hits);
        assert!(!applied);
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn no_parent_text_never_merges() {
        let mut a = child_hit("c1", "f1", "same file child one with padding", "unused", 0.5);
        let mut b = child_hit("c2", "f1", "same file child two with padding", "unused", 0.6);
        a.chunk.parent_text = None;
        b.chunk.parent_text = None;
        let (merged, applied) = auto_merge_parent_hits(&[a, b]);
        assert!(!applied);
        assert_eq!(merged.len(), 2);
    }
}
