# Upload fat setup.exe to Azure Blob with a Partner Center-safe direct URL.
#
# Why not GitHub Releases?
#   github.com/.../releases/download/... always returns HTTP 302 to a CDN.
#   Partner Center requires HTTP 200 with NO redirect.
#
# Prereqs:
#   1) Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli
#   2) az login
#   3) A subscription where you can create a storage account (or pass an existing one)
#
# Example (creates/uses storage account + public container, uploads, verifies):
#   powershell -ExecutionPolicy Bypass -File .\distribution\github-pages\PUBLISH-FAT-TO-AZURE-BLOB.ps1
param(
  [string]$SetupExe = "D:\nexus-ai-deep-fixed\distribution\windows-desktop\payload\PocketMind Hybrid AI_1.0.0_x64-setup.exe",
  [string]$AssetName = "PocketMind-Hybrid-AI_1.0.0_x64-setup.exe",
  [string]$Version = "1.0.0",
  [string]$ResourceGroup = "pocketmind-store",
  [string]$Location = "eastus",
  [string]$StorageAccount = "",
  [string]$Container = "releases",
  [string]$Subscription = ""
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Az {
  param([Parameter(Mandatory = $true)][string[]]$AzArgs, [switch]$AllowFail)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & az @AzArgs 2>&1 |
    ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) {
        [Console]::Error.WriteLine($_.ToString())
      } else {
        [Console]::Out.WriteLine([string]$_)
      }
    } |
    Out-Null
  $code = [int]$LASTEXITCODE
  $ErrorActionPreference = $prev
  if (-not $AllowFail -and $code -ne 0) {
    throw ("az {0} failed with exit {1}" -f ($AzArgs -join ' '), $code)
  }
  return $code
}

function Get-AzJson {
  param([Parameter(Mandatory = $true)][string[]]$AzArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $raw = & az @AzArgs 2>&1
  $code = [int]$LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -ne 0) {
    $text = ($raw | ForEach-Object { [string]$_ }) -join "`n"
    throw ("az {0} failed:`n{1}" -f ($AzArgs -join ' '), $text)
  }
  $text = ($raw | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
  return $text
}

function Test-DirectDownload([string]$Url) {
  Write-Step "Verifying Partner Center requirements (HTTP 200, no redirect)"
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $headers = & curl.exe -sI --max-redirs 0 $Url 2>&1
  $ErrorActionPreference = $prev
  $text = ($headers | ForEach-Object { [string]$_ }) -join "`n"
  Write-Host $text

  if ($text -notmatch '(?m)^HTTP/\S+\s+200\b') {
    throw "URL did not return HTTP 200. Partner Center will reject it."
  }
  if ($text -match '(?im)^Location:\s*\S+') {
    throw "URL still redirects (Location header present). Partner Center will reject it."
  }
  Write-Host "OK: direct download (200, no redirect)." -ForegroundColor Green
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw "Azure CLI (az) not found. Install from https://learn.microsoft.com/cli/azure/install-azure-cli then run: az login"
}
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
  throw "curl.exe not found (required for redirect verification)."
}
if (-not (Test-Path -LiteralPath $SetupExe)) {
  throw "Setup EXE not found: $SetupExe"
}

$setupItem = Get-Item -LiteralPath $SetupExe
$sizeMb = [math]::Round($setupItem.Length / 1MB, 1)
Write-Host "PocketMind Store package -> Azure Blob (direct URL)" -ForegroundColor Green
Write-Host ("  Source: {0} ({1} MB)" -f $setupItem.FullName, $sizeMb)

Write-Step "Checking Azure login"
$accountJson = Get-AzJson -AzArgs @("account", "show", "-o", "json")
$account = $accountJson | ConvertFrom-Json
Write-Host ("  Subscription: {0} ({1})" -f $account.name, $account.id)

if (-not [string]::IsNullOrWhiteSpace($Subscription)) {
  Invoke-Az -AzArgs @("account", "set", "--subscription", $Subscription) | Out-Null
}

if ([string]::IsNullOrWhiteSpace($StorageAccount)) {
  # Storage account names: 3-24 chars, lowercase alphanumeric only.
  $suffix = ($account.id -replace '[^a-f0-9]', '').Substring(0, 8)
  $StorageAccount = "pmdstore$suffix"
  Write-Host "  Using storage account name: $StorageAccount"
}

Write-Step "Ensuring resource group '$ResourceGroup'"
Invoke-Az -AzArgs @("group", "create", "--name", $ResourceGroup, "--location", $Location) -AllowFail | Out-Null
Invoke-Az -AzArgs @("group", "show", "--name", $ResourceGroup, "-o", "none") | Out-Null

Write-Step "Ensuring storage account '$StorageAccount' (public blob access allowed)"
$existsCode = Invoke-Az -AzArgs @("storage", "account", "show", "--name", $StorageAccount, "--resource-group", $ResourceGroup, "-o", "none") -AllowFail
if ($existsCode -ne 0) {
  Invoke-Az -AzArgs @(
    "storage", "account", "create",
    "--name", $StorageAccount,
    "--resource-group", $ResourceGroup,
    "--location", $Location,
    "--sku", "Standard_LRS",
    "--kind", "StorageV2",
    "--allow-blob-public-access", "true",
    "--https-only", "true",
    "--min-tls-version", "TLS1_2",
    "-o", "none"
  ) | Out-Null
} else {
  Invoke-Az -AzArgs @(
    "storage", "account", "update",
    "--name", $StorageAccount,
    "--resource-group", $ResourceGroup,
    "--allow-blob-public-access", "true",
    "-o", "none"
  ) | Out-Null
}

Write-Step "Ensuring public container '$Container'"
Invoke-Az -AzArgs @(
  "storage", "container", "create",
  "--account-name", $StorageAccount,
  "--name", $Container,
  "--public-access", "blob",
  "--auth-mode", "login",
  "-o", "none"
) -AllowFail | Out-Null

# Some tenants still need key auth for anonymous public blobs; prefer login, fall back to account key.
$blobPath = "$Version/$AssetName"
$useAuthMode = "login"

Write-Step "Uploading blob '$blobPath' (large file; can take several minutes)"
$uploadCode = Invoke-Az -AzArgs @(
  "storage", "blob", "upload",
  "--account-name", $StorageAccount,
  "--container-name", $Container,
  "--name", $blobPath,
  "--file", $setupItem.FullName,
  "--overwrite", "true",
  "--content-type", "application/octet-stream",
  "--content-disposition", ("attachment; filename=`"{0}`"" -f $AssetName),
  "--auth-mode", "login"
) -AllowFail

if ($uploadCode -ne 0) {
  Write-Host "Login auth upload failed; retrying with account key..." -ForegroundColor Yellow
  $useAuthMode = "key"
  $keyJson = Get-AzJson -AzArgs @(
    "storage", "account", "keys", "list",
    "--account-name", $StorageAccount,
    "--resource-group", $ResourceGroup,
    "-o", "json"
  )
  $key = ($keyJson | ConvertFrom-Json)[0].value
  Invoke-Az -AzArgs @(
    "storage", "blob", "upload",
    "--account-name", $StorageAccount,
    "--account-key", $key,
    "--container-name", $Container,
    "--name", $blobPath,
    "--file", $setupItem.FullName,
    "--overwrite", "true",
    "--content-type", "application/octet-stream",
    "--content-disposition", ("attachment; filename=`"{0}`"" -f $AssetName)
  ) | Out-Null
}

$url = "https://$StorageAccount.blob.core.windows.net/$Container/$blobPath"
Test-DirectDownload -Url $url

Write-Host ""
Write-Host "DONE. Paste this into Partner Center Package URL:" -ForegroundColor Green
Write-Host $url
Write-Host ""
Write-Host "Installer type: EXE"
Write-Host "Silent switch: /S"
Write-Host "Architecture: x64"
Write-Host ""
Write-Host "Website downloads can still use GitHub Releases / noumanshakeil.github.io."
Write-Host "Partner Center MUST use this Azure Blob URL (no redirects)."
Write-Host "Auth used for upload: $useAuthMode"
