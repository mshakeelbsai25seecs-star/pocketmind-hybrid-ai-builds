# Copy PocketMind Windows installers into this GitHub Pages repo and push.
param(
  [string]$PayloadDir = "D:\nexus-ai-deep-fixed\distribution\windows-desktop\payload",
  [string]$Version = "1.0.0"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot

$dest = Join-Path $RepoRoot ("downloads\" + $Version)
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$setupSrc = Join-Path $PayloadDir ("PocketMind Hybrid AI_" + $Version + "_x64-setup.exe")
$msiSrc   = Join-Path $PayloadDir ("PocketMind Hybrid AI_" + $Version + "_x64_en-US.msi")
$exeSrc   = Join-Path $PayloadDir "PocketMind Hybrid AI.exe"

$setupDst = Join-Path $dest ("PocketMind-Hybrid-AI_" + $Version + "_x64-setup.exe")
$msiDst   = Join-Path $dest ("PocketMind-Hybrid-AI_" + $Version + "_x64_en-US.msi")
$exeDst   = Join-Path $dest "PocketMind-Hybrid-AI.exe"

foreach ($pair in @(
  @{ Src = $setupSrc; Dst = $setupDst },
  @{ Src = $msiSrc;   Dst = $msiDst },
  @{ Src = $exeSrc;   Dst = $exeDst }
)) {
  if (-not (Test-Path -LiteralPath $pair.Src)) {
    throw "Missing source file: $($pair.Src)"
  }
  Write-Host ("Copying {0}" -f (Split-Path $pair.Src -Leaf))
  Copy-Item -LiteralPath $pair.Src -Destination $pair.Dst -Force
}

git add ("downloads/" + $Version) index.html README.md upload-windows-installers.ps1
git status
git commit -m ("Host PocketMind Hybrid AI " + $Version + " Windows installers")
git push -u origin main

Write-Host ""
Write-Host "Store package URL:" -ForegroundColor Green
Write-Host ("https://noumanshakeil.github.io/downloads/{0}/PocketMind-Hybrid-AI_{0}_x64-setup.exe" -f $Version)
