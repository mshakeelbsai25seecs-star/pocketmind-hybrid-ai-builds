# Publish only the small GitHub Pages site files (HTML/README) to noumanshakeil.github.io.
# Does NOT upload the fat setup.exe (that goes through PUBLISH-FAT-TO-GITHUB-RELEASE.ps1).
param(
  [string]$PagesDir = "D:\noumanshakeil.github.io",
  [string]$SiteSource = "D:\nexus-ai-deep-fixed\distribution\github-pages"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PagesDir)) {
  git clone https://github.com/noumanshakeil/noumanshakeil.github.io.git $PagesDir
}

Copy-Item -Force (Join-Path $SiteSource "index.html") (Join-Path $PagesDir "index.html")
Copy-Item -Force (Join-Path $SiteSource "README.md") (Join-Path $PagesDir "README.md")
Copy-Item -Force (Join-Path $SiteSource ".gitignore") (Join-Path $PagesDir ".gitignore")

Set-Location $PagesDir
git add index.html README.md .gitignore
git status
git commit -m "Point PocketMind downloads at public Release assets" 
if ($LASTEXITCODE -ne 0) {
  Write-Host "Nothing to commit (site already up to date)." -ForegroundColor Yellow
} else {
  git push origin main
}

Write-Host ""
Write-Host "Site: https://noumanshakeil.github.io/" -ForegroundColor Green
Write-Host "Store package URL (Release asset on this public repo):" -ForegroundColor Green
Write-Host "https://github.com/noumanshakeil/noumanshakeil.github.io/releases/download/windows-1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe"
