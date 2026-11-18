// Shared contract for `goalDescription` and `completionSummary`: <= 2000 Unicode code points
// (Chinese, newlines and emoji count once), trimmed, non-strings refused, re-checked post-redaction.

export const TASK_DESCRIPTION_MAX_CHARS = 2_000;

export const TASK_DESCRIPTION_FIELDS = Object.freeze({
  goal: 'goalDescription',
  summary: 'completionSummary',
});

export function normalizeTaskDescription(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function taskDescriptionLength(value) {
  return typeof value === 'string' ? Array.from(value).length : 0;
}

/** Build refusal facts naming field, measured code-point length and limit (never echoing text). */
export function taskDescriptionRefusal(field, value, reason) {
  const limit = TASK_DESCRIPTION_MAX_CHARS;
  const length = taskDescriptionLength(value);
  if (reason === 'type') {
    return {
      field,
      limit,
      length,
      unit: 'unicode-code-points',
      message: `${field} must be a string of at most ${limit} Unicode code points`,
    };
  }
  return {
    field,
    limit,
    length,
    unit: 'unicode-code-points',
    message: `${field} must be at most ${limit} Unicode code points, but it is ${length}`,
  };
}

export function taskDescriptionPresent(value) {
  if (value === undefined) return false;
  return typeof value === 'string' ? value.trim() !== '' : true;
}

export function readTaskDescription(value, field) {
  if (!taskDescriptionPresent(value)) return { ok: true, value: null, length: 0 };
  if (typeof value !== 'string') {
    return { ok: false, refusal: taskDescriptionRefusal(field, value, 'type') };
  }
  const text = value.trim();
  if (text === '') return { ok: true, value: null, length: 0 };
  const length = taskDescriptionLength(text);
  if (length > TASK_DESCRIPTION_MAX_CHARS) {
    return { ok: false, refusal: taskDescriptionRefusal(field, text, 'length') };
  }
  return { ok: true, value: text, length };
}

/** Canonicalize once: type, trim, inbound bound, redact, and post-redaction bound. */
export function canonicalTaskDescription(value, field, redact) {
  const read = readTaskDescription(value, field);
  if (read.ok === false) return read;
  if (read.value === null) return read;
  const masked = typeof redact === 'function' ? redact(read.value) : read.value;
  const stored = typeof masked === 'string' ? masked.trim() : '';
  if (stored === '') return { ok: true, value: null, length: 0 };
  const length = taskDescriptionLength(stored);
  if (length > TASK_DESCRIPTION_MAX_CHARS) {
    return { ok: false, refusal: taskDescriptionRefusal(field, stored, 'length') };
  }
  return { ok: true, value: stored, length };
}

/** Load-only code-point truncation leaving room for a marker without splitting surrogate pairs. */
export function truncateTaskDescription(value, markerChars = 0, limit = TASK_DESCRIPTION_MAX_CHARS) {
  if (typeof value !== 'string' || value === '') return null;
  const points = Array.from(value);
  if (points.length <= limit) return value;
  const keep = Math.max(0, limit - Math.max(0, Math.trunc(markerChars)));
  return points.slice(0, keep).join('');
}
