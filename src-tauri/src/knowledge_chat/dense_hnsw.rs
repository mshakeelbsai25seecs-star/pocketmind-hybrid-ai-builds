use crate::database::Database;
use crate::error::{AppError, AppResult};
use crate::knowledge_chat::partitions::KcPartitionId;
use sha2::{Digest, Sha256};
use usearch::{Index, IndexOptions, MetricKind, ScalarKind};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const HNSW_SEARCH_LIMIT: usize = 64;

struct CollectionHnsw {
    index: Index,
    key_to_chunk: HashMap<u64, String>,
    dimensions: usize,
}

struct HnswCache {
    // Keyed by "{collection_id}::{partition_id}".
    partitions: HashMap<String, CollectionHnsw>,
}

fn hnsw_cache() -> &'static Mutex<HnswCache> {
    static CACHE: OnceLock<Mutex<HnswCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HnswCache {
        partitions: HashMap::new(),
    }))
}

fn stable_chunk_key(chunk_id: &str) -> u64 {
    let digest = Sha256::digest(chunk_id.as_bytes());
    u64::from_le_bytes(digest[0..8].try_into().unwrap_or([0; 8]))
}

fn hnsw_storage_dir() -> PathBuf {
    let base = crate::deployment::hnsw_index_dir();
    let _ = std::fs::create_dir_all(&base);
    base
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn cache_key(collection_id: &str, partition: KcPartitionId) -> String {
    format!("{collection_id}::{}", partition.as_str())
}

fn hnsw_file_path(collection_id: &str, partition: KcPartitionId) -> PathBuf {
    hnsw_storage_dir().join(format!("{}__{}.usearch", sanitize(collection_id), partition.as_str()))
}

fn load_dense_rows(
    db: &Database,
    collection_id: &str,
    partition: KcPartitionId,
) -> AppResult<Vec<(String, Vec<f32>)>> {
    let mut out = load_dense_chunk_rows(db, collection_id, partition)?;
    if partition == KcPartitionId::Code {
        out.extend(load_dense_entity_rows(db, collection_id)?);
    }
    Ok(out)
}

fn load_dense_chunk_rows(
    db: &Database,
    collection_id: &str,
    partition: KcPartitionId,
) -> AppResult<Vec<(String, Vec<f32>)>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, dense_vector_json FROM kc_chunks
             WHERE collection_id = ?1 AND partition_id = ?2 AND dense_vector_json IS NOT NULL",
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = stmt
        .query_map(rusqlite::params![collection_id, partition.as_str()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    let mut out = Vec::new();
    for (chunk_id, dense_json) in rows {
        let Ok(vector) = serde_json::from_str::<Vec<f32>>(&dense_json) else {
            continue;
        };
        if vector.len() >= 8 {
            out.push((chunk_id, vector));
        }
    }
    Ok(out)
}

fn load_dense_entity_rows(
    db: &Database,
    collection_id: &str,
) -> AppResult<Vec<(String, Vec<f32>)>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, dense_vector_json FROM kc_code_entities
             WHERE collection_id = ?1 AND dense_vector_json IS NOT NULL",
        )
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let rows = stmt
        .query_map(rusqlite::params![collection_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;

    let mut out = Vec::new();
    for (entity_id, dense_json) in rows {
        let Ok(vector) = serde_json::from_str::<Vec<f32>>(&dense_json) else {
            continue;
        };
        if vector.len() >= 8 {
            out.push((entity_id, vector));
        }
    }
    Ok(out)
}

fn build_index(rows: &[(String, Vec<f32>)]) -> AppResult<CollectionHnsw> {
    if rows.is_empty() {
        return Err(AppError::Unknown("No dense vectors available for HNSW index.".to_string()));
    }
    let dimensions = rows[0].1.len();
    let mut options = IndexOptions::default();
    options.dimensions = dimensions;
    options.metric = MetricKind::Cos;
    options.quantization = ScalarKind::F32;
    options.connectivity = 16;
    options.expansion_add = 128;
    options.expansion_search = 64;

    let index = Index::new(&options).map_err(|e| AppError::Unknown(format!("HNSW index init failed: {e}")))?;
    index
        .reserve(rows.len())
        .map_err(|e| AppError::Unknown(format!("HNSW reserve failed: {e}")))?;

    let mut key_to_chunk = HashMap::with_capacity(rows.len());
    for (chunk_id, vector) in rows {
        // Within a partition all vectors share one model and dimension; skip the
        // rare straggler from a previous model rather than corrupting the index.
        if vector.len() != dimensions {
            continue;
        }
        let key = stable_chunk_key(chunk_id);
        if index.add(key, vector).is_ok() {
            key_to_chunk.insert(key, chunk_id.clone());
        }
    }

    if key_to_chunk.is_empty() {
        return Err(AppError::Unknown(
            "HNSW index build produced zero vectors.".to_string(),
        ));
    }

    Ok(CollectionHnsw {
        index,
        key_to_chunk,
        dimensions,
    })
}

/// Remove all partition indexes (cache + on-disk) for a collection.
pub fn invalidate_collection(collection_id: &str) {
    if let Ok(mut cache) = hnsw_cache().lock() {
        for partition in KcPartitionId::all() {
            cache.partitions.remove(&cache_key(collection_id, partition));
        }
    }
    for partition in KcPartitionId::all() {
        let _ = std::fs::remove_file(hnsw_file_path(collection_id, partition));
    }
}

pub fn invalidate_partition(collection_id: &str, partition: KcPartitionId) {
    if let Ok(mut cache) = hnsw_cache().lock() {
        cache.partitions.remove(&cache_key(collection_id, partition));
    }
    let _ = std::fs::remove_file(hnsw_file_path(collection_id, partition));
}

pub fn hnsw_vector_count(collection_id: &str, partition: KcPartitionId) -> usize {
    hnsw_cache()
        .lock()
        .ok()
        .and_then(|cache| {
            cache
                .partitions
                .get(&cache_key(collection_id, partition))
                .map(|entry| entry.key_to_chunk.len())
        })
        .unwrap_or(0)
}

pub fn hnsw_vector_count_total(collection_id: &str) -> usize {
    KcPartitionId::all()
        .iter()
        .map(|p| hnsw_vector_count(collection_id, *p))
        .sum()
}

pub fn partition_ready(collection_id: &str, partition: KcPartitionId) -> bool {
    hnsw_vector_count(collection_id, partition) > 0
}

pub fn hnsw_ready(collection_id: &str) -> bool {
    KcPartitionId::all()
        .iter()
        .any(|p| partition_ready(collection_id, *p))
}

pub fn rebuild_partition_index(
    db: &Database,
    collection_id: &str,
    partition: KcPartitionId,
) -> AppResult<usize> {
    let rows = load_dense_rows(db, collection_id, partition)?;
    if rows.is_empty() {
        invalidate_partition(collection_id, partition);
        return Ok(0);
    }

    let built = build_index(&rows)?;
    let count = built.key_to_chunk.len();
    let path = hnsw_file_path(collection_id, partition);
    if let Some(path_str) = path.to_str() {
        if let Err(err) = built.index.save(path_str) {
            log::warn!("Could not persist HNSW index for {collection_id}/{}: {err}", partition.as_str());
        }
    }

    if let Ok(mut cache) = hnsw_cache().lock() {
        cache.partitions.insert(cache_key(collection_id, partition), built);
    }
    Ok(count)
}

fn ensure_partition_index(
    db: &Database,
    collection_id: &str,
    partition: KcPartitionId,
) -> AppResult<()> {
    if partition_ready(collection_id, partition) {
        return Ok(());
    }

    let path = hnsw_file_path(collection_id, partition);
    if path.is_file() {
        let rows = load_dense_rows(db, collection_id, partition)?;
        if !rows.is_empty() {
            let dimensions = rows[0].1.len();
            let mut options = IndexOptions::default();
            options.dimensions = dimensions;
            options.metric = MetricKind::Cos;
            options.quantization = ScalarKind::F32;
            if let Ok(loaded) = Index::new(&options) {
                if let Some(path_str) = path.to_str() {
                    if loaded.load(path_str).is_ok() {
                        let mut key_to_chunk = HashMap::new();
                        for (chunk_id, _) in &rows {
                            key_to_chunk.insert(stable_chunk_key(chunk_id), chunk_id.clone());
                        }
                        if let Ok(mut cache) = hnsw_cache().lock() {
                            cache.partitions.insert(
                                cache_key(collection_id, partition),
                                CollectionHnsw {
                                    index: loaded,
                                    key_to_chunk,
                                    dimensions,
                                },
                            );
                            return Ok(());
                        }
                    }
                }
            }
        }
    }

    rebuild_partition_index(db, collection_id, partition)?;
    Ok(())
}

/// HNSW approximate nearest-neighbor search for a single partition.
/// Returns an error when the query dimension does not match the index so the
/// caller can avoid mixing incompatible embedding spaces.
pub fn search_chunk_ids(
    db: &Database,
    collection_id: &str,
    partition: KcPartitionId,
    query_vector: &[f32],
    limit: usize,
) -> AppResult<Vec<String>> {
    if query_vector.len() < 8 {
        return Ok(Vec::new());
    }
    ensure_partition_index(db, collection_id, partition)?;

    let cache = hnsw_cache()
        .lock()
        .map_err(|_| AppError::Unknown("HNSW cache lock poisoned.".to_string()))?;
    let Some(entry) = cache.partitions.get(&cache_key(collection_id, partition)) else {
        return Ok(Vec::new());
    };
    if query_vector.len() != entry.dimensions {
        return Err(AppError::Unknown(format!(
            "Query embedding dimension {} does not match {} partition index dimension {}.",
            query_vector.len(),
            partition.as_str(),
            entry.dimensions
        )));
    }

    let matches = entry
        .index
        .search(query_vector, limit.max(1).min(HNSW_SEARCH_LIMIT))
        .map_err(|e| AppError::Unknown(format!("HNSW search failed: {e}")))?;

    let mut out = Vec::new();
    for key in matches.keys {
        if let Some(chunk_id) = entry.key_to_chunk.get(&key) {
            out.push(chunk_id.clone());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_key_is_deterministic() {
        assert_eq!(stable_chunk_key("abc::chunk-1"), stable_chunk_key("abc::chunk-1"));
        assert_ne!(stable_chunk_key("a"), stable_chunk_key("b"));
    }

    #[test]
    fn partition_files_are_distinct() {
        let code = hnsw_file_path("col-1", KcPartitionId::Code);
        let general = hnsw_file_path("col-1", KcPartitionId::General);
        assert_ne!(code, general);
        assert!(code.to_string_lossy().contains("__code.usearch"));
        assert!(general.to_string_lossy().contains("__general.usearch"));
    }
}
