# Publish the fat Windows setup.exe to the PUBLIC github.io repo as a Release asset.
#
# Why Releases (not git push into downloads/):
#   Fat setup with CUDA is often >100 MB. GitHub blocks normal git files over 100 MB.
#   Releases on a public repo allow up to ~2 GB and give a stable HTTPS download URL.
#
# Public host (this is what Store + the website use):
#   Repo:  https://github.com/noumanshakeil/noumanshakeil.github.io
#   Site:  https://noumanshakeil.github.io/
#   Package URL (after publish):
#   https://github.com/noumanshakeil/noumanshakeil.github.io/releases/download/windows-1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe
#
# Prereqs: `gh auth status` (account that can push to noumanshakeil.github.io)
#
# Example:
#   powershell -ExecutionPolicy Bypass -File .\distribution\github-pages\PUBLISH-FAT-TO-GITHUB-RELEASE.ps1
param(
  [string]$SetupExe = "D:\nexus-ai-deep-fixed\distribution\windows-desktop\payload\PocketMind Hybrid AI_1.0.0_x64-setup.exe",
  [string]$Repo = "noumanshakeil/noumanshakeil.github.io",
  [string]$Tag = "windows-1.0.0",
  [string]$Title = "PocketMind Hybrid AI 1.0.0 Windows (fat installer)",
  [string]$AssetName = "PocketMind-Hybrid-AI_1.0.0_x64-setup.exe"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $SetupExe)) {
  throw "Setup EXE not found: $SetupExe"
}

$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) {
  throw "GitHub CLI (gh) not found. Install from https://cli.github.com/ then run: gh auth login"
}

$sizeMb = [math]::Round((Get-Item -LiteralPath $SetupExe).Length / 1MB, 1)
Write-Host "Publishing $sizeMb MB -> PUBLIC repo $Repo release $Tag" -ForegroundColor Cyan
Write-Host "  Source: $SetupExe"
Write-Host "  (Private nexus-ai-deep-fixed is NOT used for hosting.)"

$notes = @"
Self-contained Windows NSIS installer for **PocketMind Hybrid AI** (CPU + CUDA + Vulkan runtimes embedded).

- Site: https://noumanshakeil.github.io/
- Silent install: ``/S``
- Architecture: x64

Microsoft Store Package URL:
https://github.com/$Repo/releases/download/$Tag/$AssetName
"@

$existing = & gh release view $Tag --repo $Repo 2>$null
if ($LASTEXITCODE -ne 0) {
  & gh release create $Tag --repo $Repo --title $Title --notes $notes
  if ($LASTEXITCODE -ne 0) { throw "gh release create failed (need push access to $Repo)" }
} else {
  Write-Host "Release $Tag already exists; uploading/replacing asset..."
}

$staging = Join-Path $env:TEMP $AssetName
Copy-Item -LiteralPath $SetupExe -Destination $staging -Force
try {
  & gh release upload $Tag $staging --repo $Repo --clobber
  if ($LASTEXITCODE -ne 0) { throw "gh release upload failed" }
} finally {
  Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue
}

$url = "https://github.com/$Repo/releases/download/$Tag/$AssetName"
Write-Host ""
Write-Host "Store Package URL (paste into Partner Center):" -ForegroundColor Green
Write-Host $url
Write-Host "Install switch: /S"
Write-Host "Architecture: x64"
Write-Host ""
Write-Host "Next: refresh the Pages site HTML so the download button points here:"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\distribution\github-pages\PUBLISH-SITE-ONLY.ps1"
