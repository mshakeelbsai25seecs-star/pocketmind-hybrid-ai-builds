# NexusAI — Windows Desktop Package

Portable Windows desktop build for analysts and power users on Windows 10/11.

## Contents

| Path | Description |
|------|-------------|
| `payload/` | Staged release files (exe, DLLs, runtimes) — populated by `scripts/stage-release.ps1` |
| `INSTALL.md` | End-user installation steps |
| `WHAT_IS_INCLUDED.md` | File manifest after staging |
| `scripts/stage-release.ps1` | Copies Tauri build output into `payload/` |

## Before you ship

1. Run `npm run tauri build` on a Windows machine.
2. Run `.\scripts\stage-release.ps1` from this folder.
3. Copy `../shared/config` and `../shared/docs/QUICK_START.md` into the zip if desired.
4. Zip `payload/` + docs as `NexusAI-Windows-Desktop-v0.1.0.zip`.

## Default paths

`C:\ProgramData\NexusAI` — configurable in Settings → Deployment.

## Runtimes

Bundle llama.cpp under `payload/bin/llama.cpp/`:

- `cpu/` — required fallback
- `cuda/` — NVIDIA GPU machines
- `vulkan/` — AMD/Intel GPU machines

See repo root `RELEASE_CHECKLIST.md` for validation steps.
