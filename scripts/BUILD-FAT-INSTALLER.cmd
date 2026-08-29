@echo off
REM Wrapper: prefer the .ps1 so users can also run it with powershell -File.
setlocal
set "REPO=%~dp0.."
cd /d "%REPO%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0BUILD-FAT-INSTALLER.ps1" %*
set "ERR=%ERRORLEVEL%"
echo.
echo Exit code: %ERR%
pause
exit /b %ERR%
