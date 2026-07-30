@echo off
REM Smoke-test chat API (uses curl.exe)
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\smoke.ps1" %*
echo.
pause
exit /b %ERRORLEVEL%
