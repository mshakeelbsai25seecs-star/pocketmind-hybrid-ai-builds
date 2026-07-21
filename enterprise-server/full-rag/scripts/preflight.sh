#!/usr/bin/env bash
# Preflight checks before Full Server RAG install.
# Exit 0 only when the host is a supported Linux x86_64 Docker target.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

ALLOW_BUSY_PORTS="${ALLOW_BUSY_PORTS:-0}"
SKIP_NETWORK="${SKIP_NETWORK:-0}"
SKIP_HF_CHECK="${SKIP_HF_CHECK:-0}"
MIN_DISK_GB="${MIN_DISK_GB:-40}"
MIN_RAM_GB_WARN="${MIN_RAM_GB_WARN:-16}"

ERRS=0
WARNS=0

fail() {
  echo "ERROR: $*" >&2
  ERRS=$((ERRS + 1))
}

warn() {
  echo "WARNING: $*" >&2
  WARNS=$((WARNS + 1))
}

ok() {
  echo "OK: $*"
}

echo "=== PocketMind Full Server RAG — preflight ==="

# --- Architecture ---
ARCH="$(uname -m 2>/dev/null || echo unknown)"
case "${ARCH}" in
  x86_64|amd64)
    ok "Architecture ${ARCH}"
    ;;
  *)
    fail "Unsupported architecture '${ARCH}'. This package supports Linux x86_64/amd64 only (not ARM)."
    ;;
esac

OS_NAME="$(uname -s 2>/dev/null || echo unknown)"
if [[ "${OS_NAME}" != "Linux" ]]; then
  fail "Host OS is '${OS_NAME}'. Run on Linux (or Windows Server via WSL2 Ubuntu — see docs/WSL2_WINDOWS_SERVER.md)."
else
  ok "OS is Linux"
fi

# --- Docker ---
if ! command -v docker >/dev/null 2>&1; then
  fail "docker is not installed or not on PATH. Install Docker Engine, then re-run."
else
  ok "docker found: $(docker --version 2>/dev/null | head -1)"
fi

if ! docker compose version >/dev/null 2>&1; then
  fail "docker compose plugin is required (Compose V2). Install it, then re-run."
else
  ok "docker compose: $(docker compose version 2>/dev/null | head -1)"
fi

if command -v docker >/dev/null 2>&1; then
  if ! docker info >/dev/null 2>&1; then
    fail "docker daemon is not reachable (permission or service down). Try: sudo usermod -aG docker \$USER && newgrp docker"
  else
    ok "docker daemon responds"
  fi
fi

# --- curl/wget ---
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  fail "Need curl or wget for model downloads and health checks."
else
  ok "download tool available"
fi

# --- Disk ---
MODELS_HOST="${NEXUS_MODELS_HOST:-/opt/nexusai/models}"
DATA_HOST="${NEXUS_DATA_HOST:-/opt/nexusai/data}"
CHECK_PATH="/"
if [[ -d "$(dirname "${MODELS_HOST}")" ]]; then
  CHECK_PATH="$(dirname "${MODELS_HOST}")"
elif [[ -d /opt ]]; then
  CHECK_PATH="/opt"
fi
if command -v df >/dev/null 2>&1; then
  FREE_KB="$(df -Pk "${CHECK_PATH}" 2>/dev/null | awk 'NR==2 {print $4}')"
  if [[ -n "${FREE_KB:-}" && "${FREE_KB}" =~ ^[0-9]+$ ]]; then
    FREE_GB=$((FREE_KB / 1024 / 1024))
    if [[ "${FREE_GB}" -lt "${MIN_DISK_GB}" ]]; then
      fail "Only ~${FREE_GB} GB free under ${CHECK_PATH}; need at least ${MIN_DISK_GB} GB for images + GGUFs."
    else
      ok "Disk free ~${FREE_GB} GB under ${CHECK_PATH}"
    fi
  else
    warn "Could not measure free disk on ${CHECK_PATH}"
  fi
fi

# --- RAM ---
if [[ -r /proc/meminfo ]]; then
  MEM_KB="$(awk '/MemTotal:/ {print $2}' /proc/meminfo)"
  MEM_GB=$((MEM_KB / 1024 / 1024))
  if [[ "${MEM_GB}" -lt "${MIN_RAM_GB_WARN}" ]]; then
    warn "System RAM ~${MEM_GB} GB is low (recommend ≥${MIN_RAM_GB_WARN} GB; ≥32 GB preferred for CPU profile)."
  else
    ok "System RAM ~${MEM_GB} GB"
  fi
fi

# --- Ports ---
port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tuln 2>/dev/null | grep -qE ":${port}[[:space:]]" && return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  fi
  # Fallback: try binding via bash /dev/tcp is not a listen check; use fuser if present
  if command -v fuser >/dev/null 2>&1; then
    fuser "${port}/tcp" >/dev/null 2>&1 && return 0
  fi
  return 1
}

REQUIRED_PORTS=(8000 8001 8002 8003 8080)
BUSY=()
for p in "${REQUIRED_PORTS[@]}"; do
  if port_in_use "${p}"; then
    BUSY+=("${p}")
  fi
done
if [[ "${#BUSY[@]}" -gt 0 ]]; then
  msg="Ports in use: ${BUSY[*]} (need 8000-8003, 8080 free)"
  if [[ "${ALLOW_BUSY_PORTS}" == "1" ]]; then
    warn "${msg} — continuing because ALLOW_BUSY_PORTS=1"
  else
    fail "${msg}. Free them or re-run with --allow-busy-ports"
  fi
else
  ok "Ports 8000-8003, 8080 available"
fi

# --- Network reachability (online install) ---
if [[ "${SKIP_NETWORK}" == "1" ]]; then
  warn "SKIP_NETWORK=1 — skipped Hugging Face / registry probes"
else
  if [[ "${SKIP_HF_CHECK}" == "1" ]]; then
    warn "SKIP_HF_CHECK=1 — skipped Hugging Face probe (models expected on disk)"
  else
    if command -v curl >/dev/null 2>&1; then
      if curl -fsSIL --connect-timeout 10 --max-time 30 "https://huggingface.co" >/dev/null 2>&1; then
        ok "Hugging Face reachable"
      else
        fail "Cannot reach https://huggingface.co (needed to download GGUFs). Fix network/proxy or pre-place models and use --skip-models."
      fi
    elif command -v wget >/dev/null 2>&1; then
      if wget -q --spider --timeout=30 "https://huggingface.co" 2>/dev/null; then
        ok "Hugging Face reachable"
      else
        fail "Cannot reach https://huggingface.co"
      fi
    fi
  fi

  if command -v curl >/dev/null 2>&1; then
    if curl -fsSIL --connect-timeout 10 --max-time 30 "https://ghcr.io" >/dev/null 2>&1; then
      ok "ghcr.io reachable"
    else
      warn "https://ghcr.io HEAD failed; docker pull may still work — will verify with a short pull probe"
    fi
  fi

  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo "Probing docker pull for llama.cpp image (may take a minute)..."
    if docker pull --quiet ghcr.io/ggml-org/llama.cpp:server >/dev/null 2>&1; then
      ok "Can pull ghcr.io/ggml-org/llama.cpp:server"
    else
      fail "docker pull ghcr.io/ggml-org/llama.cpp:server failed. Check registry access / login / firewall."
    fi
    if [[ "${PREFLIGHT_EXPECT_GPU:-0}" == "1" ]]; then
      echo "Probing docker pull for CUDA llama.cpp image..."
      if docker pull --quiet ghcr.io/ggml-org/llama.cpp:server-cuda >/dev/null 2>&1; then
        ok "Can pull ghcr.io/ggml-org/llama.cpp:server-cuda"
      else
        fail "docker pull ghcr.io/ggml-org/llama.cpp:server-cuda failed. Fix registry access or run ./scripts/install.sh --cpu"
      fi
    fi
  fi
fi

echo ""
if [[ "${ERRS}" -gt 0 ]]; then
  echo "Preflight FAILED with ${ERRS} error(s), ${WARNS} warning(s)."
  echo "Fix the errors above, then re-run ./scripts/install.sh"
  exit 1
fi

echo "Preflight PASSED (${WARNS} warning(s))."
exit 0
