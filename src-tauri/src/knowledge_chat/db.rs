use crate::database::Database;
use crate::deployment::load_deployment_config;
use crate::error::{AppError, AppResult};
use crate::knowledge_chat::partitions::KcPartitionId;
use crate::knowledge_chat::types::{
    KcChunkRecord, KcCollection, KcCollectionStatus, KcFileIssue, KcFileRecord, KcFileStatus,
    KcPartitionConfig, KC_DEFAULT_EMBEDDING_MODEL,
};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json;
use uuid::Uuid;

const CHUNK_SELECT_COLUMNS: &str = "c.id, c.collection_id, c.file_id, f.name, f.absolute_path, c.chunk_index, c.title,
                c.start_char, c.end_char, c.text, c.top_terms_json, c.lexical_vector_json, c.dense_vector_json,
                c.parent_text, c.section_path, c.doc_type, c.line_start, c.line_end, c.page_start, c.page_end, c.partition_id,
                c.source_type, c.entity_kind, c.entity_name, c.parse_mode";

fn status_to_str(status: &KcCollectionStatus) -> &'static str {
    match status {
        KcCollectionStatus::Draft => "draft",
        KcCollectionStatus::Scanning => "scanning",
        KcCollectionStatus::Indexing => "indexing",
        KcCollectionStatus::Ready => "ready",
        KcCollectionStatus::Failed => "failed",
    }
}

fn status_from_str(value: &str) -> KcCollectionStatus {
    match value {
        "scanning" => KcCollectionStatus::Scanning,
        "indexing" => KcCollectionStatus::Indexing,
        "ready" => KcCollectionStatus::Ready,
        "failed" => KcCollectionStatus::Failed,
        _ => KcCollectionStatus::Draft,
    }
}

fn file_status_from_str(value: &str) -> KcFileStatus {
    match value {
        "indexed" => KcFileStatus::Indexed,
        "skipped" => KcFileStatus::Skipped,
        "error" => KcFileStatus::Error,
        _ => KcFileStatus::Pending,
    }
}

fn file_status_to_str(status: &KcFileStatus) -> &'static str {
    match status {
        KcFileStatus::Indexed => "indexed",
        KcFileStatus::Skipped => "skipped",
        KcFileStatus::Error => "error",
        KcFileStatus::Pending => "pending",
    }
}

pub fn get_default_embedding_model(db: &Database) -> String {
    let configured = db
        .conn()
        .query_row(
            "SELECT value FROM settings WHERE key = 'kc_default_embedding_model'",
            [],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
        .map(|value: String| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            let deploy = load_deployment_config(db);
            let path = deploy.embedding_model_path.trim().to_string();
            if path.is_empty() {
                None
            } else {
                Some(path)
            }
        })
        .unwrap_or_else(|| KC_DEFAULT_EMBEDDING_MODEL.to_string());

    let deploy = load_deployment_config(db);
    if let Ok(resolved) = crate::knowledge_chat::embeddings::try_resolve_embedding_model_path(
        &configured,
        Some(&deploy.models_dir),
    ) {
        if !resolved.is_empty() {
            return resolved;
        }
    }

    let discovered = crate::knowledge_chat::embeddings::discover_embedding_models(&[
        deploy.models_dir.clone(),
        configured.clone(),
    ]);
    crate::knowledge_chat::embeddings::prefer_embedding_model(&discovered)
        .unwrap_or_default()
}

pub fn set_default_embedding_model(db: &Database, model_path: &str) -> AppResult<()> {
    db.conn()
        .execute(
            "INSERT INTO settings (key, value) VALUES ('kc_default_embedding_model', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![model_path],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}

pub fn create_collection(
    db: &Database,
    name: &str,
    root_path: &str,
    embedding_model_path: &str,
    folder_category: &str,
    partition_config: &KcPartitionConfig,
) -> AppResult<KcCollection> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().timestamp();
    let partition_json = serde_json::to_string(partition_config)
        .map_err(|e| AppError::Unknown(format!("Failed to serialize partition config: {e}")))?;
    db.conn()
        .execute(
            "INSERT INTO kc_collections (
                id, name, root_path, status, embedding_model_path, dense_status,
                file_count, indexed_file_count, chunk_count, dense_chunk_count, indexed_char_count,
                last_error, created_at, updated_at, last_indexed_at, folder_category, partition_config_json,
                image_rag_opt_in, allow_cloud_media
            ) VALUES (?1, ?2, ?3, 'draft', ?4, 'not_configured', 0, 0, 0, 0, 0, NULL, ?5, ?5, NULL, ?6, ?7, 0, 0)",
            params![id, name, root_path, embedding_model_path, now, folder_category, partition_json],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    get_collection(db, &id)
}

pub fn update_collection_partition_config(
    db: &Database,
    collection_id: &str,
    folder_category: &str,
    partition_config: &KcPartitionConfig,
    embedding_model_path: &str,
) -> AppResult<()> {
    let partition_json = serde_json::to_string(partition_config)
        .map_err(|e| AppError::Unknown(format!("Failed to serialize partition config: {e}")))?;
    let now = Utc::now().timestamp();
    db.conn()
        .execute(
            "UPDATE kc_collections SET folder_category = ?1, partition_config_json = ?2, embedding_model_path = ?3, updated_at = ?4 WHERE id = ?5",
            params![folder_category, partition_json, embedding_model_path, now, collection_id],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}

pub fn list_collections(db: &Database) -> AppResult<Vec<KcCollection>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, name, root_path, status, embedding_model_path, dense_status,
                    file_count, indexed_file_count, chunk_count, dense_chunk_count, indexed_char_count,
                    last_error, created_at, updated_at, last_indexed_at, folder_category, partition_config_json,
                    COALESCE(code_entity_count, 0) AS code_entity_count,
                    COALESCE(image_rag_opt_in, 0) AS image_rag_opt_in,
                    COALESCE(allow_cloud_media, 0) AS allow_cloud_media
             FROM kc_collections ORDER BY updated_at DESC",
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = stmt
        .query_map([], map_collection_row)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))
}

pub fn get_collection(db: &Database, id: &str) -> AppResult<KcCollection> {
    db.conn()
        .query_row(
            "SELECT id, name, root_path, status, embedding_model_path, dense_status,
                    file_count, indexed_file_count, chunk_count, dense_chunk_count, indexed_char_count,
                    last_error, created_at, updated_at, last_indexed_at, folder_category, partition_config_json,
                    COALESCE(code_entity_count, 0) AS code_entity_count,
                    COALESCE(image_rag_opt_in, 0) AS image_rag_opt_in,
                    COALESCE(allow_cloud_media, 0) AS allow_cloud_media
             FROM kc_collections WHERE id = ?1",
            params![id],
            map_collection_row,
        )
        .map_err(|e| AppError::DatabaseError(format!("Collection not found: {e}")))
}

pub fn find_collection_by_root_path(db: &Database, root_path: &str) -> AppResult<Option<KcCollection>> {
    let target = crate::deployment::normalize_path_for_check(root_path);
    let collections = list_collections(db)?;
    Ok(collections.into_iter().find(|collection| {
        crate::deployment::normalize_path_for_check(&collection.root_path) == target
    }))
}

pub fn delete_collection(db: &Database, id: &str) -> AppResult<()> {
    db.conn()
        .execute("DELETE FROM kc_collections WHERE id = ?1", params![id])
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}

pub fn update_collection_status(
    db: &Database,
    id: &str,
    status: KcCollectionStatus,
    last_error: Option<&str>,
) -> AppResult<()> {
    let now = Utc::now().timestamp();
    db.conn()
        .execute(
            "UPDATE kc_collections SET status = ?1, last_error = ?2, updated_at = ?3 WHERE id = ?4",
            params![status_to_str(&status), last_error, now, id],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}

pub fn replace_collection_files(
    db: &Database,
    collection_id: &str,
    files: &[crate::knowledge_chat::types::KcScannedFile],
) -> AppResult<()> {
    sync_collection_files(db, collection_id, files, false)
}

pub fn sync_collection_files(
    db: &Database,
    collection_id: &str,
    files: &[crate::knowledge_chat::types::KcScannedFile],
    incremental: bool,
) -> AppResult<()> {
    let existing = list_files_by_status(db, collection_id, None)?;
    let existing_by_path: std::collections::HashMap<String, KcFileRecord> = existing
        .into_iter()
        .map(|file| (file.absolute_path.clone(), file))
        .collect();

    let tx = db.conn().unchecked_transaction().map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let mut seen_paths = std::collections::HashSet::new();

    for file in files {
        seen_paths.insert(file.absolute_path.clone());
        let priority_tier = crate::knowledge_chat::filter::priority_tier_for_path(&file.relative_path);

        if let Some(existing_file) = existing_by_path.get(&file.absolute_path) {
            if incremental
                && existing_file.status == KcFileStatus::Indexed
                && existing_file.modified_at == file.modified_at
                && existing_file.size_bytes == file.size_bytes as i64
            {
                tx.execute(
                    "UPDATE kc_files SET name = ?1, extension = ?2, relative_path = ?3, priority_tier = ?4, error_message = ?5
                     WHERE id = ?6",
                    params![
                        file.name,
                        file.extension,
                        file.relative_path,
                        priority_tier,
                        file.skip_reason,
                        existing_file.id,
                    ],
                )
                .map_err(|e| AppError::DatabaseError(e.to_string()))?;
                continue;
            }

            tx.execute("DELETE FROM kc_chunks WHERE file_id = ?1", params![existing_file.id])
                .map_err(|e| AppError::DatabaseError(e.to_string()))?;
            let status = if file.supported { KcFileStatus::Pending } else { KcFileStatus::Skipped };
            tx.execute(
                "UPDATE kc_files SET relative_path = ?1, name = ?2, extension = ?3, size_bytes = ?4, modified_at = ?5,
                 content_hash = NULL, text_fingerprint = NULL, status = ?6, char_count = 0, chunk_count = 0, error_message = ?7, priority_tier = ?8
                 WHERE id = ?9",
                params![
                    file.relative_path,
                    file.name,
                    file.extension,
                    file.size_bytes as i64,
                    file.modified_at,
                    file_status_to_str(&status),
                    file.skip_reason,
                    priority_tier,
                    existing_file.id,
                ],
            )
            .map_err(|e| AppError::DatabaseError(e.to_string()))?;
            continue;
        }

        let id = Uuid::new_v4().to_string();
        let status = if file.supported { KcFileStatus::Pending } else { KcFileStatus::Skipped };
        tx.execute(
            "INSERT INTO kc_files (
                id, collection_id, relative_path, absolute_path, name, extension,
                size_bytes, modified_at, content_hash, text_fingerprint, status, char_count, chunk_count, error_message, priority_tier
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, ?9, 0, 0, ?10, ?11)",
            params![
                id,
                collection_id,
                file.relative_path,
                file.absolute_path,
                file.name,
                file.extension,
                file.size_bytes as i64,
                file.modified_at,
                file_status_to_str(&status),
                file.skip_reason,
                priority_tier,
            ],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    }

    for existing_file in existing_by_path.values() {
        if !seen_paths.contains(&existing_file.absolute_path) {
            tx.execute("DELETE FROM kc_files WHERE id = ?1", params![existing_file.id])
                .map_err(|e| AppError::DatabaseError(e.to_string()))?;
        }
    }

    let file_count = files.len() as i64;
    let now = Utc::now().timestamp();
    tx.execute(
        "UPDATE kc_collections SET file_count = ?1, updated_at = ?2 WHERE id = ?3",
        params![file_count, now, collection_id],
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    tx.commit().map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}

const KC_FILE_SELECT: &str = "SELECT id, collection_id, relative_path, absolute_path, name, extension, size_bytes, modified_at,
                content_hash, status, char_count, chunk_count, error_message, text_fingerprint, priority_tier,
                code_parse_mode, code_entity_count, code_language";

pub fn list_pending_files(db: &Database, collection_id: &str) -> AppResult<Vec<KcFileRecord>> {
    let sql = format!(
        "{KC_FILE_SELECT} FROM kc_files WHERE collection_id = ?1 AND status = 'pending' ORDER BY priority_tier ASC, relative_path ASC"
    );
    let mut stmt = db.conn().prepare(&sql).map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = stmt
        .query_map(params![collection_id], map_file_row)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))
}

pub fn list_files_by_status(
    db: &Database,
    collection_id: &str,
    status: Option<KcFileStatus>,
) -> AppResult<Vec<KcFileRecord>> {
    let sql = if status.is_some() {
        format!("{KC_FILE_SELECT} FROM kc_files WHERE collection_id = ?1 AND status = ?2 ORDER BY priority_tier ASC, relative_path ASC")
    } else {
        format!("{KC_FILE_SELECT} FROM kc_files WHERE collection_id = ?1 ORDER BY priority_tier ASC, relative_path ASC")
    };

    let mut stmt = db.conn().prepare(&sql).map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = if let Some(status) = status {
        stmt.query_map(params![collection_id, file_status_to_str(&status)], map_file_row)
    } else {
        stmt.query_map(params![collection_id], map_file_row)
    }
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))
}

pub fn clear_collection_index(db: &Database, collection_id: &str) -> AppResult<()> {
    let tx = db.conn().unchecked_transaction().map_err(|e| AppError::DatabaseError(e.to_string()))?;
    tx.execute("DELETE FROM kc_chunks WHERE collection_id = ?1", params![collection_id])
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let _ = tx.execute("DELETE FROM kc_chunks_fts WHERE collection_id = ?1", params![collection_id]);
    let _ = tx.execute("DELETE FROM kc_code_entities WHERE collection_id = ?1", params![collection_id]);
    let _ = tx.execute("DELETE FROM kc_code_entities_fts WHERE collection_id = ?1", params![collection_id]);
    tx.execute(
        "UPDATE kc_files SET status = 'pending', char_count = 0, chunk_count = 0, code_entity_count = 0,
         code_parse_mode = NULL, code_language = NULL, error_message = NULL, content_hash = NULL, text_fingerprint = NULL
         WHERE collection_id = ?1 AND status != 'skipped'",
        params![collection_id],
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    tx.execute(
        "UPDATE kc_collections SET chunk_count = 0, dense_chunk_count = 0, indexed_char_count = 0,
         indexed_file_count = 0, dense_status = 'not_configured', last_indexed_at = NULL WHERE id = ?1",
        params![collection_id],
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    tx.commit().map_err(|e| AppError::DatabaseError(e.to_string()))?;
    crate::knowledge_chat::dense_hnsw::invalidate_collection(collection_id);
    Ok(())
}

pub struct StoredChunkInput {
    pub file_id: String,
    pub chunk_index: i64,
    pub title: String,
    pub start_char: i64,
    pub end_char: i64,
    pub line_start: i32,
    pub line_end: i32,
    pub page_start: Option<i32>,
    pub page_end: Option<i32>,
    pub text: String,
    pub parent_text: String,
    pub section_path: String,
    pub doc_type: String,
    pub partition_id: String,
    pub text_fingerprint: String,
    pub top_terms: Vec<String>,
    pub lexical_vector: Vec<f32>,
    pub dense_vector: Option<Vec<f32>>,
}

pub fn collection_has_dense_vectors(db: &Database, collection_id: &str) -> AppResult<bool> {
    let count: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM kc_chunks WHERE collection_id = ?1 AND dense_vector_json IS NOT NULL LIMIT 1",
        params![collection_id],
        |row| row.get(0),
    ).map_err(|e| AppError::DatabaseError(e.to_string()))?;
    if count > 0 {
        return Ok(true);
    }
    let entity_count: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM kc_code_entities WHERE collection_id = ?1 AND dense_vector_json IS NOT NULL LIMIT 1",
        params![collection_id],
        |row| row.get(0),
    ).unwrap_or(0);
    Ok(entity_count > 0)
}

pub fn replace_file_chunks(
    tx: &Transaction<'_>,
    collection_id: &str,
    file: &KcFileRecord,
    content_hash: &str,
    chunks: &[StoredChunkInput],
) -> AppResult<()> {
    tx.execute("DELETE FROM kc_chunks WHERE file_id = ?1", params![file.id])
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    let now = Utc::now().timestamp();
    let mut char_count = 0i64;
    for chunk in chunks {
        char_count += chunk.text.chars().count() as i64;
        let chunk_id = format!("{}::chunk-{}", file.id, chunk.chunk_index);
        let top_terms_json = serde_json::to_string(&chunk.top_terms)
            .map_err(|e| AppError::Unknown(format!("Failed to serialize top terms: {e}")))?;
        let lexical_json = serde_json::to_string(&chunk.lexical_vector)
            .map_err(|e| AppError::Unknown(format!("Failed to serialize lexical vector: {e}")))?;
        let dense_json = chunk
            .dense_vector
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| AppError::Unknown(format!("Failed to serialize dense vector: {e}")))?;

        let dense_dim = chunk.dense_vector.as_ref().map(|v| v.len() as i64);
        tx.execute(
            "INSERT INTO kc_chunks (
                id, collection_id, file_id, chunk_index, title, start_char, end_char, text,
                top_terms_json, lexical_vector_json, dense_vector_json, created_at,
                parent_text, section_path, doc_type, text_fingerprint,
                line_start, line_end, page_start, page_end, partition_id, dense_vector_dim
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
            params![
                chunk_id,
                collection_id,
                file.id,
                chunk.chunk_index,
                chunk.title,
                chunk.start_char,
                chunk.end_char,
                chunk.text,
                top_terms_json,
                lexical_json,
                dense_json,
                now,
                chunk.parent_text,
                chunk.section_path,
                chunk.doc_type,
                chunk.text_fingerprint,
                chunk.line_start,
                chunk.line_end,
                chunk.page_start,
                chunk.page_end,
                chunk.partition_id,
                dense_dim,
            ],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

        tx.execute("DELETE FROM kc_chunks_fts WHERE chunk_id = ?1", params![chunk_id])
            .map_err(|e| AppError::DatabaseError(e.to_string()))?;
        tx.execute(
            "INSERT INTO kc_chunks_fts (chunk_id, collection_id, file_name, title, section_path, text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                chunk_id,
                collection_id,
                file.name,
                chunk.title,
                chunk.section_path,
                format!("{} {}", chunk.parent_text, chunk.text),
            ],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    }

    let file_fingerprint = chunks
        .iter()
        .map(|chunk| chunk.text_fingerprint.as_str())
        .collect::<Vec<_>>()
        .join("|");
    tx.execute(
        "UPDATE kc_files SET status = 'indexed', char_count = ?1, chunk_count = ?2, content_hash = ?3, text_fingerprint = ?4, error_message = NULL
         WHERE id = ?5",
        params![char_count, chunks.len() as i64, content_hash, file_fingerprint, file.id],
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}

pub fn mark_file_error(tx: &Transaction<'_>, file_id: &str, message: &str) -> AppResult<()> {
    tx.execute(
        "UPDATE kc_files SET status = 'error', error_message = ?1, chunk_count = 0, char_count = 0 WHERE id = ?2",
        params![message, file_id],
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}

pub fn mark_file_skipped(tx: &Transaction<'_>, file_id: &str, message: &str) -> AppResult<()> {
    tx.execute(
        "UPDATE kc_files SET status = 'skipped', error_message = ?1, chunk_count = 0, char_count = 0 WHERE id = ?2",
        params![message, file_id],
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}

pub fn refresh_collection_stats(db: &Database, collection_id: &str, dense_status: Option<&str>) -> AppResult<KcCollection> {
    let indexed_file_count: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM kc_files WHERE collection_id = ?1 AND status = 'indexed'",
        params![collection_id],
        |row| row.get(0),
    ).map_err(|e| AppError::DatabaseError(e.to_string()))?;

    let chunk_count: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM kc_chunks WHERE collection_id = ?1",
        params![collection_id],
        |row| row.get(0),
    ).map_err(|e| AppError::DatabaseError(e.to_string()))?;

    let dense_chunk_count: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM kc_chunks WHERE collection_id = ?1 AND dense_vector_json IS NOT NULL",
        params![collection_id],
        |row| row.get(0),
    ).map_err(|e| AppError::DatabaseError(e.to_string()))?;

    let indexed_char_count: i64 = db.conn().query_row(
        "SELECT COALESCE(SUM(char_count), 0) FROM kc_files WHERE collection_id = ?1 AND status = 'indexed'",
        params![collection_id],
        |row| row.get(0),
    ).map_err(|e| AppError::DatabaseError(e.to_string()))?;

    let code_entity_count: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM kc_code_entities WHERE collection_id = ?1",
        params![collection_id],
        |row| row.get(0),
    ).unwrap_or(0);

    let entity_dense_count: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM kc_code_entities WHERE collection_id = ?1 AND dense_vector_json IS NOT NULL",
        params![collection_id],
        |row| row.get(0),
    ).unwrap_or(0);

    let dense_total = dense_chunk_count + entity_dense_count;

    let now = Utc::now().timestamp();
    if let Some(dense_status) = dense_status {
        db.conn().execute(
            "UPDATE kc_collections SET indexed_file_count = ?1, chunk_count = ?2, dense_chunk_count = ?3,
             code_entity_count = ?4, indexed_char_count = ?5, updated_at = ?6, last_indexed_at = ?6, dense_status = ?7 WHERE id = ?8",
            params![indexed_file_count, chunk_count, dense_total, code_entity_count, indexed_char_count, now, dense_status, collection_id],
        ).map_err(|e| AppError::DatabaseError(e.to_string()))?;
    } else {
        db.conn().execute(
            "UPDATE kc_collections SET indexed_file_count = ?1, chunk_count = ?2, dense_chunk_count = ?3,
             code_entity_count = ?4, indexed_char_count = ?5, updated_at = ?6, last_indexed_at = ?6 WHERE id = ?7",
            params![indexed_file_count, chunk_count, dense_total, code_entity_count, indexed_char_count, now, collection_id],
        ).map_err(|e| AppError::DatabaseError(e.to_string()))?;
    }

    get_collection(db, collection_id)
}

pub fn list_non_indexed_file_issues(db: &Database, collection_id: &str) -> AppResult<Vec<KcFileIssue>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT relative_path, status, error_message FROM kc_files
             WHERE collection_id = ?1 AND status != 'indexed'
             ORDER BY relative_path",
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = stmt
        .query_map(params![collection_id], |row| {
            Ok(KcFileIssue {
                relative_path: row.get(0)?,
                status: row.get(1)?,
                message: row.get(2)?,
            })
        })
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))
}

pub struct LoadedChunk {
    pub record: KcChunkRecord,
    pub lexical_vector: Vec<f32>,
    pub dense_vector: Option<Vec<f32>>,
}

pub fn load_chunks_for_search(db: &Database, collection_id: &str) -> AppResult<Vec<LoadedChunk>> {
    let mut stmt = db.conn().prepare(
        &format!(
            "SELECT {CHUNK_SELECT_COLUMNS}
         FROM kc_chunks c
         JOIN kc_files f ON f.id = c.file_id
         WHERE c.collection_id = ?1"
        ),
    ).map_err(|e| AppError::DatabaseError(e.to_string()))?;

    let rows = stmt.query_map(params![collection_id], map_loaded_chunk_row)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))
}

pub struct ChunkLexicalRow {
    pub id: String,
    pub lexical_vector: Vec<f32>,
}

pub struct ChunkDenseEmbedRow {
    pub id: String,
    pub file_name: String,
    pub title: String,
    pub section_path: String,
    pub parent_text: String,
    pub text: String,
}

pub fn load_lexical_rows_for_search(db: &Database, collection_id: &str) -> AppResult<Vec<ChunkLexicalRow>> {
    let mut rows = {
        let mut stmt = db.conn().prepare(
            "SELECT id, lexical_vector_json FROM kc_chunks WHERE collection_id = ?1",
        ).map_err(|e| AppError::DatabaseError(e.to_string()))?;
        let chunk_rows: Vec<ChunkLexicalRow> = stmt
            .query_map(params![collection_id], |row| {
                let lexical_json: String = row.get(1)?;
                let lexical_vector: Vec<f32> = serde_json::from_str(&lexical_json).unwrap_or_default();
                Ok(ChunkLexicalRow {
                    id: row.get(0)?,
                    lexical_vector,
                })
            })
            .map_err(|e| AppError::DatabaseError(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::DatabaseError(e.to_string()))?;
        chunk_rows
    };
    crate::knowledge_chat::db_entities::append_entity_lexical_rows(db, collection_id, &mut rows)?;
    Ok(rows)
}

pub fn load_chunk_ids_for_file_substring(
    db: &Database,
    collection_id: &str,
    file_substr: &str,
    limit: usize,
) -> AppResult<Vec<String>> {
    let pattern = format!("%{}%", file_substr.to_lowercase());
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id FROM kc_chunks
             WHERE collection_id = ?1
               AND (lower(file_name) LIKE ?2 OR lower(file_path) LIKE ?2)
             LIMIT ?3",
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = stmt
        .query_map(params![collection_id, pattern, limit as i64], |row| row.get(0))
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(rows)
}

pub fn load_chunk_ids_for_entity_name(
    db: &Database,
    collection_id: &str,
    entity_name: &str,
    limit: usize,
) -> AppResult<Vec<String>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id FROM kc_code_entities
             WHERE collection_id = ?1 AND lower(entity_name) = lower(?2)
             LIMIT ?3",
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = stmt
        .query_map(params![collection_id, entity_name, limit as i64], |row| row.get(0))
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(rows)
}

pub fn load_chunk_ids_containing_text(
    db: &Database,
    collection_id: &str,
    needle: &str,
    limit: usize,
) -> AppResult<Vec<String>> {
    let pattern = format!("%{}%", needle.to_lowercase());
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id FROM kc_chunks
             WHERE collection_id = ?1 AND lower(text) LIKE ?2
             LIMIT ?3",
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = stmt
        .query_map(params![collection_id, pattern, limit as i64], |row| row.get(0))
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(rows)
}

/// Load same-file neighbors at `chunk_index ± 1` (empty if none).
pub fn load_adjacent_file_chunks(
    db: &Database,
    collection_id: &str,
    file_id: &str,
    chunk_index: i64,
) -> AppResult<Vec<LoadedChunk>> {
    let prev = chunk_index - 1;
    let next = chunk_index + 1;
    let sql = format!(
        "SELECT {CHUNK_SELECT_COLUMNS}
         FROM kc_chunks c
         JOIN kc_files f ON f.id = c.file_id
         WHERE c.collection_id = ?1 AND c.file_id = ?2 AND c.chunk_index IN (?3, ?4)
         ORDER BY c.chunk_index ASC"
    );
    let mut stmt = db
        .conn()
        .prepare(&sql)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = stmt
        .query_map(
            params![collection_id, file_id, prev, next],
            map_loaded_chunk_row,
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(rows)
}

pub fn load_chunks_by_ids(
    db: &Database,
    collection_id: &str,
    ids: &[String],
) -> AppResult<Vec<LoadedChunk>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::with_capacity(ids.len());
    let entity_ids: Vec<String> = ids.iter().filter(|id| crate::knowledge_chat::db_entities::is_entity_id(id)).cloned().collect();
    let chunk_ids: Vec<String> = ids.iter().filter(|id| !crate::knowledge_chat::db_entities::is_entity_id(id)).cloned().collect();

    if !chunk_ids.is_empty() {
        for batch in chunk_ids.chunks(120) {
        let placeholders = batch.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let sql = format!(
            "SELECT {CHUNK_SELECT_COLUMNS}
             FROM kc_chunks c
             JOIN kc_files f ON f.id = c.file_id
             WHERE c.collection_id = ?1 AND c.id IN ({placeholders})"
        );
        let mut stmt = db.conn().prepare(&sql).map_err(|e| AppError::DatabaseError(e.to_string()))?;
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(collection_id.to_string())];
        for id in batch {
            params.push(Box::new(id.clone()));
        }
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(param_refs.as_slice(), map_loaded_chunk_row)
            .map_err(|e| AppError::DatabaseError(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::DatabaseError(e.to_string()))?;
        out.extend(rows);
        }
    }

    if !entity_ids.is_empty() {
        out.extend(crate::knowledge_chat::db_entities::load_entities_by_ids(db, collection_id, &entity_ids)?);
    }
    Ok(out)
}

pub fn list_chunks_missing_dense_for_partition(
    db: &Database,
    collection_id: &str,
    partition: KcPartitionId,
) -> AppResult<Vec<ChunkDenseEmbedRow>> {
    let mut stmt = db.conn().prepare(
        "SELECT c.id, f.name, c.title, c.section_path, COALESCE(c.parent_text, ''), c.text
         FROM kc_chunks c
         JOIN kc_files f ON f.id = c.file_id
         WHERE c.collection_id = ?1 AND c.partition_id = ?2 AND c.dense_vector_json IS NULL
         ORDER BY c.id ASC",
    ).map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let mut rows = stmt
        .query_map(params![collection_id, partition.as_str()], |row| {
            Ok(ChunkDenseEmbedRow {
                id: row.get(0)?,
                file_name: row.get(1)?,
                title: row.get(2)?,
                section_path: row.get(3)?,
                parent_text: row.get(4)?,
                text: row.get(5)?,
            })
        })
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    if partition == KcPartitionId::Code {
        rows.extend(crate::knowledge_chat::db_entities::list_entities_missing_dense(db, collection_id)?);
    }
    Ok(rows)
}

/// (total chunks, dense chunks) for a partition.
pub fn partition_chunk_counts(
    db: &Database,
    collection_id: &str,
    partition: KcPartitionId,
) -> AppResult<(i64, i64)> {
    let total: i64 = if partition == KcPartitionId::Code {
        let chunks: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM kc_chunks WHERE collection_id = ?1 AND partition_id = ?2",
            params![collection_id, partition.as_str()],
            |row| row.get(0),
        ).map_err(|e| AppError::DatabaseError(e.to_string()))?;
        let entities = crate::knowledge_chat::db_entities::collection_code_entity_count(db, collection_id)?;
        chunks + entities
    } else {
        db.conn().query_row(
            "SELECT COUNT(*) FROM kc_chunks WHERE collection_id = ?1 AND partition_id = ?2",
            params![collection_id, partition.as_str()],
            |row| row.get(0),
        ).map_err(|e| AppError::DatabaseError(e.to_string()))?
    };
    let dense: i64 = if partition == KcPartitionId::Code {
        let chunk_dense: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM kc_chunks WHERE collection_id = ?1 AND partition_id = ?2 AND dense_vector_json IS NOT NULL",
            params![collection_id, partition.as_str()],
            |row| row.get(0),
        ).map_err(|e| AppError::DatabaseError(e.to_string()))?;
        let entity_dense: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM kc_code_entities WHERE collection_id = ?1 AND dense_vector_json IS NOT NULL",
            params![collection_id],
            |row| row.get(0),
        ).unwrap_or(0);
        chunk_dense + entity_dense
    } else {
        db.conn().query_row(
            "SELECT COUNT(*) FROM kc_chunks WHERE collection_id = ?1 AND partition_id = ?2 AND dense_vector_json IS NOT NULL",
            params![collection_id, partition.as_str()],
            |row| row.get(0),
        ).map_err(|e| AppError::DatabaseError(e.to_string()))?
    };
    Ok((total, dense))
}

/// Stored dense vector dimension for a partition, if any chunk is embedded.
pub fn partition_vector_dimension(
    db: &Database,
    collection_id: &str,
    partition: KcPartitionId,
) -> AppResult<Option<i64>> {
    let dim: Option<i64> = db.conn().query_row(
        "SELECT dense_vector_dim FROM kc_chunks
         WHERE collection_id = ?1 AND partition_id = ?2 AND dense_vector_dim IS NOT NULL
         LIMIT 1",
        params![collection_id, partition.as_str()],
        |row| row.get(0),
    ).optional().map_err(|e| AppError::DatabaseError(e.to_string()))?.flatten();
    Ok(dim)
}

fn map_loaded_chunk_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LoadedChunk> {
    let top_terms_json: String = row.get(10)?;
    let lexical_json: String = row.get(11)?;
    let dense_json: Option<String> = row.get(12)?;
    let parent_text: Option<String> = row.get(13).ok();
    let section_path: Option<String> = row.get(14).ok();
    let doc_type: Option<String> = row.get(15).ok();
    let line_start: i32 = row.get(16).unwrap_or(0);
    let line_end: i32 = row.get(17).unwrap_or(0);
    let page_start: Option<i32> = row.get(18).ok();
    let page_end: Option<i32> = row.get(19).ok();
    let partition_id: Option<String> = row.get(20).ok();
    let source_type: String = row.get(21).unwrap_or_else(|_| "chunk".to_string());
    let entity_kind: Option<String> = row.get(22).ok();
    let entity_name: Option<String> = row.get(23).ok();
    let parse_mode: Option<String> = row.get(24).ok();
    let top_terms: Vec<String> = serde_json::from_str(&top_terms_json).unwrap_or_default();
    let lexical_vector: Vec<f32> = serde_json::from_str(&lexical_json).unwrap_or_default();
    let dense_vector: Option<Vec<f32>> = dense_json.and_then(|value| serde_json::from_str(&value).ok());
    let text: String = row.get(9)?;
    let context_text = parent_text
        .clone()
        .filter(|value| value.len() > text.len())
        .or_else(|| Some(text.clone()));
    Ok(LoadedChunk {
        record: KcChunkRecord {
            id: row.get(0)?,
            collection_id: row.get(1)?,
            file_id: row.get(2)?,
            file_name: row.get(3)?,
            file_path: row.get(4)?,
            chunk_index: row.get(5)?,
            title: row.get(6)?,
            start_char: row.get(7)?,
            end_char: row.get(8)?,
            text,
            top_terms,
            has_dense: dense_vector.is_some(),
            parent_text,
            section_path,
            doc_type,
            partition_id,
            context_text,
            line_start: if line_start > 0 { Some(line_start) } else { None },
            line_end: if line_end > 0 { Some(line_end) } else { None },
            page_start,
            page_end,
            source_type,
            entity_kind,
            entity_name,
            source_confidence: None,
            parse_mode,
        },
        lexical_vector,
        dense_vector,
    })
}

pub fn apply_dense_vectors_for_partition(
    db: &Database,
    collection_id: &str,
    partition: KcPartitionId,
    profile_id: &str,
    updates: &[(String, Vec<f32>)],
) -> AppResult<usize> {
    let tx = db.conn().unchecked_transaction().map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let mut stored = 0usize;
    for (chunk_id, vector) in updates {
        let dense_json = serde_json::to_string(vector)
            .map_err(|e| AppError::Unknown(format!("Failed to serialize dense vector: {e}")))?;
        let updated = tx.execute(
            "UPDATE kc_chunks SET dense_vector_json = ?1, embedding_profile_id = ?2, dense_vector_dim = ?3
             WHERE id = ?4 AND collection_id = ?5",
            params![dense_json, profile_id, vector.len() as i64, chunk_id, collection_id],
        ).map_err(|e| AppError::DatabaseError(e.to_string()))?;
        let entity_updated = if updated == 0 {
            tx.execute(
                "UPDATE kc_code_entities SET dense_vector_json = ?1, embedding_profile_id = ?2, dense_vector_dim = ?3
                 WHERE id = ?4 AND collection_id = ?5",
                params![dense_json, profile_id, vector.len() as i64, chunk_id, collection_id],
            ).map_err(|e| AppError::DatabaseError(e.to_string()))?
        } else {
            0
        };
        stored += updated + entity_updated;
    }
    tx.commit().map_err(|e| AppError::DatabaseError(e.to_string()))?;
    if stored > 0 {
        let _ = crate::knowledge_chat::dense_hnsw::rebuild_partition_index(db, collection_id, partition);
    }
    Ok(stored)
}

fn map_collection_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<KcCollection> {
    let folder_category: String = row.get::<_, Option<String>>(15)?.unwrap_or_else(|| "mixed".to_string());
    let partition_json: String = row.get::<_, Option<String>>(16)?.unwrap_or_default();
    let partition_config: KcPartitionConfig = if partition_json.trim().is_empty() {
        KcPartitionConfig::default()
    } else {
        serde_json::from_str(&partition_json).unwrap_or_default()
    };
    Ok(KcCollection {
        id: row.get(0)?,
        name: row.get(1)?,
        root_path: row.get(2)?,
        status: status_from_str(row.get::<_, String>(3)?.as_str()),
        embedding_model_path: row.get(4)?,
        dense_status: row.get(5)?,
        file_count: row.get(6)?,
        indexed_file_count: row.get(7)?,
        chunk_count: row.get(8)?,
        dense_chunk_count: row.get(9)?,
        indexed_char_count: row.get(10)?,
        last_error: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        last_indexed_at: row.get(14)?,
        folder_category,
        partition_config,
        code_entity_count: row.get::<_, i64>(17).unwrap_or(0),
        image_rag_opt_in: row.get::<_, i64>(18).unwrap_or(0) != 0,
        allow_cloud_media: row.get::<_, i64>(19).unwrap_or(0) != 0,
    })
}

pub fn update_collection_image_rag_flags(
    db: &Database,
    collection_id: &str,
    image_rag_opt_in: bool,
    allow_cloud_media: bool,
) -> AppResult<()> {
    let now = Utc::now().timestamp();
    db.conn()
        .execute(
            "UPDATE kc_collections SET image_rag_opt_in = ?1, allow_cloud_media = ?2, updated_at = ?3 WHERE id = ?4",
            params![
                if image_rag_opt_in { 1 } else { 0 },
                if allow_cloud_media { 1 } else { 0 },
                now,
                collection_id
            ],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}

fn map_file_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<KcFileRecord> {
    Ok(KcFileRecord {
        id: row.get(0)?,
        collection_id: row.get(1)?,
        relative_path: row.get(2)?,
        absolute_path: row.get(3)?,
        name: row.get(4)?,
        extension: row.get(5)?,
        size_bytes: row.get(6)?,
        modified_at: row.get(7)?,
        content_hash: row.get(8)?,
        status: file_status_from_str(row.get::<_, String>(9)?.as_str()),
        char_count: row.get(10)?,
        chunk_count: row.get(11)?,
        error_message: row.get(12)?,
        text_fingerprint: row.get(13).ok(),
        priority_tier: row.get(14).unwrap_or(1),
        code_parse_mode: row.get(15).ok(),
        code_entity_count: row.get::<_, i64>(16).unwrap_or(0),
        code_language: row.get(17).ok(),
    })
}

pub fn export_knowledge_chat_snapshot(db: &Database) -> AppResult<(Vec<KcCollection>, Vec<KcFileRecord>)> {
    let collections = list_collections(db)?;
    let mut files = Vec::new();
    for collection in &collections {
        files.extend(list_files_by_status(db, &collection.id, None)?);
    }
    Ok((collections, files))
}

pub fn restore_knowledge_chat_snapshot(
    db: &Database,
    collections: &[KcCollection],
    files: &[KcFileRecord],
) -> AppResult<()> {
    for collection in collections {
        let partition_json = serde_json::to_string(&collection.partition_config)
            .unwrap_or_default();
        db.conn().execute(
            "INSERT OR REPLACE INTO kc_collections (
                id, name, root_path, status, embedding_model_path, dense_status,
                file_count, indexed_file_count, chunk_count, dense_chunk_count, indexed_char_count,
                last_error, created_at, updated_at, last_indexed_at, folder_category, partition_config_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                collection.id,
                collection.name,
                collection.root_path,
                status_to_str(&collection.status),
                collection.embedding_model_path,
                collection.dense_status,
                collection.file_count,
                collection.indexed_file_count,
                collection.chunk_count,
                collection.dense_chunk_count,
                collection.indexed_char_count,
                collection.last_error,
                collection.created_at,
                collection.updated_at,
                collection.last_indexed_at,
                collection.folder_category,
                partition_json,
            ],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    }

    for file in files {
        db.conn().execute(
            "INSERT OR REPLACE INTO kc_files (
                id, collection_id, relative_path, absolute_path, name, extension, size_bytes,
                modified_at, content_hash, status, char_count, chunk_count, error_message,
                text_fingerprint, priority_tier
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                file.id,
                file.collection_id,
                file.relative_path,
                file.absolute_path,
                file.name,
                file.extension,
                file.size_bytes,
                file.modified_at,
                file.content_hash,
                file_status_to_str(&file.status),
                file.char_count,
                file.chunk_count,
                file.error_message,
                file.text_fingerprint,
                file.priority_tier,
            ],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    }
    Ok(())
}
