# noumanshakeil.github.io

Public download host for **PocketMind Hybrid AI** Windows installers
(Microsoft Store package URL + website).

## Live site

https://noumanshakeil.github.io/

## Downloads vs Store package URL

| Use | Host | Why |
|-----|------|-----|
| Website / people | GitHub Release on this public repo | Fine for browsers (follows redirects) |
| **Microsoft Partner Center Package URL** | **Azure Blob (direct HTTP 200)** | Partner Center rejects GitHub’s HTTP 302 redirect |

GitHub Release (website only):

https://github.com/noumanshakeil/noumanshakeil.github.io/releases/download/windows-1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe

Store Package URL: run `PUBLISH-FAT-TO-AZURE-BLOB.ps1` and use the printed
`https://<account>.blob.core.windows.net/releases/1.0.0/...exe` link.

Details: `STORE_PACKAGE_URL.md`

- Silent install: `/S`
- Architecture: **x64**

## Publish from your Windows PC

```powershell
cd D:\nexus-ai-deep-fixed
git fetch origin cursor/android-studio-setup-7411
git checkout origin/cursor/android-studio-setup-7411 -- distribution/github-pages

# 1) Upload fat setup.exe to PUBLIC repo Release (required for Store)
powershell -ExecutionPolicy Bypass -File .\distribution\github-pages\PUBLISH-FAT-TO-GITHUB-RELEASE.ps1

# 2) Refresh the small Pages site (index.html links to that Release)
powershell -ExecutionPolicy Bypass -File .\distribution\github-pages\PUBLISH-SITE-ONLY.ps1
```

Needs `gh auth login` with access to `noumanshakeil/noumanshakeil.github.io`.

## Partner Center return codes

See `distribution/windows-desktop/STORE_RETURN_CODES.md` in the product repo.
