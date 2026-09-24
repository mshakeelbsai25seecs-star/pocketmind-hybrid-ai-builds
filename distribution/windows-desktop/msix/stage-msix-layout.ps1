#Requires -Version 5.1
<#
.SYNOPSIS
  Stage a Store-safe (CPU-only) release folder into an MSIX loose layout.

.DESCRIPTION
  Copies PocketMind Hybrid AI.exe, DLLs, CPU-only resources, Package.appxmanifest,
  and sharp tile Assets into distribution/windows-desktop/msix/layout.
  Prefers prebuilt Assets under distribution/windows-desktop/msix/Assets
  (required after Store policy 10.1.1.11 tile rejection).

  Leftover cuda/vulkan folders under CARGO_TARGET_DIR release resources (from a
  prior fat build) are stripped before staging. The refuse check still runs so
  any remaining banned backends abort the package.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\distribution\windows-desktop\msix\stage-msix-layout.ps1
#>
[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$ReleaseDir = ""
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
      Write-Host "Stripping banned Store backend from resources: $path" -ForegroundColor Yellow
      Remove-Item -LiteralPath $path -Recurse -Force
    }
  }
}

function Assert-NoBannedLlamaBackends {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [string]$Label = "tree",
    [string[]]$Banned = @("cuda", "vulkan")
  )
  if (-not (Test-Path -LiteralPath $Root)) { return }
  foreach ($name in $Banned) {
    $hits = @(Get-ChildItem -LiteralPath $Root -Directory -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ieq $name })
    if ($hits.Count -gt 0) {
      $listed = ($hits | ForEach-Object { $_.FullName }) -join "; "
      throw "Refusing to stage MSIX with $name under $Label. Still present: $listed. Use Store-safe CPU-only build."
    }
  }
}

if (-not $ProjectRoot) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
}

$msixRoot = Join-Path $ProjectRoot "distribution\windows-desktop\msix"
$layout = Join-Path $msixRoot "layout"
$prebuiltAssets = Join-Path $msixRoot "Assets"
$iconsSrc = Join-Path $ProjectRoot "src-tauri\icons"
$manifestSrc = Join-Path $msixRoot "Package.appxmanifest"

if (-not (Test-Path -LiteralPath $manifestSrc)) {
  throw "Missing $manifestSrc"
}

if (-not $ReleaseDir) {
  # Wrap in @() so a single match stays an array. Otherwise PowerShell unwraps
  # to a string and $candidates[0] is the first character ("D").
  $candidates = @(
    $(if ($env:CARGO_TARGET_DIR) { Join-Path $env:CARGO_TARGET_DIR "release" } else { $null }),
    "D:\DevCache\Cargo\target\nexus-ai\release",
    (Join-Path $ProjectRoot "src-tauri\target\release")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $candidates = @($candidates)
  if ($candidates.Count -eq 0) {
    throw "No release dir. Build with scripts\BUILD-STORE-INSTALLER.ps1 first."
  }
  $ReleaseDir = $candidates[0]
}

$mainExe = Join-Path $ReleaseDir "PocketMind Hybrid AI.exe"
if (-not (Test-Path -LiteralPath $mainExe)) {
  throw "Missing $mainExe"
}

$resourceRoots = @(
  (Join-Path $ProjectRoot "src-tauri\resources\llama.cpp"),
  (Join-Path $ReleaseDir "resources\llama.cpp")
)

# Prior fat builds can leave cuda/vulkan under CARGO_TARGET_DIR release resources
# even after a Store-safe NSIS build. Strip them before the safety refuse check.
foreach ($resourceRoot in $resourceRoots) {
  Remove-BannedLlamaBackends -ResourceRoot $resourceRoot
}

foreach ($resourceRoot in $resourceRoots) {
  Assert-NoBannedLlamaBackends -Root $resourceRoot -Label $resourceRoot
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
Copy-Item -LiteralPath $manifestSrc -Destination (Join-Path $layout "AppxManifest.xml") -Force
Copy-Item -LiteralPath $mainExe -Destination $layout -Force

Get-ChildItem -LiteralPath $ReleaseDir -Filter "*.dll" -File -ErrorAction SilentlyContinue |
  ForEach-Object { Copy-Item $_.FullName -Destination $layout -Force }

$releaseResources = Join-Path $ReleaseDir "resources"
$resDst = Join-Path $layout "resources"
if (Test-Path -LiteralPath $releaseResources) {
  Copy-Item -LiteralPath $releaseResources -Destination $resDst -Recurse -Force
} else {
  $resSrc = Join-Path $ProjectRoot "src-tauri\resources"
  if (Test-Path -LiteralPath $resSrc) {
    New-Item -ItemType Directory -Force -Path $resDst | Out-Null
    Copy-Item -LiteralPath (Join-Path $resSrc "*") -Destination $resDst -Recurse -Force
  }
}

# Prefer sharp prebuilt Store tile assets (fixes 10.1.1.11 blurry tiles).
# Use Get-ChildItem -- Copy-Item -LiteralPath with "*" does not expand wildcards
# (Windows PowerShell 5.1), so the layout Assets folder stayed empty.
if (Test-Path -LiteralPath $prebuiltAssets) {
  $assetFiles = @(Get-ChildItem -LiteralPath $prebuiltAssets -File -ErrorAction Stop)
  if ($assetFiles.Count -eq 0) {
    throw "Prebuilt Assets folder is empty: $prebuiltAssets"
  }
  foreach ($f in $assetFiles) {
    Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $layout "Assets\$($f.Name)") -Force
  }
  Write-Host "Copied $($assetFiles.Count) prebuilt tile Assets from $prebuiltAssets" -ForegroundColor Cyan
} else {
  Write-Warning "Missing $prebuiltAssets - falling back to src-tauri/icons"
  $required = @(
    "StoreLogo.png",
    "Square44x44Logo.png",
    "Square71x71Logo.png",
    "Square150x150Logo.png",
    "Square310x310Logo.png",
    "Wide310x150Logo.png",
    "SplashScreen.png"
  )
  foreach ($name in $required) {
    $from = Join-Path $iconsSrc $name
    if (-not (Test-Path -LiteralPath $from)) {
      throw "Missing tile asset $from"
    }
    # Reject tiny placeholder icons (< 1 KB) that caused 10.1.1.11 failures.
    if ((Get-Item -LiteralPath $from).Length -lt 1024) {
      throw "Tile asset looks like a placeholder (too small): $from"
    }
    Copy-Item -LiteralPath $from -Destination (Join-Path $layout "Assets\$name") -Force
  }
}

$requiredAssets = @(
  "StoreLogo.png",
  "Square44x44Logo.png",
  "Square71x71Logo.png",
  "Square150x150Logo.png",
  "Square310x310Logo.png",
  "Wide310x150Logo.png",
  "SplashScreen.png"
)
foreach ($name in $requiredAssets) {
  $to = Join-Path $layout "Assets\$name"
  if (-not (Test-Path -LiteralPath $to)) {
    throw "Layout missing required tile asset: $to"
  }
  if ((Get-Item -LiteralPath $to).Length -lt 1024 -and $name -ne "StoreLogo.png") {
    throw "Layout tile asset still looks like a placeholder: $to"
  }
}

foreach ($banned in @("cuda", "vulkan")) {
  Get-ChildItem -LiteralPath $layout -Directory -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ieq $banned } |
    ForEach-Object {
      Write-Host "Removing banned runtime folder from layout: $($_.FullName)" -ForegroundColor Yellow
      Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }
}

Assert-NoBannedLlamaBackends -Root $layout -Label "MSIX layout"

Write-Host "Done. Next:" -ForegroundColor Green
Write-Host "  powershell -ExecutionPolicy Bypass -File .\distribution\windows-desktop\msix\PACK-MSIX.ps1"
Write-Host "Then upload the .msix from distribution\windows-desktop\msix\out\"
Write-Host "Version in manifest must be higher than previous Store submission (now 1.0.4.0)."
Write-Host "See: distribution\windows-desktop\msix\README.md"
Write-Host "Certification checklist: distribution\windows-desktop\STORE_RESUBMIT_CERT_FIXES.md"
