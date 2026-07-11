use crate::database::Database;
use crate::error::{AppError, AppResult};
use crate::knowledge_chat::dense_hnsw;
use crate::knowledge_chat::lexical::cosine_similarity;
use crate::knowledge_chat::partitions::{KcPartitionId, KcSearchScope};
use crate::knowledge_chat::retrieval_config::RetrievalConfig;
use crate::product::{self, KC_DEPLOYMENT_SERVER};

const EXACT_DENSE_CHUNK_THRESHOLD: i64 = 4000;

/// Add top dense-nearest chunk IDs to the candidate pool for each active
/// partition, embedding-space–correct: each partition is searched with its own
/// query vector against its own HNSW index (with a scoped linear fallback).
pub fn prefetch_dense_candidates_partitioned(
    db: &Database,
    collection_id: &str,
    scope: KcSearchScope,
    partition_vectors: &[(String, Vec<f32>)],
    existing: &mut std::collections::HashSet<String>,
) -> AppResult<()> {
    let product = product::load_product_config(db);
    let chunk_count: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM kc_chunks WHERE collection_id = ?1",
            rusqlite::params![collection_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let config = RetrievalConfig::for_profile(&product.knowledge_chat_deployment_profile);
    let use_exact = product.enable_exact_dense_search
        || product.knowledge_chat_deployment_profile == KC_DEPLOYMENT_SERVER
        || chunk_count <= EXACT_DENSE_CHUNK_THRESHOLD;
    let prefetch_limit = if use_exact {
        config.dense_prefetch_limit_exact
    } else {
        config.dense_prefetch_limit
    };

    for (partition_key, query_vector) in partition_vectors {
        if query_vector.is_empty() {
            continue;
        }
        let partition = KcPartitionId::from_value(partition_key);
        if !scope.contains(partition) {
            continue;
        }

        if use_exact {
            linear_dense_prefetch(
                db,
                collection_id,
                partition,
                query_vector,
                existing,
                prefetch_limit,
            )?;
            continue;
        }

        match dense_hnsw::search_chunk_ids(db, collection_id, partition, query_vector, prefetch_limit) {
            Ok(ids) if !ids.is_empty() => {
                for id in ids {
                    existing.insert(id);
                }
            }
            Ok(_) => {
                linear_dense_prefetch(
                    db,
                    collection_id,
                    partition,
                    query_vector,
                    existing,
                    prefetch_limit,
                )?;
            }
            Err(_) => {
                // Dimension mismatch or search failure: skip this partition rather
                // than contaminate results with a wrong-space linear scan.
                continue;
            }
        }
    }
    Ok(())
}

fn linear_dense_prefetch(
    db: &Database,
    collection_id: &str,
    partition: KcPartitionId,
    query_vector: &[f32],
    existing: &mut std::collections::HashSet<String>,
    limit: usize,
) -> AppResult<()> {
    let mut stmt = db.conn().prepare(
        "SELECT id, dense_vector_json FROM kc_chunks
         WHERE collection_id = ?1 AND partition_id = ?2 AND dense_vector_json IS NOT NULL",
    ).map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = stmt
        .query_map(rusqlite::params![collection_id, partition.as_str()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    let mut ranked: Vec<(String, f64)> = Vec::new();
    for (id, dense_json) in rows {
        if existing.contains(&id) {
            continue;
        }
        let Ok(vector) = serde_json::from_str::<Vec<f32>>(&dense_json) else {
            continue;
        };
        // Only compare same-dimension vectors to keep cosine meaningful.
        if vector.len() != query_vector.len() {
            continue;
        }
        let score = cosine_similarity(query_vector, &vector);
        if score > 0.0 {
            ranked.push((id, score));
        }
    }

    if partition == KcPartitionId::Code {
        let mut entity_stmt = db.conn().prepare(
            "SELECT id, dense_vector_json FROM kc_code_entities
             WHERE collection_id = ?1 AND dense_vector_json IS NOT NULL",
        ).map_err(|e| AppError::DatabaseError(e.to_string()))?;
        let entity_rows = entity_stmt
            .query_map(rusqlite::params![collection_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| AppError::DatabaseError(e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::DatabaseError(e.to_string()))?;
        for (id, dense_json) in entity_rows {
            if existing.contains(&id) {
                continue;
            }
            let Ok(vector) = serde_json::from_str::<Vec<f32>>(&dense_json) else {
                continue;
            };
            if vector.len() != query_vector.len() {
                continue;
            }
            let score = cosine_similarity(query_vector, &vector);
            if score > 0.0 {
                ranked.push((id, score));
            }
        }
    }

    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    for (id, _) in ranked.into_iter().take(limit) {
        existing.insert(id);
    }
    Ok(())
}
