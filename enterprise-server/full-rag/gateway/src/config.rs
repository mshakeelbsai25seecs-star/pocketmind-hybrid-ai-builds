use std::env;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub data_root: PathBuf,
    pub collections_dir: PathBuf,
    pub db_path: PathBuf,
    pub token: String,
    pub llm_base_url: String,
    pub embed_code_url: String,
    pub embed_knowledge_url: String,
    pub rerank_url: String,
    pub bind: String,
}

impl GatewayConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        let data_root = PathBuf::from(
            env::var("NEXUS_DATA_ROOT").unwrap_or_else(|_| "/opt/nexusai/data".into()),
        );
        let collections_dir = data_root.join("collections");
        let db_path = data_root.join("gateway").join("knowledge.db");
        let token = env::var("NEXUSAI_SERVER_TOKEN").unwrap_or_default();
        if token.trim().is_empty() {
            anyhow::bail!("NEXUSAI_SERVER_TOKEN is required");
        }
        Ok(Self {
            data_root,
            collections_dir,
            db_path,
            token: token.trim().to_string(),
            llm_base_url: normalize_v1_base(
                &env::var("LLM_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:8000/v1".into()),
            ),
            embed_code_url: normalize_v1_base(
                &env::var("EMBED_CODE_URL").unwrap_or_else(|_| "http://127.0.0.1:8001/v1".into()),
            ),
            embed_knowledge_url: normalize_v1_base(
                &env::var("EMBED_KNOWLEDGE_URL")
                    .unwrap_or_else(|_| "http://127.0.0.1:8002/v1".into()),
            ),
            rerank_url: env::var("NEXUS_RERANK_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8003".into())
                .trim()
                .trim_end_matches('/')
                .to_string(),
            bind: env::var("BIND").unwrap_or_else(|_| "0.0.0.0:8080".into()),
        })
    }
}

fn normalize_v1_base(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.ends_with("/v1") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1")
    }
}
