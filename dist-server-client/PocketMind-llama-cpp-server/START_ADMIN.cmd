@echo off
REM PocketMind llama.cpp — Admin UI launcher (double-click this file)
REM Always runs from this folder. Bypasses PowerShell execution-policy blocks.
setlocal
cd /d "%~dp0"

echo.
echo ========================================
echo  PocketMind chat-server admin
echo  Folder: %CD%
echo ========================================
echo.
echo If you see "script cannot be loaded", this .cmd already bypasses that.
echo Do NOT run from C:\Windows\System32 — always use this folder.
echo.

REM Clear Mark-of-the-Web so copied USB/zip scripts are not blocked as unsigned.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-ChildItem -LiteralPath '%CD%' -Recurse -File -Include *.ps1,*.cmd,*.bat -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" >nul 2>&1

REM Open the UI shortly after the server starts listening.
start "" cmd /c "timeout /t 4 /nobreak >nul & start http://127.0.0.1:8090/"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-admin.ps1" %*
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo Admin UI exited with code %ERR%.
  pause
)
exit /b %ERR%
