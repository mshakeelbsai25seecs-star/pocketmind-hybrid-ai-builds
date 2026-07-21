//! Optional Online Image RAG (OpenAI-compatible vision). Off by default; collection-scoped.

use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::ocr_settings::{self, IMAGE_RAG_PROVIDER};
use crate::knowledge_chat::db;
use crate::knowledge_chat::types::KcSearchHit;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_IMAGE_BYTES: usize = 1_500_000;
const VISION_TIMEOUT_SECS: u64 = 45;
const MAX_PAGES_STORE: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageRagEvidence {
    pub page_label: String,
    pub description: String,
    pub media_path: String,
}

pub fn collection_allows_image_rag(
    image_rag_opt_in: bool,
    allow_cloud_media: bool,
    global_enabled: bool,
    credentials_ok: bool,
) -> bool {
    global_enabled && image_rag_opt_in && allow_cloud_media && credentials_ok
}

pub fn looks_visual_question(question: &str) -> bool {
    let q = question.to_ascii_lowercase();
    [
        "chart", "graph", "figure", "diagram", "table", "screenshot", "image", "plot",
        "infographic", "photo", "picture", "scan of", "what does this show",
    ]
    .iter()
    .any(|k| q.contains(k))
}

fn sanitize_collection_id(collection_id: &str) -> Option<String> {
    let id = collection_id.trim();
    if id.is_empty() || id.len() > 128 {
        return None;
    }
    if id.contains("..") || id.contains('/') || id.contains('\\') || id.contains('\0') {
        return None;
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(id.to_string())
}

fn vision_base_url_ok(base_url: &str) -> bool {
    let u = base_url.trim().to_ascii_lowercase();
    (u.starts_with("https://") || u.starts_with("http://")) && u.len() < 2048
}

pub fn media_dir_for_collection(data_root: &Path, collection_id: &str) -> Option<PathBuf> {
    let id = sanitize_collection_id(collection_id)?;
    Some(
        data_root
            .join("knowledge-chat")
            .join("media")
            .join(id),
    )
}

/// List existing page PNGs for a PDF under the collection media store (no regeneration).
pub fn existing_pdf_page_previews(
    pdf_path: &Path,
    collection_id: &str,
    data_root: &Path,
) -> Vec<PathBuf> {
    let Some(base) = media_dir_for_collection(data_root, collection_id) else {
        return Vec::new();
    };
    let out_dir = base.join(file_stem_hash(pdf_path));
    list_pngs(&out_dir)
}

fn list_pngs(out_dir: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(rd) = std::fs::read_dir(out_dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("png") {
                if let Ok(meta) = p.metadata() {
                    if meta.len() > 0 && meta.len() as usize <= MAX_IMAGE_BYTES * 2 {
                        paths.push(p);
                    }
                }
            }
        }
    }
    paths.sort();
    paths
}

/// Render first N PDF pages as PNG for opted-in collections (best-effort; no-op on failure).
pub fn maybe_store_pdf_page_previews(
    pdf_path: &Path,
    collection_id: &str,
    data_root: &Path,
    max_pages: usize,
) -> AppResult<Vec<PathBuf>> {
    if !pdf_path.is_file() {
        return Ok(Vec::new());
    }
    let Some(base) = media_dir_for_collection(data_root, collection_id) else {
        return Ok(Vec::new());
    };
    let out_dir = base.join(file_stem_hash(pdf_path));
    let existing = list_pngs(&out_dir);
    let limit = max_pages.clamp(1, MAX_PAGES_STORE);
    if existing.len() >= limit.min(1) && !existing.is_empty() {
        return Ok(existing.into_iter().take(limit).collect());
    }
    if let Err(e) = std::fs::create_dir_all(&out_dir) {
        eprintln!("image_rag: media dir create failed: {e}");
        return Ok(Vec::new());
    }

    let python = crate::knowledge_chat::pdf_ocr::resolve_python_executable();
    let Some(python) = python else {
        return Ok(Vec::new());
    };
    // Use a separate argv after -c: sys.argv[1]=pdf, [2]=outdir, [3]=limit
    let script = r#"
import sys
from pathlib import Path
try:
    import fitz
except Exception:
    sys.exit(0)
try:
    pdf = Path(sys.argv[1])
    outdir = Path(sys.argv[2])
    limit = max(1, min(int(sys.argv[3]), 12))
    if not pdf.is_file():
        sys.exit(0)
    outdir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf)
    n = min(len(doc), limit)
    for i in range(n):
        page = doc.load_page(i)
        pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
        out = outdir / ("p%03d.png" % (i + 1))
        pix.save(out)
    print(n)
except Exception:
    sys.exit(0)
"#;
    let output = std::process::Command::new(python)
        .args([
            "-c",
            script,
            &pdf_path.to_string_lossy(),
            &out_dir.to_string_lossy(),
            &limit.to_string(),
        ])
        .output();
    let Ok(output) = output else {
        return Ok(Vec::new());
    };
    if !output.status.success() {
        return Ok(Vec::new());
    }
    Ok(list_pngs(&out_dir).into_iter().take(limit).collect())
}

fn file_stem_hash(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    if let Ok(meta) = std::fs::metadata(path) {
        hasher.update(meta.len().to_le_bytes());
        if let Ok(modified) = meta.modified() {
            if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                hasher.update(duration.as_secs().to_le_bytes());
            }
        }
    }
    let hex = format!("{:x}", hasher.finalize());
    hex.chars().take(16).collect()
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(VISION_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

pub async fn test_connection(state: &AppState) -> AppResult<String> {
    let (base_url, model, api_key) = {
        let db = state.db.lock().await;
        let encrypted = db
            .get_api_key(IMAGE_RAG_PROVIDER)
            .map_err(|e| AppError::DatabaseError(e.to_string()))?
            .ok_or_else(|| AppError::Unknown("No Image RAG API key stored.".to_string()))?;
        let api_key = state
            .crypto
            .decrypt(&encrypted)
            .map_err(|e| AppError::Unknown(format!("Decrypt Image RAG key failed: {e}")))?;
        if api_key.trim().is_empty() {
            return Err(AppError::Unknown("Image RAG API key is empty.".to_string()));
        }
        let cfg = ocr_settings::load_ocr_image_rag_config(&db, true);
        if !cfg.image_rag_enabled {
            return Err(AppError::Unknown(
                "Online Image RAG is disabled (global switch off).".to_string(),
            ));
        }
        if cfg.image_rag_base_url.trim().is_empty() || cfg.image_rag_model.trim().is_empty() {
            return Err(AppError::Unknown(
                "Set Image RAG base URL and model first.".to_string(),
            ));
        }
        if !vision_base_url_ok(&cfg.image_rag_base_url) {
            return Err(AppError::Unknown(
                "Image RAG base URL must start with http:// or https://".to_string(),
            ));
        }
        (
            cfg.image_rag_base_url.trim().trim_end_matches('/').to_string(),
            cfg.image_rag_model.clone(),
            api_key,
        )
    };

    let url = format!("{base_url}/chat/completions");
    let body = json!({
        "model": model,
        "max_tokens": 16,
        "messages": [{"role": "user", "content": "Reply with the single word: pong"}]
    });
    let client = http_client();
    let res = client
        .post(&url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Unknown(format!("Image RAG test request failed: {e}")))?;
    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        let clipped: String = text.chars().take(240).collect();
        return Err(AppError::Unknown(format!(
            "Image RAG test failed ({status}): {clipped}"
        )));
    }
    Ok("Online Image RAG connection OK.".to_string())
}

/// After local retrieval, optionally ask vision model about page crops near top hits.
/// Soft-fails to `Ok(None)` on any unexpected condition (never breaks offline answers).
pub async fn maybe_enrich_with_vision(
    state: &AppState,
    collection_id: &str,
    question: &str,
    hits: &[KcSearchHit],
) -> AppResult<Option<Vec<ImageRagEvidence>>> {
    if question.trim().is_empty() || hits.is_empty() {
        return Ok(None);
    }
    if sanitize_collection_id(collection_id).is_none() {
        return Ok(None);
    }

    let gate = {
        let db = state.db.lock().await;
        let collection = match db::get_collection(&db, collection_id) {
            Ok(c) => c,
            Err(_) => return Ok(None),
        };
        let encrypted = db.get_api_key(IMAGE_RAG_PROVIDER).ok().flatten();
        let key_ok = encrypted.as_ref().map(|k| !k.is_empty()).unwrap_or(false);
        let cfg = ocr_settings::load_ocr_image_rag_config(&db, key_ok);
        if !collection_allows_image_rag(
            collection.image_rag_opt_in,
            collection.allow_cloud_media,
            cfg.image_rag_enabled,
            key_ok,
        ) {
            return Ok(None);
        }
        if !vision_base_url_ok(&cfg.image_rag_base_url) || cfg.image_rag_model.trim().is_empty() {
            return Ok(None);
        }
        let deploy = crate::deployment::load_deployment_config(&db);
        let data_root = PathBuf::from(&deploy.data_root);
        let max_regions = cfg.image_rag_max_regions_per_query.clamp(1, 8) as usize;
        let base_url = cfg.image_rag_base_url.trim().trim_end_matches('/').to_string();
        let model = cfg.image_rag_model.trim().to_string();
        let collection_root = collection.root_path.clone();
        (encrypted, data_root, max_regions, base_url, model, collection_root)
    };

    let (encrypted, data_root, max_regions, base_url, model, collection_root) = gate;

    // Privacy minimization: network upload only for visual questions (never every PDF hit).
    let visual = looks_visual_question(question);
    if !visual {
        return Ok(None);
    }
    let mut media_paths: Vec<PathBuf> = Vec::new();
    for hit in hits.iter().take(8) {
        let p = PathBuf::from(hit.chunk.file_path.trim());
        let is_pdf = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("pdf"))
            .unwrap_or_else(|| hit.chunk.file_name.to_ascii_lowercase().ends_with(".pdf"));
        if !is_pdf {
            continue;
        }
        if !crate::knowledge_chat::path_guard::path_is_under_collection_root(
            &hit.chunk.file_path,
            &collection_root,
        ) {
            continue;
        }
        let path = if p.is_file() {
            p
        } else {
            continue;
        };
        let mut paths = existing_pdf_page_previews(&path, collection_id, &data_root);
        if paths.is_empty() {
            paths = maybe_store_pdf_page_previews(&path, collection_id, &data_root, 3)
                .unwrap_or_default();
        }
        if paths.is_empty() {
            continue;
        }
        for path in paths {
            if media_paths.len() >= max_regions {
                break;
            }
            media_paths.push(path);
        }
        if media_paths.len() >= max_regions {
            break;
        }
    }
    if media_paths.is_empty() {
        return Ok(None);
    }

    let api_key = match encrypted {
        Some(enc) => match state.crypto.decrypt(&enc) {
            Ok(k) if !k.trim().is_empty() => k,
            _ => return Ok(None),
        },
        None => return Ok(None),
    };

    let mut content = vec![json!({
        "type": "text",
        "text": format!(
            "Describe only what is visible that helps answer this question. Be factual and concise. Do not invent text that is not visible.\nQuestion: {}",
            question.chars().take(2000).collect::<String>()
        )
    })];
    let mut used_paths = Vec::new();
    for path in &media_paths {
        let bytes = match std::fs::read(path) {
            Ok(b) if !b.is_empty() && b.len() <= MAX_IMAGE_BYTES => b,
            Ok(_) => continue, // empty or too large
            Err(_) => continue,
        };
        let b64 = base64_encode(&bytes);
        content.push(json!({
            "type": "image_url",
            "image_url": { "url": format!("data:image/png;base64,{b64}") }
        }));
        used_paths.push(path.clone());
    }
    if content.len() < 2 {
        return Ok(None);
    }

    let url = format!("{base_url}/chat/completions");
    let body = json!({
        "model": model,
        "max_tokens": 400,
        "messages": [{ "role": "user", "content": content }]
    });
    let client = http_client();
    let res = match client
        .post(&url)
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    if !res.status().is_success() {
        return Ok(None);
    }
    let payload: serde_json::Value = match res.json().await {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let description = payload["choices"]
        .get(0)
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if description.is_empty() || description.len() > 8000 {
        // Empty or absurdly long → treat as unusable
        if description.is_empty() {
            return Ok(None);
        }
    }
    let description: String = description.chars().take(4000).collect();

    let page_labels: Vec<String> = used_paths
        .iter()
        .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string()))
        .collect();
    let label = if page_labels.is_empty() {
        "Online vision".to_string()
    } else {
        format!("Online vision | {}", page_labels.join(", "))
    };

    Ok(Some(vec![ImageRagEvidence {
        page_label: label.clone(),
        description: format!("[{label}]\n{description}"),
        media_path: used_paths
            .first()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    }]))
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hard_gate_requires_all_flags() {
        assert!(!collection_allows_image_rag(true, true, true, false));
        assert!(!collection_allows_image_rag(true, true, false, true));
        assert!(!collection_allows_image_rag(true, false, true, true));
        assert!(!collection_allows_image_rag(false, true, true, true));
        assert!(collection_allows_image_rag(true, true, true, true));
    }

    #[test]
    fn visual_question_detects_chart_keywords() {
        assert!(looks_visual_question("What does the chart show?"));
        assert!(!looks_visual_question("What is the VPN timeout?"));
    }

    #[test]
    fn rejects_path_traversal_collection_ids() {
        assert!(sanitize_collection_id("../etc").is_none());
        assert!(sanitize_collection_id("a/b").is_none());
        assert!(sanitize_collection_id("col-123_ab").is_some());
    }

    #[test]
    fn base_url_must_be_http() {
        assert!(vision_base_url_ok("https://api.openai.com/v1"));
        assert!(!vision_base_url_ok("file:///tmp"));
        assert!(!vision_base_url_ok(""));
    }
}
