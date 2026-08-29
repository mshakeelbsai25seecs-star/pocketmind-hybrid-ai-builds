# Publish only the small GitHub Pages site files to noumanshakeil.github.io.
# Fat setup.exe is published separately via PUBLISH-FAT-TO-GITHUB-RELEASE.ps1.
param(
  [string]$PagesDir = "D:\noumanshakeil.github.io",
  [string]$SiteSource = "D:\nexus-ai-deep-fixed\distribution\github-pages",
  [string]$Repo = "noumanshakeil/noumanshakeil.github.io"
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function Invoke-Git {
  param([Parameter(Mandatory = $true)][string[]]$Args, [switch]$AllowFail)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & git @Args 2>&1 |
    ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) {
        [Console]::Error.WriteLine($_.Exception.Message)
      } else {
        [Console]::Out.WriteLine([string]$_)
      }
    } |
    Out-Null
  $code = [int]$LASTEXITCODE
  $ErrorActionPreference = $prev
  if (-not $AllowFail -and $code -ne 0) {
    throw ("git {0} failed with exit code {1}" -f ($Args -join ' '), $code)
  }
  return $code
}

Write-Host "PocketMind site publish -> $Repo" -ForegroundColor Green

foreach ($name in @("index.html", "README.md", ".gitignore")) {
  $p = Join-Path $SiteSource $name
  if (-not (Test-Path -LiteralPath $p)) {
    throw "Missing site source file: $p`nRun: git checkout origin/cursor/android-studio-setup-7411 -- distribution/github-pages"
  }
}

if (-not (Test-Path -LiteralPath $PagesDir)) {
  Write-Host "Cloning $Repo ..."
  $parent = Split-Path -Parent $PagesDir
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Invoke-Git -Args @("clone", "https://github.com/$Repo.git", $PagesDir) | Out-Null
}

Set-Location $PagesDir
Invoke-Git -Args @("checkout", "main") -AllowFail | Out-Null
Invoke-Git -Args @("pull", "origin", "main") | Out-Null

Copy-Item -Force (Join-Path $SiteSource "index.html") (Join-Path $PagesDir "index.html")
Copy-Item -Force (Join-Path $SiteSource "README.md") (Join-Path $PagesDir "README.md")
Copy-Item -Force (Join-Path $SiteSource ".gitignore") (Join-Path $PagesDir ".gitignore")

Invoke-Git -Args @("add", "--", "index.html", "README.md", ".gitignore") | Out-Null

$prev = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$porcelain = & git status --porcelain -- index.html README.md .gitignore 2>&1
$ErrorActionPreference = $prev
$pending = @($porcelain | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] -and -not [string]::IsNullOrWhiteSpace([string]$_) })

if ($pending.Count -eq 0) {
  Write-Host "Site files already up to date; nothing to commit." -ForegroundColor Yellow
} else {
  Invoke-Git -Args @("commit", "-m", "Point PocketMind downloads at public Release assets") | Out-Null
  Invoke-Git -Args @("push", "origin", "main") | Out-Null
  Write-Host "Pushed site update." -ForegroundColor Green
}

Write-Host ""
Write-Host "Site: https://noumanshakeil.github.io/" -ForegroundColor Green
Write-Host "Store package URL:" -ForegroundColor Green
Write-Host "https://github.com/noumanshakeil/noumanshakeil.github.io/releases/download/windows-1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe"
Write-Host ""
Write-Host "If the download 404s, the Release asset is missing. Re-run:"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\distribution\github-pages\PUBLISH-FAT-TO-GITHUB-RELEASE.ps1"
