#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ManifestPath = Join-Path $Root 'src-tauri\resources\tooling\MANIFEST.json'
$OutRoot = Join-Path $Root 'src-tauri\resources\tooling'
$Target = if ($env:POCKETMIND_TOOLING_TARGET) { $env:POCKETMIND_TOOLING_TARGET } else { 'x86_64-pc-windows-msvc' }
if (-not (Test-Path $ManifestPath)) { throw "MANIFEST missing: $ManifestPath" }
$manifest = Get-Content -Raw $ManifestPath | ConvertFrom-Json

function Get-Sha256([string]$Path) {
  (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function Expand-AnyArchive([string]$Archive, [string]$Dest) {
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  if ($Archive -match '\.zip$') {
    Expand-Archive -Path $Archive -DestinationPath $Dest -Force
  } else {
    tar -xf $Archive -C $Dest
  }
}

function Fetch-Tool([string]$Name, $Spec) {
  $t = $Spec.targets.$Target
  if (-not $t) {
    Write-Warning "No $Name entry for target $Target - skip"
    return
  }
  $ver = $Spec.version
  $destDir = Join-Path $OutRoot "$Name\$ver\$Target"
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  $tmp = Join-Path $env:TEMP ('pm-tooling-' + [guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $ext = if ($t.url -match '\.zip$') { '.zip' } else { '.tar.gz' }
    $archive = Join-Path $tmp ("archive$ext")
    Write-Host "Downloading $Name $ver ($Target)..."
    Invoke-WebRequest -Uri $t.url -OutFile $archive -UseBasicParsing

    if ($t.sha256_url) {
      $shaResp = Invoke-WebRequest -Uri $t.sha256_url -UseBasicParsing
      if ($shaResp.Content -is [byte[]]) {
        $shaText = [Text.Encoding]::UTF8.GetString($shaResp.Content)
      } else {
        $shaText = [string]$shaResp.Content
      }
      $hex = [regex]::Match($shaText, '(?im)\b([a-f0-9]{64})\b')
      if (-not $hex.Success) { throw ("{0}: could not parse SHA-256 from {1}" -f $Name, $t.sha256_url) }
      $expected = $hex.Groups[1].Value.ToLowerInvariant()
      $actual = Get-Sha256 $archive
      if ($expected -ne $actual) { throw "$Name SHA-256 mismatch: expected $expected got $actual" }
    } elseif ($Spec.shasums_url) {
      $baseName = Split-Path -Leaf ([uri]$t.url).AbsolutePath
      $sumsResp = Invoke-WebRequest -Uri $Spec.shasums_url -UseBasicParsing
      if ($sumsResp.Content -is [byte[]]) {
        $sums = [Text.Encoding]::UTF8.GetString($sumsResp.Content)
      } else {
        $sums = [string]$sumsResp.Content
      }
      $line = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($baseName) } | Select-Object -First 1)
      if (-not $line) { throw "No SHASUMS line for $baseName" }
      $expected = (($line.Trim() -split '\s+')[0]).ToLowerInvariant()
      $actual = Get-Sha256 $archive
      if ($expected -ne $actual) { throw "$Name SHA-256 mismatch: expected $expected got $actual" }
    }

    $extract = Join-Path $tmp 'extract'
    Expand-AnyArchive $archive $extract
    $binaryName = $t.binary
    $srcBin = $null
    if ($t.archive_binary) {
      $candidate = Join-Path $extract (($t.archive_binary -replace '/', '\'))
      if (Test-Path $candidate) { $srcBin = $candidate }
    }
    if (-not $srcBin) {
      $found = Get-ChildItem -Path $extract -Recurse -Filter $binaryName | Select-Object -First 1
      if ($found) { $srcBin = $found.FullName }
    }
    if (-not $srcBin) { throw "Could not find $binaryName in archive for $Name" }

    Get-ChildItem $destDir -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    if ($Name -eq 'python') {
      Copy-Item -Path (Join-Path $extract '*') -Destination $destDir -Recurse -Force
      $pth = Get-ChildItem $destDir -Filter 'python*._pth' | Select-Object -First 1
      if ($pth) {
        $content = Get-Content -Raw -Path $pth.FullName
        $content = $content -replace '(?m)^#\s*import site\s*$', 'import site'
        if ($content -notmatch 'import site') {
          $nl = [Environment]::NewLine
          $content = $content.TrimEnd() + $nl + 'import site' + $nl
        }
        Set-Content -Path $pth.FullName -Value $content -NoNewline
      }
    } else {
      Copy-Item -Path $srcBin -Destination (Join-Path $destDir $binaryName) -Force
    }
    Write-Host "OK $Name -> $destDir"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

Fetch-Tool 'ripgrep' $manifest.tools.ripgrep
Fetch-Tool 'python' $manifest.tools.python
Fetch-Tool 'node' $manifest.tools.node
Write-Host "Tooling fetch complete for $Target"
