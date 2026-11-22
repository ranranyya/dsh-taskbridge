// Task-record cleanup: the browser half's projection, asserted on its own.
//
// These are pure functions over the host's projection (`src/client/task-cleanup.js`),
// so they run without jsdom and without React. The DOM behaviour they feed (checkbox
// mode, the selection counter, the confirmation and cancel) is asserted separately in
// `tests/tree-ui-dom.test.js` against the real built page.
//
// What matters here, and why each assertion exists:
//
//   1. A selectable unit is ONE execution chain, identified by the host — including a
//      chain attached to a planning node — and it carries that chain's EXACT rounds.
//   2. Eligibility is the host's own `cleanup` block. An ineligible chain is listed
//      with its reason and can never enter a selection.
//   3. A refresh that changes a chain's rounds invalidates the tick (it becomes
//      `selection-stale` and is pruned), so a stale page cannot delete an unseen round.
//   4. The confirmation counts chains and rounds from the selection, and the request
//      body carries nothing but `{ chainId, taskIds }` pairs;
//   5. the status shortcuts only ever tick selectable chains, and the linked-cleanup
//      flags reach the request body only when they were ticked.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLEANUP_PRESETS,
  MAX_CLEANUP_CHAINS,
  cleanupBlockerLabel,
  cleanupCandidates,
  cleanupConfirmText,
  cleanupOutcome,
  cleanupRequest,
  cleanupSelectionKey,
  cleanupSelectionSummary,
  cleanupWarningText,
  describeCleanupOutcome,
  describeOrphanCleanupOutcome,
  pruneCleanupSelection,
  selectCleanupCandidatesByPreset,
  toggleCleanupSelection,
  withSelectionState,
} from '../src/client/task-cleanup.js';
import { taskTreeView } from '../src/client/api.js';
import { tasksBody, tasksBodyFlatTree, tasksBodyWithoutTree } from './helpers/tree-fixtures.js';

/** The rendered view the page would hold for the standard fixture. */
const VIEW = taskTreeView(tasksBody());

/** All candidates, by chain id. */
function byChainId(view = VIEW) {
  return new Map(cleanupCandidates(view).map((entry) => [entry.chainId, entry]));
}

test('cleanup candidates are the host tree\'s own chains, including those under a planning node', () => {
  const candidates = cleanupCandidates(VIEW);
  const ids = candidates.map((entry) => entry.chainId);
  // Every chain of the fixture appears exactly once, in tree order.
  assert.deepEqual(ids, ['task-debounce', 'task-ui-1', 'task-ui-twin', 'task-legacy', 'task-missing-plan']);
  assert.equal(new Set(ids).size, ids.length, 'no chain is listed twice');

  // A chain attached to a planning node keeps that plan identity and its own rounds.
  const ui = byChainId().get('task-ui-1');
  assert.deepEqual(ui.taskIds, ['task-ui-1', 'task-ui-2', 'task-ui-3']);
  assert.equal(ui.roundCount, 3);
  assert.equal(ui.planNodeId, 'plan-ui');
  assert.equal(ui.nodeKind, 'plan');
  // A standalone chain has no planning identity at all.
  const legacy = byChainId().get('task-legacy');
  assert.deepEqual(legacy.taskIds, ['task-legacy']);
  assert.equal(legacy.planNodeId, null);

  // A host that answers no tree, or a flat one, offers no chain to remove.
  assert.deepEqual(cleanupCandidates(null), []);
  assert.deepEqual(cleanupCandidates(taskTreeView(tasksBodyWithoutTree())), []);
  assert.deepEqual(cleanupCandidates(taskTreeView(tasksBodyFlatTree())), []);
});

test('eligibility is the host\'s cleanup block, and an ineligible chain states why', () => {
  const map = byChainId();
  assert.equal(map.get('task-legacy').selectable, true);
  assert.equal(map.get('task-legacy').reason, null);

  const twin = map.get('task-ui-twin');
  assert.equal(twin.selectable, false);
  assert.ok(twin.blockers.includes('CLEANUP_CHAIN_LIVE'));
  assert.match(twin.reason, /仍在执行/u);

  const ui = map.get('task-ui-1');
  assert.equal(ui.selectable, true, 'all three related rounds can be removed together');
  assert.deepEqual(ui.blockers, []);

  // A chain with no cleanup block at all (a host that predates the feature) is not
  // selectable — the page must not offer a checkbox the host would refuse.
  const noFacts = { roots: [{ nodeId: 'x', kind: 'task', chain: { chainId: 'c1', taskIds: ['t1'], rounds: [] } }], projects: [] };
  const candidates = cleanupCandidates(noFacts);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].selectable, false);
  assert.equal(candidates[0].reason, cleanupBlockerLabel('unknown'));
});

test('a selection only ever holds selectable chains and their exact rounds', () => {
  const map = byChainId();
  let selection = {};
  selection = toggleCleanupSelection(selection, map.get('task-ui-twin'));
  assert.deepEqual(selection, {}, 'an ineligible chain cannot be ticked');
  selection = toggleCleanupSelection(selection, map.get('task-legacy'));
  assert.deepEqual(selection, { 'task-legacy': ['task-legacy'] });
  selection = toggleCleanupSelection(selection, map.get('task-legacy'));
  assert.deepEqual(selection, {}, 'a second tick clears it');
  // The input is never mutated.
  const original = { 'task-ui-1': ['task-ui-1', 'task-ui-2', 'task-ui-3'] };
  const next = toggleCleanupSelection(original, map.get('task-legacy'));
  assert.deepEqual(original, { 'task-ui-1': ['task-ui-1', 'task-ui-2', 'task-ui-3'] });
  assert.deepEqual(next, { 'task-ui-1': ['task-ui-1', 'task-ui-2', 'task-ui-3'], 'task-legacy': ['task-legacy'] });
});

test('a changed chain becomes stale: the tick is dropped and the request is refused', () => {
  const map = byChainId();
  const candidate = map.get('task-ui-1');
  const asSelectable = { ...candidate, selectable: true, blockers: [], reason: null };
  // Same rounds: the tick stands.
  assert.equal(withSelectionState(asSelectable, ['task-ui-1', 'task-ui-2', 'task-ui-3']).selectable, true);
  // A new round appeared: the tick would delete a round the operator never saw.
  const grown = { ...asSelectable, taskIds: ['task-ui-1', 'task-ui-2', 'task-ui-3', 'task-ui-4'] };
  const stale = withSelectionState(grown, ['task-ui-1', 'task-ui-2', 'task-ui-3']);
  assert.equal(stale.selectable, false);
  assert.ok(stale.blockers.includes('selection-stale'));
  assert.match(stale.reason, /重新选择/u);

  const pruned = pruneCleanupSelection(
    { 'task-ui-1': ['task-ui-1', 'task-ui-2', 'task-ui-3'], 'task-legacy': ['task-legacy'], gone: ['gone'] },
    [...map.values(), grown],
  );
  assert.deepEqual(pruned.selection, { 'task-legacy': ['task-legacy'] });
  assert.deepEqual(pruned.dropped.sort(), ['gone', 'task-ui-1']);
});

test('the confirmation counts chains and rounds, and refuses an empty or oversized batch', () => {
  const candidates = [
    { chainId: 'a', taskIds: ['a1', 'a2'], selectable: true, blockers: [], reason: null },
    { chainId: 'b', taskIds: ['b1'], selectable: true, blockers: [], reason: null },
    { chainId: 'c', taskIds: ['c1'], selectable: false, blockers: ['CLEANUP_CHAIN_LIVE'], reason: '仍在执行或排队，不能清理' },
  ];
  const summary = cleanupSelectionSummary({ a: ['a1', 'a2'], b: ['b1'] }, candidates);
  assert.equal(summary.chains, 2);
  assert.equal(summary.rounds, 3);
  assert.equal(summary.executable, true);
  assert.deepEqual(summary.problems, []);

  const empty = cleanupSelectionSummary({}, candidates);
  assert.equal(empty.chains, 0);
  assert.equal(empty.empty, true);
  assert.equal(empty.executable, false);
  assert.ok(empty.problems.length > 0);

  // A selection that includes a chain the current tree says is ineligible cannot be
  // sent, even if the page somehow still holds it.
  const blocked = cleanupSelectionSummary({ a: ['a1', 'a2'], c: ['c1'] }, candidates);
  assert.equal(blocked.chains, 1);
  assert.equal(blocked.executable, false);
  assert.match(blocked.problems[0], /仍在执行/u);

  // The bound is mirrored, and an oversized selection is refused rather than trimmed.
  const many = Array.from({ length: MAX_CLEANUP_CHAINS + 1 }, (_, index) => ({
    chainId: `c${index}`, taskIds: [`t${index}`], selectable: true, blockers: [], reason: null,
  }));
  const wide = cleanupSelectionSummary(Object.fromEntries(many.map((entry) => [entry.chainId, entry.taskIds])), many);
  assert.equal(wide.executable, false);
  assert.equal(wide.chains, MAX_CLEANUP_CHAINS + 1);
});

test('the request body is exactly the selected chains and their exact rounds', () => {
  const candidates = cleanupCandidates(VIEW);
  const selection = { 'task-legacy': ['task-legacy'], 'task-missing-plan': ['task-missing-plan'] };
  const { body, problems } = cleanupRequest(selection, candidates);
  assert.deepEqual(problems, []);
  assert.deepEqual(body, {
    chains: [
      { chainId: 'task-legacy', taskIds: ['task-legacy'] },
      { chainId: 'task-missing-plan', taskIds: ['task-missing-plan'] },
    ],
  });
  // No time window, no path, no "all" flag: the body has one key.
  assert.deepEqual(Object.keys(body), ['chains']);
  for (const chain of body.chains) assert.deepEqual(Object.keys(chain).sort(), ['chainId', 'taskIds']);

  // An empty or stale selection produces no request at all.
  assert.deepEqual(cleanupRequest({}, candidates).body, { chains: [] });
  assert.equal(cleanupRequest({ 'task-ui-twin': ['task-ui-twin'] }, candidates).problems.length, 1);
});

test('an outcome is described only from what the host reported', () => {
  assert.equal(describeCleanupOutcome({ ok: true, chains: 0, deletedTaskIds: [] }), '');
  assert.equal(describeCleanupOutcome(null), '');
  const text = describeCleanupOutcome({ chains: 2, tasks: 3, deletedTaskIds: ['a', 'b', 'c'] });
  assert.match(text, /2 条执行链/u);
  assert.match(text, /3 轮/u);
  assert.match(text, /会话、工作区与源文件均未删除/u);
  assert.deepEqual(cleanupOutcome({ chains: 2, deletedTaskIds: ['a', null, 'b'] }), {
    chains: 2, rounds: 2, deletedTaskIds: ['a', 'b'],
  });
  assert.match(cleanupWarningText(), /不可恢复/u);
  assert.match(cleanupWarningText(), /无法按这些任务编号查询或续接/u);
});

test('a selection fingerprint survives a refresh and changes when the selection does', () => {
  const candidates = cleanupCandidates(VIEW);
  const one = { 'task-legacy': ['task-legacy'] };
  assert.equal(cleanupSelectionKey(candidates, one), 'task-legacy:task-legacy');
  assert.notEqual(cleanupSelectionKey(candidates, one), cleanupSelectionKey(candidates, {}));
  assert.equal(cleanupSelectionKey(candidates, {}), '');
});

test('every blocker code has a plain-Chinese label', () => {
  for (const code of [
    'CLEANUP_CHAIN_LIVE', 'CLEANUP_NOT_DURABLE', 'CLEANUP_NEXT_ROUND', 'CLEANUP_REVIEW_WRITE',
    'CLEANUP_PLAN_CHILDREN', 'CLEANUP_HIERARCHY_CHILDREN', 'CLEANUP_UNAVAILABLE', 'CLEANUP_STALE',
  ]) {
    const label = cleanupBlockerLabel(code);
    assert.notEqual(label, code, `${code} needs its own word`);
    assert.match(label, /[\u4e00-\u9fa5]/u);
  }
});

// ---------------------------------------------------------------------------
// Linked cleanup: preset shortcuts, the request's flags and the two summaries
// ---------------------------------------------------------------------------
//
// These are the browser half of an irreversible action, so each assertion is about a
// NARROWING: a preset only ever ticks selectable chains, the flags are only ever sent
// when the operator ticked them, and every sentence states what the host reported
// rather than what the page hoped.

/** A candidate with the fields the cleanup bar reads, and nothing else. */
function candidate(chainId, overrides = {}) {
  return {
    chainId,
    taskIds: [chainId],
    roundCount: 1,
    title: `标题 ${chainId}`,
    planNodeId: null,
    parentNodeId: null,
    nodeId: chainId,
    nodeKind: 'task',
    nodeStatus: 'awaiting-host-review',
    isolation: 'worktree',
    selectable: true,
    blockers: [],
    reason: null,
    ...overrides,
  };
}

/** The standard candidate set: one of each status, plus one ineligible chain. */
function presetCandidates() {
  return [
    candidate('c-accepted', { nodeStatus: 'accepted' }),
    candidate('c-failed', { nodeStatus: 'failed' }),
    candidate('c-cancelled', { nodeStatus: 'cancelled' }),
    candidate('c-interrupted', { nodeStatus: 'interrupted' }),
    candidate('c-waiting', { nodeStatus: 'awaiting-host-review' }),
    candidate('c-live', {
      nodeStatus: 'running',
      selectable: false,
      blockers: ['CLEANUP_CHAIN_LIVE'],
      reason: '仍在执行或未正常结束，不能清理',
    }),
  ];
}

test('a preset ticks only selectable chains of its own status group', () => {
  assert.deepEqual([...CLEANUP_PRESETS], ['all', 'accepted', 'failed-cancelled']);
  const candidates = presetCandidates();

  // `all` is every chain the host says may be removed — the ineligible one is skipped,
  // because a selection only ever holds chains the host would accept.
  const all = selectCleanupCandidatesByPreset(candidates, 'all');
  assert.deepEqual(Object.keys(all).sort(), ['c-accepted', 'c-cancelled', 'c-failed', 'c-interrupted', 'c-waiting']);
  assert.deepEqual(all['c-accepted'], ['c-accepted'], 'a selection carries the chain\'s exact rounds');

  // `accepted` is the host's own status, never a guess from a title.
  assert.deepEqual(Object.keys(selectCleanupCandidatesByPreset(candidates, 'accepted')), ['c-accepted']);
  // `failed-cancelled` takes every chain that ended badly: both terminal failures and
  // a chain a host restart left `interrupted` (terminal and unresumable), but never
  // `accepted` and never a chain the host says is not removable.
  assert.deepEqual(
    Object.keys(selectCleanupCandidatesByPreset(candidates, 'failed-cancelled')).sort(),
    ['c-cancelled', 'c-failed', 'c-interrupted'],
  );
  // The default preset is `all`, so an omitted argument never means "nothing".
  assert.deepEqual(selectCleanupCandidatesByPreset(candidates), all);

  // A chain with no status at all belongs to no status group, but `all` still takes it.
  const noStatus = [candidate('c-unknown', { nodeStatus: null })];
  assert.deepEqual(Object.keys(selectCleanupCandidatesByPreset(noStatus, 'accepted')), []);
  assert.deepEqual(Object.keys(selectCleanupCandidatesByPreset(noStatus, 'failed-cancelled')), []);
  assert.deepEqual(Object.keys(selectCleanupCandidatesByPreset(noStatus, 'all')), ['c-unknown']);

  // An empty tree, or no tree at all, selects nothing rather than throwing.
  assert.deepEqual(selectCleanupCandidatesByPreset([], 'all'), {});
  assert.deepEqual(selectCleanupCandidatesByPreset(null, 'all'), {});
});

test('a preset respects what the page currently shows', () => {
  const candidates = presetCandidates();
  // A filter that leaves two chains visible: the shortcut only reaches those two.
  assert.deepEqual(
    Object.keys(selectCleanupCandidatesByPreset(candidates, 'all', ['c-accepted', 'c-live'])).sort(),
    ['c-accepted'],
    'a visible but ineligible chain is still not selected',
  );
  assert.deepEqual(
    Object.keys(selectCleanupCandidatesByPreset(candidates, 'all', new Set(['c-failed', 'c-waiting']))).sort(),
    ['c-failed', 'c-waiting'],
  );
  // An empty visible set is a real restriction, not "no filter".
  assert.deepEqual(selectCleanupCandidatesByPreset(candidates, 'all', []), {});
  // `null` means "no visibility restriction".
  assert.deepEqual(
    Object.keys(selectCleanupCandidatesByPreset(candidates, 'all', null)).sort(),
    ['c-accepted', 'c-cancelled', 'c-failed', 'c-interrupted', 'c-waiting'],
  );
  // An interrupted chain stays subject to the same visibility filter.
  assert.deepEqual(
    Object.keys(selectCleanupCandidatesByPreset(candidates, 'failed-cancelled', ['c-interrupted', 'c-accepted'])),
    ['c-interrupted'],
  );
  // The bound is the same one the request enforces.
  const many = Array.from({ length: MAX_CLEANUP_CHAINS + 5 }, (_, index) => candidate(`c${index}`));
  assert.equal(Object.keys(selectCleanupCandidatesByPreset(many, 'all')).length, MAX_CLEANUP_CHAINS);
});

test('the request carries a linked flag only when the operator ticked it', () => {
  const candidates = presetCandidates();
  const selection = { 'c-accepted': ['c-accepted'] };

  // Nothing ticked: the body is exactly the chains, as before the flags existed.
  const bare = cleanupRequest(selection, candidates, {});
  assert.deepEqual(bare.body, { chains: [{ chainId: 'c-accepted', taskIds: ['c-accepted'] }] });
  assert.deepEqual(Object.keys(bare.body), ['chains']);
  assert.deepEqual(cleanupRequest(selection, candidates).body, bare.body, 'an omitted options object sends no flag');

  // Each flag alone, then all three.
  assert.deepEqual(cleanupRequest(selection, candidates, { archiveSessions: true }).body.archiveSessions, true);
  assert.equal('removeWorktrees' in cleanupRequest(selection, candidates, { archiveSessions: true }).body, false);
  assert.equal(cleanupRequest(selection, candidates, { removeWorktrees: true }).body.removeWorktrees, true);
  assert.equal(cleanupRequest(selection, candidates, { cleanPlans: true }).body.cleanPlans, true);
  const all = cleanupRequest(selection, candidates, { archiveSessions: true, removeWorktrees: true, cleanPlans: true }).body;
  assert.deepEqual(all, {
    chains: [{ chainId: 'c-accepted', taskIds: ['c-accepted'] }],
    archiveSessions: true,
    removeWorktrees: true,
    cleanPlans: true,
  });

  // A non-boolean is not a flag: the body stays closed rather than serializing junk.
  const junk = cleanupRequest(selection, candidates, { archiveSessions: 'yes', removeWorktrees: 1, cleanPlans: null }).body;
  assert.deepEqual(junk, { chains: [{ chainId: 'c-accepted', taskIds: ['c-accepted'] }] });

  // A selection the host would refuse still produces no body at all, flags or not.
  const refused = cleanupRequest({}, candidates, { archiveSessions: true });
  assert.deepEqual(refused.body, { chains: [] });
  assert.ok(refused.problems.length > 0);
});

test('the confirmation restates the ticked linked choices before anything is sent', () => {
  const summary = { chains: 2, rounds: 5 };

  // Nothing ticked: the original sentence, and a promise nothing else is touched.
  const plain = cleanupConfirmText(summary, {});
  assert.match(plain, /确认永久删除 2 条执行链、共 5 轮/u);
  assert.match(plain, /DSH 会话、工作区与源文件不会被删除/u);
  assert.equal(cleanupConfirmText(summary), plain, 'an omitted options object matches an empty one');
  assert.doesNotMatch(plain, /同时/u);

  // One flag: only that consequence is named.
  const archived = cleanupConfirmText(summary, { archiveSessions: true });
  assert.match(archived, /同时归档对应的 DSH 派工对话/u);
  assert.doesNotMatch(archived, /隔离任务的工作树/u);
  assert.doesNotMatch(archived, /空规划节点/u);

  // All flags: the worktree sentence keeps the "shared is never deleted" promise.
  const all = cleanupConfirmText(summary, { archiveSessions: true, removeWorktrees: true, cleanPlans: true });
  assert.match(all, /归档对应的 DSH 派工对话/u);
  assert.match(all, /删除隔离任务的工作树目录与临时工作区/u);
  assert.match(all, /共享工作区绝不删除/u);
  assert.match(all, /清理已无关联任务的空规划节点/u);
  assert.match(all, /主项目源文件与共享工作区不会被删除/u);
  // Every variant still counts the batch the same way.
  for (const text of [plain, archived, all]) assert.match(text, /2 条执行链、共 5 轮/u);
});

test('a completed batch is described from the host\'s own report, including what was cleaned', () => {
  // The pre-flag answer: only record deletion is claimed.
  const plain = describeCleanupOutcome({ chains: 1, deletedTaskIds: ['a'] });
  assert.match(plain, /1 条执行链/u);
  assert.match(plain, /会话、工作区与源文件均未删除/u);
  assert.doesNotMatch(plain, /同步/u);

  // A linked batch reports each kind of extra work only when it actually happened.
  const cleaned = describeCleanupOutcome({
    chains: 2,
    deletedTaskIds: ['a', 'b', 'c'],
    retained: { sessions: false, workspaces: false, worktrees: false, sourceFiles: true, plans: false },
    cleaned: {
      archivedSessionIds: ['s1', 's2'],
      removedWorktreePaths: ['C:\\wt\\a'],
      removedWorkspaceIds: ['w1'],
      removedPlanNodeIds: ['plan-1', 'plan-2'],
    },
  });
  assert.match(cleaned, /已永久删除 2 条执行链、共 3 轮/u);
  assert.match(cleaned, /同步归档 2 个派工对话/u);
  assert.match(cleaned, /清理 1 个隔离工作树/u);
  assert.match(cleaned, /移除 1 个临时工作区/u);
  assert.match(cleaned, /清理 2 个空规划节点/u);
  assert.match(cleaned, /主项目源文件与共享工作区均未删除/u);

  // A linked request that found nothing to do states that plainly, and never claims
  // the records alone were removed "with sessions untouched" (they were asked for).
  const nothing = describeCleanupOutcome({
    chains: 1,
    deletedTaskIds: ['a'],
    retained: { sessions: false, workspaces: false, worktrees: false, sourceFiles: true, plans: false },
    cleaned: { archivedSessionIds: [], removedWorktreePaths: [], removedWorkspaceIds: [], removedPlanNodeIds: [] },
  });
  assert.match(nothing, /无额外需归档的派工对话或隔离工作树/u);
  assert.match(nothing, /主项目源文件与共享工作区均未删除/u);

  // Nothing removed is never described as a success.
  assert.equal(describeCleanupOutcome({ chains: 0, deletedTaskIds: [], cleaned: { archivedSessionIds: ['s'] } }), '');
});

test('the orphan sweep is described from its counts, and an empty sweep says so', () => {
  assert.equal(describeOrphanCleanupOutcome(null), '');
  assert.equal(describeOrphanCleanupOutcome('done'), '');

  const empty = describeOrphanCleanupOutcome({
    orphanSessionsForgotten: 0,
    cleaned: { archivedSessionIds: [], removedWorktreePaths: [], removedWorkspaceIds: [] },
  });
  assert.match(empty, /未发现残留的隔离工作树或已删记录的派工对话/u);
  assert.match(empty, /主项目源文件与共享工作区均未改动/u);

  const swept = describeOrphanCleanupOutcome({
    orphanSessionsForgotten: 2,
    cleaned: {
      archivedSessionIds: ['s1', 's2'],
      removedWorktreePaths: ['C:\\wt\\orphan-1', 'C:\\wt\\orphan-2'],
      removedWorkspaceIds: ['w1'],
    },
    retained: { sourceFiles: true },
  });
  assert.match(swept, /已完成残留清理/u);
  assert.match(swept, /归档 2 个已删记录的派工对话/u);
  assert.match(swept, /清理 2 个残留隔离工作树/u);
  assert.match(swept, /移除 1 个临时工作区/u);
  assert.match(swept, /主项目源文件与共享工作区均未删除/u);

  // Trees but no conversations: the tree count is still reported.
  const treesOnly = describeOrphanCleanupOutcome({
    orphanSessionsForgotten: 0,
    cleaned: { archivedSessionIds: [], removedWorktreePaths: ['C:\\wt\\orphan-1'], removedWorkspaceIds: [] },
  });
  assert.match(treesOnly, /清理 1 个残留隔离工作树/u);
  assert.match(treesOnly, /已完成残留清理/u);
  assert.doesNotMatch(treesOnly, /未发现残留/u);
});
