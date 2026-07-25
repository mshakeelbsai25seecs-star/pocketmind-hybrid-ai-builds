# Low-memory Tauri dev for Windows.
# Sets CARGO_TARGET_DIR / NEXUS_DATA_ROOT and ensures cargo is on PATH.
# Do NOT use ErrorActionPreference=Stop here: npm/cargo write warnings to stderr,
# and PowerShell would treat those as terminating NativeCommandError.

$ErrorActionPreference = 'Continue'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

# Cursor/sandbox sometimes injects npm_config_devdir (invalid npm key -> noisy warn / PS errors).
Remove-Item Env:npm_config_devdir -ErrorAction SilentlyContinue
Remove-Item Env:NPM_CONFIG_DEVDIR -ErrorAction SilentlyContinue

# Prefer the DevCache rustup install, then user .cargo
$cargoCandidates = @(
  'D:\DevCache\Cargo\bin',
  (Join-Path $env:USERPROFILE '.cargo\bin')
)
foreach ($dir in $cargoCandidates) {
  if ($dir -and (Test-Path (Join-Path $dir 'cargo.exe'))) {
    if ($env:Path -notlike "*${dir}*") {
      $env:Path = "$dir;$env:Path"
    }
  }
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Write-Host 'ERROR: cargo.exe not found. Install Rust (rustup) or add D:\DevCache\Cargo\bin to PATH.' -ForegroundColor Red
  exit 1
}

$env:CARGO_BUILD_JOBS = '1'

if (-not $env:CARGO_TARGET_DIR) {
  if (Test-Path 'D:\') {
    $env:CARGO_TARGET_DIR = 'D:\DevCache\Cargo\target\nexus-ai'
  } else {
    $env:CARGO_TARGET_DIR = Join-Path $RepoRoot 'src-tauri\target'
  }
}
New-Item -ItemType Directory -Force -Path $env:CARGO_TARGET_DIR | Out-Null

if (-not $env:NEXUS_DATA_ROOT) {
  $repoRuntime = Join-Path $RepoRoot 'runtime-data'
  if (Test-Path $repoRuntime) {
    $env:NEXUS_DATA_ROOT = $repoRuntime
  } elseif (Test-Path 'D:\nexus-ai-deep-fixed\runtime-data') {
    $env:NEXUS_DATA_ROOT = 'D:\nexus-ai-deep-fixed\runtime-data'
  } elseif (Test-Path 'D:\NexusAI') {
    $env:NEXUS_DATA_ROOT = 'D:\NexusAI'
  } elseif (Test-Path 'D:\') {
    $env:NEXUS_DATA_ROOT = $repoRuntime
    New-Item -ItemType Directory -Force -Path $env:NEXUS_DATA_ROOT | Out-Null
  } else {
    $env:NEXUS_DATA_ROOT = Join-Path $env:LOCALAPPDATA 'PocketMind'
    New-Item -ItemType Directory -Force -Path $env:NEXUS_DATA_ROOT | Out-Null
  }
}

$storageTmp = Join-Path $env:NEXUS_DATA_ROOT 'cache\tmp'
New-Item -ItemType Directory -Force -Path $storageTmp | Out-Null
$env:TEMP = $storageTmp
$env:TMP = $storageTmp

# Ensure Vite/tauri compile-time distDir exists
$distDir = Join-Path $RepoRoot 'dist'
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$distIndex = Join-Path $distDir 'index.html'
if (-not (Test-Path $distIndex)) {
  Set-Content -Path $distIndex -Value '<!doctype html><title>PocketMind Hybrid AI</title>' -Encoding UTF8
}

$cargoPath = (Get-Command cargo).Source
Write-Host "cargo=$cargoPath" -ForegroundColor DarkGray
Write-Host "CARGO_TARGET_DIR=$($env:CARGO_TARGET_DIR)" -ForegroundColor DarkGray
Write-Host "NEXUS_DATA_ROOT=$($env:NEXUS_DATA_ROOT)" -ForegroundColor DarkGray
Write-Host "Rust warnings in yellow are normal. Wait for the app window after Finished." -ForegroundColor DarkGray

# Invoke npm directly (avoid cmd quoting / NativeCommandError issues).
& npm.cmd run tauri:dev
exit $LASTEXITCODE
