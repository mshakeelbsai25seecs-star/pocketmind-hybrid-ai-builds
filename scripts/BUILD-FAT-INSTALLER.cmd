@echo off
REM Build a self-contained PocketMind Windows setup.exe with CPU+CUDA+Vulkan
REM llama.cpp runtimes embedded (no separate bin download for Store users).
setlocal
set "REPO=D:\nexus-ai-deep-fixed"
cd /d "%REPO%"

echo Building fat installer (runtimes embedded in setup.exe)...
echo This can take a long time and produce a large setup package.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\scripts\build-desktop-windows.ps1"
if errorlevel 1 (
  echo FAILED
  pause
  exit /b 1
)

echo.
echo Staging payload folder...
powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\distribution\windows-desktop\scripts\stage-release.ps1"

echo.
echo Done. Look for:
echo   D:\DevCache\Cargo\target\nexus-ai\release\bundle\nsis\*setup.exe
echo   D:\nexus-ai-deep-fixed\distribution\windows-desktop\payload\
echo.
echo Use the *-setup.exe as the Microsoft Store Package URL.
pause
endlocal
