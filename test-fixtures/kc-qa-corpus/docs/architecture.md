# PocketMind Hybrid AI Architecture Overview

PocketMind Hybrid AI is a privacy-first desktop assistant built with Tauri, React, and local llama.cpp runtimes.

## Three layers

1. **Presentation layer** — React UI (ChatView, Knowledge Chat, Settings).
2. **Orchestration layer** — Tauri Rust backend (commands, indexing, retrieval).
3. **Inference layer** — Local or remote LLM and embedding servers.

## Knowledge Chat pipeline

Documents are scanned, chunked by partition (code, documentation, runbooks, logs, general),
indexed lexically and optionally with dense vectors, then retrieved at question time with citations.

## Storage

Production deployments store models and indexes under `D:\PocketMind` on Windows workstations.
