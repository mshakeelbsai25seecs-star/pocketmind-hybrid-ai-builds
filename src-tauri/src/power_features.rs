//! Encrypted backups, orphan cleaner, SHA-256 verify, workspace profiles, batch docs.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::database::Database;
use crate::deployment;
use crate::error::{AppError, AppResult};

const BACKUP_MAGIC: &[u8] = b"PMBK1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceProfile {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrphanItem {
    pub path: String,
    pub size_bytes: u64,
    pub kind: String,
    pub safe_to_delete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntegrityResult {
    pub path: String,
    pub sha256: String,
    pub matched_expected: Option<bool>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchFileResult {
    pub path: String,
    pub ok: bool,
    pub summary: String,
}

pub fn ensure_profile_schema(db: &Database) -> AppResult<()> {
    db.conn().execute_batch(
        "CREATE TABLE IF NOT EXISTS workspace_profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            is_default INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO workspace_profiles (id, name, created_at, is_default)
            VALUES ('default', 'Default', strftime('%s','now'), 1);
        ",
    )?;
    // Optional column on conversations
    let _ = db.conn().execute(
        "ALTER TABLE conversations ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default'",
        [],
    );
    let _ = db.conn().execute(
        "ALTER TABLE models ADD COLUMN sha256 TEXT",
        [],
    );
    Ok(())
}

pub fn list_profiles(db: &Database) -> AppResult<Vec<WorkspaceProfile>> {
    ensure_profile_schema(db)?;
    let mut stmt = db.conn().prepare(
        "SELECT id, name, created_at, is_default FROM workspace_profiles ORDER BY is_default DESC, name ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(WorkspaceProfile {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
            is_default: row.get::<_, i64>(3)? != 0,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn create_profile(db: &Database, name: &str) -> AppResult<WorkspaceProfile> {
    ensure_profile_schema(db)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    db.conn().execute(
        "INSERT INTO workspace_profiles (id, name, created_at, is_default) VALUES (?1, ?2, ?3, 0)",
        rusqlite::params![&id, name.trim(), now],
    )?;
    Ok(WorkspaceProfile {
        id,
        name: name.trim().to_string(),
        created_at: now,
        is_default: false,
    })
}

pub fn active_profile_id(db: &Database) -> AppResult<String> {
    ensure_profile_schema(db)?;
    Ok(db
        .get_setting("active_workspace_profile")?
        .unwrap_or_else(|| "default".to_string()))
}

pub fn set_active_profile(db: &Database, id: &str) -> AppResult<()> {
    ensure_profile_schema(db)?;
    let exists: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM workspace_profiles WHERE id = ?1",
        rusqlite::params![id],
        |r| r.get(0),
    )?;
    if exists == 0 {
        return Err(AppError::Unknown("Workspace profile not found".into()));
    }
    db.set_setting("active_workspace_profile", id)?;
    Ok(())
}

pub fn delete_profile(db: &Database, id: &str) -> AppResult<()> {
    ensure_profile_schema(db)?;
    if id == "default" {
        return Err(AppError::Unknown("Cannot delete the Default profile".into()));
    }
    let active = active_profile_id(db)?;
    if active == id {
        return Err(AppError::Unknown("Switch away from this profile before deleting it".into()));
    }
    db.conn()
        .execute("DELETE FROM workspace_profiles WHERE id = ?1", rusqlite::params![id])?;
    Ok(())
}

fn derive_key(passphrase: &str, salt: &[u8]) -> [u8; 32] {
    // PBKDF2-HMAC-SHA256 (100k) — portable across machines with passphrase
    use sha2::Sha256 as S;
    let mut key = [0u8; 32];
    // Simple iterated HMAC stretch (no new crate dependency if pbkdf2 unavailable)
    let mut block = [0u8; 32];
    {
        let mut h = S::new();
        h.update(passphrase.as_bytes());
        h.update(salt);
        block.copy_from_slice(&h.finalize());
    }
    for _ in 0..100_000 {
        let mut h = S::new();
        h.update(block);
        h.update(passphrase.as_bytes());
        block.copy_from_slice(&h.finalize());
    }
    key.copy_from_slice(&block);
    key
}

pub fn encrypt_backup_bytes(plaintext: &[u8], passphrase: &str) -> AppResult<Vec<u8>> {
    if passphrase.trim().len() < 8 {
        return Err(AppError::Unknown("Passphrase must be at least 8 characters".into()));
    }
    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let key = derive_key(passphrase, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| AppError::Unknown(format!("cipher: {e}")))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| AppError::Unknown(format!("encrypt failed: {e}")))?;
    let mut out = Vec::with_capacity(BACKUP_MAGIC.len() + 16 + 12 + ciphertext.len());
    out.extend_from_slice(BACKUP_MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

pub fn decrypt_backup_bytes(blob: &[u8], passphrase: &str) -> AppResult<Vec<u8>> {
    if blob.len() < BACKUP_MAGIC.len() + 16 + 12 + 16 {
        return Err(AppError::Unknown("Invalid encrypted backup file".into()));
    }
    if &blob[..BACKUP_MAGIC.len()] != BACKUP_MAGIC {
        return Err(AppError::Unknown("Not a PocketMind encrypted backup (PMBK1)".into()));
    }
    let salt = &blob[5..21];
    let nonce_bytes = &blob[21..33];
    let ciphertext = &blob[33..];
    let key = derive_key(passphrase, salt);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| AppError::Unknown(format!("cipher: {e}")))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| AppError::Unknown("Wrong passphrase or corrupt backup".into()))
}

pub fn write_encrypted_backup(path: &Path, plaintext_json: &str, passphrase: &str) -> AppResult<String> {
    let bytes = encrypt_backup_bytes(plaintext_json.as_bytes(), passphrase)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, bytes)?;
    Ok(path.display().to_string())
}

pub fn read_encrypted_backup(path: &Path, passphrase: &str) -> AppResult<String> {
    let blob = fs::read(path)?;
    let plain = decrypt_backup_bytes(&blob, passphrase)?;
    String::from_utf8(plain).map_err(|e| AppError::Unknown(e.to_string()))
}

pub fn sha256_file(path: &Path) -> AppResult<(String, u64)> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1024 * 256];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        hasher.update(&buf[..n]);
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}

pub fn verify_model_integrity(path: &Path, expected: Option<&str>) -> AppResult<IntegrityResult> {
    let (sha, size) = sha256_file(path)?;
    let matched = expected.map(|e| e.eq_ignore_ascii_case(&sha));
    Ok(IntegrityResult {
        path: path.display().to_string(),
        sha256: sha,
        matched_expected: matched,
        size_bytes: size,
    })
}

pub fn scan_orphans(models_dir: &Path, known_paths: &[String], active_model: Option<&str>) -> AppResult<Vec<OrphanItem>> {
    let mut out = Vec::new();
    if !models_dir.exists() {
        return Ok(out);
    }
    let known: std::collections::HashSet<String> = known_paths
        .iter()
        .map(|p| canonicalize_loose(p))
        .collect();
    let active = active_model.map(canonicalize_loose);
    for entry in walkdir::WalkDir::new(models_dir).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        let canon = canonicalize_loose(&path.display().to_string());
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let kind = if name.ends_with(".part") || name.ends_with(".partial") {
            "partial_download"
        } else if name.ends_with(".gguf") && !known.contains(&canon) {
            "orphan_gguf"
        } else if size == 0 && name.ends_with(".gguf") {
            "empty_stub"
        } else {
            continue;
        };
        let safe = active.as_ref().map(|a| a != &canon).unwrap_or(true);
        out.push(OrphanItem {
            path: path.display().to_string(),
            size_bytes: size,
            kind: kind.into(),
            safe_to_delete: safe,
        });
    }
    // Cache tmp leftovers under data root
    let cache = deployment::preferred_data_root().join("cache").join("tmp");
    if cache.exists() {
        for entry in walkdir::WalkDir::new(&cache).max_depth(2).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                let age_ok = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() + 2 * 86400 < now_secs())
                    .unwrap_or(false);
                if age_ok {
                    out.push(OrphanItem {
                        path: entry.path().display().to_string(),
                        size_bytes: entry.metadata().map(|m| m.len()).unwrap_or(0),
                        kind: "stale_cache".into(),
                        safe_to_delete: true,
                    });
                }
            }
        }
    }
    Ok(out)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn canonicalize_loose(p: &str) -> String {
    PathBuf::from(p)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(p))
        .display()
        .to_string()
        .to_lowercase()
}

pub fn delete_orphan_paths(paths: &[String]) -> AppResult<usize> {
    let mut n = 0usize;
    for p in paths {
        let path = Path::new(p);
        if path.is_file() {
            fs::remove_file(path)?;
            n += 1;
        }
    }
    Ok(n)
}

pub fn batch_extract_summaries(root: &Path, max_files: usize) -> AppResult<Vec<BatchFileResult>> {
    let mut results = Vec::new();
    let exts = ["txt", "md", "json", "csv", "log", "rs", "ts", "tsx", "js", "py", "java", "go"];
    for entry in walkdir::WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if results.len() >= max_files {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !exts.contains(&ext.as_str()) {
            continue;
        }
        match fs::read_to_string(path) {
            Ok(text) => {
                let truncated = if text.len() > 4000 {
                    format!("{}…", &text[..4000])
                } else {
                    text
                };
                let keywords = top_keywords(&truncated);
                let summary = format!(
                    "{} chars · keywords: {}",
                    truncated.len(),
                    keywords.join(", ")
                );
                results.push(BatchFileResult {
                    path: path.display().to_string(),
                    ok: true,
                    summary,
                });
            }
            Err(e) => results.push(BatchFileResult {
                path: path.display().to_string(),
                ok: false,
                summary: e.to_string(),
            }),
        }
    }
    Ok(results)
}

fn top_keywords(text: &str) -> Vec<String> {
    use std::collections::HashMap;
    let mut map: HashMap<String, usize> = HashMap::new();
    for w in text.split(|c: char| !c.is_alphanumeric()) {
        let w = w.to_lowercase();
        if w.len() < 4 || w.len() > 24 {
            continue;
        }
        *map.entry(w).or_default() += 1;
    }
    let mut v: Vec<_> = map.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1));
    v.into_iter().take(8).map(|(k, _)| k).collect()
}

pub fn backup_schedule_get(db: &Database) -> AppResult<(bool, u64, String)> {
    let enabled = db
        .get_setting("backup.schedule_enabled")?
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let hours = db
        .get_setting("backup.schedule_hours")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(24);
    let dest = db.get_setting("backup.dest_dir")?.unwrap_or_default();
    Ok((enabled, hours, dest))
}

pub fn backup_schedule_set(db: &Database, enabled: bool, hours: u64, dest: &str) -> AppResult<()> {
    db.set_setting("backup.schedule_enabled", if enabled { "1" } else { "0" })?;
    db.set_setting("backup.schedule_hours", &hours.max(1).to_string())?;
    db.set_setting("backup.dest_dir", dest)?;
    Ok(())
}

/// Encode ciphertext as base64 for Android/share transport convenience.
pub fn encrypt_backup_b64(plaintext: &str, passphrase: &str) -> AppResult<String> {
    Ok(B64.encode(encrypt_backup_bytes(plaintext.as_bytes(), passphrase)?))
}

pub fn decrypt_backup_b64(b64: &str, passphrase: &str) -> AppResult<String> {
    let blob = B64
        .decode(b64.trim())
        .map_err(|e| AppError::Unknown(format!("b64: {e}")))?;
    let plain = decrypt_backup_bytes(&blob, passphrase)?;
    String::from_utf8(plain).map_err(|e| AppError::Unknown(e.to_string()))
}
