#Requires -Version 5.1
<#
.SYNOPSIS
  Generate sharp MSIX Start-tile Assets locally (fixes Store policy 10.1.1.11).

.DESCRIPTION
  Creates distribution/windows-desktop/msix/Assets/*.png from
  src-tauri/icons/app-icon-master.png (or icon.png), including scale-200/400.
  Also bumps Package.appxmanifest Identity Version to 1.0.3.0 if still on an older tile-fix version.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\distribution\windows-desktop\msix\GENERATE-MSIX-TILE-ASSETS.ps1
#>
[CmdletBinding()]
param(
  [string]$ProjectRoot = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not $ProjectRoot) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
}

$msixRoot = Join-Path $ProjectRoot "distribution\windows-desktop\msix"
$outDir = Join-Path $msixRoot "Assets"
$manifest = Join-Path $msixRoot "Package.appxmanifest"

$srcCandidates = @(
  (Join-Path $ProjectRoot "src-tauri\icons\app-icon-master.png"),
  (Join-Path $ProjectRoot "src-tauri\icons\icon.png"),
  (Join-Path $ProjectRoot "src-tauri\icons\128x128@2x.png")
) | Where-Object { Test-Path -LiteralPath $_ }

if (-not $srcCandidates) {
  throw "No source logo found under src-tauri\icons (need app-icon-master.png or icon.png)."
}
$srcPath = $srcCandidates[0]
Write-Host "Source logo: $srcPath"

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-TilePng {
  param(
    [System.Drawing.Image]$Logo,
    [int]$Width,
    [int]$Height,
    [double]$Fill,
    [string]$OutPath
  )

  $bmp = New-Object System.Drawing.Bitmap $Width, $Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::FromArgb(255, 13, 17, 23))
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

  $maxSide = [int]([Math]::Min($Width, $Height) * $Fill)
  $scale = [Math]::Min($maxSide / [double]$Logo.Width, $maxSide / [double]$Logo.Height)
  $nw = [Math]::Max(1, [int][Math]::Round($Logo.Width * $scale))
  $nh = [Math]::Max(1, [int][Math]::Round($Logo.Height * $scale))
  $x = [int](($Width - $nw) / 2)
  $y = [int](($Height - $nh) / 2)
  $g.DrawImage($Logo, $x, $y, $nw, $nh)
  $g.Dispose()

  $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("  {0} ({1}x{2}) {3:N0} bytes" -f (Split-Path $OutPath -Leaf), $Width, $Height, (Get-Item $OutPath).Length)
}

$logo = [System.Drawing.Image]::FromFile($srcPath)
try {
  $assets = @(
    @{ Name = "StoreLogo.png"; W = 50; H = 50; Fill = 0.90 },
    @{ Name = "Square44x44Logo.png"; W = 44; H = 44; Fill = 0.90 },
    @{ Name = "Square71x71Logo.png"; W = 71; H = 71; Fill = 0.90 },
    @{ Name = "Square150x150Logo.png"; W = 150; H = 150; Fill = 0.90 },
    @{ Name = "Square310x310Logo.png"; W = 310; H = 310; Fill = 0.90 },
    @{ Name = "Wide310x150Logo.png"; W = 310; H = 150; Fill = 0.78 },
    @{ Name = "SplashScreen.png"; W = 620; H = 300; Fill = 0.70 },
    @{ Name = "StoreLogo.scale-200.png"; W = 100; H = 100; Fill = 0.90 },
    @{ Name = "Square44x44Logo.scale-200.png"; W = 88; H = 88; Fill = 0.90 },
    @{ Name = "Square71x71Logo.scale-200.png"; W = 142; H = 142; Fill = 0.90 },
    @{ Name = "Square150x150Logo.scale-200.png"; W = 300; H = 300; Fill = 0.90 },
    @{ Name = "Square310x310Logo.scale-200.png"; W = 620; H = 620; Fill = 0.90 },
    @{ Name = "Wide310x150Logo.scale-200.png"; W = 620; H = 300; Fill = 0.78 },
    @{ Name = "SplashScreen.scale-200.png"; W = 1240; H = 600; Fill = 0.70 },
    @{ Name = "Square44x44Logo.scale-400.png"; W = 176; H = 176; Fill = 0.90 },
    @{ Name = "Square150x150Logo.scale-400.png"; W = 600; H = 600; Fill = 0.90 },
    @{ Name = "Square310x310Logo.scale-400.png"; W = 1240; H = 1240; Fill = 0.90 },
    @{ Name = "StoreLogo.scale-400.png"; W = 200; H = 200; Fill = 0.90 }
  )

  Write-Host "Generating tile Assets into $outDir" -ForegroundColor Green
  foreach ($a in $assets) {
    $out = Join-Path $outDir $a.Name
    New-TilePng -Logo $logo -Width $a.W -Height $a.H -Fill $a.Fill -OutPath $out
  }
}
finally {
  $logo.Dispose()
}

# Mirror base icons into src-tauri/icons so stage fallbacks are also sharp.
$iconsDir = Join-Path $ProjectRoot "src-tauri\icons"
foreach ($name in @(
    "StoreLogo.png",
    "Square44x44Logo.png",
    "Square71x71Logo.png",
    "Square150x150Logo.png",
    "Square310x310Logo.png",
    "Wide310x150Logo.png",
    "SplashScreen.png"
  )) {
  Copy-Item -LiteralPath (Join-Path $outDir $name) -Destination (Join-Path $iconsDir $name) -Force
}

if (Test-Path -LiteralPath $manifest) {
  $text = Get-Content -LiteralPath $manifest -Raw
  if ($text -match 'Version="1\.0\.[012]\.0"') {
    $text = $text -replace 'Version="1\.0\.[012]\.0"', 'Version="1.0.3.0"'
    Set-Content -LiteralPath $manifest -Value $text -Encoding UTF8
    Write-Host "Bumped Package.appxmanifest version to 1.0.3.0" -ForegroundColor Cyan
  } else {
    Write-Host "Manifest version left unchanged (already >= 1.0.3.0 or custom)."
  }
}

$check = Get-Item (Join-Path $outDir "Square150x150Logo.png")
if ($check.Length -lt 2048) {
  throw "Generated Square150x150Logo.png still looks too small ($($check.Length) bytes)."
}

Write-Host ""
Write-Host "Done. Next:" -ForegroundColor Green
Write-Host "  powershell -ExecutionPolicy Bypass -File .\distribution\windows-desktop\msix\stage-msix-layout.ps1"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\distribution\windows-desktop\msix\PACK-MSIX.ps1"
Write-Host "Upload the new 1.0.3.0 .msix (not older 1.0.0.0 / 1.0.1.0 / 1.0.2.0 packages)."
