# Reversible migration — not automatic

The existing personal installation, authentication, records, course routes, vault
scopes and Windows task have not been changed. The clean copy has no old Git history
and does not discover or import those accounts. Its default mode is standalone.

Do not run the new setup against an old installation: unversioned configuration is
rejected and preserved. Do not merge the former repository's history into this one.

An owner-controlled migration can be rehearsed as follows. No step below was run
against personal data during preparation:

1. Keep the old source commit and task configuration. Back up configuration, course
   map, state, announcement archive, manifest and relevant reports into a private,
   ignored backup directory. Do not add credentials/profiles or this backup to Git.
2. Install the clean source in a separate folder with its own private data directory.
   Run setup using the owner's own identity. Do not share/reuse a profile while the
   original scanner is running. Existing credentials and authentication remain in
   the original installation; establish the new copy's own credentials explicitly.
3. In the new data directory only, copy the owner's existing schema-3 state and
   announcement archive. They must belong to that same LearnUs account. Do not copy
   another student's records. Do not run a first scan with old state as a new user.
4. Keep old downloads in place. The manifest rejects files under an old root instead
   of restoring them there. Either keep a separately approved old download root or
   start a fresh cache; neither requires deleting existing files.
5. Set the new copy's integration mode explicitly. Re-enter exact intake/course
   mappings through setup, then approve only those note destinations. Existing
   semantic capture IDs are preserved; already-present IDs are not appended again.
   The new copy uses its own MCP policy state and never widens the original scopes.
6. Rehearse with synthetic fixtures first. Any real scan/vault verification is a
   separate owner-approved step. Compare course coverage, outstanding assignments,
   submission evidence, archive history, handoff/dedup counts and limitations.
7. Do not enable a second schedule until the owner approves the switchover. Then
   disable the old task deliberately and install the new task at the selected time.
   Keep the old folder and backup until the new workflow is verified.

Rollback: stop the new copy/task, restore the old source/configuration if needed,
and resume the original task with its existing auth/profile. Keep newer state and
reports for reconciliation; never blindly replace newer records with older state.
Never delete downloads, rewrite notes or roll back successful LMS state because an
optional handoff failed. No destructive migration command is provided.
