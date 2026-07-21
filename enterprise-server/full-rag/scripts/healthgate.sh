#!/usr/bin/env bash
# Wait until all Full Server RAG HTTP endpoints respond.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib_env.sh"

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a && source .env && set +a
fi

LLM_PORT="${LLM_PORT:-8000}"
CODE_EMBED_PORT="${CODE_EMBED_PORT:-8001}"
KNOWLEDGE_EMBED_PORT="${KNOWLEDGE_EMBED_PORT:-8002}"
RERANK_PORT="${RERANK_PORT:-8003}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
MAX_ATTEMPTS="${HEALTHGATE_ATTEMPTS:-90}"
SLEEP_SECS="${HEALTHGATE_SLEEP:-4}"

# Honor COMPOSE_FILE from .env, or derive from profile
if [[ -z "${COMPOSE_FILE:-}" && -n "${NEXUS_DEPLOY_PROFILE:-}" ]]; then
  COMPOSE_FILE="$(compose_files_for_profile "${NEXUS_DEPLOY_PROFILE}" | sed 's/^-f //; s/ -f /:/g')"
  export COMPOSE_FILE
fi

compose_cmd() {
  if [[ -n "${COMPOSE_FILE:-}" ]]; then
    COMPOSE_FILE="${COMPOSE_FILE}" docker compose "$@"
  else
    docker compose "$@"
  fi
}

check_url() {
  local url="$1"
  curl -sf --connect-timeout 3 --max-time 10 "${url}" >/dev/null 2>&1
}

dump_failure() {
  local name="$1"
  echo "" >&2
  echo "=== Healthgate FAILED: ${name} ===" >&2
  compose_cmd ps >&2 || true
  echo "--- recent logs (${name}) ---" >&2
  compose_cmd logs --tail 80 "${name}" >&2 || compose_cmd logs --tail 40 >&2 || true
}

echo "=== Healthgate (up to $((MAX_ATTEMPTS * SLEEP_SECS))s) ==="

declare -a NAMES=(llm embed-code embed-knowledge rerank gateway)
declare -a URLS=(
  "http://127.0.0.1:${LLM_PORT}/v1/models"
  "http://127.0.0.1:${CODE_EMBED_PORT}/health"
  "http://127.0.0.1:${KNOWLEDGE_EMBED_PORT}/health"
  "http://127.0.0.1:${RERANK_PORT}/health"
  "http://127.0.0.1:${GATEWAY_PORT}/health"
)

for i in $(seq 1 "${MAX_ATTEMPTS}"); do
  ALL_OK=1
  FAILED_NAME=""
  for idx in "${!NAMES[@]}"; do
    name="${NAMES[$idx]}"
    url="${URLS[$idx]}"
    if check_url "${url}"; then
      continue
    fi
    case "${name}" in
      llm)
        check_url "http://127.0.0.1:${LLM_PORT}/health" && continue
        ;;
      embed-code)
        check_url "http://127.0.0.1:${CODE_EMBED_PORT}/v1/models" && continue
        ;;
      embed-knowledge)
        check_url "http://127.0.0.1:${KNOWLEDGE_EMBED_PORT}/v1/models" && continue
        ;;
      rerank)
        check_url "http://127.0.0.1:${RERANK_PORT}/v1/models" && continue
        ;;
    esac
    ALL_OK=0
    FAILED_NAME="${name}"
    break
  done

  if [[ "${ALL_OK}" -eq 1 ]]; then
    echo "All services healthy after ${i} attempt(s)."
    exit 0
  fi

  if [[ "${i}" -eq "${MAX_ATTEMPTS}" ]]; then
    dump_failure "${FAILED_NAME}"
    echo "ERROR: service '${FAILED_NAME}' did not become healthy in time." >&2
    exit 1
  fi

  if [[ $((i % 5)) -eq 0 ]]; then
    echo "  still waiting (attempt ${i}/${MAX_ATTEMPTS}; last pending: ${FAILED_NAME})..."
  fi
  sleep "${SLEEP_SECS}"
done
