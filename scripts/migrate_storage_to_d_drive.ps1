# Move PocketMind Hybrid AI heavy storage from C: to D:\nexus-ai-deep-fixed\runtime-data (models, indexes, app DB, HNSW, cache).
# Safe to re-run: only copies files that are missing on D:.
param(
  [string]$TargetRoot = "D:\nexus-ai-deep-fixed\runtime-data",
  [string]$LegacyProgramData = "$env:ProgramData\NexusAI",
  [string]$LegacyAppData = "$env:APPDATA\NexusAI"
)

$ErrorActionPreference = "Stop"

function Copy-TreeIfMissing {
  param([string]$Source, [string]$Destination)
  if (-not (Test-Path $Source)) { return 0 }
  if (-not (Test-Path $Destination)) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  }
  $count = 0
  Get-ChildItem -Path $Source -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($Source.Length).TrimStart('\')
    $destFile = Join-Path $Destination $rel
    $destDir = Split-Path $destFile -Parent
    if (-not (Test-Path $destDir)) {
      New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    }
    if (-not (Test-Path $destFile)) {
      Copy-Item $_.FullName $destFile
      $count++
    }
  }
  return $count
}

Write-Host "=== PocketMind Hybrid AI storage migration to $TargetRoot ===" -ForegroundColor Cyan

$folders = @(
  @{ Name = "models"; Source = Join-Path $LegacyProgramData "models"; Dest = Join-Path $TargetRoot "models" },
  @{ Name = "embeddings"; Source = Join-Path $LegacyProgramData "models\embeddings"; Dest = Join-Path $TargetRoot "models\embeddings" },
  @{ Name = "indexes"; Source = Join-Path $LegacyProgramData "indexes"; Dest = Join-Path $TargetRoot "indexes" },
  @{ Name = "company-data"; Source = Join-Path $LegacyProgramData "company-data"; Dest = Join-Path $TargetRoot "company-data" },
  @{ Name = "knowledge_hnsw"; Source = Join-Path $LegacyAppData "knowledge_hnsw"; Dest = Join-Path $TargetRoot "knowledge-chat\hnsw" },
  @{ Name = "app-database"; Source = $LegacyAppData; Dest = Join-Path $TargetRoot "app-data" }
)

New-Item -ItemType Directory -Force -Path $TargetRoot | Out-Null

foreach ($item in $folders) {
  if ($item.Name -eq "app-database") {
    $db = Join-Path $item.Source "app.db"
    $destDb = Join-Path $item.Dest "app.db"
    if ((Test-Path $db) -and -not (Test-Path $destDb)) {
      New-Item -ItemType Directory -Force -Path $item.Dest | Out-Null
      Copy-Item $db $destDb
      foreach ($sidecar in @("-wal", "-shm")) {
        $srcSide = "$db$sidecar"
        $destSide = "$destDb$sidecar"
        if ((Test-Path $srcSide) -and -not (Test-Path $destSide)) {
          Copy-Item $srcSide $destSide
        }
      }
      Write-Host "Copied app.db -> $destDb"
    }
    continue
  }
  $copied = Copy-TreeIfMissing -Source $item.Source -Destination $item.Dest
  Write-Host ("{0}: copied {1} file(s) -> {2}" -f $item.Name, $copied, $item.Dest)
}

Write-Host ""
Write-Host "Done. Restart PocketMind Hybrid AI - it defaults to $TargetRoot when the D drive is present." -ForegroundColor Green
Write-Host "Optional: set NEXUS_DATA_ROOT=$TargetRoot for a custom location."
