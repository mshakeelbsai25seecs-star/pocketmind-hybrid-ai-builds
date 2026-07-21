use crate::knowledge_chat::code_late_interaction::{code_maxsim_score, is_code_retrieval_record};
use crate::knowledge_chat::dense_ann;
use crate::database::Database;
use crate::error::{AppError, AppResult};
use crate::knowledge_chat::compress::{compress_text_for_query, default_snippet_chars, sanitize_retrieved_text};
use crate::knowledge_chat::db::{self, LoadedChunk};
use crate::knowledge_chat::fts;
use crate::knowledge_chat::intent_cache;
use crate::knowledge_chat::lexical::{cosine_similarity, keyword_score, query_terms};
use crate::knowledge_chat::onnx_rerank::onnx_rerank_hits;
use crate::knowledge_chat::query::decompose_query;
use crate::knowledge_chat::query_rewrite::rewrite_for_retrieval;
use crate::knowledge_chat::rerank::rerank_hits;
use crate::knowledge_chat::partitions::{KcPartitionId, KcSearchScope};
use crate::knowledge_chat::adjacent_expand::expand_adjacent_chunk_hits;
use crate::knowledge_chat::parent_merge::auto_merge_parent_hits;
use crate::knowledge_chat::filter::normalized_text_fingerprint;
use crate::knowledge_chat::retrieval_config::RetrievalConfig;
use crate::knowledge_chat::search_filters::{derive_search_filters_with_intent, filters_are_empty};
use crate::knowledge_chat::types::{
    KcAnswerMode, KcChunkRecord, KcCollectionStatus, KcIntentMatch, KcQueryRewriteResult,
    KcRetrievalConfidence, KcRetrievalMode, KcSearchFilters, KcSearchHit, KcSearchRequest, KcSearchResult,
    KC_FTS_RESULT_LIMIT,
};
use crate::knowledge_chat::context_assembly::build_grounded_context;
use crate::knowledge_chat::evidence_answer::{build_evidence_items, format_evidence_answer};
use crate::knowledge_chat::query_intent::{
    classify_query_intent, extract_error_code, extract_file_hint, is_code_oriented_intent,
    QueryIntent,
};
use crate::knowledge_chat::intent_classifier::classify_with_confidence;
use crate::knowledge_chat::source_confidence::apply_source_confidence;
use crate::knowledge_chat::structured_answer::{try_structured_answer_with_intent};
use crate::product;
use std::collections::{HashMap, HashSet};

const INTENT_SHORT_CIRCUIT_SCORE: f64 = 0.96;

pub struct HybridSearchPending {
    pub request: KcSearchRequest,
    pub query: String,
    pub rewrite: KcQueryRewriteResult,
    pub intent_match: Option<KcIntentMatch>,
    pub sub_queries: Vec<String>,
    pub top_k: usize,
    pub hits: Vec<KcSearchHit>,
    pub dense_available: bool,
    pub fts_available: bool,
    pub query_dense_ready: bool,
    /// Filters derived from the query when the client sent none.
    pub auto_filters_applied: Option<crate::knowledge_chat::types::KcSearchFilters>,
}

pub fn hybrid_search_begin(db: &Database, request: KcSearchRequest) -> AppResult<HybridSearchPending> {
    let query = request.query.trim().to_string();
    if query.is_empty() {
        return Err(AppError::Unknown("Search query cannot be empty.".to_string()));
    }

    let collection = db::get_collection(db, &request.collection_id)?;
    if collection.status != KcCollectionStatus::Ready {
        return Err(AppError::Unknown(
            "This folder is not ready yet. Scan it, then build the index before asking questions.".to_string(),
        ));
    }
    if collection.chunk_count <= 0 && collection.code_entity_count <= 0 {
        return Err(AppError::Unknown(
            "Nothing is indexed in this folder yet. Build or rebuild the index, then try again.".to_string(),
        ));
    }

    let rewrite = rewrite_for_retrieval(&query);
    let product = product::load_product_config(db);
    let intent_match = if product.folder_agnostic_mode {
        None
    } else {
        intent_cache::lookup_intent(db, &rewrite.retrieval_query)?
    };
    let query_dense_ready = request
        .partition_query_vectors
        .iter()
        .any(|(_, vector)| !vector.is_empty())
        || request
            .query_dense_vector
            .as_ref()
            .map(|vector| !vector.is_empty())
            .unwrap_or(false);

    let retrieval_query = rewrite.retrieval_query.clone();
    let sub_queries = decompose_query(&retrieval_query);
    let config = RetrievalConfig::from_db(db);
    let top_k = request.top_k.unwrap_or(12).clamp(1, 40);
    let rerank_pool = (top_k * 4).clamp(top_k, config.rerank_pool_limit);

    let mut auto_filters_applied = None;
    let mut request = request;
    if filters_are_empty(&request.filters) {
        if let Some(derived) =
            derive_search_filters_with_intent(&query, request.intent_override)
        {
            auto_filters_applied = Some(derived.clone());
            request.filters = Some(derived);
        }
    }

    let mut merged_hits: Vec<KcSearchHit> = Vec::new();

    for sub_query in &sub_queries {
        let mut partial = search_single(db, &request, sub_query, rerank_pool, config.rrf_k)?;
        merged_hits.append(&mut partial.hits);
    }

    dedupe_hits(&mut merged_hits);
    filter_meta_hits(&mut merged_hits);

    // Auto file-name filters can zero out hits on a wrong guess — retry once unfiltered.
    let mut auto_filters_applied = auto_filters_applied;
    if merged_hits.is_empty() && auto_filters_applied.is_some() {
        request.filters = None;
        auto_filters_applied = None;
        for sub_query in &sub_queries {
            let mut partial = search_single(db, &request, sub_query, rerank_pool, config.rrf_k)?;
            merged_hits.append(&mut partial.hits);
        }
        dedupe_hits(&mut merged_hits);
        filter_meta_hits(&mut merged_hits);
    }

    let fts_available = fts::fts_search(db, &request.collection_id, &retrieval_query, 1)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false);
    let dense_available = db::collection_has_dense_vectors(db, &request.collection_id)?;

    Ok(HybridSearchPending {
        request,
        query,
        rewrite,
        intent_match,
        sub_queries,
        top_k,
        hits: merged_hits,
        dense_available,
        fts_available,
        query_dense_ready,
        auto_filters_applied,
    })
}

pub fn hybrid_search_complete(
    db: &Database,
    pending: HybridSearchPending,
    dense_pair_rerank_used: bool,
    // When true, Qwen3 / llama.cpp RANK already ran; skip ONNX / phrase rerank.
    neural_rerank_already_applied: bool,
) -> AppResult<KcSearchResult> {
    if let Some(intent) = pending.intent_match.clone() {
        let product = product::load_product_config(db);
        if product.allow_intent_short_circuit && intent.score >= INTENT_SHORT_CIRCUIT_SCORE {
            return Ok(intent_short_circuit_result(pending, intent));
        }
    }

    let retrieval_query = pending.rewrite.retrieval_query.clone();
    let config = RetrievalConfig::from_db(db);
    let degradation = degradation_reasons(&pending, dense_pair_rerank_used);
    let mut hits = pending.hits;
    filter_meta_hits(&mut hits);
    // Final neural priority: Qwen RANK (already applied upstream) → ONNX → phrase.
    let onnx_reranker_used = !neural_rerank_already_applied
        && config.enable_onnx_rerank
        && onnx_rerank_hits(
            db,
            &retrieval_query,
            &mut hits,
            config.onnx_rerank_top_n,
            config.onnx_blend_self,
            config.onnx_blend_new,
        );
    if !onnx_reranker_used && !neural_rerank_already_applied {
        rerank_hits(&retrieval_query, &mut hits);
    }
    apply_relevant_snippets(&retrieval_query, &mut hits);
    apply_source_confidence(&retrieval_query, &mut hits);
    let (expanded_hits, adjacent_expand_applied) =
        expand_adjacent_chunk_hits(db, &pending.request.collection_id, &hits)?;
    hits = expanded_hits;
    let (merged_hits, parent_merge_applied) = auto_merge_parent_hits(&hits);
    hits = merged_hits;
    dedupe_near_duplicate_hits(&mut hits);
    hits.truncate(pending.top_k);
    let auto_filters_applied = pending.auto_filters_applied.clone();

    let product_cfg = product::load_product_config(db);
    let min_context = product_cfg.min_source_confidence_for_context;
    let min_generation = product_cfg.min_source_confidence_for_generation;
    let server_profile = product_cfg.knowledge_chat_deployment_profile == product::KC_DEPLOYMENT_SERVER;
    let collection = db::get_collection(db, &pending.request.collection_id)?;

    let symbol_entities = crate::knowledge_chat::codebase_explorer::symbol_entities_for_query(
        db,
        &pending.request.collection_id,
        &pending.query,
    )
    .unwrap_or_default();

    let mut grounded_context = build_grounded_context(
        &collection.name,
        &collection.root_path,
        &hits,
        &[],
        min_context,
        min_generation,
        None,
        server_profile,
    );

    if !hits.is_empty() {
        let evidence_items = build_evidence_items(&retrieval_query, &hits);
        grounded_context.evidence_answer = format_evidence_answer(&retrieval_query, &evidence_items);
        grounded_context.evidence_items = evidence_items;
    }

    let structured_answer = if !hits.is_empty() {
        // Prefer the user question over the expanded retrieval_query so intents
        // like env_var / locate stay aligned with what the user asked.
        try_structured_answer_with_intent(
            &pending.query,
            &hits,
            pending.request.intent_override,
        )
    } else {
        None
    };
    let intent_classification = if let Some(override_intent) = pending.request.intent_override {
        crate::knowledge_chat::intent_classifier::IntentClassification {
            intent: override_intent,
            confidence: 0.95,
        }
    } else {
        classify_with_confidence(&retrieval_query)
    };
    let detected_intent = intent_classification.intent;

    let (mut confidence, confidence_score, mut answer_mode) = assess_confidence(&hits);
    if structured_answer
        .as_ref()
        .map(|answer| answer.confidence >= 0.5)
        .unwrap_or(false)
    {
        answer_mode = KcAnswerMode::Found;
        if matches!(
            confidence,
            KcRetrievalConfidence::None | KcRetrievalConfidence::Low
        ) {
            confidence = KcRetrievalConfidence::Medium;
        }
    } else if grounded_context.sources.is_empty()
        && grounded_context.evidence_answer.is_some()
        && !hits.is_empty()
    {
        answer_mode = KcAnswerMode::Evidence;
        if confidence == KcRetrievalConfidence::None {
            confidence = KcRetrievalConfidence::Low;
        }
    }
    let rewrite = pending.rewrite;

    Ok(KcSearchResult {
        collection_id: pending.request.collection_id,
        query: pending.query,
        retrieval_query,
        mode: normalize_mode(
            &pending.request.mode,
            pending.dense_available,
            pending.query_dense_ready,
        ),
        hits,
        dense_available: pending.dense_available,
        fts_available: pending.fts_available,
        confidence,
        confidence_score,
        answer_mode,
        sub_queries: pending.sub_queries,
        query_rewrite: rewrite,
        intent_match: pending.intent_match,
        onnx_reranker_used,
        dense_pair_rerank_used,
        llama_rerank_used: neural_rerank_already_applied,
        degradation_reasons: degradation,
        search_scope_applied: Some(pending.request.search_scope.unwrap_or_default()),
        partitions_searched: pending
            .request
            .partition_query_vectors
            .iter()
            .map(|(p, _)| p.clone())
            .collect(),
        partition_models_used: Vec::new(),
        grounded_context: Some(grounded_context),
        structured_answer,
        detected_intent: Some(detected_intent),
        intent_confidence: Some(intent_classification.confidence),
        answer_intent: None,
        intent_source: if pending.request.intent_override.is_some() {
            Some("override".to_string())
        } else {
            Some("rules".to_string())
        },
        symbol_entities,
        parent_merge_applied,
        adjacent_expand_applied,
        auto_filters_applied,
        pipeline_trace: None,
    })
}

pub fn hybrid_search(db: &Database, request: KcSearchRequest) -> AppResult<KcSearchResult> {
    let pending = hybrid_search_begin(db, request)?;
    hybrid_search_complete(db, pending, false, false)
}

fn intent_short_circuit_result(pending: HybridSearchPending, intent: KcIntentMatch) -> KcSearchResult {
    let rewrite = pending.rewrite;
    let retrieval_query = rewrite.retrieval_query.clone();
    let auto_filters_applied = pending.auto_filters_applied.clone();
    KcSearchResult {
        collection_id: pending.request.collection_id,
        query: pending.query,
        retrieval_query,
        mode: pending.request.mode,
        hits: Vec::new(),
        dense_available: pending.dense_available,
        fts_available: pending.fts_available,
        confidence: KcRetrievalConfidence::High,
        confidence_score: intent.score,
        answer_mode: KcAnswerMode::Found,
        sub_queries: pending.sub_queries,
        query_rewrite: rewrite,
        intent_match: Some(intent),
        onnx_reranker_used: false,
        dense_pair_rerank_used: false,
        llama_rerank_used: false,
        degradation_reasons: vec!["Intent short-circuit returned a cached answer without retrieval.".to_string()],
        search_scope_applied: Some(pending.request.search_scope.unwrap_or_default()),
        partitions_searched: Vec::new(),
        partition_models_used: Vec::new(),
        grounded_context: None,
        structured_answer: None,
        detected_intent: None,
        intent_confidence: None,
        answer_intent: None,
        intent_source: None,
        symbol_entities: Vec::new(),
        parent_merge_applied: false,
        adjacent_expand_applied: false,
        auto_filters_applied,
        pipeline_trace: None,
    }
}

fn search_single(
    db: &Database,
    request: &KcSearchRequest,
    query: &str,
    top_k: usize,
    rrf_k: f64,
) -> AppResult<KcSearchResult> {
    let mut candidate_ids = std::collections::HashSet::new();

    hard_pin_candidates(db, &request.collection_id, query, &mut candidate_ids);

    if let Ok(fts_rows) = fts::fts_search_with_fallback(db, &request.collection_id, query, KC_FTS_RESULT_LIMIT) {
        for (chunk_id, _) in fts_rows {
            candidate_ids.insert(chunk_id);
        }
    }

    boost_file_candidates(db, &request.collection_id, query, &mut candidate_ids);

    let scope = request.search_scope.unwrap_or_default();
    let query_vectors = partition_query_vector_map(request);

    if !query_vectors.is_empty() {
        let _ = dense_ann::prefetch_dense_candidates_partitioned(
            db,
            &request.collection_id,
            scope,
            &request.partition_query_vectors,
            &mut candidate_ids,
        );
    }

    if candidate_ids.is_empty() {
        return Ok(empty_result(request, query));
    }

    let id_list: Vec<String> = candidate_ids.into_iter().collect();
    let mut chunks = db::load_chunks_by_ids(db, &request.collection_id, &id_list)?;
    chunks.retain(|chunk| {
        passes_scope(&chunk.record, scope) && passes_filters(&chunk.record, &request.filters)
    });
    if chunks.is_empty() {
        return Ok(empty_result(request, query));
    }

    let dense_available = !query_vectors.is_empty()
        && chunks.iter().any(|chunk| dense_score_for_chunk(chunk, &query_vectors) > 0.0);
    let query_dense_present = !query_vectors.is_empty();
    let query_term_set = query_terms(query);
    let fts_scores = fts_score_map(db, &request.collection_id, query);
    let code_scope_active = scope.contains(KcPartitionId::Code);

    let mut keyword_ranked = Vec::new();
    let mut dense_ranked = Vec::new();
    let mut fts_ranked = Vec::new();
    let mut code_maxsim_ranked = Vec::new();

    for (idx, chunk) in chunks.iter().enumerate() {
        let keyword = keyword_score(query, &chunk.record.text, &chunk.record.file_name, &chunk.record.title);
        let dense = dense_score_for_chunk(chunk, &query_vectors);
        let fts = fts_scores.get(&chunk.record.id).copied().unwrap_or(0.0);

        keyword_ranked.push((idx, keyword));
        fts_ranked.push((idx, fts));
        if dense > 0.0 {
            dense_ranked.push((idx, dense));
        }
        if code_scope_active && is_code_retrieval_record(&chunk.record) {
            let maxsim = code_maxsim_score(query, &chunk.record);
            if maxsim > 0.0 {
                code_maxsim_ranked.push((idx, maxsim * 100.0));
            }
        }
    }

    keyword_ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    fts_ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    dense_ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    code_maxsim_ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut fused_scores = vec![0.0f64; chunks.len()];
    // RRF over FTS + dense + code MaxSim; keyword feeds source_confidence only.
    accumulate_rrf(&mut fused_scores, &fts_ranked, rrf_k);
    if dense_available && query_dense_present {
        accumulate_rrf(&mut fused_scores, &dense_ranked, rrf_k);
    }
    if !code_maxsim_ranked.is_empty() {
        accumulate_rrf(&mut fused_scores, &code_maxsim_ranked, rrf_k);
    }

    for idx in 0..chunks.len() {
        let term_boost = chunks[idx]
            .record
            .top_terms
            .iter()
            .filter(|term| query_term_set.contains(*term))
            .count() as f64
            * 0.015;
        let section_boost = section_heading_boost(query, &chunks[idx].record);
        fused_scores[idx] += term_boost + section_boost;
    }

    let mut pool: Vec<usize> = (0..chunks.len()).collect();
    pool.sort_by(|a, b| {
        fused_scores[*b]
            .partial_cmp(&fused_scores[*a])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    pool.truncate((top_k * 3).max(top_k));
    let intent = request
        .intent_override
        .unwrap_or_else(|| classify_query_intent(query));
    let mmr_lambda = mmr_lambda_for_intent(intent);
    let selected = mmr_select(&pool, &chunks, &fused_scores, top_k, mmr_lambda);

    let effective_mode = normalize_mode(&request.mode, dense_available, query_dense_present);
    let mut hits = Vec::new();
    for (rank, idx) in selected.iter().enumerate() {
        let chunk = &chunks[*idx];
        let keyword = keyword_score(query, &chunk.record.text, &chunk.record.file_name, &chunk.record.title);
        let dense = dense_score_for_chunk(chunk, &query_vectors);
        let fts = fts_scores.get(&chunk.record.id).copied().unwrap_or(0.0);

        if !passes_mode_filter(effective_mode.clone(), keyword, dense, fts) {
            continue;
        }

        hits.push(KcSearchHit {
            chunk: chunk.record.clone(),
            retrieval_mode: effective_mode.clone(),
            keyword_score: keyword,
            lexical_score: fts,
            dense_score: dense,
            fts_score: fts,
            rerank_score: fused_scores[*idx],
            fused_score: fused_scores[*idx],
            rank: rank + 1,
            relevant_snippet: None,
        });
    }

    Ok(KcSearchResult {
        collection_id: request.collection_id.clone(),
        query: query.to_string(),
        retrieval_query: query.to_string(),
        mode: effective_mode,
        hits,
        dense_available,
        fts_available: !fts_scores.is_empty(),
        confidence: KcRetrievalConfidence::None,
        confidence_score: 0.0,
        answer_mode: KcAnswerMode::NotFound,
        sub_queries: vec![query.to_string()],
        query_rewrite: rewrite_for_retrieval(query),
        intent_match: None,
        onnx_reranker_used: false,
        dense_pair_rerank_used: false,
        llama_rerank_used: false,
        degradation_reasons: Vec::new(),
        search_scope_applied: Some(scope),
        partitions_searched: request
            .partition_query_vectors
            .iter()
            .map(|(p, _)| p.clone())
            .collect(),
        partition_models_used: Vec::new(),
        grounded_context: None,
        structured_answer: None,
        detected_intent: None,
        intent_confidence: None,
        answer_intent: None,
        intent_source: None,
        symbol_entities: Vec::new(),
        parent_merge_applied: false,
        adjacent_expand_applied: false,
        auto_filters_applied: None,
        pipeline_trace: None,
    })
}

fn empty_result(request: &KcSearchRequest, query: &str) -> KcSearchResult {
    let rewrite = rewrite_for_retrieval(query);
    KcSearchResult {
        collection_id: request.collection_id.clone(),
        query: query.to_string(),
        retrieval_query: rewrite.retrieval_query.clone(),
        mode: request.mode.clone(),
        hits: Vec::new(),
        dense_available: false,
        fts_available: false,
        confidence: KcRetrievalConfidence::None,
        confidence_score: 0.0,
        answer_mode: KcAnswerMode::NotFound,
        sub_queries: vec![query.to_string()],
        query_rewrite: rewrite,
        intent_match: None,
        onnx_reranker_used: false,
        dense_pair_rerank_used: false,
        llama_rerank_used: false,
        degradation_reasons: vec!["No matching chunks found.".to_string()],
        search_scope_applied: request.search_scope,
        partitions_searched: Vec::new(),
        partition_models_used: Vec::new(),
        grounded_context: None,
        structured_answer: None,
        detected_intent: None,
        intent_confidence: None,
        answer_intent: None,
        intent_source: None,
        symbol_entities: Vec::new(),
        parent_merge_applied: false,
        adjacent_expand_applied: false,
        auto_filters_applied: None,
        pipeline_trace: None,
    }
}

fn hard_pin_candidates(
    db: &Database,
    collection_id: &str,
    query: &str,
    candidates: &mut HashSet<String>,
) {
    use crate::knowledge_chat::query_intent::{extract_camel_symbols, extract_snake_case_symbols};

    // Universal: only pin from tokens present in the query (file hints, symbols, error codes).
    if let Some(code) = extract_error_code(query) {
        if let Ok(ids) = db::load_chunk_ids_containing_text(db, collection_id, &code, 24) {
            candidates.extend(ids);
        }
    }
    if let Some(file) = extract_file_hint(query) {
        if let Ok(ids) = db::load_chunk_ids_for_file_substring(db, collection_id, &file, 40) {
            candidates.extend(ids);
        }
    }
    for symbol in extract_camel_symbols(query)
        .into_iter()
        .chain(extract_snake_case_symbols(query))
    {
        if let Ok(ids) = db::load_chunk_ids_for_entity_name(db, collection_id, &symbol, 24) {
            candidates.extend(ids);
        }
        if let Ok(ids) = db::load_chunk_ids_containing_text(db, collection_id, &symbol, 16) {
            candidates.extend(ids);
        }
    }
}

fn boost_file_candidates(
    db: &Database,
    collection_id: &str,
    query: &str,
    candidates: &mut HashSet<String>,
) {
    use crate::knowledge_chat::query_intent::{extract_camel_symbols, extract_snake_case_symbols};

    // Universal: FTS inject only query-derived tokens (no corpus-specific file names).
    if let Some(code) = extract_error_code(query) {
        inject_fts_candidates(db, collection_id, &code, candidates);
    }
    if let Some(file) = extract_file_hint(query) {
        inject_fts_candidates(db, collection_id, &file, candidates);
    }
    for symbol in extract_camel_symbols(query)
        .into_iter()
        .chain(extract_snake_case_symbols(query))
    {
        if symbol.len() >= 4 {
            inject_fts_candidates(db, collection_id, &symbol, candidates);
        }
    }
    // Significant lowercase content words from the query (generic lexical boost).
    for token in query.split_whitespace() {
        let cleaned = token
            .trim_matches(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
            .to_lowercase();
        if cleaned.len() >= 5
            && ![
                "about", "which", "where", "what", "when", "does", "with", "from", "this", "that",
                "have", "should", "would", "could", "there", "their", "these", "those", "after",
                "before", "under", "over",
            ]
            .contains(&cleaned.as_str())
        {
            inject_fts_candidates(db, collection_id, &cleaned, candidates);
        }
    }
}

fn inject_fts_candidates(
    db: &Database,
    collection_id: &str,
    query: &str,
    candidates: &mut HashSet<String>,
) {
    if let Ok(rows) = fts::fts_search_with_fallback(db, collection_id, query, 30) {
        for (id, _) in rows {
            candidates.insert(id);
        }
    }
}

fn fts_score_map(
    db: &Database,
    collection_id: &str,
    query: &str,
) -> std::collections::HashMap<String, f64> {
    fts::fts_search_with_fallback(db, collection_id, query, KC_FTS_RESULT_LIMIT)
        .unwrap_or_default()
        .into_iter()
        .collect()
}

fn dedupe_hits(hits: &mut Vec<KcSearchHit>) {
    let mut seen = std::collections::HashSet::new();
    hits.retain(|hit| seen.insert(hit.chunk.id.clone()));
}

/// Collapse near-duplicate content that appears under different paths/chunk ids.
/// Tie-break with fused score, then longer evidence, then stable chunk id.
fn dedupe_near_duplicate_hits(hits: &mut Vec<KcSearchHit>) {
    if hits.len() < 2 {
        return;
    }
    let mut best_by_key: HashMap<String, usize> = HashMap::new();
    for (idx, hit) in hits.iter().enumerate() {
        let key = near_duplicate_key(hit);
        match best_by_key.get(&key).copied() {
            None => {
                best_by_key.insert(key, idx);
            }
            Some(prev) => {
                if is_better_duplicate_hit(&hits[idx], &hits[prev]) {
                    best_by_key.insert(key, idx);
                }
            }
        }
    }
    let keep: HashSet<usize> = best_by_key.values().copied().collect();
    let mut idx = 0usize;
    hits.retain(|_| {
        let retain = keep.contains(&idx);
        idx += 1;
        retain
    });
    for (rank, hit) in hits.iter_mut().enumerate() {
        hit.rank = rank + 1;
    }
}

fn near_duplicate_key(hit: &KcSearchHit) -> String {
    let fp = normalized_text_fingerprint(&hit.chunk.text);
    let basename = std::path::Path::new(&hit.chunk.file_name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&hit.chunk.file_name)
        .to_ascii_lowercase();
    let section = hit
        .chunk
        .section_path
        .as_deref()
        .or(Some(hit.chunk.title.as_str()))
        .unwrap_or("")
        .to_ascii_lowercase();
    // Prefer content fingerprint; basename+section catches truncated equal clones.
    format!("{fp}|{basename}|{section}")
}

fn is_better_duplicate_hit(candidate: &KcSearchHit, incumbent: &KcSearchHit) -> bool {
    if (candidate.fused_score - incumbent.fused_score).abs() > 1e-9 {
        return candidate.fused_score > incumbent.fused_score;
    }
    let cand_len = candidate.chunk.text.len();
    let inc_len = incumbent.chunk.text.len();
    if cand_len != inc_len {
        return cand_len > inc_len;
    }
    candidate.chunk.id < incumbent.chunk.id
}

fn filter_meta_hits(hits: &mut Vec<KcSearchHit>) {
    hits.retain(|hit| {
        !crate::knowledge_chat::filter::is_meta_knowledge_file(
            &hit.chunk.file_name,
            Some(&hit.chunk.file_path),
        ) && !crate::knowledge_chat::filter::is_meta_chunk_text(&hit.chunk.text)
    });
}

fn degradation_reasons(pending: &HybridSearchPending, dense_pair_rerank_used: bool) -> Vec<String> {
    let mut reasons = Vec::new();
    if !pending.dense_available {
        reasons.push("Collection has no dense vectors indexed.".to_string());
    } else if !pending.query_dense_ready {
        reasons.push("Query dense embedding unavailable; lexical retrieval used.".to_string());
    }
    if pending.dense_available && pending.query_dense_ready && !dense_pair_rerank_used {
        if pending.hits.is_empty() {
            reasons.push("Dense pair rerank was not applied (no retrieval hits).".to_string());
        } else {
            reasons.push(
                "Dense pair rerank was not applied (embed/rerank pass failed or skipped)."
                    .to_string(),
            );
        }
    }
    if !pending.fts_available {
        reasons.push("Full-text search index is empty for this collection.".to_string());
    }
    reasons
}

fn chunk_partition(chunk: &KcChunkRecord) -> KcPartitionId {
    chunk
        .partition_id
        .as_deref()
        .map(KcPartitionId::from_value)
        .unwrap_or(KcPartitionId::General)
}

fn passes_scope(chunk: &KcChunkRecord, scope: KcSearchScope) -> bool {
    scope.contains(chunk_partition(chunk))
}

fn partition_query_vector_map(request: &KcSearchRequest) -> HashMap<KcPartitionId, Vec<f32>> {
    request
        .partition_query_vectors
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(p, v)| (KcPartitionId::from_value(p), v.clone()))
        .collect()
}

fn dense_score_for_chunk(
    chunk: &crate::knowledge_chat::db::LoadedChunk,
    query_vectors: &HashMap<KcPartitionId, Vec<f32>>,
) -> f64 {
    let Some(cv) = chunk.dense_vector.as_ref() else {
        return 0.0;
    };
    let partition = chunk_partition(&chunk.record);
    let Some(qv) = query_vectors.get(&partition) else {
        return 0.0;
    };
    if qv.len() != cv.len() {
        return 0.0;
    }
    cosine_similarity(qv, cv) * 100.0
}

fn passes_filters(chunk: &KcChunkRecord, filters: &Option<KcSearchFilters>) -> bool {
    let Some(filters) = filters else {
        return true;
    };

    if let Some(doc_types) = &filters.doc_types {
        if doc_types.is_empty() {
            return true;
        }
        let doc_type = chunk.doc_type.as_deref().unwrap_or("").to_lowercase();
        if !doc_types.iter().any(|value| value.to_lowercase() == doc_type) {
            return false;
        }
    }

    let file_path = chunk.file_path.to_lowercase();
    let file_name = chunk.file_name.to_lowercase();

    if let Some(excludes) = &filters.exclude_path_contains {
        for needle in excludes {
            if !needle.trim().is_empty() && file_path.contains(&needle.to_lowercase()) {
                return false;
            }
        }
    }

    if let Some(paths) = &filters.path_contains {
        if !paths.is_empty()
            && !paths
                .iter()
                .filter(|needle| !needle.trim().is_empty())
                .any(|needle| file_path.contains(&needle.to_lowercase()))
        {
            return false;
        }
    }

    if let Some(names) = &filters.file_name_contains {
        if !names.is_empty()
            && !names
                .iter()
                .filter(|needle| !needle.trim().is_empty())
                .any(|needle| file_name.contains(&needle.to_lowercase()))
        {
            return false;
        }
    }

    true
}

fn apply_relevant_snippets(query: &str, hits: &mut [KcSearchHit]) {
    let max_chars = default_snippet_chars();
    for hit in hits.iter_mut() {
        let source = hit
            .chunk
            .context_text
            .as_deref()
            .unwrap_or(&hit.chunk.text);
        hit.relevant_snippet = Some(compress_text_for_query(
            query,
            &sanitize_retrieved_text(source),
            max_chars,
        ));
    }
}

fn assess_confidence(hits: &[KcSearchHit]) -> (KcRetrievalConfidence, f64, KcAnswerMode) {
    if hits.is_empty() {
        return (KcRetrievalConfidence::None, 0.0, KcAnswerMode::NotFound);
    }
    let top = hits[0].rerank_score.max(hits[0].fused_score);
    let second = hits.get(1).map(|h| h.rerank_score.max(h.fused_score)).unwrap_or(0.0);
    let gap = top - second;
    let score = top + gap * 0.35;

    if top >= 0.18 && gap >= 0.03 {
        (KcRetrievalConfidence::High, score, KcAnswerMode::Found)
    } else if top >= 0.10 {
        (KcRetrievalConfidence::Medium, score, KcAnswerMode::Partial)
    } else if top >= 0.04 {
        (KcRetrievalConfidence::Low, score, KcAnswerMode::Partial)
    } else {
        (KcRetrievalConfidence::None, score, KcAnswerMode::NotFound)
    }
}

fn normalize_mode(mode: &KcRetrievalMode, dense_available: bool, query_dense_ready: bool) -> KcRetrievalMode {
    match mode {
        KcRetrievalMode::DenseVector | KcRetrievalMode::HybridDense
            if !dense_available || !query_dense_ready =>
        {
            KcRetrievalMode::HybridLexical
        }
        other => other.clone(),
    }
}

fn passes_mode_filter(
    mode: KcRetrievalMode,
    keyword: f64,
    dense: f64,
    fts: f64,
) -> bool {
    match mode {
        KcRetrievalMode::Keyword => keyword > 0.0 || fts > 0.0,
        KcRetrievalMode::DenseVector => dense > 0.0,
        KcRetrievalMode::HybridLexical => keyword > 0.0 || fts > 0.0,
        KcRetrievalMode::HybridDense => keyword > 0.0 || dense > 0.0 || fts > 0.0,
    }
}

fn accumulate_rrf(scores: &mut [f64], ranked: &[(usize, f64)], rrf_k: f64) {
    for (rank, (idx, score)) in ranked.iter().enumerate() {
        if *score <= 0.0 {
            continue;
        }
        scores[*idx] += 1.0 / (rrf_k + rank as f64 + 1.0);
    }
}

fn mmr_lambda_for_intent(intent: QueryIntent) -> f64 {
    match intent {
        intent if is_code_oriented_intent(intent) || matches!(intent, QueryIntent::ErrorCode) => 0.92,
        QueryIntent::RunbookStep => 0.70,
        QueryIntent::Timeline => 0.80,
        QueryIntent::General => 0.45,
        _ => 0.45,
    }
}

fn mmr_select(
    pool: &[usize],
    chunks: &[LoadedChunk],
    fused_scores: &[f64],
    top_k: usize,
    mmr_lambda: f64,
) -> Vec<usize> {
    let mut selected = Vec::new();
    let mut remaining: Vec<usize> = pool.to_vec();

    while selected.len() < top_k && !remaining.is_empty() {
        let mut best_idx = 0usize;
        let mut best_score = f64::MIN;
        for (candidate_pos, &chunk_idx) in remaining.iter().enumerate() {
            let relevance = fused_scores[chunk_idx];
            let redundancy = selected
                .iter()
                .map(|&picked| chunk_similarity(&chunks[chunk_idx], &chunks[picked]))
                .fold(0.0f64, f64::max);
            let mmr = mmr_lambda * relevance - (1.0 - mmr_lambda) * redundancy;
            if mmr > best_score {
                best_score = mmr;
                best_idx = candidate_pos;
            }
        }
        selected.push(remaining.remove(best_idx));
    }

    selected
}

fn top_terms_overlap(left: &[String], right: &[String]) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let right_set: std::collections::HashSet<&str> = right.iter().map(String::as_str).collect();
    let shared = left.iter().filter(|term| right_set.contains(term.as_str())).count();
    shared as f64 / left.len().max(right.len()) as f64
}

fn section_heading_boost(query: &str, record: &KcChunkRecord) -> f64 {
    let q = query.to_lowercase();
    let section = record
        .section_path
        .as_deref()
        .unwrap_or("")
        .to_lowercase();
    let title = record.title.to_lowercase();
    let mut boost: f64 = 0.0;

    if q.contains("layer") && (section.contains("layer") || title.contains("layer")) {
        boost += 0.08;
    }
    if q.contains("architecture") && (section.contains("architecture") || record.file_name.to_lowercase().contains("architecture")) {
        boost += 0.06;
    }
    for term in query_terms(query) {
        if term.len() > 4 && (section.contains(term.as_str()) || title.contains(term.as_str())) {
            boost += 0.03;
        }
    }
    boost.min(0.15)
}

fn chunk_similarity(left: &LoadedChunk, right: &LoadedChunk) -> f64 {
    let lexical = if !left.lexical_vector.is_empty() && !right.lexical_vector.is_empty() {
        cosine_similarity(&left.lexical_vector, &right.lexical_vector)
    } else {
        top_terms_overlap(&left.record.top_terms, &right.record.top_terms)
    };
    let same_file = if left.record.file_id == right.record.file_id {
        0.35
    } else {
        0.0
    };
    lexical + same_file
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record_with_partition(partition: &str) -> KcChunkRecord {
        KcChunkRecord {
            id: "c1".to_string(),
            collection_id: "col".to_string(),
            file_id: "f1".to_string(),
            file_name: "a.rs".to_string(),
            file_path: "/a.rs".to_string(),
            chunk_index: 0,
            title: "t".to_string(),
            start_char: 0,
            end_char: 10,
            text: "body".to_string(),
            top_terms: vec![],
            has_dense: true,
            parent_text: None,
            section_path: None,
            doc_type: Some("code".to_string()),
            partition_id: Some(partition.to_string()),
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
        }
    }

    fn loaded(partition: &str, dense: Option<Vec<f32>>) -> LoadedChunk {
        LoadedChunk {
            record: record_with_partition(partition),
            lexical_vector: vec![],
            dense_vector: dense,
        }
    }

    #[test]
    fn scope_filters_by_partition() {
        let code = record_with_partition("code");
        let docs = record_with_partition("documentation");
        let legacy = record_with_partition("knowledge");
        assert!(passes_scope(&code, KcSearchScope::Code));
        assert!(!passes_scope(&code, KcSearchScope::Documentation));
        assert!(passes_scope(&docs, KcSearchScope::Documentation));
        assert!(passes_scope(&legacy, KcSearchScope::Docs));
        assert!(passes_scope(&code, KcSearchScope::All));
        assert!(passes_scope(&docs, KcSearchScope::All));
    }

    #[test]
    fn dense_score_uses_matching_partition_vector() {
        let mut vectors: HashMap<KcPartitionId, Vec<f32>> = HashMap::new();
        vectors.insert(KcPartitionId::Code, vec![1.0, 0.0, 0.0]);

        let code_chunk = loaded("code", Some(vec![1.0, 0.0, 0.0]));
        assert!(dense_score_for_chunk(&code_chunk, &vectors) > 99.0);

        let general_chunk = loaded("general", Some(vec![1.0, 0.0, 0.0]));
        assert_eq!(dense_score_for_chunk(&general_chunk, &vectors), 0.0);
    }

    #[test]
    fn dense_score_rejects_dimension_mismatch() {
        let mut vectors: HashMap<KcPartitionId, Vec<f32>> = HashMap::new();
        vectors.insert(KcPartitionId::Code, vec![1.0, 0.0]);
        let chunk = loaded("code", Some(vec![1.0, 0.0, 0.0]));
        assert_eq!(dense_score_for_chunk(&chunk, &vectors), 0.0);
    }

    fn hit_with_text(id: &str, path: &str, name: &str, text: &str, score: f64) -> KcSearchHit {
        KcSearchHit {
            chunk: KcChunkRecord {
                id: id.to_string(),
                collection_id: "c1".to_string(),
                file_id: id.to_string(),
                file_name: name.to_string(),
                file_path: path.to_string(),
                chunk_index: 0,
                title: "Section".to_string(),
                start_char: 0,
                end_char: text.len() as i64,
                text: text.to_string(),
                top_terms: vec![],
                has_dense: false,
                parent_text: None,
                section_path: Some("Document > Section".to_string()),
                doc_type: Some("document".to_string()),
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
    fn near_duplicate_hits_collapse_across_paths() {
        let body = "Identical policy body used in two folder copies for indexing tests.";
        let mut hits = vec![
            hit_with_text("a", r"copy_a\policy.txt", "policy.txt", body, 0.5),
            hit_with_text("b", r"copy_b\policy.txt", "policy.txt", body, 0.9),
            hit_with_text("c", r"other\notes.txt", "notes.txt", "Unrelated notes content here.", 0.4),
        ];
        dedupe_near_duplicate_hits(&mut hits);
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|h| h.chunk.id == "b"));
        assert!(hits.iter().any(|h| h.chunk.id == "c"));
        assert!(!hits.iter().any(|h| h.chunk.id == "a"));
    }
}
