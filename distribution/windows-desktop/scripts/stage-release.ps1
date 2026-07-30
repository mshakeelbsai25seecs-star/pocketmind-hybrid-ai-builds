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

# Copy co-located llama.cpp Docker admin for Organization Server hosting on Windows.
$llamaSrc = Join-Path $RepoRoot "dist-server-client\PocketMind-llama-cpp-server"
$llamaDst = Join-Path $OutDir "PocketMind-llama-cpp-server"
if (Test-Path $llamaSrc) {
  Copy-Item $llamaSrc $llamaDst -Recurse -Force
  Write-Host "Copied PocketMind-llama-cpp-server (Org Server Docker admin)"
  $copied = $true
} else {
  Write-Warning "Missing dist-server-client\PocketMind-llama-cpp-server - run distribution\scripts\sync-llama-cpp-server.ps1"
}

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

# Sidecar Python helpers for OCR / Document Studio (also bundled via tauri resources when present).
$scriptsSrc = Join-Path $RepoRoot "scripts"
$scriptsDst = Join-Path $OutDir "scripts"
if (Test-Path $scriptsSrc) {
  New-Item -ItemType Directory -Force -Path $scriptsDst | Out-Null
  foreach ($name in @(
    "unlimited_ocr_worker.py",
    "soc_pdf_ocr.py",
    "doc_export_worker.py"
  )) {
    $p = Join-Path $scriptsSrc $name
    if (Test-Path $p) { Copy-Item $p -Destination (Join-Path $scriptsDst $name) -Force }
  }
  $docExport = Join-Path $scriptsSrc "doc_export"
  if (Test-Path $docExport) {
    Copy-Item $docExport -Destination (Join-Path $scriptsDst "doc_export") -Recurse -Force
  }
  Write-Host "Copied scripts/ OCR + Document Studio helpers"
  $copied = $true
}

@"
PocketMind Hybrid AI - Windows (tester)

1. Run the NSIS/MSI installer if present, or open PocketMind Hybrid AI.exe.
2. Setup wizard: engine check, models folder, first chat model, then optional Support models downloads (embeddings / reranker / OCR).
3. Or download those later under Settings -> Deployment (same list). Chat GGUFs stay under Models.
4. Knowledge Chat: pick a folder, Scan, Build Index, then ask in your own words.
5. Org Server admin (if included): PocketMind-llama-cpp-server\START_ADMIN.cmd
6. Full product guide (for operators): PRODUCT_GUIDE.md in the source repo / handoff pack.

If Windows warns: More info -> Run anyway.

Large model weights are not included in this zip - use in-app Download buttons.
"@ | Set-Content (Join-Path $OutDir "START_HERE.txt") -Encoding UTF8

if (-not $copied) {
  Write-Warning "No build artifacts found."
  exit 1
}
Write-Host "Done."
