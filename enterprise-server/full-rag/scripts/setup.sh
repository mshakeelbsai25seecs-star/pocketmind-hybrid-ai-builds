#!/usr/bin/env bash
# Backward-compatible wrapper — use install.sh going forward.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "NOTE: setup.sh now delegates to install.sh (hardened entrypoint)."
exec bash "${SCRIPT_DIR}/install.sh" "$@"
