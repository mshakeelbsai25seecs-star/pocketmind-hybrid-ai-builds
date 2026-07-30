@echo off
REM Preflight checks only (Docker, GPU, GGUF validity)
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-ChildItem -LiteralPath '%CD%' -Recurse -File -Include *.ps1 -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" >nul 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0preflight.ps1" %*
echo.
pause
exit /b %ERRORLEVEL%
