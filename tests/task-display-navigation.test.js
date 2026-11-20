import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectTaskView } from '../src/client/task-view.js';
import { userPlaneRoutes, USER_PLANE_PREFIX } from '../src/http/user-plane.js';
import { TaskDisplayStore } from '../src/jobs/task-display.js';
import { buildTaskTree } from '../src/jobs/task-tree.js';

const confirmed = {
  state: 'awaiting-host-review',
  hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 7 },
  reviewPersistence: { state: 'saved' },
};
const task = (taskId, extra = {}) => ({ taskId, title: '任务一', createdAt: 1, ...confirmed, ...extra });
const viewing = (tree, extra = {}) => projectTaskView(tree, { projectKey: '', filter: 'all', search: '', selectedTaskId: null, ...extra });

test('G04: an unresolved failed branch or an unsaved review prevents the accepted sibling from finishing the chain', () => {
  const root = task('task-root', { state: 'failed', hostAcceptance: undefined });
  const left = task('task-left', { continueFromTaskId: root.taskId, createdAt: 2, state: 'failed', hostAcceptance: undefined });
  const right = task('task-right', { continueFromTaskId: root.taskId, createdAt: 3 });
  const fixed = task('task-fixed', { continueFromTaskId: left.taskId, createdAt: 4 });
  const state = (tasks) => buildTaskTree({ tasks }).roots[0].nodeStatus;
  assert.equal(state([root, left, right]), 'failed');
  assert.equal(state([root, left, right, fixed]), 'accepted');
  const unsaved = { ...left, ...confirmed, reviewPersistence: { state: 'failed' } };
  assert.equal(state([root, unsaved, right, fixed]), 'awaiting-host-review');
});

test('G02/G05: filters find a round by ID, preserve its ancestry, and keep same-name source projects distinct', () => {
  const a = process.platform === 'win32' ? 'C:\\north\\portal' : '/north/portal';
  const b = process.platform === 'win32' ? 'C:\\south\\portal' : '/south/portal';
  const tree = buildTaskTree({
    tasks: [task('task-first', { sourcePath: a, planNodeId: 'plan-feature' }),
      task('task-wait-37', { title: 'Pending navigation review', sourcePath: a, planNodeId: 'plan-feature', continueFromTaskId: 'task-first', createdAt: 2, state: 'running', phase: 'awaiting-permission' }),
      task('task-other', { sourcePath: b }),
      task('task-unverified', { isolation: 'worktree', workspacePath: a, executionWorkspacePath: a })],
    planNodes: [{ nodeId: 'plan-total', title: '总目标', sourcePath: a },
      { nodeId: 'plan-feature', parentNodeId: 'plan-total', title: '子项', sourcePath: a }],
  });
  const all = viewing(tree);
  assert.equal(all.groups.filter((group) => group.name === 'portal').length, 2);
  assert.notEqual(all.groups[0].shortPath, all.groups[1].shortPath);
  assert.equal(all.groups.at(-1).projectKey, 'unverified');
  const result = viewing(tree, { search: 'wait-37', filter: 'attention' });
  assert.deepEqual(result.groups.map((g) => g.roots.map((node) => [node.nodeId, node.children.map((child) => child.nodeId)])), [
    [['plan-total', ['plan-feature']]],
  ]);
  assert.equal(result.groups[0].count.total, 2, 'rounds do not count as separate logical tasks');
  assert.deepEqual(viewing(tree, { search: 'navigation review' }).groups.map((g) => g.projectKey), [result.groups[0].projectKey]);
  assert.deepEqual(viewing(tree, { filter: 'done' }).groups.flatMap((g) => g.roots.map((r) => r.nodeId)).sort(), ['task-other', 'task-unverified']);
});

test('G07: user-plane archive persists and restores; a new round reopens the accepted predecessor', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'taskbridge-display-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let live = [task('task-showcase'), task('task-pending', { state: 'pending', hostAcceptance: undefined })];
  const open = () => userPlaneRoutes({
    engine: { list: () => live },
    taskDisplay: new TaskDisplayStore(directory),
  });
  let routes = open();
  const get = () => routes.find((route) => route.path === `${USER_PLANE_PREFIX}/tasks`).fetch(new Request('http://localhost/api/dsh-delegate/tasks'));
  const set = (nodeId, archived) => {
    const route = routes.find((r) => r.path === `${USER_PLANE_PREFIX}/tasks/display-archive`);
    return route.fetch(new Request(`http://localhost${route.path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodeId, archived }),
    }));
  };
  await assert.rejects(set('task-pending', true), { status: 409, code: 'TASK_DISPLAY_NOT_ACCEPTED' });
  assert.equal((await set('task-showcase', true)).status, 200);
  routes = open();
  let body = await (await get()).json();
  assert.equal(body.tasks.length, 2);
  assert.deepEqual(viewing(body.tree, { filter: 'archive' }).groups[0].roots.map((node) => node.nodeId), ['task-showcase']);
  assert.equal(viewing(body.tree).groups[0].roots[0].nodeId, 'task-pending');
  assert.equal((await set('task-showcase', false)).status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'task-display.json'), 'utf8')).archives, {});
  await set('task-showcase', true);
  live = [...live, task('task-next', { continueFromTaskId: 'task-showcase', state: 'running', hostAcceptance: undefined, createdAt: 9 })];
  body = await (await get()).json();
  assert.equal(viewing(body.tree, { filter: 'archive' }).archiveCount, 0);
  assert.equal(viewing(body.tree).groups[0].roots.find((node) => node.nodeId === 'task-showcase').chain.roundCount, 2);
  assert.equal(live.length, 3);
});
