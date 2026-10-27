[CmdletBinding()]
param([switch]$DryRun)

# Windows PowerShell 5.1 leaves $PSScriptRoot empty inside param() defaults when started with -File.
$ScriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$runner = Join-Path $ScriptRoot 'run-lightweight-monitor.ps1'
& $runner -Mode full -DryRun:$DryRun
exit $LASTEXITCODE
