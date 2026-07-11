#!/usr/bin/env bash
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
cp -R "$TMP_DIR/x64"/* "$BASE_DIR/macos-x64-metal/"
cp -R "$TMP_DIR/x64"/* "$BASE_DIR/macos-x64-cpu/"

chmod +x "$BASE_DIR/macos-arm64-metal/llama-server" "$BASE_DIR/macos-arm64-cpu/llama-server" "$BASE_DIR/macos-x64-metal/llama-server" "$BASE_DIR/macos-x64-cpu/llama-server"

echo "macOS runtimes installed:"
find "$BASE_DIR" -maxdepth 2 -name llama-server -print
