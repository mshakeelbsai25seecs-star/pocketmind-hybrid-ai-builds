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

/// True when `file_path` resolves under `collection_root` (after normalize). Soft-safe for Image RAG.
pub fn path_is_under_collection_root(file_path: &str, collection_root: &str) -> bool {
    let file = crate::deployment::normalize_path_string(file_path.trim().trim_matches('"'));
    let root = crate::deployment::normalize_path_string(collection_root.trim().trim_matches('"'));
    if file.is_empty() || root.is_empty() || contains_parent_traversal(&file) {
        return false;
    }
    let file_path = Path::new(&file);
    let root_path = Path::new(&root);
    let (Ok(file_canon), Ok(root_canon)) = (file_path.canonicalize(), root_path.canonicalize()) else {
        // Fallback: prefix check on normalized strings when canonicalize fails (missing file).
        let file_l = file.to_ascii_lowercase();
        let root_l = root.to_ascii_lowercase().trim_end_matches(['/', '\\']).to_string();
        return file_l.starts_with(&root_l)
            && (file_l.len() == root_l.len()
                || file_l.as_bytes().get(root_l.len()) == Some(&b'/')
                || file_l.as_bytes().get(root_l.len()) == Some(&b'\\'));
    };
    file_canon.starts_with(&root_canon)
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
    // Platform-native separators (Windows `\`, Unix `/`) — never force backslashes on Mac/Linux.
    let clean = deployment::normalize_path_string(path.trim().trim_matches('"'));
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
