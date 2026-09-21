# Partner Center — upload Store MSIX (1.0.3.0)

Product: **PocketMind AI**  
Store ID: **9NZ7WF9VXF5R**  
Identity: `PocketMind.PocketMindAI`  
Publisher: `CN=78BD2D1C-2460-451B-91FD-410288D37531`  
PFN: `PocketMind.PocketMindAI_fawhaqqkcp3dj`  
Package version: **1.0.3.0**

## Build on Windows (required)

This Linux Cloud Agent **cannot** run MakeAppx or produce a real `.msix`. On a Windows x64 PC with VS Build Tools + Windows SDK:

```powershell
cd D:\nexus-ai-deep-fixed
git fetch origin
git checkout cursor/store-parity-pocketcode-1e43
git pull

# CPU-only Store build (policy 10.2.4.2 — no CUDA/Vulkan in package)
powershell -ExecutionPolicy Bypass -File .\scripts\BUILD-STORE-INSTALLER.ps1

# Stage loose layout (sharp tiles from distribution\windows-desktop\msix\Assets)
powershell -ExecutionPolicy Bypass -File .\distribution\windows-desktop\msix\stage-msix-layout.ps1

# Pack (MakeAppx from Windows SDK) — Store does NOT need you to Authenticode-sign
powershell -ExecutionPolicy Bypass -File .\distribution\windows-desktop\msix\PACK-MSIX.ps1
```

Expected output:

`distribution\windows-desktop\msix\out\PocketMind.PocketMindAI_1.0.3.0_x64.msix`

If MakeAppx is missing:

```powershell
winget install -e --id Microsoft.WindowsSDK.10.0.26100 --source winget
```

Optional CI: Actions → **Store MSIX (CPU-only)** → Run workflow on this branch.

## Publish for humans (GitHub Release)

```powershell
gh release create store-msix-1.0.3.0 `
  "distribution\windows-desktop\msix\out\PocketMind.PocketMindAI_1.0.3.0_x64.msix" `
  --repo noumanshakeil/nexus-ai-deep-fixed `
  --title "PocketMind AI Store MSIX 1.0.3.0" `
  --notes "CPU-only Store MSIX for Partner Center upload. Microsoft re-signs on publish."
```

Release download URL (fine for humans; **not** for Partner Center Package URL — GitHub 302-redirects):

`https://github.com/noumanshakeil/nexus-ai-deep-fixed/releases/download/store-msix-1.0.3.0/PocketMind.PocketMindAI_1.0.3.0_x64.msix`

For **MSIX product type**, upload the file in Partner Center → Packages (file upload). Do **not** paste a GitHub Releases URL into Package URL fields.

## Partner Center submission checklist

| Step | Status / action |
|------|-----------------|
| Identity Name / Publisher CN match table above | Verify in manifest |
| Version **1.0.3.0** higher than last submitted package | Manifest bumped on this branch |
| CPU-only payload (no `cuda/` / `vulkan/`) | Enforced by BUILD-STORE-INSTALLER + stage/pack scripts |
| Tile assets sharp (policy 10.1.1.11) | `msix/Assets/` base + scale-200/400 |
| VC++ disclosure in Description first two lines (10.2.4.1) | Paste `STORE_LISTING_DESCRIPTION.md` |
| Report AI content in app (11.16) | Chat, Image Studio, Document Studio, Help, Settings → Advanced |
| Privacy URL resolves (10.1.2.7) | Publisher verifies `https://noumanshakeil.github.io/privacy.html` |
| Device family Desktop only | Yes |
| `runFullTrust` justification | See `msix/README.md` |
| Generative AI declaration = Yes | Keep |
| Remove older failed packages from submission | Publisher |
| Do **not** Authenticode-sign Store MSIX | Microsoft re-signs |

## Listing description

Paste from `STORE_LISTING_DESCRIPTION.md` (VC++ lines first).

## Related

- Certification notes: `STORE_RESUBMIT_CERT_FIXES.md`
- Properties / privacy: `STORE_PROPERTIES.md`
- Why GitHub Release URLs fail as Package URL: `../github-pages/STORE_PACKAGE_URL.md`
