[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadPath
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $PayloadPath)) {
    throw "Assignment notification payload not found: $PayloadPath"
}

$Payload = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not [bool]$Payload.should_notify) {
    exit 0
}

$Title = [string]$Payload.title
$Body = [string]$Payload.body
if ([string]::IsNullOrWhiteSpace($Title) -or [string]::IsNullOrWhiteSpace($Body)) {
    throw 'Assignment notification payload is missing title or body.'
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$NotifyIcon = New-Object System.Windows.Forms.NotifyIcon
try {
    $NotifyIcon.Icon = [System.Drawing.SystemIcons]::Warning
    $NotifyIcon.Visible = $true
    $NotifyIcon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Warning
    $NotifyIcon.BalloonTipTitle = $Title

    # Windows limits balloon text, so keep the rendered body bounded.
    if ($Body.Length -gt 900) {
        $Body = $Body.Substring(0, 897) + '...'
    }
    $NotifyIcon.BalloonTipText = $Body
    $NotifyIcon.ShowBalloonTip(10000)
    Start-Sleep -Seconds 8
}
finally {
    $NotifyIcon.Visible = $false
    $NotifyIcon.Dispose()
}
