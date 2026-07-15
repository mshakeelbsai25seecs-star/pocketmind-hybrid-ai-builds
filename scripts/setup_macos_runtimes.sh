#!/usr/bin/env bash
# Install official llama.cpp release archives into NexusAI runtime folders.
#
# Notes:
# - Official macos-arm64 builds usually include Metal (libggml-metal).
# - Official macos-x64 builds are often CPU-only. For Intel Mac GPU acceleration
#   (AMD/Intel Metal), run after this:
#     ./scripts/build_macos_x64_metal_runtime.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOWNLOADS_DIR="${1:-$HOME/Downloads}"
TMP_DIR="$HOME/Downloads/nexusai-llama-macos-runtime-temp"
BASE_DIR="$PROJECT_DIR/bin/llama.cpp"

mkdir -p "$BASE_DIR/macos-arm64-metal" "$BASE_DIR/macos-arm64-cpu" "$BASE_DIR/macos-x64-metal" "$BASE_DIR/macos-x64-cpu"
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR/arm64" "$TMP_DIR/x64"

ARM64_TAR=$(ls -t "$DOWNLOADS_DIR"/llama-*-bin-macos-arm64*.tar.gz 2>/dev/null | head -n 1 || true)
X64_TAR=$(ls -t "$DOWNLOADS_DIR"/llama-*-bin-macos-x64*.tar.gz 2>/dev/null | head -n 1 || true)

if [ -z "$ARM64_TAR" ]; then
  echo "ERROR: macOS arm64 llama.cpp tar.gz not found in $DOWNLOADS_DIR"
  echo "Download the official macOS Apple Silicon / arm64 file from llama.cpp releases first."
  exit 1
fi

if [ -z "$X64_TAR" ]; then
  echo "ERROR: macOS x64 llama.cpp tar.gz not found in $DOWNLOADS_DIR"
  echo "Download the official macOS Intel / x64 file from llama.cpp releases first."
  exit 1
fi

echo "Extracting arm64 runtime: $ARM64_TAR"
tar -xzf "$ARM64_TAR" -C "$TMP_DIR/arm64"

echo "Extracting x64 runtime: $X64_TAR"
tar -xzf "$X64_TAR" -C "$TMP_DIR/x64"

rm -rf "$BASE_DIR/macos-arm64-metal"/* "$BASE_DIR/macos-arm64-cpu"/* "$BASE_DIR/macos-x64-metal"/* "$BASE_DIR/macos-x64-cpu"/*

cp -R "$TMP_DIR/arm64"/* "$BASE_DIR/macos-arm64-metal/"
cp -R "$TMP_DIR/arm64"/* "$BASE_DIR/macos-arm64-cpu/"
# Seed Intel folders from the official x64 archive (often CPU-only).
cp -R "$TMP_DIR/x64"/* "$BASE_DIR/macos-x64-metal/"
cp -R "$TMP_DIR/x64"/* "$BASE_DIR/macos-x64-cpu/"

chmod +x "$BASE_DIR/macos-arm64-metal/llama-server" "$BASE_DIR/macos-arm64-cpu/llama-server" "$BASE_DIR/macos-x64-metal/llama-server" "$BASE_DIR/macos-x64-cpu/llama-server"

echo "macOS runtimes installed:"
find "$BASE_DIR" -maxdepth 2 -name llama-server -print

if ! ls "$BASE_DIR/macos-x64-metal"/libggml-metal* >/dev/null 2>&1; then
  echo
  echo "NOTE: macos-x64-metal has no libggml-metal (official x64 archive is CPU-only)."
  echo "For AMD/Intel GPU acceleration on Intel Macs, build a real Metal runtime:"
  echo "  ./scripts/build_macos_x64_metal_runtime.sh"
fi
