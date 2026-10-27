import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { calculateDownloadBudgetMs, compactDownloadSummary, downloadBriefSection,
  replaceDownloadBriefSection, persistSuccessfulScanAndDownload, isMainModule } from '../learnus-monitor.mjs';

const stateFixture = () => ({ last_successful_check: '2026-10-08T08:00:00+09:00',
  scanner: { implementation: 'fixture' }, check_status: { all_active_courses_checked: true },
  assignments: [{ id: 1, outstanding: true }] });
const briefFixture = '# Brief\n\n## Needs attention\n\n- Keep this.\n\n## New course files\n\n- Old download copy.\n\n## Scan health\n\n- Complete.\n';
const blankReport = () => ({ newFiles: [], newLinks: [], updated: [], failed: [], skipped: [], wouldDownload: [] });
const json = async (file) => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'learnus-phase-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = stateFixture();
  return { root, state, diff: { meaningful_changes: [], completed_since_last_check: [] },
    report: 'Successful scan report.\n', brief: briefFixture, history: { announcements: [] },
    stamp: 'fixture', config: { downloads: { enabled: true } }, env: {},
    processStartedAtMs: 0, nowMs: () => 1000, ...overrides };
}

test('deadline budget reserves five minutes, accounts for elapsed process time and caps configured budget', () => {
  assert.equal(calculateDownloadBudgetMs({ processStartedAtMs: 0, nowMs: 60 * 60000 }), 25 * 60000);
  assert.equal(calculateDownloadBudgetMs({ processStartedAtMs: 0, nowMs: 80 * 60000 }), 5 * 60000);
  assert.equal(calculateDownloadBudgetMs({ processStartedAtMs: 0, nowMs: 86 * 60000 }), 0);
  assert.equal(calculateDownloadBudgetMs({ config: { downloads: { budgetMinutes: 2.5 } }, processStartedAtMs: 0, nowMs: 0 }), 150000);
  assert.equal(calculateDownloadBudgetMs({ env: { LEARNUS_RUNNER_TIMEOUT_MINUTES: '10' }, processStartedAtMs: 0, nowMs: 4 * 60000 }), 60000);
  assert.equal(calculateDownloadBudgetMs({ env: { LEARNUS_RUN_DEADLINE_MS: String(20 * 60000) }, processStartedAtMs: 0, nowMs: 10 * 60000 }), 5 * 60000);
  assert.equal(calculateDownloadBudgetMs({ config: { downloads: { budgetMinutes: 0 } }, processStartedAtMs: 0, nowMs: 0 }), 0);
});

test('compact summaries retain counts and useful item details without full reports, skipped items or error stacks', () => {
  const compact = compactDownloadSummary({ ...blankReport(), ran: true, status: 'completed',
    newFiles: [{ course: 'Course', title: 'Notes', local_path: 'notes.pdf', source_url: 'private-url', sha256: 'large', versions: [1, 2] }],
    skipped: [{ source_url: 'private-url', reason: 'Unchanged' }], failed: [{ reason: 'Failure', stack: 'large-stack' }],
    error: { reason: 'Failure', message: 'large-message', stack: 'large-stack' }, manifest: { enormous: true } });
  assert.equal(compact.counts.newFiles, 1);
  assert.equal(compact.counts.skipped, 1);
  assert.deepEqual(compact.newFiles[0], { course: 'Course', title: 'Notes', local_path: 'notes.pdf' });
  assert.deepEqual(compact.failed, [{ reason: 'Failure' }]);
  assert.deepEqual(compact.error, { reason: 'Failure' });
  assert.equal(compact.skipped, undefined);
  assert.doesNotMatch(JSON.stringify(compact), /private-url|large-stack|large-message|versions|manifest/);
});

test('successful scan artifacts are on disk before downloader starts; only download fields and brief section change afterwards', async (t) => {
  const options = await fixture(t);
  await fs.mkdir(path.join(options.root, 'logs'));
  const statusPath = path.join(options.root, 'logs/lightweight-last-run-status.json');
  await fs.writeFile(statusPath, JSON.stringify({ succeeded: false, untouched: 'keep' }));
  let scanBytes, diffBytes;
  options.downloader = async ({ deadlineMs }) => {
    assert.equal(deadlineMs, 25 * 60000);
    for (const name of ['latest-scan.json', 'latest-diff.json', 'latest-report.txt', 'latest-brief.md',
      'scan-fixture.json', 'diff-fixture.json', 'report-fixture.txt', 'daily-brief-2026-10-08.md']) {
      await fs.access(path.join(options.root, 'reports', name));
    }
    const committed = await json(path.join(options.root, 'state.json'));
    assert.equal(committed.check_status.all_active_courses_checked, true);
    assert.equal(committed.downloads.status, 'pending');
    await fs.access(path.join(options.root, 'announcement-history.json'));
    scanBytes = await fs.readFile(path.join(options.root, 'reports/latest-scan.json'), 'utf8');
    diffBytes = await fs.readFile(path.join(options.root, 'reports/latest-diff.json'), 'utf8');
    return { ...blankReport(), newFiles: [{ course: 'Course', title: 'Notes', local_path: 'notes.pdf', versions: [1] }] };
  };
  const result = await persistSuccessfulScanAndDownload(options);
  assert.equal(await fs.readFile(path.join(options.root, 'reports/latest-scan.json'), 'utf8'), scanBytes);
  assert.equal(await fs.readFile(path.join(options.root, 'reports/latest-diff.json'), 'utf8'), diffBytes);
  const saved = await json(path.join(options.root, 'state.json'));
  assert.equal(saved.downloads.counts.newFiles, 1);
  assert.equal(saved.downloads.newFiles[0].versions, undefined);
  assert.deepEqual(saved.assignments, options.state.assignments);
  assert.equal(await fs.readFile(path.join(options.root, 'reports/latest-report.txt'), 'utf8'), options.report);
  assert.equal(result.brief.split('## New course files')[0], briefFixture.split('## New course files')[0]);
  assert.equal(result.brief.split('## Scan health')[1], briefFixture.split('## Scan health')[1]);
  assert.match(result.brief, /notes\.pdf/);
  assert.deepEqual(await json(statusPath), { succeeded: false, untouched: 'keep', downloads: saved.downloads });
});

test('throwing downloader preserves successful scan and reports reason, message and stack without calling it a failed scan', async (t) => {
  const options = await fixture(t);
  let stderr = '';
  options.stderr = (value) => { stderr += value; };
  options.downloader = async () => { throw Object.assign(new Error('fixture write exploded'), { code: 'ENOSPC' }); };
  const result = await persistSuccessfulScanAndDownload(options);
  const state = await json(path.join(options.root, 'state.json'));
  assert.equal(state.check_status.all_active_courses_checked, true);
  assert.equal(state.downloads.ran, false);
  assert.deepEqual(state.downloads.error, { reason: 'Disk is full.' });
  const downloads = await json(path.join(options.root, 'reports/latest-downloads.json'));
  assert.equal(downloads.error.reason, 'Disk is full.');
  assert.equal(downloads.error.message, 'fixture write exploded');
  assert.match(downloads.error.stack, /fixture write exploded/);
  assert.match(stderr, /Disk is full\.[\s\S]*fixture write exploded[\s\S]*Error/);
  assert.match(result.brief, /^Course file download failed: Disk is full\.$/m);
  assert.doesNotMatch(result.brief, /No new files or links saved/);
  assert.equal((await fs.readdir(path.join(options.root, 'reports'))).some((name) => name.startsWith('failed-scan')), false);
});

test('abrupt child exit during downloader leaves successful scan, diff, report and pending brief committed', async (t) => {
  const options = await fixture(t);
  const childPath = path.join(options.root, 'crash-fixture.mjs');
  const moduleUrl = pathToFileURL(path.resolve('learnus-monitor.mjs')).href;
  await fs.writeFile(childPath, `import {persistSuccessfulScanAndDownload} from ${JSON.stringify(moduleUrl)};
await persistSuccessfulScanAndDownload({
  ...${JSON.stringify({ root: options.root, state: options.state, diff: options.diff, report: options.report, brief: options.brief, stamp: options.stamp, config: options.config, env: {} })},
  downloader: async () => process.exit(73)
});`);
  const child = spawn(process.execPath, [childPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 73, stderr);
  const committed = await json(path.join(options.root, 'state.json'));
  assert.equal(committed.check_status.all_active_courses_checked, true);
  assert.equal(committed.downloads.status, 'pending');
  for (const file of ['latest-scan.json', 'latest-diff.json', 'latest-report.txt', 'latest-brief.md']) await fs.access(path.join(options.root, 'reports', file));
  assert.match(await fs.readFile(path.join(options.root, 'reports/latest-brief.md'), 'utf8'), /scan results have been saved/);
});

test('no remaining time skips downloader and reports exact reason; full/disabled cases do not imply a completed download', async (t) => {
  for (const [overrides, expected] of [
    [{ nowMs: () => 86 * 60000 }, 'skipped'],
    [{ mode: 'full' }, 'full_audit'],
    [{ config: { downloads: { enabled: false } } }, 'disabled'],
    [{ config: {} }, 'disabled'],
  ]) {
    const options = await fixture(t, overrides);
    options.downloader = async () => { assert.fail('Downloader must not run'); };
    const result = await persistSuccessfulScanAndDownload(options);
    assert.equal(result.downloads.status, expected);
    assert.equal(result.downloads.ran, false);
    assert.doesNotMatch(result.brief, /No new files or links saved/);
    if (expected === 'skipped') assert.match(result.brief, /skipped: no time left/);
  }
});

test('download-declined status is retained; dry-run warning appears without updating canonical state', async (t) => {
  const options = await fixture(t, { dryRun: true });
  const original = JSON.stringify({ sentinel: 'prior canonical state' });
  await fs.writeFile(path.join(options.root, 'state.json'), original);
  options.downloader = async () => ({ ...blankReport(), ran: false, status: 'skipped', reason: 'skipped: download lock held' });
  const declined = await persistSuccessfulScanAndDownload(options);
  assert.equal(declined.downloads.ran, false);
  assert.equal(declined.downloads.status, 'skipped');
  const warning = 'Dry run does not open item pages (view.php/article.php) because opening them can mark items viewed in LearnUs; only directly known file links are listed.';
  options.downloader = async () => ({ ...blankReport(), dry_run: true, dry_run_message: warning,
    wouldDownload: [{ course: 'Course', title: 'Direct file', local_path: 'direct.pdf' }] });
  const preview = await persistSuccessfulScanAndDownload(options);
  assert.ok(preview.brief.includes(warning));
  assert.match(preview.brief, /direct\.pdf/);
  assert.equal(await fs.readFile(path.join(options.root, 'state.json'), 'utf8'), original);
});

test('download section replacement leaves surrounding brief unchanged and completed empty downloads use accurate copy', () => {
  const section = downloadBriefSection({ ran: true, status: 'completed' });
  assert.match(section, /No new files or links saved/);
  const replaced = replaceDownloadBriefSection(briefFixture, { status: 'disabled' });
  assert.equal(replaced.replace(/## New course files\n[\s\S]*?(?=## Scan health)/, ''), briefFixture.replace(/## New course files\n[\s\S]*?(?=## Scan health)/, ''));
});

test('lock acquisition failures and declined invocations use accurate copy without claiming no new files', () => {
  const failed = downloadBriefSection({ ran: false, status: 'failed', reason: 'Permission denied writing the file.', failed: [{ reason: 'Permission denied writing the file.' }] });
  assert.match(failed, /^Course file download failed: Permission denied writing the file\.$/m);
  assert.doesNotMatch(failed, /No new files or links saved/);
  const skipped = downloadBriefSection({ ran: false, status: 'skipped', reason: 'Another download run is in progress.' });
  assert.match(skipped, /Course file download skipped: Another download run is in progress\./);
  assert.doesNotMatch(skipped, /progress\.\./);
});

test('main-module detection resolves aliases and compares Windows paths without case sensitivity', async () => {
  const moduleUrl = pathToFileURL(path.resolve('learnus-monitor.mjs')).href;
  const realpath = async (value) => value === 'entry-alias' ? 'C:\\Project\\LEARNUS-MONITOR.MJS' : 'c:\\project\\learnus-monitor.mjs';
  assert.equal(await isMainModule('entry-alias', moduleUrl, { platform: 'win32', realpath }), true);
  assert.equal(await isMainModule('entry-alias', moduleUrl, { platform: 'linux', realpath }), false);
  assert.equal(await isMainModule(undefined, moduleUrl, { realpath }), false);
  assert.equal(await isMainModule('missing', moduleUrl, { realpath: async () => { throw new Error('missing'); } }), false);
  assert.equal(await isMainModule('symlink-entry', moduleUrl, { platform: 'linux', realpath: async () => '/resolved/learnus-monitor.mjs' }), true);
});
