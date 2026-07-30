#Requires -Version 5.1
<#
.SYNOPSIS
  Smoke-test the chat API (uses curl.exe — not PowerShell's curl alias).
#>
param(
  [string]$BaseUrl = "http://127.0.0.1:8000"
)

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if (-not $curl) {
  Write-Host "FAIL: curl.exe not found" -ForegroundColor Red
  exit 1
}

$url = "$BaseUrl/v1/models"
Write-Host "GET $url"
& curl.exe -sS -f --max-time 10 $url
$code = $LASTEXITCODE
Write-Host ""
if ($code -ne 0) {
  Write-Host "SMOKE FAIL (exit $code). Is the container Up? Check: docker ps" -ForegroundColor Red
  Write-Host "Logs: docker logs nexusai-llama-cpp-cuda --tail 50" -ForegroundColor Yellow
  Write-Host "Tip: in PowerShell always use curl.exe, not curl." -ForegroundColor Yellow
  exit $code
}
Write-Host "SMOKE PASS" -ForegroundColor Green
exit 0
