use tauri::State;
use std::sync::Arc;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use std::process::Command as StdCommand;
use tokio::sync::Mutex;
use tokio::sync::mpsc;
use tokio::io::AsyncWriteExt;
use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, RANGE, USER_AGENT};
use serde::{Serialize, Deserialize};
use std::collections::BTreeMap;
use crate::deployment::{self, DeploymentConfig};
use crate::audit::{self, AuditLogEntry, AuditLogQuery};
use crate::product::{self, ProductConfig};

use crate::database::Database;
use crate::hardware::{HardwareMonitor, SystemInfo, ModelRecommendation};
use crate::crypto::CryptoVault;
use crate::error::{AppError, AppResult};
use crate::file_context::AttachmentContext;
use crate::knowledge_chat::embeddings::{self, EMBED_BATCH_SIZE, EMBED_CONTEXT_SIZE, MAX_TEXTS_PER_RUN};
use crate::knowledge_chat::types::KcEmbedTextsRequest;
use crate::llm::{GenerationRequest, GenerationChunk, InferenceBackend};
use serde_json::Value;

pub struct AppState {
    pub db: Arc<Mutex<Database>>,
    pub hardware: Arc<Mutex<HardwareMonitor>>,
    pub crypto: Arc<CryptoVault>,
    pub local_backend: Arc<crate::llm::local::LlamaCppBackend>,
    pub kc_embed_pool: Arc<crate::knowledge_chat::runtime::KcEmbedPool>,
    pub kc_rerank_pool: Arc<crate::knowledge_chat::llama_rerank::KcRerankPool>,
}

async fn record_audit(
    state: &State<'_, AppState>,
    event_type: &str,
    category: &str,
    summary: &str,
    detail: Option<String>,
    resource_path: Option<String>,
    success: bool,
) {
    let db = state.db.lock().await;
    let config = product::load_product_config(&db);
    if config.audit_log_enabled {
        let _ = audit::log_event(
            &db,
            event_type,
            category,
            summary,
            detail.as_deref(),
            resource_path.as_deref(),
            success,
        );
    }
}


const ENTERPRISE_PROVIDER: &str = "enterprise";
const KEY_ENTERPRISE_BASE_URL: &str = "enterprise.base_url";
const KEY_ENTERPRISE_SELECTED_MODEL: &str = "enterprise.selected_model";
const KEY_ENTERPRISE_EMBEDDINGS_ENABLED: &str = "enterprise.embeddings_enabled";
const KEY_ENTERPRISE_CODE_EMBED_MODEL: &str = "enterprise.code_embedding_model";
const KEY_ENTERPRISE_KNOWLEDGE_EMBED_MODEL: &str = "enterprise.knowledge_embedding_model";
const KEY_ENTERPRISE_EMBED_BASE_URL: &str = "enterprise.embeddings_base_url";
const KEY_ENTERPRISE_SERVER_RAG: &str = "enterprise.server_rag_enabled";

fn parse_remote_model(value: Option<&String>) -> AppResult<(String, String)> {
    let raw = value.map(|v| v.as_str()).unwrap_or("").trim();
    let clean = raw.strip_prefix("remote:").unwrap_or(raw);
    let (provider, model_id) = clean.split_once('/').ok_or_else(|| {
        AppError::InferenceError("Invalid online model id. Expected remote:provider/model-id.".to_string())
    })?;
    if provider.trim().is_empty() || model_id.trim().is_empty() {
        return Err(AppError::InferenceError("Invalid online model id. Provider and model must both be present.".to_string()));
    }
    Ok((provider.trim().to_string(), model_id.trim().to_string()))
}

fn parse_enterprise_model(value: Option<&String>) -> AppResult<String> {
    let raw = value.map(|v| v.as_str()).unwrap_or("").trim();
    let clean = raw.strip_prefix("enterprise:").unwrap_or(raw);
    if clean.trim().is_empty() {
        return Err(AppError::InferenceError(
            "Invalid organization server model id. Expected enterprise:model-id.".to_string(),
        ));
    }
    Ok(clean.trim().to_string())
}

fn normalize_enterprise_base_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.ends_with("/v1") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1")
    }
}

async fn resolve_enterprise_api_key(
    state: &State<'_, AppState>,
    override_key: Option<String>,
) -> AppResult<String> {
    if let Some(key) = override_key {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let db = state.db.lock().await;
    let encrypted = db
        .get_api_key(ENTERPRISE_PROVIDER)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    drop(db);
    match encrypted {
        Some(enc) => state.crypto.decrypt(&enc),
        None => Ok(String::new()),
    }
}

/// Resolve the organization-server embedding configuration when the user has
/// opted in and configured at least one embed model. Returns `None` to keep
/// Knowledge Chat on local embeddings (the default, accuracy-preserving path).
pub async fn resolve_remote_embed_config(
    state: &State<'_, AppState>,
) -> Option<crate::knowledge_chat::remote_embeddings::RemoteEmbedConfig> {
    let (enabled, chat_base, embed_base, code_model, knowledge_model) = {
        let db = state.db.lock().await;
        let enabled = db
            .get_setting(KEY_ENTERPRISE_EMBEDDINGS_ENABLED)
            .ok()
            .flatten()
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let chat_base = db.get_setting(KEY_ENTERPRISE_BASE_URL).ok().flatten().unwrap_or_default();
        let embed_base = db.get_setting(KEY_ENTERPRISE_EMBED_BASE_URL).ok().flatten().unwrap_or_default();
        let code_model = db.get_setting(KEY_ENTERPRISE_CODE_EMBED_MODEL).ok().flatten().unwrap_or_default();
        let knowledge_model = db
            .get_setting(KEY_ENTERPRISE_KNOWLEDGE_EMBED_MODEL)
            .ok()
            .flatten()
            .unwrap_or_default();
        (enabled, chat_base, embed_base, code_model, knowledge_model)
    };
    if !enabled {
        return None;
    }
    let base_url = if embed_base.trim().is_empty() { chat_base } else { embed_base };
    let base_url = normalize_enterprise_base_url(&base_url);
    if base_url.is_empty() {
        return None;
    }
    let api_key = resolve_enterprise_api_key(state, None).await.unwrap_or_default();
    let config = crate::knowledge_chat::remote_embeddings::RemoteEmbedConfig {
        base_url,
        api_key,
        code_model,
        knowledge_model,
    };
    if !config.has_any_model() {
        return None;
    }
    Some(config)
}

async fn resolve_enterprise_backend(
    state: &State<'_, AppState>,
    model_path: Option<&String>,
) -> AppResult<crate::llm::remote::RemoteBackend> {
    let model_id = if let Some(path) = model_path {
        if path.starts_with("enterprise:") {
            parse_enterprise_model(Some(path))?
        } else if !path.trim().is_empty() {
            path.trim().to_string()
        } else {
            String::new()
        }
    } else {
        String::new()
    };
    let db = state.db.lock().await;
    let base_url = db
        .get_setting(KEY_ENTERPRISE_BASE_URL)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .unwrap_or_default();
    let selected = db
        .get_setting(KEY_ENTERPRISE_SELECTED_MODEL)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .unwrap_or_default();
    drop(db);
    let model_id = if model_id.is_empty() { selected } else { model_id };
    if base_url.trim().is_empty() {
        return Err(AppError::InferenceError(
            "Organization server URL is not configured. Open Organization Server in the sidebar.".to_string(),
        ));
    }
    if model_id.trim().is_empty() {
        return Err(AppError::InferenceError(
            "No organization server model selected.".to_string(),
        ));
    }
    let base_url = normalize_enterprise_base_url(&base_url);
    let key = resolve_enterprise_api_key(state, None).await?;
    Ok(crate::llm::remote::RemoteBackend::new_custom(
        ENTERPRISE_PROVIDER,
        &base_url,
        &key,
        model_id.trim(),
    ))
}

async fn fetch_enterprise_models(base_url: &str, api_key: &str) -> AppResult<Vec<EnterpriseModelInfo>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| AppError::NetworkError(e.to_string()))?;
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let mut req = client.get(&url);
    if !api_key.trim().is_empty() {
        req = req.header("Authorization", format!("Bearer {}", api_key.trim()));
    }
    let response = req
        .send()
        .await
        .map_err(|e| AppError::NetworkError(e.to_string()))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(AppError::InferenceError(format!(
            "Organization server returned HTTP {status}: {text}"
        )));
    }
    let json: Value = response
        .json()
        .await
        .map_err(|e| AppError::NetworkError(e.to_string()))?;
    let data = json
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| AppError::InferenceError("Organization server /models response missing data array.".to_string()))?;
    let mut models = Vec::new();
        for item in data {
        let id = item
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if id.is_empty() {
            continue;
        }
                models.push(EnterpriseModelInfo {
            id,
            owned_by: item
                .get("owned_by")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        });
    }
    Ok(models)
}



#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticCheck {
    pub id: String,
    pub label: String,
    pub status: String,
    pub message: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeDiagnostics {
    pub app_version: String,
    pub current_dir: String,
    pub executable_dir: String,
    pub llama_server_path: Option<String>,
    pub llama_server_found: bool,
    pub llama_server_help_ok: bool,
    pub llama_server_error: Option<String>,
    pub models_dir_exists: bool,
    pub selected_model_path: Option<String>,
    pub selected_model_exists: bool,
    pub selected_model_size_bytes: Option<u64>,
    pub free_disk_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    pub memory_available_bytes: Option<u64>,
    pub cpu_brand: Option<String>,
    pub gpu_summary: Vec<String>,
    pub checks: Vec<DiagnosticCheck>,
}

fn diag_check(id: &str, label: &str, status: &str, message: &str, detail: Option<String>) -> DiagnosticCheck {
    DiagnosticCheck { id: id.to_string(), label: label.to_string(), status: status.to_string(), message: message.to_string(), detail }
}

fn runtime_mode_from_path(path: &Path) -> &'static str {
    let lower = path.display().to_string().to_lowercase();
    if lower.contains("\\cuda\\") || lower.contains("/cuda/") || lower.contains("llama-server-cuda") { "cuda" }
    else if lower.contains("\\vulkan\\") || lower.contains("/vulkan/") || lower.contains("llama-server-vulkan") { "vulkan" }
    else if lower.contains("\\metal\\") || lower.contains("/metal/") || lower.contains("-metal/") || lower.contains("-metal\\") || lower.contains("llama-server-metal") { "metal" }
    else if lower.contains("\\cpu\\") || lower.contains("/cpu/") || lower.contains("-cpu/") || lower.contains("-cpu\\") || lower.contains("llama-server-cpu") { "cpu" }
    else { "auto" }
}

fn runtime_arch_from_path(path: &Path) -> &'static str {
    let lower = path.display().to_string().to_lowercase();
    if lower.contains("macos-arm64") { "macOS arm64" }
    else if lower.contains("macos-x64") { "macOS x64" }
    else if lower.contains("macos-") { "macOS generic" }
    else { "generic" }
}

// Runtime discovery and NVIDIA-aware ordering are shared with chat inference and
// Knowledge Chat embeddings via `crate::llm::runtime_discovery` so device
// selection stays consistent everywhere.
fn all_llama_runtime_candidates_for_diagnostics() -> Vec<PathBuf> {
    crate::llm::runtime_discovery::all_runtime_candidates(-1)
        .into_iter()
        .map(|c| c.path)
        .collect()
}

fn resolve_llama_server_binary_for_diagnostics() -> Result<PathBuf, String> {
    crate::llm::runtime_discovery::resolve_llama_server_binary(-1).map_err(|e| e.to_string())
}

// Hardware
#[tauri::command]
pub async fn get_system_info(state: State<'_, AppState>) -> AppResult<SystemInfo> {
    let mut hw = state.hardware.lock().await;
    Ok(hw.get_system_info())
}

#[tauri::command]
pub async fn get_model_recommendations(state: State<'_, AppState>) -> AppResult<Vec<ModelRecommendation>> {
    let mut hw = state.hardware.lock().await;
    let info = hw.get_system_info();
    Ok(hw.recommend_models(&info))
}

// Conversations
#[tauri::command]
pub async fn create_conversation(
    state: State<'_, AppState>,
    title: String,
    character_id: Option<String>,
    model_id: Option<String>,
    mode: String,
) -> AppResult<String> {
    let db = state.db.lock().await;
    db.create_conversation(&title, character_id.as_deref(), model_id.as_deref(), &mode)
        .map_err(|e| e.into())
}

#[tauri::command]
pub async fn get_conversations(state: State<'_, AppState>) -> AppResult<Vec<crate::database::Conversation>> {
    let db = state.db.lock().await;
    db.get_conversations().map_err(|e| e.into())
}


#[tauri::command]
pub async fn update_conversation_title(state: State<'_, AppState>, id: String, title: String) -> AppResult<()> {
    let clean = title.trim();
    if clean.is_empty() {
        return Err(AppError::InferenceError("Chat title cannot be empty.".to_string()));
    }
    let db = state.db.lock().await;
    db.update_conversation_title(&id, clean).map_err(|e| e.into())
}

#[tauri::command]
pub async fn delete_conversation(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let db = state.db.lock().await;
    db.delete_conversation(&id).map_err(|e| e.into())
}

// Messages
#[tauri::command]
pub async fn add_message(
    state: State<'_, AppState>,
    conversation_id: String,
    role: String,
    content: String,
    metadata: Option<String>,
) -> AppResult<String> {
    let db = state.db.lock().await;
    db.add_message(&conversation_id, &role, &content, metadata.as_deref())
        .map_err(|e| e.into())
}

#[tauri::command]
pub async fn update_message(
    state: State<'_, AppState>,
    id: String,
    content: String,
    metadata: Option<String>,
) -> AppResult<()> {
    let db = state.db.lock().await;
    db.update_message(&id, &content, metadata.as_deref()).map_err(|e| e.into())
}

#[tauri::command]
pub async fn get_messages(
    state: State<'_, AppState>,
    conversation_id: String,
) -> AppResult<Vec<crate::database::Message>> {
    let db = state.db.lock().await;
    db.get_messages(&conversation_id).map_err(|e| e.into())
}

// Stable non-streaming generation used by the desktop UI. It returns exactly one final
// assistant message, which prevents duplicate SSE/listener bugs.
#[tauri::command]
pub async fn generate_response(
    state: State<'_, AppState>,
    request: GenerationRequest,
) -> AppResult<GenerationChunk> {
    let (tx, mut rx) = mpsc::channel::<GenerationChunk>(10000);

    if request.backend == "enterprise"
        || request
            .model_path
            .as_ref()
            .map(|p| p.starts_with("enterprise:"))
            .unwrap_or(false)
    {
        let backend = resolve_enterprise_backend(&state, request.model_path.as_ref()).await?;
        backend.generate_stream(request, tx).await?;
    } else if request.backend == "remote" {
        let (provider, model_id) = parse_remote_model(request.model_path.as_ref())?;
        let db = state.db.lock().await;
        let encrypted = db.get_api_key(&provider)
            .map_err(|e| AppError::DatabaseError(e.to_string()))?;
        let key = encrypted.map(|enc| state.crypto.decrypt(&enc)).transpose()?.unwrap_or_default();
        if key.trim().is_empty() {
            return Err(AppError::InferenceError(format!("No API key saved for {provider}. Open Models → Online and save your provider key first.")));
        }
        drop(db);
        let backend = crate::llm::remote::RemoteBackend::new(&provider, &key, &model_id);
        backend.generate_stream(request, tx).await?;
    } else {
        let model_path = request.model_path.clone()
            .ok_or_else(|| AppError::InferenceError("No local model selected. Go to Models, import/scan a .gguf file, then click Use.".to_string()))?;
        state.local_backend.load_model(&model_path, &request.params).await?;
        state.local_backend.generate_stream(request, tx).await?;
    }

    let mut text = String::new();
    let mut finish_reason = None;
    let mut tokens_generated = 0;
    let mut tokens_per_sec = 0.0;
    while let Some(chunk) = rx.recv().await {
        text.push_str(&chunk.text);
        if chunk.finish_reason.is_some() { finish_reason = chunk.finish_reason; }
        tokens_generated += chunk.tokens_generated;
        if chunk.tokens_per_sec > 0.0 { tokens_per_sec = chunk.tokens_per_sec; }
    }

    Ok(GenerationChunk {
        text: if text.trim().is_empty() { "[The model returned an empty response.]".to_string() } else { text.trim().to_string() },
        finish_reason,
        tokens_generated,
        tokens_per_sec,
    })
}

// Streaming Generation
#[tauri::command]
pub async fn stream_generate(
    state: State<'_, AppState>,
    request: GenerationRequest,
    window: tauri::Window,
) -> AppResult<()> {
    let (tx, mut rx) = mpsc::channel::<GenerationChunk>(100);

    if request.backend == "enterprise"
        || request
            .model_path
            .as_ref()
            .map(|p| p.starts_with("enterprise:"))
            .unwrap_or(false)
    {
        let backend = Arc::new(resolve_enterprise_backend(&state, request.model_path.as_ref()).await?);

        tokio::spawn(async move {
            let tx_for_error = tx.clone();
            let result = backend.generate_stream(request, tx).await;
            if let Err(e) = result {
                let _ = tx_for_error.send(GenerationChunk {
                    text: format!("\n\n**Generation error:** {e}"),
                    finish_reason: Some("error".to_string()),
                    tokens_generated: 0,
                    tokens_per_sec: 0.0,
                }).await;
            }
        });
    } else if request.backend == "remote" {
        let (provider, model_id) = parse_remote_model(request.model_path.as_ref())?;

        let db = state.db.lock().await;
        let encrypted = db.get_api_key(&provider)
            .map_err(|e| AppError::DatabaseError(e.to_string()))?;
        let key = encrypted.map(|enc| state.crypto.decrypt(&enc)).transpose()?.unwrap_or_default();
        if key.trim().is_empty() {
            return Err(AppError::InferenceError(format!("No API key saved for {provider}. Open Models → Online and save your provider key first.")));
        }
        let backend = Arc::new(crate::llm::remote::RemoteBackend::new(&provider, &key, &model_id));

        tokio::spawn(async move {
            let tx_for_error = tx.clone();
            let result = backend.generate_stream(request, tx).await;
            if let Err(e) = result {
                let _ = tx_for_error.send(GenerationChunk {
                    text: format!("\n\n**Generation error:** {e}"),
                    finish_reason: Some("error".to_string()),
                    tokens_generated: 0,
                    tokens_per_sec: 0.0,
                }).await;
            }
        });
    } else {
        let model_path = request.model_path.clone()
            .ok_or_else(|| AppError::InferenceError("No local model selected. Go to Models, import/scan a .gguf file, then click Use.".to_string()))?;
        let backend = state.local_backend.clone();

        let model_label = std::path::Path::new(&model_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&model_path)
            .to_string();
        let _ = window.emit("generation-status", serde_json::json!({
            "stage": "loading_model",
            "message": format!("Loading local model: {}. First load can take a while.", model_label),
            "model": model_label,
            "elapsed_secs": 0
        }));

        // Load is idempotent: if this model is already loaded, it returns quickly.
        if let Err(e) = backend.load_model(&model_path, &request.params).await {
            let msg = format!("Failed to load local model: {e}");
            let _ = window.emit("generation-error", &msg);
            return Err(e);
        }

        let _ = window.emit("generation-status", serde_json::json!({
            "stage": "generating",
            "message": "Model ready. Generating response...",
            "model": model_label,
            "elapsed_secs": 0
        }));

        tokio::spawn(async move {
            let tx_for_error = tx.clone();
            let result = backend.generate_stream(request, tx).await;
            if let Err(e) = result {
                let _ = tx_for_error.send(GenerationChunk {
                    text: format!("\n\n**Generation error:** {e}"),
                    finish_reason: Some("error".to_string()),
                    tokens_generated: 0,
                    tokens_per_sec: 0.0,
                }).await;
            }
        });
    }

    while let Some(chunk) = rx.recv().await {
        window.emit("generation-chunk", &chunk)
            .map_err(|e| AppError::Unknown(e.to_string()))?;
    }

    window.emit("generation-done", ())
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    Ok(())
}


#[tauri::command]
pub async fn stop_generation(state: State<'_, AppState>) -> AppResult<()> {
    state.local_backend.unload_model().await
}

// Characters
#[tauri::command]
pub async fn create_character(
    state: State<'_, AppState>,
    name: String,
    description: String,
    system_prompt: String,
    avatar_path: Option<String>,
    traits: String,
    folder_id: Option<String>,
) -> AppResult<String> {
    let db = state.db.lock().await;
    db.create_character(&name, &description, &system_prompt, avatar_path.as_deref(), &traits, folder_id.as_deref())
        .map_err(|e| e.into())
}

#[tauri::command]
pub async fn get_characters(state: State<'_, AppState>) -> AppResult<Vec<crate::database::Character>> {
    let db = state.db.lock().await;
    db.get_characters().map_err(|e| e.into())
}

#[tauri::command]
pub async fn update_character(
    state: State<'_, AppState>,
    id: String,
    updates: crate::database::Character,
) -> AppResult<()> {
    let db = state.db.lock().await;
    db.update_character(&id, &updates).map_err(|e| e.into())
}

#[tauri::command]
pub async fn delete_character(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let db = state.db.lock().await;
    db.delete_character(&id).map_err(|e| e.into())
}

// API Keys
#[tauri::command]
pub async fn store_api_key(state: State<'_, AppState>, provider: String, key: String) -> AppResult<()> {
    let encrypted = state.crypto.encrypt(&key)?;
    let db = state.db.lock().await;
    db.store_api_key(&provider, &encrypted).map_err(|e| e.into())
}

#[tauri::command]
pub async fn remove_api_key(state: State<'_, AppState>, provider: String) -> AppResult<()> {
    let db = state.db.lock().await;
    db.delete_api_key(&provider).map_err(|e| e.into())
}

#[tauri::command]
pub async fn get_api_key_providers(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let db = state.db.lock().await;
    let keys = db.get_all_api_keys()?;
    Ok(keys.into_iter().map(|k| k.provider).collect())
}

// Models
#[tauri::command]
pub async fn get_local_models(state: State<'_, AppState>) -> AppResult<Vec<crate::database::LocalModelRecord>> {
    let db = state.db.lock().await;
    db.get_models().map_err(|e| e.into())
}

#[tauri::command]
pub async fn delete_local_model(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let db = state.db.lock().await;
    db.delete_model(&id).map_err(|e| e.into())
}


#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub id: String,
    pub file_name: String,
    pub status: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub speed_bytes_per_sec: f64,
    pub retries: u32,
    pub message: String,
    pub elapsed_secs: u64,
}

fn sanitize_file_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    if !out.to_lowercase().ends_with(".gguf") {
        out.push_str(".gguf");
    }
    out
}

fn file_name_from_url(url: &str, fallback: Option<&str>) -> String {
    if let Some(name) = fallback {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return sanitize_file_name(trimmed);
        }
    }
    let clean = url.split('?').next().unwrap_or(url);
    let last = clean.rsplit('/').next().unwrap_or("model.gguf");
    sanitize_file_name(last)
}

fn infer_quantization(name: &str) -> Option<String> {
    let upper = name.to_uppercase();
    for q in ["Q2_K", "Q3_K_S", "Q3_K_M", "Q3_K_L", "Q4_0", "Q4_1", "Q4_K_S", "Q4_K_M", "Q5_0", "Q5_1", "Q5_K_S", "Q5_K_M", "Q6_K", "Q8_0"] {
        if upper.contains(q) {
            return Some(q.to_string());
        }
    }
    None
}

fn model_record_from_path(db: &Database, path: &Path, source_url: Option<&str>) -> AppResult<crate::database::LocalModelRecord> {
    if !path.exists() {
        return Err(AppError::MissingFile(path.display().to_string()));
    }
    if path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()) != Some("gguf".to_string()) {
        return Err(AppError::CorruptModel("Only .gguf model files can be imported here.".to_string()));
    }

    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let canonical_str = canonical.to_string_lossy().to_string();
    for existing in db.get_models()? {
        let existing_path = PathBuf::from(&existing.path);
        let existing_canonical = std::fs::canonicalize(&existing_path).unwrap_or(existing_path);
        if existing_canonical.to_string_lossy().eq_ignore_ascii_case(&canonical_str) {
            return Ok(existing);
        }
    }

    let meta = std::fs::metadata(&canonical)?;
    let name = canonical.file_name().and_then(|n| n.to_str()).unwrap_or("model.gguf").to_string();
    let quant = infer_quantization(&name);
    let id = db.add_model(
        &name,
        &canonical_str,
        "llama.cpp",
        quant.as_deref(),
        meta.len() as i64,
        source_url,
        None,
    )?;
    let models = db.get_models()?;
    models.into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| AppError::DatabaseError("Model was inserted but could not be read back.".to_string()))
}

fn emit_download_progress(
    window: &tauri::Window,
    id: &str,
    file_name: &str,
    status: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    speed_bytes_per_sec: f64,
    retries: u32,
    message: &str,
    started_at: Instant,
) {
    let _ = window.emit("model-download-progress", DownloadProgress {
        id: id.to_string(),
        file_name: file_name.to_string(),
        status: status.to_string(),
        downloaded_bytes,
        total_bytes,
        speed_bytes_per_sec,
        retries,
        message: message.to_string(),
        elapsed_secs: started_at.elapsed().as_secs(),
    });
}

fn parse_total_from_content_range(value: &str) -> Option<u64> {
    // Example: bytes 100-999/1234
    value.rsplit('/').next()?.parse::<u64>().ok()
}

#[tauri::command]
pub async fn import_local_model(state: State<'_, AppState>, path: String) -> AppResult<crate::database::LocalModelRecord> {
    let db = state.db.lock().await;
    model_record_from_path(&db, Path::new(&path), None)
}

#[tauri::command]
pub async fn scan_model_folder(state: State<'_, AppState>, folder_path: String) -> AppResult<Vec<crate::database::LocalModelRecord>> {
    let folder = PathBuf::from(folder_path);
    if !folder.exists() || !folder.is_dir() {
        return Err(AppError::MissingFile(folder.display().to_string()));
    }

    let mut ggufs = Vec::new();
    let mut stack = vec![folder];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("gguf")).unwrap_or(false) {
                ggufs.push(path);
            }
        }
    }

    let db = state.db.lock().await;
    for path in ggufs {
        let _ = model_record_from_path(&db, &path, None);
    }
    db.get_models().map_err(|e| e.into())
}

#[tauri::command]
pub async fn download_model(
    state: State<'_, AppState>,
    window: tauri::Window,
    url: String,
    dest_dir: String,
    name: Option<String>,
) -> AppResult<crate::database::LocalModelRecord> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(AppError::DownloadError("Download URL must start with http:// or https://".to_string()));
    }

    let dest_dir = PathBuf::from(dest_dir);
    tokio::fs::create_dir_all(&dest_dir).await?;
    let file_name = file_name_from_url(&url, name.as_deref());
    let final_path = dest_dir.join(&file_name);
    let part_path = dest_dir.join(format!("{}.part", &file_name));
    let id = format!("download-{}", file_name);
    let started_at = Instant::now();

    if final_path.exists() {
        let db = state.db.lock().await;
        return model_record_from_path(&db, &final_path, Some(&url));
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(120))
        .tcp_keepalive(Duration::from_secs(30))
        .build()?;

    let mut downloaded = match tokio::fs::metadata(&part_path).await {
        Ok(m) => m.len(),
        Err(_) => 0,
    };
    let mut total: Option<u64> = None;
    let mut retries: u32 = 0;
    let max_retries = 80u32;
    let mut last_emit = Instant::now();
    let mut last_bytes = downloaded;

    loop {
        let mut req = client.get(&url).header(USER_AGENT, "NexusAI/0.1 model-downloader");
        if downloaded > 0 {
            req = req.header(RANGE, format!("bytes={}-", downloaded));
            emit_download_progress(&window, &id, &file_name, "resuming", downloaded, total, 0.0, retries, "Resuming from existing .part file...", started_at);
        } else {
            emit_download_progress(&window, &id, &file_name, "starting", downloaded, total, 0.0, retries, "Connecting to server...", started_at);
        }

        let response = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                retries += 1;
                if retries > max_retries {
                    return Err(AppError::NetworkError(format!("Download failed after {} retries: {}", max_retries, e)));
                }
                emit_download_progress(&window, &id, &file_name, "retrying", downloaded, total, 0.0, retries, &format!("Connection failed, retrying: {}", e), started_at);
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };

        if downloaded > 0 && response.status() == reqwest::StatusCode::OK {
            // Server ignored Range. Restart safely to avoid appending duplicate bytes.
            downloaded = 0;
            let _ = tokio::fs::remove_file(&part_path).await;
            emit_download_progress(&window, &id, &file_name, "restarting", 0, None, 0.0, retries, "Server ignored resume request; restarting safely from 0 bytes.", started_at);
        } else if !response.status().is_success() && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            retries += 1;
            if retries > max_retries {
                return Err(AppError::DownloadError(format!("Server returned status {}", response.status())));
            }
            emit_download_progress(&window, &id, &file_name, "retrying", downloaded, total, 0.0, retries, &format!("Server returned {}; retrying...", response.status()), started_at);
            tokio::time::sleep(Duration::from_secs(3)).await;
            continue;
        }

        if let Some(range) = response.headers().get(CONTENT_RANGE).and_then(|v| v.to_str().ok()) {
            total = parse_total_from_content_range(range);
        } else if let Some(len) = response.headers().get(CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()) {
            total = Some(downloaded + len);
        }

        let mut stream = response.bytes_stream();
        let mut file = tokio::fs::OpenOptions::new().create(true).append(true).open(&part_path).await?;
        use futures::StreamExt;

        loop {
            match tokio::time::timeout(Duration::from_secs(45), stream.next()).await {
                Ok(Some(Ok(chunk))) => {
                    file.write_all(&chunk).await?;
                    downloaded += chunk.len() as u64;
                    let elapsed = last_emit.elapsed().as_secs_f64();
                    if elapsed >= 0.5 {
                        let delta = downloaded.saturating_sub(last_bytes);
                        let speed = if elapsed > 0.0 { delta as f64 / elapsed } else { 0.0 };
                        emit_download_progress(&window, &id, &file_name, "downloading", downloaded, total, speed, retries, "Downloading...", started_at);
                        last_emit = Instant::now();
                        last_bytes = downloaded;
                    }
                }
                Ok(Some(Err(e))) => {
                    retries += 1;
                    if retries > max_retries {
                        return Err(AppError::NetworkError(format!("Stream failed after {} retries: {}", max_retries, e)));
                    }
                    emit_download_progress(&window, &id, &file_name, "interrupted", downloaded, total, 0.0, retries, &format!("Stream interrupted; reconnecting: {}", e), started_at);
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    break;
                }
                Ok(None) => {
                    file.flush().await?;
                    if let Some(t) = total {
                        if downloaded >= t {
                            tokio::fs::rename(&part_path, &final_path).await?;
                            emit_download_progress(&window, &id, &file_name, "complete", downloaded, total, 0.0, retries, "Download complete.", started_at);
                            let db = state.db.lock().await;
                            return model_record_from_path(&db, &final_path, Some(&url));
                        }
                    } else if downloaded > 0 {
                        // Unknown total; a clean EOF means success.
                        tokio::fs::rename(&part_path, &final_path).await?;
                        emit_download_progress(&window, &id, &file_name, "complete", downloaded, Some(downloaded), 0.0, retries, "Download complete.", started_at);
                        let db = state.db.lock().await;
                        return model_record_from_path(&db, &final_path, Some(&url));
                    }
                    retries += 1;
                    if retries > max_retries {
                        return Err(AppError::DownloadError("Connection closed before expected file size was reached.".to_string()));
                    }
                    emit_download_progress(&window, &id, &file_name, "retrying", downloaded, total, 0.0, retries, "Connection closed early; reconnecting...", started_at);
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    break;
                }
                Err(_) => {
                    retries += 1;
                    if retries > max_retries {
                        return Err(AppError::NetworkError("Download stalled too many times.".to_string()));
                    }
                    emit_download_progress(&window, &id, &file_name, "stalled", downloaded, total, 0.0, retries, "No data received for 45 seconds; reconnecting automatically...", started_at);
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    break;
                }
            }
        }
    }
}


// Attachments / offline file context
#[tauri::command]
pub async fn process_attachments(
    paths: Vec<String>,
    max_chars_per_file: Option<usize>,
    max_total_chars: Option<usize>,
) -> AppResult<Vec<AttachmentContext>> {
    crate::file_context::process_files(paths, max_chars_per_file, max_total_chars)
}


// Diagnostics & Recovery
#[tauri::command]
pub async fn get_runtime_diagnostics(
    state: State<'_, AppState>,
    selected_model_path: Option<String>,
    models_dir: String,
) -> AppResult<RuntimeDiagnostics> {
    let mut checks = Vec::new();
    let current_dir = std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_else(|_| "unknown".to_string());
    let executable_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.display().to_string()))
        .unwrap_or_else(|| "unknown".to_string());

    let binary_result = resolve_llama_server_binary_for_diagnostics();
    let (llama_server_path, llama_server_found, llama_server_error) = match binary_result {
        Ok(path) => (Some(path), true, None),
        Err(e) => (None, false, Some(e)),
    };

    let llama_server_help_ok = if let Some(path) = &llama_server_path {
        match StdCommand::new(path).arg("--help").output() {
            Ok(output) => output.status.success(),
            Err(_) => false,
        }
    } else { false };

    checks.push(diag_check(
        "llama_server_found",
        "llama-server.exe present",
        if llama_server_found { "pass" } else { "fail" },
        if llama_server_found { "The local runtime executable was found." } else { "The local runtime executable is missing." },
        llama_server_path.as_ref().map(|p| p.display().to_string()).or(llama_server_error.clone()),
    ));
    checks.push(diag_check(
        "llama_server_help",
        "llama-server starts",
        if llama_server_help_ok { "pass" } else { "warning" },
        if llama_server_help_ok { "The runtime responds to --help." } else { "The runtime could not be started for a quick check. Required DLLs may be missing, blocked, or copied into the wrong runtime folder." },
        None,
    ));

    let selected_model_exists = selected_model_path.as_ref().map(|p| Path::new(p).is_file()).unwrap_or(false);
    let selected_model_size_bytes = selected_model_path.as_ref().and_then(|p| std::fs::metadata(p).ok().map(|m| m.len()));
    checks.push(diag_check(
        "selected_model",
        "Selected model file",
        if selected_model_exists { "pass" } else if selected_model_path.is_some() { "fail" } else { "warning" },
        if selected_model_exists { "The selected model file exists." } else if selected_model_path.is_some() { "The selected model path is invalid." } else { "No model is selected yet." },
        selected_model_path.clone(),
    ));

    let models_dir_exists = Path::new(&models_dir).is_dir();
    checks.push(diag_check(
        "models_folder",
        "Models folder",
        if models_dir_exists { "pass" } else { "warning" },
        if models_dir_exists { "The configured models folder exists." } else { "The configured models folder does not exist yet. It can be created automatically during downloads." },
        Some(models_dir.clone()),
    ));

    let info = {
        let mut hw = state.hardware.lock().await;
        hw.get_system_info()
    };

    let available_gb = info.memory.available_bytes as f64 / 1_073_741_824.0;
    checks.push(diag_check(
        "memory_available",
        "Available RAM",
        if available_gb >= 8.0 { "pass" } else if available_gb >= 4.0 { "warning" } else { "fail" },
        if available_gb >= 8.0 { "Good for small and medium GGUF models." } else if available_gb >= 4.0 { "Use small models, context 2048, and batch 128." } else { "Very low available RAM. Close other apps and use TinyLlama/low RAM settings." },
        Some(format!("{:.1} GB available", available_gb)),
    ));

    let gpu_summary: Vec<String> = info.gpus.iter().map(|g| {
        format!("{} {}{}{}{}", g.vendor, g.name,
            if g.is_cuda_capable { " • CUDA" } else { "" },
            if g.is_vulkan_capable { " • Vulkan" } else { "" },
            if g.vram_total_bytes > 0 { " • VRAM detected" } else { "" })
    }).collect();
    checks.push(diag_check(
        "gpu_detected",
        "GPU detection",
        if info.gpus.is_empty() { "info" } else { "pass" },
        if info.gpus.is_empty() { "No GPU was detected by the current scanner. CPU mode can still work." } else { "GPU information was detected. Acceleration is used only when a matching CUDA or Vulkan runtime is bundled and selected successfully." },
        Some(gpu_summary.join(" | ")),
    ));

    Ok(RuntimeDiagnostics {
        app_version: info.app_version.clone(),
        current_dir,
        executable_dir,
        llama_server_path: llama_server_path.map(|p| p.display().to_string()),
        llama_server_found,
        llama_server_help_ok,
        llama_server_error,
        models_dir_exists,
        selected_model_path,
        selected_model_exists,
        selected_model_size_bytes,
        free_disk_bytes: Some(info.storage.free_bytes),
        memory_total_bytes: Some(info.memory.total_bytes),
        memory_available_bytes: Some(info.memory.available_bytes),
        cpu_brand: Some(info.cpu.brand.clone()),
        gpu_summary,
        checks,
    })
}

#[tauri::command]
pub async fn kill_llama_servers(state: State<'_, AppState>) -> AppResult<()> {
    state.kc_embed_pool.shutdown().await;
    state.kc_rerank_pool.shutdown().await;
    let _ = state.local_backend.unload_model().await;
    #[cfg(target_os = "windows")]
    {
        let _ = StdCommand::new("taskkill").args(["/IM", "llama-server.exe", "/F"]).output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = StdCommand::new("pkill").arg("llama-server").output();
    }
    Ok(())
}



#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KcBackupSnapshot {
    pub collections: Vec<crate::knowledge_chat::types::KcCollection>,
    pub files: Vec<crate::knowledge_chat::types::KcFileRecord>,
}

// Backup / Restore
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupData {
    pub app: String,
    pub version: u32,
    pub exported_at: String,
    pub conversations: Vec<crate::database::Conversation>,
    pub messages: BTreeMap<String, Vec<crate::database::Message>>,
    pub characters: Vec<crate::database::Character>,
    pub local_models: Vec<crate::database::LocalModelRecord>,
    pub settings: BTreeMap<String, String>,
    #[serde(default)]
    pub knowledge_chat: Option<KcBackupSnapshot>,
}

#[tauri::command]
pub async fn export_backup(state: State<'_, AppState>) -> AppResult<BackupData> {
    let db = state.db.lock().await;
    let conversations = db.get_conversations()?;
    let mut messages = BTreeMap::new();
    for conv in &conversations {
        messages.insert(conv.id.clone(), db.get_messages(&conv.id)?);
    }
    let characters = db.get_characters()?;
    let local_models = db.get_models()?;
    let settings_vec = db.get_all_settings()?;
    let mut settings = BTreeMap::new();
    for (key, value) in settings_vec {
        settings.insert(key, value);
    }

    let (kc_collections, kc_files) = crate::knowledge_chat::db::export_knowledge_chat_snapshot(&db)?;
    let knowledge_chat = if kc_collections.is_empty() {
        None
    } else {
        Some(KcBackupSnapshot {
            collections: kc_collections,
            files: kc_files,
        })
    };

    let backup = BackupData {
        app: "NexusAI Desktop".to_string(),
        version: 2,
        exported_at: chrono::Utc::now().to_rfc3339(),
        conversations,
        messages,
        characters,
        local_models,
        settings,
        knowledge_chat,
    };
    drop(db);
    record_audit(
        &state,
        "backup.export",
        "backup",
        "Application backup exported",
        Some(format!("{} conversations", backup.conversations.len())),
        None,
        true,
    )
    .await;
    Ok(backup)
}

#[tauri::command]
pub async fn import_backup(state: State<'_, AppState>, backup: BackupData) -> AppResult<String> {
    if backup.app.trim().is_empty() || backup.version == 0 {
        return Err(anyhow::anyhow!("This does not look like a valid NexusAI backup file.").into());
    }

    let db = state.db.lock().await;
    let mut imported_conversations = 0usize;
    let mut imported_characters = 0usize;
    let mut imported_models = 0usize;
    let mut skipped_models = 0usize;

    for character in backup.characters {
        let _ = db.create_character(
            &character.name,
            &character.description,
            &character.system_prompt,
            character.avatar_path.as_deref(),
            &character.personality_traits,
            character.folder_id.as_deref(),
        )?;
        imported_characters += 1;
    }

    for conv in backup.conversations {
        let msgs = backup.messages.get(&conv.id).cloned().unwrap_or_default();
        let title = if conv.title.trim().is_empty() { "Imported chat" } else { conv.title.as_str() };
        let _ = db.import_conversation(title, msgs, None)?;
        imported_conversations += 1;
    }

    for model in backup.local_models {
        let path = PathBuf::from(&model.path);
        if path.is_file() {
            let _ = model_record_from_path(&db, &path, model.source_url.as_deref());
            imported_models += 1;
        } else {
            skipped_models += 1;
        }
    }

    for (key, value) in backup.settings {
        // Do not import encrypted API keys through settings. API keys are intentionally excluded.
        if !key.to_lowercase().contains("api_key") && !key.to_lowercase().contains("secret") {
            let _ = db.set_setting(&key, &value);
        }
    }

    let mut imported_collections = 0usize;
    if let Some(snapshot) = &backup.knowledge_chat {
        crate::knowledge_chat::db::restore_knowledge_chat_snapshot(
            &db,
            &snapshot.collections,
            &snapshot.files,
        )?;
        imported_collections = snapshot.collections.len();
    }

    let summary = format!(
        "Imported {} chats, {} characters, {} knowledge collections, and {} existing model records. Skipped {} model records because the GGUF files were not found on this computer. Rebuild knowledge collections after restore if chunks were not included.",
        imported_conversations, imported_characters, imported_collections, imported_models, skipped_models
    );
    drop(db);
    record_audit(
        &state,
        "backup.import",
        "backup",
        "Application backup imported",
        Some(summary.clone()),
        None,
        true,
    )
    .await;
    Ok(summary)
}

// Settings & Recovery
#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<Vec<(String, String)>> {
    let db = state.db.lock().await;
    db.get_all_settings().map_err(|e| e.into())
}

#[tauri::command]
pub async fn set_setting(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    let db = state.db.lock().await;
    db.set_setting(&key, &value).map_err(|e| e.into())
}

#[tauri::command]
pub async fn get_deployment_config(state: State<'_, AppState>) -> AppResult<deployment::DeploymentConfig> {
    let db = state.db.lock().await;
    Ok(deployment::load_deployment_config(&db))
}

#[tauri::command]
pub async fn set_deployment_config(
    state: State<'_, AppState>,
    config: deployment::DeploymentConfig,
) -> AppResult<deployment::DeploymentConfig> {
    let db = state.db.lock().await;
    deployment::save_deployment_config(&db, &config)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    let saved = deployment::load_deployment_config(&db);
    drop(db);
    record_audit(
        &state,
        "deployment.save",
        "deployment",
        "Deployment settings saved",
        Some(format!("data_root={}", saved.data_root)),
        None,
        true,
    )
    .await;
    Ok(saved)
}

#[tauri::command]
pub async fn get_deployment_paths(state: State<'_, AppState>) -> AppResult<deployment::DeploymentPaths> {
    let db = state.db.lock().await;
    let config = deployment::load_deployment_config(&db);
    Ok(deployment::resolve_paths(&config))
}

#[tauri::command]
pub async fn ensure_deployment_directories(
    state: State<'_, AppState>,
) -> AppResult<deployment::DeploymentEnsureResult> {
    let db = state.db.lock().await;
    let config = deployment::load_deployment_config(&db);
    drop(db);
    deployment::ensure_deployment_directories(&config).map_err(|e| AppError::Unknown(e.to_string()))
}

#[tauri::command]
pub async fn validate_deployment_path(
    state: State<'_, AppState>,
    path: String,
) -> AppResult<bool> {
    let db = state.db.lock().await;
    let config = deployment::load_deployment_config(&db);
    Ok(config.is_path_allowed(path.trim()))
}

#[tauri::command]
pub async fn get_last_session(state: State<'_, AppState>) -> AppResult<Option<String>> {
    let db = state.db.lock().await;
    db.get_last_active_conversation().map_err(|e| e.into())
}

#[tauri::command]
pub async fn get_product_config(state: State<'_, AppState>) -> AppResult<ProductConfig> {
    let db = state.db.lock().await;
    Ok(product::load_product_config(&db))
}

#[tauri::command]
pub async fn set_product_config(
    state: State<'_, AppState>,
    config: ProductConfig,
) -> AppResult<ProductConfig> {
    let db = state.db.lock().await;
    product::save_product_config(&db, &config)?;
    let saved = product::load_product_config(&db);
    drop(db);
    record_audit(
        &state,
        "product.config_save",
        "product",
        "Security settings saved",
        None,
        None,
        true,
    )
    .await;
    Ok(saved)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogAuditEventRequest {
    pub event_type: String,
    pub category: String,
    pub summary: String,
    pub detail: Option<String>,
    pub resource_path: Option<String>,
    pub success: Option<bool>,
}

#[tauri::command]
pub async fn log_audit_event(
    state: State<'_, AppState>,
    request: LogAuditEventRequest,
) -> AppResult<AuditLogEntry> {
    let db = state.db.lock().await;
    let config = product::load_product_config(&db);
    if !config.audit_log_enabled {
        return Ok(AuditLogEntry {
            id: String::new(),
            event_type: request.event_type,
            category: request.category,
            summary: request.summary,
            detail: request.detail,
            resource_path: request.resource_path,
            success: request.success.unwrap_or(true),
            created_at: chrono::Utc::now().timestamp(),
        });
    }
    audit::log_event(
        &db,
        &request.event_type,
        &request.category,
        &request.summary,
        request.detail.as_deref(),
        request.resource_path.as_deref(),
        request.success.unwrap_or(true),
    )
}

#[tauri::command]
pub async fn get_audit_log(
    state: State<'_, AppState>,
    limit: Option<usize>,
    offset: Option<usize>,
    category: Option<String>,
) -> AppResult<Vec<AuditLogEntry>> {
    let db = state.db.lock().await;
    audit::list_events(
        &db,
        &AuditLogQuery {
            limit,
            offset,
            category,
        },
    )
}

fn soc_path_allowed(path: &str, config: &DeploymentConfig) -> bool {
    config.is_path_allowed(path)
}

fn soc_path_error(path: &str, config: &DeploymentConfig) -> String {
    let roots = config.allowed_roots().join(", ");
    format!(
        "Path is outside configured NexusAI data roots: {path}. Allowed roots: {roots}"
    )
}

#[tauri::command]
pub async fn export_audit_log(
    state: State<'_, AppState>,
    path: String,
    limit: Option<usize>,
    category: Option<String>,
) -> AppResult<String> {
    let db = state.db.lock().await;
    let config = deployment::load_deployment_config(&db);
    drop(db);
    let clean_path = deployment::normalize_path_string(path.trim());
    if !soc_path_allowed(&clean_path, &config) {
        return Err(AppError::Unknown(soc_path_error(&clean_path, &config)));
    }
    let db = state.db.lock().await;
    let csv = audit::export_csv(
        &db,
        &AuditLogQuery {
            limit,
            offset: Some(0),
            category,
        },
    )?;
    drop(db);
    tokio::fs::write(&clean_path, csv.as_bytes()).await?;
    record_audit(
        &state,
        "audit.export",
        "audit",
        "Audit log exported",
        None,
        Some(clean_path.clone()),
        true,
    )
    .await;
    Ok(clean_path)
}

// Organization server
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnterpriseServerConfig {
    pub base_url: String,
    pub selected_model: String,
    pub api_key_saved: bool,
    /// Opt-in to offloading Knowledge Chat embeddings to the organization server.
    #[serde(default)]
    pub embeddings_enabled: bool,
    /// Model id served by the org server for the code partition (Nomic).
    #[serde(default)]
    pub code_embedding_model: String,
    /// Model id served by the org server for the knowledge partition (BGE-M3).
    #[serde(default)]
    pub knowledge_embedding_model: String,
    /// Optional separate base URL for embeddings; defaults to `base_url` when empty.
    #[serde(default)]
    pub embeddings_base_url: String,
    /// When true, Knowledge Chat uses the org gateway (`/v1/knowledge/*`) instead of local RAG.
    #[serde(default)]
    pub server_rag_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnterpriseModelInfo {
    pub id: String,
    pub owned_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnterpriseEmbeddingProbe {
    pub partition: String,
    pub model_id: String,
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnterpriseServerTestResult {
    pub ok: bool,
    pub message: String,
    pub base_url: String,
    pub model_count: usize,
    pub models: Vec<EnterpriseModelInfo>,
    #[serde(default)]
    pub embedding_probes: Vec<EnterpriseEmbeddingProbe>,
}

#[tauri::command]
pub async fn get_enterprise_server_config(state: State<'_, AppState>) -> AppResult<EnterpriseServerConfig> {
    let db = state.db.lock().await;
    let base_url = db
        .get_setting(KEY_ENTERPRISE_BASE_URL)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .unwrap_or_default();
    let selected_model = db
        .get_setting(KEY_ENTERPRISE_SELECTED_MODEL)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .unwrap_or_default();
    let api_key_saved = db
        .get_api_key(ENTERPRISE_PROVIDER)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .is_some();
    let embeddings_enabled = db
        .get_setting(KEY_ENTERPRISE_EMBEDDINGS_ENABLED)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let code_embedding_model = db
        .get_setting(KEY_ENTERPRISE_CODE_EMBED_MODEL)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .unwrap_or_default();
    let knowledge_embedding_model = db
        .get_setting(KEY_ENTERPRISE_KNOWLEDGE_EMBED_MODEL)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .unwrap_or_default();
    let embeddings_base_url = db
        .get_setting(KEY_ENTERPRISE_EMBED_BASE_URL)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .unwrap_or_default();
    let server_rag_enabled = db
        .get_setting(KEY_ENTERPRISE_SERVER_RAG)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    Ok(EnterpriseServerConfig {
        base_url,
        selected_model,
        api_key_saved,
        embeddings_enabled,
        code_embedding_model,
        knowledge_embedding_model,
        embeddings_base_url,
        server_rag_enabled,
    })
}

#[tauri::command]
pub async fn get_enterprise_server_token(state: State<'_, AppState>) -> AppResult<String> {
    resolve_enterprise_api_key(&state, None).await
}

#[tauri::command]
pub async fn save_enterprise_server_config(
    state: State<'_, AppState>,
    base_url: String,
    api_key: Option<String>,
    selected_model: Option<String>,
    embeddings_enabled: Option<bool>,
    code_embedding_model: Option<String>,
    knowledge_embedding_model: Option<String>,
    embeddings_base_url: Option<String>,
    server_rag_enabled: Option<bool>,
) -> AppResult<EnterpriseServerConfig> {
    let normalized_url = normalize_enterprise_base_url(&base_url);
    if normalized_url.is_empty() {
        return Err(AppError::Unknown(
            "Organization server URL is required.".to_string(),
        ));
    }
    let db = state.db.lock().await;
    db.set_setting(KEY_ENTERPRISE_BASE_URL, &normalized_url)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    if let Some(model) = selected_model.as_deref() {
        db.set_setting(KEY_ENTERPRISE_SELECTED_MODEL, model.trim())
            .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    }
    if let Some(enabled) = embeddings_enabled {
        db.set_setting(KEY_ENTERPRISE_EMBEDDINGS_ENABLED, if enabled { "1" } else { "0" })
            .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    }
    if let Some(model) = code_embedding_model.as_deref() {
        db.set_setting(KEY_ENTERPRISE_CODE_EMBED_MODEL, model.trim())
            .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    }
    if let Some(model) = knowledge_embedding_model.as_deref() {
        db.set_setting(KEY_ENTERPRISE_KNOWLEDGE_EMBED_MODEL, model.trim())
            .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    }
    if let Some(embed_url) = embeddings_base_url.as_deref() {
        let trimmed = embed_url.trim();
        let normalized_embed = if trimmed.is_empty() { String::new() } else { normalize_enterprise_base_url(trimmed) };
        db.set_setting(KEY_ENTERPRISE_EMBED_BASE_URL, &normalized_embed)
            .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    }
    if let Some(enabled) = server_rag_enabled {
        db.set_setting(KEY_ENTERPRISE_SERVER_RAG, if enabled { "1" } else { "0" })
            .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    }
    if let Some(key) = api_key {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            let encrypted = state.crypto.encrypt(trimmed)?;
            db.store_api_key(ENTERPRISE_PROVIDER, &encrypted)
                .map_err(|e| AppError::DatabaseError(e.to_string()))?;
        }
    }
    let saved = EnterpriseServerConfig {
        base_url: db
            .get_setting(KEY_ENTERPRISE_BASE_URL)
            .map_err(|e| AppError::DatabaseError(e.to_string()))?
            .unwrap_or_default(),
        selected_model: db
            .get_setting(KEY_ENTERPRISE_SELECTED_MODEL)
            .map_err(|e| AppError::DatabaseError(e.to_string()))?
            .unwrap_or_default(),
        api_key_saved: db
            .get_api_key(ENTERPRISE_PROVIDER)
            .map_err(|e| AppError::DatabaseError(e.to_string()))?
            .is_some(),
        embeddings_enabled: db
            .get_setting(KEY_ENTERPRISE_EMBEDDINGS_ENABLED)
            .map_err(|e| AppError::DatabaseError(e.to_string()))?
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false),
        code_embedding_model: db
            .get_setting(KEY_ENTERPRISE_CODE_EMBED_MODEL)
            .map_err(|e| AppError::DatabaseError(e.to_string()))?
            .unwrap_or_default(),
        knowledge_embedding_model: db
            .get_setting(KEY_ENTERPRISE_KNOWLEDGE_EMBED_MODEL)
            .map_err(|e| AppError::DatabaseError(e.to_string()))?
            .unwrap_or_default(),
        embeddings_base_url: db
            .get_setting(KEY_ENTERPRISE_EMBED_BASE_URL)
            .map_err(|e| AppError::DatabaseError(e.to_string()))?
            .unwrap_or_default(),
        server_rag_enabled: db
            .get_setting(KEY_ENTERPRISE_SERVER_RAG)
            .map_err(|e| AppError::DatabaseError(e.to_string()))?
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false),
    };
    drop(db);
    record_audit(
        &state,
        "enterprise.save",
        "enterprise",
        "Organization server settings saved",
        Some(saved.base_url.clone()),
        None,
        true,
    )
    .await;
    Ok(saved)
}

#[tauri::command]
pub async fn clear_enterprise_server_key(state: State<'_, AppState>) -> AppResult<()> {
    let db = state.db.lock().await;
    db.delete_api_key(ENTERPRISE_PROVIDER)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    drop(db);
    record_audit(
        &state,
        "enterprise.clear_key",
        "enterprise",
        "Organization server token removed",
        None,
        None,
        true,
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn list_enterprise_server_models(
    state: State<'_, AppState>,
    base_url: Option<String>,
    api_key: Option<String>,
) -> AppResult<Vec<EnterpriseModelInfo>> {
    let db = state.db.lock().await;
    let resolved_base = base_url
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| {
            db.get_setting(KEY_ENTERPRISE_BASE_URL)
                .ok()
                .flatten()
        .unwrap_or_default()
        });
    drop(db);
    let normalized = normalize_enterprise_base_url(&resolved_base);
    if normalized.is_empty() {
        return Err(AppError::Unknown(
            "Organization server URL is not configured.".to_string(),
        ));
    }
    let key = resolve_enterprise_api_key(&state, api_key).await?;
    fetch_enterprise_models(&normalized, &key).await
}

#[tauri::command]
pub async fn test_enterprise_server_connection(
    state: State<'_, AppState>,
    base_url: String,
    api_key: Option<String>,
    embeddings_base_url: Option<String>,
    code_embedding_model: Option<String>,
    knowledge_embedding_model: Option<String>,
) -> AppResult<EnterpriseServerTestResult> {
    let normalized = normalize_enterprise_base_url(&base_url);
    if normalized.is_empty() {
        return Err(AppError::Unknown(
            "Organization server URL is required.".to_string(),
        ));
    }
    let key = resolve_enterprise_api_key(&state, api_key).await?;
    let models = fetch_enterprise_models(&normalized, &key).await?;
    let model_count = models.len();

    // Probe /v1/embeddings for any configured embed models so the user gets a
    // clear pass/fail before enabling remote Knowledge Chat embeddings.
    let embed_base = embeddings_base_url
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(|v| normalize_enterprise_base_url(&v))
        .unwrap_or_else(|| normalized.clone());
    let mut embedding_probes = Vec::new();
    for (partition, model) in [
        ("code", code_embedding_model),
        ("knowledge", knowledge_embedding_model),
    ] {
        let Some(model_id) = model.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) else {
            continue;
        };
        let ok = crate::knowledge_chat::remote_embeddings::probe_remote_embeddings(
            &embed_base,
            &key,
            &model_id,
        )
        .await;
        embedding_probes.push(EnterpriseEmbeddingProbe {
            partition: partition.to_string(),
            ok,
            message: if ok {
                format!("/v1/embeddings served '{model_id}'.")
            } else {
                format!("Could not embed with '{model_id}' at {embed_base}/embeddings.")
            },
            model_id,
        });
    }

    Ok(EnterpriseServerTestResult {
        ok: true,
        message: format!("Connected successfully. Found {model_count} model(s)."),
        base_url: normalized,
        model_count,
        models,
        embedding_probes,
    })
}

// SOC knowledge + dense embeddings
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocKnowledgeScanFile {
    pub path: String,
    pub name: String,
    pub extension: String,
    pub size_bytes: u64,
    pub supported: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocKnowledgeScanResult {
    pub folder_path: String,
    pub scanned_files: usize,
    pub supported_files: usize,
    pub unsupported_files: usize,
    pub truncated: bool,
    pub files: Vec<SocKnowledgeScanFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocDenseEmbeddingProviderValidation {
    pub ok: bool,
    pub message: String,
    pub model_path: String,
    pub runtime_path: Option<String>,
    pub provider_name: String,
    pub model_format: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocDenseEmbeddingTextRequest {
    pub chunk_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocDenseEmbeddingBuildRequest {
    pub model_path: String,
    pub texts: Vec<SocDenseEmbeddingTextRequest>,
    pub context_size: Option<u32>,
    pub batch_size: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocDenseEmbeddingVectorResult {
    pub chunk_id: String,
    pub vector: Vec<f32>,
    pub dimension: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocDenseEmbeddingBuildResult {
    pub ok: bool,
    pub provider_name: String,
    pub runtime_path: String,
    pub model_path: String,
    pub model_format: String,
    pub dimension: usize,
    pub vectors: Vec<SocDenseEmbeddingVectorResult>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocDenseIndexPersisted {
    pub model_path: String,
    pub dimension: usize,
    pub updated_at: i64,
    pub vectors: BTreeMap<String, Vec<f32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocPdfOcrResult {
    pub ok: bool,
    pub source_pdf: String,
    pub output_markdown: String,
    pub pages_processed: usize,
    pub ocr_pages: usize,
    pub char_count: usize,
    pub alpha_count: usize,
    pub text: String,
    pub warnings: Vec<String>,
}

fn is_allowed_soc_scan_path(path: &str) -> bool {
    deployment::default_config().is_path_allowed(path)
}

fn is_soc_bulk_supported_extension(extension: &str) -> bool {
    matches!(
        extension,
        "html" | "htm" | "txt" | "md" | "markdown" | "csv" | "json" | "xml" | "yaml" | "yml" | "log" | "pdf"
    )
}

fn soc_file_extension(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn collect_soc_scan_files(
    root: &Path,
    limit: usize,
    files: &mut Vec<SocKnowledgeScanFile>,
    truncated: &mut bool,
) -> AppResult<()> {
    if *truncated || files.len() >= limit {
        *truncated = true;
        return Ok(());
    }
    let entries = std::fs::read_dir(root).map_err(|e| AppError::Unknown(e.to_string()))?;
    for entry in entries {
        if files.len() >= limit {
            *truncated = true;
            return Ok(());
        }
        let entry = entry.map_err(|e| AppError::Unknown(e.to_string()))?;
        let path = entry.path();
        if path.is_dir() {
            collect_soc_scan_files(&path, limit, files, truncated)?;
        } else if path.is_file() {
            let metadata = entry.metadata().map_err(|e| AppError::Unknown(e.to_string()))?;
            let extension = soc_file_extension(&path);
            let supported = is_soc_bulk_supported_extension(&extension);
            files.push(SocKnowledgeScanFile {
                path: deployment::normalize_path_string(&path.to_string_lossy()),
                name: path
                    .file_name()
                    .and_then(|v| v.to_str())
                    .unwrap_or("file")
                    .to_string(),
                extension: extension.clone(),
                size_bytes: metadata.len(),
                supported,
                reason: if supported {
                    None
                } else {
                    Some("Unsupported extension for SOC bulk import.".to_string())
                },
            });
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn scan_soc_knowledge_folder(
    state: State<'_, AppState>,
    folder_path: String,
    max_files: Option<usize>,
) -> AppResult<SocKnowledgeScanResult> {
    let db = state.db.lock().await;
    let config = deployment::load_deployment_config(&db);
    drop(db);
    let clean_path = deployment::normalize_path_string(folder_path.trim());
    if clean_path.is_empty() {
        return Err(AppError::Unknown("Folder path is required.".to_string()));
    }
    if !soc_path_allowed(&clean_path, &config) {
        return Err(AppError::Unknown(soc_path_error(&clean_path, &config)));
    }
    let root = PathBuf::from(&clean_path);
    if !root.is_dir() {
        return Err(AppError::Unknown(
            "Folder does not exist or is not a directory.".to_string(),
        ));
    }
    let limit = max_files.unwrap_or(1500).clamp(1, 5000);
    let mut files = Vec::new();
    let mut truncated = false;
    collect_soc_scan_files(&root, limit, &mut files, &mut truncated)?;
    let supported_files = files.iter().filter(|f| f.supported).count();
    let unsupported_files = files.len().saturating_sub(supported_files);
    Ok(SocKnowledgeScanResult {
        folder_path: clean_path,
        scanned_files: files.len(),
        supported_files,
        unsupported_files,
        truncated,
        files,
    })
}

#[tauri::command]
pub async fn write_soc_text_export(
    state: State<'_, AppState>,
    path: String,
    contents: String,
    overwrite: bool,
) -> AppResult<String> {
    let db = state.db.lock().await;
    let config = deployment::load_deployment_config(&db);
    drop(db);
    let clean_path = deployment::normalize_path_string(path.trim());
    if clean_path.is_empty() {
        return Err(AppError::Unknown("Export path is required.".to_string()));
    }
    if !soc_path_allowed(&clean_path, &config) {
        return Err(AppError::Unknown(soc_path_error(&clean_path, &config)));
    }
    if Path::new(&clean_path).exists() && !overwrite {
        return Err(AppError::Unknown(
            "File already exists. Choose another path or enable overwrite.".to_string(),
        ));
    }
    if let Some(parent) = Path::new(&clean_path).parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&clean_path, contents.as_bytes()).await?;
    record_audit(
        &state,
        "soc.export",
        "soc",
        "SOC text export saved",
        Some(format!("{} bytes", contents.len())),
        Some(clean_path.clone()),
        true,
    )
    .await;
    Ok(clean_path)
}

#[tauri::command]
pub async fn validate_soc_dense_embedding_provider(
    state: State<'_, AppState>,
    model_path: String,
) -> AppResult<SocDenseEmbeddingProviderValidation> {
    let db = state.db.lock().await;
    let config = deployment::load_deployment_config(&db);
    drop(db);
    let clean = deployment::normalize_path_string(model_path.trim().trim_matches('"'));
    if clean.is_empty() {
        return Err(AppError::Unknown(
            "A local embedding model path is required.".to_string(),
        ));
    }
    if !soc_path_allowed(&clean, &config) {
        return Err(AppError::Unknown(soc_path_error(&clean, &config)));
    }
    let validation = embeddings::validate_embedding_model(&clean).await?;
    Ok(SocDenseEmbeddingProviderValidation {
        ok: validation.ok,
        message: validation.message,
        model_path: validation.model_path,
        runtime_path: validation.runtime_path,
        provider_name: "Local llama.cpp embeddings".to_string(),
        model_format: Some("gguf".to_string()),
        warnings: validation.warnings,
    })
}

#[tauri::command]
pub async fn embed_soc_dense_texts(
    state: State<'_, AppState>,
    request: SocDenseEmbeddingBuildRequest,
) -> AppResult<SocDenseEmbeddingBuildResult> {
    let db = state.db.lock().await;
    let config = deployment::load_deployment_config(&db);
    drop(db);
    let clean_model_path = deployment::normalize_path_string(request.model_path.trim().trim_matches('"'));
    if clean_model_path.is_empty() {
        return Err(AppError::Unknown(
            "A local embedding model path is required.".to_string(),
        ));
    }
    if !soc_path_allowed(&clean_model_path, &config) {
        return Err(AppError::Unknown(soc_path_error(&clean_model_path, &config)));
    }
    if request.texts.is_empty() {
        return Err(AppError::Unknown(
            "No text chunks were provided for dense embedding.".to_string(),
        ));
    }
    if request.texts.len() > MAX_TEXTS_PER_RUN {
        return Err(AppError::Unknown(format!(
            "Dense embedding is limited to {MAX_TEXTS_PER_RUN} chunks per run."
        )));
    }
    let validation = embeddings::validate_embedding_model(&clean_model_path).await?;
    let runtime_path = validation.runtime_path.unwrap_or_default();
    let embed_result = embeddings::embed_texts(
        None,
        KcEmbedTextsRequest {
            model_path: clean_model_path.clone(),
            texts: request
                .texts
                .iter()
                .map(|item| item.text.replace('\0', " ").chars().take(2800).collect::<String>())
                .collect(),
            context_size: request.context_size.or(Some(EMBED_CONTEXT_SIZE)),
            batch_size: request.batch_size.or(Some(EMBED_BATCH_SIZE)),
        },
    )
    .await?;
    let vectors = request
        .texts
        .iter()
        .zip(embed_result.vectors.into_iter())
        .map(|(item, vector)| SocDenseEmbeddingVectorResult {
                    chunk_id: item.chunk_id.clone(),
                    dimension: vector.len(),
                    vector,
        })
        .collect::<Vec<_>>();
    let dimension = embed_result.vector_dimension;
        Ok(SocDenseEmbeddingBuildResult {
            ok: true,
            provider_name: "Local llama.cpp embeddings".to_string(),
        runtime_path,
            model_path: clean_model_path,
        model_format: "gguf".to_string(),
            dimension,
            vectors,
        warnings: validation.warnings,
        })
}

#[tauri::command]
pub async fn save_soc_dense_index(
    state: State<'_, AppState>,
    file_path: String,
    payload: SocDenseIndexPersisted,
) -> AppResult<()> {
    let db = state.db.lock().await;
    let config = deployment::load_deployment_config(&db);
    drop(db);
    let clean = deployment::normalize_path_string(file_path.trim().trim_matches('"'));
    if !config.is_path_allowed(&clean) {
        return Err(AppError::Unknown(soc_path_error(&clean, &config)));
    }
    if let Some(parent) = Path::new(&clean).parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let json = serde_json::to_string_pretty(&payload)
        .map_err(|e| AppError::Unknown(format!("Could not serialize dense index: {e}")))?;
    tokio::fs::write(&clean, json.as_bytes()).await?;
    Ok(())
}

#[tauri::command]
pub async fn load_soc_dense_index(
    state: State<'_, AppState>,
    file_path: String,
) -> AppResult<SocDenseIndexPersisted> {
    let db = state.db.lock().await;
    let config = deployment::load_deployment_config(&db);
    drop(db);
    let clean = deployment::normalize_path_string(file_path.trim().trim_matches('"'));
    if !config.is_path_allowed(&clean) {
        return Err(AppError::Unknown(soc_path_error(&clean, &config)));
    }
    let raw = tokio::fs::read_to_string(&clean).await?;
    serde_json::from_str(&raw)
        .map_err(|e| AppError::Unknown(format!("Could not parse dense index JSON: {e}")))
}

fn resolve_soc_pdf_ocr_script() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("scripts").join("soc_pdf_ocr.py"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("scripts").join("soc_pdf_ocr.py"));
            candidates.push(
                parent
                    .join("..")
                    .join("..")
                    .join("scripts")
                    .join("soc_pdf_ocr.py"),
            );
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn resolve_python_executable() -> Option<PathBuf> {
    for candidate in ["python", "python3", "py"] {
        if StdCommand::new(candidate)
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
        {
            return Some(PathBuf::from(candidate));
        }
    }
    None
}

#[tauri::command]
pub async fn ocr_soc_pdf(
    state: State<'_, AppState>,
    pdf_path: String,
    output_markdown: Option<String>,
    max_pages: Option<u32>,
    dpi: Option<u32>,
) -> AppResult<SocPdfOcrResult> {
    let db = state.db.lock().await;
    let config = deployment::load_deployment_config(&db);
    drop(db);
    let clean_pdf = deployment::normalize_path_string(pdf_path.trim());
    if clean_pdf.is_empty() {
        return Err(AppError::Unknown("PDF path is required.".to_string()));
    }
    if !soc_path_allowed(&clean_pdf, &config) {
        return Err(AppError::Unknown(soc_path_error(&clean_pdf, &config)));
    }
    let pdf = PathBuf::from(&clean_pdf);
    if !pdf.is_file() {
        return Err(AppError::Unknown("PDF file does not exist.".to_string()));
    }
    if pdf
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .eq_ignore_ascii_case("pdf")
        == false
    {
        return Err(AppError::Unknown(
            "Only .pdf files can be OCR indexed.".to_string(),
        ));
    }

    let output = output_markdown
        .map(|value| deployment::normalize_path_string(value.trim()))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            deployment::normalize_path_string(
                &pdf.with_file_name(format!(
                    "{}-OCR.md",
                    pdf.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("document")
                ))
                .to_string_lossy(),
            )
        });

    if !soc_path_allowed(&output, &config) {
        return Err(AppError::Unknown(soc_path_error(&output, &config)));
    }
    if let Some(parent) = Path::new(&output).parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let script = resolve_soc_pdf_ocr_script().ok_or_else(|| {
        AppError::Unknown(
            "Could not find scripts/soc_pdf_ocr.py. Reinstall or place the script under the project scripts folder.".to_string(),
        )
    })?;
    let python = resolve_python_executable().ok_or_else(|| {
        AppError::Unknown(
            "Python was not found on PATH. Install Python 3 and run: pip install pymupdf pillow winsdk".to_string(),
        )
    })?;

    let mut command = StdCommand::new(&python);
    command.arg(&script).arg(&clean_pdf).arg("--output").arg(&output);
    if let Some(pages) = max_pages {
        command.arg("--max-pages").arg(pages.to_string());
    }
    if let Some(dpi_value) = dpi {
        command.arg("--dpi").arg(dpi_value.to_string());
    }
    let output_proc = command
        .output()
        .map_err(|e| AppError::Unknown(format!("Could not run PDF OCR helper: {e}")))?;
    if !output_proc.status.success() {
        let stderr = String::from_utf8_lossy(&output_proc.stderr);
        let stdout = String::from_utf8_lossy(&output_proc.stdout);
        return Err(AppError::Unknown(format!(
            "PDF OCR failed: {stderr} {stdout}"
        )));
    }

    let text = tokio::fs::read_to_string(&output).await.unwrap_or_default();
    let char_count = text.chars().count();
    let alpha_count = text.chars().filter(|c| c.is_alphabetic()).count();
    let mut pages_processed = 0usize;
    let mut ocr_pages = 0usize;
    for line in String::from_utf8_lossy(&output_proc.stderr).lines() {
        if let Some(rest) = line.strip_prefix("STATS:") {
            for part in rest.split(';') {
                if let Some((key, value)) = part.split_once('=') {
                    match key {
                        "pages" => pages_processed = value.parse().unwrap_or(0),
                        "ocr_pages" => ocr_pages = value.parse().unwrap_or(0),
                        _ => {}
                    }
                }
            }
        }
    }

    record_audit(
        &state,
        "soc.ocr_pdf",
        "soc",
        "SOC PDF OCR completed",
        Some(format!("{pages_processed} pages, {char_count} chars")),
        Some(clean_pdf.clone()),
        true,
    )
    .await;

    Ok(SocPdfOcrResult {
        ok: true,
        source_pdf: clean_pdf,
        output_markdown: output.clone(),
        pages_processed,
        ocr_pages,
        char_count,
        alpha_count,
        text,
        warnings: Vec::new(),
    })
}

// GPU Runtime Manager
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuRuntimeCheck {
    pub id: String,
    pub label: String,
    pub status: String,
    pub message: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuRuntimeReport {
    pub llama_server_path: Option<String>,
    pub runtime_found: bool,
    pub supports_gpu_layers: bool,
    pub supports_cuda_hint: bool,
    pub supports_vulkan_hint: bool,
    pub supports_metal_hint: bool,
    pub supports_flash_attention: bool,
    pub nvidia_smi_ok: bool,
    pub nvidia_smi_summary: Option<String>,
    pub vulkaninfo_ok: bool,
    pub vulkaninfo_summary: Option<String>,
    pub detected_gpus: Vec<crate::hardware::GPUInfo>,
    pub selected_model_size_bytes: Option<u64>,
    pub recommended_gpu_layers: i32,
    pub recommended_context_size: i32,
    pub recommended_batch_size: i32,
    pub recommended_mode: String,
    pub auto_strategy: String,
    pub auto_gpu_layers: i32,
    pub auto_context_size: i32,
    pub auto_batch_size: i32,
    pub fit_status: String,
    pub estimated_total_vram_bytes: u64,
    pub estimated_available_vram_bytes: u64,
    pub estimated_available_ram_bytes: u64,
    pub warning: Option<String>,
    pub checks: Vec<GpuRuntimeCheck>,
}

fn gpu_check(id: &str, label: &str, status: &str, message: &str, detail: Option<String>) -> GpuRuntimeCheck {
    GpuRuntimeCheck {
        id: id.to_string(),
        label: label.to_string(),
        status: status.to_string(),
        message: message.to_string(),
        detail,
    }
}

fn run_command_for_gpu_probe(command: &str, args: &[&str], timeout_label: &str) -> (bool, Option<String>) {
    match StdCommand::new(command).args(args).output() {
        Ok(output) => {
            let mut text = String::new();
            text.push_str(&String::from_utf8_lossy(&output.stdout));
            if text.trim().is_empty() {
                text.push_str(&String::from_utf8_lossy(&output.stderr));
            }
            let first_lines = text.lines().take(8).collect::<Vec<_>>().join("\n");
            (output.status.success(), if first_lines.trim().is_empty() { Some(timeout_label.to_string()) } else { Some(first_lines) })
        }
        Err(e) => (false, Some(e.to_string())),
    }
}

fn estimate_layer_count_for_size(model_size_bytes: u64) -> i32 {
    let gb = model_size_bytes as f64 / 1_073_741_824.0;
    if gb <= 3.0 { 32 }
    else if gb <= 6.0 { 40 }
    else if gb <= 12.0 { 48 }
    else if gb <= 24.0 { 64 }
    else if gb <= 42.0 { 80 }
    else if gb <= 70.0 { 96 }
    else if gb <= 110.0 { 120 }
    else { 160 }
}

fn summed_vram(gpus: &[crate::hardware::GPUInfo]) -> (u64, u64) {
    let total = gpus.iter().map(|g| g.vram_total_bytes).sum::<u64>();
    let used = gpus.iter().map(|g| g.vram_used_bytes.min(g.vram_total_bytes)).sum::<u64>();
    (total, total.saturating_sub(used))
}

fn auto_fit_plan_for_model(
    model_size_bytes: Option<u64>,
    gpus: &[crate::hardware::GPUInfo],
    supports_gpu_layers: bool,
    available_ram_bytes: u64,
) -> (i32, i32, i32, String, String, Option<String>, u64, u64) {
    let (total_vram, free_vram) = summed_vram(gpus);
    let model_size = model_size_bytes.unwrap_or(0);

    if !supports_gpu_layers {
        return (
            0,
            2048,
            128,
            "CPU fallback".to_string(),
            "Runtime does not expose GPU-layer controls".to_string(),
            Some("NexusAI will run safely on CPU. To enable acceleration, bundle a CUDA or Vulkan llama.cpp runtime that supports GPU layer offload.".to_string()),
            total_vram,
            free_vram,
        );
    }

    if total_vram == 0 {
        return (
            0,
            2048,
            128,
            "CPU fallback".to_string(),
            "No measurable dedicated VRAM detected".to_string(),
            Some("NexusAI will use CPU mode. If this machine has an integrated GPU, Vulkan may still work when the Vulkan runtime and drivers are installed, but the app will not claim acceleration until it is confirmed.".to_string()),
            total_vram,
            free_vram,
        );
    }

    if model_size == 0 {
        let layers = if free_vram >= 24 * 1_073_741_824 { 999 } else if free_vram >= 12 * 1_073_741_824 { 48 } else if free_vram >= 8 * 1_073_741_824 { 32 } else { 16 };
        return (
            layers,
            if layers == 999 { 4096 } else { 2048 },
            if layers == 999 { 256 } else { 128 },
            "Automatic GPU-first mode".to_string(),
            "Selected model size is unknown; using a conservative GPU-first plan".to_string(),
            Some("Run Scan Models or import the local GGUF so NexusAI can calculate a more accurate automatic plan.".to_string()),
            total_vram,
            free_vram,
        );
    }

    let reserve = 2u64 * 1024 * 1024 * 1024;
    let usable_vram = if free_vram > reserve { free_vram - reserve } else { ((free_vram as f64) * 0.75) as u64 };
    let required_ram_floor = ((model_size as f64) * 1.15) as u64;
    let total_layers = estimate_layer_count_for_size(model_size);

    if usable_vram >= required_ram_floor {
        return (
            999,
            if model_size > 50 * 1_073_741_824 { 4096 } else { 8192 },
            256,
            "Full GPU offload".to_string(),
            "Model appears to fit in available combined GPU memory".to_string(),
            None,
            total_vram,
            free_vram,
        );
    }

    let ratio = (usable_vram as f64 / model_size as f64).clamp(0.0, 0.95);
    let layers = ((total_layers as f64 * ratio * 0.92).floor() as i32).clamp(0, total_layers.saturating_sub(1));
    if layers > 0 {
        return (
            layers,
            if model_size > 50 * 1_073_741_824 { 2048 } else { 4096 },
            128,
            "Automatic CPU + GPU split".to_string(),
            format!("NexusAI will offload about {layers} layers and keep the remaining model in system RAM"),
            Some("The model is larger than comfortable GPU memory, so NexusAI will try full GPU first, then partial GPU offload, then CPU fallback if needed.".to_string()),
            total_vram,
            free_vram,
        );
    }

    let enough_ram = available_ram_bytes >= required_ram_floor;
    (
        0,
        if enough_ram { 2048 } else { 1024 },
        if enough_ram { 128 } else { 64 },
        "CPU fallback".to_string(),
        if enough_ram { "Model does not fit GPU memory, but system RAM may be sufficient".to_string() } else { "Model may exceed available memory on this machine".to_string() },
        Some("NexusAI will not remove the model from the catalog. On this machine it may require a smaller quantization or stronger hardware with more combined RAM/VRAM.".to_string()),
        total_vram,
        free_vram,
    )
}

#[tauri::command]
pub async fn get_gpu_runtime_report(
    state: State<'_, AppState>,
    selected_model_path: Option<String>,
) -> AppResult<GpuRuntimeReport> {
    let mut checks = Vec::new();
    let binary_result = resolve_llama_server_binary_for_diagnostics();
    let (runtime_path, runtime_found, runtime_error) = match binary_result {
        Ok(path) => (Some(path), true, None),
        Err(e) => (None, false, Some(e)),
    };

    checks.push(gpu_check(
        "runtime_found",
        "llama.cpp runtime",
        if runtime_found { "pass" } else { "fail" },
        if runtime_found { "llama-server was found." } else { "llama-server is missing." },
        runtime_path.as_ref().map(|p| p.display().to_string()).or(runtime_error.clone()),
    ));

    let all_runtimes = all_llama_runtime_candidates_for_diagnostics();
    let runtime_summary = if all_runtimes.is_empty() {
        "No bundled runtimes found.".to_string()
    } else {
        all_runtimes.iter().map(|p| format!("{} / {}: {}", runtime_mode_from_path(p), runtime_arch_from_path(p), p.display())).collect::<Vec<_>>().join(" | ")
    };
    checks.push(gpu_check(
        "runtime_layout",
        "Universal runtime layout",
        if all_runtimes.len() >= 2 { "pass" } else if all_runtimes.len() == 1 { "info" } else { "fail" },
        if all_runtimes.len() >= 2 { "Multiple runtime modes are bundled, so NexusAI can auto-select the best available native runtime and fall back safely." } else if all_runtimes.len() == 1 { "One llama.cpp runtime is bundled. NexusAI will work with that runtime, but full automatic selection requires Windows CPU/CUDA/Vulkan folders or macOS arm64/x64 CPU/Metal folders." } else { "No llama.cpp runtime was found." },
        Some(runtime_summary),
    ));

    let mut help_text = String::new();
    if let Some(path) = &runtime_path {
        match StdCommand::new(path).arg("--help").output() {
            Ok(output) => {
                help_text.push_str(&String::from_utf8_lossy(&output.stdout));
                help_text.push_str(&String::from_utf8_lossy(&output.stderr));
                checks.push(gpu_check("runtime_help", "Runtime starts", if output.status.success() { "pass" } else { "warning" }, if output.status.success() { "llama-server responds to --help." } else { "llama-server started but returned a non-success status for --help." }, None));
            }
            Err(e) => {
                checks.push(gpu_check("runtime_help", "Runtime starts", "fail", "llama-server could not be executed. Required DLLs may be missing, blocked, or placed in the wrong runtime folder.", Some(e.to_string())));
            }
        }
    }

    let help_lower = help_text.to_lowercase();
    let supports_gpu_layers = help_lower.contains("gpu-layers") || help_lower.contains("ngl") || help_lower.contains("n-gpu-layers");
    let supports_cuda_hint = help_lower.contains("cuda") || help_lower.contains("cublas") || help_lower.contains("ggml_cuda");
    let supports_vulkan_hint = help_lower.contains("vulkan") || help_lower.contains("ggml_vulkan");
    let supports_metal_hint = help_lower.contains("metal") || help_lower.contains("ggml_metal");
    let supports_flash_attention = help_lower.contains("flash-attn") || help_lower.contains("flash attention");

    checks.push(gpu_check(
        "gpu_layer_flag",
        "GPU layer control",
        if supports_gpu_layers { "pass" } else { "warning" },
        if supports_gpu_layers { "The runtime accepts GPU layer/offload flags." } else { "The runtime did not advertise GPU layer flags in --help." },
        None,
    ));

    checks.push(gpu_check(
        "backend_hint",
        "Runtime backend hint",
        if supports_cuda_hint || supports_vulkan_hint || supports_metal_hint { "pass" } else { "info" },
        if supports_cuda_hint || supports_vulkan_hint || supports_metal_hint { "The runtime help text hints at a GPU backend." } else { "No CUDA/Vulkan/Metal hint was found in --help for the selected runtime. Some builds do not expose this clearly, so confirm with a small model and Runtime diagnostics." },
        Some(format!("CUDA hint: {supports_cuda_hint}, Vulkan hint: {supports_vulkan_hint}, Metal hint: {supports_metal_hint}, Flash attention: {supports_flash_attention}")),
    ));

    let (nvidia_smi_ok, nvidia_smi_summary) = run_command_for_gpu_probe("nvidia-smi", &["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader"], "nvidia-smi returned no text");
    checks.push(gpu_check(
        "nvidia_smi",
        "NVIDIA driver check",
        if nvidia_smi_ok { "pass" } else { "info" },
        if nvidia_smi_ok { "nvidia-smi works, so NVIDIA driver detection is available." } else { "nvidia-smi was not available. This is normal on AMD/Intel/CPU-only systems." },
        nvidia_smi_summary.clone(),
    ));

    let (vulkaninfo_ok, vulkaninfo_summary) = run_command_for_gpu_probe("vulkaninfo", &["--summary"], "vulkaninfo returned no text");
    checks.push(gpu_check(
        "vulkaninfo",
        "Vulkan tool check",
        if vulkaninfo_ok { "pass" } else { "info" },
        if vulkaninfo_ok { "vulkaninfo works, so Vulkan diagnostics are available." } else { "vulkaninfo is not installed or not on PATH. Vulkan may still work if drivers are installed." },
        vulkaninfo_summary.clone(),
    ));

    #[cfg(target_os = "macos")]
    {
        let (metal_info_ok, metal_info_summary) = run_command_for_gpu_probe("system_profiler", &["SPDisplaysDataType"], "system_profiler returned no display information");
        checks.push(gpu_check(
            "macos_metal",
            "macOS Metal check",
            if metal_info_ok { "pass" } else { "info" },
            if metal_info_ok { "macOS display/GPU information is available. Bundle native arm64 runtimes for Apple Silicon and native x64 runtimes for Intel Mac support." } else { "macOS GPU details could not be read. CPU mode remains supported, and Metal can still be tested with the matching native macOS runtime." },
            metal_info_summary,
        ));
    }

    #[cfg(not(target_os = "macos"))]
    {
        checks.push(gpu_check(
            "macos_metal",
            "macOS Metal check",
            "info",
            "Metal acceleration is a macOS runtime option. On Windows, NexusAI uses CUDA or Vulkan when available.",
            None,
        ));
    }

    let info = {
        let mut hw = state.hardware.lock().await;
        hw.get_system_info()
    };
    let model_size = selected_model_path
        .as_ref()
        .and_then(|p| std::fs::metadata(p).ok().map(|m| m.len()));
    let (recommended_gpu_layers, recommended_context_size, recommended_batch_size, recommended_mode, fit_status, warning, total_vram, free_vram) =
        auto_fit_plan_for_model(model_size, &info.gpus, supports_gpu_layers, info.memory.available_bytes);

    if info.gpus.is_empty() {
        checks.push(gpu_check("gpu_detected", "GPU detected", "info", "No dedicated GPU was detected by the app scanner. CPU mode remains safe and fully supported.", None));
    } else {
        let detail = info.gpus.iter().map(|g| {
            let vram = g.vram_total_bytes as f64 / 1_073_741_824.0;
            format!("{} {} ({:.1} GB VRAM)", g.vendor, g.name, vram)
        }).collect::<Vec<_>>().join(" | ");
        checks.push(gpu_check("gpu_detected", "GPU detected", "pass", "At least one GPU was detected.", Some(detail)));
    }

    checks.push(gpu_check(
        "recommended_mode",
        "Automatic optimization plan",
        if recommended_gpu_layers == 0 { "info" } else { "pass" },
        &format!("Automatic plan: {recommended_mode} with GPU layers set to {recommended_gpu_layers}."),
        Some(format!("{fit_status}. NexusAI will still attempt safe fallback if the first launch plan fails.")),
    ));

    Ok(GpuRuntimeReport {
        llama_server_path: runtime_path.map(|p| p.display().to_string()),
        runtime_found,
        supports_gpu_layers,
        supports_cuda_hint,
        supports_vulkan_hint,
        supports_metal_hint,
        supports_flash_attention,
        nvidia_smi_ok,
        nvidia_smi_summary,
        vulkaninfo_ok,
        vulkaninfo_summary,
        detected_gpus: info.gpus,
        selected_model_size_bytes: model_size,
        recommended_gpu_layers,
        recommended_context_size,
        recommended_batch_size,
        recommended_mode: recommended_mode.clone(),
        auto_strategy: if recommended_gpu_layers == 999 { "Try full GPU first; fall back only if needed.".to_string() } else if recommended_gpu_layers > 0 { "Try full GPU first, then automatic CPU + GPU split, then CPU fallback.".to_string() } else { "Use CPU fallback unless a compatible GPU runtime becomes available.".to_string() },
        auto_gpu_layers: recommended_gpu_layers,
        auto_context_size: recommended_context_size,
        auto_batch_size: recommended_batch_size,
        fit_status,
        estimated_total_vram_bytes: total_vram,
        estimated_available_vram_bytes: free_vram,
        estimated_available_ram_bytes: info.memory.available_bytes,
        warning,
        checks,
    })
}
