@echo off
REM Stop PocketMind / llama.cpp processes and unlock ggml DLLs before reinstalling.
REM Fixes NSIS "Error opening file for writing: ...\ggml-base.dll" when
REM llama-server.exe (or the GUI) still holds runtime DLLs from a previous session.
setlocal EnableExtensions
set "INSTALL_ROOT=%~1"
if "%INSTALL_ROOT%"=="" set "INSTALL_ROOT=D:\PocketMind"
set "LLAMA_ROOT=%INSTALL_ROOT%\resources\llama.cpp"
set "SCRIPT_DIR=%~dp0"

echo Stopping PocketMind Hybrid AI and llama-server (if running)...
"%SystemRoot%\System32\taskkill.exe" /F /T /IM "PocketMind Hybrid AI.exe" >nul 2>&1
"%SystemRoot%\System32\taskkill.exe" /F /T /IM llama-server.exe >nul 2>&1
"%SystemRoot%\System32\taskkill.exe" /F /T /IM llama-server-cpu.exe >nul 2>&1
"%SystemRoot%\System32\taskkill.exe" /F /T /IM llama-server-cuda.exe >nul 2>&1
"%SystemRoot%\System32\taskkill.exe" /F /T /IM llama-server-vulkan.exe >nul 2>&1
"%SystemRoot%\System32\taskkill.exe" /F /T /IM llama-server-metal.exe >nul 2>&1
timeout /t 2 /nobreak >nul

if exist "%LLAMA_ROOT%\" (
  echo Unlocking runtime DLLs under "%LLAMA_ROOT%"...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%unlock-llama-cpp.ps1" -Root "%LLAMA_ROOT%"
)

echo Done. You can Retry or re-run the PocketMind Hybrid AI setup.exe now.
pause
endlocal
