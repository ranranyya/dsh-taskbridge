import { buildTaskTree } from './task-tree.js';
import { HISTORY_CODES, HISTORY_DELETE_MAX_TASKS } from './history.js';
import { sessionPathKey } from '../runtime/session-placement.js';

export const MAX_CLEANUP_CHAINS = 100;
const FINISHED = new Set(['awaiting-host-review', 'failed', 'cancelled', 'interrupted']);
const ALLOWED_CLEANUP_KEYS = new Set(['chains', 'confirm', 'archiveSessions', 'removeWorktrees', 'cleanPlans']);
const ALLOWED_ORPHAN_KEYS = new Set(['confirm', 'archiveSessions', 'removeWorktrees']);

export const CLEANUP_CODES = Object.freeze({
  invalid: 'CLEANUP_INVALID',
  notFound: 'CLEANUP_CHAIN_NOT_FOUND',
  stale: 'CLEANUP_STALE',
  live: 'CLEANUP_CHAIN_LIVE',
  notDurable: 'CLEANUP_NOT_DURABLE',
  nextRound: 'CLEANUP_NEXT_ROUND',
  planChildren: 'CLEANUP_PLAN_CHILDREN',
  hierarchyChildren: 'CLEANUP_HIERARCHY_CHILDREN',
  reviewWrite: 'CLEANUP_REVIEW_WRITE',
  unavailable: 'CLEANUP_UNAVAILABLE',
  failed: 'CLEANUP_FAILED',
});

class CleanupError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CleanupError';
    this.code = code;
    this.details = details;
  }
}

function invalid(message, details) {
  throw new CleanupError(CLEANUP_CODES.invalid, message, details);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
}

export function validateCleanupRequest(body) {
  if (!isObject(body) || Object.keys(body).some((key) => !ALLOWED_CLEANUP_KEYS.has(key))) {
    invalid('expected only chains and explicit confirmation');
  }
  if (body.confirm !== true) invalid('cleanup requires explicit confirmation', { field: 'confirm' });
  for (const flag of ['archiveSessions', 'removeWorktrees', 'cleanPlans']) {
    if (body[flag] !== undefined && typeof body[flag] !== 'boolean') {
      invalid(`${flag} must be a boolean`, { field: flag });
    }
  }
  if (!Array.isArray(body.chains) || body.chains.length === 0 || body.chains.length > MAX_CLEANUP_CHAINS) {
    invalid('select a bounded list of execution chains', { field: 'chains', limit: MAX_CLEANUP_CHAINS });
  }
  const chainIds = new Set();
  const taskIds = new Set();
  const chains = body.chains.map((chain, index) => {
    if (!isObject(chain) || Object.keys(chain).some((key) => key !== 'chainId' && key !== 'taskIds') || !isId(chain.chainId)) {
      invalid('expected a chain id and its exact rounds', { index });
    }
    if (chainIds.has(chain.chainId)) invalid('duplicate chain id', { index });
    chainIds.add(chain.chainId);
    if (!Array.isArray(chain.taskIds) || chain.taskIds.length === 0) invalid('select the complete chain', { index });
    for (const id of chain.taskIds) {
      if (!isId(id) || taskIds.has(id)) invalid('expected unique task ids', { index });
      taskIds.add(id);
      if (taskIds.size > HISTORY_DELETE_MAX_TASKS) invalid('too many rounds for one batch', { limit: HISTORY_DELETE_MAX_TASKS });
    }
    return { chainId: chain.chainId, taskIds: [...chain.taskIds] };
  });
  return {
    chains,
    options: {
      archiveSessions: body.archiveSessions === true,
      removeWorktrees: body.removeWorktrees === true,
      cleanPlans: body.cleanPlans === true,
    },
  };
}

function planStore(deps) {
  return deps.plans ?? deps.engine?.plans ?? null;
}

function collectChains(node, byChain) {
  for (const chain of node.chain ? [node.chain] : node.executions ?? []) byChain.set(chain.chainId, chain);
  for (const child of node.children) collectChains(child, byChain);
}

function cleanupContext(engine, archived, plans) {
  const live = engine?.list?.() ?? [];
  const liveById = new Map(live.map((row) => [row.taskId, row]));
  const archivedById = new Map(archived.map((row) => [row.taskId, row]));
  const tasks = new Map([...archivedById, ...liveById]);
  const continuations = new Map();
  const taskChildren = new Map();
  const liveReuseChildren = new Map();
  const planParents = new Set(plans.map((node) => node.parentNodeId));
  const remember = (map, parent, child) => {
    if (typeof parent !== 'string' || parent === '' || parent === child) return;
    if (!map.has(parent)) map.set(parent, new Set());
    map.get(parent).add(child);
  };
  for (const row of [...archived, ...live]) {
    remember(continuations, row.continueFromTaskId, row.taskId);
    remember(taskChildren, row.parentNodeId, row.taskId);
    remember(taskChildren, row.planNodeId, row.taskId);
  }
  for (const row of tasks.values()) {
    if (!FINISHED.has(row.state)) {
      remember(liveReuseChildren, row.reuseWorktreeFromTaskId, row.taskId);
    }
  }
  const tree = buildTaskTree({ planNodes: plans, tasks: [...tasks.values()] });
  const byChain = new Map();
  for (const root of tree.roots) collectChains(root, byChain);
  return { byChain, liveById, archivedById, continuations, taskChildren, liveReuseChildren, planParents, engine };
}

function blockersFor(chain, context) {
  const blockers = new Set();
  const members = new Set(chain.taskIds);
  for (const taskId of members) {
    const live = context.liveById.get(taskId);
    const archived = context.archivedById.get(taskId);
    if ((live && !FINISHED.has(live.state)) || (archived && !FINISHED.has(archived.state))) {
      blockers.add(CLEANUP_CODES.live);
    } else if (!archived || (live && !context.engine.isTaskSettledForCleanup?.(taskId))) {
      blockers.add(CLEANUP_CODES.notDurable);
    }
    if (context.engine?.reviewWriteDone?.(taskId)) blockers.add(CLEANUP_CODES.reviewWrite);
    for (const child of context.continuations.get(taskId) ?? []) {
      if (!members.has(child)) blockers.add(CLEANUP_CODES.nextRound);
    }
    for (const child of context.taskChildren.get(taskId) ?? []) {
      if (!members.has(child)) blockers.add(CLEANUP_CODES.hierarchyChildren);
    }
    for (const child of context.liveReuseChildren.get(taskId) ?? []) {
      if (!members.has(child)) blockers.add(CLEANUP_CODES.hierarchyChildren);
    }
    if (context.planParents.has(taskId)) blockers.add(CLEANUP_CODES.planChildren);
  }
  return [...blockers];
}

export async function cleanupOverview(deps) {
  const archived = await deps.history.load();
  const plans = await planStore(deps)?.load() ?? [];
  const context = cleanupContext(deps.engine, archived, plans);
  const chains = [...context.byChain.values()].map((chain) => {
    const blockers = blockersFor(chain, context);
    return { chainId: chain.chainId, taskIds: [...chain.taskIds], eligible: blockers.length === 0, blockers };
  });
  return { chains };
}

function checkBatch(chains, context) {
  const refused = [];
  for (const { chainId, taskIds } of chains) {
    const chain = context.byChain.get(chainId);
    let blockers;
    if (!chain) blockers = [CLEANUP_CODES.notFound];
    else if (chain.taskIds.length !== taskIds.length || chain.taskIds.some((id, i) => id !== taskIds[i])) {
      blockers = [CLEANUP_CODES.stale];
    } else blockers = blockersFor(chain, context);
    if (blockers.length) refused.push({ chainId, code: blockers[0], blockers });
  }
  if (refused.length) {
    throw new CleanupError(refused[0].code, 'the selected chains cannot be removed as one batch', {
      chains: refused, reason: refused[0].code, deleted: 0,
    });
  }
}

export async function runCleanup(deps, body) {
  const { chains, options } = validateCleanupRequest(body);
  const store = deps.history;
  const plans = planStore(deps);
  const engine = deps.engine;
  if (typeof store?.deleteMany !== 'function' || (plans && typeof plans.withStableNodes !== 'function')) {
    throw new CleanupError(CLEANUP_CODES.unavailable, 'task record cleanup is unavailable');
  }
  const ids = chains.flatMap((chain) => chain.taskIds);
  const idsSet = new Set(ids);
  let deletedRowsSnapshot = [];
  let remainingRowsSnapshot = [];
  const deleteRecords = async (planNodes) => {
    let release;
    try {
      return await store.deleteMany(ids, {
        beforeWrite(archived) {
          // Read the latest engine state inside the history queue. No asynchronous
          // work may run between checking relationships and reserving these ids.
          const context = cleanupContext(engine, archived, planNodes);
          checkBatch(chains, context);
          const allTasks = new Map([...context.archivedById, ...context.liveById]);
          deletedRowsSnapshot = ids.map((id) => allTasks.get(id)).filter(Boolean);
          remainingRowsSnapshot = [...allTasks.values()].filter((row) => !idsSet.has(row.taskId));
          release = engine?.reserveCleanupIds(ids);
        },
        afterWrite(deletedIds) {
          engine?.forgetCleanedRecords(deletedIds);
        },
      });
    } finally {
      release?.();
    }
  };
  let result;
  try {
    result = plans ? await plans.withStableNodes(deleteRecords) : await deleteRecords([]);
  } catch (error) {
    if (error instanceof CleanupError) throw error;
    const code = error?.code === HISTORY_CODES.deleteInvalid ? CLEANUP_CODES.stale
      : error?.code === HISTORY_CODES.writeFailed ? CLEANUP_CODES.failed : CLEANUP_CODES.unavailable;
    throw new CleanupError(code, 'the task records could not be removed', { deleted: 0 });
  }

  const hasLinkedCleanup = options.archiveSessions || options.removeWorktrees || options.cleanPlans;
  if (!hasLinkedCleanup) {
    return {
      chains: chains.length,
      tasks: result.deletedTaskIds.length,
      ...result,
      retained: { sessions: true, workspaces: true, worktrees: true, sourceFiles: true, plans: true },
    };
  }

  const linked = await performLinkedCleanup(deps, {
    options,
    deletedTaskIds: result.deletedTaskIds,
    deletedRows: deletedRowsSnapshot,
    remainingRows: remainingRowsSnapshot,
    plans,
  });

  return {
    chains: chains.length,
    tasks: result.deletedTaskIds.length,
    ...result,
    retained: {
      sessions: !options.archiveSessions,
      workspaces: !options.removeWorktrees,
      worktrees: !options.removeWorktrees,
      sourceFiles: true,
      plans: !options.cleanPlans,
    },
    cleaned: linked,
  };
}

function firstNonEmpty(...values) {
  for (const val of values) {
    if (typeof val === 'string' && val.trim() !== '') return val.trim();
  }
  return null;
}

function extractTaskFacts(row, sessionRow = null) {
  const isolation = firstNonEmpty(
    row?.isolation,
    row?.effective?.worker?.isolation,
    sessionRow?.isolation,
  );
  const sourcePath = firstNonEmpty(
    sessionRow?.sourcePath,
    row?.sourcePath,
    row?.execution?.sourcePath,
    row?.conversation?.sourcePath,
  );
  const executionPath = firstNonEmpty(
    sessionRow?.executionPath,
    row?.executionWorkspacePath,
    row?.worktree?.workspacePath,
    row?.execution?.workspacePath,
    row?.workspacePath,
  );
  const workspaceId = firstNonEmpty(
    sessionRow?.workspaceId,
    row?.workspaceId,
    row?.execution?.workspaceId,
    row?.execution?.conversation?.workspaceId,
    row?.conversation?.workspaceId,
  );
  const sessionId = firstNonEmpty(
    sessionRow?.sessionId,
    row?.sessionId,
    row?.execution?.sessionId,
    row?.execution?.conversation?.sessionId,
    row?.conversation?.sessionId,
  );
  return {
    taskId: firstNonEmpty(row?.taskId, sessionRow?.taskId),
    isolation,
    sourcePath,
    executionPath,
    workspaceId,
    sessionId,
    planNodeId: firstNonEmpty(row?.planNodeId),
    parentNodeId: firstNonEmpty(row?.parentNodeId),
  };
}

function resolveController(serviceOrAccessor) {
  if (serviceOrAccessor === null || serviceOrAccessor === undefined) return null;
  if (typeof serviceOrAccessor === 'object' && 'current' in serviceOrAccessor) {
    return serviceOrAccessor.current ?? null;
  }
  return serviceOrAccessor;
}

async function tryArchiveHostSession(deps, sessionId) {
  const ws = resolveController(deps?.workspaces);
  if (typeof ws?.archiveSession === 'function') {
    try {
      await ws.archiveSession(sessionId);
      return true;
    } catch {
      try {
        await ws.archiveSession({ sessionId });
        return true;
      } catch {
        // Ignore host controller error; browser client also reconciles via client workspaces service.
      }
    }
  }
  const sc = resolveController(deps?.sessionController);
  if (typeof sc?.archiveSession === 'function') {
    try {
      await sc.archiveSession(sessionId);
      return true;
    } catch {
      // Ignore
    }
  }
  return false;
}

async function tryDeleteHostWorkspace(deps, workspaceId) {
  const ws = resolveController(deps?.workspaces);
  if (typeof ws?.delete === 'function') {
    try {
      await ws.delete(workspaceId);
      return true;
    } catch {
      try {
        await ws.delete({ workspaceId });
        return true;
      } catch {
        // Ignore
      }
    }
  }
  return false;
}

function collectReservedReuseRefs(rows, knownRowsById, sessionByTask, engine) {
  const paths = [];
  const sessionIds = [];
  const workspaceIds = [];
  const upstreamTaskIds = new Set();
  if (typeof engine?.reservedWorktreePathsForCleanup === 'function') {
    for (const candidate of engine.reservedWorktreePathsForCleanup()) {
      if (typeof candidate === 'string' && candidate.trim() !== '') paths.push(candidate.trim());
    }
  }
  if (typeof engine?.reservedContinuationRefsForCleanup === 'function') {
    const refs = engine.reservedContinuationRefsForCleanup();
    for (const id of Array.isArray(refs?.sessionIds) ? refs.sessionIds : []) {
      if (typeof id === 'string' && id.trim() !== '') sessionIds.push(id.trim());
    }
    for (const id of Array.isArray(refs?.workspaceIds) ? refs.workspaceIds : []) {
      if (typeof id === 'string' && id.trim() !== '') workspaceIds.push(id.trim());
    }
  }
  for (const row of rows) {
    if (FINISHED.has(row?.state)) continue;
    const reuseId = firstNonEmpty(row?.reuseWorktreeFromTaskId);
    const contId = firstNonEmpty(row?.continueFromTaskId);
    const upstreamId = firstNonEmpty(reuseId, contId);
    if (upstreamId === null) continue;
    upstreamTaskIds.add(upstreamId);
    const upstreamFacts = extractTaskFacts(knownRowsById.get(upstreamId) ?? null, sessionByTask.get(upstreamId) ?? null);
    if (upstreamFacts.executionPath !== null) {
      const execKey = sessionPathKey(upstreamFacts.executionPath);
      const sourceKey = sessionPathKey(upstreamFacts.sourcePath);
      if (execKey !== null && execKey !== sourceKey) paths.push(upstreamFacts.executionPath);
    }
    if (upstreamFacts.workspaceId !== null) workspaceIds.push(upstreamFacts.workspaceId);
    if (contId !== null && upstreamFacts.sessionId !== null) sessionIds.push(upstreamFacts.sessionId);
  }
  return { paths, sessionIds, workspaceIds, upstreamTaskIds };
}

async function performLinkedCleanup(deps, { options, deletedTaskIds, deletedRows, remainingRows, plans }) {
  const deletedSet = new Set(deletedTaskIds);
  let sessionRows = [];
  if (typeof deps?.sessionStore?.list === 'function') {
    try {
      sessionRows = await deps.sessionStore.list();
    } catch {
      sessionRows = [];
    }
  }
  const sessionByTask = new Map(sessionRows.map((row) => [row.taskId, row]));
  const knownRowsById = new Map(
    [...deletedRows, ...remainingRows]
      .filter((row) => typeof row?.taskId === 'string' && row.taskId !== '')
      .map((row) => [row.taskId, row]),
  );

  const activeSessionIds = new Set();
  const activeWorkspaceIds = new Set();
  const activeExecKeys = new Set();
  for (const row of remainingRows) {
    const facts = extractTaskFacts(row, sessionByTask.get(row.taskId));
    if (facts.sessionId !== null) activeSessionIds.add(facts.sessionId);
    if (facts.workspaceId !== null) activeWorkspaceIds.add(facts.workspaceId);
    const execKey = sessionPathKey(facts.executionPath);
    if (execKey !== null) activeExecKeys.add(execKey);
  }
  const reservedLinked = collectReservedReuseRefs(remainingRows, knownRowsById, sessionByTask, deps?.engine);
  for (const sid of reservedLinked.sessionIds) activeSessionIds.add(sid);
  for (const wid of reservedLinked.workspaceIds) activeWorkspaceIds.add(wid);
  for (const reservedPath of reservedLinked.paths) {
    const reservedKey = sessionPathKey(reservedPath);
    if (reservedKey !== null) activeExecKeys.add(reservedKey);
  }

  const deletedFacts = deletedTaskIds.map((taskId) => {
    const row = deletedRows.find((item) => item?.taskId === taskId) ?? { taskId };
    return extractTaskFacts(row, sessionByTask.get(taskId));
  });

  const archivedSessionIds = [];
  const archivedSet = new Set();
  if (options.archiveSessions) {
    for (const facts of deletedFacts) {
      if (facts.sessionId !== null && !activeSessionIds.has(facts.sessionId) && !archivedSet.has(facts.sessionId)) {
        archivedSet.add(facts.sessionId);
        archivedSessionIds.push(facts.sessionId);
        await tryArchiveHostSession(deps, facts.sessionId);
      }
    }
    if (typeof deps?.sessionStore?.forgetMany === 'function') {
      await deps.sessionStore.forgetMany(deletedSet).catch(() => []);
    } else if (typeof deps?.sessionStore?.forget === 'function') {
      for (const id of deletedSet) {
        await deps.sessionStore.forget(id).catch(() => false);
      }
    }
  }

  const removedWorktreePaths = [];
  const removedWorktreeSet = new Set();
  const removedWorkspaceIds = [];
  const removedWorkspaceSet = new Set();

  if (options.removeWorktrees) {
    for (const facts of deletedFacts) {
      // Strictly operate ONLY on worktree-isolated tasks; never touch shared directories or shared workspaces.
      if (facts.isolation !== 'worktree') continue;
      const execKey = sessionPathKey(facts.executionPath);
      const sourceKey = sessionPathKey(facts.sourcePath);
      if (execKey === null || execKey === sourceKey || activeExecKeys.has(execKey)) continue;

      let worktreeEligibleForWorkspaceRemoval = false;
      if (typeof deps?.worktrees?.removeManagedTree === 'function') {
        if (!removedWorktreeSet.has(execKey)) {
          const outcome = await deps.worktrees.removeManagedTree({
            taskId: facts.taskId,
            sourcePath: facts.sourcePath,
            workspacePath: facts.executionPath,
          });
          if (outcome.removed && outcome.workspacePath) {
            removedWorktreeSet.add(execKey);
            removedWorktreePaths.push(outcome.workspacePath);
            worktreeEligibleForWorkspaceRemoval = true;
          } else if (outcome.reason === 'already-absent') {
            removedWorktreeSet.add(execKey);
            worktreeEligibleForWorkspaceRemoval = true;
          }
        } else {
          worktreeEligibleForWorkspaceRemoval = true;
        }
      }

      if (
        worktreeEligibleForWorkspaceRemoval
        && facts.workspaceId !== null
        && !activeWorkspaceIds.has(facts.workspaceId)
        && !removedWorkspaceSet.has(facts.workspaceId)
      ) {
        removedWorkspaceSet.add(facts.workspaceId);
        removedWorkspaceIds.push(facts.workspaceId);
        await tryDeleteHostWorkspace(deps, facts.workspaceId);
      }
    }
  }

  let removedPlanNodeIds = [];
  if (options.cleanPlans && typeof plans?.deleteEmptyAncestors === 'function') {
    const seedPlanIds = new Set();
    for (const facts of deletedFacts) {
      if (facts.planNodeId !== null) seedPlanIds.add(facts.planNodeId);
      if (facts.parentNodeId !== null && facts.parentNodeId.startsWith('plan-')) {
        seedPlanIds.add(facts.parentNodeId);
      }
    }
    if (seedPlanIds.size > 0) {
      try {
        removedPlanNodeIds = await plans.deleteEmptyAncestors(seedPlanIds, remainingRows);
      } catch {
        removedPlanNodeIds = [];
      }
    }
  }

  return {
    archivedSessionIds,
    removedWorktreePaths,
    removedWorkspaceIds,
    removedPlanNodeIds,
  };
}

export function validateOrphanCleanupRequest(body) {
  if (!isObject(body) || Object.keys(body).some((key) => !ALLOWED_ORPHAN_KEYS.has(key))) {
    invalid('expected explicit confirmation for orphan cleanup');
  }
  if (body.confirm !== true) invalid('orphan cleanup requires explicit confirmation', { field: 'confirm' });
  for (const flag of ['archiveSessions', 'removeWorktrees']) {
    if (body[flag] !== undefined && typeof body[flag] !== 'boolean') {
      invalid(`${flag} must be a boolean`, { field: flag });
    }
  }
  return {
    archiveSessions: body.archiveSessions !== false,
    removeWorktrees: body.removeWorktrees !== false,
  };
}

/**
 * Sweep residual worktrees and dispatched session identities whose task records
 * were already deleted or rotated out of `history.json`.
 *
 * Strictly preserves any session, workspace or directory still referenced by a live
 * or retained historical task, and never touches a shared checkout or shared project
 * Workspace.
 * @param {object} deps - runtime dependencies.
 * @param {object} body - `{ confirm: true, archiveSessions?: boolean, removeWorktrees?: boolean }`.
 * @returns {Promise<object>} sweep outcome.
 */
export async function runOrphanCleanup(deps, body) {
  const options = validateOrphanCleanupRequest(body);
  const store = deps?.history;
  if (typeof store?.load !== 'function') {
    throw new CleanupError(CLEANUP_CODES.unavailable, 'task history is unavailable');
  }
  let archived = [];
  try {
    archived = await store.load();
  } catch {
    throw new CleanupError(CLEANUP_CODES.unavailable, 'task history could not be read');
  }
  const live = deps?.engine?.list?.() ?? [];
  const allExisting = [...archived, ...live];
  const existingTaskIds = new Set(allExisting.map((row) => row?.taskId).filter(Boolean));

  let sessionRows = [];
  if (typeof deps?.sessionStore?.list === 'function') {
    try {
      sessionRows = await deps.sessionStore.list();
    } catch {
      sessionRows = [];
    }
  }
  const sessionByTask = new Map(sessionRows.map((row) => [row.taskId, row]));

  const activeSessionIds = new Set();
  const activeWorkspaceIds = new Set();
  const activeExecKeys = new Set();
  const activeExecPaths = [];
  const knownSourcePaths = new Set();

  const knownRowsById = new Map(
    allExisting
      .filter((row) => typeof row?.taskId === 'string' && row.taskId !== '')
      .map((row) => [row.taskId, row]),
  );
  for (const row of allExisting) {
    const facts = extractTaskFacts(row, sessionByTask.get(row.taskId));
    if (facts.sessionId !== null) activeSessionIds.add(facts.sessionId);
    if (facts.workspaceId !== null) activeWorkspaceIds.add(facts.workspaceId);
    if (facts.sourcePath !== null) knownSourcePaths.add(facts.sourcePath);
    if (facts.executionPath !== null) {
      activeExecPaths.push(facts.executionPath);
      const key = sessionPathKey(facts.executionPath);
      if (key !== null) activeExecKeys.add(key);
    }
  }
  const reservedOrphan = collectReservedReuseRefs(allExisting, knownRowsById, sessionByTask, deps?.engine);
  for (const sid of reservedOrphan.sessionIds) activeSessionIds.add(sid);
  for (const wid of reservedOrphan.workspaceIds) activeWorkspaceIds.add(wid);
  for (const reservedPath of reservedOrphan.paths) {
    activeExecPaths.push(reservedPath);
    const key = sessionPathKey(reservedPath);
    if (key !== null) activeExecKeys.add(key);
  }

  const orphanRows = sessionRows.filter(
    (row) => typeof row?.taskId === 'string' && !existingTaskIds.has(row.taskId) && !reservedOrphan.upstreamTaskIds.has(row.taskId),
  );
  const orphanTaskIds = orphanRows.map((row) => row.taskId);

  const archivedSessionIds = [];
  const archivedSet = new Set();
  const removedWorktreePaths = [];
  const removedWorktreeSet = new Set();
  const removedWorkspaceIds = [];
  const removedWorkspaceSet = new Set();

  for (const row of orphanRows) {
    const facts = extractTaskFacts(null, row);
    if (facts.sourcePath !== null) knownSourcePaths.add(facts.sourcePath);

    if (options.archiveSessions && facts.sessionId !== null) {
      if (!activeSessionIds.has(facts.sessionId) && !archivedSet.has(facts.sessionId)) {
        archivedSet.add(facts.sessionId);
        archivedSessionIds.push(facts.sessionId);
        await tryArchiveHostSession(deps, facts.sessionId);
      }
    }

    if (options.removeWorktrees && facts.isolation === 'worktree') {
      const execKey = sessionPathKey(facts.executionPath);
      const sourceKey = sessionPathKey(facts.sourcePath);
      if (execKey !== null && execKey !== sourceKey && !activeExecKeys.has(execKey)) {
        let canRemoveWs = false;
        if (typeof deps?.worktrees?.removeManagedTree === 'function') {
          if (!removedWorktreeSet.has(execKey)) {
            const wt = await deps.worktrees.removeManagedTree({
              taskId: facts.taskId,
              sourcePath: facts.sourcePath,
              workspacePath: facts.executionPath,
            });
            if (wt.removed && wt.workspacePath) {
              removedWorktreeSet.add(execKey);
              removedWorktreePaths.push(wt.workspacePath);
              canRemoveWs = true;
            } else if (wt.reason === 'already-absent') {
              removedWorktreeSet.add(execKey);
              canRemoveWs = true;
            }
          } else {
            canRemoveWs = true;
          }
        }
        if (
          canRemoveWs
          && facts.workspaceId !== null
          && !activeWorkspaceIds.has(facts.workspaceId)
          && !removedWorkspaceSet.has(facts.workspaceId)
        ) {
          removedWorkspaceSet.add(facts.workspaceId);
          removedWorkspaceIds.push(facts.workspaceId);
          await tryDeleteHostWorkspace(deps, facts.workspaceId);
        }
      }
    }
  }

  if (options.archiveSessions && orphanTaskIds.length > 0) {
    if (typeof deps?.sessionStore?.forgetMany === 'function') {
      await deps.sessionStore.forgetMany(orphanTaskIds).catch(() => []);
    } else if (typeof deps?.sessionStore?.forget === 'function') {
      for (const id of orphanTaskIds) {
        await deps.sessionStore.forget(id).catch(() => false);
      }
    }
  }

  if (options.removeWorktrees && typeof deps?.worktrees?.sweepOrphanTrees === 'function') {
    try {
      const swept = await deps.worktrees.sweepOrphanTrees({
        activePaths: activeExecPaths,
        sourcePaths: [...knownSourcePaths],
      });
      for (const wtPath of Array.isArray(swept?.removedWorktreePaths) ? swept.removedWorktreePaths : []) {
        const key = sessionPathKey(wtPath);
        if (key !== null && !removedWorktreeSet.has(key)) {
          removedWorktreeSet.add(key);
          removedWorktreePaths.push(wtPath);
        }
      }
    } catch {
      // Best-effort disk sweep.
    }
  }

  return {
    orphanSessionsForgotten: options.archiveSessions ? orphanTaskIds.length : 0,
    cleaned: {
      archivedSessionIds,
      removedWorktreePaths,
      removedWorkspaceIds,
    },
    retained: {
      sourceFiles: true,
    },
  };
}
