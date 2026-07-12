use crate::commands::AppState;
use crate::deployment::{self, normalize_path_string};
use crate::error::{AppError, AppResult};
use crate::knowledge_chat::db;
use crate::knowledge_chat::db_entities;
use crate::knowledge_chat::embeddings;
use crate::knowledge_chat::indexer::{self, LexicalIndexOutcome};
use crate::knowledge_chat::path_guard::{ensure_knowledge_folder_path, load_deployment};
use crate::knowledge_chat::scanner::scan_folder;
use crate::knowledge_chat::remote_embeddings::RemoteEmbedConfig;
use crate::knowledge_chat::types::{KcCollection, KcCollectionStatus, KcQaCorpusBootstrapResult};
use std::path::{Path, PathBuf};
use tauri::Window;

pub const QA_COLLECTION_NAME: &str = "NexusAI QA Corpus";
const QA_COLLECTION_SETTING: &str = "kc.qa_collection_id";
const QA_CORPUS_DIR_NAME: &str = "qa-corpus";

/// Runtime path: `{NEXUS_DATA_ROOT}/qa-corpus` (default `D:\NexusAI\qa-corpus`).
pub fn qa_corpus_runtime_path() -> PathBuf {
    deployment::preferred_data_root().join(QA_CORPUS_DIR_NAME)
}

/// Bundled fixture source in the repo (dev) or override via `NEXUS_QA_CORPUS_SOURCE`.
pub fn qa_corpus_source_path() -> PathBuf {
    if let Ok(value) = std::env::var("NEXUS_QA_CORPUS_SOURCE") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("test-fixtures")
        .join("kc-qa-corpus")
}

pub async fn bootstrap(
    state: &AppState,
    window: Option<&Window>,
    rebuild: bool,
    force_sync: bool,
    remote: Option<&RemoteEmbedConfig>,
) -> AppResult<KcQaCorpusBootstrapResult> {
    let runtime = qa_corpus_runtime_path();
    let source = qa_corpus_source_path();
    if !source.is_dir() {
        return Err(AppError::Unknown(format!(
            "QA corpus source folder not found: {}",
            source.display()
        )));
    }

    let copied = sync_qa_corpus(&source, &runtime, force_sync || rebuild)?;
    if copied > 0 {
        log::info!("Synced {copied} QA corpus file(s) to {}", runtime.display());
    }

    let root_path = normalize_path_string(&runtime.to_string_lossy());
    ensure_knowledge_folder_path(&root_path, "QA corpus")?;

    let collection = {
        let db = state.db.lock().await;
        resolve_or_create_collection(&db, &root_path)?
    };

    let effective_rebuild = {
        let db = state.db.lock().await;
        let needs_entity_rebuild = db_entities::collection_needs_code_entity_rebuild(&db, &collection.id)
            .unwrap_or(false)
            || db::get_collection(&db, &collection.id)?.code_entity_count <= 0;
        rebuild || needs_entity_rebuild
    };

    let scanned = {
        let db = state.db.lock().await;
        db::update_collection_status(
            &db,
            &collection.id,
            KcCollectionStatus::Scanning,
            None,
        )?;
        let (files, _, _, _, _) = scan_folder(&root_path, None)?;
        let count = files.len();
        db::sync_collection_files(&db, &collection.id, &files, true)?;
        db::update_collection_status(&db, &collection.id, KcCollectionStatus::Draft, None)?;
        count
    };

    let lexical_outcome = {
        let db = state.db.lock().await;
        indexer::index_lexical(&db, &collection.id, effective_rebuild, !effective_rebuild, window)?
    };

    let mut warnings = lexical_outcome.warnings.clone();
    let mut dense_status = "not_configured";
    let build_dense = std::env::var("NEXUS_QA_SKIP_DENSE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .map(|skip| !skip)
        .unwrap_or(true);

    if build_dense {
        let (partition_config, _) = {
            let db = state.db.lock().await;
            let collection = db::get_collection(&db, &collection.id)?;
            let folder_category =
                crate::knowledge_chat::partitions::KcFolderCategory::from_value(
                    &collection.folder_category,
                );
            let config = if collection.partition_config.is_empty() {
                let deploy = load_deployment(&db);
                embeddings::resolve_partition_config(folder_category, &deploy.models_dir, None, None)
            } else {
                collection.partition_config.clone()
            };
            (config, ())
        };

        let remote = remote;
        match embeddings::embed_missing_dense_vectors_partitioned(
            state.db.clone(),
            state.kc_embed_pool.clone(),
            &collection.id,
            &partition_config,
            remote,
            window,
        )
        .await
        {
            Ok(outcome) => {
                warnings.extend(outcome.warnings);
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
                warnings.push(format!("Dense embedding skipped for QA corpus: {err}"));
            }
        }
    }

    let index_result = {
        let db = state.db.lock().await;
        indexer::finalize_index(
            &db,
            &collection.id,
            LexicalIndexOutcome {
                warnings: warnings.clone(),
                ..lexical_outcome
            },
            dense_status,
            window,
        )?
    };

    {
        let db = state.db.lock().await;
        let _ = db.set_setting(QA_COLLECTION_SETTING, &collection.id);
    }

    let collection = {
        let db = state.db.lock().await;
        db::get_collection(&db, &collection.id)?
    };

    Ok(KcQaCorpusBootstrapResult {
        collection_id: collection.id.clone(),
        collection_name: collection.name.clone(),
        root_path: collection.root_path.clone(),
        scanned_files: scanned,
        indexed_files: index_result.total_indexed_files.max(0) as usize,
        chunk_count: index_result.chunk_count,
        dense_chunk_count: index_result.dense_chunk_count,
        status: index_result.status.clone(),
        message: format!(
            "QA corpus ready at {} — {} files indexed, {} sections ({} dense).",
            collection.root_path,
            index_result.total_indexed_files,
            index_result.chunk_count,
            index_result.dense_chunk_count
        ),
        warnings,
    })
}

fn resolve_or_create_collection(db: &crate::database::Database, root_path: &str) -> AppResult<KcCollection> {
    if let Some(existing) = db::find_collection_by_root_path(db, root_path)? {
        return Ok(existing);
    }
    if let Ok(Some(id)) = db.get_setting(QA_COLLECTION_SETTING) {
        if let Ok(collection) = db::get_collection(db, &id) {
            if deployment::normalize_path_for_check(&collection.root_path)
                == deployment::normalize_path_for_check(root_path)
            {
                return Ok(collection);
            }
        }
    }

    let deploy = load_deployment(db);
    let folder_category = crate::knowledge_chat::partitions::KcFolderCategory::Mixed;
    let partition_config = embeddings::resolve_partition_config(
        folder_category,
        &deploy.models_dir,
        None,
        None,
    );
    let code_model =
        partition_config.model_path_for(crate::knowledge_chat::partitions::KcPartitionId::Code);
    db::create_collection(
        db,
        QA_COLLECTION_NAME,
        root_path,
        &code_model,
        folder_category.as_str(),
        &partition_config,
    )
}

fn sync_qa_corpus(source: &Path, dest: &Path, force: bool) -> std::io::Result<usize> {
    if !source.is_dir() {
        return Ok(0);
    }
    std::fs::create_dir_all(dest)?;
    let mut copied = 0usize;
    for entry in walkdir::WalkDir::new(source).into_iter().filter_map(|e| e.ok()) {
        let src = entry.path();
        if src.is_dir() {
            continue;
        }
        let rel = src.strip_prefix(source).unwrap_or(src);
        let target = dest.join(rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let copy = force
            || !target.exists()
            || source_newer_than(src, &target);
        if copy {
            std::fs::copy(src, &target)?;
            copied += 1;
        }
    }
    // Remove legacy demo cheatsheet artifacts that may remain from older syncs.
    for stale in ["demo_cheatsheet.json", "demo_cheatsheet.template.json"] {
        let path = dest.join(stale);
        if path.is_file() {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(copied)
}

fn source_newer_than(src: &Path, dest: &Path) -> bool {
    let (Ok(src_meta), Ok(dest_meta)) = (src.metadata(), dest.metadata()) else {
        return true;
    };
    let (Ok(src_mod), Ok(dest_mod)) = (src_meta.modified(), dest_meta.modified()) else {
        return true;
    };
    src_mod > dest_mod
}

/// On app launch: copy QA corpus fixtures only. Do not scan/index/embed —
/// users run Scan Folder / Build Index manually (or `kc_ensure_qa_corpus`).
pub fn spawn_startup_bootstrap(_app_handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let runtime = qa_corpus_runtime_path();
        let source = qa_corpus_source_path();
        if !source.is_dir() {
            log::info!(
                "QA corpus source not found ({}); skipping startup file sync",
                source.display()
            );
            return;
        }
        match sync_qa_corpus(&source, &runtime, false) {
            Ok(copied) => {
                if copied > 0 {
                    log::info!(
                        "Synced {copied} QA corpus file(s) to {} (index/embed manually)",
                        runtime.display()
                    );
                }
            }
            Err(err) => log::warn!("QA corpus startup sync skipped: {err}"),
        }
    });
}
