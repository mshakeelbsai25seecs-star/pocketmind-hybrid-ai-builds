# PocketMind Hybrid AI — macOS Desktop Package

macOS `.app` / `.dmg` deliverable for Intel and Apple Silicon Macs.

## Build requirement

**Must be built on macOS** (local Mac or macOS CI). Cross-compiling the Tauri bundle from Windows is not supported.

Preferred one-shot (`.app` + `.dmg` + zip; unsigned unless you add Apple certs):

```bash
cd /path/to/nexus-ai-deep-fixed
./scripts/build-macos-desktop.sh
# artifacts → dist-desktop/macos/
```

CI: GitHub Actions workflow **Package macOS Desktop** (`.github/workflows/package-macos.yml`). Isolated from Windows Store/MSIX. Unsigned builds: right-click → **Open**.

Manual / legacy:

```bash
npm install
npm run tauri build -- --bundles app,dmg
./distribution/macos-desktop/scripts/stage-release.sh
```

## Runtimes

Bundle native llama.cpp servers per architecture:

- `bin/llama.cpp/macos-arm64-metal/llama-server`
- `bin/llama.cpp/macos-arm64-cpu/llama-server`
- `bin/llama.cpp/macos-x64-metal/llama-server`
- `bin/llama.cpp/macos-x64-cpu/llama-server`

PocketMind Hybrid AI selects the matching binary for the current Mac.

## Default paths

`~/Library/Application Support/PocketMind`

## Docs

- `INSTALL.md` — end users
- `../shared/docs/QUICK_START.md`
