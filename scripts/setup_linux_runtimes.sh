#!/usr/bin/env bash
# Download and stage llama.cpp Linux runtimes into bin/llama.cpp/{cpu,cuda,vulkan}.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "${SCRIPT_DIR}/bin/llama.cpp" || -d "${SCRIPT_DIR}/bin" ]] || compgen -G "${SCRIPT_DIR}/*.AppImage" >/dev/null 2>&1; then
  PROJECT_DIR="${SCRIPT_DIR}"
elif [[ -d "${SCRIPT_DIR}/../bin/llama.cpp" || -f "${SCRIPT_DIR}/../package.json" ]]; then
  PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
else
  PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi
BASE_DIR="$PROJECT_DIR/bin/llama.cpp"
TMP_DIR="${TMPDIR:-/tmp}/nexusai-llama-linux-$$"
TAG="${1:-}"
SKIP_CUDA="${SKIP_CUDA:-0}"
SKIP_VULKAN="${SKIP_VULKAN:-0}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer is for Linux only (host=$(uname -s))."
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH_TOKEN="x64" ;;
  aarch64|arm64) ARCH_TOKEN="arm64" ;;
  *)
    echo "Unsupported Linux arch: $ARCH"
    exit 1
    ;;
esac

mkdir -p "$BASE_DIR" "$TMP_DIR"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

API_URL="https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
if [[ -n "$TAG" ]]; then
  API_URL="https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${TAG}"
fi

echo "Querying $API_URL"
RELEASE_JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: PocketMind Hybrid AI-Installer' "$API_URL")"
echo "$RELEASE_JSON" > "$TMP_DIR/release.json"
TAG_NAME="$(python3 -c 'import json; print(json.load(open("'"$TMP_DIR"'/release.json")).get("tag_name",""))')"
echo "Release: $TAG_NAME"

find_asset_url() {
  # Args: substring tokens that ALL must appear in asset name
  python3 - "$TMP_DIR/release.json" "$@" <<'PY'
import json, sys
path = sys.argv[1]
tokens = sys.argv[2:]
data = json.load(open(path))
for a in data.get("assets", []):
    name = a.get("name", "")
    if all(tok in name for tok in tokens):
        print(a["browser_download_url"])
        raise SystemExit(0)
raise SystemExit(1)
PY
}

install_backend() {
  local backend="$1"
  local url="$2"
  local dest="$BASE_DIR/$backend"
  local archive="$TMP_DIR/${backend}.tar.gz"
  local extract="$TMP_DIR/${backend}_extract"

  echo ""
  echo "=== Installing $backend ==="
  echo "URL: $url"
  rm -rf "$extract"
  mkdir -p "$extract" "$dest"
  curl -fL --retry 5 -o "$archive" "$url"
  tar -xzf "$archive" -C "$extract"
  local server
  server="$(find "$extract" -type f -name llama-server | head -n 1 || true)"
  if [[ -z "$server" ]]; then
    echo "FAIL: llama-server not found in archive for $backend"
    return 1
  fi
  local root
  root="$(cd "$(dirname "$server")" && pwd)"
  find "$dest" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -a "$root"/. "$dest"/
  chmod +x "$dest/llama-server"
  echo "OK: $dest/llama-server"
}

CPU_URL=""
if CPU_URL="$(find_asset_url "bin-ubuntu-${ARCH_TOKEN}" ".tar.gz")"; then
  :
elif [[ "$ARCH_TOKEN" == "x64" ]] && CPU_URL="$(find_asset_url "bin-ubuntu-x64" ".tar.gz")"; then
  :
else
  echo "Could not find a Linux CPU runtime asset for arch=$ARCH_TOKEN"
  exit 1
fi
install_backend "cpu" "$CPU_URL"

if [[ "$SKIP_VULKAN" != "1" ]]; then
  if VULKAN_URL="$(find_asset_url "bin-ubuntu-vulkan-${ARCH_TOKEN}" ".tar.gz")"; then
    install_backend "vulkan" "$VULKAN_URL" || true
  else
    echo "WARN: no Vulkan asset for $ARCH_TOKEN (optional)"
  fi
fi

if [[ "$SKIP_CUDA" != "1" && "$ARCH_TOKEN" == "x64" ]]; then
  if CUDA_URL="$(find_asset_url "bin-ubuntu" "cuda" ".tar.gz")"; then
    install_backend "cuda" "$CUDA_URL" || true
  else
    echo "WARN: no CUDA Linux asset found in this release (optional)."
    echo "      Place a CUDA-enabled llama-server under bin/llama.cpp/cuda/ manually if needed."
  fi
fi

echo ""
echo "Installed under: $BASE_DIR"
echo "Next: npm run verify:linux-runtimes"
echo "Dev:  npm run tauri:dev:linux"
