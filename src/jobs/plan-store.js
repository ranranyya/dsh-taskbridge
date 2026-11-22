// Bounded durable planning-node store (`plan.json`).
//
// Planning nodes exist independently of execution records (`history.json`) so a
// root goal or intermediate breakdown stage can exist before any worker runs and
// is never evicted by the 200-entry execution history rotation.

import { randomBytes, randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { redactDeep, redactText } from '../config/redact.js';
import {
  REVIEW_NOTE_MAX_CHARS,
  normalizeReviewNote,
  reviewNoteLength,
  reviewNoteOverflow,
  truncateCodePoints,
} from './review-note.js';
import {
  TASK_DESCRIPTION_FIELDS,
  TASK_DESCRIPTION_MAX_CHARS,
  canonicalTaskDescription,
  truncateTaskDescription,
} from './task-descriptions.js';
import {
  isPathDigest,
  pathDigest,
  readPathIdentity,
  recordedDirectoryIs,
  recordedPathIsMasked,
} from './continuation-identity.js';

export const PLAN_SCHEMA_VERSION = 1;
export const PLAN_FILE = 'plan.json';
export const PLAN_TITLE_MAX_CHARS = 120;
export const MAX_PLAN_DEPTH = 16;
export const MAX_PLAN_BATCH = 32;
export const MAX_PLAN_REVIEW_HISTORY = 16;

const DEFAULT_LIMITS = Object.freeze({
  maxNodes: 500,
  maxBytes: 2 * 1024 * 1024,
  maxNodeBytes: 16 * 1024,
  maxDepth: MAX_PLAN_DEPTH,
});

const MIN_NODE_BYTES = 1024;
const MIN_DOCUMENT_BYTES = 64 * 1024;
const MAX_ID_CHARS = 256;
const MAX_KEY_CHARS = 64;
const MAX_PATH_CHARS = 4096;
const MAX_SAFE_TIMESTAMP = 8.64e15;
const WINDOWS_TRANSIENT_RENAME = new Set(['EACCES', 'EBUSY', 'EPERM']);

export const PLAN_CODES = Object.freeze({
  unreadable: 'PLAN_UNREADABLE',
  fileTooLarge: 'PLAN_FILE_TOO_LARGE',
  malformed: 'PLAN_MALFORMED',
  schemaUnsupported: 'PLAN_SCHEMA_UNSUPPORTED',
  invalid: 'PLAN_INVALID',
  titleInvalid: 'PLAN_TITLE_INVALID',
  descriptionInvalid: 'PLAN_DESCRIPTION_INVALID',
  nodeNotFound: 'PLAN_NODE_NOT_FOUND',
  cycleDetected: 'PLAN_CYCLE_DETECTED',
  depthExceeded: 'PLAN_DEPTH_EXCEEDED',
  sourceMismatch: 'PLAN_SOURCE_MISMATCH',
  limitExceeded: 'PLAN_LIMIT_EXCEEDED',
  reviewInvalid: 'PLAN_REVIEW_INVALID',
  reviewConflict: 'PLAN_REVIEW_CONFLICT',
  writeFailed: 'PLAN_WRITE_FAILED',
  disposed: 'PLAN_DISPOSED',
});

export class PlanError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
    this.details = details;
  }
}

export class PlanStore {
  constructor(dataDir, options = {}) {
    if (typeof dataDir !== 'string' || dataDir.trim() === '') {
      throw new TypeError('PlanStore needs a data directory');
    }
    const limits = { ...DEFAULT_LIMITS };
    for (const key of Object.keys(DEFAULT_LIMITS)) {
      const value = options[key];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${key} must be a positive integer`);
      limits[key] = value;
    }
    if (limits.maxNodeBytes < MIN_NODE_BYTES) {
      throw new TypeError(`maxNodeBytes must be at least ${MIN_NODE_BYTES}`);
    }
    if (limits.maxBytes < limits.maxNodeBytes) {
      throw new TypeError('maxBytes must be at least maxNodeBytes');
    }

    this.dir = dataDir;
    this.path = join(dataDir, PLAN_FILE);
    this.maxNodes = limits.maxNodes;
    this.maxBytes = limits.maxBytes;
    this.maxNodeBytes = limits.maxNodeBytes;
    this.maxDepth = limits.maxDepth;
    this.maxDocumentBytes = Math.max(limits.maxBytes * 2, MIN_DOCUMENT_BYTES);
    this.fs = options.fs ?? nodeFs;

    this.nodes = null;
    this.lastSequence = 0;
    this.loading = null;
    this.refusal = null;
    this.queue = Promise.resolve();
    this.disposed = false;
  }

  async load(options = {}) {
    const state = await this.ensureLoaded();
    const filterConn = options?.connectionId;
    const filtered = typeof filterConn === 'string' && filterConn !== ''
      ? state.nodes.filter((node) => node.connectionId === filterConn)
      : state.nodes;
    return filtered.map((node) => structuredClone(node));
  }

  // Let cleanup validate relationships while queued plan mutations are held.
  async withStableNodes(action) {
    return await this.enqueue(async () => action(await this.load()));
  }

  /**
   * Remove planning nodes in `seedNodeIds` (and their ancestors) that no longer have
   * any remaining execution tasks or child plan nodes after a task cleanup.
   *
   * Never removes an unrelated empty planning node that was not in the cleaned tasks'
   * own plan ancestry.
   * @param {Iterable<string>} seedNodeIds - plan node ids referenced by the deleted tasks.
   * @param {object[]} remainingTasks - all remaining live and archived task records.
   * @returns {Promise<string[]>} removed plan node ids.
   */
  async deleteEmptyAncestors(seedNodeIds, remainingTasks = []) {
    if (this.disposed) throw this.disposedError();
    this.throwIfRefused();
    const seeds = new Set();
    for (const id of Array.isArray(seedNodeIds) || seedNodeIds instanceof Set ? seedNodeIds : []) {
      if (typeof id === 'string' && id.trim() !== '') seeds.add(id.trim());
    }
    if (seeds.size === 0) return [];

    return await this.enqueue(async () => {
      this.throwIfRefused();
      const state = await this.ensureLoaded();
      const byId = new Map(state.nodes.map((node) => [node.nodeId, node]));

      // Collect the candidate scope: seed nodes and their plan ancestors.
      const candidateScope = new Set();
      for (const seedId of seeds) {
        let cur = seedId;
        const seen = new Set();
        while (typeof cur === 'string' && cur !== '' && !seen.has(cur)) {
          seen.add(cur);
          const node = byId.get(cur);
          if (!node) break;
          candidateScope.add(node.nodeId);
          cur = node.parentNodeId ?? null;
        }
      }
      if (candidateScope.size === 0) return [];

      const referencedByTasks = new Set();
      for (const task of Array.isArray(remainingTasks) ? remainingTasks : []) {
        if (typeof task?.planNodeId === 'string' && task.planNodeId.trim() !== '') {
          referencedByTasks.add(task.planNodeId.trim());
        }
        if (typeof task?.parentNodeId === 'string' && task.parentNodeId.trim() !== '') {
          referencedByTasks.add(task.parentNodeId.trim());
        }
      }

      let draft = state.nodes.map((node) => structuredClone(node));
      const removedIds = [];
      let changed = true;
      while (changed) {
        changed = false;
        const parentIdsWithPlanChildren = new Set(
          draft
            .map((node) => node.parentNodeId)
            .filter((id) => typeof id === 'string' && id !== ''),
        );
        const next = [];
        for (const node of draft) {
          if (
            candidateScope.has(node.nodeId)
            && !referencedByTasks.has(node.nodeId)
            && !parentIdsWithPlanChildren.has(node.nodeId)
          ) {
            removedIds.push(node.nodeId);
            changed = true;
          } else {
            next.push(node);
          }
        }
        draft = next;
      }

      if (removedIds.length === 0) return [];
      const now = Date.now();
      await this.writeDocument(draft, state.lastSequence, now);
      this.nodes = draft;
      return removedIds;
    });
  }

  async get(nodeId, connectionId) {
    if (typeof nodeId !== 'string' || nodeId.trim() === '') return null;
    if (typeof connectionId !== 'string' || connectionId.trim() === '') return null;
    const state = await this.ensureLoaded();
    const target = nodeId.trim();
    const found = state.nodes.find((node) => node.nodeId === target) ?? null;
    if (found === null || found.connectionId !== connectionId) return null;
    return structuredClone(found);
  }

  async create(request, options = {}) {
    if (this.disposed) throw this.disposedError();
    this.throwIfRefused();
    if (!isPlainObject(request)) {
      throw new PlanError(PLAN_CODES.invalid, 'plan creation requires an object request', {});
    }
    const connectionId = requireConnectionId(request.connectionId);
    const isBatch = request.nodes !== undefined;
    const rawItems = isBatch ? validateBatchArray(request.nodes) : [singleItemFromRequest(request)];
    const defaultWorkspacePath = request.workspacePath;
    const defaultParentNodeId = request.parentNodeId;

    if (defaultWorkspacePath !== undefined) validateWorkspaceInput(defaultWorkspacePath, 'workspacePath');
    if (defaultParentNodeId !== undefined && defaultParentNodeId !== null) {
      validateParentRefInput(defaultParentNodeId, 'parentNodeId');
    }

    return await this.enqueue(async () => {
      this.throwIfRefused();
      const state = await this.ensureLoaded();
      const draft = state.nodes.map((node) => structuredClone(node));
      const existingById = new Map(draft.map((node) => [node.nodeId, node]));

      // Validate batch keys and local parentKey graph before minting records.
      const batchByKey = new Map();
      for (let i = 0; i < rawItems.length; i += 1) {
        const item = rawItems[i];
        if (!isPlainObject(item)) {
          throw new PlanError(PLAN_CODES.invalid, `nodes[${i}] must be an object`, { index: i });
        }
        if (item.key !== undefined) {
          if (typeof item.key !== 'string' || item.key.trim() === '' || item.key.trim().length > MAX_KEY_CHARS) {
            throw new PlanError(PLAN_CODES.invalid, `nodes[${i}].key must be a non-empty string of at most ${MAX_KEY_CHARS} characters`, {
              index: i,
            });
          }
          const key = item.key.trim();
          if (batchByKey.has(key)) {
            throw new PlanError(PLAN_CODES.invalid, `duplicate batch node key ${JSON.stringify(key)}`, { key, index: i });
          }
          batchByKey.set(key, { index: i, item });
        }
      }

      // Check local parentKey references & cycles across the batch.
      const keyParent = new Map();
      for (let i = 0; i < rawItems.length; i += 1) {
        const item = rawItems[i];
        const hasParentKey = item.parentKey !== undefined && item.parentKey !== null && item.parentKey !== '';
        const hasParentId = item.parentNodeId !== undefined && item.parentNodeId !== null && item.parentNodeId !== '';
        if (hasParentKey && hasParentId) {
          throw new PlanError(PLAN_CODES.invalid, `nodes[${i}] cannot specify both parentKey and parentNodeId`, { index: i });
        }
        if (item.parentKey !== undefined && item.parentKey !== null) {
          if (typeof item.parentKey !== 'string' || item.parentKey.trim() === '') {
            throw new PlanError(PLAN_CODES.invalid, `nodes[${i}].parentKey must be a non-empty string`, { index: i });
          }
          const pk = item.parentKey.trim();
          if (!batchByKey.has(pk)) {
            throw new PlanError(PLAN_CODES.invalid, `nodes[${i}].parentKey references unknown batch key ${JSON.stringify(pk)}`, {
              index: i,
              parentKey: pk,
            });
          }
          if (typeof item.key === 'string' && item.key.trim() === pk) {
            throw new PlanError(PLAN_CODES.cycleDetected, 'a plan node cannot be its own parent', { key: pk });
          }
          if (typeof item.key === 'string') keyParent.set(item.key.trim(), pk);
        }
      }
      for (const startKey of keyParent.keys()) {
        const seen = new Set([startKey]);
        let cur = keyParent.get(startKey) ?? null;
        while (cur !== null) {
          if (seen.has(cur)) {
            throw new PlanError(PLAN_CODES.cycleDetected, 'batch plan nodes contain a parentKey cycle', { key: startKey });
          }
          seen.add(cur);
          cur = keyParent.get(cur) ?? null;
        }
      }

      // Topological order so parents in the batch are resolved before their children.
      const order = topologicalBatchOrder(rawItems, batchByKey);
      const mintedByIndex = new Array(rawItems.length);
      const mintedByKey = new Map();
      let seq = state.lastSequence;
      const now = Date.now();

      for (const index of order) {
        const item = rawItems[index];
        const title = canonicalPlanTitle(item.title);
        const goal = canonicalPlanDescription(item.goalDescription, TASK_DESCRIPTION_FIELDS.goal);

        let resolvedParentId = null;
        let parentSource = null;
        let parentDepth = 0;

        if (typeof item.parentKey === 'string' && item.parentKey.trim() !== '') {
          const parentMinted = mintedByKey.get(item.parentKey.trim());
          resolvedParentId = parentMinted.node.nodeId;
          parentSource = parentMinted.rawSource;
          parentDepth = parentMinted.depth;
        } else {
          const rawParentId = item.parentNodeId !== undefined ? item.parentNodeId : (isBatch ? defaultParentNodeId : request.parentNodeId);
          if (rawParentId !== undefined && rawParentId !== null) {
            const parentId = validateParentRefInput(rawParentId, 'parentNodeId');
            const resolved = await this.resolveParentFacts(parentId, connectionId, existingById, options.resolveExternalParent);
            resolvedParentId = parentId;
            parentSource = resolved.source;
            parentDepth = resolved.depth;
          }
        }

        const depth = parentDepth + 1;
        if (depth > this.maxDepth) {
          throw new PlanError(PLAN_CODES.depthExceeded, `plan tree depth ${depth} exceeds the maximum of ${this.maxDepth}`, {
            depth,
            maxDepth: this.maxDepth,
          });
        }

        const rawWs = item.workspacePath !== undefined ? item.workspacePath : defaultWorkspacePath;
        const rawSource = resolveItemSource(rawWs, parentSource);

        seq += 1;
        const nodeId = `plan-${randomUUID()}`;
        const node = projectPlanNode({
          nodeId,
          parentNodeId: resolvedParentId,
          title,
          goalDescription: goal,
          sourcePath: rawSource.path === null ? null : redactText(rawSource.path),
          sourcePathDigest: rawSource.digest,
          connectionId,
          sequence: seq,
          createdAt: now,
          updatedAt: now,
          hostAcceptance: null,
          reviewHistory: [],
        }, this.maxNodeBytes);

        mintedByIndex[index] = node;
        if (typeof item.key === 'string' && item.key.trim() !== '') {
          mintedByKey.set(item.key.trim(), { node, rawSource, depth });
        }
        draft.push(node);
        existingById.set(nodeId, node);
      }

      this.enforceDocumentLimits(draft, seq, now);
      await this.writeDocument(draft, seq, now);
      this.nodes = draft;
      this.lastSequence = seq;

      const created = mintedByIndex.map((node) => structuredClone(node));
      return isBatch ? { nodes: created } : { node: created[0], nodes: created };
    });
  }

  async update(request) {
    if (this.disposed) throw this.disposedError();
    this.throwIfRefused();
    if (!isPlainObject(request)) {
      throw new PlanError(PLAN_CODES.invalid, 'plan update requires an object request', {});
    }
    const connectionId = requireConnectionId(request.connectionId);
    const nodeId = requireNodeId(request.nodeId);
    if (request.parentNodeId !== undefined) {
      throw new PlanError(PLAN_CODES.invalid, 'parentNodeId cannot be changed after a plan node is created', { nodeId });
    }
    const hasTitle = request.title !== undefined;
    const hasGoal = request.goalDescription !== undefined;
    const hasWs = request.workspacePath !== undefined;
    if (!hasTitle && !hasGoal && !hasWs) {
      throw new PlanError(PLAN_CODES.invalid, 'plan update requires at least one of title, goalDescription or workspacePath', {
        nodeId,
      });
    }
    const nextTitle = hasTitle ? canonicalPlanTitle(request.title) : undefined;
    const nextGoal = hasGoal ? canonicalPlanDescription(request.goalDescription, TASK_DESCRIPTION_FIELDS.goal) : undefined;
    if (hasGoal && nextGoal === null) {
      throw new PlanError(PLAN_CODES.descriptionInvalid, 'goalDescription cannot be erased with an empty string', {
        nodeId,
        field: TASK_DESCRIPTION_FIELDS.goal,
      });
    }
    const wsFacts = hasWs ? validateWorkspaceInput(request.workspacePath, 'workspacePath') : null;

    return await this.enqueue(async () => {
      this.throwIfRefused();
      const state = await this.ensureLoaded();
      const draft = state.nodes.map((node) => structuredClone(node));
      const index = draft.findIndex((node) => node.nodeId === nodeId);
      if (index < 0 || draft[index].connectionId !== connectionId) {
        throw absentNodeError(nodeId);
      }
      const current = draft[index];
      if (current.hostAcceptance?.accepted === true) {
        throw new PlanError(PLAN_CODES.reviewConflict, 'an accepted plan node is sealed and cannot be modified', {
          nodeId,
        });
      }

      let sourcePath = current.sourcePath;
      let sourcePathDigest = current.sourcePathDigest;
      if (wsFacts !== null) {
        if (current.sourcePath !== null || current.sourcePathDigest !== null) {
          if (!recordedDirectoryIs({ path: current.sourcePath, digest: current.sourcePathDigest }, wsFacts.path)) {
            throw new PlanError(PLAN_CODES.sourceMismatch, 'a plan node cannot switch to a different source repository', {
              nodeId,
            });
          }
        }
        if (current.parentNodeId !== null) {
          const parent = draft.find((n) => n.nodeId === current.parentNodeId && n.connectionId === connectionId) ?? null;
          if (parent !== null && (parent.sourcePath !== null || parent.sourcePathDigest !== null)) {
            if (!recordedDirectoryIs({ path: parent.sourcePath, digest: parent.sourcePathDigest }, wsFacts.path)) {
              throw new PlanError(PLAN_CODES.sourceMismatch, 'plan node workspacePath does not match its parent plan node', {
                nodeId,
                parentNodeId: current.parentNodeId,
              });
            }
          }
        }
        for (const child of draft) {
          if (child.connectionId === connectionId && child.parentNodeId === nodeId) {
            if (child.sourcePath !== null || child.sourcePathDigest !== null) {
              if (!recordedDirectoryIs({ path: child.sourcePath, digest: child.sourcePathDigest }, wsFacts.path)) {
                throw new PlanError(PLAN_CODES.sourceMismatch, 'plan node workspacePath conflicts with an existing child node', {
                  nodeId,
                  childNodeId: child.nodeId,
                });
              }
            }
          }
        }
        sourcePath = redactText(wsFacts.path);
        sourcePathDigest = wsFacts.digest;
      }

      const now = Date.now();
      const updated = projectPlanNode({
        ...current,
        title: nextTitle ?? current.title,
        goalDescription: nextGoal !== undefined ? nextGoal : current.goalDescription,
        sourcePath,
        sourcePathDigest,
        updatedAt: now,
      }, this.maxNodeBytes);

      draft[index] = updated;
      this.enforceDocumentLimits(draft, state.lastSequence, now);
      await this.writeDocument(draft, state.lastSequence, now);
      this.nodes = draft;
      return structuredClone(updated);
    });
  }

  async review(request) {
    if (this.disposed) throw this.disposedError();
    this.throwIfRefused();
    if (!isPlainObject(request)) {
      throw new PlanError(PLAN_CODES.reviewInvalid, 'plan review requires an object request', {});
    }
    const connectionId = requireConnectionId(request.connectionId);
    const nodeId = requireNodeId(request.nodeId);
    const decision = request.decision;
    if (decision !== 'accepted' && decision !== 'changes-requested') {
      throw new PlanError(PLAN_CODES.reviewInvalid, 'decision must be "accepted" or "changes-requested"', { nodeId });
    }
    if (typeof request.note !== 'string') {
      throw new PlanError(PLAN_CODES.reviewInvalid, 'a non-empty review note string is required', { nodeId });
    }
    const normalizedNote = normalizeReviewNote(request.note);
    if (normalizedNote === '') {
      throw new PlanError(PLAN_CODES.reviewInvalid, 'a non-empty review note is required', { nodeId });
    }
    if (reviewNoteLength(normalizedNote) > REVIEW_NOTE_MAX_CHARS) {
      const preOverflow = reviewNoteOverflow(normalizedNote);
      throw new PlanError(PLAN_CODES.reviewInvalid, preOverflow.message, {
        nodeId,
        limit: preOverflow.limit,
        length: preOverflow.length,
      });
    }
    const redactedNote = normalizeReviewNote(redactText(normalizedNote));
    if (redactedNote === '') {
      throw new PlanError(PLAN_CODES.reviewInvalid, 'the review note is empty after redaction', { nodeId });
    }
    if (reviewNoteLength(redactedNote) > REVIEW_NOTE_MAX_CHARS) {
      const postOverflow = reviewNoteOverflow(redactedNote);
      throw new PlanError(PLAN_CODES.reviewInvalid, postOverflow.message, {
        nodeId,
        limit: postOverflow.limit,
        length: postOverflow.length,
      });
    }
    const summary = canonicalPlanDescription(request.completionSummary, TASK_DESCRIPTION_FIELDS.summary, {
      code: PLAN_CODES.reviewInvalid,
    });

    return await this.enqueue(async () => {
      this.throwIfRefused();
      const state = await this.ensureLoaded();
      const draft = state.nodes.map((node) => structuredClone(node));
      const index = draft.findIndex((node) => node.nodeId === nodeId);
      if (index < 0 || draft[index].connectionId !== connectionId) {
        throw absentNodeError(nodeId);
      }
      const current = draft[index];
      const existing = current.hostAcceptance;
      if (existing !== null && existing !== undefined) {
        const existingState = existing.state ?? existing.decision ?? null;
        const existingSummary = existing.completionSummary ?? null;
        if (existingState === decision && existing.note === redactedNote && existingSummary === summary) {
          return { node: structuredClone(current), replayed: true };
        }
        if (existing.accepted === true) {
          throw new PlanError(PLAN_CODES.reviewConflict, 'an accepted plan review is final and cannot be replaced', {
            nodeId,
          });
        }
      }

      const now = Date.now();
      const nextHistory = Array.isArray(current.reviewHistory) ? [...current.reviewHistory] : [];
      if (existing !== null && existing !== undefined) {
        nextHistory.push(structuredClone(existing));
        if (nextHistory.length > MAX_PLAN_REVIEW_HISTORY) {
          nextHistory.splice(0, nextHistory.length - MAX_PLAN_REVIEW_HISTORY);
        }
      }

      const nextAcceptance = {
        accepted: decision === 'accepted',
        state: decision,
        decision,
        acceptedAt: now,
        by: 'commander',
        note: redactedNote,
        noteChars: reviewNoteLength(redactedNote),
        ...(summary === null ? {} : { completionSummary: summary }),
      };

      const updated = projectPlanNode({
        ...current,
        updatedAt: now,
        hostAcceptance: nextAcceptance,
        reviewHistory: nextHistory,
      }, this.maxNodeBytes);

      draft[index] = updated;
      this.enforceDocumentLimits(draft, state.lastSequence, now);
      await this.writeDocument(draft, state.lastSequence, now);
      this.nodes = draft;
      return { node: structuredClone(updated), replayed: false };
    });
  }

  async resolveParentFacts(parentId, connectionId, existingById, resolveExternalParent) {
    const planParent = existingById.get(parentId) ?? null;
    if (planParent !== null) {
      if (planParent.connectionId !== connectionId) throw absentNodeError(parentId);
      const depth = computeExistingDepth(parentId, existingById, connectionId);
      return {
        kind: 'plan',
        depth,
        source: {
          path: planParent.sourcePath,
          digest: planParent.sourcePathDigest,
        },
      };
    }
    if (typeof resolveExternalParent === 'function') {
      const external = await resolveExternalParent(parentId, connectionId, existingById);
      if (external !== null && external !== undefined && external.found === true) {
        return {
          kind: 'task',
          depth: Number.isInteger(external.depth) && external.depth > 0 ? external.depth : 1,
          source: {
            path: external.sourcePath ?? null,
            digest: external.sourcePathDigest ?? null,
          },
        };
      }
    }
    throw absentNodeError(parentId);
  }

  async flush() {
    try {
      await this.queue;
    } catch {
      // individual caller already observed its own rejection
    }
  }

  async dispose() {
    this.disposed = true;
    await this.flush();
  }

  enqueue(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  async ensureLoaded() {
    if (this.disposed) throw this.disposedError();
    this.throwIfRefused();
    if (this.nodes !== null) return { nodes: this.nodes, lastSequence: this.lastSequence };
    if (this.loading === null) {
      this.loading = this.readFromDisk().finally(() => {
        this.loading = null;
      });
    }
    return await this.loading;
  }

  async readFromDisk() {
    let stat;
    try {
      stat = await this.fs.stat(this.path);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.nodes = [];
        this.lastSequence = 0;
        return { nodes: this.nodes, lastSequence: 0 };
      }
      throw this.refuse(PLAN_CODES.unreadable, 'the plan document could not be stat-checked', {
        cause: String(error?.code ?? 'STAT_FAILED'),
      });
    }
    if (stat.size > this.maxDocumentBytes) {
      throw this.refuse(PLAN_CODES.fileTooLarge, 'the plan document exceeds the maximum readable size', {
        bytes: stat.size,
        limit: this.maxDocumentBytes,
      });
    }
    let text;
    try {
      text = await this.fs.readFile(this.path, 'utf8');
    } catch (error) {
      throw this.refuse(PLAN_CODES.unreadable, 'the plan document could not be read', {
        cause: String(error?.code ?? 'READ_FAILED'),
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw this.refuse(PLAN_CODES.malformed, 'the plan document is not valid JSON', {});
    }
    if (!isPlainObject(parsed)) {
      throw this.refuse(PLAN_CODES.malformed, 'the plan document root must be an object', {});
    }
    if (parsed.schemaVersion !== PLAN_SCHEMA_VERSION) {
      throw this.refuse(PLAN_CODES.schemaUnsupported, `unsupported plan schemaVersion ${JSON.stringify(parsed.schemaVersion)}`, {
        schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : null,
      });
    }
    if (!Array.isArray(parsed.nodes)) {
      throw this.refuse(PLAN_CODES.malformed, 'the plan document must carry a nodes array', {});
    }
    if (parsed.nodes.length > this.maxNodes * 2) {
      throw this.refuse(PLAN_CODES.malformed, 'the plan document contains too many nodes', {
        count: parsed.nodes.length,
      });
    }

    const seenIds = new Set();
    const loaded = [];
    let maxSeq = Number.isSafeInteger(parsed.lastSequence) && parsed.lastSequence >= 0 ? parsed.lastSequence : 0;

    for (let i = 0; i < parsed.nodes.length; i += 1) {
      const raw = parsed.nodes[i];
      if (!isPlainObject(raw)) {
        throw this.refuse(PLAN_CODES.malformed, `plan node at index ${i} is not an object`, { index: i });
      }
      const normalized = normalizeStoredPlanNode(raw, i, this.refuse.bind(this));
      if (seenIds.has(normalized.nodeId)) {
        throw this.refuse(PLAN_CODES.malformed, `duplicate plan nodeId ${normalized.nodeId}`, {
          nodeId: normalized.nodeId,
        });
      }
      seenIds.add(normalized.nodeId);
      if (normalized.sequence > maxSeq) maxSeq = normalized.sequence;
      loaded.push(normalized);
    }

    loaded.sort(comparePlanNodes);
    this.nodes = loaded;
    this.lastSequence = maxSeq;
    return { nodes: this.nodes, lastSequence: this.lastSequence };
  }

  enforceDocumentLimits(draft, lastSequence, now) {
    if (draft.length > this.maxNodes) {
      throw new PlanError(PLAN_CODES.limitExceeded, `plan node count ${draft.length} exceeds limit ${this.maxNodes}`, {
        nodes: draft.length,
        limit: this.maxNodes,
      });
    }
    const payload = serializeDocument(draft, lastSequence, now);
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (bytes > this.maxBytes) {
      throw new PlanError(PLAN_CODES.limitExceeded, `plan document size ${bytes} bytes exceeds limit ${this.maxBytes}`, {
        bytes,
        byteLimit: this.maxBytes,
      });
    }
  }

  async writeDocument(draft, lastSequence, now) {
    const sorted = [...draft].sort(comparePlanNodes);
    const payload = serializeDocument(sorted, lastSequence, now);
    const temp = join(dirname(this.path), `.${PLAN_FILE}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await this.fs.mkdir(dirname(this.path), { recursive: true });
      await this.fs.writeFile(temp, payload, 'utf8');
      await renameWithRetry(this.fs, temp, this.path);
    } catch (error) {
      try {
        await this.fs.rm(temp, { force: true });
      } catch {
        // best-effort temp cleanup
      }
      throw new PlanError(PLAN_CODES.writeFailed, 'the plan document could not be written', {
        cause: String(error?.code ?? 'WRITE_FAILED'),
      });
    }
  }

  refuse(code, message, details) {
    const refusal = this.refusal ?? { code, message, details };
    this.refusal = refusal;
    return new PlanError(refusal.code, refusal.message, { ...refusal.details });
  }

  throwIfRefused() {
    if (this.refusal === null) return;
    throw new PlanError(this.refusal.code, this.refusal.message, { ...this.refusal.details });
  }

  disposedError() {
    return new PlanError(PLAN_CODES.disposed, 'the plan store has been disposed', {});
  }
}

function serializeDocument(nodes, lastSequence, updatedAt) {
  return `${JSON.stringify({
    schemaVersion: PLAN_SCHEMA_VERSION,
    updatedAt,
    lastSequence,
    nodes,
  }, null, 2)}\n`;
}

function projectPlanNode(raw, maxNodeBytes) {
  const entry = redactDeep({
    nodeId: raw.nodeId,
    parentNodeId: raw.parentNodeId ?? null,
    title: raw.title,
    ...(raw.goalDescription === null || raw.goalDescription === undefined ? {} : { goalDescription: raw.goalDescription }),
    sourcePath: raw.sourcePath ?? null,
    sourcePathDigest: isPathDigest(raw.sourcePathDigest) ? raw.sourcePathDigest : null,
    connectionId: raw.connectionId,
    sequence: raw.sequence,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    hostAcceptance: raw.hostAcceptance ?? null,
    ...(Array.isArray(raw.reviewHistory) && raw.reviewHistory.length > 0 ? { reviewHistory: raw.reviewHistory } : {}),
  });
  const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
  if (bytes > maxNodeBytes) {
    throw new PlanError(PLAN_CODES.limitExceeded, `plan node exceeds per-node limit of ${maxNodeBytes} bytes`, {
      nodeId: entry.nodeId,
      bytes,
      limit: maxNodeBytes,
    });
  }
  return entry;
}

function normalizeStoredPlanNode(raw, index, refuse) {
  const nodeId = typeof raw.nodeId === 'string' ? raw.nodeId.trim() : '';
  if (nodeId === '' || nodeId.length > MAX_ID_CHARS || !nodeId.startsWith('plan-')) {
    throw refuse(PLAN_CODES.malformed, `plan node at index ${index} has an invalid nodeId`, { index });
  }
  const connectionId = typeof raw.connectionId === 'string' ? raw.connectionId.trim() : '';
  if (connectionId === '' || connectionId.length > MAX_ID_CHARS) {
    throw refuse(PLAN_CODES.malformed, `plan node ${nodeId} is missing a valid connectionId`, { nodeId });
  }
  const rawTitle = typeof raw.title === 'string' ? redactText(raw.title).trim() : '';
  if (rawTitle === '') {
    throw refuse(PLAN_CODES.malformed, `plan node ${nodeId} is missing a valid title`, { nodeId });
  }
  const title = truncateCodePoints(rawTitle, PLAN_TITLE_MAX_CHARS);
  const parentNodeId = typeof raw.parentNodeId === 'string' && raw.parentNodeId.trim() !== ''
    ? raw.parentNodeId.trim().slice(0, MAX_ID_CHARS)
    : null;

  let goalDescription = null;
  if (typeof raw.goalDescription === 'string' && raw.goalDescription.trim() !== '') {
    goalDescription = truncateTaskDescription(redactText(raw.goalDescription).trim(), 0, TASK_DESCRIPTION_MAX_CHARS);
  }

  const sourcePath = typeof raw.sourcePath === 'string' && raw.sourcePath.trim() !== ''
    ? redactText(raw.sourcePath.trim()).slice(0, MAX_PATH_CHARS)
    : null;
  const sourcePathDigest = isPathDigest(raw.sourcePathDigest) ? raw.sourcePathDigest : null;

  const sequence = Number.isSafeInteger(raw.sequence) && raw.sequence >= 0 ? raw.sequence : index + 1;
  const createdAt = safeTimestamp(raw.createdAt) ?? 0;
  const updatedAt = safeTimestamp(raw.updatedAt) ?? createdAt;
  const hostAcceptance = normalizeStoredAcceptance(raw.hostAcceptance);
  const reviewHistory = Array.isArray(raw.reviewHistory)
    ? raw.reviewHistory
      .map(normalizeStoredAcceptance)
      .filter((item) => item !== null)
      .slice(-MAX_PLAN_REVIEW_HISTORY)
    : [];

  return redactDeep({
    nodeId,
    parentNodeId,
    title,
    ...(goalDescription === null ? {} : { goalDescription }),
    sourcePath,
    sourcePathDigest,
    connectionId,
    sequence,
    createdAt,
    updatedAt,
    hostAcceptance,
    ...(reviewHistory.length > 0 ? { reviewHistory } : {}),
  });
}

function normalizeStoredAcceptance(value) {
  if (!isPlainObject(value)) return null;
  const ver = value.state ?? value.decision;
  if (ver !== 'accepted' && ver !== 'changes-requested') return null;
  const note = typeof value.note === 'string' ? normalizeReviewNote(redactText(value.note)) : '';
  if (note === '') return null;
  const boundedNote = truncateCodePoints(note, REVIEW_NOTE_MAX_CHARS);
  let summary = null;
  if (typeof value.completionSummary === 'string' && value.completionSummary.trim() !== '') {
    summary = truncateTaskDescription(redactText(value.completionSummary).trim(), 0, TASK_DESCRIPTION_MAX_CHARS);
  }
  return {
    accepted: ver === 'accepted',
    state: ver,
    decision: ver,
    acceptedAt: safeTimestamp(value.acceptedAt ?? value.decidedAt) ?? 0,
    by: 'commander',
    note: boundedNote,
    noteChars: reviewNoteLength(boundedNote),
    ...(summary === null ? {} : { completionSummary: summary }),
  };
}

function computeExistingDepth(startNodeId, existingById, connectionId) {
  const visited = new Set();
  let curId = startNodeId;
  let depth = 0;
  while (curId !== null) {
    if (visited.has(curId)) {
      throw new PlanError(PLAN_CODES.cycleDetected, 'existing plan ancestry contains a cycle', {
        nodeId: startNodeId,
      });
    }
    visited.add(curId);
    const node = existingById.get(curId) ?? null;
    if (node === null || node.connectionId !== connectionId) break;
    depth += 1;
    curId = node.parentNodeId ?? null;
  }
  return depth;
}

function topologicalBatchOrder(items, batchByKey) {
  const result = [];
  const state = new Array(items.length).fill(0); // 0 = unvisited, 1 = visiting, 2 = done
  const visit = (index) => {
    if (state[index] === 2) return;
    if (state[index] === 1) {
      throw new PlanError(PLAN_CODES.cycleDetected, 'batch plan nodes contain a parentKey cycle', { index });
    }
    state[index] = 1;
    const pk = items[index].parentKey;
    if (typeof pk === 'string' && pk.trim() !== '') {
      const parentEntry = batchByKey.get(pk.trim());
      if (parentEntry !== undefined) visit(parentEntry.index);
    }
    state[index] = 2;
    result.push(index);
  };
  for (let i = 0; i < items.length; i += 1) visit(i);
  return result;
}

function resolveItemSource(rawWorkspacePath, parentSource) {
  if (rawWorkspacePath !== undefined && rawWorkspacePath !== null) {
    const ws = validateWorkspaceInput(rawWorkspacePath, 'workspacePath');
    if (parentSource !== null && (parentSource.path !== null || parentSource.digest !== null)) {
      if (!recordedDirectoryIs(parentSource, ws.path)) {
        throw new PlanError(
          PLAN_CODES.sourceMismatch,
          'child plan node workspacePath does not match its parent source repository',
          {},
        );
      }
    }
    return ws;
  }
  if (parentSource !== null && (parentSource.path !== null || parentSource.digest !== null)) {
    const reading = readPathIdentity(parentSource.path, parentSource.digest);
    if (reading.canonical !== null && reading.digest !== null && pathDigest(reading.canonical) !== reading.digest) {
      throw new PlanError(PLAN_CODES.sourceMismatch, 'parent plan node has an inconsistent recorded source path', {});
    }
    if (reading.canonical === null && reading.digest === null) {
      throw new PlanError(PLAN_CODES.sourceMismatch, 'parent plan node has an unusable masked source path', {});
    }
    return {
      path: parentSource.path,
      digest: reading.digest,
    };
  }
  return { path: null, digest: null };
}

function validateWorkspaceInput(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PlanError(PLAN_CODES.invalid, `${field} must be a non-empty absolute path string`, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_PATH_CHARS || !isAbsolute(trimmed) || recordedPathIsMasked(trimmed)) {
    throw new PlanError(PLAN_CODES.invalid, `${field} must be an unmasked absolute path`, { field });
  }
  const digest = pathDigest(trimmed);
  if (digest === null) {
    throw new PlanError(PLAN_CODES.invalid, `${field} could not be resolved to a valid path identity`, { field });
  }
  return { path: trimmed, digest };
}

function validateParentRefInput(value, field) {
  if (typeof value !== 'string') {
    throw new PlanError(PLAN_CODES.invalid, `${field} must be a non-empty string`, { field });
  }
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_ID_CHARS) {
    throw new PlanError(PLAN_CODES.invalid, `${field} must be a bounded non-empty string`, { field });
  }
  return trimmed;
}

function validateBatchArray(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new PlanError(PLAN_CODES.invalid, 'nodes must be a non-empty array', { field: 'nodes' });
  }
  if (nodes.length > MAX_PLAN_BATCH) {
    throw new PlanError(PLAN_CODES.invalid, `nodes batch may contain at most ${MAX_PLAN_BATCH} entries`, {
      field: 'nodes',
      limit: MAX_PLAN_BATCH,
      count: nodes.length,
    });
  }
  return nodes;
}

function singleItemFromRequest(request) {
  return {
    title: request.title,
    ...(request.goalDescription === undefined ? {} : { goalDescription: request.goalDescription }),
    ...(request.parentNodeId === undefined ? {} : { parentNodeId: request.parentNodeId }),
    ...(request.workspacePath === undefined ? {} : { workspacePath: request.workspacePath }),
  };
}

function canonicalPlanTitle(value) {
  if (typeof value !== 'string') {
    throw new PlanError(PLAN_CODES.titleInvalid, 'plan title must be a non-empty string', {
      field: 'title',
      limit: PLAN_TITLE_MAX_CHARS,
    });
  }
  const trimmed = value.trim();
  const points = Array.from(trimmed).length;
  if (points === 0 || points > PLAN_TITLE_MAX_CHARS) {
    throw new PlanError(
      PLAN_CODES.titleInvalid,
      `plan title must be 1..${PLAN_TITLE_MAX_CHARS} Unicode code points, saw ${points}`,
      { field: 'title', limit: PLAN_TITLE_MAX_CHARS, length: points, unit: 'unicode-code-points' },
    );
  }
  const masked = redactText(trimmed).trim();
  const maskedPoints = Array.from(masked).length;
  if (maskedPoints === 0 || maskedPoints > PLAN_TITLE_MAX_CHARS) {
    throw new PlanError(
      PLAN_CODES.titleInvalid,
      `plan title after redaction must be 1..${PLAN_TITLE_MAX_CHARS} Unicode code points`,
      { field: 'title', limit: PLAN_TITLE_MAX_CHARS, length: maskedPoints, unit: 'unicode-code-points' },
    );
  }
  return masked;
}

function canonicalPlanDescription(value, field, options = {}) {
  const result = canonicalTaskDescription(value, field, redactText);
  if (result.ok === false) {
    throw new PlanError(options.code ?? PLAN_CODES.descriptionInvalid, result.refusal.message, {
      field: result.refusal.field,
      limit: result.refusal.limit,
      length: result.refusal.length,
      unit: result.refusal.unit,
    });
  }
  return result.value;
}

function requireConnectionId(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > MAX_ID_CHARS) {
    throw new PlanError(PLAN_CODES.invalid, 'a verified connectionId is required', {});
  }
  return value.trim();
}

function requireNodeId(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > MAX_ID_CHARS) {
    throw new PlanError(PLAN_CODES.invalid, 'nodeId must be a non-empty string', { field: 'nodeId' });
  }
  return value.trim();
}

function absentNodeError(nodeId) {
  return new PlanError(PLAN_CODES.nodeNotFound, 'no such plan node for this connection', { nodeId });
}

function comparePlanNodes(a, b) {
  const seqA = a.sequence ?? 0;
  const seqB = b.sequence ?? 0;
  if (seqA !== seqB) return seqA - seqB;
  const left = a.createdAt ?? 0;
  const right = b.createdAt ?? 0;
  if (left !== right) return left - right;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

function safeTimestamp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > MAX_SAFE_TIMESTAMP) return null;
  return Math.trunc(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

async function renameWithRetry(fs, temp, target) {
  let delay = 20;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temp, target);
      return;
    } catch (error) {
      const transient = process.platform === 'win32' && WINDOWS_TRANSIENT_RENAME.has(error?.code ?? '');
      if (!transient || attempt >= 8) throw error;
    }
    await new Promise((resolve) => { setTimeout(resolve, delay); });
    delay = Math.min(delay * 2, 200);
  }
}
