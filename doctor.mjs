import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAppConfig } from './app-config.mjs';
import { validateConfig, resolveDownloadRoot } from './monitor-runtime.mjs';

export async function diagnose(file, { skipAuth = false } = {}) {
  const config = await loadAppConfig(file);
  validateConfig(config, config.dataDirectory);
  if (config.secondBrain.mode === 'obsidian') {
    for (const target of [config.dataDirectory, await resolveDownloadRoot(config.downloads, { installRoot: config.dataDirectory })]) {
      const relative = path.relative(config.secondBrain.vaultDirectory, target);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Keep monitor data and downloads outside the Obsidian vault.');
    }
  }
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20+ required.');
  await import('playwright-core').catch(() => { throw new Error('Run npm ci before monitoring.'); });
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const chrome = await Promise.all(roots.map(root => fs.access(path.join(root, 'Google/Chrome/Application/chrome.exe')).then(() => true, () => false)));
  if (process.platform === 'win32' && !chrome.some(Boolean)) throw new Error('Install Google Chrome for LearnUs authentication.');
  if (!skipAuth) for (const name of ['username.txt', 'password.dpapi']) await fs.access(path.join(config.authDirectory, name)).catch(() => { throw new Error('Credentials missing. Run setup.ps1.'); });
  return { ok: true, mode: config.secondBrain.mode, authentication_verified: false, portal_accessed: false, vault_accessed: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--config');
  diagnose(i < 0 ? path.join(path.dirname(fileURLToPath(import.meta.url)), 'monitor.config.json') : process.argv[i + 1], { skipAuth: process.argv.includes('--skip-auth') })
    .then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
