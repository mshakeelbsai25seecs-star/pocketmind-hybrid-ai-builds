#!/usr/bin/env bash
set -euo pipefail

# Full-rag published ports plus common extras
PORTS=(8000 8001 8002 8003 8080 11434 80 443)
for port in "${PORTS[@]}"; do
  if ss -tuln 2>/dev/null | grep -qE ":${port}[[:space:]]"; then
    echo "Port $port: in use"
  else
    echo "Port $port: available"
  fi
done
