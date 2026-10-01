# Shows a one-time pairing code for a phone, the same one the Devices view shows: opens the QR
# and prints the link. The code works once, for 5 minutes. The console must be running.
$ErrorActionPreference = 'Stop'
$consoleHome = if ($env:WORK_CONSOLE_HOME) { $env:WORK_CONSOLE_HOME } else { Join-Path $env:USERPROFILE '.work-console' }
$port = 7410
$cfgFile = Join-Path $consoleHome 'config.json'
if (Test-Path $cfgFile) { $cfg = Get-Content -Raw $cfgFile | ConvertFrom-Json; if ($cfg.loopbackPort) { $port = $cfg.loopbackPort } }

$r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/pair/new" -ContentType 'application/json' -Body '{}'
$svg = Join-Path $env:TEMP 'work-console-pair.svg'
[IO.File]::WriteAllText($svg, $r.qr)
Start-Process $svg
Write-Host "scan the QR, or open on the phone: $($r.url)"
Write-Host "works once, until $(([datetime]$r.expires).ToLocalTime().ToString('HH:mm'))"
