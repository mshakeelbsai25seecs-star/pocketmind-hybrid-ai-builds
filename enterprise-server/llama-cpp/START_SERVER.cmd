@echo off
REM PocketMind llama.cpp — start chat API after preflight (double-click or run from this folder)
setlocal
cd /d "%~dp0"

echo.
echo ========================================
echo  PocketMind chat server start
echo  Folder: %CD%
echo ========================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-ChildItem -LiteralPath '%CD%' -Recurse -File -Include *.ps1,*.cmd,*.bat -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" >nul 2>&1

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-server.ps1" %*
set ERR=%ERRORLEVEL%
echo.
if "%ERR%"=="0" (
  echo Test: curl.exe http://127.0.0.1:8000/v1/models
) else (
  echo Start failed. Use START_ADMIN.cmd to fix model / see logs.
)
pause
exit /b %ERR%
