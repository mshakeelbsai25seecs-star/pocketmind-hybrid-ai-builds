# PocketMind Hybrid AI — Android on Windows (D: drive)

Use this guide when Android Studio fails on **C:** with:

```
EssentialPluginMissingException: Missing essential plugins:
Git4Idea, JUnit, com.android.tools.design, org.jetbrains.android, org.jetbrains.kotlin, ...
```

That error means the install under `C:\Program Files\Android\Android Studio` is **corrupt or incomplete** (often after a partial update, antivirus cleanup, or a bad move to another drive). The fix is a **clean reinstall on D:** — do not try to symlink or copy only part of the IDE.

## Project location

This repo is expected at:

```text
D:\nexus-ai-deep-fixed
```

## One-command setup (recommended)

**Close Android Studio first**, then either:

### Option A — double-click

```text
D:\nexus-ai-deep-fixed\scripts\RUN-ANDROID-SETUP.cmd
```

### Option B — PowerShell (paste as-is)

```powershell
cd D:\nexus-ai-deep-fixed
git fetch origin
git checkout cursor/android-studio-setup-7411
git pull

powershell -ExecutionPolicy Bypass -File D:\nexus-ai-deep-fixed\scripts\setup-android-env-windows.ps1 -RemoveBrokenCInstall
```

Do **not** run this from `C:\Windows\System32`. The script must live under `D:\nexus-ai-deep-fixed\scripts\`.

## What gets installed on D:

| Path | Purpose |
|------|---------|
| `D:\Android\Android Studio\` | Android Studio IDE (zip install, plugins intact) |
| `D:\Android\Sdk\` | `ANDROID_HOME` / SDK platform 35, build-tools |
| `D:\Android\avd\` | `ANDROID_AVD_HOME` — emulators |
| `D:\Android\.gradle\` | `GRADLE_USER_HOME` — Gradle caches & wrappers |
| `D:\Android\AndroidStudioConfig\` | IDE settings (`idea.config.path`) |
| `D:\Android\AndroidStudioCache\` | IDE indexes & caches (`idea.system.path`) |
| `D:\Android\AndroidStudioLogs\` | IDE logs (`idea.log.path`) |

Nothing large is left on **C:** except optional legacy config under `%APPDATA%\Google\AndroidStudio*` (safe to delete after confirming D: works).

## After setup — open the project

Double-click:

```text
D:\nexus-ai-deep-fixed\scripts\OPEN-ANDROID-STUDIO.cmd
```

Or:

```powershell
& "D:\Android\Android Studio\bin\studio64.exe" "D:\nexus-ai-deep-fixed\android"
```

## Build the app

```powershell
cd D:\nexus-ai-deep-fixed\android
.\gradlew.bat assembleDebug
```

Release (after configuring `keystore.properties`):

```powershell
.\gradlew.bat assembleRelease
.\gradlew.bat bundleRelease
```

## Verify plugins loaded

After launch, **Help → About** should list Android support. If plugins are still missing:

1. Confirm you launched `D:\Android\Android Studio\bin\studio64.exe` (not the old C: shortcut).
2. Delete `D:\Android\AndroidStudioCache` and restart (forces re-index; does not remove the IDE).
3. Re-run `RUN-ANDROID-SETUP.cmd` to refresh the zip install.

## Freeing C: space

After D: setup works:

```powershell
# Optional cleanup (review paths first)
Remove-Item -Recurse -Force "C:\Program Files\Android\Android Studio" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Android\Sdk" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:USERPROFILE\.gradle" -ErrorAction SilentlyContinue
```

Keep upload keystores on D: (e.g. `D:\AndroidKeys\`) — see `keystore.properties.example`.
