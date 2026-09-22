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
  [switch]$SkipCuda,
  [switch]$SkipVulkan,
  [switch]$StoreSafe,
  [switch]$SkipWebView2,
  [switch]$SkipBuild,
  [switch]$AllowNonDDrive
)

if ($StoreSafe) {
  $SkipCuda = $true
  $SkipVulkan = $true
}

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

$onCi = ($env:GITHUB_ACTIONS -eq "true") -or ($env:CI -eq "true")
if (-not (Test-Path -LiteralPath "D:\")) {
  if (-not ($AllowNonDDrive -or $onCi)) {
    throw "Drive D: is not available. This script keeps the heavy toolchain on D: (or pass -AllowNonDDrive / run on GitHub Actions)."
  }
  if ($DevCacheRoot -like "D:\*") {
    $fallbackRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { Join-Path $ProjectRoot ".devcache" }
    $DevCacheRoot = Join-Path $fallbackRoot "DevCache"
    Write-Host "No D: drive - using DevCacheRoot=$DevCacheRoot" -ForegroundColor Yellow
  }
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
if (Test-Path -LiteralPath "D:\") {
  $DataRoot = "D:\PocketMind"
} else {
  $DataRoot = Join-Path $DevCacheRoot "PocketMind"
}

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

# --- llama.cpp runtimes: download + embed into Tauri resources for setup.exe ---
$prepareArgs = @{
  ProjectRoot = $ProjectRoot
  TempRoot = Join-Path $DevCacheRoot "llama-runtime-tmp"
}
if ($SkipCuda) { $prepareArgs.SkipCuda = $true }
if ($SkipVulkan) { $prepareArgs.SkipVulkan = $true }

if (-not $SkipLlamaRuntimes) {
  $prepareScript = Join-Path $ProjectRoot "scripts\prepare-windows-bundle-runtimes.ps1"
  if (Test-Path -LiteralPath $prepareScript) {
    if ($StoreSafe) {
      Write-Step "Preparing STORE-SAFE bundled runtimes (CPU only; no CUDA/Vulkan DLLs)"
    } else {
      Write-Step "Preparing bundled llama.cpp runtimes for the installer"
    }
    & $prepareScript @prepareArgs
  } else {
    $llamaScript = Join-Path $ProjectRoot "scripts\install_llama_cpp_runtimes.ps1"
    if (Test-Path -LiteralPath $llamaScript) {
      Write-Step "Installing llama.cpp Windows runtimes into bin\llama.cpp"
      $installArgs = @{
        ProjectPath = $ProjectRoot
        TempRoot = Join-Path $DevCacheRoot "llama-runtime-tmp"
      }
      if ($SkipCuda) { $installArgs.SkipCuda = $true }
      if ($SkipVulkan) { $installArgs.SkipVulkan = $true }
      & $llamaScript @installArgs
    } else {
      Write-Host "Skipping llama runtimes (scripts missing)" -ForegroundColor Yellow
    }
  }
} else {
  # Even when download is skipped, sync selected backends from bin\ into resources\.
  $prepareScript = Join-Path $ProjectRoot "scripts\prepare-windows-bundle-runtimes.ps1"
  if (Test-Path -LiteralPath $prepareScript) {
    Write-Step "Syncing existing bin\llama.cpp into Tauri resources (SkipLlamaRuntimes download)"
    $prepareArgs.SkipDownload = $true
    & $prepareScript @prepareArgs
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

$syncResources = Join-Path $ProjectRoot "scripts\sync-tauri-bundle-resources.mjs"
if (Test-Path -LiteralPath $syncResources) {
  Write-Step "Syncing tauri.conf.json bundle.resources before build"
  Push-Location $ProjectRoot
  try {
    & node $syncResources
    if ($LASTEXITCODE -ne 0) { throw "sync-tauri-bundle-resources.mjs failed ($LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}

# --- Force fresh frontend embed (prevents stale UI in reused CARGO_TARGET_DIR) ---
Write-Step "Forcing fresh Vite dist + git SHA stamp"
$gitSha = "unknown"
try {
  Push-Location $ProjectRoot
  $gitSha = (& git rev-parse HEAD 2>$null | Out-String).Trim()
  if (-not $gitSha) { $gitSha = "unknown" }
} catch {
  $gitSha = "unknown"
} finally {
  Pop-Location
}
Write-Host "  Git HEAD: $gitSha"
$env:VITE_POCKETMIND_GIT_SHA = $gitSha

$distDir = Join-Path $ProjectRoot "dist"
if (Test-Path -LiteralPath $distDir) {
  Write-Host "  Removing stale dist/"
  Remove-Item -LiteralPath $distDir -Recurse -Force
}

# Touch build.rs so cargo re-runs tauri-build and re-embeds ../dist even when Rust sources are unchanged.
$buildRs = Join-Path $ProjectRoot "src-tauri\build.rs"
if (Test-Path -LiteralPath $buildRs) {
  (Get-Item -LiteralPath $buildRs).LastWriteTime = Get-Date
}

# Delete previous release exe / NSIS so we cannot accidentally ship yesterday's binary.
$staleBins = @(
  (Join-Path $TargetDir "release\PocketMind Hybrid AI.exe"),
  (Join-Path $TargetDir "release\app.manifest")
)
Get-ChildItem -Path (Join-Path $TargetDir "release\bundle\nsis") -Filter "*setup.exe" -ErrorAction SilentlyContinue |
  ForEach-Object { $staleBins += $_.FullName }
foreach ($bin in $staleBins) {
  if ($bin -and (Test-Path -LiteralPath $bin)) {
    Write-Host "  Removing stale output: $bin"
    Remove-Item -LiteralPath $bin -Force -ErrorAction SilentlyContinue
  }
}

npm run tauri build
if ($LASTEXITCODE -ne 0) {
  throw "tauri build failed with exit code $LASTEXITCODE"
}

# Prove the just-built web assets contain current-main markers (minified-safe string literals).
Write-Step "Verifying frontend markers in dist/ (stale-build guard)"
$jsFiles = @(Get-ChildItem -Path (Join-Path $ProjectRoot "dist\assets") -Filter "*.js" -File -ErrorAction SilentlyContinue)
if ($jsFiles.Count -eq 0) {
  throw "No dist/assets/*.js after tauri build -- frontend was not produced."
}
$jsBlob = ($jsFiles | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue }) -join "`n"
$requiredMarkers = @(
  "llama-runtime-install-progress",
  "Install CUDA runtime",
  $gitSha
)
foreach ($marker in $requiredMarkers) {
  if ([string]::IsNullOrWhiteSpace($marker)) { continue }
  if ($jsBlob -notlike "*$marker*") {
    throw "Fresh-build guard failed: dist JS is missing expected marker '$marker'. You are not building the sources you think (wrong branch/SHA or stale tree)."
  }
  Write-Host "  OK marker: $marker"
}
# Footer block was removed from Sidebar -- if this exact product footer copy is still present as a
# sidebar string it may be OK elsewhere, but the combination of SHA + CUDA progress is enough.

$buildInfo = @{
  gitSha = $gitSha
  builtAtUtc = [DateTime]::UtcNow.ToString("o")
  projectRoot = $ProjectRoot
  cargoTargetDir = $TargetDir
} | ConvertTo-Json
$buildInfoPath = Join-Path $ProjectRoot "dist\build-info.json"
Set-Content -LiteralPath $buildInfoPath -Value $buildInfo -Encoding UTF8
Write-Host "  Wrote $buildInfoPath"

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
Write-Host "  Git HEAD:  $gitSha"
Write-Host "  Main exe:  $builtExe"
if (Test-Path -LiteralPath $buildInfoPath) {
  $exeDir = Split-Path -Parent $builtExe
  Copy-Item -LiteralPath $buildInfoPath -Destination (Join-Path $exeDir "build-info.json") -Force
  Write-Host "  Build info: $(Join-Path $exeDir 'build-info.json')"
}
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
