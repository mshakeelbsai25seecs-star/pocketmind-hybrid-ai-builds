# Publish the fat Windows setup.exe to the PUBLIC github.io repo as a Release asset.
#
# Public host:
#   Repo: noumanshakeil/noumanshakeil.github.io
#   Site: https://noumanshakeil.github.io/
#   Package URL:
#   https://github.com/noumanshakeil/noumanshakeil.github.io/releases/download/windows-1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe
#
# Designed for Windows PowerShell 5.1:
#   - never trusts mixed pipeline/"return" from gh stdout
#   - treats "release already exists" as OK
#   - verifies the asset after upload
#
# Example:
#   powershell -ExecutionPolicy Bypass -File .\distribution\github-pages\PUBLISH-FAT-TO-GITHUB-RELEASE.ps1
param(
  [string]$SetupExe = "D:\nexus-ai-deep-fixed\distribution\windows-desktop\payload\PocketMind Hybrid AI_1.0.0_x64-setup.exe",
  [string]$Repo = "noumanshakeil/noumanshakeil.github.io",
  [string]$Tag = "windows-1.0.0",
  [string]$Title = "PocketMind Hybrid AI 1.0.0 Windows (fat installer)",
  [string]$AssetName = "PocketMind-Hybrid-AI_1.0.0_x64-setup.exe",
  [int]$UploadRetries = 3
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-GhAuth {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & gh auth status 2>&1 | Out-Host
  $code = [int]$LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -ne 0) {
    throw "gh is not authenticated. Run: gh auth login"
  }
}

# Run gh without letting PS 5.1 turn stderr into a terminating error.
# Exit code is written to the [ref]; stdout/stderr go to the console only.
function Invoke-GhChecked {
  param(
    [Parameter(Mandatory = $true)][string[]]$Args,
    [Parameter(Mandatory = $true)][ref]$ExitCode,
    [switch]$AllowFail
  )
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  # Discard success-stream capture so this function never returns gh stdout by accident.
  & gh @Args 2>&1 |
    ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) {
        [Console]::Error.WriteLine($_.Exception.Message)
      } else {
        [Console]::Out.WriteLine([string]$_)
      }
    } |
    Out-Null
  $ExitCode.Value = [int]$LASTEXITCODE
  $ErrorActionPreference = $prev
  if (-not $AllowFail -and $ExitCode.Value -ne 0) {
    throw ("gh {0} failed with exit code {1}" -f ($Args -join ' '), $ExitCode.Value)
  }
}

function Test-ReleaseExists {
  param([string]$TagName, [string]$RepoName)
  $code = 1
  Invoke-GhChecked -Args @("release", "view", $TagName, "--repo", $RepoName) -ExitCode ([ref]$code) -AllowFail
  return ($code -eq 0)
}

function Ensure-Release {
  param(
    [string]$TagName,
    [string]$RepoName,
    [string]$ReleaseTitle,
    [string]$NotesFile
  )
  if (Test-ReleaseExists -TagName $TagName -RepoName $RepoName) {
    Write-Host "Release $TagName already exists."
    return
  }

  Write-Host "Creating release $TagName ..."
  $code = 1
  Invoke-GhChecked -Args @(
    "release", "create", $TagName,
    "--repo", $RepoName,
    "--title", $ReleaseTitle,
    "--notes-file", $NotesFile
  ) -ExitCode ([ref]$code) -AllowFail

  if ($code -eq 0) {
    Write-Host "Release created."
    return
  }

  # Common races / partial prior runs: create printed a URL but PS mis-handled the exit code,
  # or another process created the tag first.
  Start-Sleep -Seconds 2
  if (Test-ReleaseExists -TagName $TagName -RepoName $RepoName) {
    Write-Host "Release $TagName is present after create attempt; continuing."
    return
  }

  throw ("Failed to create release {0} on {1} (gh exit {2}). Check: gh release list --repo {1}" -f $TagName, $RepoName, $code)
}

function Publish-Asset {
  param(
    [string]$TagName,
    [string]$RepoName,
    [string]$LocalPath,
    [string]$Name,
    [int]$Retries
  )

  if (-not (Test-Path -LiteralPath $LocalPath)) {
    throw "Staging file missing: $LocalPath"
  }

  $attempt = 0
  while ($attempt -lt $Retries) {
    $attempt++
    Write-Host ("Upload attempt {0}/{1} ..." -f $attempt, $Retries)
    $code = 1
    Invoke-GhChecked -Args @(
      "release", "upload", $TagName, $LocalPath,
      "--repo", $RepoName,
      "--clobber"
    ) -ExitCode ([ref]$code) -AllowFail

    if ($code -eq 0) {
      return
    }

    Write-Host ("Upload failed with exit {0}." -f $code) -ForegroundColor Yellow
    if ($attempt -ge $Retries) {
      throw ("gh release upload failed after {0} attempts (last exit {1})" -f $Retries, $code)
    }
    Start-Sleep -Seconds (5 * $attempt)
  }
}

function Assert-AssetPresent {
  param(
    [string]$TagName,
    [string]$RepoName,
    [string]$Name,
    [long]$ExpectedBytes
  )

  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $json = & gh release view $TagName --repo $RepoName --json assets 2>&1
  $code = [int]$LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -ne 0) {
    throw "Could not verify release assets (gh exit $code)."
  }

  # gh may return ErrorRecords mixed in; keep text lines only.
  $text = ($json | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
  if ([string]::IsNullOrWhiteSpace($text)) {
    throw "gh release view returned empty JSON."
  }
  $data = $text | ConvertFrom-Json
  $assets = @()
  if ($null -ne $data.assets) { $assets = @($data.assets) }
  $asset = $assets | Where-Object { $_.name -eq $Name } | Select-Object -First 1
  if ($null -eq $asset) {
    $names = ($assets | ForEach-Object { $_.name }) -join ', '
    throw ("Asset '{0}' not found on release {1}. Assets: {2}" -f $Name, $TagName, $names)
  }

  $size = [int64]$asset.size
  # Allow small metadata differences; flag large mismatches.
  if ($ExpectedBytes -gt 0 -and [math]::Abs($size - $ExpectedBytes) -gt 1024) {
    throw ("Uploaded size {0} bytes does not match local {1} bytes" -f $size, $ExpectedBytes)
  }

  Write-Host ("Verified asset {0} ({1:N1} MB)" -f $Name, ($size / 1MB)) -ForegroundColor Green
}

# --- main ---

Write-Host "PocketMind fat installer -> PUBLIC GitHub Release" -ForegroundColor Green
Write-Host "  Repo: $Repo"
Write-Host "  Tag:  $Tag"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI (gh) not found. Install from https://cli.github.com/ then run: gh auth login"
}
if (-not (Test-Path -LiteralPath $SetupExe)) {
  throw "Setup EXE not found: $SetupExe`nBuild first with scripts\BUILD-FAT-INSTALLER.ps1"
}

$setupItem = Get-Item -LiteralPath $SetupExe
$sizeMb = [math]::Round($setupItem.Length / 1MB, 1)
Write-Host ("  Source: {0} ({1} MB)" -f $setupItem.FullName, $sizeMb)
Write-Host "  Private nexus-ai-deep-fixed is NOT used for hosting."

Write-Step "Checking gh authentication"
Assert-GhAuth

$notesFile = Join-Path $env:TEMP ("pocketmind-release-notes-{0}.md" -f [guid]::NewGuid().ToString("N"))
$staging = Join-Path $env:TEMP $AssetName

@"
Self-contained Windows NSIS installer for **PocketMind Hybrid AI** (CPU + CUDA + Vulkan runtimes embedded).

- Site: https://noumanshakeil.github.io/
- Silent install: ``/S``
- Architecture: x64

Microsoft Store Package URL:
https://github.com/$Repo/releases/download/$Tag/$AssetName
"@ | Set-Content -Path $notesFile -Encoding ASCII

try {
  Write-Step "Ensuring release exists"
  Ensure-Release -TagName $Tag -RepoName $Repo -ReleaseTitle $Title -NotesFile $notesFile

  Write-Step "Staging URL-safe asset name"
  Copy-Item -LiteralPath $SetupExe -Destination $staging -Force

  Write-Step ("Uploading {0} MB (can take several minutes)" -f $sizeMb)
  Publish-Asset -TagName $Tag -RepoName $Repo -LocalPath $staging -Name $AssetName -Retries $UploadRetries

  Write-Step "Verifying asset on release"
  Assert-AssetPresent -TagName $Tag -RepoName $Repo -Name $AssetName -ExpectedBytes $setupItem.Length
} finally {
  Remove-Item -LiteralPath $notesFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue
}

$url = "https://github.com/$Repo/releases/download/$Tag/$AssetName"
Write-Host ""
Write-Host "DONE." -ForegroundColor Green
Write-Host "Store Package URL:" -ForegroundColor Green
Write-Host $url
Write-Host "Install switch: /S"
Write-Host "Architecture: x64"
Write-Host ""
Write-Host "Next (refresh the website buttons):"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\distribution\github-pages\PUBLISH-SITE-ONLY.ps1"
Write-Host "Open to confirm:"
Write-Host ("  https://github.com/{0}/releases/tag/{1}" -f $Repo, $Tag)
