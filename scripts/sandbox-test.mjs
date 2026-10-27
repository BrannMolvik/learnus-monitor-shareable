import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.platform !== 'win32') throw new Error('This smoke test requires Windows, Chrome and Node.js.');
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'learnus-sandbox-'));
const output = path.join(source, 'artifacts', 'sandbox');
const started = Date.now();
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(LEARNUS_|OBSIDIAN_|OPENAI_|ANTHROPIC_|OLLAMA_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_PATH$|PSMODULEPATH$)/i.test(key)));
const json = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
async function powershell(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { cwd: root, env: { ...env, ...extraEnv }, windowsHide: true });
    let text = '';
    child.stdout.on('data', b => { text += b; }); child.stderr.on('data', b => { text += b; });
    child.on('error', reject); child.on('close', code => resolve({ code, text }));
  });
}
let passed = false;
const results = [];
try {
  for (const name of ['src', 'setup.ps1', 'monitor.config.example.json', 'run-lightweight-monitor.ps1']) await fs.cp(path.join(source, name), path.join(root, name), { recursive: true });
  await fs.symlink(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  const setup = await powershell(['-File', path.join(source, 'scripts/sandbox-setup.ps1'), '-Root', root]);
  assert.equal(setup.code, 0, setup.text);
  const configFile = path.join(root, 'monitor.config.json'), config = await json(configFile);
  assert.equal(config.secondBrain.mode, 'none');
  config.student.searchTerms = ['Example Student', 'Example', 'Student'];
  config.student.groupAliases = [{ course: 'Example Media', title: 'Class Group Blue' }];
  config.downloads.enabled = false;
  await fs.writeFile(configFile, JSON.stringify(config));
  const statePath = path.join(root, 'data/state.json');
  async function scan(scenario, dryRun = false) {
    const start = Date.now();
    console.log(`Sandbox scenario: ${scenario}`);
    const result = await powershell(['-File', path.join(root, 'run-lightweight-monitor.ps1'), '-NoPopup', ...(dryRun ? ['-DryRun'] : [])], {
      NODE_OPTIONS: `--import=${pathToFileURL(path.join(source, 'scripts/sandbox-browser.mjs')).href}`,
      LEARNUS_SANDBOX_ROOT: root, LEARNUS_SANDBOX_CASE: scenario,
    });
    const status = await json(path.join(root, 'data/logs/lightweight-last-run-status.json'));
    const traffic = await json(path.join(root, `traffic-${scenario}.json`)).catch(async error => {
      const log = await fs.readFile(status.log_file, 'utf8').catch(() => 'No scanner log was written.');
      throw new Error(`Browser did not record fixture traffic: ${status.error || error.message}\n${log.slice(-6000)}`);
    });
    assert.equal(traffic.real_lms_requests, 0); assert.deepEqual(traffic.blocked_requests, []);
    if (!['failure', 'rejected-login'].includes(scenario)) {
      const log = result.code === 0 ? '' : await fs.readFile(status.log_file, 'utf8').catch(() => 'No scanner log was written.');
      assert.equal(result.code, 0, JSON.stringify(status) + result.text + log);
      assert.equal(status.assignment_notification_error, null);
      assert.equal(status.second_brain_capture_error, null);
      assert.equal(status.second_brain_capture_succeeded, false);
    }
    else { assert.notEqual(result.code, 0); assert.equal(status.succeeded, false); }
    assert.equal(traffic.login_submissions, 1, 'The synthetic login form must actually be submitted.');
    assert.equal(status.codex_invoked, false);
    results.push({ scenario, passed: true, runtime_ms: Date.now() - start, mocked_page_requests: traffic.mocked_requests.length, scan_succeeded: status.scan_succeeded });
    return { state: await json(statePath), diff: await json(path.join(root, 'data/reports/latest-diff.json')), status };
  }
  const baseline = await scan('baseline');
  assert.equal(baseline.state.check_status.checked_courses, 2);
  assert.equal(baseline.state.scanner.metrics.board_listing_pages_checked, 12);
  assert.equal(baseline.state.scanner.metrics.board_search_pages_checked, 54);
  assert.equal(baseline.diff.baseline_established, true); assert.deepEqual(baseline.diff.meaningful_changes, []); assert.deepEqual(baseline.diff.completed_since_last_check, []);
  for (const id of ['board-11', 'board-12']) {
    const item = baseline.state.assignments.find(x => x.id === id);
    assert.equal(item.completed, true); assert.deepEqual(item.verification.pages_exhausted, [1, 2, 3, 4]); assert.match(item.submission_status, /page 4$/);
  }
  const group = baseline.state.assignments.find(x => x.id === 'board-13');
  assert.equal(group.group_submission_evidence.individual_completion_flag_available, false);
  assert.equal(baseline.state.assignments.find(x => x.id === 10).outstanding, true);
  assert.equal(baseline.state.deadlines.length, 1); assert.equal(baseline.state.announcements.length, 1);
  assert.equal(baseline.state.scanner.ollama_invoked, false);
  assert.equal((await json(path.join(root, 'data/reports/latest-assignment-notification.json'))).assignment_count, 1);
  const parsed = await powershell(['-File', path.join(source, 'scripts/sandbox-setup.ps1'), '-Root', root, '-ParseBrief']);
  assert.equal(parsed.code, 0, parsed.text);
  const repeat = await scan('repeat'); assert.deepEqual(repeat.diff.meaningful_changes, []); assert.deepEqual(repeat.diff.completed_since_last_check, []);
  const beforePreview = await fs.readFile(statePath);
  const preview = await scan('preview', true); assert.deepEqual(await fs.readFile(statePath), beforePreview); assert.equal(preview.status.state_updated, false); assert.ok(preview.diff.meaningful_changes.length > 0);
  const changed = await scan('changed');
  assert.equal(changed.diff.completed_since_last_check.length, 1);
  assert.equal(changed.state.announcements.length, 2);
  assert.equal((await json(path.join(root, 'data/reports/latest-assignment-notification.json'))).assignment_count, 0);
  assert.ok(changed.diff.meaningful_changes.some(x => x.type === 'announcement_changed'));
  assert.ok(changed.diff.meaningful_changes.some(x => /material/.test(x.type)));
  const successful = await fs.readFile(statePath);
  await scan('failure'); assert.deepEqual(await fs.readFile(statePath), successful);
  await scan('rejected-login'); assert.deepEqual(await fs.readFile(statePath), successful);
  await fs.mkdir(output, { recursive: true });
  for (const name of ['latest-brief.md', 'latest-diff.json', 'latest-report.txt']) await fs.copyFile(path.join(root, 'data/reports', name), path.join(output, name));
  const summary = { passed: true, runtime_ms: Date.now() - started, isolation: 'Temporary data/auth/profile; synthetic browser responses; not an OS VM or separate Windows user.', real_lms_accessed: false, real_credentials_used: false, codex_invoked: false, llm_invoked: false, scheduled_task_created: false, viewer_parser_passed: true, viewer_gui_tested: false, downloads_tested: false, results, resulting_diff: changed.diff };
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, resulting_diff: changed.diff.meaningful_changes, report_directory: output }, null, 2));
  passed = true;
} finally {
  if (passed) { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); }
  else console.error(`Sandbox failed; synthetic diagnostic files retained at ${root}`);
}
