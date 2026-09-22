#Requires -Version 5.1
<#
.SYNOPSIS
  Foolproof rebuild: reset to origin/main, build Store-safe EXE, then MSIX from THAT build.

.DESCRIPTION
  Fixes the common "I rebuilt setup.exe but UI is old" failure mode:
  - wrong cwd / old clone
  - dirty or non-main branch
  - stale dist/ + DevCache CARGO_TARGET_DIR reuse without re-embedding web assets

  This script hard-resets to origin/main, prints HEAD, cleans frontend/output artifacts,
  builds Store EXE via BUILD-STORE-INSTALLER.ps1 (which forces a fresh Vite + SHA stamp),
  then stages+packs MSIX from the same release tree, and prints SHA256 of outputs.

.EXAMPLE
  cd D:\nexus-ai-deep-fixed
  powershell -ExecutionPolicy Bypass -File .\scripts\REBUILD-STORE-EXE-AND-MSIX.ps1
#>
[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$DevCacheRoot = "D:\DevCache",
  [switch]$SkipLlamaDownload,
  [switch]$AllowNonDDrive,
  [string]$ExpectedMainPrefix = "dd4221c"
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
  $scriptRepo = Split-Path -Parent $PSScriptRoot
  if (Test-Path -LiteralPath (Join-Path $scriptRepo "package.json")) {
    $ProjectRoot = $scriptRepo
  } else {
    $ProjectRoot = "D:\nexus-ai-deep-fixed"
  }
}

Set-Location -LiteralPath $ProjectRoot
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "package.json"))) {
  throw "package.json not found under $ProjectRoot. Run from the repo (e.g. cd D:\nexus-ai-deep-fixed)."
}

Write-Host "PocketMind STORE rebuild (EXE + MSIX) from origin/main" -ForegroundColor Green
Write-Host "  ProjectRoot: $ProjectRoot"

Write-Host "`n==> Syncing git to origin/main (hard reset)" -ForegroundColor Cyan
git fetch origin main
if ($LASTEXITCODE -ne 0) { throw "git fetch origin main failed" }
git checkout main
if ($LASTEXITCODE -ne 0) { throw "git checkout main failed" }
git reset --hard origin/main
if ($LASTEXITCODE -ne 0) { throw "git reset --hard origin/main failed" }
git clean -fd --exclude=node_modules --exclude=bin --exclude=src-tauri/resources/llama.cpp --exclude=distribution/windows-desktop/payload --exclude=distribution/windows-desktop/msix/layout --exclude=distribution/windows-desktop/msix/out
$head = (& git rev-parse HEAD).Trim()
$headShort = (& git rev-parse --short HEAD).Trim()
Write-Host "  HEAD: $head"
Write-Host "  short: $headShort"

if ($ExpectedMainPrefix -and ($headShort -notlike "$ExpectedMainPrefix*") -and ($head -notlike "$ExpectedMainPrefix*")) {
  Write-Host "  NOTE: HEAD does not start with expected prefix '$ExpectedMainPrefix' (repo may have moved forward -- that is OK if SHA is newer than PR #9)." -ForegroundColor Yellow
}

# Minimum feature commits that must be ancestors of HEAD
$requiredTips = @(
  @{ Name = "UI polish + CUDA progress"; Sha = "3895ec1" },
  @{ Name = "NSIS DLL unlock"; Sha = "dd4221c" },
  @{ Name = "PocketCode approval/Diff scroll"; Sha = "8180e53" }
)
foreach ($tip in $requiredTips) {
  git merge-base --is-ancestor $tip.Sha HEAD
  if ($LASTEXITCODE -ne 0) {
    throw "HEAD does not contain required commit $($tip.Sha) ($($tip.Name)). Fix your remotes/clone."
  }
  Write-Host "  OK ancestor: $($tip.Sha) -- $($tip.Name)"
}

Write-Host "`n==> Cleaning stale frontend/output artifacts" -ForegroundColor Cyan
$toRemove = @(
  (Join-Path $ProjectRoot "dist"),
  (Join-Path $ProjectRoot "distribution\windows-desktop\msix\layout"),
  (Join-Path $DevCacheRoot "Cargo\target\nexus-ai\release\PocketMind Hybrid AI.exe")
)
foreach ($p in $toRemove) {
  if (Test-Path -LiteralPath $p) {
    Write-Host "  Removing $p"
    Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
  }
}
Get-ChildItem -Path (Join-Path $DevCacheRoot "Cargo\target\nexus-ai\release\bundle\nsis") -Filter "*setup.exe" -ErrorAction SilentlyContinue |
  ForEach-Object {
    Write-Host "  Removing $($_.FullName)"
    Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
  }
Get-ChildItem -Path (Join-Path $ProjectRoot "distribution\windows-desktop\payload") -Filter "*setup.exe" -ErrorAction SilentlyContinue |
  ForEach-Object {
    Write-Host "  Removing stale payload setup: $($_.FullName)"
    Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
  }
Get-ChildItem -Path (Join-Path $ProjectRoot "distribution\windows-desktop\msix\out") -Filter "*.msix" -ErrorAction SilentlyContinue |
  ForEach-Object {
    Write-Host "  Removing old MSIX: $($_.FullName)"
    Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
  }

$storeArgs = @{
  ProjectRoot = $ProjectRoot
  DevCacheRoot = $DevCacheRoot
}
if ($SkipLlamaDownload) { $storeArgs.SkipLlamaDownload = $true }
if ($AllowNonDDrive -or $env:GITHUB_ACTIONS -eq "true" -or $env:CI -eq "true") {
  $storeArgs.AllowNonDDrive = $true
}

Write-Host "`n==> Building Store-safe setup.exe (forcing a fresh Vite + SHA stamp)" -ForegroundColor Cyan
& (Join-Path $ProjectRoot "scripts\BUILD-STORE-INSTALLER.ps1") @storeArgs
if ($LASTEXITCODE -ne 0) { throw "BUILD-STORE-INSTALLER.ps1 failed ($LASTEXITCODE)" }

# Confirm dist stamp matches HEAD
$distInfo = Join-Path $ProjectRoot "dist\build-info.json"
if (-not (Test-Path -LiteralPath $distInfo)) {
  throw "Missing $distInfo after build -- build-desktop-windows.ps1 did not stamp the frontend."
}
$info = Get-Content -LiteralPath $distInfo -Raw | ConvertFrom-Json
if ($info.gitSha -ne $head) {
  throw "dist/build-info.json gitSha=$($info.gitSha) does not match HEAD=$head"
}
Write-Host "  Verified dist/build-info.json gitSha == HEAD" -ForegroundColor Green

Write-Host "`n==> Staging + packing MSIX from this same release" -ForegroundColor Cyan
& (Join-Path $ProjectRoot "distribution\windows-desktop\msix\stage-msix-layout.ps1") -ProjectRoot $ProjectRoot
if ($LASTEXITCODE -ne 0) { throw "stage-msix-layout.ps1 failed ($LASTEXITCODE)" }
& (Join-Path $ProjectRoot "distribution\windows-desktop\msix\PACK-MSIX.ps1") -ProjectRoot $ProjectRoot
if ($LASTEXITCODE -ne 0) { throw "PACK-MSIX.ps1 failed ($LASTEXITCODE)" }

function Get-Sha256([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

$exe = Join-Path $DevCacheRoot "Cargo\target\nexus-ai\release\PocketMind Hybrid AI.exe"
$nsisDir = Join-Path $DevCacheRoot "Cargo\target\nexus-ai\release\bundle\nsis"
$setup = Get-ChildItem -LiteralPath $nsisDir -Filter "*setup.exe" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
$msix = Get-ChildItem -Path (Join-Path $ProjectRoot "distribution\windows-desktop\msix\out") -Filter "*.msix" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1

Write-Host "`n========== REBUILD SUMMARY ==========" -ForegroundColor Green
Write-Host "HEAD:        $head"
Write-Host "Confirm UI:  Settings -> Advanced -> Build: $headShort (must match)"
Write-Host ""
if (Test-Path -LiteralPath $exe) {
  Write-Host "EXE:         $exe"
  Write-Host "EXE SHA256:  $(Get-Sha256 $exe)"
  Write-Host "EXE time:    $((Get-Item -LiteralPath $exe).LastWriteTime)"
}
if ($setup) {
  Write-Host "SETUP:       $($setup.FullName)"
  Write-Host "SETUP SHA256:$(Get-Sha256 $setup.FullName)"
  Write-Host "SETUP time:  $($setup.LastWriteTime)"
}
if ($msix) {
  Write-Host "MSIX:        $($msix.FullName)"
  Write-Host "MSIX SHA256: $(Get-Sha256 $msix.FullName)"
  Write-Host "MSIX time:   $($msix.LastWriteTime)"
}
Write-Host "====================================="
Write-Host @"

Install/run ONLY these fresh paths (do not reuse an old payload EXE):
  1) Install: $($setup.FullName)
  2) Or run:  $exe
  3) Store:   $($msix.FullName)

After launch: Settings -> Advanced must show Build: $headShort
"@
