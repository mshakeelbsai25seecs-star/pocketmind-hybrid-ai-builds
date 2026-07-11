#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
docker compose up -d
cat <<'MSG'
Ollama started.
OpenAI-compatible base URL for NexusAI can usually be:
http://SERVER_IP:11434/v1

Pull a model first, for example:
docker exec -it nexusai-ollama ollama pull qwen2.5:7b-instruct
MSG
