#!/usr/bin/env bash
# Build PocketMind Hybrid AI macOS desktop packages (.app + .dmg + zip).
# Does NOT touch Windows Store / MSIX / NSIS scripts.
#
# Usage (on macOS):
#   ./scripts/build-macos-desktop.sh
#   SKIP_RUNTIMES=1 ./scripts/build-macos-desktop.sh   # skip llama download if already staged
#
# Unsigned by default (no Apple Developer cert). Users: right-click → Open (Gatekeeper).
# If APPLE_SIGNING_IDENTITY / notarization secrets are set in CI later, signing can be added.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: build-macos-desktop.sh must run on macOS (host=$(uname -s))."
  exit 1
fi

HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  arm64) ARCH_LABEL="arm64" ;;
  x86_64) ARCH_LABEL="x86_64" ;;
  *) ARCH_LABEL="$HOST_ARCH" ;;
esac

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo "1.0.0")"
OUT_ROOT="${OUT_ROOT:-$PROJECT_DIR/dist-desktop/macos}"
PAYLOAD="$PROJECT_DIR/distribution/macos-desktop/payload"
SKIP_RUNTIMES="${SKIP_RUNTIMES:-0}"
UNIVERSAL="${UNIVERSAL:-0}"

echo "==> PocketMind macOS desktop build"
echo "    version=$VERSION host_arch=$ARCH_LABEL universal=$UNIVERSAL"
echo "    Signing: unsigned (no Apple cert configured in this script)"

export PATH="${HOME}/.cargo/bin:/usr/local/bin:${PATH}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PROJECT_DIR/src-tauri/target}"
# Tauri treats an empty signing identity as a real identity and fails codesign.
# Default to ad-hoc ("-") unless a real Apple identity is provided.
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  export APPLE_SIGNING_IDENTITY='-'
fi

if [[ ! -d node_modules ]]; then
  npm ci
else
  npm ci --prefer-offline 2>/dev/null || npm ci
fi
npm run build

# --- llama.cpp macOS runtimes ---
mkdir -p bin/llama.cpp src-tauri/resources/llama.cpp
if [[ "$SKIP_RUNTIMES" != "1" ]]; then
  need_fetch=0
  if [[ "$HOST_ARCH" == "arm64" && ! -x bin/llama.cpp/macos-arm64-metal/llama-server && ! -x bin/llama.cpp/macos-arm64-cpu/llama-server ]]; then
    need_fetch=1
  fi
  if [[ "$HOST_ARCH" == "x86_64" && ! -x bin/llama.cpp/macos-x64-cpu/llama-server && ! -x bin/llama.cpp/macos-x64-metal/llama-server ]]; then
    need_fetch=1
  fi
  if [[ "$need_fetch" == "1" ]]; then
    echo "==> Fetching macOS llama.cpp runtimes"
    bash scripts/setup_macos_runtimes.sh || echo "WARN: runtime fetch had issues; continuing (local models may need manual setup)."
  else
    echo "==> Reusing existing macOS llama.cpp runtimes under bin/llama.cpp/"
  fi
fi

# Stage macos-* into resources for sync (optional embed); stage-release also embeds into .app.
RESOURCE_LLAMA="src-tauri/resources/llama.cpp"
shopt -s nullglob
for dir in bin/llama.cpp/macos-*; do
  [[ -d "$dir" ]] || continue
  name="$(basename "$dir")"
  if [[ -e "$dir/llama-server" ]]; then
    rm -rf "$RESOURCE_LLAMA/$name"
    mkdir -p "$RESOURCE_LLAMA/$name"
    cp -a "$dir"/. "$RESOURCE_LLAMA/$name"/
    chmod +x "$RESOURCE_LLAMA/$name/llama-server" || true
    echo "    staged resources/llama.cpp/$name"
  fi
done
shopt -u nullglob

mkdir -p src-tauri/resources/tooling/ci-keep src-tauri/resources/llama.cpp/ci-keep
printf 'ci\n' > src-tauri/resources/tooling/ci-keep/keep.txt
printf 'ci\n' > src-tauri/resources/llama.cpp/ci-keep/keep.txt
node scripts/sync-tauri-bundle-resources.mjs

# --- Tauri bundles (override nsis-only targets) ---
echo "==> tauri build --bundles app,dmg"
BUILD_ARGS=(build --bundles app dmg --ci)
if [[ "$UNIVERSAL" == "1" ]] \
  && rustup target list --installed | grep -q "aarch64-apple-darwin" \
  && rustup target list --installed | grep -q "x86_64-apple-darwin"; then
  echo "    universal-apple-darwin"
  npx tauri "${BUILD_ARGS[@]}" --target universal-apple-darwin
  ARCH_LABEL="universal"
else
  npx tauri "${BUILD_ARGS[@]}"
fi

bash distribution/macos-desktop/scripts/stage-release.sh

rm -rf "$OUT_ROOT"
mkdir -p "$OUT_ROOT"

shopt -s nullglob
for f in "$PAYLOAD"/*.dmg; do
  dest="$OUT_ROOT/PocketMind-Hybrid-AI-macos-${ARCH_LABEL}-${VERSION}.dmg"
  cp "$f" "$dest"
  echo "    artifact: $(basename "$dest")"
done
for app in "$PAYLOAD"/*.app; do
  [[ -d "$app" ]] || continue
  zip_name="PocketMind-Hybrid-AI-macos-${ARCH_LABEL}-${VERSION}.app.zip"
  (cd "$PAYLOAD" && ditto -c -k --sequesterRsrc --keepParent "$(basename "$app")" "$OUT_ROOT/$zip_name")
  echo "    artifact: $zip_name"
done
shopt -u nullglob

for doc in INSTALL.md README.md WHAT_IS_INCLUDED.md; do
  [[ -f "distribution/macos-desktop/$doc" ]] && cp "distribution/macos-desktop/$doc" "$OUT_ROOT/$doc"
done

cat > "$OUT_ROOT/RUN.txt" <<EOF
PocketMind Hybrid AI — macOS ${ARCH_LABEL} v${VERSION}

This build is UNSIGNED (no Apple Developer ID / notarization secrets in CI).

Install from DMG:
  1. Open PocketMind-Hybrid-AI-macos-${ARCH_LABEL}-${VERSION}.dmg
  2. Drag PocketMind Hybrid AI to Applications
  3. First launch: right-click the app → Open → Open
     (Gatekeeper blocks unsigned apps until you approve once)

Or from .app.zip:
  unzip PocketMind-Hybrid-AI-macos-${ARCH_LABEL}-${VERSION}.app.zip
  # then right-click → Open as above

Data: ~/Library/Application Support/PocketMind

Metal/CPU llama runtimes are included when fetch succeeded (bin/llama.cpp/macos-*).
EOF

echo "==> Done. Artifacts in $OUT_ROOT"
ls -la "$OUT_ROOT"
