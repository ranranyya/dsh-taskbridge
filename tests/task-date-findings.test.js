// The three acceptance findings of the date-query follow-up, at projection level.
//
// Each case is built with the REAL `buildTaskTree`, so the fixtures carry the
// projection's own fields — including its `createdAt: 0` fallback for a task that
// never recorded a creation time. That fallback is the whole point of case 1.
//
//   1. a missing creation time is the projection's `0`, and an END-ONLY range must
//      not count it as inside the range;
//   2. a plan holding SEVERAL execution chains shows only the chains the range
//      matched — a sibling chain is never exposed — while a chain that matched keeps
//      every round, and a plan kept purely as an ancestor still shows its chains;
//   3. calendar order, not text order: `9999-12-31 → 10000-01-01` is a valid
//      forward range, and a normal four-digit year crossing works too.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calendarDay,
  compareCalendarDays,
  localCalendarDay,
  localCalendarParts,
  nodeCreatedInRange,
  normalizeDayRange,
  parseCalendarDay,
  projectTaskView,
} from '../src/client/task-view.js';
import { buildTaskTree } from '../src/jobs/task-tree.js';

const repo = process.platform === 'win32' ? 'C:\\org-one\\portal' : '/org-one/portal';
const ACCEPTED = { accepted: true, state: 'accepted', decision: 'accepted', acceptedAt: 1, by: 'commander' };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Local midnight of one `YYYY-MM-DD`, through the browser calendar. */
function dayStart(day) {
  const [year, month, date] = day.split('-').map(Number);
  const at = new Date(0);
  at.setFullYear(year, month - 1, date);
  at.setHours(0, 0, 0, 0);
  return at.getTime();
}

const viewing = (tree, extra = {}) => projectTaskView(tree, {
  projectKey: '', filter: 'all', search: '', selectedTaskId: null, ...extra,
});

const taskRow = (taskId, extra) => ({
  taskId,
  state: 'awaiting-host-review', phase: 'awaiting-host-review',
  sourcePath: repo, archived: false, live: true, ...extra,
});

const planRow = (nodeId, parentNodeId, title, sequence, createdAt) => ({
  nodeId, parentNodeId, title, sequence, sourcePath: repo, createdAt, updatedAt: createdAt,
});

/** Every task id reachable in a projection, including the rounds of each chain. */
const taskIdsOf = (result) => {
  const out = [];
  const walk = (node) => {
    for (const chain of node.kind === 'plan' ? node.executions ?? [] : node.chain ? [node.chain] : []) {
      out.push(...(chain.rounds ?? []).map((round) => round.taskId));
    }
    node.children.forEach(walk);
  };
  result.groups.forEach((group) => group.roots.forEach(walk));
  return out;
};

/** The execution chains a plan node renders, by chain id. */
const chainIdsOf = (result, nodeId) => {
  const find = (node) => {
    if (node.nodeId === nodeId) return node;
    for (const child of node.children) {
      const hit = find(child);
      if (hit !== null) return hit;
    }
    return null;
  };
  for (const group of result.groups) {
    for (const root of group.roots) {
      const node = find(root);
      if (node !== null) return (node.executions ?? []).map((chain) => chain.chainId);
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// 1. An END-ONLY range must not absorb a missing creation time
// ---------------------------------------------------------------------------

test('finding 1: the projection stores a missing createdAt as 0, and an end-only range excludes it', () => {
  const anchor = dayStart('2026-11-20');
  const tree = buildTaskTree({
    tasks: [
      taskRow('task-null-time', { title: '创建时间为 null', createdAt: null }),
      taskRow('task-missing-time', { title: '没有创建时间字段' }),
      taskRow('task-real-time', { title: '真实创建时间', createdAt: anchor + 9 * HOUR }),
      taskRow('task-older', { title: '早于范围', createdAt: anchor - 5 * DAY }),
    ],
  });
  const byId = new Map(tree.roots.map((node) => [node.nodeId, node]));
  // The documented projection contract this test reacts to: no time becomes 0.
  assert.equal(byId.get('task-null-time').createdAt, 0);
  assert.equal(byId.get('task-missing-time').createdAt, 0);
  assert.equal(localCalendarDay(0), null, 'the epoch is "no recorded time", not 1970-01-01');
  assert.equal(localCalendarParts(0), null);

  // END ONLY: an upper bound must not pull "unknown" into the result.
  const endOnly = viewing(tree, { dateRange: { from: '', to: '2026-11-20' } });
  const ids = taskIdsOf(endOnly);
  assert.ok(ids.includes('task-real-time'), 'the task really created in range is shown');
  assert.ok(ids.includes('task-older'), 'a task before the end date is shown — the end is an upper bound, not a lower one');
  assert.equal(ids.includes('task-null-time'), false, 'a null creation time is NOT inside an end-only range');
  assert.equal(ids.includes('task-missing-time'), false, 'a missing creation time is NOT inside an end-only range');

  // The same two nodes are excluded from every single-sided and closed range, and
  // a no-date view still shows everything (no regression to the unfiltered tree).
  for (const range of [{ from: '2026-11-01', to: '' }, { from: '2026-01-01', to: '2027-01-01' }, { from: '2026-11-20', to: '2026-11-20' }, { from: '', to: '' }]) {
    const result = viewing(tree, { dateRange: range });
    if (range.from === '' && range.to === '') {
      assert.ok(taskIdsOf(result).includes('task-null-time'), 'an empty range is not a date filter');
    } else {
      assert.equal(taskIdsOf(result).includes('task-null-time'), false, `null time excluded for ${JSON.stringify(range)}`);
      assert.equal(taskIdsOf(result).includes('task-missing-time'), false, `missing time excluded for ${JSON.stringify(range)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. A plan with several chains shows only the matching chain
// ---------------------------------------------------------------------------

/**
 * One plan node with TWO independent execution chains: chain A created on the
 * 18th–19th, chain B created on the 25th. Rounds are ordered by the projection.
 * @returns {object} the built tree.
 */
function twoChainTree() {
  const first = dayStart('2026-11-18');
  const second = dayStart('2026-11-25');
  return buildTaskTree({
    planNodes: [planRow('plan-shared', null, '同一计划', 1, dayStart('2026-11-17'))],
    tasks: [
      taskRow('task-a-1', { title: '甲链首轮', planNodeId: 'plan-shared', createdAt: first + 2 * HOUR }),
      taskRow('task-a-2', { title: '甲链整改', continueFromTaskId: 'task-a-1', createdAt: first + DAY + 3 * HOUR }),
      taskRow('task-b-1', { title: '乙链首轮', planNodeId: 'plan-shared', createdAt: second + 2 * HOUR, hostAcceptance: ACCEPTED, state: 'accepted' }),
      taskRow('task-b-2', { title: '乙链整改', continueFromTaskId: 'task-b-1', createdAt: second + DAY + HOUR, hostAcceptance: ACCEPTED, state: 'accepted' }),
    ],
  });
}

test('finding 2: a plan with two chains shows ONLY the chain whose day is in range, and keeps that chain whole', () => {
  const tree = twoChainTree();
  const plan = viewing(tree).groups.flatMap((group) => group.roots).find((node) => node.nodeId === 'plan-shared');
  assert.ok(plan !== undefined);
  assert.equal(plan.executions.length, 2, 'the unfiltered tree keeps both chains; the fixture is what it claims');

  // A range that covers only chain A's days.
  const onlyA = viewing(tree, { dateRange: { from: '2026-11-18', to: '2026-11-19' } });
  assert.deepEqual(chainIdsOf(onlyA, 'plan-shared'), ['task-a-1'], 'only the matching chain is rendered');
  assert.deepEqual(taskIdsOf(onlyA).sort(), ['task-a-1', 'task-a-2'], 'and BOTH of its rounds are kept — the chain stays whole');

  // The mirrored case: only chain B matches, and its sibling is not exposed.
  const onlyB = viewing(tree, { dateRange: { from: '2026-11-25', to: '2026-11-26' } });
  assert.deepEqual(chainIdsOf(onlyB, 'plan-shared'), ['task-b-1']);
  assert.deepEqual(taskIdsOf(onlyB).sort(), ['task-b-1', 'task-b-2']);
  assert.equal(taskIdsOf(onlyB).includes('task-a-1'), false, 'a sibling chain is never shown');

  // A range covering neither day: the plan node goes away entirely.
  assert.deepEqual(viewing(tree, { dateRange: { from: '2026-12-01', to: '2026-12-02' } }).groups, []);

  // A range covering both days: nothing is hidden.
  const both = viewing(tree, { dateRange: { from: '2026-11-18', to: '2026-11-26' } });
  assert.deepEqual(chainIdsOf(both, 'plan-shared').sort(), ['task-a-1', 'task-b-1']);

  // No date filter: unchanged.
  assert.deepEqual(chainIdsOf(viewing(tree), 'plan-shared').sort(), ['task-a-1', 'task-b-1']);
});

test('an ancestor stays visible without its own out-of-range execution chains', () => {
  const tree = buildTaskTree({
    planNodes: [
      planRow('plan-goal', null, '总目标', 1, dayStart('2026-11-01')),
      planRow('plan-leaf', 'plan-goal', '子项', 2, dayStart('2026-11-02')),
    ],
    tasks: [
      taskRow('task-leaf-run', { title: '子项执行', planNodeId: 'plan-leaf', createdAt: dayStart('2026-11-20') + HOUR }),
      taskRow('task-parent-run', { title: '父计划自己的执行', planNodeId: 'plan-goal', createdAt: dayStart('2026-11-02') }),
      taskRow('task-old-parent', { title: '早期独立执行', createdAt: dayStart('2026-11-03') }),
      taskRow('task-new-child', { title: '最近的直接子任务', parentNodeId: 'task-old-parent', createdAt: dayStart('2026-11-20') }),
      taskRow('task-standalone', { title: '独立任务', createdAt: dayStart('2026-11-20') + 2 * HOUR }),
      taskRow('task-old-standalone', { title: '旧独立任务', createdAt: dayStart('2026-11-03') }),
    ],
  });
  const result = viewing(tree, { dateRange: { from: '2026-11-19', to: '2026-11-21' } });
  const goal = result.groups.flatMap((group) => group.roots).find((node) => node.nodeId === 'plan-goal');
  assert.ok(goal !== undefined, 'the goal created on the 1st is kept as the ancestor of a hit');
  assert.deepEqual(goal.executions, [], 'the ancestor does not show its own earlier execution');
  const leaf = goal.children.find((node) => node.nodeId === 'plan-leaf');
  assert.ok(leaf !== undefined, 'the intermediate plan is kept too');

  const ids = taskIdsOf(result);
  assert.ok(ids.includes('task-leaf-run'));
  assert.ok(ids.includes('task-standalone'), 'an independent task is matched by its own creation day');
  assert.equal(ids.includes('task-old-standalone'), false, 'an older independent task is excluded');

  assert.ok(ids.includes('task-new-child'), 'the child of an older standalone execution is visible');
  assert.ok(!ids.includes('task-old-parent'), 'the older standalone execution is only a structural row');

  const ancestorWithRuns = buildTaskTree({
    planNodes: [planRow('plan-parent', null, '父计划', 1, dayStart('2026-11-01'))],
    tasks: [
      taskRow('task-parent-run', { title: '父计划自己的执行', planNodeId: 'plan-parent', createdAt: dayStart('2026-11-02') }),
      taskRow('task-parent-next', { title: '另一次执行', planNodeId: 'plan-parent', createdAt: dayStart('2026-11-08') }),
    ],
  });
  const asAncestor = viewing(ancestorWithRuns, { dateRange: { from: '2026-11-01', to: '2026-11-02' } });
  assert.deepEqual(chainIdsOf(asAncestor, 'plan-parent'), ['task-parent-run'],
    'a matched plan narrows to the chain of the day');
});

test('finding 2: the range still composes with project, status and search around a multi-chain plan', () => {
  const tree = twoChainTree();
  // Search alone matches the PLAN NODE (its rounds carry the words), and the
  // existing projection keeps the whole plan visible — including every chain. This
  // work does not change that: it only narrows chains when a DATE range matched.
  assert.deepEqual(chainIdsOf(viewing(tree, { search: '乙链整改' }), 'plan-shared').sort(), ['task-a-1', 'task-b-1'],
    'search alone is unchanged by this work');
  // Search AND a date range: the date range still hides the sibling chain, whichever
  // chain the words belong to.
  assert.deepEqual(chainIdsOf(viewing(tree, { search: '乙链整改', dateRange: { from: '2026-11-25', to: '2026-11-26' } }), 'plan-shared'),
    ['task-b-1'], 'the words match one chain, the range confirms it');
  assert.deepEqual(chainIdsOf(viewing(tree, { search: '甲链整改', dateRange: { from: '2026-11-18', to: '2026-11-19' } }), 'plan-shared'),
    ['task-a-1']);
  assert.deepEqual(viewing(tree, { search: '甲链首轮', dateRange: { from: '2026-11-25', to: '2026-11-26' } }).groups,
    [], 'a text match on a hidden chain cannot surface its in-range sibling');
  // Status composes on the NODE status, exactly as before: this plan is still
  // `awaiting-host-review` (its first chain was never reviewed), so "done" hides it
  // even though chain B's rounds are accepted — status is not re-derived per chain.
  assert.deepEqual(viewing(tree, { filter: 'done' }).groups, [], 'the node status still decides the status filter');
  assert.deepEqual(chainIdsOf(viewing(tree, { filter: 'attention' }), 'plan-shared').sort(), ['task-a-1', 'task-b-1'],
    'a status filter that matches shows every chain, as before');
  assert.deepEqual(chainIdsOf(viewing(tree, { filter: 'attention', dateRange: { from: '2026-11-25', to: '2026-11-26' } }), 'plan-shared'),
    ['task-b-1'], 'and the date range still narrows the chains under an active status filter');
  // Project filter isolates the only project bucket without changing the chain rule.
  const projectKey = tree.projects[0].projectKey;
  assert.deepEqual(chainIdsOf(viewing(tree, { projectKey, dateRange: { from: '2026-11-25', to: '2026-11-26' } }), 'plan-shared'), ['task-b-1']);
});

// ---------------------------------------------------------------------------
// 3. Calendar order, not text order
// ---------------------------------------------------------------------------

test('finding 3: calendar order is used, so 9999-12-31 to 10000-01-01 is a valid forward range', () => {
  assert.deepEqual(parseCalendarDay('10000-01-01'), { year: 10000, month: 1, day: 1 });
  assert.deepEqual(parseCalendarDay('9999-12-31'), { year: 9999, month: 12, day: 31 });
  assert.ok(compareCalendarDays(parseCalendarDay('9999-12-31'), parseCalendarDay('10000-01-01')) < 0,
    'the last day of year 9999 precedes the first day of year 10000');

  const forward = normalizeDayRange({ from: '9999-12-31', to: '10000-01-01' });
  assert.equal(forward.error, null, 'a five-digit year does not turn a forward range into a reversed one');
  assert.equal(forward.fromText, '9999-12-31');
  assert.equal(forward.toText, '10000-01-01');

  // The genuinely reversed counterpart is still refused.
  assert.equal(normalizeDayRange({ from: '10000-01-01', to: '9999-12-31' }).error, '开始日期晚于结束日期，请调整后再筛选');
  // Ordinary ordering is unchanged for four-digit years.
  assert.equal(normalizeDayRange({ from: '2026-11-19', to: '2026-11-20' }).error, null);
  assert.equal(normalizeDayRange({ from: '2026-11-20', to: '2026-11-19' }).error, '开始日期晚于结束日期，请调整后再筛选');
  assert.equal(normalizeDayRange({ from: '2027-01-01', to: '2026-12-31' }).error, '开始日期晚于结束日期，请调整后再筛选');
  assert.equal(calendarDay('10000-01-01'), '10000-01-01');
});

test('finding 3: a range that crosses a normal year boundary includes both sides', () => {
  const dec = dayStart('2026-12-31');
  const tree = buildTaskTree({
    tasks: [
      taskRow('task-dec-last', { title: '年末最后一天', createdAt: dec + 10 * HOUR }),
      taskRow('task-jan-first', { title: '年初第一天', createdAt: dec + 14 * HOUR }),
      taskRow('task-dec-30', { title: '年前两天', createdAt: dec - DAY + HOUR }),
      taskRow('task-jan-02', { title: '年后两天', createdAt: dec + 2 * DAY + HOUR }),
    ],
  });
  const ids = taskIdsOf(viewing(tree, { dateRange: { from: '2026-12-31', to: '2027-01-01' } }));
  assert.ok(ids.includes('task-dec-last'), 'the last day of the old year is included');
  assert.ok(ids.includes('task-jan-first'), 'the first day of the new year is included');
  assert.equal(ids.includes('task-dec-30'), false);
  assert.equal(ids.includes('task-jan-02'), false);

  // The same range with its ends swapped is still refused (no silent swap).
  assert.equal(
    normalizeDayRange({ from: '2027-01-01', to: '2026-12-31' }).error,
    '开始日期晚于结束日期，请调整后再筛选',
  );
  // Both ends inside the same year behave date-by-date, not lexically by accident.
  assert.equal(normalizeDayRange({ from: '2026-02-09', to: '2026-02-10' }).error, null);
  assert.equal(normalizeDayRange({ from: '2026-02-10', to: '2026-02-09' }).error, '开始日期晚于结束日期，请调整后再筛选');
});

test('finding 3: nodeCreatedInRange compares days in calendar order too', () => {
  const at = dayStart('10000-01-01') + HOUR;
  const node = { nodeId: 'x', kind: 'task', createdAt: at, chain: { rounds: [{ taskId: 'x', createdAt: at }] } };
  const range = normalizeDayRange({ from: '9999-12-31', to: '10000-01-01' });
  assert.equal(localCalendarDay(at), '10000-01-01');
  assert.equal(nodeCreatedInRange(node, range), true, 'a five-digit year is inside a range that spans it');
  assert.equal(nodeCreatedInRange(node, normalizeDayRange({ from: '', to: '9999-12-31' })), false);
});
