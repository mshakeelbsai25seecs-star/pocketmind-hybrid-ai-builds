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

## Host for Store (public repo only)

`nexus-ai-deep-fixed` is **private** — do not use it for the Store package URL.

Host the fat setup on the **public** repo / site:

| Piece | Where |
|-------|--------|
| Website | https://noumanshakeil.github.io/ |
| Binary | GitHub **Release** on `noumanshakeil/noumanshakeil.github.io` (files >100 MB cannot use normal Pages git push) |
| Store Package URL | Release download URL below |

```powershell
powershell -ExecutionPolicy Bypass -File .\distribution\github-pages\PUBLISH-FAT-TO-GITHUB-RELEASE.ps1
powershell -ExecutionPolicy Bypass -File .\distribution\github-pages\PUBLISH-SITE-ONLY.ps1
```

Website download (OK for browsers; **not** for Partner Center):

`https://github.com/noumanshakeil/noumanshakeil.github.io/releases/download/windows-1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe`

**Partner Center Package URL** must not redirect. GitHub Releases always 302, so use Azure Blob:

```powershell
powershell -ExecutionPolicy Bypass -File .\distribution\github-pages\PUBLISH-FAT-TO-AZURE-BLOB.ps1
```

See `../github-pages/STORE_PACKAGE_URL.md`.

Silent install switch: `/S`  
Architecture: **x64** only  

Partner Center return codes: see `STORE_RETURN_CODES.md` in this folder.

## Notes

- Binaries under `src-tauri/resources/llama.cpp/` are gitignored; regenerate before each release build.
- If CUDA download fails, CPU (+ Vulkan) still produce a working installer.
- This is an **installer that unpacks runtimes**, not a single PE with zero sibling files after install (required for CUDA DLLs).
