#!/usr/bin/env bash
set -euo pipefail

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "FAIL: nvidia-smi not found. Install NVIDIA driver first."
  exit 1
fi

nvidia-smi

echo
echo "Testing Docker GPU access..."
if command -v docker >/dev/null 2>&1; then
  docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi || {
    echo "FAIL: Docker cannot access NVIDIA GPUs. Install/configure NVIDIA Container Toolkit."
    exit 1
  }
else
  echo "Docker not installed. Skipping Docker GPU test."
fi

echo "PASS: NVIDIA GPU is visible."
