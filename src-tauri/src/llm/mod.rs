use serde::{Deserialize, Serialize};
use async_trait::async_trait;
use tokio::sync::mpsc;
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationParams {
    pub temperature: f32,
    pub top_k: u32,
    pub top_p: f32,
    pub repetition_penalty: f32,
    pub max_tokens: i32,
    pub context_size: u32,
    pub gpu_layers: i32,
    pub batch_size: u32,
    pub threads: u32,
    pub rope_scaling: Option<f32>,
    pub flash_attention: bool,
}

impl Default for GenerationParams {
    fn default() -> Self {
        Self {
            temperature: 0.45,
            top_k: 40,
            top_p: 0.82,
            repetition_penalty: 1.18,
            max_tokens: 256,
            context_size: 2048,
            gpu_layers: 0,
            batch_size: 128,
            threads: 0,
            rope_scaling: None,
            flash_attention: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallFunction {
    pub name: String,
    /// JSON-encoded arguments object (OpenAI shape).
    #[serde(default)]
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type", default = "default_tool_call_type")]
    pub kind: String,
    pub function: ToolCallFunction,
}

fn default_tool_call_type() -> String {
    "function".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAiFunctionDef {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAiTool {
    #[serde(rename = "type")]
    pub kind: String,
    pub function: OpenAiFunctionDef,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChatMessage {
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Optional image for multimodal (org/online vision) chat completions.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GenerationImage {
    pub mime: String,
    pub base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationRequest {
    /// Fallback single prompt, kept for compatibility.
    pub prompt: String,
    pub system_prompt: Option<String>,
    pub params: GenerationParams,
    pub model_path: Option<String>,
    pub backend: String,
    /// Preferred structured OpenAI-style messages.
    /// The frontend sends recent user/assistant turns here so llama.cpp receives
    /// real chat messages instead of one flattened transcript.
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    /// Images attached to the *first user* turn for vision-capable backends.
    #[serde(default)]
    pub images: Vec<GenerationImage>,
    /// Native function-calling tools (OpenAI-compat, Anthropic, Gemini).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<OpenAiTool>,
    /// e.g. "auto" | "none" | {"type":"function","function":{"name":"..."}}
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationChunk {
    pub text: String,
    pub finish_reason: Option<String>,
    pub tokens_generated: u32,
    pub tokens_per_sec: f32,
    /// Assembled tool calls (typically on the final chunk when finish_reason is tool_calls).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}

impl Default for GenerationChunk {
    fn default() -> Self {
        Self {
            text: String::new(),
            finish_reason: None,
            tokens_generated: 0,
            tokens_per_sec: 0.0,
            tool_calls: None,
        }
    }
}

#[async_trait]
pub trait InferenceBackend: Send + Sync {
    async fn generate_stream(
        &self,
        request: GenerationRequest,
        tx: mpsc::Sender<GenerationChunk>,
    ) -> AppResult<()>;
    
    async fn load_model(&self, path: &str, params: &GenerationParams) -> AppResult<()>;
    async fn unload_model(&self) -> AppResult<()>;
    fn is_loaded(&self) -> bool;
    fn backend_name(&self) -> &'static str;
    fn estimate_tokens_per_sec(&self, params_b: u32, quant: &str, hardware: &crate::hardware::SystemInfo) -> f32;
}

pub mod local;
pub mod remote;
pub mod runtime_discovery;