import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { isSessionLossUrl, isYonseiSsoUrl, isLoggedOut, assertAuthenticatedPage, isAnnouncementArticleUrl, isValidAnnouncementBody } from '../src/monitor-runtime.mjs';

// Main has installation-specific top-level reads. Load only its function
// declarations so these fixtures cannot start Chrome or access private data.
const source = await fs.readFile(new URL('../src/learnus-monitor.mjs', import.meta.url), 'utf8');
function declaration(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `missing ${name}`);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  assert.ok(next >= 0, `missing end of ${name}`);
  return source.slice(start, start + 1 + next);
}
function harness() {
  const errors = [];
  const metrics = { courses_checked: 0, announcement_articles_checked: 0, announcement_articles_failed: 0, announcement_bodies_captured: 0, material_pages_checked: 0, files_listed: 0 };
  const counts = [];
  const landingWaits = [];
  const sandbox = {
    config: { timeouts: { navigationMs: 1000 } }, errors, metrics,
    countPage: kind => counts.push(kind), assertAuthenticatedPage, isLoggedOut, isYonseiSsoUrl, isAnnouncementArticleUrl, isValidAnnouncementBody, URL,
    process: { env: { LEARNUS_USERNAME: 'fixture-user', LEARNUS_PASSWORD: 'fixture-password' } },
    normalizeAnnouncementBody: value => String(value || '').trim(), FOLDER_TREE_WAIT_MS: 1500,
    waitForLearnUsLanding: async (_page, timeout) => landingWaits.push(timeout),
  };
  vm.createContext(sandbox);
  vm.runInContext(['goto', 'authenticate', 'scanCourseHome', 'scanAnnouncementArticle', 'listedAgain', 'scanFolder'].map(declaration).join('\n'), sandbox);
  return { ...sandbox, counts, landingWaits };
}
function fakePage(url, { visible = false, navigationError = null, status = 200 } = {}) {
  return {
    extractionCalls: 0,
    goto: async () => {
      if (navigationError) throw navigationError;
      return { status: () => status };
    },
    url: () => url,
    getByText: () => ({ isVisible: async () => visible }),
    async evaluate() {
      this.extractionCalls += 1;
      return { body: 'An actual announcement body.', attachments: [], extraction_method: 'fixture' };
    },
  };
}

test('session-loss URLs recognize exact SSO host and local login paths', () => {
  for (const url of ['https://infra.yonsei.ac.kr/sso/login', 'https://ys.learnus.org/login/index.php', 'https://ys.learnus.org/login/?next=course']) {
    assert.equal(isSessionLossUrl(url), true, url);
  }
  for (const url of ['https://ys.learnus.org/', 'https://ys.learnus.org/course/view.php?id=1', 'https://ys.learnus.org/passni/spLoginProcess.php', 'https://ys.learnus.org/loginish/', 'https://example.org/login/', 'https://infra.yonsei.ac.kr.example.org/', 'https://ys.learnus.org/?next=infra.yonsei.ac.kr', 'invalid']) {
    assert.equal(isSessionLossUrl(url), false, url);
  }
  assert.equal(isYonseiSsoUrl(new URL('https://infra.yonsei.ac.kr/sso/')), true);
  assert.equal(isYonseiSsoUrl('https://ys.learnus.org/login/index.php'), false);
});

test('visible Portal Login detects logout even at a course URL; invisible control is allowed', async () => {
  assert.equal(await isLoggedOut(fakePage('https://ys.learnus.org/course/view.php?id=1', { visible: true })), true);
  assert.equal(await isLoggedOut(fakePage('https://ys.learnus.org/course/view.php?id=1')), false);
  await assert.rejects(assertAuthenticatedPage(fakePage('https://ys.learnus.org/login/index.php')), { code: 'SESSION_LOST' });
});

for (const [label, url, options] of [
  ['local login', 'https://ys.learnus.org/login/index.php', {}],
  ['SSO login', 'https://infra.yonsei.ac.kr/sso/login', {}],
  ['Portal Login', 'https://ys.learnus.org/course/view.php?id=1', { visible: true }],
]) {
  test(`goto aborts ${label} rather than treating a course as checked`, async () => {
    const h = harness();
    await assert.rejects(h.goto(fakePage(url, options), 'https://ys.learnus.org/course/view.php?id=1', 'course_home'), /course_home failed.*redirected to Yonsei login/);
    assert.equal(h.errors.length, 1);
  });
  test(`announcement article aborts ${label} before extracting or archiving login text`, async () => {
    const h = harness();
    const page = fakePage(url, options);
    await assert.rejects(h.scanAnnouncementArticle(page, { url: 'https://ys.learnus.org/mod/ubboard/article.php?bwid=2' }), /announcement_article failed.*redirected to Yonsei login/);
    assert.equal(page.extractionCalls, 0);
    assert.equal(h.metrics.announcement_articles_failed, 0);
    assert.equal(h.errors.length, 1);
  });
}

test('announcement redirect followed by navigation timeout still aborts the scan', async () => {
  const h = harness();
  const page = fakePage('https://ys.learnus.org/login/index.php', { navigationError: new Error('navigation timeout') });
  await assert.rejects(h.scanAnnouncementArticle(page, { url: 'https://ys.learnus.org/mod/ubboard/article.php?bwid=2' }), /redirected to Yonsei login/);
  assert.equal(page.extractionCalls, 0);
  assert.equal(h.errors.length, 1);
});

test('course redirected to local login is not checked and login content is never extracted', async () => {
  const h = harness();
  const page = fakePage('https://ys.learnus.org/login/index.php');
  await assert.rejects(h.scanCourseHome(page, { id: 1, url: 'https://ys.learnus.org/course/view.php?id=1' }), /redirected to Yonsei login/);
  assert.equal(h.metrics.courses_checked, 0);
  assert.equal(page.extractionCalls, 0);
});

test('authenticated navigation and article extraction retain their successful behavior', async () => {
  const h = harness();
  const page = fakePage('https://ys.learnus.org/course/view.php?id=1');
  await h.goto(page, page.url(), 'course_home');
  const article = await h.scanAnnouncementArticle(page, { url: page.url() });
  assert.equal(article.body, 'An actual announcement body.');
  assert.equal(article.error, null);
  assert.equal(h.errors.length, 0);
  assert.equal(h.metrics.announcement_bodies_captured, 1);
});

test('ordinary authenticated article failures remain recoverable', async () => {
  const h = harness();
  const article = await h.scanAnnouncementArticle(fakePage('https://ys.learnus.org/mod/ubboard/article.php?bwid=2', { status: 404 }), { url: 'https://ys.learnus.org/mod/ubboard/article.php?bwid=2' });
  assert.equal(article.error, 'HTTP 404');
  assert.equal(h.metrics.announcement_articles_failed, 1);
  assert.equal(h.errors.length, 0);
});

test('listedAgain clears preservation markers and retains assignment evidence', () => {
  const h = harness();
  const prior = { id: 3, outstanding: true, currently_listed: false, preservation_note: 'absent', submission_status: 'Not submitted' };
  const result = h.listedAgain(prior);
  assert.equal(result.currently_listed, undefined);
  assert.equal(result.preservation_note, undefined);
  assert.equal(result.outstanding, true);
  assert.equal(result.submission_status, 'Not submitted');
  assert.equal(prior.currently_listed, false);
});

test('authentication may visit login and SSO before accepting the completed session', async () => {
  const h = harness();
  h.config.baseUrl = 'https://ys.learnus.org/';
  let current = 'https://ys.learnus.org/login/index.php';
  const page = {
    goto: async () => {},
    url: () => current,
    getByText: () => ({
      isVisible: async () => current.includes('/login/'),
      click: async () => { current = 'https://infra.yonsei.ac.kr/sso/'; },
    }),
    locator: selector => ({
      fill: async () => {},
      first: () => ({ fill: async () => {} }),
      click: async () => { current = 'https://ys.learnus.org/passni/spLoginProcess.php'; },
    }),
    waitForURL: async predicate => {
      if (predicate(new URL(current))) return;
      current = 'https://ys.learnus.org/';
      assert.equal(predicate(new URL(current)), true);
    },
    waitForLoadState: async () => {},
  };
  await h.authenticate(page);
  assert.equal(current, 'https://ys.learnus.org/');
  assert.equal(h.landingWaits.length, 2);
});

test('authentication rejects local login even when Portal Login is not visible', async () => {
  const h = harness();
  h.config.baseUrl = 'https://ys.learnus.org/';
  await assert.rejects(h.authenticate(fakePage('https://ys.learnus.org/login/index.php')), /LearnUs still shows Portal Login/);
});

test('empty folder without a tree container skips the wait; a tree waits at most the short bound', async () => {
  for (const [hasTree, expectedWaits] of [[false, 0], [true, 1]]) {
    const h = harness();
    const waits = [];
    const page = {
      goto: async () => ({ status: () => 200 }), url: () => 'https://ys.learnus.org/mod/folder/view.php?id=1',
      getByText: () => ({ isVisible: async () => false }),
      waitForSelector: async (selector, options) => { waits.push(options.timeout); throw new Error('timeout'); },
      evaluate: async (fn) => (String(fn).includes('foldertree') ? hasTree : []),
    };
    assert.deepEqual(await h.scanFolder(page, { url: 'https://ys.learnus.org/mod/folder/view.php?id=1' }), []);
    assert.equal(waits.length, expectedWaits);
    for (const timeout of waits) assert.ok(timeout <= 1500);
  }
});
