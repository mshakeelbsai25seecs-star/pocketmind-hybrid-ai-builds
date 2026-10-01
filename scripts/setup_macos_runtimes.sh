#!/usr/bin/env bash
# Install llama.cpp runtimes for BOTH Apple Silicon and Intel Macs.
#
# Usage:
#   ./scripts/setup_macos_runtimes.sh              # auto-download latest official builds
#   ./scripts/setup_macos_runtimes.sh ~/Downloads  # prefer tarballs already in Downloads
#
# Notes:
# - Official macos-arm64 builds usually include Metal (libggml-metal).
# - Official macos-x64 builds are often CPU-only. On Intel Macs with a discrete
#   Metal GPU (e.g. AMD Radeon), also run:
#     ./scripts/build_macos_x64_metal_runtime.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo layout: scripts/setup_*.sh → project root is parent.
# Packaged layout: script sits next to bin/ or .app → project root is script dir.
if [[ -d "${SCRIPT_DIR}/bin/llama.cpp" || -d "${SCRIPT_DIR}/bin" ]] || compgen -G "${SCRIPT_DIR}/*.app" >/dev/null 2>&1; then
  PROJECT_DIR="${SCRIPT_DIR}"
elif [[ -d "${SCRIPT_DIR}/../bin/llama.cpp" || -f "${SCRIPT_DIR}/../package.json" ]]; then
  PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
else
  PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi
DOWNLOADS_DIR="${1:-$HOME/Downloads}"
CACHE_DIR="${NEXUS_LLAMA_CACHE:-$HOME/Downloads/nexusai-llama-releases}"
TMP_DIR="$HOME/Downloads/nexusai-llama-macos-runtime-temp"
BASE_DIR="$PROJECT_DIR/bin/llama.cpp"
REPO="${NEXUS_LLAMA_REPO:-ggml-org/llama.cpp}"

mkdir -p "$BASE_DIR/macos-arm64-metal" "$BASE_DIR/macos-arm64-cpu" \
         "$BASE_DIR/macos-x64-metal" "$BASE_DIR/macos-x64-cpu" \
         "$CACHE_DIR"
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR/arm64" "$TMP_DIR/x64"

find_local_tar() {
  local pattern="$1"
  ls -t "$DOWNLOADS_DIR"/$pattern 2>/dev/null | head -n 1 || true
}

download_latest_asset() {
  local needle="$1"   # e.g. macos-arm64
  local dest_dir="$2"
  mkdir -p "$dest_dir"

  if ! command -v curl >/dev/null 2>&1; then
    echo "ERROR: curl is required to download llama.cpp releases."
    exit 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 is required to parse GitHub release JSON."
    exit 1
  fi

  echo "Resolving llama.cpp release asset matching *$needle* ..." >&2
  local url name out
  # IMPORTANT: /releases/latest is often a stub (e.g. v0.5.0) with no binaries.
  # Prefer the newest b##### release that ships the requested macOS asset.
  url="$(
    curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=20" | python3 -c '
import json, sys, re
needle = sys.argv[1].lower()
releases = json.load(sys.stdin)
for rel in releases:
    tag = str(rel.get("tag_name") or "")
    if not re.match(r"^b\d+", tag):
        continue
    for a in rel.get("assets") or []:
        n = (a.get("name") or "").lower()
        if needle in n and n.endswith(".tar.gz"):
            print(f"Selected release: {tag}", file=sys.stderr)
            print(a["browser_download_url"])
            raise SystemExit(0)
raise SystemExit(2)
' "$needle"
  )" || {
    echo "ERROR: No release asset matching *$needle*.tar.gz in recent $REPO b##### releases." >&2
    exit 1
  }

  name="$(basename "$url")"
  out="$dest_dir/$name"
  if [[ -f "$out" && -s "$out" ]]; then
    echo "Using cached: $out" >&2
  else
    echo "Downloading $name ..." >&2
    curl -fL --retry 3 --retry-delay 2 -o "$out.partial" "$url" >&2
    mv "$out.partial" "$out"
  fi
  printf '%s\n' "$out"
}

flatten_extract() {
  local dir="$1"
  shopt -s nullglob
  local entries=("$dir"/*)
  shopt -u nullglob
  if [[ ${#entries[@]} -eq 1 && -d "${entries[0]}" ]]; then
    shopt -s dotglob
    mv "${entries[0]}"/* "$dir"/ 2>/dev/null || true
    rmdir "${entries[0]}" 2>/dev/null || true
    shopt -u dotglob
  fi
}

ARM64_TAR="$(find_local_tar 'llama-*-bin-macos-arm64*.tar.gz')"
X64_TAR="$(find_local_tar 'llama-*-bin-macos-x64*.tar.gz')"

if [[ -z "$ARM64_TAR" ]]; then
  ARM64_TAR="$(download_latest_asset 'macos-arm64' "$CACHE_DIR")"
fi
if [[ -z "$X64_TAR" ]]; then
  X64_TAR="$(download_latest_asset 'macos-x64' "$CACHE_DIR")"
fi

echo "Extracting arm64 runtime: $ARM64_TAR"
tar -xzf "$ARM64_TAR" -C "$TMP_DIR/arm64"
flatten_extract "$TMP_DIR/arm64"

echo "Extracting x64 runtime: $X64_TAR"
tar -xzf "$X64_TAR" -C "$TMP_DIR/x64"
flatten_extract "$TMP_DIR/x64"

if [[ -d "$TMP_DIR/arm64/bin" ]]; then TMP_ARM="$TMP_DIR/arm64/bin"; else TMP_ARM="$TMP_DIR/arm64"; fi
if [[ -d "$TMP_DIR/x64/bin" ]]; then TMP_X64="$TMP_DIR/x64/bin"; else TMP_X64="$TMP_DIR/x64"; fi

if [[ ! -f "$TMP_ARM/llama-server" ]]; then
  echo "ERROR: llama-server missing after extracting arm64 archive."
  exit 1
fi
if [[ ! -f "$TMP_X64/llama-server" ]]; then
  echo "ERROR: llama-server missing after extracting x64 archive."
  exit 1
fi

# Preserve a previously built Intel Metal runtime (official x64 tarballs are often CPU-only).
PRESERVE_X64_METAL=""
if ls "$BASE_DIR/macos-x64-metal"/libggml-metal* >/dev/null 2>&1; then
  PRESERVE_X64_METAL="$(mktemp -d "${TMPDIR:-/tmp}/nexus-x64-metal.XXXXXX")"
  cp -R "$BASE_DIR/macos-x64-metal/." "$PRESERVE_X64_METAL/"
  echo "Preserving existing macos-x64-metal Metal build..."
fi

rm -rf "$BASE_DIR/macos-arm64-metal"/* "$BASE_DIR/macos-arm64-cpu"/* \
       "$BASE_DIR/macos-x64-metal"/* "$BASE_DIR/macos-x64-cpu"/*

cp -R "$TMP_ARM"/. "$BASE_DIR/macos-arm64-metal/"
cp -R "$TMP_ARM"/. "$BASE_DIR/macos-arm64-cpu/"
cp -R "$TMP_X64"/. "$BASE_DIR/macos-x64-metal/"
cp -R "$TMP_X64"/. "$BASE_DIR/macos-x64-cpu/"

# Restore Intel Metal if the official archive did not include libggml-metal.
if [[ -n "$PRESERVE_X64_METAL" ]]; then
  if ! ls "$BASE_DIR/macos-x64-metal"/libggml-metal* >/dev/null 2>&1; then
    echo "Restoring preserved macos-x64-metal Metal build (official archive had no Metal libs)."
    rm -rf "$BASE_DIR/macos-x64-metal"/*
    cp -R "$PRESERVE_X64_METAL"/. "$BASE_DIR/macos-x64-metal/"
  fi
  rm -rf "$PRESERVE_X64_METAL"
fi

chmod +x \
  "$BASE_DIR/macos-arm64-metal/llama-server" \
  "$BASE_DIR/macos-arm64-cpu/llama-server" \
  "$BASE_DIR/macos-x64-metal/llama-server" \
  "$BASE_DIR/macos-x64-cpu/llama-server"

echo
echo "macOS runtimes installed:"
find "$BASE_DIR" -maxdepth 2 -name llama-server -print

echo
if [[ -x "$PROJECT_DIR/scripts/verify_macos_runtimes.sh" ]]; then
  "$PROJECT_DIR/scripts/verify_macos_runtimes.sh" || true
elif [[ -x "$SCRIPT_DIR/verify_macos_runtimes.sh" ]]; then
  "$SCRIPT_DIR/verify_macos_runtimes.sh" || true
fi

if ! ls "$BASE_DIR/macos-x64-metal"/libggml-metal* >/dev/null 2>&1; then
  echo
  echo "NOTE: macos-x64-metal has no libggml-metal (official Intel archive is often CPU-only)."
  echo "On Intel Macs with AMD/discrete Metal GPU, build a real Metal runtime:"
  echo "  ./scripts/build_macos_x64_metal_runtime.sh"
fi

echo
echo "Done. Restart PocketMind Hybrid AI → Runtime → Scan runtime → Use Automatic Optimizer (or CPU Safe)."
