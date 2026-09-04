# Optional: MSIX packaging for PocketMind (free Store signing)

Use this path only if you are converting the Partner Center product from
**EXE/MSI (URL)** to **MSIX/PWA**, or creating a new MSIX listing.

Your current PocketMind AI product (`c2aea639-62fc-4bda-b565-4f1ae4f70e9a`) is
EXE/MSI. Partner Center will **not** accept an `.msix` upload on that listing
until Microsoft changes the product type (support ticket) or you create a new
MSIX app (may require releasing the name reservation).

Until then, use the signed EXE flow in `../STORE_RESUBMIT_10_2_9.md`.

## Why MSIX helps

- Microsoft **re-signs** MSIX during Store publishing — you do not buy a CA cert for Store distribution
- Still ship **CPU-only** contents (policy 10.2.4.2)
- Declare `runFullTrust` (required for classic Tauri/Win32) and justify it under Submission options

## Partner Center product-type change

1. Partner Center → Help → Support
2. Problem type: **App submission and certification** → **Submitting an app**
3. Ask to convert product ID `c2aea639-62fc-4bda-b565-4f1ae4f70e9a` from EXE/MSI to MSIX/PWA while keeping the name **PocketMind AI**
4. Do not delete the listing until support confirms the safe path

## Package identity

In Partner Center → Account settings / Product → copy:

- **Publisher** display name (e.g. `PocketMind`)
- **Publisher ID** / Package publisher CN (form `CN=XXXXXXXX-...`)

Edit `Package.appxmanifest` in this folder and replace:

- `PUBLISHER_CN_FROM_PARTNER_CENTER`
- Confirm `Name`, `Version`, and executable name

## Build (after product type is MSIX)

On the Windows build PC, with [winapp CLI](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/) installed:

```powershell
cd D:\nexus-ai-deep-fixed

# CPU-only Store build (no need to Authenticode-sign for Store MSIX)
powershell -ExecutionPolicy Bypass -File .\scripts\BUILD-STORE-INSTALLER.ps1

# Stage loose layout for winapp pack (script helper)
powershell -ExecutionPolicy Bypass -File .\distribution\windows-desktop\msix\stage-msix-layout.ps1

# Pack (Store will re-sign; local cert only needed for sideload testing)
winapp pack .\distribution\windows-desktop\msix\layout
```

Upload the `.msix` / `.msixbundle` in Partner Center Packages (upload button — not a URL).

## runFullTrust justification (Submission options)

```text
PocketMind Hybrid AI is a classic Win32 / Tauri desktop application packaged as
MSIX with full trust. It must launch a local llama.cpp inference helper
(llama-server.exe), read/write user model files under AppData, and use WebView2.
These require the runFullTrust restricted capability typical of packaged
desktop (Centennial) apps. No kernel drivers or NT services are installed.
```
