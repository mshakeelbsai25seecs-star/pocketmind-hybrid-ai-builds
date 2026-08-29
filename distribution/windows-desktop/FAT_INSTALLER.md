# Self-contained Windows installer (fat setup.exe)

Goal: Microsoft Store users download **one** setup EXE. After install, PocketMind
works for local GGUF chat without a separate `bin\` download.

## What gets embedded

| Backend | Path inside install folder |
|---------|----------------------------|
| CPU | `resources/llama.cpp/cpu/` |
| CUDA | `resources/llama.cpp/cuda/` |
| Vulkan | `resources/llama.cpp/vulkan/` |

**Not embedded:** GGUF model weights (often multi‑GB). Users still add models in Settings / Models.

## Build (Windows)

```powershell
cd D:\nexus-ai-deep-fixed

# 1) Download runtimes + copy into src-tauri/resources/llama.cpp
powershell -ExecutionPolicy Bypass -File .\scripts\prepare-windows-bundle-runtimes.ps1

# 2) Build (or use the full desktop builder)
$env:CARGO_HOME = "D:\DevCache\Cargo"
$env:RUSTUP_HOME = "D:\DevCache\Rustup"
$env:CARGO_TARGET_DIR = "D:\DevCache\Cargo\target\nexus-ai"
npm run tauri build
```

Or one-click:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\BUILD-FAT-INSTALLER.ps1
```

(`.cmd` wrapper also exists: `scripts\BUILD-FAT-INSTALLER.cmd` — run with `cmd /c`, not `powershell -File`.)

## Outputs

- NSIS: `...\release\bundle\nsis\PocketMind Hybrid AI_*_x64-setup.exe` (**Store package**)
- MSI: `...\release\bundle\msi\*.msi`
- After install, app directory contains EXE + `resources\llama.cpp\...`

Expected Store package size: roughly **hundreds of MB to ~1+ GB** (CUDA dominates).

## Host for Store

Upload only the fat `*-setup.exe` to GitHub Pages, e.g.:

`https://noumanshakeil.github.io/downloads/1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe`

Silent install switch: `/S`

## Notes

- Binaries under `src-tauri/resources/llama.cpp/` are gitignored; regenerate before each release build.
- If CUDA download fails, CPU (+ Vulkan) still produce a working installer.
- This is an **installer that unpacks runtimes**, not a single PE with zero sibling files after install (required for CUDA DLLs).
