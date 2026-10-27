[CmdletBinding()]
param(
    [string]$StudentName,
    [string[]]$AuthorNames,
    [string[]]$SearchTerms,
    [string]$DataDirectory = 'data',
    [switch]$SkipCredentials,
    [switch]$UpdateCredentials,
    [switch]$SkipDiagnostics,
    [switch]$ConfigureIntegration
)
$ErrorActionPreference = 'Stop'
$ConfigPath = Join-Path $PSScriptRoot 'monitor.config.json'
$InteractiveSetup = -not $PSBoundParameters.ContainsKey('StudentName') -and -not $SkipCredentials
$NewConfig = -not (Test-Path -LiteralPath $ConfigPath)
if ($NewConfig) {
    if (-not $StudentName) { $StudentName = Read-Host 'Your full LearnUs writer name' }
    if (-not $StudentName.Trim()) { throw 'A full student name is required.' }
    $Config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'monitor.config.example.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $Config.student.displayName = $StudentName.Trim()
    $Config.student.authorNames = [string[]]$(if ($AuthorNames) { $AuthorNames } else { $StudentName.Trim() })
    $Config.student.searchTerms = [string[]]$(if ($SearchTerms) { $SearchTerms } else { @($StudentName.Trim()) + ($StudentName.Trim() -split '\s+') | Select-Object -Unique })
    if ($InteractiveSetup) {
        $Selected = Read-Host 'Private data folder [data]; do not select a shared/cloud folder unless intended'
        if ($Selected) { $DataDirectory = $Selected }
    }
    $Config.dataDirectory = $DataDirectory
} else {
    $Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($Config.schemaVersion -ne 1) { throw 'Existing configuration is not this distribution format; preserved. See docs/MIGRATION.md.' }
    Write-Host 'Keeping existing configuration and student identity.'
}
if ($ConfigureIntegration -or ($NewConfig -and $InteractiveSetup)) {
    $Choice = Read-Host 'Optional handoff: none, markdown, obsidian [none]'
    if (-not $Choice) { $Choice = 'none' }
    if ($Choice -notin @('none','markdown','obsidian')) { throw 'Invalid integration choice; configuration was not replaced.' }
    $Config.secondBrain.mode = $Choice
    if ($Choice -eq 'markdown') {
        $Config.secondBrain.directory = Read-Host 'Approved local Markdown export directory (absolute path or relative to data folder)'
        if (-not $Config.secondBrain.directory) { throw 'An export directory is required.' }
        Write-Host 'This writes one provenance record per capture; existing conflicting files are never overwritten.'
        if ((Read-Host 'Approve writes to this directory? [y/N]') -ne 'y') { throw 'Export was not approved.' }
    }
    if ($Choice -eq 'obsidian') {
        $Config.secondBrain.projectDirectory = Read-Host 'Absolute path to your own obsidian-mcp project'
        $Config.secondBrain.vaultDirectory = Read-Host 'Absolute path to your own vault'
        $Intake = Read-Host 'Intake note [AI Inbox/LearnUs Intake.md]'
        if ($Intake) { $Config.secondBrain.intakeNote = $Intake }
        $Routes = @()
        while ($true) {
            $Course = Read-Host 'Exact LearnUs course name to route (empty to finish)'
            if (-not $Course) { break }
            $Note = Read-Host 'Exact Courses/*.md note for this course'
            $Routes += [pscustomobject]@{ aliases=@($Course); path=$Note }
        }
        $Config.secondBrain.courses = @($Routes)
        $Config.secondBrain | Add-Member -NotePropertyName createMissingNotes -NotePropertyValue ((Read-Host 'Allow explicit setup to CREATE missing selected notes without overwrite? [y/N]') -eq 'y') -Force
        Write-Host 'Only these exact notes receive append authority:'
        Write-Host $Config.secondBrain.intakeNote
        foreach ($Route in $Routes) { Write-Host $Route.path }
        if ((Read-Host 'Approve this exact-path setup? [y/N]') -ne 'y') { throw 'Obsidian setup not approved.' }
    }
}
if ($NewConfig -or $ConfigureIntegration) {
    $NextPath = "$ConfigPath.next"
    [IO.File]::WriteAllText($NextPath, ($Config | ConvertTo-Json -Depth 15), [Text.UTF8Encoding]::new($false))
    try {
        $Validation = @'
const { loadAppConfig } = await import(process.argv[1]); const { validateConfig } = await import(process.argv[2]); const c = await loadAppConfig(process.argv[3]); validateConfig(c,c.dataDirectory);
'@
        & node.exe --input-type=module -e $Validation ([Uri](Join-Path $PSScriptRoot 'src\app-config.mjs')).AbsoluteUri ([Uri](Join-Path $PSScriptRoot 'src\monitor-runtime.mjs')).AbsoluteUri $NextPath
        if ($LASTEXITCODE -ne 0) { throw 'Configuration validation failed; existing configuration preserved.' }
        Move-Item -LiteralPath $NextPath -Destination $ConfigPath -Force
    } finally { if (Test-Path -LiteralPath $NextPath) { Remove-Item -LiteralPath $NextPath -Force } }
}
$DataPath = if ([IO.Path]::IsPathRooted($Config.dataDirectory)) { [IO.Path]::GetFullPath($Config.dataDirectory) } else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $Config.dataDirectory)) }
$AuthPath = if ([IO.Path]::IsPathRooted($Config.authDirectory)) { [IO.Path]::GetFullPath($Config.authDirectory) } else { Join-Path $DataPath $Config.authDirectory }
$UsernamePath = Join-Path $AuthPath 'username.txt'
$PasswordPath = Join-Path $AuthPath 'password.dpapi'
if (-not $SkipCredentials -and ($UpdateCredentials -or -not (Test-Path -LiteralPath $UsernamePath) -or -not (Test-Path -LiteralPath $PasswordPath))) {
    $LoginName = Read-Host 'Your OWN Yonsei Portal login ID (never paste it in chat)'
    $Password = Read-Host 'Your OWN Yonsei Portal password' -AsSecureString
    if (-not $LoginName.Trim() -or $Password.Length -eq 0) { throw 'Credentials cannot be empty.' }
    New-Item -ItemType Directory -Path $AuthPath -Force | Out-Null
    $Acl = New-Object Security.AccessControl.DirectorySecurity
    $Acl.SetAccessRuleProtection($true,$false)
    $UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $Acl.SetOwner($UserSid)
    $Rule = New-Object Security.AccessControl.FileSystemAccessRule($UserSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $Acl.AddAccessRule($Rule)
    Set-Acl -LiteralPath $AuthPath -AclObject $Acl
    [IO.File]::WriteAllText($PasswordPath, (ConvertFrom-SecureString $Password), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($UsernamePath, $LoginName.Trim(), [Text.UTF8Encoding]::new($false))
    $Password = $null
    Write-Host 'Saved CurrentUser DPAPI credentials in the selected private auth directory.'
}
if (-not $SkipDiagnostics) {
    $DiagnosticArgs = @((Join-Path $PSScriptRoot 'src\doctor.mjs'),'--config',$ConfigPath)
    if ($SkipCredentials) { $DiagnosticArgs += '--skip-auth' }
    & node.exe @DiagnosticArgs
    if ($LASTEXITCODE -ne 0) { throw 'Diagnostic failed. No task was installed.' }
}
if (($ConfigureIntegration -or ($NewConfig -and $InteractiveSetup)) -and $Config.secondBrain.mode -eq 'obsidian') {
    & uv.exe run --project $Config.secondBrain.projectDirectory python (Join-Path $PSScriptRoot 'src\second-brain-writer.py') --config $ConfigPath --setup --approve-paths
    if ($LASTEXITCODE -ne 0) { throw 'Obsidian setup failed; monitoring can still run with mode none.' }
}
Write-Host 'Setup preserved existing records. No account or vault is inherited from the developer.'
if ($InteractiveSetup -and -not $SkipDiagnostics) {
    $ShortcutChoice = Read-Host 'Add Desktop and Start menu shortcuts? [Y/n]'
    if ($ShortcutChoice -in @('','y','yes')) {
        & (Join-Path $PSScriptRoot 'install-shortcuts.ps1')
    }
    if ((Read-Host 'Run a read-only LearnUs baseline now? Articles may become read. [y/N]') -eq 'y') {
        & (Join-Path $PSScriptRoot 'run-lightweight-monitor.ps1') -NoPopup
        if ($LASTEXITCODE -ne 0) { throw 'Baseline failed. No task was installed.' }
        if ((Read-Host 'Install daily monitoring for this logged-in Windows user? [y/N]') -eq 'y') {
            $Time = Read-Host 'Seoul run time HH:mm [08:00]'
            if (-not $Time) { $Time = '08:00' }
            & (Join-Path $PSScriptRoot 'install-scheduled-task.ps1') -Time $Time -Approve
        }
    }
}
Write-Host 'On demand: use the LearnUs Monitor shortcut or .\run-lightweight-monitor.ps1. Optional integration changes: .\setup.ps1 -ConfigureIntegration'
