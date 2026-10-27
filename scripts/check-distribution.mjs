import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function inspectSource(file, content) {
  const findings = [];
  if (/(?:^|\/)(?:data|auth|browser-profile|reports|logs|backups|downloads)(?:\/|$)|(?:^|\/)(?:monitor\.config\.json|state\.json.*|announcement-history\.json.*|second-brain-course-map\.json|username\.txt|password\.dpapi|\.env(?:\..*)?)$|\.(?:pdf|docx?|pptx?|xlsx?|zip|mp3|mp4|db|sqlite3?)$/i.test(file)) findings.push({ file, rule: 'private/generated file must not be tracked' });
  const rules = [
    ['credential/key pattern', /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|01000000d08c9dd[f]/i],
    ...(!file.startsWith('test/') ? [['personal user path', /[A-Z]:[\\/]+Users[\\/]+[^\s'"<>]+/i]] : []),
  ];
  for (const [rule, pattern] of rules) if (pattern.test(content)) findings.push({ file, rule });
  return findings;
}

async function main() {
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const result = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' });
if (result.status !== 0) throw new Error('Run this check inside the clean source repository.');
const files = result.stdout.split('\0').filter(Boolean);
if (!files.length) throw new Error('Stage the intended source files before checking the snapshot.');
const findings = [];
for (const file of files) {
  const text = await fs.readFile(path.join(root, file), 'utf8');
  findings.push(...inspectSource(file, text));
}
console.log(JSON.stringify({ source_files: files.length, findings, note: 'Heuristic staged-file check; also review history, attribution, fixtures and clean-account behavior before publication. Matched values are never printed.' }, null, 2));
if (findings.length) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
