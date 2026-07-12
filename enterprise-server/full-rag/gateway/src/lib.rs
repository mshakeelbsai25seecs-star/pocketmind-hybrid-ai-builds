//! NexusAI Full Server RAG gateway.
//!
//! Opens SQLite under `NEXUS_DATA_ROOT`, indexes folders from
//! `collections/<name>/`, and serves Knowledge Chat over HTTP with Bearer auth.

mod auth;
mod config;
mod db;
mod http_clients;
mod index;
mod search;
mod server;

pub use config::GatewayConfig;
pub use server::run;

/// Blocking entry used by both the crate binary and the src-tauri `[[bin]]`.
pub fn run_blocking() -> anyhow::Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(run())
}
