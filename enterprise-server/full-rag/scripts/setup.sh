#!/usr/bin/env bash
# One-shot pilot bring-up for NexusAI Full Server RAG.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

echo "=== NexusAI Full Server RAG setup ==="

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed or not on PATH." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: docker compose plugin is required." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

# shellcheck disable=SC1091
set -a && source .env && set +a

MODELS_HOST="${NEXUS_MODELS_HOST:-/opt/nexusai/models}"
DATA_HOST="${NEXUS_DATA_HOST:-/opt/nexusai/data}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"

echo "[1/7] Creating directories..."
mkdir -p \
  "${MODELS_HOST}/llm" \
  "${MODELS_HOST}/embeddings" \
  "${MODELS_HOST}/rerankers" \
  "${DATA_HOST}/collections" \
  "${DATA_HOST}/gateway"

if [[ -z "${NEXUSAI_SERVER_TOKEN:-}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    NEXUSAI_SERVER_TOKEN="$(openssl rand -hex 24)"
  else
    NEXUSAI_SERVER_TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  if grep -q '^NEXUSAI_SERVER_TOKEN=' .env; then
    sed -i.bak "s|^NEXUSAI_SERVER_TOKEN=.*|NEXUSAI_SERVER_TOKEN=${NEXUSAI_SERVER_TOKEN}|" .env
  else
    echo "NEXUSAI_SERVER_TOKEN=${NEXUSAI_SERVER_TOKEN}" >> .env
  fi
  echo "[2/7] Generated NEXUSAI_SERVER_TOKEN and wrote it to .env"
else
  echo "[2/7] Using existing NEXUSAI_SERVER_TOKEN from .env"
fi
# re-source after possible token write
set -a && source .env && set +a

echo "[3/7] Downloading models (skips existing)..."
bash "${SCRIPT_DIR}/download_models.sh"

USE_CPU=0
if [[ "${1:-}" == "--cpu" ]]; then
  USE_CPU=1
elif ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "nvidia-smi not found — using CPU compose overlay"
  USE_CPU=1
fi

echo "[4/7] Starting compose stack..."
if [[ "${USE_CPU}" -eq 1 ]]; then
  docker compose -f docker-compose.yml -f docker-compose.cpu.yml up -d --build
else
  docker compose -f docker-compose.yml up -d --build
fi

echo "[5/7] Waiting for gateway health..."
HEALTH_URL="http://127.0.0.1:${GATEWAY_PORT}/health"
for i in $(seq 1 60); do
  if curl -sf "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "Gateway healthy after ${i} attempts"
    break
  fi
  if [[ "${i}" -eq 60 ]]; then
    echo "WARNING: gateway did not become healthy in time. Check: docker compose logs gateway" >&2
  fi
  sleep 3
done

echo "[6/7] Seed corpus note"
REPO_ROOT="$(cd "${ROOT_DIR}/../.." && pwd)"
SEED_SRC="${REPO_ROOT}/test-fixtures/kc-qa-corpus"
SEED_DST="${DATA_HOST}/collections/qa-corpus"
if [[ -d "${SEED_SRC}" ]]; then
  if [[ ! -d "${SEED_DST}" ]]; then
    mkdir -p "${SEED_DST}"
    cp -a "${SEED_SRC}/." "${SEED_DST}/"
    echo "Copied test-fixtures/kc-qa-corpus -> ${SEED_DST}"
  else
    echo "Seed folder already present at ${SEED_DST}"
  fi
  echo "Index it with: ./scripts/index_collection.sh qa-corpus"
else
  echo "Optional seed: copy or bind-mount test-fixtures/kc-qa-corpus to ${SEED_DST}"
  echo "Then run: ./scripts/index_collection.sh qa-corpus"
fi

echo "[7/7] Ready"
echo ""
echo "============================================"
echo " Gateway URL : http://$(hostname -I 2>/dev/null | awk '{print $1}'):${GATEWAY_PORT}"
echo "             : http://127.0.0.1:${GATEWAY_PORT}"
echo " Bearer token: ${NEXUSAI_SERVER_TOKEN}"
echo " Health      : curl http://127.0.0.1:${GATEWAY_PORT}/health"
echo " Collections : curl -H \"Authorization: Bearer ${NEXUSAI_SERVER_TOKEN}\" http://127.0.0.1:${GATEWAY_PORT}/v1/knowledge/collections"
echo "============================================"
echo ""
echo "Desktop clients: Org Server URL = http://<server>:${GATEWAY_PORT}/v1"
echo "Enable Server RAG in Org Server settings, paste the Bearer token."
