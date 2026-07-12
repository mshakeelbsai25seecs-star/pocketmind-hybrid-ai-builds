use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use uuid::Uuid;

pub struct GatewayDb {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionRow {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub status: String,
    pub file_count: i64,
    pub indexed_file_count: i64,
    pub chunk_count: i64,
    pub dense_chunk_count: i64,
    pub dense_status: String,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct ChunkHit {
    pub id: String,
    #[allow(dead_code)]
    pub collection_id: String,
    pub file_name: String,
    pub relative_path: String,
    pub title: String,
    pub text: String,
    pub partition_id: String,
    pub score: f64,
    pub dense: Option<Vec<f32>>,
}

impl GatewayDb {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create db dir {}", parent.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("open {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS collections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                root_path TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                file_count INTEGER NOT NULL DEFAULT 0,
                indexed_file_count INTEGER NOT NULL DEFAULT 0,
                chunk_count INTEGER NOT NULL DEFAULT 0,
                dense_chunk_count INTEGER NOT NULL DEFAULT 0,
                dense_status TEXT NOT NULL DEFAULT 'not_configured',
                last_error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY,
                collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                relative_path TEXT NOT NULL,
                file_name TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                partition_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                UNIQUE(collection_id, relative_path)
            );

            CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY,
                collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                chunk_index INTEGER NOT NULL,
                title TEXT NOT NULL,
                text TEXT NOT NULL,
                partition_id TEXT NOT NULL,
                dense_vector_json TEXT,
                UNIQUE(file_id, chunk_index)
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                chunk_id UNINDEXED,
                text,
                title,
                file_name
            );
            "#,
        )?;
        Ok(())
    }

    pub fn list_collections(&self) -> Result<Vec<CollectionRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, root_path, status, file_count, indexed_file_count, chunk_count,
                    dense_chunk_count, dense_status, last_error, created_at, updated_at
             FROM collections ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(CollectionRow {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: row.get(2)?,
                status: row.get(3)?,
                file_count: row.get(4)?,
                indexed_file_count: row.get(5)?,
                chunk_count: row.get(6)?,
                dense_chunk_count: row.get(7)?,
                dense_status: row.get(8)?,
                last_error: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn get_by_id_or_name(&self, id_or_name: &str) -> Result<Option<CollectionRow>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, root_path, status, file_count, indexed_file_count, chunk_count,
                    dense_chunk_count, dense_status, last_error, created_at, updated_at
             FROM collections WHERE id = ?1 OR name = ?1 LIMIT 1",
            params![id_or_name],
            |row| {
                Ok(CollectionRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    root_path: row.get(2)?,
                    status: row.get(3)?,
                    file_count: row.get(4)?,
                    indexed_file_count: row.get(5)?,
                    chunk_count: row.get(6)?,
                    dense_chunk_count: row.get(7)?,
                    dense_status: row.get(8)?,
                    last_error: row.get(9)?,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn upsert_collection(&self, name: &str, root_path: &str) -> Result<CollectionRow> {
        let now = Utc::now().timestamp();
        let conn = self.conn.lock().unwrap();
        if let Some(existing) = conn
            .query_row(
                "SELECT id FROM collections WHERE name = ?1",
                params![name],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            conn.execute(
                "UPDATE collections SET root_path = ?1, status = 'indexing', updated_at = ?2, last_error = NULL WHERE id = ?3",
                params![root_path, now, existing],
            )?;
        } else {
            let id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO collections (id, name, root_path, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'indexing', ?4, ?4)",
                params![id, name, root_path, now],
            )?;
        }
        drop(conn);
        self.get_by_id_or_name(name)?
            .ok_or_else(|| anyhow::anyhow!("collection missing after upsert"))
    }

    pub fn clear_collection_content(&self, collection_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE collection_id = ?1)",
            params![collection_id],
        )?;
        conn.execute("DELETE FROM chunks WHERE collection_id = ?1", params![collection_id])?;
        conn.execute("DELETE FROM files WHERE collection_id = ?1", params![collection_id])?;
        Ok(())
    }

    pub fn insert_file(
        &self,
        collection_id: &str,
        relative_path: &str,
        file_name: &str,
        content_hash: &str,
        partition_id: &str,
    ) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO files (id, collection_id, relative_path, file_name, content_hash, partition_id, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'indexed')
             ON CONFLICT(collection_id, relative_path) DO UPDATE SET
               content_hash = excluded.content_hash,
               partition_id = excluded.partition_id,
               status = 'indexed'",
            params![id, collection_id, relative_path, file_name, content_hash, partition_id],
        )?;
        let file_id: String = conn.query_row(
            "SELECT id FROM files WHERE collection_id = ?1 AND relative_path = ?2",
            params![collection_id, relative_path],
            |row| row.get(0),
        )?;
        Ok(file_id)
    }

    pub fn insert_chunk(
        &self,
        collection_id: &str,
        file_id: &str,
        chunk_index: i64,
        title: &str,
        text: &str,
        partition_id: &str,
        dense: Option<&[f32]>,
    ) -> Result<()> {
        let id = Uuid::new_v4().to_string();
        let dense_json = dense.map(|v| serde_json::to_string(v).unwrap_or_else(|_| "[]".into()));
        let conn = self.conn.lock().unwrap();
        let file_name: String = conn.query_row(
            "SELECT file_name FROM files WHERE id = ?1",
            params![file_id],
            |row| row.get(0),
        )?;
        conn.execute(
            "INSERT INTO chunks (id, collection_id, file_id, chunk_index, title, text, partition_id, dense_vector_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                collection_id,
                file_id,
                chunk_index,
                title,
                text,
                partition_id,
                dense_json
            ],
        )?;
        conn.execute(
            "INSERT INTO chunks_fts(chunk_id, text, title, file_name) VALUES (?1, ?2, ?3, ?4)",
            params![id, text, title, file_name],
        )?;
        Ok(())
    }

    pub fn finalize_collection(
        &self,
        collection_id: &str,
        file_count: i64,
        indexed_files: i64,
        chunk_count: i64,
        dense_count: i64,
        status: &str,
        dense_status: &str,
        last_error: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now().timestamp();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE collections SET file_count = ?1, indexed_file_count = ?2, chunk_count = ?3,
             dense_chunk_count = ?4, status = ?5, dense_status = ?6, last_error = ?7, updated_at = ?8
             WHERE id = ?9",
            params![
                file_count,
                indexed_files,
                chunk_count,
                dense_count,
                status,
                dense_status,
                last_error,
                now,
                collection_id
            ],
        )?;
        Ok(())
    }

    pub fn fts_search(&self, collection_id: &str, query: &str, limit: usize) -> Result<Vec<ChunkHit>> {
        let conn = self.conn.lock().unwrap();
        let fts_query = sanitize_fts(query);
        if fts_query.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt = conn.prepare(
            "SELECT c.id, c.collection_id, f.file_name, f.relative_path, c.title, c.text, c.partition_id,
                    bm25(chunks_fts) AS score, c.dense_vector_json
             FROM chunks_fts
             JOIN chunks c ON c.id = chunks_fts.chunk_id
             JOIN files f ON f.id = c.file_id
             WHERE c.collection_id = ?1 AND chunks_fts MATCH ?2
             ORDER BY score
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![collection_id, fts_query, limit as i64], |row| {
            let dense_json: Option<String> = row.get(8)?;
            Ok(ChunkHit {
                id: row.get(0)?,
                collection_id: row.get(1)?,
                file_name: row.get(2)?,
                relative_path: row.get(3)?,
                title: row.get(4)?,
                text: row.get(5)?,
                partition_id: row.get(6)?,
                score: {
                    let bm: f64 = row.get(7)?;
                    // bm25 is lower-is-better; invert for hybrid
                    1.0 / (1.0 + bm.max(0.0))
                },
                dense: dense_json.and_then(|j| serde_json::from_str(&j).ok()),
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn load_dense_chunks(&self, collection_id: &str, limit: usize) -> Result<Vec<ChunkHit>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.collection_id, f.file_name, f.relative_path, c.title, c.text, c.partition_id,
                    c.dense_vector_json
             FROM chunks c
             JOIN files f ON f.id = c.file_id
             WHERE c.collection_id = ?1 AND c.dense_vector_json IS NOT NULL
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![collection_id, limit as i64], |row| {
            let dense_json: Option<String> = row.get(7)?;
            Ok(ChunkHit {
                id: row.get(0)?,
                collection_id: row.get(1)?,
                file_name: row.get(2)?,
                relative_path: row.get(3)?,
                title: row.get(4)?,
                text: row.get(5)?,
                partition_id: row.get(6)?,
                score: 0.0,
                dense: dense_json.and_then(|j| serde_json::from_str(&j).ok()),
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }
}

fn sanitize_fts(query: &str) -> String {
    query
        .split_whitespace()
        .map(|t| {
            t.chars()
                .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
                .collect::<String>()
        })
        .filter(|t| t.len() > 1)
        .map(|t| format!("{t}*"))
        .collect::<Vec<_>>()
        .join(" ")
}
