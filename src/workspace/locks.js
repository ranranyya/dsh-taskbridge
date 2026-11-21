// Workspace coordination: mutual exclusion per workspace and an audit trail of
// what a job actually changed on disk.
//
// Two guarantees, both enforced here rather than trusted from the agent:
//  1. At most one job mutates a given workspace at a time. The lock is
//     in-process, nonce-fenced and lease-bounded, so a stuck job cannot hold it
//     forever and a stale release cannot free another job's lock.
//     An exception to "at most one": a *shared* preparation hold may be taken by
//     any number of jobs at once, while any exclusive hold on the same path
//     refuses it and is refused by it. That is what lets two isolated runs of one
//     source directory prepare their Git trees one at a time without the whole
//     run having to be serialised (see {@link WorkspaceLocks#acquire}).
//  2. What a job changed is measured by reading git state before and after, not
//     by believing the agent's own summary.

import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/** Lock refusal codes. */
export const LOCK_CODES = Object.freeze({
  busy: 'WORKSPACE_BUSY',
  invalid: 'WORKSPACE_INVALID',
});

/** An operation refused because the workspace is unavailable for it. */
export class WorkspaceError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - human-readable explanation.
   * @param {object} [details] - bounded details.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Resolve a workspace path to its real absolute path.
 *
 * Refuses rather than guesses: a path that does not resolve is a refusal, and
 * the resolved value is what later boundary checks compare against so a symlink
 * cannot be used to escape the workspace.
 * @param {string} candidate - absolute workspace path.
 * @returns {Promise<string>} resolved real path.
 */
export async function resolveWorkspacePath(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new WorkspaceError(LOCK_CODES.invalid, 'a workspace path is required', {});
  }
  const absolute = candidate.trim();
  if (!(absolute.startsWith('/') || /^[A-Za-z]:[\\/]/.test(absolute) || absolute.startsWith('\\\\'))) {
    throw new WorkspaceError(LOCK_CODES.invalid, 'workspace path must be absolute', {});
  }
  try {
    return await realpath(resolve(absolute));
  } catch (error) {
    throw new WorkspaceError(LOCK_CODES.invalid, 'workspace path could not be resolved', {
      cause: error?.code ?? null,
    });
  }
}

/**
 * Whether `target` is inside `root`. Case-folded on Windows where paths are
 * compared case-insensitively.
 * @param {string} root - resolved workspace root.
 * @param {string} target - resolved candidate path.
 * @returns {boolean} true when contained (or equal).
 */
export function isInside(root, target) {
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const base = normalize(root).replace(/[\\/]+$/, '');
  const candidate = normalize(target);
  if (candidate === base) return true;
  const withSep = base.endsWith(sep) ? base : `${base}${sep}`;
  return candidate.startsWith(withSep);
}

/** The two lease modes {@link WorkspaceLocks} keeps. */
export const LOCK_MODES = Object.freeze({
  // The whole path belongs to one job for as long as the lease lives.
  exclusive: 'exclusive',
  // A short, SHARED hold for work done on behalf of a run but not inside its own
  // workspace: creating a Git worktree, reading the pinned commit, removing a
  // half-created tree. Several runs of one source may prepare at once; a run that
  // actually writes to the source holds it exclusively and excludes them.
  preparation: 'preparation',
});

/**
 * In-process workspace lock registry.
 *
 * The lock is not a file: two DSH processes would still be able to race. That
 * limitation is documented in docs/native-integration-audit.md rather than
 * papered over with a lockfile that looks stronger than it is.
 *
 * Leases are kept per path as a set, each lease carrying its own mode, so one
 * path can be held exclusively by one job while another job only prepared it:
 *
 *  - **exclusive** (the default) — nothing else may hold the path, in any mode.
 *  - **preparation** — several preparations may share the path, and none of them
 *    excludes the others; an exclusive lease refuses them and is refused by
 *    them.
 *
 * Why the second mode exists: two isolated runs of the SAME source repository are
 * separate checkouts, but the Git worktree-creation step touches the source's
 * administrative area and reads its status. Holding the source exclusively for
 * the whole run therefore refused the second isolated job with
 * `WORKSPACE_BUSY` even though the two runs never write to one file in common.
 * The preparation hold keeps that step serialised without serialising the runs.
 *
 * The mode belongs to the LEASE, not to the path, so a task can hold a
 * preparation lease, release it, and later hold the same path exclusively — and a
 * release names the nonce it holds, so it can never free a sibling's lease.
 */
export class WorkspaceLocks {
  /**
   * @param {object} [options] - `now` clock override and `maxHoldMs` lease.
   */
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.maxHoldMs = options.maxHoldMs ?? 150 * 60 * 1000;
    /** @type {Map<string, Map<string, object>>} path key -> own leases by nonce. */
    this.held = new Map();
  }

  /**
   * Acquire a lease for a workspace without waiting.
   *
   * Synchronous, and the decision and the claim happen in one step: a refusal and
   * a claim can never both observe the same free path. Ordering among waiting
   * callers (the engine's preparation queue) is the caller's business; waiting
   * here would make one hung caller able to block the registry.
   * @param {string} workspacePath - resolved absolute workspace path.
   * @param {object} [input] - `taskId` for diagnostics, `mode`:
   *   {@link LOCK_MODES.exclusive} (default) or {@link LOCK_MODES.preparation}, and
   *   `explicitRelease: true` for a lease that is returned ONLY by
   *   {@link release} — see {@link LOCK_MODES.exclusive} usage in the engine.
   * @returns {object} the lease, including its nonce and mode.
   */
  acquire(workspacePath, input = {}) {
    const key = lockKey(workspacePath);
    this.sweepKey(key);
    const mode = normalizeMode(input.mode);
    const explicit = input.explicitRelease === true;
    const existing = this.held.get(key);
    const live = existing === undefined ? [] : [...existing.values()];
    const blocker = live.find((lease) => lease.mode === LOCK_MODES.exclusive || mode === LOCK_MODES.exclusive);
    if (blocker !== undefined) {
      const shared = live.filter((lease) => lease.mode === LOCK_MODES.preparation).length;
      throw new WorkspaceError(
        LOCK_CODES.busy,
        blocker.mode === LOCK_MODES.exclusive && mode === LOCK_MODES.preparation
          ? 'another job is running in this workspace, so it cannot be prepared for another run'
          : 'another job is already running in this workspace',
        {
          taskId: blocker.taskId,
          since: blocker.acquiredAt,
          // Which lease refused, and in which mode: a caller can tell "one run holds
          // the directory" from "another run is only preparing it".
          mode: blocker.mode,
          requestedMode: mode,
          preparations: shared,
        },
      );
    }
    const lease = {
      nonce: randomUUID(),
      workspacePath,
      mode,
      taskId: typeof input.taskId === 'string' ? input.taskId : null,
      acquiredAt: this.now(),
      // An explicitly released lease has NO expiry: it belongs to an execution that
      // can legitimately run for hours (a delegated run normally has no total time
      // limit), and expiring it would hand the directory to a second writer while the
      // first one is still working. Such a lease is returned by {@link release} and by
      // nothing else; {@link releaseAll} on dispose covers the teardown case.
      expiresAt: explicit ? Infinity : this.now() + this.maxHoldMs,
      explicitRelease: explicit,
    };
    if (existing === undefined) this.held.set(key, new Map([[lease.nonce, lease]]));
    else existing.set(lease.nonce, lease);
    return { ...lease };
  }

  /**
   * Release a lease. A release with the wrong nonce is a no-op, so one job can
   * never release another job's lock — including a sibling's shared preparation
   * lease on the same path.
   * @param {string} workspacePath - locked workspace.
   * @param {string} nonce - lease nonce returned by {@link acquire}.
   * @returns {boolean} true when this call actually released the lock.
   */
  release(workspacePath, nonce) {
    const key = lockKey(workspacePath);
    const existing = this.held.get(key);
    if (existing === undefined) return false;
    const released = existing.delete(nonce);
    if (existing.size === 0) this.held.delete(key);
    return released;
  }

  /**
   * Whether a workspace is currently locked by a live lease.
   * @param {string} workspacePath - workspace to test.
   * @param {object} [options] - `mode` narrows the question to leases of that mode.
   * @returns {boolean} true when locked.
   */
  isLocked(workspacePath, options = {}) {
    const key = lockKey(workspacePath);
    this.sweepKey(key);
    const live = this.held.get(key);
    if (live === undefined) return false;
    const mode = typeof options.mode === 'string' ? normalizeMode(options.mode) : null;
    for (const lease of live.values()) {
      if (mode === null || lease.mode === mode) return true;
    }
    return false;
  }

  /**
   * Describe the live leases on one path, for diagnostics and tests. Names and
   * modes only: no content, no actor identity.
   * @param {string} workspacePath - workspace to describe.
   * @returns {object[]} live leases, oldest first.
   */
  describe(workspacePath) {
    const key = lockKey(workspacePath);
    this.sweepKey(key);
    const live = this.held.get(key);
    if (live === undefined) return [];
    return [...live.values()]
      .sort((a, b) => a.acquiredAt - b.acquiredAt)
      .map((lease) => ({ mode: lease.mode, taskId: lease.taskId, acquiredAt: lease.acquiredAt }));
  }

  /**
   * Drop every lease. Used on dispose: a shutdown must not leave a workspace
   * unacquirable in the next process.
   * @returns {number} number of leases dropped.
   */
  releaseAll() {
    let count = 0;
    for (const live of this.held.values()) count += live.size;
    this.held.clear();
    return count;
  }

  /**
   * Drop live leases whose bound expired, so an abandoned preparation cannot keep
   * a source directory unacquirable for the rest of the process's life.
   *
   * A lease acquired with `explicitRelease: true` has no bound and is never swept
   * here: it belongs to a run that is still working, and expiring it would let a
   * second job into a directory the first one is writing to.
   * @param {string} key - normalized path key.
   * @returns {void}
   */
  sweepKey(key) {
    const live = this.held.get(key);
    if (live === undefined) return;
    const now = this.now();
    for (const [nonce, lease] of live) {
      if (lease.explicitRelease === true) continue;
      if (now >= lease.expiresAt) live.delete(nonce);
    }
    if (live.size === 0) this.held.delete(key);
  }
}

/**
 * Normalize a requested lease mode. Anything unrecognized is the exclusive mode:
 * an unknown value must never be read as the weaker guarantee.
 * @param {unknown} mode - requested mode.
 * @returns {string} one of {@link LOCK_MODES}.
 */
function normalizeMode(mode) {
  return mode === LOCK_MODES.preparation ? LOCK_MODES.preparation : LOCK_MODES.exclusive;
}

function lockKey(workspacePath) {
  const normalized = String(workspacePath).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
