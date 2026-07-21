# Client shipping checklist

Use this before handing a build to a customer.

## Package contents

- [ ] **Binary zip / installer only** — staged `payload/`, not the repo root
- [ ] **No `src/`**, **no `src-tauri/`**, **no `node_modules/`**
- [ ] **No `.git/`** and no internal scripts beyond what stage copied
- [ ] **Models separate** — empty `models/` placeholder OK; ship GGUF files on a separate secure channel
- [ ] **No `company-data/`** customer corpora in the app zip
- [ ] Platform-correct **llama.cpp** backends only (see below)
- [ ] `INSTALL.md` and `WHAT_IS_INCLUDED.md` present in the zip

## Runtime layout

| Platform | Include |
|----------|---------|
| Windows | `bin/llama.cpp/cpu`, `cuda`, `vulkan` |
| Linux | `bin/llama.cpp/cpu`, `cuda`, `vulkan` |
| macOS | `bin/llama.cpp/macos-*` only; also embed under `.app/Contents/Resources/llama.cpp` when possible |

## Signing / notarization notes

- **Windows**: Prefer a signed NSIS/MSI or Authenticode-signed `PocketMind Hybrid AI.exe`. Unsigned EXEs trigger SmartScreen.
- **macOS**: Sign the `.app` and notarize the DMG/zip before client delivery (`codesign`, `notarytool`). Unsigned apps fail Gatekeeper.
- **Linux**: AppImage/deb usually unsigned; document checksums (`sha256sum`) in the handoff note.

## Stage commands

```bash
# After `npm run tauri build` on the target OS:
npm run dist:stage:windows   # PowerShell stage → distribution/windows-desktop/payload
npm run dist:stage:macos     # → distribution/macos-desktop/payload
npm run dist:stage:linux     # → distribution/linux-desktop/payload
```

## Zip examples

```powershell
# Windows (from repo root, after staging)
Compress-Archive -Path distribution\windows-desktop\payload\* -DestinationPath PocketMind Hybrid AI-windows-desktop.zip
```

```bash
# macOS / Linux (from repo root, after staging)
cd distribution/macos-desktop && zip -r ../../PocketMind Hybrid AI-macos-desktop.zip payload
cd distribution/linux-desktop && zip -r ../../PocketMind Hybrid AI-linux-desktop.zip payload
```

## Data roots (runtime, not in the zip)

| Platform | Default data root |
|----------|-------------------|
| Windows | `D:\PocketMind` |
| macOS | `~/Library/Application Support/PocketMind` (server: `/Library/Application Support/PocketMind`) |
| Linux desktop | `~/.local/share/PocketMind` |
| Linux server | `/var/lib/pocketmind` when `NEXUS_DEPLOY_MODE=server` or that path is usable |

Override anytime with `NEXUS_DATA_ROOT`.

## Related

- [CLIENT_HANDOFF.md](./CLIENT_HANDOFF.md) — short “never ship git” reminder
