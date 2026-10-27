import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sanitizeName, downloadPath, validateDownload, safeLearnUsUrl, syncCourseDownloads, linkShortcut, linksIndex, resolveDownloadRoot, filenameFor, writeNew, writeMotw, isPathInDownloadRoot, errorReason, DRY_RUN_MESSAGE, lockHeld, acquireLock, releaseLock } from '../course-downloads.mjs';
import { DEFAULT_DENY_EXTENSIONS, normalizeDenyExtensions, validateConfig } from '../monitor-runtime.mjs';

const source = 'https://ys.learnus.org/pluginfile.php/42/mod_folder/content/notes.pdf';
const item = { course_id: 1, course: '한국어: 자료', title: 'Intro', section: 'Week 1', category: 'material', source_url: source };
const fixture = () => ({ active_courses: [{ id: 1, name: item.course }], course_materials: [{ course_id: 1, items: [{ name: 'Notes', section: 'Week 1', type: 'folder', files: [{ name: 'notes.pdf', url: source }] }] }], announcements: [], assignments: [] });
const response = (body = '%PDF-1.7\nfixture', headers = {}, status = 200) => ({ status: () => status, headers: () => ({ 'content-type': 'application/pdf', ...headers }), body: async () => Buffer.from(body), dispose: async () => {} });
async function temporary(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'learnus-downloads-'));
  try { await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
// Fixtures always download inside the temp install folder, never the real default under Documents.
const run = (root, state, get, extra = {}) => syncCourseDownloads({ installRoot: root, context: { request: { get } }, state, delayMs: 0, now: '2026-10-08T00:00:00Z', ...extra,
  lockOps: { startTime: async () => null, ...extra.lockOps },
  config: { ...extra.config, downloads: { root: 'downloads', ...extra.config?.downloads } } });

test('Windows paths preserve Korean, reject reserved names, bound length and disambiguate collisions', () => {
  assert.equal(sanitizeName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeName('한국어<>. '), '한국어__');
  const result = downloadPath('C:\\downloads', item, `${'긴'.repeat(300)}.pdf`);
  assert.ok(result.length < 240);
  assert.ok(result.includes('한국어'));
  assert.equal(path.basename(downloadPath('root', item, 'notes.pdf')), 'notes.pdf');
  assert.ok(downloadPath('root', { ...item, category: 'announcement', date: '2026-10-08' }, 'a.pdf').includes('Announcements'));
  assert.ok(downloadPath('root', { ...item, category: 'assignment' }, 'a.pdf').includes('Assignments'));
});
test('reject login/error HTML, empty, oversized and incorrect magic', () => {
  assert.throws(() => validateDownload(Buffer.from('<html>login</html>'), {}, 1024), /HTML/);
  assert.throws(() => validateDownload(Buffer.from('x'), { 'content-type': 'text/html' }, 1024), /HTML/);
  assert.throws(() => validateDownload(Buffer.alloc(0), {}, 1024), /Empty/);
  assert.throws(() => validateDownload(Buffer.alloc(1025), {}, 1024), /maxFileMB/);
  assert.throws(() => validateDownload(Buffer.from('garbage'), {}, 1024, 'file.pdf'), /magic/);
  assert.equal(safeLearnUsUrl('https://ys.learnus.org/mod/assign/view.php?id=1&action=submit'), false);
  assert.equal(safeLearnUsUrl('https://outside.example/file.pdf'), false);
});

test('explicit uploaded HTML attachments are accepted while unexpected or disguised login HTML is rejected', () => {
  const body = Buffer.from('<!doctype html><html><head><title>Week 1 notes</title></head><body>Lecture material</body></html>');
  const headers = { 'content-type': 'text/html', 'content-disposition': 'attachment; filename="notes.html"' };
  assert.doesNotThrow(() => validateDownload(body, headers, 4096, 'notes.html'));
  assert.doesNotThrow(() => validateDownload(body, { ...headers, 'content-disposition': 'inline; filename="notes.html"' }, 4096, 'notes.html'));
  assert.throws(() => validateDownload(body, { 'content-type': 'text/html' }, 4096, 'notes.html'), /HTML/);
  assert.throws(() => validateDownload(body, headers, 4096, 'different.html'), /HTML/);
  assert.throws(() => validateDownload(Buffer.from('<html><form action="/login/index.php"><input type="password"></form></html>'), headers, 4096, 'notes.html'), /HTML/);
  assert.throws(() => validateDownload(Buffer.from('<html><div class="errorbox">Access denied</div></html>'), headers, 4096, 'notes.html'), /HTML/);
});

test('resource wrappers serving explicit uploaded HTML are discovered as files', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items = [{ type: 'resource', name: 'HTML notes', id: 8, url: 'https://ys.learnus.org/mod/resource/view.php?id=8' }];
  const report = await run(root, state, async () => response('<html><title>Course notes</title><body>Week 1</body></html>', { 'content-type': 'text/html', 'content-disposition': 'attachment; filename="notes.html"' }));
  assert.equal(report.newFiles.length, 1);
  assert.equal(report.failed.length, 0);
  assert.equal(path.basename(report.newFiles[0].local_path), 'notes.html');
}));
test('incremental manifest checks validators and preserves old changed versions', () => temporary(async (root) => {
  const first = await run(root, fixture(), async () => response(undefined, { etag: '"one"' }));
  assert.equal(first.newFiles.length, 1);
  const original = first.newFiles[0].local_path;
  const second = await run(root, fixture(), async (_, options) => {
    assert.equal(options.headers['If-None-Match'], '"one"');
    assert.equal(options.maxRedirects, 0);
    return response('', {}, 304);
  });
  assert.equal(second.skipped[0].reason, 'Unchanged (HTTP 304).');
  const third = await run(root, fixture(), async () => response('%PDF-1.7\nchanged'));
  assert.equal(third.updated.length, 1);
  assert.ok(third.updated[0].local_path.includes('(updated 2026-10-08)'));
  assert.equal(await fs.readFile(original, 'utf8'), '%PDF-1.7\nfixture');
  await run(root, { ...fixture(), course_materials: [] }, async () => { throw new Error('unexpected'); });
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'downloads-manifest.json')));
  assert.equal(Object.values(manifest.entries)[0].disappeared, true);
}));
test('external links produce shortcuts and per-course index without visiting external sites', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items = [{ type: 'url', name: 'Research', section: 'Week 2', url: 'https://ys.learnus.org/mod/url/view.php?id=9' }];
  const report = await run(root, state, async (url) => {
    assert.ok(url.startsWith('https://ys.learnus.org/'));
    return response('', { location: 'https://example.org/research' }, 302);
  });
  assert.equal(report.newLinks.length, 1);
  assert.equal(await fs.readFile(report.newLinks[0].local_path, 'utf8'), linkShortcut('https://example.org/research'));
  const course = path.dirname(path.dirname(report.newLinks[0].local_path));
  assert.match(await fs.readFile(path.join(course, 'Links.md'), 'utf8'), /Research.*https:\/\/example.org\/research.*Week 2/);
  assert.match(linksIndex(report.newLinks), /2026-10-08/);
}));
test('dry run fetches no file bodies and creates no files or manifest', () => temporary(async (root) => {
  const report = await run(root, fixture(), async () => { throw new Error('must not request file'); }, { dryRun: true });
  assert.equal(report.skipped[0].reason, 'Would download.');
  assert.deepEqual(await fs.readdir(root), []);
}));

test('dry run never opens item wrappers and lists only directly known course and archived announcement files', () => temporary(async (root) => {
  const state = fixture();
  state.active_courses[0].instructorNames = ['Instructor'];
  const wrappers = ['resource', 'url', 'page', 'book', 'ubfile'].map((type, index) => ({
    id: index + 10, type, name: `${type} wrapper`, url: `https://ys.learnus.org/mod/${type}/view.php?id=${index + 10}`,
  }));
  const directResource = source.replace('notes.pdf', 'direct-resource.pdf');
  const archivedAttachment = source.replace('notes.pdf', 'archived.pdf');
  state.course_materials[0].items.push(...wrappers,
    { id: 30, type: 'resource', name: 'Direct resource', url: directResource },
    { id: 31, type: 'board', name: 'Instructor files', entries: [{ id: 1, author: 'Instructor', title: 'Article', url: 'https://ys.learnus.org/mod/ubboard/article.php?id=31&bwid=1' }] });
  state.announcements.push({ id: 'archived', course_id: 1, course: item.course, title: 'Archived notice', author: 'Instructor', currently_listed: false, url: 'https://ys.learnus.org/mod/ubboard/article.php?id=32&bwid=2', attachments: [{ name: 'archived.pdf', url: archivedAttachment }] });
  state.assignments.push({ id: 33, course_id: 1, course: item.course, name: 'Board assignment', source_type: 'board_submission', source_url: 'https://ys.learnus.org/mod/ubboard/view.php?id=33' });
  const requested = [];
  const page = { goto: async (url) => {
    requested.push(url);
    assert.fail(`Dry run requested an item page or file: ${url}`);
  } };
  const report = await run(root, state, page.goto, { dryRun: true, context: { request: { get: (url) => page.goto(url) } } });
  assert.deepEqual(requested, []);
  assert.equal(report.dry_run_limited, true);
  assert.equal(report.dry_run_message, 'Dry run does not open item pages (view.php/article.php) because opening them can mark items viewed in LearnUs; only directly known file links are listed.');
  assert.equal(DRY_RUN_MESSAGE, report.dry_run_message);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.wouldDownload.map((entry) => entry.source_url).sort(), [source, directResource, archivedAttachment].sort());
  for (const wrapper of wrappers) assert.ok(report.skipped.some((entry) => entry.source_url === wrapper.url && entry.reason === DRY_RUN_MESSAGE));
  assert.ok(report.skipped.some((entry) => /\/ubboard\/article\.php/.test(entry.source_url) && entry.reason === DRY_RUN_MESSAGE));
  assert.deepEqual(await fs.readdir(root), []);
}));

test('actual synchronization resolves portable Documents roots through the runtime resolver', () => temporary(async (root) => {
  const previous = process.env.LEARNUS_DOCUMENTS;
  process.env.LEARNUS_DOCUMENTS = path.join(root, 'redirected-documents');
  try {
    const report = await run(root, fixture(), async () => response(), { config: { downloads: { root: '~/Documents/LearnUs' } } });
    assert.equal(report.failed.length, 0);
    assert.equal(report.newFiles.length, 1);
    assert.ok(report.newFiles[0].local_path.startsWith(path.join(root, 'redirected-documents', 'LearnUs') + path.sep));
    const defaultRoot = await run(root, fixture(), async () => assert.fail('dry run requested'), { dryRun: true, config: { downloads: { root: undefined } } });
    assert.ok(defaultRoot.wouldDownload[0].local_path.startsWith(path.join(root, 'redirected-documents', 'LearnUs') + path.sep));
  } finally {
    if (previous === undefined) delete process.env.LEARNUS_DOCUMENTS;
    else process.env.LEARNUS_DOCUMENTS = previous;
  }
}));
test('dry run skips wrapper redirects and preserves existing manifest bytes', () => temporary(async (root) => {
  const manifest = '{"schema_version":1,"entries":{}}\n';
  await fs.writeFile(path.join(root, 'downloads-manifest.json'), manifest);
  const state = fixture();
  state.course_materials[0].items = [{ type: 'resource', name: 'Notes', section: 'Week 1', url: 'https://ys.learnus.org/mod/resource/view.php?id=10' }];
  const requested = [];
  const report = await run(root, state, async (url) => { requested.push(url); return response('', { location: source }, 302); }, { dryRun: true });
  assert.equal(requested.length, 0);
  assert.deepEqual(report.wouldDownload, []);
  assert.equal(report.skipped[0].reason, DRY_RUN_MESSAGE);
  assert.equal(await fs.readFile(path.join(root, 'downloads-manifest.json'), 'utf8'), manifest);
  assert.deepEqual(await fs.readdir(root), ['downloads-manifest.json']);
}));
test('colliding originals are preserved and URL shortcut injection is rejected', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items[0].files.push({ name: 'notes.pdf', url: source.replace('/42/', '/43/') });
  const report = await run(root, state, async () => response());
  assert.equal(report.newFiles.length, 2);
  assert.notEqual(report.newFiles[0].local_path, report.newFiles[1].local_path);
  assert.equal(path.basename(report.newFiles[0].local_path), 'notes.pdf');
  assert.throws(() => linkShortcut('https://example.org/a%0d%0aIconFile=evil'), /Unsafe/);
}));
test('download failure remains nonfatal and is reported without a manifest entry', () => temporary(async (root) => {
  const report = await run(root, fixture(), async () => response('<html>login</html>', { 'content-type': 'text/html' }));
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].reason, /HTML/);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'downloads-manifest.json')));
  assert.deepEqual(manifest.entries, {});
}));
test('capped runs prioritise missing files so later files are not starved', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items[0].files.push({ name: 'second.pdf', url: source.replace('notes.pdf', 'second.pdf') });
  const options = { config: { downloads: { maxFilesPerRun: 1 } } };
  const first = await run(root, state, async () => response(), options);
  const second = await run(root, state, async () => response(), options);
  assert.equal(first.newFiles.length, 1);
  assert.equal(second.newFiles.length, 1);
  assert.notEqual(first.newFiles[0].source_url, second.newFiles[0].source_url);
}));

const htmlResponse = (html) => response(html, { 'content-type': 'text/html' });
const wrapper = (type, id, extra = {}) => ({ type, id, name: `Resource ${id}`, section: 'Week 1', url: `https://ys.learnus.org/mod/${type}/view.php?id=${id}`, ...extra });

test('successful and removed scopes mark disappearance while failed and capped scopes stay uncertain', () => temporary(async (root) => {
  const state = fixture();
  const secondSource = source.replace('/42/', '/43/');
  state.course_materials[0].items = [wrapper('resource', 10), wrapper('resource', 11), { id: 12, type: 'folder', name: 'Removed', files: [{ name: 'removed.pdf', url: source.replace('notes.pdf', 'removed.pdf') }] }];
  await run(root, state, async (url) => url.includes('/view.php') ? htmlResponse(`<a href="${url.includes('id=10') ? source : secondSource}">notes.pdf</a>`) : response());
  state.course_materials[0].items.pop();
  const report = await run(root, state, async (url) => url.includes('id=10') ? htmlResponse('<main>No attachments</main>') : response('', {}, 404));
  assert.equal(report.failed.length, 1);
  let manifest = JSON.parse(await fs.readFile(path.join(root, 'downloads-manifest.json')));
  assert.equal(manifest.entries[`1:${source}`].disappeared, true);
  assert.equal(manifest.entries[`1:${secondSource}`].disappeared, false);
  assert.equal(manifest.entries[`1:${secondSource}`].discovery_status, 'uncertain');
  assert.equal(manifest.entries[`1:${source.replace('notes.pdf', 'removed.pdf')}`].disappeared, true);
  // Restore both attachments, then inspect only the first scope in a capped run.
  await run(root, state, async (url) => url.includes('/view.php') ? htmlResponse(`<a href="${url.includes('id=10') ? source : secondSource}">notes.pdf</a>`) : response());
  await run(root, state, async () => htmlResponse('<main>No attachments</main>'), { config: { downloads: { maxFilesPerRun: 1 } } });
  manifest = JSON.parse(await fs.readFile(path.join(root, 'downloads-manifest.json')));
  assert.equal(manifest.entries[`1:${source}`].disappeared, true);
  assert.equal(manifest.entries[`1:${secondSource}`].discovery_status, 'uncertain');
}));

test('material boards inspect only course-scoped trusted instructors, including teachers with known names', () => temporary(async (root) => {
  const state = fixture();
  const articleUrl = (id) => `https://ys.learnus.org/mod/ubboard/article.php?id=99&bwid=${id}`;
  state.course_materials[0].items = [{ id: 99, name: 'Materials', type: 'board', entries: [
    { id: 1, title: 'Instructor notes', author: 'Professor Kim', url: articleUrl(1) },
    { id: 2, title: 'Student submission', author: 'Professor Kim', author_role: 'student', url: articleUrl(2) },
    { id: 3, title: 'Teacher handout', author: 'Lee', author_role: 'teacher', url: articleUrl(3) },
    { id: 4, title: 'Unverified post', author: 'Park', url: articleUrl(4) },
  ] }];
  const requested = [];
  const report = await run(root, state, async (url) => {
    requested.push(url);
    return url.includes('/article.php') ? htmlResponse(`<a href="${source.replace('/42/', url.includes('bwid=1') ? '/42/' : '/43/')}">notes.pdf</a>`) : response();
  }, { config: { downloads: { instructorAuthors: { 1: ['Professor Kim', 'Lee'], 2: ['Park'] } } } });
  assert.equal(report.newFiles.length, 2);
  assert.equal(requested.some((url) => /bwid=[24]/.test(url)), false);
  assert.equal(report.skipped.filter((entry) => /author not a known instructor/.test(entry.reason)).length, 2);
}));

test('Moodle URL workaround, externalurl anchor and escaped data produce shortcuts without external GETs', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items = [wrapper('url', 1), wrapper('url', 2), wrapper('url', 3)];
  const pages = [
    '<nav><a href="https://wrong.example/footer">Footer</a></nav><div class="urlworkaround"><div><a href="https://youtube.com/watch?v=one&amp;list=course">Lecture</a></div></div>',
    '<a class="externalurl" href="https://example.org/paper">Paper</a>',
    '<div data-resource="{&quot;externalurl&quot;:&quot;https:\\/\\/example.org\\/data?x=1&amp;y=2&quot;}"></div>',
  ];
  const report = await run(root, state, async (url) => {
    assert.ok(url.startsWith('https://ys.learnus.org/'));
    return htmlResponse(pages[Number(new URL(url).searchParams.get('id')) - 1]);
  });
  assert.equal(report.newLinks.length, 3);
  assert.equal(report.newFiles.length, 0);
  assert.deepEqual(report.newLinks.map((entry) => entry.source_url), ['https://youtube.com/watch?v=one&list=course', 'https://example.org/paper', 'https://example.org/data?x=1&y=2']);
}));

test('page and book content exclude boilerplate and traverse only same-book chapters', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items = [wrapper('page', 1), wrapper('book', 2)];
  const requested = [];
  const report = await run(root, state, async (url) => {
    requested.push(url);
    const parsed = new URL(url);
    const chrome = '<nav><a href="https://wrong.example/nav">Nav</a></nav><footer><a href="https://wrong.example/footer">Footer</a></footer>';
    if (parsed.pathname.includes('/page/')) return htmlResponse(`${chrome}<div class="mod_introbox"><div class="no-overflow"><a href="https://example.org/intro">Intro</a></div></div>`);
    if (parsed.searchParams.has('chapterid')) return htmlResponse(`${chrome}<div class="book_content"><a href="https://example.org/chapter">Chapter</a></div><div class="book_toc"><a href="?id=2&chapterid=3">Repeat</a></div>`);
    return htmlResponse(`${chrome}<div class="book_content"><a href="https://example.org/book">Book</a></div><div class="book_toc"><a href="?id=2&chapterid=3">Chapter</a><a href="?id=99&chapterid=4">Other book</a><a href="https://outside.example/chapter">External chapter</a></div>`);
  });
  assert.equal(report.newLinks.length, 3);
  assert.equal(requested.length, 3);
  assert.ok(requested.every((url) => url.startsWith('https://ys.learnus.org/')));
  assert.equal(report.newLinks.some((entry) => entry.source_url.includes('wrong.example')), false);
}));

test('unchanged shortcuts refresh manifest metadata and append current index rows while preserving history', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items = [wrapper('url', 9, { name: 'Old title', section: 'Week 1', url: 'https://example.org/paper' })];
  const first = await run(root, state, async () => { throw new Error('No external request'); });
  const originalPath = first.newLinks[0].local_path;
  state.course_materials[0].items[0].name = 'Current title';
  state.course_materials[0].items[0].section = 'Week 2';
  const next = await run(root, state, async () => { throw new Error('No external request'); }, { now: '2026-10-09T00:00:00Z' });
  assert.equal(next.updated.length, 0);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'downloads-manifest.json')));
  const entry = Object.values(manifest.entries)[0];
  assert.equal(entry.title, 'Current title');
  assert.equal(entry.section, 'Week 2');
  assert.equal(entry.first_seen, '2026-10-08T00:00:00Z');
  assert.equal(entry.last_seen, '2026-10-09T00:00:00Z');
  assert.equal(entry.local_path, originalPath);
  const index = await fs.readFile(path.join(root, 'downloads', sanitizeName(item.course, 70), 'Links.md'), 'utf8');
  assert.match(index, /Old title.*Week 1/);
  assert.match(index, /Current title.*Week 2.*2026-10-08/);
  await run(root, state, async () => { throw new Error('No external request'); }, { now: '2026-10-10T00:00:00Z' });
  assert.equal(await fs.readFile(path.join(root, 'downloads', sanitizeName(item.course, 70), 'Links.md'), 'utf8'), index);
  const currentManifest = JSON.parse(await fs.readFile(path.join(root, 'downloads-manifest.json')));
  assert.equal(Object.values(currentManifest.entries)[0].last_seen, '2026-10-10T00:00:00Z');
}));

test('temporary path and collision suffix fit the Windows bound; long roots fail without writing', () => temporary(async (root) => {
  const longFilename = `${'한글'.repeat(150)}.pdf`;
  const target = downloadPath('C:\\downloads', item, longFilename, ` (updated 2026-10-08) ${'a'.repeat(17)}`);
  assert.ok(target.length < 240);
  assert.ok(path.join(path.dirname(target), '.dl-0000000000000000.part').length < 240);
  const installRoot = path.join(os.tmpdir(), 'learnus-portable-path');
  for (const category of ['announcement', 'assignment']) for (const suffix of ['', ' (updated 2026-10-08)']) {
    const destination = downloadPath(installRoot, { ...item, course: '한'.repeat(55), title: '제'.repeat(55), category, date: '2026-10-08' }, 'notes.pdf', suffix);
    assert.ok(destination.length < 240);
    assert.ok(path.join(path.dirname(destination), '.dl-0000000000000000.part').length < 240);
    assert.equal(path.basename(destination), `notes${suffix}.pdf`);
  }
  assert.throws(() => downloadPath(`C:\\${'a'.repeat(210)}`, item, 'notes.pdf'), /root is too long/);
  const report = await run(root, fixture(), async () => response(), { config: { downloads: { root: 'a'.repeat(220) } } });
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].reason, /root is too long/);
  assert.deepEqual(await fs.readdir(root), ['downloads-manifest.json']);
}));

test('capped book inspection saves current pages and resumes all safe chapters across runs', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items = [wrapper('book', 2)];
  const requested = [];
  const get = async (url) => {
    requested.push(url);
    assert.ok(url.startsWith('https://ys.learnus.org/'));
    const chapter = new URL(url).searchParams.get('chapterid');
    if (chapter) return htmlResponse(`<div class="book_content"><a href="https://example.org/chapter-${chapter}">Chapter ${chapter}</a></div>`);
    const toc = Array.from({ length: 25 }, (_, i) => `<a href="?id=2&chapterid=${i + 1}">Chapter ${i + 1}</a>`).join('');
    return htmlResponse(`<div class="book_content"><a href="https://example.org/book">Book</a></div><div class="book_toc">${toc}<a href="?id=99&chapterid=1">Other book</a><a href="https://outside.example/chapter">Outside</a></div>`);
  };
  const first = await run(root, state, get);
  assert.equal(first.failed.length, 0);
  assert.equal(first.newLinks.length, 20);
  let manifest = JSON.parse(await fs.readFile(path.join(root, 'downloads-manifest.json')));
  assert.equal(Object.values(manifest.book_discovery)[0].pending.length, 6);
  const firstScope = first.newLinks[0].discovery_scope;
  assert.equal(manifest.discovery_scopes[firstScope].complete, false);
  const second = await run(root, state, get);
  assert.equal(second.newLinks.length, 6);
  manifest = JSON.parse(await fs.readFile(path.join(root, 'downloads-manifest.json')));
  assert.equal(Object.keys(manifest.entries).length, 26);
  assert.equal(Object.values(manifest.entries).some((entry) => entry.disappeared), false);
  assert.equal(Object.values(manifest.book_discovery)[0].pending.length, 0);
  assert.equal(requested.filter((url) => new URL(url).searchParams.has('chapterid')).length, 25);
  // Start the next bounded update cycle without declaring unchecked chapters absent.
  await run(root, state, get);
  manifest = JSON.parse(await fs.readFile(path.join(root, 'downloads-manifest.json')));
  assert.equal(Object.values(manifest.entries).some((entry) => entry.disappeared), false);
}));

test('video extensions, MIME video and playlists skip even with empty custom extension list', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items[0].files = [
    { name: 'lecture.webm', url: source.replace('notes.pdf', 'lecture.webm') },
    { name: 'unknown.bin', url: source.replace('notes.pdf', 'unknown.bin') },
    { name: 'playlist.bin', url: source.replace('notes.pdf', 'playlist.bin') },
  ];
  const requested = [];
  const report = await run(root, state, async (url) => {
    requested.push(url);
    const result = response('video', { 'content-type': url.includes('playlist') ? 'application/vnd.apple.mpegurl' : 'video/mp4' });
    result.body = async () => { throw new Error('Video bodies must not be requested'); };
    return result;
  }, { config: { downloads: { skipExtensions: [] } } });
  assert.equal(report.failed.length, 0);
  assert.equal(report.skipped.length, 3);
  assert.equal(requested.length, 2);
  assert.equal(report.newFiles.length, 0);
}));

test('GET retry errors are sanitised and the configured cap cannot exceed 200', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items[0].files = Array.from({ length: 201 }, (_, id) => ({ name: `${id}.pdf`, url: source.replace('notes.pdf', `${id}.pdf`) }));
  const report = await run(root, state, async () => response(), { config: { downloads: { maxFilesPerRun: 999 } } });
  assert.equal(report.newFiles.length, 200);
  assert.equal(report.skipped.filter((entry) => /file cap/.test(entry.reason)).length, 1);
  const failed = await run(root, fixture(), async () => { throw new Error('GET https://ys.learnus.org/login?password=secret Call log username=private'); });
  assert.equal(failed.failed.length, 1);
  assert.equal(JSON.stringify(failed).includes('secret'), false);
  assert.equal(JSON.stringify(failed).includes('private'), false);
}));

test('announcement and assignment content links are saved in their source folders without external requests', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials = [];
  state.announcements = [{ id: 1, course_id: 1, course: item.course, title: 'Notice', posted_on: '2026-10-08', current_content_links: [{ name: 'Paper', url: 'https://example.org/notice' }], current_attachments: [{ name: 'notes.pdf', url: 'https://ys.learnus.org/mod/ubboard/download.php?id=1&bwid=1&fileid=2' }], attachment_discovery_complete: true }];
  state.assignments = [{ id: 2, course_id: 1, course: item.course, name: 'Homework', instruction_links: [{ name: 'Dataset', url: 'https://example.org/dataset' }] }];
  const report = await run(root, state, async (url) => { assert.ok(url.startsWith('https://ys.learnus.org/')); return response(undefined, { 'content-disposition': 'attachment; filename="notes.pdf"' }); });
  assert.equal(report.newLinks.length, 2);
  assert.equal(report.newFiles.length, 1);
  assert.ok(report.newLinks[0].local_path.includes('Announcements'));
  assert.ok(report.newLinks[1].local_path.includes('Assignments'));
}));

test('HTTP200 soft errors and unrecognised templates preserve prior scope uncertainty', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items = [wrapper('resource', 1)];
  await run(root, state, async (url) => url.includes('/view.php') ? htmlResponse(`<a href="${source}">Notes</a>`) : response());
  await run(root, state, async () => htmlResponse('<html><div class="errorbox">Unavailable</div></html>'));
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'downloads-manifest.json')));
  assert.equal(manifest.entries[`1:${source}`].disappeared, false);
  assert.equal(manifest.entries[`1:${source}`].discovery_status, 'uncertain');
}));

test('assignment boards retain intro links while never visiting or downloading student article rows', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials = [];
  const studentFile = source.replace('notes.pdf', 'student.pdf');
  state.assignments = [{ id: 'board-77', course_id: 1, course: item.course, name: 'Homework', source_type: 'board_submission', source_url: 'https://ys.learnus.org/mod/ubboard/view.php?id=77' }];
  const requested = [];
  const report = await run(root, state, async (url) => {
    requested.push(url);
    return htmlResponse(`<div id="intro"><a href="https://example.org/instructions">Instructions</a></div><div class="generalbox"><a href="${studentFile}">Student attachment</a><a href="/mod/ubboard/article.php?id=77&bwid=9">Student post</a></div>`);
  });
  assert.equal(requested.length, 1);
  assert.equal(report.newLinks.length, 1);
  assert.equal(report.newFiles.length, 0);
}));

// ---- Live-site findings (LearnUs 2026-10): viewer-only ubfile, board policy, duplicate listings, nameless attachments ----
const ubfileView = (id) => `https://ys.learnus.org/mod/ubfile/view.php?id=${id}`;
const pluginfile = (name, area = 'mod_ubfile/content/0') => `https://ys.learnus.org/pluginfile.php/55/${area}/${encodeURIComponent(name)}`;

test('ubfile modules resolve to the pluginfile via redirect=1, including viewer-only items, without opening the viewer', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items = [
    { id: 1, type: 'ubfile', name: 'Direct', section: 'Week 1', url: ubfileView(1) },
    { id: 2, type: 'ubfile', name: 'Viewer only', section: 'Week 1', url: ubfileView(2) },
  ];
  const requested = [];
  const report = await run(root, state, async (url) => {
    requested.push(url);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/view.php')) {
      if (parsed.searchParams.get('redirect') !== '1') return htmlResponse('<div class="resourceworkaround"><a href="https://ys.learnus.org/mod/ubfile/viewer.php?id=2">Open</a></div>');
      return response('', { location: `${pluginfile(parsed.searchParams.get('id') === '1' ? 'direct.pdf' : 'article viewer.pdf')}?forcedownload=1` }, 303);
    }
    return response('%PDF-1.7\nubfile');
  });
  assert.equal(report.failed.length, 0);
  assert.deepEqual(report.newFiles.map((entry) => path.basename(entry.local_path)).sort(), ['article viewer.pdf', 'direct.pdf']);
  assert.ok(requested.every((url) => !/viewer\.php|coursemos/.test(url)));
  assert.ok(requested.filter((url) => url.includes('/view.php')).every((url) => url.includes('redirect=1')));
}));

test('Class Q&A boards are skipped entirely by default; Class Files boards harvest attachments and bare body URLs', () => temporary(async (root) => {
  const state = fixture();
  const article = (board, id) => `https://ys.learnus.org/mod/ubboard/article.php?id=${board}&bwid=${id}`;
  state.course_materials[0].items = [
    { id: 10, type: 'board', name: 'Class Q&A', entries: [{ id: 1, title: 'Student question', author: 'Some Student', url: article(10, 1) }] },
    { id: 11, type: 'board', name: 'Class Files', entries: [
      { id: 2, title: 'Link to film', author: 'Professor Example', url: article(11, 2) },
      { id: 3, title: 'Handout', author: 'Professor Example', url: article(11, 3) },
      { id: 4, title: 'Classmate upload', author: 'Another Student', author_role: 'student', url: article(11, 4) },
    ] },
  ];
  const requested = [];
  state.announcements = [{ course_id: 1, author: 'Professor Example', title: 'Instructor announcement' }];
  const options = {};
  const report = await run(root, state, async (url) => {
    requested.push(url);
    if (url.includes('bwid=2')) return htmlResponse('<div role="main"><div class="ubboard_view"><div class="content"><div class="text_to_html"><p><a href="https://www.bilibili.tv/en/video/1">https://www.bilibili.tv/en/video/1</a></p></div></div></div></div>');
    if (url.includes('bwid=3')) return htmlResponse(`<div role="main"><div class="text_to_html">See handout</div><a href="${pluginfile('handout.pdf', 'mod_ubboard/attachment/3')}?forcedownload=1">handout.pdf</a></div>`);
    return response();
  }, options);
  assert.equal(requested.some((url) => /bwid=[14]/.test(url)), false, 'Q&A and student posts are never fetched');
  assert.equal(report.newLinks.length, 1);
  assert.equal(report.newLinks[0].source_url, 'https://www.bilibili.tv/en/video/1');
  assert.deepEqual(report.newFiles.map((entry) => path.basename(entry.local_path)), ['handout.pdf']);
  assert.ok(report.skipped.some((entry) => /Q&A board skipped/.test(entry.reason)));
  // The opt-in still requires a verified instructor author.
  const optIn = await run(root, state, async () => htmlResponse('<main>No attachments</main>'), { config: { downloads: { includeQnA: true, instructorAuthors: { 1: ['Some Student'] } } } });
  assert.equal(optIn.skipped.some((entry) => /Q&A board skipped/.test(entry.reason)), false);
}));

test('the same file listed with and without forcedownload, and modules repeated by id, are fetched once with the real name', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items = [
    { id: 5, type: 'folder', name: 'Week 6', section: 'Week 6', files: [{ name: 'a.pdf', url: `${pluginfile('a.pdf', 'mod_folder/content/0')}?forcedownload=1` }] },
    { id: 5, type: 'folder', name: 'Week 6', section: 'Week 6 (again)', files: [{ name: 'a.pdf', url: `${pluginfile('a.pdf', 'mod_folder/content/0')}?forcedownload=1` }] },
  ];
  state.announcements = [{ id: 1, course_id: 1, course: item.course, title: 'Photos', posted_on: '2026-10-08', current_attachments: [
    { name: 'Attachment', url: pluginfile('photo.jpg', 'mod_ubboard/attachment/9') },
    { name: 'photo.jpg', url: `${pluginfile('photo.jpg', 'mod_ubboard/attachment/9')}?forcedownload=1` },
  ] }];
  const requested = [];
  const report = await run(root, state, async (url) => {
    requested.push(url);
    return response(url.includes('photo') ? 'jpegdata' : '%PDF-1.7\nfolder', { 'content-type': url.includes('photo') ? 'image/jpeg' : 'application/pdf' });
  });
  assert.equal(report.failed.length, 0);
  assert.equal(requested.length, 2);
  assert.equal(report.newFiles.length, 2);
  assert.ok(report.newFiles.some((entry) => path.basename(entry.local_path) === 'photo.jpg'));
}));

test('attachments named "attachment" take their real name from Content-Disposition, link text or content type', () => temporary(async (root) => {
  const state = fixture();
  const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  state.course_materials[0].items = [{ id: 1, type: 'folder', name: 'Files', section: 'Week 1', files: [
    { name: 'attachment', url: 'https://ys.learnus.org/pluginfile.php/55/mod_ubboard/attachment/1/attachment' },
    { name: 'attachment', url: 'https://ys.learnus.org/pluginfile.php/55/mod_ubboard/attachment/2/attachment' },
    { name: 'Syllabus.pdf', url: 'https://ys.learnus.org/pluginfile.php/55/mod_ubboard/attachment/3/attachment' },
  ] }];
  const report = await run(root, state, async (url) => {
    if (url.includes('/1/')) return response('PKdocx', { 'content-type': docx });
    if (url.includes('/2/')) return response('%PDF-1.7\ndisposition', { 'content-disposition': "attachment; filename*=UTF-8''%EC%88%99%EC%A0%9C.pdf" });
    return response('%PDF-1.7\nlinktext');
  });
  assert.equal(report.failed.length, 0);
  assert.deepEqual(report.newFiles.map((entry) => path.basename(entry.local_path)).sort(), ['Syllabus.pdf', 'attachment.docx', '숙제.pdf'].sort());
}));

test('textbooks are skipped quietly, Turnitin is not downloaded, and labels yield inline files and links', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items = [
    { id: 1, type: 'textbook', name: 'Lecture Summary 1', section: 'Week 1', url: 'https://ys.learnus.org/mod/textbook/view.php?id=1' },
    { id: 2, type: 'turnitintooltwo', name: 'Paper', section: 'Week 2', url: 'https://ys.learnus.org/mod/turnitintooltwo/view.php?id=2' },
    { id: 3, type: 'label', name: 'Week 4 note', section: 'Week 4', files: [{ name: 'map.png', url: pluginfile('map.png', 'mod_label/intro/0') }], links: [{ name: 'Reading', url: 'https://example.org/reading' }] },
  ];
  const requested = [];
  const report = await run(root, state, async (url) => { requested.push(url); return response('pngdata', { 'content-type': 'image/png' }); });
  assert.equal(requested.length, 1);
  assert.equal(report.failed.length, 0);
  assert.equal(report.newFiles.length, 1);
  assert.equal(report.newLinks.length, 1);
  assert.ok(report.skipped.some((entry) => /Turnitin/.test(entry.reason)));
  assert.equal(report.skipped.some((entry) => entry.title === 'Lecture Summary 1'), false);
}));

test('URL module targets come from the main region and never from site chrome', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items = [wrapper('url', 1)];
  const report = await run(root, state, async () => htmlResponse('<header><a href="https://wrong.example/header">Header</a></header><div role="main"><span id="maincontent"></span><div id="urlintro" class="box mod_introbox"><p>Course</p></div><a href="https://www.learnus.org/local/ubonline/view.php?id=1&category=33">Open course</a></div><footer><a href="https://wrong.example/footer">Footer</a></footer>'));
  assert.deepEqual(report.newLinks.map((entry) => entry.source_url), ['https://www.learnus.org/local/ubonline/view.php?id=1&category=33']);
}));

test('assignment downloads cover instruction attachments only; the student own submission files are refused', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials = [];
  state.assignments = [{ id: 2, course_id: 1, course: item.course, name: 'Presentation', instruction_attachments: [
    { name: 'Schedule.pdf', url: pluginfile('Schedule.pdf', 'mod_assign/introattachment/0') },
    { name: 'Sign.pdf', url: pluginfile('Sign.pdf', 'mod_assign/intro/0') },
    { name: 'My own.pdf', url: pluginfile('My own.pdf', 'assignsubmission_file/submission_files/9') },
  ] }];
  const requested = [];
  const report = await run(root, state, async (url) => { requested.push(url); return response(); });
  assert.equal(requested.length, 2);
  assert.equal(requested.some((url) => /submission/.test(url)), false);
  assert.equal(report.newFiles.length, 2);
  assert.ok(report.newFiles.every((entry) => entry.local_path.includes(`${path.sep}Assignments${path.sep}Presentation${path.sep}`)));
  assert.ok(report.skipped.some((entry) => /unsafe/i.test(entry.reason)));
}));

test('a board article with a hidden password-confirm modal is not mistaken for a login page; a real login form is', () => temporary(async (root) => {
  const state = fixture();
  state.active_courses[0].instructorNames = ['Professor Example'];
  state.course_materials[0].items = [{ id: 11, type: 'board', name: 'Class Files', entries: [{ id: 2, title: 'Link', author: 'Professor Example', url: 'https://ys.learnus.org/mod/ubboard/article.php?id=11&bwid=2' }] }];
  const article = '<div role="main"><div class="text_to_html"><a href="https://example.org/film">film</a></div><div id="password_confirm" class="modal"><form action="action.php"><input type="password" name="password_check"></form></div></div>';
  const ok = await run(root, state, async () => htmlResponse(article));
  assert.equal(ok.failed.length, 0);
  assert.equal(ok.newLinks.length, 1);
  await temporary(async (other) => {
    const failed = await run(other, state, async () => htmlResponse('<form action="https://ys.learnus.org/login/index.php"><input name="username"><input type="password" name="password"></form>'));
    assert.equal(failed.newLinks.length, 0);
    assert.equal(failed.failed.length, 1);
  });
}));

test('manifest paths under another download root are treated as new and never reused or restored', () => temporary(async (root) => {
  const first = await run(root, fixture(), async () => response(undefined, { etag: '"old"' }), { config: { downloads: { root: 'old-downloads' } } });
  const old = first.newFiles[0].local_path;
  const second = await run(root, fixture(), async (_url, options) => {
    assert.deepEqual(options.headers, {}, 'escaped prior entries send no conditional headers');
    return response();
  });
  assert.equal(second.newFiles.length, 1);
  assert.equal(second.updated.length, 0);
  assert.equal(second.skipped.some((entry) => /Unchanged|Restored/.test(entry.reason)), false);
  assert.equal(await fs.readFile(old, 'utf8'), '%PDF-1.7\nfixture');
  assert.ok(isPathInDownloadRoot(second.newFiles[0].local_path, path.join(root, 'downloads')));
  await fs.unlink(second.newFiles[0].local_path);
  const third = await run(root, fixture(), async () => response(), { config: { downloads: { root: 'third-downloads' } } });
  assert.equal(third.newFiles.length, 1);
  await assert.rejects(fs.access(second.newFiles[0].local_path), { code: 'ENOENT' });
  assert.equal(await fs.readFile(old, 'utf8'), '%PDF-1.7\nfixture');
  assert.deepEqual(third.newFiles[0].versions, []);
}));

test('traversal and different-drive manifest paths cannot restore files outside the current root', () => temporary(async (root) => {
  const original = await run(root, fixture(), async () => response());
  const manifestFile = path.join(root, 'downloads-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile));
  manifest.entries[`1:${source}`].local_path = path.join('..', 'escaped', 'notes.pdf');
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await fs.unlink(original.newFiles[0].local_path);
  const report = await run(root, fixture(), async () => response());
  assert.equal(report.newFiles.length, 1);
  await assert.rejects(fs.access(path.join(root, 'escaped')), { code: 'ENOENT' });
  assert.equal(isPathInDownloadRoot(path.join('..', 'downloads-evil', 'notes.pdf'), path.join(root, 'downloads')), false);
  assert.equal(isPathInDownloadRoot(root, root), false);
  assert.equal(isPathInDownloadRoot(undefined, root), false);
  if (process.platform === 'win32') assert.equal(isPathInDownloadRoot('Z:\\other\\notes.pdf', root), false);
}));

test('Mark-of-Web is applied to the complete temp file before publication and reapplied after exclusive fallback', () => temporary(async (root) => {
  for (const fallback of [false, true]) {
    const events = [];
    const destination = path.join(root, fallback ? 'fallback.pdf' : 'linked.pdf');
    await writeNew(destination, Buffer.from('complete'), {
      writeMotw: async (file, url) => {
        assert.equal(url, source);
        assert.equal(await fs.readFile(file, 'utf8'), 'complete');
        events.push(file === destination ? 'mark final' : 'mark temp');
      },
      link: async (temp, file) => {
        events.push('publish');
        if (fallback) throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' });
        await fs.link(temp, file);
      },
    }, source);
    assert.deepEqual(events, fallback ? ['mark temp', 'publish', 'mark final'] : ['mark temp', 'publish']);
  }
}));

test('writeMotw writes Zone.Identifier only on Windows and ignores unsupported streams', async () => {
  const calls = [];
  await writeMotw('fixture.pdf', source, { platform: 'win32', writeFile: async (...args) => calls.push(args) });
  assert.deepEqual(calls, [['fixture.pdf:Zone.Identifier', `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${source}\r\n`, 'utf8']]);
  await writeMotw('fixture.pdf', source, { platform: 'linux', writeFile: async () => assert.fail('non-Windows write') });
  await writeMotw('fixture.pdf', source, { platform: 'win32', writeFile: async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); } });
});

test('actual Windows Mark-of-Web ADS survives rename and hard-link publication', { skip: process.platform !== 'win32' }, async (t) => temporary(async (root) => {
  const temp = path.join(root, 'mark.part');
  await fs.writeFile(temp, 'probe');
  try { await fs.writeFile(`${temp}:Zone.Identifier`, 'probe'); await fs.readFile(`${temp}:Zone.Identifier`, 'utf8'); }
  catch { t.skip('Temporary filesystem does not support alternate data streams'); return; }
  await writeMotw(temp, source);
  const stream = await fs.readFile(`${temp}:Zone.Identifier`, 'utf8');
  const expected = `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${source}\r\n`;
  assert.equal(stream, expected);
  const destination = path.join(root, 'renamed.pdf');
  await fs.rename(temp, destination);
  assert.equal(await fs.readFile(`${destination}:Zone.Identifier`, 'utf8'), expected);
  const linked = path.join(root, 'linked.pdf');
  await writeNew(linked, Buffer.from('probe'), {}, source);
  assert.equal(await fs.readFile(`${linked}:Zone.Identifier`, 'utf8'), expected);
  const fallback = path.join(root, 'fallback.pdf');
  await writeNew(fallback, Buffer.from('probe'), { link: async () => { throw Object.assign(new Error('no links'), { code: 'ENOTSUP' }); } }, source);
  assert.equal(await fs.readFile(`${fallback}:Zone.Identifier`, 'utf8'), expected);
}));

test('unsupported Mark-of-Web writes do not fail a download', () => temporary(async (root) => {
  const file = path.join(root, 'unsupported.pdf');
  await writeNew(file, Buffer.from('body'), { writeMotw: async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); } }, source);
  assert.equal(await fs.readFile(file, 'utf8'), 'body');
}));

test('exclusive write fallback preserves a file created by a racing writer', () => temporary(async (root) => {
  const file = path.join(root, 'racing.pdf');
  await assert.rejects(writeNew(file, Buffer.from('download'), {
    link: async () => {
      await fs.writeFile(file, 'someone else', { flag: 'wx' });
      throw Object.assign(new Error('no hardlinks'), { code: 'EPERM' });
    },
  }, source), { code: 'EEXIST' });
  assert.equal(await fs.readFile(file, 'utf8'), 'someone else');
  assert.deepEqual(await fs.readdir(root), ['racing.pdf']);
}));

test('default attachment denylist blocks every executable extension without downloaded manifest entries', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items[0].files = DEFAULT_DENY_EXTENSIONS.map((ext) => ({ name: `handout${ext}`, url: source.replace('notes.pdf', `handout${ext}`) }));
  const report = await run(root, state, async () => response('payload', { 'content-type': 'application/octet-stream' }));
  assert.equal(report.newFiles.length, 0);
  assert.equal(report.failed.length, 0);
  assert.deepEqual(report.skipped.map((entry) => entry.reason).sort(), DEFAULT_DENY_EXTENSIONS.map((ext) => `blocked extension ${ext}`).sort());
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'downloads-manifest.json'))).entries, {});
  await assert.rejects(fs.access(path.join(root, 'downloads')), { code: 'ENOENT' });
}));

test('denylist checks the final sanitized server filename, including double extensions and trailing dots or spaces', () => temporary(async (root) => {
  for (const filename of ['lecture.pdf.EXE', 'lecture.pdf.exe. ', 'lecture.pdf.exe   ', 'lecture.pdf\u202e.exe']) {
    const report = await run(root, fixture(), async () => response('payload', { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${filename}"` }));
    assert.equal(report.newFiles.length, 0);
    assert.equal(report.skipped[0].reason, 'blocked extension .exe');
  }
  const safe = fixture();
  safe.course_materials[0].items[0].files[0].name = 'advertised.exe';
  const renamed = await run(root, safe, async () => response('%PDF-1.7\nsafe', { 'content-disposition': 'attachment; filename="safe.pdf"' }));
  assert.equal(renamed.newFiles.length, 1, 'actual safe server filename governs the decision');
}));

test('custom denyExtensions extends mandatory defaults; an empty override cannot allow executables', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items[0].files = ['blocked.foo', 'allowed.exe'].map((name) => ({ name, url: source.replace('notes.pdf', name) }));
  const report = await run(root, state, async () => response('payload', { 'content-type': 'application/octet-stream' }), { config: { downloads: { denyExtensions: ['FOO', '.fOo'] } } });
  assert.deepEqual(report.skipped.map((entry) => entry.reason), ['blocked extension .foo', 'blocked extension .exe']);
  assert.equal(report.newFiles.length, 0);
  await temporary(async (other) => {
    state.course_materials[0].items[0].files = [state.course_materials[0].items[0].files[1]];
    const allowed = await run(other, state, async () => response('payload', { 'content-type': 'application/octet-stream' }), { config: { downloads: { denyExtensions: [] } } });
    assert.equal(allowed.newFiles.length, 0);
  });
}));

test('invalid denyExtensions safely defaults and warns identically through config validation and direct sync', () => temporary(async (root) => {
  for (const invalid of [null, '.exe', [3], [''], ['*.exe'], ['.exe '], ['..exe']]) {
    const normalized = normalizeDenyExtensions(invalid);
    assert.deepEqual(normalized.extensions, DEFAULT_DENY_EXTENSIONS);
    assert.match(normalized.warning, /using the default/);
  }
  const config = validateConfig({ baseUrl: 'https://ys.learnus.org/', timezone: 'Asia/Seoul', profileDirectory: 'browser-profile', student: { displayName: 'Jane', authorNames: ['Jane'], searchTerms: ['Jane'] }, timeouts: { actionMs: 100, navigationMs: 100 }, downloads: { enabled: true, root: 'downloads', denyExtensions: 'bad' } }, root);
  assert.deepEqual(config.downloads.denyExtensions, DEFAULT_DENY_EXTENSIONS);
  const direct = await run(root, fixture(), async () => response(), { config: { downloads: { denyExtensions: 'bad' } } });
  assert.equal(direct.skipped[0].reason, config.downloads.denyExtensionsWarning);
  const validated = await run(root, fixture(), async () => response(), { config });
  assert.equal(validated.skipped[0].reason, direct.skipped[0].reason);
}));

test('macro documents remain allowed and carry MOTW; generated URL shortcuts bypass attachment denyExtensions', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items[0].files = ['.docm', '.xlsm', '.pptm'].map((ext) => ({ name: `macro${ext}`, url: source.replace('notes.pdf', `macro${ext}`) }));
  state.course_materials[0].items[0].files.push({ name: 'uploaded.url', url: source.replace('notes.pdf', 'uploaded.url') });
  state.course_materials[0].items[0].links = [{ name: 'Research', url: 'https://example.org/research' }];
  const marked = [];
  const report = await run(root, state, async () => response('PKmacro', { 'content-type': 'application/octet-stream' }), { config: { downloads: { denyExtensions: [...DEFAULT_DENY_EXTENSIONS, '.url'] } }, ops: { writeMotw: async (file, url) => marked.push({ file, url }) } });
  assert.equal(report.newFiles.length, 3);
  assert.equal(report.newLinks.length, 1);
  assert.ok(report.skipped.some((entry) => entry.reason === 'blocked extension .url'));
  assert.deepEqual(marked.filter(entry => entry.url).map((entry) => entry.url).sort(), [...state.course_materials[0].items[0].files.filter((entry) => !entry.name.endsWith('.url')).map((entry) => entry.url), 'https://example.org/research'].sort());
}));

test('configured instructors and course, group and announcement instructor names are unioned', () => temporary(async (root) => {
  const state = fixture();
  state.active_courses[0].instructorNames = ['Course Professor'];
  state.course_materials[0].instructorNames = ['Group Professor'];
  state.announcements = [{ course_id: 1, author: 'Announcement Professor', title: 'Notice' }];
  state.course_materials[0].items = [{ id: 99, type: 'board', name: 'Class Files', entries: ['Configured Professor', 'Course Professor', 'Group Professor', 'Announcement Professor'].map((author, index) => ({ id: index, title: author, author, url: `https://ys.learnus.org/mod/ubboard/article.php?id=99&bwid=${index}` })) }];
  const requested = [];
  const report = await run(root, state, async (url) => { requested.push(url); return htmlResponse('<main>No attachments</main>'); }, { config: { downloads: { instructorAuthors: { 1: ['Configured Professor'] } } } });
  assert.equal(requested.length, 4);
  assert.equal(report.skipped.some((entry) => /known instructor/.test(entry.reason)), false);
}));

test('Class Files and Korean materials boards match normalized known announcement instructors and refuse student, unknown or missing authors', () => temporary(async (root) => {
  const state = fixture();
  state.announcements = [{ course_id: 1, author: 'Professor Kim', title: 'Notice' }, { course_id: 2, author: 'Other Professor', title: 'Other course' }];
  for (const name of ['Class Files', '\uC790\uB8CC\uC2E4']) {
    state.course_materials[0].items = [{ id: 99, type: 'board', name, files: [{ name: 'unattributed.pdf', url: source }], entries: [
      { id: 1, title: 'Instructor', author: '\uFF30\uFF32\uFF2F\uFF26\uFF25\uFF33\uFF33\uFF2F\uFF32  kIm', url: 'https://ys.learnus.org/mod/ubboard/article.php?id=99&bwid=1' },
      { id: 2, title: 'Student', author: 'Professor Kim', author_role: 'student', url: 'https://ys.learnus.org/mod/ubboard/article.php?id=99&bwid=2' },
      { id: 3, title: 'Unknown teacher', author: 'Other Professor', author_role: 'teacher', url: 'https://ys.learnus.org/mod/ubboard/article.php?id=99&bwid=3' },
      { id: 4, title: 'Missing author', url: 'https://ys.learnus.org/mod/ubboard/article.php?id=99&bwid=4' },
    ] }];
    const requested = [];
    const report = await run(root, state, async (url) => { requested.push(url); return htmlResponse('<main><div class="text_to_html"><a href="https://example.org/handout">Handout</a></div></main>'); });
    assert.equal(requested.length, 1);
    assert.match(requested[0], /bwid=1/);
    assert.equal(report.failed.length, 0);
    assert.equal(report.skipped.filter((entry) => /author not a known instructor/.test(entry.reason)).length, 3);
    assert.ok(report.skipped.some((entry) => entry.reason === 'author not a known instructor: (missing)'));
    assert.equal(report.newFiles.length, 0, 'unattributed board aggregate attachments are not harvested');
  }
}));

test('boards with no instructor allowlist are skipped before any harvest, including entries claiming teacher roles', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items = [{ id: 1, type: 'board', name: 'Class Files', entries: [{ id: 1, author: 'Unknown', author_role: 'teacher', attachments: [{ name: 'notes.pdf', url: source }], url: 'https://ys.learnus.org/mod/ubboard/article.php?id=1&bwid=1' }] }];
  const report = await run(root, state, async () => assert.fail('untrusted board requested'));
  assert.equal(report.newFiles.length, 0);
  assert.equal(report.newLinks.length, 0);
  assert.match(report.skipped[0].reason, /no known instructor authors/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'downloads-manifest.json'))).entries, {});
}));

test('download root expands ~ and %VAR% and defaults outside the install folder', () => {
  const home = path.join(os.tmpdir(), 'home');
  const install = path.join(os.tmpdir(), 'install');
  assert.equal(resolveDownloadRoot('~/Documents/LearnUs', install, {}, home), path.join(home, 'Documents', 'LearnUs'));
  assert.equal(resolveDownloadRoot('%DL%/Courses', install, { DL: home }, home), path.join(home, 'Courses'));
  assert.equal(resolveDownloadRoot('downloads', install, {}, home), path.join(install, 'downloads'));
  assert.equal(resolveDownloadRoot('%MISSING%', install, {}, home), path.join(install, '%MISSING%'));
});

const downloaded = async (root) => (await fs.readdir(path.join(root, 'downloads'), { recursive: true, withFileTypes: true }).catch(() => [])).filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name)).sort();
const manifestOf = async (root) => JSON.parse(await fs.readFile(path.join(root, 'downloads-manifest.json'), 'utf8'));
const multi = (count) => { const state = fixture(); state.course_materials[0].items[0].files = Array.from({ length: count }, (_, i) => ({ name: `f${i}.pdf`, url: source.replace('notes.pdf', `f${i}.pdf`) })); return state; };
const fail = (status) => response('', {}, status);
const login = (location) => response('', { location }, 302);

test('identical existing files are adopted after a lost manifest instead of duplicated', () => temporary(async (root) => {
  const first = await run(root, fixture(), async () => response());
  const before = await downloaded(root);
  await fs.rm(path.join(root, 'downloads-manifest.json'));
  const second = await run(root, fixture(), async () => response());
  assert.deepEqual(await downloaded(root), before);
  assert.equal(second.newFiles.length, 0);
  assert.equal(second.skipped[0].reason, 'Already present locally; adopted.');
  assert.equal((await manifestOf(root)).entries[`1:${source}`].local_path, first.newFiles[0].local_path);
  // A same-named file with different content is still preserved and gets a suffixed name.
  await fs.rm(path.join(root, 'downloads-manifest.json'));
  const third = await run(root, fixture(), async () => response('%PDF-1.7\nother'));
  assert.equal(third.newFiles.length, 1);
  assert.notEqual(third.newFiles[0].local_path, first.newFiles[0].local_path);
  assert.equal(await fs.readFile(first.newFiles[0].local_path, 'utf8'), '%PDF-1.7\nfixture');
}));

for (const [name, text] of [['null', 'null'], ['array', '[]'], ['missing entries', '{"schema_version":1}'], ['string entries', '{"schema_version":1,"entries":"x"}'], ['array entries', '{"entries":[]}'], ['truncated JSON', '{"schema_version":1,"entries":{"a":'], ['empty file', '']]) {
  test(`corrupt manifest (${name}) is moved aside byte-identical and rebuilt`, () => temporary(async (root) => {
    await fs.writeFile(path.join(root, 'downloads-manifest.json'), text);
    const report = await run(root, fixture(), async () => response());
    assert.deepEqual(report.failed, [{ reason: 'Manifest was unreadable; moved aside and rebuilt.' }]);
    assert.equal(report.newFiles.length, 1);
    const aside = (await fs.readdir(root)).filter((n) => n.startsWith('downloads-manifest.json.corrupt-'));
    assert.equal(aside.length, 1);
    assert.match(aside[0], /^[\w.-]+$/);
    assert.equal(await fs.readFile(path.join(root, aside[0]), 'utf8'), text);
    assert.equal(Object.keys((await manifestOf(root)).entries).length, 1);
  }));
}
test('manifest with a UTF-8 BOM and no book_discovery is accepted as is', () => temporary(async (root) => {
  await fs.writeFile(path.join(root, 'downloads-manifest.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"schema_version":1,"entries":{}}')]));
  const report = await run(root, fixture(), async () => response());
  assert.equal(report.failed.length, 0);
  assert.equal(report.newFiles.length, 1);
  assert.deepEqual((await fs.readdir(root)).filter((n) => n.includes('corrupt')), []);
  assert.deepEqual((await manifestOf(root)).book_discovery, {});
}));

test('a live cross-process lock makes the run touch nothing; stale locks are replaced', () => temporary(async (root) => {
  const lock = path.join(root, 'downloads-manifest.json.lock');
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  const busy = await run(root, fixture(), async () => { throw new Error('must not request'); });
  assert.deepEqual(busy.skipped, [{ reason: 'Another download run is in progress.' }]);
  assert.equal(busy.ran, false);
  assert.equal(busy.status, 'skipped');
  assert.deepEqual(await fs.readdir(root), ['downloads-manifest.json.lock']);
  for (const stale of [{ pid: 2147483646, started_at: new Date().toISOString() }, { pid: process.pid, started_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() }, 'not json']) {
    await fs.rm(path.join(root, 'downloads'), { recursive: true, force: true });
    await fs.rm(path.join(root, 'downloads-manifest.json'), { force: true });
    await fs.writeFile(lock, typeof stale === 'string' ? stale : JSON.stringify(stale));
    const report = await run(root, fixture(), async () => response());
    assert.equal(report.newFiles.length, 1);
    assert.equal(await fs.access(lock).then(() => true, () => false), false);
  }
}));

test('lock identity rejects reused PIDs, expired and future locks while preserving live ownership', async () => {
  const now = Date.parse('2026-10-08T00:30:00Z');
  const started = Date.parse('2026-10-08T00:00:00Z');
  const lock = { pid: 123, token: 'owner', started_at: '2026-10-08T00:10:00Z', process_started_at: new Date(started).toISOString() };
  const ops = { now: () => now, pidAlive: async () => true, startTime: async () => started, maxAgeMs: 30 * 60000 };
  assert.equal(await lockHeld(JSON.stringify(lock), ops), true);
  assert.equal(await lockHeld(JSON.stringify(lock), { ...ops, startTime: async () => started + 60000 }), false, 'a new process with the same PID cannot own this lock');
  assert.equal(await lockHeld(JSON.stringify(lock), { ...ops, pidAlive: async () => false }), false);
  assert.equal(await lockHeld(JSON.stringify(lock), { ...ops, now: () => now + 10 * 60000 }), false, 'expiry uses the runner time limit');
  assert.equal(await lockHeld(JSON.stringify(lock), { ...ops, now: () => started }), false, 'future timestamps do not create immortal locks');
  assert.equal(await lockHeld(JSON.stringify({ ...lock, process_started_at: null }), { ...ops, startTime: async () => now }), false, 'legacy lock predating the live process is stale');
  assert.equal(await lockHeld(JSON.stringify(lock), { ...ops, startTime: async () => null }), true, 'unknown foreign process identity conservatively respects a recent live lock');
});

test('reused PID locks can be taken over and releasing an old token preserves its successor', () => temporary(async (root) => {
  const lockPath = path.join(root, 'downloads-manifest.json.lock');
  const now = Date.parse('2026-10-08T00:30:00Z');
  const started = now - 5000;
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'prior', started_at: new Date(now - 60000).toISOString(), process_started_at: new Date(now - 3600000).toISOString() }));
  const ops = { now: () => now, pidAlive: async () => true, startTime: async () => started };
  const token = await acquireLock(lockPath, ops);
  assert.ok(token);
  assert.match(JSON.parse(token).token, /^[0-9a-f]{32}$/);
  assert.equal(JSON.parse(token).process_started_at, new Date(started).toISOString());
  assert.equal(await acquireLock(lockPath, ops), null, 'the replacement live process owns the lock');
  await fs.writeFile(lockPath, 'successor-token');
  await releaseLock(lockPath, token);
  assert.equal(await fs.readFile(lockPath, 'utf8'), 'successor-token');
  await releaseLock(lockPath, 'successor-token');
  assert.deepEqual(await fs.readdir(root), []);
}));

test('default synchronization takes over an expired lock even when its PID is live', () => temporary(async (root) => {
  const lockPath = path.join(root, 'downloads-manifest.json.lock');
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'stale-reused-pid', started_at: new Date(Date.now() - 200 * 60000).toISOString() }));
  const report = await syncCourseDownloads({ installRoot: root, context: { request: { get: async () => response() } }, state: fixture(), config: { downloads: { root: 'downloads' } }, delayMs: 0 });
  assert.equal(report.newFiles.length, 1);
  assert.deepEqual(report.failed, []);
  assert.equal(await fs.access(lockPath).then(() => true, () => false), false);
}));

test('missing downloads configuration disables direct synchronization without locks or requests', () => temporary(async (root) => {
  const report = await syncCourseDownloads({ installRoot: root, context: { request: { get: async () => assert.fail('disabled downloads requested') } }, state: fixture(), config: {} });
  assert.equal(report.enabled, false);
  assert.deepEqual(report.newFiles, []);
  assert.deepEqual(await fs.readdir(root), []);
}));

test('an exhausted run time budget requests nothing further and defers files', () => temporary(async (root) => {
  let now = 0;
  const requests = [];
  const report = await run(root, multi(3), async (url) => { requests.push(url); return response(); }, { clock: () => (now += 30 * 60 * 1000) });
  assert.equal(requests.length, 0);
  assert.equal(report.skipped.length, 3);
  assert.ok(report.skipped.every((entry) => entry.reason === 'Run time budget reached; continues next run.'));
  assert.equal(report.failed.length, 0);
}));
test('a redirect to an external SSO page is session loss, not a link shortcut', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items.unshift({ type: 'url', name: 'Research', section: 'Week 2', id: 9, url: 'https://ys.learnus.org/mod/url/view.php?id=9' });
  const requests = [];
  const report = await run(root, state, async (url) => { requests.push(url); return login('https://infra.yonsei.ac.kr/sso/login?x'); });
  assert.equal(requests.length, 1);
  assert.equal(report.newLinks.length, 0);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].reason, /Session expired; redirected to login\./);
  assert.ok(report.skipped.some((entry) => entry.reason === 'Deferred after repeated failures; continues next run.'));
  assert.deepEqual(await downloaded(root), []);
  assert.equal((await manifestOf(root)).discovery_scopes['["1","material","9"]'].complete, false);
}));
test('an external link redirecting to its own sign-in page is a link, not session loss', () => temporary(async (root) => {
  const state = fixture();
  state.course_materials[0].items.unshift({ type: 'url', name: 'Zoom', section: 'Week 2', id: 9, url: 'https://ys.learnus.org/mod/url/view.php?id=9' });
  const report = await run(root, state, async (url) => url.includes('/mod/url/') ? login('https://zoom.example/signin?next=1') : response());
  assert.equal(report.newLinks.length, 1);
  assert.equal(report.newFiles.length, 1);
  assert.ok(!report.failed.some((entry) => /Session expired/.test(entry.reason)));
}));
test('a LearnUs login redirect or login page mid-run stops all later requests',() => temporary(async (root) => {
  let requests = [];
  let report = await run(root, multi(4), async (url) => { requests.push(url); return requests.length === 2 ? login('https://ys.learnus.org/login/index.php') : response(); });
  assert.equal(requests.length, 2);
  assert.equal(report.newFiles.length, 1);
  assert.equal(report.failed.length, 1);
  assert.equal(report.skipped.filter((entry) => entry.reason === 'Deferred after repeated failures; continues next run.').length, 2);
  await fs.rm(path.join(root, 'downloads-manifest.json'));
  requests = [];
  report = await run(root, multi(3), async (url) => { requests.push(url); return response('<html><form action="/login/index.php"><input name="username"></form></html>', { 'content-type': 'text/html' }); });
  assert.equal(requests.length, 1);
  assert.match(report.failed[0].reason, /Session expired/);
}));
test('4xx responses other than 408/429 are requested once; five consecutive failures stop the run', () => temporary(async (root) => {
  let requests = 0;
  const notFound = await run(root, fixture(), async () => { requests++; return fail(404); }, { retryDelayMs: 0 });
  assert.equal(requests, 1);
  assert.equal(notFound.failed[0].reason, 'Download HTTP 404.');
  // Dead links must not trip the breaker.
  requests = 0;
  await run(root, multi(7), async () => { requests++; return fail(404); }, { retryDelayMs: 0 });
  assert.equal(requests, 7);
  requests = 0;
  const report = await run(root, multi(8), async () => { requests++; return fail(500); }, { retryDelayMs: 0 });
  assert.equal(requests, 15);
  assert.equal(report.failed.filter((entry) => entry.reason === 'Download HTTP 500.').length, 5);
  assert.ok(report.failed.some((entry) => /5 consecutive request failures/.test(entry.reason)));
  assert.equal(report.skipped.filter((entry) => entry.reason === 'Deferred after repeated failures; continues next run.').length, 3);
  requests = 0;
  await run(root, multi(1), async () => { requests++; return fail(429); }, { retryDelayMs: 0 });
  assert.equal(requests, 3);
}));

test('a deleted local copy is restored in place when the content is unchanged, and versioned when it changed', () => temporary(async (root) => {
  const first = await run(root, fixture(), async () => response());
  const original = first.newFiles[0].local_path;
  await fs.rm(original);
  const restored = await run(root, fixture(), async () => response());
  assert.equal(restored.skipped[0].reason, 'Restored missing local copy.');
  assert.equal(restored.updated.length, 0);
  assert.equal(await fs.readFile(original, 'utf8'), '%PDF-1.7\nfixture');
  assert.deepEqual(await downloaded(root), [original]);
  assert.equal((await manifestOf(root)).entries[`1:${source}`].versions.length, 0);
  await fs.rm(original);
  const changed = await run(root, fixture(), async () => response('%PDF-1.7\nnew'));
  assert.equal(changed.updated.length, 1);
  assert.ok(changed.updated[0].local_path.includes('(updated 2026-10-08)'));
  assert.equal(changed.updated[0].versions.length, 1);
}));

test('writeNew sweeps only its own stale temp files', () => temporary(async (root) => {
  const dir = path.join(root, 'dir');
  await fs.mkdir(dir);
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  for (const name of ['.dl-0123456789abcdef.part', 'notes.part', '.dl-xyz.part', '.dl-0123456789abcdeg.part']) { await fs.writeFile(path.join(dir, name), 'x'); await fs.utimes(path.join(dir, name), old, old); }
  await fs.writeFile(path.join(dir, '.dl-fedcba9876543210.part'), 'x');
  await writeNew(path.join(dir, 'a.pdf'), Buffer.from('body'));
  assert.deepEqual((await fs.readdir(dir)).sort(), ['.dl-0123456789abcdeg.part', '.dl-fedcba9876543210.part', '.dl-xyz.part', 'a.pdf', 'notes.part']);
}));
test('writeNew falls back to an exclusive write where hard links are unsupported and never overwrites', () => temporary(async (root) => {
  const file = path.join(root, 'a.pdf');
  const flags = [];
  const ops = { link: async () => { throw Object.assign(new Error('no links'), { code: 'EPERM' }); }, writeFile: async (to, body, options) => { flags.push(options.flag); return fs.writeFile(to, body, options); } };
  await writeNew(file, Buffer.from('body'), ops);
  assert.equal(await fs.readFile(file, 'utf8'), 'body');
  assert.deepEqual(flags, ['wx']);
  assert.deepEqual(await fs.readdir(root), ['a.pdf']);
  await assert.rejects(writeNew(file, Buffer.from('other'), ops), /already exists/);
  assert.equal(await fs.readFile(file, 'utf8'), 'body');
  const other = path.join(root, 'b.pdf');
  await assert.rejects(writeNew(other, Buffer.from('x'), { link: async () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); } }), { code: 'ENOSPC' });
  assert.deepEqual((await fs.readdir(root)).sort(), ['a.pdf']);
}));

test('disk and permission errors get specific reasons and ENOSPC stops further downloads', () => temporary(async (root) => {
  for (const [code, reason] of [['ENOSPC', 'Disk is full.'], ['EACCES', 'Permission denied writing the file.'], ['EPERM', 'Permission denied writing the file.'], ['EBUSY', 'File is locked by another program.'], ['ENAMETOOLONG', 'Path too long.']]) assert.equal(errorReason(Object.assign(new Error('raw secret detail'), { code })), reason);
  assert.equal(errorReason(new Error('raw secret detail')), 'Download request or local file operation failed.');
  let requests = 0;
  const report = await run(root, multi(3), async () => { requests++; return response(); }, { ops: { link: async () => { throw Object.assign(new Error('disk'), { code: 'ENOSPC' }); } } });
  assert.equal(requests, 1);
  assert.deepEqual(report.failed, [{ course: item.course, title: 'Notes', reason: 'Disk is full.' }]);
  assert.equal(report.skipped.filter((entry) => entry.reason === 'Deferred after repeated failures; continues next run.').length, 2);
}));

test('a redirected Documents folder replaces ~/Documents in the download root', () => {
  const env = { LEARNUS_DOCUMENTS: 'D:\\OneDrive\\Documents' };
  const resolve = (root, vars = env) => resolveDownloadRoot(root, 'X:\\install', vars, 'H:\\home');
  assert.equal(resolve('~/Documents/LearnUs'), path.resolve('D:\\OneDrive\\Documents', 'LearnUs'));
  assert.equal(resolve('~\\documents\\LearnUs'), path.resolve('D:\\OneDrive\\Documents', 'LearnUs'));
  assert.equal(resolve('~/Documents'), path.resolve('D:\\OneDrive\\Documents'));
  assert.equal(resolve('~/DocumentsOther'), path.resolve('H:\\home', 'DocumentsOther'));
  assert.equal(resolve('~/Downloads/x'), path.resolve('H:\\home', 'Downloads', 'x'));
  assert.equal(resolve('~/Documents/LearnUs', {}), path.resolve('H:\\home', 'Documents', 'LearnUs'));
  assert.equal(resolve('~/Documents/LearnUs', { LEARNUS_DOCUMENTS: '' }), path.resolve('H:\\home', 'Documents', 'LearnUs'));
});

test('Content-Disposition forms: RFC 5987 with language tag, any case, quotes, precedence, stray percent and latin1 UTF-8', () => {
  const name = (disposition) => filenameFor('https://ys.learnus.org/pluginfile.php/1/x', { 'content-disposition': disposition }, 'fallback.bin');
  assert.equal(name("attachment; filename*=UTF-8'ko'%ED%95%9C%EA%B8%80.pdf"), '한글.pdf');
  assert.equal(name("attachment; FILENAME*=utf-8''%ED%95%9C%EA%B8%80.pdf"), '한글.pdf');
  assert.equal(name(`attachment; filename*="UTF-8''%ED%95%9C%EA%B8%80.pdf"`), '한글.pdf');
  assert.equal(name(`attachment; filename="plain.pdf"; filename*=UTF-8''%ED%95%9C.pdf`), '한.pdf');
  assert.equal(name('attachment; filename="100% notes.pdf"'), '100% notes.pdf');
  assert.equal(name('attachment; filename=plain.pdf'), 'plain.pdf');
  assert.equal(name(`attachment; filename="${Buffer.from('한글.pdf').toString('latin1')}"`), '한글.pdf');
  assert.equal(name(`attachment; filename="${Buffer.from('café.pdf', 'latin1').toString('latin1')}"`), 'café.pdf');
  assert.equal(filenameFor('https://ys.learnus.org/pluginfile.php/1/a%20b.pdf', {}, 'x'), 'a b.pdf');
});
test('names are NFC-normalised and bidi/zero-width controls cannot spoof an extension', () => {
  const rlo = String.fromCharCode(0x202e), zwsp = String.fromCharCode(0x200b);
  assert.equal(sanitizeName('한글'.normalize('NFD')), '한글');
  assert.equal(downloadPath('root', { ...item, course: item.course.normalize('NFD') }, 'a.pdf'), downloadPath('root', item, 'a.pdf'));
  assert.equal(sanitizeName(`abc${rlo}fdp.exe`), 'abcfdp.exe');
  assert.equal(path.basename(downloadPath('root', item, `x${rlo}fdp.exe`)), 'xfdp.exe');
  assert.equal(path.basename(downloadPath('root', item, `x.p${zwsp}df`)), 'x.pdf');
  assert.equal(sanitizeName(`${rlo}${zwsp}`), 'Untitled');
  assert.doesNotThrow(() => downloadPath('root', { ...item, category: 'announcement', date: 20261008 }, 'a.pdf'));
});

test('conditional headers are only sent when they are valid HTTP values', () => temporary(async (root) => {
  const withModified = (modified) => { const state = fixture(); state.course_materials[0].items[0].modified = modified; return state; };
  await run(root, withModified('2026년 10월 1일'), async () => response(undefined, { etag: '"é"' }));
  let sent;
  await run(root, withModified('2026년 10월 1일'), async (_, options) => { sent = options.headers; return response('', {}, 304); });
  assert.deepEqual(sent, {});
  await fs.rm(path.join(root, 'downloads-manifest.json'));
  await fs.rm(path.join(root, 'downloads'), { recursive: true });
  await run(root, fixture(), async () => response(undefined, { etag: '"ok"', 'last-modified': 'Wed, 01 Oct 2026 00:00:00 GMT' }));
  await run(root, fixture(), async (_, options) => { sent = options.headers; return response('', {}, 304); });
  assert.deepEqual(sent, { 'If-None-Match': '"ok"', 'If-Modified-Since': 'Wed, 01 Oct 2026 00:00:00 GMT' });
}));

test('an empty server file is skipped, not failed', () => temporary(async (root) => {
  const report = await run(root, fixture(), async () => response(''));
  assert.equal(report.failed.length, 0);
  assert.equal(report.skipped[0].reason, 'Empty file on server; skipped.');
  assert.deepEqual((await manifestOf(root)).entries, {});
}));
