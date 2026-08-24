#Requires -Version 5.1
<#
.SYNOPSIS
  Install PocketMind Hybrid AI desktop toolchain on D: and build the Windows .exe.

.DESCRIPTION
  Puts Rust/Cargo/caches on D:\DevCache (not C:), installs WebView2 if missing,
  optionally stages llama.cpp runtimes, then runs `npm run tauri build`.

  Default project: D:\nexus-ai-deep-fixed

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File D:\nexus-ai-deep-fixed\scripts\build-desktop-windows.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File D:\nexus-ai-deep-fixed\scripts\build-desktop-windows.ps1 -SkipLlamaRuntimes
#>
[CmdletBinding()]
param(
  [string]$ProjectRoot = "D:\nexus-ai-deep-fixed",
  [string]$DevCacheRoot = "D:\DevCache",
  [switch]$SkipLlamaRuntimes,
  [switch]$SkipWebView2,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Ensure-Directory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
  }
}

function Set-UserEnv([string]$Name, [string]$Value) {
  [Environment]::SetEnvironmentVariable($Name, $Value, "User")
  Set-Item -Path "Env:$Name" -Value $Value
}

function Add-UserPathEntry([string]$Entry) {
  if (-not $Entry) { return }
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ([string]::IsNullOrWhiteSpace($userPath)) {
    $userPath = $Entry
  } elseif ($userPath -notlike "*$Entry*") {
    $userPath = "$Entry;$userPath"
  }
  [Environment]::SetEnvironmentVariable("Path", $userPath, "User")
  if ($env:Path -notlike "*$Entry*") {
    $env:Path = "$Entry;$env:Path"
  }
}

function Test-MsvcToolchain {
  if (Get-Command link.exe -ErrorAction SilentlyContinue) { return $true }
  if (Get-VsInstallPath) {
    $p = Get-VsInstallPath
    if (Test-Path -LiteralPath (Join-Path $p "VC\Tools\MSVC")) { return $true }
  }
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path -LiteralPath $vswhere) {
    $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($installPath) { return $true }
  }
  return $false
}

function Get-VsInstallPath {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path -LiteralPath $vswhere) {
    $path = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($path) { return $path }
    $path = & $vswhere -latest -products * -property installationPath 2>$null
    if ($path) { return $path }
  }
  foreach ($candidate in @(
    "D:\VS\BuildTools",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools",
    "$env:ProgramFiles\Microsoft Visual Studio\2022\BuildTools"
  )) {
    if (Test-Path -LiteralPath (Join-Path $candidate "VC\Tools\MSVC")) {
      return $candidate
    }
  }
  return $null
}

function Import-VsDevEnvironment {
  $installPath = Get-VsInstallPath
  if (-not $installPath) { return $false }

  $candidates = @(
    (Join-Path $installPath "Common7\Tools\VsDevCmd.bat"),
    (Join-Path $installPath "VC\Auxiliary\Build\vcvars64.bat")
  )
  $devCmd = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $devCmd) { return $false }

  Write-Host "  Importing MSVC environment from: $devCmd"
  $tempBat = Join-Path $env:TEMP ("vsdev-env-" + [guid]::NewGuid().ToString() + ".bat")
  @"
@echo off
call "$devCmd" -arch=amd64 >nul
set
"@ | Set-Content -Path $tempBat -Encoding ASCII

  $lines = & cmd.exe /c "`"$tempBat`"" 2>$null
  Remove-Item -LiteralPath $tempBat -Force -ErrorAction SilentlyContinue
  foreach ($line in $lines) {
    if ($line -match '^(.*?)=(.*)$') {
      $name = $Matches[1]
      $value = $Matches[2]
      if ($name -and ($name -notmatch '^\s*$')) {
        Set-Item -Path "Env:$name" -Value $value
      }
    }
  }
  return [bool](Get-Command link.exe -ErrorAction SilentlyContinue)
}

function Install-MsvcBuildTools {
  param([string]$PreferredInstallPath = "D:\VS\BuildTools")

  Write-Host @"
Installing Visual Studio 2022 Build Tools with C++ workload to:
  $PreferredInstallPath
This is required for link.exe. First run often takes 15-40 minutes.
"@ -ForegroundColor Yellow

  Ensure-Directory $PreferredInstallPath
  Ensure-Directory (Join-Path $DevCacheRoot "Downloads")

  # If winget says Build Tools is installed but vswhere sees nothing, the install is corrupt.
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  $seenByVswhere = $false
  if (Test-Path -LiteralPath $vswhere) {
    $raw = & $vswhere -all -products * -property installationPath 2>$null
    if ($raw) { $seenByVswhere = $true }
  }

  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget -and -not $seenByVswhere) {
    Write-Host "  Detected broken/orphan Build Tools registration. Uninstalling via winget..." -ForegroundColor Yellow
    try {
      & winget uninstall --id Microsoft.VisualStudio.2022.BuildTools -e --disable-interactivity --accept-source-agreements 2>$null
    } catch {
      Write-Host "  winget uninstall warning: $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }

  $boot = Join-Path $DevCacheRoot "Downloads\vs_BuildTools.exe"
  if (-not (Test-Path -LiteralPath $boot)) {
    Write-Host "  Downloading VS Build Tools bootstrapper..."
    Invoke-WebRequest -Uri "https://aka.ms/vs/17/release/vs_BuildTools.exe" -OutFile $boot -UseBasicParsing
  }

  Write-Host "  Running bootstrapper (passive). A UAC prompt may appear - accept it."
  $argList = @(
    "--wait",
    "--passive",
    "--norestart",
    "--installPath", $PreferredInstallPath,
    "--add", "Microsoft.VisualStudio.Workload.VCTools",
    "--includeRecommended"
  )
  $p = Start-Process -FilePath $boot -ArgumentList $argList -Wait -PassThru
  Write-Host "  Bootstrapper exit code: $($p.ExitCode)"

  if ($p.ExitCode -notin @(0, 3010)) {
    Write-Host "  Passive install failed. Launching interactive installer - select 'Desktop development with C++'." -ForegroundColor Yellow
    Start-Process -FilePath $boot -ArgumentList @("--installPath", $PreferredInstallPath) -Wait
  }
}

# Prefer the script's own repo if present.
$ScriptRepoRoot = Split-Path -Parent $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $ScriptRepoRoot "package.json")) {
  $ProjectRoot = $ScriptRepoRoot
}

if (-not (Test-Path -LiteralPath "D:\")) {
  throw "Drive D: is not available. This script keeps the heavy toolchain on D:."
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "package.json"))) {
  throw "package.json not found under $ProjectRoot. cd to the repo or pass -ProjectRoot."
}

$CargoHome   = Join-Path $DevCacheRoot "Cargo"
$RustupHome  = Join-Path $DevCacheRoot "Rustup"
$TargetDir   = Join-Path $DevCacheRoot "Cargo\target\nexus-ai"
$NpmCache    = Join-Path $DevCacheRoot "npm-cache"
$TempRoot    = Join-Path $DevCacheRoot "tmp"
$Downloads   = Join-Path $DevCacheRoot "Downloads"
$DataRoot    = "D:\PocketMind"

Ensure-Directory $DevCacheRoot
Ensure-Directory $CargoHome
Ensure-Directory $RustupHome
Ensure-Directory $TargetDir
Ensure-Directory $NpmCache
Ensure-Directory $TempRoot
Ensure-Directory $Downloads
Ensure-Directory $DataRoot

# Keep temp/build caches off C:
$env:TEMP = $TempRoot
$env:TMP = $TempRoot
$env:CARGO_HOME = $CargoHome
$env:RUSTUP_HOME = $RustupHome
$env:CARGO_TARGET_DIR = $TargetDir
$env:NPM_CONFIG_CACHE = $NpmCache
$env:NEXUS_DATA_ROOT = $DataRoot

Set-UserEnv "CARGO_HOME" $CargoHome
Set-UserEnv "RUSTUP_HOME" $RustupHome
Set-UserEnv "CARGO_TARGET_DIR" $TargetDir
Set-UserEnv "NPM_CONFIG_CACHE" $NpmCache
Set-UserEnv "NEXUS_DATA_ROOT" $DataRoot

Write-Host "PocketMind Hybrid AI - Windows desktop build (D: drive)" -ForegroundColor Green
Write-Host "  Project:      $ProjectRoot"
Write-Host "  CARGO_HOME:   $CargoHome"
Write-Host "  RUSTUP_HOME:  $RustupHome"
Write-Host "  Target dir:   $TargetDir"
Write-Host "  Data root:    $DataRoot"

# --- Node.js ---
Write-Step "Checking Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js not found. Installing via winget..." -ForegroundColor Yellow
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "Node.js is missing and winget is unavailable. Install Node 18+ from https://nodejs.org then re-run."
  }
  & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --disable-interactivity
  $nodePaths = @(
    "$env:ProgramFiles\nodejs",
    "${env:ProgramFiles(x86)}\nodejs"
  )
  foreach ($p in $nodePaths) {
    if (Test-Path (Join-Path $p "node.exe")) { Add-UserPathEntry $p }
  }
}
node --version
npm --version

# --- Rust on D: ---
Write-Step "Checking Rust (Cargo) on D:"
$cargoExe = Join-Path $CargoHome "bin\cargo.exe"
Add-UserPathEntry (Join-Path $CargoHome "bin")

if (-not (Test-Path -LiteralPath $cargoExe)) {
  Write-Host "Installing rustup into $RustupHome / $CargoHome ..."
  $rustupInit = Join-Path $Downloads "rustup-init.exe"
  if (-not (Test-Path -LiteralPath $rustupInit)) {
    $urls = @(
      "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe",
      "https://win.rustup.rs/x86_64"
    )
    $downloaded = $false
    foreach ($url in $urls) {
      try {
        Write-Host "  Downloading: $url"
        Invoke-WebRequest -Uri $url -OutFile $rustupInit -UseBasicParsing
        $downloaded = $true
        break
      } catch {
        Write-Host "  Download failed: $($_.Exception.Message)" -ForegroundColor Yellow
      }
    }
    if (-not $downloaded) {
      throw "Could not download rustup-init.exe. Check network / antivirus and retry."
    }
  }

  # -y default host MSVC, no PATH modification prompt; we manage PATH ourselves.
  & $rustupInit -y --default-toolchain stable --default-host x86_64-pc-windows-msvc --no-modify-path
  if (-not (Test-Path -LiteralPath $cargoExe)) {
    throw "cargo.exe still missing at $cargoExe after rustup-init."
  }
} else {
  Write-Host "cargo already present: $cargoExe"
}

# Refresh PATH for this session
$env:Path = "$(Join-Path $CargoHome 'bin');$env:Path"
& (Join-Path $CargoHome "bin\rustup.exe") default stable | Out-Null
cargo --version
rustc --version

# --- MSVC Build Tools (required for Tauri on Windows) ---
Write-Step "Checking Visual C++ / MSVC toolchain"
if (-not (Test-MsvcToolchain)) {
  Install-MsvcBuildTools -PreferredInstallPath "D:\VS\BuildTools"
}

if (-not (Import-VsDevEnvironment)) {
  if (-not (Test-MsvcToolchain)) {
    throw @"
Microsoft C++ build tools (link.exe) are still missing.

Your previous Build Tools install looks corrupted (winget lists it, vswhere does not).

Fix with:
  1) Run: D:\nexus-ai-deep-fixed\scripts\FIX-MSVC-BUILDTOOLS.cmd
     (uninstalls broken registration, installs C++ tools to D:\VS\BuildTools)
  2) Or open Visual Studio Installer -> remove broken Build Tools -> install fresh
     with 'Desktop development with C++' checked, install path D:\VS\BuildTools

Then re-run:
  powershell -ExecutionPolicy Bypass -File D:\nexus-ai-deep-fixed\scripts\build-desktop-windows.ps1 -SkipLlamaRuntimes
"@
  }
}

if (Get-Command link.exe -ErrorAction SilentlyContinue) {
  Write-Host "MSVC linker ready: $((Get-Command link.exe).Source)" -ForegroundColor Green
} else {
  Write-Host "WARNING: link.exe still not on PATH; build will likely fail." -ForegroundColor Yellow
}

# --- WebView2 Runtime ---
if (-not $SkipWebView2) {
  Write-Step "Checking WebView2 Runtime"
  $wv2 = Get-ItemProperty -Path "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
  if (-not $wv2) {
    $wv2 = Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
  }
  if (-not $wv2) {
    Write-Host "Installing WebView2 Evergreen Runtime..."
    $wv2Installer = Join-Path $Downloads "MicrosoftEdgeWebView2Setup.exe"
    Invoke-WebRequest -Uri "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile $wv2Installer -UseBasicParsing
    Start-Process -FilePath $wv2Installer -ArgumentList "/silent /install" -Wait
  } else {
    Write-Host "WebView2 Runtime present."
  }
}

# --- npm deps ---
Write-Step "Installing npm dependencies"
Set-Location $ProjectRoot
npm install --cache $NpmCache

# --- llama.cpp runtimes (needed for local inference next to the exe) ---
if (-not $SkipLlamaRuntimes) {
  $llamaScript = Join-Path $ProjectRoot "scripts\install_llama_cpp_runtimes.ps1"
  if (Test-Path -LiteralPath $llamaScript) {
    Write-Step "Installing llama.cpp Windows runtimes into bin\llama.cpp"
    & $llamaScript -ProjectPath $ProjectRoot -TempRoot (Join-Path $DevCacheRoot "llama-runtime-tmp")
  } else {
    Write-Host "Skipping llama runtimes (script missing): $llamaScript" -ForegroundColor Yellow
  }
}

if ($SkipBuild) {
  Write-Host "`nToolchain ready. Skipped build (-SkipBuild)." -ForegroundColor Green
  Write-Host "Build later with:"
  Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -SkipLlamaRuntimes"
  exit 0
}

# --- Tauri release build ---
Write-Step "Building PocketMind Hybrid AI.exe (this can take a long time on first run)"
$env:CARGO_HOME = $CargoHome
$env:RUSTUP_HOME = $RustupHome
$env:CARGO_TARGET_DIR = $TargetDir
$env:Path = "$(Join-Path $CargoHome 'bin');$env:Path"
# Ensure MSVC env is loaded in this session (link.exe / cl.exe).
[void](Import-VsDevEnvironment)

if (-not (Get-Command link.exe -ErrorAction SilentlyContinue)) {
  throw "link.exe not found on PATH. Install VC++ Build Tools, then re-run this script."
}

npm run tauri build
if ($LASTEXITCODE -ne 0) {
  throw "tauri build failed with exit code $LASTEXITCODE"
}

# --- Locate and stage outputs ---
Write-Step "Locating build outputs"
$exeCandidates = @(
  (Join-Path $TargetDir "release\PocketMind Hybrid AI.exe"),
  (Join-Path $ProjectRoot "src-tauri\target\release\PocketMind Hybrid AI.exe")
)
$builtExe = $exeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $builtExe) {
  $found = Get-ChildItem -Path $TargetDir -Recurse -Filter "*.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'PocketMind|nexus' -and $_.FullName -match '\\release\\' -and $_.Name -notmatch 'build-script' } |
    Select-Object -First 5
  Write-Host "Could not find expected exe. Nearby release exes:" -ForegroundColor Yellow
  $found | ForEach-Object { Write-Host "  $($_.FullName)" }
  throw "Build finished but PocketMind Hybrid AI.exe was not found."
}

$stageScript = Join-Path $ProjectRoot "distribution\windows-desktop\scripts\stage-release.ps1"
if (Test-Path -LiteralPath $stageScript) {
  Write-Step "Staging portable payload"
  & $stageScript -RepoRoot $ProjectRoot
}

$payloadDir = Join-Path $ProjectRoot "distribution\windows-desktop\payload"
Write-Host "`nDone." -ForegroundColor Green
Write-Host "  Main exe:  $builtExe"
if (Test-Path -LiteralPath $payloadDir) {
  Write-Host "  Staged:    $payloadDir"
}
$nsis = Join-Path (Split-Path $builtExe -Parent) "bundle\nsis"
if (Test-Path -LiteralPath $nsis) {
  Get-ChildItem $nsis -Filter "*.exe" | ForEach-Object {
    Write-Host "  Installer: $($_.FullName)"
  }
}

Write-Host @"

Run the app:
  & "$builtExe"

Or from staged payload (if present):
  explorer "$payloadDir"

"@
