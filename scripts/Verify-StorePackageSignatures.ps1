#Requires -Version 5.1
<#
.SYNOPSIS
  List unsigned / invalidly signed PE files under a path (Store 10.2.9 preflight).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\Verify-StorePackageSignatures.ps1 `
    -Path "D:\DevCache\Cargo\target\nexus-ai\release\bundle\nsis"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Path,
  [switch]$Recurse
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Path)) {
  throw "Path not found: $Path"
}

$extensions = @("*.exe", "*.dll", "*.sys", "*.msi", "*.msix")
$files = @()
foreach ($ext in $extensions) {
  if ($Recurse) {
    $files += Get-ChildItem -LiteralPath $Path -Filter $ext -File -Recurse -ErrorAction SilentlyContinue
  } else {
    $files += Get-ChildItem -LiteralPath $Path -Filter $ext -File -ErrorAction SilentlyContinue
  }
}
$files = $files | Sort-Object FullName -Unique

if (-not $files) {
  Write-Warning "No PE files under $Path"
  exit 1
}

$bad = @()
foreach ($file in $files) {
  $sig = Get-AuthenticodeSignature -FilePath $file.FullName
  $status = $sig.Status.ToString()
  $subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { "(none)" }
  $line = "{0,-12} {1}" -f $status, $file.FullName
  if ($status -eq "Valid") {
    Write-Host $line -ForegroundColor Green
    Write-Host "             $subject" -ForegroundColor DarkGray
  } else {
    Write-Host $line -ForegroundColor Red
    Write-Host "             $subject" -ForegroundColor DarkGray
    $bad += $file.FullName
  }
}

Write-Host ""
if ($bad.Count -eq 0) {
  Write-Host "OK: all $($files.Count) PE file(s) have Valid Authenticode signatures." -ForegroundColor Green
  exit 0
}

Write-Host "FAIL: $($bad.Count) / $($files.Count) PE file(s) are not Validly signed." -ForegroundColor Red
Write-Host "Microsoft Store policy 10.2.9 will reject this package."
exit 1
