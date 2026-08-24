@echo off
REM Install llama.cpp CPU/CUDA/Vulkan runtimes for PocketMind local GGUF chat.
REM Places binaries under the repo bin\llama.cpp and next to the built .exe.
setlocal
set "REPO=D:\nexus-ai-deep-fixed"
set "TMP=D:\DevCache\llama-runtime-tmp"
set "EXE_DIR=D:\DevCache\Cargo\target\nexus-ai\release"

cd /d "%REPO%"
echo Installing llama.cpp Windows runtimes (CPU + CUDA + Vulkan)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\scripts\install_llama_cpp_runtimes.ps1" -ProjectPath "%REPO%" -TempRoot "%TMP%"
if errorlevel 1 (
  echo Installer failed.
  pause
  exit /b 1
)

if exist "%EXE_DIR%\PocketMind Hybrid AI.exe" (
  echo Copying runtimes next to the built exe...
  mkdir "%EXE_DIR%\bin\llama.cpp" 2>nul
  xcopy /E /I /Y "%REPO%\bin\llama.cpp\*" "%EXE_DIR%\bin\llama.cpp\"
  echo Done. Runtimes are beside:
  echo   %EXE_DIR%\PocketMind Hybrid AI.exe
) else (
  echo Note: release exe not found at %EXE_DIR%
  echo Runtimes are in %REPO%\bin\llama.cpp
  echo Copy that folder next to your .exe if you launch from another path.
)

echo.
echo Restart PocketMind Hybrid AI, pick your GGUF again, then send "hi".
pause
endlocal
