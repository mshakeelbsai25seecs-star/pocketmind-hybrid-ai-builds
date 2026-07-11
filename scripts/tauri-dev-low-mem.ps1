# Low-memory Tauri dev: single rustc job + D: target dir (see src-tauri/.cargo/config.toml).
$ErrorActionPreference = "Stop"
$env:CARGO_BUILD_JOBS = "1"
if (-not $env:CARGO_TARGET_DIR) {
  $env:CARGO_TARGET_DIR = "D:\DevCache\Cargo\target\nexus-ai"
}
$storageTmp = "D:\NexusAI\cache\tmp"
New-Item -ItemType Directory -Force -Path $storageTmp | Out-Null
$env:TEMP = $storageTmp
$env:TMP = $storageTmp
$env:NEXUS_DATA_ROOT = "D:\NexusAI"
Set-Location (Split-Path -Parent $PSScriptRoot)
npm run tauri dev
