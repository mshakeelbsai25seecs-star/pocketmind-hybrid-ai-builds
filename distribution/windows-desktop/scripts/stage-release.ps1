param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path,
  [string]$OutDir = (Join-Path $PSScriptRoot "..\payload")
)

$ErrorActionPreference = "Stop"
$desktopDir = Join-Path $PSScriptRoot ".."

$releaseCandidates = @()
if ($env:CARGO_TARGET_DIR) { $releaseCandidates += (Join-Path $env:CARGO_TARGET_DIR "release") }
$releaseCandidates += "D:\DevCache\Cargo\target\nexus-ai\release"
$releaseCandidates += (Join-Path $RepoRoot "src-tauri\target\release")
$releaseDir = $releaseCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $releaseDir) {
  Write-Warning "No release directory found. Run npm run tauri build first."
  exit 1
}

Write-Host "Using release dir: $releaseDir"
if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$copied = $false

function Copy-One([string]$Path) {
  if (-not (Test-Path $Path)) { return }
  Copy-Item $Path -Destination $OutDir -Force
  Write-Host "Copied $(Split-Path $Path -Leaf)"
  $script:copied = $true
}

# Only ship installer + main app binary (never build-script junk from deps/)
Copy-One (Join-Path $releaseDir "PocketMind Hybrid AI.exe")

# Prefer any NSIS/MSI under bundle/ (versioned names change with tauri.conf package.version)
$nsis = Join-Path $releaseDir "bundle\nsis"
$msi = Join-Path $releaseDir "bundle\msi"
if (Test-Path $nsis) {
  Get-ChildItem $nsis -Filter "*.exe" -File | ForEach-Object { Copy-One $_.FullName }
}
if (Test-Path $msi) {
  Get-ChildItem $msi -Filter "*.msi" -File | ForEach-Object { Copy-One $_.FullName }
}
Get-ChildItem $releaseDir -Filter "*.exe" -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'PocketMind|nexus' -and $_.Name -notmatch 'build-script' } |
  ForEach-Object { Copy-One $_.FullName }

$llamaSrc = Join-Path $RepoRoot "bin\llama.cpp"
$llamaDst = Join-Path $OutDir "bin\llama.cpp"
if (Test-Path $llamaSrc) {
  New-Item -ItemType Directory -Path $llamaDst -Force | Out-Null
  foreach ($backend in @("cpu", "cuda", "vulkan")) {
    $src = Join-Path $llamaSrc $backend
    if (Test-Path $src) {
      Copy-Item $src -Destination (Join-Path $llamaDst $backend) -Recurse -Force
      Write-Host "Copied bin/llama.cpp/$backend"
      $copied = $true
    }
  }
}

foreach ($doc in @("INSTALL.md", "WHAT_IS_INCLUDED.md", "README.md")) {
  $docSrc = Join-Path $desktopDir $doc
  if (Test-Path $docSrc) {
    Copy-Item $docSrc -Destination (Join-Path $OutDir $doc) -Force
    Write-Host "Copied $doc"
  }
}

$guide = Join-Path $RepoRoot "PRODUCT_GUIDE.md"
if (Test-Path $guide) {
  Copy-Item $guide -Destination (Join-Path $OutDir "PRODUCT_GUIDE.md") -Force
  Write-Host "Copied PRODUCT_GUIDE.md"
}

New-Item -ItemType Directory -Force -Path (Join-Path $OutDir "models\embeddings") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir "models\rerankers") | Out-Null

@"
PocketMind Hybrid AI - Windows (tester)

1. Run the NSIS/MSI installer if present, or open PocketMind Hybrid AI.exe.
2. Add your .gguf models in Settings.
3. Knowledge Chat: pick a folder, Scan, Build Index, then ask in your own words.
4. Full product guide (for operators): PRODUCT_GUIDE.md in the source repo / handoff pack.

If Windows warns: More info -> Run anyway.

Models are not included in this zip.
"@ | Set-Content (Join-Path $OutDir "START_HERE.txt") -Encoding UTF8

if (-not $copied) {
  Write-Warning "No build artifacts found."
  exit 1
}
Write-Host "Done."
