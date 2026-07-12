//! Shared async orchestration for partition-aware retrieval.
//!
//! Both the live search command and the eval harness embed the query once per
//! active partition (using that partition's model + profile) and rerank hits
//! per partition. This module centralizes that logic so the two paths stay in
//! lockstep.

use crate::deployment::DeploymentConfig;
use crate::knowledge_chat::dense_rerank::PartitionRerankModel;
use crate::knowledge_chat::embedding_profiles::{self, EmbeddingProfileId};
use crate::knowledge_chat::embeddings;
use crate::knowledge_chat::path_guard;
use crate::knowledge_chat::partitions::KcSearchScope;
use crate::knowledge_chat::query_intent::{
    classify_query_intent, is_code_oriented_intent, is_code_symbol_question, QueryIntent,
};
use crate::knowledge_chat::remote_embeddings::{self, RemoteEmbedConfig};
use crate::knowledge_chat::runtime::KcEmbedPool;
use crate::knowledge_chat::types::KcPartitionConfig;
use std::sync::Arc;

/// Resolve the effective scope, defaulting to `both` when the caller did not
/// specify one (keeps SOC/eval callers at full coverage).
pub fn resolve_scope(request_scope: Option<KcSearchScope>) -> KcSearchScope {
    request_scope.unwrap_or_default()
}

/// Accuracy-first: if the user narrowed scope in a way that cannot answer the
/// query intent (e.g. Code-only + onboarding timeline), widen to all partitions.
/// Returns `(effective_scope, optional_user_notice)`.
pub fn resolve_scope_for_accuracy(
    request_scope: Option<KcSearchScope>,
    query: &str,
) -> (KcSearchScope, Option<String>) {
    resolve_scope_for_accuracy_with_intent(request_scope, query, None)
}

/// Same as [`resolve_scope_for_accuracy`], but honors an optional Stage-A intent override.
pub fn resolve_scope_for_accuracy_with_intent(
    request_scope: Option<KcSearchScope>,
    query: &str,
    intent_override: Option<QueryIntent>,
) -> (KcSearchScope, Option<String>) {
    let requested = resolve_scope(request_scope);
    let intent = intent_override.unwrap_or_else(|| classify_query_intent(query));
    let q = query.to_lowercase();

    let needs_non_code = matches!(
        intent,
        QueryIntent::Timeline | QueryIntent::RunbookStep | QueryIntent::ErrorCode
    ) || (matches!(intent, QueryIntent::General) && !is_code_symbol_question(&q));

    let needs_code = is_code_oriented_intent(intent);

    if needs_non_code && matches!(requested, KcSearchScope::Code) {
        return (
            KcSearchScope::All,
            Some(
                "Widened search scope from code-only to all partitions (question looks like docs/process)."
                    .to_string(),
            ),
        );
    }

    if needs_code
        && matches!(
            requested,
            KcSearchScope::Documentation
                | KcSearchScope::Docs
                | KcSearchScope::Runbooks
                | KcSearchScope::LogsData
                | KcSearchScope::General
        )
    {
        return (
            KcSearchScope::All,
            Some(
                "Widened search scope to all partitions (question looks like code/config)."
                    .to_string(),
            ),
        );
    }

    (requested, None)
}

pub struct PartitionQueryEmbeddings {
    /// (partition_id, query_vector) for each successfully embedded partition.
    pub vectors: Vec<(String, Vec<f32>)>,
    /// (partition_id, resolved_model_path) for diagnostics/answer metadata.
    pub models_used: Vec<(String, String)>,
    /// All partitions in scope that had a resolvable model (searched).
    pub partitions_searched: Vec<String>,
}

/// Embed the retrieval query once per active partition with that partition's
/// model + profile. Partitions whose model cannot be resolved are skipped.
pub async fn embed_partition_query_vectors(
    pool: &Arc<KcEmbedPool>,
    deploy: &DeploymentConfig,
    partition_config: &KcPartitionConfig,
    remote: Option<&RemoteEmbedConfig>,
    scope: KcSearchScope,
    query_source: &str,
) -> PartitionQueryEmbeddings {
    let mut out = PartitionQueryEmbeddings {
        vectors: Vec::new(),
        models_used: Vec::new(),
        partitions_searched: Vec::new(),
    };

    for partition in scope.partitions() {
        let Some(cfg) = partition_config.model_for(partition) else {
            continue;
        };
        let resolved = embeddings::try_resolve_embedding_model_path(
            &cfg.embedding_model_path,
            Some(&deploy.models_dir),
        )
        .unwrap_or_default();
        if resolved.is_empty() || !path_guard::is_usable_embedding_model_path(deploy, &resolved) {
            continue;
        }

        out.partitions_searched.push(partition.as_str().to_string());
        let profile = EmbeddingProfileId::from_value(&cfg.profile_id);
        let text = embedding_profiles::format_query(profile, query_source);
        match remote_embeddings::embed_partition_texts(
            remote,
            partition,
            pool.as_ref(),
            &resolved,
            embedding_profiles::context_size_for(profile),
            512,
            vec![text],
        )
        .await
        {
            Ok(vectors) => {
                if let Some(vector) = vectors.into_iter().next() {
                    if !vector.is_empty() {
                        let label = remote
                            .and_then(|r| r.model_for(partition))
                            .map(|id| format!("organization:{id}"))
                            .unwrap_or_else(|| resolved.clone());
                        out.vectors.push((partition.as_str().to_string(), vector));
                        out.models_used.push((partition.as_str().to_string(), label));
                    }
                }
            }
            Err(err) => {
                log::warn!(
                    "Query embedding failed for {} partition ({}): {err}",
                    partition.as_str(),
                    resolved
                );
            }
        }
    }

    out
}

/// Build the per-partition rerank model list for the active scope.
pub fn partition_rerank_models(
    partition_config: &KcPartitionConfig,
    deploy: &DeploymentConfig,
    scope: KcSearchScope,
) -> Vec<PartitionRerankModel> {
    let mut out = Vec::new();
    for partition in scope.partitions() {
        let Some(cfg) = partition_config.model_for(partition) else {
            continue;
        };
        let resolved = embeddings::try_resolve_embedding_model_path(
            &cfg.embedding_model_path,
            Some(&deploy.models_dir),
        )
        .unwrap_or_default();
        if resolved.is_empty() || !path_guard::is_usable_embedding_model_path(deploy, &resolved) {
            continue;
        }
        out.push(PartitionRerankModel {
            partition,
            model_path: resolved,
            profile: EmbeddingProfileId::from_value(&cfg.profile_id),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge_chat::partitions::KcSearchScope;

    #[test]
    fn widens_code_only_for_onboarding_timeline() {
        let (scope, notice) = resolve_scope_for_accuracy(
            Some(KcSearchScope::Code),
            "How long does new-hire onboarding take?",
        );
        assert_eq!(scope, KcSearchScope::All);
        assert!(notice.unwrap().contains("Widened"));
    }

    #[test]
    fn keeps_code_scope_for_symbol_questions() {
        let (scope, notice) = resolve_scope_for_accuracy(
            Some(KcSearchScope::Code),
            "What does handleSend do in ChatView.tsx?",
        );
        assert_eq!(scope, KcSearchScope::Code);
        assert!(notice.is_none());
    }

    #[test]
    fn widens_docs_only_for_code_symbol() {
        let (scope, notice) = resolve_scope_for_accuracy(
            Some(KcSearchScope::Documentation),
            "What does handleSend do in ChatView.tsx?",
        );
        assert_eq!(scope, KcSearchScope::All);
        assert!(notice.unwrap().contains("Widened"));
    }
}
