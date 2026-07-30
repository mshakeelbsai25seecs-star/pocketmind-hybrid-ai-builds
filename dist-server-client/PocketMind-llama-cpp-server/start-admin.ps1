#Requires -Version 5.1
<#
.SYNOPSIS
  Start the PocketMind llama.cpp host admin UI (port 8090).

  Prefer START_ADMIN.cmd (double-click) so ExecutionPolicy and Mark-of-the-Web
  do not block this script on locked-down Windows machines.
#>
param(
  [string]$HostAddress = "0.0.0.0",
  [int]$Port = 8090
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

# Unblock scripts copied from USB/zip (Zone.Identifier / "not digitally signed")
try {
  Get-ChildItem -LiteralPath $Root -Recurse -File -Include *.ps1,*.cmd,*.bat -ErrorAction SilentlyContinue |
    Unblock-File -ErrorAction SilentlyContinue
} catch { }

$Admin = Join-Path $Root "admin"
if (-not (Test-Path (Join-Path $Admin "app.py"))) {
  Write-Host "ERROR: admin\app.py not found under $Root" -ForegroundColor Red
  Write-Host "You must run this from the llama-cpp package folder (e.g. C:\PocketMindServer\llama-cpp)." -ForegroundColor Yellow
  Write-Host "Tip: double-click START_ADMIN.cmd in that folder." -ForegroundColor Yellow
  exit 1
}
Set-Location $Admin

$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }
if (-not $py) {
  Write-Host "Python 3 is required. Install from https://www.python.org/downloads/ (check Add to PATH) and re-run." -ForegroundColor Red
  exit 1
}

$venv = Join-Path $Admin ".venv"
if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) {
  Write-Host "Creating venv..."
  & $py.Source -m venv $venv
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$venvPy = Join-Path $venv "Scripts\python.exe"
$venvPip = Join-Path $venv "Scripts\pip.exe"

Write-Host "Installing admin requirements (safe to re-run)..."
& $venvPip install -q -r (Join-Path $Admin "requirements.txt")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$models = Join-Path $Root "models"
New-Item -ItemType Directory -Force -Path $models | Out-Null
$envFile = Join-Path $Root ".env"
if (-not (Test-Path $envFile) -and (Test-Path (Join-Path $Root ".env.example"))) {
  Copy-Item (Join-Path $Root ".env.example") $envFile
}

$tokenFile = Join-Path $Root ".admin_token"
if (-not (Test-Path $tokenFile)) {
  $tok = -join ((48..57 + 65..90 + 97..122 | Get-Random -Count 32 | ForEach-Object { [char]$_ }))
  Set-Content -Path $tokenFile -Value $tok -NoNewline -Encoding ascii
}

$token = (Get-Content $tokenFile -Raw -Encoding ascii).Trim()
if ($env:ADMIN_TOKEN) { $token = $env:ADMIN_TOKEN.Trim() }

$env:ADMIN_HOST = $HostAddress
$env:ADMIN_PORT = "$Port"
$env:ADMIN_TOKEN = $token
# Avoid broken ANSI escape spam in older consoles
$env:NO_COLOR = "1"
$env:TERM = "dumb"

Write-Host ""
Write-Host "========================================"
Write-Host " Admin UI:  http://127.0.0.1:$Port/"
Write-Host " LAN URL:   http://<this-pc-ip>:$Port/"
Write-Host " Token:     $token"
Write-Host " Token file: $tokenFile"
Write-Host " Chat API:  http://127.0.0.1:8000/v1  (after Start in the UI)"
Write-Host " Package:   $Root"
Write-Host "========================================"
Write-Host "Leave this window open while using the admin UI."
Write-Host ""

Set-Location $Admin
& $venvPy -m uvicorn app:app --host $HostAddress --port $Port
