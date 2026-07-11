# NexusAI — Linux Server Package

Enterprise handoff kit for Linux server SOC pilots.

## Contents

Same documentation layout as Windows server: `docs/`, `config/`, `scripts/prepare-server.sh`.

## Application binary

Stage from `../linux-desktop/payload/` after `npm run tauri build` on Linux.

## Quick start (admin)

```bash
sudo bash scripts/prepare-server.sh /var/lib/nexusai
export NEXUS_DATA_ROOT=/var/lib/nexusai
export NEXUS_DEPLOY_MODE=server
# Launch NexusAI → Settings → Deployment → Save
```

Default data root: `/var/lib/nexusai`
