[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Root, [switch]$ParseBrief)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
if ((Split-Path -Parent $Root).TrimEnd('\') -ne ([IO.Path]::GetTempPath()).TrimEnd('\') -or (Split-Path -Leaf $Root) -notlike 'learnus-sandbox-*') { throw 'An isolated temporary sandbox is required.' }
if ($ParseBrief) {
    . (Join-Path $Root 'viewer-parse.ps1')
    $brief = Get-Content -LiteralPath (Join-Path $Root 'data\reports\latest-brief.md') -Raw -Encoding UTF8
    $parts = Get-BriefParts (ConvertFrom-BriefMarkdown $brief).Sections
    if ($parts.Tasks.Count -lt 1 -or -not $parts.HealthOk) { throw 'Viewer could not parse the generated brief.' }
    Write-Output 'Viewer parser: passed (GUI not opened).'
    return
}
$global:LearnUsSandboxPassword = [guid]::NewGuid().ToString('N')
function Read-Host {
    param([string]$Prompt, [switch]$AsSecureString)
    if ($AsSecureString) { return (ConvertTo-SecureString $global:LearnUsSandboxPassword -AsPlainText -Force) }
    switch -Regex ($Prompt) {
        '^Your full LearnUs writer name' { return 'Example Student' }
        '^Private data folder' { return '' }
        '^Optional handoff' { return 'none' }
        '^Your OWN Yonsei Portal login ID' { return 'synthetic-student' }
        '^Run a read-only LearnUs baseline' { return 'n' }
        default { throw 'Unexpected prompt: sandbox will not approve other actions.' }
    }
}
try { & (Join-Path $Root 'setup.ps1'); if ($LASTEXITCODE -ne 0) { throw 'Setup diagnostic failed.' } }
finally { $global:LearnUsSandboxPassword = $null }
