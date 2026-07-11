#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/payload"

BUNDLE_DMG="$REPO_ROOT/src-tauri/target/release/bundle/dmg"
BUNDLE_APP="$REPO_ROOT/src-tauri/target/release/bundle/macos"

echo "Staging macOS desktop release to $OUT_DIR"
mkdir -p "$OUT_DIR"

copied=false

if [[ -d "$BUNDLE_APP" ]]; then
  cp -R "$BUNDLE_APP"/*.app "$OUT_DIR/" 2>/dev/null || true
  copied=true
  echo "Copied .app from bundle/macos"
fi

if [[ -d "$BUNDLE_DMG" ]]; then
  cp "$BUNDLE_DMG"/*.dmg "$OUT_DIR/" 2>/dev/null || true
  copied=true
  echo "Copied .dmg"
fi

if [[ -d "$REPO_ROOT/bin" ]]; then
  rm -rf "$OUT_DIR/bin"
  cp -R "$REPO_ROOT/bin" "$OUT_DIR/bin"
  echo "Copied bin/ runtimes"
  copied=true
fi

mkdir -p "$OUT_DIR/models/embeddings"

if [[ "$copied" != true ]]; then
  echo "WARNING: No build artifacts found. Run 'npm run tauri build' on macOS first." >&2
  exit 1
fi

echo "Done."
