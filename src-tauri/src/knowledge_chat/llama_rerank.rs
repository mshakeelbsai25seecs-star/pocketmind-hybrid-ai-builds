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

/// Keep the Qwen3-Reranker server warm across questions (same quality, far less cold-start).
const IDLE_SHUTDOWN_SECS: u64 = 1_800;
/// Rerank inputs are short (query + snippet). Large ctx + multi-slot wastes RAM and
/// previously interacted badly with `--embedding` forcing n_ubatch=512.
const RERANK_CONTEXT_SIZE: u32 = 2048;
const RERANK_BATCH_SIZE: u32 = 2048;
/// Shorter snippets keep token count down; measured ~4s/doc at 800–1400 chars on CPU.
const DOC_SNIPPET_CHARS: usize = 900;
/// llama.cpp ranks documents sequentially; keep each HTTP call small enough to
/// finish well under the client timeout on CPU.
const RERANK_HTTP_BATCH: usize = 8;
const RERANK_HTTP_TIMEOUT_SECS: u64 = 120;

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
                .timeout(Duration::from_secs(RERANK_HTTP_TIMEOUT_SECS))
                .build()
                .map_err(|e| {
                    AppError::InferenceError(format!("Failed to create remote rerank client: {e}"))
                })?;
            return post_rerank_batched(&client, &remote_base, query, documents).await;
        }
        let model_path = normalize_model_path(model_path)?;

        // Hold the pool lock only while ensuring the warm server. Scoring can take
        // tens of seconds on CPU — do not block other work (or a reset) on that.
        let (client, base_url) = {
            let mut guard = self.session.lock().await;
            Self::drop_idle(&mut guard).await;
            Self::ensure_session(&mut guard, &model_path).await?;
            let session = guard.as_mut().expect("session just ensured");
            (session.client.clone(), session.base_url.clone())
        };

        match post_rerank_batched(&client, &base_url, query, documents).await {
            Ok(scores) => {
                let mut guard = self.session.lock().await;
                if let Some(session) = guard.as_mut() {
                    if session.base_url == base_url {
                        session.last_used = Instant::now();
                    }
                }
                Ok(scores)
            }
            Err(err) => {
                // A timed-out /v1/rerank often leaves llama-server still grinding
                // the old batch — drop the session so the next call gets a clean one.
                let mut guard = self.session.lock().await;
                if let Some(session) = guard.as_ref() {
                    if session.base_url == base_url {
                        if let Some(mut stale) = guard.take() {
                            kill_and_reap(&mut stale.child).await;
                        }
                    }
                }
                Err(err)
            }
        }
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
                kill_and_reap(&mut stale.child).await;
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

/// True when the path is a GGUF intended for the llama.cpp RANK reranker.
/// Accepts `*rerank*` names and any `.gguf` living under a `rerankers` folder.
pub fn is_llama_rerank_model(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    if !lower.ends_with(".gguf") {
        return false;
    }
    if lower.contains("rerank")
        || lower.contains("qwen3-reranker")
        || lower.contains("qwen3_reranker")
    {
        return true;
    }
    // Any GGUF the user places under models/rerankers/ is treated as the RANK model.
    lower.contains("/rerankers/") || lower.contains("\\rerankers\\")
}

const QWEN3_RERANK_CANDIDATES: &[&str] = &[
    "Qwen3-Reranker-4B-Q4_K_M.gguf",
    "Qwen3-Reranker-4B-Q5_K_M.gguf",
    "Qwen3-Reranker-4B-Q8_0.gguf",
    "Qwen3-Reranker-4B-f16.gguf",
    "Qwen3-Reranker-4B.gguf",
];

/// Probe `models/rerankers` for a known Qwen3-Reranker GGUF (or any GGUF there).
pub fn probe_qwen3_rerank_ggufs(models_dir: &str) -> Option<String> {
    if let Some(found) = probe_qwen3_rerank_in_models_dir(models_dir) {
        return Some(found);
    }
    // Windows: also probe legacy NexusAI models root when the preferred root differs.
    #[cfg(target_os = "windows")]
    {
        let legacy = PathBuf::from(crate::deployment::WINDOWS_LEGACY_DATA_ROOT).join("models");
        let legacy_s = legacy.to_string_lossy();
        if !legacy_s.eq_ignore_ascii_case(models_dir.trim()) {
            if let Some(found) = probe_qwen3_rerank_in_models_dir(&legacy_s) {
                return Some(found);
            }
        }
    }
    None
}

fn probe_qwen3_rerank_in_models_dir(models_dir: &str) -> Option<String> {
    let rerankers = Path::new(models_dir).join("rerankers");
    for name in QWEN3_RERANK_CANDIDATES {
        let candidate = rerankers.join(name);
        if crate::gguf::is_valid_gguf_file(&candidate) {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    // Prefer any *rerank* name, then fall back to the first valid GGUF in the folder.
    let mut any_gguf: Option<String> = None;
    if let Ok(entries) = std::fs::read_dir(&rerankers) {
        let mut paths: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| crate::gguf::is_valid_gguf_file(p))
            .collect();
        paths.sort();
        for path in paths {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let full = path.to_string_lossy().to_string();
            if is_llama_rerank_model(name) || name.to_ascii_lowercase().contains("rerank") {
                return Some(full);
            }
            if any_gguf.is_none() {
                any_gguf = Some(full);
            }
        }
    }
    any_gguf
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
        if Path::new(&path).is_file()
            && (is_llama_rerank_model(&path) || path.to_ascii_lowercase().ends_with(".gguf"))
        {
            // Prefer configured GGUF; skip ONNX / non-files (fall through to probe).
            if path.to_ascii_lowercase().ends_with(".gguf") {
                return Some(path);
            }
        }
    }
    // Prefer discovering a folder GGUF even when settings still point at ONNX.
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
    // Policy: try GPU first, then CPU. The historical bug was not "missing CPU in
    // the ladder" — `gpu_layer_attempts` already ended with 0 — but that the GPU
    // attempt *hangs without exiting*, we only `kill()` without `wait()`, and the
    // following `--gpu-layers 0` spawn is poisoned by the still-dying Vulkan
    // process (live logs: llama_rank_ms ≈ 2× health timeout, then fallback).
    //
    // Fix:
    // 1) Thin GPU ladder (one optimistic offload, then 0 on that runtime)
    // 2) Fail-fast health window for GPU attempts
    // 3) Kill + wait + brief settle before the next attempt
    // 4) Dedicated clean CPU pass across CPU-ordered runtimes afterward
    let desired_gpu_layers = runtime_discovery::embed_gpu_layers();
    let gpu_runtimes = runtime_discovery::ordered_runtime_candidates(desired_gpu_layers)?;
    let mut errors = Vec::<String>::new();

    crate::knowledge_chat::debug_session::agent_log(
        "R",
        "llama_rerank.rs:spawn_rerank_server",
        "rerank_spawn_begin",
        serde_json::json!({
            "model_basename": Path::new(model_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(model_path),
            "desired_gpu_layers": desired_gpu_layers,
            "runtime_count": gpu_runtimes.len(),
            "first_runtime": gpu_runtimes.first().map(|r| r.label.clone()),
        }),
    );

    // ---- Pass 1: GPU-capable runtimes (and their own layer-0 attempt) ----
    for runtime in gpu_runtimes.iter().filter(|r| !r.force_cpu) {
        let attempts =
            rerank_gpu_layer_attempts(model_path, desired_gpu_layers, runtime.force_cpu);
        for gpu_layers in attempts {
            match try_spawn_rerank_attempt(&runtime.path, model_path, gpu_layers).await {
                Ok(session) => {
                    crate::knowledge_chat::debug_session::agent_log(
                        "R",
                        "llama_rerank.rs:spawn_rerank_server",
                        "rerank_spawn_ok",
                        serde_json::json!({
                            "pass": "gpu",
                            "runtime": runtime.label,
                            "gpu_layers": gpu_layers,
                            "base_url": session.base_url,
                        }),
                    );
                    return Ok(session);
                }
                Err(e) => {
                    let msg = e.to_string();
                    crate::knowledge_chat::debug_session::agent_log(
                        "R",
                        "llama_rerank.rs:spawn_rerank_server",
                        "rerank_spawn_attempt_failed",
                        serde_json::json!({
                            "pass": "gpu",
                            "runtime": runtime.label,
                            "gpu_layers": gpu_layers,
                            "error": msg.chars().take(500).collect::<String>(),
                        }),
                    );
                    errors.push(format!(
                        "{} with {} GPU layers: {msg}",
                        runtime.label, gpu_layers
                    ));
                }
            }
        }
    }

    // ---- Pass 2: clean CPU-only pass (fresh runtimes, layers forced to 0) ----
    // Runs even if Pass 1 already tried layers=0, because that attempt may have
    // been poisoned by an incompletely reaped GPU process.
    let cpu_runtimes = runtime_discovery::ordered_runtime_candidates(0)?;
    for runtime in cpu_runtimes {
        match try_spawn_rerank_attempt(&runtime.path, model_path, 0).await {
            Ok(session) => {
                crate::knowledge_chat::debug_session::agent_log(
                    "R",
                    "llama_rerank.rs:spawn_rerank_server",
                    "rerank_spawn_ok",
                    serde_json::json!({
                        "pass": "cpu",
                        "runtime": runtime.label,
                        "gpu_layers": 0,
                        "base_url": session.base_url,
                    }),
                );
                return Ok(session);
            }
            Err(e) => {
                let msg = e.to_string();
                crate::knowledge_chat::debug_session::agent_log(
                    "R",
                    "llama_rerank.rs:spawn_rerank_server",
                    "rerank_spawn_attempt_failed",
                    serde_json::json!({
                        "pass": "cpu",
                        "runtime": runtime.label,
                        "gpu_layers": 0,
                        "error": msg.chars().take(500).collect::<String>(),
                    }),
                );
                errors.push(format!("{} with 0 GPU layers (cpu pass): {msg}", runtime.label));
            }
        }
    }

    Err(AppError::InferenceError(format!(
        "Could not start Qwen3/llama.cpp rerank server after GPU then CPU fallback. Details:\n{}",
        errors.join("\n")
    )))
}

/// Thin GPU→CPU ladder for rerank. One optimistic GPU try, then 0.
/// Long ladders (999/120/96/…) burned minutes and never reached a clean CPU start.
fn rerank_gpu_layer_attempts(
    model_path: &str,
    requested_gpu_layers: i32,
    force_cpu: bool,
) -> Vec<i32> {
    if force_cpu || requested_gpu_layers == 0 {
        return vec![0];
    }
    let model_size = runtime_discovery::model_size_bytes(model_path);
    let (_, _, free_vram, _) = runtime_discovery::hardware_memory_snapshot();
    let partial = runtime_discovery::estimate_partial_gpu_layers(model_size, free_vram);

    let gpu_try = if requested_gpu_layers > 0 {
        if partial > 0 && partial < 999 {
            requested_gpu_layers.min(partial)
        } else {
            requested_gpu_layers
        }
    } else if partial >= 999 {
        999
    } else if partial > 0 {
        partial
    } else {
        return vec![0];
    };

    runtime_discovery::unique_descending_layers(vec![gpu_try, 0])
}

/// Kill a failed spawn and wait until it is actually gone so the next attempt
/// (especially CPU after a hung Vulkan GPU try) is not poisoned.
async fn kill_and_reap(child: &mut tokio::process::Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
    // Vulkan / driver teardown can lag process exit on Windows iGPUs.
    sleep(Duration::from_millis(400)).await;
}

async fn try_spawn_rerank_attempt(
    runtime: &Path,
    model_path: &str,
    gpu_layers: i32,
) -> AppResult<WarmRerankSession> {
    let port = find_free_localhost_port()?;
    let base_url = format!("http://127.0.0.1:{port}");
    let stderr_path = std::env::temp_dir().join(format!(
        "nexus-rerank-{}-{}.log",
        std::process::id(),
        port
    ));
    let stderr_file = std::fs::File::create(&stderr_path).ok();

    let mut command = Command::new(runtime);
    command
        .arg("-m")
        .arg(model_path)
        .arg("--reranking")
        .arg("--pooling")
        .arg("rank")
        // Do NOT pass --embedding: it forces n_ubatch=512 and rejects typical
        // query+snippet rerank payloads (~500–800 tokens) with HTTP 500.
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("-c")
        .arg(RERANK_CONTEXT_SIZE.to_string())
        .arg("-b")
        .arg(RERANK_BATCH_SIZE.to_string())
        .arg("-ub")
        .arg(RERANK_BATCH_SIZE.to_string())
        .arg("-np")
        .arg("1")
        .arg("--cache-ram")
        .arg("0")
        .arg("--gpu-layers")
        .arg(gpu_layers.max(0).to_string());

    if let Some(parent) = runtime.parent() {
        command.current_dir(parent);
    }

    let mut command = command;
    command.stdout(Stdio::null());
    if let Some(file) = stderr_file {
        command.stderr(Stdio::from(file));
    } else {
        command.stderr(Stdio::null());
    }

    let child = command
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::InferenceError(format!("Could not start rerank server: {e}")))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(RERANK_HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| AppError::InferenceError(format!("Failed to create rerank client: {e}")))?;

    let health_url = format!("{base_url}/health");
    // GPU offload either becomes ready quickly or hangs on iGPU OOM — fail fast.
    // CPU load of Qwen3-Reranker-4B-Q4 is typically healthy in ~7–20s.
    let health_secs = if gpu_layers > 0 { 25 } else { 90 };
    let deadline = Instant::now() + Duration::from_secs(health_secs);
    let mut child = child;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            let tail = std::fs::read_to_string(&stderr_path).unwrap_or_default();
            let snippet: String = tail
                .chars()
                .rev()
                .take(900)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            let _ = std::fs::remove_file(&stderr_path);
            return Err(AppError::InferenceError(format!(
                "Rerank server exited before ready. Exit status: {status}. {}",
                if snippet.trim().is_empty() {
                    String::new()
                } else {
                    format!("llama-server output:\n{snippet}")
                }
            )));
        }
        if client
            .get(&health_url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
        {
            let _ = std::fs::remove_file(&stderr_path);
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

    // Timed out while still alive — this is the hung-GPU case. Must fully reap
    // before the next attempt or CPU fallback is poisoned.
    kill_and_reap(&mut child).await;
    let tail = std::fs::read_to_string(&stderr_path).unwrap_or_default();
    let snippet: String = tail
        .chars()
        .rev()
        .take(900)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let _ = std::fs::remove_file(&stderr_path);
    Err(AppError::InferenceError(format!(
        "Rerank server started but did not become healthy within {health_secs}s (gpu_layers={gpu_layers}). {}",
        if snippet.trim().is_empty() {
            String::new()
        } else {
            format!("llama-server output:\n{snippet}")
        }
    )))
}

async fn post_rerank_batched(
    client: &reqwest::Client,
    base_url: &str,
    query: &str,
    documents: &[String],
) -> AppResult<Vec<f64>> {
    if documents.is_empty() {
        return Ok(Vec::new());
    }
    let mut scores = vec![0.0f64; documents.len()];
    for (batch_start, chunk) in documents.chunks(RERANK_HTTP_BATCH).enumerate() {
        let offset = batch_start * RERANK_HTTP_BATCH;
        let batch_scores = post_rerank(client, base_url, query, chunk).await?;
        if batch_scores.len() != chunk.len() {
            return Err(AppError::InferenceError(format!(
                "Rerank batch score count mismatch at offset {offset}: got {}, expected {}",
                batch_scores.len(),
                chunk.len()
            )));
        }
        for (i, score) in batch_scores.into_iter().enumerate() {
            scores[offset + i] = score;
        }
    }
    Ok(scores)
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
            r"D:\nexus-ai-deep-fixed\runtime-data\models\rerankers\Qwen3-Reranker-4B-Q4_K_M.gguf"
        ));
        assert!(is_llama_rerank_model(
            r"D:\NexusAI\models\rerankers\custom-cross-encoder.gguf"
        ));
        assert!(!is_llama_rerank_model(
            r"D:\nexus-ai-deep-fixed\runtime-data\models\rerankers\bge-reranker-base.onnx"
        ));
        assert!(!is_llama_rerank_model(
            r"D:\nexus-ai-deep-fixed\runtime-data\models\embeddings\Qwen3-Embedding-8B.gguf"
        ));
    }

    #[test]
    fn probe_accepts_any_gguf_in_rerankers_folder() {
        let tmp = std::env::temp_dir().join(format!(
            "nexus-rerank-probe-any-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        let rerankers = tmp.join("rerankers");
        std::fs::create_dir_all(&rerankers).unwrap();
        let mut payload = b"GGUF".to_vec();
        payload.extend(vec![0u8; crate::gguf::MIN_PLAUSIBLE_GGUF_BYTES as usize]);
        std::fs::write(rerankers.join("my-custom-model.gguf"), &payload).unwrap();
        let found = probe_qwen3_rerank_ggufs(tmp.to_str().unwrap()).unwrap();
        assert!(
            found.ends_with("my-custom-model.gguf"),
            "expected any folder GGUF, got {found}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn probe_returns_none_for_empty_dir() {
        let tmp = std::env::temp_dir().join(format!("nexus-rerank-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("rerankers")).unwrap();
        let found = probe_qwen3_rerank_ggufs(tmp.to_str().unwrap());
        // Empty local folder must not invent a path under tmp. On Windows the
        // probe may still return a real GGUF from D:\NexusAI\models.
        if let Some(path) = found {
            let tmp_s = tmp.to_string_lossy();
            assert!(
                !path.starts_with(tmp_s.as_ref()),
                "empty tmp dir should not yield a path under itself, got {path}"
            );
        }
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
    fn rerank_layer_ladder_is_thin_and_ends_with_cpu() {
        // force_cpu / requested 0 → CPU only
        assert_eq!(rerank_gpu_layer_attempts("x.gguf", -1, true), vec![0]);
        assert_eq!(rerank_gpu_layer_attempts("x.gguf", 0, false), vec![0]);
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
