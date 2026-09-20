param(
  [string]$OutputDirectory = (Join-Path (Get-Location) 'backups')
)

$resolvedOutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $resolvedOutputDirectory | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupFile = Join-Path $resolvedOutputDirectory "stream-gps-$timestamp.dump"

Write-Host "Creating PostgreSQL backup: $backupFile"
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = 'docker'
$startInfo.Arguments = 'compose exec -T postgres pg_dump -U stream_gps -d stream_gps --format=custom'
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true

$process = [System.Diagnostics.Process]::Start($startInfo)
$outputStream = [System.IO.File]::Open($backupFile, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$exitCode = $null
try {
  $process.StandardOutput.BaseStream.CopyTo($outputStream)
  $process.WaitForExit()
  $exitCode = $process.ExitCode
} finally {
  $outputStream.Dispose()
  $process.Dispose()
}

if ($exitCode -ne 0) {
  throw "PostgreSQL backup failed. The partial backup file, if any, is: $backupFile"
}

Write-Host "Backup created successfully: $backupFile" -ForegroundColor Green
