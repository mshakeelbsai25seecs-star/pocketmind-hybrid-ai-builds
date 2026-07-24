use rusqlite::{Connection, Result, params, OptionalExtension};
use serde::{Serialize, Deserialize};
use std::path::PathBuf;
use chrono::Utc;
use uuid::Uuid;

pub struct Database {
    conn: Connection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub character_id: Option<String>,
    pub model_id: Option<String>,
    pub mode: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub metadata: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Character {
    pub id: String,
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    pub avatar_path: Option<String>,
    pub personality_traits: String,
    pub memory: String,
    pub folder_id: Option<String>,
    pub voice_preset: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub folder_type: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalModelRecord {
    pub id: String,
    pub name: String,
    pub path: String,
    pub backend: String,
    pub quantization: Option<String>,
    pub size_bytes: i64,
    pub downloaded: bool,
    pub source_url: Option<String>,
    pub metadata: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyRecord {
    pub id: String,
    pub provider: String,
    pub encrypted_key: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: String,
    pub character_id: String,
    pub content: String,
    pub importance: f32,
    pub created_at: i64,
}

impl Database {
    pub fn new() -> Result<Self> {
        let _ = crate::deployment::migrate_app_database_files();
        let app_dir = crate::deployment::app_database_dir();
        
        std::fs::create_dir_all(&app_dir).map_err(|e| rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(1),
            Some(format!("Failed to create app directory: {}", e)),
        ))?;
        
        let db_path = app_dir.join("app.db");
        let conn = Connection::open(db_path)?;

        // FIXED: Use pragma_update instead of execute for PRAGMAs
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;

        let db = Self { conn };
        db.migrate()?;
        if let Err(err) = crate::deployment::migrate_legacy_storage_on_startup(&db) {
            log::warn!("Storage migration skipped or partial: {err}");
        }
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        // Using individual execute calls (execute_batch is opaque when debugging)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                character_id TEXT,
                model_id TEXT,
                mode TEXT DEFAULT 'chat',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )", [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata TEXT,
                created_at INTEGER NOT NULL
            )", [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS characters (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                system_prompt TEXT,
                avatar_path TEXT,
                personality_traits TEXT,
                memory TEXT,
                folder_id TEXT,
                voice_preset TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )", [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                parent_id TEXT,
                folder_type TEXT DEFAULT 'character',
                created_at INTEGER NOT NULL
            )", [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS models (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT,
                backend TEXT NOT NULL,
                quantization TEXT,
                size_bytes INTEGER,
                downloaded INTEGER DEFAULT 0,
                source_url TEXT,
                metadata TEXT,
                created_at INTEGER NOT NULL
            )", [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS api_keys (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL UNIQUE,
                encrypted_key TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )", [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )", [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                importance REAL DEFAULT 1.0,
                created_at INTEGER NOT NULL
            )", [],
        )?;

        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)", [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC)", [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_memories_character ON memories(character_id)", [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS soc_audit_log (
                id TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                category TEXT NOT NULL,
                summary TEXT NOT NULL,
                detail TEXT,
                resource_path TEXT,
                success INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL
            )", [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_soc_audit_created ON soc_audit_log(created_at DESC)", [],
        )?;

        self.conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('db_version', '2')", [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS kc_collections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                root_path TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                embedding_model_path TEXT NOT NULL,
                dense_status TEXT NOT NULL DEFAULT 'not_configured',
                file_count INTEGER NOT NULL DEFAULT 0,
                indexed_file_count INTEGER NOT NULL DEFAULT 0,
                chunk_count INTEGER NOT NULL DEFAULT 0,
                dense_chunk_count INTEGER NOT NULL DEFAULT 0,
                indexed_char_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_indexed_at INTEGER
            )", [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS kc_files (
                id TEXT PRIMARY KEY,
                collection_id TEXT NOT NULL REFERENCES kc_collections(id) ON DELETE CASCADE,
                relative_path TEXT NOT NULL,
                absolute_path TEXT NOT NULL,
                name TEXT NOT NULL,
                extension TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                modified_at INTEGER NOT NULL,
                content_hash TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                char_count INTEGER NOT NULL DEFAULT 0,
                chunk_count INTEGER NOT NULL DEFAULT 0,
                error_message TEXT,
                UNIQUE(collection_id, absolute_path)
            )", [],
        )?;

        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS kc_chunks (
                id TEXT PRIMARY KEY,
                collection_id TEXT NOT NULL REFERENCES kc_collections(id) ON DELETE CASCADE,
                file_id TEXT NOT NULL REFERENCES kc_files(id) ON DELETE CASCADE,
                chunk_index INTEGER NOT NULL,
                title TEXT NOT NULL,
                start_char INTEGER NOT NULL,
                end_char INTEGER NOT NULL,
                text TEXT NOT NULL,
                top_terms_json TEXT NOT NULL,
                lexical_vector_json TEXT NOT NULL,
                dense_vector_json TEXT,
                created_at INTEGER NOT NULL
            )", [],
        )?;

        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kc_files_collection ON kc_files(collection_id)", [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kc_chunks_collection ON kc_chunks(collection_id)", [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kc_chunks_file ON kc_chunks(file_id)", [],
        )?;

        self.migrate_kc_v2()?;
        self.migrate_kc_v3()?;
        self.migrate_kc_v4()?;
        self.migrate_kc_v5()?;
        self.migrate_kc_v6()?;
        self.migrate_kc_v7()?;
        self.migrate_kc_v8()?;

        Ok(())
    }

    fn migrate_kc_v8(&self) -> Result<()> {
        let alters = [
            "ALTER TABLE kc_collections ADD COLUMN image_rag_opt_in INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE kc_collections ADD COLUMN allow_cloud_media INTEGER NOT NULL DEFAULT 0",
        ];
        for sql in alters {
            match self.conn.execute(sql, []) {
                Ok(_) => {}
                Err(e) => {
                    let msg = e.to_string().to_ascii_lowercase();
                    // SQLite: "duplicate column name" — safe to ignore.
                    if !msg.contains("duplicate column") {
                        return Err(e);
                    }
                }
            }
        }
        // Only stamp schema v8 when both columns are actually present.
        let mut stmt = self.conn.prepare("PRAGMA table_info(kc_collections)")?;
        let cols: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(|r| r.ok())
            .collect();
        let has_opt_in = cols.iter().any(|c| c == "image_rag_opt_in");
        let has_allow = cols.iter().any(|c| c == "allow_cloud_media");
        if !has_opt_in || !has_allow {
            // Do not stamp v8 — retry on next startup instead of claiming success.
            eprintln!("migrate_kc_v8: image_rag columns missing; schema version not bumped");
            return Ok(());
        }
        self.conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('kc_schema_version', '8')",
            [],
        )?;
        Ok(())
    }

    fn migrate_kc_v7(&self) -> Result<()> {
        let alters = [
            "ALTER TABLE kc_chunks ADD COLUMN source_type TEXT NOT NULL DEFAULT 'chunk'",
            "ALTER TABLE kc_chunks ADD COLUMN entity_kind TEXT",
            "ALTER TABLE kc_chunks ADD COLUMN entity_name TEXT",
            "ALTER TABLE kc_chunks ADD COLUMN parse_mode TEXT",
        ];
        for sql in alters {
            let _ = self.conn.execute(sql, []);
        }
        self.conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('kc_schema_version', '7')",
            [],
        )?;
        Ok(())
    }

    fn migrate_kc_v6(&self) -> Result<()> {
        let _ = self.conn.execute(
            "CREATE TABLE IF NOT EXISTS kc_code_entities (
                id TEXT PRIMARY KEY,
                collection_id TEXT NOT NULL REFERENCES kc_collections(id) ON DELETE CASCADE,
                file_id TEXT NOT NULL REFERENCES kc_files(id) ON DELETE CASCADE,
                entity_index INTEGER NOT NULL,
                language TEXT NOT NULL,
                parse_mode TEXT NOT NULL,
                entity_kind TEXT NOT NULL,
                entity_name TEXT NOT NULL,
                qualified_name TEXT NOT NULL,
                signature TEXT NOT NULL,
                body TEXT NOT NULL,
                line_start INTEGER NOT NULL,
                line_end INTEGER NOT NULL,
                start_byte INTEGER NOT NULL,
                end_byte INTEGER NOT NULL,
                doc_comment TEXT,
                text_fingerprint TEXT NOT NULL,
                top_terms_json TEXT NOT NULL,
                lexical_vector_json TEXT NOT NULL,
                dense_vector_json TEXT,
                embedding_profile_id TEXT,
                dense_vector_dim INTEGER,
                created_at INTEGER NOT NULL
            )",
            [],
        );

        let _ = self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kc_code_entities_collection ON kc_code_entities(collection_id)",
            [],
        );
        let _ = self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kc_code_entities_file ON kc_code_entities(file_id)",
            [],
        );
        let _ = self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kc_code_entities_name ON kc_code_entities(collection_id, entity_name)",
            [],
        );

        let _ = self.conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS kc_code_entities_fts USING fts5(
                entity_id UNINDEXED,
                collection_id UNINDEXED,
                file_name,
                entity_name,
                qualified_name,
                signature,
                body,
                tokenize = 'unicode61'
            )",
            [],
        );

        let file_alters = [
            "ALTER TABLE kc_files ADD COLUMN code_parse_mode TEXT",
            "ALTER TABLE kc_files ADD COLUMN code_entity_count INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE kc_files ADD COLUMN code_language TEXT",
            "ALTER TABLE kc_collections ADD COLUMN code_entity_count INTEGER NOT NULL DEFAULT 0",
        ];
        for sql in file_alters {
            let _ = self.conn.execute(sql, []);
        }

        self.conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('kc_schema_version', '6')",
            [],
        )?;
        Ok(())
    }

    fn migrate_kc_v5(&self) -> Result<()> {
        let alters = [
            "ALTER TABLE kc_collections ADD COLUMN folder_category TEXT NOT NULL DEFAULT 'mixed'",
            "ALTER TABLE kc_collections ADD COLUMN partition_config_json TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE kc_chunks ADD COLUMN partition_id TEXT NOT NULL DEFAULT 'knowledge'",
            "ALTER TABLE kc_chunks ADD COLUMN embedding_profile_id TEXT",
            "ALTER TABLE kc_chunks ADD COLUMN dense_vector_dim INTEGER",
        ];
        for sql in alters {
            let _ = self.conn.execute(sql, []);
        }

        // Backfill partition_id for existing chunks from the owning file's
        // extension so legacy collections route correctly without a full reindex.
        let code_exts = "'rs','py','js','ts','tsx','jsx','java','kt','kts','go','cs','cpp','c','h','hpp','rb','php','sql','css'";
        let _ = self.conn.execute(
            &format!(
                "UPDATE kc_chunks SET partition_id = 'code'
                 WHERE file_id IN (
                     SELECT id FROM kc_files WHERE lower(extension) IN ({code_exts})
                 )"
            ),
            [],
        );
        let _ = self.conn.execute(
            "UPDATE kc_chunks SET partition_id = 'code' WHERE lower(doc_type) = 'code'",
            [],
        );

        let _ = self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kc_chunks_partition ON kc_chunks(collection_id, partition_id)",
            [],
        );

        self.conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('kc_schema_version', '5')",
            [],
        )?;
        Ok(())
    }

    fn migrate_kc_v4(&self) -> Result<()> {
        let alters = [
            "ALTER TABLE kc_chunks ADD COLUMN line_start INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE kc_chunks ADD COLUMN line_end INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE kc_chunks ADD COLUMN page_start INTEGER",
            "ALTER TABLE kc_chunks ADD COLUMN page_end INTEGER",
        ];
        for sql in alters {
            let _ = self.conn.execute(sql, []);
        }
        self.conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('kc_schema_version', '4')",
            [],
        )?;
        Ok(())
    }

    fn migrate_kc_v3(&self) -> Result<()> {
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS kc_intent_cache (
                id TEXT PRIMARY KEY,
                pattern TEXT NOT NULL,
                answer TEXT NOT NULL,
                source_hint TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
            [],
        )?;
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_kc_intent_pattern ON kc_intent_cache(pattern)",
            [],
        )?;
        Ok(())
    }

    fn migrate_kc_v2(&self) -> Result<()> {
        let alters = [
            "ALTER TABLE kc_files ADD COLUMN text_fingerprint TEXT",
            "ALTER TABLE kc_files ADD COLUMN priority_tier INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE kc_chunks ADD COLUMN parent_text TEXT",
            "ALTER TABLE kc_chunks ADD COLUMN section_path TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE kc_chunks ADD COLUMN doc_type TEXT NOT NULL DEFAULT 'document'",
            "ALTER TABLE kc_chunks ADD COLUMN text_fingerprint TEXT",
        ];
        for sql in alters {
            let _ = self.conn.execute(sql, []);
        }

        self.conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS kc_chunks_fts USING fts5(
                chunk_id UNINDEXED,
                collection_id UNINDEXED,
                file_name,
                title,
                section_path,
                text,
                tokenize = 'unicode61 remove_diacritics 2'
            )",
            [],
        )?;

        self.conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('kc_schema_version', '2')",
            [],
        )?;

        Ok(())
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn create_conversation(&self, title: &str, character_id: Option<&str>, model_id: Option<&str>, mode: &str) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        if self.conversations_have_profile_id() {
            let profile_id = self
                .get_setting("active_workspace_profile")?
                .unwrap_or_else(|| "default".to_string());
            self.conn.execute(
                "INSERT INTO conversations (id, title, character_id, model_id, mode, created_at, updated_at, profile_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![&id, title, character_id, model_id, mode, now, now, profile_id],
            )?;
        } else {
            self.conn.execute(
                "INSERT INTO conversations (id, title, character_id, model_id, mode, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![&id, title, character_id, model_id, mode, now, now],
            )?;
        }
        Ok(id)
    }

    pub fn get_conversations(&self) -> Result<Vec<Conversation>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, character_id, model_id, mode, created_at, updated_at 
             FROM conversations ORDER BY updated_at DESC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Conversation {
                id: row.get(0)?,
                title: row.get(1)?,
                character_id: row.get(2)?,
                model_id: row.get(3)?,
                mode: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?;
        rows.collect()
    }

    pub fn conversations_have_profile_id(&self) -> bool {
        self.conn
            .prepare("SELECT profile_id FROM conversations LIMIT 1")
            .is_ok()
    }

    pub fn get_conversations_by_profile(&self, profile_id: &str) -> Result<Vec<Conversation>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, character_id, model_id, mode, created_at, updated_at
             FROM conversations
             WHERE profile_id = ?1 OR (profile_id IS NULL AND ?1 = 'default')
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map(params![profile_id], |row| {
            Ok(Conversation {
                id: row.get(0)?,
                title: row.get(1)?,
                character_id: row.get(2)?,
                model_id: row.get(3)?,
                mode: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?;
        rows.collect()
    }

    pub fn update_conversation_title(&self, id: &str, title: &str) -> Result<()> {
        let now = Utc::now().timestamp();
        self.conn.execute(
            "UPDATE conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now, id],
        )?;
        Ok(())
    }

    pub fn delete_conversation(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn add_message(&self, conversation_id: &str, role: &str, content: &str, metadata: Option<&str>) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        self.conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, metadata, created_at) 
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![&id, conversation_id, role, content, metadata, now],
        )?;
        
        self.conn.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![now, conversation_id],
        )?;
        
        Ok(id)
    }

    pub fn update_message(&self, id: &str, content: &str, metadata: Option<&str>) -> Result<()> {
        let now = Utc::now().timestamp();
        let conversation_id: String = self.conn.query_row(
            "SELECT conversation_id FROM messages WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "UPDATE messages SET content = ?1, metadata = ?2 WHERE id = ?3",
            params![content, metadata, id],
        )?;
        self.conn.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![now, conversation_id],
        )?;
        Ok(())
    }

    pub fn get_messages(&self, conversation_id: &str) -> Result<Vec<Message>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, conversation_id, role, content, metadata, created_at 
             FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC"
        )?;
        let rows = stmt.query_map(params![conversation_id], |row| {
            Ok(Message {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                metadata: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn create_character(&self, name: &str, description: &str, system_prompt: &str, 
                          avatar_path: Option<&str>, traits: &str, folder_id: Option<&str>) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        self.conn.execute(
            "INSERT INTO characters (id, name, description, system_prompt, avatar_path, personality_traits, memory, folder_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8, ?9)",
            params![&id, name, description, system_prompt, avatar_path, traits, folder_id, now, now],
        )?;
        Ok(id)
    }

    pub fn get_characters(&self) -> Result<Vec<Character>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, description, system_prompt, avatar_path, personality_traits, memory, folder_id, voice_preset, created_at, updated_at 
             FROM characters ORDER BY updated_at DESC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Character {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                system_prompt: row.get(3)?,
                avatar_path: row.get(4)?,
                personality_traits: row.get(5)?,
                memory: row.get(6)?,
                folder_id: row.get(7)?,
                voice_preset: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })?;
        rows.collect()
    }

    pub fn update_character(&self, id: &str, updates: &Character) -> Result<()> {
        let now = Utc::now().timestamp();
        self.conn.execute(
            "UPDATE characters SET name = ?1, description = ?2, system_prompt = ?3, 
             avatar_path = ?4, personality_traits = ?5, memory = ?6, folder_id = ?7, updated_at = ?8
             WHERE id = ?9",
            params![
                &updates.name, &updates.description, &updates.system_prompt,
                &updates.avatar_path, &updates.personality_traits, &updates.memory,
                &updates.folder_id, now, id
            ],
        )?;
        Ok(())
    }

    pub fn delete_character(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM characters WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn add_model(&self, name: &str, path: &str, backend: &str, quant: Option<&str>, 
                     size_bytes: i64, source_url: Option<&str>, metadata: Option<&str>) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        self.conn.execute(
            "INSERT INTO models (id, name, path, backend, quantization, size_bytes, downloaded, source_url, metadata, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9)",
            params![&id, name, path, backend, quant, size_bytes, source_url, metadata, now],
        )?;
        Ok(id)
    }

    pub fn get_models(&self) -> Result<Vec<LocalModelRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, path, backend, quantization, size_bytes, downloaded, source_url, metadata, created_at 
             FROM models ORDER BY created_at DESC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(LocalModelRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                backend: row.get(3)?,
                quantization: row.get(4)?,
                size_bytes: row.get(5)?,
                downloaded: row.get::<_, i32>(6)? != 0,
                source_url: row.get(7)?,
                metadata: row.get(8)?,
                created_at: row.get(9)?,
            })
        })?;
        rows.collect()
    }

    pub fn delete_model(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM models WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn store_api_key(&self, provider: &str, encrypted_key: &str) -> Result<()> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        self.conn.execute(
            "INSERT INTO api_keys (id, provider, encrypted_key, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(provider) DO UPDATE SET encrypted_key = excluded.encrypted_key, created_at = excluded.created_at",
            params![&id, provider, encrypted_key, now],
        )?;
        Ok(())
    }

    pub fn get_api_key(&self, provider: &str) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT encrypted_key FROM api_keys WHERE provider = ?1"
        )?;
        let result = stmt.query_row(params![provider], |row| {
            Ok(row.get::<_, String>(0)?)
        }).optional()?;
        Ok(result)
    }

    pub fn delete_api_key(&self, provider: &str) -> Result<()> {
        self.conn.execute("DELETE FROM api_keys WHERE provider = ?1", params![provider])?;
        Ok(())
    }

    pub fn get_all_api_keys(&self) -> Result<Vec<ApiKeyRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, provider, encrypted_key, created_at FROM api_keys ORDER BY provider"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ApiKeyRecord {
                id: row.get(0)?,
                provider: row.get(1)?,
                encrypted_key: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        rows.collect()
    }

    pub fn add_memory(&self, character_id: &str, content: &str, importance: f32) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        self.conn.execute(
            "INSERT INTO memories (id, character_id, content, importance, created_at) 
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![&id, character_id, content, importance, now],
        )?;
        Ok(id)
    }

    pub fn get_memories(&self, character_id: &str, limit: i64) -> Result<Vec<MemoryEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, character_id, content, importance, created_at FROM memories 
             WHERE character_id = ?1 
             ORDER BY importance DESC, created_at DESC 
             LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![character_id, limit], |row| {
            Ok(MemoryEntry {
                id: row.get(0)?,
                character_id: row.get(1)?,
                content: row.get(2)?,
                importance: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn delete_memory(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM memories WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) 
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let result = stmt.query_row(params![key], |row| {
            Ok(row.get::<_, String>(0)?)
        }).optional()?;
        Ok(result)
    }

    pub fn get_all_settings(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect()
    }

    pub fn get_last_active_conversation(&self) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM conversations ORDER BY updated_at DESC LIMIT 1"
        )?;
        let result = stmt.query_row([], |row| {
            Ok(row.get::<_, String>(0)?)
        }).optional()?;
        Ok(result)
    }

    pub fn export_conversation(&self, id: &str) -> Result<Vec<Message>> {
        self.get_messages(id)
    }

    pub fn import_conversation(&self, title: &str, messages: Vec<Message>, character_id: Option<&str>) -> Result<String> {
        let conv_id = self.create_conversation(title, character_id, None, "chat")?;
        for msg in messages {
            self.add_message(&conv_id, &msg.role, &msg.content, msg.metadata.as_deref())?;
        }
        Ok(conv_id)
    }
}
