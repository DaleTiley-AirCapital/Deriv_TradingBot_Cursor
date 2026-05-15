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

  $railwayStatusOutput = ""
  $railwayStatusSucceeded = $false
  try {
    $railwayStatusOutput = (& railway status 2>&1 | Out-String)
    $railwayStatusSucceeded = ($LASTEXITCODE -eq 0)
  } catch {
    $railwayStatusOutput = ($_ | Out-String)
  }

  if ($railwayStatusSucceeded) {
    Write-Host "Railway auth: ready" -ForegroundColor Green
  } elseif ($railwayStatusOutput -match "Unauthorized|railway login|invalid_grant|Token refresh failed") {
    Write-Host "Railway auth needs refresh. Starting railway login..." -ForegroundColor Yellow
    & railway login
  } else {
    Write-Host "Railway status check did not complete cleanly:" -ForegroundColor Yellow
    Write-Host $railwayStatusOutput.Trim() -ForegroundColor DarkYellow
  }
} catch {
  Write-Host "Railway CLI not available on PATH" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Codex in-app browser default URL:" -ForegroundColor Cyan
Write-Host $defaultUrl -ForegroundColor White
Write-Host ""
Write-Host "Ready." -ForegroundColor Green
