#Requires -Version 5.1
<#
.SYNOPSIS
  Preflight checks for PocketMind llama.cpp chat server (package directory only).
#>
param(
  [switch]$SkipGpu
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Fail([string]$msg) {
  Write-Host "PREFLIGHT FAIL: $msg" -ForegroundColor Red
  exit 1
}

function Ok([string]$msg) {
  Write-Host "OK: $msg" -ForegroundColor Green
}

Write-Host "Package root: $Root"

# Docker
try {
  $null = & docker version 2>$null
  if ($LASTEXITCODE -ne 0) { Fail "Docker is not running or not installed. Start Docker Desktop first." }
  Ok "Docker is available"
} catch {
  Fail "Docker is not available: $_"
}

# NVIDIA (optional skip)
if (-not $SkipGpu) {
  try {
    $null = & nvidia-smi -L 2>$null
    if ($LASTEXITCODE -eq 0) { Ok "nvidia-smi detected a GPU" }
    else { Write-Host "WARN: nvidia-smi failed — use CPU compose or fix the driver." -ForegroundColor Yellow }
  } catch {
    Write-Host "WARN: nvidia-smi not found — CUDA profile may fail." -ForegroundColor Yellow
  }
}

# .env
$envPath = Join-Path $Root ".env"
$example = Join-Path $Root ".env.example"
if (-not (Test-Path $envPath)) {
  if (Test-Path $example) {
    Copy-Item $example $envPath
    Write-Host "Created .env from .env.example — set MODEL_PATH before start." -ForegroundColor Yellow
  } else {
    Fail ".env missing and no .env.example"
  }
}

# Parse MODEL_PATH
$modelEnv = "/models/model.gguf"
Get-Content $envPath | ForEach-Object {
  if ($_ -match '^\s*MODEL_PATH\s*=\s*(.+)\s*$') {
    $modelEnv = $Matches[1].Trim().Trim('"').Trim("'")
  }
}

$name = $modelEnv -replace '\\', '/'
if ($name.StartsWith("/models/")) { $name = $name.Substring(8) }
elseif ($name.StartsWith("models/")) { $name = $name.Substring(7) }
elseif ($name.Contains("/")) { $name = $name.Split("/")[-1] }

$modelsDir = Join-Path $Root "models"
$hostFile = Join-Path $modelsDir $name

if (-not (Test-Path $modelsDir)) {
  New-Item -ItemType Directory -Path $modelsDir | Out-Null
}

if (-not (Test-Path $hostFile)) {
  Fail "Model file not found: $hostFile`nFix MODEL_PATH in .env or copy a complete .gguf into models\"
}

$item = Get-Item $hostFile
if ($item.Length -lt 1000000) {
  Fail "Model file too small ($($item.Length) bytes) — incomplete or corrupt: $hostFile"
}

# GGUF magic
$fs = [System.IO.File]::OpenRead($hostFile)
try {
  $buf = New-Object byte[] 4
  [void]$fs.Read($buf, 0, 4)
} finally {
  $fs.Close()
}
$magic = [System.Text.Encoding]::ASCII.GetString($buf)
if ($magic -ne "GGUF") {
  Fail "Not a GGUF file (magic='$magic'): $hostFile"
}

Ok "Model validates: $hostFile ($([math]::Round($item.Length/1MB,1)) MB)"
Write-Host "PREFLIGHT PASS" -ForegroundColor Green
exit 0
