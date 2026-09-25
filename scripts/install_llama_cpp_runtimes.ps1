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
$ProgressPreference = "SilentlyContinue"

# Windows PowerShell / older .NET often default to TLS 1.0/1.1 and fail GitHub
# downloads with "underlying connection was closed" on Invoke-WebRequest.
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11 -bor [Net.SecurityProtocolType]::Tls
} catch {
  # Ignore on hosts that already negotiate TLS correctly.
}

$Target = Join-Path $ProjectPath "bin\llama.cpp"
try {
  New-Item -ItemType Directory -Force -Path $Target -ErrorAction Stop | Out-Null
} catch {
  throw ("Cannot create runtime folder '{0}'. Access Denied or disk full. Choose a writable data folder (e.g. D:\PocketMind) in Settings -> Deployment, then retry. Details: {1}" -f $Target, $_)
}

# Stage downloads under the same writable data root (not locked C:\TEMP).
if (-not $TempRoot) {
  $TempRoot = Join-Path $ProjectPath ".llama_runtime_tmp"
}
try {
  New-Item -ItemType Directory -Force -Path $TempRoot -ErrorAction Stop | Out-Null
} catch {
  throw ("Cannot create temp folder '{0}'. Access Denied or disk full. Choose a writable data folder in Settings -> Deployment. Details: {1}" -f $TempRoot, $_)
}
$script:TempRoot = $TempRoot

# Probe write access before downloading hundreds of MB.
$probe = Join-Path $Target ".pocketmind_write_probe"
try {
  Set-Content -LiteralPath $probe -Value "ok" -Encoding Ascii -ErrorAction Stop
  Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
} catch {
  throw ("Access Denied writing to '{0}'. Lab PCs often block C: writes. Set data root to a writable drive (D:\PocketMind) in Settings -> Deployment. Details: {1}" -f $Target, $_)
}

function Write-Section($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }

function Get-GitHubToken {
  $token = $env:GH_TOKEN
  if (-not $token) { $token = $env:GITHUB_TOKEN }
  return $token
}

function Get-GitHubHeaders {
  $headers = @{
    "User-Agent" = "PocketMind-Hybrid-AI-Installer"
    "Accept" = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
  }
  $token = Get-GitHubToken
  if ($token) {
    $headers["Authorization"] = "Bearer $token"
    Write-Host "GitHub API: using authenticated requests (rate-limit safe)"
  } else {
    Write-Warning "GitHub API: unauthenticated (may hit rate limits on CI shared IPs). Set GH_TOKEN or GITHUB_TOKEN."
  }
  return $headers
}

function Get-CurlExe {
  $cmd = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    "$env:SystemRoot\System32\curl.exe",
    "$env:SystemRoot\SysWOW64\curl.exe"
  )
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return $null
}

function Invoke-GitHubApiJson {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [int]$MaxAttempts = 5
  )
  $headers = Get-GitHubHeaders
  $curl = Get-CurlExe
  $lastError = $null

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
      if ($curl) {
        $curlArgs = @(
          "-fsSL", "--tlsv1.2",
          "--retry", "3", "--retry-delay", "2",
          "--connect-timeout", "30",
          "-A", "PocketMind-Hybrid-AI-Installer",
          "-H", "Accept: application/vnd.github+json",
          "-H", "X-GitHub-Api-Version: 2022-11-28"
        )
        $token = Get-GitHubToken
        if ($token) {
          $curlArgs += @("-H", "Authorization: Bearer $token")
        }
        $curlArgs += $Url
        $raw = & $curl @curlArgs 2>&1
        if ($LASTEXITCODE -ne 0) {
          throw "curl API exit $LASTEXITCODE : $raw"
        }
        if ($raw -is [System.Array]) { $raw = ($raw | Out-String) }
        return ($raw | ConvertFrom-Json)
      }

      return Invoke-RestMethod -Uri $Url -Headers $headers
    } catch {
      $lastError = $_
      Write-Warning ("GitHub API attempt {0}/{1} failed: {2}" -f $attempt, $MaxAttempts, $_.Exception.Message)
      if ($attempt -lt $MaxAttempts) { Start-Sleep -Seconds ([Math]::Min(20, 2 * $attempt)) }
    }
  }

  throw "GitHub API request failed after $MaxAttempts attempts for $Url. Last error: $lastError"
}

function Write-PmProgress {
  param(
    [string]$Phase,
    [string]$Message,
    [int]$Percent = -1,
    [string]$File = "",
    [long]$Downloaded = -1,
    [long]$Total = -1
  )
  $payload = [ordered]@{
    phase = $Phase
    message = $Message
  }
  if ($Percent -ge 0) { $payload.percent = [Math]::Min(100, [Math]::Max(0, $Percent)) }
  if ($File) { $payload.file = $File }
  if ($Downloaded -ge 0) { $payload.downloaded = $Downloaded }
  if ($Total -ge 0) { $payload.total = $Total }
  $json = ($payload | ConvertTo-Json -Compress)
  Write-Host ("##PM_PROGRESS## {0}" -f $json)
}

function Download-FileWithRetry {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [long]$ExpectedSize = 0,
    [int]$MaxAttempts = 6,
    [string]$ProgressLabel = ""
  )

  $curl = Get-CurlExe
  $destDir = Split-Path -Parent $OutFile
  if ($destDir) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
  $label = if ($ProgressLabel) { $ProgressLabel } else { Split-Path -Leaf $OutFile }

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    if (Test-Path -LiteralPath $OutFile) {
      Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
    }

    Write-Host ("  Download attempt {0}/{1}" -f $attempt, $MaxAttempts)
    Write-PmProgress -Phase "download" -Message ("Downloading {0} (attempt {1}/{2})..." -f $label, $attempt, $MaxAttempts) -Percent 0 -File $label -Downloaded 0 -Total $ExpectedSize
    try {
      if ($curl) {
        # Prefer curl.exe: more reliable TLS/redirects than Invoke-WebRequest on
        # Windows PowerShell 5.1 (avoids "connection was closed on a send").
        # Launch as a Process and poll partial file size for UI progress.
        $argList = New-Object System.Collections.Generic.List[string]
        $token = Get-GitHubToken
        if ($token) {
          $argList.Add("-H")
          $argList.Add("Authorization: Bearer $token")
        }
        foreach ($a in @(
          "-fL", "--tlsv1.2",
          "--retry", "5", "--retry-delay", "3",
          "--connect-timeout", "30",
          "-A", "PocketMind-Hybrid-AI-Installer",
          "-o", $OutFile,
          $Url
        )) { $argList.Add($a) }

        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $curl
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardError = $true
        $psi.RedirectStandardOutput = $true
        # Quote args that contain spaces (e.g. Authorization header).
        $psi.Arguments = (($argList | ForEach-Object {
          if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
        }) -join ' ')

        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        [void]$proc.Start()
        while (-not $proc.HasExited) {
          Start-Sleep -Milliseconds 700
          $partial = 0L
          if (Test-Path -LiteralPath $OutFile) {
            try { $partial = [long](Get-Item -LiteralPath $OutFile).Length } catch { $partial = 0L }
          }
          $pct = 0
          if ($ExpectedSize -gt 0 -and $partial -gt 0) {
            $pct = [Math]::Min(99, [int](($partial * 100.0) / $ExpectedSize))
          }
          $mb = if ($partial -gt 0) { "{0:N1}" -f ($partial / 1MB) } else { "0.0" }
          $totalMb = if ($ExpectedSize -gt 0) { "{0:N1}" -f ($ExpectedSize / 1MB) } else { "?" }
          Write-PmProgress -Phase "download" -Message ("Downloading {0}: {1} / {2} MB" -f $label, $mb, $totalMb) `
            -Percent $pct -File $label -Downloaded $partial -Total $ExpectedSize
        }
        $proc.WaitForExit() | Out-Null
        if ($proc.ExitCode -ne 0) {
          $errTail = ""
          try { $errTail = $proc.StandardError.ReadToEnd() } catch { }
          throw ("curl exited with code {0}: {1}" -f $proc.ExitCode, $errTail)
        }
      } else {
        Write-Warning "curl.exe not found; falling back to Invoke-WebRequest (TLS 1.2)."
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
      }

      if (-not (Test-Path -LiteralPath $OutFile)) {
        throw "Download finished but file missing: $OutFile"
      }
      $len = (Get-Item -LiteralPath $OutFile).Length
      if ($len -le 0) {
        throw "Downloaded file is empty: $OutFile"
      }
      if ($ExpectedSize -gt 0 -and $len -lt [Math]::Max(1024, [long]($ExpectedSize * 0.5))) {
        throw ("Downloaded size {0} looks truncated (expected ~{1})" -f $len, $ExpectedSize)
      }
      Write-Host ("  Saved {0:N1} MB -> {1}" -f ($len / 1MB), $OutFile)
      Write-PmProgress -Phase "download" -Message ("Downloaded {0} ({1:N1} MB)" -f $label, ($len / 1MB)) -Percent 100 -File $label -Downloaded $len -Total $(if ($ExpectedSize -gt 0) { $ExpectedSize } else { $len })
      return
    } catch {
      Write-Warning ("  Download failed: {0}" -f $_.Exception.Message)
      if (Test-Path -LiteralPath $OutFile) {
        Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
      }
      if ($attempt -ge $MaxAttempts) {
        $msg = [string]$_.Exception.Message
        if ($msg -match 'Access is denied|UnauthorizedAccess|Permission denied|not enough space|disk full|There is not enough space') {
          throw ("Write/permission failure saving to {0}: {1}. Choose a writable data folder (e.g. D:\PocketMind) in Settings -> Deployment." -f $OutFile, $msg)
        }
        throw ("Failed to download {0} after {1} attempts. Last error: {2}" -f $Url, $MaxAttempts, $msg)
      }
      Start-Sleep -Seconds ([Math]::Min(30, 3 * $attempt))
    }
  }
}

function Get-ReleaseAssets {
  param([string]$Tag)

  if ($Tag) {
    $url = "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$Tag"
    Write-Host "Querying release metadata: $url"
    return Invoke-GitHubApiJson -Url $url
  }

  # IMPORTANT: /releases/latest is currently a stub tag (e.g. v0.2.0) with no
  # Windows binaries. Prefer the newest b##### release that ships win-cpu-x64.
  $listUrl = "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20"
  Write-Host "Querying recent releases: $listUrl"
  $releases = Invoke-GitHubApiJson -Url $listUrl
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
  Write-PmProgress -Phase "install" -Message ("Installing {0} runtime..." -f $BackendName) -Percent 5
  $dest = Join-Path $Target $BackendName
  New-Item -ItemType Directory -Force -Path $dest | Out-Null

  # Stop any running llama-server that may lock DLLs in this backend folder
  # (common when reinstalling CUDA while chat/embeddings still hold ggml-*.dll).
  foreach ($procName in @("llama-server", "llama-server-cpu", "llama-server-cuda", "llama-server-vulkan", "llama-server-metal")) {
    Get-Process -Name $procName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 800
  Get-ChildItem -LiteralPath $dest -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in ".dll", ".exe" } |
    ForEach-Object {
      try { $_.Attributes = "Normal" } catch {}
      $bak = $_.FullName + ".oldpm"
      try {
        if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue }
        Move-Item -LiteralPath $_.FullName -Destination $bak -Force -ErrorAction Stop
        Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue
      } catch {
        try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop } catch {}
      }
    }

  $tmp = Join-Path $script:TempRoot ("nexus_llama_" + $BackendName + "_" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $zips = @()

    $primaryZip = Join-Path $tmp $PrimaryAsset.name
    Write-Host ("Downloading {0} ({1:N1} MB)..." -f $PrimaryAsset.name, ($PrimaryAsset.size / 1MB))
    Download-FileWithRetry -Url $PrimaryAsset.browser_download_url -OutFile $primaryZip -ExpectedSize ([long]$PrimaryAsset.size) -ProgressLabel $PrimaryAsset.name
    $zips += $primaryZip

    if ($CudartAsset) {
      $cudartZip = Join-Path $tmp $CudartAsset.name
      Write-Host ("Downloading {0} ({1:N1} MB) [CUDA runtime DLLs]..." -f $CudartAsset.name, ($CudartAsset.size / 1MB))
      Download-FileWithRetry -Url $CudartAsset.browser_download_url -OutFile $cudartZip -ExpectedSize ([long]$CudartAsset.size) -ProgressLabel $CudartAsset.name
      $zips += $cudartZip
    }

    Write-PmProgress -Phase "extract" -Message ("Extracting {0} archives..." -f $BackendName) -Percent 85
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
        $targetFile = Join-Path $dest $file.Name
        $copied = $false
        for ($attempt = 1; $attempt -le 4 -and -not $copied; $attempt++) {
          try {
            Copy-Item -Path $file.FullName -Destination $targetFile -Force -ErrorAction Stop
            $copied = $true
          } catch {
            if ($attempt -ge 4) { throw }
            Get-Process -ErrorAction SilentlyContinue |
              Where-Object { $_.ProcessName -like 'llama-server*' } |
              Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds (400 * $attempt)
            try {
              if (Test-Path -LiteralPath $targetFile) {
                $bak = $targetFile + ".oldpm"
                if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue }
                Move-Item -LiteralPath $targetFile -Destination $bak -Force -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue
              }
            } catch {}
          }
        }
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
    Write-PmProgress -Phase "complete" -Message ("{0} runtime ready ({1} DLLs)" -f $BackendName, $dllCount) -Percent 100
    return $true
  }
  finally {
    Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Section "PocketMind Hybrid AI llama.cpp runtime installer"
Write-Host "Target: $Target"
Write-PmProgress -Phase "resolve" -Message "Resolving llama.cpp release metadata..." -Percent 2

$release = Get-ReleaseAssets -Tag $Tag
$assets = $release.assets
Write-Host ("Release: {0} ({1} assets)" -f $release.tag_name, $assets.Count)
Write-PmProgress -Phase "resolve" -Message ("Using release {0}" -f $release.tag_name) -Percent 8

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
