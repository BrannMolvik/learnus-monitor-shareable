import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SCAN = path.join('reports', 'latest-scan.json');
const DEFAULT_STATE = path.join('logs', 'assignment-notification-state.json');
const DEFAULT_OUT = path.join('reports', 'latest-assignment-notification.json');

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stableJson(item))));
  if (value && typeof value === 'object') {
    const ordered = Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, JSON.parse(stableJson(value[key]))])
    );
    return JSON.stringify(ordered);
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

export function isDefinitelyUnsubmitted(item) {
  if (!item || item.completed === true || item.outstanding !== true) return false;

  const certainty = clean(item.status_certainty).toLowerCase();
  if (
    certainty.includes('uncertain') ||
    certainty.includes('likely_group_submitted') ||
    certainty.includes('submitted_group')
  ) {
    return false;
  }

  const status = clean(item.submission_status ?? item.status).toLowerCase();
  if (
    /\b(no attempt|not submitted|not yet submitted|never submitted|draft saved|draft|not turned in|missing)\b/.test(status) ||
    /미제출|제출하지/.test(status)
  ) {
    return true;
  }

  return certainty === 'explicit_assignment_page' && status !== '' && !/submitted|complete|graded/.test(status);
}

function dateKey(value) {
  return clean(value).slice(0, 10);
}

function humanDue(dueAt, referenceAt) {
  if (!dueAt) return 'No deadline shown';
  const due = new Date(dueAt);
  const reference = new Date(referenceAt);
  if (!Number.isFinite(due.getTime()) || !Number.isFinite(reference.getTime())) return clean(dueAt);

  const dueDate = dateKey(dueAt);
  const refDate = dateKey(referenceAt);
  const dayMs = 86400000;
  const dueDay = Date.parse(`${dueDate}T00:00:00Z`);
  const refDay = Date.parse(`${refDate}T00:00:00Z`);
  const dayDelta = Math.round((dueDay - refDay) / dayMs);

  if (due.getTime() < reference.getTime()) return 'OVERDUE';
  if (dayDelta === 0) return 'DUE TODAY';
  if (dayDelta === 1) return 'DUE TOMORROW';

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    month: 'short',
    day: 'numeric',
  }).format(due);
}

function canonicalAssignment(item) {
  return {
    assignment_id: clean(item.id ?? item.activity_id ?? item.assignment_id),
    course: clean(item.course),
    title: clean(item.name ?? item.item),
    due_at: item.due_at ?? null,
    submission_status: clean(item.submission_status ?? item.status),
  };
}

export function buildAssignmentNotification(scan, priorState = {}) {
  if (!scan || scan.check_status?.all_active_courses_checked !== true) {
    throw new Error('Assignment notifications require a complete successful LearnUs scan.');
  }

  const referenceAt = scan.last_successful_check;
  if (!referenceAt) throw new Error('LearnUs scan is missing last_successful_check.');

  const assignments = (scan.assignments || [])
    .filter(isDefinitelyUnsubmitted)
    .map(canonicalAssignment)
    .sort((left, right) => {
      const leftDue = Date.parse(left.due_at || '9999-12-31');
      const rightDue = Date.parse(right.due_at || '9999-12-31');
      return leftDue - rightDue || left.course.localeCompare(right.course) || left.title.localeCompare(right.title);
    });

  if (!assignments.length) {
    return {
      schema_version: 1,
      should_notify: false,
      reason: 'no_definitely_unsubmitted_assignments',
      assignment_count: 0,
      title: null,
      body: null,
      next_state: null,
    };
  }

  const fingerprint = digest(assignments);
  const scanDate = dateKey(referenceAt);
  const sameAsShownToday =
    priorState?.shown_date === scanDate &&
    priorState?.fingerprint === fingerprint;

  const overdueCount = assignments.filter((item) => {
    if (!item.due_at) return false;
    const due = Date.parse(item.due_at);
    const ref = Date.parse(referenceAt);
    return Number.isFinite(due) && Number.isFinite(ref) && due < ref;
  }).length;

  const title = overdueCount > 0
    ? `LearnUs: ${overdueCount} overdue, ${assignments.length} unsubmitted`
    : `LearnUs: ${assignments.length} unsubmitted assignment${assignments.length === 1 ? '' : 's'}`;

  const lines = assignments.slice(0, 4).map((item) =>
    `${humanDue(item.due_at, referenceAt)} · ${item.course} · ${item.title}`
  );
  if (assignments.length > 4) {
    lines.push(`+${assignments.length - 4} more unsubmitted assignment${assignments.length - 4 === 1 ? '' : 's'}`);
  }

  return {
    schema_version: 1,
    should_notify: !sameAsShownToday,
    reason: sameAsShownToday ? 'already_shown_same_state_today' : 'unsubmitted_assignments_present',
    assignment_count: assignments.length,
    overdue_count: overdueCount,
    title,
    body: lines.join('\n'),
    assignments,
    next_state: {
      shown_date: scanDate,
      fingerprint,
      shown_assignment_ids: assignments.map((item) => item.assignment_id),
      source_check: referenceAt,
    },
  };
}

function parseArgs(argv) {
  const args = {
    scan: DEFAULT_SCAN,
    state: DEFAULT_STATE,
    out: DEFAULT_OUT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--scan', '--state', '--out'].includes(key)) throw new Error(`Unknown argument: ${key}`);
    if (!value) throw new Error(`Missing value for ${key}`);
    args[key.slice(2)] = value;
    index += 1;
  }
  return args;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scan = JSON.parse((await fs.readFile(args.scan, 'utf8')).replace(/^\uFEFF/, ''));
  const priorState = await readJsonIfExists(args.state);
  const payload = buildAssignmentNotification(scan, priorState);
  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `Assignment notification: ${payload.should_notify ? 'show' : 'skip'} (${payload.reason}; ${payload.assignment_count} assignment(s)).\n`
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`Assignment notification generation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
