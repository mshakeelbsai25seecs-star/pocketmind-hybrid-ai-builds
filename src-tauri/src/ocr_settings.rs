//! OCR engine + optional Online Image RAG settings (offline-first defaults).
use crate::database::Database;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

const KEY_OCR_ENGINE: &str = "ocr.engine";
const KEY_OCR_PREPROCESS: &str = "ocr.preprocess";
const KEY_OCR_LLM_REPAIR: &str = "ocr.llm_repair";
const KEY_OCR_CAPTION_FIGURES: &str = "ocr.caption_figures";
const KEY_KC_VERIFY_LLM: &str = "kc.verify_llm_answer";
const KEY_IMAGE_RAG_ENABLED: &str = "image_rag.enabled";
const KEY_IMAGE_RAG_BASE_URL: &str = "image_rag.base_url";
const KEY_IMAGE_RAG_MODEL: &str = "image_rag.model";
const KEY_IMAGE_RAG_MAX_REGIONS: &str = "image_rag.max_regions_per_query";

/// Provider id for encrypted Image RAG API key in `api_keys` table.
pub const IMAGE_RAG_PROVIDER: &str = "image_rag";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OcrEngine {
    Auto,
    Legacy,
    Docling,
}

impl OcrEngine {
    pub fn as_str(&self) -> &'static str {
        match self {
            OcrEngine::Auto => "auto",
            OcrEngine::Legacy => "legacy",
            OcrEngine::Docling => "docling",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "legacy" => OcrEngine::Legacy,
            "docling" => OcrEngine::Docling,
            _ => OcrEngine::Auto,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrImageRagConfig {
    pub ocr_engine: String,
    /// Phase 0 default false; Phase 1 enables true by default in load when unset after ship.
    pub ocr_preprocess: bool,
    pub ocr_llm_repair: bool,
    pub ocr_caption_figures: bool,
    pub verify_llm_answer: bool,
    pub image_rag_enabled: bool,
    pub image_rag_base_url: String,
    pub image_rag_model: String,
    pub image_rag_max_regions_per_query: u32,
    /// True when a non-empty API key is stored (never returns the raw key).
    pub image_rag_api_key_configured: bool,
}

impl Default for OcrImageRagConfig {
    fn default() -> Self {
        Self {
            ocr_engine: OcrEngine::Auto.as_str().to_string(),
            // Plan Phase 0: store false until Phase 1 ready; we enable default true once Phase 1 ships.
            ocr_preprocess: true,
            ocr_llm_repair: false,
            ocr_caption_figures: false,
            verify_llm_answer: true,
            image_rag_enabled: false,
            image_rag_base_url: String::new(),
            image_rag_model: String::new(),
            image_rag_max_regions_per_query: 4,
            image_rag_api_key_configured: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrCapabilities {
    pub python_available: bool,
    pub legacy_ocr_script_available: bool,
    pub docling_importable: bool,
    pub opencv_available: bool,
    pub image_rag_configured: bool,
    pub active_engine_hint: String,
    pub warnings: Vec<String>,
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

fn read_u32(db: &Database, key: &str, default: u32) -> u32 {
    db.get_setting(key)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(default)
}

pub fn load_ocr_image_rag_config(db: &Database, api_key_configured: bool) -> OcrImageRagConfig {
    let defaults = OcrImageRagConfig::default();
    let engine = db
        .get_setting(KEY_OCR_ENGINE)
        .ok()
        .flatten()
        .map(|v| OcrEngine::parse(&v).as_str().to_string())
        .unwrap_or_else(|| defaults.ocr_engine.clone());
    OcrImageRagConfig {
        ocr_engine: engine,
        ocr_preprocess: read_bool(db, KEY_OCR_PREPROCESS, defaults.ocr_preprocess),
        ocr_llm_repair: read_bool(db, KEY_OCR_LLM_REPAIR, defaults.ocr_llm_repair),
        ocr_caption_figures: read_bool(db, KEY_OCR_CAPTION_FIGURES, defaults.ocr_caption_figures),
        verify_llm_answer: read_bool(db, KEY_KC_VERIFY_LLM, defaults.verify_llm_answer),
        image_rag_enabled: read_bool(db, KEY_IMAGE_RAG_ENABLED, defaults.image_rag_enabled),
        image_rag_base_url: db
            .get_setting(KEY_IMAGE_RAG_BASE_URL)
            .ok()
            .flatten()
            .unwrap_or_default(),
        image_rag_model: db
            .get_setting(KEY_IMAGE_RAG_MODEL)
            .ok()
            .flatten()
            .unwrap_or_default(),
        image_rag_max_regions_per_query: read_u32(
            db,
            KEY_IMAGE_RAG_MAX_REGIONS,
            defaults.image_rag_max_regions_per_query,
        )
        .clamp(1, 8),
        image_rag_api_key_configured: api_key_configured,
    }
}

pub fn save_ocr_image_rag_config(db: &Database, config: &OcrImageRagConfig) -> AppResult<()> {
    let engine = OcrEngine::parse(&config.ocr_engine);
    let base_url = config.image_rag_base_url.trim();
    let model = config.image_rag_model.trim();
    if config.image_rag_enabled {
        if !base_url.is_empty() {
            let lower = base_url.to_ascii_lowercase();
            if !(lower.starts_with("https://") || lower.starts_with("http://")) {
                return Err(AppError::Unknown(
                    "Image RAG base URL must start with http:// or https://".to_string(),
                ));
            }
        }
        if base_url.len() > 2048 || model.len() > 256 {
            return Err(AppError::Unknown(
                "Image RAG URL or model id is too long.".to_string(),
            ));
        }
    }
    // Allow saving disabled config with empty URL; when enabling without URL, still save
    // (Test connection will fail clearly). Never persist control characters.
    let safe_url: String = base_url.chars().filter(|c| !c.is_control()).take(2048).collect();
    let safe_model: String = model.chars().filter(|c| !c.is_control()).take(256).collect();

    db.set_setting(KEY_OCR_ENGINE, engine.as_str())
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_OCR_PREPROCESS,
        if config.ocr_preprocess { "1" } else { "0" },
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_OCR_LLM_REPAIR,
        if config.ocr_llm_repair { "1" } else { "0" },
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_OCR_CAPTION_FIGURES,
        if config.ocr_caption_figures { "1" } else { "0" },
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_KC_VERIFY_LLM,
        if config.verify_llm_answer { "1" } else { "0" },
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_IMAGE_RAG_ENABLED,
        if config.image_rag_enabled { "1" } else { "0" },
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(KEY_IMAGE_RAG_BASE_URL, &safe_url)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(KEY_IMAGE_RAG_MODEL, &safe_model)
        .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    db.set_setting(
        KEY_IMAGE_RAG_MAX_REGIONS,
        &config.image_rag_max_regions_per_query.clamp(1, 8).to_string(),
    )
    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
    Ok(())
}

pub fn probe_ocr_capabilities(config: &OcrImageRagConfig) -> OcrCapabilities {
    // Never panic: every probe is catch-all so a missing Python install cannot crash UI.
    let python = std::panic::catch_unwind(|| {
        crate::knowledge_chat::pdf_ocr::python_available()
    })
    .unwrap_or(false);
    let legacy = std::panic::catch_unwind(|| {
        crate::knowledge_chat::pdf_ocr::resolve_pdf_ocr_script().is_some() && python
    })
    .unwrap_or(false);
    let docling = std::panic::catch_unwind(crate::knowledge_chat::pdf_ocr::docling_importable)
        .unwrap_or(false);
    let opencv = std::panic::catch_unwind(crate::knowledge_chat::pdf_ocr::opencv_available)
        .unwrap_or(false);
    let mut warnings = Vec::new();
    if !python {
        warnings.push("Python not found on PATH; PDF OCR unavailable.".to_string());
    } else if !legacy {
        warnings.push("OCR script scripts/soc_pdf_ocr.py not found.".to_string());
    }
    if matches!(OcrEngine::parse(&config.ocr_engine), OcrEngine::Docling) && !docling {
        warnings.push("Docling requested but not importable; will fall back to legacy.".to_string());
    }
    if config.ocr_preprocess && !opencv {
        warnings.push("OpenCV not installed; preprocess will be skipped.".to_string());
    }

    let active = match OcrEngine::parse(&config.ocr_engine) {
        OcrEngine::Legacy => "legacy".to_string(),
        OcrEngine::Docling if docling => "docling".to_string(),
        OcrEngine::Docling => "legacy (docling unavailable)".to_string(),
        OcrEngine::Auto if docling => "auto→docling".to_string(),
        OcrEngine::Auto => "auto→legacy".to_string(),
    };

    let image_rag_configured = config.image_rag_enabled
        && !config.image_rag_base_url.trim().is_empty()
        && !config.image_rag_model.trim().is_empty()
        && config.image_rag_api_key_configured;

    OcrCapabilities {
        python_available: python,
        legacy_ocr_script_available: legacy,
        docling_importable: docling,
        opencv_available: opencv,
        image_rag_configured,
        active_engine_hint: active,
        warnings,
    }
}
