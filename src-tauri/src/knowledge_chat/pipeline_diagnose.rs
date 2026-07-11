//! Culprit attribution from a completed [`KcPipelineTrace`].
//! Pure rules — no I/O, no config mutation.

use crate::knowledge_chat::pipeline_trace::{KcPipelineTrace, KcStageStatus};

/// Attach primary culprit + remediation actions onto an existing trace.
pub fn diagnose(
    trace: &mut KcPipelineTrace,
    confidence: &str,
    hit_count: usize,
) {
    let (culprit, summary, actions) = infer(trace, confidence, hit_count);
    trace.primary_culprit_stage = culprit;
    trace.diagnosis_summary = Some(summary);
    trace.diagnosis_actions = actions;
}

fn stage_status<'a>(trace: &'a KcPipelineTrace, id: &str) -> Option<&'a KcStageStatus> {
    trace.stages.iter().find(|s| s.id == id).map(|s| &s.status)
}

fn stage_detail(trace: &KcPipelineTrace, id: &str) -> String {
    trace
        .stages
        .iter()
        .find(|s| s.id == id)
        .map(|s| s.detail.clone())
        .unwrap_or_default()
}

fn infer(
    trace: &KcPipelineTrace,
    confidence: &str,
    hit_count: usize,
) -> (Option<String>, String, Vec<String>) {
    // Prefer explicit failures in critical retrieval stages.
    for id in [
        "embed",
        "llama_rank",
        "dense_pair_rerank",
        "dense",
        "fts",
        "scope_resolve",
    ] {
        if matches!(stage_status(trace, id), Some(KcStageStatus::Failed)) {
            let detail = stage_detail(trace, id);
            let (summary, actions) = remediation_for(id, &detail, confidence, hit_count);
            return (Some(id.to_string()), summary, actions);
        }
    }

    for id in [
        "embed",
        "llama_rank",
        "dense_pair_rerank",
        "dense",
        "onnx_or_phrase_rerank",
        "crag",
        "llm",
    ] {
        if matches!(stage_status(trace, id), Some(KcStageStatus::Degraded)) {
            let detail = stage_detail(trace, id);
            let (summary, actions) = remediation_for(id, &detail, confidence, hit_count);
            return (Some(id.to_string()), summary, actions);
        }
    }

    if hit_count == 0 || confidence == "none" || confidence == "low" {
        if matches!(stage_status(trace, "scope_resolve"), Some(KcStageStatus::Ok | KcStageStatus::Degraded))
            && stage_detail(trace, "scope_resolve").to_lowercase().contains("widen")
        {
            return (
                Some("scope_resolve".into()),
                "Search returned weak or empty hits even after scope adjustment.".into(),
                vec![
                    "Confirm the answer exists in the indexed folder.".into(),
                    "Rebuild the collection index if files were added recently.".into(),
                    "Use All partitions if Auto/manual scope still misses content.".into(),
                ],
            );
        }
        return (
            Some("retrieval".into()),
            "Retrieval confidence is low or no hits were returned.".into(),
            vec![
                "Widen search scope to All partitions.".into(),
                "Rebuild dense index and verify embedder GGUF in Collection Health.".into(),
                "Check that the relevant files were not skipped as meta/test files.".into(),
            ],
        );
    }

    if matches!(stage_status(trace, "extractive"), Some(KcStageStatus::Skipped))
        && matches!(stage_status(trace, "llm"), Some(KcStageStatus::Ok | KcStageStatus::Degraded))
    {
        return (
            Some("llm".into()),
            "Answer relied on LLM synthesis without a strong extractive match.".into(),
            vec![
                "Prefer a stronger chat model for multi-hop or open-ended questions.".into(),
                "Ensure Tree-sitter entities / docs cover the asked symbols.".into(),
            ],
        );
    }

    if matches!(stage_status(trace, "extractive"), Some(KcStageStatus::Ok))
        || matches!(stage_status(trace, "structured"), Some(KcStageStatus::Ok))
    {
        return (
            None,
            "Pipeline healthy: grounded extractive/structured answer path succeeded.".into(),
            Vec::new(),
        );
    }

    (
        None,
        "No single failing stage; review stage list for degraded steps.".into(),
        Vec::new(),
    )
}

fn remediation_for(
    id: &str,
    detail: &str,
    _confidence: &str,
    hit_count: usize,
) -> (String, Vec<String>) {
    match id {
        "embed" => (
            format!("Query embedding stage failed or degraded. {detail}"),
            vec![
                "Verify code/docs embedding GGUFs under models/embeddings.".into(),
                "Confirm llama-server runtime is available (Collection Health).".into(),
                "Rebuild the collection after placing models.".into(),
            ],
        ),
        "llama_rank" => (
            format!("Qwen3 / llama.cpp RANK rerank failed or was skipped. {detail}"),
            vec![
                "Place Qwen3-Reranker-4B-*.gguf under models/rerankers.".into(),
                "Use a RANK-capable GGUF (official convert); community builds may lack cls.output.weight.".into(),
                "Check Collection Health for llama_rerank_configured and free VRAM/RAM.".into(),
            ],
        ),
        "dense_pair_rerank" => (
            format!("Dense-pair rerank did not apply. {detail}"),
            vec![
                "Ensure dense vectors exist (rebuild index).".into(),
                "Check embed server errors in stage detail.".into(),
                if hit_count == 0 {
                    "No hits to rerank — fix retrieval/scope first.".into()
                } else {
                    "Retry the question; transient embed failures are retried once.".into()
                },
            ],
        ),
        "dense" => (
            format!("Dense retrieval degraded. {detail}"),
            vec![
                "Rebuild dense vectors for this collection.".into(),
                "Confirm partition embed models resolve in Collection Health.".into(),
            ],
        ),
        "fts" => (
            format!("Full-text search degraded. {detail}"),
            vec!["Rebuild the collection so FTS is populated.".into()],
        ),
        "scope_resolve" => (
            format!("Search scope may have limited results. {detail}"),
            vec![
                "Use All partitions or trust auto-widen for docs/process questions.".into(),
                "Avoid Code-only for documentation questions.".into(),
            ],
        ),
        "llm" => (
            format!("LLM synthesis was weak or ungrounded. {detail}"),
            vec![
                "Use a stronger chat model for synthesis-heavy questions.".into(),
                "Prefer extractive answers when symbol evidence exists.".into(),
            ],
        ),
        other => (
            format!("Stage `{other}` reported a problem. {detail}"),
            vec!["Open Pipeline diagnostics for this answer and inspect stage detail.".into()],
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge_chat::pipeline_trace::{stage, KcStageStatus};

    #[test]
    fn llama_rank_failure_is_primary_culprit() {
        let mut t = KcPipelineTrace::default();
        t.push(stage("embed", KcStageStatus::Ok, 10, "", ""));
        t.push(stage(
            "llama_rank",
            KcStageStatus::Failed,
            5,
            "server start failed",
            "",
        ));
        diagnose(&mut t, "medium", 5);
        assert_eq!(t.primary_culprit_stage.as_deref(), Some("llama_rank"));
        assert!(!t.diagnosis_actions.is_empty());
    }

    #[test]
    fn extractive_ok_has_no_culprit() {
        let mut t = KcPipelineTrace::default();
        t.push(stage("embed", KcStageStatus::Ok, 1, "", ""));
        t.push(stage("extractive", KcStageStatus::Ok, 1, "", ""));
        diagnose(&mut t, "high", 3);
        assert!(t.primary_culprit_stage.is_none());
    }
}
