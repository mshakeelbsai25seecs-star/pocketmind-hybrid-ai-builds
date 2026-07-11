use crate::database::Database;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

const KEY_BLOCK_LOW_CONF: &str = "product.block_low_confidence";
const KEY_MIN_CONF_SCORE: &str = "product.min_confidence_score";
const KEY_AUDIT_ENABLED: &str = "product.audit_log_enabled";
const KEY_ALLOW_INTENT_SHORT_CIRCUIT: &str = "product.allow_intent_short_circuit";
const KEY_ENABLE_LLM_QUERY_EXPAND: &str = "product.enable_llm_query_expand";
const KEY_FOLDER_AGNOSTIC_MODE: &str = "product.folder_agnostic_mode";
const KEY_ENABLE_HYDE: &str = "product.enable_hyde";
const KEY_MIN_SOURCE_CONTEXT: &str = "product.min_source_confidence_for_context";
const KEY_MIN_SOURCE_GENERATION: &str = "product.min_source_confidence_for_generation";
const KEY_KC_EVIDENCE_MODE: &str = "product.knowledge_chat_evidence_mode";
const KEY_KC_DEPLOYMENT_PROFILE: &str = "product.knowledge_chat_deployment_profile";
const KEY_ENABLE_CONTEXTUAL_INDEXING: &str = "product.enable_contextual_indexing";
const KEY_ENABLE_SEMANTIC_CHUNKING: &str = "product.enable_semantic_chunking";
const KEY_ENABLE_EXACT_DENSE: &str = "product.enable_exact_dense_search";
const KEY_ENABLE_LLM_CONTEXTUAL_SUMMARIES: &str = "product.enable_llm_contextual_summaries";
const KEY_KC_DEMO_CHEATSHEET: &str = "product.knowledge_chat_demo_cheatsheet";
const KEY_KC_MODE: &str = "product.knowledge_chat_mode";

pub const KC_EVIDENCE_MODE_CONCISE: &str = "concise";
pub const KC_EVIDENCE_MODE_EXPLANATION: &str = "evidence_explanation";
pub const KC_DEPLOYMENT_DEMO: &str = "demo";
pub const KC_DEPLOYMENT_SERVER: &str = "server";
pub const KC_MODE_FOLDER_QA: &str = "folder_qa";
pub const KC_MODE_CODEBASE_EXPLORER: &str = "codebase_explorer";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductConfig {
    pub block_low_confidence_generation: bool,
    pub min_confidence_score: f64,
    pub audit_log_enabled: bool,
    /// When false, intent cache never bypasses grounded retrieval (recommended).
    pub allow_intent_short_circuit: bool,
    /// Hint for clients to run LLM query expansion on vague Knowledge Chat questions.
    pub enable_llm_query_expand: bool,
    /// When true, disable SOC-specific intent cache and eval defaults for Knowledge Chat.
    pub folder_agnostic_mode: bool,
    /// When true, embed a HyDE-style hypothetical document query for dense retrieval.
    pub enable_hyde: bool,
    #[serde(default = "default_min_source_context")]
    pub min_source_confidence_for_context: f64,
    #[serde(default = "default_min_source_generation")]
    pub min_source_confidence_for_generation: f64,
    #[serde(default = "default_kc_evidence_mode")]
    pub knowledge_chat_evidence_mode: String,
    /// `demo` uses reduced context for local laptops; `server` uses full quality limits.
    #[serde(default = "default_kc_deployment_profile")]
    pub knowledge_chat_deployment_profile: String,
    #[serde(default = "default_true")]
    pub enable_contextual_indexing: bool,
    #[serde(default = "default_true")]
    pub enable_semantic_chunking: bool,
    #[serde(default = "default_true")]
    pub enable_exact_dense_search: bool,
    /// When true, enrich contextual index prefixes with one-line summaries (deterministic or LLM).
    #[serde(default)]
    pub enable_llm_contextual_summaries: bool,
    /// When true, load demo_cheatsheet.json from collection root to guide file pinning + LLM routing.
    #[serde(default = "default_true")]
    pub knowledge_chat_demo_cheatsheet: bool,
    /// `folder_qa` is cheatsheet-guided document QA; `codebase_explorer` adds repo map + symbol-first retrieval.
    #[serde(default = "default_kc_mode")]
    pub knowledge_chat_mode: String,
}

fn default_true() -> bool {
    true
}

fn default_kc_deployment_profile() -> String {
    KC_DEPLOYMENT_SERVER.to_string()
}

fn default_kc_mode() -> String {
    KC_MODE_FOLDER_QA.to_string()
}

fn default_min_source_context() -> f64 {
    0.42
}

fn default_min_source_generation() -> f64 {
    0.28
}

fn default_kc_evidence_mode() -> String {
    KC_EVIDENCE_MODE_CONCISE.to_string()
}

impl Default for ProductConfig {
    fn default() -> Self {
        Self {
            block_low_confidence_generation: true,
            min_confidence_score: 0.15,
            audit_log_enabled: true,
            allow_intent_short_circuit: false,
            enable_llm_query_expand: true,
            folder_agnostic_mode: true,
            enable_hyde: true,
            min_source_confidence_for_context: 0.42,
            min_source_confidence_for_generation: 0.28,
            knowledge_chat_evidence_mode: KC_EVIDENCE_MODE_CONCISE.to_string(),
            knowledge_chat_deployment_profile: KC_DEPLOYMENT_SERVER.to_string(),
            enable_contextual_indexing: true,
            enable_semantic_chunking: true,
            enable_exact_dense_search: true,
            enable_llm_contextual_summaries: false,
            knowledge_chat_demo_cheatsheet: false,
            knowledge_chat_mode: KC_MODE_FOLDER_QA.to_string(),
        }
    }
}

fn read_bool(db: &Database, key: &str, default: bool) -> bool {
    db.get_setting(key)
        .ok()
        .flatten()
        .map(|v| {
            let trimmed = v.trim();
            trimmed == "1" || trimmed.eq_ignore_ascii_case("true")
        })
        .unwrap_or(default)
}

fn read_f64(db: &Database, key: &str, default: f64) -> f64 {
    db.get_setting(key)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(default)
}

pub fn load_product_config(db: &Database) -> ProductConfig {
    let defaults = ProductConfig::default();
    ProductConfig {
        block_low_confidence_generation: read_bool(
            db,
            KEY_BLOCK_LOW_CONF,
            defaults.block_low_confidence_generation,
        ),
        min_confidence_score: read_f64(db, KEY_MIN_CONF_SCORE, defaults.min_confidence_score),
        audit_log_enabled: read_bool(db, KEY_AUDIT_ENABLED, defaults.audit_log_enabled),
        allow_intent_short_circuit: read_bool(
            db,
            KEY_ALLOW_INTENT_SHORT_CIRCUIT,
            defaults.allow_intent_short_circuit,
        ),
        enable_llm_query_expand: read_bool(
            db,
            KEY_ENABLE_LLM_QUERY_EXPAND,
            defaults.enable_llm_query_expand,
        ),
        folder_agnostic_mode: read_bool(
            db,
            KEY_FOLDER_AGNOSTIC_MODE,
            defaults.folder_agnostic_mode,
        ),
        enable_hyde: read_bool(db, KEY_ENABLE_HYDE, defaults.enable_hyde),
        min_source_confidence_for_context: read_f64(
            db,
            KEY_MIN_SOURCE_CONTEXT,
            defaults.min_source_confidence_for_context,
        ),
        min_source_confidence_for_generation: read_f64(
            db,
            KEY_MIN_SOURCE_GENERATION,
            defaults.min_source_confidence_for_generation,
        ),
        knowledge_chat_evidence_mode: db
            .get_setting(KEY_KC_EVIDENCE_MODE)
            .ok()
            .flatten()
            .filter(|v| {
                v == KC_EVIDENCE_MODE_CONCISE || v == KC_EVIDENCE_MODE_EXPLANATION
            })
            .unwrap_or_else(|| defaults.knowledge_chat_evidence_mode.clone()),
        knowledge_chat_deployment_profile: db
            .get_setting(KEY_KC_DEPLOYMENT_PROFILE)
            .ok()
            .flatten()
            .filter(|v| v == KC_DEPLOYMENT_DEMO || v == KC_DEPLOYMENT_SERVER)
            .unwrap_or_else(|| defaults.knowledge_chat_deployment_profile.clone()),
        enable_contextual_indexing: read_bool(
            db,
            KEY_ENABLE_CONTEXTUAL_INDEXING,
            defaults.enable_contextual_indexing,
        ),
        enable_semantic_chunking: read_bool(
            db,
            KEY_ENABLE_SEMANTIC_CHUNKING,
            defaults.enable_semantic_chunking,
        ),
        enable_exact_dense_search: read_bool(
            db,
            KEY_ENABLE_EXACT_DENSE,
            defaults.enable_exact_dense_search,
        ),
        enable_llm_contextual_summaries: read_bool(
            db,
            KEY_ENABLE_LLM_CONTEXTUAL_SUMMARIES,
            defaults.enable_llm_contextual_summaries,
        ),
        knowledge_chat_demo_cheatsheet: read_bool(
            db,
            KEY_KC_DEMO_CHEATSHEET,
            defaults.knowledge_chat_demo_cheatsheet,
        ),
        knowledge_chat_mode: db
            .get_setting(KEY_KC_MODE)
            .ok()
            .flatten()
            .filter(|v| v == KC_MODE_FOLDER_QA || v == KC_MODE_CODEBASE_EXPLORER)
            .unwrap_or_else(|| defaults.knowledge_chat_mode.clone()),
    }
}

pub fn save_product_config(db: &Database, config: &ProductConfig) -> AppResult<()> {
    db.set_setting(
        KEY_BLOCK_LOW_CONF,
        if config.block_low_confidence_generation {
            "1"
        } else {
            "0"
        },
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_MIN_CONF_SCORE,
        &config.min_confidence_score.to_string(),
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_AUDIT_ENABLED,
        if config.audit_log_enabled { "1" } else { "0" },
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_ALLOW_INTENT_SHORT_CIRCUIT,
        if config.allow_intent_short_circuit {
            "1"
        } else {
            "0"
        },
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_ENABLE_LLM_QUERY_EXPAND,
        if config.enable_llm_query_expand { "1" } else { "0" },
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_FOLDER_AGNOSTIC_MODE,
        if config.folder_agnostic_mode { "1" } else { "0" },
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_ENABLE_HYDE,
        if config.enable_hyde { "1" } else { "0" },
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_MIN_SOURCE_CONTEXT,
        &config.min_source_confidence_for_context.to_string(),
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_MIN_SOURCE_GENERATION,
        &config.min_source_confidence_for_generation.to_string(),
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_KC_EVIDENCE_MODE,
        &config.knowledge_chat_evidence_mode,
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_KC_DEPLOYMENT_PROFILE,
        &config.knowledge_chat_deployment_profile,
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_ENABLE_CONTEXTUAL_INDEXING,
        if config.enable_contextual_indexing { "1" } else { "0" },
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_ENABLE_SEMANTIC_CHUNKING,
        if config.enable_semantic_chunking { "1" } else { "0" },
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_ENABLE_EXACT_DENSE,
        if config.enable_exact_dense_search { "1" } else { "0" },
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_ENABLE_LLM_CONTEXTUAL_SUMMARIES,
        if config.enable_llm_contextual_summaries { "1" } else { "0" },
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_KC_DEMO_CHEATSHEET,
        if config.knowledge_chat_demo_cheatsheet { "1" } else { "0" },
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(KEY_KC_MODE, &config.knowledge_chat_mode)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}
