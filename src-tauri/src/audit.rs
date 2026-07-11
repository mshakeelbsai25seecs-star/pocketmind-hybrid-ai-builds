use crate::database::Database;
use crate::error::{AppError, AppResult};
use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditLogEntry {
    pub id: String,
    pub event_type: String,
    pub category: String,
    pub summary: String,
    pub detail: Option<String>,
    pub resource_path: Option<String>,
    pub success: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditLogQuery {
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    pub category: Option<String>,
}

pub fn ensure_audit_table(db: &Database) -> AppResult<()> {
    db.conn()
        .execute(
            "CREATE TABLE IF NOT EXISTS soc_audit_log (
                id TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                category TEXT NOT NULL,
                summary TEXT NOT NULL,
                detail TEXT,
                resource_path TEXT,
                success INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.conn()
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_soc_audit_created ON soc_audit_log(created_at DESC)",
            [],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}

pub fn log_event(
    db: &Database,
    event_type: &str,
    category: &str,
    summary: &str,
    detail: Option<&str>,
    resource_path: Option<&str>,
    success: bool,
) -> AppResult<AuditLogEntry> {
    ensure_audit_table(db)?;
    let id = Uuid::new_v4().to_string();
    let created_at = Utc::now().timestamp();
    db.conn()
        .execute(
            "INSERT INTO soc_audit_log (id, event_type, category, summary, detail, resource_path, success, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                event_type,
                category,
                summary,
                detail,
                resource_path,
                if success { 1 } else { 0 },
                created_at,
            ],
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    Ok(AuditLogEntry {
        id,
        event_type: event_type.to_string(),
        category: category.to_string(),
        summary: summary.to_string(),
        detail: detail.map(|v| v.to_string()),
        resource_path: resource_path.map(|v| v.to_string()),
        success,
        created_at,
    })
}

pub fn list_events(db: &Database, query: &AuditLogQuery) -> AppResult<Vec<AuditLogEntry>> {
    ensure_audit_table(db)?;
    let limit = query.limit.unwrap_or(200).min(2000) as i64;
    let offset = query.offset.unwrap_or(0) as i64;

    let mut sql = String::from(
        "SELECT id, event_type, category, summary, detail, resource_path, success, created_at
         FROM soc_audit_log",
    );
    let category = query
        .category
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    if category.is_some() {
        sql.push_str(" WHERE category = ?1");
    }
    sql.push_str(" ORDER BY created_at DESC LIMIT ");
    sql.push_str(&limit.to_string());
    sql.push_str(" OFFSET ");
    sql.push_str(&offset.to_string());

    let mut stmt = db
        .conn()
        .prepare(&sql)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    let rows = if let Some(ref cat) = category {
        stmt.query_map(params![cat], map_audit_row)
    } else {
        stmt.query_map([], map_audit_row)
    }
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(|e| AppError::DatabaseError(e.to_string()))?);
    }
    Ok(entries)
}

fn map_audit_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuditLogEntry> {
    Ok(AuditLogEntry {
        id: row.get(0)?,
        event_type: row.get(1)?,
        category: row.get(2)?,
        summary: row.get(3)?,
        detail: row.get(4)?,
        resource_path: row.get(5)?,
        success: row.get::<_, i64>(6)? != 0,
        created_at: row.get(7)?,
    })
}

pub fn export_csv(db: &Database, query: &AuditLogQuery) -> AppResult<String> {
    let entries = list_events(db, query)?;
    let mut lines = vec![
        "id,created_at,event_type,category,success,summary,resource_path,detail".to_string(),
    ];
    for entry in entries {
        lines.push(format!(
            "{},{},{},{},{},{},{},{}",
            csv_escape(&entry.id),
            entry.created_at,
            csv_escape(&entry.event_type),
            csv_escape(&entry.category),
            entry.success,
            csv_escape(&entry.summary),
            csv_escape(entry.resource_path.as_deref().unwrap_or("")),
            csv_escape(entry.detail.as_deref().unwrap_or("")),
        ));
    }
    Ok(lines.join("\n"))
}

fn csv_escape(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}
