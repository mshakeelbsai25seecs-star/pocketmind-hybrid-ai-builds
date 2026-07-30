use std::env;
use std::path::PathBuf;

fn default_agent_host_data_root() -> String {
    if cfg!(windows) {
        env::var("LOCALAPPDATA")
            .map(|root| PathBuf::from(root).join("PocketMind").join("agent-host"))
            .unwrap_or_else(|_| PathBuf::from("./agent-host-data"))
            .to_string_lossy()
            .into_owned()
    } else {
        "/var/lib/pocketmind/agent-host".to_string()
    }
}

#[derive(Debug, Clone)]
pub struct AgentHostConfig {
    pub data_root: PathBuf,
    pub workspaces_dir: PathBuf,
    pub meta_dir: PathBuf,
    pub uploads_dir: PathBuf,
    pub token: String,
    pub bind: String,
}

impl AgentHostConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        let token = env::var("AGENT_HOST_TOKEN").unwrap_or_default();
        if token.trim().is_empty() {
            anyhow::bail!("AGENT_HOST_TOKEN is required");
        }

        let default_data = default_agent_host_data_root();
        let data_root = PathBuf::from(env::var("AGENT_HOST_DATA").unwrap_or(default_data));
        let bind = env::var("AGENT_HOST_BIND").unwrap_or_else(|_| "0.0.0.0:8788".into());

        Ok(Self {
            workspaces_dir: data_root.join("workspaces"),
            meta_dir: data_root.join("meta"),
            uploads_dir: data_root.join("uploads"),
            data_root,
            token: token.trim().to_string(),
            bind,
        })
    }
}
