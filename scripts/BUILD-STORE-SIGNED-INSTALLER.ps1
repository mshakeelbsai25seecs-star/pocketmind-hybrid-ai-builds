#Requires -Version 5.1
<#
.SYNOPSIS
  Build a Microsoft Store submission package that satisfies policies 10.2.4.2 and 10.2.9.

.DESCRIPTION
  1) Builds the CPU-only Store-safe installer (no CUDA/Vulkan) — policy 10.2.4.2
  2) Authenticode-signs EVERY PE that ships inside the setup.exe — policy 10.2.9

  Order matters: PE files are signed BEFORE they are packed into NSIS, then the
  outer setup.exe is signed. Microsoft scans the installer and the installed
  binaries; signing only the outer EXE is not enough.

  Self-signed certificates are NOT accepted. Use:
    - OV/EV code-signing cert (thumbprint) — works worldwide
    - Azure Artifact Signing / Trusted Signing — org US/CA/EU/UK; individual US/CA only

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\BUILD-STORE-SIGNED-INSTALLER.ps1 `
    -CertificateThumbprint "YOURFULLTHUMBPRINT"

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\BUILD-STORE-SIGNED-INSTALLER.ps1 `
    -TrustedSigningMetadata "D:\secrets\trusted-signing.json"
#>
[CmdletBinding(DefaultParameterSetName = "Thumbprint")]
param(
  [string]$ProjectRoot = "D:\nexus-ai-deep-fixed",

  [Parameter(ParameterSetName = "Thumbprint", Mandatory = $true)]
  [string]$CertificateThumbprint,

  [Parameter(ParameterSetName = "TrustedSigning", Mandatory = $true)]
  [string]$TrustedSigningMetadata,

  [Parameter(ParameterSetName = "TrustedSigning")]
  [string]$TrustedSigningDlib = "",

  [string]$TimestampUrl = "",
  [switch]$SkipLlamaDownload
)

$ErrorActionPreference = "Stop"

$scriptRepo = Split-Path -Parent $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $scriptRepo "package.json")) {
  $ProjectRoot = $scriptRepo
}
Set-Location $ProjectRoot

$signScript = Join-Path $ProjectRoot "scripts\Sign-PeFiles.ps1"
$verifyScript = Join-Path $ProjectRoot "scripts\Verify-StorePackageSignatures.ps1"
$desktopBuilder = Join-Path $ProjectRoot "scripts\build-desktop-windows.ps1"
$tauriConf = Join-Path $ProjectRoot "src-tauri\tauri.conf.json"

foreach ($required in @($signScript, $verifyScript, $desktopBuilder, $tauriConf)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Missing $required" }
}

function Invoke-SignTree([string]$TreePath) {
  if (-not (Test-Path -LiteralPath $TreePath)) {
    Write-Warning "Skip signing (missing): $TreePath"
    return
  }
  $params = @{
    Path               = $TreePath
    Recurse            = $true
    SkipAlreadySigned  = $true
    Description        = "PocketMind Hybrid AI"
  }
  if ($TimestampUrl) { $params.TimestampUrl = $TimestampUrl }
  if ($PSCmdlet.ParameterSetName -eq "TrustedSigning") {
    $params.TrustedSigningMetadata = $TrustedSigningMetadata
    if ($TrustedSigningDlib) { $params.TrustedSigningDlib = $TrustedSigningDlib }
  } else {
    $params.CertificateThumbprint = $CertificateThumbprint
  }
  & $signScript @params
  if ($LASTEXITCODE -ne 0) { throw "Sign-PeFiles failed for $TreePath" }
}

function Invoke-SignFile([string]$FilePath) {
  if (-not (Test-Path -LiteralPath $FilePath)) {
    throw "Expected file missing: $FilePath"
  }
  Invoke-SignTree (Split-Path -Parent $FilePath)
}

function Find-MakeNsis {
  $cmd = Get-Command makensis.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($c in @(
      "${env:ProgramFiles(x86)}\NSIS\makensis.exe",
      "${env:ProgramFiles}\NSIS\makensis.exe",
      "D:\DevCache\NSIS\makensis.exe"
    )) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return $null
}

Write-Host "PocketMind STORE signed installer (10.2.4.2 + 10.2.9)" -ForegroundColor Green
Write-Host "  Project: $ProjectRoot"
Write-Host "  Signer:  $($PSCmdlet.ParameterSetName)"

# ---------------------------------------------------------------------------
# 1) Prepare CPU-only resources (no full build yet)
# ---------------------------------------------------------------------------
Write-Host "`n==> Preparing Store-safe CPU-only runtimes..." -ForegroundColor Cyan
$prepareArgs = @{
  ProjectRoot = $ProjectRoot
  StoreSafe   = $true
  SkipBuild   = $true
}
if ($SkipLlamaDownload) { $prepareArgs.SkipLlamaRuntimes = $true }
& $desktopBuilder @prepareArgs
if ($LASTEXITCODE -ne 0) { throw "Runtime prepare failed" }

$resourceRoot = Join-Path $ProjectRoot "src-tauri\resources\llama.cpp"
foreach ($banned in @("cuda", "vulkan")) {
  $bannedPath = Join-Path $resourceRoot $banned
  if (Test-Path -LiteralPath $bannedPath) {
    throw "Store-safe prepare still has $bannedPath"
  }
}

# ---------------------------------------------------------------------------
# 2) Sign resource PE files BEFORE they are packed into NSIS
# ---------------------------------------------------------------------------
Write-Host "`n==> Signing bundled resource PE files..." -ForegroundColor Cyan
Invoke-SignTree $resourceRoot
$toolingRoot = Join-Path $ProjectRoot "src-tauri\resources\tooling"
if (Test-Path -LiteralPath $toolingRoot) { Invoke-SignTree $toolingRoot }

# ---------------------------------------------------------------------------
# 3) Build with Tauri Authenticode when using a store cert thumbprint
# ---------------------------------------------------------------------------
$tauriOriginal = $null
if ($PSCmdlet.ParameterSetName -eq "Thumbprint") {
  $thumbNormalized = ($CertificateThumbprint -replace "\s", "").ToUpperInvariant()
  Write-Host "`n==> Enabling tauri.conf.json windows.certificateThumbprint for this build..." -ForegroundColor Cyan
  $tauriOriginal = Get-Content -LiteralPath $tauriConf -Raw -Encoding UTF8
  $patched = $tauriOriginal
  if ($patched -match '"certificateThumbprint"\s*:\s*null') {
    $patched = $patched -replace '"certificateThumbprint"\s*:\s*null', ('"certificateThumbprint": "' + $thumbNormalized + '"')
  } elseif ($patched -match '"certificateThumbprint"\s*:\s*"[^"]*"') {
    $patched = $patched -replace '"certificateThumbprint"\s*:\s*"[^"]*"', ('"certificateThumbprint": "' + $thumbNormalized + '"')
  } else {
    throw "Could not locate certificateThumbprint in tauri.conf.json"
  }
  if ($patched -match '"digestAlgorithm"\s*:\s*"[^"]*"') {
    $patched = $patched -replace '"digestAlgorithm"\s*:\s*"[^"]*"', '"digestAlgorithm": "sha256"'
  }
  $ts = if ($TimestampUrl) { $TimestampUrl } else { "http://timestamp.digicert.com" }
  if ($patched -match '"timestampUrl"\s*:\s*"[^"]*"') {
    $patched = $patched -replace '"timestampUrl"\s*:\s*"[^"]*"', ('"timestampUrl": "' + $ts + '"')
  }
  Set-Content -LiteralPath $tauriConf -Value $patched -Encoding UTF8 -NoNewline
}

try {
  Write-Host "`n==> Building Store-safe NSIS package..." -ForegroundColor Cyan
  $buildArgs = @{
    ProjectRoot        = $ProjectRoot
    StoreSafe          = $true
    SkipLlamaRuntimes  = $true   # already prepared + signed above
  }
  & $desktopBuilder @buildArgs
  if ($LASTEXITCODE -ne 0) { throw "build-desktop-windows.ps1 failed" }
}
finally {
  if ($null -ne $tauriOriginal) {
    Write-Host "==> Restoring tauri.conf.json" -ForegroundColor DarkGray
    Set-Content -LiteralPath $tauriConf -Value $tauriOriginal -Encoding UTF8 -NoNewline
  }
}

$releaseCandidates = @(
  $(if ($env:CARGO_TARGET_DIR) { Join-Path $env:CARGO_TARGET_DIR "release" } else { $null }),
  "D:\DevCache\Cargo\target\nexus-ai\release",
  (Join-Path $ProjectRoot "src-tauri\target\release")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
if (-not $releaseCandidates) { throw "No release directory found after build." }
$releaseDir = $releaseCandidates[0]
$mainExe = Join-Path $releaseDir "PocketMind Hybrid AI.exe"
$nsisDir = Join-Path $releaseDir "bundle\nsis"

# ---------------------------------------------------------------------------
# 4) Trusted Signing (or re-sign): sign main exe, then rebuild NSIS if needed
# ---------------------------------------------------------------------------
Write-Host "`n==> Signing main application PE files in release dir..." -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath $mainExe)) {
  throw "Missing main exe: $mainExe"
}

# Sign only PE files sitting directly in release (not deps/) via a 1-file temp
# folder so Sign-PeFiles does not walk the entire target tree.
$releasePe = @(Get-ChildItem -LiteralPath $releaseDir -File |
  Where-Object { $_.Extension -match '\.(exe|dll)$' })
foreach ($pe in $releasePe) {
  $sig = Get-AuthenticodeSignature -FilePath $pe.FullName
  if ($sig.Status -eq "Valid") {
    Write-Host "Already signed: $($pe.Name)" -ForegroundColor DarkGray
    continue
  }
  $one = Join-Path $env:TEMP ("pm-one-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $one | Out-Null
  try {
    $copy = Join-Path $one $pe.Name
    Copy-Item -LiteralPath $pe.FullName -Destination $copy -Force
    if ($PSCmdlet.ParameterSetName -eq "TrustedSigning") {
      & $signScript -Path $one -TrustedSigningMetadata $TrustedSigningMetadata `
        -TrustedSigningDlib $TrustedSigningDlib -Description "PocketMind Hybrid AI"
    } else {
      & $signScript -Path $one -CertificateThumbprint $CertificateThumbprint `
        -Description "PocketMind Hybrid AI"
    }
    if ($LASTEXITCODE -ne 0) { throw "Failed signing $($pe.Name)" }
    Copy-Item -LiteralPath $copy -Destination $pe.FullName -Force
  }
  finally {
    Remove-Item -LiteralPath $one -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# Re-pack NSIS from the now-signed main exe when makensis + generated script exist.
# Tauri thumbprint builds usually already produced a signed setup; Trusted Signing
# always needs a re-pack so the installer embeds the signed exe.
$needsRepack = ($PSCmdlet.ParameterSetName -eq "TrustedSigning")
if (-not $needsRepack) {
  # If setup exists but is unsigned, repack/sign it.
  if (Test-Path -LiteralPath $nsisDir) {
    $setupProbe = Get-ChildItem -LiteralPath $nsisDir -Filter "*setup.exe" -File | Select-Object -First 1
    if ($setupProbe) {
      $s = Get-AuthenticodeSignature -FilePath $setupProbe.FullName
      if ($s.Status -ne "Valid") { $needsRepack = $true }
    }
  }
}

if ($needsRepack) {
  $makensis = Find-MakeNsis
  $nsi = $null
  $nsiRoots = @(
    (Join-Path $releaseDir "nsis"),
    (Join-Path $releaseDir "bundle\nsis"),
    $releaseDir
  )
  foreach ($root in $nsiRoots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $hit = Get-ChildItem -LiteralPath $root -Filter "*.nsi" -File -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($hit) { $nsi = $hit; break }
  }

  if ($makensis -and $nsi) {
    Write-Host "`n==> Re-packing NSIS with signed binaries..." -ForegroundColor Cyan
    Write-Host "  makensis: $makensis"
    Write-Host "  script:   $($nsi.FullName)"
    & $makensis /V2 $nsi.FullName
    if ($LASTEXITCODE -ne 0) { throw "makensis re-pack failed" }
  } else {
    Write-Host "`nWARNING: Could not re-pack NSIS automatically (makensis or .nsi missing)." -ForegroundColor Yellow
    Write-Host "The main exe and resources are signed on disk. For thumbprint mode,"
    Write-Host "re-run this script so Tauri signs during bundle. For Trusted Signing,"
    Write-Host "install NSIS and ensure Tauri left a .nsi under the release folder."
  }
}

# ---------------------------------------------------------------------------
# 5) Sign outer setup.exe
# ---------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $nsisDir)) {
  throw "NSIS output folder missing: $nsisDir"
}
Write-Host "`n==> Signing NSIS setup.exe..." -ForegroundColor Cyan
Invoke-SignTree $nsisDir

$payload = Join-Path $ProjectRoot "distribution\windows-desktop\payload"
if (Test-Path -LiteralPath $payload) {
  Write-Host "`n==> Signing staged payload copies..." -ForegroundColor Cyan
  Invoke-SignTree $payload
}

# ---------------------------------------------------------------------------
# 6) Verify
# ---------------------------------------------------------------------------
Write-Host "`n==> Verifying Authenticode signatures..." -ForegroundColor Cyan
$verifyTargets = @($resourceRoot, $nsisDir)
if (Test-Path -LiteralPath $payload) { $verifyTargets += $payload }
$anyFail = $false
foreach ($t in $verifyTargets) {
  Write-Host "--- $t"
  & $verifyScript -Path $t -Recurse
  if ($LASTEXITCODE -ne 0) { $anyFail = $true }
}
$mainSig = Get-AuthenticodeSignature -FilePath $mainExe
if ($mainSig.Status -ne "Valid") {
  Write-Host "Main exe not Valid: $mainExe ($($mainSig.Status))" -ForegroundColor Red
  $anyFail = $true
}
if ($anyFail) {
  throw "Unsigned PE files remain. Do not upload to Partner Center yet."
}

# ---------------------------------------------------------------------------
# 7) Space-free upload filename
# ---------------------------------------------------------------------------
$storeOut = Join-Path $ProjectRoot "distribution\windows-desktop\store-upload"
New-Item -ItemType Directory -Force -Path $storeOut | Out-Null
$setup = Get-ChildItem -LiteralPath $nsisDir -Filter "*setup.exe" -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $setup) { throw "No *setup.exe under $nsisDir" }

$safeName = "PocketMind-Hybrid-AI_1.0.0_x64-setup.exe"
$dest = Join-Path $storeOut $safeName
Copy-Item -LiteralPath $setup.FullName -Destination $dest -Force

Write-Host "`nDone." -ForegroundColor Green
Write-Host "Signed Store upload file (NO SPACES):"
Write-Host "  $dest"
Write-Host ("  Size: {0:N1} MB" -f ((Get-Item -LiteralPath $dest).Length / 1MB))
Write-Host ""
Write-Host "R2 object key:"
Write-Host "  1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe"
Write-Host "Package URL:"
Write-Host "  https://pub-4d3aca60dcc04c09ae0f1450f6ccf8c5.r2.dev/1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe"
Write-Host ""
Write-Host "See: distribution\windows-desktop\STORE_RESUBMIT_10_2_9.md"
