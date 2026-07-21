#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$DESKTOP_DIR/payload"

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

# Copy ONLY macos-* llama.cpp runtime folders (never Windows cpu/cuda/vulkan trees).
LLAMA_SRC="$REPO_ROOT/bin/llama.cpp"
LLAMA_DST="$OUT_DIR/bin/llama.cpp"
if [[ -d "$LLAMA_SRC" ]]; then
  rm -rf "$LLAMA_DST"
  mkdir -p "$LLAMA_DST"
  shopt -s nullglob
  for dir in "$LLAMA_SRC"/macos-*; do
    [[ -d "$dir" ]] || continue
    name="$(basename "$dir")"
    cp -R "$dir" "$LLAMA_DST/$name"
    echo "Copied bin/llama.cpp/$name"
    copied=true
  done
  shopt -u nullglob

  # When a .app is staged, also embed runtimes under Contents/Resources/llama.cpp.
  shopt -s nullglob
  for app in "$OUT_DIR"/*.app; do
    [[ -d "$app" ]] || continue
    resources_llama="$app/Contents/Resources/llama.cpp"
    mkdir -p "$resources_llama"
    for dir in "$LLAMA_DST"/macos-*; do
      [[ -d "$dir" ]] || continue
      name="$(basename "$dir")"
      rm -rf "$resources_llama/$name"
      cp -R "$dir" "$resources_llama/$name"
    done
    echo "Embedded llama.cpp into $(basename "$app")/Contents/Resources/llama.cpp"
  done
  shopt -u nullglob
fi

for doc in INSTALL.md WHAT_IS_INCLUDED.md README.md; do
  if [[ -f "$DESKTOP_DIR/$doc" ]]; then
    cp "$DESKTOP_DIR/$doc" "$OUT_DIR/$doc"
    echo "Copied $doc"
  fi
done

mkdir -p "$OUT_DIR/models/embeddings"

if [[ "$copied" != true ]]; then
  echo "WARNING: No build artifacts found. Run 'npm run tauri build' on macOS first." >&2
  exit 1
fi

echo "Done. Zip only this payload/ folder + docs — never the git repo. See distribution/CLIENT_HANDOFF.md."
