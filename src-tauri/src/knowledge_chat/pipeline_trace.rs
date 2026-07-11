//! Per-question pipeline stage traces (additive observability).
//!
//! Stages record status/timing/detail/remediation plus truncated input/output
//! snapshots so each node can be evaluated independently.

use serde::{Deserialize, Serialize};
use std::time::Instant;

/// Cap per field so message metadata / audit stay bounded.
pub const MAX_IO_CHARS: usize = 1800;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum KcStageStatus {
    #[default]
    Ok,
    Skipped,
    Degraded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KcStageTrace {
    pub id: String,
    pub status: KcStageStatus,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub remediation: String,
    /// Truncated snapshot of what this stage received.
    #[serde(default)]
    pub input: String,
    /// Truncated snapshot of what this stage produced.
    #[serde(default)]
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KcPipelineTrace {
    #[serde(default)]
    pub stages: Vec<KcStageTrace>,
    #[serde(default)]
    pub winning_answer_stage: Option<String>,
    #[serde(default)]
    pub corrective_used: bool,
    #[serde(default)]
    pub overall_status: KcStageStatus,
    #[serde(default)]
    pub primary_culprit_stage: Option<String>,
    #[serde(default)]
    pub diagnosis_summary: Option<String>,
    #[serde(default)]
    pub diagnosis_actions: Vec<String>,
}

impl KcPipelineTrace {
    pub fn push(&mut self, stage: KcStageTrace) {
        self.stages.push(stage);
        self.recompute_overall();
    }

    pub fn recompute_overall(&mut self) {
        self.overall_status = if self.stages.iter().any(|s| s.status == KcStageStatus::Failed) {
            KcStageStatus::Failed
        } else if self.stages.iter().any(|s| s.status == KcStageStatus::Degraded) {
            KcStageStatus::Degraded
        } else if self.stages.is_empty() {
            KcStageStatus::Skipped
        } else {
            KcStageStatus::Ok
        };
    }

    pub fn summary_for_audit(&self) -> String {
        let parts: Vec<String> = self
            .stages
            .iter()
            .map(|s| format!("{}:{:?}:{}ms", s.id, s.status, s.duration_ms))
            .collect();
        let culprit = self.primary_culprit_stage.as_deref().unwrap_or("-");
        format!(
            "overall={:?}; culprit={}; stages=[{}]",
            self.overall_status,
            culprit,
            parts.join(", ")
        )
    }
}

pub fn truncate_io(text: impl AsRef<str>) -> String {
    let s = text.as_ref();
    if s.chars().count() <= MAX_IO_CHARS {
        return s.to_string();
    }
    let truncated: String = s.chars().take(MAX_IO_CHARS).collect();
    format!("{truncated}… [truncated]")
}

pub fn stage(
    id: &str,
    status: KcStageStatus,
    duration_ms: u64,
    detail: impl Into<String>,
    remediation: impl Into<String>,
) -> KcStageTrace {
    stage_io(id, status, duration_ms, detail, remediation, "", "")
}

pub fn stage_io(
    id: &str,
    status: KcStageStatus,
    duration_ms: u64,
    detail: impl Into<String>,
    remediation: impl Into<String>,
    input: impl Into<String>,
    output: impl Into<String>,
) -> KcStageTrace {
    KcStageTrace {
        id: id.to_string(),
        status,
        duration_ms,
        detail: detail.into(),
        remediation: remediation.into(),
        input: truncate_io(input.into()),
        output: truncate_io(output.into()),
    }
}

/// Compact top-hit summary for stage outputs (file + score).
pub fn summarize_hits(hits: &[crate::knowledge_chat::types::KcSearchHit], limit: usize) -> String {
    if hits.is_empty() {
        return "hits=[]".to_string();
    }
    let rows: Vec<String> = hits
        .iter()
        .take(limit)
        .map(|h| {
            format!(
                "#{} {} score={:.3} conf={:.2}",
                h.rank,
                h.chunk.file_name,
                h.fused_score,
                h.chunk.source_confidence.unwrap_or(0.0)
            )
        })
        .collect();
    format!("hits={} top=[{}]", hits.len(), rows.join("; "))
}

pub struct StageTimer {
    start: Instant,
}

impl StageTimer {
    pub fn start() -> Self {
        Self {
            start: Instant::now(),
        }
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overall_prefers_failed_over_degraded() {
        let mut t = KcPipelineTrace::default();
        t.push(stage("a", KcStageStatus::Degraded, 1, "", ""));
        t.push(stage("b", KcStageStatus::Failed, 2, "", ""));
        assert_eq!(t.overall_status, KcStageStatus::Failed);
    }

    #[test]
    fn truncates_long_io() {
        let long = "x".repeat(MAX_IO_CHARS + 50);
        let s = stage_io("t", KcStageStatus::Ok, 1, "", "", &long, "out");
        assert!(s.input.contains("[truncated]"));
        assert_eq!(s.output, "out");
        assert!(s.input.chars().count() <= MAX_IO_CHARS + "… [truncated]".chars().count());
    }

    #[test]
    fn summarize_hits_empty() {
        assert_eq!(summarize_hits(&[], 5), "hits=[]");
    }

    #[test]
    fn summarize_hits_includes_top_files() {
        use crate::knowledge_chat::types::{KcChunkRecord, KcRetrievalMode, KcSearchHit};

        let hit = |rank: usize, file: &str, score: f64| KcSearchHit {
            chunk: KcChunkRecord {
                id: format!("c{rank}"),
                collection_id: "col".into(),
                file_id: format!("f{rank}"),
                file_name: file.into(),
                file_path: file.into(),
                chunk_index: 0,
                title: file.into(),
                start_char: 0,
                end_char: 4,
                text: "body".into(),
                top_terms: vec![],
                has_dense: false,
                parent_text: None,
                section_path: None,
                doc_type: None,
                partition_id: Some("code".into()),
                context_text: None,
                line_start: Some(1),
                line_end: Some(2),
                page_start: None,
                page_end: None,
                source_type: "chunk".into(),
                entity_kind: None,
                entity_name: None,
                source_confidence: Some(0.8),
                parse_mode: None,
            },
            retrieval_mode: KcRetrievalMode::HybridDense,
            keyword_score: 0.0,
            lexical_score: 0.0,
            dense_score: 0.0,
            fts_score: 0.0,
            rerank_score: score,
            fused_score: score,
            rank,
            relevant_snippet: None,
        };

        let hits = vec![hit(1, "a.rs", 0.9), hit(2, "b.md", 0.5)];
        let summary = summarize_hits(&hits, 1);
        assert!(summary.starts_with("hits=2"));
        assert!(summary.contains("a.rs"));
        assert!(!summary.contains("b.md"));
    }

    #[test]
    fn stage_io_serde_roundtrip_preserves_input_output() {
        let s = stage_io(
            "rrf",
            KcStageStatus::Ok,
            12,
            "detail",
            "fix",
            "in-query",
            "out-hits",
        );
        let json = serde_json::to_string(&s).expect("serialize");
        let back: KcStageTrace = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.input, "in-query");
        assert_eq!(back.output, "out-hits");
        assert_eq!(back.id, "rrf");
    }
}
