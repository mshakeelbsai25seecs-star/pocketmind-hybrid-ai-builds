@echo off
REM Fix corrupted VS Build Tools and install C++ linker to D:\VS\BuildTools
REM Run this, accept UAC, wait 15-40 minutes, then rebuild the PocketMind exe.
setlocal
echo Uninstalling broken Build Tools registration (if any)...
winget uninstall --id Microsoft.VisualStudio.2022.BuildTools -e --disable-interactivity --accept-source-agreements

mkdir D:\VS\BuildTools 2>nul
mkdir D:\DevCache\Downloads 2>nul

if not exist D:\DevCache\Downloads\vs_BuildTools.exe (
  echo Downloading VS Build Tools bootstrapper...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vs_BuildTools.exe' -OutFile 'D:\DevCache\Downloads\vs_BuildTools.exe' -UseBasicParsing"
)

echo.
echo Installing Desktop C++ tools to D:\VS\BuildTools
echo Accept the UAC prompt and wait until the installer finishes.
echo.
D:\DevCache\Downloads\vs_BuildTools.exe --wait --passive --norestart --installPath "D:\VS\BuildTools" --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended
echo.
echo Installer exit code: %ERRORLEVEL%
echo.
if exist "D:\VS\BuildTools\VC\Tools\MSVC" (
  echo SUCCESS: MSVC tools found under D:\VS\BuildTools
) else (
  echo MSVC folder not found. Opening interactive installer...
  D:\DevCache\Downloads\vs_BuildTools.exe --installPath "D:\VS\BuildTools"
)
echo.
echo Next: rebuild with
echo   powershell -ExecutionPolicy Bypass -File D:\nexus-ai-deep-fixed\scripts\build-desktop-windows.ps1 -SkipLlamaRuntimes
pause
endlocal
