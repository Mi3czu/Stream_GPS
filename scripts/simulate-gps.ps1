param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z0-9_-]{3,100}$')]
  [string]$DeviceId,

  [ValidatePattern('^https?://')]
  [string]$ApiUrl = 'http://localhost:8080/api/v1/gps/update',

  [ValidateRange(1, 300)]
  [int]$Frames = 30,

  [ValidateRange(0, 60)]
  [int]$IntervalSeconds = 1
)

$apiUri = [Uri]$ApiUrl
$healthUrl = '{0}://{1}/health' -f $apiUri.Scheme, $apiUri.Authority

try {
  $health = Invoke-RestMethod -Method Get -Uri $healthUrl -TimeoutSec 10 -ErrorAction Stop
  if ($health.status -ne 'ok' -or $health.database -ne 'ok') {
    throw "API returned an unhealthy status."
  }
  Write-Host "Stream GPS API is healthy at $healthUrl" -ForegroundColor Green
} catch {
  throw "Stream GPS is not available at $healthUrl. Run .\scripts\start-local.ps1 first. $($_.Exception.Message)"
}

$keyPointer = [IntPtr]::Zero
$secureDeviceKey = Read-Host -AsSecureString 'Device key (input is hidden)'
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureDeviceKey)
$deviceKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
$sentFrames = 0

try {
  $baseLatitude = 52.2297
  $baseLongitude = 21.0122
  $speedPattern = @(3, 5, 8, 12, 20, 30, 45, 60, 80, 100, 120, 90, 65, 45, 25, 15)

  Write-Host "Sending $Frames simulated GPS frames for $DeviceId to $ApiUrl"

  for ($frame = 0; $frame -lt $Frames; $frame++) {
    $speed = $speedPattern[$frame % $speedPattern.Count]
    $latitude = $baseLatitude + ($frame * 0.00045) + ([Math]::Sin($frame / 3) * 0.00015)
    $longitude = $baseLongitude + ($frame * 0.00120)
    $heading = 72 + (($frame % 8) * 3)
    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $nonce = [guid]::NewGuid().ToString()
    $payload = @{
      latitude = [Math]::Round($latitude, 6)
      longitude = [Math]::Round($longitude, 6)
      altitude = 100 + ($frame % 12)
      speed = $speed
      heading = $heading
      accuracy = 4 + ($frame % 4)
      satellites = 10 + ($frame % 5)
      recorded_at = [DateTime]::UtcNow.ToString('o')
    }
    $body = $payload | ConvertTo-Json -Compress
    $headers = @{
      Authorization = "Bearer $deviceKey"
      'X-Device-Id' = $DeviceId
      'X-Request-Timestamp' = $timestamp
      'X-Request-Nonce' = $nonce
    }

    try {
      $response = Invoke-RestMethod -Method Post -Uri $ApiUrl -Headers $headers -ContentType 'application/json' -Body $body -ErrorAction Stop
      $sentFrames += 1
      Write-Host ("[{0}/{1}] {2} km/h  {3}, {4}  {5}" -f ($frame + 1), $Frames, $speed, $payload.latitude, $payload.longitude, $response.status) -ForegroundColor Green
    } catch {
      $responseDetails = $_.ErrorDetails.Message
      throw "Frame $($frame + 1) failed: $($_.Exception.Message) $responseDetails"
    }

    if ($frame -lt ($Frames - 1) -and $IntervalSeconds -gt 0) {
      Start-Sleep -Seconds $IntervalSeconds
    }
  }
} finally {
  if ($keyPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  }
  Remove-Variable deviceKey -ErrorAction SilentlyContinue
}

Write-Host "Simulation complete: $sentFrames/$Frames GPS frames accepted." -ForegroundColor Cyan
