<#
.SYNOPSIS
  Sync enterprise-server/llama-cpp → dist-server-client/PocketMind-llama-cpp-server

  Keeps the shipped Windows server admin package aligned with source. Run after
  changing admin UI, compose files, optimizer, or import/download helpers.
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
)

$ErrorActionPreference = "Stop"
$src = Join-Path $RepoRoot "enterprise-server\llama-cpp"
$dst = Join-Path $RepoRoot "dist-server-client\PocketMind-llama-cpp-server"

if (-not (Test-Path $src)) {
  throw "Source not found: $src"
}

New-Item -ItemType Directory -Force -Path $dst | Out-Null

$excludeDirs = @("models", ".venv", "__pycache__", ".git")
$excludeFiles = @(".env", ".admin_token", ".optimizer_plan.json")

function Should-Skip([string]$rel) {
  foreach ($d in $excludeDirs) {
    if ($rel -match "(^|[\\/])$([regex]::Escape($d))([\\/]|$)") { return $true }
  }
  $leaf = Split-Path $rel -Leaf
  if ($excludeFiles -contains $leaf) { return $true }
  if ($leaf -like "*.pyc") { return $true }
  return $false
}

Get-ChildItem $src -Recurse -Force | ForEach-Object {
  $rel = $_.FullName.Substring($src.Length).TrimStart("\")
  if (-not $rel) { return }
  if (Should-Skip $rel) { return }
  $target = Join-Path $dst $rel
  if ($_.PSIsContainer) {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
  } else {
    $parent = Split-Path $target -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item $_.FullName -Destination $target -Force
  }
}

# Preserve runtime dirs on destination
foreach ($dir in @("models")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $dst $dir) | Out-Null
}

Write-Host "Synced llama-cpp server package:" -ForegroundColor Green
Write-Host "  $dst"
Write-Host ""
Write-Host "Next on the server machine:"
Write-Host "  1. cd dist-server-client\PocketMind-llama-cpp-server"
Write-Host "  2. .\START_ADMIN.cmd   (admin UI :8090)"
Write-Host "  3. Import or download a GGUF, then Start (auto-optimize)"
