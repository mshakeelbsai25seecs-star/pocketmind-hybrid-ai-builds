# Unlock llama.cpp PE files under a resources\llama.cpp (or backend) folder.
# Used by PREPARE-REINSTALL.cmd and can be invoked manually:
#   powershell -File scripts\unlock-llama-cpp.ps1 -Root "D:\PocketMind\resources\llama.cpp"
param(
  [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = "SilentlyContinue"

Get-Process |
  Where-Object { $_.ProcessName -match "^(llama-server|PocketMind)" } |
  Stop-Process -Force

Start-Sleep -Milliseconds 800

if (-not (Test-Path -LiteralPath $Root)) {
  Write-Host "No llama.cpp folder at $Root (nothing to unlock)."
  exit 0
}

Get-CimInstance Win32_Process |
  Where-Object {
    $_.ExecutablePath -and (
      $_.ExecutablePath.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) -or
      $_.ExecutablePath -match "llama-server"
    )
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Sleep -Milliseconds 1000

$n = 0
Get-ChildItem -LiteralPath $Root -Recurse -File |
  Where-Object { $_.Extension -in ".dll", ".exe" } |
  ForEach-Object {
    try { $_.Attributes = "Normal" } catch {}
    $bak = $_.FullName + ".oldpm"
    try {
      if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force }
      Move-Item -LiteralPath $_.FullName -Destination $bak -Force
      Remove-Item -LiteralPath $bak -Force
      $n++
    } catch {
      try {
        Remove-Item -LiteralPath $_.FullName -Force
        $n++
      } catch {
        Write-Warning "Still locked: $($_.FullName)"
      }
    }
  }

Write-Host "Unlocked/removed $n llama.cpp PE file(s) under $Root."
