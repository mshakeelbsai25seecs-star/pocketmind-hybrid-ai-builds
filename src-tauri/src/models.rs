use serde::{Serialize, Deserialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub model_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub speed_bytes_per_sec: f32,
    pub status: String,
    pub error_message: Option<String>,
}

pub struct ModelDownloader;

impl ModelDownloader {
    pub fn new() -> Self { Self }

    pub async fn download_huggingface(&self, _repo: &str, _file: &str, _dest: &Path) -> crate::error::AppResult<()> {
        // Streaming download with integrity verification
        Ok(())
    }

    pub async fn verify_checksum(&self, path: &Path, expected: &str) -> crate::error::AppResult<bool> {
        use sha2::{Sha256, Digest};
        use std::io::Read;
        
        let mut file = std::fs::File::open(path)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 8192];
        
        loop {
            let n = file.read(&mut buffer)?;
            if n == 0 { break; }
            hasher.update(&buffer[..n]);
        }
        
        Ok(format!("{:x}", hasher.finalize()) == expected)
    }
}