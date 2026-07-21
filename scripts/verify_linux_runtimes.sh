#!/usr/bin/env bash
# Verify PocketMind Hybrid AI Linux llama.cpp runtime layout (cpu / cuda / vulkan).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "${SCRIPT_DIR}/bin/llama.cpp" || -d "${SCRIPT_DIR}/bin" ]] || compgen -G "${SCRIPT_DIR}/*.AppImage" >/dev/null 2>&1; then
  PROJECT_DIR="${SCRIPT_DIR}"
else
  PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi
BASE_DIR="$PROJECT_DIR/bin/llama.cpp"
FAIL=0

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This verifier is for Linux only (host=$(uname -s))."
  exit 0
fi

echo "Runtime root: $BASE_DIR"
echo

check_backend() {
  local name="$1"
  local required="$2" # yes|no
  local dir="$BASE_DIR/$name"
  local path="$dir/llama-server"
  local label="[$name]"

  if [[ ! -f "$path" ]]; then
    if [[ "$required" == "yes" ]]; then
      echo "FAIL  $label missing llama-server"
      FAIL=1
    else
      echo "SKIP  $label not installed (optional)"
    fi
    return
  fi
  chmod +x "$path" 2>/dev/null || true
  echo "OK    $label binary present"

  if "$path" --help >/dev/null 2>&1; then
    echo "OK    $label llama-server --help"
  else
    # Some builds print help to stderr / non-zero; accept if binary is executable ELF.
    if file "$path" | grep -qi "ELF"; then
      echo "WARN  $label --help returned non-zero (ELF present; may still work)"
    else
      echo "FAIL  $label llama-server --help failed"
      FAIL=1
    fi
  fi

  local names
  names="$(ls "$dir" 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr '\n' ' ')"
  case "$name" in
    cuda)
      if echo "$names" | grep -Eq 'cuda|cublas|cudart|ggml'; then
        echo "OK    $label CUDA/ggml libs detected"
      else
        echo "WARN  $label no cuda/ggml library names found"
      fi
      ;;
    vulkan)
      if echo "$names" | grep -Eq 'vulkan|ggml'; then
        echo "OK    $label Vulkan/ggml libs detected"
      else
        echo "WARN  $label no vulkan/ggml library names found"
      fi
      ;;
  esac
}

if [[ ! -d "$BASE_DIR" ]]; then
  echo "FAIL  runtime root missing: $BASE_DIR"
  echo "Run: npm run setup:linux-runtimes"
  exit 1
fi

check_backend "cpu" "yes"
check_backend "cuda" "no"
check_backend "vulkan" "no"

echo
if [[ "$FAIL" -gt 0 ]]; then
  echo "Verification FAILED ($FAIL issue(s))."
  exit 1
fi
echo "Verification PASSED."
exit 0
