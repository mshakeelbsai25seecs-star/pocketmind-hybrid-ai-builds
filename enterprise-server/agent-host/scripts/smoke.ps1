# Smoke: health + preloaded provision + list_dir
param(
    [string]$BaseUrl = "http://127.0.0.1:8788",
    [string]$Token = $env:AGENT_HOST_TOKEN,
    [string]$ServerPath = ""
)

$ErrorActionPreference = "Stop"

if (-not $Token) {
    Write-Error "Set AGENT_HOST_TOKEN or pass -Token"
}

$headers = @{
    Authorization = "Bearer $Token"
    Accept        = "application/json"
}

Write-Host "== health =="
$health = Invoke-RestMethod -Uri "$BaseUrl/v1/agent/health" -Method GET
$health | ConvertTo-Json -Compress
if (-not $health.ok) { throw "health failed" }

if (-not $ServerPath) {
    $ServerPath = Join-Path $env:TEMP ("pm-agent-host-smoke-" + [guid]::NewGuid().ToString("n"))
    New-Item -ItemType Directory -Path $ServerPath | Out-Null
    Set-Content -Path (Join-Path $ServerPath "hello.txt") -Value "pocketmind smoke"
}

Write-Host "== provision/preloaded =="
$body = @{
    server_path = $ServerPath
    read_only   = $false
} | ConvertTo-Json
$prov = Invoke-RestMethod -Uri "$BaseUrl/v1/workspaces/provision/preloaded" `
    -Method POST -Headers ($headers + @{ "Content-Type" = "application/json" }) -Body $body
$prov | ConvertTo-Json -Compress
$wid = $prov.workspaceId
if (-not $wid) { throw "missing workspaceId" }

Write-Host "== tools/list_dir =="
$toolBody = @{
    workspace_id = $wid
    path         = "."
} | ConvertTo-Json
$list = Invoke-RestMethod -Uri "$BaseUrl/v1/agent/tools/list_dir" `
    -Method POST -Headers ($headers + @{ "Content-Type" = "application/json" }) -Body $toolBody
$list | ConvertTo-Json -Compress

Write-Host "OK workspaceId=$wid"
