import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { isStudentAuthor, normalizeName, normalizeDenyExtensions, resolveDownloadRoot as runtimeResolveDownloadRoot } from './monitor-runtime.mjs';
import { assertLocalTarget } from './local-paths.mjs';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Expands a leading ~ and %VAR% so the root can live in the user's Documents folder.
export function resolveDownloadRoot(root, installRoot, env = process.env, home = os.homedir()) {
  let expanded = String(root).replace(/%([^%]+)%/g, (match, name) => env[name] ?? match);
  // OneDrive Known Folder Move can put Documents somewhere other than ~/Documents.
  if (typeof env.LEARNUS_DOCUMENTS === 'string' && env.LEARNUS_DOCUMENTS && /^~[\/\\]Documents(?=$|[\/\\])/i.test(expanded)) expanded = env.LEARNUS_DOCUMENTS + expanded.slice(11);
  expanded = expanded.replace(/^~(?=$|[\/\\])/, home);
  return path.resolve(installRoot, expanded);
}
const exists = async (file) => fs.access(file).then(() => true, () => false);
export function isPathInDownloadRoot(file, root) {
  if (typeof file !== 'string' || !file) return false;
  const relative = path.relative(path.resolve(root), path.resolve(root, file));
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
const SESSION_EXPIRED = 'Session expired; redirected to login.';
const DEFERRED = 'Deferred after repeated failures; continues next run.';
const BUDGET = 'Run time budget reached; continues next run.';
export const DRY_RUN_MESSAGE = 'Dry run does not open item pages (view.php/article.php) because opening them can mark items viewed in LearnUs; only directly known file links are listed.';
const CODE_REASONS = { ENOSPC: 'Disk is full.', EACCES: 'Permission denied writing the file.', EPERM: 'Permission denied writing the file.', EBUSY: 'File is locked by another program.', ENAMETOOLONG: 'Path too long.' };
export function errorReason(error) {
  const message = String(error?.message || '');
  if (CODE_REASONS[error?.code]) return CODE_REASONS[error.code];
  const http = message.match(/Download HTTP (\d{3})\./);
  if (http) return http[0];
  const safeMessages = ['Unsafe or external download redirect blocked.', 'Request cap reached.', 'File exceeds maxFileMB.', 'Too many redirects.', 'Login page returned during discovery.', 'External file redirect blocked.', 'Empty download.', 'Rejected HTML/login/error response.', 'Invalid PDF magic bytes.', 'Invalid archive/document magic bytes.', 'Invalid document magic bytes.', 'Local destination already exists; preserved.', 'Download root is too long for safe Windows paths.', SESSION_EXPIRED, DEFERRED];
  if (safeMessages.includes(message)) return message;
  if (/timeout|timed out/i.test(message)) return 'Download request timed out.';
  return 'Download request or local file operation failed.';
}
// Bidi/zero-width controls can spoof an extension (RLO) or make visually identical names differ.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
export function sanitizeName(value, limit = 70) {
  let name = String(value || 'Untitled').normalize('NFC').replace(INVISIBLE, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!name) name = 'Untitled';
  if (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
  limit = Math.max(1, Math.floor(limit));
  if (name.length > limit) name = limit <= 11 ? hash(name).slice(0, limit) : `${name.slice(0, limit - 11).replace(/[\uD800-\uDBFF]$/, '')}-${hash(name).slice(0, 10)}`;
  return name.replace(/[. ]+$/g, '');
}
export function downloadPath(root, item, filename, suffix = '') {
  const course = sanitizeName(item.course_folder || item.course, 70);
  const folders = item.category === 'announcement' ? ['Announcements', `${String(item.date || 'Undated').slice(0, 10)} ${item.title}`]
    : item.category === 'assignment' ? ['Assignments', item.title] : [item.section || 'General'];
  const dir = path.join(root, course, ...folders.map((name) => sanitizeName(name, 45)));
  const original = path.basename(path.win32.basename(String(filename))).replace(INVISIBLE, '');
  const ext = path.extname(original).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 15);
  // The temporary file has its own short basename in this same directory.
  const budget = 239 - dir.length - 1 - ext.length - suffix.length;
  if (budget < 1 || dir.length + 26 >= 240) throw new Error('Download root is too long for safe Windows paths.');
  const stem = sanitizeName(path.basename(original, path.extname(original)), budget);
  const result = path.join(dir, `${stem}${suffix}${ext}`);
  if (result.length >= 240) throw new Error('Download root is too long for safe Windows paths.');
  return result;
}
export function safeLearnUsUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://ys.learnus.org' && !url.username && !url.password &&
      !/vod|xncommons|assignsubmission|\/submission(?:\/|_)|\/login\/|completion|\/submit|\/edit|\/delete/i.test(url.pathname) &&
      ![...url.searchParams.keys()].some((key) => /sesskey|token|password|action|edit|delete|submit|completion/i.test(key));
  } catch { return false; }
}
function externalUrl(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && u.origin !== 'https://ys.learnus.org' && !/[\r\n]/.test(decodeURIComponent(value)) && ![...u.searchParams.keys()].some((key) => /password|access_token|auth_token|sesskey/i.test(key)); } catch { return false; }
}
export function validateDownload(body, headers, maxBytes, filename = '') {
  if (!body.length) throw new Error('Empty download.');
  if (body.length > maxBytes || Number(headers['content-length'] || 0) > maxBytes) throw new Error('File exceeds maxFileMB.');
  const beginning = body.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/html/i.test(headers['content-type'] || '') || /^(?:<!doctype\s+html|<html|<head|<body|<form)/i.test(beginning) || /<(?:html|form)\b[^>]*>[\s\S]*(?:login|password|로그인)/i.test(beginning)) {
    const disposition = headers['content-disposition'] || '';
    const declared = filenameFor('https://ys.learnus.org/', headers, '');
    const uploadedHtml = /\.html?$/i.test(filename) && /^(?:attachment|inline)\s*;/i.test(disposition) && /\bfilename\*?=/i.test(disposition) && declared === filename;
    const loginOrError = /\btype\s*=\s*["']?password\b|\bname\s*=\s*["']?(?:password|username)\b|\/login\/|<title\b[^>]*>[^<]*(?:login|sign\s*in|로그인)|\b(?:errorcode|errorbox|alert-danger|accessdenied)\b/i;
    if (!uploadedHtml || loginOrError.test(body.toString('utf8'))) throw new Error('Rejected HTML/login/error response.');
  }
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf' && !body.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('Invalid PDF magic bytes.');
  if (['.zip', '.docx', '.xlsx', '.pptx', '.hwpx'].includes(ext) && !body.subarray(0, 2).equals(Buffer.from('PK'))) throw new Error('Invalid archive/document magic bytes.');
  if (['.doc', '.xls', '.ppt', '.hwp'].includes(ext) && !body.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) throw new Error('Invalid document magic bytes.');
}
export function linkShortcut(url) {
  if (!externalUrl(url)) throw new Error('Unsafe external shortcut URL.');
  return `[InternetShortcut]\r\nURL=${url}\r\n`;
}
export function linksIndex(entries) {
  const cell = (v) => String(v || '').replace(/[|\r\n]/g, ' ');
  return '# Course links\n\n| Title | URL | Section | First seen |\n| --- | --- | --- | --- |\n' + entries.filter((e) => e.kind === 'link').sort((a, b) => a.source_url.localeCompare(b.source_url)).map((e) => `| ${cell(e.title)} | ${cell(e.source_url)} | ${cell(e.section)} | ${cell(e.first_seen)} |`).join('\n') + '\n';
}
function decodeHtml(value) {
  return String(value).replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, dec) => { const code = parseInt(hex || dec, hex ? 16 : 10); return code <= 0x10ffff ? String.fromCodePoint(code) : ''; })
    .replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}
function htmlLinks(html, base) {
  const links = [];
  for (const match of html.matchAll(/<(?:a|iframe|object|embed)\b[^>]*\b(?:href|src|data)\s*=\s*["']([^"']+)["'][^>]*>([^<]*)/gi)) {
    try { links.push({ url: new URL(decodeHtml(match[1]), base).href, name: decodeHtml(match[2]).trim() }); } catch {}
  }
  return links;
}
// Find complete containers, including nested divs, without collecting site navigation.
function contentContainers(html, marker) {
  const results = [];
  const tags = [...html.matchAll(/<\/?([a-z][\w-]*)\b[^>]*>/gi)];
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (tag[0].startsWith('</') || !marker.test(tag[0])) continue;
    let depth = 1;
    for (let j = i + 1; j < tags.length; j++) {
      if (tags[j][1].toLowerCase() !== tag[1].toLowerCase()) continue;
      depth += tags[j][0].startsWith('</') ? -1 : /\/>$/.test(tags[j][0]) ? 0 : 1;
      if (!depth) { results.push(html.slice(tag.index + tag[0].length, tags[j].index)); break; }
    }
    if (/^<a\b/i.test(tag[0])) results.push(tag[0] + '</a>');
  }
  return results.join('\n');
}
// Moodle themes mark the main column as #region-main or role="main"; site chrome lives outside it.
function mainRegion(html) {
  return contentContainers(html, /\b(?:id\s*=\s*["']region-main["']|role\s*=\s*["']main["'])/i);
}
function resourceContent(html) {
  const main = mainRegion(html);
  return contentContainers(main || html, /\b(?:class|id)\s*=\s*["'][^"']*\b(?:book_content|mod_introbox|intro|page-content|generalbox|no-overflow|ubboard-content|ubboard_content|article-content|article_content|board-content|board_content|post-content|post_content|text_to_html|posting)\b[^"']*["']/i);
}
function instructionContent(html) {
  return contentContainers(html, /\b(?:class|id)\s*=\s*["'][^"']*\b(?:mod_introbox|intro|assignmentintro)\b[^"']*["']/i);
}
function urlResourceLinks(html, base) {
  const result = htmlLinks(contentContainers(html, /\b(?:class|id)\s*=\s*["'][^"']*\b(?:urlworkaround|externalurl)\b[^"']*["']/i), base);
  for (const tag of html.matchAll(/<[a-z][^>]*>/gi)) for (const attr of tag[0].matchAll(/\b([\w-]+)\s*=\s*(["'])(.*?)\2/gs)) {
    const value = decodeHtml(attr[3]);
    let target = /^(?:data-)?externalurl$/i.test(attr[1]) ? value : value.match(/["']externalurl["']\s*:\s*["']([^"']+)/i)?.[1];
    if (!target) continue;
    target = target.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/\\u003a/gi, ':');
    try { result.push({ url: new URL(target, base).href, name: '' }); } catch {}
  }
  return result;
}
function instructorConfirmed(entry, trusted) {
  const role = String(entry.author_role || entry.author_evidence?.role || '').trim().toLowerCase();
  if (/student|learner|학생|수강생/.test(role)) return false;
  const author = normalizeName(entry.author).replace(/\s/g, '');
  return Boolean(author) && trusted.has(author);
}
function videoResource(filename, headers = {}) {
  return /\.(?:mp4|mkv|mov|webm|avi|m4v|wmv|flv|mpeg|mpg|ts|m3u8|mpd)(?:$|[?#])/i.test(filename || '') || /^(?:video\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i.test(headers['content-type'] || '');
}
// Percent-decode only when valid, so a literal "100% notes.pdf" survives.
const decodeKeep = (value) => { try { return decodeURIComponent(value); } catch { return value; } };
// UTF-8 bytes that arrived as latin1 characters (common for raw Korean filename="...") are re-decoded.
function fixMojibake(value) {
  if (!/[^\x00-\x7f]/.test(value) || /[^\x00-\xff]/.test(value)) return value;
  const redecoded = Buffer.from(value, 'latin1').toString('utf8');
  return !redecoded.includes(String.fromCharCode(0xFFFD)) && redecoded !== value && /[^\x00-\x7f]/.test(redecoded) ? redecoded : value;
}
export function filenameFor(url, headers, fallback) {
  const disposition = headers['content-disposition'] || '';
  const encoded = disposition.match(/filename\*\s*=\s*"?[^'";]*'[^'";]*'([^";]+)/i)?.[1];
  const plain = disposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  const urlName = new URL(url).pathname.split('/').pop();
  if (encoded) return decodeKeep(encoded.trim());
  const plainName = plain?.[1] || plain?.[2]?.trim();
  if (plainName) return fixMojibake(decodeKeep(plainName));
  return decodeKeep((/\.php$/i.test(urlName) ? fallback : urlName) || fallback);
}
const CONTENT_TYPE_EXTENSIONS = {
  'application/pdf': '.pdf', 'application/msword': '.doc', 'application/vnd.ms-powerpoint': '.ppt', 'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx', 'application/zip': '.zip', 'application/x-zip-compressed': '.zip',
  'application/x-hwp': '.hwp', 'application/haansofthwp': '.hwp', 'application/vnd.hancom.hwp': '.hwp', 'application/vnd.hancom.hwpx': '.hwpx',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'text/plain': '.txt', 'text/csv': '.csv',
};
// Boards sometimes serve a file literally called "attachment". Prefer a real name, then the link text, then the MIME type.
function nameWithExtension(name, linkText, headers = {}) {
  if (path.extname(name)) return name;
  if (path.extname(String(linkText || ''))) return path.basename(path.win32.basename(String(linkText)));
  const ext = CONTENT_TYPE_EXTENSIONS[String(headers['content-type'] || '').split(';')[0].trim().toLowerCase()];
  return ext ? `${name}${ext}` : name;
}
const GENERIC_NAME = /^(?:attachment|download|file|첨부파일?)$/i;
// forcedownload is a presentation hint: the same file listed with and without it is one file.
function canonicalFileUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin === 'https://ys.learnus.org' && /pluginfile\.php|\/download\.php/i.test(url.pathname)) url.searchParams.delete('forcedownload');
    return url.href;
  } catch { return value; }
}
// Board articles embed a hidden password-confirm modal, so a password input alone is not a login page.
function looksLikeLogin(html) {
  return /\baction\s*=\s*["'][^"']*\/login\/(?:index\.php)?["'?]/i.test(html) || (/type=["']password/i.test(html) && /\bname=["']username["']/i.test(html));
}
const QNA_BOARD = /Q\s*&\s*A|질의응답/i;
// Only our own stale temp files (crash leftovers) are ever removed.
async function sweepOrphans(dir) {
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!/^\.dl-[0-9a-f]{16}\.part$/.test(name)) continue;
    const orphan = path.join(dir, name);
    const info = await fs.stat(orphan).catch(() => null);
    if (info?.isFile() && Date.now() - info.mtimeMs > 24 * 60 * 60 * 1000) await fs.unlink(orphan).catch(() => {});
  }
}
// Unsupported alternate data streams are harmless; downloads remain usable on non-NTFS storage.
export async function writeMotw(file, sourceUrl, { platform = process.platform, writeFile = fs.writeFile } = {}) {
  if (platform !== 'win32' || !sourceUrl) return;
  try { await writeFile(`${file}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${String(sourceUrl).replace(/[\r\n]/g, '')}\r\n`, 'utf8'); } catch {}
}
// exFAT/FAT32/some SMB shares cannot hard-link; an exclusive write still never overwrites.
const LINK_FALLBACK = ['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV'];
export async function writeNew(file, body, ops = {}, sourceUrl = '') {
  if (ops.root) await assertLocalTarget(file, ops.root);
  const { link, writeFile, writeMotw: mark } = { link: fs.link, writeFile: fs.writeFile, writeMotw, ...ops };
  const temp = path.join(path.dirname(file), `.dl-${crypto.randomBytes(8).toString('hex')}.part`);
  if (file.length >= 240 || temp.length >= 240) throw new Error('Download root is too long for safe Windows paths.');
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (ops.root) await assertLocalTarget(file, ops.root);
  await sweepOrphans(path.dirname(file));
  if (await exists(file)) throw new Error('Local destination already exists; preserved.');
  try {
    await fs.writeFile(temp, body, { flag: 'wx' });
    await mark(temp, sourceUrl).catch(() => {});
    // link is atomic and fails if the destination exists, unlike rename on POSIX.
    try { await link(temp, file); } catch (e) {
      if (!LINK_FALLBACK.includes(e.code)) throw e;
      await writeFile(file, body, { flag: 'wx' });
      await mark(file, sourceUrl).catch(() => {});
    }
  } finally { await fs.unlink(temp).catch(() => {}); }
}

const LOCK_MAX_AGE_MS = 90 * 60 * 1000;
const CURRENT_PROCESS_STARTED_AT = Math.floor(Date.now() - process.uptime() * 1000);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// No subprocess lookup: foreign live PIDs rely on the bounded lock age unless a caller supplies an identity probe.
const processStartTime = (pid) => pid === process.pid ? CURRENT_PROCESS_STARTED_AT : null;
export async function lockHeld(raw, { now = Date.now, pidAlive: alive = pidAlive, startTime = processStartTime, maxAgeMs = LOCK_MAX_AGE_MS } = {}) {
  try {
    const lock = JSON.parse(raw);
    const pid = Number(lock?.pid);
    const startedAt = Date.parse(lock?.started_at);
    const age = now() - startedAt;
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(age) || age < 0 || age >= maxAgeMs || !await alive(pid)) return false;
    const started = await startTime(pid);
    if (started === null || started === undefined) return true; // Preserve a live lock when the OS cannot identify it.
    const actualStart = typeof started === 'number' ? started : Date.parse(started);
    const recordedStart = Date.parse(lock.process_started_at);
    if (Number.isFinite(recordedStart)) return actualStart === recordedStart;
    // Legacy locks lack a process fingerprint. A process born after the lock cannot own it.
    return !Number.isFinite(actualStart) || actualStart <= startedAt;
  } catch { return false; }
}
// Returns a unique ownership token; dead, reused-PID and expired locks can be replaced.
export async function acquireLock(lockPath, ops = {}) {
  const now = ops.now ?? Date.now;
  const started = await (ops.startTime ?? processStartTime)(process.pid);
  const token = JSON.stringify({ pid: process.pid, token: crypto.randomBytes(16).toString('hex'), started_at: new Date(now()).toISOString(), process_started_at: started == null ? null : new Date(started).toISOString() });
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await fs.writeFile(lockPath, token, { flag: 'wx' }); return token; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const raw = await fs.readFile(lockPath, 'utf8').catch(() => null);
      if (raw === null) continue;
      if (await lockHeld(raw, ops)) return null;
      if (await fs.readFile(lockPath, 'utf8').catch(() => null) === raw) await fs.unlink(lockPath).catch(() => {});
    }
  }
  return null;
}
export async function releaseLock(lockPath, token) {
  if (await fs.readFile(lockPath, 'utf8').catch(() => null) === token) await fs.unlink(lockPath).catch(() => {});
}
export async function syncCourseDownloads(params) {
  const { installRoot, dryRun = false, config } = params;
  if (dryRun || !config.downloads || ('enabled' in config.downloads && !config.downloads.enabled)) return syncLocked(params);
  const lockPath = path.join(installRoot, 'downloads-manifest.json.lock');
  const blank = { generated_at: params.now ?? new Date().toISOString(), dry_run: false, enabled: true, newFiles: [], newLinks: [], updated: [], wouldDownload: [], skipped: [], failed: [] };
  let token;
  const timeoutMinutes = Number(process.env.LEARNUS_RUNNER_TIMEOUT_MINUTES);
  const maxAgeMs = Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes * 60000 : LOCK_MAX_AGE_MS;
  try { await fs.mkdir(installRoot, { recursive: true }); token = await acquireLock(lockPath, { maxAgeMs, ...params.lockOps }); } catch { return { ...blank, ran: false, status: 'failed', reason: 'Download lock could not be created.', failed: [{ reason: 'Download lock could not be created.' }] }; }
  if (!token) return { ...blank, ran: false, status: 'skipped', reason: 'Another download run is in progress.', skipped: [{ reason: 'Another download run is in progress.' }] };
  try { return await syncLocked(params); } finally { await releaseLock(lockPath, token); }
}
const IMF_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
// A scanned LearnUs date (possibly Korean text) is not an HTTP date; non-ASCII header values make the request throw.
const conditionalHeaders = (prior) => ({ ...(/^[\x20-\x7e]+$/.test(String(prior.etag || '')) ? { 'If-None-Match': prior.etag } : {}), ...(IMF_DATE.test(String(prior.modified || '')) ? { 'If-Modified-Since': prior.modified } : {}) });
const fileHash = (file) => fs.readFile(file).then(hash, () => null);
// Only Yonsei SSO counts: an ordinary external link that happens to redirect to its own sign-in page must not halt the run.
const SSO_PATH = /(?:^|[\/._-])(?:sso|login|signin|saml|oauth2?|cas|auth)(?:$|[\/._-])/i;
const loginRedirect = (destination) => { const u = new URL(destination); return u.origin === 'https://ys.learnus.org' ? /\/login\//i.test(u.pathname) : /(?:^|\.)yonsei\.ac\.kr$/i.test(u.hostname) && SSO_PATH.test(u.pathname); };
const LOCAL_ERROR = /cap|Unsafe|exceeds|Video\/lecture|Session expired/;
const clientError = (message) => { const code = Number(String(message).match(/Download HTTP (\d{3})\./)?.[1]); return code >= 400 && code < 500 && code !== 408 && code !== 429; };

async function syncLocked({ context, state, config, installRoot, dryRun = false, now = new Date().toISOString(), delayMs = 200, retryDelayMs = 500, deadlineMs = 25 * 60 * 1000, clock = Date.now, ops }) {
  const options = { enabled: Boolean(config.downloads), maxFileMB: 300, maxFilesPerRun: 200, skipExtensions: ['.mp4', '.mkv', '.mov'], ...config.downloads };
  options.maxFilesPerRun = Math.min(200, Math.max(1, Math.floor(Number(options.maxFilesPerRun) || 200)));
  const report = { generated_at: now, dry_run: dryRun, enabled: options.enabled, ...(dryRun ? { dry_run_limited: true, dry_run_message: DRY_RUN_MESSAGE } : {}), newFiles: [], newLinks: [], updated: [], wouldDownload: [], skipped: [], failed: [] };
  if (!options.enabled) return report;
  const deny = normalizeDenyExtensions(options.denyExtensions);
  options.denyExtensions = deny.extensions;
  if (deny.warning || options.denyExtensionsWarning) report.skipped.push({ reason: deny.warning || options.denyExtensionsWarning });
  const root = await runtimeResolveDownloadRoot(options, { installRoot });
  ops = { ...ops, root };
  const manifestPath = path.join(installRoot, 'downloads-manifest.json');
  const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  let manifest = { schema_version: 1, entries: {} };
  let raw = null;
  try { raw = await fs.readFile(manifestPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') { report.failed.push({ reason: 'Manifest could not be read; downloads preserved.' }); return report; } }
  if (raw !== null) {
    let parsed = null;
    try { parsed = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); } catch {}
    if (isPlain(parsed) && isPlain(parsed.entries)) { manifest = parsed; if (!isPlain(manifest.book_discovery)) manifest.book_discovery = {}; }
    else if (dryRun) report.failed.push({ reason: 'Manifest was unreadable; would be moved aside and rebuilt.' });
    else {
      try { await fs.rename(manifestPath, `${manifestPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`); } catch { report.failed.push({ reason: 'Manifest could not be read; downloads preserved.' }); return report; }
      report.failed.push({ reason: 'Manifest was unreadable; moved aside and rebuilt.' });
    }
  }
  // A changed root starts fresh for escaped entries. Never read, restore or adopt a prior root's files.
  for (const [key, entry] of Object.entries(manifest.entries)) {
    if (!isPathInDownloadRoot(entry?.local_path, root) || entry.kind !== 'link' && options.denyExtensions.includes(path.extname(entry.local_path).toLowerCase())) { delete manifest.entries[key]; continue; }
    entry.local_path = path.resolve(root, entry.local_path);
    await assertLocalTarget(entry.local_path, root);
    if (Array.isArray(entry.versions)) entry.versions = entry.versions.filter((version) => isPathInDownloadRoot(version?.local_path, root));
  }
  // Run budget and session breaker: once halted, no further requests are made this run.
  const startedAt = clock();
  let halted = null;
  let failures = 0;
  const stopReason = () => halted || (clock() - startedAt >= deadlineMs ? BUDGET : null);
  const seen = new Set();
  const discovered = [];
  let requests = 0;
  const scopes = new Map();
  manifest.book_discovery ||= {};
  const chapterScope = (item, url) => `${item.discovery_scope}:chapter:${url}`;
  const scopeKey = (courseId, category, id) => JSON.stringify([String(courseId), category, String(id)]);
  function scopeItem(item, id, complete = true) {
    const scope = scopeKey(item.course_id, item.category, id);
    scopes.set(scope, complete && scopes.get(scope) !== false);
    return { ...item, discovery_scope: scope };
  }
  const maxBytes = options.maxFileMB * 1024 * 1024;
  async function get(url, headers = {}, inspect = false) {
    if (halted) throw new Error(DEFERRED);
    try { const result = await fetchWithRetry(url, headers, inspect); failures = 0; return result; } catch (e) {
      if (clientError(e.message)) failures = 0;
      else if (!LOCAL_ERROR.test(e.message) && ++failures >= 5 && !halted) { halted = DEFERRED; report.failed.push({ reason: 'Stopped after 5 consecutive request failures.' }); }
      throw e;
    }
  }
  const sessionLost = () => { halted = DEFERRED; return new Error(SESSION_EXPIRED); };
  async function fetchWithRetry(url, headers, inspect) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let current = url;
        for (let redirect = 0; redirect < 6; redirect++) {
          if (!safeLearnUsUrl(current)) throw new Error('Unsafe or external download redirect blocked.');
          if (videoResource(new URL(current).pathname)) throw new Error('Video/lecture stream skipped.');
          if (++requests > options.maxFilesPerRun * 5) throw new Error('Request cap reached.');
          await pause(delayMs);
          const response = await context.request.get(current, { headers, maxRedirects: 0, timeout: 60000 });
          const status = response.status();
          if ([301, 302, 303, 307, 308].includes(status)) {
            const destination = new URL(response.headers().location, current).href;
            await response.dispose();
            if (loginRedirect(destination)) throw sessionLost();
            if (externalUrl(destination)) return { external: destination };
            if (inspect && safeLearnUsUrl(destination) && /pluginfile\.php|\/download\.php/i.test(destination)) return { status: 200, url: destination, headers: { 'content-type': 'application/octet-stream' } };
            current = destination; continue;
          }
          if (status >= 400) { await response.dispose(); throw new Error(`Download HTTP ${status}.`); }
          const responseHeaders = response.headers();
          if (videoResource(filenameFor(current, responseHeaders, ''), responseHeaders)) { await response.dispose(); throw new Error('Video/lecture stream skipped.'); }
          const explicitHtmlAttachment = /^(?:attachment|inline)\s*;/i.test(responseHeaders['content-disposition'] || '') && /\bfilename\*?=/i.test(responseHeaders['content-disposition'] || '') && /\.html?$/i.test(filenameFor(current, responseHeaders, ''));
          if (inspect && (!/html/i.test(responseHeaders['content-type'] || '') || explicitHtmlAttachment)) { await response.dispose(); return { status, headers: responseHeaders, url: current }; }
          if (Number(responseHeaders['content-length'] || 0) > maxBytes) { await response.dispose(); throw new Error('File exceeds maxFileMB.'); }
          const body = status === 304 ? Buffer.alloc(0) : await response.body();
          await response.dispose();
          if (body.length > maxBytes) throw new Error('File exceeds maxFileMB.');
          if (/html/i.test(responseHeaders['content-type'] || '') && !explicitHtmlAttachment && looksLikeLogin(body.toString('utf8'))) throw sessionLost();
          return { status, headers: responseHeaders, body, url: current };
        }
        throw new Error('Too many redirects.');
      } catch (e) { if (attempt === 2 || LOCAL_ERROR.test(e.message) || clientError(e.message)) throw e; await pause(delayMs + retryDelayMs * 2 ** attempt); }
    }
  }
  function add(item, url, filename) {
    if (!url) return;
    const source_url = canonicalFileUrl(String(url).split('#')[0]);
    if (!safeLearnUsUrl(source_url) && !externalUrl(source_url)) { report.skipped.push({ course: item.course, title: item.title, reason: 'Unsupported or unsafe resource URL.' }); return; }
    const key = `${item.course_id}:${source_url}`;
    if (seen.has(key)) {
      const existing = discovered.find((entry) => `${entry.course_id}:${entry.source_url}` === key);
      if (item.discovery_scope && !existing.discovery_scopes.includes(item.discovery_scope)) existing.discovery_scopes.push(item.discovery_scope);
      if (filename && GENERIC_NAME.test(String(existing.filename || '').trim()) && !GENERIC_NAME.test(String(filename).trim())) existing.filename = filename;
      return;
    }
    seen.add(key);
    discovered.push({ ...item, discovery_scopes: item.discovery_scope ? [item.discovery_scope] : [], source_url, filename: filename || item.title, kind: externalUrl(source_url) ? 'link' : 'file' });
  }
  const courses = new Map(state.active_courses.map((c) => [String(c.id), c.name]));
  const instructors = new Map(state.active_courses.map((course) => {
    const id = String(course.id);
    const configured = options.instructorAuthors?.[id];
    const names = [
      ...(Array.isArray(configured) ? configured : []),
      ...(Array.isArray(course.instructorNames) ? course.instructorNames : []),
      ...(state.announcements || []).filter((announcement) => String(announcement.course_id) === id).map((announcement) => announcement.author),
      ...(state.course_materials || []).filter((group) => String(group.course_id) === id).flatMap((group) => Array.isArray(group.instructorNames) ? group.instructorNames : []),
    ];
    return [id, new Set(names.filter((name) => typeof name === 'string' && name.trim()).map((name) => normalizeName(name).replace(/\s/g, '')).filter(Boolean))];
  }));
  const courseFolders = new Map(state.active_courses.map((c) => {
    const sanitized = sanitizeName(c.name, 55);
    const collision = state.active_courses.some((other) => String(other.id) !== String(c.id) && sanitizeName(other.name, 55).toLowerCase() === sanitized.toLowerCase());
    return [String(c.id), collision ? `${sanitized}-${hash(String(c.id)).slice(0, 6)}` : sanitized];
  }));
  const wrappers = [];
  for (const activity of state.required_activities || []) if (/vod|xncommons/i.test(activity.type || '')) report.skipped.push({ course: activity.course, title: activity.name, reason: 'Video/lecture stream skipped.' });
  for (const group of state.course_materials || []) {
    // The current week can appear twice on a course page; each module id is processed once.
    const moduleIds = new Set();
    for (const material of group.items || []) {
      if (material.id !== undefined && material.id !== null) {
        if (moduleIds.has(String(material.id))) continue;
        moduleIds.add(String(material.id));
      }
      const item = scopeItem({ course_id: group.course_id, course: courses.get(String(group.course_id)), title: material.name, section: material.section, category: 'material', modified: material.modified || null }, material.id ?? material.url ?? material.name);
      if (/vod|xncommons/i.test(material.type || '')) { report.skipped.push({ ...item, reason: 'Video/lecture stream skipped.' }); continue; }
      if (material.type === 'textbook') continue; // "There is no textbooks." - nothing to download.
      if (material.type === 'turnitintooltwo') { report.skipped.push({ ...item, reason: 'Turnitin submission activity; nothing to download.' }); continue; }
      if (material.type !== 'board') {
        for (const file of material.files || []) add(item, file.url, file.name);
        for (const link of material.links || []) if (externalUrl(link.url)) add(item, link.url, link.name || item.title);
      }
      if (['resource', 'url', 'page', 'book', 'ubfile', 'file'].includes(material.type)) {
        scopes.set(item.discovery_scope, false);
        if (material.type === 'book') for (const url of manifest.book_discovery[item.discovery_scope]?.known || []) scopes.set(chapterScope(item, url), false);
        wrappers.push({ ...item, resource_type: material.type, source_url: material.url });
      }
      const boardName = material.type === 'board' ? String(material.name || '') : '';
      if (QNA_BOARD.test(boardName) && !options.includeQnA) {
        report.skipped.push({ ...item, reason: 'Class Q&A board skipped (student posts); set downloads.includeQnA to inspect instructor posts.' });
        continue;
      }
      const trusted = instructors.get(String(group.course_id)) || new Set();
      if (material.type === 'board' && !trusted.size) {
        scopes.set(item.discovery_scope, false);
        report.skipped.push({ ...item, reason: 'Board harvest skipped: no known instructor authors for this course.' });
        continue;
      }
      for (const entry of material.entries || []) {
        const article = scopeItem({ ...item, title: entry.title || material.name }, `${material.id ?? material.url ?? material.name}:article:${entry.id ?? entry.url}`, false);
        const studentPost = /student|learner|학생|수강생/i.test(String(entry.author_role || '')) || Boolean(config.student?.authorNames && isStudentAuthor(entry.author, config.student));
        if (studentPost || !instructorConfirmed(entry, trusted)) {
          report.skipped.push({ ...article, reason: `author not a known instructor: ${entry.author || '(missing)'}` });
          continue;
        }
        for (const file of entry.attachments || []) add(article, file.url, file.name);
        wrappers.push({ ...article, resource_type: 'board_article', source_url: entry.url });
      }
    }
  }
  for (const announcement of state.announcements || []) {
    const item = scopeItem({ course_id: announcement.course_id, course: announcement.course, title: announcement.source_title || announcement.title, date: announcement.posted_on, category: 'announcement' }, announcement.id ?? announcement.url ?? announcement.title, announcement.attachment_discovery_complete !== false);
    for (const file of announcement.current_attachments || announcement.attachments || []) add(item, file.url, file.name);
    for (const link of announcement.current_content_links || announcement.content_links || []) if (externalUrl(link.url)) add(item, link.url, link.name || item.title);
  }
  for (const assignment of state.assignments || []) {
    const item = scopeItem({ course_id: assignment.course_id, course: assignment.course, title: assignment.name, category: 'assignment' }, assignment.id ?? assignment.source_url ?? assignment.name, assignment.attachment_discovery_complete !== false);
    for (const file of assignment.instruction_attachments || []) add(item, file.url, file.name);
    for (const link of assignment.instruction_links || []) if (externalUrl(link.url)) add(item, link.url, link.name || item.title);
    if (assignment.source_type === 'board_submission' && assignment.currently_listed !== false) {
      // Only inspect the board's instructor-provided intro. Never follow its article rows.
      scopes.set(item.discovery_scope, false);
      wrappers.push({ ...item, resource_type: 'assignment_board', source_url: assignment.source_url });
    }
  }
  // Item-page GETs can mark activities viewed, so dry runs use only known links.
  const cursor = Number(manifest.discovery_cursor || 0) % Math.max(1, wrappers.length);
  const orderedWrappers = [...wrappers.slice(cursor), ...wrappers.slice(0, cursor)];
  let attempted = 0;
  for (const item of orderedWrappers.slice(0, options.maxFilesPerRun)) {
    const stopped = stopReason();
    if (stopped) { report.skipped.push({ course: item.course, title: item.title, reason: stopped }); continue; }
    attempted++;
    try {
      if (externalUrl(item.source_url)) { add(item, item.source_url, item.title); scopes.set(item.discovery_scope, true); continue; }
      if (/pluginfile\.php|\/download\.php/i.test(item.source_url)) { add(item, item.source_url, item.title); scopes.set(item.discovery_scope, true); continue; }
      if (dryRun) { report.skipped.push({ ...item, reason: DRY_RUN_MESSAGE }); continue; }
      const wrapperUrl = new URL(item.source_url);
      if (item.resource_type === 'assignment_board' && !/\/mod\/ubboard\/view\.php$/.test(wrapperUrl.pathname)) throw new Error('Unsafe or external download redirect blocked.');
      if (/\/mod\/(?:resource|url)\/view\.php/.test(wrapperUrl.pathname)) wrapperUrl.searchParams.set('redirect', '0');
      else if (/\/mod\/ubfile\/view\.php/.test(wrapperUrl.pathname)) wrapperUrl.searchParams.set('redirect', '1');
      const response = await get(wrapperUrl.href, {}, true);
      if (response.external) { add(item, response.external, item.title); scopes.set(item.discovery_scope, true); continue; }
      if (!response.body) { add(item, response.url, filenameFor(response.url, response.headers, item.title)); scopes.set(item.discovery_scope, true); continue; }
      const pages = [{ html: response.body.toString('utf8'), url: response.url }];
      let bookIncomplete = false;
      // The saved queue continues bounded chapter inspection across later runs.
      // Each chapter has its own scope so uninspected chapters retain uncertainty.
      if (item.resource_type === 'book') {
        const canonicalChapter = (value) => {
          try {
            const chapter = new URL(value);
            if (!safeLearnUsUrl(value) || chapter.pathname !== wrapperUrl.pathname || chapter.searchParams.get('id') !== wrapperUrl.searchParams.get('id') || !/^\d+$/.test(chapter.searchParams.get('chapterid') || '')) return null;
            chapter.search = new URLSearchParams({ id: wrapperUrl.searchParams.get('id'), chapterid: chapter.searchParams.get('chapterid') }).toString();
            chapter.hash = '';
            return chapter.href;
          } catch { return null; }
        };
        const saved = manifest.book_discovery[item.discovery_scope] || {};
        const known = new Set((saved.known || []).map(canonicalChapter).filter(Boolean));
        const queue = [...new Set((saved.pending?.length ? saved.pending : [...known]).map(canonicalChapter).filter(Boolean))];
        const enqueuePage = (page) => {
          const toc = contentContainers(page.html, /\b(?:class|id)\s*=\s*["'][^"']*\b(?:book_toc|book_content|booktoc)\b[^"']*["']/i);
          for (const link of htmlLinks(toc, page.url)) {
            const chapter = canonicalChapter(link.url);
            if (chapter && !known.has(chapter)) { known.add(chapter); queue.push(chapter); }
          }
        };
        enqueuePage(pages[0]);
        for (const url of known) scopes.set(chapterScope(item, url), false);
        const pageCap = Math.min(20, Math.max(2, options.maxFilesPerRun));
        for (let inspected = 1; queue.length && inspected < pageCap; inspected++) {
          if (stopReason()) break;
          const chapter = queue.shift();
          try {
            const next = await get(chapter, {}, true);
            if (next.external || !canonicalChapter(next.url) || !/html/i.test(next.headers?.['content-type'] || '')) throw new Error('Unsafe or external download redirect blocked.');
            const page = { html: next.body.toString('utf8'), url: next.url, discovery_scope: chapterScope(item, chapter) };
            if (looksLikeLogin(page.html)) throw new Error('Login page returned during discovery.');
            pages.push(page);
            enqueuePage(page);
          } catch (error) {
            queue.push(chapter);
            bookIncomplete = true;
            report.failed.push({ course: item.course, title: item.title, reason: `Book chapter discovery: ${errorReason(error)}` });
          }
        }
        bookIncomplete ||= queue.length > 0;
        manifest.book_discovery[item.discovery_scope] = { known: [...known], pending: queue };
        if (queue.length && !stopReason()) report.skipped.push({ course: item.course, title: item.title, reason: 'Book chapter inspection capped; queued chapters continue next run.' });
      }
      let found = false;
      let recognizable = false;
      for (const page of pages) {
        const pageItem = page.discovery_scope ? { ...item, discovery_scope: page.discovery_scope } : item;
        let pageFound = false;
        if (looksLikeLogin(page.html)) throw new Error('Login page returned during discovery.');
        const scopedContent = item.resource_type === 'assignment_board' ? instructionContent(page.html) : ['page', 'book'].includes(item.resource_type) ? resourceContent(page.html) : page.html;
        recognizable ||= Boolean(resourceContent(page.html)) || /\b(?:urlworkaround|resourceworkaround|resourcecontent|externalurl)\b|\bNo (?:attachments|files)\b|첨부파일\s*(?:없음|없습니다)|파일이 없습니다/i.test(page.html);
        if (/\b(?:errorcode|errorbox|alert-danger)\b/i.test(page.html)) recognizable = false;
        // A URL module's target is its workaround/externalurl link; fall back to the main column, never site chrome.
        const urlTargets = item.resource_type === 'url' ? urlResourceLinks(page.html, page.url) : [];
        const links = item.resource_type === 'url' ? (urlTargets.length ? urlTargets : htmlLinks(mainRegion(page.html), page.url)) : htmlLinks(scopedContent, page.url);
        for (const link of links) {
          if (/pluginfile\.php|\/mod\/ubboard\/download\.php/i.test(link.url) && safeLearnUsUrl(link.url)) { add(pageItem, link.url, link.name); found = pageFound = true; }
          else if (['url', 'page', 'book', 'assignment_board'].includes(item.resource_type) && externalUrl(link.url)) { add(pageItem, link.url, link.name || item.title); found = pageFound = true; }
        }
        if (item.resource_type === 'board_article') for (const link of htmlLinks(resourceContent(page.html), page.url)) if (externalUrl(link.url)) { add(item, link.url, link.name || item.title); found = true; }
        if (page.discovery_scope) scopes.set(page.discovery_scope, pageFound || Boolean(resourceContent(page.html)) && !/\b(?:errorcode|errorbox|alert-danger)\b/i.test(page.html));
      }
      scopes.set(item.discovery_scope, (found || recognizable) && !bookIncomplete);
      if (!found) report.skipped.push({ ...item, reason: recognizable ? 'No downloadable files or external resource link found.' : 'Unrecognized resource content; discovery remains uncertain.' });
    } catch (e) {
      const video = e.message === 'Video/lecture stream skipped.';
      scopes.set(item.discovery_scope, video);
      report[video ? 'skipped' : 'failed'].push({ course: item.course, title: item.title, reason: video ? e.message : `Resource discovery: ${errorReason(e)}` });
    }
  }
  manifest.discovery_cursor = (cursor + attempted) % Math.max(1, wrappers.length);
  let processed = 0;
  const pending = discovered.filter((item) => !manifest.entries[`${item.course_id}:${item.source_url}`]);
  const known = discovered.filter((item) => manifest.entries[`${item.course_id}:${item.source_url}`]);
  const fileCursor = Number(manifest.file_cursor || 0) % Math.max(1, known.length);
  const orderedFiles = [...pending, ...known.slice(fileCursor), ...known.slice(0, fileCursor)];
  for (const item of orderedFiles) {
    const stopped = dryRun ? null : stopReason();
    if (stopped) { report.skipped.push({ course: item.course, title: item.title, reason: stopped }); continue; }
    item.course_folder = courseFolders.get(String(item.course_id));
    const key = `${item.course_id}:${item.source_url}`;
    const prior = manifest.entries[key];
    if (prior) {
      Object.assign(prior, { title: item.title, section: item.section, course: item.course, category: item.category, date: item.date, discovery_scope: item.discovery_scope, discovery_scopes: item.discovery_scopes, last_seen: now, disappeared: false, discovery_status: 'present' });
      delete prior.disappeared_at;
    }
    try {
      if (item.kind === 'file' && !safeLearnUsUrl(item.source_url)) { report.skipped.push({ ...item, reason: 'Unsupported or unsafe LearnUs URL.' }); continue; }
      let filename = item.kind === 'link' ? `${item.title}.url` : item.filename;
      const blocked = (name) => item.kind === 'file' && options.denyExtensions.includes(path.extname(downloadPath(root, item, name)).toLowerCase());
      if (item.kind === 'file' && videoResource(filename)) { report.skipped.push({ ...item, reason: 'Video/lecture stream skipped.' }); continue; }
      if (options.skipExtensions.map((e) => e.toLowerCase()).includes(path.extname(filename).toLowerCase())) { report.skipped.push({ ...item, reason: 'Configured extension skipped.' }); continue; }
      if (++processed > options.maxFilesPerRun) { report.skipped.push({ ...item, reason: 'Per-run file cap reached.' }); continue; }
      if (dryRun) {
        if (blocked(filename)) { report.skipped.push({ ...item, reason: `blocked extension ${path.extname(downloadPath(root, item, filename)).toLowerCase()}` }); continue; }
        const preview = { ...item, local_path: prior?.local_path || downloadPath(root, item, filename), reason: prior ? 'Would check existing file for updates.' : 'Would download.' }; report.skipped.push(preview); report.wouldDownload.push(preview); continue;
      }
      let body, headers = {};
      if (item.kind === 'link') body = Buffer.from(linkShortcut(item.source_url));
      else {
        const response = await get(item.source_url, prior && await exists(prior.local_path) ? conditionalHeaders(prior) : {});
        if (response.external) throw new Error('External file redirect blocked.');
        if (response.status === 304 && prior && await exists(prior.local_path)) {
          if (blocked(path.basename(prior.local_path))) { report.skipped.push({ ...item, reason: `blocked extension ${path.extname(prior.local_path).toLowerCase()}` }); continue; }
          prior.etag = response.headers.etag || prior.etag; prior.modified = response.headers['last-modified'] || prior.modified; report.skipped.push({ ...item, local_path: prior.local_path, reason: 'Unchanged (HTTP 304).' }); continue;
        }
        body = response.body; headers = response.headers;
        filename = nameWithExtension(filenameFor(response.url, headers, filename), item.filename, headers);
        if (blocked(filename)) { report.skipped.push({ ...item, reason: `blocked extension ${path.extname(downloadPath(root, item, filename)).toLowerCase()}` }); continue; }
        if (options.skipExtensions.map((e) => e.toLowerCase()).includes(path.extname(filename).toLowerCase())) { report.skipped.push({ ...item, reason: 'Configured extension skipped.' }); continue; }
        validateDownload(body, headers, maxBytes, filename);
      }
      const sha256 = hash(body);
      if (prior?.sha256 === sha256 && await exists(prior.local_path)) { prior.etag = headers.etag || prior.etag; prior.modified = headers['last-modified'] || prior.modified; report.skipped.push({ ...item, local_path: prior.local_path, reason: 'Unchanged (SHA256).' }); continue; }
      if (prior?.sha256 === sha256 && typeof prior.local_path === 'string') {
        // Unchanged content whose local copy was deleted: put it back where it was.
        await writeNew(prior.local_path, body, ops, item.source_url);
        prior.etag = headers.etag || prior.etag; prior.modified = headers['last-modified'] || prior.modified;
        report.skipped.push({ ...item, local_path: prior.local_path, reason: 'Restored missing local copy.' }); continue;
      }
      const suffix = prior ? ` (updated ${now.slice(0, 10)})` : '';
      // An identical file at the destination (crash before the manifest write, lost manifest) is adopted, not duplicated.
      const owned = (file) => Object.entries(manifest.entries).some(([other, e]) => other !== key && e.local_path === file);
      let local_path = null, adopted = false;
      for (const tail of ['', ` ${hash(item.source_url).slice(0, 8)} ${sha256.slice(0, 8)}`]) {
        const candidate = downloadPath(root, item, filename, suffix + tail);
        if (!await exists(candidate)) { local_path = candidate; break; }
        if (!owned(candidate) && await fileHash(candidate) === sha256) { local_path = candidate; adopted = true; break; }
      }
      if (!local_path) throw new Error('Local destination already exists; preserved.');
      if (!adopted) await writeNew(local_path, body, ops, item.source_url);
      else await writeMotw(local_path, item.source_url);
      const entry = { ...item, local_path, size: body.length, sha256, first_seen: prior?.first_seen || now, last_seen: now, modified: headers['last-modified'] || item.modified || null, etag: headers.etag || null, disappeared: false, versions: [...(prior?.versions || []), ...(prior ? [{ local_path: prior.local_path, sha256: prior.sha256, size: prior.size }] : [])] };
      manifest.entries[key] = entry;
      if (adopted) report.skipped.push({ ...item, local_path, reason: 'Already present locally; adopted.' });
      else report[prior ? 'updated' : item.kind === 'link' ? 'newLinks' : 'newFiles'].push(entry);
    } catch (e) {
      const skip = e.message === 'Video/lecture stream skipped.' ? e.message : e.message === 'Empty download.' ? 'Empty file on server; skipped.' : null;
      report[skip ? 'skipped' : 'failed'].push({ course: item.course, title: item.title, reason: skip || errorReason(e) });
      if (e.code === 'ENOSPC') halted = DEFERRED;
    }
  }
  if (!dryRun) {
    manifest.file_cursor = (fileCursor + Math.max(1, options.maxFilesPerRun - Math.min(pending.length, options.maxFilesPerRun))) % Math.max(1, known.length);
    for (const [key, entry] of Object.entries(manifest.entries)) if (courses.has(String(entry.course_id)) && !seen.has(key)) {
      const entryScopes = entry.discovery_scopes || (entry.discovery_scope ? [entry.discovery_scope] : []);
      // Missing scopes were removed from the current complete course inventory.
      // Unknown legacy provenance and failed/uninspected scopes stay uncertain.
      if (entryScopes.length && entryScopes.every((scope) => !scopes.has(scope) || scopes.get(scope))) {
        entry.disappeared = true; entry.disappeared_at ||= now; entry.discovery_status = 'absent';
      } else entry.discovery_status = 'uncertain';
    }
    manifest.discovery_scopes = Object.fromEntries([...scopes].map(([key, complete]) => [key, { complete, checked_at: now }]));
    for (const course of state.active_courses) {
      const links = Object.values(manifest.entries).filter((e) => String(e.course_id) === String(course.id) && e.kind === 'link');
      if (!links.length) continue;
      const courseDir = path.join(root, courseFolders.get(String(course.id)));
      const index = path.join(courseDir, 'Links.md');
      await assertLocalTarget(index, root);
      try {
        const body = Buffer.from(linksIndex(links));
        const old = await fs.readFile(index).catch(() => null);
        if (!old || !old.equals(body)) {
          if (old) {
            const existingLines = new Set(old.toString('utf8').split('\n'));
            const newRows = body.toString('utf8').split('\n').filter((line) => line.startsWith('| ') && !existingLines.has(line));
            if (newRows.length) await fs.appendFile(index, newRows.join('\n') + '\n');
          }
          else await writeNew(index, body, ops);
        }
      } catch (e) { report.failed.push({ course: course.name, reason: `Links index: ${errorReason(e)}` }); }
    }
    try {
      const temp = `${manifestPath}.next`;
      await fs.writeFile(temp, JSON.stringify(manifest, null, 2) + '\n');
      JSON.parse(await fs.readFile(temp, 'utf8'));
      // Antivirus/OneDrive can briefly lock the target on Windows.
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temp, manifestPath); break; } catch (e) { if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; await pause(50 * 2 ** attempt); }
      }
    } catch { report.failed.push({ reason: 'Manifest write failed; downloaded files preserved.' }); }
  }
  return report;
}
