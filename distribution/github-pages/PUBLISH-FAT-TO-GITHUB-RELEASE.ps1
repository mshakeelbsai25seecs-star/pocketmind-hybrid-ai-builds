# Publish the fat Windows setup.exe to the PUBLIC github.io repo as a Release asset.
#
# Public host:
#   Repo:  https://github.com/noumanshakeil/noumanshakeil.github.io
#   Site:  https://noumanshakeil.github.io/
#   Package URL:
#   https://github.com/noumanshakeil/noumanshakeil.github.io/releases/download/windows-1.0.0/PocketMind-Hybrid-AI_1.0.0_x64-setup.exe
#
# Example:
#   powershell -ExecutionPolicy Bypass -File .\distribution\github-pages\PUBLISH-FAT-TO-GITHUB-RELEASE.ps1
param(
  [string]$SetupExe = "D:\nexus-ai-deep-fixed\distribution\windows-desktop\payload\PocketMind Hybrid AI_1.0.0_x64-setup.exe",
  [string]$Repo = "noumanshakeil/noumanshakeil.github.io",
  [string]$Tag = "windows-1.0.0",
  [string]$Title = "PocketMind Hybrid AI 1.0.0 Windows (fat installer)",
  [string]$AssetName = "PocketMind-Hybrid-AI_1.0.0_x64-setup.exe"
)

$ErrorActionPreference = "Stop"

function Invoke-Gh {
  param([Parameter(Mandatory = $true)][string[]]$GhArgs)
  # PowerShell 5.1 treats native stderr as terminating under Stop; run via cmd for exit codes.
  $argLine = ($GhArgs | ForEach-Object {
      if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }) -join ' '
  cmd.exe /c "gh $argLine"
  return $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath $SetupExe)) {
  throw "Setup EXE not found: $SetupExe"
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI (gh) not found. Install from https://cli.github.com/ then run: gh auth login"
}

$sizeMb = [math]::Round((Get-Item -LiteralPath $SetupExe).Length / 1MB, 1)
Write-Host "Publishing $sizeMb MB -> PUBLIC repo $Repo release $Tag" -ForegroundColor Cyan
Write-Host "  Source: $SetupExe"
Write-Host "  (Private nexus-ai-deep-fixed is NOT used for hosting.)"

$notesFile = Join-Path $env:TEMP ("pocketmind-release-notes-{0}.md" -f [guid]::NewGuid().ToString("N"))
@"
Self-contained Windows NSIS installer for **PocketMind Hybrid AI** (CPU + CUDA + Vulkan runtimes embedded).

- Site: https://noumanshakeil.github.io/
- Silent install: ``/S``
- Architecture: x64

Microsoft Store Package URL:
https://github.com/$Repo/releases/download/$Tag/$AssetName
"@ | Set-Content -Path $notesFile -Encoding UTF8

try {
  $viewCode = Invoke-Gh @("release", "view", $Tag, "--repo", $Repo)
  if ($viewCode -ne 0) {
    Write-Host "Release $Tag not found; creating it..." -ForegroundColor Yellow
    $createCode = Invoke-Gh @(
      "release", "create", $Tag,
      "--repo", $Repo,
      "--title", $Title,
      "--notes-file", $notesFile
    )
    if ($createCode -ne 0) {
      throw "gh release create failed (need push access to $Repo). Exit code $createCode"
    }
  } else {
    Write-Host "Release $Tag already exists; uploading/replacing asset..."
  }

  $staging = Join-Path $env:TEMP $AssetName
  Copy-Item -LiteralPath $SetupExe -Destination $staging -Force
  try {
    $uploadCode = Invoke-Gh @(
      "release", "upload", $Tag, $staging,
      "--repo", $Repo,
      "--clobber"
    )
    if ($uploadCode -ne 0) {
      throw "gh release upload failed with exit code $uploadCode"
    }
  } finally {
    Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue
  }
} finally {
  Remove-Item -LiteralPath $notesFile -Force -ErrorAction SilentlyContinue
}

$url = "https://github.com/$Repo/releases/download/$Tag/$AssetName"
Write-Host ""
Write-Host "Store Package URL (paste into Partner Center):" -ForegroundColor Green
Write-Host $url
Write-Host "Install switch: /S"
Write-Host "Architecture: x64"
Write-Host ""
Write-Host "Verify:"
Write-Host "  gh release view $Tag --repo $Repo"
Write-Host "Then refresh the site HTML:"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\distribution\github-pages\PUBLISH-SITE-ONLY.ps1"
