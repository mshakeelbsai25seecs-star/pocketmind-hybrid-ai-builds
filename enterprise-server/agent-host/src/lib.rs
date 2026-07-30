//! PocketMind Hybrid AI remote agent-host service.

mod auth;
mod config;
mod provision;
mod server;
mod store;

pub use config::AgentHostConfig;
pub use server::run;

pub fn run_blocking() -> anyhow::Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(run())
}
