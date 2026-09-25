#Requires -Version 5.1
<#
.SYNOPSIS
  Offline checks for Automatic Optimizer / CUDA offload policy (no NVIDIA GPU required).

.DESCRIPTION
  Validates that runtime discovery search roots, weak-iGPU heuristics, and Store
  CPU-only packaging policy stay intact. Lab confirmation with a real NVIDIA GPU
  is still required for end-to-end offload.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\verify-gpu-offload-policy.ps1
#>
[CmdletBinding()]
param(
  [string]$ProjectRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
Set-Location -LiteralPath $ProjectRoot

$failed = 0
function Assert-True([bool]$Cond, [string]$Msg) {
  if ($Cond) {
    Write-Host "PASS  $Msg" -ForegroundColor Green
  } else {
    Write-Host "FAIL  $Msg" -ForegroundColor Red
    $script:failed++
  }
}

Write-Host "PocketMind GPU offload policy checks (offline)" -ForegroundColor Cyan

$discovery = Join-Path $ProjectRoot "src-tauri\src\llm\runtime_discovery.rs"
$hardware = Join-Path $ProjectRoot "src-tauri\src\hardware.rs"
$commands = Join-Path $ProjectRoot "src-tauri\src\commands.rs"
$manifest = Join-Path $ProjectRoot "distribution\windows-desktop\msix\Package.appxmanifest"

Assert-True (Test-Path -LiteralPath $discovery) "runtime_discovery.rs present"
Assert-True (Test-Path -LiteralPath $hardware) "hardware.rs present"

$disc = Get-Content -LiteralPath $discovery -Raw
Assert-True ($disc -match 'data_root_search_paths') "CUDA discovery searches multiple data roots"
Assert-True ($disc -match 'D:\\PocketMind') "D:\\PocketMind included in data-root search"
Assert-True ($disc -match 'has_usable_cuda_runtime') "usable CUDA runtime helper exists"
Assert-True ($disc -match 'gpu_looks_nvidia') "NVIDIA name heuristic exists"
Assert-True ($disc -match 'prefer_cpu = weak_igpu_only\(\) && !nvidia_ok') "weak-iGPU cannot override NVIDIA/CUDA"
Assert-True ($disc -match 'set_last_launch_status') "last launch status recorded for UI"

$hw = Get-Content -LiteralPath $hardware -Raw
Assert-True ($hw -match 'is_cuda_capable: vendor == "NVIDIA"') "DXGI NVIDIA adapters marked CUDA-capable"

$cmd = Get-Content -LiteralPath $commands -Raw
Assert-True ($cmd -match 'cuda_runtime_found') "GPU report exposes cuda_runtime_found"
Assert-True ($cmd -match 'active_backend') "GPU report exposes active_backend"
Assert-True ($cmd -match 'GPU runtime present; dedicated VRAM size unknown') "Auto plan stays GPU-first when VRAM unknown"

# Store package must remain CPU-only (no cuda/ under staged resources policy scripts).
$stage = Join-Path $ProjectRoot "distribution\windows-desktop\msix\stage-msix-layout.ps1"
Assert-True (Test-Path -LiteralPath $stage) "MSIX stage script present"
$stageText = Get-Content -LiteralPath $stage -Raw
Assert-True ($stageText -match 'Remove-BannedLlamaBackends|Assert-NoBannedLlamaBackends|cuda') "MSIX stage still strips/refuses cuda"

$ver = Select-String -Path $manifest -Pattern 'Version="([0-9.]+)"' | ForEach-Object { $_.Matches[0].Groups[1].Value } | Select-Object -First 1
Write-Host "MSIX Identity Version: $ver"
Assert-True ([version]$ver -ge [version]"1.0.5.0") "MSIX version >= 1.0.5.0 for Partner Center upload"

Write-Host ""
Write-Host "Lab confirmation still needed:" -ForegroundColor Yellow
Write-Host "  1) Install CUDA runtime from Home / Hardware on a machine with NVIDIA"
Write-Host "  2) Set Automatic Optimizer, load a small GGUF, confirm Offload status shows backend=cuda and ngl>0"
Write-Host "  3) CPU Safe must still force ngl=0"

if ($failed -gt 0) {
  throw "$failed offline GPU offload policy check(s) failed"
}
Write-Host "`nAll offline checks passed." -ForegroundColor Green
