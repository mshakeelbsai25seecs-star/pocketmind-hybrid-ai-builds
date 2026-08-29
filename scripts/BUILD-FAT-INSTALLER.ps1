#Requires -Version 5.1
<#
.SYNOPSIS
  Build a self-contained PocketMind Windows setup.exe with CPU/CUDA/Vulkan embedded.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\BUILD-FAT-INSTALLER.ps1
#>
[CmdletBinding()]
param(
  [string]$ProjectRoot = "D:\nexus-ai-deep-fixed",
  [switch]$SkipLlamaDownload
)

$ErrorActionPreference = "Stop"

# Prefer the script's repo if present.
$scriptRepo = Split-Path -Parent $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $scriptRepo "package.json")) {
  $ProjectRoot = $scriptRepo
}

Set-Location $ProjectRoot
Write-Host "PocketMind fat installer build" -ForegroundColor Green
Write-Host "  Project: $ProjectRoot"

$builder = Join-Path $ProjectRoot "scripts\build-desktop-windows.ps1"
if (-not (Test-Path -LiteralPath $builder)) {
  throw "Missing $builder"
}

Write-Host "`n==> Building (embeds llama.cpp runtimes into NSIS/MSI)..." -ForegroundColor Cyan
if ($SkipLlamaDownload) {
  & $builder -ProjectRoot $ProjectRoot -SkipLlamaRuntimes
} else {
  & $builder -ProjectRoot $ProjectRoot
}
if ($LASTEXITCODE -ne 0) {
  throw "build-desktop-windows.ps1 failed with exit code $LASTEXITCODE"
}

$stage = Join-Path $ProjectRoot "distribution\windows-desktop\scripts\stage-release.ps1"
if (Test-Path -LiteralPath $stage) {
  Write-Host "`n==> Staging payload..." -ForegroundColor Cyan
  & $stage -RepoRoot $ProjectRoot
}

$nsis = "D:\DevCache\Cargo\target\nexus-ai\release\bundle\nsis"
$payload = Join-Path $ProjectRoot "distribution\windows-desktop\payload"
Write-Host "`nDone." -ForegroundColor Green
Write-Host "Look for setup.exe under:"
if (Test-Path -LiteralPath $nsis) {
  Get-ChildItem -LiteralPath $nsis -Filter "*setup.exe" | ForEach-Object { Write-Host ("  " + $_.FullName) }
} else {
  Write-Host "  $nsis  (folder not found yet)"
}
if (Test-Path -LiteralPath $payload) {
  Write-Host "Payload:"
  Get-ChildItem -LiteralPath $payload -Filter "*setup.exe" -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host ("  " + $_.FullName) }
}
Write-Host "`nUse the *-setup.exe as the Microsoft Store Package URL."
