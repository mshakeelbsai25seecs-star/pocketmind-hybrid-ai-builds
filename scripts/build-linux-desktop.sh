#!/usr/bin/env bash
# Build PocketMind Hybrid AI Linux desktop packages (AppImage + .deb + staged tar.gz).
# Does NOT touch Windows Store / MSIX / NSIS scripts.
#
# Usage:
#   ./scripts/build-linux-desktop.sh
#   SKIP_CUDA=1 SKIP_VULKAN=1 ./scripts/build-linux-desktop.sh   # CI default (CPU only)
#   INCLUDE_CUDA=1 ./scripts/build-linux-desktop.sh              # also fetch CUDA runtime
#
# Outputs under dist-desktop/linux/ and distribution/linux-desktop/payload/
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: build-linux-desktop.sh must run on Linux (host=$(uname -s))."
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH_LABEL="x86_64" ;;
  aarch64|arm64) ARCH_LABEL="arm64" ;;
  *) ARCH_LABEL="$ARCH" ;;
esac

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo "1.0.0")"
OUT_ROOT="${OUT_ROOT:-$PROJECT_DIR/dist-desktop/linux}"
PAYLOAD="$PROJECT_DIR/distribution/linux-desktop/payload"
INCLUDE_CUDA="${INCLUDE_CUDA:-0}"
SKIP_CUDA="${SKIP_CUDA:-1}"
SKIP_VULKAN="${SKIP_VULKAN:-1}"
if [[ "$INCLUDE_CUDA" == "1" ]]; then
  SKIP_CUDA=0
fi

echo "==> PocketMind Linux desktop build"
echo "    version=$VERSION arch=$ARCH_LABEL"
echo "    SKIP_CUDA=$SKIP_CUDA SKIP_VULKAN=$SKIP_VULKAN"

export PATH="${HOME}/.cargo/bin:/usr/local/bin:${PATH}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PROJECT_DIR/src-tauri/target}"

# --- Frontend ---
if [[ ! -d node_modules ]]; then
  npm ci
else
  npm ci --prefer-offline 2>/dev/null || npm ci
fi
npm run build

# --- CPU llama runtime (CUDA optional / post-install like Store policy) ---
mkdir -p bin/llama.cpp src-tauri/resources/llama.cpp
if [[ ! -x bin/llama.cpp/cpu/llama-server ]]; then
  echo "==> Fetching Linux CPU llama.cpp runtime"
  SKIP_CUDA="$SKIP_CUDA" SKIP_VULKAN="$SKIP_VULKAN" bash scripts/setup_linux_runtimes.sh
else
  echo "==> Reusing existing bin/llama.cpp/cpu"
fi

# Stage CPU (and optional cuda/vulkan) into Tauri resources for embedding.
RESOURCE_LLAMA="src-tauri/resources/llama.cpp"
for backend in cpu cuda vulkan; do
  if [[ -d "bin/llama.cpp/$backend" && -e "bin/llama.cpp/$backend/llama-server" ]]; then
    rm -rf "$RESOURCE_LLAMA/$backend"
    mkdir -p "$RESOURCE_LLAMA/$backend"
    cp -a "bin/llama.cpp/$backend"/. "$RESOURCE_LLAMA/$backend"/
    chmod +x "$RESOURCE_LLAMA/$backend/llama-server" || true
    echo "    staged resources/llama.cpp/$backend"
  fi
done
mkdir -p src-tauri/resources/tooling/ci-keep src-tauri/resources/llama.cpp/ci-keep
printf 'ci\n' > src-tauri/resources/tooling/ci-keep/keep.txt
printf 'ci\n' > src-tauri/resources/llama.cpp/ci-keep/keep.txt
node scripts/sync-tauri-bundle-resources.mjs

# --- Tauri bundles (override nsis-only targets from tauri.conf.json) ---
echo "==> tauri build --bundles appimage,deb"
npx tauri build --bundles appimage,deb --ci

# --- Stage payload + modular artifacts ---
bash distribution/linux-desktop/scripts/stage-release.sh

rm -rf "$OUT_ROOT"
mkdir -p "$OUT_ROOT"

shopt -s nullglob
for f in "$PAYLOAD"/*.AppImage; do
  dest="$OUT_ROOT/PocketMind-Hybrid-AI-linux-${ARCH_LABEL}-${VERSION}.AppImage"
  cp "$f" "$dest"
  chmod +x "$dest"
  echo "    artifact: $(basename "$dest")"
done
for f in "$PAYLOAD"/*.deb; do
  dest="$OUT_ROOT/PocketMind-Hybrid-AI-linux-${ARCH_LABEL}-${VERSION}.deb"
  cp "$f" "$dest"
  echo "    artifact: $(basename "$dest")"
done
shopt -u nullglob

TAR_NAME="PocketMind-Hybrid-AI-linux-${ARCH_LABEL}-${VERSION}-desktop.tar.gz"
tar -C "$PAYLOAD" -czf "$OUT_ROOT/$TAR_NAME" .
echo "    artifact: $TAR_NAME"

# Copy install docs next to artifacts
for doc in INSTALL.md README.md WHAT_IS_INCLUDED.md; do
  [[ -f "distribution/linux-desktop/$doc" ]] && cp "distribution/linux-desktop/$doc" "$OUT_ROOT/$doc"
done

cat > "$OUT_ROOT/RUN.txt" <<EOF
PocketMind Hybrid AI — Linux ${ARCH_LABEL} v${VERSION}

AppImage (no install):
  chmod +x PocketMind-Hybrid-AI-linux-${ARCH_LABEL}-${VERSION}.AppImage
  ./PocketMind-Hybrid-AI-linux-${ARCH_LABEL}-${VERSION}.AppImage

Debian package:
  sudo dpkg -i PocketMind-Hybrid-AI-linux-${ARCH_LABEL}-${VERSION}.deb
  sudo apt-get install -f
  nexus-ai

Staged folder (tar.gz):
  tar -xzf PocketMind-Hybrid-AI-linux-${ARCH_LABEL}-${VERSION}-desktop.tar.gz
  # then run the AppImage/.deb from the extracted payload, or use the staged files.

CPU llama.cpp runtime is bundled when present under resources/llama.cpp/cpu.
Optional CUDA/Vulkan: on the target machine run:
  SKIP_CUDA=0 ./scripts/setup_linux_runtimes.sh
  # or place binaries under ~/.local/share/PocketMind/bin/llama.cpp/{cuda,vulkan}/
EOF

echo "==> Done. Artifacts in $OUT_ROOT"
ls -la "$OUT_ROOT"
