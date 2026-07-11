<#
.SYNOPSIS
  Deprecated. Installs only the CPU llama.cpp runtime by delegating to the
  unified installer.

.DESCRIPTION
  This wrapper is kept for backwards compatibility. It now calls
  install_llama_cpp_runtimes.ps1 with -SkipCuda -SkipVulkan so the CPU runtime
  is staged into bin\llama.cpp\cpu\ with all required DLLs and verified
  automatically. For full GPU support (CUDA + Vulkan), run the unified installer
  directly without the skip flags.
#>
param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"

Write-Host "install_llama_cpp_cpu.ps1 is deprecated. Delegating to the unified installer (CPU only)." -ForegroundColor Yellow
Write-Host "For GPU runtimes, run: scripts\install_llama_cpp_runtimes.ps1" -ForegroundColor Cyan

$unified = Join-Path $PSScriptRoot "install_llama_cpp_runtimes.ps1"
& $unified -ProjectPath $ProjectPath -SkipCuda -SkipVulkan
