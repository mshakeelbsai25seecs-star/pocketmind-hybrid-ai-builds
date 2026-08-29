# Publish the fat Windows setup.exe as a GitHub Release asset (up to ~2 GB).
# Use this when the installer is too large for a normal git push to github.io.
#
# Prereqs: GitHub CLI authenticated (`gh auth status`)
#
# Example:
#   powershell -ExecutionPolicy Bypass -File .\distribution\github-pages\PUBLISH-FAT-TO-GITHUB-RELEASE.ps1
param(
  [string]$SetupExe = "D:\nexus-ai-deep-fixed\distribution\windows-desktop\payload\PocketMind Hybrid AI_1.0.0_x64-setup.exe",
  [string]$Repo = "noumanshakeil/nexus-ai-deep-fixed",
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
Write-Host "Publishing $sizeMb MB -> $Repo release $Tag" -ForegroundColor Cyan
Write-Host "  Source: $SetupExe"

$notes = @"
Self-contained Windows NSIS installer (CPU + CUDA + Vulkan llama.cpp runtimes embedded).

Silent install: ``/S``

Microsoft Store Package URL:
https://github.com/$Repo/releases/download/$Tag/$AssetName
"@

$existing = & gh release view $Tag --repo $Repo 2>$null
if ($LASTEXITCODE -ne 0) {
  & gh release create $Tag --repo $Repo --title $Title --notes $notes
  if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }
} else {
  Write-Host "Release $Tag already exists; uploading/replacing asset..."
}

# Upload under a URL-safe name (spaces break Partner Center / browsers).
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
Write-Host "Store Package URL:" -ForegroundColor Green
Write-Host $url
Write-Host "Install switch: /S"
Write-Host "Architecture: x64"
Write-Host ""
Write-Host "Also update Partner Center package size/notes if asked, then smoke-test install."
