use crate::database::Database;
use crate::deployment::load_deployment_config;
use crate::error::AppResult;
use crate::knowledge_chat::db;
use crate::knowledge_chat::db_entities;
use crate::knowledge_chat::dense_hnsw;
use crate::knowledge_chat::embeddings;
use crate::knowledge_chat::fts;
use crate::knowledge_chat::onnx_rerank::onnx_reranker_configured;
use crate::knowledge_chat::llama_rerank;
use crate::knowledge_chat::partitions::KcPartitionId;
use crate::knowledge_chat::pdf_ocr::pdf_ocr_available;
use crate::knowledge_chat::types::{
    KcCollectionHealth, KcFileRecord, KcFileStatus, KcPartitionHealth, KcSystemReadiness,
};

pub fn collection_health(db: &Database, collection_id: &str) -> AppResult<KcCollectionHealth> {
    let collection = db::get_collection(db, collection_id)?;
    let deploy = load_deployment_config(db);
    let files = db::list_files_by_status(db, collection_id, None)?;

    let indexed = files
        .iter()
        .filter(|f| f.status == KcFileStatus::Indexed)
        .count();
    let skipped = files
        .iter()
        .filter(|f| f.status == KcFileStatus::Skipped)
        .count();
    let failed = files
        .iter()
        .filter(|f| f.status == KcFileStatus::Error)
        .count();
    let pending = files
        .iter()
        .filter(|f| f.status == KcFileStatus::Pending)
        .count();

    let dense_coverage_pct = if collection.chunk_count > 0 {
        (collection.dense_chunk_count as f64 / collection.chunk_count as f64) * 100.0
    } else {
        0.0
    };

    let fts_populated = fts::fts_search(db, collection_id, "the", 1)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false);

    let ocr_needed: Vec<String> = files
        .iter()
        .filter(|f| needs_ocr_attention(f))
        .map(|f| f.relative_path.clone())
        .take(24)
        .collect();

    let failed_files: Vec<String> = files
        .iter()
        .filter(|f| f.status == KcFileStatus::Error)
        .map(|f| format!("{}: {}", f.relative_path, f.error_message.clone().unwrap_or_default()))
        .take(24)
        .collect();

    let skipped_files: Vec<String> = files
        .iter()
        .filter(|f| f.status == KcFileStatus::Skipped)
        .map(|f| format!("{}: {}", f.relative_path, f.error_message.clone().unwrap_or_default()))
        .take(24)
        .collect();

    let mut partitions = Vec::new();
    for partition in KcPartitionId::all() {
        let cfg = collection.partition_config.model_for(partition);
        let model_path = cfg.map(|c| c.embedding_model_path.clone()).unwrap_or_default();
        let profile_id = cfg.map(|c| c.profile_id.clone()).unwrap_or_default();
        let resolved = embeddings::try_resolve_embedding_model_path(&model_path, Some(&deploy.models_dir))
            .unwrap_or_default();
        let model_resolved = !resolved.is_empty() && std::path::Path::new(&resolved).is_file();
        let (chunk_count, dense_count) = db::partition_chunk_counts(db, collection_id, partition)?;
        let coverage = if chunk_count > 0 {
            (dense_count as f64 / chunk_count as f64) * 100.0
        } else {
            0.0
        };
        partitions.push(KcPartitionHealth {
            partition_id: partition.as_str().to_string(),
            embedding_model_path: resolved,
            profile_id,
            model_resolved,
            chunk_count,
            dense_chunk_count: dense_count,
            dense_coverage_pct: coverage,
            vector_dimension: db::partition_vector_dimension(db, collection_id, partition)?,
            hnsw_ready: dense_hnsw::partition_ready(collection_id, partition),
            hnsw_vector_count: dense_hnsw::hnsw_vector_count(collection_id, partition) as i64,
        });
    }

    let dual_model_reindex_recommended = {
        let code = partitions.iter().find(|p| p.partition_id == "code");
        let non_code_with_chunks: Vec<_> = partitions
            .iter()
            .filter(|p| p.partition_id != "code" && p.chunk_count > 0)
            .collect();
        match (code, non_code_with_chunks.is_empty()) {
            (Some(c), false) if c.chunk_count > 0 => non_code_with_chunks.iter().any(|p| {
                !c.embedding_model_path.is_empty()
                    && c.embedding_model_path.eq_ignore_ascii_case(&p.embedding_model_path)
            }),
            _ => false,
        }
    };

    let code_entity_count = collection.code_entity_count;
    let mut tree_sitter_files = 0i64;
    let mut heuristic_files = 0i64;
    let mut unsupported_language_files = 0i64;
    let mut parse_failed_files = 0i64;
    for file in &files {
        if file.status != KcFileStatus::Indexed {
            continue;
        }
        match file.code_parse_mode.as_deref() {
            Some("tree_sitter") => tree_sitter_files += 1,
            Some("heuristic") => heuristic_files += 1,
            Some("unsupported") => unsupported_language_files += 1,
            Some("failed") => parse_failed_files += 1,
            _ => {}
        }
    }
    let code_entity_rebuild_required =
        db_entities::collection_needs_code_entity_rebuild(db, collection_id).unwrap_or(false);
    let code_parse_summary = if tree_sitter_files + heuristic_files + unsupported_language_files + parse_failed_files > 0 {
        Some(format!(
            "{tree_sitter_files} Tree-sitter · {heuristic_files} heuristic · {unsupported_language_files} unsupported · {parse_failed_files} parse failed"
        ))
    } else {
        None
    };

    Ok(KcCollectionHealth {
        collection_id: collection_id.to_string(),
        status: collection.status,
        file_count: collection.file_count,
        indexed_file_count: collection.indexed_file_count,
        chunk_count: collection.chunk_count,
        dense_chunk_count: collection.dense_chunk_count,
        dense_coverage_pct,
        fts_populated,
        indexed_files: indexed as i64,
        skipped_files: skipped as i64,
        failed_files: failed as i64,
        pending_files: pending as i64,
        ocr_needed_files: ocr_needed,
        failed_file_samples: failed_files,
        skipped_file_samples: skipped_files,
        last_error: collection.last_error,
        hnsw_ready: dense_hnsw::hnsw_ready(collection_id),
        hnsw_vector_count: dense_hnsw::hnsw_vector_count_total(collection_id) as i64,
        onnx_reranker_configured: onnx_reranker_configured(db),
        onnx_reranker_enabled: cfg!(feature = "onnx-reranker"),
        pdf_ocr_available: pdf_ocr_available(),
        folder_category: collection.folder_category,
        partitions,
        dual_model_reindex_recommended,
        code_entity_count,
        tree_sitter_files,
        heuristic_files,
        unsupported_language_files,
        parse_failed_files,
        code_entity_rebuild_required,
        code_parse_summary,
    })
}

pub fn system_readiness(db: &Database) -> AppResult<KcSystemReadiness> {
    let deploy = load_deployment_config(db);
    let mut warnings = Vec::new();
    let configured = db::get_default_embedding_model(db);
    let embedding_model_path = embeddings::try_resolve_embedding_model_path(&configured, Some(&deploy.models_dir))
        .unwrap_or_default();
    let embedding_model_resolved = !embedding_model_path.is_empty()
        && std::path::Path::new(&embedding_model_path).is_file();
    if !embedding_model_resolved {
        warnings.push("No embedding .gguf model resolved. Dense indexing and hybrid search will be lexical-only.".to_string());
    }
    let llama_server_available = embeddings::llama_server_available();
    if !llama_server_available {
        warnings.push("llama-server runtime not found. Local embedding and chat inference may fail.".to_string());
    }
    let pdf_ocr = pdf_ocr_available();

    // Resolve the default per-partition models (Qwen3 for code, BGE-M3 for non-code).
    let default_config = embeddings::resolve_partition_config(
        crate::knowledge_chat::partitions::KcFolderCategory::Mixed,
        &deploy.models_dir,
        None,
        None,
    );
    let code_model_path = default_config.model_path_for(KcPartitionId::Code);
    let code_model_resolved =
        !code_model_path.is_empty() && std::path::Path::new(&code_model_path).is_file();
    let knowledge_model_path = default_config.model_path_for(KcPartitionId::General);
    let knowledge_model_resolved =
        !knowledge_model_path.is_empty() && std::path::Path::new(&knowledge_model_path).is_file();
    if !code_model_resolved {
        warnings.push(
            "No code-partition embedding model (e.g. Qwen3-Embedding-8B) resolved. Place Qwen3-Embedding-8B-Q4_K_M.gguf under models/embeddings. Code search will be lexical-only.".to_string(),
        );
    }
    if !knowledge_model_resolved {
        warnings.push(
            "No knowledge-partition embedding model (e.g. bge-m3) resolved. Place bge-m3-Q4_K_M.gguf under models/embeddings. Document dense search will be lexical-only.".to_string(),
        );
    }

    let llama_rerank_model_path = llama_rerank::resolve_llama_rerank_path(db).unwrap_or_default();
    let llama_rerank_configured = !llama_rerank_model_path.is_empty()
        && std::path::Path::new(&llama_rerank_model_path).is_file();
    if !llama_rerank_configured {
        warnings.push(
            "No Qwen3-Reranker GGUF found. Place Qwen3-Reranker-4B-Q4_K_M.gguf (or f16/Q8) under models/rerankers. Search will fall back to dense-pair / ONNX / phrase rerank.".to_string(),
        );
    }

    Ok(KcSystemReadiness {
        db_ready: true,
        embedding_model_resolved,
        embedding_model_path,
        llama_server_available,
        pdf_ocr_available: pdf_ocr,
        onnx_reranker_configured: onnx_reranker_configured(db),
        deployment_data_root: deploy.data_root.clone(),
        warnings,
        code_model_resolved,
        code_model_path,
        knowledge_model_resolved,
        knowledge_model_path,
        llama_rerank_configured,
        llama_rerank_model_path,
    })
}

fn needs_ocr_attention(file: &KcFileRecord) -> bool {
    file.extension.eq_ignore_ascii_case("pdf")
        && (file.status == KcFileStatus::Error || file.status == KcFileStatus::Skipped)
        && file
            .error_message
            .as_deref()
            .map(|msg| msg.to_lowercase().contains("ocr") || msg.to_lowercase().contains("too short"))
            .unwrap_or(false)
}
