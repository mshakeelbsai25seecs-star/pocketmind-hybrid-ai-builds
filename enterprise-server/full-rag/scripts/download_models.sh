#!/usr/bin/env bash
# Download pilot GGUF models into NEXUS_MODELS_HOST (HF URLs from .env).
# Usage:
#   ./scripts/download_models.sh
#   ./scripts/download_models.sh --check-only   # verify files exist (no download)
#   SKIP_MODELS=1 ./scripts/download_models.sh # same as --check-only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

CHECK_ONLY=0
if [[ "${1:-}" == "--check-only" ]] || [[ "${SKIP_MODELS:-0}" == "1" ]]; then
  CHECK_ONLY=1
fi

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a && source .env && set +a
fi

MODELS_HOST="${NEXUS_MODELS_HOST:-/opt/nexusai/models}"
mkdir -p \
  "${MODELS_HOST}/llm" \
  "${MODELS_HOST}/embeddings" \
  "${MODELS_HOST}/rerankers"

LLM_URL="${HF_LLM_URL:-https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf}"
CODE_URL="${HF_CODE_EMBED_URL:-https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF/resolve/main/Qwen3-Embedding-8B-Q4_K_M.gguf}"
KNOW_URL="${HF_KNOWLEDGE_EMBED_URL:-https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q4_K_M.gguf}"
RERANK_URL="${HF_RERANK_URL:-https://huggingface.co/Qwen/Qwen3-Reranker-4B-GGUF/resolve/main/Qwen3-Reranker-4B-Q4_K_M.gguf}"

LLM_NAME="${LLM_LOCAL_NAME:-llm/Qwen2.5-7B-Instruct-Q4_K_M.gguf}"
CODE_NAME="${CODE_EMBED_LOCAL_NAME:-embeddings/Qwen3-Embedding-8B-Q4_K_M.gguf}"
KNOW_NAME="${KNOWLEDGE_EMBED_LOCAL_NAME:-embeddings/bge-m3-Q4_K_M.gguf}"
RERANK_NAME="${RERANK_LOCAL_NAME:-rerankers/Qwen3-Reranker-4B-Q4_K_M.gguf}"

# Reject empty/HTML error pages and obviously truncated GGUFs (chat/embed are multi‑GB).
MIN_BYTES_DEFAULT="${MODEL_MIN_BYTES:-104857600}" # 100 MiB floor unless overridden per file

min_bytes_for() {
  local dest="$1"
  case "${dest}" in
    *bge-m3*|*BGE*|*rerank*|*Rerank*) echo "${MODEL_MIN_BYTES_SMALL:-52428800}" ;; # 50 MiB
    *) echo "${MIN_BYTES_DEFAULT}" ;;
  esac
}

is_gguf() {
  local dest="$1"
  local magic
  magic="$(head -c 4 "${dest}" 2>/dev/null || true)"
  [[ "${magic}" == "GGUF" ]]
}

require_file() {
  local dest="$1"
  local min_b
  min_b="$(min_bytes_for "${dest}")"
  if [[ ! -f "${dest}" ]]; then
    echo "MISSING: ${dest}" >&2
    return 1
  fi
  local sz
  sz="$(wc -c < "${dest}" | tr -d ' ')"
  if [[ "${sz}" -lt "${min_b}" ]]; then
    echo "TOO SMALL (${sz} bytes, need ≥${min_b}): ${dest}" >&2
    return 1
  fi
  if ! is_gguf "${dest}"; then
    echo "NOT A GGUF (bad magic header): ${dest}" >&2
    return 1
  fi
  return 0
}

download_one() {
  local url="$1"
  local dest="$2"
  local attempt max_attempts delay
  max_attempts=5
  delay=2

  local min_b
  min_b="$(min_bytes_for "${dest}")"
  if [[ -f "${dest}" && -s "${dest}" ]]; then
    local sz
    sz="$(wc -c < "${dest}" | tr -d ' ')"
    if [[ "${sz}" -ge "${min_b}" ]] && is_gguf "${dest}"; then
      echo "[skip] ${dest} already exists (${sz} bytes)"
      return 0
    fi
    echo "[retry] ${dest} exists but is invalid/too small (${sz} bytes); re-downloading"
    rm -f "${dest}"
  fi

  echo "[download] ${url}"
  echo "        -> ${dest}"
  mkdir -p "$(dirname "${dest}")"

  for attempt in $(seq 1 "${max_attempts}"); do
    set +e
    if command -v curl >/dev/null 2>&1; then
      curl -fL --retry 3 --retry-delay 2 --connect-timeout 30 \
        -o "${dest}.partial" "${url}"
      rc=$?
    elif command -v wget >/dev/null 2>&1; then
      wget --timeout=60 -O "${dest}.partial" "${url}"
      rc=$?
    else
      echo "ERROR: need curl or wget to download models" >&2
      exit 1
    fi
    set -e

    if [[ "${rc}" -eq 0 && -f "${dest}.partial" ]]; then
      local sz
      sz="$(wc -c < "${dest}.partial" | tr -d ' ')"
      if [[ "${sz}" -ge "${min_b}" ]] && is_gguf "${dest}.partial"; then
        mv "${dest}.partial" "${dest}"
        echo "[ok] ${dest} (${sz} bytes)"
        return 0
      fi
      echo "[warn] download invalid/too small (${sz} bytes, need ≥${min_b}); attempt ${attempt}/${max_attempts}" >&2
      rm -f "${dest}.partial"
    else
      echo "[warn] download failed (exit ${rc}) for ${url}; attempt ${attempt}/${max_attempts}" >&2
      rm -f "${dest}.partial"
    fi
    sleep "${delay}"
    delay=$((delay * 2))
    if [[ "${delay}" -gt 60 ]]; then delay=60; fi
  done

  echo "ERROR: failed to download after ${max_attempts} attempts:" >&2
  echo "  URL : ${url}" >&2
  echo "  DEST: ${dest}" >&2
  exit 1
}

if [[ "${CHECK_ONLY}" -eq 1 ]]; then
  echo "Checking required GGUFs under ${MODELS_HOST}..."
  missing=0
  for rel in "${LLM_NAME}" "${CODE_NAME}" "${KNOW_NAME}" "${RERANK_NAME}"; do
    if ! require_file "${MODELS_HOST}/${rel}"; then
      missing=1
    else
      echo "[ok] ${MODELS_HOST}/${rel}"
    fi
  done
  if [[ "${missing}" -ne 0 ]]; then
    echo "" >&2
    echo "ERROR: required model files missing or too small. Place them under ${MODELS_HOST} or run without --skip-models." >&2
    echo "Expected relative paths:" >&2
    echo "  ${LLM_NAME}" >&2
    echo "  ${CODE_NAME}" >&2
    echo "  ${KNOW_NAME}" >&2
    echo "  ${RERANK_NAME}" >&2
    exit 1
  fi
  echo "All required models present."
  exit 0
fi

download_one "${LLM_URL}" "${MODELS_HOST}/${LLM_NAME}"
download_one "${CODE_URL}" "${MODELS_HOST}/${CODE_NAME}"
download_one "${KNOW_URL}" "${MODELS_HOST}/${KNOW_NAME}"
download_one "${RERANK_URL}" "${MODELS_HOST}/${RERANK_NAME}"

echo "All model downloads complete under ${MODELS_HOST}"
