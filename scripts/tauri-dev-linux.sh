#!/usr/bin/env bash
# Low-memory / Linux-friendly Tauri dev launcher.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

export PATH="${HOME}/.cargo/bin:/usr/local/bin:${PATH}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PROJECT_DIR/src-tauri/target}"
export NEXUS_DATA_ROOT="${NEXUS_DATA_ROOT:-$HOME/.local/share/PocketMind}"

mkdir -p "$CARGO_TARGET_DIR" "$NEXUS_DATA_ROOT" "$PROJECT_DIR/dist"
if [[ ! -f "$PROJECT_DIR/dist/index.html" ]]; then
  printf '%s\n' '<!doctype html><title>PocketMind Hybrid AI</title>' > "$PROJECT_DIR/dist/index.html"
fi

echo "CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
echo "NEXUS_DATA_ROOT=$NEXUS_DATA_ROOT"

# ONNX (ort) prebuilts are not assumed on every Linux arch; defaults already exclude onnx-reranker.
# Qwen3-Reranker GGUF remains the primary neural reranker.
exec npx tauri dev
