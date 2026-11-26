// Safe, zero-destruction worktree-to-source synchronization.
//
// Called ONLY after a durable `accepted` host review when the host explicitly passes
// `applyToSource: true` on a `worktree`-isolated task.
//
// Guarantees enforced before a single byte of `sourcePath` is mutated:
//  1. Both `sourcePath` and `executionPath` are real directories held under exclusive
//     in-process workspace leases (acquired in canonical path order to avoid deadlocks).
//  2. Both checkouts are Git worktree roots whose `HEAD` still equals the pinned `baseHead`.
//  3. Every touched relative path (tracked diff + untracked files) is validated against
//     traversal, `.git/` internals, Windows ADS/drive syntax, symlinks (on disk AND in Git
//     mode `120000`), submodules (`160000`), and `isSensitivePath`.
//  4. Idempotency: if `sourcePath` already matches every changed/deleted file in
//     `executionPath` byte-for-byte, the sync answers `already-synced` without failing.
//  5. Conflict precheck: any overlapping uncommitted edit in `sourcePath`, any untracked
//     collision with different content, or any `git apply --check` failure aborts with
//     ZERO bytes modified in `sourcePath` and returns the bounded `conflictingPaths` list.
//  6. Never stages (`git add`), commits (`git commit`), stashes, or pushes.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, win32 } from 'node:path';

import { isSensitivePath, redactText } from '../config/redact.js';
import { AUDIT_LIMITS, parseStatusZ } from './audit.js';
import { LOCK_CODES, LOCK_MODES, isInside, resolveWorkspacePath } from './locks.js';

/** Hard safety bounds for worktree-to-source sync. */
export const SOURCE_SYNC_LIMITS = Object.freeze({
  maxFiles: AUDIT_LIMITS.statusEntries,
  maxReportedFiles: AUDIT_LIMITS.files,
  maxReportedConflicts: 100,
  maxPatchBytes: 16 * 1024 * 1024,
  maxUntrackedTotalBytes: 32 * 1024 * 1024,
  gitTimeoutMs: 15_000,
  stderrChars: 400,
});

/** Closed vocabulary of machine-readable sync reasons. */
export const SOURCE_SYNC_REASONS = Object.freeze({
  synced: 'synced',
  alreadySynced: 'already-synced',
  noChanges: 'no-changes',
  sharedInPlace: 'shared-in-place',
  conflict: 'conflict',
  sourceHeadChanged: 'source-head-changed',
  executionHeadChanged: 'execution-head-changed',
  sensitivePathBlocked: 'sensitive-path-blocked',
  unsafePath: 'symlink-or-unsafe-path',
  workspaceBusy: 'workspace-busy',
  delegationDisabled: 'delegation-disabled',
  reviewNotDurable: 'review-not-durable',
  baselineMissing: 'baseline-missing',
  pathUnavailable: 'path-unavailable',
  tooManyChanges: 'too-many-changes',
  patchTooLarge: 'patch-too-large',
  applyFailed: 'apply-failed',
  gitUnavailable: 'git-unavailable',
});

const SHA_RE = /^[0-9a-f]{40}$/iu;

function samePath(left, right) {
  if (process.platform === 'win32') {
    return win32.normalize(String(left)).toLowerCase() === win32.normalize(String(right)).toLowerCase();
  }
  const trim = (value) => String(value).replace(/[\\/]+$/, '');
  return trim(left) === trim(right);
}

function lockOrderKey(path) {
  const normalized = String(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function boundedList(items, limit) {
  const unique = [...new Set(items)].sort();
  return {
    items: unique.slice(0, limit),
    total: unique.length,
    truncated: unique.length > limit,
  };
}

function syncOutcome({ applied, reason, changedFiles = [], conflictingPaths = [], error = null }) {
  const files = boundedList(changedFiles, SOURCE_SYNC_LIMITS.maxReportedFiles);
  const conflicts = boundedList(conflictingPaths, SOURCE_SYNC_LIMITS.maxReportedConflicts);
  return {
    applied: applied === true,
    reason,
    changedFiles: files.items,
    ...(files.truncated ? { changedFilesTotal: files.total, changedFilesTruncated: true } : {}),
    conflictingPaths: conflicts.items,
    ...(conflicts.truncated ? { conflictingPathsTotal: conflicts.total } : {}),
    ...(typeof error === 'string' && error !== '' ? { error: redactText(error).slice(0, SOURCE_SYNC_LIMITS.stderrChars) } : {}),
  };
}

/**
 * Execute git with exact binary stdout and optional binary stdin.
 * @param {string} cwd - working directory.
 * @param {string[]} args - git arguments.
 * @param {{ input?: Buffer, timeoutMs?: number, maxBytes?: number }} [options] - runner options.
 * @returns {Promise<{ ok: true, code: number, stdout: Buffer, stderr: Buffer } | { ok: false, unavailable: boolean, message: string }>} result.
 */
function runGitBinary(cwd, args, options = {}) {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : SOURCE_SYNC_LIMITS.gitTimeoutMs;
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : SOURCE_SYNC_LIMITS.maxPatchBytes;
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : '';
      resolvePromise({
        ok: false,
        unavailable: code === 'ENOENT' || code === 'EPERM' || code === 'EACCES',
        message: error?.message ?? 'git could not be spawned',
      });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let overflow = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ ok: false, unavailable: false, message: 'git timed out' });
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > maxBytes) {
        overflow = true;
        try { child.kill(); } catch { /* ignore */ }
        return;
      }
      outChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (errBytes < 64 * 1024) {
        errChunks.push(chunk);
        errBytes += chunk.length;
      }
    });
    child.on('error', (error) => {
      const code = typeof error?.code === 'string' ? error.code : '';
      finish({
        ok: false,
        unavailable: code === 'ENOENT' || code === 'EPERM' || code === 'EACCES',
        message: error?.message ?? 'git failed to spawn',
      });
    });
    child.on('close', (code) => {
      if (overflow) {
        finish({ ok: false, unavailable: false, overflow: true, message: 'git output exceeded size limit' });
        return;
      }
      finish({
        ok: true,
        code: typeof code === 'number' ? code : 1,
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks),
      });
    });

    child.stdin.on('error', () => { /* ignore EPIPE if git exits early */ });
    if (Buffer.isBuffer(options.input) && options.input.length > 0) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Validate a git-reported relative POSIX path for safe filesystem resolution.
 * @param {string} relPath - relative path from git output.
 * @returns {string[] | null} validated path segments, or null if unsafe.
 */
function safeSegments(relPath) {
  if (typeof relPath !== 'string' || relPath === '' || relPath.includes('\0')) return null;
  if (/[\x00-\x1f]/u.test(relPath)) return null;
  if (relPath.startsWith('/') || relPath.startsWith('\\') || relPath.includes(':')) return null;
  const parts = relPath.split(/[\\/]/u);
  if (parts.length === 0) return null;
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return null;
  }
  if (parts[0].toLowerCase() === '.git') return null;
  return parts;
}

/**
 * Parse `git diff --raw -z <baseHead>` output.
 * @param {string} stdout - NUL-delimited raw diff output.
 * @returns {Array<{ oldMode: string, newMode: string, status: string, path: string, from: string | null }>} entries.
 */
function parseRawDiffZ(stdout) {
  if (typeof stdout !== 'string' || stdout === '') return [];
  const tokens = stdout.split('\0');
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const meta = tokens[index];
    if (meta === '') continue;
    if (!meta.startsWith(':')) continue;
    const match = /^:([0-7]{6})\s+([0-7]{6})\s+[0-9a-f]+\s+[0-9a-f]+\s+([A-Z][0-9]*)$/iu.exec(meta);
    if (match === null) continue;
    const [, oldMode, newMode, status] = match;
    const isRenameOrCopy = status.startsWith('R') || status.startsWith('C');
    const firstPath = tokens[index + 1] ?? '';
    if (firstPath === '') continue;
    index += 1;
    let from = null;
    let path = firstPath;
    if (isRenameOrCopy) {
      const secondPath = tokens[index + 1] ?? '';
      if (secondPath !== '') {
        from = firstPath;
        path = secondPath;
        index += 1;
      }
    }
    entries.push({ oldMode, newMode, status, path, from });
  }
  return entries;
}

/**
 * Inspect a path and every existing ancestor inside `root` without following symlinks.
 * @param {string} root - resolved real workspace root.
 * @param {string[]} parts - validated relative path segments.
 * @returns {Promise<{ ok: true, target: string, stat: import('node:fs').Stats | null } | { ok: false, reason: 'symlink' | 'not-directory' | 'not-file' | 'outside' }>} result.
 */
async function inspectPathChain(root, parts) {
  const target = resolve(root, ...parts);
  if (!isInside(root, target) || samePath(root, target)) {
    return { ok: false, reason: 'outside' };
  }
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor = join(cursor, parts[i]);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) return { ok: false, reason: 'symlink' };
      if (!info.isDirectory()) return { ok: false, reason: 'not-directory' };
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: true, target, stat: null };
      throw error;
    }
  }
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    if (!info.isFile()) return { ok: false, reason: 'not-file' };
    return { ok: true, target, stat: info };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, target, stat: null };
    throw error;
  }
}

/**
 * Extract candidate file paths mentioned in `git apply --check` stderr diagnostics.
 * @param {string} stderrText - git stderr output.
 * @returns {string[]} extracted relative paths.
 */
function parseApplyConflictPaths(stderrText) {
  const paths = [];
  for (const line of String(stderrText ?? '').split(/\r?\n/u)) {
    const patterns = [
      /^error:\s+patch failed:\s+(.+?):\d+$/u,
      /^error:\s+(.+?):\s+(?:patch does not apply|already exists in working directory|does not exist in working tree|No such file or directory)/u,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(line.trim());
      if (match !== null && match[1]) {
        paths.push(match[1].trim());
        break;
      }
    }
  }
  return paths;
}

async function writeBufferAtomic(targetPath, content, mode = null) {
  const parent = dirname(targetPath);
  await mkdir(parent, { recursive: true });
  const tempPath = join(parent, `.dsh-sync-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tempPath, content, mode !== null ? { mode } : undefined);
    await rename(tempPath, targetPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function removeEmptyAncestors(root, relParts) {
  let cursor = dirname(resolve(root, ...relParts));
  while (!samePath(cursor, root) && isInside(root, cursor)) {
    try {
      await rmdir(cursor);
    } catch {
      break;
    }
    cursor = dirname(cursor);
  }
}

async function readHead(gitExec, cwd) {
  const top = await gitExec(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { ok: false, unavailable: top.unavailable, message: top.message };
  if (top.code !== 0) return { ok: false, unavailable: false, notRepo: true, message: top.stderr.toString('utf8').trim() };
  const topLevel = top.stdout.toString('utf8').trim();
  const realTop = await resolveWorkspacePath(topLevel).catch(() => topLevel);
  if (!samePath(realTop, cwd)) {
    return { ok: false, unavailable: false, notRoot: true, message: 'path is not a git worktree root' };
  }
  const head = await gitExec(cwd, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok) return { ok: false, unavailable: head.unavailable, message: head.message };
  if (head.code !== 0) return { ok: false, unavailable: false, notRepo: true, message: head.stderr.toString('utf8').trim() };
  return { ok: true, head: head.stdout.toString('utf8').trim() };
}

/**
 * Synchronize an accepted isolated worktree's changes back into `sourcePath`.
 * @param {object} request - `{ sourcePath, executionPath, baseHead, locks?, taskId?, gitExec? }`.
 * @returns {Promise<object>} bounded structured `sourceSync` receipt.
 */
export async function syncWorktreeToSource(request) {
  const baseHead = typeof request?.baseHead === 'string' ? request.baseHead.trim() : '';
  if (!SHA_RE.test(baseHead)) {
    return syncOutcome({ applied: false, reason: SOURCE_SYNC_REASONS.baselineMissing });
  }
  let realSource;
  let realExec;
  try {
    realSource = await resolveWorkspacePath(request?.sourcePath);
    realExec = await resolveWorkspacePath(request?.executionPath);
  } catch (error) {
    return syncOutcome({ applied: false, reason: SOURCE_SYNC_REASONS.pathUnavailable, error: error?.message ?? null });
  }
  if (samePath(realSource, realExec)) {
    return syncOutcome({ applied: true, reason: SOURCE_SYNC_REASONS.sharedInPlace });
  }

  const gitExec = typeof request?.gitExec === 'function' ? request.gitExec : runGitBinary;
  const locks = request?.locks ?? null;
  const leases = [];
  if (locks !== null && typeof locks.acquire === 'function') {
    const ordered = [realSource, realExec].sort((a, b) => lockOrderKey(a).localeCompare(lockOrderKey(b)));
    try {
      for (const target of ordered) {
        leases.push(locks.acquire(target, {
          taskId: typeof request?.taskId === 'string' ? `${request.taskId}:sync` : 'source-sync',
          mode: LOCK_MODES.exclusive,
        }));
      }
    } catch (error) {
      for (const lease of leases) locks.release(lease.workspacePath, lease.nonce);
      if (error?.code === LOCK_CODES.busy) {
        return syncOutcome({ applied: false, reason: SOURCE_SYNC_REASONS.workspaceBusy });
      }
      return syncOutcome({ applied: false, reason: SOURCE_SYNC_REASONS.pathUnavailable, error: error?.message ?? null });
    }
  }

  try {
    // 1. Verify both roots and pinned HEAD commits before inspecting diffs.
    const execHead = await readHead(gitExec, realExec);
    if (!execHead.ok) {
      return syncOutcome({
        applied: false,
        reason: execHead.unavailable ? SOURCE_SYNC_REASONS.gitUnavailable : SOURCE_SYNC_REASONS.pathUnavailable,
        error: execHead.message,
      });
    }
    if (execHead.head !== baseHead) {
      return syncOutcome({ applied: false, reason: SOURCE_SYNC_REASONS.executionHeadChanged });
    }
    const sourceHead = await readHead(gitExec, realSource);
    if (!sourceHead.ok) {
      return syncOutcome({
        applied: false,
        reason: sourceHead.unavailable ? SOURCE_SYNC_REASONS.gitUnavailable : SOURCE_SYNC_REASONS.pathUnavailable,
        error: sourceHead.message,
      });
    }
    if (sourceHead.head !== baseHead) {
      return syncOutcome({ applied: false, reason: SOURCE_SYNC_REASONS.sourceHeadChanged });
    }

    // 2. Enumerate tracked diff (`--raw -z` + `--cached --raw -z`) and full status in both trees.
    const [execStatusRes, rawDiffRes, cachedDiffRes, sourceStatusRes] = await Promise.all([
      gitExec(realExec, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      gitExec(realExec, ['diff', '--raw', '-z', '--no-ext-diff', baseHead]),
      gitExec(realExec, ['diff', '--cached', '--raw', '-z', '--no-ext-diff', baseHead]),
      gitExec(realSource, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ]);
    for (const res of [execStatusRes, rawDiffRes, cachedDiffRes, sourceStatusRes]) {
      if (!res.ok) {
        return syncOutcome({
          applied: false,
          reason: res.unavailable
            ? SOURCE_SYNC_REASONS.gitUnavailable
            : (res.overflow ? SOURCE_SYNC_REASONS.tooManyChanges : SOURCE_SYNC_REASONS.applyFailed),
          error: res.message,
        });
      }
      if (res.code !== 0) {
        return syncOutcome({
          applied: false,
          reason: SOURCE_SYNC_REASONS.applyFailed,
          error: res.stderr.toString('utf8').trim(),
        });
      }
    }

    const execStatus = parseStatusZ(execStatusRes.stdout.toString('utf8'), SOURCE_SYNC_LIMITS.maxFiles);
    const sourceStatus = parseStatusZ(sourceStatusRes.stdout.toString('utf8'), SOURCE_SYNC_LIMITS.maxFiles);
    if (execStatus.truncated || sourceStatus.truncated) {
      return syncOutcome({ applied: false, reason: SOURCE_SYNC_REASONS.tooManyChanges });
    }
    const rawDiffEntries = parseRawDiffZ(rawDiffRes.stdout.toString('utf8'));
    const cachedDiffEntries = parseRawDiffZ(cachedDiffRes.stdout.toString('utf8'));
    const allRawDiffEntries = [...rawDiffEntries, ...cachedDiffEntries];
    const untrackedPaths = execStatus.entries
      .filter((entry) => entry.code === '??')
      .map((entry) => entry.path);

    const touchedSet = new Set();
    const deletedOrRenamedFrom = [];
    for (const entry of rawDiffEntries) {
      touchedSet.add(entry.path);
      if (entry.from !== null) {
        touchedSet.add(entry.from);
        deletedOrRenamedFrom.push(entry.from);
      }
      if (entry.status === 'D') deletedOrRenamedFrom.push(entry.path);
    }
    for (const entry of execStatus.entries) {
      touchedSet.add(entry.path);
      if (entry.from !== null) touchedSet.add(entry.from);
    }
    const touchedPaths = [...touchedSet].sort();

    if (touchedPaths.length === 0 && allRawDiffEntries.length === 0) {
      return syncOutcome({ applied: true, reason: SOURCE_SYNC_REASONS.noChanges, changedFiles: [] });
    }
    if (touchedPaths.length > SOURCE_SYNC_LIMITS.maxFiles) {
      return syncOutcome({ applied: false, reason: SOURCE_SYNC_REASONS.tooManyChanges });
    }

    // 3. Validate git modes (both working tree and index), path safety, sensitivity, and symlinks.
    const unsafePaths = [];
    const sensitivePaths = [];
    for (const entry of allRawDiffEntries) {
      if (entry.oldMode === '120000' || entry.newMode === '120000'
        || entry.oldMode === '160000' || entry.newMode === '160000') {
        unsafePaths.push(entry.path);
      }
    }
    const segmentsByPath = new Map();
    for (const rel of touchedPaths) {
      const parts = safeSegments(rel);
      if (parts === null) {
        unsafePaths.push(rel);
        continue;
      }
      segmentsByPath.set(rel, parts);
      if (isSensitivePath(rel)) {
        sensitivePaths.push(rel);
      }
    }
    if (sensitivePaths.length > 0) {
      return syncOutcome({
        applied: false,
        reason: SOURCE_SYNC_REASONS.sensitivePathBlocked,
        conflictingPaths: sensitivePaths,
      });
    }
    if (unsafePaths.length > 0) {
      return syncOutcome({
        applied: false,
        reason: SOURCE_SYNC_REASONS.unsafePath,
        conflictingPaths: unsafePaths,
      });
    }

    const execInspect = new Map();
    const sourceInspect = new Map();
    for (const rel of touchedPaths) {
      const parts = segmentsByPath.get(rel);
      const [eInfo, sInfo] = await Promise.all([
        inspectPathChain(realExec, parts),
        inspectPathChain(realSource, parts),
      ]);
      if (!eInfo.ok) {
        unsafePaths.push(rel);
        continue;
      }
      if (!sInfo.ok) {
        if (sInfo.reason === 'symlink' || sInfo.reason === 'outside') {
          unsafePaths.push(rel);
        } else {
          // A regular file where a directory is needed or a directory where a file is needed.
          sourceInspect.set(rel, sInfo);
        }
        continue;
      }
      execInspect.set(rel, eInfo);
      sourceInspect.set(rel, sInfo);
    }
    if (unsafePaths.length > 0) {
      return syncOutcome({
        applied: false,
        reason: SOURCE_SYNC_REASONS.unsafePath,
        conflictingPaths: unsafePaths,
      });
    }

    // 4. Read untracked file buffers (bounded), generate tracked patch, and check idempotency.
    const untrackedSet = new Set(untrackedPaths);
    const trackedPaths = touchedPaths.filter((rel) => !untrackedSet.has(rel));
    const untrackedBuffers = new Map();
    let totalUntrackedBytes = 0;
    let untrackedAllMatch = true;
    const conflictingPaths = [];

    for (const rel of touchedPaths) {
      const sInfo = sourceInspect.get(rel);
      if (sInfo === undefined || !sInfo.ok) {
        untrackedAllMatch = false;
        conflictingPaths.push(rel);
      }
    }

    for (const rel of untrackedPaths) {
      const eInfo = execInspect.get(rel);
      const sInfo = sourceInspect.get(rel);
      if (eInfo?.stat === null || eInfo?.stat === undefined) continue;
      totalUntrackedBytes += eInfo.stat.size;
      if (totalUntrackedBytes > SOURCE_SYNC_LIMITS.maxUntrackedTotalBytes) {
        return syncOutcome({ applied: false, reason: SOURCE_SYNC_REASONS.patchTooLarge });
      }
      const execBytes = await readFile(eInfo.target);
      untrackedBuffers.set(rel, { bytes: execBytes, mode: eInfo.stat.mode & 0o777 });
      if (sInfo === undefined || !sInfo.ok) {
        untrackedAllMatch = false;
        continue;
      }
      if (sInfo.stat === null) {
        untrackedAllMatch = false;
      } else {
        const sourceBytes = await readFile(sInfo.target);
        if (!execBytes.equals(sourceBytes)) {
          untrackedAllMatch = false;
          conflictingPaths.push(rel);
        }
      }
    }

    let trackedPatch = Buffer.alloc(0);
    if (rawDiffEntries.length > 0) {
      const diffRes = await gitExec(realExec, ['diff', '--binary', '--no-ext-diff', baseHead], {
        maxBytes: SOURCE_SYNC_LIMITS.maxPatchBytes,
      });
      if (!diffRes.ok) {
        return syncOutcome({
          applied: false,
          reason: diffRes.overflow ? SOURCE_SYNC_REASONS.patchTooLarge : SOURCE_SYNC_REASONS.applyFailed,
          error: diffRes.message,
        });
      }
      if (diffRes.code !== 0) {
        return syncOutcome({
          applied: false,
          reason: SOURCE_SYNC_REASONS.applyFailed,
          error: diffRes.stderr.toString('utf8').trim(),
        });
      }
      trackedPatch = diffRes.stdout;
    }

    // Check tracked idempotency via Git's own diff (respects repo `core.autocrlf` cleanly)
    // plus staged-new files that exist untracked in `sourcePath` after a prior sync.
    let trackedAllMatch = rawDiffEntries.length === 0;
    if (!trackedAllMatch && conflictingPaths.length === 0 && trackedPaths.length > 0) {
      let everyTrackedMatches = true;
      const sourceTrackedDiff = await gitExec(
        realSource,
        ['diff', '--binary', '--no-ext-diff', baseHead, '--', ...trackedPaths],
        { maxBytes: SOURCE_SYNC_LIMITS.maxPatchBytes },
      );
      if (sourceTrackedDiff.ok && sourceTrackedDiff.code === 0 && sourceTrackedDiff.stdout.equals(trackedPatch)) {
        trackedAllMatch = true;
      } else {
        // Fallback for newly staged files (`A`) in executionPath that became untracked in sourcePath
        // after `git apply` (not staged in sourcePath, so `git diff baseHead` in source omits them).
        const normalizeText = (buf) => (buf.includes(0) ? buf : Buffer.from(buf.toString('utf8').replace(/\r\n/gu, '\n'), 'utf8'));
        for (const rel of trackedPaths) {
          const eInfo = execInspect.get(rel);
          const sInfo = sourceInspect.get(rel);
          if (!eInfo || !sInfo || !sInfo.ok) { everyTrackedMatches = false; break; }
          if (eInfo.stat === null) {
            if (sInfo.stat !== null) { everyTrackedMatches = false; break; }
          } else {
            if (sInfo.stat === null) { everyTrackedMatches = false; break; }
            const [eBuf, sBuf] = await Promise.all([readFile(eInfo.target), readFile(sInfo.target)]);
            if (!eBuf.equals(sBuf) && !normalizeText(eBuf).equals(normalizeText(sBuf))) {
              everyTrackedMatches = false;
              break;
            }
          }
        }
        trackedAllMatch = everyTrackedMatches;
      }
    }

    if (trackedAllMatch && untrackedAllMatch && conflictingPaths.length === 0) {
      return syncOutcome({
        applied: true,
        reason: SOURCE_SYNC_REASONS.alreadySynced,
        changedFiles: touchedPaths,
      });
    }

    // 5. Conflict precheck: refuse overlapping dirty edits in `sourcePath` and run `git apply --check`.
    const normRel = (rel) => (process.platform === 'win32' ? rel.toLowerCase() : rel);
    const sourceDirtySet = new Set();
    for (const entry of sourceStatus.entries) {
      sourceDirtySet.add(normRel(entry.path));
      if (entry.from !== null) sourceDirtySet.add(normRel(entry.from));
    }
    for (const rel of trackedPaths) {
      if (sourceDirtySet.has(normRel(rel))) {
        conflictingPaths.push(rel);
      }
    }

    if (trackedPatch.length > 0 && conflictingPaths.length === 0) {
      const checkRes = await gitExec(realSource, ['apply', '--check', '--binary', '--whitespace=nowarn', '-'], {
        input: trackedPatch,
      });
      if (!checkRes.ok) {
        return syncOutcome({
          applied: false,
          reason: checkRes.unavailable ? SOURCE_SYNC_REASONS.gitUnavailable : SOURCE_SYNC_REASONS.applyFailed,
          error: checkRes.message,
        });
      }
      if (checkRes.code !== 0) {
        const stderrText = checkRes.stderr.toString('utf8');
        const parsed = parseApplyConflictPaths(stderrText);
        return syncOutcome({
          applied: false,
          reason: SOURCE_SYNC_REASONS.conflict,
          conflictingPaths: parsed.length > 0 ? parsed : trackedPaths,
          error: stderrText.trim(),
        });
      }
    }

    if (conflictingPaths.length > 0) {
      return syncOutcome({
        applied: false,
        reason: SOURCE_SYNC_REASONS.conflict,
        conflictingPaths,
      });
    }

    // 6. All prechecks passed — apply tracked patch and write untracked files atomically.
    if (trackedPatch.length > 0) {
      const applyRes = await gitExec(realSource, ['apply', '--binary', '--whitespace=nowarn', '-'], {
        input: trackedPatch,
      });
      if (!applyRes.ok || applyRes.code !== 0) {
        return syncOutcome({
          applied: false,
          reason: SOURCE_SYNC_REASONS.applyFailed,
          error: applyRes.ok ? applyRes.stderr.toString('utf8').trim() : applyRes.message,
        });
      }
    }

    for (const rel of untrackedPaths) {
      const sInfo = sourceInspect.get(rel);
      const entry = untrackedBuffers.get(rel);
      if (entry === undefined) continue;
      // Skip if identical file already exists in sourcePath.
      if (sInfo?.stat !== null) continue;
      await writeBufferAtomic(sInfo.target, entry.bytes, process.platform === 'win32' ? null : entry.mode);
    }

    for (const rel of deletedOrRenamedFrom) {
      const parts = segmentsByPath.get(rel);
      if (parts !== undefined) await removeEmptyAncestors(realSource, parts);
    }

    return syncOutcome({
      applied: true,
      reason: SOURCE_SYNC_REASONS.synced,
      changedFiles: touchedPaths,
    });
  } finally {
    if (locks !== null && typeof locks.release === 'function') {
      for (const lease of leases) locks.release(lease.workspacePath, lease.nonce);
    }
  }
}
