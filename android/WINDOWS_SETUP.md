# PocketMind Hybrid AI — Android on Windows (D: drive)

Use this guide when Android Studio fails on **C:** with:

```
EssentialPluginMissingException: Missing essential plugins:
Git4Idea, JUnit, com.android.tools.design, org.jetbrains.android, org.jetbrains.kotlin, ...
```

That error means the install under `C:\Program Files\Android\Android Studio` is **corrupt or incomplete** (often after a partial update, antivirus cleanup, or a bad move to another drive). The fix is a **clean reinstall on D:** — do not try to symlink or copy only part of the IDE.

## One-command setup (recommended)

**You must run this from the repository root** (the folder that contains `android\` and `scripts\`), **not** from `C:\Windows\System32`.

```powershell
# 1) Go to your PocketMind repo (change the path if yours is different)
cd C:\path\to\nexus-ai-deep-fixed

# 2) Confirm the script exists
Test-Path .\scripts\setup-android-env-windows.ps1

# 3) Run setup (add -RemoveBrokenCInstall to delete the broken C: install)
powershell -ExecutionPolicy Bypass -File .\scripts\setup-android-env-windows.ps1 -RemoveBrokenCInstall
```

If `Test-Path` returns `False`, you do not have the latest repo yet. Either:

- `git pull` on branch `cursor/android-studio-setup-7411`, or
- use the **full path** to the script, e.g.  
  `powershell -ExecutionPolicy Bypass -File "D:\Projects\nexus-ai-deep-fixed\scripts\setup-android-env-windows.ps1" -RemoveBrokenCInstall`

Optional — remove the broken C: install after closing Android Studio:

```powershell
cd C:\path\to\nexus-ai-deep-fixed
powershell -ExecutionPolicy Bypass -File .\scripts\setup-android-env-windows.ps1 -RemoveBrokenCInstall
```

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

## Manual fix (if you prefer the GUI installer)

1. **Uninstall** the broken install: Settings → Apps → Android Studio → Uninstall.
2. Download **Android Studio Quail 3 Patch 1** (`.zip`, not only `.exe`) from [developer.android.com/studio](https://developer.android.com/studio).
3. Extract to `D:\Android\Android Studio\` (not `C:\Program Files`).
4. Edit `D:\Android\Android Studio\bin\idea.properties` and add:

   ```properties
   idea.config.path=D:/Android/AndroidStudioConfig
   idea.system.path=D:/Android/AndroidStudioCache
   idea.plugins.path=D:/Android/AndroidStudioConfig/plugins
   idea.log.path=D:/Android/AndroidStudioLogs
   ```

5. Set **user** environment variables (System Properties → Environment Variables):

   | Variable | Value |
   |----------|-------|
   | `ANDROID_HOME` | `D:\Android\Sdk` |
   | `ANDROID_SDK_ROOT` | `D:\Android\Sdk` |
   | `ANDROID_AVD_HOME` | `D:\Android\avd` |
   | `GRADLE_USER_HOME` | `D:\Android\.gradle` |

6. Launch `D:\Android\Android Studio\bin\studio64.exe` and open this repo’s `android\` folder.
7. In **Settings → Languages & Frameworks → Android SDK**, set SDK location to `D:\Android\Sdk`.
8. Install SDK Platform 35 and Build-Tools 35 if prompted.

## Build the app

```bat
cd android
copy keystore.properties.example keystore.properties
REM Point storeFile at D:\AndroidKeys\pocketmind-upload-key.jks for release signing
gradlew.bat assembleDebug
```

Release:

```bat
gradlew.bat assembleRelease
gradlew.bat bundleRelease
```

## Verify plugins loaded

After launch, **Help → About** should list Android support. If plugins are still missing:

1. Confirm you launched `D:\Android\Android Studio\bin\studio64.exe` (not the old C: shortcut).
2. Delete `D:\Android\AndroidStudioCache` and restart (forces re-index; does not remove the IDE).
3. Re-run `setup-android-env-windows.ps1` to refresh the zip install.

## Freeing C: space

After D: setup works:

```powershell
# Optional cleanup (review paths first)
Remove-Item -Recurse -Force "C:\Program Files\Android\Android Studio" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Android\Sdk" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:USERPROFILE\.gradle" -ErrorAction SilentlyContinue
```

Keep `D:\AndroidKeys\` for upload keystores (see `keystore.properties.example`).
