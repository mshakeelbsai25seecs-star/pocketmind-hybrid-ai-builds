# Remove empty leftover D:\NexusAI after consolidating into runtime-data.
# Run after closing Cursor/app processes that still hold old TEMP files under D:\NexusAI\cache\tmp.
$ErrorActionPreference = 'Continue'
$newTmp = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime-data\cache\tmp'
New-Item -ItemType Directory -Force -Path $newTmp | Out-Null
$env:TEMP = $newTmp
$env:TMP = $newTmp

if (-not (Test-Path 'D:\NexusAI')) {
  Write-Host 'D:\NexusAI already gone.' -ForegroundColor Green
  exit 0
}

Write-Host 'Removing D:\NexusAI ...'
cmd /c 'rd /s /q D:\NexusAI'
if (Test-Path 'D:\NexusAI') {
  Write-Host 'Still locked. Close Cursor/terminals that used the old TEMP, then re-run this script.' -ForegroundColor Yellow
  Get-ChildItem 'D:\NexusAI' -Recurse -Force -ErrorAction SilentlyContinue | Select-Object -First 30 FullName
  exit 1
}

Write-Host 'D:\NexusAI removed.' -ForegroundColor Green
