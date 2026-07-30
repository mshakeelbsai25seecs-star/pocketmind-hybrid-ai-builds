<#
.SYNOPSIS
  Build PocketMind tester zips (Windows desktop + Server always;
  macOS/Linux packages are prepared for native stage or include run-scripts).

.OUTPUTS
  dist-zips/PocketMind-Windows-Desktop-Tester.zip
  dist-zips/PocketMind-macOS-Desktop-Tester.zip
  dist-zips/PocketMind-Linux-Desktop-Tester.zip
  dist-zips/PocketMind-Server-Tester.zip
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [switch]$SkipWindowsBuild,
  [switch]$SkipServer
)

$ErrorActionPreference = "Stop"
$OutRoot = Join-Path $RepoRoot "dist-zips"
$StageRoot = Join-Path $OutRoot "_stage"
New-Item -ItemType Directory -Force -Path $OutRoot, $StageRoot | Out-Null

function Write-StartHere([string]$Path, [string]$Body) {
  Set-Content -Path $Path -Value $Body.Trim() -Encoding UTF8
}

function Compress-Dir([string]$SourceDir, [string]$ZipPath) {
  if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
  Compress-Archive -Path (Join-Path $SourceDir "*") -DestinationPath $ZipPath -Force
  Write-Host "Created $ZipPath" -ForegroundColor Green
}

# ---------- Windows desktop ----------
$winStage = Join-Path $StageRoot "windows-desktop"
if (Test-Path $winStage) { Remove-Item $winStage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $winStage | Out-Null

if (-not $SkipWindowsBuild) {
  Write-Host "`n=== Windows: ensure runtimes ===" -ForegroundColor Cyan
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot "scripts\install_llama_cpp_runtimes.ps1")
  Write-Host "`n=== Windows: tauri build (release) ===" -ForegroundColor Cyan
  Push-Location $RepoRoot
  try {
    $env:CARGO_BUILD_JOBS = "1"
    if (Test-Path "D:\") {
      $env:CARGO_TARGET_DIR = "D:\DevCache\Cargo\target\nexus-ai"
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $RepoRoot "dist") | Out-Null
    if (-not (Test-Path (Join-Path $RepoRoot "dist\index.html"))) {
      Set-Content (Join-Path $RepoRoot "dist\index.html") "<!doctype html><title>PocketMind Hybrid AI</title>"
    }
    npm run tauri build
  } finally {
    Pop-Location
  }
}

Write-Host "`n=== Windows: stage ===" -ForegroundColor Cyan
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot "distribution\scripts\sync-llama-cpp-server.ps1")
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot "distribution\windows-desktop\scripts\stage-release.ps1") -RepoRoot $RepoRoot -OutDir (Join-Path $winStage "PocketMind")

Write-StartHere (Join-Path $winStage "START_HERE.txt") @"
PocketMind Hybrid AI — Windows (tester build)

USE THE PORTABLE FOLDER (recommended):
1. Unzip this archive.
2. Open the PocketMind folder (must contain the .exe AND bin\llama.cpp\).
3. Double-click PocketMind Hybrid AI.exe (or the nexus-ai exe).
4. Settings → Deployment: confirm folders (app prefers D:\PocketMind when D: exists).
5. Point Models at your .gguf files (chat, embeddings, reranker).
6. Knowledge Chat → folder → Scan → Build Index → ask in your own words.

Do NOT rely on setup.exe/MSI alone for testers — those installers may not include
bin\llama.cpp. If you install via setup.exe, also copy bin\llama.cpp next to the app.

Models are not included (too large).
If Windows blocks the app: More info → Run anyway (unsigned tester build).
"@

Copy-Item (Join-Path $RepoRoot "distribution\windows-desktop\INSTALL.md") (Join-Path $winStage "INSTALL.md") -Force -ErrorAction SilentlyContinue
Compress-Dir $winStage (Join-Path $OutRoot "PocketMind-Windows-Desktop-Tester.zip")

# ---------- Server ----------
if (-not $SkipServer) {
  Write-Host "`n=== Server package ===" -ForegroundColor Cyan
  $srvStage = Join-Path $StageRoot "server"
  if (Test-Path $srvStage) { Remove-Item $srvStage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $srvStage | Out-Null
  $fullRag = Join-Path $RepoRoot "enterprise-server\full-rag"
  $srvFullRag = Join-Path $srvStage "full-rag"
  Copy-Item $fullRag $srvFullRag -Recurse -Force
  # Drop secrets, build artifacts, and backups — never ship a live .env
  @(
    (Join-Path $srvFullRag ".env"),
    (Join-Path $srvFullRag ".env.bak")
  ) | ForEach-Object { if (Test-Path $_) { Remove-Item $_ -Force } }
  Get-ChildItem $srvFullRag -Recurse -Directory -Filter target -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem $srvFullRag -Recurse -Filter "*.bak" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

  $requiredServer = @(
    "scripts\install.sh",
    "scripts\preflight.sh",
    "scripts\healthgate.sh",
    "scripts\smoke_test.sh",
    "scripts\lib_env.sh",
    "scripts\download_models.sh",
    "docker-compose.yml",
    "docker-compose.gpu.yml",
    "docker-compose.gpu-small.yml",
    "docker-compose.cpu.yml",
    "docs\WSL2_WINDOWS_SERVER.md",
    ".env.example"
  )
  foreach ($rel in $requiredServer) {
    $p = Join-Path $srvFullRag $rel
    if (-not (Test-Path $p)) {
      throw ("Server package incomplete: missing full-rag\" + $rel + " - fix source before packing.")
    }
  }

  Write-StartHere (Join-Path $srvStage "START_HERE.txt") @'
PocketMind Hybrid AI - Server (tester build)

Supported: Linux x86_64 + Docker Compose v2 (NVIDIA GPU or CPU).
Windows Server: use WSL2 Ubuntu - see full-rag/docs/WSL2_WINDOWS_SERVER.md
Not supported here: ARM, macOS Metal, native Windows Docker without WSL.

Requires online access to pull Docker images and Hugging Face GGUFs.
Default data paths: /opt/nexusai/models and /opt/nexusai/data (falls back to ~/nexusai if not writable).

1. Copy this folder to the Linux server (or into WSL).
2. Install Docker Engine + Compose plugin.
   For GPU: NVIDIA driver + NVIDIA Container Toolkit.
3. cd full-rag
4. cp .env.example .env   (optional: change paths)
5. chmod +x scripts/*.sh
6. ./scripts/install.sh
   Flags: --cpu | --gpu | --skip-models | --no-seed
7. ./scripts/smoke_test.sh
8. Put company folders under DATA/collections/NAME/ then:
   ./scripts/index_collection.sh NAME
9. Give testers the gateway URL and Bearer token printed by install.

Desktop apps: Organization Server / Server RAG with that URL + token.
Optional qa-corpus seed is only present in full repo checkouts - not required.

Do not commit or share the token publicly.
'@

  Compress-Dir $srvStage (Join-Path $OutRoot "PocketMind-Server-Tester.zip")
}

# ---------- macOS desktop (structure + scripts; binary staged if present) ----------
Write-Host "`n=== macOS package ===" -ForegroundColor Cyan
$macStage = Join-Path $StageRoot "macos-desktop"
if (Test-Path $macStage) { Remove-Item $macStage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $macStage | Out-Null
$macPayload = Join-Path $macStage "PocketMind"
New-Item -ItemType Directory -Force -Path $macPayload | Out-Null

# Stage if a Mac build already exists in repo (unlikely on Windows)
& bash (Join-Path $RepoRoot "distribution\macos-desktop\scripts\stage-release.sh") 2>$null
$macSrcPayload = Join-Path $RepoRoot "distribution\macos-desktop\payload"
if (Test-Path $macSrcPayload) {
  Copy-Item (Join-Path $macSrcPayload "*") $macPayload -Recurse -Force -ErrorAction SilentlyContinue
}

Copy-Item (Join-Path $RepoRoot "scripts\setup_macos_runtimes.sh") $macPayload -Force
Copy-Item (Join-Path $RepoRoot "scripts\verify_macos_runtimes.sh") $macPayload -Force
Copy-Item (Join-Path $RepoRoot "distribution\macos-desktop\scripts\stage-release.sh") $macPayload -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $RepoRoot "distribution\macos-desktop\INSTALL.md") (Join-Path $macStage "INSTALL.md") -Force -ErrorAction SilentlyContinue

$macAppReady = (@(Get-ChildItem -Path $macPayload -Filter "*.app" -ErrorAction SilentlyContinue).Count -gt 0) -or (@(Get-ChildItem -Path $macPayload -Filter "*.dmg" -ErrorAction SilentlyContinue).Count -gt 0)
if (-not $macAppReady) {
  Write-StartHere (Join-Path $macStage "NOT_READY.txt") @'
This zip is a BUILD HELPER only - it does not contain PocketMind.app.

Build on a Mac from the private repo, then:
  npm run dist:stage:macos
  bash distribution/scripts/pack_macos_tester.sh

Do not give this zip to end users until NOT_READY.txt is gone and PocketMind.app is present.
'@
}

Write-StartHere (Join-Path $macStage "START_HERE.txt") @'
PocketMind Hybrid AI - Mac (tester build)

If you see NOT_READY.txt: this package is not runnable yet. Build on a Mac first.

If you see PocketMind.app (or .dmg) inside the PocketMind folder:
  1. Open the app (right-click -> Open if macOS warns about an unidentified developer).
  2. Add your model files when asked (chat + embeddings + reranker .gguf).
  3. Knowledge Chat -> choose a folder -> Scan -> Build Index -> ask in your own words.

Build on Mac:
  npm run dist:stage:macos
  bash distribution/scripts/pack_macos_tester.sh

Runtime helpers (setup_macos_runtimes.sh) install into THIS folder bin/llama.cpp when run from the zip.

Models are not included.
'@

# Helper for Mac build machine to finalize zip (LF via .NET to avoid CRLF shebang breakage)
$macPackSh = @'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/dist-zips"
STAGE="$OUT/_stage/macos-desktop"
mkdir -p "$STAGE/PocketMind"
bash "$ROOT/distribution/macos-desktop/scripts/stage-release.sh"
cp -R "$ROOT/distribution/macos-desktop/payload/." "$STAGE/PocketMind/" 2>/dev/null || true
cp "$ROOT/scripts/setup_macos_runtimes.sh" "$STAGE/PocketMind/" 2>/dev/null || true
cp "$ROOT/scripts/verify_macos_runtimes.sh" "$STAGE/PocketMind/" 2>/dev/null || true
if ! ls "$STAGE/PocketMind"/*.app >/dev/null 2>&1 && ! ls "$STAGE/PocketMind"/*.dmg >/dev/null 2>&1; then
  echo "ERROR: No .app/.dmg after stage-release. Build the Mac app first." >&2
  exit 1
fi
rm -f "$STAGE/NOT_READY.txt"
cat > "$STAGE/START_HERE.txt" <<'EOF'
PocketMind Hybrid AI — Mac (tester build)

1. Open PocketMind.app (right-click → Open if macOS shows a warning).
2. Add your .gguf models in Settings.
3. Knowledge Chat → folder → Scan → Build Index → ask naturally.

Models are not included in this zip.
EOF
rm -f "$OUT/PocketMind-macOS-Desktop-Tester.zip"
(cd "$STAGE" && zip -r "$OUT/PocketMind-macOS-Desktop-Tester.zip" .)
echo "Wrote $OUT/PocketMind-macOS-Desktop-Tester.zip"
'@
[System.IO.File]::WriteAllText((Join-Path $RepoRoot "distribution\scripts\pack_macos_tester.sh"), ($macPackSh -replace "`r`n","`n"))

Compress-Dir $macStage (Join-Path $OutRoot "PocketMind-macOS-Desktop-Tester.zip")
if (-not $macAppReady) {
  Write-Host "WARNING: macOS zip has no .app - see NOT_READY.txt inside" -ForegroundColor Yellow
}

# ---------- Linux desktop ----------
Write-Host "`n=== Linux package ===" -ForegroundColor Cyan
$linStage = Join-Path $StageRoot "linux-desktop"
if (Test-Path $linStage) { Remove-Item $linStage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $linStage | Out-Null
$linPayload = Join-Path $linStage "PocketMind"
New-Item -ItemType Directory -Force -Path $linPayload | Out-Null

& bash (Join-Path $RepoRoot "distribution\linux-desktop\scripts\stage-release.sh") 2>$null
$linSrcPayload = Join-Path $RepoRoot "distribution\linux-desktop\payload"
if (Test-Path $linSrcPayload) {
  Copy-Item (Join-Path $linSrcPayload "*") $linPayload -Recurse -Force -ErrorAction SilentlyContinue
}

Copy-Item (Join-Path $RepoRoot "scripts\setup_linux_runtimes.sh") $linPayload -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $RepoRoot "scripts\verify_linux_runtimes.sh") $linPayload -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $RepoRoot "distribution\linux-desktop\INSTALL.md") (Join-Path $linStage "INSTALL.md") -Force -ErrorAction SilentlyContinue

$linAppReady = (@(Get-ChildItem -Path $linPayload -Filter "*.AppImage" -ErrorAction SilentlyContinue).Count -gt 0) -or (@(Get-ChildItem -Path $linPayload -Filter "*.deb" -ErrorAction SilentlyContinue).Count -gt 0)
if (-not $linAppReady) {
  Write-StartHere (Join-Path $linStage "NOT_READY.txt") @'
This zip is a BUILD HELPER only - it does not contain an AppImage or .deb.

Build on Linux from the private repo, then:
  npm run dist:stage:linux
  bash distribution/scripts/pack_linux_tester.sh

Do not give this zip to end users until NOT_READY.txt is gone and a binary is present.
'@
}

Write-StartHere (Join-Path $linStage "START_HERE.txt") @'
PocketMind Hybrid AI - Linux (tester build)

If you see NOT_READY.txt: this package is not runnable yet. Build on Linux first.

If you see an AppImage or .deb inside the PocketMind folder:
  1. Install/run it (chmod +x *.AppImage if needed).
  2. Add your .gguf models in Settings.
  3. Knowledge Chat -> folder -> Scan -> Build Index -> ask naturally.

Build on Linux:
  npm run dist:stage:linux
  bash distribution/scripts/pack_linux_tester.sh

Runtime helpers (setup_linux_runtimes.sh) install into THIS folder bin/llama.cpp when run from the zip.

Models are not included.
'@

$linPackSh = @'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/dist-zips"
STAGE="$OUT/_stage/linux-desktop"
mkdir -p "$STAGE/PocketMind"
bash "$ROOT/distribution/linux-desktop/scripts/stage-release.sh"
cp -R "$ROOT/distribution/linux-desktop/payload/." "$STAGE/PocketMind/" 2>/dev/null || true
cp "$ROOT/scripts/setup_linux_runtimes.sh" "$STAGE/PocketMind/" 2>/dev/null || true
cp "$ROOT/scripts/verify_linux_runtimes.sh" "$STAGE/PocketMind/" 2>/dev/null || true
if ! ls "$STAGE/PocketMind"/*.AppImage >/dev/null 2>&1 && ! ls "$STAGE/PocketMind"/*.deb >/dev/null 2>&1; then
  echo "ERROR: No AppImage/.deb after stage-release. Build the Linux app first." >&2
  exit 1
fi
rm -f "$STAGE/NOT_READY.txt"
cat > "$STAGE/START_HERE.txt" <<'EOF'
PocketMind Hybrid AI — Linux (tester build)

1. Run the AppImage or install the .deb.
2. Add your .gguf models in Settings.
3. Knowledge Chat → folder → Scan → Build Index → ask naturally.

Models are not included.
EOF
rm -f "$OUT/PocketMind-Linux-Desktop-Tester.zip"
(cd "$STAGE" && zip -r "$OUT/PocketMind-Linux-Desktop-Tester.zip" .)
echo "Wrote $OUT/PocketMind-Linux-Desktop-Tester.zip"
'@
[System.IO.File]::WriteAllText((Join-Path $RepoRoot "distribution\scripts\pack_linux_tester.sh"), ($linPackSh -replace "`r`n","`n"))

Compress-Dir $linStage (Join-Path $OutRoot "PocketMind-Linux-Desktop-Tester.zip")
if (-not $linAppReady) {
  Write-Host "WARNING: Linux zip has no AppImage/.deb - see NOT_READY.txt inside" -ForegroundColor Yellow
}

Write-Host "`n=== Done ===" -ForegroundColor Cyan
Get-ChildItem $OutRoot -Filter "*.zip" | ForEach-Object { Write-Host "$($_.Name)  $([math]::Round($_.Length/1MB,1)) MB" }
Write-Host "Folder: $OutRoot"
