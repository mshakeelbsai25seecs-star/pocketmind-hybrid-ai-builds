#!/usr/bin/env bash
# Smoke test after install.sh succeeds — gateway + all llama backends.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a && source .env && set +a
fi

GATEWAY_PORT="${GATEWAY_PORT:-8080}"
LLM_PORT="${LLM_PORT:-8000}"
CODE_EMBED_PORT="${CODE_EMBED_PORT:-8001}"
KNOWLEDGE_EMBED_PORT="${KNOWLEDGE_EMBED_PORT:-8002}"
RERANK_PORT="${RERANK_PORT:-8003}"
TOKEN="${NEXUSAI_SERVER_TOKEN:-}"
BASE="http://127.0.0.1:${GATEWAY_PORT}"

echo "=== PocketMind Full Server RAG — smoke_test ==="

fail=0

check() {
  local label="$1"
  local url="$2"
  local auth="${3:-}"
  if [[ -n "${auth}" ]]; then
    if curl -sf -H "Authorization: Bearer ${auth}" "${url}" >/dev/null; then
      echo "OK  ${label}"
    else
      echo "FAIL ${label} (${url})"
      fail=1
    fi
  else
    if curl -sf "${url}" >/dev/null; then
      echo "OK  ${label}"
    else
      # try /v1/models fallback for llama.cpp
      local alt="${url%/health}/v1/models"
      if [[ "${url}" == */health ]] && curl -sf "${alt}" >/dev/null; then
        echo "OK  ${label} (via /v1/models)"
      else
        echo "FAIL ${label} (${url})"
        fail=1
      fi
    fi
  fi
}

check "gateway /health" "${BASE}/health"
check "llm /v1/models" "http://127.0.0.1:${LLM_PORT}/v1/models"
check "embed-code /health" "http://127.0.0.1:${CODE_EMBED_PORT}/health"
check "embed-knowledge /health" "http://127.0.0.1:${KNOWLEDGE_EMBED_PORT}/health"
check "rerank /health" "http://127.0.0.1:${RERANK_PORT}/health"

if [[ -n "${TOKEN}" ]]; then
  check "gateway /v1/models" "${BASE}/v1/models" "${TOKEN}"
  check "gateway /v1/knowledge/collections" "${BASE}/v1/knowledge/collections" "${TOKEN}"
else
  echo "SKIP authenticated gateway checks (NEXUSAI_SERVER_TOKEN empty)"
fi

DATA_HOST="${NEXUS_DATA_HOST:-/opt/nexusai/data}"
if [[ -d "${DATA_HOST}/collections/qa-corpus" && -n "${TOKEN}" ]]; then
  echo "NOTE: qa-corpus folder present. Index with: ./scripts/index_collection.sh qa-corpus"
fi

if [[ "${fail}" -ne 0 ]]; then
  echo "Smoke test FAILED"
  exit 1
fi
echo "Smoke test PASSED"
exit 0
