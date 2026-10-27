[CmdletBinding()]
param([string]$Directory)
$ErrorActionPreference = 'Stop'
$ScriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
foreach ($name in @('show-daily-brief.ps1','run-lightweight-monitor.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ScriptRoot $name))) { throw "Missing app file: $name" }
}
$Target = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Arguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -ScanOnOpen' -f (Join-Path $ScriptRoot 'show-daily-brief.ps1')
$Folders = if ($Directory) { @([IO.Path]::GetFullPath($Directory)) } else {
    @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\LearnUs Monitor'))
}
$Shell = New-Object -ComObject WScript.Shell
foreach ($Folder in $Folders) {
    if (-not $Folder) { throw 'Windows shortcut folder is unavailable.' }
    New-Item -ItemType Directory -Path $Folder -Force | Out-Null
    $Path = Join-Path $Folder 'LearnUs Monitor.lnk'
    $Shortcut = $Shell.CreateShortcut($Path)
    if ((Test-Path -LiteralPath $Path) -and ($Shortcut.TargetPath -ne $Target -or $Shortcut.Arguments -ne $Arguments)) {
        throw "Existing shortcut points elsewhere and was preserved: $Path"
    }
    $Shortcut.TargetPath = $Target
    $Shortcut.Arguments = $Arguments
    $Shortcut.WorkingDirectory = $ScriptRoot
    $Shortcut.Description = 'Open LearnUs Monitor and scan courses locally (no Codex).'
    $Shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',13'
    $Shortcut.WindowStyle = 7
    $Shortcut.Save()
    $Check = $Shell.CreateShortcut($Path)
    if ($Check.TargetPath -ne $Target -or $Check.Arguments -ne $Arguments -or $Check.WorkingDirectory -ne $ScriptRoot) {
        throw "Shortcut verification failed: $Path"
    }
    Write-Host "Installed: $Path"
}
