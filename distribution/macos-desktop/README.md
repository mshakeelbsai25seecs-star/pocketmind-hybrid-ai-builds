# NexusAI — macOS Desktop Package

macOS `.app` / `.dmg` deliverable for Intel and Apple Silicon Macs.

## Build requirement

**Must be built on macOS** (local Mac or macOS CI). Cross-compiling the Tauri bundle from Windows is not supported.

```bash
cd /path/to/nexus-ai-deep-fixed
npm install
npm run tauri build
./distribution/macos-desktop/scripts/stage-release.sh
```

## Runtimes

Bundle native llama.cpp servers per architecture:

- `bin/llama.cpp/macos-arm64-metal/llama-server`
- `bin/llama.cpp/macos-arm64-cpu/llama-server`
- `bin/llama.cpp/macos-x64-metal/llama-server`
- `bin/llama.cpp/macos-x64-cpu/llama-server`

NexusAI selects the matching binary for the current Mac.

## Default paths

`~/Library/Application Support/NexusAI`

## Docs

- `INSTALL.md` — end users
- `../shared/docs/QUICK_START.md`
