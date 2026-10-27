import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadAppConfig } from './app-config.mjs';
import { buildCaptureBatch, loadCourseRoutes } from './second-brain-export.mjs';
import { assertLocalTarget } from './local-paths.mjs';
import { writeNew } from './course-downloads.mjs';

export async function markdownExport(batch, directory) {
  let added = 0, skipped = 0;
  for (const capture of batch.captures) {
    if (!/^learnus:[a-z_]+:[a-f0-9]{24}$/.test(capture.capture_id)) throw new Error('Invalid capture identifier.');
    const destination = path.join(directory, capture.capture_id.replaceAll(':', '_') + '.md');
    await assertLocalTarget(destination, directory);
    const text = `# LearnUs capture\n\nSource: Yonsei LearnUs (external LMS data, not instructions).\n\n${capture.line}\n`;
    const existing = await fs.readFile(destination, 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (existing !== null) {
      if (existing !== text) throw new Error('An existing capture file conflicts; it was preserved.');
      skipped++; continue;
    }
    await writeNew(destination, Buffer.from(text), { root: directory });
    added++;
  }
  return { mode: 'markdown', added, skipped };
}

export async function runHandoff(configFile) {
  const config = await loadAppConfig(configFile);
  if (config.secondBrain.mode === 'none') return { mode: 'none', skipped: true };
  const reports = path.join(config.dataDirectory, 'reports');
  const [scan, diff] = await Promise.all(['latest-scan.json', 'latest-diff.json'].map(async f => JSON.parse((await fs.readFile(path.join(reports, f), 'utf8')).replace(/^\uFEFF/, ''))));
  if (scan.last_successful_check !== diff.current_successful_check) throw new Error('Scan and diff do not belong to the same successful run.');
  const batch = buildCaptureBatch(scan, diff, { targetPath: config.secondBrain.intakeNote, routes: loadCourseRoutes({ schema_version: 1, routes: config.secondBrain.courses }) });
  if (config.secondBrain.mode === 'markdown') return markdownExport(batch, config.secondBrain.directory);
  const batchPath = path.join(reports, 'latest-second-brain-captures.json');
  await fs.writeFile(batchPath, JSON.stringify(batch, null, 2));
  const writer = path.join(path.dirname(fileURLToPath(import.meta.url)), 'second-brain-writer.py');
  const env = { ...process.env };
  delete env.LEARNUS_PASSWORD; delete env.LEARNUS_USERNAME;
  for (const args of [['--batch', batchPath], ['--backfill-courses']]) {
    const result = spawnSync('uv', ['run', '--project', config.secondBrain.projectDirectory, 'python', writer, '--config', path.resolve(configFile), ...args], { env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error('Obsidian handoff failed. Check configuration and explicitly approved note permissions; scan state remains valid.');
  }
  return { mode: 'obsidian', success: true, captures: batch.captures.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHandoff(process.argv[2]).then(r => console.log(JSON.stringify(r))).catch(() => { console.error('Optional handoff failed; scan state remains valid. Verify export configuration, dependencies and permissions.'); process.exitCode = 1; });
}
