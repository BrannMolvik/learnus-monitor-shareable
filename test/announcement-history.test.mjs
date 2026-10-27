import test from 'node:test';
import assert from 'node:assert/strict';
import { announcementBodyHash, mergeAnnouncementHistory, shouldReuseAnnouncementSummary } from '../src/announcement-history.mjs';

test('announcement body hash changes when saved body changes', () => {
  const base = {
    id: 101,
    source_title: 'Schedule update',
    author: 'Professor',
    posted_on: '2026-10-03',
    body: 'Class starts at 10:00.',
  };
  assert.notEqual(
    announcementBodyHash(base),
    announcementBodyHash({ ...base, body: 'Class starts at 11:00.' }),
  );
});

test('announcement history preserves removed items and adds new items', () => {
  const existing = {
    schema_version: 1,
    updated_at: '2026-10-02T08:00:00+09:00',
    announcements: [
      {
        id: 1,
        course: 'Course A',
        title: 'Old notice',
        posted_on: '2026-10-01',
        first_seen_at: '2026-10-01T08:00:00+09:00',
        last_seen_at: '2026-10-02T08:00:00+09:00',
        archived: false,
      },
    ],
  };

  const merged = mergeAnnouncementHistory(
    existing,
    [
      {
        id: 2,
        course: 'Course B',
        title: 'New notice',
        posted_on: '2026-10-03',
      },
    ],
    '2026-10-03T08:00:00+09:00',
  );

  const oldItem = merged.announcements.find((item) => item.id === 1);
  const newItem = merged.announcements.find((item) => item.id === 2);

  assert.equal(oldItem.archived, true);
  assert.equal(oldItem.first_seen_at, '2026-10-01T08:00:00+09:00');
  assert.equal(newItem.archived, false);
  assert.equal(newItem.first_seen_at, '2026-10-03T08:00:00+09:00');
  assert.equal(newItem.last_seen_at, '2026-10-03T08:00:00+09:00');
  assert.equal(merged.announcements[0].id, 2);
});


test('backfill excerpts are retried when Ollama summarization is available', () => {
  assert.equal(
    shouldReuseAnnouncementSummary(
      { summary: '원문 요약', summary_source: 'backfill_excerpt' },
      { enabled: true, provider: 'ollama' },
    ),
    false,
  );

  assert.equal(
    shouldReuseAnnouncementSummary(
      { summary: 'English summary', summary_source: 'ollama' },
      { enabled: true, provider: 'ollama' },
    ),
    true,
  );
});

test('fallback excerpts are retained when Ollama summarization is disabled', () => {
  assert.equal(
    shouldReuseAnnouncementSummary(
      { summary: 'Saved excerpt', summary_source: 'backfill_excerpt' },
      { enabled: false, provider: 'ollama' },
    ),
    true,
  );
});
