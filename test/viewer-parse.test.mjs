import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parser = path.join(root, 'viewer-parse.ps1');
const windows = process.platform === 'win32';
const D = ' \u2014 ';
const KO_COURSE = '\uD55C\uAD6D\uC5B4 (1)';
const KO_TITLE = '\uC219\uC81C 3';
const HEADER = '# Yonsei LearnUs Daily Brief\n\nGenerated: 2026-10-08T00:10:00.000Z\n';

function powershellFile(scriptPath) {
  // Windows PowerShell 5.1, with its own module path rather than pwsh's.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { encoding: 'utf8', timeout: 60000, env });
}

// Runs `body` (PowerShell) with the parser dot-sourced; fixtures are files in $Dir, and the body sets $Out,
// which is written as UTF-8 JSON (no Korean ever crosses the command line or the console).
async function run(body, fixtures = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer parse '));
  try {
    for (const [name, text] of Object.entries(fixtures)) await fs.writeFile(path.join(dir, name), text, 'utf8');
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$Dir = '${dir.replace(/'/g, "''")}'`,
      `. '${parser.replace(/'/g, "''")}'`,
      "$Now = [datetime]'2026-10-08 09:00'",
      "function Fmt($d) { if ($null -eq $d) { return $null }; return ([datetime]$d).ToString('yyyy-MM-dd HH:mm') }",
      "function Read-Fixture([string]$Name) { [IO.File]::ReadAllText((Join-Path $Dir $Name), [Text.Encoding]::UTF8) }",
      "function Due-Json($Items) { @($Items | ForEach-Object { [ordered]@{ Id = $_.Id; Title = $_.Title; Course = $_.Course; Date = (Fmt $_.Date); Status = $_.Status; Overdue = [bool]$_.Overdue; Label = $_.Label; Source = $_.Source } }) }",
      '$Out = $null',
      body,
      "[IO.File]::WriteAllText((Join-Path $Dir 'out.json'), (ConvertTo-Json -InputObject $Out -Depth 8), (New-Object Text.UTF8Encoding $false))",
    ].join('\r\n');
    await fs.writeFile(path.join(dir, 'run.ps1'), script, 'ascii');
    const result = powershellFile(path.join(dir, 'run.ps1'));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse((await fs.readFile(path.join(dir, 'out.json'), 'utf8')).replace(/^\uFEFF/, ''));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

const briefDue = `
$Parts = Get-BriefParts (ConvertFrom-BriefMarkdown (Read-Fixture 'brief.md')).Sections
$Items = Get-DueItems $Parts.Tasks @() $Now
$Out = [ordered]@{
  Items = (Due-Json $Items)
  Ids = @($Items | ForEach-Object { Get-DueId $_.Course $_.Title $_.Date })
  Notes = @($Parts.RailNotes | ForEach-Object { [ordered]@{ Label = $_.Label; Items = @($_.Items) } })
  Files = @($Parts.Files | ForEach-Object { [ordered]@{ Course = $_.Course; Title = $_.Title; Path = $_.Path; Name = $_.Name; IsLink = $_.IsLink } })
  FileNotes = @($Parts.FileNotes)
  TaskCount = $Parts.Tasks.Count
}`;

const asList = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

test('urgency labels are not courses, and each task shows once', { skip: !windows }, async () => {
  const brief = `${HEADER}
## Needs attention
- **OVERDUE**${D}PHYSICS (2)${D}Lab report${D}Oct 7, 23:59
  - Status: Not submitted
- **DUE TODAY**${D}KOREAN (1)${D}Homework 3${D}Oct 8, 23:59
- **DUE TOMORROW**${D}CALCULUS${D}Quiz 2${D}Oct 9, 12:00
- **DUE SOON**${D}ECON${D}Essay${D}Oct 10, 09:00
  - Status: Draft saved

## Current tasks and deadlines
- Oct 7, 23:59${D}**PHYSICS (2)**${D}Lab report
- Oct 8, 23:59${D}**KOREAN (1)**${D}Homework 3
  - Status: No attempt
- Oct 9, 12:00${D}**CALCULUS**${D}Quiz 2
- Oct 10, 09:00${D}**ECON**${D}Essay
- Oct 20, 23:59${D}**ECON**${D}Final paper
`;
  const out = await run(briefDue, { 'brief.md': brief });
  const items = asList(out.Items);
  assert.equal(items.length, 5);
  assert.ok(items.every((item) => !/^(OVERDUE|DUE )/.test(item.Course)), JSON.stringify(items));
  assert.equal(new Set(items.map((item) => item.Id)).size, 5);
  assert.deepEqual(items.map((item) => item.Id), asList(out.Ids));
  const byTitle = Object.fromEntries(items.map((item) => [item.Title, item]));
  assert.deepEqual(Object.keys(byTitle).sort(), ['Essay', 'Final paper', 'Homework 3', 'Lab report', 'Quiz 2']);
  assert.equal(byTitle['Lab report'].Course, 'PHYSICS (2)');
  assert.equal(byTitle['Lab report'].Overdue, true);
  assert.equal(byTitle['Lab report'].Status, 'Not submitted');
  assert.equal(byTitle['Homework 3'].Course, 'KOREAN (1)');
  assert.equal(byTitle['Homework 3'].Overdue, false);
  assert.equal(byTitle['Homework 3'].Label, 'DUE TODAY');
  assert.equal(byTitle['Homework 3'].Status, 'No attempt');
  assert.equal(byTitle['Homework 3'].Id, 'KOREAN (1)|HOMEWORK 3|202610082359');
  assert.equal(byTitle['Quiz 2'].Overdue, false);
  assert.equal(byTitle.Essay.Status, 'Draft saved');
  assert.equal(byTitle['Final paper'].Date, '2026-10-20 23:59');
});

test('midnight deadlines (00:00 and 24:00) and Korean titles', { skip: !windows }, async () => {
  const brief = `${HEADER}
## Needs attention
- **DUE TOMORROW**${D}CALCULUS${D}Quiz 3${D}Oct 9, 24:00
- **DUE TODAY**${D}${KO_COURSE}${D}${KO_TITLE}${D}Oct 8, 23:59

## Current tasks and deadlines
- Oct 9, 00:00${D}**CALCULUS**${D}Quiz 3
- Oct 8, 23:59${D}**${KO_COURSE}**${D}${KO_TITLE}
- Oct 12, 00:00${D}**PHYSICS (2)**${D}Problem set
`;
  const out = await run(briefDue, { 'brief.md': brief });
  const items = asList(out.Items);
  assert.equal(items.length, 3, JSON.stringify(items));
  const quiz = items.find((item) => item.Title === 'Quiz 3');
  assert.equal(quiz.Date, '2026-10-09 00:00');
  assert.equal(items.find((item) => item.Title === 'Problem set').Date, '2026-10-12 00:00');
  const korean = items.find((item) => item.Course === KO_COURSE);
  assert.ok(korean, JSON.stringify(items));
  assert.equal(korean.Title, KO_TITLE);
  assert.equal(korean.Date, '2026-10-08 23:59');
});

test('missing fields degrade gracefully', { skip: !windows }, async () => {
  const brief = `${HEADER}
## Needs attention
- **OVERDUE**${D}ECON${D}Reflection${D}No deadline shown
  - Status: Not submitted

## Current tasks and deadlines
- Oct 11, 18:00${D}**ECON**${D}Reading quiz
- Oct 13, 18:00${D}Untitled course work
`;
  const out = await run(briefDue, { 'brief.md': brief });
  const items = asList(out.Items);
  assert.equal(items.length, 2, JSON.stringify(items));
  assert.equal(items[0].Status, null);
  assert.equal(items[0].Course, 'ECON');
  assert.equal(items[1].Title, 'Untitled course work');
  assert.equal(items[1].Course, '');
  const notes = asList(out.Notes).flatMap((note) => asList(note.Items));
  assert.ok(notes.some((text) => text.includes('Reflection') && text.startsWith('OVERDUE')), JSON.stringify(notes));

  const empty = await run(`
$Parts = Get-BriefParts (ConvertFrom-BriefMarkdown '').Sections
$Missing = Read-AnnouncementHistory (Join-Path $Dir 'nope.json')
$Damaged = Read-AnnouncementHistory (Join-Path $Dir 'damaged.json')
$Bare = ConvertTo-AnnouncementModel ([pscustomobject]@{ id = 'x' })
$Out = [ordered]@{ Tasks = $Parts.Tasks.Count; MissingCount = @($Missing.Announcements).Count; MissingError = $Missing.Error
  DamagedError = $Damaged.Error; BareCourse = $Bare.CourseFull; BareTitle = $Bare.Title; BareDue = (Get-DueItems @() @([pscustomobject]@{ Model = $Bare }) $Now).Count }`, { 'damaged.json': '{not json' });
  assert.equal(empty.Tasks, 0);
  assert.equal(empty.MissingCount, 0);
  assert.equal(empty.MissingError, null);
  assert.ok(empty.DamagedError && empty.DamagedError.length > 0);
  assert.equal(empty.BareCourse, 'Unknown course');
  assert.equal(empty.BareTitle, 'Untitled announcement');
  assert.equal(empty.BareDue, 0);
});

test('deadlines found in announcements, deduplicated against the brief', { skip: !windows }, async () => {
  const posted = '2026-10-06T10:00:00+09:00';
  const history = {
    announcements: [
      { id: 'r1', course: 'PHYSICS (2)', title: 'Report', posted_on: posted, first_seen_at: posted, body: 'Please submit the report by October 12, 11:59 PM.' },
      { id: 'p1', course: 'CALCULUS', title: 'Project', posted_on: posted, first_seen_at: posted, body: 'See the project page.', deadlines: [{ due_at: '2026-10-15T18:00:00+09:00', title: 'Project' }] },
      { id: 'e1', course: 'ECON', title: 'Essay reminder', posted_on: posted, first_seen_at: posted, body: 'The essay is due October 10 at 9 AM.' },
      { id: 'k1', course: KO_COURSE, title: KO_TITLE, posted_on: posted, first_seen_at: posted, body: '\uACFC\uC81C \uB9C8\uAC10: 10\uC6D4 14\uC77C' },
    ],
  };
  const brief = `${HEADER}
## Current tasks and deadlines
- Oct 10, 09:00${D}**ECON**${D}Essay
`;
  const out = await run(`
$Parts = Get-BriefParts (ConvertFrom-BriefMarkdown (Read-Fixture 'brief.md')).Sections
$History = Read-AnnouncementHistory (Join-Path $Dir 'history.json')
$Cards = @($History.Announcements | ForEach-Object { [pscustomobject]@{ Model = (ConvertTo-AnnouncementModel $_) } })
$Out = [ordered]@{ Items = (Due-Json (Get-DueItems $Parts.Tasks $Cards $Now)); Error = $History.Error }`, { 'brief.md': brief, 'history.json': JSON.stringify(history) });
  assert.equal(out.Error, null);
  const items = asList(out.Items);
  const fromAnnouncements = items.filter((item) => item.Source === 'announcement');
  const report = fromAnnouncements.find((item) => item.Course === 'PHYSICS (2)');
  assert.equal(report.Date, '2026-10-12 23:59');
  assert.equal(report.Title, 'Report');
  const project = fromAnnouncements.find((item) => item.Course === 'CALCULUS');
  const expected = new Date('2026-10-15T18:00:00+09:00');
  const pad = (n) => String(n).padStart(2, '0');
  assert.equal(project.Date, `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())} ${pad(expected.getHours())}:${pad(expected.getMinutes())}`);
  assert.equal(items.filter((item) => item.Course === 'ECON').length, 1, JSON.stringify(items));
  assert.equal(items.find((item) => item.Course === 'ECON').Source, 'brief');
  const korean = fromAnnouncements.find((item) => item.Course === KO_COURSE);
  assert.ok(korean, JSON.stringify(items));
  assert.equal(korean.Date.slice(0, 10), '2026-10-14');
  assert.equal(korean.Title.replace(/\u2060/g, ''), KO_TITLE); // the viewer keeps Hangul words together with U+2060
});

test('New course files become file rows, not a raw note', { skip: !windows }, async () => {
  const brief = `${HEADER}
## New course files

- **ECON**${D}Week 6 slides${D}C:\\Users\\x\\LearnUs\\ECON\\Week 6\\slides.pdf
- **ECON**${D}Reading${D}list${D}C:\\Users\\x\\LearnUs\\ECON\\General\\Reading list.url
- Download failures: 2. See reports/latest-downloads.json.

## Completed since last check
- None.
`;
  const out = await run(briefDue, { 'brief.md': brief });
  assert.deepEqual(asList(out.Files), [
    { Course: 'ECON', Title: 'Week 6 slides', Path: 'C:\\Users\\x\\LearnUs\\ECON\\Week 6\\slides.pdf', Name: 'slides.pdf', IsLink: false },
    { Course: 'ECON', Title: 'Reading \u2014 list', Path: 'C:\\Users\\x\\LearnUs\\ECON\\General\\Reading list.url', Name: 'Reading list.url', IsLink: true },
  ]);
  assert.deepEqual(asList(out.FileNotes), ['Download failures: 2. See reports/latest-downloads.json.']);
  assert.ok(!asList(out.Notes).some((note) => /files/i.test(note.Label)));
  assert.equal(out.TaskCount, 0);
});

test('two viewer windows merge resolved, read and theme state', { skip: !windows }, async () => {
  const out = await run(`
$Path = Join-Path $Dir 'viewer-state.json'
$T0 = [datetime]'2026-10-08 08:00'; $T1 = [datetime]'2026-10-08 09:00'; $T2 = [datetime]'2026-10-08 10:00'
$Due = '2026-10-09T23:59:00'
function Snap { $S = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  [ordered]@{ resolved = @($S.resolved | ForEach-Object { $_.id }); unresolved = @($S.unresolved | ForEach-Object { $_.id }); unread = @($S.unreadIds); theme = $S.theme; lastOpenedAt = (Fmt $S.lastOpenedAt); version = $S.version } }
# A (newer window) resolves X, reads ann1, switches to dark.
$null = Save-MergedViewerState $Path @{ LastOpenedAt = $T1; UnreadIds = @(); ReadActions = @{ ann1 = $T1 }; ResolveActions = @{ X = @{ resolved = $true; at = $T1; due = $Due } }; Theme = 'dark'; ThemeAt = $T1 } $T1
$AfterA = Snap
# B (older window, opened before A) closes later: it still shows ann1 unread and knows nothing about X.
$null = Save-MergedViewerState $Path @{ LastOpenedAt = $T0; UnreadIds = @('ann1', 'ann2'); ReadActions = @{}; ResolveActions = @{}; Theme = 'light'; Window = @{ width = 900; height = 700; maximized = $false } } $T2
$AfterB = Snap
# B unresolves X later than A resolved it; A saving again afterwards must not bring it back.
$null = Save-MergedViewerState $Path @{ LastOpenedAt = $T0; UnreadIds = @(); ResolveActions = @{ X = @{ resolved = $false; at = $T2; due = $Due } } } $T2
$null = Save-MergedViewerState $Path @{ LastOpenedAt = $T1; UnreadIds = @(); ResolveActions = @{} } $T2
$AfterUnresolve = Snap
# Version 1 file (one shared, last-writer-wins file) is read and upgraded.
$V1 = Join-Path $Dir 'v1.json'
[IO.File]::WriteAllText($V1, '{"version":1,"resolved":["OLD|ID|1",{"id":"OLD|ID|2","due":"2026-10-20T23:59:00"}],"unreadIds":["u1"],"theme":"light"}')
$null = Save-MergedViewerState $V1 @{ UnreadIds = @() } $T2
$Path = $V1; $V1State = Snap
$Out = [ordered]@{ A = $AfterA; B = $AfterB; U = $AfterUnresolve; V1 = $V1State }`);
  assert.deepEqual(asList(out.A.resolved), ['X']);
  assert.equal(out.A.theme, 'dark');
  assert.deepEqual(asList(out.B.resolved), ['X']);
  assert.deepEqual(asList(out.B.unread), ['ann2']);
  assert.equal(out.B.theme, 'dark');
  assert.equal(out.B.lastOpenedAt, '2026-10-08 09:00');
  assert.deepEqual(asList(out.U.resolved), []);
  assert.deepEqual(asList(out.U.unresolved), ['X']);
  assert.deepEqual(asList(out.V1.resolved), ['OLD|ID|1', 'OLD|ID|2']);
  assert.deepEqual(asList(out.V1.unread), ['u1']);
  assert.equal(out.V1.theme, 'light');
  assert.equal(out.V1.version, 2);
});

test('viewer state mutex identity is deterministic', { skip: !windows }, async () => {
  const out = await run("$Out = [ordered]@{ Id = (Get-InstallId 'C:\\Some\\Folder') }");
  const expected = crypto.createHash('sha256').update('c:\\some\\folder', 'utf8').digest('hex').slice(0, 20).toUpperCase();
  assert.equal(out.Id, expected);
});
