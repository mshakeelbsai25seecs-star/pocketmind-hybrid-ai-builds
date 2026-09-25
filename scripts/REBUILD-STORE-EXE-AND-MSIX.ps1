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

  Use -MsixOnly when the Store-safe EXE/release tree already exists and you only need
  to strip leftover cuda/vulkan under CARGO_TARGET_DIR and pack MSIX (no cargo rebuild).

  Use -SkipGitFetch when the network cannot reach origin (Recv failure) but local HEAD
  is already the desired commit. Optionally pass -ExpectedSha to require that SHA.

.EXAMPLE
  cd D:\nexus-ai-deep-fixed
  powershell -ExecutionPolicy Bypass -File .\scripts\REBUILD-STORE-EXE-AND-MSIX.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\REBUILD-STORE-EXE-AND-MSIX.ps1 -MsixOnly

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\REBUILD-STORE-EXE-AND-MSIX.ps1 -SkipGitFetch -ExpectedSha dbae23f
#>
[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$DevCacheRoot = "D:\DevCache",
  [switch]$SkipLlamaDownload,
  [switch]$AllowNonDDrive,
  [string]$ExpectedMainPrefix = "dbae23f",
  [string]$ExpectedSha = "",
  [switch]$SkipGitFetch,
  [switch]$MsixOnly
)

$ErrorActionPreference = "Stop"

function Remove-BannedLlamaBackends {
  param(
    [Parameter(Mandatory = $true)][string]$ResourceRoot,
    [string[]]$Banned = @("cuda", "vulkan")
  )
  if (-not (Test-Path -LiteralPath $ResourceRoot)) { return }
  foreach ($name in $Banned) {
    $path = Join-Path $ResourceRoot $name
    if (Test-Path -LiteralPath $path) {
      Write-Host "  Stripping banned Store backend: $path" -ForegroundColor Yellow
      Remove-Item -LiteralPath $path -Recurse -Force
    }
  }
}

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

if ($MsixOnly) {
  Write-Host "PocketMind STORE MSIX-only pack (reuse existing release EXE)" -ForegroundColor Green
} else {
  Write-Host "PocketMind STORE rebuild (EXE + MSIX) from origin/main" -ForegroundColor Green
}
Write-Host "  ProjectRoot: $ProjectRoot"

Write-Host "`n==> Syncing git to origin/main" -ForegroundColor Cyan
$fetchedOk = $false
if ($SkipGitFetch) {
  Write-Host "  Skipping git fetch (-SkipGitFetch). Using local HEAD." -ForegroundColor Yellow
} else {
  git fetch origin main
  if ($LASTEXITCODE -eq 0) {
    $fetchedOk = $true
  } else {
    Write-Host "  WARNING: git fetch origin main failed (network?). Will continue only if local HEAD is acceptable." -ForegroundColor Yellow
  }
}

if ($fetchedOk) {
  git checkout main
  if ($LASTEXITCODE -ne 0) { throw "git checkout main failed" }
  git reset --hard origin/main
  if ($LASTEXITCODE -ne 0) { throw "git reset --hard origin/main failed" }
  git clean -fd --exclude=node_modules --exclude=bin --exclude=src-tauri/resources/llama.cpp --exclude=distribution/windows-desktop/payload --exclude=distribution/windows-desktop/msix/layout --exclude=distribution/windows-desktop/msix/out
} else {
  # Stay on current branch/commit; ensure we are on main when possible.
  $branch = (& git rev-parse --abbrev-ref HEAD 2>$null | Out-String).Trim()
  if ($branch -ne "main") {
    Write-Host "  NOTE: current branch is '$branch' (expected main). Continuing with local HEAD." -ForegroundColor Yellow
  }
}

$head = (& git rev-parse HEAD).Trim()
$headShort = (& git rev-parse --short HEAD).Trim()
Write-Host "  HEAD: $head"
Write-Host "  short: $headShort"

if ($ExpectedSha) {
  $want = $ExpectedSha.Trim().ToLowerInvariant()
  $okSha = ($head.ToLowerInvariant().StartsWith($want)) -or ($headShort.ToLowerInvariant().StartsWith($want))
  if (-not $okSha) {
    throw "HEAD $headShort does not match -ExpectedSha $ExpectedSha. Fetch when online, or check out the correct commit first."
  }
  Write-Host "  OK: HEAD matches -ExpectedSha $ExpectedSha" -ForegroundColor Green
} elseif (-not $fetchedOk) {
  # Offline / skip-fetch without ExpectedSha: accept HEAD if it matches origin/main tip when known, else warn.
  $originTip = ""
  try { $originTip = (& git rev-parse origin/main 2>$null | Out-String).Trim() } catch {}
  if ($originTip -and ($originTip -eq $head)) {
    Write-Host "  OK: local HEAD matches origin/main ($headShort) without fetch." -ForegroundColor Green
  } else {
    Write-Host "  WARNING: rebuild proceeding on local HEAD $headShort without a successful fetch. Pass -ExpectedSha <sha> to enforce." -ForegroundColor Yellow
  }
}

if ($ExpectedMainPrefix -and ($headShort -notlike "$ExpectedMainPrefix*") -and ($head -notlike "$ExpectedMainPrefix*")) {
  Write-Host "  NOTE: HEAD does not start with expected prefix '$ExpectedMainPrefix' (repo may have moved forward -- that is OK if SHA is newer)." -ForegroundColor Yellow
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

$releaseDir = Join-Path $DevCacheRoot "Cargo\target\nexus-ai\release"
$exe = Join-Path $releaseDir "PocketMind Hybrid AI.exe"

if (-not $MsixOnly) {
  Write-Host "`n==> Cleaning stale frontend/output artifacts" -ForegroundColor Cyan
  $toRemove = @(
    (Join-Path $ProjectRoot "dist"),
    (Join-Path $ProjectRoot "distribution\windows-desktop\msix\layout"),
    $exe
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
} else {
  Write-Host "`n==> MSIX-only: reusing existing release EXE (no cargo rebuild)" -ForegroundColor Cyan
  if (-not (Test-Path -LiteralPath $exe)) {
    throw "Missing $exe. Run full REBUILD-STORE-EXE-AND-MSIX.ps1 (without -MsixOnly) first."
  }
  Write-Host "  Found: $exe"
  Write-Host "  time:  $((Get-Item -LiteralPath $exe).LastWriteTime)"
  # Clear prior MSIX layout/out so we pack fresh
  $layoutPath = Join-Path $ProjectRoot "distribution\windows-desktop\msix\layout"
  if (Test-Path -LiteralPath $layoutPath) {
    Remove-Item -LiteralPath $layoutPath -Recurse -Force -ErrorAction SilentlyContinue
  }
  Get-ChildItem -Path (Join-Path $ProjectRoot "distribution\windows-desktop\msix\out") -Filter "*.msix" -ErrorAction SilentlyContinue |
    ForEach-Object {
      Write-Host "  Removing old MSIX: $($_.FullName)"
      Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "`n==> Stripping leftover cuda/vulkan under release + src-tauri resources" -ForegroundColor Cyan
Remove-BannedLlamaBackends -ResourceRoot (Join-Path $ProjectRoot "src-tauri\resources\llama.cpp")
Remove-BannedLlamaBackends -ResourceRoot (Join-Path $releaseDir "resources\llama.cpp")

Write-Host "`n==> Staging + packing MSIX from this same release" -ForegroundColor Cyan
& (Join-Path $ProjectRoot "distribution\windows-desktop\msix\stage-msix-layout.ps1") -ProjectRoot $ProjectRoot -ReleaseDir $releaseDir
if ($LASTEXITCODE -ne 0) { throw "stage-msix-layout.ps1 failed ($LASTEXITCODE)" }
& (Join-Path $ProjectRoot "distribution\windows-desktop\msix\PACK-MSIX.ps1") -ProjectRoot $ProjectRoot
if ($LASTEXITCODE -ne 0) { throw "PACK-MSIX.ps1 failed ($LASTEXITCODE)" }

function Get-Sha256([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

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
