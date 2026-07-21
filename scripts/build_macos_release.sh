#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

echo "Checking macOS runtime folders..."
for dir in   "bin/llama.cpp/macos-arm64-metal"   "bin/llama.cpp/macos-arm64-cpu"   "bin/llama.cpp/macos-x64-metal"   "bin/llama.cpp/macos-x64-cpu"; do
  if [ ! -f "$dir/llama-server" ]; then
    echo "WARNING: $dir/llama-server is missing. This Mac family may not run local models offline."
  else
    chmod +x "$dir/llama-server" || true
  fi
done

echo "Building PocketMind Hybrid AI for macOS..."
npm install
npm run build
cd src-tauri
cargo check
cd ..

if rustup target list --installed | grep -q "aarch64-apple-darwin" && rustup target list --installed | grep -q "x86_64-apple-darwin"; then
  echo "Building universal Apple Silicon + Intel target..."
  npm run tauri build -- --target universal-apple-darwin
else
  echo "Universal Rust targets are not both installed. Building for the current Mac architecture only."
  echo "To build universal later: rustup target add aarch64-apple-darwin x86_64-apple-darwin"
  npm run tauri build
fi

echo "Done. Check src-tauri/target/release/bundle for .app/.dmg outputs."
