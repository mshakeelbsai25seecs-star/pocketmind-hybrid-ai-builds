#Requires -Version 5.1
<#
.SYNOPSIS
  Start llama.cpp chat server after preflight (always from this package directory).
  Prefer START_SERVER.cmd so ExecutionPolicy does not block this script.
#>
param(
  [ValidateSet("cuda", "cpu")]
  [string]$Mode = "cuda"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

try {
  Get-ChildItem -LiteralPath $Root -Recurse -File -Include *.ps1,*.cmd,*.bat -ErrorAction SilentlyContinue |
    Unblock-File -ErrorAction SilentlyContinue
} catch { }

Write-Host "Working directory: $Root"

if (-not (Test-Path (Join-Path $Root "docker-compose.cuda.yml"))) {
  Write-Host "ERROR: docker-compose.cuda.yml not found. Wrong folder?" -ForegroundColor Red
  Write-Host "cd to the llama-cpp package (or double-click START_SERVER.cmd)." -ForegroundColor Yellow
  exit 1
}

if ($Mode -eq "cpu") {
  & "$Root\preflight.ps1" -SkipGpu
} else {
  & "$Root\preflight.ps1"
}
if ($LASTEXITCODE -ne 0) {
  Write-Host "Refusing to start - fix preflight errors first (or use START_ADMIN.cmd)." -ForegroundColor Red
  exit $LASTEXITCODE
}

# Auto GPU/CPU layer plan (max VRAM first; spill remaining layers to CPU/RAM).
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }
if ($py) {
  Write-Host "Running automatic GPU optimizer..." -ForegroundColor Cyan
  $optArgs = @()
  if ($Mode -eq "cpu") { $optArgs += "--cpu" }
  & $py.Source "$Root\admin\optimize_start.py" @optArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Host "WARN: optimizer failed — continuing with existing .env GPU_LAYERS." -ForegroundColor Yellow
  }
} else {
  Write-Host "WARN: Python not found — skipping auto-optimizer (use START_ADMIN.cmd for full retries)." -ForegroundColor Yellow
}

$compose = if ($Mode -eq "cuda") { "docker-compose.cuda.yml" } else { "docker-compose.cpu.yml" }

Write-Host "Starting docker compose ($Mode)..."
& docker compose --env-file .env -f $compose up -d
if ($LASTEXITCODE -ne 0) {
  Write-Host "docker compose failed." -ForegroundColor Red
  exit $LASTEXITCODE
}

Start-Sleep -Seconds 5
& docker ps --filter "name=nexusai-llama-cpp"
Write-Host ""
Write-Host "Test with: curl.exe http://127.0.0.1:8000/v1/models" -ForegroundColor Cyan
Write-Host "If STATUS shows Restarting, use START_ADMIN.cmd → Start (auto-optimizer retries lower GPU layers)." -ForegroundColor Yellow
Write-Host "(Use curl.exe in PowerShell - plain 'curl' is Invoke-WebRequest.)"
