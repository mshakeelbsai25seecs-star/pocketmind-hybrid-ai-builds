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

1. On Windows, build the **fat self-contained installer** (embeds CPU/CUDA/Vulkan runtimes):
   see [FAT_INSTALLER.md](FAT_INSTALLER.md) (`scripts\prepare-windows-bundle-runtimes.ps1` + `npm run tauri build`).
2. Or use the D:-drive builder: [BUILD_ON_D.md](BUILD_ON_D.md).
3. Run `.\scripts\stage-release.ps1` from this folder.
4. Copy `../shared/config` and `../shared/docs/QUICK_START.md` into the zip if desired.
5. For Microsoft Store, host the fat `*-setup.exe` only (GitHub Pages). Zip `payload/` for tester portable packages.

## Default paths

On Windows the app prefers **`D:\PocketMind`** when D: exists (models, indexes, cache).  
`C:\ProgramData\PocketMind` is not the primary data root.

## Runtimes

Bundle llama.cpp under `payload/bin/llama.cpp/`:

- `cpu/` — required fallback
- `cuda/` — NVIDIA GPU machines
- `vulkan/` — AMD/Intel GPU machines

See repo root `RELEASE_CHECKLIST.md` for validation steps.
