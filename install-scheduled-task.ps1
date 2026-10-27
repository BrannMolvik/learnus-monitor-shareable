[CmdletBinding()]
param(
    [string]$TaskName = 'LearnUs Monitor Daily',
    [ValidatePattern('^(?:[01][0-9]|2[0-3]):[0-5][0-9]$')][string]$Time = '08:00',
    [switch]$NoPopup,
    [switch]$Approve,
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 leaves $PSScriptRoot empty inside param() defaults when started with -File.
$ScriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $Approve) { throw 'Scheduling requires explicit -Approve. No task was changed.' }
$RunnerPath = Join-Path $ScriptRoot 'run-lightweight-monitor.ps1'
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing -and (@($Existing.Actions).Count -ne 1 -or $Existing.Actions[0].WorkingDirectory -ne $ScriptRoot -or $Existing.Actions[0].Arguments -notlike ('*{0}*' -f [WildcardPattern]::Escape('"{0}"' -f $RunnerPath)))) { throw 'That task belongs to another installation; no change was made.' }
if ($Remove) {
    if ($Existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    Write-Host 'Owned task removed. Configuration, credentials and records were retained.'
    return
}
if ((Get-TimeZone).Id -ne 'Korea Standard Time') {
    throw 'Set Windows to Seoul (Korea Standard Time) before installing the local-time task.'
}
$Config = Get-Content -LiteralPath (Join-Path $ScriptRoot 'monitor.config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$DataPath = if ([IO.Path]::IsPathRooted($Config.dataDirectory)) { $Config.dataDirectory } else { Join-Path $ScriptRoot $Config.dataDirectory }
$AuthPath = if ([IO.Path]::IsPathRooted($Config.authDirectory)) { $Config.authDirectory } else { Join-Path $DataPath $Config.authDirectory }
foreach ($Required in @((Join-Path $DataPath 'state.json'),(Join-Path $AuthPath 'username.txt'),(Join-Path $AuthPath 'password.dpapi'))) { if (-not (Test-Path -LiteralPath $Required)) { throw 'Complete setup and a successful baseline first.' } }
$State = Get-Content -LiteralPath (Join-Path $DataPath 'state.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $State.last_successful_check -or -not $State.check_status.all_active_courses_checked) { throw 'A verified successful baseline is required before scheduling.' }
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing -and (@($Existing.Actions).Count -ne 1 -or $Existing.Actions[0].WorkingDirectory -ne $ScriptRoot -or $Existing.Actions[0].Arguments -notlike ('*{0}*' -f [WildcardPattern]::Escape('"{0}"' -f $RunnerPath)))) {
    throw 'That task belongs to another installation. Choose a unique -TaskName; nothing was replaced.'
}
$PowerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Mode daily' -f $RunnerPath
if ($NoPopup) { $Arguments += ' -NoPopup' }
$Action = New-ScheduledTaskAction -Execute $PowerShellPath -Argument $Arguments -WorkingDirectory $ScriptRoot
$Trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.Add([timespan]::ParseExact($Time, 'hh\:mm', [Globalization.CultureInfo]::InvariantCulture)))
$Principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Description 'Deterministic local LearnUs login, check and report.' -Force | Out-Null
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State, Actions, Triggers, Principal, Settings
Write-Host "Installed $TaskName at $Time Seoul time. Test with: Start-ScheduledTask -TaskName '$TaskName'"
