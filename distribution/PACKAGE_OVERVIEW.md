# Package overview

NexusAI ships as **seven sibling packages** under `distribution/`. Each package is designed to be zipped and handed to IT or analysts without requiring the full source repository.

## Desktop packages (end-user installs)

### Windows desktop (`windows-desktop/`)

- **Payload:** `NexusAI.exe`, WebView2 runtime deps, `bin/llama.cpp/{cpu,cuda,vulkan}/`
- **Docs:** `INSTALL.md`, `WHAT_IS_INCLUDED.md`
- **Script:** `scripts/stage-release.ps1` copies from `src-tauri/target/release/bundle/`

### macOS desktop (`macos-desktop/`)

- **Payload:** `NexusAI.app` or `.dmg`, `bin/llama.cpp/macos-{arm64,x64}-{metal,cpu}/`
- **Build note:** Must be built on macOS or macOS CI.
- **Script:** `scripts/stage-release.sh`

### Linux desktop (`linux-desktop/`)

- **Payload:** AppImage and/or `.deb` from Tauri bundle, `bin/llama.cpp/linux-{cpu,vulkan}/`
- **Script:** `scripts/stage-release.sh`

## Server packages (IT / SOC rollout)

### Windows server (`windows-server/`)

- Same desktop binary plus **admin** documentation.
- `scripts/prepare-server.ps1` creates `C:\ProgramData\NexusAI` tree.
- Includes `USER_MANUAL.md`, `ADMIN_DEPLOYMENT_GUIDE.md`, `CONFIGURATION.md`, `TROUBLESHOOTING.md`.

### Linux server (`linux-server/`)

- Same as Windows server but paths under `/var/lib/nexusai`.
- `scripts/prepare-server.sh`

### macOS server (`macos-server/`)

- For shared Mac mini / Mac Studio SOC pilots.
- Default root: `/Library/Application Support/NexusAI` when `NEXUS_DEPLOY_MODE=server`.

## Shared assets (`shared/`)

- `config/deployment.env.example` — environment variable template (Windows + Linux examples)
- `config/folder-layout.md` — recommended directory tree
- `docs/QUICK_START.md` — 10-minute analyst onboarding
- `company-data-template/README.md` — intake folder structure for company SOC data

## What is NOT in the bundle

- GGUF model weights (customer supplies under `models/`)
- Company SOC documents (customer supplies under `company-data/`)
- API keys for optional online providers

## Offline-first guarantees

- SOC triage, Knowledge Chat indexing, validators, and exports run without internet.
- Human approval is required for production actions; no live FortiSIEM/FortiSOAR API in this release.
