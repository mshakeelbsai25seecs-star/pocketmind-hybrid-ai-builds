use crate::database::Database;
use crate::error::{AppError, AppResult};
use rusqlite::params;

pub fn clear_collection_fts(db: &Database, collection_id: &str) -> AppResult<()> {
    db.conn()
        .execute(
            "DELETE FROM kc_chunks_fts WHERE collection_id = ?1",
            params![collection_id],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}

pub fn delete_file_fts(db: &Database, file_id: &str) -> AppResult<()> {
    db.conn()
        .execute(
            "DELETE FROM kc_chunks_fts WHERE chunk_id IN (SELECT id FROM kc_chunks WHERE file_id = ?1)",
            params![file_id],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}

pub fn upsert_chunk_fts(
    db: &Database,
    chunk_id: &str,
    collection_id: &str,
    file_name: &str,
    title: &str,
    section_path: &str,
    text: &str,
) -> AppResult<()> {
    db.conn()
        .execute("DELETE FROM kc_chunks_fts WHERE chunk_id = ?1", params![chunk_id])
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.conn()
        .execute(
            "INSERT INTO kc_chunks_fts (chunk_id, collection_id, file_name, title, section_path, text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![chunk_id, collection_id, file_name, title, section_path, text],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}

pub fn fts_search(
    db: &Database,
    collection_id: &str,
    query: &str,
    limit: usize,
) -> AppResult<Vec<(String, f64)>> {
    let fts_query = build_fts_or_query(query);
    fts_search_match(db, collection_id, &fts_query, limit)
}

/// Prefer AND matching for precision; fall back to OR when AND returns too few hits.
pub fn fts_search_with_fallback(
    db: &Database,
    collection_id: &str,
    query: &str,
    limit: usize,
) -> AppResult<Vec<(String, f64)>> {
    let and_query = build_fts_and_query(query);
    if !and_query.is_empty() {
        let and_rows = fts_search_match(db, collection_id, &and_query, limit)?;
        let min_useful = (limit / 4).max(6);
        if and_rows.len() >= min_useful {
            return Ok(merge_entity_fts(db, collection_id, &and_query, and_rows, limit));
        }
        let mut merged = and_rows;
        let or_rows = fts_search(db, collection_id, query, limit)?;
        for (id, score) in or_rows {
            if !merged.iter().any(|(existing, _)| existing == &id) {
                merged.push((id, score));
            }
        }
        merged.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        merged.truncate(limit);
        return Ok(merge_entity_fts(db, collection_id, &build_fts_or_query(query), merged, limit));
    }
    fts_search(db, collection_id, query, limit)
}

fn merge_entity_fts(
    db: &Database,
    collection_id: &str,
    fts_query: &str,
    mut rows: Vec<(String, f64)>,
    limit: usize,
) -> Vec<(String, f64)> {
    if let Ok(entity_rows) = fts_search_entities(db, collection_id, fts_query, limit) {
        for (id, score) in entity_rows {
            if !rows.iter().any(|(existing, _)| existing == &id) {
                rows.push((id, score));
            }
        }
        rows.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        rows.truncate(limit);
    }
    rows
}

fn fts_search_entities(
    db: &Database,
    collection_id: &str,
    fts_query: &str,
    limit: usize,
) -> AppResult<Vec<(String, f64)>> {
    if fts_query.is_empty() {
        return Ok(Vec::new());
    }
    let sql = "SELECT entity_id, bm25(kc_code_entities_fts) AS score
               FROM kc_code_entities_fts
               WHERE collection_id = ?1 AND kc_code_entities_fts MATCH ?2
               ORDER BY score
               LIMIT ?3";
    let mut stmt = db.conn().prepare(sql).map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = stmt
        .query_map(params![collection_id, fts_query, limit as i64], |row| {
            Ok((row.get::<_, String>(0)?, (-row.get::<_, f64>(1)?).max(0.0)))
        })
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))
}

fn fts_search_match(
    db: &Database,
    collection_id: &str,
    fts_query: &str,
    limit: usize,
) -> AppResult<Vec<(String, f64)>> {
    if fts_query.is_empty() {
        return Ok(Vec::new());
    }

    let sql = "SELECT chunk_id, bm25(kc_chunks_fts) AS score
               FROM kc_chunks_fts
               WHERE collection_id = ?1 AND kc_chunks_fts MATCH ?2
               ORDER BY score
               LIMIT ?3";

    let mut stmt = db.conn().prepare(sql).map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = stmt
        .query_map(params![collection_id, fts_query, limit as i64], |row| {
            let chunk_id: String = row.get(0)?;
            let bm25: f64 = row.get(1)?;
            Ok((chunk_id, (-bm25).max(0.0)))
        })
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))
}

fn tokenize_fts(query: &str) -> Vec<String> {
    query
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-' && c != '.')
        .map(str::trim)
        .filter(|t| t.len() >= 2 && t.len() <= 48)
        .take(12)
        .map(|token| format!("\"{}\"", token.replace('"', " ")))
        .collect()
}

fn build_fts_or_query(query: &str) -> String {
    let tokens = tokenize_fts(query);
    if tokens.is_empty() {
        return String::new();
    }
    tokens.join(" OR ")
}

fn build_fts_and_query(query: &str) -> String {
    let tokens = tokenize_fts(query);
    if tokens.len() < 2 {
        return String::new();
    }
    tokens.join(" AND ")
}
