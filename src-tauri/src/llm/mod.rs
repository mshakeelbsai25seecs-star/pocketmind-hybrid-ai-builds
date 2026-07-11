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
pub struct ChatMessage {
    pub role: String,
    pub content: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationChunk {
    pub text: String,
    pub finish_reason: Option<String>,
    pub tokens_generated: u32,
    pub tokens_per_sec: f32,
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