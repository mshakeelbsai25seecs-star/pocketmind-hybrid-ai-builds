@echo off
REM One-click Android Studio setup for PocketMind at D:\nexus-ai-deep-fixed
REM Installs Studio/SDK/Gradle/AVD on D:\Android and removes broken C: install.
setlocal
set "REPO=D:\nexus-ai-deep-fixed"
set "SCRIPT=%REPO%\scripts\setup-android-env-windows.ps1"

if not exist "%SCRIPT%" (
  echo ERROR: Script not found:
  echo   %SCRIPT%
  echo.
  echo Make sure the repo is at D:\nexus-ai-deep-fixed and you have pulled
  echo branch cursor/android-studio-setup-7411:
  echo.
  echo   cd /d D:\nexus-ai-deep-fixed
  echo   git fetch origin
  echo   git checkout cursor/android-studio-setup-7411
  echo   git pull
  echo.
  pause
  exit /b 1
)

cd /d "%REPO%"
echo Running Android setup from %REPO% ...
echo Close Android Studio before continuing if it is open.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -ProjectRoot "%REPO%" -RemoveBrokenCInstall
echo.
echo Exit code: %ERRORLEVEL%
if %ERRORLEVEL% EQU 0 (
  echo.
  echo Next: open the project with scripts\OPEN-ANDROID-STUDIO.cmd
)
pause
endlocal
