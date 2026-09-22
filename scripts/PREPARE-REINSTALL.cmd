@echo off
REM Stop PocketMind / llama.cpp processes before reinstalling setup.exe.
REM Fixes NSIS "Error opening file for writing: ...\ggml-base.dll" when
REM llama-server.exe still holds runtime DLLs from a previous session.
setlocal
echo Stopping PocketMind Hybrid AI and llama-server (if running)...
taskkill /F /T /IM "PocketMind Hybrid AI.exe" >nul 2>&1
taskkill /F /T /IM llama-server.exe >nul 2>&1
taskkill /F /T /IM llama-server-cpu.exe >nul 2>&1
taskkill /F /T /IM llama-server-cuda.exe >nul 2>&1
taskkill /F /T /IM llama-server-vulkan.exe >nul 2>&1
timeout /t 2 /nobreak >nul
echo Done. You can Retry or re-run the PocketMind Hybrid AI setup.exe now.
pause
endlocal
