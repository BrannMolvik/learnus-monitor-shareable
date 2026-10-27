import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appConfig, notePath } from '../app-config.mjs';
import { validateConfig, isValidAnnouncementBody, isAnnouncementArticleUrl } from '../monitor-runtime.mjs';
import { buildCaptureBatch, loadCourseRoutes } from '../second-brain-export.mjs';
import { markdownExport, runHandoff } from '../run-handoff.mjs';
import { assertLocalTarget } from '../local-paths.mjs';
import { writeNew } from '../course-downloads.mjs';
import { diagnose } from '../doctor.mjs';
import { inspectSource } from '../scripts/check-distribution.mjs';

test('distribution gate rejects private filenames and synthetic secrets without printing matched values', () => {
  assert.equal(inspectSource('state.json.next', '{}').length, 1);
  assert.equal(inspectSource('auth/username.txt', 'fixture').length, 1);
  const fixture = 'ghp_' + 'a'.repeat(30);
  const result = inspectSource('example.mjs', fixture);
  assert.equal(result.length, 1);
  assert.equal(JSON.stringify(result).includes(fixture), false);
  assert.deepEqual(inspectSource('monitor.config.example.json', '{"student":"YOUR NAME"}'), []);
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = () => ({ schemaVersion: 1, baseUrl: 'https://ys.learnus.org/', timezone: 'Asia/Seoul', dataDirectory: 'data', authDirectory: 'auth', profileDirectory: 'browser-profile', student: { displayName: 'Example Student', authorNames: ['Example Student'], searchTerms: ['Example Student', 'Example', 'Student'] }, timeouts: { actionMs: 1000, navigationMs: 1000 } });
const scan = () => ({ last_successful_check: '2026-10-01T08:00:00+09:00', check_status: { all_active_courses_checked: true }, assignments: [{ id: 100, course: 'Example Course', course_id: 1, name: 'Example exercise', outstanding: true, completed: false, submission_status: 'No attempt' }], required_activities: [], announcements: [], course_materials: [] });
const diff = { current_successful_check: '2026-10-01T08:00:00+09:00', meaningful_changes: [], completed_since_last_check: [] };
async function temporary(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'learnus-distribution-'));
  try { await fn(dir); } finally { assert.equal(path.dirname(dir), os.tmpdir()); await fs.rm(dir, { recursive: true, force: true }); }
}

test('new configuration defaults standalone and resolves arbitrary installation/data directories', () => {
  const a = appConfig(config(), path.resolve('Install With Spaces'));
  assert.equal(a.secondBrain.mode, 'none');
  assert.equal(a.authDirectory, path.join(a.dataDirectory, 'auth'));
  assert.equal(a.notifications.enabled, true);
  const b = config(); b.dataDirectory = path.resolve('Other Data');
  assert.equal(appConfig(b, '.').dataDirectory, b.dataDirectory);
  assert.throws(() => appConfig({ ...b, schemaVersion: 2 }, '.'), /Unsupported/);
});

test('disabled handoff needs no reports, credentials, Python, uv or Obsidian', () => temporary(async dir => {
  const file = path.join(dir, 'monitor.config.json');
  await fs.writeFile(file, JSON.stringify(config()));
  assert.deepEqual(await runHandoff(file), { mode: 'none', skipped: true });
  assert.deepEqual(await fs.readdir(dir), ['monitor.config.json']);
}));

test('diagnostic detects missing credentials without opening a portal or touching a vault', () => temporary(async dir => {
  const file = path.join(dir, 'monitor.config.json'); await fs.writeFile(file, JSON.stringify(config()));
  await assert.rejects(diagnose(file), /Credentials missing/);
  const result = await diagnose(file, { skipAuth: true });
  assert.equal(result.portal_accessed, false); assert.equal(result.vault_accessed, false);
}));

test('summary flags have consistent safe defaults and reject nonlocal enabled endpoints', () => {
  const raw = config(); raw.announcementSummaries = { ollamaUrl: 'https://example.invalid/api/generate' };
  const disabled = validateConfig(raw, '.');
  assert.equal(disabled.announcementSummaries.enabled, false);
  disabled.announcementSummaries.enabled = true;
  assert.throws(() => validateConfig(disabled, '.'), /local HTTP/);
  const code = fs.readFile(new URL('../learnus-monitor.mjs', import.meta.url), 'utf8');
  return code.then(value => assert.equal((value.match(/redirect: 'error'/g) || []).length, 2));
});

test('traversal, absolute and Windows-alias course paths are rejected', () => {
  for (const value of ['Courses/../outside.md', '/outside.md', 'C:/outside.md', 'Courses\\escape.md', 'Courses/NUL.md', 'Courses/file. /x.md', 'Courses//x.md']) {
    assert.throws(() => notePath(value, true));
    assert.throws(() => loadCourseRoutes({ schema_version: 1, routes: [{ aliases: ['Example'], path: value }] }));
  }
});

test('course routing and intake changes preserve semantic capture IDs', () => {
  const before = buildCaptureBatch(scan(), diff);
  const after = buildCaptureBatch(scan(), diff, { targetPath: 'Inbox/Own.md', routes: loadCourseRoutes({ schema_version: 1, routes: [{ aliases: ['Example Course'], path: 'Courses/example.md' }] }) });
  assert.deepEqual(after.captures.map(c => c.capture_id), before.captures.map(c => c.capture_id));
  assert.equal(after.captures[0].target_path, 'Inbox/Own.md');
  assert.equal(after.captures[0].course_note_path, 'Courses/example.md');
  const { capture_id, ...record } = after.captures[0].record;
  const canonical = Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
  assert.equal(capture_id.split(':').at(-1), crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 24));
});

test('Markdown export is idempotent and conflicting existing content is preserved', () => temporary(async dir => {
  const batch = buildCaptureBatch(scan(), diff);
  assert.equal((await markdownExport(batch, dir)).added, 1);
  assert.equal((await markdownExport(batch, dir)).skipped, 1);
  const file = path.join(dir, (await fs.readdir(dir))[0]);
  await fs.writeFile(file, 'user content');
  await assert.rejects(markdownExport(batch, dir), /conflict/);
  assert.equal(await fs.readFile(file, 'utf8'), 'user content');
}));

test('Markdown handoff rejects mismatched runs and incomplete scans without changing state', () => temporary(async dir => {
  const cfg = config(); cfg.secondBrain = { mode: 'markdown', directory: 'exports' };
  const configFile = path.join(dir, 'monitor.config.json');
  const reports = path.join(dir, 'data/reports'); await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(configFile, JSON.stringify(cfg));
  const state = scan(); state.check_status.all_active_courses_checked = false;
  const original = JSON.stringify(state);
  await fs.writeFile(path.join(reports, 'latest-scan.json'), original);
  await fs.writeFile(path.join(reports, 'latest-diff.json'), JSON.stringify(diff));
  await assert.rejects(runHandoff(configFile), /successful complete/);
  assert.equal(await fs.readFile(path.join(reports, 'latest-scan.json'), 'utf8'), original);
  await fs.writeFile(path.join(reports, 'latest-scan.json'), JSON.stringify(scan()));
  await fs.writeFile(path.join(reports, 'latest-diff.json'), JSON.stringify({ ...diff, current_successful_check: 'different' }));
  await assert.rejects(runHandoff(configFile), /same successful run/);
}));

test('local writes reject parent traversal and directory junction escapes', () => temporary(async dir => {
  const approved = path.join(dir, 'approved'), outside = path.join(dir, 'outside');
  await fs.mkdir(approved); await fs.mkdir(outside);
  await assert.rejects(assertLocalTarget(path.join(outside, 'record.md'), approved), /escapes/);
  await fs.symlink(outside, path.join(approved, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writeNew(path.join(approved, 'link/record.md'), Buffer.from('fixture'), { root: approved }), /links/);
  assert.deepEqual(await fs.readdir(outside), []);
}));

test('article redirects and navigation fallback are not source content', () => {
  assert.equal(isAnnouncementArticleUrl('https://ys.learnus.org/course/view.php?id=1', 'https://ys.learnus.org/mod/ubboard/article.php?id=1&bwid=2'), false);
  assert.equal(isValidAnnouncementBody({ body: 'Your progress\nCourse Summary', body_extraction_method: 'region-main-fallback' }), false);
});

test('guided setup is idempotent, accepts a separate data path, and refuses legacy config without modifying it', { skip: process.platform !== 'win32' }, () => temporary(async dir => {
  for (const name of ['setup.ps1', 'monitor.config.example.json', 'app-config.mjs', 'monitor-runtime.mjs']) await fs.copyFile(path.join(root, name), path.join(dir, name));
  const env = { ...process.env }; for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'setup.ps1'), '-StudentName', 'Example Student', '-DataDirectory', path.join(dir, 'Other Data'), '-SkipCredentials', '-SkipDiagnostics'];
  for (let i = 0; i < 2; i++) { const result = spawnSync('powershell.exe', args, { env, encoding: 'utf8', timeout: 30000 }); assert.equal(result.status, 0, result.stdout + result.stderr); }
  const file = path.join(dir, 'monitor.config.json');
  const text = await fs.readFile(file, 'utf8');
  assert.equal(JSON.parse(text).secondBrain.mode, 'none');
  assert.equal(JSON.parse(text).dataDirectory, path.join(dir, 'Other Data'));
  await fs.writeFile(file, '{"legacy":true}');
  const bad = spawnSync('powershell.exe', args, { env, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(bad.status, 0);
  assert.equal(await fs.readFile(file, 'utf8'), '{"legacy":true}');
}));

test('runner clears credentials before optional handoff and notification code; scheduler requires consent', async () => {
  const runner = await fs.readFile(path.join(root, 'run-lightweight-monitor.ps1'), 'utf8');
  assert.ok(runner.indexOf('Remove-Item Env:\\LEARNUS_PASSWORD') < runner.indexOf("'run-handoff.mjs'"));
  assert.match(runner, /secondBrain\.mode -ne 'none'/);
  const scheduler = await fs.readFile(path.join(root, 'install-scheduled-task.ps1'), 'utf8');
  assert.ok(scheduler.indexOf('if (-not $Approve)') < scheduler.indexOf('Get-ScheduledTask'));
  assert.match(scheduler, /MultipleInstances IgnoreNew/);
  assert.match(scheduler, /StartWhenAvailable/);
});
