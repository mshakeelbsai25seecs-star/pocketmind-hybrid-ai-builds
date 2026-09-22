//! Image Studio generation + export. Working providers only — no catalog stubs.

use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenRequest {
    pub provider: String,
    pub model_id: String,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub width: u32,
    pub height: u32,
    pub seed: Option<u32>,
    pub quality: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageGenResult {
    pub url: Option<String>,
    pub b64: Option<String>,
    pub mime: String,
    pub provider: String,
    pub model_id: String,
}

async fn vault_key(state: &State<'_, AppState>, provider: &str) -> AppResult<String> {
    let db = state.db.lock().await;
    let enc = db.get_api_key(provider)?.ok_or_else(|| {
        AppError::Unknown(format!(
            "No saved API key for {provider}. Add one in Control Center → API Keys."
        ))
    })?;
    drop(db);
    state.crypto.decrypt(&enc)
}

fn clamp_dim(v: u32) -> u32 {
    v.clamp(256, 2048)
}

pub fn pollinations_url(req: &ImageGenRequest) -> String {
    let prompt = req.prompt.trim().replace('\n', " ");
    let encoded = urlencoding_lite(&prompt);
    let mut url = format!(
        "https://image.pollinations.ai/prompt/{encoded}?width={}&height={}&nologo=true&enhance=true&safe=false&model={}",
        clamp_dim(req.width),
        clamp_dim(req.height),
        if req.model_id.trim().is_empty() { "flux" } else { req.model_id.trim() }
    );
    if let Some(seed) = req.seed {
        url.push_str(&format!("&seed={seed}"));
    }
    if let Some(neg) = req.negative_prompt.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        url.push_str(&format!("&negative={}", urlencoding_lite(neg)));
    }
    url
}

fn urlencoding_lite(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn openai_size(w: u32, h: u32) -> &'static str {
    if w == h {
        "1024x1024"
    } else if w > h {
        "1792x1024"
    } else {
        "1024x1792"
    }
}

pub async fn generate(state: State<'_, AppState>, req: ImageGenRequest) -> AppResult<ImageGenResult> {
    let prompt = req.prompt.trim();
    if prompt.is_empty() {
        return Err(AppError::Unknown("Enter an image prompt first.".into()));
    }
    let provider = req.provider.trim().to_ascii_lowercase();
    match provider.as_str() {
        "pollinations" => Ok(ImageGenResult {
            url: Some(pollinations_url(&req)),
            b64: None,
            mime: "image/jpeg".into(),
            provider: "pollinations".into(),
            model_id: req.model_id.clone(),
        }),
        "openai" => {
            let key = vault_key(&state, "openai").await?;
            let client = reqwest::Client::new();
            let model = if req.model_id.trim().is_empty() {
                "gpt-image-1"
            } else {
                req.model_id.trim()
            };
            let body = serde_json::json!({
                "model": model,
                "prompt": prompt,
                "size": openai_size(req.width, req.height),
                "n": 1,
            });
            let resp = client
                .post("https://api.openai.com/v1/images/generations")
                .bearer_auth(&key)
                .json(&body)
                .send()
                .await
                .map_err(|e| AppError::NetworkError(e.to_string()))?;
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(AppError::Unknown(format!("OpenAI image error ({status}): {text}")));
            }
            parse_openai_image(&text, &req)
        }
        "together" => {
            let key = vault_key(&state, "together").await?;
            let client = reqwest::Client::new();
            let model = if req.model_id.trim().is_empty() {
                "black-forest-labs/FLUX.1-schnell"
            } else {
                req.model_id.trim()
            };
            let body = serde_json::json!({
                "model": model,
                "prompt": prompt,
                "width": clamp_dim(req.width),
                "height": clamp_dim(req.height),
                "steps": 8,
                "n": 1,
            });
            let resp = client
                .post("https://api.together.xyz/v1/images/generations")
                .bearer_auth(&key)
                .json(&body)
                .send()
                .await
                .map_err(|e| AppError::NetworkError(e.to_string()))?;
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(AppError::Unknown(format!("Together image error ({status}): {text}")));
            }
            parse_openai_image(&text, &req)
        }
        "huggingface" => {
            let key = vault_key(&state, "huggingface").await?;
            let client = reqwest::Client::new();
            let model = if req.model_id.trim().is_empty() {
                "stabilityai/stable-diffusion-xl-base-1.0"
            } else {
                req.model_id.trim()
            };
            let resp = client
                .post(format!("https://api-inference.huggingface.co/models/{model}"))
                .bearer_auth(&key)
                .header("Accept", "image/png")
                .json(&serde_json::json!({ "inputs": prompt }))
                .send()
                .await
                .map_err(|e| AppError::NetworkError(e.to_string()))?;
            let status = resp.status();
            let bytes = resp.bytes().await.map_err(|e| AppError::NetworkError(e.to_string()))?;
            if !status.is_success() {
                return Err(AppError::Unknown(format!(
                    "Hugging Face image error ({status}): {}",
                    String::from_utf8_lossy(&bytes)
                )));
            }
            Ok(ImageGenResult {
                url: None,
                b64: Some(B64.encode(&bytes)),
                mime: "image/png".into(),
                provider: "huggingface".into(),
                model_id: req.model_id.clone(),
            })
        }
        "replicate" => {
            let key = vault_key(&state, "replicate").await?;
            let client = reqwest::Client::new();
            let model = if req.model_id.contains('/') {
                req.model_id.trim().to_string()
            } else {
                "black-forest-labs/flux-schnell".into()
            };
            let resp = client
                .post("https://api.replicate.com/v1/predictions")
                .header("Authorization", format!("Bearer {key}"))
                .header("Prefer", "wait=60")
                .json(&serde_json::json!({
                    "model": model,
                    "input": { "prompt": prompt }
                }))
                .send()
                .await
                .map_err(|e| AppError::NetworkError(e.to_string()))?;
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(AppError::Unknown(format!("Replicate image error ({status}): {text}")));
            }
            let v: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| AppError::Unknown(format!("Replicate parse: {e}")))?;
            let url = v
                .pointer("/output/0")
                .and_then(|x| x.as_str())
                .or_else(|| v.get("output").and_then(|x| x.as_str()))
                .ok_or_else(|| AppError::Unknown("Replicate returned no image URL.".into()))?;
            Ok(ImageGenResult {
                url: Some(url.to_string()),
                b64: None,
                mime: "image/png".into(),
                provider: "replicate".into(),
                model_id: req.model_id.clone(),
            })
        }
        "stability" => {
            let key = vault_key(&state, "stability").await?;
            let client = reqwest::Client::new();
            let form = reqwest::multipart::Form::new()
                .text("prompt", prompt.to_string())
                .text("output_format", "png");
            let resp = client
                .post("https://api.stability.ai/v2beta/stable-image/generate/core")
                .bearer_auth(&key)
                .header("Accept", "image/*")
                .multipart(form)
                .send()
                .await
                .map_err(|e| AppError::NetworkError(e.to_string()))?;
            let status = resp.status();
            let bytes = resp.bytes().await.map_err(|e| AppError::NetworkError(e.to_string()))?;
            if !status.is_success() {
                return Err(AppError::Unknown(format!(
                    "Stability image error ({status}): {}",
                    String::from_utf8_lossy(&bytes)
                )));
            }
            Ok(ImageGenResult {
                url: None,
                b64: Some(B64.encode(&bytes)),
                mime: "image/png".into(),
                provider: "stability".into(),
                model_id: req.model_id.clone(),
            })
        }
        other => Err(AppError::Unknown(format!(
            "Image provider '{other}' is not wired. Use Pollinations (free) or a configured OpenAI / Together / Hugging Face / Replicate / Stability key."
        ))),
    }
}

fn parse_openai_image(text: &str, req: &ImageGenRequest) -> AppResult<ImageGenResult> {
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| AppError::Unknown(format!("Image API parse: {e}")))?;
    let item = v
        .get("data")
        .and_then(|d| d.get(0))
        .ok_or_else(|| AppError::Unknown("Image API returned no data.".into()))?;
    if let Some(url) = item.get("url").and_then(|u| u.as_str()) {
        return Ok(ImageGenResult {
            url: Some(url.to_string()),
            b64: None,
            mime: "image/png".into(),
            provider: req.provider.clone(),
            model_id: req.model_id.clone(),
        });
    }
    if let Some(b64) = item.get("b64_json").and_then(|u| u.as_str()) {
        return Ok(ImageGenResult {
            url: None,
            b64: Some(b64.to_string()),
            mime: "image/png".into(),
            provider: req.provider.clone(),
            model_id: req.model_id.clone(),
        });
    }
    Err(AppError::Unknown("Image API returned neither url nor b64_json.".into()))
}

pub fn save_bytes(path: String, bytes: Vec<u8>) -> AppResult<()> {
    if path.trim().is_empty() {
        return Err(AppError::Unknown("No save path selected.".into()));
    }
    std::fs::write(&path, bytes).map_err(|e| AppError::Unknown(format!("Failed to save image: {e}")))?;
    Ok(())
}

pub fn save_b64(path: String, b64: String) -> AppResult<()> {
    let bytes = B64
        .decode(b64.trim())
        .map_err(|e| AppError::Unknown(format!("Invalid image data: {e}")))?;
    save_bytes(path, bytes)
}
