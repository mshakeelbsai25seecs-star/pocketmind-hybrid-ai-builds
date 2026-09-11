#Requires -Version 5.1
<#
.SYNOPSIS
  Pack the staged MSIX layout into an .msix using MakeAppx.exe (Windows SDK).

.DESCRIPTION
  Prefer this when `winapp` / WinApp CLI is not installed.
  Store submissions do NOT need you to sign the .msix — Partner Center re-signs it.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\distribution\windows-desktop\msix\PACK-MSIX.ps1
#>
[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$LayoutDir = "",
  [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
}

$msixRoot = Join-Path $ProjectRoot "distribution\windows-desktop\msix"
if (-not $LayoutDir) {
  $LayoutDir = Join-Path $msixRoot "layout"
}
if (-not (Test-Path -LiteralPath $LayoutDir)) {
  throw "Layout missing: $LayoutDir`nRun stage-msix-layout.ps1 first."
}

# MakeAppx expects AppxManifest.xml in the root of the layout.
$pkgManifest = Join-Path $LayoutDir "Package.appxmanifest"
$appxManifest = Join-Path $LayoutDir "AppxManifest.xml"
if (Test-Path -LiteralPath $pkgManifest) {
  Copy-Item -LiteralPath $pkgManifest -Destination $appxManifest -Force
}
if (-not (Test-Path -LiteralPath $appxManifest)) {
  throw "No AppxManifest.xml / Package.appxmanifest under $LayoutDir"
}

# Hard fail if CUDA/Vulkan slipped into the layout.
foreach ($banned in @("cuda", "vulkan")) {
  $hits = Get-ChildItem -LiteralPath $LayoutDir -Directory -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ieq $banned }
  if ($hits) {
    throw "Store MSIX layout still contains '$banned' folders. Re-run CPU-only stage."
  }
}

function Find-MakeAppx {
  $cmd = Get-Command makeappx.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $roots = @(
    "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
    "${env:ProgramFiles(x86)}\Windows Kits\10\App Certification Kit",
    "${env:ProgramFiles}\Windows Kits\10\bin"
  )
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $hit = Get-ChildItem -LiteralPath $root -Recurse -Filter "makeappx.exe" -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\makeappx\.exe$' -or $_.DirectoryName -match 'App Certification Kit' } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

$makeAppx = Find-MakeAppx
if (-not $makeAppx) {
  Write-Host @"

MakeAppx.exe not found.

Install ONE of:
  A) Windows SDK (Signing tools / MakeAppx):
       winget install -e --id Microsoft.WindowsSDK.10.0.26100 --source winget
     or Visual Studio Installer → Individual components → Windows 10/11 SDK

  B) WinApp CLI:
       winget install -e --id Microsoft.winappcli --source winget
     then:  winapp pack "$LayoutDir"

"@ -ForegroundColor Yellow
  throw "MakeAppx.exe not found."
}

$outDir = Join-Path $msixRoot "out"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
if (-not $OutFile) {
  $OutFile = Join-Path $outDir "PocketMind.PocketMindAI_1.0.0.0_x64.msix"
}

Write-Host "Packing MSIX" -ForegroundColor Green
Write-Host "  MakeAppx: $makeAppx"
Write-Host "  Layout:   $LayoutDir"
Write-Host "  Output:   $OutFile"

if (Test-Path -LiteralPath $OutFile) {
  Remove-Item -LiteralPath $OutFile -Force
}

& $makeAppx pack /d $LayoutDir /p $OutFile /o
if ($LASTEXITCODE -ne 0) {
  throw "MakeAppx failed with exit code $LASTEXITCODE"
}

$item = Get-Item -LiteralPath $OutFile
Write-Host "`nDone." -ForegroundColor Green
Write-Host ("  {0}" -f $item.FullName)
Write-Host ("  Size: {0:N1} MB" -f ($item.Length / 1MB))
Write-Host ""
Write-Host "Upload this .msix in Partner Center → Packages (MSIX product)."
Write-Host "Do NOT Authenticode-sign for Store — Microsoft re-signs MSIX."
Write-Host "Device family: Windows 10/11 Desktop only."
