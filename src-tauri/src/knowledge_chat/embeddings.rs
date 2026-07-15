use crate::database::Database;
use crate::deployment::{load_deployment_config, normalize_path_string};
use crate::error::{AppError, AppResult};
use crate::llm::runtime_discovery;
use crate::knowledge_chat::db;
use crate::knowledge_chat::path_guard;
use crate::knowledge_chat::embedding_profiles::{self, EmbeddingProfileId};
use crate::knowledge_chat::partitions::{KcFolderCategory, KcPartitionId};
use crate::knowledge_chat::types::{
    KcEmbedTextsRequest, KcEmbedTextsResult, KcEmbeddingValidation, KcIndexProgress, KcPartitionConfig,
    KcPartitionModelConfig,
};
use std::sync::Arc;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tauri::Window;
use tokio::process::Command;
use tokio::time::sleep;

pub(crate) const EMBED_BATCH_SIZE: u32 = 512;
pub(crate) const EMBED_CONTEXT_SIZE: u32 = 2048;
pub(crate) const MAX_TEXTS_PER_RUN: usize = 160;

pub(crate) struct EmbedServerHandle {
    pub base_url: String,
    batch_size: u32,
    child: tokio::process::Child,
    client: reqwest::Client,
}

impl EmbedServerHandle {
    pub async fn is_healthy(&self) -> bool {
        let health_url = format!("{}/health", self.base_url);
        self.client
            .get(&health_url)
            .send()
            .await
            .map(|resp| resp.status().is_success())
            .unwrap_or(false)
    }
}

/// Spawn a local embedding server, mirroring chat's GPU/CPU auto-fit policy:
/// try the preferred GPU runtime with full offload, then progressively fewer
/// GPU layers, then CPU. The per-attempt layer counts come from free-VRAM-aware
/// estimation, so embeddings naturally share the GPU with chat when it fits and
/// fall back cleanly when it does not. Same GGUF, profiles, and dimensions —
/// only the execution device changes, so accuracy is unaffected.
pub(crate) async fn spawn_embedding_server(
    model_path: &str,
    context_size: u32,
    batch_size: u32,
) -> AppResult<EmbedServerHandle> {
    let desired_gpu_layers = runtime_discovery::embed_gpu_layers();
    if desired_gpu_layers != 0 && runtime_discovery::chat_holds_gpu() {
        log::info!(
            "Chat currently holds {} GPU layers; embedding server will fit remaining VRAM or fall back to CPU.",
            runtime_discovery::chat_gpu_layers_active()
        );
    }

    let runtimes = runtime_discovery::ordered_runtime_candidates(desired_gpu_layers)?;
    let mut errors = Vec::<String>::new();

    for runtime in runtimes {
        let attempts = runtime_discovery::gpu_layer_attempts(model_path, desired_gpu_layers, runtime.force_cpu);
        for gpu_layers in attempts {
            match try_spawn_embedding_attempt(&runtime.path, model_path, context_size, batch_size, gpu_layers).await {
                Ok(handle) => return Ok(handle),
                Err(e) => errors.push(format!("{} with {} GPU layers: {}", runtime.label, gpu_layers, e)),
            }
        }
    }

    Err(AppError::InferenceError(format!(
        "Could not start a local embedding server after automatic GPU/CPU fallback. Tried full GPU offload first, then reduced GPU layers, then CPU. Details:\n{}",
        errors.join("\n")
    )))
}

/// Launch one embedding-server attempt with a specific GPU-layer count.
async fn try_spawn_embedding_attempt(
    runtime: &Path,
    model_path: &str,
    context_size: u32,
    batch_size: u32,
    gpu_layers: i32,
) -> AppResult<EmbedServerHandle> {
    let port = find_free_localhost_port()?;
    let base_url = format!("http://127.0.0.1:{port}");

    // Pooling must match the model family. Qwen3-Embedding requires last-token
    // pooling; BGE/Nomic use mean pooling.
    let pooling = crate::knowledge_chat::embedding_profiles::pooling_for_model(model_path)
        .as_llama_arg();

    let mut command = Command::new(runtime);
    command
        .arg("-m")
        .arg(model_path)
        .arg("--embeddings")
        .arg("--pooling")
        .arg(pooling)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("-c")
        .arg(context_size.to_string())
        .arg("-b")
        .arg(batch_size.to_string())
        .arg("-ub")
        .arg(batch_size.to_string())
        .arg("--gpu-layers")
        .arg(gpu_layers.max(0).to_string());

    // Run from the runtime's own folder so its bundled DLLs load on Windows.
    if let Some(parent) = runtime.parent() {
        command.current_dir(parent);
    }

    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::InferenceError(format!("Could not start local embedding server: {e}")))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| AppError::NetworkError(e.to_string()))?;

    if let Err(e) = wait_for_embedding_server(&client, &base_url, &mut child).await {
        let detail = take_child_stderr_tail(&mut child).await;
        let _ = child.kill().await;
        return Err(match detail {
            Some(log) if !log.is_empty() => AppError::InferenceError(format!("{e}\n\nllama-server output:\n{log}")),
            _ => e,
        });
    }

    // Keep the server from blocking once its pipe buffers fill.
    drain_child_stdio(&mut child);

    Ok(EmbedServerHandle {
        base_url,
        batch_size,
        child,
        client,
    })
}

pub(crate) async fn shutdown_embedding_server(handle: &mut EmbedServerHandle) {
    let _ = handle.child.kill().await;
}

pub(crate) async fn embed_texts_on_server(
    handle: &EmbedServerHandle,
    texts: &[String],
    batch_size: u32,
) -> AppResult<Vec<Vec<f32>>> {
    let mut vectors = Vec::with_capacity(texts.len());
    for text in texts {
        let vector = embed_one_adaptive(&handle.client, &handle.base_url, text, batch_size).await?;
        vectors.push(vector);
    }
    Ok(vectors)
}

pub async fn embed_texts(
    pool: Option<&crate::knowledge_chat::runtime::KcEmbedPool>,
    request: KcEmbedTextsRequest,
) -> AppResult<KcEmbedTextsResult> {
    if let Some(pool) = pool {
        return pool.embed(request).await;
    }

    let model_path = validate_model_path(&request.model_path, None)?;
    if request.texts.is_empty() {
        return Err(AppError::Unknown("No texts provided for embedding.".to_string()));
    }
    if request.texts.len() > MAX_TEXTS_PER_RUN {
        return Err(AppError::Unknown(format!(
            "Embedding is limited to {MAX_TEXTS_PER_RUN} texts per run for local memory safety."
        )));
    }

    let ctx = request.context_size.unwrap_or(EMBED_CONTEXT_SIZE).clamp(512, 8192);
    let batch_size = request.batch_size.unwrap_or(EMBED_BATCH_SIZE).clamp(256, 4096);
    let mut handle = spawn_embedding_server(&model_path, ctx, batch_size).await?;
    let vectors = embed_texts_on_server(&handle, &request.texts, batch_size).await?;
    shutdown_embedding_server(&mut handle).await;

    let vector_dimension = vectors.first().map(|v| v.len()).unwrap_or(0);
    Ok(KcEmbedTextsResult {
        vectors,
        model_path,
        vector_dimension,
    })
}

pub async fn validate_embedding_model(model_path: &str) -> AppResult<KcEmbeddingValidation> {
    let clean = validate_model_path(model_path, None)?;
    let runtime = resolve_llama_server_runtime()?;
    let mut warnings = Vec::new();
    if runtime.to_string_lossy().to_lowercase().contains("cuda") {
        warnings.push("CUDA runtime detected. If embedding startup fails, try CPU runtime.".to_string());
    }
    Ok(KcEmbeddingValidation {
        ok: true,
        message: "Local embedding model and llama-server runtime are ready.".to_string(),
        model_path: clean,
        runtime_path: Some(normalize_path_string(&runtime.to_string_lossy())),
        warnings,
    })
}

/// Outcome of a partitioned dense build.
pub struct PartitionEmbedOutcome {
    pub stored: usize,
    pub warnings: Vec<String>,
    /// (partition_id, vector_dimension) for partitions that produced vectors.
    pub partition_dims: Vec<(String, u32)>,
    /// Partitions that have chunks AND a fully resolved dense index after this run.
    pub partitions_ready: Vec<String>,
    /// Partitions that have chunks but could not be embedded (e.g. missing model).
    pub partitions_missing_model: Vec<String>,
}

/// Embed all chunks missing a dense vector, grouped by partition, using each
/// partition's own model + embedding profile. Each partition writes into its
/// own vector space and HNSW index.
pub async fn embed_missing_dense_vectors_partitioned(
    db: Arc<Mutex<Database>>,
    pool: Arc<crate::knowledge_chat::runtime::KcEmbedPool>,
    collection_id: &str,
    partition_config: &KcPartitionConfig,
    remote: Option<&crate::knowledge_chat::remote_embeddings::RemoteEmbedConfig>,
    window: Option<&Window>,
) -> AppResult<PartitionEmbedOutcome> {
    let deploy = {
        let db = db.lock().await;
        load_deployment_config(&db)
    };

    let mut stored = 0usize;
    let mut warnings = Vec::new();
    let mut partition_dims = Vec::new();
    let mut partitions_ready = Vec::new();
    let mut partitions_missing_model = Vec::new();

    for partition in KcPartitionId::all() {
        let rows = {
            let db = db.lock().await;
            db::list_chunks_missing_dense_for_partition(&db, collection_id, partition)?
        };
        // Determine whether this partition has any chunks at all (for status).
        let (total_chunks, _dense_chunks) = {
            let db = db.lock().await;
            db::partition_chunk_counts(&db, collection_id, partition)?
        };
        if total_chunks == 0 {
            continue;
        }

        let model_config = partition_config.model_for(partition);
        let raw_model_path = model_config
            .map(|c| c.embedding_model_path.clone())
            .unwrap_or_default();
        let resolved = try_resolve_embedding_model_path(&raw_model_path, Some(&deploy.models_dir))
            .unwrap_or_default();
        if resolved.is_empty() {
            partitions_missing_model.push(partition.as_str().to_string());
            warnings.push(format!(
                "Semantic search is off for {} files: no embedding model (.gguf) was found. Use Browse beside the model field and select Nomic (code) or BGE-M3 (documents).",
                partition.label()
            ));
            continue;
        }
        if !path_guard::is_usable_embedding_model_path(&deploy, &resolved) {
            partitions_missing_model.push(partition.as_str().to_string());
            warnings.push(format!(
                "Semantic search is off for {} files: move the embedding model into your NexusAI models folder (Settings → Deployment), or use Browse to select a .gguf file there.",
                partition.label()
            ));
            continue;
        }

        let profile = model_config
            .map(|c| EmbeddingProfileId::from_value(&c.profile_id))
            .unwrap_or_else(|| embedding_profiles::resolve_profile_for_model(&resolved));
        let context_size = embedding_profiles::context_size_for(profile);

        if rows.is_empty() {
            // Already fully embedded.
            partitions_ready.push(partition.as_str().to_string());
            continue;
        }

        let mut partition_stored = 0usize;
        for (batch_idx, batch) in rows.chunks(MAX_TEXTS_PER_RUN).enumerate() {
            emit_dense_progress_phase(
                window,
                collection_id,
                partition,
                batch_idx * MAX_TEXTS_PER_RUN,
                rows.len(),
                &format!("Embedding {} chunks...", partition.as_str()),
            );
            let mut ids = Vec::with_capacity(batch.len());
            let mut texts = Vec::with_capacity(batch.len());
            for row in batch {
                let formatted = crate::knowledge_chat::dense_rerank::format_chunk_for_dense_index(
                    profile,
                    &row.file_name,
                    &row.title,
                    &row.section_path,
                    &row.parent_text,
                    &row.text,
                );
                if formatted.trim().is_empty() {
                    warnings.push(format!(
                        "Skipped empty dense vector for chunk {} ({})",
                        row.id, row.file_name
                    ));
                    continue;
                }
                ids.push(row.id.clone());
                texts.push(formatted);
            }
            if texts.is_empty() {
                continue;
            }
            let vectors = match crate::knowledge_chat::remote_embeddings::embed_partition_texts(
                remote,
                partition,
                pool.as_ref(),
                &resolved,
                context_size,
                EMBED_BATCH_SIZE,
                texts,
            )
            .await {
                Ok(vectors) => vectors,
                Err(err) => {
                    warnings.push(format!(
                        "Dense embedding batch failed for {} partition: {err}",
                        partition.as_str()
                    ));
                    continue;
                }
            };

            if let Some(dim) = vectors.first().map(|v| v.len() as u32) {
                if !partition_dims.iter().any(|(p, _)| p == partition.as_str()) {
                    partition_dims.push((partition.as_str().to_string(), dim));
                }
            }

            let updates: Vec<(String, Vec<f32>)> = ids
                .iter()
                .cloned()
                .zip(vectors.into_iter())
                .collect();
            let db = db.lock().await;
            partition_stored += db::apply_dense_vectors_for_partition(
                &db,
                collection_id,
                partition,
                profile.as_str(),
                &updates,
            )?;
        }
        stored += partition_stored;
        partitions_ready.push(partition.as_str().to_string());
    }

    Ok(PartitionEmbedOutcome {
        stored,
        warnings,
        partition_dims,
        partitions_ready,
        partitions_missing_model,
    })
}

/// Build a default partition configuration: Nomic for code, BGE-M3 for all
/// non-code partitions, honoring optional overrides and model discovery.
pub fn resolve_partition_config(
    folder_category: KcFolderCategory,
    models_dir: &str,
    code_override: Option<&str>,
    knowledge_override: Option<&str>,
) -> KcPartitionConfig {
    let discovered = discover_embedding_models(&[models_dir.to_string()]);

    let code_seed = code_override
        .map(|v| normalize_path_string(v.trim().trim_matches('"')))
        .filter(|v| !v.is_empty())
        .or_else(|| prefer_code_embedding_model(&discovered))
        .unwrap_or_default();
    let knowledge_seed = knowledge_override
        .map(|v| normalize_path_string(v.trim().trim_matches('"')))
        .filter(|v| !v.is_empty())
        .or_else(|| prefer_knowledge_embedding_model(&discovered))
        .unwrap_or_default();

    let code_model = soften_embedding_model_path(&code_seed, Some(models_dir));
    let knowledge_model = soften_embedding_model_path(&knowledge_seed, Some(models_dir));

    let code_profile = if code_model.is_empty() {
        EmbeddingProfileId::Qwen3
    } else {
        embedding_profiles::resolve_profile_for_model(&code_model)
    };
    let bge_profile = if knowledge_model.is_empty() {
        EmbeddingProfileId::BgeM3
    } else {
        embedding_profiles::resolve_profile_for_model(&knowledge_model)
    };

    let partitions = KcPartitionId::all()
        .into_iter()
        .map(|partition| {
            let (model, profile) = if partition == KcPartitionId::Code {
                (code_model.clone(), code_profile)
            } else {
                (knowledge_model.clone(), bge_profile)
            };
            KcPartitionModelConfig {
                partition_id: partition.as_str().to_string(),
                embedding_model_path: model,
                profile_id: profile.as_str().to_string(),
                vector_dimension: None,
            }
        })
        .collect();

    KcPartitionConfig {
        folder_category: folder_category.as_str().to_string(),
        partitions,
    }
}

/// Merge a stored partition config with defaults so legacy two-partition collections
/// gain all five partition entries (legacy `knowledge` seeds non-code partitions).
pub fn merge_partition_config(
    stored: KcPartitionConfig,
    folder_category: KcFolderCategory,
    models_dir: &str,
    code_override: Option<&str>,
    knowledge_override: Option<&str>,
) -> KcPartitionConfig {
    let defaults = resolve_partition_config(
        folder_category,
        models_dir,
        code_override,
        knowledge_override,
    );
    let legacy_knowledge = stored
        .partitions
        .iter()
        .find(|p| p.partition_id.eq_ignore_ascii_case("knowledge"))
        .cloned();

    let mut partitions = Vec::new();
    for partition in KcPartitionId::all() {
        if let Some(existing) = stored
            .partitions
            .iter()
            .find(|p| p.partition_id.eq_ignore_ascii_case(partition.as_str()))
        {
            partitions.push(existing.clone());
            continue;
        }
        if partition != KcPartitionId::Code {
            if let Some(ref legacy) = legacy_knowledge {
                partitions.push(KcPartitionModelConfig {
                    partition_id: partition.as_str().to_string(),
                    embedding_model_path: legacy.embedding_model_path.clone(),
                    profile_id: legacy.profile_id.clone(),
                    vector_dimension: legacy.vector_dimension,
                });
                continue;
            }
        }
        if let Some(default) = defaults.model_for(partition) {
            partitions.push(default.clone());
        }
    }

    KcPartitionConfig {
        folder_category: if stored.folder_category.is_empty() {
            folder_category.as_str().to_string()
        } else {
            stored.folder_category
        },
        partitions,
    }
}

/// Prefer Qwen3-Embedding for the code partition, then Nomic, then any embedder.
pub fn prefer_code_embedding_model(candidates: &[String]) -> Option<String> {
    candidates
        .iter()
        .find(|path| {
            let lower = path.to_lowercase();
            lower.contains("qwen3") && (lower.contains("embed") || lower.contains("embedding"))
        })
        .or_else(|| {
            candidates.iter().find(|path| {
                let lower = path.to_lowercase();
                lower.contains("nomic") && lower.contains("embed")
            })
        })
        .or_else(|| candidates.iter().find(|path| path.to_lowercase().contains("embed")))
        .cloned()
        .or_else(|| candidates.first().cloned())
}

/// Prefer a BGE-M3 model for the knowledge partition, then fall back gracefully.
pub fn prefer_knowledge_embedding_model(candidates: &[String]) -> Option<String> {
    candidates
        .iter()
        .find(|path| {
            let lower = path.to_lowercase();
            lower.contains("bge-m3") || lower.contains("bge_m3") || lower.contains("bgem3")
        })
        .or_else(|| candidates.iter().find(|path| path.to_lowercase().contains("bge")))
        .or_else(|| {
            candidates.iter().find(|path| {
                let lower = path.to_lowercase();
                lower.contains("nomic") && lower.contains("embed")
            })
        })
        .or_else(|| candidates.iter().find(|path| path.to_lowercase().contains("embed")))
        .cloned()
        .or_else(|| candidates.first().cloned())
}

fn emit_dense_progress_phase(
    window: Option<&Window>,
    collection_id: &str,
    partition: KcPartitionId,
    current: usize,
    total: usize,
    message: &str,
) {
    if let Some(window) = window {
        let payload = KcIndexProgress {
            collection_id: collection_id.to_string(),
            phase: format!("dense_{}", partition.as_str()),
            current,
            total,
            file_name: None,
            message: message.to_string(),
        };
        let _ = window.emit("kc-index-progress", payload);
    }
}

pub(crate) fn validate_model_path(
    model_path: &str,
    deploy: Option<&crate::deployment::DeploymentConfig>,
) -> AppResult<String> {
    let clean = normalize_path_string(model_path.trim().trim_matches('"'));
    if clean.is_empty() {
        return Err(AppError::Unknown("Embedding model path is required.".to_string()));
    }
    if let Some(config) = deploy {
        crate::knowledge_chat::path_guard::ensure_allowed_path(config, &clean, "Embedding model")?;
    }
    let path = PathBuf::from(&clean);
    crate::gguf::validate_gguf_file(&path).map_err(AppError::Unknown)?;
    Ok(clean)
}

/// Resolve a user-entered embedding path to a concrete `.gguf` file when possible.
pub fn try_resolve_embedding_model_path(
    model_path: &str,
    models_dir_hint: Option<&str>,
) -> AppResult<String> {
    let clean = normalize_path_string(model_path.trim().trim_matches('"'));
    if clean.is_empty() {
        let discovered = discover_embedding_models(&discovery_search_roots(None, models_dir_hint));
        if let Some(found) = prefer_embedding_model(&discovered) {
            return Ok(found);
        }
        return Ok(String::new());
    }
    let path = PathBuf::from(&clean);
    if path.is_file() && is_gguf_file(&path) {
        return Ok(clean);
    }
    if path.is_dir() {
        if let Ok(found) = find_gguf_in_dir(&path, 4) {
            return Ok(found);
        }
    }
    if !clean.to_lowercase().ends_with(".gguf") {
        let with_ext = format!("{clean}.gguf");
        if PathBuf::from(&with_ext).is_file() {
            return Ok(with_ext);
        }
    }
    if let Some(parent) = path.parent() {
        if parent.is_dir() {
            if let Ok(found) = find_gguf_in_dir(parent, 4) {
                return Ok(found);
            }
        }
    }
    if let Some(found) = prefer_embedding_model(&discover_embedding_models(&discovery_search_roots(
        Some(&clean),
        models_dir_hint,
    ))) {
        return Ok(found);
    }
    Err(AppError::Unknown(format!(
        "No .gguf embedding model found near \"{clean}\". Click Browse beside the embedding field and select a model file (e.g. nomic-embed-text-v1.5.Q4_K_M.gguf), or place one under your NexusAI models folder."
    )))
}

pub fn discover_embedding_models(search_roots: &[String]) -> Vec<String> {
    let mut matches = Vec::new();
    for root in search_roots {
        let path = PathBuf::from(root.trim());
        if path.is_file() && is_gguf_file(&path) {
            matches.push(normalize_path_string(&path.to_string_lossy()));
            continue;
        }
        if path.is_dir() {
            collect_gguf_files(&path, 5, &mut matches);
        }
    }
    matches.sort();
    matches.dedup();
    matches
}

pub fn prefer_embedding_model(candidates: &[String]) -> Option<String> {
    candidates
        .iter()
        .find(|path| {
            let lower = path.to_lowercase();
            lower.contains("nomic") && lower.contains("embed")
        })
        .or_else(|| {
            candidates
                .iter()
                .find(|path| path.to_lowercase().contains("embed"))
        })
        .cloned()
        .or_else(|| candidates.first().cloned())
}

fn discovery_search_roots(seed: Option<&str>, models_dir_hint: Option<&str>) -> Vec<String> {
    let mut roots = Vec::new();
    if let Some(dir) = models_dir_hint {
        if !dir.trim().is_empty() {
            roots.push(normalize_path_string(dir.trim()));
        }
    }
    if let Some(seed_path) = seed {
        let path = PathBuf::from(seed_path);
        roots.push(seed_path.to_string());
        if let Some(parent) = path.parent() {
            roots.push(normalize_path_string(&parent.to_string_lossy()));
        }
    }
    let default_models = crate::deployment::default_config().models_dir;
    if !default_models.trim().is_empty() {
        roots.push(default_models);
    }
    roots.sort();
    roots.dedup();
    roots
}

pub fn soften_embedding_model_path(model_path: &str, models_dir_hint: Option<&str>) -> String {
    match try_resolve_embedding_model_path(model_path, models_dir_hint) {
        Ok(resolved) if !resolved.is_empty() => resolved,
        Ok(_) => String::new(),
        Err(_) => normalize_path_string(model_path.trim().trim_matches('"')),
    }
}

fn is_gguf_file(path: &Path) -> bool {
    crate::gguf::is_valid_gguf_file(path)
}

fn collect_gguf_files(dir: &Path, max_depth: usize, out: &mut Vec<String>) {
    if max_depth == 0 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(value) => value,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && is_gguf_file(&path) {
            out.push(normalize_path_string(&path.to_string_lossy()));
        } else if path.is_dir() {
            collect_gguf_files(&path, max_depth - 1, out);
        }
    }
}

fn find_gguf_in_dir(dir: &Path, max_depth: usize) -> AppResult<String> {
    let mut matches = Vec::new();
    collect_gguf_files(dir, max_depth, &mut matches);
    matches.sort();
    prefer_embedding_model(&matches).ok_or_else(|| {
        AppError::Unknown(format!(
            "No .gguf embedding model found in folder: {}",
            dir.display()
        ))
    })
}

fn find_free_localhost_port() -> AppResult<u16> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .map_err(|e| AppError::InferenceError(format!("Could not allocate embedding port: {e}")))
}

pub fn llama_server_available() -> bool {
    resolve_llama_server_runtime()
        .map(|path| path.is_file())
        .unwrap_or(false)
}

/// Resolve any available llama-server binary for validation/availability checks.
/// The actual spawn path ([`spawn_embedding_server`]) re-resolves with the
/// device policy so it can fall back across runtimes.
fn resolve_llama_server_runtime() -> AppResult<PathBuf> {
    runtime_discovery::resolve_llama_server_binary(runtime_discovery::embed_gpu_layers())
}

async fn wait_for_embedding_server(
    client: &reqwest::Client,
    base_url: &str,
    child: &mut tokio::process::Child,
) -> AppResult<()> {
    let deadline = Instant::now() + Duration::from_secs(120);
    let health_url = format!("{base_url}/health");
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(AppError::InferenceError(format!(
                "Embedding server exited before ready. Exit status: {status}"
            )));
        }
        if client.get(&health_url).send().await.map(|r| r.status().is_success()).unwrap_or(false) {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(AppError::InferenceError(
                "Embedding server did not become ready within 120 seconds.".to_string(),
            ));
        }
        sleep(Duration::from_millis(450)).await;
    }
}

/// Capture a short tail of llama-server stderr/stdout after a failed spawn so
/// the UI can show the real reason (invalid GGUF, OOM, etc.).
async fn take_child_stderr_tail(child: &mut tokio::process::Child) -> Option<String> {
    use tokio::io::AsyncReadExt;
    let mut combined = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        combined.push_str(&String::from_utf8_lossy(&buf));
    }
    if let Some(mut stdout) = child.stdout.take() {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf).await;
        if !buf.is_empty() {
            if !combined.is_empty() {
                combined.push('\n');
            }
            combined.push_str(&String::from_utf8_lossy(&buf));
        }
    }
    let trimmed = combined.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lines: Vec<&str> = trimmed.lines().collect();
    let start = lines.len().saturating_sub(24);
    Some(lines[start..].join("\n"))
}

fn drain_child_stdio(child: &mut tokio::process::Child) {
    use tokio::io::AsyncReadExt;
    if let Some(mut stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            loop {
                match stderr.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        });
    }
    if let Some(mut stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            loop {
                match stdout.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        });
    }
}

fn max_embedding_chars(batch_size: u32) -> usize {
    ((batch_size.saturating_sub(64) as usize) * 3 / 2).clamp(256, 960)
}

async fn embed_one_adaptive(
    client: &reqwest::Client,
    base_url: &str,
    text: &str,
    batch_size: u32,
) -> AppResult<Vec<f32>> {
    let mut char_limit = max_embedding_chars(batch_size);
    let mut last_error = String::from("no embedding attempts were made");
    for _ in 0..4 {
        let input = text.replace('\0', " ").chars().take(char_limit).collect::<String>().trim().to_string();
        if input.is_empty() {
            return Err(AppError::InferenceError("Cannot embed empty text.".to_string()));
        }
        match embed_batch_openai(client, base_url, std::slice::from_ref(&input)).await {
            Ok(rows) if rows.len() == 1 => return Ok(rows.into_iter().next().unwrap_or_default()),
            Ok(_) => last_error = "Unexpected vector count from /v1/embeddings.".to_string(),
            Err(openai_err) => {
                match embed_batch_native(client, base_url, std::slice::from_ref(&input)).await {
                    Ok(rows) if rows.len() == 1 => return Ok(rows.into_iter().next().unwrap_or_default()),
                    Ok(_) => last_error = format!("{openai_err}; unexpected vector count from /embeddings."),
                    Err(native_err) => last_error = format!("{openai_err}; {native_err}"),
                }
            }
        }
        if last_error.to_ascii_lowercase().contains("too large") && char_limit > 128 {
            char_limit = (char_limit / 2).max(128);
            continue;
        }
        break;
    }
    Err(AppError::InferenceError(format!(
        "Could not embed text within batch limits. Last error: {last_error}"
    )))
}

async fn embed_batch_openai(client: &reqwest::Client, base_url: &str, inputs: &[String]) -> AppResult<Vec<Vec<f32>>> {
    let url = format!("{base_url}/v1/embeddings");
    let payload = serde_json::json!({ "model": "local-gguf-embedding", "input": inputs });
    let resp = client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| AppError::NetworkError(format!("Could not call /v1/embeddings: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::InferenceError(format!("/v1/embeddings rejected ({status}): {text}")));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| AppError::NetworkError(e.to_string()))?;
    parse_openai_embedding_response(json)
}

async fn embed_batch_native(client: &reqwest::Client, base_url: &str, inputs: &[String]) -> AppResult<Vec<Vec<f32>>> {
    let url = format!("{base_url}/embeddings");
    let payload = serde_json::json!({ "input": inputs });
    let resp = client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| AppError::NetworkError(format!("Could not call /embeddings: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::InferenceError(format!("/embeddings rejected ({status}): {text}")));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| AppError::NetworkError(e.to_string()))?;
    parse_native_embeddings_response(json, inputs.len())
}

fn parse_openai_embedding_response(value: serde_json::Value) -> AppResult<Vec<Vec<f32>>> {
    let data = value
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| AppError::InferenceError("Embedding response missing data array.".to_string()))?;
    data.iter()
        .map(|item| {
            let embedding_val = item.get("embedding").ok_or_else(|| {
                AppError::InferenceError("Embedding item missing embedding field.".to_string())
            })?;
            extract_embedding_from_value(embedding_val)
        })
        .collect()
}

fn parse_native_embeddings_response(value: serde_json::Value, expected: usize) -> AppResult<Vec<Vec<f32>>> {
    let items = value
        .as_array()
        .ok_or_else(|| AppError::InferenceError("Native embeddings response was not an array.".to_string()))?;
    if items.len() != expected {
        return Err(AppError::InferenceError(format!(
            "Native embeddings returned {} items, expected {expected}.",
            items.len()
        )));
    }
    items
        .iter()
        .map(|item| {
            if let Some(embedding_val) = item.get("embedding") {
                extract_embedding_from_value(embedding_val)
            } else {
                extract_embedding_from_value(item)
            }
        })
        .collect()
}

fn extract_embedding_from_value(value: &serde_json::Value) -> AppResult<Vec<f32>> {
    let Some(arr) = value.as_array() else {
        return Err(AppError::InferenceError("Embedding value was not an array.".to_string()));
    };
    if arr.is_empty() {
        return Err(AppError::InferenceError("Embedding array was empty.".to_string()));
    }
    if arr.first().and_then(|v| v.as_f64()).is_some() || arr.first().and_then(|v| v.as_i64()).is_some() {
        let vector: Vec<f32> = arr.iter().map(|v| v.as_f64().unwrap_or(0.0) as f32).collect();
        return Ok(normalize_dense_vector(vector));
    }
    if arr.first().and_then(|v| v.as_array()).is_some() {
        let mut sum: Option<Vec<f32>> = None;
        let mut count = 0usize;
        for token_vec in arr {
            let Some(inner) = token_vec.as_array() else { continue; };
            let v: Vec<f32> = inner.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect();
            if sum.is_none() {
                sum = Some(vec![0.0; v.len()]);
            }
            let acc = sum.as_mut().unwrap();
            for (idx, value) in v.iter().enumerate() {
                acc[idx] += value;
            }
            count += 1;
        }
        let mut acc = sum.ok_or_else(|| AppError::InferenceError("Could not parse token vectors.".to_string()))?;
        if count > 0 {
            for value in acc.iter_mut() {
                *value /= count as f32;
            }
        }
        return Ok(normalize_dense_vector(acc));
    }
    Err(AppError::InferenceError("Unsupported embedding shape.".to_string()))
}

fn normalize_dense_vector(values: Vec<f32>) -> Vec<f32> {
    let mag = values.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>().sqrt();
    if mag <= 0.0 {
        return values;
    }
    values.into_iter().map(|v| (v as f64 / mag) as f32).collect()
}
