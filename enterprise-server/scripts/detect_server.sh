#!/usr/bin/env bash
set -euo pipefail

echo "NexusAI Server Detection Report"
echo "Generated: $(date -Is)"
echo

echo "== OS =="
uname -a || true
if [ -f /etc/os-release ]; then cat /etc/os-release; fi
echo

echo "== CPU =="
lscpu | sed -n '1,25p' || true
echo

echo "== Memory =="
free -h || true
echo

echo "== Storage =="
df -h | sed -n '1,20p' || true
echo

echo "== NVIDIA GPU =="
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi
else
  echo "nvidia-smi not found. NVIDIA GPU/driver may be unavailable."
fi
echo

echo "== Docker =="
if command -v docker >/dev/null 2>&1; then
  docker --version
  docker compose version || true
else
  echo "Docker not found."
fi
echo

echo "== Network ports =="
ss -tulpen 2>/dev/null | sed -n '1,30p' || netstat -tulpen 2>/dev/null | sed -n '1,30p' || true
