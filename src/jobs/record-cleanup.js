import { buildTaskTree } from './task-tree.js';
import { HISTORY_CODES, HISTORY_DELETE_MAX_TASKS } from './history.js';

export const MAX_CLEANUP_CHAINS = 100;
const FINISHED = new Set(['awaiting-host-review', 'failed', 'cancelled']);

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
  if (!isObject(body) || Object.keys(body).some((key) => key !== 'chains' && key !== 'confirm')) {
    invalid('expected only chains and explicit confirmation');
  }
  if (body.confirm !== true) invalid('cleanup requires explicit confirmation', { field: 'confirm' });
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
  return { chains };
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
  const tree = buildTaskTree({ planNodes: plans, tasks: [...tasks.values()] });
  const byChain = new Map();
  for (const root of tree.roots) collectChains(root, byChain);
  return { byChain, liveById, archivedById, continuations, taskChildren, planParents, engine };
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
  const { chains } = validateCleanupRequest(body);
  const store = deps.history;
  const plans = planStore(deps);
  const engine = deps.engine;
  if (typeof store?.deleteMany !== 'function' || (plans && typeof plans.withStableNodes !== 'function')) {
    throw new CleanupError(CLEANUP_CODES.unavailable, 'task record cleanup is unavailable');
  }
  const ids = chains.flatMap((chain) => chain.taskIds);
  const deleteRecords = async (planNodes) => {
    let release;
    try {
      return await store.deleteMany(ids, {
        beforeWrite(archived) {
          // Read the latest engine state inside the history queue. No asynchronous
          // work may run between checking relationships and reserving these ids.
          checkBatch(chains, cleanupContext(engine, archived, planNodes));
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
  return {
    chains: chains.length,
    tasks: result.deletedTaskIds.length,
    ...result,
    retained: { sessions: true, workspaces: true, worktrees: true, sourceFiles: true, plans: true },
  };
}
