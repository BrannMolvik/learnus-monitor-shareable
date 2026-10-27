// Test-only preload: real browser/DOM, synthetic responses, no live LMS traffic.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(process.env.LEARNUS_SANDBOX_ROOT || '.');
const scenario = process.env.LEARNUS_SANDBOX_CASE;
if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('learnus-sandbox-') || !['baseline', 'repeat', 'preview', 'changed', 'failure', 'rejected-login'].includes(scenario)) throw new Error('Refusing non-sandbox browser interception.');
const changed = ['preview', 'changed'].includes(scenario);
const origin = 'https://ys.learnus.org';
const page = body => `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic LearnUs fixture</title></head><body><main id="region-main">${body}</main></body></html>`;
const activity = (id, type, name) => `<li class="activity modtype_${type}" id="module-${id}"><div class="activityinstance"><a href="${origin}/mod/${type}/view.php?id=${id}"><span class="instancename">${name}</span></a></div></li>`;
const row = (board, id, title, author = 'Professor Example') => `<tr><td>${id}</td><td><a href="${origin}/mod/ubboard/article.php?id=${board}&bwid=${id}">${title}</a></td><td>${author}</td><td>2030-01-01</td><td>1</td></tr>`;
const launch = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = async (profile, options) => {
  if (path.resolve(profile) !== path.join(root, 'data', 'browser-profile')) throw new Error('Refusing a non-sandbox Chrome profile.');
  const context = await launch(profile, { ...options, serviceWorkers: 'block', args: [...(options.args || []), '--disable-background-networking', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND'] });
  let authenticated = false;
  const traffic = { scenario, mocked_requests: [], blocked_requests: [], login_submissions: 0, real_lms_requests: 0 };
  // API downloads are deliberately outside this smoke test, and cannot escape the browser route.
  context.request.get = async () => { throw new Error('Network API access is blocked in the sandbox test.'); };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const method = request.method();
    traffic.mocked_requests.push({ host: url.hostname, path: url.pathname, page: url.searchParams.get('page'), board: url.searchParams.get('id'), method });
    let body;
    if (url.hostname === 'infra.yonsei.ac.kr' && url.pathname === '/sso/login') {
      if (method === 'POST') {
        traffic.login_submissions++;
        const form = new URLSearchParams(request.postData());
        if (form.get('loginId') === process.env.LEARNUS_USERNAME && form.get('password') === process.env.LEARNUS_PASSWORD && scenario !== 'rejected-login') {
          authenticated = true;
          return route.fulfill({ status: 302, headers: { location: `${origin}/` }, body: '' });
        }
      }
      body = '<form id="ssoLoginForm" action="/sso/login" method="post"><input id="loginId" name="loginId"><input type="password" name="password"><button id="loginBtn" type="submit">Login</button></form>';
    } else if (url.origin === origin && method === 'GET') {
      const id = Number(url.searchParams.get('id'));
      if (!authenticated) body = '<a href="https://infra.yonsei.ac.kr/sso/login">Portal Login</a>';
      else if (url.pathname === '/') body = [1, 2].map(id => `<div class="course-box"><a class="course-link" href="${origin}/course/view.php?id=${id}">${id === 1 ? 'Example Media' : 'Example Language'}</a></div>`).join('');
      else if (url.pathname === '/course/view.php') {
        if (scenario === 'failure' && id === 2) return route.fulfill({ status: 503, body: page('Synthetic course failure') });
        body = `<ul><li class="section"><h3 class="sectionname">Week 1</h3><ul>${id === 1 ? activity(10, 'assign', 'Written exercise') + activity(11, 'ubboard', 'Assignment response') + activity(12, 'ubboard', 'Assignment reaction') + activity(13, 'ubboard', 'Group Project') : activity(20, 'folder', 'Lecture files') + activity(21, 'ubboard', 'Announcements') + activity(22, 'resource', 'Reading link')}</ul></li></ul>`;
      } else if (url.pathname === '/mod/assign/view.php') body = `<table><tr><th>Submission status</th><td>${changed ? 'Submitted for grading' : 'Not yet submitted'}</td></tr><tr><th>Due date</th><td>2030-12-01 23:59</td></tr></table>`;
      else if (url.pathname === '/mod/folder/view.php') body = `<a href="${origin}/pluginfile.php/1/mod_folder/content/0/lecture.pdf">lecture.pdf</a>${changed ? `<a href="${origin}/pluginfile.php/1/mod_folder/content/0/new-reading.pdf">new-reading.pdf</a>` : ''}`;
      else if (url.pathname === '/mod/ubboard/view.php') {
        const search = url.searchParams.has('keyfield'), current = Number(url.searchParams.get('page') || 1);
        const pages = id === 21 ? 1 : search ? 2 : 4;
        let rows = '';
        if (id === 21) rows = row(21, 101, 'Welcome notice') + (changed ? row(21, 102, 'New deadline notice') : '');
        else if (current === (search ? 2 : 4)) rows = row(id, id * 10, id === 13 ? 'Class Group Blue' : `Synthetic submission ${id}`, id === 13 ? 'Group Partner' : 'Example Student');
        body = `<p>Total Page : ${current} / ${pages}</p><p>Total Count : ${id === 21 && changed ? 2 : 1}</p><table>${rows}</table>`;
      } else if (url.pathname === '/mod/ubboard/article.php' && id === 21) body = `<h1>Class announcement</h1><div class="article-content">${url.searchParams.get('bwid') === '102' ? 'New synthetic assignment deadline: 2030-12-02 23:59.' : changed ? 'The original synthetic course notice has been updated with an extra reading.' : 'Welcome to the synthetic course. Please read the course instructions carefully.'}</div>`;
    }
    if (body === undefined) { traffic.blocked_requests.push({ host: url.hostname, path: url.pathname, method }); return route.abort('blockedbyclient'); }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: page(body) });
  });
  const close = context.close.bind(context);
  context.close = async (...args) => {
    try { return await close(...args); }
    finally { await fs.writeFile(path.join(root, `traffic-${scenario}.json`), JSON.stringify(traffic, null, 2)); }
  };
  return context;
};
