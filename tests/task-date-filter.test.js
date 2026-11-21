// Creation-date filtering of the task tree (projection level).
//
// Every fixture below is built with the REAL `buildTaskTree`, so the nodes carry
// the projection's own `createdAt`, `chain.rounds` and `children` fields. The
// calendar days are computed with the same browser-local rules the panel uses, so
// these assertions hold in any time zone: the point under test is which nodes
// survive and how the tree is kept whole, not a hard-coded UTC instant.
//
// What it pins down:
//   1. an empty range changes nothing, and the projection reports no error;
//   2. single-sided ranges, the same day twice (a closed one-day range), and a
//      closed multi-day range all include both calendar boundaries;
//   3. a chain is kept WHOLE when any rectification round was created in range,
//      and a plan node outside the range survives only as the ancestor of a hit,
//      with its hierarchy and child progress intact;
//   4. a node with no usable creation time is never a hit;
//   5. a reversed range is reported and NOT applied (and never silently swapped);
//   6. the range composes with project, status, search and display archive.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calendarDay,
  localCalendarDay,
  nodeCreatedInRange,
  normalizeDayRange,
  parseCalendarDay,
  projectTaskView,
} from '../src/client/task-view.js';
import { buildTaskTree } from '../src/jobs/task-tree.js';

const ACCEPTED = { accepted: true, state: 'accepted', decision: 'accepted', acceptedAt: 1, by: 'commander' };
const repoA = process.platform === 'win32' ? 'C:\\org-one\\portal' : '/org-one/portal';
const repoB = process.platform === 'win32' ? 'C:\\org-two\\console' : '/org-two/console';

/** Local midnight of one `YYYY-MM-DD`, through the browser calendar (never a fixed offset). */
function dayStart(day) {
  const [year, month, date] = day.split('-').map(Number);
  const at = new Date(0);
  at.setFullYear(year, month - 1, date);
  at.setHours(0, 0, 0, 0);
  return at.getTime();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const days = {
  before: localCalendarDay(dayStart('2026-11-17')),
  start: '2026-11-18',
  middle: '2026-11-19',
  end: '2026-11-20',
  after: '2026-11-21',
};

const viewing = (tree, extra = {}) => projectTaskView(tree, {
  projectKey: '', filter: 'all', search: '', selectedTaskId: null, ...extra,
});

/** Node ids of the WHOLE returned tree, depth first (ancestors included). */
const allNodeIds = (result) => {
  const out = [];
  const walk = (node) => {
    out.push(node.nodeId);
    // A plan node carries its executions in `executions`, a task node its rounds in
    // `chain`; both are part of what is "kept", so both are collected here.
    for (const chain of node.chain ? [node.chain] : node.executions ?? []) {
      out.push(...(chain.rounds ?? []).map((round) => round.taskId));
    }
    node.children.forEach(walk);
  };
  result.groups.forEach((group) => group.roots.forEach(walk));
  return out;
};

/** Root-level node ids per project, in the projection's order. */
const topLevel = (result) => result.groups
  .map((group) => [group.projectKey, group.roots.map((node) => node.nodeId)]);

/**
 * A tree spanning the boundary days around `2026-11-18 … 2026-11-20`:
 * `plan-goal` (created before) → `plan-ui` (before) → a three-round chain whose
 * rounds are created before / inside / after the range, one unexecuted leaf, a
 * chain in the second project entirely inside the range, and a node with no time.
 * @returns {object} the built tree.
 */
function rangeTree() {
  const plan = (nodeId, parentNodeId, title, sequence, sourcePath, createdAt) => ({
    nodeId, parentNodeId, title, sequence, sourcePath, createdAt, updatedAt: createdAt,
  });
  const task = (taskId, extra) => ({
    taskId,
    state: 'awaiting-host-review', phase: 'awaiting-host-review',
    sourcePath: repoA, archived: false, live: true, ...extra,
  });
  const tasks = [
    // Round 1 is created BEFORE the range, round 2 and 3 INSIDE it.
    task('task-chain-1', { title: '首轮实现', planNodeId: 'plan-ui', createdAt: dayStart(days.before) + 9 * HOUR, hostAcceptance: { accepted: false, state: 'changes-requested', decision: 'changes-requested', acceptedAt: 1 } }),
    task('task-chain-2', { title: '整改第二轮', continueFromTaskId: 'task-chain-1', createdAt: dayStart(days.middle) + 2 * HOUR, hostAcceptance: { accepted: false, state: 'changes-requested', decision: 'changes-requested', acceptedAt: 2 } }),
    task('task-chain-3', { title: '整改第三轮', continueFromTaskId: 'task-chain-2', createdAt: dayStart(days.after) + 10 * HOUR, hostAcceptance: ACCEPTED }),
    // Wholly before the range.
    task('task-early', { title: '更早完成的任务', planNodeId: 'plan-early', createdAt: dayStart(days.before) + HOUR, hostAcceptance: ACCEPTED }),
    // Boundary: the last instant of the start day is in range, the first instant of
    // the day before is not — the closed boundary is decided by calendar day.
    task('task-start-edge', { title: '开始日最后一刻', createdAt: dayStart(days.start) + 24 * HOUR - MINUTE }),
    task('task-just-before', { title: '开始日之前的最后一刻', createdAt: dayStart(days.start) - MINUTE }),
    // Boundary: local midnight of the end day belongs to the end day; the next
    // midnight does not (an exclusive upper midnight — no fixed 24-hour step).
    task('task-end-midnight', { title: '结束日零点', createdAt: dayStart(days.end) }),
    task('task-after-midnight', { title: '次日零点', createdAt: dayStart(days.after) }),
    // A second project, wholly inside the range but in another project bucket.
    task('task-other-project', { title: '另一个项目的任务', sourcePath: repoB, createdAt: dayStart(days.middle) + 3 * HOUR }),
    // No usable creation time: "unknown" is not evidence of "in range".
    task('task-no-time', { title: '缺少创建时间的任务', createdAt: null }),
    task('task-text-time', { title: '创建时间是文本', createdAt: '2026-11-19' }),
  ];
  const planNodes = [
    plan('plan-goal', null, '总体目标', 1, repoA, dayStart(days.before)),
    plan('plan-ui', 'plan-goal', '界面反馈', 2, repoA, dayStart(days.before) + HOUR),
    plan('plan-early', 'plan-goal', '早期子项', 3, repoA, dayStart(days.before)),
    plan('plan-planned', 'plan-ui', '尚未执行的计划项', 4, repoA, dayStart(days.before) + 2 * HOUR),
  ];
  return buildTaskTree({ planNodes, tasks });
}

// ---------------------------------------------------------------------------
// 1. The helpers: a calendar day, not a 24-hour block
// ---------------------------------------------------------------------------

test('days: a calendar day round-trips, an impossible date is refused, and a timestamp maps to its LOCAL day', () => {
  assert.equal(calendarDay('2026-11-20'), '2026-11-20');
  assert.equal(calendarDay(' 2026-11-20 '), '2026-11-20');
  assert.equal(calendarDay('2026-02-30'), null, 'a day that does not exist is not silently rolled into March');
  assert.equal(calendarDay('2026-13-01'), null);
  assert.equal(calendarDay('2026-11'), null);
  assert.equal(calendarDay('2026/11/20'), null);
  assert.equal(calendarDay(''), null);
  assert.equal(calendarDay(null), null);
  assert.equal(calendarDay(1_795_190_400_000), null, 'a number is not a date input value');

  // A timestamp one millisecond before local midnight belongs to the previous day.
  const midnight = dayStart('2026-11-20');
  assert.equal(localCalendarDay(midnight), '2026-11-20');
  assert.equal(localCalendarDay(midnight - 1), days.middle);
  assert.equal(localCalendarDay(Number.NaN), null);
  assert.equal(localCalendarDay(null), null);
});

test('days: a single-sided range, the same day twice, and a reversed range are normalised without guessing', () => {
  // The bounds are compared as parsed calendar days; the text form is only what the
  // page shows back. Both are asserted here so the display can never drift.
  assert.deepEqual(normalizeDayRange({}), {
    from: null, to: null, fromText: null, toText: null, error: null,
  });
  assert.deepEqual(normalizeDayRange({ from: '', to: '' }), {
    from: null, to: null, fromText: null, toText: null, error: null,
  });
  assert.deepEqual(normalizeDayRange({ from: days.start }), {
    from: parseCalendarDay(days.start), to: null, fromText: days.start, toText: null, error: null,
  });
  assert.deepEqual(normalizeDayRange({ to: days.end }), {
    from: null, to: parseCalendarDay(days.end), fromText: null, toText: days.end, error: null,
  });
  assert.deepEqual(normalizeDayRange({ from: days.end, to: days.end }), {
    from: parseCalendarDay(days.end), to: parseCalendarDay(days.end),
    fromText: days.end, toText: days.end, error: null,
  });
  const reversed = normalizeDayRange({ from: days.end, to: days.start });
  assert.equal(reversed.error, '开始日期晚于结束日期，请调整后再筛选');
  assert.equal(reversed.fromText, days.end, 'the reversed input is reported, not swapped behind the operator');
  assert.equal(reversed.toText, days.start);
  assert.equal(normalizeDayRange({ from: 'not-a-day' }).error, '开始日期格式无效');
  assert.equal(normalizeDayRange({ to: '2026-02-30' }).error, '结束日期格式无效');
});

test('days: membership is decided per node by its own creation day, with an exclusive end midnight', () => {
  const tree = rangeTree();
  const byId = new Map(tree.roots.flatMap(function flatten(node) {
    return [node, ...node.children.flatMap(flatten)];
  }).map((node) => [node.nodeId, node]));
  const range = normalizeDayRange({ from: days.start, to: days.end });
  assert.equal(nodeCreatedInRange(byId.get('task-start-edge'), range), true, 'the last minute of the start day is included');
  assert.equal(nodeCreatedInRange(byId.get('task-just-before'), range), false, 'one minute earlier is outside');
  assert.equal(nodeCreatedInRange(byId.get('task-end-midnight'), range), true, 'local midnight of the end day is the end day');
  assert.equal(nodeCreatedInRange(byId.get('task-after-midnight'), range), false, 'the next midnight is excluded');
  assert.equal(nodeCreatedInRange(byId.get('task-no-time'), range), false);
  assert.equal(nodeCreatedInRange(byId.get('task-text-time'), range), false);
  assert.equal(nodeCreatedInRange(byId.get('task-chain-3'), normalizeDayRange({})), true, 'no range means no date condition');
});

// ---------------------------------------------------------------------------
// 2. An empty range changes nothing
// ---------------------------------------------------------------------------

test('dates: an empty range keeps the whole tree and reports no error', () => {
  const tree = rangeTree();
  const base = viewing(tree);
  assert.equal(base.dateError, null);
  const empty = viewing(tree, { dateRange: { from: '', to: '' } });
  assert.equal(empty.dateError, null);
  assert.deepEqual(topLevel(empty), topLevel(base));
  assert.deepEqual(allNodeIds(empty), allNodeIds(base));
  assert.deepEqual(viewing(tree, { dateRange: undefined }), base, 'omitting the range is the same as an empty one');
});

// ---------------------------------------------------------------------------
// 3. Closed, single-sided and one-day ranges
// ---------------------------------------------------------------------------

test('dates: a closed range keeps both calendar boundaries and drops what lies outside', () => {
  const tree = rangeTree();
  const result = viewing(tree, { dateRange: { from: days.start, to: days.end } });
  assert.equal(result.dateError, null);
  const ids = allNodeIds(result);
  for (const id of ['task-start-edge', 'task-end-midnight', 'task-chain-1', 'task-other-project']) {
    assert.ok(ids.includes(id), `${id} is inside the range`);
  }
  for (const id of ['task-just-before', 'task-after-midnight', 'task-no-time', 'task-text-time']) {
    assert.equal(ids.includes(id), false, `${id} is outside the range or has no usable creation time`);
  }
});

test('dates: one side only caps one end; the same day twice is exactly that day', () => {
  const tree = rangeTree();
  const fromOnly = allNodeIds(viewing(tree, { dateRange: { from: days.start } }));
  assert.equal(fromOnly.includes('task-start-edge'), true);
  assert.equal(fromOnly.includes('task-just-before'), false, 'before the start is excluded');
  assert.equal(fromOnly.includes('task-after-midnight'), true, 'no upper cap');

  const toOnly = allNodeIds(viewing(tree, { dateRange: { to: days.end } }));
  assert.equal(toOnly.includes('task-after-midnight'), false, 'after the end is excluded');
  assert.equal(toOnly.includes('task-start-edge'), true, 'no lower cap');

  const today = allNodeIds(viewing(tree, { dateRange: { from: days.end, to: days.end } }));
  assert.equal(today.includes('task-end-midnight'), true, 'midnight of that day belongs to it');
  assert.equal(today.includes('task-start-edge'), false, 'the day before does not');
  assert.equal(today.includes('task-after-midnight'), false, 'the next day does not');
});

// ---------------------------------------------------------------------------
// 4. A chain stays whole, the ancestor stays as structure
// ---------------------------------------------------------------------------

test('dates: a round created in range keeps its whole chain, and the plan nodes above it survive as ancestors', () => {
  const tree = rangeTree();
  const result = viewing(tree, { dateRange: { from: days.middle, to: days.middle } });
  assert.equal(result.dateError, null);

  const goal = result.groups.flatMap((group) => group.roots).find((node) => node.nodeId === 'plan-goal');
  assert.ok(goal !== undefined, 'the goal plan node is created BEFORE the range but is the ancestor of a hit');
  const ui = goal.children.find((node) => node.nodeId === 'plan-ui');
  assert.ok(ui !== undefined, 'the intermediate plan node is kept too, so the hierarchy is not flattened');

  const chain = ui.executions[0];
  assert.deepEqual(chain.rounds.map((round) => round.taskId), ['task-chain-1', 'task-chain-2', 'task-chain-3'],
    'all three rounds are kept, including the two created outside the range');
  assert.equal(chain.updatedAt, chain.rounds[2].createdAt, 'the chain keeps its own ordering data');
  assert.equal(chain.rounds[0].createdAt, dayStart(days.before) + 9 * HOUR, 'round 1 still reports its own earlier creation time');

  // The unexecuted plan node created before the range and with nothing in range
  // is not an ancestor of a hit, so it goes away.
  assert.deepEqual(ui.children.map((child) => child.nodeId), []);
  // The original hierarchy and per-node child progress survive.
  assert.deepEqual(goal.children.map((child) => child.nodeId), ['plan-ui']);
  assert.equal(goal.childProgress.total, 2, 'the goal reports its two original children');
  // `plan-early` is an accepted leaf recorded before the range: it is not a hit
  // and not an ancestor of one, so it is not kept — but the goal's progress line
  // still counts it, because progress describes the original children.
  assert.equal(goal.childProgress.accepted, 1, 'acceptance of a dropped sibling is still reported');
  assert.equal(ui.childProgress.total, 1);
  assert.equal(ui.childProgress.accepted, 0);
});

test('dates: a plan node created in range matches on its OWN creation day even before it has an execution', () => {
  const at = dayStart(days.end) + 5 * HOUR;
  const tree = buildTaskTree({
    planNodes: [{ nodeId: 'plan-new', parentNodeId: null, title: '今天新建的计划', sequence: 1, sourcePath: repoA, createdAt: at, updatedAt: at }],
    tasks: [],
  });
  const result = viewing(tree, { dateRange: { from: days.end, to: days.end } });
  assert.deepEqual(result.groups.flatMap((group) => group.roots.map((node) => node.nodeId)), ['plan-new']);
  assert.deepEqual(viewing(tree, { dateRange: { from: days.after } }).groups, [], 'and not on another day');
});

test('dates: counts and attention still describe the project, and the ordering rule is unchanged', () => {
  const tree = rangeTree();
  const result = viewing(tree, { dateRange: { from: days.middle, to: days.middle } });
  const group = result.groups.find((entry) => entry.shortPath !== undefined && entry.projectKey !== 'unverified');
  assert.ok(group !== undefined);
  assert.ok(Number.isInteger(group.count.total) && group.count.total > 0);
});

// ---------------------------------------------------------------------------
// 5. A reversed range is stated and not applied
// ---------------------------------------------------------------------------

test('dates: a reversed range reports an error and does NOT filter instead of guessing', () => {
  const tree = rangeTree();
  const base = viewing(tree);
  const reversed = viewing(tree, { dateRange: { from: days.end, to: days.start } });
  assert.equal(reversed.dateError, '开始日期晚于结束日期，请调整后再筛选');
  assert.deepEqual(allNodeIds(reversed), allNodeIds(base), 'the tree is what it was before the invalid input');
  const broken = viewing(tree, { dateRange: { from: '2026-02-30' } });
  assert.equal(broken.dateError, '开始日期格式无效');
  assert.deepEqual(allNodeIds(broken), allNodeIds(base));
});

// ---------------------------------------------------------------------------
// 6. Composition with the other filters
// ---------------------------------------------------------------------------

test('dates: the range composes with project, status, search and archive', () => {
  const tree = rangeTree();
  const range = { from: days.middle, to: days.middle };

  // Project: only the requested bucket, even though both hold hits.
  const projectOnly = viewing(tree, { dateRange: range, projectKey: tree.projects.find((p) => p.sourcePath === repoB)?.projectKey ?? '' });
  assert.equal(projectOnly.groups.length, 1);
  assert.deepEqual(projectOnly.groups[0].roots.map((node) => node.nodeId), ['task-other-project']);

  // Search: a word that matches a node OUTSIDE the range yields nothing, so the
  // two conditions are ANDed rather than ORed.
  assert.deepEqual(viewing(tree, { dateRange: range, search: '更早完成' }).groups, []);
  assert.deepEqual(
    viewing(tree, { dateRange: range, search: '整改第二轮' }).groups.flatMap((group) => group.roots.map((node) => node.nodeId)),
    ['plan-goal'],
  );

  // Status: "done" keeps only accepted nodes that also carry a day in range. The
  // chain node here is still `awaiting-host-review` (its last round was never
  // reviewed), so the two conditions are ANDed and nothing survives — the range
  // does not re-open a node the status filter excluded, and the status filter does
  // not re-open one the range excluded.
  const done = viewing(tree, { dateRange: range, filter: 'done' });
  assert.deepEqual(done.groups, [], 'a node in range but not "done" is not shown by the status filter');
  assert.equal(allNodeIds(viewing(tree, { dateRange: range })).includes('task-chain-3'), true,
    'the same node IS shown when no status filter is applied');
  assert.deepEqual(allNodeIds(viewing(tree, { filter: 'done' })), ['plan-goal', 'plan-early', 'task-early'],
    'without the range, "done" shows the accepted early task; WITH it, that task is outside the range');

  // Archive: an archived node is only shown in the archive view, and the date
  // range still applies there.
  const archivedTree = JSON.parse(JSON.stringify(tree));
  const walk = (node) => { if (node.nodeId === 'task-other-project') node.displayArchived = true; node.children.forEach(walk); };
  archivedTree.roots.forEach(walk);
  const archiveView = viewing(archivedTree, { dateRange: range, filter: 'archive' });
  assert.deepEqual(archiveView.groups.flatMap((group) => group.roots.map((node) => node.nodeId)), ['task-other-project']);
  assert.equal(archiveView.archiveCount, 1);
  assert.deepEqual(
    viewing(archivedTree, { dateRange: { from: days.end, to: days.end }, filter: 'archive' }).groups,
    [],
    'an archived node outside the range is not shown just because it is archived',
  );

  // A previously selected round outside the range cannot bring its chain back.
  const selected = viewing(tree, { dateRange: { from: days.end, to: days.end }, selectedTaskId: 'task-chain-2' });
  assert.equal(allNodeIds(selected).includes('task-chain-1'), false);
  const selectedInRange = viewing(tree, { dateRange: range, selectedTaskId: 'task-chain-3' });
  assert.equal(allNodeIds(selectedInRange).includes('task-chain-3'), true, 'the selected round stays reachable');
});
