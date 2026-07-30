//! Locate the co-located PocketMind llama.cpp Docker admin package on server machines.

use crate::deployment;
use crate::error::AppResult;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct LlamaServerHostHint {
    pub package_root: Option<String>,
    pub admin_token: Option<String>,
    pub admin_url: String,
    pub chat_url: String,
    pub models_dir: Option<String>,
}

fn push_unique(out: &mut Vec<PathBuf>, path: PathBuf) {
    if out.iter().any(|p| p == &path) {
        return;
    }
    out.push(path);
}

fn llama_server_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    if let Ok(v) = std::env::var("LLAMA_CPP_SERVER_ROOT") {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            push_unique(&mut out, PathBuf::from(trimmed));
        }
    }

    let data_root = deployment::preferred_data_root();
    push_unique(&mut out, data_root.join("llama-cpp-server"));
    push_unique(
        &mut out,
        data_root
            .join("dist-server-client")
            .join("PocketMind-llama-cpp-server"),
    );

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            push_unique(&mut out, dir.join("PocketMind-llama-cpp-server"));
            push_unique(&mut out, dir.join("llama-cpp-server"));
            if let Some(parent) = dir.parent() {
                push_unique(
                    &mut out,
                    parent.join("dist-server-client").join("PocketMind-llama-cpp-server"),
                );
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors() {
            push_unique(
                &mut out,
                ancestor
                    .join("dist-server-client")
                    .join("PocketMind-llama-cpp-server"),
            );
            push_unique(&mut out, ancestor.join("enterprise-server").join("llama-cpp"));
        }
    }

    out
}

fn looks_like_package(root: &Path) -> bool {
    root.join("docker-compose.cuda.yml").is_file()
        && root.join("START_ADMIN.cmd").is_file()
}

fn read_admin_token(root: &Path) -> Option<String> {
    let token_path = root.join(".admin_token");
    std::fs::read_to_string(&token_path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn host_hint() -> AppResult<LlamaServerHostHint> {
    let port = std::env::var("LLAMA_ADMIN_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(8090);
    let chat_port = std::env::var("LLAMA_CHAT_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(8000);

    let package = llama_server_candidates()
        .into_iter()
        .find(|p| looks_like_package(p));

    Ok(LlamaServerHostHint {
        package_root: package.as_ref().map(|p| p.to_string_lossy().to_string()),
        admin_token: package.as_ref().and_then(|p| read_admin_token(p)),
        admin_url: format!("http://127.0.0.1:{port}/"),
        chat_url: format!("http://127.0.0.1:{chat_port}/v1"),
        models_dir: package.as_ref().map(|p| p.join("models").to_string_lossy().to_string()),
    })
}
