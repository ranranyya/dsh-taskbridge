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
//      body carries nothing but `{ chainId, taskIds }` pairs.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CLEANUP_CHAINS,
  cleanupBlockerLabel,
  cleanupCandidates,
  cleanupOutcome,
  cleanupRequest,
  cleanupSelectionKey,
  cleanupSelectionSummary,
  cleanupWarningText,
  describeCleanupOutcome,
  pruneCleanupSelection,
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
