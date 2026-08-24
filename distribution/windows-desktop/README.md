# PocketMind Hybrid AI — Windows Desktop Package

Portable Windows desktop build for analysts and power users on Windows 10/11.

## Contents

| Path | Description |
|------|-------------|
| `payload/` | Staged release files (exe, DLLs, runtimes) — populated by `scripts/stage-release.ps1` |
| `INSTALL.md` | End-user installation steps |
| `WHAT_IS_INCLUDED.md` | File manifest after staging |
| `scripts/stage-release.ps1` | Copies Tauri build output into `payload/` |

## Before you ship

1. On a Windows machine with D: available, prefer the D:-drive installer/builder:
   see [BUILD_ON_D.md](BUILD_ON_D.md) (`scripts\build-desktop-windows.ps1`).
2. Or manually: `npm run tauri build` then `.\scripts\stage-release.ps1` from this folder.
3. Copy `../shared/config` and `../shared/docs/QUICK_START.md` into the zip if desired.
4. Zip `payload/` + docs as `PocketMind Hybrid AI-Windows-Desktop-v0.1.0.zip`.

## Default paths

On Windows the app prefers **`D:\PocketMind`** when D: exists (models, indexes, cache).  
`C:\ProgramData\PocketMind` is not the primary data root.

## Runtimes

Bundle llama.cpp under `payload/bin/llama.cpp/`:

- `cpu/` — required fallback
- `cuda/` — NVIDIA GPU machines
- `vulkan/` — AMD/Intel GPU machines

See repo root `RELEASE_CHECKLIST.md` for validation steps.
