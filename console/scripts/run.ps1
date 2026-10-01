# What the WorkConsole scheduled task runs: the backend, restarted whenever it exits.
# Task Scheduler's own restart-on-failure does not fire for a long-running process that dies,
# so the loop lives here. Output goes to <home>\console.log (rotated at 10 MB).
param(
    [Parameter(Mandatory)][string]$Node,
    [Parameter(Mandatory)][string]$ConsoleHome
)
$ErrorActionPreference = 'Continue'
$pkg = Split-Path $PSScriptRoot -Parent
$main = Join-Path $pkg 'server\main.ts'
$log = Join-Path $ConsoleHome 'console.log'
$env:WORK_CONSOLE_HOME = $ConsoleHome
Set-Location $pkg

while ($true) {
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 10MB) { Move-Item $log "$log.1" -Force }
    Add-Content -Encoding UTF8 $log "[$(Get-Date -Format s)] starting"
    cmd /c "`"$Node`" --experimental-strip-types --no-warnings=ExperimentalWarning `"$main`" >> `"$log`" 2>&1"
    Add-Content -Encoding UTF8 $log "[$(Get-Date -Format s)] exited with $LASTEXITCODE; restarting in 10 s"
    Start-Sleep -Seconds 10
}
