import crypto from 'node:crypto';

const text = (value) => String(value ?? '').trim();

export function announcementKey(item) {
  return String(item?.id ?? item?.announcement_id ?? item?.article_id ?? '');
}

export function announcementBodyHash(item) {
  const payload = [
    text(item?.source_title || item?.title),
    text(item?.author),
    text(item?.posted_on),
    text(item?.body),
  ].join('\n');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function mergeAnnouncementHistory(existingDocument, currentAnnouncements, seenAt) {
  const previousItems = Array.isArray(existingDocument?.announcements) ? existingDocument.announcements : [];
  const currentKeys = new Set();
  const byKey = new Map(previousItems.map((item) => [announcementKey(item), { ...item }]));

  for (const item of currentAnnouncements || []) {
    const key = announcementKey(item);
    if (!key) continue;
    currentKeys.add(key);
    const prior = byKey.get(key);
    byKey.set(key, {
      ...(prior || {}),
      ...item,
      first_seen_at: prior?.first_seen_at || item.first_seen_at || seenAt,
      last_seen_at: seenAt,
      archived: false,
    });
  }

  for (const [key, item] of byKey.entries()) {
    if (currentKeys.has(key)) continue;
    byKey.set(key, { ...item, archived: true });
  }

  const announcements = [...byKey.values()].sort((a, b) => {
    const aTime = Date.parse(a.posted_on || a.last_seen_at || 0);
    const bTime = Date.parse(b.posted_on || b.last_seen_at || 0);
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
    return announcementKey(b).localeCompare(announcementKey(a));
  });

  return {
    schema_version: 1,
    updated_at: seenAt,
    announcements,
  };
}


export function shouldReuseAnnouncementSummary(prior, options = {}) {
  if (!prior?.summary) return false;

  const enabled = options.enabled !== false;
  const provider = options.provider || 'ollama';
  const source = String(prior.summary_source || '');

  // A real Ollama summary is final until the announcement body changes.
  if (source === 'ollama') return true;

  // When local summarization is unavailable by configuration, keep the best
  // existing fallback instead of recomputing the same excerpt every scan.
  if (!enabled || provider !== 'ollama') return true;

  // Excerpts are provisional. Once Ollama is available, retry them so
  // historical/backfilled announcements are eventually summarized in English.
  if (['backfill_excerpt', 'excerpt', 'excerpt_after_ollama_failure'].includes(source)) {
    return false;
  }

  return false;
}
