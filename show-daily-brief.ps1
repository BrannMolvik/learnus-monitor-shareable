[CmdletBinding()]
param(
    [string]$BriefPath,
    [string]$HistoryPath,
    [string]$StatePath,
    [string]$RunnerPath,
    [string]$RunStatusPath
)
$ScriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$DataRoot = Join-Path $ScriptRoot 'data'
$LocalConfigPath = Join-Path $ScriptRoot 'monitor.config.json'
if (Test-Path -LiteralPath $LocalConfigPath) {
    $LocalConfig = Get-Content -LiteralPath $LocalConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $DataRoot = if ([IO.Path]::IsPathRooted($LocalConfig.dataDirectory)) { $LocalConfig.dataDirectory } else { Join-Path $ScriptRoot $LocalConfig.dataDirectory }
}
if (-not $BriefPath) { $BriefPath = Join-Path $DataRoot 'reports\latest-brief.md' }
if (-not $HistoryPath) { $HistoryPath = Join-Path $DataRoot 'announcement-history.json' }
if (-not $StatePath) { $StatePath = Join-Path $DataRoot 'viewer-state.json' }

# The Update button starts this script and reads its status report from <runner folder>\logs.
if (-not $RunnerPath) { $RunnerPath = Join-Path $ScriptRoot 'run-lightweight-monitor.ps1' }
try { $RunnerPath = [System.IO.Path]::GetFullPath($RunnerPath) } catch { }
if (-not $RunStatusPath) { $RunStatusPath = Join-Path $DataRoot 'logs\lightweight-last-run-status.json' }

$ErrorActionPreference = 'Stop'

$HasBrief = Test-Path -LiteralPath $BriefPath
$HasHistory = Test-Path -LiteralPath $HistoryPath
if (-not $HasBrief -and -not $HasHistory) {
    exit 0
}

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

# Keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less scripts as ANSI).
$Dash = [string][char]0x2014
$Dot = [string][char]0x00B7
$Bullet = [string][char]0x2022
$Ellipsis = [string][char]0x2026
$Circle = [string][char]0x25CF
$IconFont = 'Segoe Fluent Icons, Segoe MDL2 Assets'
$Invariant = [Globalization.CultureInfo]::InvariantCulture
$script:SessionStart = Get-Date
# Parsing, Due-list building and state merging live in viewer-parse.ps1 (shared with the tests).
. (Join-Path $ScriptRoot 'src\viewer-parse.ps1')

# This distribution never imports another installation's display state.

$Content = ''
if ($HasBrief) {
    try {
        $Content = Get-Content -LiteralPath $BriefPath -Raw -Encoding UTF8
        if ($null -eq $Content) { $Content = '' }
        $Content = $Content.TrimStart([char]0xFEFF)
    }
    catch { $Content = '' }
}

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

function Format-ShortDate([datetime]$Date) {
    if ($Date.Year -eq (Get-Date).Year) { return $Date.ToString('ddd, MMM d', $Invariant) }
    return $Date.ToString('ddd, MMM d, yyyy', $Invariant)
}

function Get-RelativeDayText([datetime]$Date) {
    $Days = ($Date.Date - (Get-Date).Date).Days
    if ($Days -eq 0) { return 'today' }
    if ($Days -eq 1) { return 'tomorrow' }
    if ($Days -eq -1) { return 'yesterday' }
    if ($Days -gt 1) { return "in $Days days" }
    return "$(-$Days) days ago"
}

function Format-ListDate([datetime]$Date) {
    $Days = ((Get-Date).Date - $Date.Date).Days
    if ($Days -eq 0) { return 'Today' }
    if ($Days -eq 1) { return 'Yesterday' }
    if ($Days -gt 1 -and $Days -lt 7) { return $Date.ToString('dddd', $Invariant) }
    if ($Date.Year -eq (Get-Date).Year) { return $Date.ToString('MMM d', $Invariant) }
    return $Date.ToString('MMM d, yyyy', $Invariant)
}

function Format-Age([TimeSpan]$Age) {
    if ($Age.TotalMinutes -lt 1) { return 'just now' }
    if ($Age.TotalMinutes -lt 60) { return "$([int][Math]::Floor($Age.TotalMinutes)) min ago" }
    if ($Age.TotalHours -lt 24) { return "$([int][Math]::Floor($Age.TotalHours)) h ago" }
    $Days = [int][Math]::Floor($Age.TotalDays)
    if ($Days -eq 1) { return '1 day ago' }
    return "$Days days ago"
}

function Get-WeekStart([datetime]$Date) {
    $Offset = ([int]$Date.DayOfWeek + 6) % 7
    return $Date.Date.AddDays(-$Offset)
}

function Get-WeekLabel($Date) {
    if (-not $Date) { return 'UNDATED' }
    $Week = Get-WeekStart $Date
    $ThisWeek = Get-WeekStart (Get-Date)
    $Weeks = [int][Math]::Round(($ThisWeek - $Week).TotalDays / 7)
    if ($Weeks -le 0) { return 'THIS WEEK' }
    if ($Weeks -eq 1) { return 'LAST WEEK' }
    return ('WEEK OF ' + $Week.ToString('MMM d', $Invariant).ToUpperInvariant())
}

function Get-Plural([int]$Count, [string]$One, [string]$Many) {
    if ($Count -eq 1) { return "$Count $One" }
    return "$Count $Many"
}

# ---------------------------------------------------------------------------
# Viewer state (private data directory, never imported from another installation)
# ---------------------------------------------------------------------------
# Saving re-reads and merges the file (Save-MergedViewerState), so only what this window changed is written:
$script:ReadActions = @{}      # announcement id -> when it was read in this window
$script:ResolveActions = @{}   # due id -> @{ resolved; at; due } for resolves/unresolves in this window
$script:ThemeChangedAt = $null # set when the theme is toggled in this window
$script:ViewerState = Read-ViewerStateFile $StatePath

function Get-StateValue([string]$Name) {
    try {
        if ($script:ViewerState -and ($script:ViewerState.PSObject.Properties.Name -contains $Name)) { return $script:ViewerState.$Name }
    }
    catch { }
    return $null
}

$script:ThemeChoice = $null
$SavedTheme = [string](Get-StateValue 'theme')
if ($SavedTheme -eq 'dark' -or $SavedTheme -eq 'light') { $script:ThemeChoice = $SavedTheme }
$LastOpened = ConvertTo-LocalDate (Get-StateValue 'lastOpenedAt')
$CarriedUnread = @{}
foreach ($UnreadId in @(Get-StateValue 'unreadIds')) {
    if ($UnreadId) { $CarriedUnread[[string]$UnreadId] = $true }
}
# A reload after an Update restarts the viewer; the old instance leaves its view state here (valid for 3 minutes only).
$script:Restore = $null
try {
    $RestoreCandidate = Get-StateValue 'restore'
    if ($RestoreCandidate -and $RestoreCandidate.at) {
        $RestoreAt = ConvertTo-LocalDate $RestoreCandidate.at
        if ($RestoreAt -and ((Get-Date) - $RestoreAt).TotalSeconds -lt 180 -and ((Get-Date) - $RestoreAt).TotalSeconds -gt -5) { $script:Restore = $RestoreCandidate }
    }
}
catch { $script:Restore = $null }
$script:ConsumedRestoreAt = $(if ($script:Restore) { $script:Restore.at } else { $null })

# Announcements read in any window: id -> when (an item updated after that counts as unread again).
$ReadAtOnDisk = @{}
try {
    $ReadAtValue = Get-StateValue 'readAt'
    if ($ReadAtValue) {
        foreach ($Property in $ReadAtValue.PSObject.Properties) {
            $ReadWhen = ConvertTo-LocalDate $Property.Value
            if ($ReadWhen) { $ReadAtOnDisk[[string]$Property.Name] = $ReadWhen }
        }
    }
}
catch { }

# Due items the user marked as resolved: id (course|title|due) -> due date as ISO text (used only to prune old entries).
$script:ResolvedIds = @{}
foreach ($ResolvedEntry in @(Get-StateValue 'resolved')) {
    try {
        if ($ResolvedEntry -is [string]) { if ($ResolvedEntry) { $script:ResolvedIds[$ResolvedEntry] = '' } }
        elseif ($ResolvedEntry -and $ResolvedEntry.id) { $script:ResolvedIds[[string]$ResolvedEntry.id] = [string]$ResolvedEntry.due }
    }
    catch { }
}

# ---------------------------------------------------------------------------
# Theme palettes
# ---------------------------------------------------------------------------
$Palettes = @{
    Light = @{
        Bg = '#F4F5F7'; Surface = '#FFFFFF'; SurfaceAlt = '#F7F8FA'; Border = '#E4E7EC'; BorderStrong = '#D0D5DD'
        Text = '#161B26'; TextMuted = '#4B5565'; TextFaint = '#5F6673'
        Accent = '#1F55C9'; AccentText = '#FFFFFF'; AccentSoft = '#EAF0FC'
        Danger = '#C0281C'; OnDanger = '#FFFFFF'; DangerSoft = '#FDEEEC'
        Warn = '#9A5700'; WarnSoft = '#FFF3E0'; Good = '#146C33'
        Hover = '#E9ECF1'; HoverOverlay = '#12000000'; PressedOverlay = '#22000000'; Selected = '#E5ECFB'
        ScrollThumb = '#C9CED6'; ScrollThumbHover = '#9EA5B0'
        Course0 = '#1D4ED8'; Course1 = '#7C3AED'; Course2 = '#0F766E'; Course3 = '#B4237A'; Course4 = '#146C33'; Course5 = '#0E7490'
    }
    Dark = @{
        Bg = '#121417'; Surface = '#1B1E23'; SurfaceAlt = '#22262C'; Border = '#2C3138'; BorderStrong = '#3B414A'
        Text = '#E7E9EC'; TextMuted = '#B0B6BF'; TextFaint = '#9AA1AB'
        Accent = '#82A9FF'; AccentText = '#0D1526'; AccentSoft = '#1F2A42'
        Danger = '#FF7B72'; OnDanger = '#2B0B09'; DangerSoft = '#3A1F1F'
        Warn = '#F2B45A'; WarnSoft = '#362A17'; Good = '#86EFAC'
        Hover = '#2A2F37'; HoverOverlay = '#16FFFFFF'; PressedOverlay = '#26FFFFFF'; Selected = '#24324F'
        ScrollThumb = '#454C56'; ScrollThumbHover = '#646C78'
        Course0 = '#8AB4FF'; Course1 = '#C4B5FD'; Course2 = '#5EEAD4'; Course3 = '#F9A8D4'; Course4 = '#86EFAC'; Course5 = '#67E8F9'
    }
}

function Get-SystemPrefersDark {
    try {
        $Value = Get-ItemPropertyValue -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'AppsUseLightTheme' -ErrorAction Stop
        return ([int]$Value -eq 0)
    }
    catch {
        return $false
    }
}

# Dark title bar / caption colors (Windows 10 1809+ / Windows 11). Failures are ignored.
$script:DwmAvailable = $false
try {
    if (-not ('LearnUsBriefDwm' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LearnUsBriefDwm {
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    public static void Apply(IntPtr hwnd, bool dark, int caption, int text, int border) {
        if (hwnd == IntPtr.Zero) { return; }
        int value = dark ? 1 : 0;
        if (DwmSetWindowAttribute(hwnd, 20, ref value, 4) != 0) { DwmSetWindowAttribute(hwnd, 19, ref value, 4); }
        DwmSetWindowAttribute(hwnd, 35, ref caption, 4);
        DwmSetWindowAttribute(hwnd, 36, ref text, 4);
        DwmSetWindowAttribute(hwnd, 34, ref border, 4);
    }
}
'@
    }
    $script:DwmAvailable = $true
}
catch {
    $script:DwmAvailable = $false
}

# Read/unread flag that the feed cards bind to (needs change notification).
if (-not ('LearnUsFeedState' -as [type])) {
    Add-Type -ReferencedAssemblies ([System.ComponentModel.INotifyPropertyChanged].Assembly.Location) -TypeDefinition @'
using System.ComponentModel;
public class LearnUsFeedState : INotifyPropertyChanged {
    private bool unread;
    public event PropertyChangedEventHandler PropertyChanged;
    public bool IsUnread {
        get { return unread; }
        set { unread = value; Raise("IsUnread"); Raise("BadgeVisibility"); Raise("TitleWeight"); }
    }
    public string BadgeVisibility { get { return unread ? "Visible" : "Collapsed"; } }
    public string TitleWeight { get { return unread ? "SemiBold" : "Normal"; } }
    private void Raise(string name) {
        PropertyChangedEventHandler handler = PropertyChanged;
        if (handler != null) { handler(this, new PropertyChangedEventArgs(name)); }
    }
}
'@
}

function ConvertTo-ColorRef([string]$Hex) {
    $Color = [System.Windows.Media.ColorConverter]::ConvertFromString($Hex)
    return ([int]$Color.R) -bor ([int]$Color.G -shl 8) -bor ([int]$Color.B -shl 16)
}

# ---------------------------------------------------------------------------
# Shared styles (application-level so tooltips and context menus are themed too)
# ---------------------------------------------------------------------------
$ResourcesXaml = @'
<ResourceDictionary xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Style x:Key="FocusRing">
    <Setter Property="Control.Template">
      <Setter.Value>
        <ControlTemplate>
          <Border Margin="-3" CornerRadius="8" BorderThickness="2" BorderBrush="{DynamicResource Accent}" SnapsToDevicePixels="True"/>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style x:Key="ItemFocusRing">
    <Setter Property="Control.Template">
      <Setter.Value>
        <ControlTemplate>
          <Border CornerRadius="8" BorderThickness="2" BorderBrush="{DynamicResource Accent}" SnapsToDevicePixels="True"/>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>

  <Style TargetType="{x:Type Button}">
    <Setter Property="FocusVisualStyle" Value="{StaticResource FocusRing}"/>
    <Setter Property="Background" Value="{DynamicResource Surface}"/>
    <Setter Property="Foreground" Value="{DynamicResource Text}"/>
    <Setter Property="BorderBrush" Value="{DynamicResource BorderStrong}"/>
    <Setter Property="BorderThickness" Value="1"/>
    <Setter Property="Padding" Value="14,7"/>
    <Setter Property="FontSize" Value="13"/>
    <Setter Property="Cursor" Value="Hand"/>
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="{x:Type Button}">
          <Grid SnapsToDevicePixels="True">
            <Border x:Name="Bd" CornerRadius="6" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}"/>
            <Border x:Name="Overlay" CornerRadius="6" Background="{DynamicResource HoverOverlay}" Opacity="0"/>
            <ContentPresenter Margin="{TemplateBinding Padding}" HorizontalAlignment="Center" VerticalAlignment="Center" RecognizesAccessKey="True"/>
          </Grid>
          <ControlTemplate.Triggers>
            <Trigger Property="IsMouseOver" Value="True">
              <Setter TargetName="Overlay" Property="Opacity" Value="1"/>
            </Trigger>
            <Trigger Property="IsPressed" Value="True">
              <Setter TargetName="Overlay" Property="Background" Value="{DynamicResource PressedOverlay}"/>
              <Setter TargetName="Overlay" Property="Opacity" Value="1"/>
            </Trigger>
            <Trigger Property="IsEnabled" Value="False">
              <Setter Property="Opacity" Value="0.4"/>
              <Setter Property="Cursor" Value="Arrow"/>
            </Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style x:Key="PrimaryButton" TargetType="{x:Type Button}" BasedOn="{StaticResource {x:Type Button}}">
    <Setter Property="Background" Value="{DynamicResource Accent}"/>
    <Setter Property="BorderBrush" Value="{DynamicResource Accent}"/>
    <Setter Property="Foreground" Value="{DynamicResource AccentText}"/>
    <Setter Property="FontWeight" Value="SemiBold"/>
  </Style>
  <Style x:Key="IconButton" TargetType="{x:Type Button}" BasedOn="{StaticResource {x:Type Button}}">
    <Setter Property="Background" Value="Transparent"/>
    <Setter Property="BorderBrush" Value="Transparent"/>
    <Setter Property="Foreground" Value="{DynamicResource TextMuted}"/>
    <Setter Property="Padding" Value="0"/>
    <Setter Property="Width" Value="36"/>
    <Setter Property="Height" Value="34"/>
  </Style>
  <Style x:Key="LinkButton" TargetType="{x:Type Button}">
    <Setter Property="FocusVisualStyle" Value="{StaticResource FocusRing}"/>
    <Setter Property="Foreground" Value="{DynamicResource Accent}"/>
    <Setter Property="Background" Value="Transparent"/>
    <Setter Property="FontSize" Value="12.5"/>
    <Setter Property="FontWeight" Value="SemiBold"/>
    <Setter Property="Padding" Value="2,2"/>
    <Setter Property="Cursor" Value="Hand"/>
    <Setter Property="HorizontalAlignment" Value="Left"/>
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="{x:Type Button}">
          <Border x:Name="Bd" Background="Transparent" CornerRadius="4" Padding="{TemplateBinding Padding}">
            <ContentPresenter VerticalAlignment="Center"/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="IsMouseOver" Value="True">
              <Setter TargetName="Bd" Property="Background" Value="{DynamicResource Hover}"/>
            </Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style x:Key="UpdateButton" TargetType="{x:Type Button}" BasedOn="{StaticResource {x:Type Button}}">
    <Setter Property="Foreground" Value="{DynamicResource TextMuted}"/>
    <Setter Property="FontSize" Value="12.5"/>
    <Setter Property="Height" Value="30"/>
    <Setter Property="Margin" Value="0,0,6,0"/>
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="{x:Type Button}">
          <Grid SnapsToDevicePixels="True">
            <Border x:Name="Bd" CornerRadius="6" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}"/>
            <Border x:Name="Overlay" CornerRadius="6" Background="{DynamicResource HoverOverlay}" Opacity="0"/>
            <ContentPresenter Margin="11,0" HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Grid>
          <ControlTemplate.Triggers>
            <Trigger Property="IsMouseOver" Value="True">
              <Setter TargetName="Overlay" Property="Opacity" Value="1"/>
              <Setter Property="Foreground" Value="{DynamicResource Text}"/>
            </Trigger>
            <Trigger Property="IsPressed" Value="True">
              <Setter TargetName="Overlay" Property="Background" Value="{DynamicResource PressedOverlay}"/>
              <Setter TargetName="Overlay" Property="Opacity" Value="1"/>
            </Trigger>
            <Trigger Property="IsEnabled" Value="False">
              <Setter Property="Opacity" Value="0.85"/>
              <Setter Property="Cursor" Value="Arrow"/>
            </Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style x:Key="RowAction" TargetType="{x:Type Button}">
    <Setter Property="FocusVisualStyle" Value="{StaticResource FocusRing}"/>
    <Setter Property="Foreground" Value="{DynamicResource TextFaint}"/>
    <Setter Property="Background" Value="Transparent"/>
    <Setter Property="Cursor" Value="Hand"/>
    <Setter Property="Width" Value="24"/>
    <Setter Property="Height" Value="24"/>
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="{x:Type Button}">
          <Border x:Name="Bd" CornerRadius="12" Background="{TemplateBinding Background}" BorderThickness="1" BorderBrush="Transparent">
            <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="IsMouseOver" Value="True">
              <Setter TargetName="Bd" Property="Background" Value="{DynamicResource AccentSoft}"/>
              <Setter TargetName="Bd" Property="BorderBrush" Value="{DynamicResource Accent}"/>
              <Setter Property="Foreground" Value="{DynamicResource Accent}"/>
            </Trigger>
            <Trigger Property="IsKeyboardFocused" Value="True">
              <Setter Property="Foreground" Value="{DynamicResource Accent}"/>
            </Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style x:Key="DueRowHost" TargetType="{x:Type Label}">
    <Setter Property="IsTabStop" Value="False"/>
    <Setter Property="Padding" Value="0"/>
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="{x:Type Label}">
          <Border Background="Transparent"><ContentPresenter/></Border>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style x:Key="RowButton" TargetType="{x:Type Button}">
    <Setter Property="FocusVisualStyle" Value="{StaticResource ItemFocusRing}"/>
    <Setter Property="Foreground" Value="{DynamicResource Text}"/>
    <Setter Property="Background" Value="Transparent"/>
    <Setter Property="Cursor" Value="Hand"/>
    <Setter Property="HorizontalContentAlignment" Value="Stretch"/>
    <Setter Property="Padding" Value="8,7,8,8"/>
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="{x:Type Button}">
          <Border x:Name="Bd" CornerRadius="8" Background="{TemplateBinding Background}" Padding="{TemplateBinding Padding}">
            <ContentPresenter HorizontalAlignment="Stretch"/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="IsMouseOver" Value="True">
              <Setter TargetName="Bd" Property="Background" Value="{DynamicResource Hover}"/>
            </Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style x:Key="SearchBox" TargetType="{x:Type TextBox}">
    <Setter Property="Foreground" Value="{DynamicResource Text}"/>
    <Setter Property="CaretBrush" Value="{DynamicResource Text}"/>
    <Setter Property="SelectionBrush" Value="{DynamicResource Accent}"/>
    <Setter Property="FocusVisualStyle" Value="{x:Null}"/>
    <Setter Property="FontSize" Value="13.5"/>
    <Setter Property="Height" Value="36"/>
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="{x:Type TextBox}">
          <Border x:Name="Bd" CornerRadius="8" Background="{DynamicResource SurfaceAlt}" BorderBrush="{DynamicResource BorderStrong}" BorderThickness="1" SnapsToDevicePixels="True">
            <Grid>
              <TextBlock Text="&#xE721;" FontFamily="Segoe Fluent Icons, Segoe MDL2 Assets" FontSize="13" Foreground="{DynamicResource TextFaint}" VerticalAlignment="Center" Margin="12,1,0,0" IsHitTestVisible="False"/>
              <TextBlock x:Name="Hint" Text="{TemplateBinding Tag}" Foreground="{DynamicResource TextFaint}" VerticalAlignment="Center" Margin="36,0,0,1" Visibility="Collapsed" IsHitTestVisible="False"/>
              <ScrollViewer x:Name="PART_ContentHost" Margin="32,0,34,0" VerticalAlignment="Center" Focusable="False"/>
            </Grid>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="Text" Value="">
              <Setter TargetName="Hint" Property="Visibility" Value="Visible"/>
            </Trigger>
            <Trigger Property="IsKeyboardFocused" Value="True">
              <Setter TargetName="Bd" Property="BorderBrush" Value="{DynamicResource Accent}"/>
              <Setter TargetName="Bd" Property="BorderThickness" Value="2"/>
            </Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>

  <Style x:Key="ScrollThumbStyle" TargetType="{x:Type Thumb}">
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="{x:Type Thumb}">
          <Border x:Name="T" CornerRadius="3" Background="{DynamicResource ScrollThumb}"/>
          <ControlTemplate.Triggers>
            <Trigger Property="IsMouseOver" Value="True">
              <Setter TargetName="T" Property="Background" Value="{DynamicResource ScrollThumbHover}"/>
            </Trigger>
            <Trigger Property="IsDragging" Value="True">
              <Setter TargetName="T" Property="Background" Value="{DynamicResource ScrollThumbHover}"/>
            </Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style x:Key="ScrollPageStyle" TargetType="{x:Type RepeatButton}">
    <Setter Property="Focusable" Value="False"/>
    <Setter Property="IsTabStop" Value="False"/>
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="{x:Type RepeatButton}">
          <Border Background="Transparent"/>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style TargetType="{x:Type ScrollBar}">
    <Setter Property="Background" Value="Transparent"/>
    <Setter Property="Width" Value="12"/>
    <Setter Property="MinWidth" Value="12"/>
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="{x:Type ScrollBar}">
          <Grid Background="Transparent">
            <Track x:Name="PART_Track" IsDirectionReversed="True" Margin="3,4">
              <Track.DecreaseRepeatButton>
                <RepeatButton Style="{StaticResource ScrollPageStyle}" Command="ScrollBar.PageUpCommand"/>
              </Track.DecreaseRepeatButton>
              <Track.Thumb>
                <Thumb Style="{StaticResource ScrollThumbStyle}" MinHeight="28"/>
              </Track.Thumb>
              <Track.IncreaseRepeatButton>
                <RepeatButton Style="{StaticResource ScrollPageStyle}" Command="ScrollBar.PageDownCommand"/>
              </Track.IncreaseRepeatButton>
            </Track>
          </Grid>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
    <Style.Triggers>
      <Trigger Property="Orientation" Value="Horizontal">
        <Setter Property="Width" Value="Auto"/>
        <Setter Property="MinWidth" Value="0"/>
        <Setter Property="Height" Value="12"/>
        <Setter Property="MinHeight" Value="12"/>
        <Setter Property="Template">
          <Setter.Value>
            <ControlTemplate TargetType="{x:Type ScrollBar}">
              <Grid Background="Transparent">
                <Track x:Name="PART_Track" IsDirectionReversed="False" Margin="4,3">
                  <Track.DecreaseRepeatButton>
                    <RepeatButton Style="{StaticResource ScrollPageStyle}" Command="ScrollBar.PageLeftCommand"/>
                  </Track.DecreaseRepeatButton>
                  <Track.Thumb>
                    <Thumb Style="{StaticResource ScrollThumbStyle}" MinWidth="28"/>
                  </Track.Thumb>
                  <Track.IncreaseRepeatButton>
                    <RepeatButton Style="{StaticResource ScrollPageStyle}" Command="ScrollBar.PageRightCommand"/>
                  </Track.IncreaseRepeatButton>
                </Track>
              </Grid>
            </ControlTemplate>
          </Setter.Value>
        </Setter>
      </Trigger>
    </Style.Triggers>
  </Style>

  <Style x:Key="FeedListStyle" TargetType="{x:Type ListBox}">
    <Setter Property="Background" Value="Transparent"/>
    <Setter Property="Foreground" Value="{DynamicResource Text}"/>
    <Setter Property="BorderThickness" Value="0"/>
    <Setter Property="FocusVisualStyle" Value="{x:Null}"/>
    <Setter Property="ScrollViewer.HorizontalScrollBarVisibility" Value="Disabled"/>
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="{x:Type ListBox}">
          <Border Background="Transparent" Padding="0,2,0,12">
            <ItemsPresenter/>
          </Border>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
    <Setter Property="ItemsPanel">
      <Setter.Value>
        <ItemsPanelTemplate>
          <StackPanel/>
        </ItemsPanelTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style x:Key="FeedItem" TargetType="{x:Type ListBoxItem}">
    <Setter Property="FocusVisualStyle" Value="{StaticResource ItemFocusRing}"/>
    <Setter Property="Foreground" Value="{DynamicResource Text}"/>
    <Setter Property="Margin" Value="8,1"/>
    <Setter Property="Padding" Value="16,11,14,12"/>
    <Setter Property="HorizontalContentAlignment" Value="Stretch"/>
    <Setter Property="Cursor" Value="Hand"/>
    <Setter Property="AutomationProperties.Name" Value="{Binding A11yName}"/>
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="{x:Type ListBoxItem}">
          <Grid SnapsToDevicePixels="True">
            <Border x:Name="Bd" CornerRadius="8" Background="Transparent"/>
            <Border x:Name="Bar" Width="3" CornerRadius="1.5" HorizontalAlignment="Left" Margin="0,10" Background="{DynamicResource Accent}" Visibility="Collapsed"/>
            <ContentPresenter Margin="{TemplateBinding Padding}" HorizontalAlignment="{TemplateBinding HorizontalContentAlignment}"/>
          </Grid>
          <ControlTemplate.Triggers>
            <Trigger Property="IsMouseOver" Value="True">
              <Setter TargetName="Bd" Property="Background" Value="{DynamicResource Hover}"/>
            </Trigger>
            <Trigger Property="IsSelected" Value="True">
              <Setter TargetName="Bd" Property="Background" Value="{DynamicResource Selected}"/>
              <Setter TargetName="Bar" Property="Visibility" Value="Visible"/>
            </Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
    <Style.Triggers>
      <DataTrigger Binding="{Binding Kind}" Value="header">
        <Setter Property="Focusable" Value="False"/>
        <Setter Property="IsHitTestVisible" Value="False"/>
        <Setter Property="Cursor" Value="Arrow"/>
        <Setter Property="Padding" Value="16,16,14,6"/>
        <Setter Property="Template">
          <Setter.Value>
            <ControlTemplate TargetType="{x:Type ListBoxItem}">
              <ContentPresenter Margin="{TemplateBinding Padding}"/>
            </ControlTemplate>
          </Setter.Value>
        </Setter>
      </DataTrigger>
    </Style.Triggers>
  </Style>

  <Style TargetType="{x:Type ToolTip}">
    <Setter Property="Foreground" Value="{DynamicResource Text}"/>
    <Setter Property="FontSize" Value="12.5"/>
    <Setter Property="MaxWidth" Value="420"/>
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="{x:Type ToolTip}">
          <Border Background="{DynamicResource Surface}" BorderBrush="{DynamicResource BorderStrong}" BorderThickness="1" CornerRadius="6" Padding="9,5">
            <ContentPresenter>
              <ContentPresenter.Resources>
                <Style TargetType="{x:Type TextBlock}">
                  <Setter Property="TextWrapping" Value="Wrap"/>
                </Style>
              </ContentPresenter.Resources>
            </ContentPresenter>
          </Border>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>

  <Style TargetType="{x:Type ContextMenu}">
    <Setter Property="Foreground" Value="{DynamicResource Text}"/>
    <Setter Property="FontFamily" Value="Segoe UI"/>
    <Setter Property="FontSize" Value="13"/>
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="{x:Type ContextMenu}">
          <Border Background="{DynamicResource Surface}" BorderBrush="{DynamicResource BorderStrong}" BorderThickness="1" CornerRadius="8" Padding="4" MinWidth="220">
            <StackPanel IsItemsHost="True" KeyboardNavigation.DirectionalNavigation="Cycle"/>
          </Border>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>
  <Style TargetType="{x:Type MenuItem}">
    <Setter Property="Foreground" Value="{DynamicResource Text}"/>
    <Setter Property="Template">
      <Setter.Value>
        <ControlTemplate TargetType="{x:Type MenuItem}">
          <Border x:Name="Bd" Background="Transparent" CornerRadius="4" Padding="10,7">
            <DockPanel>
              <TextBlock DockPanel.Dock="Right" Text="{TemplateBinding InputGestureText}" Foreground="{DynamicResource TextFaint}" Margin="24,0,0,0"/>
              <ContentPresenter ContentSource="Header" RecognizesAccessKey="True"/>
            </DockPanel>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="IsHighlighted" Value="True">
              <Setter TargetName="Bd" Property="Background" Value="{DynamicResource Hover}"/>
            </Trigger>
            <Trigger Property="IsEnabled" Value="False">
              <Setter Property="Opacity" Value="0.45"/>
            </Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value>
    </Setter>
  </Style>

  <Style x:Key="Card" TargetType="{x:Type Border}">
    <Setter Property="Background" Value="{DynamicResource Surface}"/>
    <Setter Property="BorderBrush" Value="{DynamicResource Border}"/>
    <Setter Property="BorderThickness" Value="1"/>
    <Setter Property="CornerRadius" Value="10"/>
    <Setter Property="SnapsToDevicePixels" Value="True"/>
  </Style>
  <Style x:Key="Icon" TargetType="{x:Type TextBlock}">
    <Setter Property="FontFamily" Value="Segoe Fluent Icons, Segoe MDL2 Assets"/>
    <Setter Property="FontSize" Value="13"/>
    <Setter Property="VerticalAlignment" Value="Center"/>
    <Setter Property="Margin" Value="0,1,8,0"/>
  </Style>
  <Style x:Key="IconGlyph" TargetType="{x:Type TextBlock}">
    <Setter Property="FontFamily" Value="Segoe Fluent Icons, Segoe MDL2 Assets"/>
    <Setter Property="FontSize" Value="15"/>
    <Setter Property="HorizontalAlignment" Value="Center"/>
    <Setter Property="VerticalAlignment" Value="Center"/>
  </Style>
</ResourceDictionary>
'@

$WindowXaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Yonsei LearnUs Daily Brief"
        Width="1320" Height="820" MinWidth="520" MinHeight="460"
        WindowStartupLocation="CenterScreen" ShowInTaskbar="True" ShowActivated="True" Topmost="True"
        FontFamily="Segoe UI" FontSize="13"
        Background="{DynamicResource Bg}" Foreground="{DynamicResource Text}"
        UseLayoutRounding="True" SnapsToDevicePixels="True">
  <Grid>
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="*"/>
    </Grid.RowDefinitions>

    <!-- Status line -->
    <Grid Grid.Row="0" Margin="24,14,14,12">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="Auto"/>
      </Grid.ColumnDefinitions>
      <StackPanel VerticalAlignment="Center">
        <TextBlock x:Name="TodayText" FontSize="20" FontWeight="SemiBold" TextTrimming="CharacterEllipsis"/>
        <TextBlock x:Name="SummaryText" FontSize="13.5" Margin="0,3,0,0" TextWrapping="Wrap"/>
      </StackPanel>
      <StackPanel Grid.Column="1" Orientation="Horizontal" VerticalAlignment="Center">
        <TextBlock x:Name="UpdatedText" FontSize="12.5" Foreground="{DynamicResource TextFaint}" VerticalAlignment="Center" Margin="12,0,10,0" TextTrimming="CharacterEllipsis"/>
        <Button x:Name="UpdateButton" Style="{DynamicResource UpdateButton}" ToolTip="Check LearnUs now" AutomationProperties.Name="Update: check LearnUs now">
          <StackPanel Orientation="Horizontal">
            <TextBlock x:Name="UpdateGlyph" Style="{DynamicResource IconGlyph}" Text="&#xE72C;" FontSize="13" RenderTransformOrigin="0.5,0.5">
              <TextBlock.RenderTransform>
                <RotateTransform x:Name="UpdateSpin" Angle="0"/>
              </TextBlock.RenderTransform>
            </TextBlock>
            <TextBlock x:Name="UpdateLabel" Text="Update" VerticalAlignment="Center" Margin="7,0,0,1"/>
          </StackPanel>
        </Button>
        <Button x:Name="ThemeButton" Style="{DynamicResource IconButton}">
          <TextBlock x:Name="ThemeGlyph" Style="{DynamicResource IconGlyph}"/>
        </Button>
        <Button x:Name="MoreButton" Style="{DynamicResource IconButton}" ToolTip="More options" AutomationProperties.Name="More options">
          <TextBlock Style="{DynamicResource IconGlyph}" Text="&#xE712;"/>
        </Button>
      </StackPanel>
    </Grid>

    <StackPanel x:Name="BannerStack" Grid.Row="1">
      <!-- Stale / incomplete banner -->
      <Border x:Name="Banner" Visibility="Collapsed" Margin="16,0,16,12" Padding="14,9,14,10" CornerRadius="8"
              Background="{DynamicResource WarnSoft}" BorderBrush="{DynamicResource Warn}" BorderThickness="1">
        <DockPanel>
          <TextBlock Style="{DynamicResource IconGlyph}" Text="&#xE7BA;" FontSize="14" Foreground="{DynamicResource Warn}" Margin="0,1,10,0" VerticalAlignment="Top"/>
          <TextBlock x:Name="BannerText" TextWrapping="Wrap" Foreground="{DynamicResource Text}" FontSize="13"/>
        </DockPanel>
      </Border>
      <!-- Update status banner (waiting for another scan / failure / timeout) -->
      <Border x:Name="UpdateBanner" Visibility="Collapsed" Margin="16,0,16,12" Padding="14,5,6,6" CornerRadius="8"
              Background="{DynamicResource DangerSoft}" BorderBrush="{DynamicResource Danger}" BorderThickness="1"
              AutomationProperties.Name="Update status" AutomationProperties.LiveSetting="Polite">
        <DockPanel>
          <Button x:Name="UpdateBannerClose" DockPanel.Dock="Right" Style="{DynamicResource IconButton}" Width="28" Height="28" VerticalAlignment="Top"
                  ToolTip="Dismiss" AutomationProperties.Name="Dismiss update message">
            <TextBlock Style="{DynamicResource IconGlyph}" Text="&#xE711;" FontSize="11"/>
          </Button>
          <Button x:Name="UpdateBannerLog" DockPanel.Dock="Right" Style="{DynamicResource LinkButton}" Content="Open log" VerticalAlignment="Top"
                  Margin="8,3,4,0" Visibility="Collapsed" ToolTip="Open the scan log" AutomationProperties.Name="Open the scan log"/>
          <TextBlock x:Name="UpdateBannerGlyph" Style="{DynamicResource IconGlyph}" Text="&#xEA39;" FontSize="14" Margin="0,5,10,0" VerticalAlignment="Top"/>
          <TextBlock x:Name="UpdateBannerText" TextWrapping="Wrap" Foreground="{DynamicResource Text}" FontSize="13" Margin="0,4,0,0" VerticalAlignment="Top"/>
        </DockPanel>
      </Border>
    </StackPanel>

    <!-- Main -->
    <Grid x:Name="MainGrid" Grid.Row="2" Margin="16,0,16,16">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="300"/>
        <ColumnDefinition Width="14"/>
        <ColumnDefinition Width="5*"/>
        <ColumnDefinition Width="14"/>
        <ColumnDefinition Width="7*"/>
      </Grid.ColumnDefinitions>

      <Border x:Name="RailCard" Grid.Column="0" Style="{DynamicResource Card}" AutomationProperties.Name="Due">
        <ScrollViewer x:Name="RailScroll" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled" Focusable="False" Margin="0,2,2,2">
          <ContentControl x:Name="RailHost" Focusable="False" IsTabStop="False"/>
        </ScrollViewer>
      </Border>

      <Border x:Name="FeedCard" Grid.Column="2" Style="{DynamicResource Card}">
        <Grid>
          <Grid.RowDefinitions>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="*"/>
          </Grid.RowDefinitions>
          <Border x:Name="FeedHeaderHost" Grid.Row="0" BorderThickness="0,0,0,1" BorderBrush="{DynamicResource Border}">
            <StackPanel x:Name="FeedHeader" Margin="18,14,16,8">
              <DockPanel>
                <Button x:Name="MarkReadButton" DockPanel.Dock="Right" Style="{DynamicResource LinkButton}" Content="Mark all read" VerticalAlignment="Center"
                        ToolTip="Clear the New and Updated badges" AutomationProperties.Name="Mark all announcements as read"/>
                <TextBlock Text="Announcements" FontSize="16" FontWeight="SemiBold" VerticalAlignment="Center"/>
                <TextBlock x:Name="FeedCount" FontSize="13" Foreground="{DynamicResource TextFaint}" Margin="8,2,0,0" VerticalAlignment="Center"/>
              </DockPanel>
              <Grid x:Name="SearchRow" Margin="0,10,0,4">
                <Grid.ColumnDefinitions>
                  <ColumnDefinition Width="*"/>
                  <ColumnDefinition Width="Auto"/>
                </Grid.ColumnDefinitions>
                <TextBox x:Name="SearchBox" Style="{DynamicResource SearchBox}" Tag="Search  (Ctrl+F)" AutomationProperties.Name="Search announcements"/>
                <Button x:Name="ClearSearchButton" Style="{DynamicResource IconButton}" HorizontalAlignment="Right" Width="30" Height="30" Margin="0,0,3,0"
                        Visibility="Collapsed" ToolTip="Clear search (Esc)" AutomationProperties.Name="Clear search">
                  <TextBlock Style="{DynamicResource IconGlyph}" Text="&#xE711;" FontSize="11"/>
                </Button>
                <Button x:Name="FilterButton" Grid.Column="1" Margin="8,0,0,0" Height="36" Padding="11,0,9,0" ToolTip="Show one course only">
                  <StackPanel Orientation="Horizontal">
                    <Ellipse x:Name="FilterDot" Width="8" Height="8" Margin="0,1,7,0" VerticalAlignment="Center" Visibility="Collapsed"/>
                    <TextBlock x:Name="FilterLabel" Text="All courses" VerticalAlignment="Center" MaxWidth="150" TextTrimming="CharacterEllipsis"/>
                    <TextBlock Style="{DynamicResource IconGlyph}" Text="&#xE70D;" FontSize="10" Margin="8,2,0,0" Foreground="{DynamicResource TextMuted}"/>
                  </StackPanel>
                </Button>
              </Grid>
            </StackPanel>
          </Border>
          <ScrollViewer x:Name="FeedScroll" Grid.Row="1" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled" Focusable="False" Margin="0,0,2,2">
            <StackPanel>
              <StackPanel x:Name="FeedTop"/>
              <ListBox x:Name="FeedList" Style="{DynamicResource FeedListStyle}" ItemContainerStyle="{DynamicResource FeedItem}" AutomationProperties.Name="Announcements">
                <ListBox.ItemTemplate>
                  <DataTemplate>
                    <Grid>
                      <DockPanel Visibility="{Binding HeaderVisibility}">
                        <TextBlock Text="{Binding HeaderText}" FontSize="11.5" FontWeight="SemiBold" Foreground="{Binding HeaderBrush}"/>
                        <TextBlock Text="{Binding HeaderCount}" FontSize="11.5" FontWeight="SemiBold" Foreground="{DynamicResource TextFaint}" Margin="8,0,0,0"/>
                      </DockPanel>
                      <StackPanel Visibility="{Binding CardVisibility}">
                        <DockPanel>
                          <TextBlock DockPanel.Dock="Right" Text="{Binding DateLabel}" ToolTip="{Binding DateTooltip}" FontSize="12" Foreground="{DynamicResource TextFaint}" VerticalAlignment="Center" Margin="10,0,0,0"/>
                          <Border DockPanel.Dock="Right" Visibility="{Binding State.BadgeVisibility}" Background="{DynamicResource Accent}" CornerRadius="4" Padding="6,1,6,2" VerticalAlignment="Center" Margin="8,0,0,0">
                            <TextBlock Text="{Binding BadgeText}" FontSize="10.5" FontWeight="Bold" Foreground="{DynamicResource AccentText}"/>
                          </Border>
                          <Ellipse Width="8" Height="8" Fill="{Binding CourseBrush}" VerticalAlignment="Center" Margin="0,1,7,0"/>
                          <TextBlock Text="{Binding CourseShort}" Foreground="{Binding CourseBrush}" FontSize="12" FontWeight="SemiBold" TextTrimming="CharacterEllipsis" VerticalAlignment="Center"/>
                        </DockPanel>
                        <TextBlock Text="{Binding Title}" FontSize="14.5" FontWeight="{Binding State.TitleWeight}" TextWrapping="Wrap" TextTrimming="CharacterEllipsis"
                                   LineHeight="20" LineStackingStrategy="BlockLineHeight" MaxHeight="40" Margin="0,6,0,0"/>
                        <TextBlock Text="{Binding Preview}" FontStyle="{Binding PreviewStyle}" FontSize="12.5" Foreground="{DynamicResource TextMuted}" TextWrapping="Wrap" TextTrimming="CharacterEllipsis"
                                   LineHeight="18" LineStackingStrategy="BlockLineHeight" MaxHeight="36" Margin="0,4,0,0"/>
                        <WrapPanel Margin="0,7,0,0" Visibility="{Binding IndicatorVisibility}">
                          <StackPanel Orientation="Horizontal" Visibility="{Binding DueVisibility}" Margin="0,0,14,0">
                            <TextBlock Style="{DynamicResource Icon}" Text="&#xE787;" FontSize="12" Margin="0,1,5,0" Foreground="{Binding DueBrush}"/>
                            <TextBlock Text="{Binding DueText}" FontSize="12" FontWeight="SemiBold" Foreground="{Binding DueBrush}"/>
                          </StackPanel>
                          <StackPanel Orientation="Horizontal" Visibility="{Binding AttachVisibility}" Margin="0,0,14,0">
                            <TextBlock Style="{DynamicResource Icon}" Text="&#xE723;" FontSize="12" Margin="0,1,5,0" Foreground="{DynamicResource TextFaint}"/>
                            <TextBlock Text="{Binding AttachText}" FontSize="12" Foreground="{DynamicResource TextFaint}"/>
                          </StackPanel>
                          <StackPanel Orientation="Horizontal" Visibility="{Binding NoTextVisibility}">
                            <TextBlock Style="{DynamicResource Icon}" Text="&#xE7BA;" FontSize="12" Margin="0,1,5,0" Foreground="{DynamicResource TextFaint}"/>
                            <TextBlock Text="Text not extracted" FontSize="12" Foreground="{DynamicResource TextFaint}"/>
                          </StackPanel>
                        </WrapPanel>
                      </StackPanel>
                    </Grid>
                  </DataTemplate>
                </ListBox.ItemTemplate>
              </ListBox>
              <StackPanel x:Name="FeedEmpty" Visibility="Collapsed" Margin="28,36,28,36" HorizontalAlignment="Center">
                <TextBlock x:Name="FeedEmptyText" TextWrapping="Wrap" TextAlignment="Center" Foreground="{DynamicResource TextMuted}" FontSize="13.5"/>
                <Button x:Name="ClearFiltersButton" Content="Clear search and filter" Margin="0,14,0,0" HorizontalAlignment="Center"/>
              </StackPanel>
            </StackPanel>
          </ScrollViewer>
        </Grid>
      </Border>

      <Border x:Name="ReaderCard" Grid.Column="4" Style="{DynamicResource Card}">
        <Grid>
          <Grid.RowDefinitions>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="*"/>
          </Grid.RowDefinitions>
          <Border x:Name="ReaderBar" Grid.Row="0" BorderThickness="0,0,0,1" BorderBrush="{DynamicResource Border}" Padding="10,9,12,9">
            <DockPanel LastChildFill="False">
              <Button x:Name="BackButton" DockPanel.Dock="Left" Visibility="Collapsed" Margin="0,0,8,0" Padding="10,6" AutomationProperties.Name="Back to the list" ToolTip="Back to the list (Esc)">
                <StackPanel Orientation="Horizontal">
                  <TextBlock Style="{DynamicResource Icon}" Text="&#xE72B;"/>
                  <TextBlock Text="Back" VerticalAlignment="Center"/>
                </StackPanel>
              </Button>
              <Button x:Name="NewerButton" DockPanel.Dock="Left" Style="{DynamicResource IconButton}" ToolTip="Newer announcement" AutomationProperties.Name="Newer announcement">
                <TextBlock Style="{DynamicResource IconGlyph}" Text="&#xE70E;" FontSize="13"/>
              </Button>
              <Button x:Name="OlderButton" DockPanel.Dock="Left" Style="{DynamicResource IconButton}" ToolTip="Older announcement" AutomationProperties.Name="Older announcement">
                <TextBlock Style="{DynamicResource IconGlyph}" Text="&#xE70D;" FontSize="13"/>
              </Button>
              <TextBlock x:Name="ReaderPosition" DockPanel.Dock="Left" VerticalAlignment="Center" Margin="12,0,0,0" FontSize="12.5" Foreground="{DynamicResource TextFaint}"/>
              <Button x:Name="OpenLearnUsButton" DockPanel.Dock="Right" Style="{DynamicResource PrimaryButton}" IsEnabled="False" Padding="14,7"
                      ToolTip="Open the original announcement in your browser" AutomationProperties.Name="Open in LearnUs">
                <StackPanel Orientation="Horizontal">
                  <TextBlock Style="{DynamicResource Icon}" Text="&#xE8A7;"/>
                  <TextBlock Text="Open in LearnUs" VerticalAlignment="Center"/>
                </StackPanel>
              </Button>
            </DockPanel>
          </Border>
          <FlowDocumentScrollViewer x:Name="ReaderViewer" Grid.Row="1" IsToolBarVisible="False"
                                    VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled"
                                    Background="Transparent" FocusVisualStyle="{x:Null}" Margin="0,0,2,2"
                                    SelectionBrush="{DynamicResource Accent}" SelectionOpacity="0.35"
                                    AutomationProperties.Name="Announcement text"/>
          <Border x:Name="ReaderFocus" Grid.Row="0" Grid.RowSpan="2" BorderThickness="2" BorderBrush="{DynamicResource Accent}" CornerRadius="10"
                  Margin="-1" Visibility="Collapsed" IsHitTestVisible="False"/>
        </Grid>
      </Border>
    </Grid>
  </Grid>
</Window>
'@

if (-not [System.Windows.Application]::Current) {
    $null = New-Object System.Windows.Application
}
$App = [System.Windows.Application]::Current
$App.ShutdownMode = [System.Windows.ShutdownMode]::OnExplicitShutdown
$App.Resources.MergedDictionaries.Add([System.Windows.Markup.XamlReader]::Parse($ResourcesXaml))

# ---------------------------------------------------------------------------
# Theme switching (brushes are mutated in place so data-bound items follow)
# ---------------------------------------------------------------------------
$script:IsDark = if ($script:ThemeChoice) { $script:ThemeChoice -eq 'dark' } else { Get-SystemPrefersDark }
$script:WindowHandle = [IntPtr]::Zero

# DynamicResource consumers get fresh resource brushes; data-bound feed items hold "live" brushes
# that are recoloured in place (WPF may freeze or replace brushes stored in a ResourceDictionary).
$script:LiveBrushes = @{}
function Set-Palette([bool]$Dark) {
    $Palette = if ($Dark) { $Palettes.Dark } else { $Palettes.Light }
    foreach ($Key in $Palette.Keys) {
        $Color = [System.Windows.Media.ColorConverter]::ConvertFromString($Palette[$Key])
        # ::new (not New-Object): the dictionary indexer would otherwise store the PSObject wrapper.
        $App.Resources[$Key] = [System.Windows.Media.SolidColorBrush]::new($Color)
        if ($script:LiveBrushes.ContainsKey($Key)) { $script:LiveBrushes[$Key].Color = $Color }
        else { $script:LiveBrushes[$Key] = [System.Windows.Media.SolidColorBrush]::new($Color) }
    }
}
Set-Palette $script:IsDark

function Get-Brush([string]$Key) {
    if ($script:LiveBrushes.ContainsKey($Key)) { return $script:LiveBrushes[$Key] }
    return $script:LiveBrushes['TextMuted']
}

$Window = [System.Windows.Markup.XamlReader]::Parse($WindowXaml)
foreach ($Name in 'TodayText', 'SummaryText', 'UpdatedText', 'ThemeButton', 'ThemeGlyph', 'MoreButton', 'Banner', 'BannerText',
    'UpdateButton', 'UpdateGlyph', 'UpdateSpin', 'UpdateLabel', 'UpdateBanner', 'UpdateBannerClose', 'UpdateBannerLog', 'UpdateBannerGlyph', 'UpdateBannerText',
    'MainGrid', 'RailCard', 'RailScroll', 'RailHost', 'FeedCard', 'FeedHeaderHost', 'FeedHeader', 'MarkReadButton', 'FeedCount',
    'SearchRow', 'SearchBox', 'ClearSearchButton', 'FilterButton', 'FilterDot', 'FilterLabel', 'FeedScroll', 'FeedTop', 'FeedList', 'FeedEmpty', 'FeedEmptyText',
    'ClearFiltersButton', 'ReaderCard', 'BackButton', 'NewerButton', 'OlderButton', 'ReaderPosition', 'OpenLearnUsButton',
    'ReaderViewer', 'ReaderFocus', 'ReaderBar') {
    Set-Variable -Name $Name -Value $Window.FindName($Name)
}

function Set-Theme([bool]$Dark) {
    $script:IsDark = $Dark
    Set-Palette $Dark
    if ($Dark) {
        $ThemeGlyph.Text = [string][char]0xE706
        $ThemeButton.ToolTip = 'Switch to light theme'
        [System.Windows.Automation.AutomationProperties]::SetName($ThemeButton, 'Switch to light theme')
    }
    else {
        $ThemeGlyph.Text = [string][char]0xE708
        $ThemeButton.ToolTip = 'Switch to dark theme'
        [System.Windows.Automation.AutomationProperties]::SetName($ThemeButton, 'Switch to dark theme')
    }
    if ($script:DwmAvailable -and $script:WindowHandle -ne [IntPtr]::Zero) {
        $Palette = if ($Dark) { $Palettes.Dark } else { $Palettes.Light }
        try {
            [LearnUsBriefDwm]::Apply($script:WindowHandle, $Dark, (ConvertTo-ColorRef $Palette.Bg), (ConvertTo-ColorRef $Palette.Text), (ConvertTo-ColorRef $Palette.BorderStrong))
        }
        catch { }
    }
}

# ---------------------------------------------------------------------------
# Element builders
# ---------------------------------------------------------------------------
$FgProp = [System.Windows.Documents.TextElement]::ForegroundProperty
$BgProp = [System.Windows.Documents.TextElement]::BackgroundProperty
$TbFgProp = [System.Windows.Controls.TextBlock]::ForegroundProperty

function New-Thickness([double]$Left, [double]$Top, [double]$Right, [double]$Bottom) {
    return [System.Windows.Thickness]::new($Left, $Top, $Right, $Bottom)
}

function New-Text {
    param([string]$Text, [double]$Size = 13, [string]$Fg = 'Text', [string]$Weight = 'Normal', [switch]$Wrap, [int]$MaxLines = 0, [switch]$Italic)
    $Block = New-Object System.Windows.Controls.TextBlock
    $Block.Text = $Text
    $Block.FontSize = $Size
    $Block.FontWeight = [System.Windows.FontWeights]::$Weight
    if ($Fg) { $Block.SetResourceReference($TbFgProp, $Fg) }
    if ($Wrap) { $Block.TextWrapping = [System.Windows.TextWrapping]::Wrap }
    $Block.TextTrimming = [System.Windows.TextTrimming]::CharacterEllipsis
    if ($MaxLines -gt 0) {
        $LineHeight = [Math]::Round($Size * 1.4)
        $Block.LineHeight = $LineHeight
        $Block.LineStackingStrategy = [System.Windows.LineStackingStrategy]::BlockLineHeight
        $Block.MaxHeight = $LineHeight * $MaxLines
    }
    if ($Italic) { $Block.FontStyle = [System.Windows.FontStyles]::Italic }
    return $Block
}

function New-Glyph([int]$Code, [double]$Size = 13, [string]$Fg = 'TextMuted') {
    $Block = New-Object System.Windows.Controls.TextBlock
    $Block.Text = [string][char]$Code
    $Block.FontFamily = $IconFont
    $Block.FontSize = $Size
    $Block.VerticalAlignment = 'Center'
    if ($Fg) { $Block.SetResourceReference($TbFgProp, $Fg) }
    return $Block
}

function New-Dot([string]$Key, [double]$Size = 8) {
    $Ellipse = New-Object System.Windows.Shapes.Ellipse
    $Ellipse.Width = $Size
    $Ellipse.Height = $Size
    $Ellipse.SetResourceReference([System.Windows.Shapes.Shape]::FillProperty, $Key)
    $Ellipse.VerticalAlignment = 'Center'
    $Ellipse.Margin = New-Thickness 0 1 6 0
    return $Ellipse
}

function New-Run {
    param([string]$Text, [string]$Fg, [switch]$Bold, [double]$Size = 0, [switch]$Italic)
    $Run = [System.Windows.Documents.Run]::new($Text)
    if ($Fg) { $Run.SetResourceReference($FgProp, $Fg) }
    if ($Bold) { $Run.FontWeight = [System.Windows.FontWeights]::SemiBold }
    if ($Size -gt 0) { $Run.FontSize = $Size }
    if ($Italic) { $Run.FontStyle = [System.Windows.FontStyles]::Italic }
    return $Run
}

function New-Paragraph {
    param([double]$Size = 0, [double]$Top = 0, [double]$Bottom = 0, [double]$Left = 0, [double]$LineHeight = 0)
    $Paragraph = New-Object System.Windows.Documents.Paragraph
    $Paragraph.Margin = New-Thickness $Left $Top 0 $Bottom
    if ($Size -gt 0) { $Paragraph.FontSize = $Size }
    if ($LineHeight -gt 0) { $Paragraph.LineHeight = $LineHeight }
    return $Paragraph
}

function New-DocumentBase([double]$Size, [string]$Padding) {
    $Document = New-Object System.Windows.Documents.FlowDocument
    $Document.FontFamily = 'Segoe UI'
    $Document.FontSize = $Size
    $Document.PagePadding = [System.Windows.Thickness]$Padding
    $Document.TextAlignment = 'Left'
    $Document.LineHeight = [Math]::Round($Size * 1.6)
    $Document.SetResourceReference($FgProp, 'Text')
    return , $Document
}

function Open-Url([string]$Url) {
    if ($Url -match '^(https?://|mailto:)') {
        try { Start-Process $Url } catch { }
    }
}

function New-Link([string]$Text, [string]$Url) {
    $Link = New-Object System.Windows.Documents.Hyperlink
    $Link.Inlines.Add([System.Windows.Documents.Run]::new($Text))
    $Link.SetResourceReference($FgProp, 'Accent')
    $Link.Tag = $Url
    $Link.ToolTip = $Url
    $Link.Cursor = [System.Windows.Input.Cursors]::Hand
    $Link.Add_Click({
            param($LinkSender, $LinkArgs)
            Open-Url ([string]$LinkSender.Tag)
        })
    # The default dotted focus rectangle is nearly invisible; highlight the focused link instead.
    $Link.Add_GotKeyboardFocus({
            param($LinkSender, $FocusArgs)
            try { $LinkSender.SetResourceReference($BgProp, 'Selected') } catch { }
        })
    $Link.Add_LostKeyboardFocus({
            param($LinkSender, $FocusArgs)
            try { $LinkSender.ClearValue($BgProp) } catch { }
        })
    return $Link
}

$LinkRegex = New-Object System.Text.RegularExpressions.Regex('(?<url>https?://[^\s<>"]+)|(?<mail>[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})')

function Add-LinkifiedText {
    param($Inlines, [string]$Text, [string]$Fg = 'Text')
    $Position = 0
    foreach ($Match in $LinkRegex.Matches($Text)) {
        if ($Match.Index -gt $Position) { $Inlines.Add((New-Run -Text $Text.Substring($Position, $Match.Index - $Position) -Fg $Fg)) }
        $Value = $Match.Value
        $Trail = ''
        if ($Match.Groups['url'].Success) {
            while ($Value.Length -gt 8) {
                $Last = [string]$Value[$Value.Length - 1]
                if ('.,;:!?)]}>'.Contains($Last)) {
                    if ($Last -eq ')' -and $Value.Contains('(')) { break }
                    $Trail = $Last + $Trail
                    $Value = $Value.Substring(0, $Value.Length - 1)
                }
                else { break }
            }
            $Inlines.Add((New-Link $Value $Value))
        }
        else {
            $Inlines.Add((New-Link $Value ('mailto:' + $Value)))
        }
        if ($Trail) { $Inlines.Add((New-Run -Text $Trail -Fg $Fg)) }
        $Position = $Match.Index + $Match.Length
    }
    if ($Position -lt $Text.Length) { $Inlines.Add((New-Run -Text $Text.Substring($Position) -Fg $Fg)) }
}

function Find-VisualParent($Element, [type]$Type) {
    $Current = $Element
    while ($Current) {
        if ($Current -is $Type) { return $Current }
        if ($Current -is [System.Windows.Media.Visual] -or $Current -is [System.Windows.Media.Media3D.Visual3D]) {
            $Current = [System.Windows.Media.VisualTreeHelper]::GetParent($Current)
        }
        else {
            $Current = [System.Windows.LogicalTreeHelper]::GetParent($Current)
        }
    }
    return $null
}

# ---------------------------------------------------------------------------
# Smooth wheel scrolling for the feed, the Due rail and the reader
# ---------------------------------------------------------------------------
$script:ScrollAnims = New-Object System.Collections.ArrayList
$script:ScrollTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:ScrollTimer.Interval = [TimeSpan]::FromMilliseconds(15)
$script:ScrollTimer.Add_Tick({
        try {
            for ($i = $script:ScrollAnims.Count - 1; $i -ge 0; $i--) {
                $Anim = $script:ScrollAnims[$i]
                $Viewer = $Anim.Viewer
                $Current = $Viewer.VerticalOffset
                $Delta = $Anim.Target - $Current
                if ([Math]::Abs($Delta) -lt 0.75) {
                    $Viewer.ScrollToVerticalOffset($Anim.Target)
                    $script:ScrollAnims.RemoveAt($i)
                    continue
                }
                $Viewer.ScrollToVerticalOffset($Current + $Delta * 0.25)
            }
            if ($script:ScrollAnims.Count -eq 0) { $script:ScrollTimer.Stop() }
        }
        catch {
            $script:ScrollAnims.Clear()
            $script:ScrollTimer.Stop()
        }
    })

function Stop-SmoothScroll($Viewer) {
    for ($i = $script:ScrollAnims.Count - 1; $i -ge 0; $i--) {
        if ([object]::ReferenceEquals($script:ScrollAnims[$i].Viewer, $Viewer)) { $script:ScrollAnims.RemoveAt($i) }
    }
}

$script:WheelHandler = {
    param($WheelSender, $WheelArgs)
    try {
        $Viewer = $WheelSender
        if ($Viewer -isnot [System.Windows.Controls.ScrollViewer]) { return }
        if ($Viewer.ScrollableHeight -le 0) { return }
        $Anim = $null
        foreach ($Candidate in $script:ScrollAnims) {
            if ([object]::ReferenceEquals($Candidate.Viewer, $Viewer)) { $Anim = $Candidate }
        }
        $Base = if ($Anim) { $Anim.Target } else { $Viewer.VerticalOffset }
        $Target = [Math]::Max(0, [Math]::Min($Viewer.ScrollableHeight, $Base - ($WheelArgs.Delta / 120.0) * 104))
        if ($Anim) { $Anim.Target = $Target }
        else { [void]$script:ScrollAnims.Add([PSCustomObject]@{ Viewer = $Viewer; Target = $Target }) }
        $WheelArgs.Handled = $true
        if (-not $script:ScrollTimer.IsEnabled) { $script:ScrollTimer.Start() }
    }
    catch { }
}

function Enable-SmoothScroll($Viewer) {
    if ($Viewer) { $Viewer.Add_PreviewMouseWheel($script:WheelHandler) }
}

# ---------------------------------------------------------------------------
# Brief parsing (Markdown -> sections/items): viewer-parse.ps1
# ---------------------------------------------------------------------------
$BriefParsed = ConvertFrom-BriefMarkdown $Content
$Generated = $BriefParsed.Generated
$BriefParts = Get-BriefParts $BriefParsed.Sections
$BriefTasks = $BriefParts.Tasks
$RailNotes = $BriefParts.RailNotes
$BriefAnnouncementItems = $BriefParts.AnnouncementItems
$HealthPairs = $BriefParts.HealthPairs
$HealthNotes = $BriefParts.HealthNotes
$BriefFiles = $BriefParts.Files
$BriefFileNotes = $BriefParts.FileNotes
$BriefFilesPreview = $BriefParts.FilesPreview
$HealthOk = $BriefParts.HealthOk
$CoursesCheckedText = $BriefParts.CoursesChecked

# ---------------------------------------------------------------------------
# Announcements (loading, cleaning and date extraction: viewer-parse.ps1)
# ---------------------------------------------------------------------------
$HistoryRead = Read-AnnouncementHistory $(if ($HasHistory) { $HistoryPath } else { '' })
$Announcements = @($HistoryRead.Announcements)
if ($HistoryRead.Error) { $script:HistoryError = $HistoryRead.Error }

$Models = New-Object System.Collections.Generic.List[object]
foreach ($Announcement in $Announcements) {
    try { $Models.Add((ConvertTo-AnnouncementModel $Announcement)) }
    catch { }
}

$SortedModels = @($Models | Sort-Object -Property @{ Expression = { if ($_.Posted) { $_.Posted } else { [datetime]::MinValue } }; Descending = $true }, @{ Expression = { if ($_.FirstSeen) { $_.FirstSeen } else { [datetime]::MinValue } }; Descending = $true }, @{ Expression = { $_.Title }; Descending = $false })

# Course colour assignment (stable: alphabetical order of every course we know about).
$CourseSet = @{}
foreach ($Model in $SortedModels) { $CourseSet[$Model.CourseFull.ToUpperInvariant()] = $Model.CourseFull }
foreach ($Entry in $BriefTasks) { if ($Entry.Task.Course) { $CourseSet[$Entry.Task.Course.ToUpperInvariant()] = $Entry.Task.Course } }
$script:CourseIndex = @{}
$Index = 0
foreach ($Key in ($CourseSet.Keys | Sort-Object)) {
    $script:CourseIndex[$Key] = $Index % 6
    $Index++
}

function Get-CourseKey([string]$Course) {
    $Key = if ($Course) { $Course.ToUpperInvariant() } else { '' }
    if ($script:CourseIndex.ContainsKey($Key)) { return ('Course' + $script:CourseIndex[$Key]) }
    return 'TextMuted'
}

# New / updated detection.
$Threshold = if ($LastOpened) { $LastOpened } else { (Get-Date).Date.AddDays(-3) }
$MinFirstSeen = $null
foreach ($Model in $SortedModels) {
    if ($Model.FirstSeen -and (-not $MinFirstSeen -or $Model.FirstSeen -lt $MinFirstSeen)) { $MinFirstSeen = $Model.FirstSeen }
}

# ---------------------------------------------------------------------------
# Feed cards
# ---------------------------------------------------------------------------
$script:Cards = New-Object System.Collections.Generic.List[object]
$script:CardById = @{}
$Today = (Get-Date).Date

foreach ($Model in $SortedModels) {
    $Effective = $Model.FirstSeen
    if ($Effective -and $MinFirstSeen -and ($Effective - $MinFirstSeen).TotalMinutes -le 10 -and $Model.Posted) {
        # The monitor's first scan stamps everything at once; use the posting date for that batch.
        $Effective = $Model.Posted
    }
    $IsNew = [bool]($Effective -and $Effective -ge $Threshold)
    $WasUpdated = [bool]($Model.BodyUpdated -and $Model.FirstCaptured -and ($Model.BodyUpdated - $Model.FirstCaptured).TotalMinutes -gt 2)
    $IsUpdated = (-not $IsNew) -and $WasUpdated -and $Model.BodyUpdated -ge $Threshold
    if (-not $IsNew -and -not $IsUpdated -and $CarriedUnread.ContainsKey($Model.Id)) {
        if ($WasUpdated) { $IsUpdated = $true } else { $IsNew = $true }
    }
    # Already read in another viewer window after it became new/updated (an older window may have been open meanwhile).
    $UnreadSince = if ($IsUpdated -and $Model.BodyUpdated) { $Model.BodyUpdated } elseif ($IsNew -and $Effective) { $Effective } else { [datetime]::MinValue }
    if (($IsNew -or $IsUpdated) -and $ReadAtOnDisk.ContainsKey($Model.Id) -and $ReadAtOnDisk[$Model.Id] -ge $UnreadSince) { $IsNew = $false; $IsUpdated = $false }
    $Badge =if ($IsNew) { 'NEW' } elseif ($IsUpdated) { 'UPDATED' } else { '' }

    $State = [LearnUsFeedState]::new()
    $State.IsUnread = [bool]$Badge

    $DueMention = $null
    foreach ($Mention in $Model.Mentions) {
        if ($Mention.IsDeadline -and $Mention.Date.Date -ge $Today) { $DueMention = $Mention; break }
    }
    $DueText = ''
    $DueKey = 'TextMuted'
    if ($DueMention) {
        $DueText = 'Due ' + (Format-ShortDate $DueMention.Date)
        if ($DueMention.HasTime) { $DueText += ', ' + $DueMention.Date.ToString('HH:mm', $Invariant) }
        if (($DueMention.Date.Date - $Today).Days -le 3) { $DueKey = 'Warn' }
    }
    $AttachCount = $Model.Attachments.Count
    $AttachText = if ($AttachCount -eq 1) { '1 file' } else { "$AttachCount files" }
    $CourseKey = Get-CourseKey $Model.CourseFull
    $DateLabel = if ($Model.Posted) { Format-ListDate $Model.Posted } else { 'Undated' }
    $DateTooltip = if ($Model.Posted) { 'Posted ' + $Model.Posted.ToString('dddd, MMMM d, yyyy', $Invariant) } else { 'Posting date unknown' }

    $A11y = New-Object System.Collections.Generic.List[string]
    if ($Badge) { $A11y.Add($Badge.ToLowerInvariant()) }
    $A11y.Add($Model.CourseShort)
    $A11y.Add($Model.Title)
    $A11y.Add($DateLabel)
    if ($DueText) { $A11y.Add($DueText) }
    if ($AttachCount) { $A11y.Add($AttachText) }

    $Card = [PSCustomObject]@{
        Kind                = 'card'
        HeaderVisibility    = 'Collapsed'
        CardVisibility      = 'Visible'
        HeaderText          = ''
        HeaderCount         = ''
        HeaderBrush         = (Get-Brush 'TextFaint')
        Model               = $Model
        Id                  = $Model.Id
        Title               = $Model.Title
        CourseShort         = $Model.CourseShort
        CourseKey           = $CourseKey
        CourseBrush         = (Get-Brush $CourseKey)
        DateLabel           = $DateLabel
        DateTooltip         = $DateTooltip
        BadgeText           = $Badge
        State               = $State
        Preview             = $Model.Preview
        PreviewStyle        = $(if ($Model.NotExtracted) { 'Italic' } else { 'Normal' })
        DueText             = $DueText
        DueBrush            = (Get-Brush $DueKey)
        DueVisibility       = $(if ($DueText) { 'Visible' } else { 'Collapsed' })
        AttachText          = $AttachText
        AttachVisibility    = $(if ($AttachCount) { 'Visible' } else { 'Collapsed' })
        NoTextVisibility    = 'Collapsed'
        IndicatorVisibility = $(if ($DueText -or $AttachCount) { 'Visible' } else { 'Collapsed' })
        A11yName            = (($A11y -join ', ').Replace($WordJoiner, ''))
        InNewGroup          = [bool]$Badge
        WeekLabel           = (Get-WeekLabel $Model.Posted)
        UnreadSince         = $UnreadSince
    }
    $script:Cards.Add($Card)
    $script:CardById[$Model.Id] = $Card
}
$script:NewCount = @($script:Cards | Where-Object { $_.InNewGroup }).Count

# ---------------------------------------------------------------------------
# Due items (brief tasks + dates found in recent announcements)
# ---------------------------------------------------------------------------
$Now = Get-Date
$DueItems = Get-DueItems $BriefTasks $script:Cards $Now

function Get-DueGroup($Item) {
    $Days = ($Item.Date.Date - $Today).Days
    if ($Item.Date -lt $Now) {
        if ($Item.Date -lt $Now.AddDays(-7)) { return 'missed' }
        return 'overdue'
    }
    if ($Days -eq 0) { return 'today' }
    if ($Days -eq 1) { return 'tomorrow' }
    if ($Days -le 6) { return 'week' }
    return 'later'
}

# Groups the open (unresolved) items; resolved ones are collected separately for the fold at the bottom.
function Update-DueGroups {
    $Groups = @{ overdue = @(); missed = @(); today = @(); tomorrow = @(); week = @(); later = @(); resolved = @() }
    foreach ($Item in ($DueItems | Sort-Object -Property Date)) {
        if ($script:ResolvedIds.ContainsKey($Item.Id)) { $Groups['resolved'] = @($Groups['resolved']) + $Item; continue }
        $Group = Get-DueGroup $Item
        $Groups[$Group] = @($Groups[$Group]) + $Item
    }
    $script:DueGroups = $Groups
}
Update-DueGroups

# ---------------------------------------------------------------------------
# Due panel (lives in the left rail on wide windows, above the feed otherwise)
# ---------------------------------------------------------------------------
# Rows are wrapped so the quiet "resolve" button can appear on hover / keyboard focus; the wrappers are
# remembered (per panel) so focus can move to the neighbouring row after a row disappears.
$script:DueRowsWide = New-Object System.Collections.Generic.List[object]
$script:DueRowsCompact = New-Object System.Collections.Generic.List[object]

function New-ResolveAction($Item, [bool]$IsResolved) {
    $Button = New-Object System.Windows.Controls.Button
    $Button.Tag = $Item
    $Title = $Item.Title.Replace($WordJoiner, '')
    if ($IsResolved) {
        $Button.Style = $App.Resources['LinkButton']
        $Button.Content = 'Unresolve'
        $Button.FontSize = 12
        $Button.Padding = New-Thickness 6 1 6 1
        $Button.ToolTip = 'Move back to the Due list (R)'
        [System.Windows.Automation.AutomationProperties]::SetName($Button, "Unresolve: $Title")
    }
    else {
        $Button.Style = $App.Resources['RowAction']
        $Button.Content = (New-Glyph 0xE73E 12 '')
        $Button.Opacity = 0
        $Button.ToolTip = 'Mark as resolved (R)'
        [System.Windows.Automation.AutomationProperties]::SetName($Button, "Mark as resolved: $Title")
    }
    $Button.Add_Click({
            param($ActionSender, $ActionArgs)
            try { Switch-DueResolved $ActionSender.Tag } catch { }
        })
    return $Button
}

function New-DueRowWrapper($Row, $Item, $Action, [bool]$IsResolved, [bool]$WrapperFocusable, $Sink) {
    # A Label (not a Grid/Border, which have no UI Automation peer) so the row gets its own UI Automation element and accessible name.
    $Wrapper = New-Object System.Windows.Controls.Label
    $Wrapper.Style = $App.Resources['DueRowHost']
    $Wrapper.Content = $Row
    $Target = if ($WrapperFocusable) { $Wrapper } else { $Row }
    $Wrapper.Tag = [PSCustomObject]@{ Id = $Item.Id; Item = $Item; Action = $Action; Target = $Target }
    if ($WrapperFocusable) {
        $Wrapper.Focusable = $true
        $Wrapper.IsTabStop = $true
        $Wrapper.FocusVisualStyle = $App.Resources['ItemFocusRing']
        $Wrapper.Add_PreviewMouseLeftButtonDown({
                param($WrapSender, $WrapArgs)
                try { if (-not ($WrapArgs.OriginalSource -is [System.Windows.Controls.Primitives.ButtonBase])) { $null = $WrapSender.Focus() } } catch { }
            })
    }
    if (-not $IsResolved) {
        $Wrapper.Add_MouseEnter({ param($WrapSender, $WrapArgs) try { $WrapSender.Tag.Action.Opacity = 1 } catch { } })
        $Wrapper.Add_MouseLeave({ param($WrapSender, $WrapArgs) try { if (-not $WrapSender.IsKeyboardFocusWithin) { $WrapSender.Tag.Action.Opacity = 0 } } catch { } })
        $Wrapper.Add_IsKeyboardFocusWithinChanged({
                param($WrapSender, $WrapArgs)
                try { $WrapSender.Tag.Action.Opacity = $(if ($WrapSender.IsKeyboardFocusWithin -or $WrapSender.IsMouseOver) { 1 } else { 0 }) } catch { }
            })
    }
    $Wrapper.Add_KeyDown({
            param($WrapSender, $WrapArgs)
            try {
                if ($WrapArgs.Key -eq [System.Windows.Input.Key]::R -and [System.Windows.Input.Keyboard]::Modifiers -eq [System.Windows.Input.ModifierKeys]::None) {
                    $WrapArgs.Handled = $true
                    Switch-DueResolved $WrapSender.Tag.Item
                }
            }
            catch { }
        })

    $Menu = New-Object System.Windows.Controls.ContextMenu
    $Entry = New-Object System.Windows.Controls.MenuItem
    $Entry.Header = $(if ($IsResolved) { 'Unresolve' } else { 'Mark as resolved' })
    $Entry.InputGestureText = 'R'
    $Entry.Tag = $Item
    $Entry.Add_Click({ param($EntrySender, $EntryArgs) try { Switch-DueResolved $EntrySender.Tag } catch { } })
    $Menu.Items.Add($Entry) | Out-Null
    if ($Item.Source -eq 'announcement' -and $Item.Card) {
        $OpenEntry = New-Object System.Windows.Controls.MenuItem
        $OpenEntry.Header = 'Open the announcement'
        $OpenEntry.Tag = $Item.Card
        $OpenEntry.Add_Click({ param($EntrySender, $EntryArgs) try { Select-Card $EntrySender.Tag -Open } catch { } })
        $Menu.Items.Add($OpenEntry) | Out-Null
    }
    $Wrapper.ContextMenu = $Menu
    $Sink.Add($Wrapper)
    return $Wrapper
}

function New-DueRow($Item, [string]$Group, [bool]$IsResolved = $false) {
    $TimeFg = switch ($Group) { 'overdue' { 'Danger' } 'today' { 'Warn' } 'tomorrow' { 'Warn' } 'week' { 'Text' } default { 'TextMuted' } }
    $Grid = New-Object System.Windows.Controls.Grid
    $Col0 = New-Object System.Windows.Controls.ColumnDefinition
    $Col0.Width = [System.Windows.GridLength]::new(58)
    $Col1 = New-Object System.Windows.Controls.ColumnDefinition
    $Col1.Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
    $Grid.ColumnDefinitions.Add($Col0)
    $Grid.ColumnDefinitions.Add($Col1)

    $Time = $Item.Date.ToString('HH:mm', $Invariant)
    switch ($Group) {
        { $_ -in 'today', 'tomorrow' } {
            if ($Item.HasTime) { $Line1 = $Time; $Line2 = '' } else { $Line1 = 'Any time'; $Line2 = '' }
        }
        'week' { $Line1 = $Item.Date.ToString('ddd', $Invariant); $Line2 = $(if ($Item.HasTime) { $Time } else { $Item.Date.ToString('MMM d', $Invariant) }) }
        default { $Line1 = $Item.Date.ToString('MMM d', $Invariant); $Line2 = $(if ($Item.HasTime) { $Time } else { $Item.Date.ToString('ddd', $Invariant) }) }
    }
    $TimeStack = New-Object System.Windows.Controls.StackPanel
    $TimeStack.Children.Add((New-Text -Text $Line1 -Size 13 -Fg $TimeFg -Weight 'SemiBold')) | Out-Null
    if ($Line2) { $TimeStack.Children.Add((New-Text -Text $Line2 -Size 11.5 -Fg 'TextFaint')) | Out-Null }
    $Grid.Children.Add($TimeStack) | Out-Null

    $Body = New-Object System.Windows.Controls.StackPanel
    [System.Windows.Controls.Grid]::SetColumn($Body, 1)
    $Body.Children.Add((New-Text -Text $Item.Title -Size 13.5 -Fg 'Text' -Weight 'SemiBold' -Wrap -MaxLines 2)) | Out-Null
    $CourseLine = New-Object System.Windows.Controls.StackPanel
    $CourseLine.Orientation = 'Horizontal'
    $CourseLine.Margin = New-Thickness 0 3 0 0
    $CourseKey = Get-CourseKey $Item.Course
    $CourseLine.Children.Add((New-Dot $CourseKey 7)) | Out-Null
    $CourseLine.Children.Add((New-Text -Text (Get-CourseShortName $Item.Course) -Size 12 -Fg $CourseKey)) | Out-Null
    $Action = New-ResolveAction $Item $IsResolved
    [System.Windows.Controls.DockPanel]::SetDock($Action, [System.Windows.Controls.Dock]::Right)
    $Action.Margin = New-Thickness 6 (-5) 0 (-5)
    $CourseDock = New-Object System.Windows.Controls.DockPanel
    $CourseDock.Margin = New-Thickness 0 3 0 0
    if (-not $IsResolved) { $CourseDock.Children.Add($Action) | Out-Null }
    $CourseDock.Children.Add($CourseLine) | Out-Null
    $CourseLine.Margin = New-Thickness 0 0 0 0
    $Body.Children.Add($CourseDock) | Out-Null
    $Extra = New-Object System.Collections.Generic.List[string]
    if ($Group -in 'later', 'overdue', 'missed') { $Extra.Add((Get-RelativeDayText $Item.Date)) }
    if ($Item.Status) { $Extra.Add($Item.Status) }
    if ($Item.Source -eq 'announcement' -or $Extra.Count) {
        $Info = New-Object System.Windows.Controls.WrapPanel
        $Info.Margin = New-Thickness 0 2 0 0
        if ($Item.Source -eq 'announcement') {
            $TagGlyph = New-Glyph 0xE789 11.5 'Accent'
            $TagGlyph.Margin = New-Thickness 0 1 5 0
            $Info.Children.Add($TagGlyph) | Out-Null
            $Info.Children.Add((New-Text -Text 'From an announcement' -Size 12 -Fg 'Accent')) | Out-Null
            if ($Extra.Count) { $Info.Children.Add((New-Text -Text "  $Dot  " -Size 12 -Fg 'TextFaint')) | Out-Null }
        }
        if ($Extra.Count) { $Info.Children.Add((New-Text -Text ($Extra -join "  $Dot  ") -Size 12 -Fg 'TextFaint')) | Out-Null }
        $Body.Children.Add($Info) | Out-Null
    }
    $Grid.Children.Add($Body) | Out-Null
    if ($IsResolved) {
        $TimeStack.Opacity = 0.6
        foreach ($Child in $Body.Children) { if (-not [object]::ReferenceEquals($Child, $CourseDock)) { $Child.Opacity = 0.6 } }
        $CourseLine.Opacity = 0.6
        # Resolved rows keep the (undimmed) Unresolve link on its own line so the course name is not squeezed.
        $Action.Margin = New-Thickness (-2) 2 0 0
        $Body.Children.Add($Action) | Out-Null
    }

    $When = (Format-ShortDate $Item.Date)
    if ($Item.HasTime) { $When += ' ' + $Time }
    $Name = "$($Item.Title.Replace($WordJoiner, '')), $(Get-CourseDisplayName $Item.Course), due $When"
    if ($IsResolved) { $Name += ', resolved' }
    if ($Item.Source -eq 'announcement') {
        $Row = New-Object System.Windows.Controls.Button
        $Row.Style = $App.Resources['RowButton']
        $Row.Content = $Grid
        $Row.Tag = $Item.Card
        $Tip = 'Found in the announcement "' + $Item.Title + '"'
        if ($Item.Context) { $Tip += ":`n" + $Item.Context }
        $Row.ToolTip = $Tip
        $Row.Add_Click({
                param($RowSender, $RowArgs)
                try { Select-Card $RowSender.Tag -Open } catch { }
            })
        [System.Windows.Automation.AutomationProperties]::SetName($Row, "$Name, from an announcement. Open the announcement.")
    }
    else {
        $Row = New-Object System.Windows.Controls.Border
        $Row.Padding = New-Thickness 8 7 8 8
        $Row.Child = $Grid
    }
    $Wrapper = New-DueRowWrapper $Row $Item $Action $IsResolved ($Item.Source -ne 'announcement') $script:DueRowsWide
    [System.Windows.Automation.AutomationProperties]::SetHelpText($Wrapper, $(if ($IsResolved) { 'Press R to move it back to the Due list.' } else { 'Press R to mark it as resolved.' }))
    if ($Item.Source -ne 'announcement') { [System.Windows.Automation.AutomationProperties]::SetName($Wrapper, $Name) }
    $Wrapper.Margin = New-Thickness 0 1 0 1
    return $Wrapper
}

function New-RailHeader([string]$Text, [string]$Fg, [string]$Count, [double]$Top = 14) {
    $Panel = New-Object System.Windows.Controls.StackPanel
    $Panel.Orientation = 'Horizontal'
    $Panel.Margin = New-Thickness 8 $Top 8 3
    $Panel.Children.Add((New-Text -Text $Text -Size 12.5 -Fg $Fg -Weight 'SemiBold')) | Out-Null
    if ($Count) {
        $CountText = New-Text -Text $Count -Size 12.5 -Fg 'TextFaint' -Weight 'SemiBold'
        $CountText.Margin = New-Thickness 8 0 0 0
        $Panel.Children.Add($CountText) | Out-Null
    }
    return $Panel
}

# Open/closed state of the folds survives a rebuild of the Due panels (keyed by Key).
$script:OpenFolds = @{}
function New-ToggleSection($Parent, [string]$ShowText, [string]$HideText, $Rows, [string]$Key = '') {
    $Hidden = New-Object System.Windows.Controls.StackPanel
    $Hidden.Visibility = 'Collapsed'
    foreach ($Row in $Rows) { $Hidden.Children.Add($Row) | Out-Null }
    $Toggle = New-Object System.Windows.Controls.Button
    $Toggle.Style = $App.Resources['LinkButton']
    $Toggle.Content = $ShowText
    $Toggle.Margin = New-Thickness 6 2 6 2
    $Toggle.Padding = New-Thickness 4 3 4 3
    $Toggle.Tag = [PSCustomObject]@{ Panel = $Hidden; Show = $ShowText; Hide = $HideText; Key = $Key }
    if ($Key -and $script:OpenFolds[$Key]) { $Hidden.Visibility = 'Visible'; $Toggle.Content = $HideText }
    $Toggle.Add_Click({
            param($ToggleSender, $ToggleArgs)
            try {
                $Info = $ToggleSender.Tag
                if ($Info.Panel.Visibility -eq 'Visible') { $Info.Panel.Visibility = 'Collapsed'; $ToggleSender.Content = $Info.Show }
                else { $Info.Panel.Visibility = 'Visible'; $ToggleSender.Content = $Info.Hide }
                if ($Info.Key) { $script:OpenFolds[$Info.Key] = ($Info.Panel.Visibility -eq 'Visible') }
            }
            catch { }
        })
    $Parent.Children.Add($Hidden) | Out-Null
    $Parent.Children.Add($Toggle) | Out-Null
}

# "New course files" from the downloader: one compact row per file (name, course, Open file / Open folder)
# instead of the raw local paths the brief carries.
function Open-BriefFile([string]$Path, [switch]$Folder) {
    try {
        if ($Folder) {
            if (Test-Path -LiteralPath $Path -PathType Leaf) { Start-Process -FilePath 'explorer.exe' -ArgumentList ('/select,"{0}"' -f $Path); return }
            $Parent = Split-Path -Parent $Path
            if ($Parent -and (Test-Path -LiteralPath $Parent)) { Start-Process -FilePath 'explorer.exe' -ArgumentList ('"{0}"' -f $Parent); return }
        }
        elseif (Test-Path -LiteralPath $Path -PathType Leaf) { Start-Process -FilePath $Path; return }
        Show-Transient 'That file is no longer there'
    }
    catch { Show-Transient 'Could not open it' }
}

function New-FileLink([string]$Text, [string]$Path, [switch]$Folder, [string]$Name) {
    $Button = New-Object System.Windows.Controls.Button
    $Button.Style = $App.Resources['LinkButton']
    $Button.Content = $Text
    $Button.FontSize = 12
    $Button.Padding = New-Thickness 5 1 5 1
    $Button.Tag = [PSCustomObject]@{ Path = $Path; Folder = [bool]$Folder }
    $Button.ToolTip = $(if ($Folder) { 'Show it in File Explorer' } else { 'Open with the default app' })
    [System.Windows.Automation.AutomationProperties]::SetName($Button, "$Text`: $Name")
    $Button.Add_Click({
            param($LinkSender, $LinkArgs)
            try { Open-BriefFile $LinkSender.Tag.Path -Folder:($LinkSender.Tag.Folder) } catch { }
        })
    return $Button
}

function New-FileRow($File) {
    $Row = New-Object System.Windows.Controls.StackPanel
    $Row.Margin = New-Thickness 8 4 8 4
    $Name = if ($File.IsLink) { $File.Title } else { $File.Name }
    $NameLine = New-Object System.Windows.Controls.DockPanel
    $Glyph = New-Glyph $(if ($File.IsLink) { 0xE71B } else { 0xE8A5 }) 12.5 'TextMuted'
    $Glyph.Margin = New-Thickness 0 1 7 0
    $NameLine.Children.Add($Glyph) | Out-Null
    $NameText = New-Text -Text $Name -Size 13 -Fg 'Text'
    $NameText.ToolTip = $(if ($File.Title -and $File.Title -ne $Name) { $File.Title + "`n" + $File.Path } else { $File.Path })
    $NameLine.Children.Add($NameText) | Out-Null
    $Row.Children.Add($NameLine) | Out-Null
    $Meta = New-Object System.Windows.Controls.DockPanel
    $Meta.Margin = New-Thickness 19 1 0 0
    $Links = New-Object System.Windows.Controls.StackPanel
    $Links.Orientation = 'Horizontal'
    [System.Windows.Controls.DockPanel]::SetDock($Links, [System.Windows.Controls.Dock]::Right)
    $Links.Margin = New-Thickness 6 (-2) (-5) (-2)
    $Links.Children.Add((New-FileLink $(if ($File.IsLink) { 'Open link' } else { 'Open file' }) $File.Path -Name $Name)) | Out-Null
    $Links.Children.Add((New-FileLink 'Open folder' $File.Path -Folder -Name $Name)) | Out-Null
    $Meta.Children.Add($Links) | Out-Null
    $CourseKey = Get-CourseKey $File.Course
    $CourseLine = New-Object System.Windows.Controls.StackPanel
    $CourseLine.Orientation = 'Horizontal'
    $CourseLine.Children.Add((New-Dot $CourseKey 7)) | Out-Null
    $CourseLine.Children.Add((New-Text -Text (Get-CourseShortName $File.Course) -Size 12 -Fg $(if ($CourseKey -eq 'TextMuted') { 'TextFaint' } else { $CourseKey }))) | Out-Null
    $Meta.Children.Add($CourseLine) | Out-Null
    $Row.Children.Add($Meta) | Out-Null
    [System.Windows.Automation.AutomationProperties]::SetName($Row, "$Name, $(Get-CourseDisplayName $File.Course)")
    return $Row
}

# Adds the "New files" group to a Due panel: the first few rows, the rest behind a fold, then any notes.
function Add-FilesGroup($Panel, [string]$FoldKey, [double]$Top = 18) {
    if (-not $BriefFiles.Count -and -not $BriefFileNotes.Count) { return }
    $Head = New-Object System.Windows.Controls.StackPanel
    $Head.Orientation = 'Horizontal'
    $Head.Margin = New-Thickness 8 $Top 8 2
    $HeadGlyph = New-Glyph 0xE896 12.5 'Accent'
    $HeadGlyph.Margin = New-Thickness 0 1 7 0
    $Head.Children.Add($HeadGlyph) | Out-Null
    $Head.Children.Add((New-Text -Text $(if ($BriefFilesPreview) { 'New files (preview, not saved yet)' } else { 'New files' }) -Size 12.5 -Fg 'TextMuted' -Weight 'SemiBold')) | Out-Null
    if ($BriefFiles.Count) {
        $HeadCount = New-Text -Text ([string]$BriefFiles.Count) -Size 12.5 -Fg 'TextFaint' -Weight 'SemiBold'
        $HeadCount.Margin = New-Thickness 8 0 0 0
        $Head.Children.Add($HeadCount) | Out-Null
    }
    $Panel.Children.Add($Head) | Out-Null
    $Shown = [Math]::Min(4, $BriefFiles.Count)
    for ($i = 0; $i -lt $Shown; $i++) { $Panel.Children.Add((New-FileRow $BriefFiles[$i])) | Out-Null }
    if ($BriefFiles.Count -gt $Shown) {
        $Rest = @()
        for ($i = $Shown; $i -lt $BriefFiles.Count; $i++) { $Rest += (New-FileRow $BriefFiles[$i]) }
        New-ToggleSection $Panel ('Show ' + ($BriefFiles.Count - $Shown) + ' more') 'Show fewer' $Rest $FoldKey
    }
    foreach ($Text in $BriefFileNotes) {
        $Line = New-Text -Text $Text -Size 12.5 -Fg 'Warn' -Wrap
        $Line.Margin = New-Thickness 27 4 8 2
        $Panel.Children.Add($Line) | Out-Null
    }
}

function Build-DuePanel {
    $script:DueRowsWide.Clear()
    $Panel = New-Object System.Windows.Controls.StackPanel
    $Panel.Margin = New-Thickness 10 14 10 14

    $Head = New-Object System.Windows.Controls.DockPanel
    $Head.Margin = New-Thickness 8 0 8 2
    $HeadTitle = New-Text -Text 'Due' -Size 16 -Fg 'Text' -Weight 'SemiBold'
    $Head.Children.Add($HeadTitle) | Out-Null
    $SoonCount = @($DueGroups.overdue).Count + @($DueGroups.today).Count + @($DueGroups.tomorrow).Count + @($DueGroups.week).Count
    $HeadNote = New-Text -Text $(if ($SoonCount) { 'next 7 days: ' + $SoonCount } else { '' }) -Size 12.5 -Fg 'TextFaint'
    $HeadNote.Margin = New-Thickness 10 3 0 0
    $Head.Children.Add($HeadNote) | Out-Null
    $Panel.Children.Add($Head) | Out-Null

    $Labels = [ordered]@{
        overdue  = @('Overdue', 'Danger')
        today    = @(('Today ' + $Dot + ' ' + $Today.ToString('ddd, MMM d', $Invariant)), 'Warn')
        tomorrow = @(('Tomorrow ' + $Dot + ' ' + $Today.AddDays(1).ToString('ddd, MMM d', $Invariant)), 'Warn')
        week     = @('This week', 'Text')
    }
    foreach ($Group in $Labels.Keys) {
        $Items = @($DueGroups[$Group])
        if (-not $Items.Count) { continue }
        $Panel.Children.Add((New-RailHeader $Labels[$Group][0] $Labels[$Group][1] ([string]$Items.Count))) | Out-Null
        foreach ($Item in $Items) { $Panel.Children.Add((New-DueRow $Item $Group)) | Out-Null }
    }
    if (-not $SoonCount) {
        $Clear = New-Object System.Windows.Controls.StackPanel
        $Clear.Orientation = 'Horizontal'
        $Clear.Margin = New-Thickness 8 12 8 4
        $ClearGlyph = New-Glyph 0xE73E 14 'Good'
        $ClearGlyph.Margin = New-Thickness 0 1 8 0
        $Clear.Children.Add($ClearGlyph) | Out-Null
        $Clear.Children.Add((New-Text -Text 'Nothing due in the next 7 days' -Size 13.5 -Fg 'TextMuted')) | Out-Null
        $Panel.Children.Add($Clear) | Out-Null
    }
    $Later = @($DueGroups.later)
    if ($Later.Count) {
        $Panel.Children.Add((New-RailHeader 'Later' 'TextMuted' ([string]$Later.Count))) | Out-Null
        $Shown = [Math]::Min(3, $Later.Count)
        for ($i = 0; $i -lt $Shown; $i++) { $Panel.Children.Add((New-DueRow $Later[$i] 'later')) | Out-Null }
        if ($Later.Count -gt $Shown) {
            $Rest = @()
            for ($i = $Shown; $i -lt $Later.Count; $i++) { $Rest += (New-DueRow $Later[$i] 'later') }
            New-ToggleSection $Panel ('Show ' + ($Later.Count - $Shown) + ' more') 'Show fewer' $Rest 'w:later'
        }
    }
    $Missed = @($DueGroups.missed)
    if ($Missed.Count) {
        $Rows = @((New-RailHeader 'Missed' 'TextMuted' ([string]$Missed.Count) 6))
        foreach ($Item in $Missed) { $Rows += (New-DueRow $Item 'missed') }
        $MissedText = (Get-Plural $Missed.Count 'missed deadline' 'missed deadlines') + ' (over a week ago)'
        $Spacer = New-Object System.Windows.Controls.Border
        $Spacer.Height = 8
        $Panel.Children.Add($Spacer) | Out-Null
        New-ToggleSection $Panel $MissedText 'Hide missed deadlines' $Rows 'w:missed'
    }
    $Resolved = @($DueGroups.resolved)
    if ($Resolved.Count) {
        $Rows = @((New-RailHeader 'Resolved' 'TextMuted' ([string]$Resolved.Count) 6))
        foreach ($Item in $Resolved) { $Rows += (New-DueRow $Item (Get-DueGroup $Item) $true) }
        $Spacer = New-Object System.Windows.Controls.Border
        $Spacer.Height = 8
        $Panel.Children.Add($Spacer) | Out-Null
        New-ToggleSection $Panel ("$($Resolved.Count) resolved") 'Hide resolved' $Rows 'w:resolved'
    }

    foreach ($Note in $RailNotes) {
        $NoteHead = New-Object System.Windows.Controls.StackPanel
        $NoteHead.Orientation = 'Horizontal'
        $NoteHead.Margin = New-Thickness 8 18 8 4
        $NoteGlyph = New-Glyph $Note.Glyph 12.5 $Note.Fg
        $NoteGlyph.Margin = New-Thickness 0 1 7 0
        $NoteHead.Children.Add($NoteGlyph) | Out-Null
        $NoteHead.Children.Add((New-Text -Text $Note.Label -Size 12.5 -Fg 'TextMuted' -Weight 'SemiBold')) | Out-Null
        $Panel.Children.Add($NoteHead) | Out-Null
        foreach ($Text in $Note.Items) {
            $Line = New-Text -Text ($Bullet + '  ' + $Text) -Size 13 -Fg 'TextMuted' -Wrap
            $Line.Margin = New-Thickness 10 2 8 2
            $Panel.Children.Add($Line) | Out-Null
        }
    }
    Add-FilesGroup $Panel 'w:files'
    if ($script:Cards.Count -eq 0 -and $BriefAnnouncementItems.Count) {
        $Panel.Children.Add((New-RailHeader 'New announcements (from the brief)' 'TextMuted' '' 18)) | Out-Null
        foreach ($Text in $BriefAnnouncementItems) {
            $Line = New-Text -Text ($Bullet + '  ' + $Text) -Size 13 -Fg 'TextMuted' -Wrap -MaxLines 3
            $Line.Margin = New-Thickness 10 2 8 2
            $Panel.Children.Add($Line) | Out-Null
        }
    }
    return $Panel
}

function New-CompactDueRow($Item, [string]$Group, [bool]$IsResolved = $false) {
    $TimeFg = switch ($Group) { 'overdue' { 'Danger' } 'today' { 'Warn' } 'tomorrow' { 'Warn' } 'week' { 'Text' } default { 'TextMuted' } }
    $Time = $Item.Date.ToString('HH:mm', $Invariant)
    $Label = switch ($Group) {
        'overdue' { 'Overdue' }
        'today' { if ($Item.HasTime) { "Today $Time" } else { 'Today' } }
        'tomorrow' { if ($Item.HasTime) { "Tomorrow $Time" } else { 'Tomorrow' } }
        'week' { if ($Item.HasTime) { $Item.Date.ToString('ddd', $Invariant) + " $Time" } else { $Item.Date.ToString('ddd', $Invariant) } }
        default { $Item.Date.ToString('MMM d', $Invariant) }
    }
    $Grid = New-Object System.Windows.Controls.Grid
    $Col0 = New-Object System.Windows.Controls.ColumnDefinition
    $Col0.Width = [System.Windows.GridLength]::new(112)
    $Col1 = New-Object System.Windows.Controls.ColumnDefinition
    $Col1.Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
    $Grid.ColumnDefinitions.Add($Col0)
    $Grid.ColumnDefinitions.Add($Col1)
    $LabelText = New-Text -Text $Label -Size 12.5 -Fg $TimeFg -Weight 'SemiBold'
    $Grid.Children.Add($LabelText) | Out-Null
    $Line = New-Object System.Windows.Controls.DockPanel
    [System.Windows.Controls.Grid]::SetColumn($Line, 1)
    $Action = New-ResolveAction $Item $IsResolved
    [System.Windows.Controls.DockPanel]::SetDock($Action, [System.Windows.Controls.Dock]::Right)
    $Action.Margin = New-Thickness 6 (-4) 0 (-4)
    $Line.Children.Add($Action) | Out-Null
    $CourseKey = Get-CourseKey $Item.Course
    $Line.Children.Add((New-Dot $CourseKey 7)) | Out-Null
    if ($Item.Source -eq 'announcement') {
        $TagGlyph = New-Glyph 0xE789 11.5 'Accent'
        $TagGlyph.Margin = New-Thickness 0 1 6 0
        $Line.Children.Add($TagGlyph) | Out-Null
    }
    $Line.Children.Add((New-Text -Text $Item.Title -Size 13 -Fg 'Text')) | Out-Null
    $Grid.Children.Add($Line) | Out-Null
    if ($IsResolved) {
        $LabelText.Opacity = 0.6
        foreach ($Child in $Line.Children) { if (-not [object]::ReferenceEquals($Child, $Action)) { $Child.Opacity = 0.6 } }
    }

    $When = (Format-ShortDate $Item.Date)
    if ($Item.HasTime) { $When += ' ' + $Time }
    $Tip = "$($Item.Title)`n$(Get-CourseDisplayName $Item.Course)  $Dot  due $When"
    if ($Item.Status) { $Tip += "  $Dot  $($Item.Status)" }
    $Name = "$($Item.Title.Replace($WordJoiner, '')), $(Get-CourseDisplayName $Item.Course), due $When"
    if ($IsResolved) { $Name += ', resolved' }
    if ($Item.Source -eq 'announcement') {
        $Row = New-Object System.Windows.Controls.Button
        $Row.Style = $App.Resources['RowButton']
        $Row.Padding = New-Thickness 8 5 8 6
        $Row.Content = $Grid
        $Row.Tag = $Item.Card
        $Row.ToolTip = $Tip + "`nFrom an announcement $Dash click to open it"
        $Row.Add_Click({
                param($RowSender, $RowArgs)
                try { Select-Card $RowSender.Tag -Open } catch { }
            })
        [System.Windows.Automation.AutomationProperties]::SetName($Row, "$Name, from an announcement. Open the announcement.")
    }
    else {
        $Row = New-Object System.Windows.Controls.Border
        $Row.Padding = New-Thickness 8 5 8 6
        $Row.Child = $Grid
        $Row.ToolTip = $Tip
    }
    $Wrapper = New-DueRowWrapper $Row $Item $Action $IsResolved ($Item.Source -ne 'announcement') $script:DueRowsCompact
    [System.Windows.Automation.AutomationProperties]::SetHelpText($Wrapper, $(if ($IsResolved) { 'Press R to move it back to the Due list.' } else { 'Press R to mark it as resolved.' }))
    if ($Item.Source -ne 'announcement') { [System.Windows.Automation.AutomationProperties]::SetName($Wrapper, $Name) }
    return $Wrapper
}

function Build-DueCompact {
    $script:DueRowsCompact.Clear()
    $Panel = New-Object System.Windows.Controls.StackPanel
    $Panel.Margin = New-Thickness 10 12 10 10
    $Head = New-Object System.Windows.Controls.StackPanel
    $Head.Orientation = 'Horizontal'
    $Head.Margin = New-Thickness 8 0 8 4
    $Head.Children.Add((New-Text -Text 'Due' -Size 15 -Fg 'Text' -Weight 'SemiBold')) | Out-Null
    $SoonCount = @($DueGroups.overdue).Count + @($DueGroups.today).Count + @($DueGroups.tomorrow).Count + @($DueGroups.week).Count
    if ($SoonCount) {
        $Note = New-Text -Text ('next 7 days: ' + $SoonCount) -Size 12.5 -Fg 'TextFaint'
        $Note.Margin = New-Thickness 10 2 0 0
        $Head.Children.Add($Note) | Out-Null
    }
    $Panel.Children.Add($Head) | Out-Null
    foreach ($Group in 'overdue', 'today', 'tomorrow', 'week') {
        foreach ($Item in @($DueGroups[$Group])) { $Panel.Children.Add((New-CompactDueRow $Item $Group)) | Out-Null }
    }
    if (-not $SoonCount) {
        $Clear = New-Object System.Windows.Controls.StackPanel
        $Clear.Orientation = 'Horizontal'
        $Clear.Margin = New-Thickness 8 4 8 4
        $ClearGlyph = New-Glyph 0xE73E 13 'Good'
        $ClearGlyph.Margin = New-Thickness 0 1 8 0
        $Clear.Children.Add($ClearGlyph) | Out-Null
        $Clear.Children.Add((New-Text -Text 'Nothing due in the next 7 days' -Size 13 -Fg 'TextMuted')) | Out-Null
        $Panel.Children.Add($Clear) | Out-Null
    }
    $Later = @($DueGroups.later)
    if ($Later.Count) {
        $Rows = @()
        foreach ($Item in $Later) { $Rows += (New-CompactDueRow $Item 'later') }
        $Next = $Later[0]
        New-ToggleSection $Panel ((Get-Plural $Later.Count 'later deadline' 'later deadlines') + ' (next: ' + $Next.Date.ToString('MMM d', $Invariant) + ')') 'Hide later deadlines' $Rows 'c:later'
    }
    $Missed = @($DueGroups.missed)
    if ($Missed.Count) {
        $Rows = @((New-RailHeader 'Missed' 'TextMuted' ([string]$Missed.Count) 6))
        foreach ($Item in $Missed) { $Rows += (New-CompactDueRow $Item 'missed') }
        New-ToggleSection $Panel ((Get-Plural $Missed.Count 'missed deadline' 'missed deadlines') + ' (over a week ago)') 'Hide missed deadlines' $Rows 'c:missed'
    }
    $Resolved = @($DueGroups.resolved)
    if ($Resolved.Count) {
        $Rows = @((New-RailHeader 'Resolved' 'TextMuted' ([string]$Resolved.Count) 6))
        foreach ($Item in $Resolved) { $Rows += (New-CompactDueRow $Item (Get-DueGroup $Item) $true) }
        New-ToggleSection $Panel ("$($Resolved.Count) resolved") 'Hide resolved' $Rows 'c:resolved'
    }
    if ($RailNotes.Count) {
        $Rows = @()
        foreach ($Note in $RailNotes) {
            $Rows += (New-RailHeader $Note.Label 'TextMuted' '' 8)
            foreach ($Text in $Note.Items) {
                $Line = New-Text -Text ($Bullet + '  ' + $Text) -Size 13 -Fg 'TextMuted' -Wrap
                $Line.Margin = New-Thickness 10 2 8 2
                $Rows += $Line
            }
        }
        $NoteCount = 0
        foreach ($Note in $RailNotes) { $NoteCount += $Note.Items.Count }
        New-ToggleSection $Panel ("More from the brief ($NoteCount)") 'Hide' $Rows 'c:notes'
    }
    if ($BriefFiles.Count -or $BriefFileNotes.Count) {
        $FilesHost = New-Object System.Windows.Controls.StackPanel
        Add-FilesGroup $FilesHost 'c:files-more' 6
        $FilesRows = @($FilesHost.Children | ForEach-Object { $_ })
        $FilesHost.Children.Clear()
        $FilesLabel = if ($BriefFiles.Count) { Get-Plural $BriefFiles.Count 'new file' 'new files' } else { 'New files' }
        New-ToggleSection $Panel $FilesLabel 'Hide new files' $FilesRows 'c:files'
    }
    return $Panel
}

$script:DuePanel = Build-DuePanel
$script:DueCompact = Build-DueCompact
$DueWrapper = New-Object System.Windows.Controls.Border
$DueWrapper.Child = $script:DueCompact
$DueWrapper.BorderThickness = New-Thickness 0 0 0 1
$DueWrapper.SetResourceReference([System.Windows.Controls.Border]::BorderBrushProperty, 'Border')
[System.Windows.Automation.AutomationProperties]::SetName($DueWrapper, 'Due')

# ---------------------------------------------------------------------------
# Status line and banner
# ---------------------------------------------------------------------------
$TodayText.Text = (Get-Date).ToString('dddd, MMMM d', $Invariant)

function Add-SummarySegment([string]$Text, [string]$Fg, [switch]$Bold) {
    if ($SummaryText.Inlines.Count -gt 0) {
        $SummaryText.Inlines.Add((New-Run -Text "   $Dot   " -Fg 'TextFaint'))
    }
    $SummaryText.Inlines.Add((New-Run -Text $Text -Fg $Fg -Bold:$Bold))
}

# Counts come from the open groups, so resolved items never show up here.
function Update-SummaryLine {
    $SummaryText.Inlines.Clear()
    $OverdueCount = @($script:DueGroups.overdue).Count
    $TodayCount = @($script:DueGroups.today).Count
    $TomorrowCount = @($script:DueGroups.tomorrow).Count
    $WeekCount = @($script:DueGroups.week).Count
    if ($OverdueCount) { Add-SummarySegment "$OverdueCount overdue" 'Danger' -Bold }
    if ($TodayCount) { Add-SummarySegment "$TodayCount due today" 'Warn' -Bold }
    if ($TomorrowCount) { Add-SummarySegment "$TomorrowCount due tomorrow" 'Warn' -Bold }
    if ($WeekCount) { Add-SummarySegment "$WeekCount more this week" 'Text' -Bold }
    if (-not ($OverdueCount + $TodayCount + $TomorrowCount + $WeekCount)) { Add-SummarySegment 'Nothing due in the next 7 days' 'TextMuted' }
    if ($script:NewCount) { Add-SummarySegment (Get-Plural $script:NewCount 'new announcement' 'new announcements') 'Accent' -Bold }
    elseif ($script:Cards.Count) { Add-SummarySegment 'No new announcements' 'TextMuted' }
}
Update-SummaryLine

# Rebuilds both Due panels (wide rail and compact) and the status line from the current resolved set.
function Update-DueView {
    Update-DueGroups
    $Offset = 0
    try { $Offset = $RailScroll.VerticalOffset } catch { }
    $script:DuePanel = Build-DuePanel
    $script:DueCompact = Build-DueCompact
    $DueWrapper.Child = $script:DueCompact
    if ($script:Mode -eq 'wide') {
        $RailHost.Content = $script:DuePanel
        $script:RailRestoreOffset = $Offset
        $null = $RailScroll.Dispatcher.BeginInvoke([System.Windows.Threading.DispatcherPriority]::Loaded, [Action] {
                try { Stop-SmoothScroll $RailScroll; $RailScroll.ScrollToVerticalOffset($script:RailRestoreOffset) } catch { }
            })
    }
    Update-SummaryLine
}

function Switch-DueResolved($Item) {
    if (-not $Item -or -not $Item.Id) { return }
    $Sink = if ($script:Mode -eq 'wide') { $script:DueRowsWide } else { $script:DueRowsCompact }
    $Visible = @($Sink | Where-Object { $_.IsVisible })
    $Ids = @($Visible | ForEach-Object { $_.Tag.Id })
    $Index = [Array]::IndexOf($Ids, $Item.Id)
    $FocusId = ''
    if ($Index -ge 0 -and $Visible[$Index].IsKeyboardFocusWithin) {
        if ($Index + 1 -lt $Ids.Count) { $FocusId = $Ids[$Index + 1] }
        elseif ($Index -gt 0) { $FocusId = $Ids[$Index - 1] }
    }
    $Resolving = -not $script:ResolvedIds.ContainsKey($Item.Id)
    if ($Resolving) { $script:ResolvedIds[$Item.Id] = $Item.Date.ToString('o', $Invariant) }
    else { $script:ResolvedIds.Remove($Item.Id) }
    $script:ResolveActions[$Item.Id] = @{ resolved = $Resolving; at = (Get-Date); due = $Item.Date.ToString('o', $Invariant) }
    Save-ViewerState
    Update-DueView
    if ($FocusId) {
        $script:PendingFocusId = $FocusId
        $null = $Window.Dispatcher.BeginInvoke([System.Windows.Threading.DispatcherPriority]::Loaded, [Action] {
                try {
                    $List = if ($script:Mode -eq 'wide') { $script:DueRowsWide } else { $script:DueRowsCompact }
                    $Target = @($List | Where-Object { $_.Tag.Id -eq $script:PendingFocusId -and $_.IsVisible }) | Select-Object -First 1
                    if ($Target) { $null = $Target.Tag.Target.Focus() }
                }
                catch { }
            })
    }
    Show-Transient $(if ($Resolving) { 'Marked as resolved' } else { 'Moved back to Due' })
}

# Short-lived message in the "Updated" slot (shares the copy-confirmation timer).
function Show-Transient([string]$Text) {
    try {
        if (-not $script:CopyTimer.IsEnabled) { $script:CopiedRestore = $UpdatedText.Text }
        $UpdatedText.Text = $Text
        $script:CopyTimer.Stop()
        $script:CopyTimer.Start()
    }
    catch { }
}

$BannerLines = New-Object System.Collections.Generic.List[string]
$HealthTip = New-Object System.Collections.Generic.List[string]
if ($Generated) {
    $GeneratedLocal = $Generated.LocalDateTime
    $Age = (Get-Date) - $GeneratedLocal
    $UpdatedText.Text = 'Updated ' + $GeneratedLocal.ToString('HH:mm', $Invariant) + "  $Dot  " + (Format-Age $Age)
    if ($Age.TotalDays -ge 1) { $UpdatedText.Text = 'Updated ' + (Format-ShortDate $GeneratedLocal) }
    $HealthTip.Add('Brief generated ' + $GeneratedLocal.ToString('dddd, MMMM d, HH:mm', $Invariant))
    if ($Age.TotalHours -gt 26) {
        $AgeDays = [int][Math]::Floor($Age.TotalDays)
        $AgeWords = if ($AgeDays -ge 2) { "$AgeDays days" } elseif ($AgeDays -eq 1) { '1 day' } else { "$([int][Math]::Floor($Age.TotalHours)) hours" }
        $BannerLines.Add("This brief is $AgeWords old (last updated $(Format-ShortDate $GeneratedLocal) at $($GeneratedLocal.ToString('HH:mm', $Invariant))). The monitor may not have run since then, so deadlines and announcements could be out of date.")
    }
}
elseif ($HasBrief) {
    $UpdatedText.Text = 'Brief date unknown'
}
else {
    $UpdatedText.Text = 'No daily brief yet'
    $BannerLines.Add('No daily brief was found, so LearnUs assignment deadlines are missing. Only dates mentioned in announcements are listed under Due.')
}
if (-not $HealthOk) {
    $Detail = if ($CoursesCheckedText) { " ($CoursesCheckedText courses checked)" } else { '' }
    $BannerLines.Add("The last scan didn't check every course$Detail. Some deadlines or announcements may be missing.")
}
foreach ($Pair in $HealthPairs) { $HealthTip.Add("$($Pair.Key): $($Pair.Value)") }
foreach ($Note in $HealthNotes) { $HealthTip.Add($Note) }
if ($HasBrief) { $HealthTip.Add($BriefPath) }
if ($HealthTip.Count) { $UpdatedText.ToolTip = ($HealthTip -join "`n") }
if ($BannerLines.Count) {
    $BannerText.Text = ($BannerLines -join "`n")
    $Banner.Visibility = 'Visible'
}

# ---------------------------------------------------------------------------
# Course filter chips and search
# ---------------------------------------------------------------------------
$script:CourseFilter = ''
$script:SearchQuery = ''

$script:CourseOptions = @(
    $script:Cards | Group-Object -Property { $_.Model.CourseFull } | Sort-Object -Property @{ Expression = 'Count'; Descending = $true }, Name | ForEach-Object {
        $First = $_.Group[0]
        [PSCustomObject]@{ Course = $First.Model.CourseFull; Short = $First.CourseShort; Key = $First.CourseKey; Count = $_.Count }
    }
)
$CourseMenu = New-Object System.Windows.Controls.ContextMenu

function Set-CourseFilter([string]$Course) {
    $script:CourseFilter = $Course
    $Option = $script:CourseOptions | Where-Object { $_.Course -eq $Course } | Select-Object -First 1
    if ($Option) {
        $FilterLabel.Text = $Option.Short
        $FilterDot.SetResourceReference([System.Windows.Shapes.Shape]::FillProperty, $Option.Key)
        $FilterDot.Visibility = 'Visible'
        $FilterButton.ToolTip = "Showing $($Option.Course) only"
    }
    else {
        $FilterLabel.Text = 'All courses'
        $FilterDot.Visibility = 'Collapsed'
        $FilterButton.ToolTip = 'Show one course only'
    }
    [System.Windows.Automation.AutomationProperties]::SetName($FilterButton, "Course filter: $($FilterLabel.Text)")
}

function New-CourseMenuItem([string]$Label, [string]$Course, [string]$DotKey, [int]$Count) {
    $Entry = New-Object System.Windows.Controls.MenuItem
    $Header = New-Object System.Windows.Controls.StackPanel
    $Header.Orientation = 'Horizontal'
    $Check = New-Glyph 0xE73E 12 'Accent'
    $Check.Width = 20
    $Check.Visibility = if ($script:CourseFilter -eq $Course) { 'Visible' } else { 'Hidden' }
    $Header.Children.Add($Check) | Out-Null
    if ($DotKey) { $Header.Children.Add((New-Dot $DotKey 8)) | Out-Null }
    else {
        $Spacer = New-Object System.Windows.Controls.Border
        $Spacer.Width = 14
        $Header.Children.Add($Spacer) | Out-Null
    }
    $Header.Children.Add((New-Text -Text (Get-CourseDisplayName $Label) -Size 13 -Fg 'Text')) | Out-Null
    $CountText = New-Text -Text ([string]$Count) -Size 12.5 -Fg 'TextFaint'
    $CountText.Margin = New-Thickness 10 0 0 0
    $Header.Children.Add($CountText) | Out-Null
    $Entry.Header = $Header
    $Entry.Tag = $Course
    [System.Windows.Automation.AutomationProperties]::SetName($Entry, "$(Get-CourseDisplayName $Label), $Count announcements")
    $Entry.Add_Click({
            param($EntrySender, $EntryArgs)
            try {
                Set-CourseFilter ([string]$EntrySender.Tag)
                Update-Feed
            }
            catch { }
        })
    return $Entry
}

function Build-CourseMenu {
    $CourseMenu.Items.Clear()
    $CourseMenu.Items.Add((New-CourseMenuItem 'All courses' '' '' $script:Cards.Count)) | Out-Null
    foreach ($Option in $script:CourseOptions) {
        $CourseMenu.Items.Add((New-CourseMenuItem $Option.Course $Option.Course $Option.Key $Option.Count)) | Out-Null
    }
}

function New-FeedHeaderItem([string]$Text, [int]$Count, [string]$Fg) {
    return [PSCustomObject]@{
        Kind             = 'header'
        HeaderVisibility = 'Visible'
        CardVisibility   = 'Collapsed'
        HeaderText       = $Text
        HeaderCount      = [string]$Count
        HeaderBrush      = (Get-Brush $Fg)
        A11yName         = "$Text, $Count"
    }
}

$script:FeedCardsInView = @()
$script:CurrentCard = $null
$script:SuppressSelection = $false

function Update-Feed([switch]$KeepScroll) {
    $Query = $script:SearchQuery
    $Filter = $script:CourseFilter
    $Visible = @($script:Cards | Where-Object {
            (-not $Filter -or $_.Model.CourseFull -eq $Filter) -and (-not $Query -or $_.Model.Haystack.Contains($Query))
        })
    $List = New-Object System.Collections.ArrayList
    $InView = New-Object System.Collections.Generic.List[object]
    $Fresh = @($Visible | Where-Object { $_.InNewGroup })
    if ($Fresh.Count) {
        [void]$List.Add((New-FeedHeaderItem 'NEW & UPDATED' $Fresh.Count 'Accent'))
        foreach ($Card in $Fresh) { [void]$List.Add($Card); $InView.Add($Card) }
    }
    $Rest = @($Visible | Where-Object { -not $_.InNewGroup })
    $CurrentLabel = $null
    $Pending = New-Object System.Collections.Generic.List[object]
    foreach ($Card in $Rest) {
        if ($Card.WeekLabel -ne $CurrentLabel) {
            if ($Pending.Count) {
                [void]$List.Add((New-FeedHeaderItem $CurrentLabel $Pending.Count 'TextFaint'))
                foreach ($PendingCard in $Pending) { [void]$List.Add($PendingCard); $InView.Add($PendingCard) }
                $Pending.Clear()
            }
            $CurrentLabel = $Card.WeekLabel
        }
        $Pending.Add($Card)
    }
    if ($Pending.Count) {
        [void]$List.Add((New-FeedHeaderItem $CurrentLabel $Pending.Count 'TextFaint'))
        foreach ($PendingCard in $Pending) { [void]$List.Add($PendingCard); $InView.Add($PendingCard) }
    }
    $script:FeedCardsInView = $InView.ToArray()

    $script:SuppressSelection = $true
    try {
        $FeedList.ItemsSource = $List
        if ($script:CurrentCard -and ($script:FeedCardsInView -contains $script:CurrentCard)) {
            $FeedList.SelectedItem = $script:CurrentCard
        }
    }
    finally { $script:SuppressSelection = $false }

    $Total = $script:Cards.Count
    $FeedCount.Text = if ($Filter -or $Query) { "$($Visible.Count) of $Total" } else { [string]$Total }
    if ($Total -eq 0) {
        $FeedEmptyText.Text = "No announcements saved yet.`nThey'll appear here after the monitor's next scan."
        $ClearFiltersButton.Visibility = 'Collapsed'
        $FeedEmpty.Visibility = 'Visible'
    }
    elseif ($Visible.Count -eq 0) {
        $FeedEmptyText.Text = if ($Query) { "No announcements match `"$($SearchBox.Text.Trim())`"." } else { 'No announcements for this course.' }
        $ClearFiltersButton.Visibility = 'Visible'
        $FeedEmpty.Visibility = 'Visible'
    }
    else {
        $FeedEmpty.Visibility = 'Collapsed'
    }
    $MarkReadButton.Visibility = if (@($script:Cards | Where-Object { $_.State.IsUnread }).Count) { 'Visible' } else { 'Collapsed' }
    if (-not $KeepScroll) {
        Stop-SmoothScroll $FeedScroll
        if ($script:Mode -eq 'wide') { $FeedScroll.ScrollToVerticalOffset(0) }
    }
    Update-ReaderNav
}

# ---------------------------------------------------------------------------
# Reader
# ---------------------------------------------------------------------------
function Get-ReaderScroll {
    try {
        $ReaderViewer.ApplyTemplate() | Out-Null
        return $ReaderViewer.Template.FindName('PART_ContentHost', $ReaderViewer)
    }
    catch { return $null }
}

function Reset-ReaderScroll {
    $Scroll = Get-ReaderScroll
    if ($Scroll) {
        Stop-SmoothScroll $Scroll
        $Scroll.ScrollToHome()
    }
    $null = $ReaderViewer.Dispatcher.BeginInvoke([System.Windows.Threading.DispatcherPriority]::Loaded, [Action] {
            try {
                $Later = Get-ReaderScroll
                if ($Later) { $Later.ScrollToHome() }
            }
            catch { }
        })
}

function Update-ReaderNav {
    $Index = -1
    if ($script:CurrentCard) { $Index = [Array]::IndexOf($script:FeedCardsInView, $script:CurrentCard) }
    $Count = $script:FeedCardsInView.Count
    $NewerButton.IsEnabled = ($Index -gt 0)
    $OlderButton.IsEnabled = ($Index -ge 0 -and $Index -lt $Count - 1)
    $ReaderPosition.Text = if ($Index -ge 0) { "$($Index + 1) of $Count" } else { '' }
}

function Add-SectionLabel($Blocks, [string]$Text, [double]$Top = 22) {
    $Paragraph = New-Paragraph -Size 11.5 -Top $Top -Bottom 8
    $Paragraph.Inlines.Add((New-Run -Text $Text -Fg 'TextFaint' -Bold))
    $Blocks.Add($Paragraph)
}

function Add-BodyParagraphs($Blocks, [string]$Text) {
    foreach ($Chunk in ($Text -split "\n\s*\n")) {
        $Trimmed = $Chunk.Trim()
        if (-not $Trimmed) { continue }
        $Paragraph = New-Paragraph -Bottom 14
        $Lines = $Trimmed -split "\n"
        for ($i = 0; $i -lt $Lines.Count; $i++) {
            if ($i -gt 0) { $Paragraph.Inlines.Add((New-Object System.Windows.Documents.LineBreak)) }
            Add-LinkifiedText -Inlines $Paragraph.Inlines -Text $Lines[$i].TrimEnd() -Fg 'Text'
        }
        $Blocks.Add($Paragraph)
    }
}

function Show-ReaderMessage([string]$Heading, [string]$Message) {
    $Document = New-DocumentBase 15 '32,40,32,32'
    $Title = New-Paragraph -Size 18 -Bottom 8
    $Title.Inlines.Add((New-Run -Text $Heading -Fg 'Text' -Bold))
    $Document.Blocks.Add($Title)
    if ($Message) {
        $Body = New-Paragraph -Size 14
        $Body.Inlines.Add((New-Run -Text $Message -Fg 'TextMuted'))
        $Document.Blocks.Add($Body)
    }
    $ReaderViewer.Document = $Document
    $OpenLearnUsButton.IsEnabled = $false
    $OpenLearnUsButton.Visibility = 'Collapsed'
    $OpenLearnUsButton.Tag = $null
    $script:CurrentCard = $null
    Update-ReaderNav
}

function Show-Reader($Card) {
    $script:CurrentCard = $Card
    $Model = $Card.Model
    $Document = New-DocumentBase 15 '32,22,32,40'
    $Document.MaxPageWidth = 860

    $CourseLine = New-Paragraph -Size 12.5 -Bottom 6
    $CourseLine.Inlines.Add((New-Run -Text ($Circle + '  ') -Fg $Card.CourseKey -Size 10))
    $CourseLine.Inlines.Add((New-Run -Text $Model.CourseFull -Fg $Card.CourseKey -Bold))
    $Document.Blocks.Add($CourseLine)

    $TitleLine = New-Paragraph -Size 22 -Bottom 8 -LineHeight 30
    $TitleLine.Inlines.Add((New-Run -Text $Model.Title -Fg 'Text' -Bold))
    $Document.Blocks.Add($TitleLine)

    $Meta = New-Paragraph -Size 13 -Bottom 2 -LineHeight 20
    if ($Card.BadgeText) {
        $Badge = New-Run -Text (' ' + $Card.BadgeText + ' ') -Fg 'AccentText' -Bold -Size 11
        $Badge.SetResourceReference($BgProp, 'Accent')
        $Meta.Inlines.Add($Badge)
        $Meta.Inlines.Add((New-Run -Text '   '))
    }
    if ($Model.Posted) {
        $Meta.Inlines.Add((New-Run -Text ('Posted ' + (Format-ShortDate $Model.Posted) + ' (' + (Get-RelativeDayText $Model.Posted) + ')') -Fg 'TextMuted'))
    }
    else {
        $Meta.Inlines.Add((New-Run -Text 'Posting date unknown' -Fg 'TextMuted'))
    }
    if ($Model.Author) { $Meta.Inlines.Add((New-Run -Text ("   $Dot   " + $Model.Author) -Fg 'TextMuted')) }
    if ($Card.BadgeText -eq 'UPDATED' -and $Model.BodyUpdated) { $Meta.Inlines.Add((New-Run -Text ("   $Dot   Text changed " + (Format-ShortDate $Model.BodyUpdated)) -Fg 'TextMuted')) }
    if ($Model.Archived) { $Meta.Inlines.Add((New-Run -Text ("   $Dot   No longer listed on LearnUs") -Fg 'TextMuted')) }
    $Document.Blocks.Add($Meta)
    if ($Model.OriginalTitle -and $Model.OriginalTitle -ne $Model.Title) {
        $Original = New-Paragraph -Size 12.5 -Top 4
        $Original.Inlines.Add((New-Run -Text 'Original title: ' -Fg 'TextFaint'))
        $Original.Inlines.Add((New-Run -Text $Model.OriginalTitle -Fg 'TextMuted'))
        $Document.Blocks.Add($Original)
    }

    if ($Model.NotExtracted) {
        $Box = New-Object System.Windows.Documents.Section
        $Box.Margin = New-Thickness 0 18 0 4
        $Box.Padding = New-Thickness 16 12 16 4
        $Box.BorderThickness = New-Thickness 3 0 0 0
        $Box.SetResourceReference($BgProp, 'WarnSoft')
        $Box.SetResourceReference([System.Windows.Documents.Block]::BorderBrushProperty, 'Warn')
        $Line = New-Paragraph -Size 14 -Bottom 8
        $Line.Inlines.Add((New-Run -Text "Couldn't extract the text of this announcement." -Fg 'Text' -Bold))
        $Line.Inlines.Add((New-Object System.Windows.Documents.LineBreak))
        $Line.Inlines.Add((New-Run -Text 'Use Open in LearnUs (top right) to read the original.' -Fg 'TextMuted'))
        $Box.Blocks.Add($Line)
        $Document.Blocks.Add($Box)
    }

    if ($Model.Mentions.Count) {
        $Soon = $false
        foreach ($Mention in $Model.Mentions) {
            $Days = ($Mention.Date.Date - $Today).Days
            if ($Mention.IsDeadline -and $Days -ge 0 -and $Days -le 3) { $Soon = $true }
        }
        $Box = New-Object System.Windows.Documents.Section
        $Box.Margin = New-Thickness 0 18 0 4
        $Box.Padding = New-Thickness 16 12 16 2
        $Box.BorderThickness = New-Thickness 3 0 0 0
        $Box.SetResourceReference($BgProp, $(if ($Soon) { 'WarnSoft' } else { 'AccentSoft' }))
        $Box.SetResourceReference([System.Windows.Documents.Block]::BorderBrushProperty, $(if ($Soon) { 'Warn' } else { 'Accent' }))
        $Label = New-Paragraph -Size 11.5 -Bottom 8
        $LabelText = if ($Model.ExplicitDates) { 'DEADLINES' } else { 'DATES MENTIONED' }
        $Label.Inlines.Add((New-Run -Text $LabelText -Fg 'TextFaint' -Bold))
        $Box.Blocks.Add($Label)
        $Shown = 0
        foreach ($Mention in $Model.Mentions) {
            if ($Shown -ge 8) { break }
            $Shown++
            $Past = $Mention.Date.Date -lt $Today
            $Row = New-Paragraph -Size 14 -Bottom 10 -LineHeight 21
            $DateText = Format-ShortDate $Mention.Date
            if ($Mention.HasTime) { $DateText += "  $Dot  " + $Mention.Date.ToString('HH:mm', $Invariant) }
            $Row.Inlines.Add((New-Run -Text $DateText -Fg $(if ($Past) { 'TextFaint' } else { 'Text' }) -Bold))
            $Row.Inlines.Add((New-Run -Text ('   ' + (Get-RelativeDayText $Mention.Date)) -Fg $(if ($Past) { 'TextFaint' } else { 'TextMuted' })))
            if ($Mention.IsDeadline -and -not $Past) {
                $Row.Inlines.Add((New-Run -Text '   deadline' -Fg $(if ($Soon) { 'Warn' } else { 'Accent' }) -Bold -Size 12.5))
            }
            if ($Mention.Context) {
                $Row.Inlines.Add((New-Object System.Windows.Documents.LineBreak))
                $Row.Inlines.Add((New-Run -Text $Mention.Context -Fg $(if ($Past) { 'TextFaint' } else { 'TextMuted' }) -Size 13))
            }
            $Box.Blocks.Add($Row)
        }
        $Document.Blocks.Add($Box)
    }

    if ($Model.Attachments.Count) {
        Add-SectionLabel $Document.Blocks ("ATTACHMENTS ($($Model.Attachments.Count))") 20
        foreach ($Attachment in $Model.Attachments) {
            $File = New-Paragraph -Size 14 -Bottom 6 -Left 26 -LineHeight 22
            $File.TextIndent = -26
            $Clip = New-Run -Text ([string][char]0xE723 + '    ') -Fg 'Accent' -Size 13
            $Clip.FontFamily = $IconFont
            $File.Inlines.Add($Clip)
            $File.Inlines.Add((New-Link $Attachment.Name $Attachment.Url))
            $Document.Blocks.Add($File)
        }
    }

    if ($Model.RealSummary) {
        Add-SectionLabel $Document.Blocks 'SUMMARY' 20
        $Summary = New-Paragraph -Size 14.5 -Bottom 4
        Add-LinkifiedText -Inlines $Summary.Inlines -Text $Model.RealSummary -Fg 'Text'
        $Document.Blocks.Add($Summary)
    }

    if (-not $Model.NotExtracted -and $Model.Clean) {
        $Rule = New-Paragraph -Top 22 -Bottom 18
        $Rule.BorderThickness = New-Thickness 0 1 0 0
        $Rule.SetResourceReference([System.Windows.Documents.Block]::BorderBrushProperty, 'Border')
        $Rule.FontSize = 1
        $Rule.LineHeight = 1
        $Document.Blocks.Add($Rule)
        Add-BodyParagraphs $Document.Blocks $Model.Clean
    }

    $ReaderViewer.Document = $Document
    Reset-ReaderScroll
    $OpenLearnUsButton.Tag = $Model.Url
    $OpenLearnUsButton.IsEnabled = [bool]$Model.Url
    $OpenLearnUsButton.Visibility = 'Visible'
    if ($Card.State.IsUnread) { $Card.State.IsUnread = $false; $script:ReadActions[[string]$Card.Id] = Get-Date }
    $MarkReadButton.Visibility = if (@($script:Cards | Where-Object { $_.State.IsUnread }).Count) { 'Visible' } else { 'Collapsed' }
    Update-ReaderNav
}

# ---------------------------------------------------------------------------
# Layout modes: wide (Due | feed | reader), medium (feed+Due | reader), narrow (one column)
# ---------------------------------------------------------------------------
$script:Mode = ''
$script:ReaderOpen = $false

function Set-ReaderOpen([bool]$Open) {
    $script:ReaderOpen = $Open
    if ($script:Mode -ne 'narrow') { return }
    if ($Open) {
        $FeedCard.Visibility = 'Collapsed'
        $ReaderCard.Visibility = 'Visible'
        $BackButton.Visibility = 'Visible'
        $null = $ReaderViewer.Focus()
    }
    else {
        $ReaderCard.Visibility = 'Collapsed'
        $FeedCard.Visibility = 'Visible'
        $BackButton.Visibility = 'Collapsed'
        if ($script:CurrentCard) {
            $Container = $FeedList.ItemContainerGenerator.ContainerFromItem($script:CurrentCard)
            if ($Container) { $null = $Container.Focus() }
        }
    }
}

function Set-LayoutMode([string]$Mode) {
    if ($Mode -eq $script:Mode) { return }
    $script:Mode = $Mode
    $RailHost.Content = $null
    $FeedHeaderHost.Child = $null
    $FeedTop.Children.Clear()
    $Columns = $MainGrid.ColumnDefinitions
    $Star = [System.Windows.GridUnitType]::Star
    switch ($Mode) {
        'wide' {
            $Columns[0].Width = [System.Windows.GridLength]::new(300)
            $Columns[1].Width = [System.Windows.GridLength]::new(14)
            $Columns[2].Width = [System.Windows.GridLength]::new(5, $Star)
            $Columns[3].Width = [System.Windows.GridLength]::new(14)
            $Columns[4].Width = [System.Windows.GridLength]::new(7, $Star)
            $RailCard.Visibility = 'Visible'
            $RailHost.Content = $script:DuePanel
            $FeedHeaderHost.Child = $FeedHeader
            $FeedHeaderHost.Visibility = 'Visible'
        }
        default {
            $Columns[0].Width = [System.Windows.GridLength]::new(0)
            $Columns[1].Width = [System.Windows.GridLength]::new(0)
            $RailCard.Visibility = 'Collapsed'
            $FeedTop.Children.Add($DueWrapper) | Out-Null
            $FeedTop.Children.Add($FeedHeader) | Out-Null
            $FeedHeaderHost.Visibility = 'Collapsed'
            if ($Mode -eq 'medium') {
                $Columns[2].Width = [System.Windows.GridLength]::new(5, $Star)
                $Columns[3].Width = [System.Windows.GridLength]::new(14)
                $Columns[4].Width = [System.Windows.GridLength]::new(7, $Star)
            }
            else {
                $Columns[2].Width = [System.Windows.GridLength]::new(1, $Star)
                $Columns[3].Width = [System.Windows.GridLength]::new(0)
                $Columns[4].Width = [System.Windows.GridLength]::new(0)
            }
        }
    }
    if ($Mode -eq 'narrow') {
        [System.Windows.Controls.Grid]::SetColumn($ReaderCard, 2)
        Set-ReaderOpen $script:ReaderOpen
        if (-not $script:ReaderOpen) {
            $ReaderCard.Visibility = 'Collapsed'
            $FeedCard.Visibility = 'Visible'
        }
    }
    else {
        [System.Windows.Controls.Grid]::SetColumn($ReaderCard, 4)
        $ReaderCard.Visibility = 'Visible'
        $FeedCard.Visibility = 'Visible'
        $BackButton.Visibility = 'Collapsed'
    }
    try { Set-UpdateUi } catch { }
}

function Update-LayoutMode {
    $Width = $Window.ActualWidth
    if ($Width -le 0) { $Width = $Window.Width }
    if ($Width -ge 1180) { Set-LayoutMode 'wide' }
    elseif ($Width -ge 840) { Set-LayoutMode 'medium' }
    else { Set-LayoutMode 'narrow' }
}

function Select-Card($Card, [switch]$Open) {
    if (-not $Card) { return }
    if (-not ($script:FeedCardsInView -contains $Card)) {
        $script:SearchQuery = ''
        $SearchBox.Text = ''
        Set-CourseFilter ''
        Update-Feed
    }
    if ([object]::ReferenceEquals($FeedList.SelectedItem, $Card)) { Show-Reader $Card }
    else { $FeedList.SelectedItem = $Card }
    $FeedList.ScrollIntoView($Card)
    if ($Open -and $script:Mode -eq 'narrow') { Set-ReaderOpen $true }
}

function Move-Selection([int]$Step) {
    $Index = -1
    if ($script:CurrentCard) { $Index = [Array]::IndexOf($script:FeedCardsInView, $script:CurrentCard) }
    $Next = $Index + $Step
    if ($Next -ge 0 -and $Next -lt $script:FeedCardsInView.Count) {
        Select-Card $script:FeedCardsInView[$Next]
    }
}

function Focus-Search {
    if ($script:Mode -eq 'narrow' -and $script:ReaderOpen) { Set-ReaderOpen $false }
    if ($script:Mode -ne 'wide') {
        Stop-SmoothScroll $FeedScroll
        $FeedHeader.BringIntoView()
    }
    $null = $SearchBox.Focus()
    $SearchBox.SelectAll()
}

# ---------------------------------------------------------------------------
# State persistence
# ---------------------------------------------------------------------------
# Merges into the state file instead of overwriting it (see Save-MergedViewerState): another viewer window
# may have resolved, unresolved or read things since this one opened. -Closing also records the window size.
function Save-ViewerState([hashtable]$Restore = $null, [switch]$Closing) {
    try {
        $Mine = @{
            LastOpenedAt      = $script:SessionStart
            UnreadIds         = [string[]]@($script:Cards | Where-Object { $_.State.IsUnread } | Select-Object -First 300 | ForEach-Object { [string]$_.Id })
            UnreadSince       = @{}
            ReadActions       = $script:ReadActions
            ResolveActions    = $script:ResolveActions
            Theme             = $script:ThemeChoice
            ThemeAt           = $script:ThemeChangedAt
            Window            = $null
            Restore           = $Restore
            ConsumedRestoreAt = $script:ConsumedRestoreAt
        }
        foreach ($Card in $script:Cards) { if ($Card.State.IsUnread) { $Mine.UnreadSince[[string]$Card.Id] = $Card.UnreadSince } }
        if ($Closing) {
            $Maximized = ($Window.WindowState -eq [System.Windows.WindowState]::Maximized)
            $Bounds = if ($Maximized) { $Window.RestoreBounds } else { [System.Windows.Rect]::new($Window.Left, $Window.Top, $Window.ActualWidth, $Window.ActualHeight) }
            $Mine.Window = @{ width = [int][Math]::Round($Bounds.Width); height = [int][Math]::Round($Bounds.Height); maximized = $Maximized }
        }
        $Merged = Save-MergedViewerState $StatePath $Mine (Get-Date)
        if ($Merged) {
            # Pick up resolves made in other windows; the Due panels show them on their next rebuild.
            $Synced = @{}
            foreach ($Entry in @($Merged.resolved)) { $Synced[[string]$Entry.id] = [string]$Entry.due }
            $script:ResolvedIds = $Synced
        }
    }
    catch { }
}

try {
    $SavedWindow = Get-StateValue 'window'
    if ($SavedWindow) {
        $WorkArea = [System.Windows.SystemParameters]::WorkArea
        $SavedWidth = [double]$SavedWindow.width
        $SavedHeight = [double]$SavedWindow.height
        if ($SavedWidth -ge $Window.MinWidth -and $SavedHeight -ge $Window.MinHeight) {
            $Window.Width = [Math]::Min($SavedWidth, $WorkArea.Width)
            $Window.Height = [Math]::Min($SavedHeight, $WorkArea.Height)
        }
        if ([bool]$SavedWindow.maximized) { $Window.WindowState = [System.Windows.WindowState]::Maximized }
    }
}
catch { }
# After an Update-triggered restart the new window opens exactly where the old one was.
try {
    if ($script:Restore -and $null -ne $script:Restore.left -and $null -ne $script:Restore.top -and $Window.WindowState -eq [System.Windows.WindowState]::Normal) {
        $RestoreLeft = [double]$script:Restore.left
        $RestoreTop = [double]$script:Restore.top
        $ScreenLeft = [System.Windows.SystemParameters]::VirtualScreenLeft
        $ScreenTop = [System.Windows.SystemParameters]::VirtualScreenTop
        if ($RestoreLeft -ge $ScreenLeft - 50 -and $RestoreTop -ge $ScreenTop - 50 -and
            $RestoreLeft -lt $ScreenLeft + [System.Windows.SystemParameters]::VirtualScreenWidth - 100 -and
            $RestoreTop -lt $ScreenTop + [System.Windows.SystemParameters]::VirtualScreenHeight - 100) {
            $Window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
            $Window.Left = $RestoreLeft
            $Window.Top = $RestoreTop
        }
    }
}
catch { }

function Restore-ScrollPositions {
    if (-not $script:Restore) { return }
    Stop-SmoothScroll $FeedScroll
    Stop-SmoothScroll $RailScroll
    $FeedScroll.UpdateLayout()
    if ($null -ne $script:Restore.feedScroll) { $FeedScroll.ScrollToVerticalOffset([double]$script:Restore.feedScroll) }
    if ($null -ne $script:Restore.railScroll) { $RailScroll.ScrollToVerticalOffset([double]$script:Restore.railScroll) }
    $ReaderHost = Get-ReaderScroll
    if ($ReaderHost -and $null -ne $script:Restore.readerScroll) { $ReaderHost.ScrollToVerticalOffset([double]$script:Restore.readerScroll) }
}

# ---------------------------------------------------------------------------
# Update: run a fresh scan in the background, then reload the viewer
# ---------------------------------------------------------------------------
# State: idle | probing (checking for a running scan) | waiting (someone else's scan is running)
#        | running (our scan) | restarting (waiting for the reloaded viewer to appear)
$script:UpdState = 'idle'
$script:UpdStarted = [datetime]::MinValue
$script:UpdProcess = $null
$script:UpdProbePs = $null
$script:UpdProbeAsync = $null
$script:UpdProbeRunspace = $null
$script:UpdProbeTries = 0
$script:UpdLastProbe = [datetime]::MinValue
$script:UpdStatusTries = 0
$script:UpdNewViewer = $null
$script:SkipSaveOnClose = $false
# A scan with course downloads can take well over an hour; say so after 10 minutes, give up waiting after 110.
$script:UpdTimeoutMinutes = 110
$script:UpdSlowMinutes = 10

# Runs in a background runspace so the (slow) CIM and scheduled-task queries never block the UI thread.
$script:UpdProbeScript = {
    param([int]$SelfPid, [string]$RunnerPath)
    $Result = [PSCustomObject]@{ Running = $false; Reason = '' }
    try {
        $Procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe' OR Name='node.exe'" -ErrorAction Stop)
        foreach ($Proc in $Procs) {
            if ($Proc.ProcessId -eq $SelfPid) { continue }
            $Cmd = [string]$Proc.CommandLine
            if (-not $Cmd) { continue }
            if ($Cmd -like '*show-daily-brief*' -or $Cmd -like '*-RunnerPath*' -or $Cmd -like '*-RunStatusPath*') { continue }
            if ($Cmd -like '*run-lightweight-monitor.ps1*' -or $Cmd -like '*learnus-monitor.mjs*') { $Result.Running = $true; $Result.Reason = 'process'; break }
        }
    }
    catch { }
    if (-not $Result.Running) {
        # The installer's task name, or any running task whose action starts this install's runner.
        try {
            $RunnerLeaf = Split-Path -Leaf $RunnerPath
            $RunnerFolder = (Split-Path -Parent $RunnerPath).TrimEnd('\')
            foreach ($Task in @(Get-ScheduledTask -ErrorAction Stop | Where-Object { [string]$_.State -eq 'Running' })) {
                foreach ($Action in @($Task.Actions)) {
                    $ActionText = ([string]$Action.Execute + ' ' + [string]$Action.Arguments)
                    if ($ActionText.IndexOf($RunnerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $Result.Running = $true }
                    elseif ($ActionText.IndexOf($RunnerLeaf, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and ($ActionText.IndexOf($RunnerFolder, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or ([string]$Action.WorkingDirectory).Trim('"').TrimEnd('\') -eq $RunnerFolder)) { $Result.Running = $true }
                }
                if ($Result.Running) { $Result.Reason = 'task'; break }
            }
        }
        catch { }
    }
    return $Result
}

# Opening a runspace takes a moment, so it is opened asynchronously (and pre-warmed once the window is up).
function Initialize-ProbeRunspace {
    try {
        if ($script:UpdProbeRunspace) { return }
        $script:UpdProbeRunspace = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
        $script:UpdProbeRunspace.OpenAsync()
    }
    catch { $script:UpdProbeRunspace = $null }
}

# Starts a probe if the runspace is ready; the tick calls this again until it is (or gives up).
function Start-ScanProbe {
    try {
        if ($script:UpdProbeAsync) { return }
        $script:UpdProbeTries++
        Initialize-ProbeRunspace
        if (-not $script:UpdProbeRunspace -or $script:UpdProbeRunspace.RunspaceStateInfo.State -ne [System.Management.Automation.Runspaces.RunspaceState]::Opened) { return }
        $Ps = [System.Management.Automation.PowerShell]::Create()
        $Ps.Runspace = $script:UpdProbeRunspace
        [void]$Ps.AddScript($script:UpdProbeScript.ToString()).AddArgument($PID).AddArgument($RunnerPath)
        $script:UpdProbePs = $Ps
        $script:UpdProbeAsync = $Ps.BeginInvoke()
        $script:UpdLastProbe = Get-Date
    }
    catch { $script:UpdProbePs = $null; $script:UpdProbeAsync = $null }
}

# 'none' (no probe in flight), 'pending', 'busy' (a scan is running) or 'free' (probe failures count as free).
function Get-ScanProbeResult {
    if (-not $script:UpdProbeAsync) { return 'none' }
    if (-not $script:UpdProbeAsync.IsCompleted) { return 'pending' }
    $Running = $false
    try {
        $Output = @($script:UpdProbePs.EndInvoke($script:UpdProbeAsync))
        foreach ($Entry in $Output) { if ($Entry -and $Entry.Running) { $Running = $true } }
    }
    catch { $Running = $false }
    try { $script:UpdProbePs.Dispose() } catch { }
    $script:UpdProbePs = $null
    $script:UpdProbeAsync = $null
    if ($Running) { return 'busy' }
    return 'free'
}

function Format-Elapsed([TimeSpan]$Span) {
    return ('{0}:{1:00}' -f [int][Math]::Floor($Span.TotalMinutes), $Span.Seconds)
}

function Set-UpdateUi {
    $Busy = ($script:UpdState -ne 'idle')
    $Narrow = ($script:Mode -eq 'narrow')
    $Elapsed = if ($Busy) { Format-Elapsed ((Get-Date) - $script:UpdStarted) } else { '' }
    $UpdateButton.IsEnabled = -not $Busy
    if ($Busy) {
        $Word = switch ($script:UpdState) { 'waiting' { 'Waiting...' } 'restarting' { 'Reloading...' } default { 'Updating...' } }
        if ($script:UpdState -in 'waiting', 'running' -and ((Get-Date) - $script:UpdStarted).TotalMinutes -ge $script:UpdSlowMinutes) { $Word = 'Still running...' }
        $UpdateLabel.Text = if ($Narrow) { $Elapsed } else { "$Word $Elapsed" }
        $UpdateLabel.Visibility = 'Visible'
        $UpdateButton.ToolTip = switch ($script:UpdState) {
            'waiting' { 'Another scan is running; the viewer will reload when it finishes' }
            'restarting' { 'Reloading the viewer with the new data' }
            default { 'Scanning LearnUs in the background. You can close this window; the scan keeps running.' }
        }
        [System.Windows.Automation.AutomationProperties]::SetName($UpdateButton, "$Word $Elapsed elapsed")
        if (-not $script:UpdSpinning) {
            $Spin = [System.Windows.Media.Animation.DoubleAnimation]::new(0, 360, [System.Windows.Duration]::new([TimeSpan]::FromSeconds(1.1)))
            $Spin.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
            $UpdateSpin.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $Spin)
            $script:UpdSpinning = $true
        }
    }
    else {
        $UpdateLabel.Text = 'Update'
        $UpdateLabel.Visibility = if ($Narrow) { 'Collapsed' } else { 'Visible' }
        $UpdateButton.ToolTip = 'Check LearnUs now'
        [System.Windows.Automation.AutomationProperties]::SetName($UpdateButton, 'Update: check LearnUs now')
        if ($script:UpdSpinning) {
            $UpdateSpin.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $null)
            $UpdateSpin.Angle = 0
            $script:UpdSpinning = $false
        }
    }
}
$script:UpdSpinning = $false

# Kind: 'error' | 'warn' | 'info'. LogPath (optional) adds the "Open log" button.
function Show-UpdateBanner([string]$Kind, [string]$Text, [string]$LogPath = '') {
    $Soft = 'DangerSoft'; $Strong = 'Danger'; $Glyph = 0xEA39
    if ($Kind -eq 'warn') { $Soft = 'WarnSoft'; $Strong = 'Warn'; $Glyph = 0xE7BA }
    elseif ($Kind -eq 'info') { $Soft = 'AccentSoft'; $Strong = 'Accent'; $Glyph = 0xE946 }
    $UpdateBanner.SetResourceReference([System.Windows.Controls.Border]::BackgroundProperty, $Soft)
    $UpdateBanner.SetResourceReference([System.Windows.Controls.Border]::BorderBrushProperty, $Strong)
    $UpdateBannerGlyph.SetResourceReference($TbFgProp, $Strong)
    $UpdateBannerGlyph.Text = [string][char]$Glyph
    $UpdateBannerText.Text = $Text
    $UpdateBannerLog.Tag = $LogPath
    $UpdateBannerLog.Visibility = if ($LogPath -and (Test-Path -LiteralPath $LogPath)) { 'Visible' } else { 'Collapsed' }
    $UpdateBanner.Visibility = 'Visible'
}

function Hide-UpdateBanner { $UpdateBanner.Visibility = 'Collapsed' }

function Start-UpdateScan {
    if ($script:UpdState -ne 'idle') { return }
    if (-not (Test-Path -LiteralPath $RunnerPath)) {
        Show-UpdateBanner 'error' "The scan script was not found, so nothing was started: $RunnerPath"
        return
    }
    Hide-UpdateBanner
    $script:UpdStarted = Get-Date
    $script:UpdStatusTries = 0
    $script:UpdProbeTries = 0
    $script:UpdSlowShown = $false
    $script:UpdState = 'probing'
    Start-ScanProbe
    Set-UpdateUi
    $script:UpdTimer.Start()
}

function Start-ScanProcess {
    try {
        $HostPath = $null
        try { $Found = Get-Command -Name 'pwsh.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1; if ($Found) { $HostPath = $Found.Source } } catch { }
        if (-not $HostPath) { $HostPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
        $Info = New-Object System.Diagnostics.ProcessStartInfo
        $Info.FileName = $HostPath
        # -Command "& '...'" rather than -File: under Windows PowerShell 5.1, -File leaves $PSScriptRoot empty in the
        # runner's [CmdletBinding()] param defaults, so unfixed runners crash before writing a status file.
        $Info.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& ''{0}'' -Mode daily -NoPopup; exit $LASTEXITCODE"' -f ($RunnerPath -replace "'", "''")
        $Info.WorkingDirectory = Split-Path -Parent $RunnerPath
        $Info.UseShellExecute = $false
        $Info.CreateNoWindow = $true
        $Info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
        $script:UpdStarted = Get-Date
        $script:UpdProcess = [System.Diagnostics.Process]::Start($Info)
        $script:UpdState = 'running'
    }
    catch {
        $script:UpdState = 'idle'
        $script:UpdTimer.Stop()
        Show-UpdateBanner 'error' ('The scan could not be started: ' + $_.Exception.Message)
    }
    Set-UpdateUi
}

# Returns $true once the outcome is final (reloaded / failed), $false to try again on the next tick.
function Resolve-ScanResult([bool]$WasWaiting) {
    $Status = $null
    try {
        if (Test-Path -LiteralPath $RunStatusPath) {
            $Item = Get-Item -LiteralPath $RunStatusPath
            if ($Item.LastWriteTime -gt $script:UpdStarted) {
                $Text = [System.IO.File]::ReadAllText($RunStatusPath).TrimStart([char]0xFEFF)
                $Status = $Text | ConvertFrom-Json
            }
        }
    }
    catch { $Status = $null }
    if (-not $Status) {
        $script:UpdStatusTries++
        if ($script:UpdStatusTries -lt 6) { return $false }
        $script:UpdTimer.Stop()
        if ($WasWaiting) { Restart-Viewer; return $true }
        $Code = ''
        try { if ($script:UpdProcess -and $script:UpdProcess.HasExited) { $Code = " (exit code $($script:UpdProcess.ExitCode))" } } catch { }
        $script:UpdState = 'idle'
        Set-UpdateUi
        Show-UpdateBanner 'error' "The scan ended$Code without writing its status file ($RunStatusPath), so it most likely failed on startup and the viewer was not reloaded. Run run-lightweight-monitor.ps1 in a PowerShell window to see the error." (Get-ChildItem -LiteralPath (Split-Path -Parent $RunStatusPath) -Filter 'learnus-daily-*.log' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $script:UpdStarted } | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName)
        return $true
    }
    if ($Status.succeeded -eq $true) {
        $script:UpdTimer.Stop()
        Restart-Viewer
        return $true
    }
    $script:UpdTimer.Stop()
    $script:UpdState = 'idle'
    Set-UpdateUi
    $Reason = [string]$Status.error
    $Message = if ($Reason) { "The update failed: $Reason" } else { 'The update failed. The log has the details.' }
    Show-UpdateBanner 'error' $Message ([string]$Status.log_file)
    return $true
}

function Invoke-UpdateTick {
    if ($script:UpdState -eq 'idle') { $script:UpdTimer.Stop(); return }
    if ($script:UpdState -eq 'restarting') { Invoke-RestartTick; return }
    $Elapsed = (Get-Date) - $script:UpdStarted
    if ($Elapsed.TotalMinutes -ge $script:UpdTimeoutMinutes) {
        $script:UpdTimer.Stop()
        $script:UpdState = 'idle'
        Set-UpdateUi
        Show-UpdateBanner 'warn' "The scan is still running after $script:UpdTimeoutMinutes minutes. The viewer stopped waiting, but the scan was not stopped. Use Update again once it has finished."
        return
    }
    if (-not $script:UpdSlowShown -and $Elapsed.TotalMinutes -ge $script:UpdSlowMinutes -and $script:UpdState -in 'waiting', 'running') {
        $script:UpdSlowShown = $true
        Show-UpdateBanner 'info' 'The scan is still running. Downloading course files can take over an hour; you can keep reading or close this window, and the viewer reloads when the scan finishes.'
    }
    switch ($script:UpdState) {
        'probing' {
            $Probe = Get-ScanProbeResult
            if ($Probe -eq 'pending') { break }
            if ($Probe -eq 'none' -and $script:UpdProbeTries -lt 20) { Start-ScanProbe; break }
            if ($Probe -eq 'busy') {
                $script:UpdState = 'waiting'
                Show-UpdateBanner 'info' 'Update already in progress. Waiting for it to finish, then the viewer will reload.'
            }
            else { Start-ScanProcess }
        }
        'waiting' {
            if ($script:UpdStatusTries -gt 0) { $null = Resolve-ScanResult $true; break }
            $Probe = Get-ScanProbeResult
            if ($Probe -eq 'pending') { break }
            if ($Probe -eq 'free') { $null = Resolve-ScanResult $true; break }
            if ($Probe -eq 'none' -and ((Get-Date) - $script:UpdLastProbe).TotalSeconds -ge 3) { Start-ScanProbe }
        }
        'running' {
            $Done = $true
            try { $Done = $script:UpdProcess.HasExited } catch { $Done = $true }
            if ($Done) { $null = Resolve-ScanResult $false }
        }
    }
    if ($script:UpdState -ne 'idle') { Set-UpdateUi }
}

function Get-RestoreSnapshot {
    $Snapshot = @{ at = (Get-Date).ToString('o', $Invariant) }
    try { if ($script:CurrentCard) { $Snapshot['selectedId'] = [string]$script:CurrentCard.Id } } catch { }
    try { $Snapshot['feedScroll'] = [Math]::Round($FeedScroll.VerticalOffset, 1) } catch { }
    try { $Snapshot['railScroll'] = [Math]::Round($RailScroll.VerticalOffset, 1) } catch { }
    try { $ReaderHost = Get-ReaderScroll; if ($ReaderHost) { $Snapshot['readerScroll'] = [Math]::Round($ReaderHost.VerticalOffset, 1) } } catch { }
    $Snapshot['search'] = [string]$SearchBox.Text
    $Snapshot['course'] = [string]$script:CourseFilter
    $Snapshot['readerOpen'] = [bool]$script:ReaderOpen
    if ($Window.WindowState -eq [System.Windows.WindowState]::Normal) {
        $Snapshot['left'] = [Math]::Round($Window.Left, 1)
        $Snapshot['top'] = [Math]::Round($Window.Top, 1)
    }
    return $Snapshot
}

# Reload = start a fresh viewer process on the new data (the brief, history, cards and Due list are
# built by top-level script code, so an in-place reload would mean re-running all of it). The old window
# stays up until the new one is visible, then closes without saving over the state it just handed off.
function Restart-Viewer {
    try {
        $script:UpdState = 'restarting'
        $script:UpdStarted = Get-Date
        Set-UpdateUi
        Save-ViewerState (Get-RestoreSnapshot) -Closing
        $HostPath = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
        $Info = New-Object System.Diagnostics.ProcessStartInfo
        $Info.FileName = $HostPath
        $Info.Arguments = '-NoProfile -STA -ExecutionPolicy Bypass -File "{0}" -BriefPath "{1}" -HistoryPath "{2}" -StatePath "{3}" -RunnerPath "{4}" -RunStatusPath "{5}"' -f $PSCommandPath, $BriefPath, $HistoryPath, $StatePath, $RunnerPath, $RunStatusPath
        $Info.UseShellExecute = $false
        $Info.CreateNoWindow = $true
        $Info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
        $script:UpdNewViewer = [System.Diagnostics.Process]::Start($Info)
        $script:UpdTimer.Start()
    }
    catch {
        $script:UpdState = 'idle'
        $script:UpdTimer.Stop()
        Set-UpdateUi
        Show-UpdateBanner 'error' ('The scan finished, but the viewer could not reload: ' + $_.Exception.Message)
    }
}

function Invoke-RestartTick {
    try {
        $Fresh = $script:UpdNewViewer
        $Fresh.Refresh()
        if ($Fresh.HasExited) {
            $script:UpdTimer.Stop()
            $script:UpdState = 'idle'
            Set-UpdateUi
            Show-UpdateBanner 'error' 'The scan finished, but the reloaded viewer did not start. Close this window and open the viewer again.'
            return
        }
        if ($Fresh.MainWindowTitle -eq $Window.Title) {
            $script:UpdTimer.Stop()
            $script:SkipSaveOnClose = $true
            $Window.Close()
            return
        }
        if (((Get-Date) - $script:UpdStarted).TotalSeconds -gt 150) {
            $script:UpdTimer.Stop()
            $script:UpdState = 'idle'
            Set-UpdateUi
            Show-UpdateBanner 'warn' 'The reloaded viewer is taking too long to appear. This window is still showing the previous data.'
        }
    }
    catch { }
    Set-UpdateUi
}

$script:UpdTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:UpdTimer.Interval = [TimeSpan]::FromMilliseconds(500)
$script:UpdTimer.Add_Tick({ try { Invoke-UpdateTick } catch { } })

# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------
$FeedList.Add_SelectionChanged({
        try {
            if ($script:SuppressSelection) { return }
            $Selected = $FeedList.SelectedItem
            if (-not $Selected -or $Selected.Kind -ne 'card') { return }
            Show-Reader $Selected
        }
        catch {
            try { Show-ReaderMessage 'This announcement could not be displayed.' $_.Exception.Message } catch { }
        }
    })

$FeedList.Add_PreviewMouseLeftButtonUp({
        param($ListSender, $MouseArgs)
        try {
            if ($script:Mode -ne 'narrow') { return }
            $Item = Find-VisualParent $MouseArgs.OriginalSource ([System.Windows.Controls.ListBoxItem])
            if ($Item -and $Item.DataContext -and $Item.DataContext.Kind -eq 'card') {
                if (-not [object]::ReferenceEquals($script:CurrentCard, $Item.DataContext)) { Show-Reader $Item.DataContext }
                Set-ReaderOpen $true
            }
        }
        catch { }
    })

$FeedList.Add_PreviewKeyDown({
        param($ListSender, $KeyArgs)
        try {
            if (($KeyArgs.Key -eq [System.Windows.Input.Key]::PageDown -or $KeyArgs.Key -eq [System.Windows.Input.Key]::PageUp) -and $script:FeedCardsInView.Count) {
                # The feed list has no scroll host of its own, so page navigation is done here.
                $Step = [Math]::Max(1, [int][Math]::Floor($FeedScroll.ViewportHeight / 120))
                if ($KeyArgs.Key -eq [System.Windows.Input.Key]::PageUp) { $Step = -$Step }
                $Index = if ($script:CurrentCard) { [Array]::IndexOf($script:FeedCardsInView, $script:CurrentCard) } else { 0 }
                $Target = [Math]::Max(0, [Math]::Min($script:FeedCardsInView.Count - 1, $Index + $Step))
                Select-Card $script:FeedCardsInView[$Target]
                $Container = $FeedList.ItemContainerGenerator.ContainerFromItem($script:FeedCardsInView[$Target])
                if ($Container) { $null = $Container.Focus() }
                $KeyArgs.Handled = $true
                return
            }
            if ($KeyArgs.Key -eq [System.Windows.Input.Key]::Enter -and $script:CurrentCard) {
                if ($script:Mode -eq 'narrow') { Set-ReaderOpen $true }
                else { $null = $ReaderViewer.Focus() }
                $KeyArgs.Handled = $true
            }
        }
        catch { }
    })

$script:SearchTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:SearchTimer.Interval = [TimeSpan]::FromMilliseconds(220)
$script:SearchTimer.Add_Tick({
        try {
            $script:SearchTimer.Stop()
            $script:SearchQuery = (($SearchBox.Text -replace '\s+', ' ').Trim()).ToLowerInvariant()
            Update-Feed
        }
        catch { }
    })
$SearchBox.Add_TextChanged({
        try {
            $ClearSearchButton.Visibility = if ($SearchBox.Text) { 'Visible' } else { 'Collapsed' }
            $script:SearchTimer.Stop()
            $script:SearchTimer.Start()
        }
        catch { }
    })
$SearchBox.Add_KeyDown({
        param($BoxSender, $KeyArgs)
        try {
            if ($KeyArgs.Key -eq [System.Windows.Input.Key]::Down -or $KeyArgs.Key -eq [System.Windows.Input.Key]::Enter) {
                $script:SearchTimer.Stop()
                $script:SearchQuery = (($SearchBox.Text -replace '\s+', ' ').Trim()).ToLowerInvariant()
                Update-Feed
                if ($script:FeedCardsInView.Count) {
                    Select-Card $script:FeedCardsInView[0]
                    $Container = $FeedList.ItemContainerGenerator.ContainerFromItem($script:FeedCardsInView[0])
                    if ($Container) { $null = $Container.Focus() }
                }
                $KeyArgs.Handled = $true
            }
        }
        catch { }
    })
$ClearSearchButton.Add_Click({
        try {
            $SearchBox.Text = ''
            $null = $SearchBox.Focus()
        }
        catch { }
    })
$ClearFiltersButton.Add_Click({
        try {
            $SearchBox.Text = ''
            $script:SearchQuery = ''
            Set-CourseFilter ''
            Update-Feed
        }
        catch { }
    })

$MarkReadButton.Add_Click({
        try {
            $ReadNow = Get-Date
            foreach ($Card in $script:Cards) {
                if ($Card.State.IsUnread) { $script:ReadActions[[string]$Card.Id] = $ReadNow }
                $Card.State.IsUnread = $false
                $Card.InNewGroup = $false
            }
            Update-Feed -KeepScroll
        }
        catch { }
    })

$OpenLearnUsButton.Add_Click({
        try { if ($OpenLearnUsButton.Tag) { Open-Url ([string]$OpenLearnUsButton.Tag) } } catch { }
    })
$NewerButton.Add_Click({ try { Move-Selection -1 } catch { } })
$OlderButton.Add_Click({ try { Move-Selection 1 } catch { } })
$BackButton.Add_Click({ try { Set-ReaderOpen $false } catch { } })

$UpdateButton.Add_Click({ try { Start-UpdateScan } catch { } })
$UpdateBannerClose.Add_Click({ try { Hide-UpdateBanner } catch { } })
$UpdateBannerLog.Add_Click({
        try {
            $LogPath = [string]$UpdateBannerLog.Tag
            if ($LogPath -and (Test-Path -LiteralPath $LogPath)) { Start-Process notepad.exe -ArgumentList ('"{0}"' -f $LogPath) }
        }
        catch { }
    })

$ThemeButton.Add_Click({
        try {
            Set-Theme (-not $script:IsDark)
            $script:ThemeChoice = if ($script:IsDark) { 'dark' } else { 'light' }
            $script:ThemeChangedAt = Get-Date
        }
        catch { }
    })

# Overflow menu.
$MoreMenu = New-Object System.Windows.Controls.ContextMenu
function Add-MenuEntry([string]$Header, [scriptblock]$Action, [bool]$Enabled = $true) {
    $Entry = New-Object System.Windows.Controls.MenuItem
    $Entry.Header = $Header
    $Entry.IsEnabled = $Enabled
    $Entry.Add_Click($Action)
    $MoreMenu.Items.Add($Entry) | Out-Null
}
Add-MenuEntry 'Copy brief text' {
    try {
        [System.Windows.Clipboard]::SetText($Content)
        $script:CopiedRestore = $UpdatedText.Text
        $UpdatedText.Text = 'Brief copied to clipboard'
        $script:CopyTimer.Stop()
        $script:CopyTimer.Start()
    }
    catch { }
} ([bool]$Content)
Add-MenuEntry 'Open brief file' { try { Start-Process notepad.exe -ArgumentList ('"{0}"' -f $BriefPath) } catch { } } $HasBrief
Add-MenuEntry 'Scan details' {
    try {
        $Lines = New-Object System.Collections.Generic.List[string]
        foreach ($Pair in $HealthPairs) { $Lines.Add("$($Pair.Key): $($Pair.Value)") }
        foreach ($Note in $HealthNotes) { $Lines.Add($Note) }
        if (-not $Lines.Count) { $Lines.Add('No scan details in this brief.') }
        $null = [System.Windows.MessageBox]::Show($Window, ($Lines -join "`n"), 'Scan details')
    }
    catch { }
} ($HealthPairs.Count -gt 0 -or $HealthNotes.Count -gt 0)
$FilterButton.Add_Click({
        try {
            Build-CourseMenu
            $CourseMenu.PlacementTarget = $FilterButton
            $CourseMenu.Placement = [System.Windows.Controls.Primitives.PlacementMode]::Bottom
            $CourseMenu.IsOpen = $true
        }
        catch { }
    })
$MoreButton.Add_Click({
        try {
            $MoreMenu.PlacementTarget = $MoreButton
            $MoreMenu.Placement = [System.Windows.Controls.Primitives.PlacementMode]::Bottom
            $MoreMenu.IsOpen = $true
        }
        catch { }
    })

$script:CopyTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:CopyTimer.Interval = [TimeSpan]::FromSeconds(2)
$script:CopyTimer.Add_Tick({
        try {
            $script:CopyTimer.Stop()
            if ($script:CopiedRestore) { $UpdatedText.Text = $script:CopiedRestore }
        }
        catch { }
    })

$ReaderViewer.Add_IsKeyboardFocusWithinChanged({
        try {
            $FromKeyboard = [System.Windows.Input.InputManager]::Current.MostRecentInputDevice -is [System.Windows.Input.KeyboardDevice]
            $ReaderFocus.Visibility = if ($ReaderViewer.IsKeyboardFocusWithin -and $FromKeyboard) { 'Visible' } else { 'Collapsed' }
        }
        catch { }
    })

$Window.Add_PreviewKeyDown({
        param($KeySender, $KeyArgs)
        try {
            $Control = ([System.Windows.Input.Keyboard]::Modifiers -band [System.Windows.Input.ModifierKeys]::Control) -ne 0
            $Alt = ([System.Windows.Input.Keyboard]::Modifiers -band [System.Windows.Input.ModifierKeys]::Alt) -ne 0
            $Key = $KeyArgs.Key
            if ($Key -eq [System.Windows.Input.Key]::System) { $Key = $KeyArgs.SystemKey }
            if ($Control -and $Key -eq [System.Windows.Input.Key]::F) {
                Focus-Search
                $KeyArgs.Handled = $true
                return
            }
            if (($Key -eq [System.Windows.Input.Key]::F5 -and -not $Control -and -not $Alt) -or ($Control -and -not $Alt -and $Key -eq [System.Windows.Input.Key]::R)) {
                Start-UpdateScan
                $KeyArgs.Handled = $true
                return
            }
            # Esc undoes one thing at a time (open menu, search text, narrow reader) and only closes the window last.
            if ($Key -eq [System.Windows.Input.Key]::Escape) {
                if ($MoreMenu.IsOpen -or $CourseMenu.IsOpen) {
                    $MoreMenu.IsOpen = $false
                    $CourseMenu.IsOpen = $false
                    $KeyArgs.Handled = $true
                    return
                }
                if ($SearchBox.Text) {
                    $SearchBox.Text = ''
                    $KeyArgs.Handled = $true
                    return
                }
                if ($script:Mode -eq 'narrow' -and $script:ReaderOpen) {
                    Set-ReaderOpen $false
                    $KeyArgs.Handled = $true
                    return
                }
                $Window.Close()
                $KeyArgs.Handled = $true
                return
            }
            if ($Alt -and $Key -eq [System.Windows.Input.Key]::Left -and $script:Mode -eq 'narrow' -and $script:ReaderOpen) {
                Set-ReaderOpen $false
                $KeyArgs.Handled = $true
            }
        }
        catch { }
    })

$Window.Add_SizeChanged({
        try { Update-LayoutMode } catch { }
    })

$Window.Add_Closing({
        try { if (-not $script:SkipSaveOnClose) { Save-ViewerState -Closing } } catch { }
        try { if ($script:UpdProbeRunspace) { $script:UpdProbeRunspace.Dispose() } } catch { }
    })

# ---------------------------------------------------------------------------
# Window lifecycle
# ---------------------------------------------------------------------------
Set-Theme $script:IsDark
Set-CourseFilter ''
if ($script:Restore) {
    try {
        $RestoreCourse = [string]$script:Restore.course
        if ($RestoreCourse -and ($script:CourseOptions | Where-Object { $_.Course -eq $RestoreCourse })) { Set-CourseFilter $RestoreCourse }
        $RestoreSearch = [string]$script:Restore.search
        if ($RestoreSearch) {
            $SearchBox.Text = $RestoreSearch
            $script:SearchTimer.Stop()
            $script:SearchQuery = (($RestoreSearch -replace '\s+', ' ').Trim()).ToLowerInvariant()
        }
    }
    catch { }
}
Update-LayoutMode
Update-Feed
if ($script:Cards.Count -eq 0) {
    $SearchRow.Visibility = 'Collapsed'
    $FilterButton.Visibility = 'Collapsed'
    $MarkReadButton.Visibility = 'Collapsed'
    $ReaderBar.Visibility = 'Collapsed'
    if ($script:HistoryError) { Show-ReaderMessage 'Announcements unavailable' ($script:HistoryError + ' The next successful scan rewrites it.') }
    else { Show-ReaderMessage 'Nothing to read yet' 'Saved announcements will show up here once the monitor has scanned your courses.' }
}
else {
    Show-ReaderMessage 'Select an announcement' 'Pick an announcement on the left to read it here.'
}

$Window.Add_SourceInitialized({
        try {
            $script:WindowHandle = (New-Object System.Windows.Interop.WindowInteropHelper($Window)).EnsureHandle()
            Set-Theme $script:IsDark
        }
        catch { }
    })

$Window.Add_Loaded({
        try {
            Enable-SmoothScroll $FeedScroll
            Enable-SmoothScroll $RailScroll
            Enable-SmoothScroll (Get-ReaderScroll)
        }
        catch { }
    })

$Window.Add_ContentRendered({
        $Window.Activate() | Out-Null
        try {
            Update-LayoutMode
            if ($script:Cards.Count -gt 0) {
                $First = $null
                if ($script:Restore -and $script:Restore.selectedId) {
                    $RestoredCard = $script:CardById[[string]$script:Restore.selectedId]
                    if ($RestoredCard -and ($script:FeedCardsInView -contains $RestoredCard)) { $First = $RestoredCard }
                }
                if (-not $First) { $First = $script:Cards | Where-Object { $_.InNewGroup } | Select-Object -First 1 }
                if (-not $First) { $First = $script:FeedCardsInView | Select-Object -First 1 }
                if ($First) {
                    $script:SuppressSelection = $true
                    $FeedList.SelectedItem = $First
                    $script:SuppressSelection = $false
                    Show-Reader $First
                    if ($script:Restore -and [object]::ReferenceEquals($First, $RestoredCard) -and $script:Restore.readerOpen -and $script:Mode -eq 'narrow') { Set-ReaderOpen $true }
                }
            }
            if ($script:Restore) {
                # Scroll offsets only stick once the lists have been laid out, so wait for idle.
                $null = $Window.Dispatcher.BeginInvoke([System.Windows.Threading.DispatcherPriority]::ApplicationIdle, [Action] { try { Restore-ScrollPositions } catch { } })
                # Layout can still grow a little after the first idle pass, so settle once more.
                $script:RestoreTimer = New-Object System.Windows.Threading.DispatcherTimer
                $script:RestoreTimer.Interval = [TimeSpan]::FromMilliseconds(700)
                $script:RestoreTimer.Add_Tick({ try { $script:RestoreTimer.Stop(); Restore-ScrollPositions } catch { } })
                $script:RestoreTimer.Start()
            }
        }
        catch { }

        $null = $Window.Dispatcher.BeginInvoke([System.Windows.Threading.DispatcherPriority]::ApplicationIdle, [Action] { try { Initialize-ProbeRunspace } catch { } })

        # Bring the window forward initially, then stop forcing it above other apps.
        $Timer = New-Object System.Windows.Threading.DispatcherTimer
        $Timer.Interval = [TimeSpan]::FromSeconds(2)
        $Timer.Add_Tick({
                param($sender, $eventArgs)
                $Window.Topmost = $false
                $sender.Stop()
            })
        $Timer.Start()
    })

$null = $Window.ShowDialog()
