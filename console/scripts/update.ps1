# Update from the repo: install, build, then restart the WorkConsole task. npm ci runs only when
# package-lock.json changed since the last one here (a stamp in node_modules), and only once the
# console is stopped: the running server holds native modules such as rolldown's, which Windows
# will not let npm delete. Without npm ci a failed build leaves the running console untouched.
# Stopping the task does not always stop run.ps1 or its node child at once, so both are stopped by
# their command lines, the loop first. Unfinished runs come back as interrupted.
$ErrorActionPreference = 'Stop'
$pkg = Split-Path $PSScriptRoot -Parent
$taskName = 'WorkConsole'
$stamp = Join-Path $pkg 'node_modules\.update-lock.sha256'

if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) { throw "no '$taskName' task: run scripts\install.ps1 first" }

function Stop-Console {
    Stop-ScheduledTask -TaskName $taskName
    foreach ($script in (Join-Path $pkg 'scripts\run.ps1'), (Join-Path $pkg 'server\main.ts')) {
        $procs = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($script) })
        foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
        foreach ($p in $procs) { Wait-Process -Id $p.ProcessId -Timeout 30 -ErrorAction SilentlyContinue }
    }
}

$lock = (Get-FileHash (Join-Path $pkg 'package-lock.json') -Algorithm SHA256).Hash
$ci = -not ((Test-Path $stamp) -and ("$(Get-Content $stamp -Raw)".Trim() -eq $lock))
$stopped = $false
Push-Location $pkg
try {
    if ($ci) {
        Stop-Console
        $stopped = $true
        npm ci
        if ($LASTEXITCODE) { throw 'npm ci failed' }
        Set-Content -Encoding ascii -NoNewline $stamp $lock
    }
    npm run build
    if ($LASTEXITCODE) { throw 'the build failed' }
} catch {
    if (-not $stopped) { throw "$($_.Exception.Message); the console was not restarted" }
    Start-ScheduledTask -TaskName $taskName
    throw "$($_.Exception.Message); the console was stopped for npm ci and started again on what is installed now"
} finally { Pop-Location }

if (-not $stopped) { Stop-Console }
Start-ScheduledTask -TaskName $taskName
Write-Host "updated and restarted '$taskName'$(if ($ci) { ' (npm ci ran with the console stopped)' })"
