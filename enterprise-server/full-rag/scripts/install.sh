#!/usr/bin/env bash
# Single entrypoint for PocketMind Hybrid AI Full Server RAG (Linux x86_64 + Docker).
#
# Usage:
#   ./scripts/install.sh
#   ./scripts/install.sh --cpu
#   ./scripts/install.sh --gpu
#   ./scripts/install.sh --skip-models --no-seed
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib_env.sh"

FORCE_CPU=0
FORCE_GPU=0
SKIP_MODELS=0
NO_SEED=0
ASSUME_YES=0
ALLOW_BUSY_PORTS=0
SKIP_NETWORK=0

usage() {
  cat <<'EOF'
PocketMind Full Server RAG — install.sh

Flags:
  --cpu                 Force CPU compose (no NVIDIA devices)
  --gpu                 Force GPU path (fails if Docker cannot use NVIDIA)
  --skip-models         Do not download; require GGUFs already on disk
  --no-seed             Skip copying optional qa-corpus fixture
  --allow-busy-ports    Continue even if 8000-8003/8080 appear in use
  --skip-network-check  Skip Hugging Face / registry preflight probes
  --yes                 Non-interactive (accept defaults; same as unattended)
  -h, --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cpu) FORCE_CPU=1 ;;
    --gpu) FORCE_GPU=1 ;;
    --skip-models) SKIP_MODELS=1 ;;
    --no-seed) NO_SEED=1 ;;
    --allow-busy-ports) ALLOW_BUSY_PORTS=1 ;;
    --skip-network-check) SKIP_NETWORK=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown flag: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [[ "${FORCE_CPU}" -eq 1 && "${FORCE_GPU}" -eq 1 ]]; then
  echo "ERROR: use only one of --cpu or --gpu" >&2
  exit 1
fi

echo "=== PocketMind Hybrid AI Full Server RAG install ==="

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

# shellcheck disable=SC1091
set -a && source .env && set +a

export ALLOW_BUSY_PORTS SKIP_NETWORK ASSUME_YES
export NEXUS_MODELS_HOST NEXUS_DATA_HOST

if [[ "${SKIP_MODELS}" -eq 1 ]]; then
  export SKIP_HF_CHECK=1
fi

# Hint preflight whether a CUDA image pull may be needed
if [[ "${FORCE_CPU}" -eq 1 ]]; then
  export PREFLIGHT_EXPECT_GPU=0
elif [[ "${FORCE_GPU}" -eq 1 ]]; then
  export PREFLIGHT_EXPECT_GPU=1
elif command -v nvidia-smi >/dev/null 2>&1; then
  export PREFLIGHT_EXPECT_GPU=1
else
  export PREFLIGHT_EXPECT_GPU=0
fi

echo ""
echo "[1/8] Preflight..."
bash "${SCRIPT_DIR}/preflight.sh"

GATEWAY_PORT="${GATEWAY_PORT:-8080}"

echo ""
echo "[2/8] Selecting deploy profile..."
PROFILE=""
GPU_WARN=""

pick_gpu_profile() {
  local vram
  vram="$(vram_mib)"
  # Unknown VRAM → gpu-small (safer than full layers on a mystery card)
  if [[ "${vram}" -le 0 || "${vram}" -lt 20000 ]]; then
    PROFILE="gpu-small"
    if [[ "${vram}" -le 0 ]]; then
      echo "Profile: gpu-small (Docker GPU OK; VRAM unknown — using conservative settings)"
    else
      echo "Profile: gpu-small (Docker GPU OK, VRAM ${vram} MiB < 20 GiB)"
    fi
  else
    PROFILE="gpu"
    echo "Profile: gpu (Docker GPU OK, VRAM ${vram} MiB)"
  fi
}

if [[ "${FORCE_CPU}" -eq 1 ]]; then
  PROFILE="cpu"
  echo "Profile: cpu (--cpu)"
elif [[ "${FORCE_GPU}" -eq 1 ]]; then
  if ! docker_gpu_ok; then
    echo "ERROR: --gpu requested but Docker cannot access NVIDIA GPUs." >&2
    echo "Install NVIDIA driver + NVIDIA Container Toolkit, then verify:" >&2
    echo "  docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi" >&2
    exit 1
  fi
  pick_gpu_profile
else
  if command -v nvidia-smi >/dev/null 2>&1; then
    if docker_gpu_ok; then
      pick_gpu_profile
    else
      PROFILE="cpu"
      GPU_WARN="GPU visible to host (nvidia-smi) but not to Docker; using CPU. Install/configure NVIDIA Container Toolkit for GPU speed."
      echo "Profile: cpu"
      echo "WARNING: ${GPU_WARN}"
    fi
  else
    PROFILE="cpu"
    echo "Profile: cpu (nvidia-smi not found)"
  fi
fi

env_set "NEXUS_DEPLOY_PROFILE" "${PROFILE}"

THREADS_VAL="$(default_threads)"
env_set "THREADS" "${THREADS_VAL}"
echo "THREADS=${THREADS_VAL} (from nproc, capped)"

case "${PROFILE}" in
  gpu-small)
    env_set "CTX_SIZE" "4096"
    env_set "EMBED_CTX_SIZE" "4096"
    env_set "GPU_LAYERS" "35"
    echo "gpu-small: CTX_SIZE=4096 EMBED_CTX_SIZE=4096 GPU_LAYERS=35"
    # Longer healthgate for smaller / contended cards
    env_set "HEALTHGATE_ATTEMPTS" "${HEALTHGATE_ATTEMPTS:-120}"
    ;;
  gpu)
    if ! grep -q '^CTX_SIZE=' .env; then env_set "CTX_SIZE" "8192"; fi
    env_set "GPU_LAYERS" "${GPU_LAYERS:--1}"
    ;;
  cpu)
    env_set "GPU_LAYERS" "0"
    env_set "HEALTHGATE_ATTEMPTS" "${HEALTHGATE_ATTEMPTS:-150}"
    echo "cpu: healthgate timeout extended (model load is slow)"
    ;;
esac

COMPOSE_FILE_VAL="$(compose_files_for_profile "${PROFILE}" | sed 's/^-f //; s/ -f /:/g')"
env_set "COMPOSE_FILE" "${COMPOSE_FILE_VAL}"

set -a && source .env && set +a

echo ""
echo "[3/8] Creating directories..."
ensure_data_paths
MODELS_HOST="${NEXUS_MODELS_HOST}"
DATA_HOST="${NEXUS_DATA_HOST}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"

echo ""
echo "[4/8] Server token..."
if [[ -z "${NEXUSAI_SERVER_TOKEN:-}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    NEXUSAI_SERVER_TOKEN="$(openssl rand -hex 24)"
  else
    NEXUSAI_SERVER_TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  env_set "NEXUSAI_SERVER_TOKEN" "${NEXUSAI_SERVER_TOKEN}"
  echo "Generated NEXUSAI_SERVER_TOKEN and wrote it to .env"
else
  echo "Using existing NEXUSAI_SERVER_TOKEN from .env"
fi
set -a && source .env && set +a

echo ""
echo "[5/8] Models..."
if [[ "${SKIP_MODELS}" -eq 1 ]]; then
  echo "Skipping downloads (--skip-models); verifying required files..."
  SKIP_MODELS=1 bash "${SCRIPT_DIR}/download_models.sh" --check-only
else
  bash "${SCRIPT_DIR}/download_models.sh"
fi

echo ""
echo "[6/8] Starting compose stack (profile=${PROFILE})..."
# shellcheck disable=SC2206
COMPOSE_ARGS=( $(compose_files_for_profile "${PROFILE}") )

if ! docker compose "${COMPOSE_ARGS[@]}" up -d --build; then
  echo "" >&2
  echo "ERROR: docker compose up --build failed." >&2
  echo "Common causes:" >&2
  echo "  - Gateway Rust build OOM (need more RAM or swap)" >&2
  echo "  - Registry pull blocked" >&2
  echo "  - NVIDIA runtime missing (try: ./scripts/install.sh --cpu)" >&2
  echo "Inspect: docker compose ${COMPOSE_ARGS[*]} logs" >&2
  exit 1
fi

echo ""
echo "[7/8] Healthgate..."
export COMPOSE_FILE="${COMPOSE_FILE_VAL}"
bash "${SCRIPT_DIR}/healthgate.sh"

echo ""
echo "[8/8] Seed corpus..."
if [[ "${NO_SEED}" -eq 1 ]]; then
  echo "Skipped (--no-seed)"
else
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
    echo "Optional seed not in this package. Copy docs to ${DATA_HOST}/collections/<name>/"
    echo "Then: ./scripts/index_collection.sh <name>"
  fi
fi

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "============================================"
echo " INSTALL OK  profile=${PROFILE}"
if [[ -n "${GPU_WARN}" ]]; then
  echo " NOTE: ${GPU_WARN}"
fi
echo " Models dir  : ${MODELS_HOST}"
echo " Data dir    : ${DATA_HOST}"
echo " Gateway URL : http://${HOST_IP:-<server-ip>}:${GATEWAY_PORT}"
echo "             : http://127.0.0.1:${GATEWAY_PORT}"
echo " Bearer token: ${NEXUSAI_SERVER_TOKEN}"
echo " Token file  : ${ROOT_DIR}/.env  (NEXUSAI_SERVER_TOKEN)"
echo " Health      : curl http://127.0.0.1:${GATEWAY_PORT}/health"
echo " Smoke test  : ./scripts/smoke_test.sh"
echo " Index       : ./scripts/index_collection.sh <collection-name>"
echo "============================================"
echo ""
echo "Desktop clients: Org Server URL = http://<server>:${GATEWAY_PORT}/v1"
echo "Enable Server RAG, paste the Bearer token. Do not share the token publicly."
