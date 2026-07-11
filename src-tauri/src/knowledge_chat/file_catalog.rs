//! Indexed folder catalog for LLM file-selection (pass 1) before whole-file attachment (pass 2).

use std::collections::BTreeMap;

use crate::database::Database;
use crate::error::{AppError, AppResult};
use crate::knowledge_chat::context_bundle::MAX_WHOLE_FILE_BYTES;
use crate::knowledge_chat::contextual_index::build_deterministic_summary;
use crate::knowledge_chat::db;
use crate::knowledge_chat::types::{KcFileCatalog, KcFileCatalogEntry};
use rusqlite::params;

pub fn build_collection_catalog(db: &Database, collection_id: &str) -> AppResult<KcFileCatalog> {
    let collection = db::get_collection(db, collection_id)?;
    let rows = load_catalog_rows(db, collection_id)?;
    let architecture_blurb = find_architecture_blurb(&rows);

    let mut by_partition: BTreeMap<String, Vec<KcFileCatalogEntry>> = BTreeMap::new();
    let file_count = rows.len();
    for row in rows {
        by_partition
            .entry(row.partition_id.clone())
            .or_default()
            .push(row);
    }

    let mut sections = Vec::new();
    sections.push(format!(
        "# Indexed folder catalog\n\nCollection: **{}**\nRoot: `{}`\nIndexed files: {}\nWhole-file attach limit: {} bytes (5 KB)\n",
        collection.name,
        collection.root_path,
        file_count,
        MAX_WHOLE_FILE_BYTES
    ));

    if let Some(arch) = architecture_blurb {
        sections.push(format!("## Collection overview\n{arch}\n"));
    }

    sections.push(
        "## How to use this catalog\n\
         Each line is: `relative_path` | size | attachable? | one-line summary\n\
         Pick the smallest set of files that can answer the question.\n"
            .to_string(),
    );

    let mut all_entries = Vec::new();
    for (partition, mut entries) in by_partition {
        entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        sections.push(format!("## Partition: `{partition}`"));
        for entry in &entries {
            let attach = if entry.attachable { "yes" } else { "no (>5KB)" };
            sections.push(format!(
                "- `{}` | {} B | attachable: {} | {}",
                entry.relative_path, entry.size_bytes, attach, entry.summary
            ));
        }
        sections.push(String::new());
        all_entries.extend(entries);
    }

    Ok(KcFileCatalog {
        collection_id: collection_id.to_string(),
        collection_name: collection.name,
        root_path: collection.root_path,
        catalog_text: sections.join("\n"),
        entries: all_entries,
    })
}

struct CatalogRow {
    relative_path: String,
    absolute_path: String,
    file_name: String,
    size_bytes: i64,
    partition_id: String,
    preview_title: String,
    preview_text: String,
}

impl CatalogRow {
    fn into_entry(self) -> KcFileCatalogEntry {
        let section = if self.preview_title.trim().is_empty() {
            self.file_name.clone()
        } else {
            self.preview_title.clone()
        };
        let mut summary = build_deterministic_summary(&section, &self.preview_text);
        if summary.is_empty() {
            summary = format!("Indexed {} file.", self.partition_id);
        }
        let attachable = self.size_bytes >= 0 && (self.size_bytes as usize) <= MAX_WHOLE_FILE_BYTES;
        KcFileCatalogEntry {
            relative_path: self.relative_path,
            file_name: self.file_name,
            absolute_path: self.absolute_path,
            partition_id: self.partition_id,
            size_bytes: self.size_bytes,
            attachable,
            summary,
        }
    }
}

fn load_catalog_rows(db: &Database, collection_id: &str) -> AppResult<Vec<KcFileCatalogEntry>> {
    let sql = r#"
        SELECT
            f.relative_path,
            f.absolute_path,
            f.name,
            f.size_bytes,
            COALESCE(
                (SELECT c.partition_id FROM kc_chunks c WHERE c.file_id = f.id ORDER BY c.chunk_index ASC LIMIT 1),
                CASE
                    WHEN f.code_entity_count > 0 THEN 'code'
                    WHEN lower(f.extension) IN ('py','rs','ts','tsx','js','jsx','go','java','kt','cs','cpp','c','h') THEN 'code'
                    WHEN lower(f.relative_path) LIKE '%runbook%' OR lower(f.name) LIKE '%runbook%' OR lower(f.relative_path) LIKE '%incident%' THEN 'runbooks'
                    WHEN lower(f.extension) IN ('json','csv','log') THEN 'logs_data'
                    WHEN lower(f.extension) IN ('md','txt','rst') THEN 'documentation'
                    ELSE 'general'
                END
            ) AS partition_id,
            COALESCE(
                (SELECT c.title FROM kc_chunks c WHERE c.file_id = f.id ORDER BY c.chunk_index ASC LIMIT 1),
                f.name
            ) AS preview_title,
            COALESCE(
                (SELECT c.text FROM kc_chunks c WHERE c.file_id = f.id ORDER BY c.chunk_index ASC LIMIT 1),
                (SELECT e.body FROM kc_code_entities e WHERE e.file_id = f.id ORDER BY e.entity_index ASC LIMIT 1),
                ''
            ) AS preview_text
        FROM kc_files f
        WHERE f.collection_id = ?1 AND f.status = 'indexed'
        ORDER BY f.relative_path ASC
    "#;

    let mut stmt = db
        .conn()
        .prepare(sql)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = stmt
        .query_map(params![collection_id], |row| {
            Ok(CatalogRow {
                relative_path: row.get(0)?,
                absolute_path: row.get(1)?,
                file_name: row.get(2)?,
                size_bytes: row.get(3)?,
                partition_id: row.get(4)?,
                preview_title: row.get(5)?,
                preview_text: row.get(6)?,
            })
        })
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))
        .map(|items| items.into_iter().map(CatalogRow::into_entry).collect())
}

fn find_architecture_blurb(entries: &[KcFileCatalogEntry]) -> Option<String> {
    entries
        .iter()
        .find(|e| e.file_name.eq_ignore_ascii_case("architecture.md"))
        .map(|e| {
            format!(
                "See `{}` ({} partition) for system architecture. {}",
                e.relative_path, e.partition_id, e.summary
            )
        })
}

pub fn resolve_catalog_paths(
    catalog: &KcFileCatalog,
    selected: &[String],
) -> Vec<KcFileCatalogEntry> {
    let mut out = Vec::new();
    for raw in selected {
        let trimmed = raw.trim().trim_matches('`');
        if trimmed.is_empty() {
            continue;
        }
        if let Some(entry) = catalog
            .entries
            .iter()
            .find(|e| paths_match(&e.relative_path, trimmed))
        {
            if !out.iter().any(|e: &KcFileCatalogEntry| e.relative_path == entry.relative_path) {
                out.push(entry.clone());
            }
        }
    }
    out
}

fn paths_match(catalog_path: &str, selected: &str) -> bool {
    catalog_path.eq_ignore_ascii_case(selected)
        || catalog_path.replace('\\', "/").eq_ignore_ascii_case(&selected.replace('\\', "/"))
        || catalog_path.ends_with(selected)
        || selected.ends_with(catalog_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_paths_case_insensitive() {
        let catalog = KcFileCatalog {
            collection_id: "c".into(),
            collection_name: "QA".into(),
            root_path: "/qa".into(),
            catalog_text: String::new(),
            entries: vec![KcFileCatalogEntry {
                relative_path: "code/config_loader.py".into(),
                file_name: "config_loader.py".into(),
                absolute_path: "/qa/code/config_loader.py".into(),
                partition_id: "code".into(),
                size_bytes: 400,
                attachable: true,
                summary: "Loads API timeout from env.".into(),
            }],
        };
        let resolved = resolve_catalog_paths(&catalog, &["code/config_loader.py".into()]);
        assert_eq!(resolved.len(), 1);
    }
}
