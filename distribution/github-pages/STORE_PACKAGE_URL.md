# Why Partner Center rejects the GitHub Release URL

## What the error means

> The package URL redirects to another URL. Provide a download URL without redirection.

Microsoft Partner Center downloads your installer with a plain HTTP GET and **requires HTTP 200 with the binary body**. It **rejects any 301/302 redirect**.

### Your current URL

```
https://github.com/noumanshakeil/noumanshakeil.github.io/releases/download/windows-1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe
```

That URL is fine for humans/browsers, but GitHub always responds like:

```
HTTP/2 302
Location: https://release-assets.githubusercontent.com/github-production-release-asset/...?sig=...&se=...
```

So Partner Center fails. The redirected CDN URL is also **time-limited** — do not paste that signed URL into Partner Center.

Same problem with OneDrive / Google Drive / Dropbox “share” links.

## What works

A **public HTTPS URL that returns 200** and streams the `.exe` with no redirect, for example:

```
https://<storageaccount>.blob.core.windows.net/releases/1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe
```

Verify before pasting into Partner Center:

```powershell
curl.exe -sI "https://YOUR-DIRECT-URL/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe"
```

You want:

- `HTTP/1.1 200` or `HTTP/2 200`
- **No** `Location:` header
- `Content-Type` something like `application/octet-stream` (or exe)
- `Content-Length` matching the file (~1 GB)

## Recommended host (this repo)

Use **Azure Blob Storage** (anonymous public read on one container):

```powershell
cd D:\nexus-ai-deep-fixed
git fetch origin cursor/android-studio-setup-7411
git checkout origin/cursor/android-studio-setup-7411 -- distribution/github-pages

# one-time: az login, then:
powershell -ExecutionPolicy Bypass -File .\distribution\github-pages\PUBLISH-FAT-TO-AZURE-BLOB.ps1
```

The script prints the **Store Package URL** after verifying zero redirects.

Keep GitHub Releases / https://noumanshakeil.github.io/ for people downloading from the website. Use the **Azure Blob URL only** in Partner Center.

## Partner Center fields (unchanged)

| Field | Value |
|-------|--------|
| Installer | EXE |
| Architecture | x64 |
| Silent switch | `/S` |
| Package URL | Azure Blob URL from the script (no GitHub Releases URL) |
