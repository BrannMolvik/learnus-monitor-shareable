import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile as executeFile } from 'node:child_process';
import { promisify } from 'node:util';

const defaultExecFile = promisify(executeFile);
function expandEnvironment(value, env) {
  const variables = new Map(Object.entries(env).map(([key, entry]) => [key.toUpperCase(), entry]));
  return value.replace(/%([^%]+)%/g, (match, key) => variables.get(key.toUpperCase()) ?? match);
}

export async function resolveDocumentsDirectory({ platform = process.platform, env = process.env,
  homedir = os.homedir(), execFile = defaultExecFile } = {}) {
  const paths = platform === 'win32' ? path.win32 : path;
  const fallback = paths.join(homedir, 'Documents');
  if (platform !== 'win32') return fallback;
  try {
    const result = await execFile('reg.exe', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Personal'],
    { encoding: 'utf8', timeout: 2000, windowsHide: true });
    const stdout = typeof result === 'string' ? result : result.stdout;
    const value = String(stdout).match(/^\s*Personal\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/im)?.[1];
    if (!value) return fallback;
    const expanded = expandEnvironment(value, env);
    return !/%[^%]+%/.test(expanded) && paths.isAbsolute(expanded) ? paths.normalize(expanded) : fallback;
  } catch { return fallback; }
}

export async function resolveDownloadRoot(downloads = {}, options = {}) {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? path.win32 : path;
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir();
  const configured = downloads.root?.trim();
  // The portable example follows the user's actual Documents Known Folder.
  const documentsSuffix = configured?.match(/^~[\\/]Documents(?:[\\/](.*))?$/i);
  if (configured && !documentsSuffix) {
    return paths.resolve(options.installRoot ?? process.cwd(), expandEnvironment(configured.replace(/^~(?=$|[\\/])/, homedir), env));
  }
  const documents = env.LEARNUS_DOCUMENTS?.trim() || await resolveDocumentsDirectory({ ...options, platform, env, homedir });
  return paths.join(documents, documentsSuffix ? (documentsSuffix[1] || '') : 'LearnUs');
}

export function isYonseiSsoUrl(value) {
  try { return new URL(value).hostname === 'infra.yonsei.ac.kr'; }
  catch { return false; }
}

export function isSessionLossUrl(value) {
  try {
    const url = new URL(value);
    return isYonseiSsoUrl(url) ||
      (url.hostname === 'ys.learnus.org' && url.pathname.startsWith('/login/'));
  } catch { return false; }
}

export async function isLoggedOut(page) {
  if (isSessionLossUrl(page.url())) return true;
  return page.getByText('Portal Login', { exact: true }).isVisible().catch(() => false);
}

export async function assertAuthenticatedPage(page) {
  if (await isLoggedOut(page)) {
    const error = new Error('redirected to Yonsei login');
    error.code = 'SESSION_LOST';
    throw error;
  }
}

export const normalizeName = (value) => String(value ?? '').normalize('NFKD')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toUpperCase();

export const DEFAULT_DENY_EXTENSIONS = Object.freeze([
  '.exe', '.msi', '.msp', '.bat', '.cmd', '.com', '.scr', '.pif', '.cpl', '.ps1', '.psm1', '.psd1',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.lnk', '.dll', '.sys', '.reg', '.jar',
  '.msc', '.gadget', '.appx', '.msix', '.url',
]);
export function normalizeDenyExtensions(value) {
  if (value === undefined) return { extensions: [...DEFAULT_DENY_EXTENSIONS], warning: null };
  if (!Array.isArray(value) || value.some((ext) => typeof ext !== 'string' || !/^\.?[a-z0-9]+$/i.test(ext))) {
    return { extensions: [...DEFAULT_DENY_EXTENSIONS], warning: 'Invalid downloads.denyExtensions; using the default blocked extensions.' };
  }
  return { extensions: [...new Set([...DEFAULT_DENY_EXTENSIONS, ...value.map((ext) => `.${ext.replace(/^\./, '').toLowerCase()}`)])], warning: null };
}

export function courseNameFromRaw(raw, prior) {
  if (prior?.name) return prior.name;
  // Dashboard category labels may have spaces. Preserve NEW in actual course titles.
  return String(raw ?? '').replace(/\s+/g, ' ').trim()
    .replace(/^(?:Regular\s*(?:Grad|Univ)|Irregular)\s*/i, '')
    .replace(/\s*\([^()]+\)\s*\((?:1st|2nd) Semester\).*$/i, '')
    .replace(/\s+My Rate\s+[\d.]+%.*$/i, '').trim();
}

export async function readJson(filePath, missingValue) {
  try {
    return JSON.parse((await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT' && missingValue !== undefined) return missingValue;
    throw error;
  }
}

export function emptyState() {
  return {
    schema_version: 3, last_successful_check: null,
    active_courses: [], assignments: [], required_activities: [],
    announcements: [], announcement_boards: [], deadlines: [], course_materials: [],
  };
}

export function validateConfig(config, root) {
  if (config.baseUrl !== 'https://ys.learnus.org/') throw new Error('Only https://ys.learnus.org/ is supported.');
  if (config.timezone !== 'Asia/Seoul') throw new Error('This monitor uses Asia/Seoul time.');
  if (!config.student?.displayName?.trim() || /YOUR NAME/i.test(config.student.displayName)) {
    throw new Error('Run setup.ps1 to configure your student identity first.');
  }
  if (!Array.isArray(config.student.searchTerms) || !config.student.searchTerms.length ||
      config.student.searchTerms.some((term) => typeof term !== 'string' || !term.trim())) {
    throw new Error('student.searchTerms must contain nonempty student name searches.');
  }
  if (!Array.isArray(config.student.authorNames) || !config.student.authorNames.length ||
      config.student.authorNames.some((name) => typeof name !== 'string' || !name.trim())) {
    throw new Error('student.authorNames must contain your full LearnUs writer name(s).');
  }
  for (const alias of config.student.groupAliases || []) {
    if (!alias?.course?.trim() || !alias?.title?.trim()) {
      throw new Error('Each confirmed group alias must specify both course and title.');
    }
  }
  if (!config.profileDirectory?.trim()) throw new Error('profileDirectory is required.');
  config.profileDirectory = path.resolve(root, config.profileDirectory);
  config.downloads = { enabled: false, maxFileMB: 300, skipExtensions: ['.mp4', '.mkv', '.mov'], maxFilesPerRun: 200, ...config.downloads };
  const deny = normalizeDenyExtensions(config.downloads.denyExtensions);
  config.downloads.denyExtensions = deny.extensions;
  if (deny.warning) config.downloads.denyExtensionsWarning = deny.warning;
  if (typeof config.downloads.enabled !== 'boolean' || (config.downloads.root !== undefined &&
      (typeof config.downloads.root !== 'string' || !config.downloads.root.trim()))) throw new Error('Invalid downloads configuration.');
  for (const key of ['maxFileMB', 'maxFilesPerRun']) {
    if (!Number.isFinite(config.downloads[key]) || config.downloads[key] <= 0) throw new Error(`Invalid downloads.${key}`);
  }
  if (!Number.isInteger(config.downloads.maxFilesPerRun) || !Array.isArray(config.downloads.skipExtensions) || config.downloads.skipExtensions.some((ext) => typeof ext !== 'string' || !/^\.[a-z0-9]+$/i.test(ext))) throw new Error('Invalid downloads limits or skipExtensions.');
  if (config.downloads.includeQnA !== undefined && typeof config.downloads.includeQnA !== 'boolean') throw new Error('downloads.includeQnA must be true or false.');
  if (config.downloads.instructorAuthors !== undefined) {
    const authors = config.downloads.instructorAuthors;
    if (!authors || typeof authors !== 'object' || Array.isArray(authors) || Object.getPrototypeOf(authors) !== Object.prototype ||
        Object.entries(authors).some(([courseId, names]) => !/^[1-9]\d*$/.test(courseId) || !Number.isSafeInteger(Number(courseId)) ||
          !Array.isArray(names) || !names.length || names.some((name) => typeof name !== 'string' || !name.trim()))) {
      throw new Error('downloads.instructorAuthors must map positive course IDs to nonempty full author-name arrays.');
    }
  }
  for (const key of ['actionMs', 'navigationMs']) {
    if (!Number.isFinite(config.timeouts?.[key]) || config.timeouts[key] <= 0) throw new Error(`Invalid timeout: ${key}`);
  }
  config.announcementSummaries = { enabled: false, ...config.announcementSummaries };
  for (const section of [config.translation, config.announcementSummaries]) {
    if (section?.enabled !== undefined && typeof section.enabled !== 'boolean') throw new Error('Model enabled flags must be booleans.');
    if (!section?.enabled) continue;
    const endpoint = new URL(section.ollamaUrl || 'http://127.0.0.1:11434/api/generate');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.protocol !== 'http:') {
      throw new Error('Ollama must use a local HTTP loopback endpoint.');
    }
    section.timeoutMs ??= 20000;
    if (!Number.isFinite(section.timeoutMs) || section.timeoutMs <= 0 || section.timeoutMs > 60000) {
      throw new Error('Ollama timeoutMs must be between 1 and 60000.');
    }
  }
  return config;
}

export function isAnnouncementArticleUrl(actual, expected) {
  try {
    const a = new URL(actual), e = new URL(expected);
    return a.origin === e.origin && a.pathname === e.pathname && ['id', 'bwid'].every(k => a.searchParams.get(k) === e.searchParams.get(k));
  } catch { return false; }
}

export function isValidAnnouncementBody(item) {
  return Boolean(item?.body?.trim()) && !(item.body_extraction_method === 'region-main-fallback' &&
    /Skip to main content|Your progress|Course Summary|Sorry, this activity is currently hidden/i.test(item.body));
}

export function isStudentAuthor(author, student) {
  const value = normalizeName(author);
  // Searches may be broad, but completion requires an exact full writer-name match.
  return value.length > 0 && student.authorNames.some((name) => normalizeName(name) === value);
}

export function baselineComparison(previous, assignmentResult, announcementChanges, materialChanges) {
  if (!previous.last_successful_check) return { meaningful: [], completed: [], baselineEstablished: true };
  return {
    meaningful: [...assignmentResult.changes, ...announcementChanges, ...materialChanges],
    completed: assignmentResult.completed,
    baselineEstablished: false,
  };
}
