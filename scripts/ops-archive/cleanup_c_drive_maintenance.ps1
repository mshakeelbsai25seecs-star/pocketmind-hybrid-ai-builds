# Weekly C: maintenance for PocketMind Hybrid AI dev machines.
# Safe to re-run. Closes nothing automatically — stop tauri/cargo first for best results.
param(
  [switch]$Aggressive
)

$ErrorActionPreference = 'SilentlyContinue'

function Get-DirSizeGB([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  $bytes = (Get-ChildItem -LiteralPath $Path -Force -Recurse -File -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum
  if (-not $bytes) { return 0 }
  [math]::Round($bytes / 1GB, 2)
}

function Remove-IfExists([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Host "[skip] $Label"
    return 0
  }
  $before = Get-DirSizeGB $Path
  Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "[cleared] $Label (~${before} GB): $Path"
  return $before
}

Write-Host '=== PocketMind Hybrid AI C: maintenance ===' -ForegroundColor Cyan
$volBefore = Get-Volume -DriveLetter C
$freeBefore = [math]::Round($volBefore.SizeRemaining / 1GB, 2)
Write-Host "C: free before: ${freeBefore} GB"

$freed = 0.0

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$RepoCacheTmp = Join-Path $RepoRoot 'runtime-data\cache\tmp'
$tempRoots = @($env:TEMP, "$env:LOCALAPPDATA\Temp")
if (Test-Path -LiteralPath $RepoCacheTmp) { $tempRoots += $RepoCacheTmp }

# Cursor / VS Code sandbox cargo caches (biggest regrow item when TEMP points to C:)
foreach ($tempRoot in $tempRoots) {
  if (-not $tempRoot) { continue }
  $sandbox = Join-Path $tempRoot 'cursor-sandbox-cache'
  $freed += Remove-IfExists $sandbox 'cursor-sandbox-cache'
}

# Stale temp files (older than 2 days)
$cutoff = (Get-Date).AddDays(-2)
foreach ($tempRoot in $tempRoots) {
  if (-not (Test-Path -LiteralPath $tempRoot)) { continue }
  Get-ChildItem -LiteralPath $tempRoot -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host '[cleared] temp files older than 2 days'

# Cursor trace logs (regrow during agent sessions)
$cursorLogs = Join-Path $env:APPDATA 'Cursor\logs'
if (Test-Path -LiteralPath $cursorLogs) {
  $before = Get-DirSizeGB $cursorLogs
  Get-ChildItem -LiteralPath $cursorLogs -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-3) } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  $after = Get-DirSizeGB $cursorLogs
  Write-Host "[trimmed] Cursor logs (~$([math]::Round($before - $after, 2)) GB)"
}

if ($Aggressive) {
  npm cache clean --force 2>$null
  Write-Host '[cleared] npm cache'

  foreach ($browserCache in @(
    "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Cache",
    "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Code Cache",
    "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Cache",
    "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Code Cache"
  )) {
    $freed += Remove-IfExists $browserCache 'browser cache'
  }
}

$volAfter = Get-Volume -DriveLetter C
$freeAfter = [math]::Round($volAfter.SizeRemaining / 1GB, 2)
Write-Host ''
Write-Host "C: free after:  ${freeAfter} GB" -ForegroundColor Green
Write-Host "Approx reclaimed this run: ~$([math]::Round($freeAfter - $freeBefore, 2)) GB"
