#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "FAIL: Docker is not installed."
  exit 1
fi

docker --version
docker compose version || true

docker info >/dev/null

echo "PASS: Docker is installed and responding."
