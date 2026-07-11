use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::knowledge_chat::db;
use crate::knowledge_chat::dense_rerank;
use crate::knowledge_chat::embeddings;
use crate::knowledge_chat::indexer::{self, LexicalIndexOutcome};
use crate::knowledge_chat::llama_rerank;
use crate::knowledge_chat::path_guard::{ensure_allowed_model_path, ensure_knowledge_folder_path, load_deployment};
use crate::knowledge_chat::pipeline;
use crate::knowledge_chat::query_rewrite;
use crate::knowledge_chat::scanner::{normalize_path, scan_folder};
use crate::knowledge_chat::retrieval_config;
use crate::knowledge_chat::search;
use crate::knowledge_chat::eval;
use crate::knowledge_chat::health;
use crate::knowledge_chat::types::{
    KcCollection, KcCreateCollectionRequest, KcEmbedTextsRequest, KcEmbedTextsResult, KcEmbeddingValidation,
    KcEvalCase, KcEvalResult, KcFileRecord, KcIndexOptions, KcIndexResult, KcQueryRewriteResult, KcRetrievalMode,
    KcScanResult,     KcSearchRequest, KcSearchResult, KC_MAX_FILES_PER_SCAN, KcEvalMode, KcCollectionHealth,
    KcSystemReadiness, KcFileCatalog, KcLoadSelectedFilesResult, KcRepoMap, KcCodebaseContext,
};
use crate::audit;
use crate::product;
use tauri::{State, Window};

fn log_kc_audit(
    db: &crate::database::Database,
    event_type: &str,
    summary: &str,
    detail: Option<&str>,
    resource_path: Option<&str>,
    success: bool,
) {
    let config = product::load_product_config(db);
    if !config.audit_log_enabled {
        return;
    }
    let _ = audit::log_event(db, event_type, "kc", summary, detail, resource_path, success);
}

fn needs_server_dense_embedding(mode: &KcRetrievalMode) -> bool {
    matches!(
        mode,
        KcRetrievalMode::HybridDense | KcRetrievalMode::DenseVector
    )
}

#[tauri::command]
pub async fn kc_list_collections(state: State<'_, AppState>) -> AppResult<Vec<KcCollection>> {
    let db = state.db.lock().await;
    db::list_collections(&db)
}

#[tauri::command]
pub async fn kc_get_collection(state: State<'_, AppState>, collection_id: String) -> AppResult<KcCollection> {
    let db = state.db.lock().await;
    db::get_collection(&db, &collection_id)
}

#[tauri::command]
pub async fn kc_create_collection(
    state: State<'_, AppState>,
    request: KcCreateCollectionRequest,
) -> AppResult<KcCollection> {
    let name = request.name.trim();
    let root_path = normalize_path(&request.root_path);
    if name.is_empty() {
        return Err(AppError::Unknown("Collection name is required.".to_string()));
    }
    if root_path.is_empty() {
        return Err(AppError::Unknown("Folder path is required.".to_string()));
    }

    let db = state.db.lock().await;
    ensure_knowledge_folder_path(&root_path, "Knowledge collection root")?;
    let deploy = load_deployment(&db);

    let folder_category = crate::knowledge_chat::partitions::KcFolderCategory::from_value(
        request.folder_category.as_deref().unwrap_or("mixed"),
    );

    // Legacy single-model field applies as a fallback to both partitions when no
    // explicit per-partition model is supplied.
    let legacy = request
        .embedding_model_path
        .map(|value| normalize_path(&value))
        .filter(|value| !value.is_empty());
    let code_override = request
        .code_model_path
        .map(|value| normalize_path(&value))
        .filter(|value| !value.is_empty())
        .or_else(|| legacy.clone());
    let knowledge_override = request
        .knowledge_model_path
        .map(|value| normalize_path(&value))
        .filter(|value| !value.is_empty())
        .or_else(|| legacy.clone());

    let partition_config = embeddings::resolve_partition_config(
        folder_category,
        &deploy.models_dir,
        code_override.as_deref(),
        knowledge_override.as_deref(),
    );
    let code_model_path =
        partition_config.model_path_for(crate::knowledge_chat::partitions::KcPartitionId::Code);

    db::create_collection(
        &db,
        name,
        &root_path,
        &code_model_path,
        folder_category.as_str(),
        &partition_config,
    )
    .map(|collection| {
        log_kc_audit(
            &db,
            "kc.collection_create",
            "Knowledge collection created",
            Some(&collection.name),
            Some(&collection.root_path),
            true,
        );
        collection
    })
}

#[tauri::command]
pub async fn kc_delete_collection(state: State<'_, AppState>, collection_id: String) -> AppResult<()> {
    let db = state.db.lock().await;
    db::delete_collection(&db, &collection_id)
}

#[tauri::command]
pub async fn kc_scan_collection(
    state: State<'_, AppState>,
    collection_id: String,
    max_files: Option<usize>,
) -> AppResult<KcScanResult> {
    let db = state.db.lock().await;
    let collection = db::get_collection(&db, &collection_id)?;
    db::update_collection_status(
        &db,
        &collection_id,
        crate::knowledge_chat::types::KcCollectionStatus::Scanning,
        None,
    )?;

    let (files, ignored_dirs, truncated, permission_denied_files, walk_errors) =
        scan_folder(&collection.root_path, max_files)?;
    db::sync_collection_files(&db, &collection_id, &files, true)?;
    db::update_collection_status(
        &db,
        &collection_id,
        crate::knowledge_chat::types::KcCollectionStatus::Draft,
        None,
    )?;

    let supported_files = files.iter().filter(|file| file.supported).count();
    let skipped_files = files.len().saturating_sub(supported_files);
    Ok(KcScanResult {
        collection_id,
        root_path: collection.root_path,
        scanned_files: files.len(),
        supported_files,
        skipped_files,
        ignored_dirs,
        truncated,
        permission_denied_files,
        walk_errors,
        files,
    })
}

#[tauri::command]
pub async fn kc_system_readiness(
    state: State<'_, AppState>,
) -> AppResult<KcSystemReadiness> {
    let db = state.db.lock().await;
    health::system_readiness(&db)
}

#[tauri::command]
pub async fn kc_list_collection_files(
    state: State<'_, AppState>,
    collection_id: String,
) -> AppResult<Vec<KcFileRecord>> {
    let db = state.db.lock().await;
    db::list_files_by_status(&db, &collection_id, None)
}

#[tauri::command]
pub async fn kc_index_collection(
    window: Window,
    state: State<'_, AppState>,
    collection_id: String,
    options: Option<KcIndexOptions>,
) -> AppResult<KcIndexResult> {
    let (mut partition_config, folder_category, rebuild, build_dense, incremental, pre_warnings) = {
        let db = state.db.lock().await;
        let deploy = load_deployment(&db);
        let collection = db::get_collection(&db, &collection_id)?;
        let opts = options.unwrap_or(KcIndexOptions {
            rebuild: Some(false),
            build_dense: Some(true),
            embedding_model_path: None,
            incremental: Some(true),
        });

        let folder_category = crate::knowledge_chat::partitions::KcFolderCategory::from_value(
            &collection.folder_category,
        );
        let override_model = opts
            .embedding_model_path
            .map(|value| normalize_path(&value))
            .filter(|value| !value.is_empty());

        // Use the collection's persisted partition config; build defaults for
        // legacy collections that predate the partition schema.
        let mut partition_config = if collection.partition_config.is_empty() {
            let legacy = override_model
                .clone()
                .or_else(|| Some(collection.embedding_model_path.clone()))
                .filter(|value| !value.is_empty());
            embeddings::resolve_partition_config(
                folder_category,
                &deploy.models_dir,
                legacy.as_deref(),
                legacy.as_deref(),
            )
        } else {
            embeddings::merge_partition_config(
                collection.partition_config.clone(),
                folder_category,
                &deploy.models_dir,
                None,
                None,
            )
        };

        // A legacy single-model override updates the code partition only.
        if let Some(path) = override_model {
            if let Some(code) = partition_config
                .partitions
                .iter_mut()
                .find(|p| p.partition_id.eq_ignore_ascii_case("code"))
            {
                code.embedding_model_path = path.clone();
                code.profile_id =
                    crate::knowledge_chat::embedding_profiles::resolve_profile_for_model(&path)
                        .as_str()
                        .to_string();
            }
        }

        (
            partition_config,
            folder_category,
            opts.rebuild.unwrap_or(false),
            opts.build_dense.unwrap_or(true),
            opts.incremental.unwrap_or(true),
            Vec::<String>::new(),
        )
    };

    let lexical_outcome = {
        let db = state.db.lock().await;
        indexer::index_lexical(&db, &collection_id, rebuild, incremental, Some(&window))?
    };

    let mut dense_status = if build_dense { "indexing" } else { "not_configured" };
    let mut warnings = lexical_outcome.warnings.clone();
    warnings.extend(pre_warnings);
    if build_dense {
        let remote = crate::commands::resolve_remote_embed_config(&state).await;
        match embeddings::embed_missing_dense_vectors_partitioned(
            state.db.clone(),
            state.kc_embed_pool.clone(),
            &collection_id,
            &partition_config,
            remote.as_ref(),
            Some(&window),
        )
        .await
        {
            Ok(outcome) => {
                warnings.extend(outcome.warnings);
                // Record resolved vector dimensions back onto the config.
                for (partition_id, dim) in &outcome.partition_dims {
                    if let Some(cfg) = partition_config
                        .partitions
                        .iter_mut()
                        .find(|p| &p.partition_id == partition_id)
                    {
                        cfg.vector_dimension = Some(*dim);
                    }
                }
                dense_status = if outcome.partitions_ready.is_empty() {
                    "not_configured"
                } else if !outcome.partitions_missing_model.is_empty() {
                    "partial"
                } else {
                    "ready"
                };
            }
            Err(err) => {
                dense_status = "failed";
                warnings.push(format!("Dense embedding build failed: {err}"));
            }
        }
    }

    // Persist the (possibly dimension-updated) partition config so a rebuild
    // never loses the model selection.
    {
        let db = state.db.lock().await;
        let code_model = partition_config
            .model_path_for(crate::knowledge_chat::partitions::KcPartitionId::Code);
        let _ = db::update_collection_partition_config(
            &db,
            &collection_id,
            folder_category.as_str(),
            &partition_config,
            &code_model,
        );
    }

    let db = state.db.lock().await;
    let result = indexer::finalize_index(
        &db,
        &collection_id,
        LexicalIndexOutcome { warnings, ..lexical_outcome },
        dense_status,
        Some(&window),
    )?;
    let resource_path = db::get_collection(&db, &collection_id)
        .ok()
        .map(|collection| collection.root_path);
    log_kc_audit(
        &db,
        "kc.index",
        "Knowledge collection indexed",
        Some(&format!(
            "chunks={}; dense={}",
            result.chunk_count, result.dense_chunk_count
        )),
        resource_path.as_deref(),
        true,
    );
    Ok(result)
}

#[tauri::command]
pub async fn kc_run_eval(
    state: State<'_, AppState>,
    collection_id: String,
    cases: Option<Vec<KcEvalCase>>,
    top_k: Option<usize>,
    eval_mode: Option<KcEvalMode>,
    production_parity: Option<bool>,
) -> AppResult<KcEvalResult> {
    let db = state.db.lock().await;
    drop(db);
    eval::run_eval(
        state.db.clone(),
        state.kc_embed_pool.clone(),
        state.kc_rerank_pool.clone(),
        &collection_id,
        cases,
        top_k,
        eval_mode,
        production_parity,
    )
    .await
}

#[tauri::command]
pub async fn kc_collection_health(
    state: State<'_, AppState>,
    collection_id: String,
) -> AppResult<KcCollectionHealth> {
    let db = state.db.lock().await;
    health::collection_health(&db, &collection_id)
}

#[tauri::command]
pub async fn kc_prepare_search_query(query: String) -> AppResult<KcQueryRewriteResult> {
    Ok(query_rewrite::rewrite_for_retrieval(&query))
}

#[tauri::command]
pub async fn kc_hybrid_search(
    state: State<'_, AppState>,
    mut request: KcSearchRequest,
) -> AppResult<KcSearchResult> {
    use crate::knowledge_chat::pipeline_diagnose;
    use crate::knowledge_chat::pipeline_trace::{
        stage_io, summarize_hits, StageTimer, KcPipelineTrace, KcStageStatus,
    };

    let mut trace = KcPipelineTrace::default();
    let original_query = request.query.trim().to_string();
    let requested_scope = format!("{:?}", request.search_scope);

    let db = state.db.lock().await;
    let deploy = load_deployment(&db);
    let product = product::load_product_config(&db);
    let collection = db::get_collection(&db, &request.collection_id)?;
    ensure_knowledge_folder_path(&collection.root_path, "Knowledge collection root")?;
    let rewrite = query_rewrite::rewrite_for_retrieval(request.query.trim());
    let embed_source = if product.enable_hyde {
        query_rewrite::hyde_retrieval_query(&rewrite.retrieval_query)
    } else {
        rewrite.retrieval_query.clone()
    };
    let partition_config = collection.partition_config.clone();
    let collection_root = collection.root_path.clone();

    let scope_timer = StageTimer::start();
    let (scope, scope_widen_notice) =
        pipeline::resolve_scope_for_accuracy(request.search_scope, request.query.trim());
    let scope_ms = scope_timer.elapsed_ms();
    let scope_in = format!("query={original_query:?}; requested_scope={requested_scope}");
    if let Some(ref notice) = scope_widen_notice {
        trace.push(stage_io(
            "scope_resolve",
            KcStageStatus::Degraded,
            scope_ms,
            notice.clone(),
            "Use All partitions for docs/process questions, or keep Auto widen.",
            &scope_in,
            format!("effective_scope={scope:?}; widened=true"),
        ));
    } else {
        trace.push(stage_io(
            "scope_resolve",
            KcStageStatus::Ok,
            scope_ms,
            format!("scope={scope:?}"),
            "",
            &scope_in,
            format!("effective_scope={scope:?}; widened=false"),
        ));
    }
    drop(db);

    request.query_dense_vector = None;
    request.search_scope = Some(scope);
    let mut partition_models_used = Vec::new();
    let embed_timer = StageTimer::start();
    let embed_in = format!("embed_source={embed_source:?}; mode={:?}", request.mode);
    if needs_server_dense_embedding(&request.mode) {
        let remote = crate::commands::resolve_remote_embed_config(&state).await;
        let embeds = pipeline::embed_partition_query_vectors(
            &state.kc_embed_pool,
            &deploy,
            &partition_config,
            remote.as_ref(),
            scope,
            &embed_source,
        )
        .await;
        let embed_ms = embed_timer.elapsed_ms();
        request.partition_query_vectors = embeds.vectors;
        partition_models_used = embeds.models_used;
        if request.partition_query_vectors.is_empty() {
            trace.push(stage_io(
                "embed",
                KcStageStatus::Degraded,
                embed_ms,
                "No partition query vectors produced",
                "Verify embedding GGUFs under models/embeddings and llama-server runtime.",
                &embed_in,
                "vectors=[]",
            ));
        } else {
            let models: Vec<String> = partition_models_used
                .iter()
                .map(|(partition, model)| {
                    let dims = request
                        .partition_query_vectors
                        .iter()
                        .find(|(id, _)| id == partition)
                        .map(|(_, v)| v.len())
                        .unwrap_or(0);
                    format!("{partition}:{model} dims={dims}")
                })
                .collect();
            trace.push(stage_io(
                "embed",
                KcStageStatus::Ok,
                embed_ms,
                format!("vectors={}", request.partition_query_vectors.len()),
                "",
                &embed_in,
                format!(
                    "vector_count={}; models=[{}]",
                    request.partition_query_vectors.len(),
                    models.join("; ")
                ),
            ));
        }
    } else {
        request.partition_query_vectors = Vec::new();
        trace.push(stage_io(
            "embed",
            KcStageStatus::Skipped,
            embed_timer.elapsed_ms(),
            "Mode does not require server dense embedding",
            "",
            &embed_in,
            "skipped",
        ));
    }

    let db = state.db.lock().await;
    let retrieval_config = retrieval_config::RetrievalConfig::from_db(&db);
    let begin_timer = StageTimer::start();
    let begin_in = format!(
        "retrieval_query={:?}; top_k={:?}; partition_vectors={}",
        rewrite.retrieval_query,
        request.top_k,
        request.partition_query_vectors.len()
    );
    let mut pending = search::hybrid_search_begin(&db, request)?;
    let begin_ms = begin_timer.elapsed_ms();
    let dense_ready =
        pending.dense_available && !pending.request.partition_query_vectors.is_empty();
    let hit_count_begin = pending.hits.len();
    let hits_summary = summarize_hits(&pending.hits, 5);
    if !pending.fts_available {
        trace.push(stage_io(
            "fts",
            KcStageStatus::Degraded,
            0,
            "FTS index empty or unavailable",
            "Rebuild the collection so FTS is populated.",
            &begin_in,
            "fts_available=false",
        ));
    } else {
        trace.push(stage_io(
            "fts",
            KcStageStatus::Ok,
            begin_ms / 3,
            "FTS available",
            "",
            &begin_in,
            format!("fts_available=true; {hits_summary}"),
        ));
    }
    if !pending.dense_available {
        trace.push(stage_io(
            "dense",
            KcStageStatus::Degraded,
            0,
            "No dense vectors indexed",
            "Rebuild dense index; confirm embed models in Collection Health.",
            &begin_in,
            "dense_available=false",
        ));
    } else if !pending.query_dense_ready {
        trace.push(stage_io(
            "dense",
            KcStageStatus::Degraded,
            0,
            "Query dense embedding unavailable",
            "Check embed stage / llama-server.",
            &begin_in,
            "query_dense_ready=false",
        ));
    } else {
        trace.push(stage_io(
            "dense",
            KcStageStatus::Ok,
            begin_ms / 3,
            "Dense retrieval available",
            "",
            &begin_in,
            format!("dense_available=true; query_dense_ready=true; {hits_summary}"),
        ));
    }
    trace.push(stage_io(
        "rrf",
        if hit_count_begin > 0 {
            KcStageStatus::Ok
        } else {
            KcStageStatus::Degraded
        },
        begin_ms,
        format!("hybrid_search_begin hits={hit_count_begin}"),
        if hit_count_begin == 0 {
            "Widen scope or rebuild index if expected files are missing."
        } else {
            ""
        },
        &begin_in,
        &hits_summary,
    ));
    drop(db);

    let rerank_models = pipeline::partition_rerank_models(&partition_config, &deploy, scope);
    let mut dense_pair_rerank_used = false;
    let mut dense_pair_failure_notes: Vec<String> = Vec::new();
    let dense_pair_timer = StageTimer::start();
    let dense_pair_in = format!(
        "query={:?}; {}",
        pending.rewrite.retrieval_query,
        summarize_hits(&pending.hits, 8)
    );
    if retrieval_config.enable_dense_pair_rerank && dense_ready && !pending.hits.is_empty() {
        for attempt in 0..2 {
            match dense_rerank::apply_dense_pair_rerank_partitioned(
                &state.kc_embed_pool,
                &rerank_models,
                &pending.rewrite.retrieval_query,
                &mut pending.hits,
                retrieval_config.dense_pair_rerank_top_n,
                retrieval_config.dense_pair_blend_self,
                retrieval_config.dense_pair_blend_new,
            )
            .await
            {
                Ok(outcome) => {
                    dense_pair_rerank_used = outcome.applied;
                    dense_pair_failure_notes = outcome.failure_notes;
                    if dense_pair_rerank_used {
                        break;
                    }
                }
                Err(err) => {
                    dense_pair_failure_notes = vec![err.to_string()];
                    if attempt == 0 {
                        continue;
                    }
                }
            }
        }
    } else if retrieval_config.enable_dense_pair_rerank
        && dense_ready
        && pending.hits.is_empty()
    {
        dense_pair_failure_notes.push("no retrieval hits".to_string());
    }
    let dense_pair_ms = dense_pair_timer.elapsed_ms();
    let dense_pair_out = summarize_hits(&pending.hits, 8);
    if !retrieval_config.enable_dense_pair_rerank {
        trace.push(stage_io(
            "dense_pair_rerank",
            KcStageStatus::Skipped,
            dense_pair_ms,
            "Disabled in retrieval config",
            "",
            &dense_pair_in,
            "skipped",
        ));
    } else if dense_pair_rerank_used {
        trace.push(stage_io(
            "dense_pair_rerank",
            KcStageStatus::Ok,
            dense_pair_ms,
            "Applied",
            "",
            &dense_pair_in,
            &dense_pair_out,
        ));
    } else if !dense_ready {
        trace.push(stage_io(
            "dense_pair_rerank",
            KcStageStatus::Skipped,
            dense_pair_ms,
            "Dense not ready",
            "Rebuild dense vectors and ensure query embed succeeded.",
            &dense_pair_in,
            "skipped",
        ));
    } else {
        let notes = if dense_pair_failure_notes.is_empty() {
            "not applied".to_string()
        } else {
            dense_pair_failure_notes.join("; ")
        };
        trace.push(stage_io(
            "dense_pair_rerank",
            KcStageStatus::Degraded,
            dense_pair_ms,
            notes,
            "Check embed server / OOM / partition model paths.",
            &dense_pair_in,
            &dense_pair_out,
        ));
    }

    let mut llama_rerank_used = false;
    let llama_timer = StageTimer::start();
    let llama_in = format!(
        "query={:?}; {}",
        pending.rewrite.retrieval_query,
        summarize_hits(&pending.hits, 8)
    );
    if retrieval_config.enable_llama_rerank && !pending.hits.is_empty() {
        let db = state.db.lock().await;
        let llama_path = llama_rerank::resolve_llama_rerank_path(&db);
        drop(db);
        match llama_path {
            Some(path) => {
                match llama_rerank::apply_llama_rerank(
                    &state.kc_rerank_pool,
                    &path,
                    &pending.rewrite.retrieval_query,
                    &mut pending.hits,
                    retrieval_config.onnx_rerank_top_n,
                    retrieval_config.onnx_blend_self,
                    retrieval_config.onnx_blend_new,
                )
                .await
                {
                    Ok(true) => {
                        llama_rerank_used = true;
                        trace.push(stage_io(
                            "llama_rank",
                            KcStageStatus::Ok,
                            llama_timer.elapsed_ms(),
                            format!("priority=1 primary=qwen_gguf; path={path}"),
                            "",
                            &llama_in,
                            summarize_hits(&pending.hits, 8),
                        ));
                    }
                    Ok(false) => {
                        trace.push(stage_io(
                            "llama_rank",
                            KcStageStatus::Skipped,
                            llama_timer.elapsed_ms(),
                            format!("priority=1 primary=qwen_gguf skipped; path={path}"),
                            "Falling back to ONNX / phrase rerank.",
                            &llama_in,
                            "skipped",
                        ));
                    }
                    Err(err) => {
                        trace.push(stage_io(
                            "llama_rank",
                            KcStageStatus::Failed,
                            llama_timer.elapsed_ms(),
                            format!("priority=1 primary=qwen_gguf; path={path}; error={err}"),
                            "Install RANK-capable Qwen3-Reranker GGUF; check llama-server runtime and VRAM. Falling back to ONNX / phrase.",
                            &llama_in,
                            format!("error={err}"),
                        ));
                    }
                }
            }
            None => {
                trace.push(stage_io(
                    "llama_rank",
                    KcStageStatus::Skipped,
                    llama_timer.elapsed_ms(),
                    "priority=1 primary=qwen_gguf; No Qwen3-Reranker GGUF resolved",
                    "Place Qwen3-Reranker-4B-*.gguf under models/rerankers. Falling back to ONNX / phrase.",
                    &llama_in,
                    "no_model_path",
                ));
            }
        }
    } else {
        trace.push(stage_io(
            "llama_rank",
            KcStageStatus::Skipped,
            llama_timer.elapsed_ms(),
            if pending.hits.is_empty() {
                "No hits to rerank"
            } else {
                "Qwen/llama RANK disabled in retrieval config"
            },
            "",
            &llama_in,
            "skipped",
        ));
    }

    let pre_complete_hits = summarize_hits(&pending.hits, 8);
    let db = state.db.lock().await;
    let complete_timer = StageTimer::start();
    let mut result = search::hybrid_search_complete(
        &db,
        pending,
        dense_pair_rerank_used,
        llama_rerank_used,
    )?;
    let complete_ms = complete_timer.elapsed_ms();
    let post_complete_hits = summarize_hits(&result.hits, 8);
    if result.onnx_reranker_used {
        trace.push(stage_io(
            "onnx_or_phrase_rerank",
            KcStageStatus::Ok,
            complete_ms,
            "priority=2 fallback; ONNX or phrase rerank applied in complete",
            "",
            &pre_complete_hits,
            &post_complete_hits,
        ));
    } else if llama_rerank_used {
        trace.push(stage_io(
            "onnx_or_phrase_rerank",
            KcStageStatus::Skipped,
            complete_ms,
            "Skipped; primary Qwen RANK already applied",
            "",
            &pre_complete_hits,
            "skipped",
        ));
    } else {
        trace.push(stage_io(
            "onnx_or_phrase_rerank",
            KcStageStatus::Degraded,
            complete_ms,
            "No primary Qwen RANK or ONNX rerank applied (phrase fallback may still run)",
            "Place Qwen3-Reranker GGUF under models/rerankers (primary), or configure ONNX as fallback.",
            &pre_complete_hits,
            &post_complete_hits,
        ));
    }
    if result.parent_merge_applied {
        trace.push(stage_io(
            "parent_merge",
            KcStageStatus::Ok,
            0,
            "Sibling chunks merged into parent context",
            "",
            &pre_complete_hits,
            &post_complete_hits,
        ));
    } else {
        trace.push(stage_io(
            "parent_merge",
            KcStageStatus::Skipped,
            0,
            "No parent merge",
            "",
            &pre_complete_hits,
            "unchanged",
        ));
    }

    result.search_scope_applied = Some(scope);
    result.partition_models_used = partition_models_used;
    if let Some(notice) = scope_widen_notice {
        result.degradation_reasons.insert(0, notice);
    }
    if dense_ready && !dense_pair_rerank_used {
        if dense_pair_failure_notes.is_empty() && !retrieval_config.enable_dense_pair_rerank {
            result.degradation_reasons.push(
                "Dense pair rerank disabled in retrieval config.".to_string(),
            );
        }
        for note in &dense_pair_failure_notes {
            let msg = format!("Dense pair rerank: {note}");
            if !result.degradation_reasons.iter().any(|r| r.contains(note)) {
                result.degradation_reasons.push(msg);
            }
        }
    }

    let conf_label = format!("{:?}", result.confidence).to_lowercase();
    pipeline_diagnose::diagnose(&mut trace, &conf_label, result.hits.len());
    let audit_detail = format!(
        "hits={}; confidence={:?}; intent={}; {}",
        result.hits.len(),
        result.confidence,
        result.intent_match.is_some(),
        trace.summary_for_audit()
    );
    result.pipeline_trace = Some(trace);

    log_kc_audit(
        &db,
        "kc.search",
        "Knowledge hybrid search",
        Some(&audit_detail),
        Some(&collection_root),
        true,
    );
    Ok(result)
}

#[tauri::command]
pub async fn kc_embed_query(
    state: State<'_, AppState>,
    request: KcEmbedTextsRequest,
) -> AppResult<KcEmbedTextsResult> {
    if request.texts.len() != 1 {
        return Err(AppError::Unknown("Query embedding expects exactly one text input.".to_string()));
    }
    let db = state.db.lock().await;
    let deploy = load_deployment(&db);
    let model_path = ensure_allowed_model_path(&deploy, &request.model_path, "Embedding model")?;
    drop(db);
    embeddings::embed_texts(
        Some(state.kc_embed_pool.as_ref()),
        KcEmbedTextsRequest {
            model_path,
            ..request
        },
    )
    .await
}

#[tauri::command]
pub async fn kc_validate_embedding_model(
    state: State<'_, AppState>,
    model_path: String,
) -> AppResult<KcEmbeddingValidation> {
    let db = state.db.lock().await;
    let deploy = load_deployment(&db);
    let resolved = embeddings::try_resolve_embedding_model_path(&model_path, Some(&deploy.models_dir))?;
    let clean = ensure_allowed_model_path(&deploy, &resolved, "Embedding model")?;
    drop(db);
    embeddings::validate_embedding_model(&clean).await
}

#[tauri::command]
pub async fn kc_set_default_embedding_model(
    state: State<'_, AppState>,
    model_path: String,
) -> AppResult<KcEmbeddingValidation> {
    let db = state.db.lock().await;
    let deploy = load_deployment(&db);
    let resolved = embeddings::try_resolve_embedding_model_path(&model_path, Some(&deploy.models_dir))?;
    let clean = ensure_allowed_model_path(&deploy, &resolved, "Embedding model")?;
    let validation = embeddings::validate_embedding_model(&clean).await?;
    db::set_default_embedding_model(&db, &clean)?;
    Ok(validation)
}

#[tauri::command]
pub async fn kc_resolve_embedding_model(
    state: State<'_, AppState>,
    model_path: String,
) -> AppResult<String> {
    let db = state.db.lock().await;
    let deploy = load_deployment(&db);
    embeddings::try_resolve_embedding_model_path(&model_path, Some(&deploy.models_dir))
}

#[tauri::command]
pub async fn kc_discover_embedding_models(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let db = state.db.lock().await;
    let deploy = load_deployment(&db);
    let configured = db::get_default_embedding_model(&db);
    let mut roots = vec![deploy.models_dir.clone()];
    if !configured.trim().is_empty() {
        roots.push(configured);
    }
    Ok(embeddings::discover_embedding_models(&roots))
}

#[tauri::command]
pub async fn kc_get_default_embedding_model(state: State<'_, AppState>) -> AppResult<String> {
    let db = state.db.lock().await;
    Ok(db::get_default_embedding_model(&db))
}

#[tauri::command]
pub async fn kc_preview_partition_mix(
    folder_path: String,
    max_files: Option<usize>,
) -> AppResult<crate::knowledge_chat::types::KcPartitionMix> {
    use crate::knowledge_chat::partitions::{route_file_to_partition, KcPartitionId};

    let root_path = normalize_path(&folder_path);
    ensure_knowledge_folder_path(&root_path, "Partition preview folder")?;

    let (files, _ignored_dirs, _truncated, _permission_denied, _walk_errors) =
        scan_folder(&root_path, max_files.or(Some(KC_MAX_FILES_PER_SCAN)))?;

    let mut code_files = 0usize;
    let mut documentation_files = 0usize;
    let mut runbooks_files = 0usize;
    let mut logs_data_files = 0usize;
    let mut general_files = 0usize;
    let mut total_supported = 0usize;

    for file in files.iter().filter(|f| f.supported) {
        total_supported += 1;
        match route_file_to_partition(&file.extension, Some(&file.relative_path)) {
            KcPartitionId::Code => code_files += 1,
            KcPartitionId::Documentation => documentation_files += 1,
            KcPartitionId::Runbooks => runbooks_files += 1,
            KcPartitionId::LogsData => logs_data_files += 1,
            KcPartitionId::General => general_files += 1,
        }
    }

    Ok(crate::knowledge_chat::types::KcPartitionMix {
        root_path,
        code_files,
        documentation_files,
        runbooks_files,
        logs_data_files,
        general_files,
        total_supported,
    })
}

#[tauri::command]
pub async fn kc_quick_scan_folder(
    state: State<'_, AppState>,
    folder_path: String,
    max_files: Option<usize>,
) -> AppResult<KcScanResult> {
    let root_path = normalize_path(&folder_path);
    ensure_knowledge_folder_path(&root_path, "Quick scan folder")?;

    let (files, ignored_dirs, truncated, permission_denied_files, walk_errors) =
        scan_folder(&root_path, max_files.or(Some(KC_MAX_FILES_PER_SCAN)))?;
    let supported_files = files.iter().filter(|file| file.supported).count();
    let skipped_files = files.len().saturating_sub(supported_files);
    Ok(KcScanResult {
        collection_id: String::new(),
        root_path,
        scanned_files: files.len(),
        supported_files,
        skipped_files,
        ignored_dirs,
        truncated,
        permission_denied_files,
        walk_errors,
        files,
    })
}

#[tauri::command]
pub async fn kc_build_file_catalog(
    state: State<'_, AppState>,
    collection_id: String,
) -> AppResult<KcFileCatalog> {
    let db = state.db.lock().await;
    crate::knowledge_chat::file_catalog::build_collection_catalog(&db, &collection_id)
}

#[tauri::command]
pub async fn kc_load_selected_files(
    state: State<'_, AppState>,
    collection_id: String,
    relative_paths: Vec<String>,
) -> AppResult<KcLoadSelectedFilesResult> {
    let db = state.db.lock().await;
    let catalog = crate::knowledge_chat::file_catalog::build_collection_catalog(&db, &collection_id)?;
    let selected = crate::knowledge_chat::file_catalog::resolve_catalog_paths(&catalog, &relative_paths);
    let selected_paths: Vec<String> = selected.iter().map(|e| e.relative_path.clone()).collect();
    let bundle = crate::knowledge_chat::context_bundle::bundle_catalog_entries(
        &selected,
        &catalog.collection_name,
    );
    Ok(KcLoadSelectedFilesResult {
        context_block: bundle.context_block,
        sources: bundle.sources,
        selected_paths,
        omitted_paths: bundle.omitted_oversize,
    })
}

#[tauri::command]
pub async fn kc_build_repo_map(
    state: State<'_, AppState>,
    collection_id: String,
) -> AppResult<KcRepoMap> {
    let db = state.db.lock().await;
    crate::knowledge_chat::codebase_explorer::build_repo_map(&db, &collection_id)
}

#[tauri::command]
pub async fn kc_codebase_explorer_context(
    state: State<'_, AppState>,
    collection_id: String,
    query: String,
) -> AppResult<KcCodebaseContext> {
    let db = state.db.lock().await;
    crate::knowledge_chat::codebase_explorer::build_codebase_context(&db, &collection_id, &query)
}

#[tauri::command]
pub async fn kc_ensure_qa_corpus(
    window: Window,
    state: State<'_, AppState>,
    rebuild: Option<bool>,
    force_sync: Option<bool>,
) -> AppResult<crate::knowledge_chat::types::KcQaCorpusBootstrapResult> {
    let remote = crate::commands::resolve_remote_embed_config(&state).await;
    crate::knowledge_chat::qa_corpus::bootstrap(
        state.inner(),
        Some(&window),
        rebuild.unwrap_or(false),
        force_sync.unwrap_or(false),
        remote.as_ref(),
    )
    .await
}

