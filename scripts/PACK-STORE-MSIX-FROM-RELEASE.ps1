#Requires -Version 5.1
<#
.SYNOPSIS
  Pack Store MSIX from an existing Store-safe release tree (no cargo rebuild).

.DESCRIPTION
  Strips leftover cuda/vulkan under CARGO_TARGET_DIR release resources and
  src-tauri resources, stages the MSIX layout, then runs MakeAppx.
  Use after REBUILD-STORE-EXE-AND-MSIX.ps1 already produced a good EXE.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\PACK-STORE-MSIX-FROM-RELEASE.ps1
#>
[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$DevCacheRoot = "D:\DevCache",
  [string]$ReleaseDir = ""
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
if (-not $ReleaseDir) {
  $ReleaseDir = Join-Path $DevCacheRoot "Cargo\target\nexus-ai\release"
}

$exe = Join-Path $ReleaseDir "PocketMind Hybrid AI.exe"
if (-not (Test-Path -LiteralPath $exe)) {
  throw "Missing $exe. Build Store-safe EXE first (scripts\BUILD-STORE-INSTALLER.ps1 or full REBUILD)."
}

Write-Host "PocketMind STORE MSIX from existing release (no cargo rebuild)" -ForegroundColor Green
Write-Host "  ProjectRoot: $ProjectRoot"
Write-Host "  ReleaseDir:  $ReleaseDir"
Write-Host "  EXE:         $exe"
Write-Host "  EXE time:    $((Get-Item -LiteralPath $exe).LastWriteTime)"

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

Write-Host "`n==> Stripping leftover cuda/vulkan under resources" -ForegroundColor Cyan
Remove-BannedLlamaBackends -ResourceRoot (Join-Path $ProjectRoot "src-tauri\resources\llama.cpp")
Remove-BannedLlamaBackends -ResourceRoot (Join-Path $ReleaseDir "resources\llama.cpp")

$layoutPath = Join-Path $ProjectRoot "distribution\windows-desktop\msix\layout"
if (Test-Path -LiteralPath $layoutPath) {
  Remove-Item -LiteralPath $layoutPath -Recurse -Force -ErrorAction SilentlyContinue
}
Get-ChildItem -Path (Join-Path $ProjectRoot "distribution\windows-desktop\msix\out") -Filter "*.msix" -ErrorAction SilentlyContinue |
  ForEach-Object {
    Write-Host "  Removing old MSIX: $($_.FullName)"
    Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
  }

Write-Host "`n==> Staging + packing MSIX" -ForegroundColor Cyan
& (Join-Path $ProjectRoot "distribution\windows-desktop\msix\stage-msix-layout.ps1") -ProjectRoot $ProjectRoot -ReleaseDir $ReleaseDir
if ($LASTEXITCODE -ne 0) { throw "stage-msix-layout.ps1 failed ($LASTEXITCODE)" }
& (Join-Path $ProjectRoot "distribution\windows-desktop\msix\PACK-MSIX.ps1") -ProjectRoot $ProjectRoot
if ($LASTEXITCODE -ne 0) { throw "PACK-MSIX.ps1 failed ($LASTEXITCODE)" }

$msix = Get-ChildItem -Path (Join-Path $ProjectRoot "distribution\windows-desktop\msix\out") -Filter "*.msix" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $msix) {
  throw "No .msix produced under distribution\windows-desktop\msix\out"
}

Write-Host "`nDone." -ForegroundColor Green
Write-Host ("  MSIX: " + $msix.FullName)
Write-Host ("  Size: {0:N1} MB" -f ($msix.Length / 1MB))
Write-Host ("  SHA256: " + (Get-FileHash -LiteralPath $msix.FullName -Algorithm SHA256).Hash)
