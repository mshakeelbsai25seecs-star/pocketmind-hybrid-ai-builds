# Publish only the small GitHub Pages site files to noumanshakeil.github.io.
# Fat setup.exe is published separately (R2 / Azure / Release).
param(
  [string]$PagesDir = "D:\noumanshakeil.github.io",
  [string]$SiteSource = "D:\nexus-ai-deep-fixed\distribution\github-pages",
  [string]$Repo = "noumanshakeil/noumanshakeil.github.io"
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function Invoke-Git {
  param([Parameter(Mandatory = $true)][string[]]$GitArgs, [switch]$AllowFail)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & git @GitArgs 2>&1 |
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
    throw ("git {0} failed with exit code {1}" -f ($GitArgs -join ' '), $code)
  }
}

Write-Host "PocketMind site publish -> $Repo" -ForegroundColor Green

$files = @("index.html", "privacy.html", "README.md", ".gitignore")
foreach ($name in $files) {
  $p = Join-Path $SiteSource $name
  if (-not (Test-Path -LiteralPath $p)) {
    throw "Missing site source file: $p"
  }
}

if (-not (Test-Path -LiteralPath $PagesDir)) {
  Write-Host "Cloning $Repo ..."
  $parent = Split-Path -Parent $PagesDir
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Invoke-Git -GitArgs @("clone", "https://github.com/$Repo.git", $PagesDir)
}

Set-Location $PagesDir
Invoke-Git -GitArgs @("checkout", "main") -AllowFail
Invoke-Git -GitArgs @("pull", "origin", "main")

foreach ($name in $files) {
  Copy-Item -Force (Join-Path $SiteSource $name) (Join-Path $PagesDir $name)
}

Invoke-Git -GitArgs (@("add", "--") + $files)

$prev = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$porcelain = & git status --porcelain -- @files 2>&1
$ErrorActionPreference = $prev
$pending = @($porcelain | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] -and -not [string]::IsNullOrWhiteSpace([string]$_) })

if ($pending.Count -eq 0) {
  Write-Host "Site files already up to date; nothing to commit." -ForegroundColor Yellow
} else {
  Invoke-Git -GitArgs @("commit", "-m", "Publish PocketMind site pages including privacy policy")
  Invoke-Git -GitArgs @("push", "origin", "main")
  Write-Host "Pushed site update." -ForegroundColor Green
}

Write-Host ""
Write-Host "Site: https://noumanshakeil.github.io/" -ForegroundColor Green
Write-Host "Privacy Policy URL: https://noumanshakeil.github.io/privacy.html" -ForegroundColor Green
