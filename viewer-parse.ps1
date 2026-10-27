# Brief / announcement parsing, Due-list building and viewer-state merging for show-daily-brief.ps1.
# Dot-source this file (it only defines constants and functions; no WPF, no side effects) so the
# parsing can be tested headless under Windows PowerShell 5.1 and pwsh (see test/viewer-parse.test.mjs).
# Keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less scripts as ANSI).

$Dash = [string][char]0x2014
$Bullet = [string][char]0x2022
$Ellipsis = [string][char]0x2026
$WordJoiner = [string][char]0x2060
$Invariant = [Globalization.CultureInfo]::InvariantCulture

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
function ConvertTo-LocalDate($Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [datetime]) {
        if ($Value.Kind -eq [DateTimeKind]::Utc) { return $Value.ToLocalTime() }
        return $Value
    }
    if ($Value -is [DateTimeOffset]) { return $Value.LocalDateTime }
    $Text = ([string]$Value).Trim()
    if (-not $Text) { return $null }
    try { return [DateTimeOffset]::Parse($Text, $Invariant).LocalDateTime } catch { return $null }
}

function Get-PropertyValue($Object, [string[]]$Names) {
    if ($null -eq $Object) { return $null }
    # Indexer lookup: enumerating .Properties.Name per call made 1000+ announcements take minutes.
    try { $Properties = $Object.PSObject.Properties } catch { return $null }
    foreach ($Name in $Names) {
        try {
            $Property = $Properties[$Name]
            if ($Property) {
                $Value = $Property.Value
                if ($null -ne $Value -and [string]$Value -ne '') { return $Value }
            }
        }
        catch { }
    }
    return $null
}

function Remove-Markdown([string]$Text) {
    if (-not $Text) { return '' }
    $Text = $Text -replace '\[([^\]]+)\]\(([^)]+)\)', '$1'
    return ($Text -replace '\*\*', '').Trim()
}

# ---------------------------------------------------------------------------
# Brief parsing (Markdown -> sections/items)
# ---------------------------------------------------------------------------
$DeadlinePattern = '^[A-Z][a-z]{2,3}\.? \d{1,2}, \d{1,2}:\d{2}$'
$UrgencyLabelPattern = '^\*{0,2}(OVERDUE|DUE TODAY|DUE TOMORROW|DUE SOON)\*{0,2}:?$'
$script:ReferenceDate = Get-Date

function ConvertTo-Deadline([string]$Text) {
    $Parsed = [datetime]::MinValue
    $Formats = [string[]]@('MMM d, HH:mm', 'MMM d, H:mm')
    # Some Intl builds print midnight as 24:00 (hour cycle h24); that is 00:00 of the same date.
    $Text = $Text.Trim().Replace('.', '') -replace ', 24:(\d\d)$', ', 00:$1'
    if (-not [datetime]::TryParseExact($Text, $Formats, $Invariant, [Globalization.DateTimeStyles]::AllowWhiteSpaces, [ref]$Parsed)) {
        return $null
    }
    try {
        $Reference = $script:ReferenceDate
        $Date = [datetime]::new($Reference.Year, $Parsed.Month, $Parsed.Day, $Parsed.Hour, $Parsed.Minute, 0)
        if (($Date - $Reference).TotalDays -lt -183) { $Date = $Date.AddYears(1) }
        elseif (($Date - $Reference).TotalDays -gt 183) { $Date = $Date.AddYears(-1) }
        return $Date
    }
    catch {
        return $null
    }
}

function Split-TaskText([string]$Text) {
    $Tokens = $Text -split (' ' + $Dash + ' ')
    if ($Tokens.Count -lt 2) { return $null }
    $Overdue = $false
    $Label = $null
    $DateText = $null
    $Course = $null
    $CourseMarked = $false
    $Task = New-Object System.Collections.Generic.List[string]
    foreach ($Token in $Tokens) {
        $Trimmed = $Token.Trim()
        # "Needs attention" rows start with an urgency label (learnus-monitor.mjs attentionLabel); it is not a course.
        if (-not $Label -and $Trimmed -cmatch $UrgencyLabelPattern) {
            $Label = $Matches[1]
            if ($Label -eq 'OVERDUE') { $Overdue = $true }
            continue
        }
        if (-not $DateText -and $Trimmed -match $DeadlinePattern) { $DateText = $Trimmed; continue }
        if (-not $Course -and $Trimmed -match '^\*\*(.+)\*\*$') { $Course = $Matches[1]; $CourseMarked = $true; continue }
        $Task.Add($Trimmed)
    }
    if (-not $DateText) { return $null }
    $Date = ConvertTo-Deadline $DateText
    if (-not $Date) { return $null }
    if (-not $Course -and $Task.Count -ge 2) {
        $Course = $Task[0]
        $Task.RemoveAt(0)
    }
    if ($Task.Count -eq 0) { $Task.Add('Untitled task') }
    return [PSCustomObject]@{
        Overdue      = $Overdue
        Label        = $Label
        Date         = $Date
        Course       = ($Course -replace '\*\*', '').Trim()
        CourseMarked = $CourseMarked
        Task         = (($Task -join " $Dash ") -replace '\*\*', '').Trim()
    }
}

function Test-EmptyItem([string]$Text) {
    return ($Text -match '^(None\b|No\s|Nothing\b)')
}

# Markdown brief -> sections of items. Sets the reference date (used to give "Oct 8, 23:59" a year)
# from the brief's "Generated:" stamp when it has one.
function ConvertFrom-BriefMarkdown([string]$Content) {
    $Generated = $null
    $Sections = New-Object System.Collections.Generic.List[object]
    $CurrentSection = $null
    $LastItem = $null
    if (-not $Content) { $Content = '' }
    foreach ($RawLine in ($Content.TrimStart([char]0xFEFF) -split '\r?\n')) {
        $Line = $RawLine.TrimEnd()
        if (-not $Line.Trim()) { continue }
        if ($Line -match '^#\s+(.+)$') { continue }
        if (-not $Generated -and $Line -match '^Generated:\s*(.+)$') {
            try { $Generated = [DateTimeOffset]::Parse($Matches[1].Trim(), $Invariant) } catch { $Generated = $null }
            continue
        }
        if ($Line -match '^#{2,6}\s+(.+)$') {
            $CurrentSection = [PSCustomObject]@{ Title = ($Matches[1] -replace '\*\*', '').Trim(); Items = (New-Object System.Collections.Generic.List[object]) }
            $Sections.Add($CurrentSection)
            $LastItem = $null
            continue
        }
        if (-not $CurrentSection) {
            $CurrentSection = [PSCustomObject]@{ Title = ''; Items = (New-Object System.Collections.Generic.List[object]) }
            $Sections.Add($CurrentSection)
        }
        if ($Line -match '^(\s*)[-*+]\s+(.*)$') {
            $Indent = $Matches[1].Length
            $Text = $Matches[2]
            if ($Indent -ge 2 -and $LastItem) {
                $LastItem.Subs.Add($Text)
            }
            else {
                $LastItem = [PSCustomObject]@{ Text = $Text; Subs = (New-Object System.Collections.Generic.List[string]); Plain = $false; Task = $null }
                $CurrentSection.Items.Add($LastItem)
            }
            continue
        }
        $LastItem = [PSCustomObject]@{ Text = $Line.Trim(); Subs = (New-Object System.Collections.Generic.List[string]); Plain = $true; Task = $null }
        $CurrentSection.Items.Add($LastItem)
    }
    if ($Generated) { $script:ReferenceDate = $Generated.LocalDateTime }
    return [PSCustomObject]@{ Generated = $Generated; Sections = $Sections }
}

# "- **COURSE** -- Title -- C:\...\file.pdf" (the downloader's "New course files" section).
function ConvertTo-BriefFile([string]$Text) {
    $Tokens = @($Text -split (' ' + $Dash + ' '))
    if ($Tokens.Count -lt 3) { return $null }
    if ($Tokens[0].Trim() -notmatch '^\*\*(.+)\*\*$') { return $null }
    $Course = $Matches[1].Trim()
    # The path is the last token that starts like an absolute path (a title may itself contain the dash).
    $PathIndex = -1
    for ($i = $Tokens.Count - 1; $i -ge 2; $i--) {
        if ($Tokens[$i].Trim() -match '^([A-Za-z]:[\\/]|\\\\|/)') { $PathIndex = $i; break }
    }
    if ($PathIndex -lt 0) { return $null }
    $Path = (($Tokens[$PathIndex..($Tokens.Count - 1)]) -join " $Dash ").Trim()
    $Title = (($Tokens[1..($PathIndex - 1)]) -join " $Dash ").Trim()
    $Name = ($Path -split '[\\/]')[-1]
    if (-not $Name) { $Name = $Title }
    return [PSCustomObject]@{
        Course = $Course
        Title  = (Remove-Markdown $Title)
        Path   = $Path
        Name   = $Name
        IsLink = [bool]($Name -match '\.url$')
    }
}

# Sorts the brief's sections into tasks, rail notes, announcement lines, scan health and new files.
function Get-BriefParts($Sections) {
    $Parts = [PSCustomObject]@{
        Tasks             = (New-Object System.Collections.Generic.List[object])
        RailNotes         = (New-Object System.Collections.Generic.List[object])
        AnnouncementItems = (New-Object System.Collections.Generic.List[string])
        HealthPairs       = (New-Object System.Collections.Generic.List[object])
        HealthNotes       = (New-Object System.Collections.Generic.List[string])
        Files             = (New-Object System.Collections.Generic.List[object])
        FileNotes         = (New-Object System.Collections.Generic.List[string])
        FilesPreview      = $false
        HealthOk          = $true
        CoursesChecked    = $null
    }
    foreach ($Section in $Sections) {
        $Title = [string]$Section.Title
        $Kind = 'notes'
        if ($Title -match 'health') { $Kind = 'health' }
        elseif ($Title -match 'announcement') { $Kind = 'announcements' }
        elseif ($Title -match 'course files|new files|download') { $Kind = 'files' }
        elseif ($Title -match 'complete' -and $Title -notmatch 'incomplete') { $Kind = 'done' }
        elseif ($Title -match 'incomplete|activit') { $Kind = 'also' }
        elseif ($Title -match 'changed course|course information') { $Kind = 'changes' }
        elseif ($Title -match 'attention|task|deadline') { $Kind = 'tasks' }

        $Texts = New-Object System.Collections.Generic.List[string]
        foreach ($Item in $Section.Items) {
            # Only task sections hold Due items; "Deadline changed" lines elsewhere must not become tasks.
            if ($Kind -eq 'tasks' -and -not $Item.Plain) { $Item.Task = Split-TaskText $Item.Text }
            if ($Item.Task) {
                $Status = $null
                foreach ($Sub in $Item.Subs) {
                    if ($Sub -match '^Status:\s*(.+)$') { $Status = Remove-Markdown $Matches[1] }
                }
                $Parts.Tasks.Add([PSCustomObject]@{ Task = $Item.Task; Status = $Status })
                continue
            }
            if ($Kind -eq 'files') {
                if ($Item.Plain -and $Item.Text -match '^Preview\b') { $Parts.FilesPreview = $true; continue }
                if (Test-EmptyItem $Item.Text) { continue }
                $File = if ($Item.Plain) { $null } else { ConvertTo-BriefFile $Item.Text }
                if ($File) { $Parts.Files.Add($File) } else { $Parts.FileNotes.Add((Remove-Markdown $Item.Text)) }
                continue
            }
            if (Test-EmptyItem $Item.Text) { continue }
            if ($Kind -eq 'health') {
                if ($Item.Text -match '^([A-Za-z][^:]{0,40}):\s+(.+)$') { $Parts.HealthPairs.Add([PSCustomObject]@{ Key = $Matches[1].Trim(); Value = (Remove-Markdown $Matches[2]) }) }
                else { $Parts.HealthNotes.Add((Remove-Markdown $Item.Text)) }
                continue
            }
            if ($Kind -eq 'announcements') {
                $Parts.AnnouncementItems.Add((Remove-Markdown $Item.Text))
                continue
            }
            $Line = Remove-Markdown $Item.Text
            if ($Kind -eq 'tasks') { $Line = $Line -creplace ('^(OVERDUE|DUE TODAY|DUE TOMORROW|DUE SOON)\s*' + $Dash + '\s*'), '$1: ' }
            foreach ($Sub in $Item.Subs) {
                $SubText = Remove-Markdown $Sub
                if ($SubText -and $SubText.Length -le 160) { $Line += "  ($SubText)" }
            }
            $Texts.Add($Line)
        }
        if ($Texts.Count -gt 0 -and $Kind -ne 'health' -and $Kind -ne 'announcements' -and $Kind -ne 'files') {
            $Label = switch ($Kind) {
                'also' { 'Also open' }
                'done' { 'Done since last check' }
                'changes' { 'Course changes' }
                default { if ($Title) { $Title } else { 'Notes' } }
            }
            $Glyph = switch ($Kind) { 'done' { 0xE73E } 'also' { 0xE8FD } 'changes' { 0xE70F } default { 0xE946 } }
            $Fg = switch ($Kind) { 'done' { 'Good' } 'tasks' { 'Danger' } default { 'TextMuted' } }
            $Parts.RailNotes.Add([PSCustomObject]@{ Label = $Label; Items = $Texts; Glyph = $Glyph; Fg = $Fg })
        }
    }
    foreach ($Pair in $Parts.HealthPairs) {
        if ($Pair.Key -match '^Courses checked$' -and $Pair.Value -match '^(\d+)\s*/\s*(\d+)') {
            $Parts.CoursesChecked = $Pair.Value
            if ([int]$Matches[1] -lt [int]$Matches[2]) { $Parts.HealthOk = $false }
        }
        if ($Pair.Key -match 'All active courses checked' -and $Pair.Value -notmatch '^(yes|true)') { $Parts.HealthOk = $false }
    }
    return $Parts
}

# ---------------------------------------------------------------------------
# Announcements: load, clean, extract dates
# ---------------------------------------------------------------------------
# Returns { Announcements = @(...); Error = $null | 'message' }.
function Read-AnnouncementHistory([string]$Path) {
    $Result = [PSCustomObject]@{ Announcements = @(); Error = $null }
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $Result }
    try {
        $HistoryText = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
        if ($HistoryText -and $HistoryText.Trim()) {
            $HistoryDocument = $HistoryText.TrimStart([char]0xFEFF) | ConvertFrom-Json
            # Accept a bare array as well as { announcements: [...] }; anything else is not a history file.
            $Source = if ($HistoryDocument -is [array]) { $HistoryDocument } elseif ($HistoryDocument -and $HistoryDocument.PSObject.Properties['announcements']) { $HistoryDocument.announcements } else { $null }
            if ($null -ne $Source -and $Source -isnot [array]) { $Source = $null }
            $Result.Announcements = @($Source | Where-Object { $_ -is [System.Management.Automation.PSCustomObject] })
            if ($null -eq $Source -and $null -ne $HistoryDocument) { $Result.Error = 'The announcement archive has an unexpected format.' }
        }
    }
    catch {
        $Result.Announcements = @()
        $Result.Error = 'The announcement archive could not be read (it may be damaged or still being written).'
    }
    return $Result
}

function Get-AnnouncementTitle($Announcement) {
    $Value = Get-PropertyValue $Announcement @('english_title', 'source_title', 'title')
    if ($Value) { return [string]$Value }
    return 'Untitled announcement'
}

function Get-CleanTitle([string]$Text) {
    $Title = ($Text -replace '\s+', ' ').Trim()
    $Title = $Title -replace '^\*+\s*', ''
    $Title = $Title -replace '(?<=[^\s\[\(])\[', ' ['
    $Title = $Title -replace '\](?=[^\s\]\)\.,:;!?])', '] '
    $Title = $Title -replace '\(\s+', '('
    $Title = $Title -replace '\s+\)', ')'
    $Title = $Title -replace '\s{2,}', ' '
    return $Title.Trim()
}

# Keep Korean words together when a title wraps (WPF otherwise breaks between any two syllables).
$WordJoiner = [string][char]0x2060
function Join-Hangul([string]$Text) {
    if (-not $Text) { return $Text }
    return [regex]::Replace($Text, '(?<=[\uAC00-\uD7A3])(?=[\uAC00-\uD7A3])', $WordJoiner)
}

function Get-CourseDisplayName([string]$Name) {
    if (-not $Name) { return 'Unknown course' }
    $Display = ($Name -replace '\s+', ' ').Trim()
    if ($Display -ceq $Display.ToUpperInvariant()) {
        $Display = $Invariant.TextInfo.ToTitleCase($Display.ToLowerInvariant())
    }
    return [regex]::Replace($Display, '(?<=\s)(And|To|Of|The|In|On|For)(?=\s)', [System.Text.RegularExpressions.MatchEvaluator] { param($Found) $Found.Value.ToLowerInvariant() })
}

$script:CourseShortCache = @{}
function Get-CourseShortName([string]$Name) {
    if (-not $Name) { return 'Unknown course' }
    # A handful of courses repeat across every announcement; the regex work is cached per name.
    if ($script:CourseShortCache.ContainsKey($Name)) { return $script:CourseShortCache[$Name] }
    $Short = Get-CourseShortNameUncached $Name
    $script:CourseShortCache[$Name] = $Short
    return $Short
}

function Get-CourseShortNameUncached([string]$Name) {
    $Short = Get-CourseDisplayName $Name
    $Short = $Short -replace '^Introduction to\b', 'Intro to'
    $Short = $Short -replace '(?<=\s)and(?=\s)', '&'
    if ($Short.Length -gt 24) {
        $Words = $Short -split ' '
        $Built = ''
        foreach ($Word in $Words) {
            $Next = if ($Built) { "$Built $Word" } else { $Word }
            if ($Next.Length -gt 24) { break }
            $Built = $Next
        }
        $Short = ($Built -replace '[\s&,:-]+$', '')
        if (-not $Short) { $Short = $Name.Substring(0, 24) }
    }
    return $Short
}

function Get-CleanBody([string]$Body) {
    if (-not $Body) { return '' }
    $Text = $Body -replace "`r`n", "`n" -replace "`r", "`n"
    $Text = $Text.Replace([string][char]0x00A0, ' ').Replace([string][char]0x200E, '').Replace([string][char]0x200F, '').Replace([string][char]0x200B, '')
    $Output = New-Object System.Collections.Generic.List[string]
    $PendingBullet = $null
    foreach ($Line in ($Text -split "`n")) {
        $Trimmed = $Line.Trim()
        if ($Trimmed -match '^([\u2022\u25CF\u25AA\u25E6\u00B7*-]|\d{1,2}[.)])$') { $PendingBullet = $Trimmed; continue }
        if ($PendingBullet) {
            if (-not $Trimmed) { continue }
            $Marker = if ($PendingBullet -match '^\d') { $PendingBullet } else { $Bullet }
            $Output.Add("$Marker $Trimmed")
            $PendingBullet = $null
            continue
        }
        $Output.Add($Trimmed)
    }
    $Joined = ($Output -join "`n") -replace "\n{3,}", "`n`n"
    return $Joined.Trim()
}

function Test-Boilerplate([string]$Body) {
    if (-not $Body) { return $false }
    $Head = $Body.Substring(0, [Math]::Min(800, $Body.Length))
    if ($Head -match 'Skip to main content') { return $true }
    if ($Head -match '\bLog ?out\b' -and $Head -match 'Yonsei Portal|learnus|My Page|Course Home') { return $true }
    return $false
}

$MonthNumbers = @{ jan = 1; feb = 2; mar = 3; apr = 4; may = 5; jun = 6; jul = 7; aug = 8; sep = 9; oct = 10; nov = 11; dec = 12 }
$MentionRegex = New-Object System.Text.RegularExpressions.Regex(
    '(?<![A-Za-z])(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?,?\s+)?(?<mon>Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(?<day>[0-3]?\d)(?:st|nd|rd|th)?(?![\d:])(?:,?\s+(?<year>20\d\d))?|(?<kmon>1[0-2]|0?[1-9])\s*\uC6D4\s*(?<kday>[0-3]?\d)\s*\uC77C',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
$Time12Regex = New-Object System.Text.RegularExpressions.Regex('(?<![\d:])(?<h>1[0-2]|0?[1-9])(?::(?<m>[0-5]\d))?\s*(?<ap>[ap])\.?\s?m\b\.?', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
$Time24Regex = New-Object System.Text.RegularExpressions.Regex('(?<![\d:])(?<h>[01]?\d|2[0-3]):(?<m>[0-5]\d)(?![\d:])')
$DeadlineWordRegex = New-Object System.Text.RegularExpressions.Regex('\b(due|deadline|submit\w*|turn(ed)? in|hand in|no later than|until|quiz|exam|midterm|presentation|assignment|homework|email your|upload)\b|\uB9C8\uAC10|\uC81C\uCD9C', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)

function Get-Snippet([string]$Text, [int]$Index, [int]$Length) {
    $Start = [Math]::Max(0, $Index - 90)
    $End = [Math]::Min($Text.Length, $Index + $Length + 70)
    $Snippet = $Text.Substring($Start, $End - $Start)
    if ($Start -gt 0) {
        $Space = $Snippet.IndexOf(' ')
        if ($Space -ge 0 -and $Space -lt 20) { $Snippet = $Snippet.Substring($Space + 1) }
        $Snippet = $Ellipsis + $Snippet
    }
    if ($End -lt $Text.Length) {
        $Space = $Snippet.LastIndexOf(' ')
        if ($Space -gt $Snippet.Length - 20) { $Snippet = $Snippet.Substring(0, $Space) }
        $Snippet = $Snippet + $Ellipsis
    }
    return (($Snippet -replace '\s+', ' ').Trim())
}

function Get-DateMentions([string]$Text, $Posted) {
    $Results = New-Object System.Collections.Generic.List[object]
    if (-not $Text) { return , $Results }
    $Flat = $Text -replace '\s+', ' '
    # Bound the work per announcement: a pasted schedule with thousands of dates froze startup for minutes.
    if ($Flat.Length -gt 20000) { $Flat = $Flat.Substring(0, 20000) }
    $Base = if ($Posted) { $Posted } else { Get-Date }
    $Seen = @{}
    $Scanned = 0
    foreach ($Match in $MentionRegex.Matches($Flat)) {
        if (++$Scanned -gt 60) { break }
        try {
            if ($Match.Groups['mon'].Success) {
                $Month = $MonthNumbers[$Match.Groups['mon'].Value.Substring(0, 3).ToLowerInvariant()]
                $Day = [int]$Match.Groups['day'].Value
                $Year = if ($Match.Groups['year'].Success) { [int]$Match.Groups['year'].Value } else { 0 }
            }
            else {
                $Month = [int]$Match.Groups['kmon'].Value
                $Day = [int]$Match.Groups['kday'].Value
                $Year = 0
            }
            if (-not $Month -or $Day -lt 1 -or $Day -gt 31) { continue }
            if ($Year -gt 0) { $Date = [datetime]::new($Year, $Month, $Day) }
            else {
                $Date = [datetime]::new($Base.Year, $Month, $Day)
                if ($Date -lt $Base.Date.AddDays(-60)) { $Date = $Date.AddYears(1) }
                elseif ($Date -gt $Base.Date.AddDays(300)) { $Date = $Date.AddYears(-1) }
            }
        }
        catch { continue }

        $WindowStart = [Math]::Max(0, $Match.Index - 60)
        $WindowEnd = [Math]::Min($Flat.Length, $Match.Index + $Match.Length + 45)
        $Around = $Flat.Substring($WindowStart, $WindowEnd - $WindowStart)
        $Center = $Match.Index - $WindowStart + [int]($Match.Length / 2)
        $HasTime = $false
        $BestDistance = [int]::MaxValue
        foreach ($TimeMatch in $Time12Regex.Matches($Around)) {
            $Distance = [Math]::Abs($TimeMatch.Index - $Center)
            if ($Distance -lt $BestDistance) {
                $Hour = [int]$TimeMatch.Groups['h'].Value % 12
                if ($TimeMatch.Groups['ap'].Value -match '^[pP]') { $Hour += 12 }
                $Minute = if ($TimeMatch.Groups['m'].Success) { [int]$TimeMatch.Groups['m'].Value } else { 0 }
                $Date = $Date.Date.AddHours($Hour).AddMinutes($Minute)
                $HasTime = $true
                $BestDistance = $Distance
            }
        }
        if (-not $HasTime) {
            foreach ($TimeMatch in $Time24Regex.Matches($Around)) {
                $Distance = [Math]::Abs($TimeMatch.Index - $Center)
                if ($Distance -lt $BestDistance) {
                    $Date = $Date.Date.AddHours([int]$TimeMatch.Groups['h'].Value).AddMinutes([int]$TimeMatch.Groups['m'].Value)
                    $HasTime = $true
                    $BestDistance = $Distance
                }
            }
        }
        if (-not $HasTime -and $Around -match '\bmidnight\b') { $Date = $Date.Date.AddHours(23).AddMinutes(59); $HasTime = $true }

        $KeyStart = [Math]::Max(0, $Match.Index - 80)
        $KeyEnd = [Math]::Min($Flat.Length, $Match.Index + $Match.Length + 30)
        $IsDeadline = $DeadlineWordRegex.IsMatch($Flat.Substring($KeyStart, $KeyEnd - $KeyStart))

        $DayKey = $Date.ToString('yyyy-MM-dd')
        $Entry = [PSCustomObject]@{
            Date       = $Date
            HasTime    = $HasTime
            IsDeadline = $IsDeadline
            Context    = (Get-Snippet $Flat $Match.Index $Match.Length)
        }
        if ($Seen.ContainsKey($DayKey)) {
            $Old = $Seen[$DayKey]
            if (($IsDeadline -and -not $Old.IsDeadline) -or ($IsDeadline -eq $Old.IsDeadline -and $HasTime -and -not $Old.HasTime)) {
                $Results.Remove($Old) | Out-Null
                $Results.Add($Entry)
                $Seen[$DayKey] = $Entry
            }
            continue
        }
        $Seen[$DayKey] = $Entry
        $Results.Add($Entry)
    }
    $Sorted = New-Object System.Collections.Generic.List[object]
    foreach ($Entry in ($Results | Sort-Object -Property Date)) { $Sorted.Add($Entry) }
    return , $Sorted
}

function Get-ExplicitDeadlines($Announcement) {
    $Results = New-Object System.Collections.Generic.List[object]
    $Raw = $null
    try { if ($Announcement.PSObject.Properties.Name -contains 'deadlines') { $Raw = @($Announcement.deadlines) } } catch { }
    if ($null -eq $Raw) { return $null }
    foreach ($Entry in $Raw) {
        if ($null -eq $Entry) { continue }
        $DateValue = $null
        $Label = $null
        if ($Entry -is [string] -or $Entry -is [datetime]) { $DateValue = $Entry }
        else {
            $DateValue = Get-PropertyValue $Entry @('due_at', 'due', 'date', 'datetime', 'deadline', 'at', 'when')
            $Label = Get-PropertyValue $Entry @('title', 'label', 'text', 'name', 'description', 'context')
        }
        $Date = ConvertTo-LocalDate $DateValue
        if (-not $Date) { continue }
        $HasTime = -not ($Date.TimeOfDay.TotalMinutes -eq 0 -and [string]$DateValue -notmatch '\d:\d')
        $Results.Add([PSCustomObject]@{ Date = $Date; HasTime = $HasTime; IsDeadline = $true; Context = [string]$Label })
    }
    return , $Results
}

function Get-AttachmentList($Announcement) {
    $Results = New-Object System.Collections.Generic.List[object]
    $SeenUrls = @{}
    $SeenNames = @{}
    $Generic = 0
    foreach ($Attachment in @($Announcement.attachments)) {
        if (-not $Attachment) { continue }
        $Url = [string](Get-PropertyValue $Attachment @('url', 'href'))
        if (-not $Url -or $SeenUrls.ContainsKey($Url)) { continue }
        $SeenUrls[$Url] = $true
        $Name = [string](Get-PropertyValue $Attachment @('name', 'title'))
        if (-not $Name -or $Name -eq 'Attachment') {
            $Derived = $null
            try {
                $Path = ([Uri]$Url).AbsolutePath
                $Leaf = [Uri]::UnescapeDataString(($Path -split '/')[-1])
                if ($Leaf -match '\.[A-Za-z0-9]{2,5}$') { $Derived = $Leaf }
            }
            catch { }
            if ($Derived) { $Name = $Derived }
            else { $Generic++; $Name = "Attachment $Generic" }
        }
        if ($SeenNames.ContainsKey($Name)) { continue }
        $SeenNames[$Name] = $true
        $Results.Add([PSCustomObject]@{ Name = $Name; Url = $Url })
    }
    return , $Results
}

# One announcement from the history file -> the model the feed cards and Due list are built from.
function ConvertTo-AnnouncementModel($Announcement) {
    $Id = [string](Get-PropertyValue $Announcement @('id', 'url'))
    if (-not $Id) { $Id = [guid]::NewGuid().ToString() }
    $RawTitle = Get-AnnouncementTitle $Announcement
    $SourceTitle = [string](Get-PropertyValue $Announcement @('source_title', 'title'))
    $Course = [string](Get-PropertyValue $Announcement @('course'))
    if (-not $Course) { $Course = 'Unknown course' }
    $Body = [string](Get-PropertyValue $Announcement @('body'))
    $NotExtracted = (-not $Body) -or (Test-Boilerplate $Body)
    $Clean = if ($NotExtracted) { '' } else { Get-CleanBody $Body }
    $Posted = ConvertTo-LocalDate (Get-PropertyValue $Announcement @('posted_on'))
    $SummarySource = [string](Get-PropertyValue $Announcement @('summary_source'))
    $Summary = [string](Get-PropertyValue $Announcement @('summary'))
    $RealSummary = if ($Summary -and $SummarySource -and $SummarySource -ne 'excerpt' -and -not (Test-Boilerplate $Summary)) { $Summary } else { $null }
    $Explicit = Get-ExplicitDeadlines $Announcement
    $Mentions = if ($null -ne $Explicit) { $Explicit } else { Get-DateMentions $Clean $Posted }
    $Preview = if ($NotExtracted) { "Couldn't extract the text $Dash open it in LearnUs to read it." } else { ($Clean -replace '\s+', ' ').Trim() }
    if ($Preview.Length -gt 260) { $Preview = $Preview.Substring(0, 260) }
    return [PSCustomObject]@{
        Id            = $Id
        Ann           = $Announcement
        Title         = (Join-Hangul (Get-CleanTitle $RawTitle))
        OriginalTitle = $(if ($SourceTitle -and $SourceTitle -ne $RawTitle) { $SourceTitle } else { $null })
        CourseFull    = $Course
        CourseShort   = (Get-CourseShortName $Course)
        Posted        = $Posted
        FirstSeen     = (ConvertTo-LocalDate (Get-PropertyValue $Announcement @('first_seen_at')))
        FirstCaptured = (ConvertTo-LocalDate (Get-PropertyValue $Announcement @('first_body_captured_at')))
        BodyUpdated   = (ConvertTo-LocalDate (Get-PropertyValue $Announcement @('body_updated_at')))
        Url           = [string](Get-PropertyValue $Announcement @('url'))
        Author        = [string](Get-PropertyValue $Announcement @('author'))
        Archived      = [bool](Get-PropertyValue $Announcement @('archived'))
        NotExtracted  = $NotExtracted
        Clean         = $Clean
        RealSummary   = $RealSummary
        Preview       = $Preview
        Attachments   = (Get-AttachmentList $Announcement)
        Mentions      = $Mentions
        ExplicitDates = ($null -ne $Explicit)
        Haystack      = (($RawTitle + ' ' + $Course + ' ' + $Clean) -replace '\s+', ' ').ToLowerInvariant()
    }
}

# ---------------------------------------------------------------------------
# Due items (brief tasks + dates found in recent announcements)
# ---------------------------------------------------------------------------
# Stable identity of a due item: course + title + due date. A moved deadline gets a new id and so comes back unresolved.
function Get-DueId([string]$Course, [string]$Title, [datetime]$Date) {
    return ("$Course|$($Title.Replace($WordJoiner, ''))|$($Date.ToString('yyyyMMddHHmm', $Invariant))").ToUpperInvariant()
}

# Duplicate key for brief tasks: the whole "course -- title" text plus the minute it is due. Both brief line
# shapes join to the same text even when the split between course and title landed in a different place.
function Get-DueTextKey([string]$Course, [string]$Title, [datetime]$Date) {
    $Text = (@($Course, $Title) | Where-Object { $_ }) -join " $Dash "
    $Text = ($Text.Replace($WordJoiner, '') -replace '\*\*', '' -replace '\s+', ' ').Trim().ToUpperInvariant()
    return $Text + '|' + $Date.ToString('yyyyMMddHHmm', $Invariant)
}

# BriefTasks: Get-BriefParts .Tasks. Cards: objects with a .Model (ConvertTo-AnnouncementModel); the card
# itself is kept on announcement-derived items so the viewer can open it.
function Get-DueItems($BriefTasks, $Cards, [datetime]$Now = (Get-Date)) {
    $Today = $Now.Date
    $DueItems = New-Object System.Collections.Generic.List[object]
    $ByText = @{}
    $ById = @{}
    foreach ($Entry in $BriefTasks) {
        if (-not $Entry -or -not $Entry.Task) { continue }
        $Task = $Entry.Task
        $TextKey = Get-DueTextKey $Task.Course $Task.Task $Task.Date
        $Existing = $ByText[$TextKey]
        if (-not $Existing) {
            $Id = Get-DueId $Task.Course $Task.Task $Task.Date
            $Existing = $ById[$Id]
        }
        if ($Existing) {
            if ($Entry.Status -and -not $Existing.Status) { $Existing.Status = $Entry.Status }
            if ($Task.Overdue) { $Existing.Overdue = $true }
            if ($Task.Label -and -not $Existing.Label) { $Existing.Label = $Task.Label }
            # The "Current tasks" row marks the course in bold, so its course/title split is the reliable one.
            if ($Task.CourseMarked -and -not $Existing.CourseMarked) {
                $Existing.Course = $Task.Course
                $Existing.Title = $Task.Task
                $Existing.CourseMarked = $true
                $Existing.Id = Get-DueId $Task.Course $Task.Task $Task.Date
                $ById[$Existing.Id] = $Existing
            }
            continue
        }
        $Item = [PSCustomObject]@{
            Id           = (Get-DueId $Task.Course $Task.Task $Task.Date)
            Title        = $Task.Task
            Course       = $Task.Course
            Date         = $Task.Date
            HasTime      = $true
            Status       = $Entry.Status
            Overdue      = [bool]$Task.Overdue
            Label        = $Task.Label
            CourseMarked = [bool]$Task.CourseMarked
            Source       = 'brief'
            Card         = $null
            Context      = $null
        }
        $ByText[$TextKey] = $Item
        $ById[$Item.Id] = $Item
        $DueItems.Add($Item)
    }
    $RecentCutoff = $Today.AddDays(-14)
    foreach ($Card in $Cards) {
        if (-not $Card) { continue }
        $Model = $Card.Model
        if (-not $Model) { continue }
        if (-not $Model.ExplicitDates -and (-not $Model.Posted -or $Model.Posted -lt $RecentCutoff)) { continue }
        foreach ($Mention in $Model.Mentions) {
            if (-not $Mention -or -not $Mention.IsDeadline) { continue }
            $Due = if ($Mention.HasTime) { $Mention.Date } else { $Mention.Date.Date.AddHours(23).AddMinutes(59) }
            if ($Due -lt $Now) { continue }
            $Duplicate = $false
            foreach ($Existing in $DueItems) {
                if ($Existing.Source -eq 'brief' -and $Existing.Date.Date -eq $Due.Date -and ([string]$Existing.Course).ToUpperInvariant() -eq ([string]$Model.CourseFull).ToUpperInvariant()) { $Duplicate = $true; break }
            }
            if ($Duplicate) { continue }
            # Titles like "HW#10 [Monday, October 5, 2026]" carry the posting date; drop it from the due label.
            $DueLabel = ($Model.Title -replace '\s*\[[^\]]*\b20\d\d\b[^\]]*\]', ' ' -replace '\s{2,}', ' ').Trim()
            if (-not $DueLabel) { $DueLabel = $Model.Title }
            $Id = Get-DueId $Model.CourseFull $DueLabel $Due
            if ($ById.ContainsKey($Id)) { continue }
            $Item = [PSCustomObject]@{
                Id           = $Id
                Title        = $DueLabel
                Course       = $Model.CourseFull
                Date         = $Due
                HasTime      = $Mention.HasTime
                Status       = $null
                Overdue      = $false
                Label        = $null
                CourseMarked = $true
                Source       = 'announcement'
                Card         = $Card
                Context      = $Mention.Context
            }
            $ById[$Id] = $Item
            $DueItems.Add($Item)
        }
    }
    return , $DueItems
}

# ---------------------------------------------------------------------------
# Viewer state (the caller supplies this installation's private data path)
# ---------------------------------------------------------------------------
# Stable mutex identity for concurrent writes to one viewer-state file.
function Get-InstallId([string]$Folder) {
    $Hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($Hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Folder.TrimEnd('\', '/').ToLowerInvariant())))).Replace('-', '').Substring(0, 20) }
    finally { $Hash.Dispose() }
}

function ConvertTo-StateTime($Value) {
    $Date = ConvertTo-LocalDate $Value
    if ($Date) { return $Date }
    return [datetime]::MinValue
}

function ConvertTo-StateText($Value) {
    if ($null -eq $Value) { return '' }
    if ($Value -is [datetime]) { return $Value.ToString('o', $Invariant) }
    return [string]$Value
}

function Get-StateField($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { if ($Object.Contains($Name)) { return $Object[$Name] }; return $null }
    try { $Property = $Object.PSObject.Properties[$Name]; if ($Property) { return $Property.Value } } catch { }
    return $null
}

# Merges this window's state into what is on disk, so two viewers (yesterday's still open, today's scheduled one)
# never undo each other. Mine (hashtable):
#   LastOpenedAt [datetime]; UnreadIds [string[]]; UnreadSince @{id = [datetime] the item became unread};
#   ReadActions @{id = [datetime]}; ResolveActions @{id = @{ resolved = [bool]; at = [datetime]; due = 'iso' }};
#   Theme 'dark'|'light'|$null; ThemeAt [datetime] (only when changed in this window);
#   Window @{width; height; maximized} (only when this window is closing); Restore (hashtable or $null);
#   ConsumedRestoreAt 'iso' (the restore block this window already used).
function Merge-ViewerState($Disk, [hashtable]$Mine, [datetime]$Now = (Get-Date)) {
    $Iso = { param([datetime]$Value) $Value.ToString('o', $Invariant) }

    $LastOpened = ConvertTo-StateTime (Get-StateField $Disk 'lastOpenedAt')
    if ($Mine.LastOpenedAt -and $Mine.LastOpenedAt -gt $LastOpened) { $LastOpened = $Mine.LastOpenedAt }

    # Read tombstones: latest read per id; forgotten after 60 days.
    $ReadAt = @{}
    $DiskRead = Get-StateField $Disk 'readAt'
    if ($DiskRead) {
        $Pairs = New-Object System.Collections.Generic.List[object]
        if ($DiskRead -is [System.Collections.IDictionary]) { foreach ($Key in @($DiskRead.Keys)) { $Pairs.Add(@([string]$Key, $DiskRead[$Key])) } }
        else { foreach ($Property in $DiskRead.PSObject.Properties) { $Pairs.Add(@([string]$Property.Name, $Property.Value)) } }
        foreach ($Pair in $Pairs) { $When = ConvertTo-StateTime $Pair[1]; if ($When -gt [datetime]::MinValue) { $ReadAt[$Pair[0]] = $When } }
    }
    if ($Mine.ReadActions) {
        foreach ($Key in @($Mine.ReadActions.Keys)) {
            $When = [datetime]$Mine.ReadActions[$Key]
            if (-not $ReadAt.ContainsKey($Key) -or $When -gt $ReadAt[$Key]) { $ReadAt[$Key] = $When }
        }
    }
    foreach ($Key in @($ReadAt.Keys)) { if ($ReadAt[$Key] -lt $Now.AddDays(-60)) { $ReadAt.Remove($Key) } }

    # Unread: union of both windows, minus anything read (in either window) after it became unread.
    $Unread = New-Object System.Collections.Generic.List[string]
    $SeenUnread = @{}
    foreach ($Id in @(@(Get-StateField $Disk 'unreadIds') + @($Mine.UnreadIds))) {
        if (-not $Id) { continue }
        $Id = [string]$Id
        if ($SeenUnread.ContainsKey($Id)) { continue }
        $SeenUnread[$Id] = $true
        $Since = [datetime]::MinValue
        if ($Mine.UnreadSince -and $Mine.UnreadSince.ContainsKey($Id) -and $Mine.UnreadSince[$Id]) { $Since = [datetime]$Mine.UnreadSince[$Id] }
        if ($ReadAt.ContainsKey($Id) -and $ReadAt[$Id] -ge $Since) { continue }
        $Unread.Add($Id)
    }

    # Resolved / unresolved: latest action per id wins; both kinds are forgotten after 45 days.
    $Latest = @{}
    foreach ($Entry in @(Get-StateField $Disk 'resolved')) {
        if (-not $Entry) { continue }
        if ($Entry -is [string]) { $Act = @{ id = $Entry; resolved = $true; at = [datetime]::MinValue; due = '' } }
        else { $Act = @{ id = [string](Get-StateField $Entry 'id'); resolved = $true; at = (ConvertTo-StateTime (Get-StateField $Entry 'at')); due = (ConvertTo-StateText (Get-StateField $Entry 'due')) } }
        if (-not $Act.id) { continue }
        if (-not $Latest.ContainsKey($Act.id) -or $Act.at -gt $Latest[$Act.id].at) { $Latest[$Act.id] = $Act }
    }
    foreach ($Entry in @(Get-StateField $Disk 'unresolved')) {
        if (-not $Entry) { continue }
        $Act = @{ id = [string](Get-StateField $Entry 'id'); resolved = $false; at = (ConvertTo-StateTime (Get-StateField $Entry 'at')); due = '' }
        if (-not $Act.id) { continue }
        if (-not $Latest.ContainsKey($Act.id) -or $Act.at -gt $Latest[$Act.id].at) { $Latest[$Act.id] = $Act }
    }
    if ($Mine.ResolveActions) {
        foreach ($Key in @($Mine.ResolveActions.Keys)) {
            $Action = $Mine.ResolveActions[$Key]
            $Act = @{ id = [string]$Key; resolved = [bool]$Action.resolved; at = [datetime]$Action.at; due = (ConvertTo-StateText $Action.due) }
            if (-not $Latest.ContainsKey($Act.id) -or $Act.at -ge $Latest[$Act.id].at) { $Latest[$Act.id] = $Act }
        }
    }
    $Resolved = New-Object System.Collections.Generic.List[object]
    $Unresolved = New-Object System.Collections.Generic.List[object]
    foreach ($Key in @($Latest.Keys | Sort-Object)) {
        $Act = $Latest[$Key]
        if ($Act.resolved) {
            $DueDate = ConvertTo-LocalDate $Act.due
            if ($DueDate -and $DueDate -lt $Now.AddDays(-45)) { continue }
            $Record = [ordered]@{ id = $Act.id; due = $Act.due }
            if ($Act.at -gt [datetime]::MinValue) { $Record['at'] = & $Iso $Act.at }
            $Resolved.Add($Record)
        }
        elseif ($Act.at -gt $Now.AddDays(-45)) {
            $Unresolved.Add([ordered]@{ id = $Act.id; at = (& $Iso $Act.at) })
        }
    }

    # Theme: a change made in this window wins only if it is newer than the one on disk.
    $Theme = [string](Get-StateField $Disk 'theme')
    $ThemeAt = ConvertTo-StateTime (Get-StateField $Disk 'themeAt')
    if ($Mine.ThemeAt -and [datetime]$Mine.ThemeAt -gt $ThemeAt) { $Theme = [string]$Mine.Theme; $ThemeAt = [datetime]$Mine.ThemeAt }
    if ($Theme -ne 'dark' -and $Theme -ne 'light') { $Theme = $null }

    # Window size: from the closing window, unless the file already holds a newer one.
    $Window = Get-StateField $Disk 'window'
    $WindowAt = ConvertTo-StateTime (Get-StateField $Window 'at')
    if ($Mine.Window -and $Now -ge $WindowAt) {
        $Window = [ordered]@{ width = $Mine.Window.width; height = $Mine.Window.height; maximized = [bool]$Mine.Window.maximized; at = (& $Iso $Now) }
    }

    $State = [ordered]@{
        version      = 2
        lastOpenedAt = $(if ($LastOpened -gt [datetime]::MinValue) { & $Iso $LastOpened } else { $null })
        unreadIds    = @($Unread | Select-Object -First 300)
        readAt       = [ordered]@{}
        resolved     = $Resolved.ToArray()
        unresolved   = $Unresolved.ToArray()
        theme        = $Theme
        themeAt      = $(if ($ThemeAt -gt [datetime]::MinValue) { & $Iso $ThemeAt } else { $null })
        window       = $Window
    }
    foreach ($Key in @($ReadAt.Keys | Sort-Object { $ReadAt[$_] } -Descending | Select-Object -First 3000)) { $State.readAt[$Key] = & $Iso $ReadAt[$Key] }

    # Reload hand-off: keep a fresh one on disk unless this window is the one that already used it.
    if ($Mine.Restore) { $State['restore'] = $Mine.Restore }
    else {
        $DiskRestore = Get-StateField $Disk 'restore'
        $RestoreAt = ConvertTo-LocalDate (Get-StateField $DiskRestore 'at')
        $Consumed = ConvertTo-LocalDate $Mine.ConsumedRestoreAt
        if ($RestoreAt -and ($Now - $RestoreAt).TotalSeconds -lt 180 -and -not ($Consumed -and $Consumed -eq $RestoreAt)) { $State['restore'] = $DiskRestore }
    }
    return $State
}

function Read-ViewerStateFile([string]$Path) {
    try {
        if ($Path -and (Test-Path -LiteralPath $Path)) {
            $Text = [System.IO.File]::ReadAllText($Path).TrimStart([char]0xFEFF)
            if ($Text.Trim()) { return ($Text | ConvertFrom-Json) }
        }
    }
    catch { }
    return $null
}

# Re-reads the file, merges, and swaps the result in atomically, all under a per-file mutex so two
# viewers closing together cannot interleave. Returns the merged state (or $null if it could not be written).
function Save-MergedViewerState([string]$Path, [hashtable]$Mine, [datetime]$Now = (Get-Date)) {
    $Directory = Split-Path -Parent $Path
    if ($Directory -and -not (Test-Path -LiteralPath $Directory)) { New-Item -ItemType Directory -Path $Directory -Force | Out-Null }
    $Mutex = $null
    $HasLock = $false
    try {
        $Mutex = New-Object System.Threading.Mutex($false, ('Local\LearnUsViewerState_' + (Get-InstallId $Path)))
        try { $HasLock = $Mutex.WaitOne(3000) } catch [System.Threading.AbandonedMutexException] { $HasLock = $true }
        $State = Merge-ViewerState (Read-ViewerStateFile $Path) $Mine $Now
        $Json = $State | ConvertTo-Json -Depth 6
        # Write beside the target and swap, so a crash never leaves truncated JSON.
        $TempPath = '{0}.{1}.tmp' -f $Path, $PID
        [System.IO.File]::WriteAllText($TempPath, $Json, (New-Object System.Text.UTF8Encoding $false))
        try {
            if ([System.IO.File]::Exists($Path)) { [System.IO.File]::Replace($TempPath, $Path, [NullString]::Value) }
            else { [System.IO.File]::Move($TempPath, $Path) }
        }
        finally { if ([System.IO.File]::Exists($TempPath)) { [System.IO.File]::Delete($TempPath) } }
        return $State
    }
    finally {
        if ($HasLock) { try { $Mutex.ReleaseMutex() } catch { } }
        if ($Mutex) { $Mutex.Dispose() }
    }
}
