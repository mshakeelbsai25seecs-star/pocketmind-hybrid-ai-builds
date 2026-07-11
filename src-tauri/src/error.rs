use thiserror::Error;
use serde::{Serialize, Deserialize};

#[derive(Error, Debug, Serialize, Deserialize, Clone)]
pub enum AppError {
    #[error("Out of memory: {0}. Try closing other apps or using a smaller model.")]
    OutOfMemory(String),
    
    #[error("GPU error: {0}. Falling back to CPU mode.")]
    GpuFailure(String),
    
    #[error("Model file missing: {0}")]
    MissingFile(String),
    
    #[error("Corrupt model: {0}. Please re-download.")]
    CorruptModel(String),
    
    #[error("Invalid API key for {provider}. Please check your key at {url}")]
    InvalidApiKey { provider: String, url: String },
    
    #[error("Network error: {0}. Check your connection.")]
    NetworkError(String),
    
    #[error("Unsupported hardware: {0}")]
    UnsupportedHardware(String),
    
    #[error("Context overflow. Reduce context size or enable truncation.")]
    ContextOverflow,
    
    #[error("Database error: {0}")]
    DatabaseError(String),
    
    #[error("Encryption error: {0}")]
    CryptoError(String),
    
    #[error("Inference error: {0}")]
    InferenceError(String),
    
    #[error("Download error: {0}")]
    DownloadError(String),
    
    #[error("Unknown error: {0}")]
    Unknown(String),
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        let msg = err.to_string();
        if msg.contains("memory") || msg.contains("OOM") {
            AppError::OutOfMemory(msg)
        } else if msg.contains("GPU") || msg.contains("CUDA") || msg.contains("Vulkan") {
            AppError::GpuFailure(msg)
        } else if msg.contains("network") || msg.contains("connect") {
            AppError::NetworkError(msg)
        } else {
            AppError::Unknown(msg)
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        AppError::DatabaseError(err.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        match err.kind() {
            std::io::ErrorKind::NotFound => AppError::MissingFile(err.to_string()),
            std::io::ErrorKind::InvalidData => AppError::CorruptModel(err.to_string()),
            _ => AppError::Unknown(err.to_string()),
        }
    }
}

impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        if err.is_timeout() || err.is_connect() {
            AppError::NetworkError(err.to_string())
        } else {
            AppError::InferenceError(err.to_string())
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;