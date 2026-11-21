// Task-record cleanup: one bounded, all-or-nothing deletion of finished execution
// chains, asserted end to end against the REAL stores and the REAL tree projection.
//
// What this file proves, and why each part is here:
//
//   1. The primitive (`HistoryStore.deleteMany`) is atomic, bounded and refuses a
//      live record — the three properties every later assertion rests on.
//   2. The surface (`POST /api/dsh-delegate/tasks/cleanup`) removes exactly the
//      records of the chains that were named, and a restart over the SAME data
//      directory no longer shows them: nothing is simulated, the process-local
//      objects are discarded and a fresh engine/history pair is built.
//   3. A refusal is whole-batch: unknown chain, changed rounds, a new round, a live
//      record, an undurable record, a planning child, a planning reference and a
//      continuation dependency all answer with their own code and write NOTHING —
//      asserted by comparing the history document byte for byte before and after.
//   4. Nothing outside the record is touched: the plan document, the settings
//      document, the session map and the worktree directory keep their bytes, and no
//      native agent or tool is created (counters stay at zero).
//   5. A failed write is reported as a failure, and the old records stay visible.
//
// No browser, no network, no native agent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { USER_PLANE_PREFIX, wrapUserPlaneRoutes, assertUserPlaneRoutes } from '../src/http/user-plane.js';
import { AuthorizationRegistry } from '../src/auth/grants.js';
import { SettingsService } from '../src/config/settings.js';
import { HistoryStore, HISTORY_CODES } from '../src/jobs/history.js';
import { JobEngine } from '../src/jobs/engine.js';
import { PlanStore } from '../src/jobs/plan-store.js';
import {
  CLEANUP_CODES,
  MAX_CLEANUP_CHAINS,
  cleanupOverview,
  runCleanup,
  validateCleanupRequest,
} from '../src/jobs/record-cleanup.js';
import { buildTaskTree } from '../src/jobs/task-tree.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import { fakeAgents, fakeGit, fakeLlm, fakeToolRegistry, validSettings } from './helpers/fakes.js';

const WORKSPACE = process.platform === 'win32' ? 'C:\\work\\cleanup' : '/work/cleanup';
const CONN = 'conn-cleanup-4f21ab90';

// ---------------------------------------------------------------------------
// Harness: real stores over a temporary data directory
// ---------------------------------------------------------------------------

/** @returns {Promise<string>} fresh data directory. */
async function dataDir() {
  return await mkdtemp(join(tmpdir(), 'dsh-cleanup-'));
}

/**
 * One stored public view shaped like the engine's own projection.
 *
 * `taskId` is the only field a test varies most of the time; everything else is a
 * complete, projectable record so `HistoryStore` accepts it exactly as it would an
 * engine write.
 * @param {string} taskId - task id.
 * @param {object} [overrides] - fields to replace.
 * @returns {object} view.
 */
function record(taskId, overrides = {}) {
  const createdAt = 1_700_000_000_000;
  return {
    taskId,
    state: 'awaiting-host-review',
    phase: 'awaiting-host-review',
    createdAt,
    startedAt: createdAt + 1000,
    endedAt: createdAt + 2000,
    title: `title of ${taskId}`,
    sourcePath: WORKSPACE,
    workspacePath: WORKSPACE,
    executionWorkspacePath: WORKSPACE,
    isolation: 'shared',
    connectionId: CONN,
    effective: {
      worker: {
        providerId: 'relay',
        model: 'deepseek-chat',
        reasoningEffort: 'medium',
        timeoutSeconds: 600,
        maxParallelism: 1,
        isolation: 'shared',
      },
      review: { enabled: false, providerId: null, model: null, reasoningEffort: null },
    },
    route: { providerId: 'relay', providerRoute: 'dsh-delegate:relay', model: 'deepseek-chat', reasoningEffort: 'medium' },
    reviewRoute: null,
    reviewRouteError: null,
    worktree: null,
    baseline: null,
    diff: null,
    execution: { workspacePath: WORKSPACE, outcome: 'completed', text: 'done', usage: null, error: null },
    review: { state: 'not_run', verdict: null, text: '', error: null },
    error: null,
    cancelledBy: null,
    hostAcceptance: null,
    ...overrides,
  };
}

/**
 * Build one dependency set over a data directory.
 *
 * The counters prove that cleanup creates no native work: `agents.create` is the
 * single point where an agent exists and every tool access goes through the scoped
 * registry, so both staying at zero is the direct evidence.
 * @param {string} dir - data directory.
 * @returns {Promise<object>} deps plus the stores and counters.
 */
async function buildDeps(dir) {
  const settings = new SettingsService(dir);
  await settings.replace(validSettings());
  const auth = new AuthorizationRegistry();
  const history = new HistoryStore(dir);
  const plans = new PlanStore(dir);
  const locks = new WorkspaceLocks();
  const counters = { agentCalls: 0, toolCalls: 0 };

  const agents = fakeAgents();
  const createAgent = agents.create;
  agents.create = async (...args) => {
    counters.agentCalls += 1;
    return await createAgent.apply(agents, args);
  };
  const tools = fakeToolRegistry({ global: ['read'] });
  const baseToolsFor = tools.toolsFor;
  tools.toolsFor = (...args) => {
    counters.toolCalls += 1;
    return baseToolsFor.apply(tools, args);
  };
  const engine = new JobEngine({
    agents,
    agentPresets: null,
    sessions: null,
    llm: fakeLlm({ providers: { relay: { 'deepseek-chat': ['low', 'medium', 'high'] } } }),
    tools,
    settings,
    auth,
    locks,
    runGit: fakeGit(),
    worktrees: null,
    history,
    plans,
    providerRegistry: null,
    allowLegacyProviderRoutes: true,
    authorizationMode: 'switch',
  });
  const deps = {
    settings,
    auth,
    engine,
    history,
    plans,
    llm: null,
    tools,
    locks,
    runGit: fakeGit(),
    logger: { warn() {}, info() {} },
    describeRuntime: () => ({ plugin: 'dsh-delegate' }),
  };
  return { deps, settings, auth, history, plans, engine, locks, counters };
}

/**
 * Tear down one deps set without the engine's five-second settle window.
 * @param {object} built - value of {@link buildDeps}.
 * @returns {Promise<void>} resolves after both stores are closed.
 */
async function teardown({ engine, history, plans }) {
  for (const task of engine.tasks.values()) {
    task.state = 'cancelled';
    task.phase = 'cancelled';
    task.endedAt = task.endedAt ?? Date.now();
    task.settle?.();
  }
  await engine.dispose();
  await history.dispose();
  await plans?.dispose?.();
}

/**
 * Dispatch one request through the validated route set.
 * @param {object} deps - dependency object.
 * @param {string} method - HTTP method.
 * @param {string} path - absolute path.
 * @param {object} [body] - JSON body.
 * @returns {Promise<{ status: number, body: object }>} parsed response.
 */
async function call(deps, method, path, body) {
  const routes = wrapUserPlaneRoutes(deps);
  const pathname = new URL(`http://127.0.0.1:3210${path}`).pathname;
  const route = routes.find((entry) => entry.path === pathname);
  assert.ok(route !== undefined, `no route for ${pathname}`);
  const response = await route.fetch(new Request(`http://127.0.0.1:3210${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  }));
  return { status: response.status, body: await response.json() };
}

/** The exact bytes of the history document, for "nothing was written" checks. */
async function historyBytes(dir) {
  return await readFile(join(dir, 'history.json'), 'utf8');
}

/** The chain ids and rounds a `/tasks` answer publishes, by chain id. */
function chainsOfTree(tree) {
  const out = new Map();
  const walk = (node) => {
    const chains = node?.kind === 'plan' ? (node.executions ?? []) : (node?.chain ? [node.chain] : []);
    for (const chain of chains) out.set(chain.chainId, chain);
    for (const child of Array.isArray(node?.children) ? node.children : []) walk(child);
  };
  for (const root of tree.roots) walk(root);
  return out;
}

/** Put one LIVE record into an engine under a chosen id (bypassing admission). */
function attachLiveTask(engine, { taskId, state = 'running', createdAt = 1_700_000_000_000 }) {
  // `createTask` mints its own `task-<uuid>` id and REGISTERS it. It must be removed
  // again or a throwaway record would sit in the engine under an id no assertion
  // mentions — it would appear in `/tasks`, change every count and, worse, make the
  // engine look like it holds a task nobody listed.
  const template = engine.createTask('a live prompt', 'task');
  engine.tasks.delete(template.taskId);
  const record = { ...template, taskId };
  engine.tasks.set(taskId, record);
  const task = engine.tasks.get(taskId);
  task.state = state;
  task.phase = state;
  task.connectionId = CONN;
  task.createdAt = createdAt;
  task.startedAt = createdAt + 5;
  task.endedAt = null;
  return task;
}

// ---------------------------------------------------------------------------
// 1. The primitive
// ---------------------------------------------------------------------------

test('HistoryStore.deleteMany removes one batch atomically and refuses anything that is not a stored finished record', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(record('task-a'));
    await store.save(record('task-b', { createdAt: 1_700_000_100_000 }));
    await store.save(record('task-live', { state: 'running', phase: 'execute', endedAt: null }));
    const before = await historyBytes(dir);

    // A live record is refused, and the whole batch with it: nothing is written.
    await assert.rejects(
      () => store.deleteMany(['task-a', 'task-live']),
      (error) => error.code === HISTORY_CODES.deleteInvalid && error.details.live.includes('task-live'),
    );
    assert.equal(await historyBytes(dir), before, 'a refused batch must not write one byte');

    // Unknown ids, duplicates and unbounded lists are refusals too.
    await assert.rejects(() => store.deleteMany(['task-a', 'task-ghost']), { code: HISTORY_CODES.deleteInvalid });
    await assert.rejects(() => store.deleteMany(['task-a', 'task-a']), { code: HISTORY_CODES.deleteInvalid });
    await assert.rejects(() => store.deleteMany([]), { code: HISTORY_CODES.deleteInvalid });
    await assert.rejects(() => store.deleteMany(undefined), { code: HISTORY_CODES.deleteInvalid });
    await assert.rejects(() => store.deleteMany(['task-a', 7]), { code: HISTORY_CODES.deleteInvalid });

    const outcome = await store.deleteMany(['task-a', 'task-b']);
    assert.deepEqual(outcome.deletedTaskIds, ['task-a', 'task-b']);
    assert.equal(outcome.remaining, 1);
    const left = await store.load();
    assert.deepEqual(left.map((row) => row.taskId), ['task-live'], 'only the live record remains');

    // The removal is durable: a fresh store over the same directory agrees.
    const reopened = new HistoryStore(dir);
    try {
      assert.deepEqual((await reopened.load()).map((row) => row.taskId), ['task-live']);
    } finally {
      await reopened.dispose();
    }
    await store.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Request validation
// ---------------------------------------------------------------------------

test('a cleanup request is a closed shape: unknown fields, a missing confirmation and an unbounded list are refused', () => {
  const ok = validateCleanupRequest({ confirm: true, chains: [{ chainId: 'task-a', taskIds: ['task-a'] }] });
  assert.deepEqual(ok.chains, [{ chainId: 'task-a', taskIds: ['task-a'] }]);

  for (const body of [
    null,
    'chains',
    { chains: [] },
    { chains: [{ chainId: 'task-a', taskIds: ['task-a'] }] },
    { confirm: true },
    { confirm: true, chains: [], since: 0 },
    { confirm: true, chains: [{ chainId: 'task-a', taskIds: ['task-a'], until: 1 }] },
    { confirm: false, chains: [{ chainId: 'task-a', taskIds: ['task-a'] }] },
    { confirm: true, chains: [{ chainId: 'task-a' }] },
    { confirm: true, chains: [{ chainId: '', taskIds: ['task-a'] }] },
    { confirm: true, chains: [{ chainId: 'task-a', taskIds: [] }] },
    { confirm: true, chains: [{ chainId: 'task-a', taskIds: [null] }] },
    { confirm: true, chains: [{ chainId: 'task-a', taskIds: ['a'], }, { chainId: 'task-a', taskIds: ['a'] }] },
    {
      confirm: true,
      chains: Array.from({ length: MAX_CLEANUP_CHAINS + 1 }, (_, index) => ({ chainId: `task-${index}`, taskIds: [`task-${index}`] })),
    },
  ]) {
    assert.throws(() => validateCleanupRequest(body), { code: CLEANUP_CODES.invalid }, JSON.stringify(body));
  }
});

// ---------------------------------------------------------------------------
// 3. Overview: eligibility comes from the unfiltered current records
// ---------------------------------------------------------------------------

test('the overview describes every chain of the unfiltered tree, and only finished durable chains are eligible', async () => {
  const dir = await dataDir();
  try {
    const built = await buildDeps(dir);
    await built.history.save(record('task-finished'));
    await built.history.save(record('task-orphan', { state: 'interrupted', phase: 'interrupted' }));
    attachLiveTask(built.engine, { taskId: 'task-live' });

    const overview = await cleanupOverview(built.deps);
    const byId = new Map(overview.chains.map((entry) => [entry.chainId, entry]));
    assert.equal(byId.get('task-finished').eligible, true, 'a finished durable chain is removable');
    assert.equal(byId.get('task-live').eligible, false);
    assert.ok(byId.get('task-live').blockers.includes(CLEANUP_CODES.live));
    assert.equal(byId.get('task-orphan').eligible, false);
    assert.ok(byId.get('task-orphan').blockers.includes(CLEANUP_CODES.live), 'an interrupted record never ended');

    // The same facts are published on the task list, per chain.
    const listed = await call(built.deps, 'GET', `${USER_PLANE_PREFIX}/tasks`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.tree.cleanupAvailable, true);
    const chains = chainsOfTree(listed.body.tree);
    assert.equal(chains.get('task-finished').cleanup.eligible, true);
    assert.deepEqual(chains.get('task-live').cleanup.blockers, [CLEANUP_CODES.live]);
    await teardown(built);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. The happy path, and the restart that proves it
// ---------------------------------------------------------------------------

test('a confirmed batch removes the selected chains and a restart no longer shows them', async () => {
  const dir = await dataDir();
  try {
    const built = await buildDeps(dir);
    // One two-round continuation chain and one unrelated finished task.
    await built.history.save(record('task-round-1', { createdAt: 1_700_000_100_000 }));
    await built.history.save(record('task-round-2', {
      createdAt: 1_700_000_200_000,
      continueFromTaskId: 'task-round-1',
      hostAcceptance: { accepted: true, state: 'accepted', decision: 'accepted', acceptedAt: 1_700_000_300_000, note: '已验收' },
    }));
    await built.history.save(record('task-keep', { createdAt: 1_700_000_400_000 }));

    const list = await call(built.deps, 'GET', `${USER_PLANE_PREFIX}/tasks`);
    const chain = chainsOfTree(list.body.tree).get('task-round-1');
    assert.deepEqual(chain.taskIds, ['task-round-1', 'task-round-2'], 'the chain names both rounds in order');

    const response = await call(built.deps, 'POST', `${USER_PLANE_PREFIX}/tasks/cleanup`, {
      confirm: true,
      chains: [{ chainId: 'task-round-1', taskIds: chain.taskIds }],
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.ok, true);
    assert.equal(response.body.chains, 1);
    assert.equal(response.body.tasks, 2);
    assert.deepEqual([...response.body.deletedTaskIds].sort(), ['task-round-1', 'task-round-2']);
    assert.deepEqual(response.body.retained, {
      sessions: true, workspaces: true, worktrees: true, sourceFiles: true, plans: true,
    });
    assert.equal(built.counters.agentCalls, 0, 'cleanup must not create an agent');
    assert.equal(built.counters.toolCalls, 0, 'cleanup must not call a tool');
    await teardown(built);

    // Restart: new stores over the same directory. The deleted records are gone and
    // cannot be queried back; the untouched one is still there.
    const restarted = await buildDeps(dir);
    const after = await call(restarted.deps, 'GET', `${USER_PLANE_PREFIX}/tasks`);
    const ids = after.body.tasks.map((task) => task.taskId).sort();
    assert.deepEqual(ids, ['task-keep']);
    const missing = await call(restarted.deps, 'POST', `${USER_PLANE_PREFIX}/tasks/get`, { taskId: 'task-round-2' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'JOB_TASK_NOT_FOUND');
    // …and the durable store itself agrees, so no cached copy can reappear.
    assert.deepEqual((await restarted.history.load()).map((row) => row.taskId), ['task-keep']);
    await teardown(restarted);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Refusals: whole batch, nothing written
// ---------------------------------------------------------------------------

test('unknown, stale, second-round, live and undurable selections are refused whole with nothing written', async () => {
  const dir = await dataDir();
  try {
    const built = await buildDeps(dir);
    await built.history.save(record('task-first', { createdAt: 1_700_000_100_000 }));
    await built.history.save(record('task-second', { createdAt: 1_700_000_200_000, continueFromTaskId: 'task-first' }));
    await built.history.save(record('task-solo', { createdAt: 1_700_000_300_000 }));
    attachLiveTask(built.engine, { taskId: 'task-live', state: 'running', createdAt: 1_700_000_400_000 });
    const before = await historyBytes(dir);

    const cases = [
      {
        name: 'unknown chain',
        chains: [{ chainId: 'task-ghost', taskIds: ['task-ghost'] }],
        code: CLEANUP_CODES.notFound,
        status: 404,
      },
      {
        name: 'a subset of the chain rounds',
        chains: [{ chainId: 'task-first', taskIds: ['task-first'] }],
        code: CLEANUP_CODES.stale,
        status: 409,
      },
      {
        name: 'a new round the page never saw',
        chains: [{ chainId: 'task-first', taskIds: ['task-first', 'task-second', 'task-third'] }],
        code: CLEANUP_CODES.stale,
        status: 409,
      },
      {
        name: 'a live record',
        chains: [{ chainId: 'task-live', taskIds: ['task-live'] }],
        code: CLEANUP_CODES.live,
        status: 409,
      },
      {
        name: 'one good chain plus one refused chain',
        chains: [
          { chainId: 'task-solo', taskIds: ['task-solo'] },
          { chainId: 'task-first', taskIds: ['task-first'] },
        ],
        code: CLEANUP_CODES.stale,
        status: 409,
      },
    ];
    for (const entry of cases) {
      const response = await call(built.deps, 'POST', `${USER_PLANE_PREFIX}/tasks/cleanup`, {
        confirm: true,
        chains: entry.chains,
      });
      assert.equal(response.status, entry.status, `${entry.name}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.ok, false, entry.name);
      assert.equal(response.body.error.code, entry.code, entry.name);
      assert.equal(response.body.error.details.deleted, 0, `${entry.name}: nothing may be deleted`);
      assert.equal(await historyBytes(dir), before, `${entry.name}: the document must be untouched`);
    }

    // The second round is reachable through the first chain, so it is removable only
    // as part of that chain; and the live record blocks nothing else.
    const good = await call(built.deps, 'POST', `${USER_PLANE_PREFIX}/tasks/cleanup`, {
      confirm: true,
      chains: [
        { chainId: 'task-first', taskIds: ['task-first', 'task-second'] },
        { chainId: 'task-solo', taskIds: ['task-solo'] },
      ],
    });
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.equal(good.body.chains, 2);
    assert.equal(good.body.tasks, 3);
    const remaining = (await built.history.load()).map((row) => row.taskId);
    assert.deepEqual(remaining, []);
    assert.equal(built.engine.get('task-live').state, 'running', 'the live record was never removable');
    await teardown(built);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a chain with an undurable round is refused instead of half-deleted', async () => {
  const dir = await dataDir();
  try {
    const built = await buildDeps(dir);
    await built.history.save(record('task-written', { createdAt: 1_700_000_100_000 }));
    // A live task that has not written a history row yet: it is durable-absent.
    const task = attachLiveTask(built.engine, { taskId: 'task-unwritten', state: 'awaiting-host-review', createdAt: 1_700_000_200_000 });
    task.endedAt = task.createdAt + 10;
    const before = await historyBytes(dir);

    const response = await call(built.deps, 'POST', `${USER_PLANE_PREFIX}/tasks/cleanup`, {
      confirm: true,
      chains: [{ chainId: 'task-unwritten', taskIds: ['task-unwritten'] }],
    });
    assert.equal(response.status, 409);
    // It is live in memory first, which is the stronger refusal; either way nothing
    // is written and the stored record is untouched.
    assert.ok([CLEANUP_CODES.live, CLEANUP_CODES.notDurable].includes(response.body.error.code), response.body.error.code);
    assert.equal(await historyBytes(dir), before);

    // Remove the live copy: now it exists neither in memory nor on disk, so it is
    // simply unknown rather than "deletable".
    built.engine.tasks.delete('task-unwritten');
    const second = await call(built.deps, 'POST', `${USER_PLANE_PREFIX}/tasks/cleanup`, {
      confirm: true,
      chains: [{ chainId: 'task-unwritten', taskIds: ['task-unwritten'] }],
    });
    assert.equal(second.status, 404);
    assert.equal(await historyBytes(dir), before);
    await teardown(built);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cleanup preserves the plan and refuses a chain with a child that depends on its record', async () => {
  const dir = await dataDir();
  try {
    const built = await buildDeps(dir);
    await built.plans.create({
      connectionId: 'local-mcp',
      nodes: [
        { key: 'goal', title: '总目标', sourcePath: WORKSPACE },
        { key: 'step-a', parentKey: 'goal', title: '子步骤 A' },
      ],
    });
    const nodes = await built.plans.load({});
    const goal = nodes.find((node) => node.title === '总目标');
    const step = nodes.find((node) => node.title === '子步骤 A');
    assert.ok(goal && step);

    await built.history.save(record('task-goal-run', { planNodeId: goal.nodeId }));
    await built.history.save(record('task-step-run', { planNodeId: step.nodeId, connectionId: 'local-mcp' }));
    const planned = await call(built.deps, 'POST', `${USER_PLANE_PREFIX}/tasks/cleanup`, {
      confirm: true,
      chains: [{ chainId: 'task-goal-run', taskIds: ['task-goal-run'] }],
    });
    assert.equal(planned.status, 200, JSON.stringify(planned.body));
    assert.deepEqual(await built.plans.load({}), nodes, 'the plan remains after its execution is removed');

    await built.plans.create({
      connectionId: 'local-mcp',
      parentNodeId: 'task-step-run',
      title: '挂在任务下的步骤',
    }, { resolveExternalParent: (...args) => built.engine.resolveHierarchyParentFacts(...args) });
    const before = await historyBytes(dir);
    const childBlocked = await call(built.deps, 'POST', `${USER_PLANE_PREFIX}/tasks/cleanup`, {
      confirm: true,
      chains: [{ chainId: 'task-step-run', taskIds: ['task-step-run'] }],
    });
    assert.equal(childBlocked.status, 409, JSON.stringify(childBlocked.body));
    assert.equal(childBlocked.body.error.code, CLEANUP_CODES.planChildren);
    assert.equal(await historyBytes(dir), before);
    await teardown(built);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Nothing else is touched
// ---------------------------------------------------------------------------

test('cleanup removes only history: plans, settings, session map and worktrees keep their bytes', async () => {
  const dir = await dataDir();
  try {
    const built = await buildDeps(dir);
    await built.plans.create({
      connectionId: 'local-mcp',
      nodes: [{ key: 'goal', title: '保持不变的规划' }],
    });
    await built.history.save(record('task-solo', { createdAt: 1_700_000_100_000 }));
    const settingsBefore = await readFile(join(dir, 'settings.json'), 'utf8');
    const plansBefore = await readFile(join(dir, 'plan.json'), 'utf8');

    const response = await call(built.deps, 'POST', `${USER_PLANE_PREFIX}/tasks/cleanup`, {
      confirm: true,
      chains: [{ chainId: 'task-solo', taskIds: ['task-solo'] }],
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    assert.equal(await readFile(join(dir, 'settings.json'), 'utf8'), settingsBefore, 'settings must not change');
    assert.equal(await readFile(join(dir, 'plan.json'), 'utf8'), plansBefore, 'the plan document must not change');
    // The plan is still readable and still names its node.
    const plans = await built.plans.load({});
    assert.equal(plans.length, 1);
    assert.equal(plans[0].title, '保持不变的规划');
    // Only history.json changed, and only by losing the record.
    const rows = await built.history.load();
    assert.deepEqual(rows, []);
    await teardown(built);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. A failed write is reported, and the record stays visible
// ---------------------------------------------------------------------------

test('a failing history write is reported as a failure and the old record stays visible and queryable', async () => {
  const dir = await dataDir();
  try {
    const built = await buildDeps(dir);
    await built.history.save(record('task-solo', { createdAt: 1_700_000_100_000 }));
    const before = await historyBytes(dir);

    // Make the document replacement fail exactly where a wedged filesystem would.
    const originalFs = built.history.fs;
    const realWrite = originalFs.writeFile;
    built.history.fs = {
      ...built.history.fs,
      writeFile: async (path, ...rest) => {
        if (String(path).endsWith('.tmp')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return await realWrite(path, ...rest);
      },
    };
    const response = await call(built.deps, 'POST', `${USER_PLANE_PREFIX}/tasks/cleanup`, {
      confirm: true,
      chains: [{ chainId: 'task-solo', taskIds: ['task-solo'] }],
    });
    assert.equal(response.status, 502, JSON.stringify(response.body));
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error.code, CLEANUP_CODES.failed);
    assert.equal(await historyBytes(dir), before, 'a failed write must leave the old document');

    // The record is still listed and still readable by id: nothing pretended to succeed.
    const list = await call(built.deps, 'GET', `${USER_PLANE_PREFIX}/tasks`);
    assert.ok(list.body.tasks.some((task) => task.taskId === 'task-solo'));
    const detail = await call(built.deps, 'POST', `${USER_PLANE_PREFIX}/tasks/get`, { taskId: 'task-solo' });
    assert.equal(detail.status, 200);

    // Once the write works again, the same request succeeds.
    built.history.fs = originalFs;
    const retry = await call(built.deps, 'POST', `${USER_PLANE_PREFIX}/tasks/cleanup`, {
      confirm: true,
      chains: [{ chainId: 'task-solo', taskIds: ['task-solo'] }],
    });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.deepEqual(await built.history.load(), []);
    await teardown(built);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a deployment without a durable store refuses instead of pretending to delete', async () => {
  const dir = await dataDir();
  try {
    // No history store at all: the surface must be a stated capability gap.
    await assert.rejects(
      () => runCleanup({ engine: null, plans: null }, { confirm: true, chains: [{ chainId: 't', taskIds: ['t'] }] }),
      { code: CLEANUP_CODES.unavailable },
    );
    // A refused document is a refusal too, never an empty success.
    await writeFile(join(dir, 'history.json'), '{ not json', 'utf8');
    const store = new HistoryStore(dir);
    await assert.rejects(() => runCleanup({ history: store }, { confirm: true, chains: [{ chainId: 't', taskIds: ['t'] }] }), {
      code: CLEANUP_CODES.unavailable,
    });
    assert.equal(await readFile(join(dir, 'history.json'), 'utf8'), '{ not json', 'a refused document is left as found');
    await store.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. Route set and reachability
// ---------------------------------------------------------------------------

test('the cleanup route is one POST on the user plane, and the execution plane gains no deletion', async () => {
  const dir = await dataDir();
  try {
    const built = await buildDeps(dir);
    const routes = wrapUserPlaneRoutes(built.deps);
    assertUserPlaneRoutes(routes);
    const cleanup = routes.filter((route) => route.path === `${USER_PLANE_PREFIX}/tasks/cleanup`);
    assert.equal(cleanup.length, 1);
    assert.deepEqual(cleanup[0].methods, ['POST']);
    assert.equal(cleanup[0].requestBody, 'buffered');

    // The task list still offers no deletion of its own: a GET cannot remove anything.
    await built.history.save(record('task-stays'));
    const before = await historyBytes(dir);
    const list = await call(built.deps, 'GET', `${USER_PLANE_PREFIX}/tasks/cleanup`);
    assert.ok(list.status >= 400 && list.status < 500);
    assert.equal(await historyBytes(dir), before);

    // The execution plane has no cleanup reach: its handler rejects an unknown path.
    let plane = null;
    try {
      plane = await import('../src/http/execution-plane.js');
    } catch {
      plane = null;
    }
    if (plane !== null) {
      const handler = plane.createExecutionHandler({ ...built.deps, getBindHost: () => '127.0.0.1' });
      assert.equal(typeof handler, 'function');
      const source = await readFile(new URL('../src/http/execution-plane.js', import.meta.url), 'utf8');
      assert.ok(!source.includes('tasks/cleanup'), 'the execution plane must not expose the cleanup route');
    }
    await teardown(built);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. The tree this module reads is the tree /tasks serves
// ---------------------------------------------------------------------------

test('the eligibility of a chain is computed from the same projection the list serves', async () => {
  const dir = await dataDir();
  try {
    const built = await buildDeps(dir);
    await built.history.save(record('task-a', { createdAt: 1_700_000_100_000 }));
    const listed = await call(built.deps, 'GET', `${USER_PLANE_PREFIX}/tasks`);
    const listedTree = listed.body.tree;
    const rows = await built.history.load();
    const direct = buildTaskTree({ planNodes: [], tasks: rows });
    const fromOverview = await cleanupOverview(built.deps);
    const listedChains = chainsOfTree(listedTree);
    assert.equal(fromOverview.chains.length, direct.counts.taskChains);
    for (const entry of fromOverview.chains) {
      assert.deepEqual(listedChains.get(entry.chainId).taskIds, entry.taskIds);
      assert.equal(listedChains.get(entry.chainId).cleanup.eligible, entry.eligible);
    }
    await teardown(built);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a finished record in the live engine cannot be reviewed or continued while it is being removed', { timeout: 10000 }, async () => {
  const dir = await dataDir();
  const built = await buildDeps(dir);
  const taskId = 'task-finished-live';
  const current = attachLiveTask(built.engine, { taskId, state: 'awaiting-host-review' });
  current.native.settled = true;
  current.endedAt = Date.now();
  current.settle();
  built.engine.setDelegationEnabled(true);
  const startedWrite = Promise.withResolvers();
  const finishWrite = Promise.withResolvers();
  let deletion;
  try {
    await built.history.save(record(taskId));
    const originalFs = built.history.fs;
    built.history.fs = {
      ...originalFs,
      async writeFile(...args) {
        startedWrite.resolve();
        await finishWrite.promise;
        return originalFs.writeFile(...args);
      },
    };
    deletion = runCleanup(built.deps, { confirm: true, chains: [{ chainId: taskId, taskIds: [taskId] }] });
    // Observe a rejection before waiting on the barrier, too.
    void deletion.catch(() => {});
    await Promise.race([startedWrite.promise, deletion.then(() => { throw new Error('write barrier not reached'); })]);
    assert.equal(built.engine.get(taskId).state, 'awaiting-host-review');
    await assert.rejects(built.engine.recordHostReview({
      taskId, connectionId: CONN, decision: 'accepted', note: 'concurrent review',
    }), { code: 'JOB_TASK_NOT_FOUND' });
    await assert.rejects(built.engine.recordHistoricalReview({ taskId, connectionId: CONN }, 'accepted', 'concurrent historical review'), {
      code: 'JOB_TASK_NOT_FOUND',
    });
    await assert.rejects(built.engine.start({
      prompt: 'continue while deletion writes', workspacePath: WORKSPACE, continueFromTaskId: taskId, connectionId: CONN,
    }), { code: 'JOB_TASK_NOT_FOUND' });
    const newPlan = built.plans.create({ connectionId: CONN, parentNodeId: taskId, title: 'Concurrent plan child' }, {
      resolveExternalParent: (...args) => built.engine.resolveHierarchyParentFacts(...args),
    });
    const planRefused = assert.rejects(newPlan, { code: 'PLAN_NODE_NOT_FOUND' });
    finishWrite.resolve();
    assert.deepEqual((await deletion).deletedTaskIds, [taskId]);
    await planRefused;
    assert.throws(() => built.engine.get(taskId), { code: 'JOB_TASK_NOT_FOUND' });
    assert.deepEqual(await new HistoryStore(dir).load(), []);
    assert.deepEqual(await built.plans.load(), []);
    assert.equal(built.counters.agentCalls, 0);
  } finally {
    finishWrite.resolve();
    await deletion?.catch(() => {});
    await teardown(built);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a continuation recorded ahead of a waiting delete invalidates the confirmed selection', { timeout: 10000 }, async () => {
  const dir = await dataDir();
  const built = await buildDeps(dir);
  const allowSave = Promise.withResolvers();
  let queued;
  let deletion;
  try {
    await built.history.save(record('task-base'));
    queued = built.history.enqueue(() => allowSave.promise);
    const followUp = built.history.save(record('task-late', { continueFromTaskId: 'task-base' }));
    deletion = runCleanup(built.deps, { confirm: true, chains: [{ chainId: 'task-base', taskIds: ['task-base'] }] });
    const refused = assert.rejects(deletion, { code: CLEANUP_CODES.stale });
    allowSave.resolve();
    await followUp;
    await refused;
    assert.deepEqual((await built.history.load()).map((row) => row.taskId).sort(), ['task-base', 'task-late']);
  } finally {
    allowSave.resolve();
    await queued;
    await deletion?.catch(() => {});
    await teardown(built);
    await rm(dir, { recursive: true, force: true });
  }
});
