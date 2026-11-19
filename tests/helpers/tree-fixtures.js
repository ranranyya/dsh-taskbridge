// Fixtures shaped EXACTLY like the host's `/tasks` projection.
//
// They are built with the real `buildTaskTree` from `src/jobs/task-tree.js`, not
// hand-written objects, so the browser-side tests exercise the contract the server
// actually produces: `nodeStatus`, `orphan`, `children` and each chain's `rounds`
// are the projection's own values. Renaming or adding a field here would therefore
// paper over a client bug instead of revealing it.

import { buildTaskTree } from '../../src/jobs/task-tree.js';
import { pathDigest } from '../../src/jobs/continuation-identity.js';

const ACCEPTED = Object.freeze({ accepted: true, state: 'accepted', decision: 'accepted', acceptedAt: 1_763_200_900_000, by: 'commander', note: '已验收' });

/**
 * A three-level plan whose `ui` leaf carries a THREE-round chain, plus an
 * unexecuted leaf, a standalone legacy task, an orphan plan and a missing-plan
 * task. One more plan node is titled identically at the same project to prove the
 * page keys nodes by identity rather than by title.
 * @returns {object} `{ tasks, treeInput }` — the `/tasks` body pieces.
 */
export function threeLevelProjection() {
  const repoA = process.platform === 'win32' ? 'C:\\org-one\\portal' : '/org-one/portal';
  const digestA = pathDigest(repoA);
  const planNode = (nodeId, parentNodeId, title, sequence, extra = {}) => ({
    nodeId,
    parentNodeId,
    title,
    goalDescription: extra.goalDescription ?? null,
    sourcePath: repoA,
    sourcePathDigest: digestA,
    sequence,
    createdAt: 1_763_200_000_000 + sequence,
    updatedAt: 1_763_200_000_000 + sequence,
    hostAcceptance: extra.hostAcceptance ?? null,
    connectionId: 'local-mcp',
    ...extra,
  });

  const nodes = [
    planNode('plan-goal', null, '实现设置自动保存', 1, { goalDescription: '总体目标：配置变更自动落盘' }),
    planNode('plan-logic', 'plan-goal', '保存逻辑', 2),
    planNode('plan-debounce', 'plan-logic', '防抖保存', 3, {
      goalDescription: '合并 300ms 内的连续输入',
      hostAcceptance: ACCEPTED,
    }),
    planNode('plan-errors', 'plan-logic', '保存失败处理', 4),
    planNode('plan-ui', 'plan-goal', '界面反馈', 5),
    // Same title, same parent, same project — a DIFFERENT node. Identity, not title.
    planNode('plan-ui-twin', 'plan-goal', '界面反馈', 6),
    // A plan node whose recorded parent does not exist: the projection keeps it as
    // an explicit orphan instead of dropping it or guessing a parent.
    planNode('plan-orphan', 'plan-evicted-42', '孤儿规划节点', 7),
  ];

  const task = (overrides) => ({
    state: 'awaiting-host-review',
    phase: 'awaiting-host-review',
    sourcePath: repoA,
    sourcePathDigest: digestA,
    archived: false,
    live: true,
    ...overrides,
  });

  const tasks = [
    task({
      taskId: 'task-debounce',
      title: '实现防抖保存函数',
      planNodeId: 'plan-debounce',
      createdAt: 1_763_200_100_000,
      hostAcceptance: ACCEPTED,
      reviewPersistence: { state: 'saved' },
    }),
    // Round 1 of the ui chain: reviewed, changes requested.
    task({
      taskId: 'task-ui-1',
      title: '界面保存状态条',
      planNodeId: 'plan-ui',
      createdAt: 1_763_200_200_000,
      state: 'awaiting-host-review',
      hostAcceptance: { accepted: false, state: 'changes-requested', decision: 'changes-requested', acceptedAt: 1_763_200_210_000, note: '窄窗口下状态文字未对齐' },
      reviewPersistence: { state: 'saved' },
    }),
    // Rounds 2 and 3 continue an explicit `continueFromTaskId` chain.
    task({
      taskId: 'task-ui-2',
      title: '修正窄窗口状态条对齐',
      continueFromTaskId: 'task-ui-1',
      createdAt: 1_763_200_300_000,
      hostAcceptance: { accepted: false, state: 'changes-requested', decision: 'changes-requested', acceptedAt: 1_763_200_310_000, note: '还需补 aria-live' },
      reviewPersistence: { state: 'saved' },
    }),
    task({
      taskId: 'task-ui-3',
      title: '补充状态条 aria-live',
      continueFromTaskId: 'task-ui-2',
      createdAt: 1_763_200_400_000,
      hostAcceptance: ACCEPTED,
      reviewPersistence: { state: 'saved' },
    }),
    // The twin plan node's own execution: also awaiting review, awaiting permission.
    task({
      taskId: 'task-ui-twin',
      title: '界面反馈（另一处）',
      planNodeId: 'plan-ui-twin',
      createdAt: 1_763_200_500_000,
      phase: 'awaiting-permission',
      state: 'running',
      permission: { waiting: true },
    }),
    // A legacy caller: no plan, no parent.
    task({
      taskId: 'task-legacy',
      title: '清理构建脚本注释',
      createdAt: 1_763_200_600_000,
    }),
    // A task pointing at a plan node that no longer exists.
    task({
      taskId: 'task-missing-plan',
      title: '缺失规划引用的执行任务',
      planNodeId: 'plan-deleted-404',
      createdAt: 1_763_200_700_000,
      state: 'failed',
      phase: 'failed',
    }),
  ];

  return { tasks, planNodes: nodes, repoA, digestA };
}

/**
 * The `/tasks` body a host would answer for {@link threeLevelProjection}.
 * @returns {object} `{ ok, tasks, history, plans, tree }`.
 */
export function tasksBody() {
  const { tasks, planNodes } = threeLevelProjection();
  const tree = buildTaskTree({ planNodes, tasks });
  return {
    ok: true,
    tasks,
    history: { available: true, archived: 0, unreadable: false },
    plans: { available: true, count: planNodes.length, unreadable: false },
    tree,
  };
}

/**
 * The same body with the tree REMOVED, standing in for an older host.
 * @returns {object} `{ ok, tasks }`.
 */
export function tasksBodyWithoutTree() {
  const { tasks } = threeLevelProjection();
  return { ok: true, tasks };
}

/**
 * The flat-only tree shape (what the execution plane's `/plans list` publishes).
 * @returns {object} a `/tasks` body whose `tree` carries `flatNodes` and no `roots`.
 */
export function tasksBodyFlatTree() {
  const { tasks, planNodes } = threeLevelProjection();
  const tree = buildTaskTree({ planNodes, tasks });
  return {
    ok: true,
    tasks,
    plans: { available: true, count: planNodes.length, unreadable: false },
    tree: {
      flatNodes: tree.flatNodes,
      orphans: tree.orphans,
      projects: tree.projects,
      counts: tree.counts,
    },
  };
}
