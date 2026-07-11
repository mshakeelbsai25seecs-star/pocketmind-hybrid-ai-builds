#!/usr/bin/env bash
set -euo pipefail

OUT="nexusai-server-report-$(date +%Y%m%d-%H%M%S).txt"
{
  echo "NexusAI Enterprise Server Report"
  echo "================================"
  echo
  ./detect_server.sh || true
} > "$OUT"

echo "Report written to: $OUT"
