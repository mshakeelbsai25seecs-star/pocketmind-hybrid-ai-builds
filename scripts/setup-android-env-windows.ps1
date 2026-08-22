#Requires -Version 5.1
<#
.SYNOPSIS
  Repair / install Android Studio for PocketMind Hybrid AI on Windows, with all heavy
  paths on D: (not C:).

.DESCRIPTION
  Fixes EssentialPluginMissingException (missing Git4Idea, org.jetbrains.android, etc.)
  by performing a clean install of Android Studio to D:\Android\Android Studio and
  relocating SDK, AVD, Gradle, and IDE config/cache to D:\Android\.

  Default project root: D:\nexus-ai-deep-fixed

  Safe to re-run. Does not delete your C: install until you pass -RemoveBrokenCInstall.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File D:\nexus-ai-deep-fixed\scripts\setup-android-env-windows.ps1 -RemoveBrokenCInstall
#>
[CmdletBinding()]
param(
  [string]$ProjectRoot = "D:\nexus-ai-deep-fixed",
  [string]$DriveRoot = "D:\Android",
  [string]$StudioVersion = "2026.1.3.8",
  [string]$StudioZip = "android-studio-quail3-patch1-windows.zip",
  [string]$StudioSha256 = "758e927767972c44f2bb14e0af035e6b90ec07a9e2819fc2eb83f51a2492501b",
  [string]$CmdlineToolsZip = "commandlinetools-win-11076708_latest.zip",
  [string]$AvdName = "pocketmind_api35",
  [switch]$RemoveBrokenCInstall,
  [switch]$SkipSdkPackages
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Ensure-Directory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
  }
}

function Assert-Sha256([string]$File, [string]$Expected) {
  $hash = (Get-FileHash -Algorithm SHA256 -Path $File).Hash.ToLowerInvariant()
  if ($hash -ne $Expected.ToLowerInvariant()) {
    throw "SHA256 mismatch for $File`nExpected: $Expected`nActual:   $hash"
  }
}

function Copy-TreeIfMissing {
  param([string]$Source, [string]$Destination)
  if (-not (Test-Path -LiteralPath $Source)) { return 0 }
  Ensure-Directory $Destination
  $count = 0
  Get-ChildItem -Path $Source -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($Source.Length).TrimStart('\')
    $destFile = Join-Path $Destination $rel
    $destDir = Split-Path $destFile -Parent
    Ensure-Directory $destDir
    if (-not (Test-Path -LiteralPath $destFile)) {
      Copy-Item -LiteralPath $_.FullName -Destination $destFile
      $count++
    }
  }
  return $count
}

function Set-UserEnv([string]$Name, [string]$Value) {
  [Environment]::SetEnvironmentVariable($Name, $Value, "User")
  Set-Item -Path "Env:$Name" -Value $Value
}

# Prefer the script's own repo if it lives under a different path than the default.
$ScriptRepoRoot = Split-Path -Parent $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $ScriptRepoRoot "android")) {
  $ProjectRoot = $ScriptRepoRoot
}

if (-not (Test-Path -LiteralPath "D:\")) {
  throw "Drive D: is not available. Plug in / mount the D: drive or pass -DriveRoot to another volume."
}

$StudioDir     = Join-Path $DriveRoot "Android Studio"
$SdkRoot       = Join-Path $DriveRoot "Sdk"
$AvdHome       = Join-Path $DriveRoot "avd"
$GradleHome    = Join-Path $DriveRoot ".gradle"
$StudioConfig  = Join-Path $DriveRoot "AndroidStudioConfig"
$StudioCache   = Join-Path $DriveRoot "AndroidStudioCache"
$StudioLogs    = Join-Path $DriveRoot "AndroidStudioLogs"
$DownloadDir   = Join-Path $DriveRoot "Downloads"
$BrokenCStudio = Join-Path ${env:ProgramFiles} "Android\Android Studio"
$AndroidDir    = Join-Path $ProjectRoot "android"

Ensure-Directory $DriveRoot
Ensure-Directory $DownloadDir
Ensure-Directory $SdkRoot
Ensure-Directory $AvdHome
Ensure-Directory $GradleHome
Ensure-Directory $StudioConfig
Ensure-Directory $StudioCache
Ensure-Directory $StudioLogs

Write-Host "PocketMind Hybrid AI — Android Studio setup (Windows, D: drive)" -ForegroundColor Green
Write-Host "  Project: $ProjectRoot"
Write-Host "  Studio:  $StudioDir"
Write-Host "  SDK:     $SdkRoot"
Write-Host "  AVD:     $AvdHome"
Write-Host "  Gradle:  $GradleHome"

# --- Detect broken C: install (EssentialPluginMissingException) ---
if (Test-Path -LiteralPath $BrokenCStudio) {
  $pluginsDir = Join-Path $BrokenCStudio "plugins"
  $essential = @("android", "gradle", "java", "Kotlin", "Git4Idea", "JUnit")
  $missing = @()
  foreach ($name in $essential) {
    $match = Get-ChildItem -Path $pluginsDir -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "*$name*" } | Select-Object -First 1
    if (-not $match) { $missing += $name }
  }
  if ($missing.Count -gt 0) {
    Write-Host "`nWARNING: Broken Android Studio install detected on C:" -ForegroundColor Yellow
    Write-Host "  Path: $BrokenCStudio"
    Write-Host "  Missing plugin folders (sample): $($missing -join ', ')"
    Write-Host "  This causes EssentialPluginMissingException. A fresh D: install fixes it."
    if ($RemoveBrokenCInstall) {
      Write-Step "Removing broken C: Android Studio install"
      try {
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if ($winget) {
          & winget uninstall --id Google.AndroidStudio --accept-source-agreements --disable-interactivity 2>$null
        }
      } catch { }
      if (Test-Path -LiteralPath $BrokenCStudio) {
        Remove-Item -LiteralPath $BrokenCStudio -Recurse -Force -ErrorAction SilentlyContinue
      }
      Write-Host "  Left user config under $env:APPDATA\Google\AndroidStudio* (migrate manually if needed)."
    } else {
      Write-Host "  Re-run with -RemoveBrokenCInstall after closing Android Studio to remove the C: install."
    }
  }
}

# --- Install Android Studio (zip -> D:, keeps plugins intact) ---
$studioExe = Join-Path $StudioDir "bin\studio64.exe"
if (-not (Test-Path -LiteralPath $studioExe)) {
  Write-Step "Downloading Android Studio $StudioVersion (zip installer for D:)"
  $studioUrl = "https://edgedl.me.gvt1.com/android/studio/ide-zips/$StudioVersion/$StudioZip"
  $studioArchive = Join-Path $DownloadDir $StudioZip
  if (-not (Test-Path -LiteralPath $studioArchive)) {
    Write-Host "  URL: $studioUrl"
    Invoke-WebRequest -Uri $studioUrl -OutFile $studioArchive -UseBasicParsing
  }
  Assert-Sha256 $studioArchive $StudioSha256

  Write-Step "Extracting Android Studio to $StudioDir"
  if (Test-Path -LiteralPath $StudioDir) {
    Remove-Item -LiteralPath $StudioDir -Recurse -Force
  }
  Ensure-Directory $StudioDir
  Expand-Archive -LiteralPath $studioArchive -DestinationPath $DriveRoot -Force
  $extracted = Get-ChildItem -Path $DriveRoot -Directory |
    Where-Object { $_.Name -like "android-studio*" } |
    Select-Object -First 1
  if ($extracted -and $extracted.FullName -ne $StudioDir) {
    Rename-Item -LiteralPath $extracted.FullName -NewName "Android Studio"
  }
  if (-not (Test-Path -LiteralPath $studioExe)) {
    throw "studio64.exe not found at $studioExe after extract."
  }
} else {
  Write-Step "Android Studio already present at $StudioDir"
}

# --- Pin IDE config / cache / logs to D: (idea.properties) ---
Write-Step "Configuring Android Studio config, cache, and logs on D:"
$ideaProps = Join-Path $StudioDir "bin\idea.properties"
$props = @()
if (Test-Path -LiteralPath $ideaProps) {
  $props = Get-Content -LiteralPath $ideaProps | Where-Object {
    $_ -notmatch '^\s*idea\.(config|system|plugins|log)\.path\s*='
  }
}
$pluginsPath = (Join-Path $StudioConfig "plugins") -replace '\\', '/'
$props += @(
  "idea.config.path=$($StudioConfig -replace '\\', '/')"
  "idea.system.path=$($StudioCache -replace '\\', '/')"
  "idea.plugins.path=$pluginsPath"
  "idea.log.path=$($StudioLogs -replace '\\', '/')"
)
Ensure-Directory (Join-Path $StudioConfig "plugins")
Set-Content -Path $ideaProps -Value $props -Encoding UTF8

# --- SDK cmdline-tools ---
$sdkManager = Join-Path $SdkRoot "cmdline-tools\latest\bin\sdkmanager.bat"
if (-not (Test-Path -LiteralPath $sdkManager)) {
  Write-Step "Installing Android SDK command-line tools"
  $cmdlineUrl = "https://dl.google.com/android/repository/$CmdlineToolsZip"
  $cmdlineArchive = Join-Path $DownloadDir $CmdlineToolsZip
  if (-not (Test-Path -LiteralPath $cmdlineArchive)) {
    Invoke-WebRequest -Uri $cmdlineUrl -OutFile $cmdlineArchive -UseBasicParsing
  }
  $tmp = Join-Path $env:TEMP ("android-cmdline-" + [guid]::NewGuid().ToString())
  Ensure-Directory $tmp
  Expand-Archive -LiteralPath $cmdlineArchive -DestinationPath $tmp -Force
  $latest = Join-Path $SdkRoot "cmdline-tools\latest"
  if (Test-Path -LiteralPath $latest) { Remove-Item -LiteralPath $latest -Recurse -Force }
  Ensure-Directory $latest
  $inner = Join-Path $tmp "cmdline-tools"
  if (Test-Path -LiteralPath $inner) {
    Copy-Item -Path (Join-Path $inner "*") -Destination $latest -Recurse -Force
  } else {
    Copy-Item -Path (Join-Path $tmp "*") -Destination $latest -Recurse -Force
  }
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not $SkipSdkPackages) {
  Write-Step "Installing SDK packages (platform 35, build-tools, emulator)"
  $env:ANDROID_HOME = $SdkRoot
  $env:ANDROID_SDK_ROOT = $SdkRoot
  $yes = ("y`n" * 200)
  $yes | & $sdkManager --licenses 2>&1 | Out-Null
  & $sdkManager --install `
    "platform-tools" `
    "platforms;android-35" `
    "build-tools;35.0.0" `
    "build-tools;34.0.0" `
    "emulator" `
    "system-images;android-35;google_apis;x86_64"
}

# --- Migrate lightweight C: Android user data if present ---
Write-Step "Migrating existing Android user data from C: when safe"
$migrations = @(
  @{ Source = Join-Path $env:USERPROFILE ".android"; Dest = Join-Path $DriveRoot ".android" },
  @{ Source = Join-Path $env:USERPROFILE ".gradle"; Dest = $GradleHome }
)
foreach ($m in $migrations) {
  $copied = Copy-TreeIfMissing -Source $m.Source -Destination $m.Dest
  if ($copied -gt 0) {
    Write-Host "  Copied $copied file(s): $($m.Source) -> $($m.Dest)"
  }
}

# --- AVD on D: ---
$env:ANDROID_AVD_HOME = $AvdHome
$avdManager = Join-Path $SdkRoot "cmdline-tools\latest\bin\avdmanager.bat"
if ((Test-Path -LiteralPath $avdManager) -and -not (Test-Path -LiteralPath (Join-Path $AvdHome "$AvdName.avd"))) {
  Write-Step "Creating AVD $AvdName on D:"
  "no" | & $avdManager create avd `
    -n $AvdName `
    -k "system-images;android-35;google_apis;x86_64" `
    -d pixel_6 `
    --force 2>&1 | Out-Null
}

# --- User environment variables (persistent) ---
Write-Step "Setting user environment variables"
Set-UserEnv "ANDROID_HOME" $SdkRoot
Set-UserEnv "ANDROID_SDK_ROOT" $SdkRoot
Set-UserEnv "ANDROID_AVD_HOME" $AvdHome
Set-UserEnv "GRADLE_USER_HOME" $GradleHome

$studioBin = Join-Path $StudioDir "bin"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathAdds = @(
  $studioBin,
  (Join-Path $SdkRoot "platform-tools"),
  (Join-Path $SdkRoot "emulator"),
  (Join-Path $SdkRoot "cmdline-tools\latest\bin")
)
foreach ($entry in $pathAdds) {
  if ($userPath -notlike "*$entry*") {
    $userPath = if ($userPath) { "$userPath;$entry" } else { $entry }
  }
}
[Environment]::SetEnvironmentVariable("Path", $userPath, "User")
$env:Path = "$userPath;$env:Path"

# --- Project local.properties ---
if (Test-Path -LiteralPath $AndroidDir) {
  $localProps = Join-Path $AndroidDir "local.properties"
  @"
## Machine-local SDK path (D: drive). Do not commit.
sdk.dir=$($SdkRoot -replace '\\', '/')
"@ | Set-Content -Path $localProps -Encoding UTF8
  Write-Host "  Wrote $localProps"
} else {
  Write-Host "  WARNING: android\ folder not found under $ProjectRoot" -ForegroundColor Yellow
}

# --- Desktop shortcut ---
$shortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "Android Studio (D).lnk"
try {
  $wsh = New-Object -ComObject WScript.Shell
  $shortcut = $wsh.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $studioExe
  $shortcut.WorkingDirectory = $StudioDir
  $shortcut.Arguments = "`"$AndroidDir`""
  $shortcut.Save()
  Write-Host "  Shortcut: $shortcutPath"
} catch {
  Write-Host "  Could not create desktop shortcut (non-fatal)."
}

Write-Host "`nDone. Android Studio is installed on D: with SDK/AVD/Gradle on D:." -ForegroundColor Green
Write-Host @"

Next steps:
  1. Close any broken Android Studio window from C:\Program Files.
  2. Launch: "$studioExe" "$AndroidDir"
     (or use the Desktop shortcut "Android Studio (D)")
  3. In the Setup Wizard, confirm SDK path: $SdkRoot
  4. Build:
       cd $ProjectRoot\android
       .\gradlew.bat assembleDebug

If C: still has a broken install, re-run with -RemoveBrokenCInstall after closing Studio.

"@
