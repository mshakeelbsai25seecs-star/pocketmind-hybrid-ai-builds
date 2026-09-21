# Build PocketMind Hybrid AI Windows `.exe` (D: drive)

This cloud agent **cannot** build a Windows `.exe` (it runs Linux). Build on your PC.

## One command (recommended)

In **PowerShell**:

```powershell
cd D:\nexus-ai-deep-fixed

# Get build scripts without switching branches (do NOT use Set-Content - it corrupts .ps1 files)
git fetch origin cursor/android-studio-setup-7411
git checkout origin/cursor/android-studio-setup-7411 -- `
  scripts/build-desktop-windows.ps1 `
  scripts/BUILD-DESKTOP-EXE.cmd `
  scripts/FIX-MSVC-BUILDTOOLS.cmd

# Install toolchain on D: + build
powershell -ExecutionPolicy Bypass -File .\scripts\build-desktop-windows.ps1
```

Or double-click:

```text
D:\nexus-ai-deep-fixed\scripts\BUILD-DESKTOP-EXE.cmd
```

## What gets installed on D:

| Path | Purpose |
|------|---------|
| `D:\DevCache\Cargo` | `CARGO_HOME` (cargo, crates) |
| `D:\DevCache\Rustup` | `RUSTUP_HOME` (toolchains) |
| `D:\DevCache\Cargo\target\nexus-ai` | Build output / `CARGO_TARGET_DIR` |
| `D:\DevCache\npm-cache` | npm cache |
| `D:\DevCache\tmp` | TEMP/TMP during build |
| `D:\PocketMind` | App data root (`NEXUS_DATA_ROOT`) |

Also installs (if missing):

- Node.js LTS (via winget) — usually on C: under Program Files
- Rust stable MSVC via `rustup-init` into the D: paths above
- Visual Studio 2022 **Build Tools** (C++ workload) — needed to link the `.exe` (may use some C: space)
- WebView2 Evergreen Runtime
- `bin\llama.cpp\{cpu,cuda,vulkan}` runtimes next to the project (for local inference)

## Outputs

After a successful build:

```text
D:\DevCache\Cargo\target\nexus-ai\release\PocketMind Hybrid AI.exe
```

Optional staged portable folder:

```text
D:\nexus-ai-deep-fixed\distribution\windows-desktop\payload\
```

NSIS installer (if bundling succeeds):

```text
D:\DevCache\Cargo\target\nexus-ai\release\bundle\nsis\
```

## Common failures

| Error | Fix |
|-------|-----|
| `failed to get cargo metadata: program not found` | Re-run this script (it installs Rust on D:) or open a **new** PowerShell after install |
| `ENOENT ... package.json` | `cd D:\nexus-ai-deep-fixed` first |
| linker / `link.exe` / MSVC errors | Install VS Build Tools with C++ workload (script tries via winget) |
| Out of space on C: | Confirm `CARGO_HOME` / `CARGO_TARGET_DIR` point at `D:\DevCache\...` |

## Build only (toolchain already installed)

```powershell
cd D:\nexus-ai-deep-fixed
powershell -ExecutionPolicy Bypass -File .\scripts\build-desktop-windows.ps1 -SkipLlamaRuntimes
```
