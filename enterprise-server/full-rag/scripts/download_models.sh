#!/usr/bin/env bash
# Download pilot GGUF models into NEXUS_MODELS_HOST (HF URLs from .env).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a && source .env && set +a
fi

MODELS_HOST="${NEXUS_MODELS_HOST:-/opt/nexusai/models}"
mkdir -p \
  "${MODELS_HOST}/llm" \
  "${MODELS_HOST}/embeddings" \
  "${MODELS_HOST}/rerankers"

download_one() {
  local url="$1"
  local dest="$2"
  if [[ -f "${dest}" && -s "${dest}" ]]; then
    echo "[skip] ${dest} already exists"
    return 0
  fi
  echo "[download] ${url}"
  echo "        -> ${dest}"
  mkdir -p "$(dirname "${dest}")"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 -o "${dest}.partial" "${url}"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "${dest}.partial" "${url}"
  else
    echo "ERROR: need curl or wget to download models" >&2
    exit 1
  fi
  mv "${dest}.partial" "${dest}"
  echo "[ok] ${dest}"
}

LLM_URL="${HF_LLM_URL:-https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf}"
CODE_URL="${HF_CODE_EMBED_URL:-https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF/resolve/main/Qwen3-Embedding-8B-Q4_K_M.gguf}"
KNOW_URL="${HF_KNOWLEDGE_EMBED_URL:-https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q4_K_M.gguf}"
RERANK_URL="${HF_RERANK_URL:-https://huggingface.co/Qwen/Qwen3-Reranker-4B-GGUF/resolve/main/Qwen3-Reranker-4B-Q4_K_M.gguf}"

LLM_NAME="${LLM_LOCAL_NAME:-llm/Qwen2.5-7B-Instruct-Q4_K_M.gguf}"
CODE_NAME="${CODE_EMBED_LOCAL_NAME:-embeddings/Qwen3-Embedding-8B-Q4_K_M.gguf}"
KNOW_NAME="${KNOWLEDGE_EMBED_LOCAL_NAME:-embeddings/bge-m3-Q4_K_M.gguf}"
RERANK_NAME="${RERANK_LOCAL_NAME:-rerankers/Qwen3-Reranker-4B-Q4_K_M.gguf}"

download_one "${LLM_URL}" "${MODELS_HOST}/${LLM_NAME}"
download_one "${CODE_URL}" "${MODELS_HOST}/${CODE_NAME}"
download_one "${KNOW_URL}" "${MODELS_HOST}/${KNOW_NAME}"
download_one "${RERANK_URL}" "${MODELS_HOST}/${RERANK_NAME}"

echo "All model downloads complete under ${MODELS_HOST}"
