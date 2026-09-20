$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot

try {
  docker compose -f compose.local.yaml down
} finally {
  Pop-Location
}
