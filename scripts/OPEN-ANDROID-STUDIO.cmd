@echo off
REM Open PocketMind android/ in the D: Android Studio install
setlocal
set "STUDIO=D:\Android\Android Studio\bin\studio64.exe"
set "PROJECT=D:\nexus-ai-deep-fixed\android"

if not exist "%STUDIO%" (
  echo Android Studio not found at:
  echo   %STUDIO%
  echo.
  echo Run this first:
  echo   D:\nexus-ai-deep-fixed\scripts\RUN-ANDROID-SETUP.cmd
  echo.
  pause
  exit /b 1
)

if not exist "%PROJECT%" (
  echo Project folder not found at:
  echo   %PROJECT%
  pause
  exit /b 1
)

start "" "%STUDIO%" "%PROJECT%"
endlocal
