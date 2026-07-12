#!/usr/bin/env bash
# Index (or re-index) a collection folder already on disk under
#   ${NEXUS_DATA_HOST}/collections/<name>
#
# Usage:
#   ./scripts/index_collection.sh qa-corpus
#   ./scripts/index_collection.sh my-docs --rebuild
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a && source .env && set +a
fi

NAME="${1:-}"
if [[ -z "${NAME}" ]]; then
  echo "Usage: $0 <collection-name> [--rebuild]" >&2
  exit 1
fi
shift || true

REBUILD=false
if [[ "${1:-}" == "--rebuild" ]]; then
  REBUILD=true
fi

GATEWAY_PORT="${GATEWAY_PORT:-8080}"
TOKEN="${NEXUSAI_SERVER_TOKEN:?NEXUSAI_SERVER_TOKEN is required (see .env)}"
BASE="http://127.0.0.1:${GATEWAY_PORT}"

if ! curl -sf "${BASE}/health" >/dev/null; then
  echo "Gateway not healthy at ${BASE}/health" >&2
  echo "Alternative: docker exec -it nexusai-rag-gateway /bin/sh" >&2
  echo "  then curl -X POST http://127.0.0.1:8080/v1/admin/index ..." >&2
  exit 1
fi

echo "Indexing collection '${NAME}' (rebuild=${REBUILD})..."
RESP="$(curl -sf -X POST "${BASE}/v1/admin/index" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"${NAME}\",\"rebuild\":${REBUILD}}")"

echo "${RESP}" | python3 -m json.tool 2>/dev/null || echo "${RESP}"
echo "Done."
