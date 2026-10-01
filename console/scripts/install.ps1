# One-time setup of the Work Console on your PC, run in your own session:
#   1. installs packages and builds the page;
#   2. makes the local CA and the LAN certificate in <home>\tls (the CA is kept on re-runs);
#   3. opens the LAN port in the firewall for private networks (only when run elevated;
#      otherwise prints the command);
#   4. registers the WorkConsole scheduled task: at logon, as this user, restarted by run.ps1.
# Re-running it is safe; after a LAN address change it reissues the certificate.
$ErrorActionPreference = 'Stop'
$pkg = Split-Path $PSScriptRoot -Parent
$consoleHome = if ($env:WORK_CONSOLE_HOME) { $env:WORK_CONSOLE_HOME } else { Join-Path $env:USERPROFILE '.work-console' }
$taskName = 'WorkConsole'

$node = (Get-Command node -ErrorAction Stop).Source
$ver = [version]((& $node --version).TrimStart('v'))
if ($ver -lt [version]'22.6') { throw "Node $ver is too old: the backend runs TypeScript directly and needs 22.6 or newer." }

New-Item -ItemType Directory -Force $consoleHome | Out-Null
$loopPort = 7410; $lanPort = 7411
$cfgFile = Join-Path $consoleHome 'config.json'
if (Test-Path $cfgFile) {
    $cfg = Get-Content -Raw $cfgFile | ConvertFrom-Json
    if ($cfg.loopbackPort) { $loopPort = $cfg.loopbackPort }
    if ($cfg.lanPort) { $lanPort = $cfg.lanPort }
}

Push-Location $pkg
try {
    npm ci
    if ($LASTEXITCODE) { throw 'npm ci failed' }
    npm run build
    if ($LASTEXITCODE) { throw 'the build failed' }
    & $node --experimental-strip-types --no-warnings=ExperimentalWarning server/tls/mkcert.ts $consoleHome
    if ($LASTEXITCODE) { throw 'the certificate step failed' }
} finally { Pop-Location }

$ruleName = 'Work Console (LAN)'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$ruleCmd = "New-NetFirewallRule -DisplayName '$ruleName' -Direction Inbound -Protocol TCP -LocalPort $lanPort -Profile Private -Action Allow"
if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) { Write-Host "firewall rule '$ruleName' already exists" }
elseif ($admin) { Invoke-Expression $ruleCmd | Out-Null; Write-Host "firewall: opened TCP $lanPort on private networks" }
else { Write-Host "firewall: not elevated, so the phone may not reach port $lanPort. From an elevated PowerShell run:`n  $ruleCmd" }

$runner = Join-Path $PSScriptRoot 'run.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $pkg `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -Node `"$node`" -ConsoleHome `"$consoleHome`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "scheduled task '$taskName' registered and started (log: $consoleHome\console.log)"

Write-Host ""
Write-Host "On this PC:  http://127.0.0.1:$loopPort"
Write-Host "Phone, once: install $consoleHome\tls\ca.crt (send it to the phone by mail or cloud drive)."
Write-Host "  iPhone: open the file, install the profile in Settings, then turn it on under"
Write-Host "          Settings > General > About > Certificate Trust Settings."
Write-Host "  Android: Settings > Security > Encryption & credentials > Install a certificate > CA certificate."
Write-Host "Then pair: Devices on the PC page (or scripts\pair.ps1) and scan the code."
Write-Host "  iPhone needs the page added to the Home Screen for notifications."
