#!/usr/bin/env bash
# Build a real Metal-enabled llama.cpp runtime for Intel macOS (x86_64) and
# install it into bin/llama.cpp/macos-x64-metal.
#
# Official llama-*-bin-macos-x64.tar.gz releases are typically CPU-only (no
# libggml-metal). Metal acceleration for AMD/Intel GPUs on Intel Macs requires
# building with GGML_METAL=ON on a Mac.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$PROJECT_DIR/bin/llama.cpp/macos-x64-metal"
BUILD_ROOT="${NEXUS_LLAMA_BUILD_DIR:-$HOME/Downloads/nexusai-llama-cpp-src}"
LLAMA_REPO="${NEXUS_LLAMA_REPO:-https://github.com/ggml-org/llama.cpp.git}"
# Match the currently bundled server when possible; fall back to latest master tip.
DEFAULT_TAG="b9981"
LLAMA_TAG="${NEXUS_LLAMA_TAG:-$DEFAULT_TAG}"
JOBS="${NEXUS_LLAMA_JOBS:-4}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: This script must run on macOS."
  exit 1
fi
if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "NOTE: Host arch is $(uname -m). This script targets macOS Intel (x86_64)."
  echo "      Continuing anyway — cmake will build for the native arch."
fi

command -v cmake >/dev/null || { echo "ERROR: cmake not found. brew install cmake"; exit 1; }
command -v git >/dev/null || { echo "ERROR: git not found."; exit 1; }
command -v clang++ >/dev/null || { echo "ERROR: clang++ not found. Install Xcode CLT."; exit 1; }

mkdir -p "$BUILD_ROOT"
if [[ ! -d "$BUILD_ROOT/.git" ]]; then
  echo "Cloning llama.cpp into $BUILD_ROOT ..."
  git clone --depth 1 --branch "$LLAMA_TAG" "$LLAMA_REPO" "$BUILD_ROOT" \
    || git clone --depth 1 "$LLAMA_REPO" "$BUILD_ROOT"
fi

cd "$BUILD_ROOT"
if git rev-parse -q --verify "refs/tags/$LLAMA_TAG" >/dev/null 2>&1 \
  || git ls-remote --exit-code --tags origin "refs/tags/$LLAMA_TAG" >/dev/null 2>&1; then
  git fetch --depth 1 origin "refs/tags/$LLAMA_TAG:refs/tags/$LLAMA_TAG" 2>/dev/null || true
  git checkout -f "$LLAMA_TAG" 2>/dev/null || git checkout -f "tags/$LLAMA_TAG" 2>/dev/null || true
else
  echo "Tag $LLAMA_TAG not found locally; using current checkout / master tip."
  git fetch --depth 1 origin master 2>/dev/null || git fetch --depth 1 origin main 2>/dev/null || true
fi

echo "Configuring Metal-enabled Release build..."
rm -rf build-metal
cmake -S . -B build-metal \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_NATIVE=OFF \
  -DGGML_BLAS=ON \
  -DLLAMA_BUILD_SERVER=ON \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_TOOLS=ON

echo "Building llama-server (jobs=$JOBS)..."
cmake --build build-metal --config Release -j"$JOBS" --target llama-server

BIN_DIR="build-metal/bin"
if [[ ! -x "$BIN_DIR/llama-server" ]]; then
  # Some cmake layouts place the binary under build-metal/bin/Release
  if [[ -x "$BIN_DIR/Release/llama-server" ]]; then
    BIN_DIR="$BIN_DIR/Release"
  else
    echo "ERROR: llama-server not found after build."
    find build-metal -name 'llama-server' -type f 2>/dev/null | head
    exit 1
  fi
fi

if ! ls "$BIN_DIR"/libggml-metal* >/dev/null 2>&1 && ! ls "$BIN_DIR"/../lib/libggml-metal* >/dev/null 2>&1; then
  # Libraries may sit next to the binary or in lib/
  META_LIB=$(find build-metal -name 'libggml-metal*' 2>/dev/null | head -n 1 || true)
  if [[ -z "$META_LIB" ]]; then
    echo "ERROR: Build finished but libggml-metal was not produced. Metal is not enabled."
    exit 1
  fi
fi

echo "Installing into $DEST ..."
mkdir -p "$DEST"
# Clear previous install but keep the folder
find "$DEST" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

# Prefer copying the whole bin dir (binaries + dylibs + any default.metallib)
cp -R "$BIN_DIR"/* "$DEST/" 2>/dev/null || true

# Also pull any GGML metal libs / metal shaders from the build tree if not in bin/
find build-metal -maxdepth 4 \( -name 'libggml-metal*' -o -name 'libggml*.dylib' -o -name 'libllama*.dylib' -o -name 'libmtmd*.dylib' -o -name 'default.metallib' -o -name '*.metal' \) \
  -type f 2>/dev/null | while read -r f; do
  base="$(basename "$f")"
  if [[ ! -e "$DEST/$base" ]]; then
    cp -f "$f" "$DEST/" || true
  fi
done

# Some layouts put dylibs under build-metal/bin and dependent libs under lib
if [[ -d build-metal/lib ]]; then
  cp -f build-metal/lib/*.dylib "$DEST/" 2>/dev/null || true
fi

chmod +x "$DEST/llama-server"

# Ensure @rpath resolution for dylibs living next to the binary
install_name_tool -add_rpath "@loader_path" "$DEST/llama-server" 2>/dev/null || true

echo
echo "Installed Metal runtime:"
ls -lh "$DEST/llama-server"
ls -lh "$DEST"/libggml-metal* 2>/dev/null || {
  echo "WARNING: libggml-metal* still missing in DEST — listing DEST:"
  ls -la "$DEST" | head -40
  exit 1
}

echo
echo "Version / backend probe:"
"$DEST/llama-server" --version 2>&1 | head -20 || true
"$DEST/llama-server" --help 2>&1 | rg -i "metal|gpu-layers|ngl" | head -20 || true

echo
echo "Done. Restart PocketMind Hybrid AI → Runtime → Scan runtime."
echo "Use Automatic Optimizer or Calculated Split; CPU Safe remains available."
