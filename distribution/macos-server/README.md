# NexusAI — macOS Server Package

For shared Mac Studio / Mac mini SOC pilots in server mode.

## Default data root

`/Library/Application Support/NexusAI` when `NEXUS_DEPLOY_MODE=server`

Workstation installs use `~/Library/Application Support/NexusAI`.

## Quick start

```bash
sudo bash scripts/prepare-server.sh "/Library/Application Support/NexusAI"
export NEXUS_DATA_ROOT="/Library/Application Support/NexusAI"
export NEXUS_DEPLOY_MODE=server
```

Stage application from `../macos-desktop/payload/` after building on macOS.

## Contents

- `docs/` — USER_MANUAL, ADMIN guide, CONFIGURATION, TROUBLESHOOTING
- `config/` — deployment.env.example, folder-layout.md
- `scripts/prepare-server.sh`
