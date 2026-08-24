@echo off
REM Install Rust/Cargo/caches on D:\DevCache and build PocketMind Hybrid AI.exe
setlocal
set "REPO=D:\nexus-ai-deep-fixed"
set "SCRIPT=%REPO%\scripts\build-desktop-windows.ps1"

if not exist "%SCRIPT%" (
  echo ERROR: Script not found:
  echo   %SCRIPT%
  echo.
  echo Pull it without switching branches:
  echo   cd /d D:\nexus-ai-deep-fixed
  echo   git fetch origin cursor/android-studio-setup-7411
  echo   git show origin/cursor/android-studio-setup-7411:scripts/build-desktop-windows.ps1 ^| Set-Content -Path .\scripts\build-desktop-windows.ps1 -Encoding UTF8
  echo.
  pause
  exit /b 1
)

cd /d "%REPO%"
echo Building PocketMind desktop on D: — first run can take a long time.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
echo.
echo Exit code: %ERRORLEVEL%
pause
endlocal
