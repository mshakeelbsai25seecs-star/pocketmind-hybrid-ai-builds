use crate::database::Database;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEPLOY_MODE_WORKSTATION: &str = "workstation";
pub const DEPLOY_MODE_SERVER: &str = "server";

/// Dev-tree Windows storage root — used only when it already exists (local developer installs).
#[cfg(target_os = "windows")]
pub const WINDOWS_DEV_DATA_ROOT: &str = r"D:\nexus-ai-deep-fixed\runtime-data";

/// Previous brand folder name — kept so upgrades still find existing installs.
#[cfg(target_os = "windows")]
pub const WINDOWS_LEGACY_DATA_ROOT: &str = r"D:\NexusAI";

const KEY_MODE: &str = "deploy.mode";
const KEY_DATA_ROOT: &str = "deploy.data_root";
const KEY_MODELS_DIR: &str = "deploy.models_dir";
const KEY_EMBEDDING_MODEL: &str = "deploy.embedding_model_path";
const KEY_SOC_DATA_ROOT: &str = "deploy.soc_data_root";
const KEY_SOC_INTAKE_SUBDIR: &str = "deploy.soc_intake_subdir";
const KEY_EXPORT_DIR: &str = "deploy.export_dir";
const KEY_DENSE_INDEX: &str = "deploy.dense_index_path";
const KEY_CONTEXT_SIZE: &str = "deploy.context_size";
const KEY_MAX_TOKENS: &str = "deploy.max_tokens";
const KEY_GPU_LAYERS: &str = "deploy.gpu_layers";
const KEY_BATCH_SIZE: &str = "deploy.batch_size";
const KEY_THREADS: &str = "deploy.threads";
const KEY_TEMPERATURE: &str = "deploy.temperature";
const KEY_RETRIEVAL_TOP_K: &str = "deploy.retrieval_top_k";
const KEY_EMBED_CONTEXT: &str = "deploy.embed_context_size";
const KEY_MAX_SNIPPET: &str = "deploy.max_snippet_chars";
const KEY_RERANKER_MODEL: &str = "deploy.reranker_model_path";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentConfig {
    pub deployment_mode: String,
    pub data_root: String,
    pub models_dir: String,
    pub embedding_model_path: String,
    pub soc_data_root: String,
    pub soc_intake_subdir: String,
    pub export_dir: String,
    pub dense_index_path: String,
    pub context_size: u32,
    pub max_tokens: u32,
    pub gpu_layers: i32,
    pub batch_size: u32,
    pub threads: u32,
    pub temperature: f32,
    pub retrieval_top_k: u32,
    pub embed_context_size: u32,
    pub max_snippet_chars: u32,
    pub reranker_model_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentPaths {
    pub data_root: String,
    pub models_dir: String,
    pub embedding_model_path: String,
    pub soc_data_root: String,
    pub soc_intake_root: String,
    pub export_dir: String,
    pub dense_index_path: String,
    pub knowledge_db_dir: String,
    pub app_db_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentEnsureResult {
    pub created: Vec<String>,
    pub existing: Vec<String>,
}

pub fn default_data_root() -> PathBuf {
    preferred_data_root()
}

/// True when a system data root already exists as writable, or can be created.
#[cfg(target_os = "linux")]
fn linux_system_data_root_usable(path: &Path) -> bool {
    if path.is_dir() {
        let probe = path.join(".pocketmind_write_probe");
        match std::fs::write(&probe, b"") {
            Ok(()) => {
                let _ = std::fs::remove_file(&probe);
                true
            }
            Err(_) => false,
        }
    } else if path.exists() {
        false
    } else {
        std::fs::create_dir_all(path).is_ok()
    }
}

/// Resolve the active PocketMind Hybrid AI data root (`NEXUS_DATA_ROOT`, else platform default).
/// If a legacy NexusAI root already exists and the new root does not, keep using the legacy root.
pub fn preferred_data_root() -> PathBuf {
    if let Ok(value) = std::env::var("NEXUS_DATA_ROOT") {
        if !value.trim().is_empty() {
            return PathBuf::from(value.trim());
        }
    }
    #[cfg(target_os = "windows")]
    {
        let portable = dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
            .join("PocketMind");
        let dev = PathBuf::from(WINDOWS_DEV_DATA_ROOT);
        let legacy = PathBuf::from(WINDOWS_LEGACY_DATA_ROOT);
        // Prefer an already-initialized install so upgrades do not relocate data.
        if portable.exists() {
            return portable;
        }
        if dev.exists() {
            return dev;
        }
        if legacy.exists() {
            return legacy;
        }
        let _ = std::fs::create_dir_all(&portable);
        return portable;
    }
    #[cfg(target_os = "macos")]
    {
        let server_mode = std::env::var("NEXUS_DEPLOY_MODE")
            .map(|v| v.eq_ignore_ascii_case("server"))
            .unwrap_or(false);
        if server_mode {
            let root = PathBuf::from("/Library/Application Support/PocketMind");
            let legacy = PathBuf::from("/Library/Application Support/NexusAI");
            if !root.exists() && legacy.exists() {
                return legacy;
            }
            return root;
        }
        let root = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("PocketMind");
        let legacy = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("NexusAI");
        if !root.exists() && legacy.exists() {
            return legacy;
        }
        return root;
    }
    #[cfg(target_os = "linux")]
    {
        let server_mode = std::env::var("NEXUS_DEPLOY_MODE")
            .map(|v| v.eq_ignore_ascii_case("server"))
            .unwrap_or(false);
        let system_root = PathBuf::from("/var/lib/pocketmind");
        let system_legacy = PathBuf::from("/var/lib/nexusai");
        if server_mode
            || linux_system_data_root_usable(&system_root)
            || (system_legacy.exists() && linux_system_data_root_usable(&system_legacy))
        {
            if !system_root.exists() && system_legacy.exists() {
                return system_legacy;
            }
            if server_mode || linux_system_data_root_usable(&system_root) {
                return system_root;
            }
            return system_legacy;
        }
        let root = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("PocketMind");
        let legacy = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("NexusAI");
        if !root.exists() && legacy.exists() {
            return legacy;
        }
        return root;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let root = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("PocketMind");
        let legacy = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("NexusAI");
        if !root.exists() && legacy.exists() {
            return legacy;
        }
        root
    }
}

/// SQLite and local app state (settings, KC collections metadata).
pub fn app_database_dir() -> PathBuf {
    preferred_data_root().join("app-data")
}

/// On-disk HNSW vector indexes for Knowledge Chat.
pub fn hnsw_index_dir() -> PathBuf {
    preferred_data_root().join("knowledge-chat").join("hnsw")
}

/// Process caches (ONNX runtime, temp artifacts) — kept off the system drive when possible.
pub fn process_cache_dir() -> PathBuf {
    preferred_data_root().join("cache")
}

/// Scratch space for OCR, PDF conversion, and other temp artifacts.
pub fn process_temp_dir() -> PathBuf {
    let tmp = process_cache_dir().join("tmp");
    let _ = std::fs::create_dir_all(&tmp);
    tmp
}

/// Point heavyweight runtime caches at the deployment data root (call once at process start).
pub fn configure_process_storage_env() {
    let cache = process_cache_dir();
    let _ = std::fs::create_dir_all(&cache);
    let ort_cache = cache.join("ort");
    let _ = std::fs::create_dir_all(&ort_cache);
    std::env::set_var(
        "ORT_DYLIB_CACHE_DIR",
        ort_cache.to_string_lossy().to_string(),
    );
    let tmp = process_temp_dir();
    let tmp_str = tmp.to_string_lossy().to_string();
    std::env::set_var("NEXUS_TMP", &tmp_str);
    #[cfg(target_os = "windows")]
    {
        for key in ["TEMP", "TMP", "TMPDIR"] {
            std::env::set_var(key, &tmp_str);
        }
    }
}

/// Pre-rebrand AppData folder (`NexusAI`) used for database/index migration.
pub fn legacy_app_database_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("NexusAI")
}

pub fn legacy_hnsw_dir() -> PathBuf {
    legacy_app_database_dir().join("knowledge_hnsw")
}

#[cfg(target_os = "windows")]
pub fn legacy_programdata_root() -> PathBuf {
    std::env::var("PROGRAMDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(r"C:\ProgramData"))
        .join("NexusAI")
}

fn join_path(base: &Path, parts: &[&str]) -> String {
    let mut path = base.to_path_buf();
    for part in parts {
        path = path.join(part);
    }
    normalize_path_string(&path.to_string_lossy())
}

pub fn normalize_path_string(path: &str) -> String {
    let trimmed = path.trim();
    #[cfg(target_os = "windows")]
    {
        trimmed.replace('/', "\\")
    }
    #[cfg(not(target_os = "windows"))]
    {
        trimmed.replace('\\', "/")
    }
}

pub fn normalize_path_for_check(path: &str) -> String {
    normalize_path_string(path).to_lowercase()
}

pub fn default_config() -> DeploymentConfig {
    let data_root = default_data_root();
    let data_root_str = normalize_path_string(&data_root.to_string_lossy());
    let models_dir = join_path(&data_root, &["models"]);
    // Code partition prefers Qwen3-Embedding-8B; docs still resolve BGE-M3 via
    // prefer_knowledge_embedding_model. Legacy single-path default points at Qwen3.
    let embedding_model_path = join_path(
        &data_root,
        &["models", "embeddings", "Qwen3-Embedding-8B-Q4_K_M.gguf"],
    );
    let soc_data_root = join_path(&data_root, &["company-data"]);
    let export_dir = join_path(&data_root, &["exports"]);
    let dense_index_path = join_path(&data_root, &["indexes", "nexus-soc-dense-index.json"]);
    let reranker_model_path = join_path(
        &data_root,
        &["models", "rerankers", "Qwen3-Reranker-4B-Q4_K_M.gguf"],
    );

    let (context_size, max_tokens, gpu_layers, batch_size) = if std::env::var("NEXUS_DEPLOY_MODE")
        .map(|v| v.eq_ignore_ascii_case("server"))
        .unwrap_or(false)
    {
        (8192, 1024, -1, 256)
    } else {
        (4096, 512, -1, 128)
    };

    DeploymentConfig {
        deployment_mode: DEPLOY_MODE_SERVER.to_string(),
        data_root: data_root_str,
        models_dir,
        embedding_model_path,
        soc_data_root,
        soc_intake_subdir: "intake".to_string(),
        export_dir,
        dense_index_path,
        context_size,
        max_tokens,
        gpu_layers,
        batch_size,
        threads: 0,
        temperature: 0.35,
        retrieval_top_k: 10,
        embed_context_size: 2048,
        max_snippet_chars: 1400,
        reranker_model_path,
    }
}

impl DeploymentConfig {
    pub fn soc_intake_root(&self) -> String {
        join_path(
            Path::new(&self.soc_data_root),
            &[self.soc_intake_subdir.trim().trim_matches(['\\', '/']).as_ref()],
        )
    }

    pub fn allowed_roots(&self) -> Vec<String> {
        let mut roots = vec![
            self.data_root.clone(),
            self.models_dir.clone(),
            self.soc_data_root.clone(),
            self.export_dir.clone(),
        ];
        roots.push(self.soc_intake_root());
        let preferred = normalize_path_string(&preferred_data_root().to_string_lossy());
        if !preferred.is_empty() {
            roots.push(preferred);
        }
        if let Ok(extra) = std::env::var("NEXUS_ALLOWED_PATHS") {
            for part in extra.split(';').chain(extra.split(':')) {
                let trimmed = part.trim();
                if !trimmed.is_empty() {
                    roots.push(normalize_path_string(trimmed));
                }
            }
        }
        roots.sort();
        roots.dedup();
        roots
    }

    pub fn is_path_allowed(&self, path: &str) -> bool {
        if contains_parent_traversal(path) {
            return false;
        }
        let normalized = resolve_path_for_policy(path)
            .map(|value| normalize_path_for_check(&value.to_string_lossy()))
            .unwrap_or_else(|| normalize_path_for_check(path));
        if normalized.is_empty() {
            return false;
        }
        for root in self.allowed_roots() {
            let root_norm = resolve_path_for_policy(&root)
                .map(|value| normalize_path_for_check(&value.to_string_lossy()))
                .unwrap_or_else(|| normalize_path_for_check(&root));
            if root_norm.is_empty() {
                continue;
            }
            if normalized == root_norm {
                return true;
            }
            let separator = if normalized.contains('\\') { '\\' } else { '/' };
            let with_sep = format!("{}{}", root_norm.trim_end_matches(['\\', '/']), separator);
            if normalized.starts_with(&with_sep) {
                return true;
            }
        }
        false
    }
}

fn contains_parent_traversal(path: &str) -> bool {
    path.replace('\\', "/")
        .split('/')
        .any(|segment| segment == "..")
}

fn resolve_path_for_policy(path: &str) -> Option<std::path::PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = std::path::PathBuf::from(trimmed);
    if candidate.exists() {
        return std::fs::canonicalize(&candidate).ok();
    }
    Some(candidate)
}

pub fn resolve_paths(config: &DeploymentConfig) -> DeploymentPaths {
    let app_db_dir = app_database_dir()
        .to_string_lossy()
        .to_string();

    DeploymentPaths {
        data_root: config.data_root.clone(),
        models_dir: config.models_dir.clone(),
        embedding_model_path: config.embedding_model_path.clone(),
        soc_data_root: config.soc_data_root.clone(),
        soc_intake_root: config.soc_intake_root(),
        export_dir: config.export_dir.clone(),
        dense_index_path: config.dense_index_path.clone(),
        knowledge_db_dir: join_path(Path::new(&config.data_root), &["knowledge-chat"]),
        app_db_dir: normalize_path_string(&app_db_dir),
    }
}

pub fn load_deployment_config(db: &Database) -> DeploymentConfig {
    let mut config = default_config();

    if let Ok(Some(value)) = db.get_setting(KEY_MODE) {
        if !value.trim().is_empty() {
            config.deployment_mode = value;
        }
    }
    if let Ok(Some(value)) = db.get_setting(KEY_DATA_ROOT) {
        if !value.trim().is_empty() {
            config.data_root = normalize_path_string(&value);
        }
    }
    if let Ok(Some(value)) = db.get_setting(KEY_MODELS_DIR) {
        if !value.trim().is_empty() {
            config.models_dir = normalize_path_string(&value);
        }
    }
    if let Ok(Some(value)) = db.get_setting(KEY_EMBEDDING_MODEL) {
        if !value.trim().is_empty() {
            config.embedding_model_path = normalize_path_string(&value);
        }
    }
    if let Ok(Some(value)) = db.get_setting(KEY_SOC_DATA_ROOT) {
        if !value.trim().is_empty() {
            config.soc_data_root = normalize_path_string(&value);
        }
    }
    if let Ok(Some(value)) = db.get_setting(KEY_SOC_INTAKE_SUBDIR) {
        if !value.trim().is_empty() {
            config.soc_intake_subdir = value;
        }
    }
    if let Ok(Some(value)) = db.get_setting(KEY_EXPORT_DIR) {
        if !value.trim().is_empty() {
            config.export_dir = normalize_path_string(&value);
        }
    }
    if let Ok(Some(value)) = db.get_setting(KEY_DENSE_INDEX) {
        if !value.trim().is_empty() {
            config.dense_index_path = normalize_path_string(&value);
        }
    }
    if let Ok(Some(value)) = db.get_setting(KEY_RERANKER_MODEL) {
        if !value.trim().is_empty() {
            config.reranker_model_path = normalize_path_string(&value);
        }
    }

    config.context_size = read_u32_setting(db, KEY_CONTEXT_SIZE, config.context_size);
    config.max_tokens = read_u32_setting(db, KEY_MAX_TOKENS, config.max_tokens);
    config.gpu_layers = read_i32_setting(db, KEY_GPU_LAYERS, config.gpu_layers);
    config.batch_size = read_u32_setting(db, KEY_BATCH_SIZE, config.batch_size);
    config.threads = read_u32_setting(db, KEY_THREADS, config.threads);
    config.temperature = read_f32_setting(db, KEY_TEMPERATURE, config.temperature);
    config.retrieval_top_k = read_u32_setting(db, KEY_RETRIEVAL_TOP_K, config.retrieval_top_k);
    config.embed_context_size = read_u32_setting(db, KEY_EMBED_CONTEXT, config.embed_context_size);
    config.max_snippet_chars = read_u32_setting(db, KEY_MAX_SNIPPET, config.max_snippet_chars);

    apply_env_overrides(&mut config);
    // Mirror the GPU offload policy into the shared runtime selector so Knowledge
    // Chat embedding servers honor the same gpu_layers the Runtime page uses for chat.
    crate::llm::runtime_discovery::set_embed_gpu_layers(config.gpu_layers);
    config
}

fn apply_env_overrides(config: &mut DeploymentConfig) {
    if let Ok(value) = std::env::var("NEXUS_DATA_ROOT") {
        if !value.trim().is_empty() {
            config.data_root = normalize_path_string(&value);
        }
    }
    if let Ok(value) = std::env::var("NEXUS_MODELS_DIR") {
        if !value.trim().is_empty() {
            config.models_dir = normalize_path_string(&value);
        }
    }
    if let Ok(value) = std::env::var("NEXUS_SOC_DATA_ROOT") {
        if !value.trim().is_empty() {
            config.soc_data_root = normalize_path_string(&value);
        }
    }
    if let Ok(value) = std::env::var("NEXUS_EXPORT_DIR") {
        if !value.trim().is_empty() {
            config.export_dir = normalize_path_string(&value);
        }
    }
    if let Ok(value) = std::env::var("NEXUS_EMBEDDING_MODEL") {
        if !value.trim().is_empty() {
            config.embedding_model_path = normalize_path_string(&value);
        }
    }
    if let Ok(value) = std::env::var("NEXUS_CONTEXT_SIZE") {
        if let Ok(parsed) = value.parse::<u32>() {
            config.context_size = parsed;
        }
    }
    if let Ok(value) = std::env::var("NEXUS_MAX_TOKENS") {
        if let Ok(parsed) = value.parse::<u32>() {
            config.max_tokens = parsed;
        }
    }
    if let Ok(value) = std::env::var("NEXUS_GPU_LAYERS") {
        if let Ok(parsed) = value.trim().parse::<i32>() {
            config.gpu_layers = parsed;
        }
    }
}

pub fn save_deployment_config(db: &Database, config: &DeploymentConfig) -> rusqlite::Result<()> {
    db.set_setting(KEY_MODE, &config.deployment_mode)?;
    db.set_setting(KEY_DATA_ROOT, &config.data_root)?;
    db.set_setting(KEY_MODELS_DIR, &config.models_dir)?;
    db.set_setting(KEY_EMBEDDING_MODEL, &config.embedding_model_path)?;
    db.set_setting(KEY_SOC_DATA_ROOT, &config.soc_data_root)?;
    db.set_setting(KEY_SOC_INTAKE_SUBDIR, &config.soc_intake_subdir)?;
    db.set_setting(KEY_EXPORT_DIR, &config.export_dir)?;
    db.set_setting(KEY_DENSE_INDEX, &config.dense_index_path)?;
    db.set_setting(KEY_CONTEXT_SIZE, &config.context_size.to_string())?;
    db.set_setting(KEY_MAX_TOKENS, &config.max_tokens.to_string())?;
    db.set_setting(KEY_GPU_LAYERS, &config.gpu_layers.to_string())?;
    db.set_setting(KEY_BATCH_SIZE, &config.batch_size.to_string())?;
    db.set_setting(KEY_THREADS, &config.threads.to_string())?;
    db.set_setting(KEY_TEMPERATURE, &config.temperature.to_string())?;
    db.set_setting(KEY_RETRIEVAL_TOP_K, &config.retrieval_top_k.to_string())?;
    db.set_setting(KEY_EMBED_CONTEXT, &config.embed_context_size.to_string())?;
    db.set_setting(KEY_MAX_SNIPPET, &config.max_snippet_chars.to_string())?;
    db.set_setting(KEY_RERANKER_MODEL, &config.reranker_model_path)?;
    Ok(())
}

pub fn ensure_deployment_directories(config: &DeploymentConfig) -> std::io::Result<DeploymentEnsureResult> {
    let paths = resolve_paths(config);
    let dense_parent = Path::new(&paths.dense_index_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| paths.data_root.clone());
    let embedding_parent = Path::new(&paths.embedding_model_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| join_path(Path::new(&paths.models_dir), &["embeddings"]));
    let reranker_parent = Path::new(&config.reranker_model_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| join_path(Path::new(&paths.models_dir), &["rerankers"]));

    let mut dir_paths = vec![
        paths.data_root.clone(),
        paths.models_dir.clone(),
        embedding_parent,
        reranker_parent,
        paths.soc_data_root.clone(),
        paths.soc_intake_root.clone(),
        paths.export_dir.clone(),
        paths.knowledge_db_dir.clone(),
        dense_parent,
        normalize_path_string(&app_database_dir().to_string_lossy()),
        normalize_path_string(&hnsw_index_dir().to_string_lossy()),
        normalize_path_string(&process_cache_dir().to_string_lossy()),
    ];
    dir_paths.sort();
    dir_paths.dedup();

    let mut created = Vec::new();
    let mut existing = Vec::new();

    for dir in dir_paths {
        let path = Path::new(&dir);
        if path.exists() {
            existing.push(normalize_path_string(&dir));
        } else {
            std::fs::create_dir_all(path)?;
            created.push(normalize_path_string(&dir));
        }
    }

    Ok(DeploymentEnsureResult { created, existing })
}

fn read_u32_setting(db: &Database, key: &str, fallback: u32) -> u32 {
    db.get_setting(key)
        .ok()
        .flatten()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(fallback)
}

fn read_i32_setting(db: &Database, key: &str, fallback: i32) -> i32 {
    db.get_setting(key)
        .ok()
        .flatten()
        .and_then(|value| value.parse::<i32>().ok())
        .unwrap_or(fallback)
}

fn read_f32_setting(db: &Database, key: &str, fallback: f32) -> f32 {
    db.get_setting(key)
        .ok()
        .flatten()
        .and_then(|value| value.parse::<f32>().ok())
        .unwrap_or(fallback)
}

fn path_under_root(path: &str, root: &str) -> bool {
    let path_norm = normalize_path_for_check(path);
    let root_norm = normalize_path_for_check(root);
    if path_norm.is_empty() || root_norm.is_empty() {
        return false;
    }
    if path_norm == root_norm {
        return true;
    }
    let sep = if path_norm.contains('\\') { '\\' } else { '/' };
    path_norm.starts_with(&format!(
        "{}{}",
        root_norm.trim_end_matches(['\\', '/']),
        sep
    ))
}

fn remap_path_under_root(path: &str, old_root: &str, new_root: &str) -> String {
    if !path_under_root(path, old_root) {
        return normalize_path_string(path);
    }
    let path_norm = normalize_path_string(path);
    let old_norm = normalize_path_string(old_root).trim_end_matches(['\\', '/']).to_string();
    let suffix = path_norm
        .strip_prefix(&old_norm)
        .unwrap_or(path)
        .trim_start_matches(['\\', '/']);
    if suffix.is_empty() {
        normalize_path_string(new_root)
    } else {
        join_path(Path::new(new_root), &[suffix])
    }
}

fn copy_file_if_missing(src: &Path, dest: &Path) -> std::io::Result<bool> {
    if dest.exists() {
        return Ok(false);
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, dest)?;
    Ok(true)
}

fn copy_tree_if_missing(src: &Path, dest: &Path) -> std::io::Result<usize> {
    if !src.exists() {
        return Ok(0);
    }
    let mut copied = 0usize;
    if src.is_file() {
        if copy_file_if_missing(src, dest)? {
            copied += 1;
        }
        return Ok(copied);
    }
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let child_src = entry.path();
        let child_dest = dest.join(entry.file_name());
        if child_src.is_dir() {
            copied += copy_tree_if_missing(&child_src, &child_dest)?;
        } else if copy_file_if_missing(&child_src, &child_dest)? {
            copied += 1;
        }
    }
    Ok(copied)
}

/// Copy `app.db` (+ WAL sidecars) from legacy %AppData%\\NexusAI when upgrading storage layout.
pub fn migrate_app_database_files() -> std::io::Result<()> {
    let target_dir = app_database_dir();
    std::fs::create_dir_all(&target_dir)?;
    let legacy_dir = legacy_app_database_dir();
    let target_db = target_dir.join("app.db");
    if target_db.exists() {
        return Ok(());
    }
    let legacy_db = legacy_dir.join("app.db");
    if !legacy_db.exists() {
        return Ok(());
    }
    copy_file_if_missing(&legacy_db, &target_db)?;
    for sidecar in ["-wal", "-shm"] {
        let name = format!("app.db{sidecar}");
        let _ = copy_file_if_missing(&legacy_dir.join(&name), &target_dir.join(&name));
    }
    log::info!(
        "Migrated app database from {} to {}",
        legacy_dir.display(),
        target_dir.display()
    );
    Ok(())
}

/// Copy HNSW indexes from legacy AppData location into the deployment data root.
pub fn migrate_hnsw_indexes() -> std::io::Result<usize> {
    let src = legacy_hnsw_dir();
    let dest = hnsw_index_dir();
    if !src.exists() {
        return Ok(0);
    }
    let copied = copy_tree_if_missing(&src, &dest)?;
    if copied > 0 {
        log::info!(
            "Copied {copied} HNSW index file(s) from {} to {}",
            src.display(),
            dest.display()
        );
    }
    Ok(copied)
}

fn legacy_storage_roots() -> Vec<String> {
    let mut roots = Vec::new();
    #[cfg(target_os = "windows")]
    {
        roots.push(normalize_path_string(
            &legacy_programdata_root().to_string_lossy(),
        ));
        roots.push(normalize_path_string(WINDOWS_LEGACY_DATA_ROOT));
    }
    #[cfg(target_os = "macos")]
    {
        roots.push(normalize_path_string(
            "/Library/Application Support/NexusAI",
        ));
    }
    #[cfg(target_os = "linux")]
    {
        roots.push(normalize_path_string("/var/lib/nexusai"));
    }
    roots.push(normalize_path_string(
        &legacy_app_database_dir().to_string_lossy(),
    ));
    roots.sort();
    roots.dedup();
    roots
}

/// After the DB is available, remap deployment paths off C: and copy heavy folders to D: when needed.
pub fn migrate_legacy_storage_on_startup(db: &Database) -> rusqlite::Result<()> {
    let _ = migrate_app_database_files();
    let _ = migrate_hnsw_indexes();

    let preferred = normalize_path_string(&preferred_data_root().to_string_lossy());
    let mut config = load_deployment_config(db);
    let mut changed = false;

    for legacy in legacy_storage_roots() {
        if legacy.is_empty() || legacy.eq_ignore_ascii_case(&preferred) {
            continue;
        }
        if path_under_root(&config.data_root, &legacy) {
            config.data_root = remap_path_under_root(&config.data_root, &legacy, &preferred);
            changed = true;
        }
        if path_under_root(&config.models_dir, &legacy) {
            config.models_dir = remap_path_under_root(&config.models_dir, &legacy, &preferred);
            changed = true;
        }
        if path_under_root(&config.embedding_model_path, &legacy) {
            config.embedding_model_path =
                remap_path_under_root(&config.embedding_model_path, &legacy, &preferred);
            changed = true;
        }
        if path_under_root(&config.soc_data_root, &legacy) {
            config.soc_data_root = remap_path_under_root(&config.soc_data_root, &legacy, &preferred);
            changed = true;
        }
        if path_under_root(&config.export_dir, &legacy) {
            config.export_dir = remap_path_under_root(&config.export_dir, &legacy, &preferred);
            changed = true;
        }
        if path_under_root(&config.dense_index_path, &legacy) {
            config.dense_index_path =
                remap_path_under_root(&config.dense_index_path, &legacy, &preferred);
            changed = true;
        }
        if path_under_root(&config.reranker_model_path, &legacy) {
            config.reranker_model_path =
                remap_path_under_root(&config.reranker_model_path, &legacy, &preferred);
            changed = true;
        }

        let legacy_path = Path::new(&legacy);
        if legacy_path.exists() {
            let copied_models = copy_tree_if_missing(&legacy_path.join("models"), &Path::new(&config.models_dir))
                .unwrap_or(0);
            let copied_indexes = copy_tree_if_missing(
                &legacy_path.join("indexes"),
                &Path::new(&join_path(Path::new(&config.data_root), &["indexes"])),
            )
            .unwrap_or(0);
            let copied_company = copy_tree_if_missing(
                &legacy_path.join("company-data"),
                &Path::new(&config.soc_data_root),
            )
            .unwrap_or(0);
            if copied_models > 0 || copied_indexes > 0 || copied_company > 0 {
                log::info!(
                    "Copied legacy storage from {legacy} (models={copied_models}, indexes={copied_indexes}, company-data={copied_company})"
                );
            }
        }
    }

    if config.data_root.trim().is_empty() {
        config = default_config();
        changed = true;
    }

    if let Ok(Some(kc_embed)) = db.get_setting("kc_default_embedding_model") {
        for legacy in legacy_storage_roots() {
            if path_under_root(&kc_embed, &legacy) {
                let new_path = remap_path_under_root(&kc_embed, &legacy, &preferred);
                let _ = db.set_setting("kc_default_embedding_model", &new_path);
                break;
            }
        }
    }

    if changed {
        save_deployment_config(db, &config)?;
        log::info!("Deployment paths now use storage root: {preferred}");
    }

    let _ = ensure_deployment_directories(&config);
    Ok(())
}
