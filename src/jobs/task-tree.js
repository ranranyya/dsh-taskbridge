// Deterministic, runtime-agnostic task tree and continuation-chain projection.
//
// Zero Node-only imports so both the server planes and the browser bundle can use
// the exact same relational rules:
//   1. `continueFromTaskId` links rectification rounds of ONE work item only;
//   2. `planNodeId` binds an execution chain to an unexecuted/planned node;
//   3. `parentNodeId` builds the multi-level goal -> subtask -> step hierarchy;
//   4. Titles, timestamps, models and prompts are NEVER used to infer relationships;
//   5. Missing parents/plans become explicit orphans (never dropped or title-merged),
//      and corrupted parent/continuation cycles are broken deterministically.

const PATH_MASK_SEGMENT = 'masks-user-profile-segment';
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
export const UNVERIFIED_PROJECT_KEY = 'unverified';

export function isMaskedPathString(value) {
  if (typeof value !== 'string') return false;
  return value.split(/[\\/]+/u).some((part) => part.trim() === PATH_MASK_SEGMENT);
}

export function normalizePathComparisonKey(value, options = {}) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || isMaskedPathString(trimmed)) return null;
  const stripped = trimmed.length > 1 ? trimmed.replace(/[\\/]+$/u, '') : trimmed;
  const caseInsensitive = options.caseInsensitive ?? /^[A-Za-z]:[\\/]/u.test(stripped);
  return caseInsensitive ? stripped.toLowerCase() : stripped;
}

function cleanRef(value, selfId = null) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === selfId) return null;
  return trimmed;
}

function shortTaskLabel(id) {
  if (typeof id !== 'string' || id === '') return 'unknown';
  const stripped = id.startsWith('task-') ? id.slice(5) : id;
  return stripped.slice(0, 8);
}

export function explicitContinuationOf(task) {
  if (!isObject(task)) return null;
  const selfId = typeof task.taskId === 'string' ? task.taskId.trim() : null;
  const direct = cleanRef(task.continueFromTaskId, selfId);
  if (direct !== null) return direct;
  const placed = cleanRef(task.execution?.conversation?.continuedFromTaskId, selfId);
  return placed;
}

/**
 * Group flat task views into continuation chains using explicit `continueFromTaskId` only.
 * @param {object[]} tasks - live + archived task views.
 * @returns {object[]} ordered chains.
 */
export function groupContinuationChains(tasks = []) {
  const byId = new Map();
  for (const raw of Array.isArray(tasks) ? tasks : []) {
    if (!isObject(raw) || typeof raw.taskId !== 'string' || raw.taskId.trim() === '') continue;
    const taskId = raw.taskId.trim();
    if (!byId.has(taskId)) byId.set(taskId, raw);
  }

  // Build explicit parent link `childId -> parentTaskId` with self-loop guard.
  const parentOf = new Map();
  const brokenByTask = new Map();
  for (const [taskId, task] of byId.entries()) {
    const rawCont = typeof task.continueFromTaskId === 'string' ? task.continueFromTaskId.trim() : '';
    if (rawCont !== '' && rawCont === taskId) {
      brokenByTask.set(taskId, { cycleTaskId: taskId, reason: 'cycle-broken' });
      continue;
    }
    const target = explicitContinuationOf(task);
    if (target === null) continue;
    if (!byId.has(target)) {
      brokenByTask.set(taskId, { missingTaskId: target, reason: 'missing-task' });
      continue;
    }
    parentOf.set(taskId, target);
  }

  // Detect and break cycles in `parentOf` deterministically (earliest createdAt/taskId becomes root).
  const state = new Map(); // 0/undef = unvisited, 1 = visiting, 2 = done
  for (const startId of byId.keys()) {
    if ((state.get(startId) ?? 0) !== 0) continue;
    const trail = [];
    const indexInTrail = new Map();
    let cur = startId;
    while (cur !== null && cur !== undefined) {
      const st = state.get(cur) ?? 0;
      if (st === 2) break;
      if (st === 1) {
        const cycleStart = indexInTrail.get(cur) ?? 0;
        const cycleIds = trail.slice(cycleStart);
        cycleIds.sort((a, b) => compareTasksChronologically(byId.get(a), byId.get(b)));
        const chosenRoot = cycleIds[0];
        const brokenTarget = parentOf.get(chosenRoot);
        parentOf.delete(chosenRoot);
        brokenByTask.set(chosenRoot, { cycleTaskId: brokenTarget, reason: 'cycle-broken' });
        break;
      }
      state.set(cur, 1);
      indexInTrail.set(cur, trail.length);
      trail.push(cur);
      cur = parentOf.get(cur) ?? null;
    }
    for (const id of trail) state.set(id, 2);
  }

  // Group children under each chain's root task.
  const childrenOf = new Map();
  for (const [childId, pId] of parentOf.entries()) {
    if (!childrenOf.has(pId)) childrenOf.set(pId, []);
    childrenOf.get(pId).push(childId);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => compareTasksChronologically(byId.get(a), byId.get(b)));
  }

  const roots = [];
  for (const taskId of byId.keys()) {
    if (!parentOf.has(taskId)) roots.push(taskId);
  }
  roots.sort((a, b) => compareTasksChronologically(byId.get(a), byId.get(b)));

  const chains = [];
  for (const rootId of roots) {
    const rounds = [];
    let hasParallelContinuations = false;
    const collect = (id) => {
      const task = byId.get(id);
      rounds.push(task);
      const kids = childrenOf.get(id) ?? [];
      if (kids.length > 1) hasParallelContinuations = true;
      for (const kid of kids) collect(kid);
    };
    collect(rootId);

    const rootTask = rounds[0];
    const latestTask = rounds[rounds.length - 1];

    // Hierarchy identity comes from explicit fields only, never guessed.
    let planNodeId = null;
    let parentNodeId = null;
    let hierarchyMismatch = false;
    for (const r of rounds) {
      const rPlan = cleanRef(r.planNodeId, r.taskId);
      const rParent = cleanRef(r.parentNodeId, r.taskId);
      if (rPlan !== null) {
        if (planNodeId === null) planNodeId = rPlan;
        else if (planNodeId !== rPlan) hierarchyMismatch = true;
      }
      if (rParent !== null) {
        if (parentNodeId === null) parentNodeId = rParent;
        else if (parentNodeId !== rParent) hierarchyMismatch = true;
      }
    }

    const recordedTitle = firstNonEmptyTitle(rounds);
    const titleMissing = recordedTitle === null;
    const displayTitle = titleMissing
      ? `未记录标题 (${shortTaskLabel(rootId)})`
      : recordedTitle;

    const goalDescription = firstNonEmptyDescription(rounds, 'goalDescription');
    const latestAcceptedOrReviewed = [...rounds].reverse().find(
      (r) => acceptanceVerdictOf(r.hostAcceptance) !== null,
    ) ?? null;
    const completionSummary = typeof latestAcceptedOrReviewed?.hostAcceptance?.completionSummary === 'string'
      && latestAcceptedOrReviewed.hostAcceptance.completionSummary.trim() !== ''
      ? latestAcceptedOrReviewed.hostAcceptance.completionSummary.trim()
      : null;

    chains.push({
      chainId: rootId,
      rootTaskId: rootId,
      latestTaskId: latestTask.taskId,
      taskIds: rounds.map((r) => r.taskId),
      roundCount: rounds.length,
      rounds,
      title: recordedTitle,
      titleMissing,
      displayTitle,
      goalDescription,
      completionSummary,
      planNodeId,
      parentNodeId,
      hierarchyRecorded: planNodeId !== null || parentNodeId !== null,
      hierarchyMismatch,
      hasParallelContinuations,
      brokenContinuation: brokenByTask.get(rootId) ?? null,
      nodeStatus: deriveChainStatus(rounds, hasParallelContinuations),
      createdAt: finiteNumber(rootTask.createdAt) ?? 0,
      updatedAt: maxTimestampOfRounds(rounds),
      sourcePath: rootTask.sourcePath ?? rootTask.workspacePath ?? null,
      sourcePathDigest: isDigest(rootTask.sourcePathDigest) ? rootTask.sourcePathDigest : null,
    });
  }

  return chains;
}

/**
 * Derive conservative status for a task continuation chain (foundation for G04).
 * Execution finishing (`awaiting-host-review`) is NEVER reported as `accepted`.
 */
export function deriveChainStatus(rounds, hasParallelContinuations = false) {
  if (!Array.isArray(rounds) || rounds.length === 0) return 'planned';
  for (const r of rounds) {
    if (r.state === 'running' && (r.phase === 'awaiting-permission' || r.permission?.waiting === true)) {
      return 'awaiting-permission';
    }
    if (r.state === 'running' && (r.phase === 'awaiting-question' || r.question?.waiting === true)) {
      return 'awaiting-question';
    }
  }
  if (rounds.some((r) => r.state === 'pending' || r.state === 'running')) {
    return 'running';
  }
  const latest = rounds[rounds.length - 1];
  // If parallel continuations exist and any leaf/sibling round is unaccepted or failed, do not mark accepted.
  if (hasParallelContinuations) {
    for (const r of rounds.slice(1)) {
      if (r.state === 'awaiting-host-review' && !isSavedAcceptance(r)) return 'awaiting-host-review';
      if (acceptanceVerdictOf(r.hostAcceptance) === 'changes-requested') return 'changes-requested';
    }
  }
  if (latest.state === 'awaiting-host-review') {
    if (isSavedAcceptance(latest)) {
      return latest.hostAcceptance.accepted === true ? 'accepted' : 'changes-requested';
    }
    return 'awaiting-host-review';
  }
  if (latest.state === 'failed') return 'failed';
  if (latest.state === 'cancelled') return 'cancelled';
  if (latest.state === 'interrupted') return 'interrupted';
  return 'unknown';
}

function acceptanceVerdictOf(acceptance) {
  if (!isObject(acceptance)) return null;
  const raw = acceptance.state ?? acceptance.decision ?? null;
  if (raw === 'accepted' || raw === 'changes-requested') return raw;
  if (typeof acceptance.accepted === 'boolean') {
    return acceptance.accepted ? 'accepted' : 'changes-requested';
  }
  return null;
}

function isSavedAcceptance(task) {
  if (acceptanceVerdictOf(task?.hostAcceptance) === null) return false;
  if (task.reviewPersistence && typeof task.reviewPersistence.state === 'string') {
    if (task.reviewPersistence.state !== 'saved' && task.reviewPersistence.state !== 'none') {
      return false;
    }
  }
  return true;
}

/**
 * Build the complete multi-level goal/subtask tree and project index.
 * @param {{ planNodes?: object[], tasks?: object[] }} input - loaded plan nodes and tasks.
 * @returns {object} structured tree, flat index, orphans, projects and counts.
 */
export function buildTaskTree(input = {}) {
  const rawPlans = Array.isArray(input.planNodes) ? input.planNodes : [];
  const rawTasks = Array.isArray(input.tasks) ? input.tasks : [];

  const chains = groupContinuationChains(rawTasks);
  const projectResolver = createProjectResolver(rawPlans, chains);

  const planWrappers = new Map();
  const orderedPlans = [...rawPlans]
    .filter((p) => isObject(p) && typeof p.nodeId === 'string' && p.nodeId.trim() !== '')
    .sort(comparePlanRecords);

  for (const plan of orderedPlans) {
    const nodeId = plan.nodeId.trim();
    if (planWrappers.has(nodeId)) continue;
    const parentNodeId = typeof plan.parentNodeId === 'string' && plan.parentNodeId.trim() !== ''
      ? plan.parentNodeId.trim()
      : null;
    const project = projectResolver.resolve(plan.sourcePath ?? null, plan.sourcePathDigest ?? null);
    const completionSummary = typeof plan.hostAcceptance?.completionSummary === 'string'
      && plan.hostAcceptance.completionSummary.trim() !== ''
      ? plan.hostAcceptance.completionSummary.trim()
      : null;
    planWrappers.set(nodeId, {
      kind: 'plan',
      nodeId,
      parentNodeId,
      title: plan.title,
      displayTitle: plan.title,
      titleMissing: false,
      goalDescription: typeof plan.goalDescription === 'string' ? plan.goalDescription : null,
      completionSummary,
      hostAcceptance: plan.hostAcceptance ?? null,
      reviewHistory: Array.isArray(plan.reviewHistory) ? plan.reviewHistory : [],
      sequence: Number.isSafeInteger(plan.sequence) ? plan.sequence : 0,
      createdAt: finiteNumber(plan.createdAt) ?? 0,
      updatedAt: finiteNumber(plan.updatedAt) ?? finiteNumber(plan.createdAt) ?? 0,
      sourcePath: plan.sourcePath ?? null,
      sourcePathDigest: isDigest(plan.sourcePathDigest) ? plan.sourcePathDigest : null,
      projectKey: project.projectKey,
      executions: [],
      children: [],
      orphan: null,
      executed: false,
      nodeStatus: 'planned',
      depth: 1,
    });
  }

  // Lookup table for valid parent targets: plan nodeId -> wrapper, taskId -> wrapper.
  const parentLookup = new Map();
  for (const [nodeId, wrapper] of planWrappers.entries()) {
    parentLookup.set(nodeId, wrapper);
  }

  const taskNodes = [];
  for (const chain of chains) {
    if (chain.planNodeId !== null) {
      const targetPlan = planWrappers.get(chain.planNodeId) ?? null;
      if (targetPlan !== null) {
        targetPlan.executions.push(chain);
        targetPlan.executed = true;
        if (chain.updatedAt > targetPlan.updatedAt) targetPlan.updatedAt = chain.updatedAt;
        // Any child task naming a taskId in this chain resolves to this plan node in the tree.
        for (const tId of chain.taskIds) {
          if (!parentLookup.has(tId)) parentLookup.set(tId, targetPlan);
        }
        continue;
      }
      // Missing planNodeId -> preserve as root-level orphan task node, never drop or guess!
      const project = projectResolver.resolve(chain.sourcePath, chain.sourcePathDigest);
      const orphanNode = makeTaskTreeNode(chain, project.projectKey, {
        isOrphan: true,
        kind: 'missing-plan-node',
        missingNodeId: chain.planNodeId,
      });
      taskNodes.push(orphanNode);
      for (const tId of chain.taskIds) {
        if (!parentLookup.has(tId)) parentLookup.set(tId, orphanNode);
      }
      continue;
    }

    const project = projectResolver.resolve(chain.sourcePath, chain.sourcePathDigest);
    const taskNode = makeTaskTreeNode(chain, project.projectKey, null);
    taskNodes.push(taskNode);
    for (const tId of chain.taskIds) {
      if (!parentLookup.has(tId)) parentLookup.set(tId, taskNode);
    }
  }

  // Combine all structural nodes (plan nodes + standalone/child task nodes).
  const allNodes = [...planWrappers.values(), ...taskNodes];
  const nodeByPrimaryId = new Map(allNodes.map((n) => [n.nodeId, n]));

  // Resolve each node's parent wrapper, detecting self-loops and missing parents.
  const resolvedParent = new Map();
  for (const node of allNodes) {
    if (node.orphan !== null) {
      // Already marked orphan (e.g. missing-plan-node) -> stays at root.
      resolvedParent.set(node.nodeId, null);
      continue;
    }
    const rawParentId = node.parentNodeId;
    if (rawParentId === null) {
      resolvedParent.set(node.nodeId, null);
      continue;
    }
    const target = parentLookup.get(rawParentId) ?? null;
    if (target === null) {
      node.orphan = {
        isOrphan: true,
        kind: 'missing-parent',
        missingParentId: rawParentId,
      };
      resolvedParent.set(node.nodeId, null);
      continue;
    }
    if (target.nodeId === node.nodeId) {
      node.orphan = {
        isOrphan: true,
        kind: 'cycle-broken',
        cycleParentId: rawParentId,
      };
      resolvedParent.set(node.nodeId, null);
      continue;
    }
    resolvedParent.set(node.nodeId, target.nodeId);
  }

  // Detect and break multi-node parent cycles deterministically.
  const visitState = new Map();
  for (const node of allNodes) {
    if ((visitState.get(node.nodeId) ?? 0) !== 0) continue;
    const trail = [];
    const pos = new Map();
    let curId = node.nodeId;
    while (curId !== null && curId !== undefined) {
      const st = visitState.get(curId) ?? 0;
      if (st === 2) break;
      if (st === 1) {
        const startIdx = pos.get(curId) ?? 0;
        const cycleIds = trail.slice(startIdx);
        // Detach the earliest node's upward back-edge so the earliest node stays root and
        // newer nodes in the cycle remain descendants beneath it.
        cycleIds.sort((a, b) => compareStructuralNodes(nodeByPrimaryId.get(a), nodeByPrimaryId.get(b)));
        const rootToDetachId = cycleIds[0];
        const rootNode = nodeByPrimaryId.get(rootToDetachId);
        const cycleTarget = rootNode.parentNodeId;
        resolvedParent.set(rootToDetachId, null);
        rootNode.orphan = {
          isOrphan: true,
          kind: 'cycle-broken',
          cycleParentId: cycleTarget,
        };
        break;
      }
      visitState.set(curId, 1);
      pos.set(curId, trail.length);
      trail.push(curId);
      curId = resolvedParent.get(curId) ?? null;
    }
    for (const id of trail) visitState.set(id, 2);
  }

  // Attach children to resolved parents and collect roots.
  const roots = [];
  for (const node of allNodes) {
    const pId = resolvedParent.get(node.nodeId) ?? null;
    if (pId === null) {
      roots.push(node);
    } else {
      const parent = nodeByPrimaryId.get(pId);
      parent.children.push(node);
    }
  }

  // Sort children at each level, compute depths and roll up node statuses bottom-up.
  const sortAndFinalize = (list, depth) => {
    list.sort(compareStructuralNodes);
    for (const node of list) {
      node.depth = depth;
      if (node.children.length > 0) {
        sortAndFinalize(node.children, depth + 1);
      }
      if (node.kind === 'plan') {
        finalizePlanNodeStatus(node);
      }
    }
  };
  sortAndFinalize(roots, 1);

  // Build flat pre-order index and orphan summary.
  const flatNodes = [];
  const orphans = [];
  const walkFlat = (node, resolvedParentId) => {
    const roundCount = node.kind === 'plan'
      ? node.executions.reduce((sum, ch) => sum + ch.roundCount, 0)
      : node.chain.roundCount;
    flatNodes.push({
      nodeId: node.nodeId,
      kind: node.kind,
      parentNodeId: node.parentNodeId,
      resolvedParentNodeId: resolvedParentId,
      depth: node.depth,
      title: node.title,
      displayTitle: node.displayTitle,
      titleMissing: node.titleMissing,
      goalDescription: node.goalDescription,
      completionSummary: node.completionSummary,
      executed: node.executed,
      nodeStatus: node.nodeStatus,
      roundCount,
      childCount: node.children.length,
      orphan: node.orphan,
      projectKey: node.projectKey,
    });
    if (node.orphan !== null) {
      orphans.push({ nodeId: node.nodeId, kind: node.kind, orphan: node.orphan });
    }
    for (const child of node.children) {
      walkFlat(child, node.nodeId);
    }
  };
  for (const root of roots) walkFlat(root, null);

  const projects = projectResolver.summarize(roots, allNodes);
  const unexecutedPlanNodes = [...planWrappers.values()].filter(
    (p) => p.executions.length === 0 && p.children.every((c) => !c.executed),
  ).length;

  return {
    roots,
    flatNodes,
    orphans,
    projects,
    counts: {
      planNodes: planWrappers.size,
      taskRecords: rawTasks.length,
      taskChains: chains.length,
      roots: roots.length,
      orphans: orphans.length,
      unexecutedPlanNodes,
    },
  };
}

function makeTaskTreeNode(chain, projectKey, orphan) {
  return {
    kind: 'task',
    nodeId: chain.rootTaskId,
    parentNodeId: chain.parentNodeId,
    title: chain.title,
    displayTitle: chain.displayTitle,
    titleMissing: chain.titleMissing,
    goalDescription: chain.goalDescription,
    completionSummary: chain.completionSummary,
    hostAcceptance: chain.rounds[chain.rounds.length - 1]?.hostAcceptance ?? null,
    createdAt: chain.createdAt,
    updatedAt: chain.updatedAt,
    sourcePath: chain.sourcePath,
    sourcePathDigest: chain.sourcePathDigest,
    projectKey,
    chain,
    rounds: chain.rounds,
    children: [],
    orphan,
    standalone: chain.planNodeId === null && chain.parentNodeId === null,
    executed: true,
    nodeStatus: chain.nodeStatus,
    depth: 1,
  };
}

function finalizePlanNodeStatus(node) {
  const hasExecutions = node.executions.length > 0;
  const anyChildExecuted = node.children.some((c) => c.executed);
  node.executed = hasExecutions || anyChildExecuted;

  // Priority of active attention states in own executions or children:
  const childStatuses = node.children.map((c) => c.nodeStatus);
  const execStatuses = node.executions.map((e) => e.nodeStatus);
  const allSub = [...execStatuses, ...childStatuses];

  for (const urgent of ['awaiting-permission', 'awaiting-question', 'running', 'failed', 'changes-requested', 'awaiting-host-review', 'interrupted', 'cancelled']) {
    if (allSub.includes(urgent)) {
      node.nodeStatus = urgent;
      return;
    }
  }

  // Own explicit commander review on the plan node:
  if (acceptanceVerdictOf(node.hostAcceptance) === 'changes-requested') {
    node.nodeStatus = 'changes-requested';
    return;
  }
  if (node.hostAcceptance?.accepted === true) {
    // Only mark accepted when no child is unexecuted/pending!
    if (allSub.some((st) => st === 'planned')) {
      node.nodeStatus = 'in-progress';
      return;
    }
    node.nodeStatus = 'accepted';
    return;
  }

  // If executions exist without a plan-level review, reflect the latest execution chain status:
  if (hasExecutions && node.children.length === 0) {
    node.nodeStatus = node.executions[node.executions.length - 1].nodeStatus;
    return;
  }

  if (allSub.length > 0 && allSub.every((st) => st === 'accepted')) {
    // All children accepted, awaiting final goal review by commander (G04 rule).
    node.nodeStatus = 'children-accepted';
    return;
  }
  if (allSub.some((st) => st === 'accepted' || st === 'children-accepted' || st === 'in-progress')) {
    node.nodeStatus = 'in-progress';
    return;
  }
  node.nodeStatus = 'planned';
}

function createProjectResolver(planNodes, chains) {
  // Map normalized unmasked path -> verified digest when both are present, so legacy records
  // carrying the same unmasked path join the exact same project bucket.
  const normToDigest = new Map();
  const projectsByKey = new Map();

  const observe = (sourcePath, sourcePathDigest) => {
    const norm = normalizePathComparisonKey(sourcePath);
    const digest = isDigest(sourcePathDigest) ? sourcePathDigest : null;
    if (norm !== null && digest !== null && !normToDigest.has(norm)) {
      normToDigest.set(norm, digest);
    }
  };
  for (const p of planNodes) {
    if (isObject(p)) observe(p.sourcePath, p.sourcePathDigest);
  }
  for (const c of chains) observe(c.sourcePath, c.sourcePathDigest);

  const ensureEntry = (projectKey, sourcePath, unverified) => {
    let entry = projectsByKey.get(projectKey);
    if (entry === undefined) {
      entry = {
        projectKey,
        name: unverified ? '来源未确认' : folderNameOf(sourcePath) ?? '已验证项目',
        sourcePath: unverified ? null : (isMaskedPathString(sourcePath) ? null : sourcePath),
        shortPath: null,
        unverified,
      };
      projectsByKey.set(projectKey, entry);
    } else if (entry.sourcePath === null && !unverified && typeof sourcePath === 'string' && !isMaskedPathString(sourcePath)) {
      entry.sourcePath = sourcePath;
      entry.name = folderNameOf(sourcePath) ?? entry.name;
    }
    return entry;
  };

  const resolve = (sourcePath, sourcePathDigest) => {
    const norm = normalizePathComparisonKey(sourcePath);
    const digest = isDigest(sourcePathDigest) ? sourcePathDigest : (norm !== null ? (normToDigest.get(norm) ?? null) : null);
    if (digest !== null) {
      return ensureEntry(digest, typeof sourcePath === 'string' ? sourcePath.trim() : null, false);
    }
    if (norm !== null) {
      return ensureEntry(`path:${norm}`, sourcePath.trim(), false);
    }
    return ensureEntry(UNVERIFIED_PROJECT_KEY, null, true);
  };

  const summarize = (roots, allNodes) => {
    // Disambiguate same-name projects by computing trailing path segments!
    const byName = new Map();
    for (const entry of projectsByKey.values()) {
      if (entry.unverified) continue;
      if (!byName.has(entry.name)) byName.set(entry.name, []);
      byName.get(entry.name).push(entry);
    }
    for (const group of byName.values()) {
      if (group.length <= 1) {
        if (group.length === 1 && group[0].sourcePath !== null) {
          group[0].shortPath = trailingSegments(group[0].sourcePath, 2);
        }
        continue;
      }
      assignDisambiguatedPaths(group);
    }

    const rootIdsByProject = new Map();
    const countByProject = new Map();
    for (const r of roots) {
      if (!rootIdsByProject.has(r.projectKey)) rootIdsByProject.set(r.projectKey, []);
      rootIdsByProject.get(r.projectKey).push(r.nodeId);
    }
    for (const n of allNodes) {
      countByProject.set(n.projectKey, (countByProject.get(n.projectKey) ?? 0) + 1);
    }

    const list = [];
    for (const entry of projectsByKey.values()) {
      const nodeCount = countByProject.get(entry.projectKey) ?? 0;
      if (nodeCount === 0) continue;
      list.push({
        projectKey: entry.projectKey,
        name: entry.name,
        shortPath: entry.shortPath,
        sourcePath: entry.sourcePath,
        unverified: entry.unverified,
        rootNodeIds: rootIdsByProject.get(entry.projectKey) ?? [],
        nodeCount,
      });
    }
    list.sort((a, b) => {
      if (a.unverified !== b.unverified) return a.unverified ? 1 : -1;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.projectKey < b.projectKey ? -1 : a.projectKey > b.projectKey ? 1 : 0;
    });
    return list;
  };

  return { resolve, summarize };
}

function assignDisambiguatedPaths(entries) {
  for (let depth = 2; depth <= 8; depth += 1) {
    const seen = new Map();
    let collision = false;
    for (const entry of entries) {
      const candidate = entry.sourcePath !== null
        ? trailingSegments(entry.sourcePath, depth)
        : `${entry.name}#${entry.projectKey.slice(-6)}`;
      if (seen.has(candidate)) collision = true;
      seen.set(candidate, entry);
      entry.shortPath = candidate;
    }
    if (!collision) return;
  }
}

function folderNameOf(pathValue) {
  if (typeof pathValue !== 'string' || pathValue.trim() === '' || isMaskedPathString(pathValue)) return null;
  const parts = pathValue.trim().replace(/[\\/]+$/u, '').split(/[\\/]+/u).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

function trailingSegments(pathValue, count) {
  const parts = pathValue.trim().replace(/[\\/]+$/u, '').split(/[\\/]+/u).filter(Boolean);
  return parts.slice(-count).join('/');
}

function firstNonEmptyTitle(rounds) {
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    const t = rounds[i]?.title;
    if (typeof t === 'string' && t.trim() !== '') return t.trim();
  }
  return null;
}

function firstNonEmptyDescription(rounds, field) {
  for (const r of rounds) {
    const val = r?.[field];
    if (typeof val === 'string' && val.trim() !== '') return val.trim();
  }
  return null;
}

function maxTimestampOfRounds(rounds) {
  let max = 0;
  for (const r of rounds) {
    for (const candidate of [r.endedAt, r.startedAt, r.createdAt, r.hostAcceptance?.acceptedAt, r.hostAcceptance?.decidedAt]) {
      const num = finiteNumber(candidate);
      if (num !== null && num > max) max = num;
    }
  }
  return max;
}

function compareTasksChronologically(a, b) {
  const left = finiteNumber(a?.createdAt) ?? 0;
  const right = finiteNumber(b?.createdAt) ?? 0;
  if (left !== right) return left - right;
  const idA = typeof a?.taskId === 'string' ? a.taskId : '';
  const idB = typeof b?.taskId === 'string' ? b.taskId : '';
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

function comparePlanRecords(a, b) {
  const seqA = Number.isSafeInteger(a?.sequence) ? a.sequence : 0;
  const seqB = Number.isSafeInteger(b?.sequence) ? b.sequence : 0;
  if (seqA !== seqB) return seqA - seqB;
  const left = finiteNumber(a?.createdAt) ?? 0;
  const right = finiteNumber(b?.createdAt) ?? 0;
  if (left !== right) return left - right;
  const idA = typeof a?.nodeId === 'string' ? a.nodeId : '';
  const idB = typeof b?.nodeId === 'string' ? b.nodeId : '';
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

function compareStructuralNodes(a, b) {
  // Preserve plan sibling order first when both carry explicit plan sequences; otherwise chronological.
  if (a?.kind === 'plan' && b?.kind === 'plan') {
    return comparePlanRecords(a, b);
  }
  const left = finiteNumber(a?.createdAt) ?? 0;
  const right = finiteNumber(b?.createdAt) ?? 0;
  if (left !== right) return left - right;
  const idA = typeof a?.nodeId === 'string' ? a.nodeId : '';
  const idB = typeof b?.nodeId === 'string' ? b.nodeId : '';
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

function isDigest(value) {
  return typeof value === 'string' && SHA256_DIGEST_RE.test(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
