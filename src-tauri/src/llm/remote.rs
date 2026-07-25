use tokio::sync::mpsc;
use serde::Serialize;
use serde_json::Value;
use futures::StreamExt;
use async_trait::async_trait;
use crate::error::{AppError, AppResult};
use super::{
    InferenceBackend, GenerationRequest, GenerationChunk, GenerationParams, ToolCall,
    ToolCallFunction,
};

#[derive(Debug, Default)]
struct PendingToolCall {
    index: usize,
    id: String,
    name: String,
    arguments: String,
}

fn merge_tool_call_deltas(pending: &mut Vec<PendingToolCall>, deltas: &[Value]) {
    for d in deltas {
        let index = d.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        while pending.len() <= index {
            let i = pending.len();
            pending.push(PendingToolCall {
                index: i,
                ..Default::default()
            });
        }
        let slot = &mut pending[index];
        if let Some(id) = d.get("id").and_then(|v| v.as_str()) {
            if !id.is_empty() {
                slot.id = id.to_string();
            }
        }
        if let Some(func) = d.get("function") {
            if let Some(name) = func.get("name").and_then(|v| v.as_str()) {
                if !name.is_empty() {
                    slot.name.push_str(name);
                }
            }
            if let Some(args) = func.get("arguments").and_then(|v| v.as_str()) {
                slot.arguments.push_str(args);
            }
        }
    }
}


fn is_knowledge_system_prompt(system: &str) -> bool {
    system.contains("Nexus Data Knowledge Chat")
        || system.contains("Nexus Codebase Explorer")
}

fn is_soc_system_prompt(system: &str) -> bool {
    system.contains("Nexus SOC Offline")
}

fn is_code_workspace_system_prompt(system: &str) -> bool {
    system.contains("PocketMind Code Workspace")
        || system.contains("CRITICAL OUTPUT FORMAT")
        || system.contains("PocketCode")
}

fn nexus_formatting_system_prompt(custom: Option<&str>) -> String {
    let base = "You are PocketMind Hybrid AI. Answer the latest user message directly. Use plain, clean Markdown. Put headings, bullet points, numbered points, and fenced code blocks on separate lines. Use inline code for single keywords. Use fenced code blocks only for complete runnable examples. Do not output LaTeX, TikZ, PGF, Asymptote, tabular, graph, or diagram source unless the user explicitly asks for that exact format. Do not invent follow-up questions or repeat yourself.";
    match custom {
        Some(value) if !value.trim().is_empty()
            && (is_knowledge_system_prompt(value)
                || is_soc_system_prompt(value)
                || is_code_workspace_system_prompt(value)) =>
        {
            // Pass through specialized prompts unchanged (tool JSON protocol must not fight Markdown chat instructions).
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
            "cerebras" => "https://api.cerebras.ai/v1",
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
            "cerebras" => "https://cloud.cerebras.ai/".to_string(),
            "openrouter" => "https://openrouter.ai/keys".to_string(),
            "openai" => "https://platform.openai.com/api-keys".to_string(),
            "together" => "https://api.together.xyz/settings/api-keys".to_string(),
            "anthropic" => "https://console.anthropic.com/settings/keys".to_string(),
            "deepseek" => "https://platform.deepseek.com/api_keys".to_string(),
            "mistral" => "https://console.mistral.ai/api-keys/".to_string(),
            "gemini" => "https://aistudio.google.com/app/apikey".to_string(),
            "enterprise" => "Ask your company administrator for the internal PocketMind Hybrid AI server token.".to_string(),
            _ => "".to_string(),
        }
    }

    /// Lightweight auth check against the provider (list-models style). Does not stream chat.
    pub async fn validate_api_key(provider: &str, api_key: &str) -> ApiKeyValidation {
        let provider = provider.trim().to_lowercase();
        let api_key = api_key.trim();
        if provider.is_empty() {
            return ApiKeyValidation::fail(&provider, "Unknown provider.", None);
        }
        if api_key.is_empty() {
            return ApiKeyValidation::fail(
                &provider,
                "Paste an API key first.",
                Some(Self::get_api_key_url(&provider)),
            );
        }

        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                return ApiKeyValidation::fail(&provider, &format!("HTTP client error: {e}"), None)
            }
        };

        let result = match provider.as_str() {
            "gemini" => validate_gemini_key(&client, api_key).await,
            "anthropic" => validate_anthropic_key(&client, api_key).await,
            "groq" | "cerebras" | "openrouter" | "openai" | "together" | "deepseek" | "mistral" => {
                let backend = Self::new(&provider, api_key, "probe");
                validate_openai_compatible_key(&client, &backend.provider, &backend.base_url, api_key)
                    .await
            }
            _ => {
                return ApiKeyValidation::fail(
                    &provider,
                    &format!("No validator for provider '{provider}'."),
                    Some(Self::get_api_key_url(&provider)),
                )
            }
        };

        match result {
            Ok(msg) => ApiKeyValidation::ok(&provider, &msg),
            Err(ValidateProbeError::InvalidKey(msg)) => ApiKeyValidation::fail(
                &provider,
                &msg,
                Some(Self::get_api_key_url(&provider)),
            ),
            Err(ValidateProbeError::Other(msg)) => ApiKeyValidation::fail(&provider, &msg, None),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ApiKeyValidation {
    pub ok: bool,
    pub provider: String,
    pub message: String,
    pub key_url: Option<String>,
}

impl ApiKeyValidation {
    fn ok(provider: &str, message: &str) -> Self {
        Self {
            ok: true,
            provider: provider.to_string(),
            message: message.to_string(),
            key_url: None,
        }
    }

    fn fail(provider: &str, message: &str, key_url: Option<String>) -> Self {
        Self {
            ok: false,
            provider: provider.to_string(),
            message: message.to_string(),
            key_url,
        }
    }
}

enum ValidateProbeError {
    InvalidKey(String),
    Other(String),
}

async fn validate_openai_compatible_key(
    client: &reqwest::Client,
    provider: &str,
    base_url: &str,
    api_key: &str,
) -> Result<String, ValidateProbeError> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let mut req = client
        .get(&url)
        .header("Authorization", format!("Bearer {api_key}"));
    if provider == "openrouter" {
        req = req
            .header("HTTP-Referer", "https://nexusai.local")
            .header("X-Title", "PocketMind Hybrid AI Desktop");
    }
    let response = req
        .send()
        .await
        .map_err(|e| ValidateProbeError::Other(format!("Network error: {e}")))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    classify_probe_status(provider, status, &text)
}

async fn validate_anthropic_key(
    client: &reqwest::Client,
    api_key: &str,
) -> Result<String, ValidateProbeError> {
    let response = client
        .get("https://api.anthropic.com/v1/models")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| ValidateProbeError::Other(format!("Network error: {e}")))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    classify_probe_status("anthropic", status, &text)
}

async fn validate_gemini_key(
    client: &reqwest::Client,
    api_key: &str,
) -> Result<String, ValidateProbeError> {
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models?key={}&pageSize=1",
        urlencoding_loose(api_key)
    );
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| ValidateProbeError::Other(format!("Network error: {e}")))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    classify_probe_status("gemini", status, &text)
}

fn urlencoding_loose(s: &str) -> String {
    // API keys are typically URL-safe; encode reserved chars if present.
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u8),
        })
        .collect()
}

fn classify_probe_status(
    provider: &str,
    status: reqwest::StatusCode,
    body: &str,
) -> Result<String, ValidateProbeError> {
    if status.is_success() {
        return Ok(format!("{provider} API key is valid."));
    }
    let snippet = body.trim();
    let snippet = if snippet.len() > 280 {
        format!("{}…", &snippet[..280])
    } else {
        snippet.to_string()
    };
    // Auth failures
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(ValidateProbeError::InvalidKey(format!(
            "Invalid or unauthorized API key ({status}). {snippet}"
        )));
    }
    // Key was accepted but account/quota blocked — still useful signal that the key format/auth worked.
    if status.as_u16() == 402 {
        return Ok(format!(
            "API key authenticated, but {provider} requires billing/quota ({status}). {snippet}"
        ));
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Ok(format!(
            "API key looks valid (rate limited by {provider}). Try again shortly."
        ));
    }
    // Gemini sometimes returns 400 for bad keys
    if provider == "gemini"
        && (status == reqwest::StatusCode::BAD_REQUEST
            || snippet.to_ascii_lowercase().contains("api key not valid")
            || snippet.to_ascii_lowercase().contains("api_key_invalid"))
    {
        return Err(ValidateProbeError::InvalidKey(format!(
            "Invalid Gemini API key ({status}). {snippet}"
        )));
    }
    Err(ValidateProbeError::Other(format!(
        "Could not verify key ({status}). {snippet}"
    )))
}

impl RemoteBackend {
    fn build_openai_messages(&self, request: &GenerationRequest) -> Vec<Value> {
        let mut messages = vec![];
        messages.push(serde_json::json!({"role": "system", "content": nexus_formatting_system_prompt(request.system_prompt.as_deref())}));
        let images = &request.images;
        let mut first_user_done = false;
        if request.messages.is_empty() {
            messages.push(Self::user_content_with_images(request.prompt.trim(), images));
        } else {
            for m in &request.messages {
                if m.role == "tool" {
                    let mut obj = serde_json::json!({
                        "role": "tool",
                        "content": m.content.clone(),
                    });
                    if let Some(id) = &m.tool_call_id {
                        obj["tool_call_id"] = Value::String(id.clone());
                    }
                    if let Some(name) = &m.name {
                        obj["name"] = Value::String(name.clone());
                    }
                    messages.push(obj);
                    continue;
                }
                let role = match m.role.as_str() {
                    "assistant" => "assistant",
                    "system" => "system",
                    _ => "user",
                };
                let has_tool_calls = m
                    .tool_calls
                    .as_ref()
                    .map(|t| !t.is_empty())
                    .unwrap_or(false);
                if m.content.trim().is_empty()
                    && !has_tool_calls
                    && !(role == "user" && !images.is_empty() && !first_user_done)
                {
                    continue;
                }
                if role == "user" && !first_user_done {
                    first_user_done = true;
                    messages.push(Self::user_content_with_images(m.content.trim(), images));
                } else if role == "assistant" && has_tool_calls {
                    let tool_calls = m.tool_calls.as_ref().unwrap();
                    let calls: Vec<Value> = tool_calls
                        .iter()
                        .map(|tc| {
                            serde_json::json!({
                                "id": tc.id,
                                "type": if tc.kind.is_empty() { "function" } else { tc.kind.as_str() },
                                "function": {
                                    "name": tc.function.name,
                                    "arguments": tc.function.arguments,
                                }
                            })
                        })
                        .collect();
                    messages.push(serde_json::json!({
                        "role": "assistant",
                        "content": if m.content.trim().is_empty() { Value::Null } else { Value::String(m.content.trim().to_string()) },
                        "tool_calls": calls,
                    }));
                } else {
                    messages.push(serde_json::json!({"role": role, "content": m.content.trim()}));
                }
            }
            if !first_user_done && !images.is_empty() {
                messages.push(Self::user_content_with_images(request.prompt.trim(), images));
            }
        }
        messages
    }

    fn user_content_with_images(text: &str, images: &[crate::llm::GenerationImage]) -> Value {
        if images.is_empty() {
            return serde_json::json!({"role": "user", "content": text});
        }
        let mut parts: Vec<Value> = Vec::new();
        if !text.is_empty() {
            parts.push(serde_json::json!({"type": "text", "text": text}));
        }
        for img in images {
            let mime = if img.mime.trim().is_empty() { "image/png" } else { img.mime.trim() };
            let url = format!("data:{mime};base64,{}", img.base64.trim());
            parts.push(serde_json::json!({
                "type": "image_url",
                "image_url": { "url": url }
            }));
        }
        serde_json::json!({"role": "user", "content": parts})
    }

    fn gemini_user_parts(text: &str, images: &[crate::llm::GenerationImage], attach_images: bool) -> Vec<Value> {
        let mut parts = Vec::new();
        if !text.is_empty() {
            parts.push(serde_json::json!({"text": text}));
        }
        if attach_images {
            for img in images {
                let mime = if img.mime.trim().is_empty() { "image/png" } else { img.mime.trim() };
                parts.push(serde_json::json!({
                    "inline_data": {
                        "mime_type": mime,
                        "data": img.base64.trim(),
                    }
                }));
            }
        }
        if parts.is_empty() {
            parts.push(serde_json::json!({"text": "(empty)"}));
        }
        parts
    }

    fn openai_tools_to_anthropic(tools: &[crate::llm::OpenAiTool]) -> Vec<Value> {
        tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "name": t.function.name,
                    "description": t.function.description,
                    "input_schema": if t.function.parameters.is_null() {
                        serde_json::json!({"type": "object", "properties": {}})
                    } else {
                        t.function.parameters.clone()
                    },
                })
            })
            .collect()
    }

    fn openai_tools_to_gemini(tools: &[crate::llm::OpenAiTool]) -> Value {
        let decls: Vec<Value> = tools
            .iter()
            .map(|t| {
                let mut decl = serde_json::json!({
                    "name": t.function.name,
                    "description": t.function.description,
                });
                if !t.function.parameters.is_null() {
                    decl["parameters"] = t.function.parameters.clone();
                }
                decl
            })
            .collect();
        serde_json::json!([{ "functionDeclarations": decls }])
    }

    fn anthropic_tool_choice(choice: &Option<Value>) -> Value {
        match choice {
            None => serde_json::json!({"type": "auto"}),
            Some(Value::String(s)) => match s.as_str() {
                "none" => serde_json::json!({"type": "none"}),
                "required" => serde_json::json!({"type": "any"}),
                _ => serde_json::json!({"type": "auto"}),
            },
            Some(other) => other.clone(),
        }
    }

    fn gemini_tool_config(choice: &Option<Value>) -> Value {
        let mode = match choice {
            Some(Value::String(s)) if s == "none" => "NONE",
            Some(Value::String(s)) if s == "required" => "ANY",
            _ => "AUTO",
        };
        serde_json::json!({ "functionCallingConfig": { "mode": mode } })
    }

    fn parse_tool_args_value(arguments: &str) -> Value {
        let trimmed = arguments.trim();
        if trimmed.is_empty() {
            return serde_json::json!({});
        }
        serde_json::from_str(trimmed).unwrap_or_else(|_| serde_json::json!({ "raw": trimmed }))
    }

    fn tool_result_as_json(content: &str) -> Value {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return serde_json::json!({ "result": "" });
        }
        serde_json::from_str(trimmed).unwrap_or_else(|_| serde_json::json!({ "result": trimmed }))
    }

    fn anthropic_user_content(text: &str, images: &[crate::llm::GenerationImage], attach_images: bool) -> Value {
        if !attach_images || images.is_empty() {
            return Value::String(text.to_string());
        }
        let mut parts: Vec<Value> = Vec::new();
        if !text.is_empty() {
            parts.push(serde_json::json!({"type": "text", "text": text}));
        }
        for img in images {
            let mime = if img.mime.trim().is_empty() { "image/png" } else { img.mime.trim() };
            parts.push(serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": mime,
                    "data": img.base64.trim(),
                }
            }));
        }
        Value::Array(parts)
    }

    /// Convert OpenAI-shaped chat history into Anthropic Messages API messages
    /// (assistant `tool_use` blocks + user `tool_result` blocks).
    fn build_anthropic_messages(request: &GenerationRequest) -> Vec<Value> {
        let images = &request.images;
        let mut messages = Vec::new();
        let mut first_user_done = false;
        let mut pending_tool_results: Vec<Value> = Vec::new();

        let flush_tool_results = |msgs: &mut Vec<Value>, pending: &mut Vec<Value>| {
            if pending.is_empty() {
                return;
            }
            msgs.push(serde_json::json!({
                "role": "user",
                "content": std::mem::take(pending),
            }));
        };

        if request.messages.is_empty() {
            messages.push(serde_json::json!({
                "role": "user",
                "content": Self::anthropic_user_content(request.prompt.trim(), images, true)
            }));
            return messages;
        }

        for m in &request.messages {
            if m.role == "system" {
                continue;
            }
            if m.role == "tool" {
                let tool_use_id = m
                    .tool_call_id
                    .clone()
                    .unwrap_or_else(|| "toolu_unknown".to_string());
                pending_tool_results.push(serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": m.content.clone(),
                }));
                continue;
            }

            flush_tool_results(&mut messages, &mut pending_tool_results);

            let has_tool_calls = m
                .tool_calls
                .as_ref()
                .map(|t| !t.is_empty())
                .unwrap_or(false);

            if m.role == "assistant" {
                if has_tool_calls {
                    let mut content_blocks: Vec<Value> = Vec::new();
                    if !m.content.trim().is_empty() {
                        content_blocks.push(serde_json::json!({
                            "type": "text",
                            "text": m.content.trim(),
                        }));
                    }
                    for tc in m.tool_calls.as_ref().unwrap() {
                        content_blocks.push(serde_json::json!({
                            "type": "tool_use",
                            "id": if tc.id.is_empty() {
                                format!("toolu_{}", tc.function.name)
                            } else {
                                tc.id.clone()
                            },
                            "name": tc.function.name,
                            "input": Self::parse_tool_args_value(&tc.function.arguments),
                        }));
                    }
                    messages.push(serde_json::json!({
                        "role": "assistant",
                        "content": content_blocks,
                    }));
                } else if !m.content.trim().is_empty() {
                    messages.push(serde_json::json!({
                        "role": "assistant",
                        "content": m.content.trim(),
                    }));
                }
                continue;
            }

            // user
            if m.content.trim().is_empty() && !( !images.is_empty() && !first_user_done) {
                continue;
            }
            if !first_user_done {
                first_user_done = true;
                messages.push(serde_json::json!({
                    "role": "user",
                    "content": Self::anthropic_user_content(m.content.trim(), images, true)
                }));
            } else {
                messages.push(serde_json::json!({
                    "role": "user",
                    "content": m.content.trim(),
                }));
            }
        }

        flush_tool_results(&mut messages, &mut pending_tool_results);

        if messages.is_empty() {
            messages.push(serde_json::json!({
                "role": "user",
                "content": Self::anthropic_user_content(request.prompt.trim(), images, true)
            }));
        } else if !first_user_done && !images.is_empty() {
            messages.insert(
                0,
                serde_json::json!({
                    "role": "user",
                    "content": Self::anthropic_user_content(request.prompt.trim(), images, true)
                }),
            );
        }
        messages
    }

    /// Convert OpenAI-shaped history into Gemini `contents` with functionCall / functionResponse.
    fn build_gemini_contents(request: &GenerationRequest) -> Vec<Value> {
        let images = &request.images;
        let mut contents = Vec::new();
        let mut first_user_done = false;
        let mut pending_fn_responses: Vec<Value> = Vec::new();
        // Map tool_call_id → function name for results that omit `name`.
        let mut call_id_to_name: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        let flush_fn_responses = |msgs: &mut Vec<Value>, pending: &mut Vec<Value>| {
            if pending.is_empty() {
                return;
            }
            msgs.push(serde_json::json!({
                "role": "user",
                "parts": std::mem::take(pending),
            }));
        };

        if request.messages.is_empty() {
            contents.push(serde_json::json!({
                "role": "user",
                "parts": Self::gemini_user_parts(request.prompt.trim(), images, true)
            }));
            return contents;
        }

        for m in &request.messages {
            if m.role == "system" {
                continue;
            }
            if m.role == "tool" {
                let name = m
                    .name
                    .clone()
                    .or_else(|| {
                        m.tool_call_id
                            .as_ref()
                            .and_then(|id| call_id_to_name.get(id).cloned())
                    })
                    .unwrap_or_else(|| "unknown".to_string());
                pending_fn_responses.push(serde_json::json!({
                    "functionResponse": {
                        "name": name,
                        "response": Self::tool_result_as_json(&m.content),
                    }
                }));
                continue;
            }

            flush_fn_responses(&mut contents, &mut pending_fn_responses);

            let has_tool_calls = m
                .tool_calls
                .as_ref()
                .map(|t| !t.is_empty())
                .unwrap_or(false);

            if m.role == "assistant" {
                if has_tool_calls {
                    let mut parts: Vec<Value> = Vec::new();
                    if !m.content.trim().is_empty() {
                        parts.push(serde_json::json!({ "text": m.content.trim() }));
                    }
                    for tc in m.tool_calls.as_ref().unwrap() {
                        if !tc.id.is_empty() {
                            call_id_to_name.insert(tc.id.clone(), tc.function.name.clone());
                        }
                        parts.push(serde_json::json!({
                            "functionCall": {
                                "name": tc.function.name,
                                "args": Self::parse_tool_args_value(&tc.function.arguments),
                            }
                        }));
                    }
                    contents.push(serde_json::json!({
                        "role": "model",
                        "parts": parts,
                    }));
                } else if !m.content.trim().is_empty() {
                    contents.push(serde_json::json!({
                        "role": "model",
                        "parts": [{ "text": m.content.trim() }],
                    }));
                }
                continue;
            }

            // user
            if m.content.trim().is_empty() && !(!images.is_empty() && !first_user_done) {
                continue;
            }
            if !first_user_done {
                first_user_done = true;
                contents.push(serde_json::json!({
                    "role": "user",
                    "parts": Self::gemini_user_parts(m.content.trim(), images, true)
                }));
            } else {
                contents.push(serde_json::json!({
                    "role": "user",
                    "parts": [{ "text": m.content.trim() }],
                }));
            }
        }

        flush_fn_responses(&mut contents, &mut pending_fn_responses);

        if contents.is_empty() {
            contents.push(serde_json::json!({
                "role": "user",
                "parts": Self::gemini_user_parts(request.prompt.trim(), images, true)
            }));
        } else if !first_user_done && !images.is_empty() {
            contents.insert(
                0,
                serde_json::json!({
                    "role": "user",
                    "parts": Self::gemini_user_parts(request.prompt.trim(), images, true)
                }),
            );
        }
        contents
    }

    fn parse_anthropic_tool_calls(json: &Value) -> (String, Vec<ToolCall>) {
        let mut text = String::new();
        let mut tool_calls = Vec::new();
        if let Some(blocks) = json.get("content").and_then(|c| c.as_array()) {
            for block in blocks {
                match block.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        if let Some(piece) = block.get("text").and_then(|v| v.as_str()) {
                            text.push_str(piece);
                        }
                    }
                    Some("tool_use") => {
                        let id = block
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let input = block.get("input").cloned().unwrap_or_else(|| serde_json::json!({}));
                        let arguments = if input.is_string() {
                            input.as_str().unwrap_or("{}").to_string()
                        } else {
                            input.to_string()
                        };
                        tool_calls.push(ToolCall {
                            id: if id.is_empty() {
                                format!("toolu_{name}")
                            } else {
                                id
                            },
                            kind: "function".to_string(),
                            function: ToolCallFunction { name, arguments },
                        });
                    }
                    _ => {}
                }
            }
        }
        (text, tool_calls)
    }

    fn parse_gemini_tool_calls(json: &Value) -> (String, Vec<ToolCall>) {
        let mut text = String::new();
        let mut tool_calls = Vec::new();
        if let Some(parts) = json
            .get("candidates")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("content"))
            .and_then(|c| c.get("parts"))
            .and_then(|p| p.as_array())
        {
            for (idx, part) in parts.iter().enumerate() {
                if let Some(piece) = part.get("text").and_then(|v| v.as_str()) {
                    text.push_str(piece);
                }
                if let Some(fc) = part.get("functionCall") {
                    let name = fc
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let args = fc
                        .get("args")
                        .cloned()
                        .or_else(|| fc.get("arguments").cloned())
                        .unwrap_or_else(|| serde_json::json!({}));
                    let arguments = if args.is_string() {
                        args.as_str().unwrap_or("{}").to_string()
                    } else {
                        args.to_string()
                    };
                    tool_calls.push(ToolCall {
                        id: format!("call_{name}_{idx}"),
                        kind: "function".to_string(),
                        function: ToolCallFunction { name, arguments },
                    });
                }
            }
        }
        (text, tool_calls)
    }

    async fn generate_gemini(&self, request: GenerationRequest, tx: mpsc::Sender<GenerationChunk>) -> AppResult<()> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| AppError::NetworkError(e.to_string()))?;

        let contents = Self::build_gemini_contents(&request);
        let mut body = serde_json::json!({
            "contents": contents,
            "generationConfig": {
                "temperature": request.params.temperature,
                "topP": request.params.top_p,
                "maxOutputTokens": request.params.max_tokens.max(1),
            }
        });
        body["systemInstruction"] = serde_json::json!({
            "parts": [{ "text": nexus_formatting_system_prompt(request.system_prompt.as_deref()) }]
        });
        if !request.tools.is_empty() {
            body["tools"] = Self::openai_tools_to_gemini(&request.tools);
            body["toolConfig"] = Self::gemini_tool_config(&request.tool_choice);
        }

        let url = format!(
            "{}/models/{}:generateContent?key={}",
            self.base_url, self.model_id, self.api_key
        );
        let response = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::NetworkError(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
                return Err(AppError::InvalidApiKey {
                    provider: self.provider.clone(),
                    url: Self::get_api_key_url(&self.provider),
                });
            }
            return Err(AppError::InferenceError(format!("Gemini HTTP {}: {}", status, text)));
        }

        let json: Value = response.json().await.map_err(|e| AppError::NetworkError(e.to_string()))?;
        let (mut text, tool_calls) = Self::parse_gemini_tool_calls(&json);
        if text.trim().is_empty() && tool_calls.is_empty() {
            text = json.to_string();
        }
        let finish_reason = if tool_calls.is_empty() {
            "stop".to_string()
        } else {
            "tool_calls".to_string()
        };
        let _ = tx
            .send(GenerationChunk {
                text,
                finish_reason: Some(finish_reason),
                tokens_generated: 0,
                tokens_per_sec: 0.0,
                tool_calls: if tool_calls.is_empty() {
                    None
                } else {
                    Some(tool_calls)
                },
            })
            .await;
        Ok(())
    }

    async fn generate_anthropic(&self, request: GenerationRequest, tx: mpsc::Sender<GenerationChunk>) -> AppResult<()> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| AppError::NetworkError(e.to_string()))?;

        let messages = Self::build_anthropic_messages(&request);
        let mut body = serde_json::json!({
            "model": self.model_id,
            "max_tokens": request.params.max_tokens.max(1),
            "temperature": request.params.temperature,
            "system": nexus_formatting_system_prompt(request.system_prompt.as_deref()),
            "messages": messages,
        });
        if !request.tools.is_empty() {
            body["tools"] = Value::Array(Self::openai_tools_to_anthropic(&request.tools));
            body["tool_choice"] = Self::anthropic_tool_choice(&request.tool_choice);
        }

        let url = format!("{}/messages", self.base_url);
        let response = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::NetworkError(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
                return Err(AppError::InvalidApiKey {
                    provider: self.provider.clone(),
                    url: Self::get_api_key_url(&self.provider),
                });
            }
            return Err(AppError::InferenceError(format!("Anthropic HTTP {}: {}", status, text)));
        }

        let json: Value = response.json().await.map_err(|e| AppError::NetworkError(e.to_string()))?;
        let (mut text, tool_calls) = Self::parse_anthropic_tool_calls(&json);
        if text.trim().is_empty() && tool_calls.is_empty() {
            text = json.to_string();
        }
        let stop = json
            .get("stop_reason")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let finish_reason = if !tool_calls.is_empty() || stop == "tool_use" {
            "tool_calls".to_string()
        } else {
            "stop".to_string()
        };
        let _ = tx
            .send(GenerationChunk {
                text,
                finish_reason: Some(finish_reason),
                tokens_generated: 0,
                tokens_per_sec: 0.0,
                tool_calls: if tool_calls.is_empty() {
                    None
                } else {
                    Some(tool_calls)
                },
            })
            .await;
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
        if self.provider == "anthropic" {
            return self.generate_anthropic(request, tx).await;
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| AppError::NetworkError(e.to_string()))?;
        
        let mut body = serde_json::json!({
            "model": self.model_id,
            "messages": self.build_openai_messages(&request),
            "stream": true,
            "temperature": request.params.temperature,
            "top_p": request.params.top_p,
            "max_tokens": request.params.max_tokens,
        });
        if !request.tools.is_empty() {
            body["tools"] = serde_json::to_value(&request.tools)
                .unwrap_or_else(|_| Value::Array(vec![]));
            body["tool_choice"] = request
                .tool_choice
                .clone()
                .unwrap_or_else(|| Value::String("auto".to_string()));
        }

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
                .header("X-Title", "PocketMind Hybrid AI Desktop");
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
        let mut pending_tools: Vec<PendingToolCall> = Vec::new();
        let mut last_finish: Option<String> = None;

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
                    let choice = json.get("choices").and_then(|c| c.get(0));
                    if let Some(fr) = choice
                        .and_then(|c| c.get("finish_reason"))
                        .and_then(|v| v.as_str())
                    {
                        last_finish = Some(fr.to_string());
                    }
                    if let Some(delta) = choice.and_then(|c| c.get("delta")) {
                        if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
                            if !content.is_empty() {
                                let _ = tx
                                    .send(GenerationChunk {
                                        text: content.to_string(),
                                        finish_reason: None,
                                        tokens_generated: 0,
                                        tokens_per_sec: 0.0,
                                        tool_calls: None,
                                    })
                                    .await;
                            }
                        }
                        if let Some(arr) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                            merge_tool_call_deltas(&mut pending_tools, arr);
                        }
                    }
                }
            }
        }

        if !pending_tools.is_empty() {
            let calls: Vec<crate::llm::ToolCall> = pending_tools
                .into_iter()
                .map(|p| crate::llm::ToolCall {
                    id: if p.id.is_empty() {
                        format!("call_{}", p.index)
                    } else {
                        p.id
                    },
                    kind: "function".to_string(),
                    function: crate::llm::ToolCallFunction {
                        name: p.name,
                        arguments: p.arguments,
                    },
                })
                .collect();
            let _ = tx
                .send(GenerationChunk {
                    text: String::new(),
                    finish_reason: Some(
                        last_finish
                            .unwrap_or_else(|| "tool_calls".to_string()),
                    ),
                    tokens_generated: 0,
                    tokens_per_sec: 0.0,
                    tool_calls: Some(calls),
                })
                .await;
        } else if let Some(fr) = last_finish {
            let _ = tx
                .send(GenerationChunk {
                    text: String::new(),
                    finish_reason: Some(fr),
                    tokens_generated: 0,
                    tokens_per_sec: 0.0,
                    tool_calls: None,
                })
                .await;
        }

        Ok(())
    }
    
    async fn load_model(&self, _path: &str, _params: &GenerationParams) -> AppResult<()> { Ok(()) }
    async fn unload_model(&self) -> AppResult<()> { Ok(()) }
    fn is_loaded(&self) -> bool { true }
    fn backend_name(&self) -> &'static str { "remote" }
    fn estimate_tokens_per_sec(&self, _params_b: u32, _quant: &str, _hardware: &crate::hardware::SystemInfo) -> f32 { 120.0 }
}
