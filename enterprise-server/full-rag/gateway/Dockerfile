# Multi-stage build for nexus-rag-gateway (standalone crate).
# Build context: enterprise-server/full-rag/gateway
FROM rust:1.83-bookworm AS builder
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libssl3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /src/target/release/nexus-rag-gateway /usr/local/bin/nexus-rag-gateway
ENV BIND=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/nexus-rag-gateway"]
