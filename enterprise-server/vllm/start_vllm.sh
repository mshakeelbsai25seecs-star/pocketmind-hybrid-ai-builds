#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Edit .env before production use."
fi

MODE="${1:-single}"

if [ "$MODE" = "multi" ]; then
  docker compose --env-file .env -f docker-compose.multi-gpu.yml up -d
else
  docker compose --env-file .env -f docker-compose.nvidia.yml up -d
fi

echo "vLLM started. Test with: curl http://localhost:${PORT:-8000}/v1/models"
