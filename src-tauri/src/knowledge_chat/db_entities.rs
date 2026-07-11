use crate::database::Database;
use crate::error::{AppError, AppResult};
use crate::knowledge_chat::code_entities::CodeParseMode;
use crate::knowledge_chat::types::{KcChunkRecord, KcFileRecord};
use chrono::Utc;
use rusqlite::{params, Transaction};
use serde_json;

use super::db::{LoadedChunk, StoredChunkInput};

pub struct StoredCodeEntityInput {
    pub entity_index: i64,
    pub language: String,
    pub parse_mode: CodeParseMode,
    pub entity_kind: String,
    pub entity_name: String,
    pub qualified_name: String,
    pub signature: String,
    pub body: String,
    pub line_start: i32,
    pub line_end: i32,
    pub start_byte: i64,
    pub end_byte: i64,
    pub doc_comment: Option<String>,
    pub text_fingerprint: String,
    pub top_terms: Vec<String>,
    pub lexical_vector: Vec<f32>,
    pub dense_vector: Option<Vec<f32>>,
}

pub fn entity_id(file_id: &str, entity_index: i64) -> String {
    format!("{file_id}::entity-{entity_index}")
}

pub fn is_entity_id(id: &str) -> bool {
    id.contains("::entity-")
}

pub fn replace_file_code_entities(
    tx: &Transaction<'_>,
    collection_id: &str,
    file: &KcFileRecord,
    content_hash: &str,
    parse_mode: CodeParseMode,
    language: &str,
    entities: &[StoredCodeEntityInput],
) -> AppResult<()> {
    tx.execute("DELETE FROM kc_code_entities WHERE file_id = ?1", params![file.id])
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    tx.execute("DELETE FROM kc_chunks WHERE file_id = ?1", params![file.id])
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    let now = Utc::now().timestamp();
    let mut char_count = 0i64;

    for entity in entities {
        char_count += entity.body.chars().count() as i64;
        let id = entity_id(&file.id, entity.entity_index);
        let top_terms_json = serde_json::to_string(&entity.top_terms)
            .map_err(|e| AppError::Unknown(format!("Failed to serialize top terms: {e}")))?;
        let lexical_json = serde_json::to_string(&entity.lexical_vector)
            .map_err(|e| AppError::Unknown(format!("Failed to serialize lexical vector: {e}")))?;
        let dense_json = entity
            .dense_vector
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| AppError::Unknown(format!("Failed to serialize dense vector: {e}")))?;
        let dense_dim = entity.dense_vector.as_ref().map(|v| v.len() as i64);

        tx.execute(
            "INSERT INTO kc_code_entities (
                id, collection_id, file_id, entity_index, language, parse_mode, entity_kind,
                entity_name, qualified_name, signature, body, line_start, line_end, start_byte, end_byte,
                doc_comment, text_fingerprint, top_terms_json, lexical_vector_json, dense_vector_json,
                dense_vector_dim, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
            params![
                id,
                collection_id,
                file.id,
                entity.entity_index,
                entity.language,
                parse_mode.as_str(),
                entity.entity_kind,
                entity.entity_name,
                entity.qualified_name,
                entity.signature,
                entity.body,
                entity.line_start,
                entity.line_end,
                entity.start_byte,
                entity.end_byte,
                entity.doc_comment,
                entity.text_fingerprint,
                top_terms_json,
                lexical_json,
                dense_json,
                dense_dim,
                now,
            ],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

        tx.execute(
            "DELETE FROM kc_code_entities_fts WHERE entity_id = ?1",
            params![id],
        )
        .ok();
        tx.execute(
            "INSERT INTO kc_code_entities_fts (entity_id, collection_id, file_name, entity_name, qualified_name, signature, body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                collection_id,
                file.name,
                entity.entity_name,
                entity.qualified_name,
                entity.signature,
                entity.body,
            ],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

        insert_entity_mirror_chunk(
            tx,
            collection_id,
            file,
            &id,
            entity,
            parse_mode,
            language,
            &top_terms_json,
            &lexical_json,
            dense_json.as_deref(),
            dense_dim,
            now,
        )?;
    }

    let file_fingerprint = entities
        .iter()
        .map(|e| e.text_fingerprint.as_str())
        .collect::<Vec<_>>()
        .join("|");

    tx.execute(
        "UPDATE kc_files SET status = 'indexed', char_count = ?1, chunk_count = 0, code_entity_count = ?2,
         code_parse_mode = ?3, code_language = ?4, content_hash = ?5, text_fingerprint = ?6, error_message = NULL
         WHERE id = ?7",
        params![
            char_count,
            entities.len() as i64,
            parse_mode.as_str(),
            language,
            content_hash,
            file_fingerprint,
            file.id,
        ],
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}

fn insert_entity_mirror_chunk(
    tx: &Transaction<'_>,
    collection_id: &str,
    file: &KcFileRecord,
    id: &str,
    entity: &StoredCodeEntityInput,
    parse_mode: CodeParseMode,
    _language: &str,
    top_terms_json: &str,
    lexical_json: &str,
    dense_json: Option<&str>,
    dense_dim: Option<i64>,
    now: i64,
) -> AppResult<()> {
    let section_path = format!("{} {}", entity.entity_kind, entity.entity_name);
    tx.execute(
        "INSERT INTO kc_chunks (
            id, collection_id, file_id, chunk_index, title, start_char, end_char, text,
            top_terms_json, lexical_vector_json, dense_vector_json, created_at,
            parent_text, section_path, doc_type, text_fingerprint,
            line_start, line_end, page_start, page_end, partition_id, dense_vector_dim,
            source_type, entity_kind, entity_name, parse_mode
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)",
        params![
            id,
            collection_id,
            file.id,
            entity.entity_index,
            entity.entity_name,
            entity.start_byte,
            entity.end_byte,
            entity.body,
            top_terms_json,
            lexical_json,
            dense_json,
            now,
            entity.body,
            section_path,
            "code",
            entity.text_fingerprint,
            entity.line_start,
            entity.line_end,
            None::<i32>,
            None::<i32>,
            "code",
            dense_dim,
            "code_entity",
            entity.entity_kind,
            entity.entity_name,
            parse_mode.as_str(),
        ],
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    tx.execute("DELETE FROM kc_chunks_fts WHERE chunk_id = ?1", params![id]).ok();
    tx.execute(
        "INSERT INTO kc_chunks_fts (chunk_id, collection_id, file_name, title, section_path, text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            id,
            collection_id,
            file.name,
            entity.entity_name,
            format!("{} {}", entity.entity_kind, entity.entity_name),
            format!("{} {}", entity.signature, entity.body),
        ],
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}

pub fn append_entity_lexical_rows(db: &Database, collection_id: &str, rows: &mut Vec<super::db::ChunkLexicalRow>) -> AppResult<()> {
    let mut stmt = db.conn().prepare(
        "SELECT id, lexical_vector_json FROM kc_code_entities WHERE collection_id = ?1",
    ).map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let entity_rows = stmt
        .query_map(params![collection_id], |row| {
            let lexical_json: String = row.get(1)?;
            let lexical_vector: Vec<f32> = serde_json::from_str(&lexical_json).unwrap_or_default();
            Ok(super::db::ChunkLexicalRow {
                id: row.get(0)?,
                lexical_vector,
            })
        })
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    rows.extend(entity_rows);
    Ok(())
}

pub fn load_entities_by_ids(
    db: &Database,
    collection_id: &str,
    ids: &[String],
) -> AppResult<Vec<LoadedChunk>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let entity_ids: Vec<&str> = ids.iter().filter(|id| is_entity_id(id)).map(String::as_str).collect();
    if entity_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::with_capacity(entity_ids.len());
    for batch in entity_ids.chunks(120) {
        let placeholders = batch.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let sql = format!(
            "SELECT e.id, e.collection_id, e.file_id, f.name, f.absolute_path, e.entity_index, e.entity_name,
                    e.qualified_name, e.signature, e.body, e.top_terms_json, e.lexical_vector_json, e.dense_vector_json,
                    e.entity_kind, e.line_start, e.line_end, e.parse_mode, e.doc_comment
             FROM kc_code_entities e
             JOIN kc_files f ON f.id = e.file_id
             WHERE e.collection_id = ?1 AND e.id IN ({placeholders})"
        );
        let mut stmt = db.conn().prepare(&sql).map_err(|e| AppError::DatabaseError(e.to_string()))?;
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(collection_id.to_string())];
        for id in batch {
            params.push(Box::new(id.to_string()));
        }
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(param_refs.as_slice(), map_loaded_entity_row)
            .map_err(|e| AppError::DatabaseError(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::DatabaseError(e.to_string()))?;
        out.extend(rows);
    }
    Ok(out)
}

fn map_loaded_entity_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LoadedChunk> {
    let top_terms_json: String = row.get(10)?;
    let lexical_json: String = row.get(11)?;
    let dense_json: Option<String> = row.get(12)?;
    let top_terms: Vec<String> = serde_json::from_str(&top_terms_json).unwrap_or_default();
    let lexical_vector: Vec<f32> = serde_json::from_str(&lexical_json).unwrap_or_default();
    let dense_vector = dense_json
        .as_deref()
        .and_then(|json| serde_json::from_str(json).ok());
    let body: String = row.get(9)?;
    let entity_name: String = row.get(6)?;
    let entity_kind: String = row.get(13)?;
    let line_start: i32 = row.get(14)?;
    let line_end: i32 = row.get(15)?;
    let parse_mode: String = row.get(16)?;
    let doc_comment: Option<String> = row.get(17)?;

    let record = KcChunkRecord {
        id: row.get(0)?,
        collection_id: row.get(1)?,
        file_id: row.get(2)?,
        file_name: row.get(3)?,
        file_path: row.get(4)?,
        chunk_index: row.get(5)?,
        title: entity_name.clone(),
        start_char: 0,
        end_char: body.len() as i64,
        text: body.clone(),
        top_terms,
        has_dense: dense_vector.is_some(),
        parent_text: None,
        section_path: Some(format!("{} {}", entity_kind, entity_name)),
        doc_type: Some("code".into()),
        partition_id: Some("code".into()),
        context_text: Some(body),
        line_start: Some(line_start),
        line_end: Some(line_end),
        page_start: None,
        page_end: None,
        source_type: "code_entity".into(),
        entity_kind: Some(entity_kind),
        entity_name: Some(entity_name),
        source_confidence: None,
        parse_mode: Some(parse_mode),
    };
    let _ = doc_comment;
    Ok(LoadedChunk {
        record,
        lexical_vector,
        dense_vector,
    })
}

pub fn list_entities_missing_dense(
    db: &Database,
    collection_id: &str,
) -> AppResult<Vec<super::db::ChunkDenseEmbedRow>> {
    let mut stmt = db.conn().prepare(
        "SELECT e.id, f.name, e.entity_kind, e.qualified_name, e.signature, e.body
         FROM kc_code_entities e
         JOIN kc_files f ON f.id = e.file_id
         WHERE e.collection_id = ?1 AND e.dense_vector_json IS NULL
         ORDER BY e.id ASC",
    ).map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = stmt
        .query_map(params![collection_id], |row| {
            Ok(super::db::ChunkDenseEmbedRow {
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
    Ok(rows)
}

pub fn collection_code_entity_count(db: &Database, collection_id: &str) -> AppResult<i64> {
    let count: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM kc_code_entities WHERE collection_id = ?1",
        params![collection_id],
        |row| row.get(0),
    ).map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(count)
}

pub fn collection_needs_code_entity_rebuild(db: &Database, collection_id: &str) -> AppResult<bool> {
    let code_files: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM kc_files WHERE collection_id = ?1 AND status = 'indexed' AND code_language IS NOT NULL",
        params![collection_id],
        |row| row.get(0),
    ).unwrap_or(0);
    if code_files == 0 {
        let legacy_code_chunks: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM kc_chunks WHERE collection_id = ?1 AND partition_id = 'code' LIMIT 1",
            params![collection_id],
            |row| row.get(0),
        ).unwrap_or(0);
        return Ok(legacy_code_chunks > 0);
    }
    Ok(false)
}

pub fn clear_collection_entities(db: &Database, collection_id: &str) -> AppResult<()> {
    db.conn()
        .execute(
            "DELETE FROM kc_code_entities WHERE collection_id = ?1",
            params![collection_id],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.conn()
        .execute(
            "DELETE FROM kc_code_entities_fts WHERE collection_id = ?1",
            params![collection_id],
        )
        .ok();
    Ok(())
}

// Chunk input for non-code files only (used by indexer).
