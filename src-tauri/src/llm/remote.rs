use tokio::sync::mpsc;
use serde_json::Value;
use futures::StreamExt;
use async_trait::async_trait;
use crate::error::{AppError, AppResult};
use super::{InferenceBackend, GenerationRequest, GenerationChunk, GenerationParams};


fn is_knowledge_system_prompt(system: &str) -> bool {
    system.contains("Nexus Data Knowledge Chat")
        || system.contains("Nexus Codebase Explorer")
}

fn is_soc_system_prompt(system: &str) -> bool {
    system.contains("Nexus SOC Offline")
}

fn nexus_formatting_system_prompt(custom: Option<&str>) -> String {
    let base = "You are NexusAI. Answer the latest user message directly. Use plain, clean Markdown. Put headings, bullet points, numbered points, and fenced code blocks on separate lines. Use inline code for single keywords. Use fenced code blocks only for complete runnable examples. Do not output LaTeX, TikZ, PGF, Asymptote, tabular, graph, or diagram source unless the user explicitly asks for that exact format. Do not invent follow-up questions or repeat yourself.";
    match custom {
        Some(value) if !value.trim().is_empty()
            && (is_knowledge_system_prompt(value) || is_soc_system_prompt(value)) =>
        {
            value.trim().to_string()
        }
        Some(value) if !value.trim().is_empty() => format!("{}\n\n{}", base, value.trim()),
        _ => base.to_string(),
    }
}

pub struct RemoteBackend {
    provider: String,
    api_key: String,
    base_url: String,
    model_id: String,
}

impl RemoteBackend {
    pub fn new(provider: &str, api_key: &str, model_id: &str) -> Self {
        let base_url = match provider {
            "groq" => "https://api.groq.com/openai/v1",
            "openrouter" => "https://openrouter.ai/api/v1",
            "openai" => "https://api.openai.com/v1",
            "together" => "https://api.together.xyz/v1",
            "anthropic" => "https://api.anthropic.com/v1",
            "deepseek" => "https://api.deepseek.com/v1",
            "mistral" => "https://api.mistral.ai/v1",
            "gemini" => "https://generativelanguage.googleapis.com/v1beta",
            _ => "https://api.openai.com/v1",
        };
        
        Self {
            provider: provider.to_string(),
            api_key: api_key.to_string(),
            base_url: base_url.to_string(),
            model_id: model_id.to_string(),
        }
    }

    pub fn new_custom(provider: &str, base_url: &str, api_key: &str, model_id: &str) -> Self {
        Self {
            provider: provider.to_string(),
            api_key: api_key.to_string(),
            base_url: base_url.trim_end_matches('/').to_string(),
            model_id: model_id.to_string(),
        }
    }

    pub fn get_api_key_url(provider: &str) -> String {
        match provider {
            "groq" => "https://console.groq.com/keys".to_string(),
            "openrouter" => "https://openrouter.ai/keys".to_string(),
            "openai" => "https://platform.openai.com/api-keys".to_string(),
            "together" => "https://api.together.xyz/settings/api-keys".to_string(),
            "anthropic" => "https://console.anthropic.com/settings/keys".to_string(),
            "deepseek" => "https://platform.deepseek.com/api_keys".to_string(),
            "mistral" => "https://console.mistral.ai/api-keys/".to_string(),
            "gemini" => "https://aistudio.google.com/app/apikey".to_string(),
            "enterprise" => "Ask your company administrator for the internal NexusAI server token.".to_string(),
            _ => "".to_string(),
        }
    }

    fn build_openai_messages(&self, request: &GenerationRequest) -> Vec<Value> {
        let mut messages = vec![];
        messages.push(serde_json::json!({"role": "system", "content": nexus_formatting_system_prompt(request.system_prompt.as_deref())}));
        if request.messages.is_empty() {
            messages.push(serde_json::json!({"role": "user", "content": request.prompt.trim()}));
        } else {
            for m in &request.messages {
                let role = match m.role.as_str() { "assistant" => "assistant", "system" => "system", _ => "user" };
                if !m.content.trim().is_empty() {
                    messages.push(serde_json::json!({"role": role, "content": m.content.trim()}));
                }
            }
        }
        messages
    }

    async fn generate_gemini(&self, request: GenerationRequest, tx: mpsc::Sender<GenerationChunk>) -> AppResult<()> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| AppError::NetworkError(e.to_string()))?;

        let mut contents = Vec::new();
        if request.messages.is_empty() {
            contents.push(serde_json::json!({"role": "user", "parts": [{"text": request.prompt.trim()}]}));
        } else {
            for m in &request.messages {
                if m.content.trim().is_empty() || m.role == "system" { continue; }
                let role = if m.role == "assistant" { "model" } else { "user" };
                contents.push(serde_json::json!({"role": role, "parts": [{"text": m.content.trim()}]}));
            }
        }
        if contents.is_empty() {
            contents.push(serde_json::json!({"role": "user", "parts": [{"text": request.prompt.trim()}]}));
        }

        let mut body = serde_json::json!({
            "contents": contents,
            "generationConfig": {
                "temperature": request.params.temperature,
                "topP": request.params.top_p,
                "maxOutputTokens": request.params.max_tokens.max(1),
            }
        });
        body["systemInstruction"] = serde_json::json!({"parts": [{"text": nexus_formatting_system_prompt(request.system_prompt.as_deref())}]});

        let url = format!("{}/models/{}:generateContent?key={}", self.base_url, self.model_id, self.api_key);
        let response = client.post(&url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::NetworkError(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
                return Err(AppError::InvalidApiKey { provider: self.provider.clone(), url: Self::get_api_key_url(&self.provider) });
            }
            return Err(AppError::InferenceError(format!("Gemini HTTP {}: {}", status, text)));
        }

        let json: Value = response.json().await.map_err(|e| AppError::NetworkError(e.to_string()))?;
        let mut text = String::new();
        if let Some(parts) = json.get("candidates")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("content"))
            .and_then(|c| c.get("parts"))
            .and_then(|p| p.as_array())
        {
            for part in parts {
                if let Some(piece) = part.get("text").and_then(|v| v.as_str()) {
                    text.push_str(piece);
                }
            }
        }
        if text.trim().is_empty() {
            text = json.to_string();
        }
        let _ = tx.send(GenerationChunk {
            text,
            finish_reason: Some("stop".to_string()),
            tokens_generated: 0,
            tokens_per_sec: 0.0,
        }).await;
        Ok(())
    }
}

#[async_trait]
impl InferenceBackend for RemoteBackend {
    async fn generate_stream(
        &self,
        request: GenerationRequest,
        tx: mpsc::Sender<GenerationChunk>,
    ) -> AppResult<()> {
        if self.api_key.trim().is_empty() && self.provider != "enterprise" {
            return Err(AppError::InvalidApiKey { provider: self.provider.clone(), url: Self::get_api_key_url(&self.provider) });
        }
        if self.provider == "gemini" {
            return self.generate_gemini(request, tx).await;
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| AppError::NetworkError(e.to_string()))?;
        
        let body = serde_json::json!({
            "model": self.model_id,
            "messages": self.build_openai_messages(&request),
            "stream": true,
            "temperature": request.params.temperature,
            "top_p": request.params.top_p,
            "max_tokens": request.params.max_tokens,
        });
        
        let url = format!("{}/chat/completions", self.base_url);
        let mut req = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body);

        if !self.api_key.trim().is_empty() {
            req = req.header("Authorization", format!("Bearer {}", self.api_key));
        }

        if self.provider == "openrouter" {
            req = req
                .header("HTTP-Referer", "https://nexusai.local")
                .header("X-Title", "NexusAI Desktop");
        }

        let response = req.send().await.map_err(|e| {
            if e.status() == Some(reqwest::StatusCode::UNAUTHORIZED) {
                AppError::InvalidApiKey { provider: self.provider.clone(), url: Self::get_api_key_url(&self.provider) }
            } else {
                AppError::NetworkError(e.to_string())
            }
        })?;
        
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
                return Err(AppError::InvalidApiKey { provider: self.provider.clone(), url: Self::get_api_key_url(&self.provider) });
            }
            return Err(AppError::InferenceError(format!("HTTP {}: {}", status, text)));
        }
        
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::NetworkError(e.to_string()))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim().to_string();
                buffer = buffer[pos + 1..].to_string();
                if !line.starts_with("data: ") { continue; }
                let data = line.trim_start_matches("data: ").trim();
                if data == "[DONE]" { continue; }
                if let Ok(json) = serde_json::from_str::<Value>(data) {
                    if let Some(delta) = json.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("delta")) {
                        if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
                            let _ = tx.send(GenerationChunk {
                                text: content.to_string(),
                                finish_reason: json.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("finish_reason")).and_then(|v| v.as_str()).map(|s| s.to_string()),
                                tokens_generated: 0,
                                tokens_per_sec: 0.0,
                            }).await;
                        }
                    }
                }
            }
        }
        
        Ok(())
    }
    
    async fn load_model(&self, _path: &str, _params: &GenerationParams) -> AppResult<()> { Ok(()) }
    async fn unload_model(&self) -> AppResult<()> { Ok(()) }
    fn is_loaded(&self) -> bool { true }
    fn backend_name(&self) -> &'static str { "remote" }
    fn estimate_tokens_per_sec(&self, _params_b: u32, _quant: &str, _hardware: &crate::hardware::SystemInfo) -> f32 { 120.0 }
}
