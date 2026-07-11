# NexusAI — Linux Desktop Package

Linux desktop deliverable (AppImage and/or `.deb` from Tauri).

## Build

```bash
cd /path/to/nexus-ai-deep-fixed
npm install
npm run tauri build
./distribution/linux-desktop/scripts/stage-release.sh
```

## Runtimes

- `bin/llama.cpp/linux-cpu/llama-server`
- `bin/llama.cpp/linux-vulkan/llama-server` (when GPU drivers available)

## Default paths

`/var/lib/nexusai` (override with `NEXUS_DATA_ROOT` or Settings → Deployment)

## Docs

- `INSTALL.md`
- `../shared/docs/QUICK_START.md`
