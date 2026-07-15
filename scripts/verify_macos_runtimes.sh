#!/usr/bin/env bash
# Verify NexusAI macOS llama.cpp runtime layout for universal (arm64 + x64) support.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_DIR="$PROJECT_DIR/bin/llama.cpp"
HOST_ARCH="$(uname -m)"
FAIL=0

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This verifier is for macOS only (host=$(uname -s))."
  exit 0
fi

echo "Host architecture: $HOST_ARCH"
echo "Runtime root: $BASE_DIR"
echo

check_runtime() {
  local dir="$1"
  local expect_arch="$2"   # arm64 | x86_64
  local expect_metal="$3"  # yes | no | optional
  local path="$BASE_DIR/$dir/llama-server"
  local label="[$dir]"

  if [[ ! -x "$path" && ! -f "$path" ]]; then
    echo "FAIL  $label missing llama-server"
    FAIL=1
    return
  fi
  chmod +x "$path" 2>/dev/null || true

  local file_out
  file_out="$(file "$path" 2>/dev/null || true)"
  if ! echo "$file_out" | grep -q "$expect_arch"; then
    echo "FAIL  $label wrong arch (expected $expect_arch): $file_out"
    FAIL=1
  else
    echo "OK    $label binary arch matches ($expect_arch)"
  fi

  if ! "$path" --help >/dev/null 2>&1; then
    # On wrong-host arch (e.g. running arm64 binary on Intel) --help may fail; warn only.
    if [[ "$HOST_ARCH" == "$expect_arch" ]] || { [[ "$HOST_ARCH" == "aarch64" && "$expect_arch" == "arm64" ]]; }; then
      echo "FAIL  $label llama-server --help failed on native host"
      FAIL=1
    else
      echo "SKIP  $label --help (not native to this host)"
    fi
  else
    echo "OK    $label llama-server --help"
  fi

  local has_metal=0
  if ls "$BASE_DIR/$dir"/libggml-metal* >/dev/null 2>&1; then
    has_metal=1
  fi

  case "$expect_metal" in
    yes)
      if [[ $has_metal -eq 1 ]]; then
        echo "OK    $label Metal backend library present"
      else
        echo "FAIL  $label expected libggml-metal* but none found"
        FAIL=1
      fi
      ;;
    no)
      if [[ $has_metal -eq 1 ]]; then
        echo "INFO  $label has Metal libs (fine for a metal-named folder)"
      else
        echo "OK    $label CPU-only libraries (expected for cpu folder)"
      fi
      ;;
    optional)
      if [[ $has_metal -eq 1 ]]; then
        echo "OK    $label Metal backend library present"
      else
        echo "WARN  $label no libggml-metal (GPU offload unavailable for this folder)"
      fi
      ;;
  esac
}

# Map host names: Darwin reports arm64 / x86_64
check_runtime "macos-arm64-metal" "arm64" "optional"
check_runtime "macos-arm64-cpu" "arm64" "no"
check_runtime "macos-x64-metal" "x86_64" "optional"
check_runtime "macos-x64-cpu" "x86_64" "no"

echo
case "$HOST_ARCH" in
  arm64|aarch64)
    NATIVE_METAL="$BASE_DIR/macos-arm64-metal/llama-server"
    NATIVE_CPU="$BASE_DIR/macos-arm64-cpu/llama-server"
    ;;
  x86_64)
    NATIVE_METAL="$BASE_DIR/macos-x64-metal/llama-server"
    NATIVE_CPU="$BASE_DIR/macos-x64-cpu/llama-server"
    ;;
  *)
    echo "WARN  Unknown host arch $HOST_ARCH"
    NATIVE_METAL=""
    NATIVE_CPU=""
    ;;
esac

if [[ -n "$NATIVE_METAL" && -f "$NATIVE_METAL" ]]; then
  echo "Native metal candidate: $NATIVE_METAL"
fi
if [[ -n "$NATIVE_CPU" && -f "$NATIVE_CPU" ]]; then
  echo "Native cpu candidate:   $NATIVE_CPU"
fi

if [[ $FAIL -ne 0 ]]; then
  echo
  echo "Verification FAILED. Fix missing/wrong-arch runtimes:"
  echo "  ./scripts/setup_macos_runtimes.sh"
  echo "Intel Metal GPU (optional):"
  echo "  ./scripts/build_macos_x64_metal_runtime.sh"
  exit 1
fi

echo
echo "Verification PASSED for universal runtime layout."
echo "NexusAI will auto-select the native arch folder and ignore the other arch."
exit 0
