$ErrorActionPreference = "Stop"

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$defaultUrl = "https://workspaceapi-server-production-e61f.up.railway.app/"

Set-Location $workspaceRoot

Write-Host ""
Write-Host "Codex workspace bootstrap" -ForegroundColor Cyan
Write-Host "Workspace: $workspaceRoot"
Write-Host "Default URL: $defaultUrl"
Write-Host ""

try {
  $ghVersion = (& gh --version | Select-Object -First 1)
  Write-Host "GitHub CLI: $ghVersion" -ForegroundColor Green
} catch {
  Write-Host "GitHub CLI not available on PATH" -ForegroundColor Yellow
}

try {
  $railwayVersion = (& railway --version | Select-Object -First 1)
  Write-Host "Railway CLI: $railwayVersion" -ForegroundColor Green
} catch {
  Write-Host "Railway CLI not available on PATH" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Codex in-app browser default URL:" -ForegroundColor Cyan
Write-Host $defaultUrl -ForegroundColor White
Write-Host ""
Write-Host "Ready." -ForegroundColor Green
