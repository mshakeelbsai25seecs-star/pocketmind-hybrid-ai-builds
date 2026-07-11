#!/usr/bin/env bash
set -euo pipefail

PORTS=(8000 8080 11434 80 443)
for port in "${PORTS[@]}"; do
  if ss -tuln 2>/dev/null | grep -q ":$port "; then
    echo "Port $port: in use"
  else
    echo "Port $port: available"
  fi
done
