# Build all platform packages

NexusAI uses **per-OS builds**. You cannot produce a signed macOS `.app` from Windows alone. Plan CI or manual builds on each target OS.

## Prerequisites (all platforms)

```bash
npm install
# Rust + Tauri deps per https://tauri.app/v1/guides/getting-started/prerequisites
```

## Windows desktop + Windows server

```powershell
cd D:\nexus-ai-deep-fixed
npm run build
npm run tauri build
.\distribution\windows-desktop\scripts\stage-release.ps1
# Server: copy same payload + run prepare-server.ps1 on target host
.\distribution\windows-server\scripts\prepare-server.ps1
```

## macOS desktop + macOS server

On a Mac:

```bash
cd /path/to/nexus-ai-deep-fixed
npm run build
npm run tauri build
chmod +x distribution/macos-desktop/scripts/stage-release.sh
./distribution/macos-desktop/scripts/stage-release.sh
chmod +x distribution/macos-server/scripts/prepare-server.sh
sudo ./distribution/macos-server/scripts/prepare-server.sh
```

## Linux desktop + Linux server

```bash
cd /path/to/nexus-ai-deep-fixed
npm run build
npm run tauri build
chmod +x distribution/linux-desktop/scripts/stage-release.sh
./distribution/linux-desktop/scripts/stage-release.sh
chmod +x distribution/linux-server/scripts/prepare-server.sh
sudo ./distribution/linux-server/scripts/prepare-server.sh
```

## Validation

Follow repo root `RELEASE_CHECKLIST.md` on each platform before zipping.

## Zip naming convention

- `NexusAI-Windows-Desktop-v0.1.0.zip`
- `NexusAI-Windows-Server-v0.1.0.zip`
- `NexusAI-macOS-Desktop-v0.1.0.zip`
- `NexusAI-Linux-Desktop-v0.1.0.zip`
- etc.

Include `shared/docs/QUICK_START.md` and `shared/company-data-template/` in enterprise handoffs.
