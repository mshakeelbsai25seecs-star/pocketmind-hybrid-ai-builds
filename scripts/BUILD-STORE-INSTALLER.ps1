#Requires -Version 5.1
<#
.SYNOPSIS
  Build a Microsoft Store-safe Windows setup.exe (CPU-only llama.cpp, no CUDA/Vulkan).

.DESCRIPTION
  Microsoft Store policy 10.2.4.2 rejects packages that contain non-Microsoft
  drivers / NT services. PocketMind's fat installer embeds NVIDIA CUDA and Vulkan
  user-mode DLLs from llama.cpp; certification repeatedly flags those as
  "drivers that have not been provided by Microsoft."

  Policy exceptions are effectively limited to OEMs / Microsoft partners.
  The reliable fix for a standard publisher account is to ship a Store package
  that does NOT embed CUDA/Vulkan.

  This script builds that package:
  - embeds CPU llama.cpp only
  - excludes cuda/ and vulkan/ from src-tauri/resources/llama.cpp
  - produces NSIS setup.exe for the Store Package URL

  Users who want GPU acceleration install CUDA/Vulkan runtimes after setup via:
    scripts\INSTALL-LLAMA-RUNTIMES.cmd
  or the in-app Runtime Manager.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\BUILD-STORE-INSTALLER.ps1
#>
[CmdletBinding()]
param(
  [string]$ProjectRoot = "D:\nexus-ai-deep-fixed",
  [switch]$SkipLlamaDownload
)

$ErrorActionPreference = "Stop"

$scriptRepo = Split-Path -Parent $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $scriptRepo "package.json")) {
  $ProjectRoot = $scriptRepo
}

Set-Location $ProjectRoot
Write-Host "PocketMind STORE-SAFE installer build (CPU only)" -ForegroundColor Green
Write-Host "  Project: $ProjectRoot"
Write-Host "  Policy:  exclude CUDA/Vulkan DLLs for Microsoft Store 10.2.4.2"

$builder = Join-Path $ProjectRoot "scripts\build-desktop-windows.ps1"
if (-not (Test-Path -LiteralPath $builder)) {
  throw "Missing $builder"
}

Write-Host "`n==> Building Store-safe NSIS setup.exe..." -ForegroundColor Cyan
if ($SkipLlamaDownload) {
  & $builder -ProjectRoot $ProjectRoot -StoreSafe -SkipLlamaRuntimes
} else {
  & $builder -ProjectRoot $ProjectRoot -StoreSafe
}
if ($LASTEXITCODE -ne 0) {
  throw "build-desktop-windows.ps1 failed with exit code $LASTEXITCODE"
}

# Hard verify: resources must not contain cuda/vulkan before we trust the artifact.
$resourceRoot = Join-Path $ProjectRoot "src-tauri\resources\llama.cpp"
foreach ($banned in @("cuda", "vulkan")) {
  $path = Join-Path $resourceRoot $banned
  if (Test-Path -LiteralPath $path) {
    throw "Store-safe build still has $path - aborting. Re-run prepare with -SkipCuda -SkipVulkan."
  }
}
$cpuServer = Join-Path $resourceRoot "cpu\llama-server.exe"
if (-not (Test-Path -LiteralPath $cpuServer)) {
  throw "Store-safe build missing CPU runtime: $cpuServer"
}
Write-Host "Verified: resources contain CPU only (no cuda/, no vulkan/)." -ForegroundColor Green

$stage = Join-Path $ProjectRoot "distribution\windows-desktop\scripts\stage-release.ps1"
if (Test-Path -LiteralPath $stage) {
  Write-Host "`n==> Staging payload..." -ForegroundColor Cyan
  & $stage -RepoRoot $ProjectRoot
}

$nsis = "D:\DevCache\Cargo\target\nexus-ai\release\bundle\nsis"
$payload = Join-Path $ProjectRoot "distribution\windows-desktop\payload"
Write-Host "`nDone." -ForegroundColor Green
Write-Host "Store Package setup.exe:"
if (Test-Path -LiteralPath $nsis) {
  Get-ChildItem -LiteralPath $nsis -Filter "*setup.exe" | ForEach-Object {
    Write-Host ("  " + $_.FullName)
    Write-Host ("  Size: {0:N1} MB" -f ($_.Length / 1MB))
  }
} else {
  Write-Host "  $nsis  (folder not found yet)"
}
if (Test-Path -LiteralPath $payload) {
  Get-ChildItem -LiteralPath $payload -Filter "*setup.exe" -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host ("  Payload: " + $_.FullName) }
}
Write-Host "`nWARNING: This setup.exe is NOT Authenticode-signed." -ForegroundColor Yellow
Write-Host "Microsoft Store policy 10.2.9 rejects unsigned EXE/MSI Package URLs."
Write-Host "Next: run scripts\BUILD-STORE-SIGNED-INSTALLER.ps1 with your code-signing cert,"
Write-Host "upload the hyphenated file from distribution\windows-desktop\store-upload\, then resubmit."
Write-Host "See: distribution\windows-desktop\STORE_RESUBMIT_10_2_9.md"
Write-Host "(CPU-only / 10.2.4.2 notes: STORE_RESUBMIT_10_2_4_2.md)"
