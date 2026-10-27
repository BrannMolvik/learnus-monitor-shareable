[CmdletBinding()]
param(
    [ValidateSet('daily','full')][string]$Mode = 'daily',
    [switch]$DryRun,
    [switch]$NoPopup,
    [ValidateRange(1,119)][int]$TimeoutMinutes = 20
)
$ErrorActionPreference = 'Stop'
$ProjectPath = $PSScriptRoot
$ConfigPath = Join-Path $ProjectPath 'monitor.config.json'
$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Config.schemaVersion -ne 1) { throw 'Run setup.ps1 before monitoring.' }
$DataPath = if ([IO.Path]::IsPathRooted($Config.dataDirectory)) { [IO.Path]::GetFullPath($Config.dataDirectory) } else { [IO.Path]::GetFullPath((Join-Path $ProjectPath $Config.dataDirectory)) }
$AuthPath = if ([IO.Path]::IsPathRooted($Config.authDirectory)) { [IO.Path]::GetFullPath($Config.authDirectory) } else { [IO.Path]::GetFullPath((Join-Path $DataPath $Config.authDirectory)) }
$LogsPath = Join-Path $DataPath 'logs'
New-Item -ItemType Directory -Path $LogsPath -Force | Out-Null
$LogPath = Join-Path $LogsPath ('run-{0}.log' -f (Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'))
$StatusPath = Join-Path $LogsPath 'lightweight-last-run-status.json'
$StatePath = Join-Path $DataPath 'state.json'
$BriefPath = Join-Path $DataPath 'reports\latest-brief.md'
$Hash = [Security.Cryptography.SHA256]::Create()
try { $InstallId = [BitConverter]::ToString($Hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($DataPath.ToLowerInvariant()))).Replace('-','') }
finally { $Hash.Dispose() }
$Mutex = [Threading.Mutex]::new($false, "Local\LearnUs_$InstallId")
$HasLock = $false
$Status = [ordered]@{ started_at=(Get-Date).ToString('o'); succeeded=$false; scan_succeeded=$false; codex_invoked=$false; dry_run=[bool]$DryRun; state_updated=$false; second_brain_capture_succeeded=$false; second_brain_capture_error=$null; assignment_notification_error=$null; popup_error=$null; error=$null; log_file=$LogPath }
try {
    try { $HasLock = $Mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $HasLock = $true }
    if (-not $HasLock) { throw 'Another scan is already running for this data directory.' }
    $NodePath = (Get-Command node.exe -ErrorAction Stop).Source
    & $NodePath (Join-Path $ProjectPath 'doctor.mjs') --config $ConfigPath --skip-auth | Set-Content -LiteralPath $LogPath -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw 'Configuration/dependency diagnostic failed; run setup.ps1.' }
    $Before = if (Test-Path -LiteralPath $StatePath) { (Get-Item -LiteralPath $StatePath).LastWriteTimeUtc } else { $null }
    $SecurePassword = (Get-Content -LiteralPath (Join-Path $AuthPath 'password.dpapi') -Raw).Trim() | ConvertTo-SecureString
    $Username = (Get-Content -LiteralPath (Join-Path $AuthPath 'username.txt') -Raw -Encoding UTF8).Trim()
    $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)
    try { $PlainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer) }
    if (-not $Username -or -not $PlainPassword) { throw 'Credentials are empty. Run setup.ps1 -UpdateCredentials.' }
    try {
        $env:LEARNUS_USERNAME = $Username; $env:LEARNUS_PASSWORD = $PlainPassword
        $env:LEARNUS_DOCUMENTS = [Environment]::GetFolderPath('MyDocuments')
        $env:LEARNUS_RUNNER_TIMEOUT_MINUTES = [string]$TimeoutMinutes
        $env:LEARNUS_RUN_DEADLINE_MS = [string]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $TimeoutMinutes * 60000)
        $Arguments = '"{0}" --mode {1}' -f (Join-Path $ProjectPath 'learnus-monitor.mjs'), $Mode
        if ($DryRun) { $Arguments += ' --dry-run' }
        $Info = New-Object Diagnostics.ProcessStartInfo
        $Info.FileName = $NodePath; $Info.Arguments = $Arguments; $Info.WorkingDirectory = $ProjectPath
        $Info.UseShellExecute = $false; $Info.CreateNoWindow = $true
        $Info.RedirectStandardOutput = $true; $Info.RedirectStandardError = $true
        $Info.StandardOutputEncoding = [Text.Encoding]::UTF8; $Info.StandardErrorEncoding = [Text.Encoding]::UTF8
        $Process = [Diagnostics.Process]::Start($Info)
        $OutputReads = @($Process.StandardOutput.ReadToEndAsync(), $Process.StandardError.ReadToEndAsync())
        $null = $Process.Handle
        if (-not $Process.WaitForExit($TimeoutMinutes * 60000)) {
            try { & taskkill.exe /PID $Process.Id /T /F 2>&1 | Out-Null } catch { }
            throw 'Scanner timed out. Previous successful state is retained if retrieval was incomplete.'
        }
        $Process.WaitForExit()
        $ExitCode = $Process.ExitCode
    }
    finally {
        Remove-Item Env:\LEARNUS_PASSWORD,Env:\LEARNUS_USERNAME,Env:\LEARNUS_DOCUMENTS,Env:\LEARNUS_RUNNER_TIMEOUT_MINUTES,Env:\LEARNUS_RUN_DEADLINE_MS -ErrorAction SilentlyContinue
        foreach ($OutputRead in $OutputReads) {
            if ($OutputRead.Wait(5000)) {
                $OutputText = $OutputRead.Result
                if ($PlainPassword) { $OutputText = $OutputText.Replace($PlainPassword,'[REDACTED]') }
                if ($Username) { $OutputText = $OutputText.Replace($Username,'[REDACTED]') }
                $OutputText | Add-Content -LiteralPath $LogPath -Encoding UTF8
            }
        }
        $PlainPassword = $null
    }
    if ($ExitCode -ne 0) { throw 'Scan failed. Inspect the dated log; no handoff was attempted.' }
    $ScanPath = Join-Path $DataPath 'reports\latest-scan.json'
    $State = Get-Content -LiteralPath $ScanPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $State.check_status.all_active_courses_checked -or $State.scanner.codex_invoked) { throw 'Scan did not verify all active courses.' }
    if (-not $DryRun) {
        $Status.state_updated = (Test-Path -LiteralPath $StatePath) -and ((-not $Before) -or (Get-Item -LiteralPath $StatePath).LastWriteTimeUtc -gt $Before)
        if (-not $Status.state_updated) { throw 'Successful state was not updated.' }
    }
    $Status.scan_succeeded = $true; $Status.succeeded = $true
    if (-not $DryRun -and $Config.secondBrain.mode -and $Config.secondBrain.mode -ne 'none') {
        try {
            & $NodePath (Join-Path $ProjectPath 'run-handoff.mjs') $ConfigPath 2>&1 | Add-Content -LiteralPath $LogPath -Encoding UTF8
            if ($LASTEXITCODE -ne 0) { throw 'Optional handoff failed; scan remains successful.' }
            $Status.second_brain_capture_succeeded = $true
        } catch { $Status.second_brain_capture_error = $_.Exception.Message }
    }
    if (-not $DryRun -and $Config.notifications.enabled) {
        try {
            $Payload = Join-Path $DataPath 'reports\latest-assignment-notification.json'
            $NotifyState = Join-Path $LogsPath 'assignment-notification-state.json'
            & $NodePath (Join-Path $ProjectPath 'assignment-notifications.mjs') --scan $ScanPath --state $NotifyState --out $Payload | Add-Content -LiteralPath $LogPath -Encoding UTF8
            if ($LASTEXITCODE -ne 0) { throw 'Notification generation failed.' }
            $Notification = Get-Content -LiteralPath $Payload -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not $NoPopup -and $Config.notifications.popup -and $Notification.should_notify) {
                & (Join-Path $ProjectPath 'show-assignment-notification.ps1') -PayloadPath $Payload
                $Notification.next_state | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $NotifyState -Encoding UTF8
            }
        } catch { $Status.assignment_notification_error = 'Assignment notification failed; scan remains successful.' }
    }
} catch {
    $Status.error = $_.Exception.Message
} finally {
    Remove-Item Env:\LEARNUS_PASSWORD,Env:\LEARNUS_USERNAME -ErrorAction SilentlyContinue
    $PlainPassword = $null
    $Status.finished_at = (Get-Date).ToString('o')
    if ($HasLock) { $Status | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $StatusPath -Encoding UTF8; $Mutex.ReleaseMutex() }
    $Mutex.Dispose()
}
if ($Status.succeeded -and -not $DryRun -and -not $NoPopup -and $Config.notifications.popup) {
    $HostPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $ViewerPath = Join-Path $ProjectPath 'show-daily-brief.ps1'
    try {
        Start-Process $HostPath -ArgumentList ('-NoProfile -STA -ExecutionPolicy Bypass -File "{0}" -BriefPath "{1}" -HistoryPath "{2}" -StatePath "{3}" -RunStatusPath "{4}"' -f $ViewerPath,$BriefPath,(Join-Path $DataPath 'announcement-history.json'),(Join-Path $DataPath 'viewer-state.json'),$StatusPath) -WindowStyle Hidden | Out-Null
    } catch {
        $Status.popup_error = 'Daily viewer could not be launched; scan remains successful.'
        $Status | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $StatusPath -Encoding UTF8
    }
}
if (-not $Status.succeeded) { exit 1 }
exit 0
