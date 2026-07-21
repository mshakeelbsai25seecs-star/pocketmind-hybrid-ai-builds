# PocketMind Hybrid AI — Linux Desktop Package

Linux desktop deliverable (AppImage and/or `.deb` from Tauri).

## Build

```bash
cd /path/to/nexus-ai-deep-fixed
npm install
npm run tauri build
npm run dist:stage:linux
# or: ./distribution/linux-desktop/scripts/stage-release.sh
```

## Runtimes

Staged under `bin/llama.cpp/{cpu,cuda,vulkan}` (not `linux-cpu`):

- `bin/llama.cpp/cpu/llama-server`
- `bin/llama.cpp/cuda/llama-server` (NVIDIA)
- `bin/llama.cpp/vulkan/llama-server` (when GPU drivers available)

## Default paths

Desktop (unprivileged): `~/.local/share/PocketMind` (legacy fallback: `~/.local/share/NexusAI`)  
Server / writable system root: `/var/lib/pocketmind` when `NEXUS_DEPLOY_MODE=server` or that path is usable (legacy: `/var/lib/nexusai`)  

Override with `NEXUS_DATA_ROOT` or Settings → Deployment.

## Docs

- `INSTALL.md`
- `../shared/docs/QUICK_START.md`
- `../CLIENT_SHIPPING.md`
