# Update from the repo: install, build, then restart the WorkConsole task. A failed build leaves
# the running console untouched. Stopping the task kills run.ps1 but not always its node child,
# so a leftover backend is stopped by its command line. Unfinished runs come back as interrupted.
$ErrorActionPreference = 'Stop'
$pkg = Split-Path $PSScriptRoot -Parent
$taskName = 'WorkConsole'

Push-Location $pkg
try {
    npm ci
    if ($LASTEXITCODE) { throw 'npm ci failed; the console was not restarted' }
    npm run build
    if ($LASTEXITCODE) { throw 'the build failed; the console was not restarted' }
} finally { Pop-Location }

if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) { throw "no '$taskName' task: run scripts\install.ps1 first" }
Stop-ScheduledTask -TaskName $taskName
$main = Join-Path $pkg 'server\main.ts'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($main) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-ScheduledTask -TaskName $taskName
Write-Host "updated and restarted '$taskName'"
