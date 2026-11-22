// Task-record cleanup: which execution chains may be selected for deletion, what a
// deletion batch carries, and what the operator is shown before it is sent.
//
// Zero Node-only imports and no React: this is the part of "清理记录" that can be
// reasoned about and tested on its own, while the page (`index.jsx`) only renders
// the answers computed here. Three rules shape everything:
//
//   1. **Identity comes from the host's own tree.** A selectable unit is ONE
//      execution chain (`chainId`, `taskIds`) taken from the projection's
//      `executions` — including a chain attached to a planning node — and the
//      selection carries exactly that chain's ids. Nothing is inferred from a
//      title, a time or a position, and the tree is never re-derived here.
//   2. **Eligibility is stated, not guessed.** A chain the host marked as still
//      active/undurable, as depended on by another chain, or as holding planning
//      children is listed with `selectable: false` and a reason. A selection only
//      ever contains selectable chains, so a disabled row cannot be sent by accident.
//      The server re-checks every rule; this side only decides what to draw.
//   3. **The batch is closed.** The request body carries `{ chainId, taskIds }`
//      pairs and nothing else: no time range, no path, and no "delete everything".

/** Refusal/notice codes the cleanup surface may produce locally. */
export const CLEANUP_BLOCKER_LABELS = Object.freeze({
  CLEANUP_CHAIN_LIVE: '仍在执行或未正常结束，不能清理',
  CLEANUP_NOT_DURABLE: '记录尚未写入，不能清理',
  CLEANUP_NEXT_ROUND: '还有续接记录，不能清理',
  CLEANUP_PLAN_CHILDREN: '有规划子节点引用此记录，不能清理',
  CLEANUP_HIERARCHY_CHILDREN: '有子任务引用此记录，不能清理',
  CLEANUP_REVIEW_WRITE: '审查意见正在写入，请稍后重试',
  CLEANUP_UNAVAILABLE: '清理暂不可用',
  CLEANUP_STALE: '任务记录已变化，请重新选择',
  unknown: '暂时无法确认这条记录可以清理',
  'selection-stale': '任务记录已变化，请重新选择',
});

/** Chinese label for one blocker code, falling back to the raw code. */
export function cleanupBlockerLabel(code) {
  if (typeof code !== 'string' || code === '') return CLEANUP_BLOCKER_LABELS.unknown;
  return CLEANUP_BLOCKER_LABELS[code] ?? String(code);
}

/**
 * How many chains one request may name. Mirrors `MAX_CLEANUP_CHAINS` in
 * `src/jobs/record-cleanup.js`; the host refuses a larger batch rather than
 * silently dropping the rest, and the page refuses it before sending.
 */
export const MAX_CLEANUP_CHAINS = 100;

/** Chains of one node: a plan node carries `executions`, a task node its own `chain`. */
function chainsOf(node) {
  if (node === null || typeof node !== 'object') return [];
  if (Array.isArray(node.executions)) return node.executions;
  return node.chain !== null && typeof node.chain === 'object' ? [node.chain] : [];
}

/** One chain whose identity the page can key, or `null`. */
function selectableChain(chain) {
  if (chain === null || typeof chain !== 'object') return null;
  const chainId = typeof chain.chainId === 'string' && chain.chainId !== '' ? chain.chainId : null;
  const taskIds = Array.isArray(chain.taskIds) ? chain.taskIds.filter((id) => typeof id === 'string' && id !== '') : [];
  if (chainId === null || taskIds.length === 0) return null;
  return { chainId, taskIds };
}

/**
 * Every execution chain of one rendered tree, in pre-order, with its eligibility.
 *
 * A chain that appears twice (it cannot in one projection, but a host could answer a
 * duplicated node) is listed once, by `chainId`: the selection is a set of chains,
 * and a duplicate row would let one chain be counted twice in the confirmation.
 * @param {object | null} view - `taskTreeView(...)` result.
 * @returns {object[]} `{ chainId, taskIds, roundCount, title, planNodeId, parentNodeId,
 *   selectable, blockers, reason, nodeId }` entries.
 */
export function cleanupCandidates(view) {
  const out = [];
  const seen = new Set();
  const walk = (node) => {
    for (const chain of chainsOf(node)) {
      const identity = selectableChain(chain);
      if (identity === null || seen.has(identity.chainId)) continue;
      seen.add(identity.chainId);
      const blockers = Array.isArray(chain.cleanup?.blockers)
        ? chain.cleanup.blockers.filter((code) => typeof code === 'string' && code !== '')
        : [];
      const eligible = chain.cleanup?.eligible === true;
      const selectable = eligible && blockers.length === 0;
      out.push({
        chainId: identity.chainId,
        taskIds: identity.taskIds,
        roundCount: Number.isFinite(chain.roundCount) ? chain.roundCount : identity.taskIds.length,
        title: typeof chain.displayTitle === 'string' && chain.displayTitle !== ''
          ? chain.displayTitle
          : (typeof chain.title === 'string' && chain.title !== '' ? chain.title : '未记录标题'),
        planNodeId: typeof chain.planNodeId === 'string' ? chain.planNodeId : null,
        parentNodeId: typeof chain.parentNodeId === 'string' ? chain.parentNodeId : null,
        nodeId: typeof node?.nodeId === 'string' ? node.nodeId : null,
        nodeKind: typeof node?.kind === 'string' ? node.kind : 'unknown',
        nodeStatus: typeof chain.nodeStatus === 'string'
          ? chain.nodeStatus
          : (typeof node?.nodeStatus === 'string' ? node.nodeStatus : null),
        isolation: typeof chain.isolation === 'string'
          ? chain.isolation
          : (Array.isArray(chain.rounds) && typeof chain.rounds[0]?.isolation === 'string' ? chain.rounds[0].isolation : null),
        selectable,
        blockers,
        reason: selectable
          ? null
          : (blockers.length > 0
            ? blockers.map(cleanupBlockerLabel).join('；')
            : cleanupBlockerLabel('unknown')),
      });
    }
    for (const child of Array.isArray(node?.children) ? node.children : []) walk(child);
  };
  for (const root of Array.isArray(view?.roots) ? view.roots : []) walk(root);
  return out;
}

/**
 * The cleanup state of one candidate after a refresh.
 *
 * `selection-stale` is the one blocker this module adds: the operator selected a
 * chain, a background refresh replaced the tree, and the chain's rounds are no
 * longer exactly what was selected. Sending it anyway would delete a round the
 * operator never saw, so it is made unselectable instead.
 * @param {object} candidate - entry from {@link cleanupCandidates}.
 * @param {string[]} selectedTaskIds - the ids that were selected for this chain.
 * @returns {object} the candidate, possibly with an added `selection-stale` blocker.
 */
export function withSelectionState(candidate, selectedTaskIds) {
  if (!Array.isArray(selectedTaskIds) || !candidate.selectable) return candidate;
  const same = selectedTaskIds.length === candidate.taskIds.length
    && selectedTaskIds.every((id, index) => id === candidate.taskIds[index]);
  if (same) return candidate;
  const blockers = [...candidate.blockers, 'selection-stale'];
  return {
    ...candidate,
    selectable: false,
    blockers,
    reason: blockers.map(cleanupBlockerLabel).join('；'),
  };
}

/**
 * Drop selections that no longer name a selectable chain of the current tree.
 *
 * Kept as a pure function so the page can run it on every render: a selection is
 * `{ [chainId]: taskIds }`, and anything this returns is safe to send.
 * @param {object} selection - chain id -> selected task ids.
 * @param {object[]} candidates - current candidates.
 * @returns {{ selection: object, dropped: string[] }} the surviving selection and the ids dropped.
 */
export function pruneCleanupSelection(selection, candidates) {
  const byId = new Map(candidates.map((candidate) => [candidate.chainId, candidate]));
  const next = {};
  const dropped = [];
  for (const [chainId, ids] of Object.entries(selection ?? {})) {
    const candidate = byId.get(chainId);
    if (candidate === undefined || !candidate.selectable) {
      dropped.push(chainId);
      continue;
    }
    const checked = withSelectionState(candidate, ids);
    if (!checked.selectable) {
      dropped.push(chainId);
      continue;
    }
    next[chainId] = candidate.taskIds.slice();
  }
  return { selection: next, dropped };
}

/**
 * Toggle one chain in a selection.
 * @param {object} selection - chain id -> selected task ids.
 * @param {object} candidate - the chain to toggle.
 * @returns {object} the new selection (a new object; the input is not mutated).
 */
export function toggleCleanupSelection(selection, candidate) {
  const next = { ...(selection ?? {}) };
  if (candidate === null || typeof candidate !== 'object' || candidate.selectable !== true) return next;
  if (Array.isArray(next[candidate.chainId])) delete next[candidate.chainId];
  else next[candidate.chainId] = candidate.taskIds.slice();
  return next;
}

/**
 * Which status group one preset shortcut selects.
 *
 * `all` takes every selectable chain of the current view, `accepted` only the chains
 * the host marked `accepted`, and `failed-cancelled` the chains that ended badly:
 * `failed`, `cancelled`, and `interrupted` (a chain a host restart left in a terminal
 * state no round can resume).
 */
export const CLEANUP_PRESETS = Object.freeze(['all', 'accepted', 'failed-cancelled']);

/**
 * Batch-select up to {@link MAX_CLEANUP_CHAINS} selectable candidates matching a preset,
 * optionally restricted to the chains currently visible under the active UI filters.
 * @param {object[]} candidates - entries from {@link cleanupCandidates}.
 * @param {'all'|'accepted'|'failed-cancelled'} [preset] - which status group to select.
 * @param {Set<string>|string[]|null} [visibleChainIds] - optional visible chain id filter.
 * @returns {object} `{ [chainId]: taskIds }` selection map.
 */
export function selectCleanupCandidatesByPreset(candidates, preset = 'all', visibleChainIds = null) {
  const visibleSet = visibleChainIds instanceof Set
    ? visibleChainIds
    : (Array.isArray(visibleChainIds) ? new Set(visibleChainIds) : null);
  const next = {};
  let count = 0;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (count >= MAX_CLEANUP_CHAINS) break;
    if (candidate === null || typeof candidate !== 'object' || candidate.selectable !== true) continue;
    if (visibleSet !== null && !visibleSet.has(candidate.chainId)) continue;
    if (preset === 'accepted' && candidate.nodeStatus !== 'accepted') continue;
    if (
      preset === 'failed-cancelled'
      && candidate.nodeStatus !== 'failed'
      && candidate.nodeStatus !== 'cancelled'
      && candidate.nodeStatus !== 'interrupted'
    ) {
      continue;
    }
    next[candidate.chainId] = candidate.taskIds.slice();
    count += 1;
  }
  return next;
}

/**
 * What the confirmation says BEFORE anything is sent.
 *
 * The numbers are computed from the selection and the current tree, so the text can
 * never claim more (or fewer) chains and rounds than the request will name.
 * @param {object} selection - chain id -> selected task ids.
 * @param {object[]} candidates - current candidates.
 * @returns {{ chains: number, rounds: number, empty: boolean, executable: boolean, problems: string[] }} summary.
 */
export function cleanupSelectionSummary(selection, candidates) {
  const byId = new Map(candidates.map((candidate) => [candidate.chainId, candidate]));
  let chains = 0;
  let rounds = 0;
  const problems = [];
  for (const [chainId, ids] of Object.entries(selection ?? {})) {
    const candidate = byId.get(chainId);
    if (candidate === undefined) {
      problems.push('所选执行链已不在当前任务树中，请重新选择');
      continue;
    }
    if (!candidate.selectable || !withSelectionState(candidate, ids).selectable) {
      problems.push(`执行链「${candidate.title}」已不能清理：${candidate.reason ?? cleanupBlockerLabel('unknown')}`);
      continue;
    }
    chains += 1;
    rounds += candidate.taskIds.length;
  }
  if (chains > MAX_CLEANUP_CHAINS) {
    problems.push(`一次最多清理 ${MAX_CLEANUP_CHAINS} 条执行链，请分批处理`);
  }
  if (chains === 0 && problems.length === 0) problems.push('请先勾选要清理的执行链');
  return { chains, rounds, empty: chains === 0, executable: problems.length === 0, problems };
}

/**
 * Project a selection onto the exact request body the host accepts.
 *
 * One entry per selected chain: its id and that chain's exact task ids, in tree
 * order. Anything that is not a selectable chain of the CURRENT tree is refused
 * here instead of being sent and refused by the host.
 * @param {object} selection - chain id -> selected task ids.
 * @param {object[]} candidates - current candidates.
 * @returns {{ body: { chains: Array<{ chainId: string, taskIds: string[] }> }, problems: string[] }} request.
 */
export function cleanupRequest(selection, candidates, options = {}) {
  const byId = new Map(candidates.map((candidate) => [candidate.chainId, candidate]));
  const summary = cleanupSelectionSummary(selection, candidates);
  if (!summary.executable) return { body: { chains: [] }, problems: summary.problems };
  const chains = [];
  for (const [chainId] of Object.entries(selection)) {
    const candidate = byId.get(chainId);
    chains.push({ chainId: candidate.chainId, taskIds: candidate.taskIds.slice() });
  }
  const body = { chains };
  if (options?.archiveSessions === true) body.archiveSessions = true;
  if (options?.removeWorktrees === true) body.removeWorktrees = true;
  if (options?.cleanPlans === true) body.cleanPlans = true;
  return { body, problems: [] };
}

/**
 * Stable key so a selection survives a refresh: `chainId` -> the ids selected.
 * @param {object[]} candidates - current candidates.
 * @param {object} selection - chain id -> selected task ids.
 * @returns {string} a comparable fingerprint of the selection.
 */
export function cleanupSelectionKey(candidates, selection) {
  const parts = [];
  for (const candidate of candidates) {
    if (Array.isArray(selection?.[candidate.chainId])) parts.push(`${candidate.chainId}:${candidate.taskIds.join(',')}`);
  }
  return parts.join('|');
}

/**
 * The task ids a completed deletion removed, as the host reported them.
 *
 * Read defensively: a host that answers `deleted: []` removed nothing and must not
 * be shown as a success, so the caller decides from `chains`/`tasks` counts.
 * @param {object | null} outcome - `{ chains, tasks, deletedTaskIds }`.
 * @returns {{ chains: number, rounds: number, deletedTaskIds: string[] }} normalized counts.
 */
export function cleanupOutcome(outcome) {
  const deleted = Array.isArray(outcome?.deletedTaskIds)
    ? outcome.deletedTaskIds.filter((id) => typeof id === 'string' && id !== '')
    : [];
  const chains = Number.isFinite(outcome?.chains) ? outcome.chains : 0;
  return { chains, rounds: deleted.length, deletedTaskIds: deleted };
}

/**
 * Plain-Chinese description of one completed cleanup.
 * @param {object | null} outcome - the host's success body.
 * @returns {string} one sentence; empty when nothing was removed.
 */
export function describeCleanupOutcome(outcome) {
  const summary = cleanupOutcome(outcome);
  if (summary.chains === 0 && summary.rounds === 0) return '';
  const cleaned = outcome?.cleaned ?? null;
  const retained = outcome?.retained ?? null;
  const hasLinkedOption = cleaned !== null
    || (retained !== null && (
      retained.sessions === false
      || retained.worktrees === false
      || retained.workspaces === false
      || retained.plans === false
    ));
  if (!hasLinkedOption) {
    return `已永久删除 ${summary.chains} 条执行链、共 ${summary.rounds} 轮的任务记录与审查意见；`
      + 'DSH 会话、工作区与源文件均未删除。';
  }
  const archivedCount = Array.isArray(cleaned?.archivedSessionIds) ? cleaned.archivedSessionIds.length : 0;
  const worktreeCount = Array.isArray(cleaned?.removedWorktreePaths) ? cleaned.removedWorktreePaths.length : 0;
  const workspaceCount = Array.isArray(cleaned?.removedWorkspaceIds) ? cleaned.removedWorkspaceIds.length : 0;
  const planCount = Array.isArray(cleaned?.removedPlanNodeIds) ? cleaned.removedPlanNodeIds.length : 0;
  const extras = [];
  if (archivedCount > 0) extras.push(`归档 ${archivedCount} 个派工对话`);
  if (worktreeCount > 0) extras.push(`清理 ${worktreeCount} 个隔离工作树`);
  if (workspaceCount > 0) extras.push(`移除 ${workspaceCount} 个临时工作区`);
  if (planCount > 0) extras.push(`清理 ${planCount} 个空规划节点`);
  const linkedClause = extras.length > 0
    ? `同步${extras.join('、')}；`
    : '无额外需归档的派工对话或隔离工作树；';
  return `已永久删除 ${summary.chains} 条执行链、共 ${summary.rounds} 轮的任务记录与审查意见；`
    + `${linkedClause}主项目源文件与共享工作区均未删除。`;
}

/**
 * Plain-Chinese description of one completed orphan worktree/session sweep.
 * @param {object | null} outcome - the host's orphan cleanup body.
 * @returns {string} summary sentence.
 */
export function describeOrphanCleanupOutcome(outcome) {
  if (outcome === null || typeof outcome !== 'object') return '';
  const cleaned = outcome.cleaned ?? {};
  const archivedCount = Array.isArray(cleaned.archivedSessionIds) ? cleaned.archivedSessionIds.length : 0;
  const worktreeCount = Array.isArray(cleaned.removedWorktreePaths) ? cleaned.removedWorktreePaths.length : 0;
  const workspaceCount = Array.isArray(cleaned.removedWorkspaceIds) ? cleaned.removedWorkspaceIds.length : 0;
  const forgottenCount = Number.isFinite(outcome.orphanSessionsForgotten) ? outcome.orphanSessionsForgotten : 0;
  if (archivedCount === 0 && worktreeCount === 0 && workspaceCount === 0 && forgottenCount === 0) {
    return '未发现残留的隔离工作树或已删记录的派工对话；主项目源文件与共享工作区均未改动。';
  }
  const parts = [];
  if (archivedCount > 0) parts.push(`归档 ${archivedCount} 个已删记录的派工对话`);
  else if (forgottenCount > 0) parts.push(`清理 ${forgottenCount} 条残留会话映射`);
  if (worktreeCount > 0) parts.push(`清理 ${worktreeCount} 个残留隔离工作树`);
  if (workspaceCount > 0) parts.push(`移除 ${workspaceCount} 个临时工作区`);
  return `已完成残留清理：${parts.join('、')}；主项目源文件与共享工作区均未删除。`;
}

/**
 * Build the confirmation dialog text before deletion is executed.
 * @param {{ chains: number, rounds: number }} summary - selection counts.
 * @param {{ archiveSessions?: boolean, removeWorktrees?: boolean, cleanPlans?: boolean }} [options] - linked cleanup choices.
 * @returns {string} confirmation sentence.
 */
export function cleanupConfirmText(summary, options = {}) {
  const archiveSessions = options?.archiveSessions === true;
  const removeWorktrees = options?.removeWorktrees === true;
  const cleanPlans = options?.cleanPlans === true;
  if (!archiveSessions && !removeWorktrees && !cleanPlans) {
    return `确认永久删除 ${summary.chains} 条执行链、共 ${summary.rounds} 轮的任务记录及审查意见？删除后无法按任务编号查询或续接。DSH 会话、工作区与源文件不会被删除。`;
  }
  const linked = [];
  if (archiveSessions) linked.push('归档对应的 DSH 派工对话（不影响你自己的普通对话）');
  if (removeWorktrees) linked.push('删除隔离任务的工作树目录与临时工作区（共享工作区绝不删除）');
  if (cleanPlans) linked.push('清理已无关联任务的空规划节点');
  return `确认永久删除 ${summary.chains} 条执行链、共 ${summary.rounds} 轮的任务记录及审查意见，并同时${linked.join('、')}？删除后无法按任务编号查询或续接；主项目源文件与共享工作区不会被删除。`;
}

/**
 * The standing warning shown next to the confirm button.
 * @returns {string} Chinese text.
 */
export function cleanupWarningText() {
  return '删除任务记录后不可恢复，也无法按这些任务编号查询或续接。';
}

/**
 * A detached copy of the projection, for one caller that must not see bindings change.
 * @returns {object} the projection functions plus the bound.
 */
export function cleanupProjection() {
  return {
    candidates: cleanupCandidates,
    request: cleanupRequest,
    outcome: cleanupOutcome,
    describe: describeCleanupOutcome,
    describeOrphans: describeOrphanCleanupOutcome,
    confirmText: cleanupConfirmText,
    selectByPreset: selectCleanupCandidatesByPreset,
    selectionSummary: cleanupSelectionSummary,
    prune: pruneCleanupSelection,
    toggle: toggleCleanupSelection,
    blockerLabel: cleanupBlockerLabel,
    warning: cleanupWarningText,
    MAX_CHAINS: MAX_CLEANUP_CHAINS,
    PRESETS: CLEANUP_PRESETS,
  };
}
