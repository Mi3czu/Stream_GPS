$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot

try {
  docker compose -f compose.local.yaml up -d --build
  if ($LASTEXITCODE -ne 0) {
    throw 'Local Stream GPS startup failed.'
  }

  Write-Host 'Stream GPS is starting at http://localhost:8080' -ForegroundColor Green
  Write-Host 'Use: docker compose -f compose.local.yaml ps'
} finally {
  Pop-Location
}
