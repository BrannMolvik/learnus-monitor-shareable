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

- No authenticated LearnUs production scan or fresh-user account test was run.
  Login/MFA behavior, current LMS markup and course coverage require account-owner
  validation. Board pages without interpretable pagination fail conservatively.
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
- Automated privacy checks do not replace source/license review. No cloud CI run
  or independent security certification is claimed.

## Publication / adoption checklist

- [x] New installations default to standalone; no LLM or Obsidian dependency.
- [x] Personal settings and generated files excluded from tracked source.
- [x] Narrow optional export permissions and stable capture identities tested.
- [x] Existing personal installation left separate; reversible migration documented.
- [ ] Validate a new student's own login, complete baseline and subsequent diff.
- [ ] Validate any selected real MCP integration in an isolated test vault.
- [ ] Test the selected Windows schedule and GUI on the intended user's PC.
- [ ] Review attribution and obtain applicable redistribution/license permission.
- [x] Owner approved a separate private GitHub repository for test sharing.
- [x] Owner subsequently approved public source visibility for an AI-class demo.
- [ ] Complete remaining validation and obtain approval before a formal release.

Until the unchecked items are resolved, describe this as a locally tested class-demo
candidate, not a fully account-validated release. Public source availability does
not mean the remaining tests or licensing review have been completed.
