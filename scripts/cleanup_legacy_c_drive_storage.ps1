# Remove NexusAI data left on C drive after a successful move to D:\NexusAI.
# Default is dry-run (lists only). Pass -ConfirmCleanup to actually delete.
param(
  [string]$TargetRoot = 'D:\NexusAI',
  [string]$LegacyProgramData = "$env:ProgramData\NexusAI",
  [string]$LegacyAppData = "$env:APPDATA\NexusAI",
  [switch]$ConfirmCleanup
)

$ErrorActionPreference = 'Stop'

function Test-TreePresent {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $false }
  return (Get-ChildItem -Path $Path -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1) -ne $null
}

function Get-FolderSizeMb {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return 0 }
  $bytes = (Get-ChildItem -Path $Path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  if (-not $bytes) { return 0 }
  return [math]::Round($bytes / 1MB, 1)
}

function Remove-LegacyTree {
  param([string]$Path, [string]$Label)
  if (-not (Test-Path $Path)) {
    Write-Host "[skip] $Label - not found: $Path" -ForegroundColor DarkGray
    return
  }
  $sizeMb = Get-FolderSizeMb $Path
  if (-not $ConfirmCleanup) {
    Write-Host "[dry-run] Would remove $Label (~${sizeMb} MB): $Path" -ForegroundColor Yellow
    return
  }
  Write-Host "[delete] Removing $Label (~${sizeMb} MB): $Path" -ForegroundColor Red
  Remove-Item -LiteralPath $Path -Recurse -Force
}

Write-Host '=== NexusAI legacy C drive storage cleanup ===' -ForegroundColor Cyan
Write-Host "Target (must exist): $TargetRoot"
if (-not (Test-Path $TargetRoot)) {
  throw 'Target root missing. Run migrate_storage_to_d_drive.ps1 first.'
}

$checks = @(
  @{ Label = 'models'; Legacy = Join-Path $LegacyProgramData 'models'; Target = Join-Path $TargetRoot 'models' },
  @{ Label = 'embeddings'; Legacy = Join-Path $LegacyProgramData 'models\embeddings'; Target = Join-Path $TargetRoot 'models\embeddings' },
  @{ Label = 'indexes'; Legacy = Join-Path $LegacyProgramData 'indexes'; Target = Join-Path $TargetRoot 'indexes' },
  @{ Label = 'company-data'; Legacy = Join-Path $LegacyProgramData 'company-data'; Target = Join-Path $TargetRoot 'company-data' },
  @{ Label = 'hnsw'; Legacy = Join-Path $LegacyAppData 'knowledge_hnsw'; Target = Join-Path $TargetRoot 'knowledge-chat\hnsw' }
)

$blocked = @()
foreach ($item in $checks) {
  if (-not (Test-Path $item.Legacy)) { continue }
  $legacyHasFiles = Test-TreePresent $item.Legacy
  $targetHasFiles = Test-TreePresent $item.Target
  if ($legacyHasFiles -and -not $targetHasFiles) {
    $blocked += "$($item.Label): legacy has files but target is empty ($($item.Target))"
  }
}

$legacyDb = Join-Path $LegacyAppData 'app.db'
$targetDb = Join-Path $TargetRoot 'app-data\app.db'
if ((Test-Path $legacyDb) -and -not (Test-Path $targetDb)) {
  $blocked += "app.db: legacy exists but D drive copy missing ($targetDb)"
}

if ($blocked.Count -gt 0) {
  Write-Host ''
  Write-Host 'Cleanup blocked - copy to D drive first:' -ForegroundColor Red
  $blocked | ForEach-Object { Write-Host "  - $_" }
  exit 1
}

Write-Host ''
if (-not $ConfirmCleanup) {
  Write-Host 'Dry run only. Re-run with -ConfirmCleanup to delete.' -ForegroundColor Yellow
}

foreach ($item in $checks) {
  Remove-LegacyTree -Path $item.Legacy -Label $item.Label
}

if ((Test-Path $legacyDb) -and (Test-Path $targetDb)) {
  $dbFiles = @($legacyDb) + @('-wal', '-shm' | ForEach-Object { "$legacyDb$_" })
  foreach ($file in $dbFiles) {
    if (-not (Test-Path $file)) { continue }
    if (-not $ConfirmCleanup) {
      Write-Host "[dry-run] Would remove app database file: $file" -ForegroundColor Yellow
    } else {
      Write-Host "[delete] Removing app database file: $file" -ForegroundColor Red
      Remove-Item -LiteralPath $file -Force
    }
  }
}

foreach ($root in @($LegacyProgramData, $LegacyAppData)) {
  if (-not (Test-Path $root)) { continue }
  $remaining = Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue
  if ($remaining.Count -eq 0) {
    if (-not $ConfirmCleanup) {
      Write-Host "[dry-run] Would remove empty folder: $root" -ForegroundColor Yellow
    } else {
      Write-Host "[delete] Removing empty folder: $root" -ForegroundColor Red
      Remove-Item -LiteralPath $root -Force
    }
  } elseif (-not $ConfirmCleanup) {
    Write-Host "[keep] $root still has $($remaining.Count) item(s) - not removing root" -ForegroundColor DarkGray
  }
}

Write-Host ''
if ($ConfirmCleanup) {
  Write-Host 'Cleanup complete.' -ForegroundColor Green
} else {
  Write-Host 'No files deleted. Add -ConfirmCleanup after you verify NexusAI works from the D drive.' -ForegroundColor Green
}
