#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/payload"
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

if [[ -d "$REPO_ROOT/bin" ]]; then
  rm -rf "$OUT_DIR/bin"
  cp -R "$REPO_ROOT/bin" "$OUT_DIR/bin"
  copied=true
fi

mkdir -p "$OUT_DIR/models/embeddings"

if [[ "$copied" != true ]]; then
  echo "WARNING: No build artifacts found. Run 'npm run tauri build' on Linux first." >&2
  exit 1
fi

echo "Done."
