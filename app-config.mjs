import fs from 'node:fs/promises';
import path from 'node:path';

export function notePath(value, course = false) {
  if (typeof value !== 'string' || !value.endsWith('.md') || value.includes('\\') || /[:\x00-\x1f]/.test(value) ||
      value.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p)) ||
      (course && !value.startsWith('Courses/'))) throw new Error('Use a safe vault-relative Markdown note path.');
  return value;
}

export function appConfig(raw, installRoot) {
  if (!raw || raw.schemaVersion !== 1) throw new Error('Unsupported configuration. Run setup.ps1; existing settings were not changed.');
  for (const key of ['dataDirectory', 'authDirectory']) if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key].trim())) throw new Error(`Invalid ${key}.`);
  const notifications = { enabled: true, popup: true, ...raw.notifications };
  if (typeof notifications.enabled !== 'boolean' || typeof notifications.popup !== 'boolean') throw new Error('Notification settings must be booleans.');
  const dataDirectory = path.resolve(installRoot, raw.dataDirectory || 'data');
  const authDirectory = path.resolve(dataDirectory, raw.authDirectory || 'auth');
  const integration = { mode: 'none', directory: 'exports', intakeNote: 'AI Inbox/LearnUs Intake.md', courses: [], ...raw.secondBrain };
  if (!['none', 'markdown', 'obsidian'].includes(integration.mode)) throw new Error('secondBrain.mode must be none, markdown or obsidian.');
  notePath(integration.intakeNote);
  if (!Array.isArray(integration.courses)) throw new Error('secondBrain.courses must be an array.');
  const aliases = new Map();
  for (const route of integration.courses) {
    notePath(route?.path, true);
    if (!Array.isArray(route.aliases) || !route.aliases.length || route.aliases.some(v => typeof v !== 'string' || !v.trim())) throw new Error('Each course route needs nonempty aliases.');
    for (const alias of route.aliases) {
      const key = alias.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (aliases.has(key) && aliases.get(key) !== route.path) throw new Error('Conflicting course routes.');
      aliases.set(key, route.path);
    }
  }
  if (integration.mode === 'markdown') {
    if (typeof integration.directory !== 'string' || !integration.directory.trim()) throw new Error('Select a Markdown export directory.');
    integration.directory = path.resolve(dataDirectory, integration.directory);
  }
  if (integration.mode === 'obsidian') {
    for (const key of ['projectDirectory', 'vaultDirectory']) {
      if (typeof integration[key] !== 'string' || !path.isAbsolute(integration[key])) throw new Error(`secondBrain.${key} must be an explicit absolute path.`);
      integration[key] = path.resolve(integration[key]);
    }
  }
  return { ...raw, dataDirectory, authDirectory, secondBrain: integration,
    notifications };
}

export async function loadAppConfig(file) {
  const raw = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  return appConfig(raw, path.dirname(path.resolve(file)));
}
