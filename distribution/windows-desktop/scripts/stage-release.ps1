param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path,
  [string]$OutDir = (Join-Path $PSScriptRoot "..\payload")
)

$ErrorActionPreference = "Stop"

$bundleRoot = Join-Path $RepoRoot "src-tauri\target\release\bundle"
$msiDir = Join-Path $bundleRoot "msi"
$nsisDir = Join-Path $bundleRoot "nsis"

Write-Host "Staging Windows desktop release to $OutDir"

if (-not (Test-Path $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

$copied = $false

foreach ($dir in @($nsisDir, $msiDir, (Join-Path $RepoRoot "src-tauri\target\release"))) {
  if (-not (Test-Path $dir)) { continue }
  Get-ChildItem -Path $dir -Filter "*.exe" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName -Destination $OutDir -Force
    Write-Host "Copied $($_.Name)"
    $copied = $true
  }
}

$binSrc = Join-Path $RepoRoot "bin"
$binDst = Join-Path $OutDir "bin"
if (Test-Path $binSrc) {
  if (Test-Path $binDst) { Remove-Item $binDst -Recurse -Force }
  Copy-Item $binSrc -Destination $binDst -Recurse -Force
  Write-Host "Copied bin/ runtimes"
  $copied = $true
}

$modelsDst = Join-Path $OutDir "models"
if (-not (Test-Path $modelsDst)) {
  New-Item -ItemType Directory -Path $modelsDst -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $modelsDst "embeddings") -Force | Out-Null
}

if (-not $copied) {
  Write-Warning "No build artifacts found. Run 'npm run tauri build' first."
  exit 1
}

Write-Host "Done. See WHAT_IS_INCLUDED.md for expected layout."
