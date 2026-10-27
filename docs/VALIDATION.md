# Validation and distribution readiness

Prepared locally on 2026-10-27. This is a source-only candidate, not a published
release or a replacement for the existing personal installation.

## Verified locally

- 151 Node tests passed with no failures or skips on Windows. Coverage includes
  baseline comparison, preserved state after failed retrieval, session loss,
  announcement identity/body validation, every board results page plus configured
  name searches, exact author/group confirmation, notifications and viewer parsing.
- Nine Python tests passed against isolated temporary mock vaults: explicit setup
  approval, exact scopes, no-overwrite creation, append-only capture routing,
  deduplication/backfill, invalid routes, missing notes and stale-proposal retry.
- All root PowerShell scripts passed Windows PowerShell syntax parsing.
- `npm ci --ignore-scripts` installed the pinned dependency successfully; npm
  reported no known advisories at the time of installation. This is not a complete
  dependency security audit.
- Setup was exercised with a synthetic student, separate storage and no credentials.
  Repeated setup preserves configuration; unsupported old configuration is refused
  without replacement. Disabled handoff touches no vault or MCP project.
- A subsequent fresh GitHub clone exercised the actual guided setup script with
  synthetic prompt answers, including its credential-storage branch. CurrentUser
  DPAPI encryption/decryption, owner-only protected auth-folder ACLs, custom storage,
  standalone diagnostics, unchanged credentials/configuration on repeat setup, and
  preservation after an empty-login update were verified. No real credentials,
  LearnUs requests, browser profile, vault or scheduled task were used. This tests
  setup, not whether Yonsei accepts a real account's login or current MFA flow.
- All 151 Node and nine Python tests passed again on that GitHub checkout.
- A fresh export of the staged source was tested in an isolated temporary folder,
  without inherited dependencies, credentials or runtime records. The diagnostic
  correctly rejected the missing dependency; after `npm ci --ignore-scripts`, its
  standalone diagnostic and all 151 Node / nine Python tests passed again. The
  diagnostic explicitly reported no portal or vault access.
- Markdown export is idempotent, preserves conflicting files and refuses directory
  traversal and junction escapes. Download-manifest paths outside the selected
  cache are rejected; mandatory executable/script blocks cannot be disabled.

## Repeatable offline browser smoke test

Run `npm run test:sandbox` after `npm ci --ignore-scripts` on Windows with Chrome.
The initial run completed in 46 seconds, passing all six scenarios: baseline,
unchanged repeat, changed-data dry run, committed changes, failed course retrieval
and rejected synthetic login. The actual setup, runner, scanner, browser DOM
extraction, state/diff/report generation and notification generation are exercised.
The viewer parser is checked; the GUI is not opened. Both individual submissions
are found on page four; confirmed group evidence retains no-individual-flag metadata.

The test uses temporary configuration, dummy DPAPI credentials and a new browser
profile. Browser navigation is fulfilled by synthetic fixtures before networking;
unmatched page requests and download API GETs are blocked. Downloading is disabled.
Real LearnUs, real credentials, Second Brain and scheduled tasks are not accessed.
This is isolation within the current Windows user, not a fresh Windows VM. Passing
does not establish that actual Yonsei authentication or current course HTML works.

## Authorized live follow-up (2026-10-28)

The owner explicitly authorized testing with the existing locally protected
credentials. A separate ignored private installation reused the configured Chrome
profile and local runner; automatic SSO and a complete followed-course retrieval
were verified. Canonical baseline and reports were saved only in that private test
directory, not in this public source repository. The original personal state,
announcement history, configuration and Windows task were verified unchanged.
An immediate repeat retrieval produced zero meaningful changes and zero new
completions; the initial private baseline did not classify existing items as new.

The live trial identified and regression-tested delayed login/dashboard rendering,
explicitly empty boards without page totals, and dated Zoom links that are not new
assignments. Existing tracked assignments remain preserved. Unknown board pagination
still fails conservatively. An inaccessible announcement body remains explicitly
reported; the scanner does not bypass access controls or archive navigation as text.

Downloads, AI processing, notifications and Second Brain handoff were disabled for
the live test. No real account details, submission evidence, logs, state or course
content are included in this repository. This verifies one existing owner account,
not a new student's first-time login, MFA or a full personal-installation migration.

## Privacy boundary

Only selected application source, synthetic fixtures and generic documentation were
copied. No old `.git` directory or history, personal configuration, course map,
credentials, Chrome profile, state, announcement archive, logs, downloaded course
files or real student submission evidence belongs in this source repository.

`node scripts/check-distribution.mjs` checks tracked filenames and source for common
credential patterns and personal Windows paths without printing matched values.
It is a heuristic gate, not proof that no sensitive information can exist. Review
the source and all future staged changes as well. Build an eventual source archive
from Git, never by zipping an installation's working directory.

The final 41-file source snapshot passed that gate with zero findings. A separate
search found none of the original owner's names or the known private submission
identifiers used by the old fixtures. This does not make the heuristic exhaustive.

The original repository's historical personal data is not removed or remediated by
this copy. Keep that repository private. Its separate audit remains the source for
owner-specific findings; never merge its old history into the clean repository.

## Not verified / known limits

- The authorized owner-account test above passed, but a new student's first-time
  login/MFA and course coverage still require that student's validation. Board
  pages without interpretable pagination or explicit empty evidence fail safely.
- No real Obsidian vault or actual MCP append was used. Python tests mock MCP calls;
  a real compatible MCP/CLI installation still needs its own isolated-vault test.
- No scheduled task was created, removed, triggered or rescheduled, and the new
  viewer GUI was not interactively inspected. Parser tests are not GUI validation.
- Migration of real private state, download history or live note routes was not
  performed. Follow MIGRATION.md and approve an explicit switchover separately.
- Windows 11 is the intended environment. DPAPI is tied to the Windows identity;
  credentials and profiles are not portable distribution artifacts. A powered-off
  PC cannot scan until Windows and its logged-in user are available.
- Course downloads and announcement text are untrusted external content. Download
  marking is best-effort; documents may contain malicious macros. Path checks do
  not defend against every concurrent hostile local filesystem change.
- Automated privacy checks and hosted Windows CI do not replace source/license
  review or constitute independent security certification.

## Layout cleanup validation (2026-10-28)

Internal runtime modules and viewer parsing now live in `src/`; detailed notes
live in `docs/`. Setup, daily/full runners and the viewer launcher remain at the
repository root. Private configuration/data paths and scheduled entry points are
unchanged. The root contains 14 tracked files, down from 29.

Local checks passed: 155 Node tests, nine Python mock-vault tests, Windows
PowerShell syntax checks for root/source/test-helper scripts, and the source
privacy gate (44 tracked files, no findings). All six no-account browser scenarios
passed in 73 seconds using the reorganized setup and runner.

This layout test did not access a real LearnUs account, download real course
files, display the viewer GUI, alter a Scheduled Task or access a real vault.

## Publication / adoption checklist

- [x] New installations default to standalone; no LLM or Obsidian dependency.
- [x] Personal settings and generated files excluded from tracked source.
- [x] Narrow optional export permissions and stable capture identities tested.
- [x] Existing personal installation left separate; reversible migration documented.
- [x] Explicitly authorized owner-account live retrieval in separate private storage.
- [ ] Validate a new student's own login, complete baseline and subsequent diff.
- [ ] Validate any selected real MCP integration in an isolated test vault.
- [ ] Test the selected Windows schedule and GUI on the intended user's PC.
- [ ] Review attribution and obtain applicable redistribution/license permission.
- [x] Owner approved a separate private GitHub repository for test sharing.
- [x] Owner subsequently approved public source visibility for an AI-class demo.
- [ ] Complete remaining validation and obtain approval before a formal release.

Tested with the developer's account; independent student setup testing is still
pending. Until the unchecked items are resolved, this remains a class-demo/testing
candidate. Public source availability does not mean the remaining tests or
licensing review have been completed.
