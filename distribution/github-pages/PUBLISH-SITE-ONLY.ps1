# Publish only the small GitHub Pages site files (HTML/README) to noumanshakeil.github.io.
# Does NOT upload the fat setup.exe (use PUBLISH-FAT-TO-GITHUB-RELEASE.ps1 for that).
param(
  [string]$PagesDir = "D:\noumanshakeil.github.io",
  [string]$SiteSource = "D:\nexus-ai-deep-fixed\distribution\github-pages"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PagesDir)) {
  git clone https://github.com/noumanshakeil/noumanshakeil.github.io.git $PagesDir
  if ($LASTEXITCODE -ne 0) { throw "git clone failed for noumanshakeil.github.io" }
}

$indexSrc = Join-Path $SiteSource "index.html"
$readmeSrc = Join-Path $SiteSource "README.md"
$gitignoreSrc = Join-Path $SiteSource ".gitignore"
foreach ($p in @($indexSrc, $readmeSrc, $gitignoreSrc)) {
  if (-not (Test-Path -LiteralPath $p)) { throw "Missing site source file: $p" }
}

Set-Location $PagesDir
git pull origin main
Copy-Item -Force $indexSrc (Join-Path $PagesDir "index.html")
Copy-Item -Force $readmeSrc (Join-Path $PagesDir "README.md")
Copy-Item -Force $gitignoreSrc (Join-Path $PagesDir ".gitignore")

git add -- index.html README.md .gitignore
$status = git status --porcelain -- index.html README.md .gitignore
if ([string]::IsNullOrWhiteSpace($status)) {
  Write-Host "Site files already match; nothing to commit." -ForegroundColor Yellow
} else {
  git commit -m "Point PocketMind downloads at public Release assets"
  if ($LASTEXITCODE -ne 0) { throw "git commit failed" }
  git push origin main
  if ($LASTEXITCODE -ne 0) { throw "git push failed" }
  Write-Host "Pushed site update to noumanshakeil.github.io" -ForegroundColor Green
}

Write-Host ""
Write-Host "Site: https://noumanshakeil.github.io/" -ForegroundColor Green
Write-Host "Store package URL:" -ForegroundColor Green
Write-Host "https://github.com/noumanshakeil/noumanshakeil.github.io/releases/download/windows-1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe"
