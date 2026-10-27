import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { notePath } from './app-config.mjs';

export const CAPTURE_SCHEMA_VERSION = 1;
export const DEFAULT_TARGET_PATH = 'AI Inbox/LearnUs Intake.md';


function normalizeCourseName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function loadCourseRoutes(payload = { schema_version: 1, routes: [] }) {
  if (payload?.schema_version !== 1 || !Array.isArray(payload.routes)) {
    throw new Error('Invalid Second Brain course-map schema.');
  }

  const routes = new Map();
  for (const route of payload.routes) {
    if (!route || !Array.isArray(route.aliases) || typeof route.path !== 'string') {
      throw new Error('Invalid Second Brain course-map route.');
    }
    notePath(route.path, true);
    for (const alias of route.aliases) {
      const normalized = normalizeCourseName(alias);
      if (!normalized) throw new Error('Course-map aliases must not be empty.');
      const existing = routes.get(normalized);
      if (existing && existing !== route.path) {
        throw new Error(`Conflicting course-map alias: ${alias}`);
      }
      routes.set(normalized, route.path);
    }
  }
  return routes;
}

const COURSE_ROUTES = loadCourseRoutes();

export function resolveCourseNotePath(courseName, routes = COURSE_ROUTES) {
  return routes.get(normalizeCourseName(courseName)) || null;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function hashRecord(record) {
  return crypto.createHash('sha256').update(stableJson(record)).digest('hex');
}

function cleanString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || null;
}

function boundedText(value, limit = 2000) {
  const text = cleanString(value);
  if (!text) return null;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function compactObject(input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  );
}

function makeCapture(kind, payload, targetPath = DEFAULT_TARGET_PATH) {
  const record = compactObject({
    schema_version: CAPTURE_SCHEMA_VERSION,
    source: 'Yonsei LearnUs',
    source_kind: 'external_lms',
    routing_hint: 'course_context',
    kind,
    ...payload,
  });
  const digest = hashRecord(record);
  const captureId = `learnus:${kind}:${digest.slice(0, 24)}`;
  const persistedRecord = { capture_id: captureId, ...record };
  return {
    capture_id: captureId,
    target_path: targetPath,
    course_note_path: resolveCourseNotePath(record.course),
    line: `- learnus-capture ${stableJson(persistedRecord)}`,
    record: persistedRecord,
  };
}

function assignmentId(item) {
  return cleanString(item?.id ?? item?.activity_id ?? item?.assignment_id);
}

function announcementId(item) {
  return cleanString(item?.id ?? item?.announcement_id ?? item?.article_id);
}

function courseNameById(scan, courseId) {
  return cleanString(
    (scan.active_courses || []).find((course) => Number(course.id) === Number(courseId))?.name
  ) || cleanString(courseId) || 'Unknown course';
}

function assignmentPayload(item) {
  return compactObject({
    assignment_id: assignmentId(item),
    course_id: item.course_id ?? null,
    course: cleanString(item.course),
    title: cleanString(item.name ?? item.item),
    due_at: item.due_at ?? null,
    submission_status: cleanString(item.submission_status ?? item.status),
    status_certainty: cleanString(item.status_certainty),
    outstanding: Boolean(item.outstanding),
    completed: Boolean(item.completed),
    overdue: Boolean(item.overdue),
    source_type: cleanString(item.source_type),
    source_url: cleanString(item.url),
  });
}

function addUnique(captures, capture) {
  if (!captures.has(capture.capture_id)) captures.set(capture.capture_id, capture);
}

export function buildSecondBrainCaptures(scan, diff, options = {}) {
  const targetPath = options.targetPath || DEFAULT_TARGET_PATH;
  if (!scan || scan.check_status?.all_active_courses_checked !== true) {
    throw new Error('Second Brain export requires a successful complete LearnUs scan.');
  }
  if (!diff || !Array.isArray(diff.meaningful_changes)) {
    throw new Error('Second Brain export requires a valid LearnUs diff.');
  }

  const captures = new Map();
  const assignments = Array.isArray(scan.assignments) ? scan.assignments : [];
  const assignmentById = new Map(
    assignments.map((item) => [assignmentId(item), item]).filter(([id]) => id)
  );
  const announcements = Array.isArray(scan.announcements) ? scan.announcements : [];
  const announcementById = new Map(
    announcements.map((item) => [announcementId(item), item]).filter(([id]) => id)
  );

  for (const item of assignments) {
    if (!item.outstanding) continue;
    addUnique(captures, makeCapture('assignment_state', assignmentPayload(item), targetPath));
  }

  for (const item of scan.required_activities || []) {
    if (!item.outstanding) continue;
    addUnique(captures, makeCapture('required_activity_state', compactObject({
      activity_id: cleanString(item.activity_id ?? item.id),
      course_id: item.course_id ?? null,
      course: cleanString(item.course),
      title: cleanString(item.name),
      activity_type: cleanString(item.type),
      status: cleanString(item.status),
      outstanding: true,
      source_url: cleanString(item.url),
    }), targetPath));
  }

  for (const item of diff.completed_since_last_check || []) {
    const current = assignmentById.get(cleanString(item.assignment_id));
    addUnique(captures, makeCapture('assignment_completed', compactObject({
      assignment_id: cleanString(item.assignment_id),
      course: cleanString(item.course ?? current?.course),
      title: cleanString(item.item ?? current?.name),
      status: cleanString(item.status ?? current?.submission_status),
      completed_at: cleanString(item.last_modified ?? current?.last_modified ?? current?.submitted_at),
      submission_files: Array.isArray(item.submission_files)
        ? item.submission_files.map((file) => cleanString(file?.name ?? file)).filter(Boolean)
        : [],
      source_url: cleanString(current?.url),
    }), targetPath));
  }

  for (const change of diff.meaningful_changes) {
    if (change.type === 'deadline_changed') {
      const current = assignmentById.get(cleanString(change.assignment_id));
      addUnique(captures, makeCapture('deadline_changed', compactObject({
        assignment_id: cleanString(change.assignment_id),
        course: cleanString(change.course ?? current?.course),
        title: cleanString(change.item ?? current?.name),
        from: change.from ?? null,
        to: change.to ?? current?.due_at ?? null,
        current_status: cleanString(current?.submission_status),
        source_url: cleanString(current?.url),
      }), targetPath));
      continue;
    }

    if (['new_announcement', 'announcement_changed', 'discovered_existing_announcement'].includes(change.type)) {
      const current = announcementById.get(cleanString(change.announcement_id));
      addUnique(captures, makeCapture('announcement_change', compactObject({
        change_type: change.type,
        announcement_id: cleanString(change.announcement_id),
        course_id: current?.course_id ?? null,
        course: cleanString(change.course ?? current?.course),
        title: cleanString(current?.english_title ?? current?.title ?? change.title),
        original_title: cleanString(current?.source_title),
        posted_on: current?.posted_on ?? change.posted_on ?? null,
        body_hash: cleanString(current?.body_hash),
        summary: boundedText(current?.summary ?? current?.body),
        summary_source: cleanString(current?.summary_source),
        source_url: cleanString(current?.url),
        external_content: true,
      }), targetPath));
      continue;
    }

    if (['material_discovered', 'material_listing_changed'].includes(change.type)) {
      addUnique(captures, makeCapture('course_material_change', compactObject({
        change_type: change.type,
        course_id: change.course_id ?? null,
        course: courseNameById(scan, change.course_id),
        material_id: cleanString(change.material_id),
        title: cleanString(change.item),
      }), targetPath));
    }
  }

  const routes = options.routes || COURSE_ROUTES;
  return [...captures.values()].map(capture => ({ ...capture, course_note_path: resolveCourseNotePath(capture.record.course, routes) })).sort((left, right) =>
    left.capture_id.localeCompare(right.capture_id)
  );
}

export function buildCaptureBatch(scan, diff, options = {}) {
  const captures = buildSecondBrainCaptures(scan, diff, options);
  return {
    schema_version: CAPTURE_SCHEMA_VERSION,
    target_path: options.targetPath || DEFAULT_TARGET_PATH,
    source_check: scan.last_successful_check ?? null,
    captures,
  };
}

function parseArgs(argv) {
  const args = {
    scan: path.join('reports', 'latest-scan.json'),
    diff: path.join('reports', 'latest-diff.json'),
    out: path.join('reports', 'latest-second-brain-captures.json'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!['--scan', '--diff', '--out', '--target'].includes(value)) {
      throw new Error(`Unknown argument: ${value}`);
    }
    const next = argv[index + 1];
    if (!next) throw new Error(`Missing value for ${value}`);
    index += 1;
    if (value === '--scan') args.scan = next;
    if (value === '--diff') args.diff = next;
    if (value === '--out') args.out = next;
    if (value === '--target') args.target = next;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [scan, diff] = await Promise.all([
    fs.readFile(args.scan, 'utf8').then(JSON.parse),
    fs.readFile(args.diff, 'utf8').then(JSON.parse),
  ]);
  const batch = buildCaptureBatch(scan, diff, {
    targetPath: args.target || DEFAULT_TARGET_PATH,
  });
  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, `${JSON.stringify(batch, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `Prepared ${batch.captures.length} deterministic Second Brain capture(s) for ${batch.target_path}.\n`
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`Second Brain export failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
