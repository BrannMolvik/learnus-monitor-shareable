# Compatibility entry point for the standalone deterministic runner.
# Windows PowerShell 5.1 leaves $PSScriptRoot empty inside param() defaults when started with -File.
$ScriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
& (Join-Path $ScriptRoot 'run-lightweight-monitor.ps1') -Mode daily @args
exit $LASTEXITCODE
