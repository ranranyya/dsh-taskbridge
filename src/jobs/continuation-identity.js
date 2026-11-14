// Continuation identity: what a stored path may be READ as, and what may be
// SAVED so it can be read back later.
//
// A `continueFromTaskId` follow-up is admitted only when two durable documents
// agree on where the parent really ran. Those documents are written through
// redaction, which masks a per-profile directory under a temporary root
// (`config/redact.js`). A masked path proves nothing, so it is refused — which is
// correct, but only for a path that was ACTUALLY masked. Redaction used to mask
// ordinary repository names too (`dsh-delegate`, `dsh-taskbridge`), so a normally
// run task could not be continued after a restart.
//
// This module is the single definition of the identity a durable path carries:
//
//  * {@link canonicalPath} — the ONE spelling used to compare and to record. It is
//    the same rule the session layer keys a Workspace by (`sessionPathKey`), so the
//    two can never disagree.
//  * {@link pathDigest} — a `sha256:` digest of {@link canonicalPath}. It is the only
//    proof of "these two strings are the same directory" that survives redaction,
//    because a digest is opaque to every masking rule.
//  * {@link readPathIdentity} — what a STORED row proves: its canonical path when the
//    value is usable, plus the digest when one is stored. A masked value yields
//    neither, so it can only be refused.
//  * {@link sameRecordedDirectory} — the ONE comparison rule, including the
//    requirement that a row's own path and digest agree with each other.
//  * {@link continuationIdentityOf} — what is SAVED beside a task: the canonical
//    paths, their digests, and the Workspace/Session ids a follow-up is bound to.

import { createHash } from 'node:crypto';

/**
 * The placeholder redaction rewrites an account-identifying directory segment to.
 *
 * One segment of a stored path equal to this is a shortened spelling. It is never
 * a pattern and never equals anything, which is why the check is for the WHOLE
 * segment: a real directory whose name merely contains this text is still its own
 * directory.
 */
export const PATH_MASK_SEGMENT = 'masks-user-profile-segment';

/**
 * Whether a value cannot prove which directory it names because redaction rewrote it.
 * @param {unknown} value - candidate path.
 * @returns {boolean} true when the value was rewritten and can only be refused.
 */
export function recordedPathIsMasked(value) {
  if (typeof value !== 'string') return false;
  return value
    .split(/[\\/]+/)
    .some((part) => part.trim() === PATH_MASK_SEGMENT);
}

/**
 * The canonical key of a directory, expressed exactly as `sessionPathKey` does.
 *
 * This module cannot import `runtime/session-placement.js` (that module imports THIS
 * one), so the identical rule is restated and a test asserts the two agree for every
 * spelling: same directory, both accept; different directory, both reject. Written
 * as: trim, strip trailing separators below the root, fold case on Windows.
 * @param {unknown} value - candidate directory path.
 * @returns {string | null} canonical key, or null.
 */
export function sessionKeyOf(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const stripped = trimmed.length > 1 ? trimmed.replace(/[\\/]+$/u, '') : trimmed;
  return process.platform === 'win32' ? stripped.toLowerCase() : stripped;
}

/**
 * The one canonical spelling of a directory path.
 *
 * Built on {@link sessionKeyOf} — the same rule the session layer keys a Workspace by —
 * so this module does not invent a second spelling, and the two are cross-checked by a
 * test. On Windows the fold is over the WHOLE path, not just the drive letter: NTFS is
 * case-insensitive at every level, so `E:\repo\Src` and `E:\repo\src` are one
 * directory. Elsewhere the path keeps its case, because two POSIX paths differing only
 * in case really are two directories.
 *
 * Deliberately NOT done here: normalising `/` to `\`, or collapsing `..`. The session
 * layer does neither, and a normaliser that accepted more spellings than the layer
 * that reaches the Session would prove equality for two paths the harness treats as
 * different directories. Whatever `sessionPathKey` considers distinct stays distinct.
 * @param {unknown} value - candidate path.
 * @returns {string | null} canonical path, or null when the value is unusable.
 */
export function canonicalPath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // A masked path is NOT canonicalised: keying it would produce a plausible spelling
  // naming a directory nobody wrote, and a mask is never anything.
  if (trimmed === '' || recordedPathIsMasked(trimmed)) return null;
  return sessionKeyOf(trimmed);
}

/**
 * Whether two path values name the same directory under {@link canonicalPath}.
 * @param {unknown} a - first path.
 * @param {unknown} b - second path.
 * @returns {boolean} true when both are usable and canonicalise equal.
 */
export function sameCanonicalPath(a, b) {
  const left = canonicalPath(a);
  const right = canonicalPath(b);
  return left !== null && right !== null && left === right;
}

/**
 * A stable digest of one canonical path.
 *
 * The digest is the identity a stored row keeps when the path STRING cannot be
 * trusted for comparison (a projection that rewrote it). It is opaque to text
 * redaction, so it survives the same projection the path did not.
 * @param {unknown} value - candidate path.
 * @returns {string | null} `sha256:<hex>` digest, or null when unusable.
 */
export function pathDigest(value) {
  const canonical = canonicalPath(value);
  if (canonical === null) return null;
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/**
 * Whether a stored value is a path digest this module would have produced.
 * @param {unknown} value - candidate digest.
 * @returns {boolean} true for a well-formed digest.
 */
export function isPathDigest(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

/**
 * What one stored path field PROVES about the directory behind it.
 *
 * Two independent facts, and either may be enough:
 *
 *  * `canonical` — the value is a readable path and survives redaction, so two
 *    records carrying the same canonical value are the same directory;
 *  * `digest` — a stored digest is well formed, so a comparison can be made on the
 *    digest alone even when the path string was shortened.
 *
 * Both absent means the field proves nothing, and a caller must refuse. Nothing
 * here ever answers "any path", which is what a wildcard would be.
 * @param {unknown} value - stored path value.
 * @param {unknown} [storedDigest] - stored digest beside it, if the row has one.
 * @returns {{ canonical: string | null, digest: string | null, masked: boolean }} facts.
 */
export function readPathIdentity(value, storedDigest = null) {
  const masked = recordedPathIsMasked(value);
  const canonical = masked ? null : canonicalPath(value);
  const digest = isPathDigest(storedDigest)
    ? storedDigest
    : (canonical === null ? null : pathDigest(canonical));
  return { canonical, digest, masked };
}

/**
 * Whether two stored path fields prove they name the SAME directory.
 *
 * The rule is an EQUALITY OF USABLE EVIDENCE, and every kind of evidence a record
 * carries must agree before it proves anything:
 *
 *  1. A record that states both a readable path and a digest must have them name the
 *     same directory. A digest that contradicts its own path is a record that was
 *     edited, and NOTHING it says is used — not the path and not the digest. An
 *     earlier version let the readable path win such a case, which admitted
 *     `'E:/repo'` recorded with `pathDigest('E:/other')`.
 *  2. Then the two records are compared. Two readable paths are compared exactly; a
 *     masked side contributes only its digest, so a shortened path is never matched
 *     against a string.
 *  3. A side with no readable path AND no digest proves nothing, so the answer is
 *     `false` — an empty or masked value without a digest is a refusal, never a
 *     wildcard.
 * @param {{ path?: unknown, digest?: unknown }} left - first record.
 * @param {{ path?: unknown, digest?: unknown }} right - second record.
 * @returns {boolean} true only when both sides prove the same directory.
 */
export function sameRecordedDirectory(left, right) {
  const a = readPathIdentity(left?.path, left?.digest);
  const b = readPathIdentity(right?.path, right?.digest);
  // (1) Each side must be internally consistent before it may prove anything.
  if (!identityIsConsistent(a) || !identityIsConsistent(b)) return false;
  // (2) Both readable: an exact comparison of the canonical spellings.
  if (a.canonical !== null && b.canonical !== null) return a.canonical === b.canonical;
  // (3) At least one side is masked; both must then offer a digest, and those must match.
  if (a.digest !== null && b.digest !== null) return a.digest === b.digest;
  return false;
}

/**
 * Whether one record's own two proofs agree.
 *
 * A digest is derived from the readable path, so a well-formed digest beside a
 * readable path has exactly one permissible value. Anything else means the record is
 * inconsistent and must not be used as evidence at all.
 * @param {{ canonical: string | null, digest: string | null }} reading - one record.
 * @returns {boolean} true when the record is consistent (or states only one proof).
 */
function identityIsConsistent(reading) {
  if (reading.canonical === null || reading.digest === null) return true;
  return reading.digest === pathDigest(reading.canonical);
}

/**
 * Whether a stored path field names THIS directory, from either kind of evidence.
 * @param {{ path?: unknown, digest?: unknown }} recorded - stored record facts.
 * @param {string} directory - the directory a submission resolved.
 * @returns {boolean} true only when the record proves it.
 */
export function recordedDirectoryIs(recorded, directory) {
  return sameRecordedDirectory(recorded, { path: directory, digest: pathDigest(directory) });
}

/**
 * The identity SAVED for one task thread.
 *
 * Two facts per path, and they serve different purposes:
 *
 *  * `sourcePath` / `executionPath` keep the operator's REAL spelling. This value can
 *    be handed back to the runtime as a directory to open, so it must never be a
 *    lower-cased comparison key.
 *  * `sourcePathDigest` / `executionPathDigest` are digests of the CANONICAL key
 *    ({@link canonicalPath}), which is what a later comparison is made on.
 *
 * Storing the canonical key in the path field would look like success and then fail
 * at the first real read on a case-sensitive filesystem. Only identity is written: no
 * prompt, transcript, output, usage figure or credential has a field.
 * @param {object} task - task record with `taskId`, `sourcePath`, `executionPath`.
 * @param {object | null} placement - the run's own placement (`workspaceId`, `sessionId`).
 * @param {string | null} isolation - the isolation the run used.
 * @returns {{ taskId: string, sourcePath: string | null, executionPath: string | null,
 *   sourcePathDigest: string | null, executionPathDigest: string | null,
 *   workspaceId: string, sessionId: string, isolation: string | null } | null} identity, or null.
 */
export function continuationIdentityOf(task, placement, isolation) {
  const taskId = typeof task?.taskId === 'string' ? task.taskId.trim() : '';
  if (taskId === '') return null;
  const sourcePath = storedSpelling(task.sourcePath);
  const executionPath = storedSpelling(task.executionPath);
  return {
    taskId,
    sourcePath,
    executionPath,
    sourcePathDigest: sourcePath === null ? null : pathDigest(sourcePath),
    executionPathDigest: executionPath === null ? null : pathDigest(executionPath),
    workspaceId: typeof placement?.workspaceId === 'string' ? placement.workspaceId.trim() : '',
    sessionId: typeof placement?.sessionId === 'string' ? placement.sessionId.trim() : '',
    isolation: typeof isolation === 'string' && isolation !== '' ? isolation : null,
  };
}

/**
 * The spelling to WRITE for a path: the operator's own, trimmed, never a key.
 *
 * Returns null for a value that is not a usable path (empty, non-string, or already
 * masked), so a row cannot carry a mask as though it were a directory.
 * @param {unknown} value - candidate path.
 * @returns {string | null} the stored spelling, or null.
 */
function storedSpelling(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || recordedPathIsMasked(trimmed)) return null;
  return trimmed;
}

/**
 * The identity fields a durable history row carries.
 *
 * Kept as one list (rather than written out at the save site) so the history
 * projection, the engine and the tests name the same fields.
 */
export const CONTINUATION_IDENTITY_FIELDS = Object.freeze([
  'sourcePathDigest',
  'executionPathDigest',
  'workspaceId',
  'sessionId',
]);
