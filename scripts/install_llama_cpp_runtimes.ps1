<#
.SYNOPSIS
  Download and stage llama.cpp Windows runtimes (CPU + CUDA + Vulkan) into the
  bin\llama.cpp\{cpu,cuda,vulkan} layout that PocketMind Hybrid AI expects.

.DESCRIPTION
  Queries the official ggml-org/llama.cpp GitHub releases, downloads the Windows
  x64 runtime archives, and copies llama-server.exe plus all required DLLs into
  the matching backend subfolder. For CUDA it also merges the separate
  cudart-*.zip runtime DLLs (downloading only the main CUDA archive is a common
  failure mode that leaves the runtime unable to start).

  Each backend lives in its own folder so DLLs are never mixed between runtimes.

.PARAMETER ProjectPath
  Repo root. Defaults to the parent of this script's folder.

.PARAMETER Tag
  Optional release tag to pin (for example b7525). Defaults to the latest release.

.PARAMETER CudaVersion
  Preferred CUDA build to install (12.4 or 13.1). Falls back to whichever CUDA
  asset is available if the preferred one is absent.

.PARAMETER SkipCuda
  Skip the CUDA runtime (saves ~580 MB of downloads).

.PARAMETER SkipVulkan
  Skip the Vulkan runtime.

.PARAMETER TempRoot
  Folder used for downloading and extracting archives. Defaults to a folder on
  the same drive as the project so the system drive (often space-constrained)
  is not used for multi-hundred-MB staging.

.EXAMPLE
  pwsh -File scripts\install_llama_cpp_runtimes.ps1

.EXAMPLE
  pwsh -File scripts\install_llama_cpp_runtimes.ps1 -Tag b7525 -CudaVersion 12.4
#>
param(
  [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
  [string]$Tag = "",
  [ValidateSet("12.4", "13.1")]
  [string]$CudaVersion = "12.4",
  [switch]$SkipCuda,
  [switch]$SkipVulkan,
  [switch]$SkipCpu,
  [string]$TempRoot = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # faster Invoke-WebRequest downloads

$Target = Join-Path $ProjectPath "bin\llama.cpp"
New-Item -ItemType Directory -Force -Path $Target | Out-Null

# Stage downloads on the project drive by default. The system drive may be too
# small for the CUDA archives (~580 MB combined).
if (-not $TempRoot) {
  $TempRoot = Join-Path $ProjectPath ".llama_runtime_tmp"
}
New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null
$script:TempRoot = $TempRoot

function Write-Section($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }

function Get-GitHubHeaders {
  $headers = @{
    "User-Agent" = "PocketMind-Hybrid-AI-Installer"
    "Accept" = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
  }
  $token = $env:GH_TOKEN
  if (-not $token) { $token = $env:GITHUB_TOKEN }
  if ($token) {
    $headers["Authorization"] = "Bearer $token"
    Write-Host "GitHub API: using authenticated requests (rate-limit safe)"
  } else {
    Write-Warning "GitHub API: unauthenticated (may hit rate limits on CI shared IPs). Set GH_TOKEN or GITHUB_TOKEN."
  }
  return $headers
}

function Get-ReleaseAssets {
  param([string]$Tag)
  $headers = Get-GitHubHeaders

  if ($Tag) {
    $url = "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$Tag"
    Write-Host "Querying release metadata: $url"
    return Invoke-RestMethod -Uri $url -Headers $headers
  }

  # IMPORTANT: /releases/latest is currently a stub tag (e.g. v0.2.0) with no
  # Windows binaries. Prefer the newest b##### release that ships win-cpu-x64.
  $listUrl = "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20"
  Write-Host "Querying recent releases: $listUrl"
  $releases = Invoke-RestMethod -Uri $listUrl -Headers $headers
  foreach ($release in $releases) {
    $tagName = [string]$release.tag_name
    $assets = @($release.assets)
    $hasCpu = $assets | Where-Object {
      $_.name -match 'bin-win-cpu-x64' -and $_.name -like '*.zip'
    } | Select-Object -First 1
    if ($tagName -match '^b\d+' -and $hasCpu) {
      Write-Host "Selected release: $tagName ($($assets.Count) assets)"
      return $release
    }
  }

  throw "Could not find a llama.cpp release with Windows CPU x64 binaries (bin-win-cpu-x64). Pass -Tag b10615 (or newer)."
}

function Find-Asset {
  param($Assets, [string[]]$MustContain, [string[]]$MustNotContain = @())
  foreach ($asset in $Assets) {
    $name = $asset.name.ToLower()
    $ok = $true
    foreach ($needle in $MustContain) {
      if (-not $name.Contains($needle.ToLower())) { $ok = $false; break }
    }
    if ($ok) {
      foreach ($bad in $MustNotContain) {
        if ($name.Contains($bad.ToLower())) { $ok = $false; break }
      }
    }
    if ($ok) { return $asset }
  }
  return $null
}

function Install-Backend {
  param(
    [string]$BackendName,        # cpu | cuda | vulkan
    $PrimaryAsset,               # GitHub asset object for the main runtime zip
    $CudartAsset                 # optional GitHub asset for CUDA runtime DLLs
  )

  Write-Section "Installing $BackendName runtime"
  $dest = Join-Path $Target $BackendName
  New-Item -ItemType Directory -Force -Path $dest | Out-Null

  $tmp = Join-Path $script:TempRoot ("nexus_llama_" + $BackendName + "_" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $zips = @()

    $primaryZip = Join-Path $tmp $PrimaryAsset.name
    Write-Host ("Downloading {0} ({1:N1} MB)..." -f $PrimaryAsset.name, ($PrimaryAsset.size / 1MB))
    Invoke-WebRequest -Uri $PrimaryAsset.browser_download_url -OutFile $primaryZip -UseBasicParsing
    $zips += $primaryZip

    if ($CudartAsset) {
      $cudartZip = Join-Path $tmp $CudartAsset.name
      Write-Host ("Downloading {0} ({1:N1} MB) [CUDA runtime DLLs]..." -f $CudartAsset.name, ($CudartAsset.size / 1MB))
      Invoke-WebRequest -Uri $CudartAsset.browser_download_url -OutFile $cudartZip -UseBasicParsing
      $zips += $cudartZip
    }

    foreach ($zip in $zips) {
      $extractDir = Join-Path $tmp ("x_" + [System.IO.Path]::GetFileNameWithoutExtension($zip))
      Expand-Archive -Path $zip -DestinationPath $extractDir -Force

      # llama.cpp zips usually place binaries in a build\bin folder; some place them
      # at the archive root. Copy every .exe and .dll we find into the backend folder.
      $files = Get-ChildItem -Path $extractDir -Recurse -Include *.exe, *.dll -File
      if (-not $files -or $files.Count -eq 0) {
        Write-Warning "No .exe/.dll found in $zip"
      }
      foreach ($file in $files) {
        Copy-Item -Path $file.FullName -Destination (Join-Path $dest $file.Name) -Force
      }
    }

    $server = Join-Path $dest "llama-server.exe"
    if (-not (Test-Path $server)) {
      Write-Warning "${BackendName}: llama-server.exe not found after extraction."
      return $false
    }

    # Verify the runtime can at least start and print help.
    Write-Host "Verifying $BackendName runtime..."
    $verified = $false
    try {
      $out = & $server "--help" 2>&1
      if ($LASTEXITCODE -eq 0) { $verified = $true }
    } catch {
      Write-Warning "$BackendName verification raised: $_"
    }

    $dllCount = (Get-ChildItem -Path $dest -Filter *.dll -File | Measure-Object).Count
    if ($verified) {
      Write-Host ("OK: {0} -> {1} (+{2} DLLs)" -f $BackendName, $server, $dllCount) -ForegroundColor Green
    } else {
      Write-Warning ("$BackendName runtime staged but --help did not exit cleanly. It may still work, or may need GPU drivers present at runtime. DLLs: $dllCount")
    }
    return $true
  }
  finally {
    Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Section "PocketMind Hybrid AI llama.cpp runtime installer"
Write-Host "Target: $Target"

$release = Get-ReleaseAssets -Tag $Tag
$assets = $release.assets
Write-Host ("Release: {0} ({1} assets)" -f $release.tag_name, $assets.Count)

$summary = @()

# CPU
if (-not $SkipCpu) {
  $cpuAsset = Find-Asset -Assets $assets -MustContain @("bin-win-cpu-x64", ".zip")
  if ($cpuAsset) {
    $ok = Install-Backend -BackendName "cpu" -PrimaryAsset $cpuAsset
    $summary += [pscustomobject]@{ Backend = "cpu"; Installed = $ok }
  } else {
    Write-Warning "Could not find a Windows CPU x64 asset in release $($release.tag_name)."
    $summary += [pscustomobject]@{ Backend = "cpu"; Installed = $false }
  }
} else {
  Write-Host "Skipping CPU (--SkipCpu)."
}

# Vulkan (cross-vendor GPU)
if (-not $SkipVulkan) {
  $vulkanAsset = Find-Asset -Assets $assets -MustContain @("bin-win-vulkan-x64", ".zip")
  if ($vulkanAsset) {
    $ok = Install-Backend -BackendName "vulkan" -PrimaryAsset $vulkanAsset
    $summary += [pscustomobject]@{ Backend = "vulkan"; Installed = $ok }
  } else {
    Write-Warning "Could not find a Windows Vulkan x64 asset."
    $summary += [pscustomobject]@{ Backend = "vulkan"; Installed = $false }
  }
} else {
  Write-Host "Skipping Vulkan (--SkipVulkan)."
}

# CUDA (NVIDIA) + cudart runtime DLLs
if (-not $SkipCuda) {
  $cudaToken = "bin-win-cuda-$CudaVersion-x64"
  # The main CUDA runtime and the cudart DLL package share the same token, so the
  # primary lookup must exclude "cudart" to avoid grabbing the DLL-only archive.
  $cudaAsset = Find-Asset -Assets $assets -MustContain @($cudaToken, ".zip") -MustNotContain @("cudart")
  $cudartAsset = Find-Asset -Assets $assets -MustContain @("cudart-llama-bin-win-cuda-$CudaVersion", ".zip")

  # Fallback: any available CUDA build if the preferred version is missing.
  if (-not $cudaAsset) {
    $cudaAsset = Find-Asset -Assets $assets -MustContain @("bin-win-cuda", "x64", ".zip") -MustNotContain @("cudart")
    if ($cudaAsset) {
      Write-Warning "Preferred CUDA $CudaVersion not found; using $($cudaAsset.name)."
      if ($cudaAsset.name -match "cuda-([0-9.]+)-x64") {
        $foundVer = $Matches[1]
        $cudartAsset = Find-Asset -Assets $assets -MustContain @("cudart-llama-bin-win-cuda-$foundVer", ".zip")
      }
    }
  }

  if ($cudaAsset) {
    if (-not $cudartAsset) {
      Write-Warning "CUDA runtime DLL package (cudart-*.zip) not found. The CUDA runtime may fail to start without it."
    }
    $ok = Install-Backend -BackendName "cuda" -PrimaryAsset $cudaAsset -CudartAsset $cudartAsset
    $summary += [pscustomobject]@{ Backend = "cuda"; Installed = $ok }
  } else {
    Write-Warning "Could not find a Windows CUDA x64 asset."
    $summary += [pscustomobject]@{ Backend = "cuda"; Installed = $false }
  }
} else {
  Write-Host "Skipping CUDA (--SkipCuda)."
}

Write-Section "Summary"
$summary | Format-Table -AutoSize
Write-Host "`nInstalled under: $Target" -ForegroundColor Cyan
Write-Host "PocketMind Hybrid AI will auto-discover these on next launch. Set the Runtime profile to Automatic Optimizer for GPU/CPU auto-fit." -ForegroundColor Cyan
