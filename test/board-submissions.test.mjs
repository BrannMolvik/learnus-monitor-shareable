import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { normalizeName, isStudentAuthor } from '../monitor-runtime.mjs';

const source = await fs.readFile(new URL('../learnus-monitor.mjs', import.meta.url), 'utf8');
function declaration(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, start + 1 + next);
}
const course = { id: 1, name: 'Example Course' };

test('only an explicitly empty board may omit page totals', async () => {
  for (const [body, expected] of [
    ['Total Count : 0 No registered post.', 1],
    ['Total Count : 0', null],
    ['Total Count : 1 No registered post.', null],
    ['No registered post.', null],
    ['Total Count : 5 Total Page : 1 / 3', 3],
  ]) {
    const parse = vm.runInNewContext(`(${declaration('parseBoardPage')})`, { document: { body: { innerText: body }, querySelectorAll: () => [] } });
    const page = { evaluate: fn => fn() };
    if (expected === null) await assert.rejects(parse(page), /pagination/);
    else assert.equal((await parse(page)).totalPages, expected);
  }
});
const activity = { id: 2, name: 'Example board assignment', url: 'https://ys.learnus.org/mod/ubboard/view.php?id=2' };
function harness(own = true, alias = false) {
  const visited = [];
  const sandbox = { URL, isStudentAuthor, normalize: normalizeName,
    config: { student: { displayName: 'Example Student', authorNames: ['Example Student'], searchTerms: ['Example Student', 'Example', 'Student'], groupAliases: alias ? [{ course: course.name, title: 'Example Group' }] : [] } },
    previousAssignment: () => null, listedAgain: x => x || {}, parseBoardDue: () => null, isOverdue: () => false,
    metrics: { board_listing_pages_checked: 0, board_search_pages_checked: 0 },
    goto: async (_page, url) => visited.push(new URL(url)),
    parseBoardPage: async () => {
      const current = visited.at(-1), search = current.searchParams.has('keyfield'), page = Number(current.searchParams.get('page') || 1);
      return { totalPages: search ? 2 : 4, totalCount: 4,
        rows: !search && page === 4 ? [{ entry_id: 44, author: own ? 'Example Student' : 'Other Student', title: alias ? 'Example Group' : 'Synthetic submission', url: 'https://ys.learnus.org/mod/ubboard/article.php?id=2&bwid=44', posted_on: '2026-10-01' }] : [] };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(['exhaustBoardPages', 'configuredGroupAliases', 'findVerifiedGroupSubmission', 'scanBoardAssignment'].map(declaration).join('\n'), sandbox);
  return { sandbox, visited };
}

test('own submission on page four is found after all listings and all nine paginated searches', async () => {
  const { sandbox: h, visited } = harness();
  const result = await h.scanBoardAssignment({}, course, activity);
  assert.equal(result.completed, true); assert.equal(result.outstanding, false);
  assert.equal(result.submission_entry_id, 44);
  assert.match(result.submission_status, /page 4$/);
  assert.equal(visited.length, 4 + 9 * 2);
  assert.equal(result.verification.search_result_pages.length, 9);
});

test('confirmed group on a later page retains evidence without inventing an individual flag', async () => {
  const { sandbox: h } = harness(false, true);
  const result = await h.scanBoardAssignment({}, course, activity);
  assert.equal(result.status_certainty, 'verified_group_alias');
  assert.equal(result.group_submission_evidence.individual_completion_flag_available, false);
});

test('missing match is only reported after all available listing and search pages', async () => {
  const { sandbox: h, visited } = harness(false);
  const result = await h.scanBoardAssignment({}, course, activity);
  assert.equal(result.outstanding, true); assert.equal(result.completed, false);
  assert.equal(visited.length, 22);
  h.parseBoardPage = async () => ({ totalPages: NaN, rows: [] });
  await assert.rejects(h.exhaustBoardPages({}, activity.url, 'listing'), /pagination/);
});

test('explicit not-yet-submitted states are not mistaken for completion', async () => {
  for (const status of ['Not submitted', 'Not yet submitted', 'Not completed', 'No attempt', 'Submitted for grading']) {
    const sandbox = { goto: async () => {}, metrics: { assignment_pages_checked: 0 }, previousAssignment: () => null, listedAgain: () => ({}), parseDateTime: () => null, isOverdue: () => false };
    vm.createContext(sandbox); vm.runInContext(declaration('scanDirectAssignment'), sandbox);
    const result = await sandbox.scanDirectAssignment({ evaluate: async () => ({ submission_status: status, body: status }) }, course, activity);
    assert.equal(result.completed, status === 'Submitted for grading', status);
    assert.equal(result.outstanding, status !== 'Submitted for grading', status);
  }
});
