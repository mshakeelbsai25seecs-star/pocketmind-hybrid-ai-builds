#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$DESKTOP_DIR/payload"
BUNDLE="$REPO_ROOT/src-tauri/target/release/bundle"

echo "Staging Linux desktop release to $OUT_DIR"
mkdir -p "$OUT_DIR"

copied=false

for sub in appimage deb; do
  if [[ -d "$BUNDLE/$sub" ]]; then
    cp -R "$BUNDLE/$sub"/* "$OUT_DIR/" 2>/dev/null || true
    copied=true
    echo "Copied $sub artifacts"
  fi
done

# Copy ONLY Linux llama.cpp backends: cpu, cuda, vulkan (never macos-* folders).
LLAMA_SRC="$REPO_ROOT/bin/llama.cpp"
LLAMA_DST="$OUT_DIR/bin/llama.cpp"
if [[ -d "$LLAMA_SRC" ]]; then
  rm -rf "$LLAMA_DST"
  mkdir -p "$LLAMA_DST"
  for backend in cpu cuda vulkan; do
    if [[ -d "$LLAMA_SRC/$backend" ]]; then
      cp -R "$LLAMA_SRC/$backend" "$LLAMA_DST/$backend"
      echo "Copied bin/llama.cpp/$backend"
      copied=true
    fi
  done
fi

for doc in INSTALL.md WHAT_IS_INCLUDED.md README.md; do
  if [[ -f "$DESKTOP_DIR/$doc" ]]; then
    cp "$DESKTOP_DIR/$doc" "$OUT_DIR/$doc"
    echo "Copied $doc"
  fi
done

mkdir -p "$OUT_DIR/models/embeddings"

if [[ "$copied" != true ]]; then
  echo "WARNING: No build artifacts found. Run 'npm run tauri build' on Linux first." >&2
  exit 1
fi

echo "Done. Zip only this payload/ folder + docs — never the git repo. See distribution/CLIENT_HANDOFF.md."
