param(
  [string]$DataRoot = "C:\ProgramData\PocketMind"
)

$ErrorActionPreference = "Stop"

$folders = @(
  "$DataRoot",
  "$DataRoot\models",
  "$DataRoot\models\embeddings",
  "$DataRoot\company-data",
  "$DataRoot\company-data\intake",
  "$DataRoot\exports",
  "$DataRoot\indexes",
  "$DataRoot\knowledge-chat"
)

Write-Host "Preparing PocketMind Hybrid AI server folders under $DataRoot"
foreach ($folder in $folders) {
  if (-not (Test-Path $folder)) {
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    Write-Host "Created $folder"
  } else {
    Write-Host "Exists  $folder"
  }
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Copy GGUF models to $DataRoot\models"
Write-Host "2. Copy embedding model to $DataRoot\models\embeddings"
Write-Host "3. Copy company SOC data to $DataRoot\company-data"
Write-Host "4. Set NEXUS_DATA_ROOT=$DataRoot (optional)"
Write-Host "5. Launch PocketMind Hybrid AI and open Settings -> Deployment"
