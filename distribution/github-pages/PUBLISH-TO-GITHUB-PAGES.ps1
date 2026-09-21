# One-shot: publish PocketMind Windows installers to noumanshakeil.github.io
param(
  [string]$PayloadDir = "D:\nexus-ai-deep-fixed\distribution\windows-desktop\payload",
  [string]$PagesDir = "D:\noumanshakeil.github.io",
  [string]$SiteSource = "D:\nexus-ai-deep-fixed\distribution\github-pages",
  [string]$Version = "1.0.0"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PayloadDir)) {
  throw "Payload folder not found: $PayloadDir"
}

if (-not (Test-Path -LiteralPath $PagesDir)) {
  git clone https://github.com/noumanshakeil/noumanshakeil.github.io.git $PagesDir
}

# Refresh site files from the product repo copy
New-Item -ItemType Directory -Force -Path (Join-Path $PagesDir "downloads\$Version") | Out-Null
Copy-Item -Force (Join-Path $SiteSource "index.html") (Join-Path $PagesDir "index.html")
Copy-Item -Force (Join-Path $SiteSource "README.md") (Join-Path $PagesDir "README.md")
Copy-Item -Force (Join-Path $SiteSource ".gitignore") (Join-Path $PagesDir ".gitignore")
Copy-Item -Force (Join-Path $SiteSource "upload-windows-installers.ps1") (Join-Path $PagesDir "upload-windows-installers.ps1")

$dest = Join-Path $PagesDir "downloads\$Version"
$setupSrc = Join-Path $PayloadDir ("PocketMind Hybrid AI_" + $Version + "_x64-setup.exe")
$msiSrc   = Join-Path $PayloadDir ("PocketMind Hybrid AI_" + $Version + "_x64_en-US.msi")
$exeSrc   = Join-Path $PayloadDir "PocketMind Hybrid AI.exe"

Copy-Item -LiteralPath $setupSrc -Destination (Join-Path $dest ("PocketMind-Hybrid-AI_" + $Version + "_x64-setup.exe")) -Force
Copy-Item -LiteralPath $msiSrc   -Destination (Join-Path $dest ("PocketMind-Hybrid-AI_" + $Version + "_x64_en-US.msi")) -Force
Copy-Item -LiteralPath $exeSrc   -Destination (Join-Path $dest "PocketMind-Hybrid-AI.exe") -Force

Set-Location $PagesDir
git add -A
git status
git commit -m ("Host PocketMind Hybrid AI " + $Version + " Windows installers")
git branch -M main
git remote remove origin 2>$null
git remote add origin https://github.com/noumanshakeil/noumanshakeil.github.io.git
git push -u origin main

Write-Host ""
Write-Host "Site: https://noumanshakeil.github.io/" -ForegroundColor Green
Write-Host ("Store package URL: https://noumanshakeil.github.io/downloads/{0}/PocketMind-Hybrid-AI_{0}_x64-setup.exe" -f $Version) -ForegroundColor Green
