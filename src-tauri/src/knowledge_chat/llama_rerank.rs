//! Qwen3-Reranker (and compatible llama.cpp RANK models) via a dedicated
//! `llama-server` process with `--reranking --pooling rank`.
//!
//! This is the **primary** final neural reranker for Knowledge Chat when a
//! properly converted Qwen3-Reranker GGUF is present under `models/rerankers/`.
//! ONNX cross-encoder and phrase/title boosts are fallbacks only.
//! Community GGUFs missing `cls.output.weight` produce garbage scores — use an
//! official convert_hf_to_gguf.py build.

use crate::database::Database;
use crate::deployment::load_deployment_config;
use crate::error::{AppError, AppResult};
use crate::knowledge_chat::types::KcSearchHit;
use crate::llm::runtime_discovery;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::sleep;

const IDLE_SHUTDOWN_SECS: u64 = 300;
const RERANK_CONTEXT_SIZE: u32 = 8192;
const DOC_SNIPPET_CHARS: usize = 2400;

struct WarmRerankSession {
    model_path: String,
    base_url: String,
    child: tokio::process::Child,
    client: reqwest::Client,
    last_used: Instant,
}

/// Warm pool for the llama.cpp rerank server (one model at a time).
pub struct KcRerankPool {
    session: Mutex<Option<WarmRerankSession>>,
}

impl KcRerankPool {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            session: Mutex::new(None),
        })
    }

    pub async fn shutdown(&self) {
        let mut guard = self.session.lock().await;
        if let Some(mut session) = guard.take() {
            let _ = session.child.kill().await;
        }
    }

    /// Score query/document pairs. Returns relevance scores in `[0, 1]` aligned
    /// with `documents`, or an error if the server cannot start / respond.
    ///
    /// When `NEXUS_RERANK_URL` is set (e.g. `http://rerank:8003`), posts to that
    /// base URL's `/v1/rerank` and never spawns a local llama-server.
    pub async fn score(
        &self,
        model_path: &str,
        query: &str,
        documents: &[String],
    ) -> AppResult<Vec<f64>> {
        if documents.is_empty() {
            return Ok(Vec::new());
        }
        if let Some(remote_base) = remote_rerank_base_url() {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(180))
                .build()
                .map_err(|e| AppError::InferenceError(format!("Failed to create remote rerank client: {e}")))?;
            return post_rerank(&client, &remote_base, query, documents).await;
        }
        let model_path = normalize_model_path(model_path)?;
        let mut guard = self.session.lock().await;
        Self::drop_idle(&mut guard).await;
        Self::ensure_session(&mut guard, &model_path).await?;
        let session = guard.as_mut().expect("session just ensured");
        let scores = post_rerank(&session.client, &session.base_url, query, documents).await?;
        session.last_used = Instant::now();
        Ok(scores)
    }

    async fn drop_idle(guard: &mut Option<WarmRerankSession>) {
        if let Some(session) = guard.as_ref() {
            if session.last_used.elapsed() > Duration::from_secs(IDLE_SHUTDOWN_SECS) {
                if let Some(mut session) = guard.take() {
                    let _ = session.child.kill().await;
                }
            }
        }
    }

    async fn ensure_session(
        guard: &mut Option<WarmRerankSession>,
        model_path: &str,
    ) -> AppResult<()> {
        if let Some(session) = guard.as_ref() {
            if session.model_path == model_path {
                let health = format!("{}/health", session.base_url);
                if session
                    .client
                    .get(&health)
                    .send()
                    .await
                    .map(|r| r.status().is_success())
                    .unwrap_or(false)
                {
                    return Ok(());
                }
            }
            if let Some(mut stale) = guard.take() {
                let _ = stale.child.kill().await;
            }
        }
        *guard = Some(spawn_rerank_server(model_path).await?);
        Ok(())
    }
}

fn normalize_model_path(model_path: &str) -> AppResult<String> {
    let path = PathBuf::from(model_path.trim());
    if !path.is_file() {
        return Err(AppError::Unknown(format!(
            "Reranker model not found: {}",
            model_path
        )));
    }
    Ok(path.to_string_lossy().to_string())
}

/// Prefer a remote llama.cpp rerank server when `NEXUS_RERANK_URL` is set.
pub fn remote_rerank_base_url() -> Option<String> {
    let raw = std::env::var("NEXUS_RERANK_URL").ok()?;
    let trimmed = raw.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// True when the configured path looks like a llama.cpp RANK GGUF (Qwen3-Reranker).
pub fn is_llama_rerank_model(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".gguf")
        && (lower.contains("rerank") || lower.contains("qwen3-reranker") || lower.contains("qwen3_reranker"))
}

const QWEN3_RERANK_CANDIDATES: &[&str] = &[
    "Qwen3-Reranker-4B-Q4_K_M.gguf",
    "Qwen3-Reranker-4B-Q5_K_M.gguf",
    "Qwen3-Reranker-4B-Q8_0.gguf",
    "Qwen3-Reranker-4B-f16.gguf",
    "Qwen3-Reranker-4B.gguf",
];

/// Probe `models/rerankers` for a known Qwen3-Reranker GGUF (or any matching name).
pub fn probe_qwen3_rerank_ggufs(models_dir: &str) -> Option<String> {
    let rerankers = Path::new(models_dir).join("rerankers");
    for name in QWEN3_RERANK_CANDIDATES {
        let candidate = rerankers.join(name);
        if crate::gguf::is_valid_gguf_file(&candidate) {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    // Accept any *qwen3*rerank*.gguf the user dropped in (e.g. community F16 builds).
    if let Ok(entries) = std::fs::read_dir(&rerankers) {
        for entry in entries.flatten() {
            let path = entry.path();
            if crate::gguf::is_valid_gguf_file(&path) {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if is_llama_rerank_model(name) || is_llama_rerank_model(&path.to_string_lossy()) {
                    return Some(path.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

/// Resolve the primary llama.cpp RANK GGUF (Qwen3-Reranker) from settings /
/// deployment. Priority:
/// 1. Remote `NEXUS_RERANK_URL` (returns a sentinel path; no local GGUF required)
/// 2. Configured path when it is an existing RANK `.gguf`
/// 3. Probe `models/rerankers` for known Qwen3-Reranker filenames
///
/// An empty or ONNX-only configured path still picks up a Qwen GGUF when present
/// so the primary reranker is never skipped solely because the setting points at
/// a secondary ONNX model.
pub fn resolve_llama_rerank_path(db: &Database) -> Option<String> {
    if let Some(url) = remote_rerank_base_url() {
        return Some(format!("remote:{url}"));
    }
    let deploy = load_deployment_config(db);
    let setting: Option<String> = db
        .conn()
        .query_row(
            "SELECT value FROM settings WHERE key = 'kc_reranker_model_path'",
            [],
            |row| row.get(0),
        )
        .ok();
    let configured = setting
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            let p = deploy.reranker_model_path.trim().to_string();
            if p.is_empty() {
                None
            } else {
                Some(p)
            }
        });
    if let Some(path) = configured {
        if is_llama_rerank_model(&path) && Path::new(&path).is_file() {
            return Some(path);
        }
    }
    // Prefer discovering Qwen even when settings still point at an ONNX file.
    probe_qwen3_rerank_ggufs(&deploy.models_dir)
}

/// Apply Qwen3 / llama.cpp RANK reranking to the top hits.
/// Returns `Ok(true)` when scores were applied, `Ok(false)` when skipped,
/// `Err(reason)` when the rerank server/path failed.
pub async fn apply_llama_rerank(
    pool: &Arc<KcRerankPool>,
    model_path: &str,
    query: &str,
    hits: &mut [KcSearchHit],
    top_n: usize,
    blend_self: f64,
    blend_new: f64,
) -> Result<bool, String> {
    if hits.is_empty() || query.trim().is_empty() {
        return Ok(false);
    }
    let capped = hits.len().min(top_n.max(1));
    let documents: Vec<String> = hits[..capped]
        .iter()
        .map(|hit| {
            let body = hit
                .chunk
                .context_text
                .as_deref()
                .unwrap_or(&hit.chunk.text);
            let snippet: String = body.chars().take(DOC_SNIPPET_CHARS).collect();
            format!(
                "{} | {} | {}",
                hit.chunk.file_name,
                hit.chunk.title,
                snippet
            )
        })
        .collect();

    let scores = pool
        .score(model_path, query, &documents)
        .await
        .map_err(|e| e.to_string())?;
    if scores.len() != capped {
        return Err(format!(
            "rerank score count mismatch: got {}, expected {capped}",
            scores.len()
        ));
    }

    let max_score = scores.iter().copied().fold(0.0f64, f64::max);
    for (hit, raw) in hits[..capped].iter_mut().zip(scores.iter()) {
        let normalized = if max_score > 0.0 { raw / max_score } else { *raw };
        hit.rerank_score = hit.rerank_score * blend_self + normalized * blend_new;
    }
    hits.sort_by(|a, b| {
        b.rerank_score
            .partial_cmp(&a.rerank_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for (idx, hit) in hits.iter_mut().enumerate() {
        hit.rank = idx + 1;
    }
    Ok(true)
}

async fn spawn_rerank_server(model_path: &str) -> AppResult<WarmRerankSession> {
    let desired_gpu_layers = runtime_discovery::embed_gpu_layers();
    let runtimes = runtime_discovery::ordered_runtime_candidates(desired_gpu_layers)?;
    let mut errors = Vec::<String>::new();

    for runtime in runtimes {
        let attempts =
            runtime_discovery::gpu_layer_attempts(model_path, desired_gpu_layers, runtime.force_cpu);
        for gpu_layers in attempts {
            match try_spawn_rerank_attempt(&runtime.path, model_path, gpu_layers).await {
                Ok(session) => return Ok(session),
                Err(e) => errors.push(format!("{} with {} GPU layers: {}", runtime.label, gpu_layers, e)),
            }
        }
    }

    Err(AppError::InferenceError(format!(
        "Could not start Qwen3/llama.cpp rerank server. Details:\n{}",
        errors.join("\n")
    )))
}

async fn try_spawn_rerank_attempt(
    runtime: &Path,
    model_path: &str,
    gpu_layers: i32,
) -> AppResult<WarmRerankSession> {
    let port = find_free_localhost_port()?;
    let base_url = format!("http://127.0.0.1:{port}");

    let mut command = Command::new(runtime);
    command
        .arg("-m")
        .arg(model_path)
        .arg("--reranking")
        .arg("--pooling")
        .arg("rank")
        .arg("--embedding")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("-c")
        .arg(RERANK_CONTEXT_SIZE.to_string())
        .arg("--gpu-layers")
        .arg(gpu_layers.max(0).to_string());

    if let Some(parent) = runtime.parent() {
        command.current_dir(parent);
    }

    let child = command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::InferenceError(format!("Could not start rerank server: {e}")))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| AppError::InferenceError(format!("Failed to create rerank client: {e}")))?;

    let health_url = format!("{base_url}/health");
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        if client
            .get(&health_url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
        {
            return Ok(WarmRerankSession {
                model_path: model_path.to_string(),
                base_url,
                child,
                client,
                last_used: Instant::now(),
            });
        }
        sleep(Duration::from_millis(250)).await;
    }

    Err(AppError::InferenceError(
        "Rerank server started but did not become healthy in time.".to_string(),
    ))
}

async fn post_rerank(
    client: &reqwest::Client,
    base_url: &str,
    query: &str,
    documents: &[String],
) -> AppResult<Vec<f64>> {
    let url = format!("{base_url}/v1/rerank");
    let body = serde_json::json!({
        "model": "rerank",
        "query": query,
        "documents": documents,
        "top_n": documents.len(),
    });
    let response = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::InferenceError(format!("Rerank request failed: {e}")))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(AppError::InferenceError(format!(
            "Rerank server rejected request ({status}): {text}"
        )));
    }
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|e| AppError::InferenceError(format!("Invalid rerank response: {e}")))?;

    // llama-server returns results with index + relevance_score (order may differ).
    let mut scores = vec![0.0f64; documents.len()];
    let results = payload
        .get("results")
        .or_else(|| payload.get("data"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for item in results {
        let idx = item
            .get("index")
            .and_then(|v| v.as_u64())
            .unwrap_or(u64::MAX) as usize;
        let score = item
            .get("relevance_score")
            .or_else(|| item.get("score"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        if idx < scores.len() {
            scores[idx] = score;
        }
    }
    Ok(scores)
}

fn find_free_localhost_port() -> AppResult<u16> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .map_err(|e| AppError::InferenceError(format!("Could not allocate local port: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_qwen3_gguf_reranker() {
        assert!(is_llama_rerank_model(
            r"D:\NexusAI\models\rerankers\Qwen3-Reranker-4B-Q4_K_M.gguf"
        ));
        assert!(!is_llama_rerank_model(
            r"D:\NexusAI\models\rerankers\bge-reranker-base.onnx"
        ));
        assert!(!is_llama_rerank_model(
            r"D:\NexusAI\models\embeddings\Qwen3-Embedding-8B.gguf"
        ));
    }

    #[test]
    fn probe_returns_none_for_empty_dir() {
        let tmp = std::env::temp_dir().join(format!("nexus-rerank-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("rerankers")).unwrap();
        assert!(probe_qwen3_rerank_ggufs(tmp.to_str().unwrap()).is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn probe_prefers_known_qwen3_candidate_first() {
        let tmp = std::env::temp_dir().join(format!(
            "nexus-rerank-probe-order-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        let rerankers = tmp.join("rerankers");
        std::fs::create_dir_all(&rerankers).unwrap();
        // Minimal valid GGUF payloads (magic + size) so discovery rejects HTML stubs.
        let mut payload = b"GGUF".to_vec();
        payload.extend(vec![0u8; crate::gguf::MIN_PLAUSIBLE_GGUF_BYTES as usize]);
        // Secondary-looking name should lose to the preferred Q4_K_M candidate.
        std::fs::write(rerankers.join("qwen3-reranker-custom.gguf"), &payload).unwrap();
        std::fs::write(rerankers.join("Qwen3-Reranker-4B-Q4_K_M.gguf"), &payload).unwrap();
        let found = probe_qwen3_rerank_ggufs(tmp.to_str().unwrap()).unwrap();
        assert!(
            found.ends_with("Qwen3-Reranker-4B-Q4_K_M.gguf"),
            "expected preferred Q4_K_M candidate, got {found}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn remote_rerank_url_parsed() {
        std::env::remove_var("NEXUS_RERANK_URL");
        assert!(remote_rerank_base_url().is_none());
        std::env::set_var("NEXUS_RERANK_URL", "http://rerank:8003/");
        assert_eq!(
            remote_rerank_base_url().as_deref(),
            Some("http://rerank:8003")
        );
        std::env::remove_var("NEXUS_RERANK_URL");
    }
}
