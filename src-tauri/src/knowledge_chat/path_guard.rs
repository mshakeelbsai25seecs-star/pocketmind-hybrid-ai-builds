use crate::database::Database;
use crate::deployment::{self, DeploymentConfig};
use crate::error::{AppError, AppResult};
use std::path::Path;

pub fn load_deployment(db: &Database) -> DeploymentConfig {
    deployment::load_deployment_config(db)
}

fn contains_parent_traversal(path: &str) -> bool {
    path.replace('\\', "/")
        .split('/')
        .any(|segment| segment == "..")
}

/// Knowledge Chat may index any local folder the user selects (not limited to deployment roots).
pub fn ensure_knowledge_folder_path(path: &str, label: &str) -> AppResult<()> {
    let clean = path.trim().trim_matches('"');
    if clean.is_empty() {
        return Err(AppError::Unknown(format!("{label} path is required.")));
    }
    if contains_parent_traversal(clean) {
        return Err(AppError::Unknown(format!(
            "{label} path cannot contain parent traversal (..)."
        )));
    }
    let candidate = Path::new(clean);
    if candidate.exists() && !candidate.is_dir() {
        return Err(AppError::Unknown(format!(
            "{label} must be a folder, not a file: {clean}"
        )));
    }
    Ok(())
}

pub fn ensure_allowed_path(config: &DeploymentConfig, path: &str, label: &str) -> AppResult<()> {
    if path.trim().is_empty() {
        return Err(AppError::Unknown(format!("{label} path is required.")));
    }
    if !config.is_path_allowed(path) {
        return Err(AppError::Unknown(format!(
            "{label} path is outside allowed deployment roots: {path}"
        )));
    }
    Ok(())
}

pub fn ensure_allowed_model_path(config: &DeploymentConfig, path: &str, label: &str) -> AppResult<String> {
    let clean = path.trim().trim_matches('"').replace('/', "\\");
    ensure_allowed_path(config, &clean, label)?;
    Ok(clean)
}

/// Embedding models may live outside deployment roots when the user browses to a
/// local `.gguf` on disk. Allow allowed roots OR any existing GGUF file path.
pub fn is_usable_embedding_model_path(config: &DeploymentConfig, path: &str) -> bool {
    let clean = path.trim().trim_matches('"');
    if clean.is_empty() {
        return false;
    }
    if config.is_path_allowed(clean) {
        return true;
    }
    crate::gguf::is_valid_gguf_file(Path::new(clean))
}
