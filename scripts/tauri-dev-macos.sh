#!/usr/bin/env bash
# Low-memory / safe Tauri dev launcher for macOS.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
export NEXUS_DATA_ROOT="${NEXUS_DATA_ROOT:-$HOME/Library/Application Support/PocketMind}"

if [[ ! -d node_modules ]]; then
  echo "Installing npm dependencies..."
  npm install
fi

if [[ ! -f "bin/llama.cpp/macos-x64-cpu/llama-server" && ! -f "bin/llama.cpp/macos-arm64-cpu/llama-server" ]]; then
  echo "WARNING: No macOS llama-server found under bin/llama.cpp/."
  echo "Run: ./scripts/setup_macos_runtimes.sh"
fi

echo "Data root: $NEXUS_DATA_ROOT"
echo "Starting Tauri dev (host arch=$(uname -m))..."
npm run tauri -- dev
