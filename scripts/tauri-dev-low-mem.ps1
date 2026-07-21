# Low-memory Tauri dev for Windows.
# Sets a sensible CARGO_TARGET_DIR (prefers D:\DevCache when present) and NEXUS_DATA_ROOT.
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$env:CARGO_BUILD_JOBS = "1"

if (-not $env:CARGO_TARGET_DIR) {
  if (Test-Path "D:\") {
    $env:CARGO_TARGET_DIR = "D:\DevCache\Cargo\target\nexus-ai"
  } else {
    $env:CARGO_TARGET_DIR = Join-Path $RepoRoot "src-tauri\target"
  }
}
New-Item -ItemType Directory -Force -Path $env:CARGO_TARGET_DIR | Out-Null

if (-not $env:NEXUS_DATA_ROOT) {
  if (Test-Path "D:\PocketMind") {
    $env:NEXUS_DATA_ROOT = "D:\PocketMind"
  } elseif (Test-Path "D:\NexusAI") {
    # Legacy brand root — keep using until D:\PocketMind exists
    $env:NEXUS_DATA_ROOT = "D:\NexusAI"
  } elseif (Test-Path "D:\") {
    $env:NEXUS_DATA_ROOT = "D:\PocketMind"
    New-Item -ItemType Directory -Force -Path $env:NEXUS_DATA_ROOT | Out-Null
  } else {
    $env:NEXUS_DATA_ROOT = Join-Path $env:LOCALAPPDATA "PocketMind"
    New-Item -ItemType Directory -Force -Path $env:NEXUS_DATA_ROOT | Out-Null
  }
}

$storageTmp = Join-Path $env:NEXUS_DATA_ROOT "cache\tmp"
New-Item -ItemType Directory -Force -Path $storageTmp | Out-Null
$env:TEMP = $storageTmp
$env:TMP = $storageTmp

# Ensure Vite/tauri compile-time distDir exists
$distDir = Join-Path $RepoRoot "dist"
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$distIndex = Join-Path $distDir "index.html"
if (-not (Test-Path $distIndex)) {
  Set-Content -Path $distIndex -Value "<!doctype html><title>PocketMind Hybrid AI</title>" -Encoding UTF8
}

Write-Host "CARGO_TARGET_DIR=$($env:CARGO_TARGET_DIR)" -ForegroundColor DarkGray
Write-Host "NEXUS_DATA_ROOT=$($env:NEXUS_DATA_ROOT)" -ForegroundColor DarkGray
npm run tauri:dev
