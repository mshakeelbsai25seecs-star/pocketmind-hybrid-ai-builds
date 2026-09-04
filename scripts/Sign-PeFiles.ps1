#Requires -Version 5.1
<#
.SYNOPSIS
  Authenticode-sign all PE files (.exe / .dll / .sys / .msi / .msix) under a folder.

.DESCRIPTION
  Microsoft Store policy 10.2.9 requires the installer AND every Portable Executable
  inside it to be signed with SHA-256 (or higher) using a certificate that chains to
  the Microsoft Trusted Root Program. Self-signed certificates are rejected.

  Supported backends:
    - CertificateThumbprint  (cert in CurrentUser/LocalMachine\My — OV/EV PFX imported)
    - TrustedSigningMetadata (Azure Artifact Signing / Trusted Signing JSON + dlib)

.EXAMPLE
  # OV/EV cert already imported into the Windows certificate store:
  powershell -ExecutionPolicy Bypass -File .\scripts\Sign-PeFiles.ps1 `
    -Path "D:\DevCache\Cargo\target\nexus-ai\release" `
    -CertificateThumbprint "ABC123..."

.EXAMPLE
  # Azure Artifact Signing:
  powershell -ExecutionPolicy Bypass -File .\scripts\Sign-PeFiles.ps1 `
    -Path "D:\nexus-ai-deep-fixed\src-tauri\resources\llama.cpp" `
    -TrustedSigningMetadata "D:\secrets\trusted-signing.json" `
    -TrustedSigningDlib "C:\ArtifactSigning\Azure.CodeSigning.Dlib.dll"
#>
[CmdletBinding(DefaultParameterSetName = "Thumbprint")]
param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [Parameter(ParameterSetName = "Thumbprint", Mandatory = $true)]
  [string]$CertificateThumbprint,

  [Parameter(ParameterSetName = "TrustedSigning", Mandatory = $true)]
  [string]$TrustedSigningMetadata,

  [Parameter(ParameterSetName = "TrustedSigning")]
  [string]$TrustedSigningDlib = "",

  [string]$TimestampUrl = "",
  [string]$Description = "PocketMind Hybrid AI",
  [string]$SignToolPath = "",
  [switch]$Recurse,
  [switch]$SkipAlreadySigned
)

$ErrorActionPreference = "Stop"

function Find-SignTool {
  param([string]$Explicit)
  if ($Explicit -and (Test-Path -LiteralPath $Explicit)) { return $Explicit }

  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $kitsRoot = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
  if (Test-Path -LiteralPath $kitsRoot) {
    $candidates = Get-ChildItem -LiteralPath $kitsRoot -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object {
        @(
          (Join-Path $_.FullName "x64\signtool.exe"),
          (Join-Path $_.FullName "x86\signtool.exe")
        )
      } |
      Where-Object { Test-Path -LiteralPath $_ }
    if ($candidates) { return $candidates[0] }
  }

  throw "signtool.exe not found. Install Windows SDK Signing Tools, or pass -SignToolPath."
}

function Find-TrustedSigningDlib {
  param([string]$Explicit)
  if ($Explicit -and (Test-Path -LiteralPath $Explicit)) { return $Explicit }

  $wingetRoots = @(
    "${env:ProgramFiles}\Azure Artifact Signing Client Tools",
    "${env:ProgramFiles(x86)}\Azure Artifact Signing Client Tools",
    "${env:ProgramFiles}\Microsoft Artifact Signing Client Tools",
    "${env:LOCALAPPDATA}\Microsoft\ArtifactSigning"
  )
  foreach ($root in $wingetRoots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $hit = Get-ChildItem -LiteralPath $root -Recurse -Filter "Azure.CodeSigning.Dlib.dll" -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  throw "Azure.CodeSigning.Dlib.dll not found. Install with: winget install -e --id Microsoft.Azure.ArtifactSigningClientTools"
}

if (-not (Test-Path -LiteralPath $Path)) {
  throw "Path not found: $Path"
}

$signTool = Find-SignTool -Explicit $SignToolPath
$useTrusted = $PSCmdlet.ParameterSetName -eq "TrustedSigning"

if ($useTrusted) {
  if (-not (Test-Path -LiteralPath $TrustedSigningMetadata)) {
    throw "Trusted Signing metadata JSON not found: $TrustedSigningMetadata"
  }
  $dlib = Find-TrustedSigningDlib -Explicit $TrustedSigningDlib
  if (-not $TimestampUrl) { $TimestampUrl = "http://timestamp.acs.microsoft.com" }
} else {
  $thumb = ($CertificateThumbprint -replace "\s", "").ToUpperInvariant()
  if ($thumb.Length -lt 40) {
    throw "CertificateThumbprint looks too short. Paste the full SHA1 thumbprint from certmgr."
  }
  $CertificateThumbprint = $thumb
  if (-not $TimestampUrl) { $TimestampUrl = "http://timestamp.digicert.com" }
}

$extensions = @("*.exe", "*.dll", "*.sys", "*.msi", "*.msix", "*.appx")
$files = @()
$pathItem = Get-Item -LiteralPath $Path
if (-not $pathItem.PSIsContainer) {
  $files = @($pathItem)
} else {
  foreach ($ext in $extensions) {
    if ($Recurse) {
      $files += Get-ChildItem -LiteralPath $Path -Filter $ext -File -Recurse -ErrorAction SilentlyContinue
    } else {
      $files += Get-ChildItem -LiteralPath $Path -Filter $ext -File -ErrorAction SilentlyContinue
    }
  }
  $files = $files | Sort-Object FullName -Unique
}

if (-not $files -or $files.Count -eq 0) {
  Write-Warning "No PE files found under $Path"
  return
}

Write-Host "SignTool: $signTool"
Write-Host "Files to consider: $($files.Count)"
Write-Host "Mode: $(if ($useTrusted) { 'Azure Artifact Signing' } else { 'Certificate thumbprint' })"

$signed = 0
$skipped = 0
$failed = @()

foreach ($file in $files) {
  if ($SkipAlreadySigned) {
    $existing = Get-AuthenticodeSignature -FilePath $file.FullName
    if ($existing.Status -eq "Valid") {
      $skipped++
      continue
    }
  }

  Write-Host "Signing $($file.FullName)" -ForegroundColor Cyan
  if ($useTrusted) {
    $args = @(
      "sign", "/v", "/fd", "SHA256",
      "/tr", $TimestampUrl, "/td", "SHA256",
      "/dlib", $dlib,
      "/dmdf", $TrustedSigningMetadata,
      "/d", $Description,
      $file.FullName
    )
  } else {
    $args = @(
      "sign", "/v", "/fd", "SHA256",
      "/tr", $TimestampUrl, "/td", "SHA256",
      "/sha1", $CertificateThumbprint,
      "/d", $Description,
      $file.FullName
    )
  }

  & $signTool @args
  if ($LASTEXITCODE -ne 0) {
    $failed += $file.FullName
    Write-Host "  FAILED (exit $LASTEXITCODE)" -ForegroundColor Red
    continue
  }

  $check = Get-AuthenticodeSignature -FilePath $file.FullName
  if ($check.Status -ne "Valid") {
    $failed += $file.FullName
    Write-Host "  Signature status after sign: $($check.Status) — $($check.StatusMessage)" -ForegroundColor Red
    continue
  }
  $signed++
}

Write-Host "`nSigned: $signed  Skipped(already valid): $skipped  Failed: $($failed.Count)" -ForegroundColor $(if ($failed.Count) { "Yellow" } else { "Green" })
if ($failed.Count) {
  $failed | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  throw "One or more files failed Authenticode signing."
}
