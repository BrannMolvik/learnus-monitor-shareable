import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAssignmentNotification,
  isDefinitelyUnsubmitted,
} from '../assignment-notifications.mjs';

function baseScan() {
  return {
    last_successful_check: '2026-10-08T08:00:00+09:00',
    check_status: { all_active_courses_checked: true },
    assignments: [
      {
        id: 1,
        course: 'KOREAN (1)',
        name: 'Vocabulary quiz 1',
        due_at: '2026-10-13T00:00:00+09:00',
        submission_status: 'No attempt',
        status_certainty: 'explicit_assignment_page',
        outstanding: true,
        completed: false,
      },
      {
        id: 2,
        course: 'UNDERSTANDING COMMUNICATION TECHNOLOGY',
        name: '#2 Individual Assignment',
        due_at: '2026-11-29T23:59:00+09:00',
        submission_status: 'Not submitted',
        status_certainty: 'explicit_assignment_page',
        outstanding: true,
        completed: false,
      },
      {
        id: 3,
        course: 'Applied Agentic AI',
        name: 'Already done',
        due_at: '2026-10-10T23:59:00+09:00',
        submission_status: 'Submitted',
        status_certainty: 'explicit_assignment_page',
        outstanding: false,
        completed: true,
      },
      {
        id: 4,
        course: 'New Media',
        name: 'Group submission',
        due_at: '2026-10-09T23:59:00+09:00',
        submission_status: 'Group work detected',
        status_certainty: 'uncertain_likely_group_submitted',
        outstanding: true,
        completed: false,
      },
    ],
  };
}

test('classifies only clear unsubmitted assignments', () => {
  const scan = baseScan();
  assert.equal(isDefinitelyUnsubmitted(scan.assignments[0]), true);
  assert.equal(isDefinitelyUnsubmitted(scan.assignments[1]), true);
  assert.equal(isDefinitelyUnsubmitted(scan.assignments[2]), false);
  assert.equal(isDefinitelyUnsubmitted(scan.assignments[3]), false);
});

test('builds one summary notification for definitely unsubmitted assignments', () => {
  const payload = buildAssignmentNotification(baseScan(), {});
  assert.equal(payload.should_notify, true);
  assert.equal(payload.assignment_count, 2);
  assert.equal(payload.overdue_count, 0);
  assert.match(payload.title, /2 unsubmitted assignments/);
  assert.match(payload.body, /KOREAN \(1\).*Vocabulary quiz 1/);
  assert.match(payload.body, /UNDERSTANDING COMMUNICATION TECHNOLOGY.*#2 Individual Assignment/);
  assert.equal(payload.assignments.length, 2);
});

test('suppresses an identical repeat on the same scan date', () => {
  const first = buildAssignmentNotification(baseScan(), {});
  const second = buildAssignmentNotification(baseScan(), first.next_state);
  assert.equal(second.should_notify, false);
  assert.equal(second.reason, 'already_shown_same_state_today');
});

test('reminds again on the next day if assignments remain unsubmitted', () => {
  const firstScan = baseScan();
  const first = buildAssignmentNotification(firstScan, {});

  const secondScan = baseScan();
  secondScan.last_successful_check = '2026-10-09T08:00:00+09:00';
  const second = buildAssignmentNotification(secondScan, first.next_state);

  assert.equal(second.should_notify, true);
  assert.equal(second.assignment_count, 2);
});

test('same-day state change triggers a fresh notification', () => {
  const firstScan = baseScan();
  const first = buildAssignmentNotification(firstScan, {});

  const changedScan = baseScan();
  changedScan.assignments[0].due_at = '2026-10-10T00:00:00+09:00';
  const changed = buildAssignmentNotification(changedScan, first.next_state);

  assert.equal(changed.should_notify, true);
});

test('does not notify when no assignment is definitely unsubmitted', () => {
  const scan = baseScan();
  for (const item of scan.assignments) {
    item.completed = true;
    item.outstanding = false;
    item.submission_status = 'Submitted';
  }
  const payload = buildAssignmentNotification(scan, {});
  assert.equal(payload.should_notify, false);
  assert.equal(payload.assignment_count, 0);
  assert.equal(payload.reason, 'no_definitely_unsubmitted_assignments');
});
