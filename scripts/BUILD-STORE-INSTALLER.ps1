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
  [string]$DevCacheRoot = "D:\DevCache",
  [switch]$SkipLlamaDownload,
  [switch]$AllowNonDDrive
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
try {
  $headNow = (& git -C $ProjectRoot rev-parse HEAD 2>$null | Out-String).Trim()
  if ($headNow) { Write-Host "  Git HEAD: $headNow" }
} catch {}

$builder = Join-Path $ProjectRoot "scripts\build-desktop-windows.ps1"
if (-not (Test-Path -LiteralPath $builder)) {
  throw "Missing $builder"
}

$buildArgs = @{
  ProjectRoot = $ProjectRoot
  DevCacheRoot = $DevCacheRoot
  StoreSafe = $true
}
if ($SkipLlamaDownload) { $buildArgs.SkipLlamaRuntimes = $true }
if ($AllowNonDDrive -or $env:GITHUB_ACTIONS -eq "true" -or $env:CI -eq "true") {
  $buildArgs.AllowNonDDrive = $true
}

Write-Host "`n==> Building Store-safe NSIS setup.exe..." -ForegroundColor Cyan
& $builder @buildArgs
if ($LASTEXITCODE -ne 0) {
  throw "build-desktop-windows.ps1 failed with exit code $LASTEXITCODE"
}

# Strip leftover cuda/vulkan under CARGO_TARGET_DIR release resources (prior fat builds).
$releaseLlama = Join-Path $DevCacheRoot "Cargo\target\nexus-ai\release\resources\llama.cpp"
foreach ($banned in @("cuda", "vulkan")) {
  $path = Join-Path $releaseLlama $banned
  if (Test-Path -LiteralPath $path) {
    Write-Host "Removing leftover $banned from release resources: $path" -ForegroundColor Yellow
    Remove-Item -LiteralPath $path -Recurse -Force
  }
}

# Hard verify: resources must not contain cuda/vulkan before we trust the artifact.
$resourceRoot = Join-Path $ProjectRoot "src-tauri\resources\llama.cpp"
foreach ($banned in @("cuda", "vulkan")) {
  $path = Join-Path $resourceRoot $banned
  if (Test-Path -LiteralPath $path) {
    throw "Store-safe build still has $path - aborting. Re-run prepare with -SkipCuda -SkipVulkan."
  }
  $releasePath = Join-Path $releaseLlama $banned
  if (Test-Path -LiteralPath $releasePath) {
    throw "Store-safe build still has $releasePath - aborting."
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

$nsisCandidates = @(
  (Join-Path $DevCacheRoot "Cargo\target\nexus-ai\release\bundle\nsis"),
  "D:\DevCache\Cargo\target\nexus-ai\release\bundle\nsis"
)
$payload = Join-Path $ProjectRoot "distribution\windows-desktop\payload"
Write-Host "`nDone." -ForegroundColor Green
Write-Host "Store Package setup.exe:"
$foundNsis = $false
foreach ($nsis in $nsisCandidates) {
  if (Test-Path -LiteralPath $nsis) {
    $foundNsis = $true
    Get-ChildItem -LiteralPath $nsis -Filter "*setup.exe" | ForEach-Object {
      Write-Host ("  " + $_.FullName)
      Write-Host ("  Size: {0:N1} MB" -f ($_.Length / 1MB))
    }
  }
}
if (-not $foundNsis) {
  Write-Host "  (NSIS output folder not found yet - MSIX staging uses release exe under CARGO_TARGET_DIR)"
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
