fn main() {
    if let Err(err) = nexus_rag_gateway::run_blocking() {
        eprintln!("nexus-rag-gateway error: {err:#}");
        std::process::exit(1);
    }
}
