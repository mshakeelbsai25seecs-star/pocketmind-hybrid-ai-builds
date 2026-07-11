import os

db_content = """
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

impl Database {
    pub fn new() -> Result<Self> {
        let app_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("NexusAI");
        std::fs::create_dir_all(&app_dir).ok();
        let db_path = app_dir.join("app.db");
        
        let conn = Connection::open(db_path)?;
        
        // Use query_row for PRAGMAs that return values
        let _journal: String = conn.query_row("PRAGMA journal_mode = WAL;", [], |row| row.get(0))?;
        let _fk: i32 = conn.query_row("PRAGMA foreign_keys = ON;", [], |row| row.get(0))?;
        let _sync: i32 = conn.query_row("PRAGMA synchronous = NORMAL;", [], |row| row.get(0))?;
        
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        // Create tables one by one using execute
        self.conn.execute("
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                character_id TEXT,
                model_id TEXT,
                mode TEXT DEFAULT 'chat',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
        ", [])?;
        
        self.conn.execute("
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata TEXT,
                created_at INTEGER NOT NULL
            )
        ", [])?;
        
        self.conn.execute("
            CREATE TABLE IF NOT EXISTS characters (
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
            )
        ", [])?;
        
        self.conn.execute("
            CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                parent_id TEXT,
                type TEXT DEFAULT 'character',
                created_at INTEGER NOT NULL
            )
        ", [])?;
        
        self.conn.execute("
            CREATE TABLE IF NOT EXISTS models (
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
            )
        ", [])?;
        
        self.conn.execute("
            CREATE TABLE IF NOT EXISTS api_keys (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL UNIQUE,
                encrypted_key TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
        ", [])?;
        
        self.conn.execute("
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        ", [])?;
        
        self.conn.execute("
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                importance REAL DEFAULT 1.0,
                created_at INTEGER NOT NULL
            )
        ", [])?;
        
        self.conn.execute("
            CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)
        ", [])?;
        
        self.conn.execute("
            CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC)
        ", [])?;
        
        self.conn.execute("
            CREATE INDEX IF NOT EXISTS idx_memories_character ON memories(character_id)
        ", [])?;
        
        // Use REPLACE instead of INSERT OR IGNORE to avoid result issues
        self.conn.execute("
            INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', '1')
        ", [])?;
        
        Ok(())
    }

    pub fn create_conversation(&self, title: &str, character_id: Option<&str>, model_id: Option<&str>, mode: &str) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        self.conn.execute(
            \"INSERT INTO conversations (id, title, character_id, model_id, mode, created_at, updated_at) 
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)\",
            params![&id, title, character_id, model_id, mode, now, now],
        )?;
        Ok(id)
    }

    pub fn get_conversations(&self) -> Result<Vec<Conversation>> {
        let mut stmt = self.conn.prepare(
            \"SELECT id, title, character_id, model_id, mode, created_at, updated_at 
             FROM conversations ORDER BY updated_at DESC\"
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

    pub fn delete_conversation(&self, id: &str) -> Result<()> {
        self.conn.execute(\"DELETE FROM conversations WHERE id = ?1\", params![id])?;
        Ok(())
    }

    pub fn add_message(&self, conversation_id: &str, role: &str, content: &str, metadata: Option<&str>) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        self.conn.execute(
            \"INSERT INTO messages (id, conversation_id, role, content, metadata, created_at) 
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)\",
            params![&id, conversation_id, role, content, metadata, now],
        )?;
        
        self.conn.execute(
            \"UPDATE conversations SET updated_at = ?1 WHERE id = ?2\",
            params![now, conversation_id],
        )?;
        
        Ok(id)
    }

    pub fn get_messages(&self, conversation_id: &str) -> Result<Vec<Message>> {
        let mut stmt = self.conn.prepare(
            \"SELECT id, conversation_id, role, content, metadata, created_at 
             FROM messages WHERE conversation_id = ?1 ORDER BY created_at ASC\"
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
            \"INSERT INTO characters (id, name, description, system_prompt, avatar_path, personality_traits, memory, folder_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8, ?9)\",
            params![&id, name, description, system_prompt, avatar_path, traits, folder_id, now, now],
        )?;
        Ok(id)
    }

    pub fn get_characters(&self) -> Result<Vec<Character>> {
        let mut stmt = self.conn.prepare(
            \"SELECT id, name, description, system_prompt, avatar_path, personality_traits, memory, folder_id, voice_preset, created_at, updated_at 
             FROM characters ORDER BY updated_at DESC\"
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

    pub fn delete_character(&self, id: &str) -> Result<()> {
        self.conn.execute(\"DELETE FROM characters WHERE id = ?1\", params![id])?;
        Ok(())
    }

    pub fn add_model(&self, name: &str, path: &str, backend: &str, quant: Option<&str>, 
                     size_bytes: i64, source_url: Option<&str>, metadata: Option<&str>) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        self.conn.execute(
            \"INSERT INTO models (id, name, path, backend, quantization, size_bytes, downloaded, source_url, metadata, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9)\",
            params![&id, name, path, backend, quant, size_bytes, source_url, metadata, now],
        )?;
        Ok(id)
    }

    pub fn get_models(&self) -> Result<Vec<LocalModelRecord>> {
        let mut stmt = self.conn.prepare(
            \"SELECT id, name, path, backend, quantization, size_bytes, downloaded, source_url, metadata, created_at 
             FROM models ORDER BY created_at DESC\"
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
        self.conn.execute(\"DELETE FROM models WHERE id = ?1\", params![id])?;
        Ok(())
    }

    pub fn store_api_key(&self, provider: &str, encrypted_key: &str) -> Result<()> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        self.conn.execute(
            \"INSERT INTO api_keys (id, provider, encrypted_key, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(provider) DO UPDATE SET encrypted_key = excluded.encrypted_key, created_at = excluded.created_at\",
            params![&id, provider, encrypted_key, now],
        )?;
        Ok(())
    }

    pub fn get_api_key(&self, provider: &str) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare(
            \"SELECT encrypted_key FROM api_keys WHERE provider = ?1\"
        )?;
        let result = stmt.query_row(params![provider], |row| {
            Ok(row.get::<_, String>(0)?)
        }).optional()?;
        Ok(result)
    }

    pub fn delete_api_key(&self, provider: &str) -> Result<()> {
        self.conn.execute(\"DELETE FROM api_keys WHERE provider = ?1\", params![provider])?;
        Ok(())
    }

    pub fn get_all_api_keys(&self) -> Result<Vec<ApiKeyRecord>> {
        let mut stmt = self.conn.prepare(
            \"SELECT id, provider, encrypted_key, created_at FROM api_keys ORDER BY provider\"
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

    pub fn get_all_settings(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare(\"SELECT key, value FROM settings\")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect()
    }

    pub fn get_last_active_conversation(&self) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare(
            \"SELECT id FROM conversations ORDER BY updated_at DESC LIMIT 1\"
        )?;
        let result = stmt.query_row([], |row| {
            Ok(row.get::<_, String>(0)?)
        }).optional()?;
        Ok(result)
    }
}
"""

with open('src/database.rs', 'w') as f:
    f.write(db_content.strip())

print('database.rs rewritten successfully')
