import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJson, emptyState, validateConfig, isStudentAuthor, baselineComparison, courseNameFromRaw,
  resolveDocumentsDirectory, resolveDownloadRoot, waitForLearnUsLanding } from '../monitor-runtime.mjs';

test('landing readiness waits for visible course or login controls within the configured timeout', async () => {
  const calls = [];
  const locator = { or: other => { assert.equal(other, 'portal'); return locator; }, filter: options => { assert.equal(options.visible, true); return locator; }, first: () => locator,
    waitFor: async options => { calls.push(options); await Promise.resolve(); } };
  await waitForLearnUsLanding({ locator: selector => { assert.match(selector, /course-link/); return locator; }, getByText: (text, options) => { assert.equal(text, 'Portal Login'); assert.equal(options.exact, true); return 'portal'; } }, 30000);
  assert.deepEqual(calls, [{ state: 'visible', timeout: 30000 }]);
});

const config = () => ({
  baseUrl: 'https://ys.learnus.org/', timezone: 'Asia/Seoul', profileDirectory: 'browser-profile',
  student: { displayName: 'Jane Student', authorNames: ['JANE STUDENT'], searchTerms: ['Jane Student', 'Jane', 'Student'], groupAliases: [] },
  timeouts: { actionMs: 15000, navigationMs: 60000 },
  translation: { enabled: false }, announcementSummaries: { enabled: false },
});
test('fresh dashboard names strip spaced category labels without stripping NEW from course names', () => {
  assert.equal(courseNameFromRaw('Regular Univ NEW MEDIA AND DIGITAL STORYTELLING My Rate 10%'), 'NEW MEDIA AND DIGITAL STORYTELLING');
  assert.equal(courseNameFromRaw('RegularGrad KOREAN (1) My Rate 40%'), 'KOREAN (1)');
  assert.equal(courseNameFromRaw('Regular Grad EXAMPLE COURSE'), 'EXAMPLE COURSE');
  assert.equal(courseNameFromRaw('changed dashboard title', { name: 'saved course name' }), 'saved course name');
});
test('fresh install has an empty comparison state', () => {
  assert.equal(emptyState().last_successful_check, null);
  assert.deepEqual(emptyState().assignments, []);
});
test('initial baseline does not call existing content new or completed since last check', () => {
  assert.deepEqual(baselineComparison(emptyState(), { changes: ['assignment'], completed: ['done'] }, ['notice'], ['file']),
    { meaningful: [], completed: [], baselineEstablished: true });
});
test('later successful checks retain meaningful changes and completions', () => {
  assert.deepEqual(baselineComparison({ last_successful_check: '2026-10-08' }, { changes: ['assignment'], completed: ['done'] }, ['notice'], ['file']),
    { meaningful: ['assignment', 'notice', 'file'], completed: ['done'], baselineEstablished: false });
});
test('author confirmation requires full exact configured name, not partial names', () => {
  const student = config().student;
  assert.ok(isStudentAuthor('Jane Student', student));
  assert.ok(isStudentAuthor('JANE   STUDENT', student));
  assert.equal(isStudentAuthor('Jane Other Student', student), false);
  assert.equal(isStudentAuthor('Jane', student), false);
});
test('config is portable and group identities must be course-scoped', () => {
  assert.equal(validateConfig(config(), path.resolve('fixture')).profileDirectory, path.resolve('fixture', 'browser-profile'));
  const invalid = config(); invalid.student.groupAliases = ['TEAM 2'];
  assert.throws(() => validateConfig(invalid, '.'), /course and title/);
});
test('placeholder student and remote model endpoints are rejected', () => {
  const placeholder = config(); placeholder.student.displayName = 'YOUR NAME';
  assert.throws(() => validateConfig(placeholder, '.'), /setup/);
  const remote = config(); remote.translation = { enabled: true, ollamaUrl: 'https://example.com', timeoutMs: 15000 };
  assert.throws(() => validateConfig(remote, '.'), /local HTTP/);
});

test('optional instructor author configuration requires course-scoped nonempty names', () => {
  const valid = config();
  valid.downloads = { instructorAuthors: { '123': ['Professor Kim', '김교수'] } };
  assert.deepEqual(validateConfig(valid, '.').downloads.instructorAuthors, { '123': ['Professor Kim', '김교수'] });
  for (const mapping of [null, [], 'Professor Kim', { '0': ['Professor Kim'] }, { '-1': ['Professor Kim'] },
    { 'course': ['Professor Kim'] }, { '123': [] }, { '123': [''] }, { '123': ['   '] }, { '123': [42] }, { '123': 'Professor Kim' }]) {
    const invalid = config();
    invalid.downloads = { instructorAuthors: mapping };
    assert.throws(() => validateConfig(invalid, '.'), /instructorAuthors/);
  }
  assert.equal(validateConfig(config(), '.').downloads.instructorAuthors, undefined);
});
test('missing state is allowed, malformed state fails without replacing its bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'learnus-state-test-'));
  const target = path.join(root, 'state.json');
  try {
    assert.deepEqual(await readJson(target, emptyState()), emptyState());
    await fs.writeFile(target, '{broken');
    await assert.rejects(readJson(target, emptyState()), SyntaxError);
    assert.equal(await fs.readFile(target, 'utf8'), '{broken');
    await fs.writeFile(target, '\uFEFF{"schema_version":3}');
    assert.deepEqual(await readJson(target), { schema_version: 3 });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('includeQnA must be a boolean when configured', () => {
  const valid = config();
  valid.downloads = { includeQnA: true };
  assert.equal(validateConfig(valid, '.').downloads.includeQnA, true);
  const invalid = config();
  invalid.downloads = { includeQnA: 'yes' };
  assert.throws(() => validateConfig(invalid, '.'), /includeQnA/);
});

test('missing downloads stay disabled while explicit example opt-in remains enabled', async () => {
  assert.equal(validateConfig(config(), '.').downloads.enabled, false);
  const example = await readJson(new URL('../monitor.config.example.json', import.meta.url));
  example.student = config().student;
  assert.equal(validateConfig(example, '.').downloads.enabled, true);
});

test('Documents registry lookup expands environment variables without case sensitivity', async () => {
  const calls = [];
  const documents = await resolveDocumentsDirectory({ platform: 'win32', homedir: 'C:\\Users\\Fixture',
    env: { OneDrive: 'D:\\OneDrive Fixture' }, execFile: async (...args) => {
      calls.push(args);
      return { stdout: '\r\n    Personal    REG_EXPAND_SZ    %ONEDRIVE%\\Documents\r\n' };
    } });
  assert.equal(documents, 'D:\\OneDrive Fixture\\Documents');
  assert.equal(calls[0][0], 'reg.exe');
  assert.deepEqual(calls[0][1], ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Personal']);
  assert.equal(calls[0][2].timeout, 2000);
  assert.equal(calls[0][2].windowsHide, true);
});

test('Documents lookup falls back on registry failure, malformed values and unsupported platforms', async () => {
  for (const execFile of [async () => { throw new Error('unavailable'); },
    async () => ({ stdout: 'missing value' }),
    async () => ({ stdout: ' Personal REG_EXPAND_SZ %UNKNOWN%\\Documents' }),
    async () => ({ stdout: ' Personal REG_SZ relative\\Documents' })]) {
    assert.equal(await resolveDocumentsDirectory({ platform: 'win32', homedir: 'C:\\Users\\Fixture', env: {}, execFile }),
      'C:\\Users\\Fixture\\Documents');
  }
  assert.equal(await resolveDocumentsDirectory({ platform: 'linux', homedir: '/fixture', execFile: () => { throw new Error('must not execute'); } }),
    path.join('/fixture', 'Documents'));
});

test('download root precedence honors explicit root then Documents environment then registry', async () => {
  let queries = 0;
  const options = { platform: 'win32', homedir: 'C:\\Users\\Fixture', env: { LEARNUS_DOCUMENTS: 'E:\\Documents' },
    execFile: async () => { queries++; return { stdout: ' Personal REG_SZ D:\\Moved Documents' }; } };
  assert.equal(await resolveDownloadRoot({ root: 'F:\\Explicit' }, options), 'F:\\Explicit');
  assert.equal(await resolveDownloadRoot({}, options), 'E:\\Documents\\LearnUs');
  assert.equal(await resolveDownloadRoot({ root: '~/Documents/LearnUs' }, options), 'E:\\Documents\\LearnUs');
  assert.equal(queries, 0);
  assert.equal(await resolveDownloadRoot({}, { ...options, env: {} }), 'D:\\Moved Documents\\LearnUs');
  assert.equal(queries, 1);
  assert.equal(await resolveDownloadRoot({ root: '%downloads%\\LearnUs' }, { ...options, env: { Downloads: 'F:\\Files' } }), 'F:\\Files\\LearnUs');
  assert.equal(await resolveDownloadRoot({ root: 'files' }, { ...options, installRoot: 'C:\\Install' }), 'C:\\Install\\files');
});
