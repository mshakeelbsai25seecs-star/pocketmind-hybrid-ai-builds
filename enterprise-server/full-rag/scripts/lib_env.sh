#!/usr/bin/env bash
# Shared helpers for Full Server RAG scripts (source this file).
# shellcheck shell=bash

env_set() {
  # env_set KEY VALUE  — upsert KEY=VALUE in .env (creates file if missing)
  local key="$1"
  local value="$2"
  local env_file="${3:-.env}"
  if [[ ! -f "${env_file}" ]]; then
    touch "${env_file}"
  fi
  if grep -q "^${key}=" "${env_file}" 2>/dev/null; then
    local escaped
    escaped="$(printf '%s' "${value}" | sed -e 's/[\/&]/\\&/g')"
    sed -i.bak "s|^${key}=.*|${key}=${escaped}|" "${env_file}"
    rm -f "${env_file}.bak"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${env_file}"
  fi
}

vram_mib() {
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo 0
    return 0
  fi
  local v
  v="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')"
  if [[ "${v}" =~ ^[0-9]+$ ]]; then
    echo "${v}"
  else
    echo 0
  fi
}

path_writable() {
  local dir="$1"
  local parent
  parent="$(dirname "${dir}")"
  if [[ -d "${dir}" ]]; then
    [[ -w "${dir}" ]]
    return $?
  fi
  if [[ -d "${parent}" && -w "${parent}" ]]; then
    return 0
  fi
  # Try create-and-remove probe
  if mkdir -p "${dir}" 2>/dev/null; then
    return 0
  fi
  return 1
}

ensure_data_paths() {
  # Sets MODELS_HOST and DATA_HOST globals; rewrites .env if falling back to $HOME.
  local models="${NEXUS_MODELS_HOST:-/opt/nexusai/models}"
  local data="${NEXUS_DATA_HOST:-/opt/nexusai/data}"
  local fallback_models="${HOME}/nexusai/models"
  local fallback_data="${HOME}/nexusai/data"

  if ! path_writable "${models}" || ! path_writable "${data}"; then
    echo "WARNING: cannot write to ${models} or ${data}."
    echo "         Falling back to ${fallback_models} and ${fallback_data}"
    echo "         (override anytime in .env, or: sudo mkdir -p /opt/nexusai && sudo chown \"\$USER\" /opt/nexusai)"
    models="${fallback_models}"
    data="${fallback_data}"
    env_set "NEXUS_MODELS_HOST" "${models}"
    env_set "NEXUS_DATA_HOST" "${data}"
  fi

  mkdir -p \
    "${models}/llm" \
    "${models}/embeddings" \
    "${models}/rerankers" \
    "${data}/collections" \
    "${data}/gateway"

  MODELS_HOST="${models}"
  DATA_HOST="${data}"
  export MODELS_HOST DATA_HOST NEXUS_MODELS_HOST="${models}" NEXUS_DATA_HOST="${data}"
}

docker_gpu_ok() {
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    return 1
  fi
  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi

  # Fast path: already-local CUDA base or llama.cpp CUDA image
  local img
  for img in \
    nvidia/cuda:12.4.1-base-ubuntu22.04 \
    ghcr.io/ggml-org/llama.cpp:server-cuda
  do
    if docker image inspect "${img}" >/dev/null 2>&1; then
      if docker run --rm --gpus all "${img}" nvidia-smi >/dev/null 2>&1; then
        return 0
      fi
      # Image present but GPU runtime broken
      return 1
    fi
  done

  if [[ "${SKIP_NETWORK:-0}" == "1" ]]; then
    # No local CUDA image and cannot pull — treat as GPU-unavailable for Docker
    return 1
  fi

  docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi >/dev/null 2>&1
}

default_threads() {
  local n=8
  if command -v nproc >/dev/null 2>&1; then
    n="$(nproc)"
  fi
  if [[ "${n}" -lt 2 ]]; then
    n=2
  elif [[ "${n}" -gt 16 ]]; then
    n=16
  fi
  echo "${n}"
}

compose_files_for_profile() {
  # Prints space-separated -f args for a profile
  local profile="$1"
  case "${profile}" in
    cpu)
      echo "-f docker-compose.yml -f docker-compose.cpu.yml"
      ;;
    gpu)
      echo "-f docker-compose.yml -f docker-compose.gpu.yml"
      ;;
    gpu-small)
      echo "-f docker-compose.yml -f docker-compose.gpu.yml -f docker-compose.gpu-small.yml"
      ;;
    *)
      echo "-f docker-compose.yml"
      ;;
  esac
}
