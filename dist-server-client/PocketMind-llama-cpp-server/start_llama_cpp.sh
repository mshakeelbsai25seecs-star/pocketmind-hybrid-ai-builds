#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p models
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env. Put a complete GGUF in ./models and set MODEL_PATH."
fi

# shellcheck disable=SC1091
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1090
  source .env || true
  set +a
fi

MODEL_PATH="${MODEL_PATH:-/models/model.gguf}"
HOST_FILE="models/$(basename "${MODEL_PATH}")"
if [ ! -f "$HOST_FILE" ]; then
  echo "REFUSING TO START: model not found: $HOST_FILE" >&2
  echo "Copy a complete .gguf into ./models and set MODEL_PATH in .env" >&2
  exit 1
fi
SIZE=$(wc -c < "$HOST_FILE" | tr -d ' ')
if [ "$SIZE" -lt 1000000 ]; then
  echo "REFUSING TO START: model too small ($SIZE bytes) — incomplete/corrupt: $HOST_FILE" >&2
  exit 1
fi
MAGIC=$(head -c 4 "$HOST_FILE" || true)
if [ "$MAGIC" != "GGUF" ]; then
  echo "REFUSING TO START: not a GGUF file (magic=$MAGIC): $HOST_FILE" >&2
  exit 1
fi

MODE="${1:-cpu}"
if [ "$MODE" = "cuda" ]; then
  docker compose --env-file .env -f docker-compose.cuda.yml up -d
else
  docker compose --env-file .env -f docker-compose.cpu.yml up -d
fi

echo "llama.cpp server started from $(pwd)."
echo "Test with: curl http://127.0.0.1:${PORT:-8000}/v1/models"
echo "On Windows PowerShell use: curl.exe http://127.0.0.1:${PORT:-8000}/v1/models"
