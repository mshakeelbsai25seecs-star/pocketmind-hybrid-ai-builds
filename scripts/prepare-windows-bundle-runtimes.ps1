#Requires -Version 5.1
<#
.SYNOPSIS
  Download llama.cpp CPU/CUDA/Vulkan runtimes and stage them into
  src-tauri/resources/llama.cpp so the Tauri NSIS/MSI installer embeds them.

.DESCRIPTION
  After this runs, `npm run tauri build` produces a setup.exe that installs a
  complete app folder: PocketMind Hybrid AI.exe + resources/llama.cpp/{cpu,cuda,vulkan}.
  Microsoft Store users then only need that one setup package (models still separate).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\prepare-windows-bundle-runtimes.ps1
#>
[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [string]$TempRoot = "D:\DevCache\llama-runtime-tmp",
  [switch]$SkipCuda,
  [switch]$SkipVulkan,
  [switch]$SkipDownload,
  [string]$Tag = ""
)

$ErrorActionPreference = "Stop"

if (-not $ProjectRoot) {
  $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$installScript = Join-Path $ProjectRoot "scripts\install_llama_cpp_runtimes.ps1"
$binRoot = Join-Path $ProjectRoot "bin\llama.cpp"
$resourceRoot = Join-Path $ProjectRoot "src-tauri\resources\llama.cpp"

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Assert-Backend([string]$Name) {
  $server = Join-Path $binRoot "$Name\llama-server.exe"
  if (-not (Test-Path -LiteralPath $server)) {
    throw "Missing required runtime: $server"
  }
  $dlls = @(Get-ChildItem -LiteralPath (Join-Path $binRoot $Name) -Filter *.dll -File -ErrorAction SilentlyContinue)
  Write-Host "  OK ${Name}: llama-server.exe + $($dlls.Count) DLL(s)"
}

# ASCII-only banner: PowerShell 5.1 mis-parses UTF-8 em dashes without BOM.
Write-Host "PocketMind - prepare Windows bundled llama.cpp runtimes" -ForegroundColor Green
Write-Host "  Project:   $ProjectRoot"
Write-Host "  Bin:       $binRoot"
Write-Host "  Resources: $resourceRoot"

if (-not $SkipDownload) {
  if (-not (Test-Path -LiteralPath $installScript)) {
    throw "Installer script not found: $installScript"
  }
  Write-Step "Downloading / refreshing runtimes into bin\llama.cpp"
  New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null
  $args = @{
    ProjectPath = $ProjectRoot
    TempRoot = $TempRoot
  }
  if ($Tag) { $args.Tag = $Tag }
  if ($SkipCuda) { $args.SkipCuda = $true }
  if ($SkipVulkan) { $args.SkipVulkan = $true }
  & $installScript @args
}

Assert-Backend "cpu"
if (-not $SkipCuda) {
  if (Test-Path -LiteralPath (Join-Path $binRoot "cuda\llama-server.exe")) {
    Assert-Backend "cuda"
  } else {
    Write-Warning "CUDA runtime not present under bin\llama.cpp\cuda (CPU/Vulkan only build)."
  }
}
if (-not $SkipVulkan) {
  if (Test-Path -LiteralPath (Join-Path $binRoot "vulkan\llama-server.exe")) {
    Assert-Backend "vulkan"
  } else {
    Write-Warning "Vulkan runtime not present under bin\llama.cpp\vulkan."
  }
}

Write-Step "Syncing bin\llama.cpp -> src-tauri\resources\llama.cpp (for Tauri bundle)"
if (Test-Path -LiteralPath $resourceRoot) {
  Remove-Item -LiteralPath $resourceRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $resourceRoot | Out-Null

foreach ($backend in @("cpu", "cuda", "vulkan")) {
  $src = Join-Path $binRoot $backend
  if (-not (Test-Path -LiteralPath $src)) { continue }
  $dst = Join-Path $resourceRoot $backend
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force
  $count = (Get-ChildItem -LiteralPath $dst -File -Recurse | Measure-Object).Count
  Write-Host "  Synced $backend ($count files)"
}

$manifest = @(
  "PocketMind bundled llama.cpp runtimes",
  ("PreparedUtc=" + [DateTime]::UtcNow.ToString("o")),
  ("ProjectRoot=" + $ProjectRoot)
)
foreach ($backend in @("cpu", "cuda", "vulkan")) {
  $server = Join-Path $resourceRoot "$backend\llama-server.exe"
  if (Test-Path -LiteralPath $server) {
    $item = Get-Item -LiteralPath $server
    $manifest += "$backend=present size=$($item.Length)"
  } else {
    $manifest += "$backend=absent"
  }
}
Set-Content -Path (Join-Path $resourceRoot "BUNDLE_MANIFEST.txt") -Value $manifest -Encoding UTF8

$sizeMb = [math]::Round(((Get-ChildItem -LiteralPath $resourceRoot -Recurse -File | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
Write-Host "`nBundled runtime payload: $sizeMb MB under src-tauri\resources\llama.cpp" -ForegroundColor Green
Write-Host "Next: npm run tauri build   (NSIS/MSI will embed these runtimes)"
Write-Host "Store users install one setup.exe; no separate bin download required."
Write-Host "GGUF models remain user-provided (too large to embed)."
