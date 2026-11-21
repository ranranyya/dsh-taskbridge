// The TaskBridge section model: one row per DISPATCHED CHAIN, strictly three levels.
//
// Fixtures are the shapes the host and the plugin really produce:
//   * the snapshot is `workspaces.list.getSnapshot()`;
//   * the identity rows are `GET /api/dsh-delegate/session-map` `sessions`;
//   * the records are `/tasks` rows, which name the chain (`continueFromTaskId`) and, for a
//     dispatch the map has not written yet, the placement.
//
// The cases are the ones the requirement names: two independent new dispatches in ONE project
// are two task workspaces; a continuation is the SAME node and one row; external shared and
// worktree runs of one source share a project; a mixed Workspace is never claimed (the native
// browser keeps it); ordinary and empty Workspaces stay outside the section; same-named
// different sources stay two projects.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GROUP_KINDS,
  identityRows,
  isManagedRootPath,
  projectNameOf,
  readWorkspacesSnapshot,
  sessionIndex,
  sessionTitles,
  sourcePathKey,
  workspaceGroups,
  workspaceItems,
} from '../src/client/workspace-groups.js';

const REPO = 'C:\\work\\alpha';
const OTHER = 'C:\\work\\beta';
const ROOT = 'C:\\Users\\someone\\.dsh\\data\\dsh-delegate\\worktrees';

/** One host Workspace item. */
function workspace(workspaceId, path, sessionIds = [], title = '') {
  return { workspaceId, path, title, sessionIds };
}

/** One identity row, as the route publishes it. */
function identity(overrides = {}) {
  return {
    taskId: 'task-1',
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    sourcePath: REPO,
    executionPath: REPO,
    isolation: 'shared',
    updatedAt: 1000,
    ...overrides,
  };
}

/** A ready snapshot. */
function snapshot(items, extra = {}) {
  return { phase: 'ready', items, archivedSessionIds: [], ungroupedSessionIds: [], ...extra };
}

/** The section, asserting it exists. */
function sectionOf(view) {
  const root = view.groups.find((group) => group.kind === GROUP_KINDS.container);
  assert.ok(root !== undefined, 'the TaskBridge section is present');
  return root;
}

/** Every task-workspace id in the section, in render order. */
function taskWorkspaces(view) {
  return sectionOf(view).projects.flatMap((project) => project.workspaces.map((entry) => entry.workspaceId));
}

/** Every conversation id in the section. */
function conversationIds(view) {
  return sectionOf(view).projects.flatMap((project) => project.workspaces
    .flatMap((workspaceNode) => workspaceNode.conversations.map((session) => session.sessionId)));
}

test('task workspaces: canonical path keys fold exactly what the session layer folds', () => {
  assert.equal(sourcePathKey('C:\\work\\alpha\\'), sourcePathKey('C:\\work\\alpha'));
  assert.equal(sourcePathKey(' C:\\work\\alpha '), sourcePathKey('C:\\work\\alpha'));
  assert.notEqual(sourcePathKey('C:\\work\\alpha'), sourcePathKey('C:\\work\\alpha2'));
  assert.equal(sourcePathKey(''), '');
  assert.equal(sourcePathKey(undefined), '');
  const folded = sourcePathKey('C:\\Work\\Alpha');
  assert.equal(folded, process.platform === 'win32' ? 'c:\\work\\alpha' : 'C:\\Work\\Alpha');
});

test('task workspaces: the managed root and project names are read from the path itself', () => {
  assert.equal(isManagedRootPath(ROOT), true);
  assert.equal(isManagedRootPath(`${ROOT}\\task-1-abc`), false);
  assert.equal(isManagedRootPath('C:\\work\\alpha'), false);
  assert.equal(isManagedRootPath('C:\\worktrees'), false);
  assert.equal(projectNameOf(REPO), 'work/alpha');
  assert.equal(projectNameOf(''), '未命名项目');
});

test('task workspaces: a host without a readable snapshot answers nothing, not an invented list', () => {
  assert.equal(readWorkspacesSnapshot(null), null);
  assert.equal(readWorkspacesSnapshot({ list: { getSnapshot() { throw new Error('refused'); } } }), null);
  assert.deepEqual(workspaceItems(null).items, []);
  const view = workspaceGroups({ snapshot: null, identities: [] });
  assert.deepEqual(view.groups, [], 'no snapshot means no section, never a guessed one');
  assert.deepEqual(view.standalone, []);
});

test('task workspaces: two independent dispatches in one project are TWO task workspaces', () => {
  // One source, one shared Workspace, two chains: each independent dispatch is its own row.
  const view = workspaceGroups({
    snapshot: snapshot([workspace('ws-shared', REPO, ['session-a', 'session-b'], '派工')]),
    identities: [
      identity({ taskId: 'task-a', sessionId: 'session-a', workspaceId: 'ws-shared', updatedAt: 2000 }),
      identity({ taskId: 'task-b', sessionId: 'session-b', workspaceId: 'ws-shared', updatedAt: 3000 }),
    ],
    tasks: [
      { taskId: 'task-a', sessionId: 'session-a', title: '第一个派工' },
      { taskId: 'task-b', sessionId: 'session-b', title: '第二个派工' },
    ],
  });

  const section = sectionOf(view);
  assert.equal(section.projects.length, 1, 'one project for one real source');
  const [project] = section.projects;
  assert.equal(project.kind, GROUP_KINDS.project);
  assert.equal(project.path, sourcePathKey(REPO));
  // Both chains live in the SAME native Workspace, yet they are two task workspaces: the tree is
  // per chain, not per Workspace.
  assert.equal(project.workspaces.length, 2, 'each chain owns its own task-workspace row');
  assert.deepEqual(taskWorkspaces(view).sort(), ['ws-shared', 'ws-shared']);
  for (const node of project.workspaces) {
    assert.equal(node.conversations.length, 1, 'each task workspace holds its own conversation');
    assert.equal(node.chainId !== '', true, 'and names the chain it stands for');
  }
  // Newest first, so the run just started is the row an operator looks at.
  assert.deepEqual(project.workspaces.map((node) => node.conversations[0].sessionId), ['session-b', 'session-a']);
  assert.equal(section.workspaceCount, 2);
  assert.equal(section.conversationCount, 2);
});

test('task workspaces: a continuation is the SAME task workspace and ONE conversation row', () => {
  const view = workspaceGroups({
    snapshot: snapshot([workspace('ws-tree', `${ROOT}\\task-1-abc`, ['session-1'], '修复侧栏')]),
    identities: [
      identity({ taskId: 'task-1', sessionId: 'session-1', workspaceId: 'ws-tree', isolation: 'worktree', updatedAt: 1000 }),
      identity({ taskId: 'task-2', sessionId: 'session-1', workspaceId: 'ws-tree', isolation: 'worktree', updatedAt: 2000 }),
    ],
    tasks: [
      { taskId: 'task-1', sessionId: 'session-1', title: '修复侧栏' },
      { taskId: 'task-2', sessionId: 'session-1', continueFromTaskId: 'task-1', title: '修复侧栏（整改）' },
    ],
  });
  const [project] = sectionOf(view).projects;
  assert.equal(project.workspaces.length, 1, 'the continuation keeps its parent task workspace');
  assert.equal(project.workspaces[0].conversations.length, 1, 'and does not add a second row');
  assert.equal(project.workspaces[0].conversations[0].taskId, 'task-2', 'the newest round names the row');
  assert.deepEqual(view.duplicates, []);
});

test('task workspaces: external shared and worktree runs of one source share one project node', () => {
  const tree = `${ROOT}\\task-2-abc`;
  const view = workspaceGroups({
    snapshot: snapshot([
      workspace('ws-shared', REPO, ['session-shared'], '共享派工'),
      workspace('ws-tree', tree, ['session-tree'], '隔离派工'),
    ]),
    identities: [
      identity({ taskId: 'task-1', sessionId: 'session-shared', workspaceId: 'ws-shared', updatedAt: 2000 }),
      identity({
        taskId: 'task-2', sessionId: 'session-tree', workspaceId: 'ws-tree',
        executionPath: tree, isolation: 'worktree', updatedAt: 3000,
      }),
    ],
  });
  const section = sectionOf(view);
  assert.equal(section.projects.length, 1, 'one project for the real SOURCE, shared and worktree alike');
  const [project] = section.projects;
  assert.equal(project.workspaces.length, 2, 'two chains, two task workspaces');
  assert.deepEqual(project.workspaces.map((node) => node.workspaceId).sort(), ['ws-shared', 'ws-tree']);
  // The real Workspace ID and path stay on each node: the display node never pretends to be the
  // native record, it names it.
  for (const node of project.workspaces) {
    assert.equal(typeof node.workspaceId, 'string');
    assert.notEqual(node.path, '', 'each node keeps the real execution path');
  }
});

test('task workspaces: same-named sources in different places stay two projects', () => {
  const a = 'C:\\one\\project';
  const b = 'D:\\two\\project';
  const view = workspaceGroups({
    snapshot: snapshot([
      workspace('ws-a', a, ['session-a'], '甲'),
      workspace('ws-b', b, ['session-b'], '乙'),
    ]),
    identities: [
      identity({ taskId: 'task-a', sessionId: 'session-a', workspaceId: 'ws-a', sourcePath: a, executionPath: a }),
      identity({ taskId: 'task-b', sessionId: 'session-b', workspaceId: 'ws-b', sourcePath: b, executionPath: b }),
    ],
  });
  const [section] = [sectionOf(view)];
  assert.equal(section.projects.length, 2, 'identity is the source path, never the directory name');
  assert.deepEqual(section.projects.map((project) => project.name), ['one/project', 'two/project']);
});

test('task workspaces: an ordinary, empty or mixed Workspace is NEVER claimed by the section', () => {
  const view = workspaceGroups({
    snapshot: snapshot([
      workspace('ws-ours', REPO, ['session-1'], 'TaskBridge 派工'),
      workspace('ws-empty', OTHER, [], '空的普通工作区'),
      workspace('ws-ordinary', 'C:\\notes', ['session-human'], '我自己的工作区'),
      workspace('ws-mixed', 'C:\\mixed', ['session-2', 'session-mine'], '混用'),
    ]),
    identities: [
      identity({ taskId: 'task-1', sessionId: 'session-1', workspaceId: 'ws-ours' }),
      identity({ taskId: 'task-2', sessionId: 'session-2', workspaceId: 'ws-mixed', sourcePath: 'C:\\mixed', executionPath: 'C:\\mixed' }),
    ],
  });

  // Only the two dispatched conversations are in the section.
  assert.deepEqual(conversationIds(view).sort(), ['session-1', 'session-2']);
  // The Workspaces the section cannot fully explain are reported, for measurement: the native
  // browser below shows them, and the section neither hides nor duplicates them.
  const keepsOrdinary = view.standalone.map((entry) => entry.workspaceId).sort();
  assert.deepEqual(keepsOrdinary, ['ws-empty', 'ws-mixed', 'ws-ordinary']);
  assert.equal(view.mixedCount, 1, 'the mixed Workspace is counted as the native browser keeps it');

  // The MIXED task workspace must not be renamed or removed as a whole.
  const mixedNode = sectionOf(view).projects
    .flatMap((project) => project.workspaces)
    .find((node) => node.workspaceId === 'ws-mixed');
  assert.equal(mixedNode.sharedWithOrdinary, true, 'a Workspace with other conversations is marked shared');
  const ownNode = sectionOf(view).projects
    .flatMap((project) => project.workspaces)
    .find((node) => node.workspaceId === 'ws-ours');
  assert.equal(ownNode.sharedWithOrdinary, false, 'a fully dispatched Workspace may be managed');
});

test('task workspaces: a dispatch made while the view is open is merged from its record', () => {
  const view = workspaceGroups({
    snapshot: snapshot([workspace('ws-1', REPO, ['session-old', 'session-new'], '派工')]),
    identities: [identity({ taskId: 'task-old', sessionId: 'session-old', workspaceId: 'ws-1', updatedAt: 1000 })],
    tasks: [
      { taskId: 'task-old', sessionId: 'session-old', title: '旧派工' },
      {
        taskId: 'task-new',
        title: '新派工',
        updatedAt: 5000,
        execution: { sessionId: 'session-new', workspaceId: 'ws-1', sourcePath: REPO },
      },
    ],
  });
  assert.deepEqual(conversationIds(view).sort(), ['session-new', 'session-old'],
    'the run started while the view was open is on screen without a reload');
  const fresh = sectionOf(view).projects
    .flatMap((project) => project.workspaces)
    .flatMap((node) => node.conversations)
    .find((session) => session.sessionId === 'session-new');
  assert.equal(fresh.taskId, 'task-new');
  assert.equal(fresh.title, '新派工');
  assert.equal(fresh.workspaceId, 'ws-1');
  // Now fully proven, so the native browser no longer needs to be counted as keeping it.
  assert.deepEqual(view.standalone.map((entry) => entry.workspaceId), []);
});

test('task workspaces: a record cannot move an already recorded placement', () => {
  const view = workspaceGroups({
    snapshot: snapshot([workspace('ws-a', REPO, ['session-1']), workspace('ws-b', OTHER, [])]),
    identities: [identity({ workspaceId: 'ws-a', sourcePath: REPO, executionPath: REPO })],
    tasks: [{ taskId: 'task-1', sessionId: 'session-1', execution: { workspaceId: 'ws-b' }, title: '派工' }],
  });
  assert.deepEqual(taskWorkspaces(view), ['ws-a'], 'the recorded pair wins');
  assert.equal(view.standalone.some((entry) => entry.workspaceId === 'ws-b'), true,
    'the other Workspace stays with the native browser');
});

test('task workspaces: archived, ungrouped and duplicate sessions are stated, never dropped silently', () => {
  const view = workspaceGroups({
    snapshot: snapshot(
      [workspace('ws-1', REPO, ['session-1'])],
      { archivedSessionIds: ['session-archived', 'session-not-ours'], ungroupedSessionIds: ['session-loose', 'session-1'] },
    ),
    identities: [
      identity(),
      identity({ taskId: 'task-9', sessionId: 'session-archived', workspaceId: 'ws-1', updatedAt: 500 }),
    ],
    tasks: [{ taskId: 'task-9', sessionId: 'session-archived', title: '早就归档的派工' }],
  });
  assert.deepEqual(view.archived.map((entry) => entry.sessionId), ['session-archived']);
  assert.equal(view.archived[0].taskId, 'task-9');
  assert.equal(view.archived[0].workspaceId, 'ws-1');
  assert.deepEqual(view.ungrouped.map((entry) => entry.sessionId), ['session-loose']);
  assert.equal(view.ungrouped[0].owned, false);
});

test('task workspaces: identity rows and records without both ids prove nothing', () => {
  assert.deepEqual(identityRows([
    null,
    {},
    { sessionId: 's', workspaceId: '' },
    { sessionId: 's', workspaceId: 'w', taskId: 't', sourcePath: REPO, executionPath: REPO, updatedAt: 5 },
  ]), [{
    taskId: 't', sessionId: 's', workspaceId: 'w', sourcePath: REPO, executionPath: REPO, isolation: null, updatedAt: 5,
  }]);

  const index = sessionIndex([
    { taskId: 'task-1', sessionId: 'session-1', title: '只有会话与标题' },
    { taskId: 'task-2', execution: { sessionId: 'session-2', workspaceId: 'ws-2' }, title: '成对' },
    { taskId: 'task-3', continueFromTaskId: 'task-2', execution: { sessionId: 'session-3', workspaceId: 'ws-2' } },
  ]);
  assert.equal(index.pairs.has('ws-2\u0000session-2'), true);
  assert.equal(index.pairs.size, 2, 'a record naming no Workspace proves no placement');
  assert.equal(index.titles.get('session-1'), '只有会话与标题');
  // The chain of a continuation is resolved from the records' own links.
  assert.equal(index.chainOf.get('task-3'), 'task-2');
  assert.equal(index.chainOf.get('task-2'), 'task-2');
});

test('task workspaces: session titles come only from records that state id and title', () => {
  const titles = sessionTitles([
    { taskId: 'task-1', execution: { sessionId: 'session-1' }, title: '来自执行块' },
    { taskId: 'task-2', sessionId: 'session-2', title: '来自顶层' },
    { taskId: 'task-3', conversation: { sessionId: 'session-3' }, title: '来自会话块' },
    { taskId: 'task-4', title: '没有会话标识' },
    { taskId: 'task-5', sessionId: 'session-5', title: '   ' },
    { taskId: 'task-6', sessionId: 'session-1', title: '后来的记录不覆盖第一条' },
  ]);
  assert.equal(titles.get('session-1'), '来自执行块');
  assert.equal(titles.get('session-2'), '来自顶层');
  assert.equal(titles.get('session-3'), '来自会话块');
  assert.equal(titles.has('session-5'), false);
  assert.equal(titles.size, 3);
});
