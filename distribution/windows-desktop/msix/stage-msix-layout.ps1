#Requires -Version 5.1
<#
.SYNOPSIS
  Stage a Store-safe (CPU-only) release folder into an MSIX loose layout.

.DESCRIPTION
  Copies the built PocketMind Hybrid AI.exe, WebView2Loader (if present), and
  CPU-only resources into distribution/windows-desktop/msix/layout along with
  Package.appxmanifest and Assets. Does not Authenticode-sign (Store re-signs MSIX).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\distribution\windows-desktop\msix\stage-msix-layout.ps1
#>
[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$ReleaseDir = ""
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
}

$msixRoot = Join-Path $ProjectRoot "distribution\windows-desktop\msix"
$layout = Join-Path $msixRoot "layout"
$assetsSrc = Join-Path $ProjectRoot "src-tauri\icons"
$manifestSrc = Join-Path $msixRoot "Package.appxmanifest"

if (-not $ReleaseDir) {
  $candidates = @(
    $(if ($env:CARGO_TARGET_DIR) { Join-Path $env:CARGO_TARGET_DIR "release" } else { $null }),
    "D:\DevCache\Cargo\target\nexus-ai\release",
    (Join-Path $ProjectRoot "src-tauri\target\release")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  if (-not $candidates) {
    throw "No release dir. Build with scripts\BUILD-STORE-INSTALLER.ps1 first."
  }
  $ReleaseDir = $candidates[0]
}

$mainExe = Join-Path $ReleaseDir "PocketMind Hybrid AI.exe"
if (-not (Test-Path -LiteralPath $mainExe)) {
  throw "Missing $mainExe"
}

$resourceRoot = Join-Path $ProjectRoot "src-tauri\resources\llama.cpp"
foreach ($banned in @("cuda", "vulkan")) {
  if (Test-Path -LiteralPath (Join-Path $resourceRoot $banned)) {
    throw "Refusing to stage MSIX with $banned runtime present. Use Store-safe CPU-only build."
  }
}

Write-Host "Staging MSIX layout" -ForegroundColor Green
Write-Host "  Release: $ReleaseDir"
Write-Host "  Layout:  $layout"

if (Test-Path -LiteralPath $layout) {
  Remove-Item -LiteralPath $layout -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $layout | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $layout "Assets") | Out-Null

Copy-Item -LiteralPath $manifestSrc -Destination (Join-Path $layout "Package.appxmanifest") -Force
Copy-Item -LiteralPath $mainExe -Destination $layout -Force

Get-ChildItem -LiteralPath $ReleaseDir -Filter "*.dll" -File -ErrorAction SilentlyContinue |
  ForEach-Object { Copy-Item $_.FullName -Destination $layout -Force }

# Tauri resource tree expected next to the exe when packaged
$resDst = Join-Path $layout "resources"
New-Item -ItemType Directory -Force -Path $resDst | Out-Null
$resSrc = Join-Path $ProjectRoot "src-tauri\resources"
if (Test-Path -LiteralPath $resSrc) {
  Copy-Item -LiteralPath (Join-Path $resSrc "*") -Destination $resDst -Recurse -Force
}

# Assets from icons (generate Wide/Splash fallbacks from existing art)
$assetMap = @{
  "StoreLogo.png"           = "StoreLogo.png"
  "Square44x44Logo.png"     = "Square44x44Logo.png"
  "Square71x71Logo.png"     = "Square71x71Logo.png"
  "Square150x150Logo.png"   = "Square150x150Logo.png"
  "Square310x310Logo.png"   = "Square310x310Logo.png"
  "icon.png"                = "Wide310x150Logo.png"
  "128x128.png"             = "SplashScreen.png"
}
foreach ($pair in $assetMap.GetEnumerator()) {
  $from = Join-Path $assetsSrc $pair.Key
  $to = Join-Path $layout "Assets\$($pair.Value)"
  if (Test-Path -LiteralPath $from) {
    Copy-Item -LiteralPath $from -Destination $to -Force
  }
}

Write-Host "Done. Next:" -ForegroundColor Green
Write-Host "  1. Edit Publisher CN in $manifestSrc (and re-run this script)"
Write-Host "  2. winapp pack `"$layout`""
Write-Host "  3. Upload .msix in Partner Center (MSIX product type only)"
Write-Host "See: distribution\windows-desktop\msix\README.md"
