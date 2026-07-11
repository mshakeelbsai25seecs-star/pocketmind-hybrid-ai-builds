use crate::database::Database;
use crate::error::{AppError, AppResult};
use crate::knowledge_chat::lexical::{build_lexical_vector, cosine_similarity, clean_text};
use crate::knowledge_chat::types::KcIntentMatch;
use chrono::Utc;
use rusqlite::params;
use serde::Deserialize;
use uuid::Uuid;

const INTENT_MATCH_THRESHOLD: f64 = 0.88;
const INTENT_EXACT_BOOST: f64 = 1.0;

#[derive(Debug, Deserialize)]
struct DefaultIntentEntry {
    id: String,
    patterns: Vec<String>,
    answer: String,
    source_hint: Option<String>,
}

pub fn ensure_intent_cache_seeded(db: &Database) -> AppResult<()> {
    let count: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM kc_intent_cache", [], |row| row.get(0))
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    if count > 0 {
        return Ok(());
    }
    seed_default_intents(db)
}

pub fn seed_default_intents(db: &Database) -> AppResult<()> {
    let raw = include_str!("../../resources/kc_intent_defaults.json");
    let entries: Vec<DefaultIntentEntry> =
        serde_json::from_str(raw).map_err(|e| AppError::Unknown(format!("Invalid intent defaults JSON: {e}")))?;
    let now = Utc::now().timestamp();
    for entry in entries {
        for pattern in entry.patterns {
            let id = Uuid::new_v4().to_string();
            db.conn()
                .execute(
                    "INSERT INTO kc_intent_cache (id, pattern, answer, source_hint, enabled, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)",
                    params![id, normalize_pattern(&pattern), entry.answer, entry.source_hint, now],
                )
                .map_err(|e| AppError::DatabaseError(e.to_string()))?;
        }
    }
    Ok(())
}

pub fn lookup_intent(db: &Database, query: &str) -> AppResult<Option<KcIntentMatch>> {
    ensure_intent_cache_seeded(db)?;
    let normalized = normalize_pattern(query);
    if normalized.len() < 4 {
        return Ok(None);
    }

    let mut stmt = db
        .conn()
        .prepare("SELECT id, pattern, answer, source_hint FROM kc_intent_cache WHERE enabled = 1")
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    let query_vector = build_lexical_vector(&normalized);
    let mut best: Option<(f64, KcIntentMatch)> = None;

    for row in rows {
        let (id, pattern, answer, source_hint) = row.map_err(|e| AppError::DatabaseError(e.to_string()))?;
        let score = intent_similarity(&normalized, &pattern, &query_vector);
        if score < INTENT_MATCH_THRESHOLD {
            continue;
        }
        let candidate = KcIntentMatch {
            intent_id: id,
            pattern,
            answer,
            source_hint,
            score,
        };
        if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
            best = Some((score, candidate));
        }
    }

    Ok(best.map(|(_, value)| value))
}

fn intent_similarity(normalized_query: &str, pattern: &str, query_vector: &[f32]) -> f64 {
    if normalized_query == pattern {
        return INTENT_EXACT_BOOST;
    }
    let pattern_vector = build_lexical_vector(pattern);
    let lexical = cosine_similarity(query_vector, &pattern_vector);
    let token_overlap = token_boundary_overlap_score(normalized_query, pattern);
    if token_overlap >= 0.95 {
        return 0.96;
    }
    if token_overlap >= 0.75 {
        return 0.9;
    }
    lexical * 0.7 + token_overlap * 0.3
}

fn token_boundary_overlap_score(left: &str, right: &str) -> f64 {
    let left_tokens: Vec<&str> = left.split_whitespace().filter(|t| t.len() > 2).collect();
    if left_tokens.is_empty() {
        return 0.0;
    }
    let right_lower = right.to_lowercase();
    let matches = left_tokens
        .iter()
        .filter(|token| {
            let needle = token.to_lowercase();
            right_lower == needle
                || right_lower
                    .split_whitespace()
                    .any(|part| part == needle.as_str())
        })
        .count();
    matches as f64 / left_tokens.len() as f64
}

fn normalize_pattern(value: &str) -> String {
    clean_text(&value.to_lowercase().replace('?', ""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intent_similarity_prefers_exact_pattern() {
        let score = intent_similarity(
            "who do i escalate to",
            "who do i escalate to",
            &build_lexical_vector("who do i escalate to"),
        );
        assert!(score >= 0.99);
    }
}
