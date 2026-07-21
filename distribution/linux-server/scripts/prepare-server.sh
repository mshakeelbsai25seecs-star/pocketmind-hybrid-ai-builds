#!/usr/bin/env bash
set -euo pipefail

DATA_ROOT="${1:-/var/lib/pocketmind}"

folders=(
  "$DATA_ROOT"
  "$DATA_ROOT/models"
  "$DATA_ROOT/models/embeddings"
  "$DATA_ROOT/company-data"
  "$DATA_ROOT/company-data/intake"
  "$DATA_ROOT/exports"
  "$DATA_ROOT/indexes"
  "$DATA_ROOT/knowledge-chat"
)

echo "Preparing PocketMind Hybrid AI server folders under $DATA_ROOT"
for folder in "${folders[@]}"; do
  if [[ -d "$folder" ]]; then
    echo "Exists  $folder"
  else
    mkdir -p "$folder"
    echo "Created $folder"
  fi
done

echo ""
echo "Next steps:"
echo "1. Copy GGUF models to $DATA_ROOT/models"
echo "2. Copy embedding model to $DATA_ROOT/models/embeddings"
echo "3. Copy company SOC data to $DATA_ROOT/company-data"
echo "4. export NEXUS_DATA_ROOT=$DATA_ROOT (optional)"
echo "5. Launch PocketMind Hybrid AI and open Settings -> Deployment"
