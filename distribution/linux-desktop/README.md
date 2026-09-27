# PocketMind Hybrid AI — Linux Desktop Package

Linux desktop deliverable (AppImage and/or `.deb` from Tauri).

## Build

Preferred one-shot (AppImage + `.deb` + staged tar.gz; CPU llama runtime):

```bash
cd /path/to/nexus-ai-deep-fixed
./scripts/build-linux-desktop.sh
# artifacts → dist-desktop/linux/
```

CI: GitHub Actions workflow **Package Linux Desktop** (`.github/workflows/package-linux.yml`). Isolated from Windows Store/MSIX.

Manual / legacy:

```bash
npm install
npm run tauri build -- --bundles appimage,deb
npm run dist:stage:linux
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
