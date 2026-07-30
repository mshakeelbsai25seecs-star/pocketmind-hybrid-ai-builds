fn main() {
    if let Err(err) = pocketcode_agent_host::run_blocking() {
        eprintln!("pocketcode-agent-host error: {err:#}");
        std::process::exit(1);
    }
}
