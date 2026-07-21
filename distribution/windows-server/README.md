# PocketMind Hybrid AI — Windows Server Package

Handoff kit for Windows Server pilots.

## Contents

- `docs/USER_MANUAL.md` — analyst guide
- `docs/ADMIN_DEPLOYMENT_GUIDE.md` — IT install
- `docs/CONFIGURATION.md` — paths and options
- `docs/TROUBLESHOOTING.md` — common issues
- `scripts/prepare-server.ps1` — create data folders

## Quick start

1. Run `.\scripts\prepare-server.ps1`.
2. Copy the app and models into the install folder.
3. Launch the app → **Settings → Deployment** → **Save**.
4. Scan and index company data before use.

Default data root: `C:\ProgramData\PocketMind`

Also see `../shared/docs/QUICK_START.md`.
