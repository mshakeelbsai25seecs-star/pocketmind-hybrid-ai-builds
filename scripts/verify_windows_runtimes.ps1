<#
.SYNOPSIS
  Verify PocketMind Hybrid AI Windows llama.cpp runtime layout (cpu / cuda / vulkan).
#>
param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$BaseDir = Join-Path $ProjectPath "bin\llama.cpp"
$Fail = 0

Write-Host "Runtime root: $BaseDir"
Write-Host ""

function Test-Backend([string]$Name, [switch]$Required) {
  $dir = Join-Path $BaseDir $Name
  $exe = Join-Path $dir "llama-server.exe"
  $label = "[$Name]"

  if (-not (Test-Path $exe)) {
    if ($Required) {
      Write-Host "FAIL  $label missing llama-server.exe" -ForegroundColor Red
      $script:Fail++
    } else {
      Write-Host "SKIP  $label not installed (optional)" -ForegroundColor Yellow
    }
    return
  }

  Write-Host "OK    $label binary present" -ForegroundColor Green

  try {
    $p = Start-Process -FilePath $exe -ArgumentList "--help" -Wait -PassThru -NoNewWindow -RedirectStandardOutput "$env:TEMP\nexus-llama-help.out" -RedirectStandardError "$env:TEMP\nexus-llama-help.err"
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne $null) {
      # Some builds return non-zero for --help; treat presence of usage text as OK.
      $out = ""
      if (Test-Path "$env:TEMP\nexus-llama-help.out") { $out += Get-Content "$env:TEMP\nexus-llama-help.out" -Raw }
      if (Test-Path "$env:TEMP\nexus-llama-help.err") { $out += Get-Content "$env:TEMP\nexus-llama-help.err" -Raw }
      if ($out -match "usage|llama") {
        Write-Host "OK    $label llama-server --help" -ForegroundColor Green
      } else {
        Write-Host "FAIL  $label llama-server --help failed (exit $($p.ExitCode))" -ForegroundColor Red
        $script:Fail++
      }
    } else {
      Write-Host "OK    $label llama-server --help" -ForegroundColor Green
    }
  } catch {
    Write-Host "FAIL  $label could not launch: $_" -ForegroundColor Red
    $script:Fail++
  }

  $dlls = Get-ChildItem -Path $dir -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
  $joined = ($dlls -join " ").ToLowerInvariant()
  switch ($Name) {
    "cuda" {
      if ($joined -match "cuda|cublas|cudart") {
        Write-Host "OK    $label CUDA-related DLLs detected" -ForegroundColor Green
      } else {
        Write-Host "WARN  $label no cuda/cublas/cudart DLL names found (may still work if static)" -ForegroundColor Yellow
      }
    }
    "vulkan" {
      if ($joined -match "vulkan|ggml") {
        Write-Host "OK    $label Vulkan/ggml libs detected" -ForegroundColor Green
      } else {
        Write-Host "WARN  $label no vulkan/ggml DLL names found" -ForegroundColor Yellow
      }
    }
    "cpu" {
      Write-Host "OK    $label CPU runtime folder checked" -ForegroundColor Green
    }
  }
}

if (-not (Test-Path $BaseDir)) {
  Write-Host "FAIL  runtime root missing: $BaseDir" -ForegroundColor Red
  Write-Host "Run: npm run setup:windows-runtimes"
  exit 1
}

Test-Backend -Name "cpu" -Required
Test-Backend -Name "cuda"
Test-Backend -Name "vulkan"

Write-Host ""
if ($Fail -gt 0) {
  Write-Host "Verification FAILED ($Fail issue(s))." -ForegroundColor Red
  exit 1
}
Write-Host "Verification PASSED." -ForegroundColor Green
exit 0
