use rand::Rng;
use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use sha2::{Sha256, Digest};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use crate::error::{AppError, AppResult};

pub struct CryptoVault {
    master_key: Vec<u8>,
}

impl CryptoVault {
    pub fn new(password: &str) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(password.as_bytes());
        let master_key = hasher.finalize().to_vec();
        Self { master_key }
    }

    pub fn encrypt(&self, plaintext: &str) -> AppResult<String> {
        let cipher = Aes256Gcm::new_from_slice(&self.master_key)
            .map_err(|e| AppError::CryptoError(e.to_string()))?;
        
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        
        let ciphertext = cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|e| AppError::CryptoError(e.to_string()))?;
        
        let mut combined = nonce_bytes.to_vec();
        combined.extend_from_slice(&ciphertext);
        Ok(BASE64.encode(&combined))
    }

    pub fn decrypt(&self, ciphertext_b64: &str) -> AppResult<String> {
        let combined = BASE64.decode(ciphertext_b64)
            .map_err(|e| AppError::CryptoError(e.to_string()))?;
        
        if combined.len() < 12 {
            return Err(AppError::CryptoError("Invalid ciphertext length".to_string()));
        }
        
        let (nonce_bytes, ciphertext) = combined.split_at(12);
        let nonce = Nonce::from_slice(nonce_bytes);
        
        let cipher = Aes256Gcm::new_from_slice(&self.master_key)
            .map_err(|e| AppError::CryptoError(e.to_string()))?;
        
        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| AppError::CryptoError(format!("Decryption failed: {}", e)))?;
        
        String::from_utf8(plaintext)
            .map_err(|e| AppError::CryptoError(e.to_string()))
    }

    pub fn derive_key_from_device() -> String {
        let mut seed = String::new();
        let mut hostname_cmd = std::process::Command::new("hostname");
        crate::process_util::no_window_std(&mut hostname_cmd);
        if let Ok(hostname) = hostname_cmd.output() {
            seed.push_str(&String::from_utf8_lossy(&hostname.stdout));
        }
        seed.push_str(std::env::consts::OS);
        seed.push_str(std::env::consts::ARCH);
        
        let mut hasher = Sha256::new();
        hasher.update(seed.as_bytes());
        format!("{:x}", hasher.finalize())
    }
}