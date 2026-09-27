# Build all platform packages

PocketMind Hybrid AI uses **per-OS builds**. You cannot produce a signed macOS `.app` from Windows alone. Plan CI or manual builds on each target OS.

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

On a Mac (or CI workflow **Package macOS Desktop**):

```bash
cd /path/to/nexus-ai-deep-fixed
./scripts/build-macos-desktop.sh
# artifacts → dist-desktop/macos/
# Server optional:
chmod +x distribution/macos-server/scripts/prepare-server.sh
sudo ./distribution/macos-server/scripts/prepare-server.sh
```

## Linux desktop + Linux server

On Linux (or CI workflow **Package Linux Desktop**):

```bash
cd /path/to/nexus-ai-deep-fixed
./scripts/build-linux-desktop.sh
# artifacts → dist-desktop/linux/
# Server optional:
chmod +x distribution/linux-server/scripts/prepare-server.sh
sudo ./distribution/linux-server/scripts/prepare-server.sh
```

Windows Store/MSIX remains isolated (`scripts/REBUILD-STORE-EXE-AND-MSIX.ps1`, `.github/workflows/store-msix.yml`).

## Validation

Follow repo root `RELEASE_CHECKLIST.md` on each platform before zipping.

## Zip naming convention

- `PocketMind Hybrid AI-Windows-Desktop-v0.1.0.zip`
- `PocketMind Hybrid AI-Windows-Server-v0.1.0.zip`
- `PocketMind Hybrid AI-macOS-Desktop-v0.1.0.zip`
- `PocketMind Hybrid AI-Linux-Desktop-v0.1.0.zip`
- etc.

Include `shared/docs/QUICK_START.md` and `shared/company-data-template/` in enterprise handoffs.
