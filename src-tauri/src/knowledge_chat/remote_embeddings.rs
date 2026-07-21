//! Optional organization-server embeddings for Knowledge Chat.
//!
//! When the org server exposes OpenAI-compatible `/v1/embeddings` for the Nomic
//! (code) and BGE-M3 (knowledge) models, clients can offload dense embedding
//! there instead of spawning local llama-server embed processes. Local
//! embeddings remain the default and the automatic fallback, so dense retrieval
//! never silently degrades and accuracy is preserved (same model family, same
//! normalized vectors).

use std::time::Duration;

use crate::error::{AppError, AppResult};
use crate::knowledge_chat::partitions::KcPartitionId;
use crate::knowledge_chat::runtime::KcEmbedPool;
use crate::knowledge_chat::types::KcEmbedTextsRequest;

/// Resolved remote-embedding settings for the organization server.
#[derive(Debug, Clone)]
pub struct RemoteEmbedConfig {
    /// Base URL ending in `/v1` (embeddings base, falling back to chat base).
    pub base_url: String,
    pub api_key: String,
    /// Model id served by the org server for the code partition (Nomic).
    pub code_model: String,
    /// Model id served by the org server for the knowledge partition (BGE-M3).
    pub knowledge_model: String,
}

impl RemoteEmbedConfig {
    /// Remote model id for a partition, if one is configured.
    pub fn model_for(&self, partition: KcPartitionId) -> Option<&str> {
        let id = match partition {
            KcPartitionId::Code => self.code_model.trim(),
            _ => self.knowledge_model.trim(),
        };
        if id.is_empty() {
            None
        } else {
            Some(id)
        }
    }

    /// True when at least one partition has a configured remote model.
    pub fn has_any_model(&self) -> bool {
        !self.code_model.trim().is_empty() || !self.knowledge_model.trim().is_empty()
    }
}

fn embeddings_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    format!("{trimmed}/embeddings")
}

fn build_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| AppError::NetworkError(e.to_string()))
}

/// Lightweight smoke test: embed a single token to confirm the org server
/// serves the given model on `/v1/embeddings`.
pub async fn probe_remote_embeddings(base_url: &str, api_key: &str, model_id: &str) -> bool {
    if base_url.trim().is_empty() || model_id.trim().is_empty() {
        return false;
    }
    match embed_texts_remote(base_url, api_key, model_id, &["ping".to_string()]).await {
        Ok(vectors) => vectors.first().map(|v| !v.is_empty()).unwrap_or(false),
        Err(_) => false,
    }
}

/// Embed texts via the org server's OpenAI-compatible `/v1/embeddings` endpoint.
/// Returns L2-normalized vectors to match the local embedding path.
pub async fn embed_texts_remote(
    base_url: &str,
    api_key: &str,
    model_id: &str,
    texts: &[String],
) -> AppResult<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let client = build_client()?;
    let url = embeddings_url(base_url);
    let payload = serde_json::json!({ "model": model_id, "input": texts });

    let mut req = client.post(&url).json(&payload);
    if !api_key.trim().is_empty() {
        req = req.bearer_auth(api_key.trim());
    }

    let resp = req
        .send()
        .await
        .map_err(|e| AppError::NetworkError(format!("Could not reach organization /v1/embeddings: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::InferenceError(format!(
            "Organization /v1/embeddings rejected the request ({status}): {text}"
        )));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::NetworkError(e.to_string()))?;
    parse_openai_embedding_response(json, texts.len())
}

fn parse_openai_embedding_response(value: serde_json::Value, expected: usize) -> AppResult<Vec<Vec<f32>>> {
    let data = value
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| AppError::InferenceError("Embedding response missing data array.".to_string()))?;
    if data.len() != expected {
        return Err(AppError::InferenceError(format!(
            "Organization embeddings returned {} vectors, expected {expected}.",
            data.len()
        )));
    }
    data.iter()
        .map(|item| {
            let arr = item
                .get("embedding")
                .and_then(|v| v.as_array())
                .ok_or_else(|| AppError::InferenceError("Embedding item missing embedding array.".to_string()))?;
            let vector: Vec<f32> = arr.iter().map(|v| v.as_f64().unwrap_or(0.0) as f32).collect();
            if vector.is_empty() {
                return Err(AppError::InferenceError("Empty embedding vector from organization server.".to_string()));
            }
            Ok(normalize_dense_vector(vector))
        })
        .collect()
}

fn normalize_dense_vector(values: Vec<f32>) -> Vec<f32> {
    let mag = values.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>().sqrt();
    if mag <= 0.0 {
        return values;
    }
    values.into_iter().map(|v| (v as f64 / mag) as f32).collect()
}

/// Outcome of partition embedding: vectors plus optional quality guidance.
#[derive(Debug, Clone)]
pub struct EmbedPartitionOutcome {
    pub vectors: Vec<Vec<f32>>,
    /// True when organization remote embeddings produced the vectors.
    pub used_organization: bool,
    /// User-visible note when a local fallback was used (or recommended server model).
    pub quality_note: Option<String>,
}

/// Embed a batch for one partition, preferring the organization server when it
/// is configured for that partition and falls back to the local embed pool on
/// any remote failure. This is the single routing point used by both indexing
/// and query embedding so behavior stays consistent.
pub async fn embed_partition_texts(
    remote: Option<&RemoteEmbedConfig>,
    partition: KcPartitionId,
    pool: &KcEmbedPool,
    local_model_path: &str,
    context_size: u32,
    batch_size: u32,
    texts: Vec<String>,
) -> AppResult<EmbedPartitionOutcome> {
    let local_basename = std::path::Path::new(local_model_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(local_model_path);
    let recommended = match partition {
        KcPartitionId::Code => {
            "Recommended for server-class code search: Qwen3-Embedding-8B (when GPU/RAM allows)."
        }
        _ => "Recommended for server-class document search: BGE-M3 or an organization knowledge embedding endpoint.",
    };

    if let Some(remote) = remote {
        if let Some(model_id) = remote.model_for(partition) {
            match embed_texts_remote(&remote.base_url, &remote.api_key, model_id, &texts).await {
                Ok(vectors) if !vectors.is_empty() => {
                    return Ok(EmbedPartitionOutcome {
                        vectors,
                        used_organization: true,
                        quality_note: None,
                    });
                }
                Ok(_) => {
                    log::warn!(
                        "Organization embeddings returned no vectors for the {} partition; falling back to local.",
                        partition.as_str()
                    );
                }
                Err(e) => {
                    log::warn!(
                        "Organization embeddings failed for the {} partition ({e}); falling back to local.",
                        partition.as_str()
                    );
                }
            }
            let result = pool
                .embed(KcEmbedTextsRequest {
                    model_path: local_model_path.to_string(),
                    texts,
                    context_size: Some(context_size),
                    batch_size: Some(batch_size),
                })
                .await?;
            return Ok(EmbedPartitionOutcome {
                vectors: result.vectors,
                used_organization: false,
                quality_note: Some(format!(
                    "Using local {local_basename} fallback for {} partition (organization embeddings unavailable). {recommended}",
                    partition.as_str()
                )),
            });
        }
    }

    let result = pool
        .embed(KcEmbedTextsRequest {
            model_path: local_model_path.to_string(),
            texts,
            context_size: Some(context_size),
            batch_size: Some(batch_size),
        })
        .await?;
    Ok(EmbedPartitionOutcome {
        vectors: result.vectors,
        used_organization: false,
        quality_note: None,
    })
}
