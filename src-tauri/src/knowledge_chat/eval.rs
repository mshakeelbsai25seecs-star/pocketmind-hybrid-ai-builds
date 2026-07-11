use crate::database::Database;
use crate::deployment::DeploymentConfig;
use crate::error::AppResult;
use crate::knowledge_chat::db;
use crate::knowledge_chat::dense_rerank;
use crate::knowledge_chat::eval_cases::{default_eval_mode, eval_cases_for_mode};
use crate::knowledge_chat::partitions::KcSearchScope;
use crate::knowledge_chat::path_guard::load_deployment;
use crate::knowledge_chat::pipeline;
use crate::knowledge_chat::query_rewrite::{hyde_retrieval_query, rewrite_for_retrieval};
use crate::knowledge_chat::runtime::KcEmbedPool;
use crate::knowledge_chat::search;
use crate::knowledge_chat::types::{
    KcEvalCase, KcEvalCaseResult, KcEvalMode, KcEvalResult, KcRetrievalMode, KcSearchRequest,
};
use crate::product;
use std::sync::Arc;
use tokio::sync::Mutex;

pub fn default_eval_cases(folder_agnostic: bool) -> Vec<KcEvalCase> {
    eval_cases_for_mode(default_eval_mode(folder_agnostic))
}

pub async fn run_eval(
    db: Arc<Mutex<Database>>,
    embed_pool: Arc<KcEmbedPool>,
    rerank_pool: Arc<crate::knowledge_chat::llama_rerank::KcRerankPool>,
    collection_id: &str,
    cases: Option<Vec<KcEvalCase>>,
    top_k: Option<usize>,
    eval_mode: Option<KcEvalMode>,
    production_parity: Option<bool>,
) -> AppResult<KcEvalResult> {
    let (product, deploy, mode, eval_cases) = {
        let guard = db.lock().await;
        let product = product::load_product_config(&guard);
        let deploy = load_deployment(&guard);
        let mode = eval_mode.unwrap_or_else(|| default_eval_mode(product.folder_agnostic_mode));
        let eval_cases = cases.unwrap_or_else(|| eval_cases_for_mode(mode.clone()));
        (product, deploy, mode, eval_cases)
    };

    let production = production_parity.unwrap_or(true);
    // Accuracy-first: wider default pool for eval (matches interactive quality).
    let top_k = top_k.unwrap_or(12).clamp(1, 40);

    let mut results = Vec::new();
    let mut passed = 0usize;
    let mut recall_sum = 0.0f64;
    let mut term_sum = 0.0f64;
    let mut precision_sum = 0.0f64;
    let mut faithfulness_sum = 0.0f64;
    let mut mrr_sum = 0.0f64;
    let mut mrr_count = 0usize;

    for case in &eval_cases {
        let scope = case.search_scope.unwrap_or(KcSearchScope::Both);
        let search = if production {
            run_production_search(
                db.clone(),
                embed_pool.clone(),
                rerank_pool.clone(),
                &deploy,
                collection_id,
                &case.question,
                top_k,
                product.enable_hyde,
                scope,
            )
            .await?
        } else {
            let guard = db.lock().await;
            search::hybrid_search(
                &guard,
                KcSearchRequest {
                    collection_id: collection_id.to_string(),
                    query: case.question.clone(),
                    mode: KcRetrievalMode::HybridDense,
                    top_k: Some(top_k),
                    query_dense_vector: None,
                    filters: None,
                    search_scope: Some(scope),
                    partition_query_vectors: Vec::new(),
                },
            )?
        };

        let top_file = search.hits.first().map(|hit| hit.chunk.file_name.clone());
        let hit_files: Vec<String> = search
            .hits
            .iter()
            .map(|hit| hit.chunk.file_name.to_lowercase())
            .collect();

        let recall_at_k = if case.expected_files.is_empty() {
            if search.hits.is_empty() {
                0.0
            } else {
                1.0
            }
        } else {
            let matched = case.expected_files.iter().any(|expected| {
                hit_files
                    .iter()
                    .any(|name| name.contains(&expected.to_lowercase()))
            });
            if matched { 1.0 } else { 0.0 }
        };

        let mrr = if case.expected_files.is_empty() {
            None
        } else {
            let rank = case.expected_files.iter().find_map(|expected| {
                let needle = expected.to_lowercase();
                hit_files
                    .iter()
                    .position(|name| name.contains(&needle))
                    .map(|pos| pos + 1)
            });
            rank.map(|r| 1.0 / r as f64)
        };
        if let Some(value) = mrr {
            mrr_sum += value;
            mrr_count += 1;
        }

        let joined = search
            .hits
            .iter()
            .map(|hit| {
                hit.relevant_snippet
                    .clone()
                    .or_else(|| hit.chunk.context_text.clone())
                    .unwrap_or_else(|| hit.chunk.text.clone())
            })
            .collect::<Vec<_>>()
            .join("\n")
            .to_lowercase();
        let term_hits = case
            .expected_terms
            .iter()
            .filter(|term| joined.contains(&term.to_lowercase()))
            .count();
        let term_hit_rate = if case.expected_terms.is_empty() {
            1.0
        } else {
            term_hits as f64 / case.expected_terms.len() as f64
        };

        let context_precision_at_k =
            context_precision_at_k(&case.expected_files, &hit_files, search.hits.len());
        let lexical_faithfulness =
            lexical_faithfulness_score(&case.expected_terms, &joined);

        let case_passed = recall_at_k >= 1.0
            && term_hit_rate >= 0.34
            && !meta_pollution_failed(&case.id, &hit_files)
            && !forbidden_files_present(&case.forbidden_files, &hit_files);
        if case_passed {
            passed += 1;
        }
        recall_sum += recall_at_k;
        term_sum += term_hit_rate;
        precision_sum += context_precision_at_k;
        faithfulness_sum += lexical_faithfulness;

        results.push(KcEvalCaseResult {
            case_id: case.id.clone(),
            question: case.question.clone(),
            hit_count: search.hits.len(),
            recall_at_k,
            term_hit_rate,
            context_precision_at_k,
            lexical_faithfulness,
            mrr: mrr.unwrap_or(0.0),
            top_file,
            confidence: search.confidence.clone(),
            passed: case_passed,
        });
    }

    let cases_run = eval_cases.len();
    let mode_label = match mode {
        KcEvalMode::Generic => "generic",
        KcEvalMode::Soc => "soc",
        KcEvalMode::All => "all",
    };
    Ok(KcEvalResult {
        collection_id: collection_id.to_string(),
        eval_mode: mode_label.to_string(),
        production_parity: production,
        cases_run,
        cases_passed: passed,
        average_recall_at_k: if cases_run > 0 {
            recall_sum / cases_run as f64
        } else {
            0.0
        },
        average_term_hit_rate: if cases_run > 0 {
            term_sum / cases_run as f64
        } else {
            0.0
        },
        average_context_precision_at_k: if cases_run > 0 {
            precision_sum / cases_run as f64
        } else {
            0.0
        },
        average_lexical_faithfulness: if cases_run > 0 {
            faithfulness_sum / cases_run as f64
        } else {
            0.0
        },
        average_mrr: if mrr_count > 0 {
            mrr_sum / mrr_count as f64
        } else {
            0.0
        },
        results,
    })
}

async fn run_production_search(
    db: Arc<Mutex<Database>>,
    embed_pool: Arc<KcEmbedPool>,
    rerank_pool: Arc<crate::knowledge_chat::llama_rerank::KcRerankPool>,
    deploy: &DeploymentConfig,
    collection_id: &str,
    question: &str,
    top_k: usize,
    enable_hyde: bool,
    scope: KcSearchScope,
) -> AppResult<crate::knowledge_chat::types::KcSearchResult> {
    let rewrite = rewrite_for_retrieval(question);
    let embed_source = if enable_hyde {
        hyde_retrieval_query(&rewrite.retrieval_query)
    } else {
        rewrite.retrieval_query.clone()
    };

    let partition_config = {
        let guard = db.lock().await;
        db::get_collection(&guard, collection_id)?.partition_config
    };

    let (scope, _) = crate::knowledge_chat::pipeline::resolve_scope_for_accuracy(Some(scope), question);

    let embeds = pipeline::embed_partition_query_vectors(
        &embed_pool,
        deploy,
        &partition_config,
        None,
        scope,
        &embed_source,
    )
    .await;

    let request = KcSearchRequest {
        collection_id: collection_id.to_string(),
        query: question.to_string(),
        mode: KcRetrievalMode::HybridDense,
        top_k: Some(top_k),
        query_dense_vector: None,
        filters: None,
        search_scope: Some(scope),
        partition_query_vectors: embeds.vectors,
    };

    let (mut pending, retrieval_config) = {
        let guard = db.lock().await;
        let cfg = crate::knowledge_chat::retrieval_config::RetrievalConfig::from_db(&guard);
        (search::hybrid_search_begin(&guard, request)?, cfg)
    };

    let dense_ready =
        pending.dense_available && !pending.request.partition_query_vectors.is_empty();

    let rerank_models = pipeline::partition_rerank_models(&partition_config, deploy, scope);
    let mut dense_pair_rerank_used = false;
    if retrieval_config.enable_dense_pair_rerank && dense_ready && !pending.hits.is_empty() {
        for _ in 0..2 {
            match dense_rerank::apply_dense_pair_rerank_partitioned(
                &embed_pool,
                &rerank_models,
                &pending.rewrite.retrieval_query,
                &mut pending.hits,
                retrieval_config.dense_pair_rerank_top_n,
                retrieval_config.dense_pair_blend_self,
                retrieval_config.dense_pair_blend_new,
            )
            .await
            {
                Ok(outcome) if outcome.applied => {
                    dense_pair_rerank_used = true;
                    break;
                }
                _ => continue,
            }
        }
    }

    // Production parity: Qwen RANK is the primary final reranker when GGUF is present.
    let mut llama_rerank_used = false;
    if retrieval_config.enable_llama_rerank && !pending.hits.is_empty() {
        let llama_path = {
            let guard = db.lock().await;
            crate::knowledge_chat::llama_rerank::resolve_llama_rerank_path(&guard)
        };
        if let Some(path) = llama_path {
            llama_rerank_used = crate::knowledge_chat::llama_rerank::apply_llama_rerank(
                &rerank_pool,
                &path,
                &pending.rewrite.retrieval_query,
                &mut pending.hits,
                retrieval_config.onnx_rerank_top_n,
                retrieval_config.onnx_blend_self,
                retrieval_config.onnx_blend_new,
            )
            .await
            .unwrap_or(false);
        }
    }

    let guard = db.lock().await;
    search::hybrid_search_complete(&guard, pending, dense_pair_rerank_used, llama_rerank_used)
}

fn forbidden_files_present(forbidden: &[String], hit_files: &[String]) -> bool {
    if forbidden.is_empty() {
        return false;
    }
    // Only the top-3 hits matter for the scope-pollution guard.
    let top: Vec<&String> = hit_files.iter().take(3).collect();
    forbidden.iter().any(|needle| {
        let needle = needle.to_lowercase();
        top.iter().any(|name| name.contains(&needle))
    })
}

fn meta_pollution_failed(case_id: &str, hit_files: &[String]) -> bool {
    if case_id != "meta-pollution-guard" {
        return false;
    }
    hit_files.iter().any(|name| {
        name.contains("test_manifest") || name.contains("test_queries")
    })
}

/// Fraction of retrieved hits whose file name matches any expected file substring.
/// When `expected_files` is empty, returns 1.0 if there is at least one hit, else 0.0.
pub fn context_precision_at_k(
    expected_files: &[String],
    hit_files: &[String],
    hit_count: usize,
) -> f64 {
    if hit_count == 0 || hit_files.is_empty() {
        return 0.0;
    }
    if expected_files.is_empty() {
        return 1.0;
    }
    let relevant = hit_files
        .iter()
        .filter(|name| {
            expected_files
                .iter()
                .any(|expected| name.contains(&expected.to_lowercase()))
        })
        .count();
    relevant as f64 / hit_files.len() as f64
}

/// Lexical faithfulness: fraction of expected answer/evidence terms present in retrieved text.
pub fn lexical_faithfulness_score(expected_terms: &[String], joined_context_lower: &str) -> f64 {
    if expected_terms.is_empty() {
        return 1.0;
    }
    let supported = expected_terms
        .iter()
        .filter(|term| joined_context_lower.contains(&term.to_lowercase()))
        .count();
    supported as f64 / expected_terms.len() as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_precision_counts_relevant_files() {
        let expected = vec!["KnowledgeChatPanel.tsx".into(), "answerPipeline.ts".into()];
        let hits = vec![
            "knowledgechatpanel.tsx".into(),
            "unrelated.md".into(),
            "answerpipeline.ts".into(),
            "noise.rs".into(),
        ];
        let score = context_precision_at_k(&expected, &hits, hits.len());
        assert!((score - 0.5).abs() < 1e-9);
    }

    #[test]
    fn context_precision_empty_expected_with_hits() {
        assert_eq!(context_precision_at_k(&[], &["a.ts".into()], 1), 1.0);
        assert_eq!(context_precision_at_k(&[], &[], 0), 0.0);
    }

    #[test]
    fn lexical_faithfulness_scores_supported_terms() {
        let terms = vec!["handleSend".into(), "kcHybridSearch".into(), "missingTerm".into()];
        let ctx = "function handlesend() { await kchybridsearch(...) }";
        let score = lexical_faithfulness_score(&terms, ctx);
        assert!((score - 2.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn lexical_faithfulness_empty_terms() {
        assert_eq!(lexical_faithfulness_score(&[], "anything"), 1.0);
    }
}
