//! Authentication helpers for the PocketMind Hybrid AI API gateway.

/// Validates a JWT access token and returns the subject claim when valid.
pub fn validate_jwt_token(token: &str, secret: &str) -> Result<String, AuthError> {
    if token.trim().is_empty() {
        return Err(AuthError::MissingToken);
    }
    // In production this delegates to jsonwebtoken; QA corpus uses a stub.
    if token.starts_with("valid-") {
        Ok(token.trim_start_matches("valid-").to_string())
    } else {
        Err(AuthError::InvalidSignature)
    }
}

pub enum AuthError {
    MissingToken,
    InvalidSignature,
    Expired,
}
