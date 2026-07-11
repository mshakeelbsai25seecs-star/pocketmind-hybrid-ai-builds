#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env. Put your GGUF file in enterprise-server/llama-cpp/models and edit MODEL_PATH."
fi

mkdir -p models
MODE="${1:-cpu}"
if [ "$MODE" = "cuda" ]; then
  docker compose --env-file .env -f docker-compose.cuda.yml up -d
else
  docker compose --env-file .env -f docker-compose.cpu.yml up -d
fi

echo "llama.cpp server started. Test with: curl http://localhost:${PORT:-8000}/v1/models"
