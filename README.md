# LearnUs Monitor

A personal Windows monitor for Yonsei LearnUs. It automatically logs in with your
own account, checks courses and submission states, tracks deadlines and notices,
archives announcements, saves course files and shows a daily brief. It is not an
official Yonsei service and never submits work or marks activities complete.

This clean repository is intended for an AI-class demonstration and independent
student setup. Show source code and synthetic test results in class, not private
course records, credentials, browser sessions or downloaded teaching materials.

Normal monitoring is deterministic. Codex, Claude, an API key, Ollama and Obsidian
are **not required**. An assistant can launch the same runner if you want one.

## Repository layout

- `setup.ps1`, `run-lightweight-monitor.ps1`, `show-daily-brief.ps1`: setup, scan and open the app.
- `src/`: scanner, downloads, viewer helpers and optional integrations.
- `scripts/`: development and sandbox checks.
- `test/`: automated regression tests.
- `docs/`: validation, migration and source-provenance notes.

Private settings remain in ignored `monitor.config.json`; runtime records stay in
the configured data directory. Moving source files does not move your private data.

## First installation (Windows 11)

### Try it without a LearnUs account

With Windows, Google Chrome, Node.js 20+ and Git installed, clone this repository
and run these commands from its folder:

```powershell
npm ci --ignore-scripts
npm run test:sandbox
```

No setup or real credentials are required for this test. It runs the actual setup
and PowerShell runner with a synthetic student, temporary encrypted credentials and
a temporary Chrome profile. A test-only browser hook supplies every LMS/SSO page
from fixtures and blocks unmatched page requests. It checks a two-course baseline,
page-four board submissions, group evidence, notices/materials, notification data,
unchanged and changed scans, dry-run state protection, and failure-state retention.

Results and a sample brief/diff are written to ignored `artifacts/sandbox/`.
Successful temporary account/profile data is removed; failed tests retain their
temporary synthetic files for diagnosis. This is not a Windows VM or separate OS
user. Node/Chrome are still local installations; the test does not validate real
Yonsei login/MFA, actual course markup, file downloads, scheduled execution or the
viewer GUI. No real LearnUs request, scheduled task, vault write or LLM is needed.
The test uses the shipping navigation timeouts and includes a slow synthetic login;
allow roughly two minutes, including the intentionally rejected-login timeout.

### Set up your own real account

Install Google Chrome, Node.js 20+ (22 recommended), and Git. Windows PowerShell
5.1 is supported. Tested with the developer's account; independent student setup
testing is still pending. Clone the clean source:

```powershell
git clone https://github.com/BrannMolvik/learnus-monitor-shareable.git
cd learnus-monitor-shareable
```

In the extracted/cloned source folder:

```powershell
npm ci --ignore-scripts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

The setup asks for your own full LearnUs writer name, private data directory and
credentials. Supply the full writer name exactly as LearnUs displays it. Broad
name searches do not prove completion: matches require an exact author name or an
explicitly confirmed course/group alias. Add alternate full author names or group
aliases only after verifying them. Account names/passwords must never be pasted
into chat, GitHub issues, task arguments or source files.

Setup stores the password with Windows CurrentUser DPAPI and restricts the auth
folder's NTFS ACL to your Windows user. It preserves existing settings on repeat
runs. Use `setup.ps1 -UpdateCredentials` only when you intend to replace credentials.
No developer account, Chrome session or vault access comes with cloning the source.

Setup performs a local diagnostic and offers an explicitly approved baseline and
daily schedule. It does not install a task automatically. A first real scan needs
your own account. A controlled owner-account live check has passed; that does not
guarantee every student's login/MFA flow. See [validation notes](docs/VALIDATION.md) for exact coverage.

## Daily use

```powershell
.\run-lightweight-monitor.ps1
.\run-lightweight-monitor.ps1 -NoPopup
.\run-full-audit.ps1
.\show-daily-brief.ps1
node .\src\doctor.mjs
```

`doctor` checks local configuration/dependencies/credential-file presence, not
credential validity or portal availability. It does not open LearnUs or your vault.
`-DryRun` scans without committing canonical state; announcement inspection can
still mark articles read. It is not an offline test. Full audit stays separate
from daily downloading. A failed scan retains the previous successful state.

The first successful scan establishes a baseline. Subsequent reports show meaningful
changes and current outstanding tasks; overdue work does not disappear automatically.
Every board pagination page and configured name search must be checked before a
submission is declared missing. Group-only evidence remains explicitly distinguished
from an LMS individual completion flag. Inaccessible announcement bodies are reported,
not replaced with course navigation. Local viewer dismissal does not submit work.

## Optional export modes

Run `setup.ps1 -ConfigureIntegration` to choose:

| Mode | What it does | Additional requirements |
| --- | --- | --- |
| `none` (default) | Monitor, history, downloads, viewer and notifications only | None |
| `markdown` | One provenance record per capture in an explicitly approved folder | None |
| `obsidian` | Intake first, then explicitly mapped course notes through MCP | Your own compatible obsidian-mcp project, uv, Python, Obsidian/CLI |

Markdown files have stable capture IDs, are deduplicated and never overwrite
conflicting files. Directory escapes and reparse links are refused. Existing
captures do not become new merely because another day passed or a route changed.

Obsidian setup requests explicit project/vault paths, the intake note, course-note
mappings and approval of the exact note allowlist. Existing notes are append-only.
Missing notes are created only during explicit setup if you opt in to no-overwrite
creation. Automatic runs never create missing notes or widen permissions.
Permissions live in this installation's private MCP policy directory; the program
does not change the global MCP vault or other installations' scopes.

The runner clears LearnUs credentials before optional handoff/UI processes start.
Obsidian failures are reported separately and do not invalidate a successful scan.
Already ingested intake captures can replay to newly approved course routes without
duplicates. An unconfigured course remains intake-only. Do not place the monitor's
data/download directories inside a vault; doctor rejects this configuration.

## Schedule, change time, or remove

After a successful baseline, with Windows set to Seoul (`Korea Standard Time`):

```powershell
.\install-scheduled-task.ps1 -Time '08:00' -Approve
.\install-scheduled-task.ps1 -Time '09:30' -Approve
.\install-scheduled-task.ps1 -Remove -Approve
```

The default task is `LearnUs Monitor Daily`, distinct from other installations.
Use a unique `-TaskName` for an additional installation. Ownership checks prevent
replacing/removing a task pointing elsewhere. Tasks use the normal logged-in user,
start after a missed time when possible, and ignore overlapping runs. A powered-off
PC cannot scan: catch-up happens when Windows and the logged-in user are available.
No task or credential arguments contain the LearnUs password. Removal retains data.

## Data and privacy

All personal settings live in ignored `monitor.config.json`. `dataDirectory` and
`authDirectory` accept relative or absolute paths. Defaults are private runtime
folders beneath this copy's `data/`:

- `auth/`: login ID and DPAPI ciphertext (no account credentials in Git).
- `browser-profile/`: your persistent Chrome authentication; never share it.
- `state.json`, `announcement-history.json`: comparisons and original article text.
- `reports/`, `logs/`: dated JSON diff/scan, text report and daily brief/error status.
- `downloads/`, `downloads-manifest.json`: local files, versions, checksums and links.
- `exports/`: optional local Markdown captures; `obsidian-policy/`: optional MCP scopes.

The supplied ignore rules exclude runtime/temp/profile data, but ignore rules are
not encryption and cannot protect a personal folder you deliberately add with force.
Use a fresh source clone or `git archive`, not a ZIP of your working directory.
Never include configuration, account/session data, state, downloads, logs or vault
notes in a distribution. Do not select a cloud-synced folder unless you intend the
operating system to sync these private records off-device.

No telemetry or cloud model calls are introduced. Optional summaries/translations
are disabled by default; explicit local Ollama processing must use a loopback HTTP
endpoint, has a maximum 60-second timeout and refuses redirects. Original article
text remains archived even if a summary fails. LearnUs read/unread flags are not
the monitor's source of truth for new/seen history.

Downloads are GET-only, instructor-confirmed, bounded and version-preserving.
Executable/script attachment types cannot be enabled by an empty denylist; custom
entries only extend the mandatory blocks. Windows download-origin marking is
best-effort on supported filesystems. Documents can still be malicious (including
macros): never treat downloaded course content as trusted code. External links are
saved as HTTP(S) shortcuts, not fetched by the downloader.

## Troubleshooting, updates and uninstall

- Missing Node/Chrome/dependency: install it and run `npm ci`, then `doctor` again.
- Missing credentials or DPAPI error after moving PCs/users: run setup under the
  intended Windows user. DPAPI ciphertext is not portable to another identity.
- Authentication fails: inspect the private log, stop repeated retries and check
  your own portal account/MFA. Do not bypass school access controls.
- Scan failed: the previous successful state stays intact; check dated errors.
- Handoff failed: monitoring can still succeed. Check selected paths, MCP/uv
  availability and exact permissions; choose `none` to disable the optional layer.
- Busy profile: do not run multiple scanners against one profile/data directory.
- Update: back up private configuration/data, stop your own scan, update reviewed
  source and run `npm ci`. Do not copy another student's configuration. Unsupported
  configuration versions are rejected rather than silently migrated.
- Uninstall: remove the owned task, back up data, then remove your own source/data
  through Explorer. Never delete another installation's profile or a vault.

See [migration notes](docs/MIGRATION.md) before moving an existing personal installation and
[validation notes](docs/VALIDATION.md) for tests, remaining limits and publication gates.
