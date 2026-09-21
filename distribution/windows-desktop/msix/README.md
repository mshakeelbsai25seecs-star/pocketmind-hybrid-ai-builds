# Optional: MSIX packaging for PocketMind (free Store signing)

Use this path only if you are converting the Partner Center product from
**EXE/MSI (URL)** to **MSIX/PWA**, or creating a new MSIX listing.

## Current MSIX product identity (use exactly)

| Field | Value |
|-------|--------|
| Store ID | `9NZ7WF9VXF5R` |
| Package/Identity/Name | `PocketMind.PocketMindAI` |
| Publisher | `CN=78BD2D1C-2460-451B-91FD-410288D37531` |
| Publisher display name | `PocketMind` |
| Package Family Name | `PocketMind.PocketMindAI_fawhaqqkcp3dj` |

These values are already set in `Package.appxmanifest`.

## Why MSIX helps

- Microsoft **re-signs** MSIX during Store publishing — you do not buy a CA cert for Store distribution
- Still ship **CPU-only** contents (policy 10.2.4.2)
- Declare `runFullTrust` (required for classic Tauri/Win32) and justify it under Submission options

## Tile icons (policy 10.1.1.11)

Store rejected the first MSIX because Start tile assets were tiny placeholders and looked blurry.

Sharp assets now live in `distribution/windows-desktop/msix/Assets/` (base + `.scale-200` + `.scale-400`).
`stage-msix-layout.ps1` copies those into the package layout. Do not replace them with the old
tiny `src-tauri/icons/Square*.png` placeholders.

After any tile fix, bump `Package.appxmanifest` `Identity Version` before resubmitting.
Current package version target: **1.0.2.0** (includes Report AI content for policy 11.16).

Certification resubmit checklist for 10.2.4.1 / 11.16 / 10.1.2.7:
`distribution/windows-desktop/STORE_RESUBMIT_CERT_FIXES.md`
Store Description paste (Visual C++ in first two lines):
`distribution/windows-desktop/STORE_LISTING_DESCRIPTION.md`

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

On the Windows build PC:

```powershell
cd D:\nexus-ai-deep-fixed

# CPU-only Store build (no need to Authenticode-sign for Store MSIX)
powershell -ExecutionPolicy Bypass -File .\scripts\BUILD-STORE-INSTALLER.ps1

# Stage loose layout
powershell -ExecutionPolicy Bypass -File .\distribution\windows-desktop\msix\stage-msix-layout.ps1

# Pack with MakeAppx (Windows SDK) — recommended if winapp is missing
powershell -ExecutionPolicy Bypass -File .\distribution\windows-desktop\msix\PACK-MSIX.ps1
```

If `MakeAppx.exe` is missing, install a Windows SDK **or** WinApp CLI:

```powershell
winget install -e --id Microsoft.WindowsSDK.10.0.26100 --source winget
# OR
winget install -e --id Microsoft.winappcli --source winget
```

Output file:

`distribution\windows-desktop\msix\out\PocketMind.PocketMindAI_1.0.0.0_x64.msix`

Upload that `.msix` in Partner Center → Packages (upload button — not a URL).
Do **not** buy a code-signing cert for Store MSIX — Microsoft re-signs it.

## runFullTrust justification (Submission options)

```text
PocketMind Hybrid AI is a classic Win32 / Tauri desktop application packaged as
MSIX with full trust. It must launch a local llama.cpp inference helper
(llama-server.exe), read/write user model files under AppData, and use WebView2.
These require the runFullTrust restricted capability typical of packaged
desktop (Centennial) apps. No kernel drivers or NT services are installed.
```
