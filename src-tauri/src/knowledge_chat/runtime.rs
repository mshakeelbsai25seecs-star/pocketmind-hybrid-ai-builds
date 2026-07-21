use crate::error::{AppError, AppResult};
use crate::knowledge_chat::embeddings::{
    embed_texts_on_server, shutdown_embedding_server, spawn_embedding_server, validate_model_path,
    EmbedServerHandle, EMBED_BATCH_SIZE, EMBED_CONTEXT_SIZE, MAX_TEXTS_PER_RUN,
};
use crate::knowledge_chat::types::{KcEmbedTextsRequest, KcEmbedTextsResult};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Keep warm embed servers longer so a second Knowledge Chat question does not
/// pay another multi-minute Qwen3-Embedding cold start. Same model/weights.
const IDLE_SHUTDOWN_SECS: u64 = 1_800;
const DEFAULT_MAX_WARM_SESSIONS: usize = 2;

struct WarmEmbedSession {
    model_path: String,
    context_size: u32,
    batch_size: u32,
    handle: EmbedServerHandle,
    last_used: Instant,
}

/// Maximum number of concurrently warm embedding servers. Defaults to 2 (one
/// per partition model for "Both" searches) and can be lowered to 1 on
/// memory-constrained machines via `NEXUS_KC_MAX_EMBED_SESSIONS`, which makes
/// the pool fall back to sequential single-model operation (re-spawn on switch).
fn max_warm_sessions() -> usize {
    std::env::var("NEXUS_KC_MAX_EMBED_SESSIONS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .map(|value| value.clamp(1, DEFAULT_MAX_WARM_SESSIONS))
        .unwrap_or(DEFAULT_MAX_WARM_SESSIONS)
}

/// Keeps up to `max_warm_sessions()` embedding servers warm, keyed by
/// (model_path, context_size, batch_size). When a new model is requested beyond
/// capacity the least-recently-used session is evicted (LRU).
pub struct KcEmbedPool {
    sessions: Mutex<Vec<WarmEmbedSession>>,
}

impl KcEmbedPool {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(Vec::new()),
        })
    }

    pub async fn embed(&self, request: KcEmbedTextsRequest) -> AppResult<KcEmbedTextsResult> {
        let model_path = validate_model_path(&request.model_path, None)?;
        if request.texts.is_empty() {
            return Err(AppError::Unknown("No texts provided for embedding.".to_string()));
        }
        if request.texts.len() > MAX_TEXTS_PER_RUN {
            return Err(AppError::Unknown(format!(
                "Embedding is limited to {MAX_TEXTS_PER_RUN} texts per run for local memory safety."
            )));
        }

        let context_size = request.context_size.unwrap_or(EMBED_CONTEXT_SIZE).clamp(512, 8192);
        let batch_size = request.batch_size.unwrap_or(EMBED_BATCH_SIZE).clamp(256, 4096);

        let mut guard = self.sessions.lock().await;
        Self::drop_idle(&mut guard).await;
        let idx = Self::ensure_session(&mut guard, &model_path, context_size, batch_size).await?;

        let vectors = embed_texts_on_server(&guard[idx].handle, &request.texts, batch_size).await?;
        guard[idx].last_used = Instant::now();

        let vector_dimension = vectors.first().map(|v| v.len()).unwrap_or(0);
        Ok(KcEmbedTextsResult {
            vectors,
            model_path,
            vector_dimension,
        })
    }

    pub async fn shutdown(&self) {
        let mut guard = self.sessions.lock().await;
        for mut session in guard.drain(..) {
            shutdown_embedding_server(&mut session.handle).await;
        }
    }

    async fn drop_idle(guard: &mut Vec<WarmEmbedSession>) {
        let mut idx = 0;
        while idx < guard.len() {
            if guard[idx].last_used.elapsed() > Duration::from_secs(IDLE_SHUTDOWN_SECS) {
                let mut session = guard.remove(idx);
                shutdown_embedding_server(&mut session.handle).await;
            } else {
                idx += 1;
            }
        }
    }

    /// Ensure a warm session exists for the given model parameters; returns its index.
    async fn ensure_session(
        guard: &mut Vec<WarmEmbedSession>,
        model_path: &str,
        context_size: u32,
        batch_size: u32,
    ) -> AppResult<usize> {
        // Reuse a matching, healthy session.
        if let Some(pos) = guard.iter().position(|s| {
            s.model_path == model_path && s.context_size == context_size && s.batch_size == batch_size
        }) {
            if guard[pos].handle.is_healthy().await {
                return Ok(pos);
            }
            let mut stale = guard.remove(pos);
            shutdown_embedding_server(&mut stale.handle).await;
        }

        // Evict least-recently-used sessions until under capacity.
        let max = max_warm_sessions();
        while guard.len() >= max {
            if let Some(lru) = guard
                .iter()
                .enumerate()
                .min_by_key(|(_, s)| s.last_used)
                .map(|(idx, _)| idx)
            {
                log::info!("Evicting LRU embedding session to honor max {max} warm sessions.");
                let mut evicted = guard.remove(lru);
                shutdown_embedding_server(&mut evicted.handle).await;
            } else {
                break;
            }
        }

        let handle = spawn_embedding_server(model_path, context_size, batch_size).await?;
        guard.push(WarmEmbedSession {
            model_path: model_path.to_string(),
            context_size,
            batch_size,
            handle,
            last_used: Instant::now(),
        });
        Ok(guard.len() - 1)
    }
}

/// Legacy alias kept for module wiring during evolution.
pub type KcModuleState = KcEmbedPool;
