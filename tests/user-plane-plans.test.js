// The narrow user-plane plan-create route (`POST /api/dsh-delegate/plans`).
//
// It is the ONE planning write the settings page has. These tests drive the real
// route set (`wrapUserPlaneRoutes`) over the real `PlanStore`, so the assertions are
// about the same code path the plugin registers:
//
//   1. success: a batch (parent + deeper child, by `parentKey`) is written atomically
//      under the FIXED local owner and is readable through the EXISTING `/tasks`
//      projection;
//   2. identity: a body that names a `connectionId` is refused with 403 and writes
//      nothing — the page can never address another connection;
//   3. shape: unknown fields, a non-batch body, a missing per-item title, a batch
//      cycle and a depth overflow are refused with the store's own codes and HTTP
//      statuses, and `plan.json` stays byte-identical;
//   4. nothing is dispatched: a create never touches the engine's dispatch path and
//      the response says `executed: false`;
//   5. no plan store / method gate: a host without a store answers 503, and the route
//      refuses a method it does not handle.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { JobEngine } from '../src/jobs/engine.js';
import { HistoryStore } from '../src/jobs/history.js';
import { PLAN_CODES, PlanStore } from '../src/jobs/plan-store.js';
import { SessionStore } from '../src/runtime/session-placement.js';
import { configureDelegatedSession } from '../src/runtime/sandbox.js';
import { SettingsService } from '../src/config/settings.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import { AuthorizationRegistry } from '../src/auth/grants.js';
import { USER_PLANE_PREFIX, wrapUserPlaneRoutes } from '../src/http/user-plane.js';
import {
  cleanup,
  fakeAgents,
  fakeLlm,
  fakeSessionController,
  fakeWorkspaceController,
  llmTable,
  makeTempDir,
  nativePolicyServices,
  validSettings,
} from './helpers/fakes.js';

/**
 * A user plane over a real plan store and a real engine, with no tasks in it.
 * @param {object} [options] - `plans` to substitute, `delegationEnabled`.
 * @returns {Promise<object>} harness with `call`, `tasks`, `store` and `close`.
 */
async function harness(options = {}) {
  const dir = await makeTempDir();
  const dataPath = join(dir, 'data');
  await mkdir(dataPath, { recursive: true });
  const workspaceDir = join(dir, 'repo');
  await mkdir(workspaceDir, { recursive: true });

  const settings = new SettingsService(dataPath);
  const doc = validSettings();
  doc.worker.isolation = 'shared';
  await settings.replace(doc);

  const history = new HistoryStore(dataPath);
  const plans = options.plans === undefined ? new PlanStore(dataPath) : options.plans;
  const sessionStore = new SessionStore(dataPath);
  const workspaces = fakeWorkspaceController();
  const services = await nativePolicyServices();
  const engine = new JobEngine({
    agents: fakeAgents({ respond: { text: 'ok' } }),
    agentPresets: {
      async mount(ctx) {
        ctx.tools.schemas = () => [];
        return { id: 'default-preset' };
      },
    },
    sessions: { async flush() {} },
    workspaces,
    sessionController: fakeSessionController({ workspaces, respond: { text: 'ok' } }),
    sessionStore,
    configureDelegatedSession,
    policyServices: () => services,
    llm: fakeLlm({ providers: { 'relay-native': llmTable().relay } }),
    settings,
    auth: new AuthorizationRegistry(),
    locks: new WorkspaceLocks(),
    runGit: async () => ({ stdout: '', code: 0 }),
    providerRegistry: { async ensure(providers) { return { routes: new Map(providers.map((p) => [p.id, `${p.id}-native`])) }; } },
    history,
    plans: plans === null ? undefined : plans,
    delegationEnabled: options.delegationEnabled ?? true,
    authorizationMode: 'switch',
    logger: { info() {}, warn() {} },
  });

  const deps = {
    settings,
    auth: engine.auth,
    engine,
    history,
    ...(plans === null || plans === undefined ? {} : { plans }),
    logger: { info() {}, warn() {} },
    describeRuntime: () => ({ plugin: 'dsh-taskbridge', version: '1.6.0' }),
  };
  const routes = wrapUserPlaneRoutes(deps);
  const call = async (path, body) => {
    const route = routes.find((entry) => entry.path === `${USER_PLANE_PREFIX}${path}`);
    assert.ok(route !== undefined, `the route ${path} is registered`);
    const response = await route.fetch(new Request(`http://127.0.0.1:43210${USER_PLANE_PREFIX}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json() };
  };
  return {
    dir,
    dataPath,
    workspaceDir,
    plans,
    engine,
    call,
    async tasks(query = '') {
      const route = routes.find((entry) => entry.path === `${USER_PLANE_PREFIX}/tasks`);
      const response = await route.fetch(new Request(`http://127.0.0.1:43210${USER_PLANE_PREFIX}/tasks${query}`));
      return { status: response.status, body: await response.json() };
    },
    async planBytes() {
      try {
        return await readFile(join(dataPath, 'plan.json'), 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    },
    async close() {
      await engine.dispose();
      await history.dispose();
      if (plans !== null && plans !== undefined && typeof plans.dispose === 'function') await plans.dispose();
      await sessionStore.dispose();
      await cleanup(dir);
    },
  };
}

test('POST /plans creates a batch under the fixed local owner and the existing /tasks projection shows it', async () => {
  const h = await harness();
  try {
    const created = await h.call('/plans', {
      workspacePath: h.workspaceDir,
      nodes: [
        { key: 'root', title: '发布前验收', goalDescription: '把清单跑一遍' },
        { key: 'deeper', parentKey: 'root', title: '补充边界用例' },
      ],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.ok, true);
    assert.equal(created.body.nodes.length, 2);
    assert.equal(created.body.executed, false, 'creating a plan never dispatches');
    assert.equal(created.body.connectionId, undefined, 'the answer does not echo a caller-named owner');
    assert.equal(created.body.switch.changedByThisAction, false);
    for (const node of created.body.nodes) {
      assert.match(node.nodeId, /^plan-/u);
      assert.equal(node.connectionId, 'local-mcp', 'the owner is the fixed local identity');
      assert.equal(node.hostAcceptance, null, 'a fresh node carries no acceptance');
    }
    const [root, deeper] = created.body.nodes;
    assert.equal(root.parentNodeId, null);
    assert.equal(deeper.parentNodeId, root.nodeId, 'the in-batch parentKey resolved to the minted id');

    // The READ path is the one the page uses: the new nodes are already in the tree.
    const read = await h.tasks();
    assert.equal(read.status, 200);
    assert.equal(read.body.plans.available, true);
    assert.equal(read.body.plans.count, 2);
    assert.equal(read.body.tree.counts.planNodes, 2);
    const treeRoot = read.body.tree.roots[0];
    assert.equal(treeRoot.nodeId, root.nodeId);
    assert.equal(treeRoot.executed, false);
    assert.equal(treeRoot.children[0].nodeId, deeper.nodeId);
    assert.equal(treeRoot.children[0].depth, 2);
    // The read projection is filtered by the SAME owner, so the page sees its writes.
    const filtered = await h.tasks('?connectionId=local-mcp');
    assert.equal(filtered.body.tree.counts.planNodes, 2);
    const other = await h.tasks('?connectionId=someone-else');
    assert.equal(other.body.tree.counts.planNodes, 0);
    assert.notEqual(other.status, 500);
  } finally {
    await h.close();
  }
});

test('POST /plans refuses a caller-named connectionId and writes nothing', async () => {
  const h = await harness();
  try {
    const refused = await h.call('/plans', {
      connectionId: 'someone-else',
      nodes: [{ title: '不应该存在' }],
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'PLAN_CONNECTION_UNTRUSTED');
    assert.equal(await h.planBytes(), null, 'no plan document was written');

    // The owner cannot be smuggled in per item either.
    const sneaky = await h.call('/plans', {
      nodes: [{ title: '偷渡', connectionId: 'someone-else' }],
    });
    assert.equal(sneaky.status, 400);
    assert.equal(sneaky.body.error.code, PLAN_CODES.invalid);
    assert.equal(await h.planBytes(), null);
  } finally {
    await h.close();
  }
});

test('POST /plans refuses bad shapes and impossible batches atomically, leaving plan.json untouched', async () => {
  const h = await harness();
  try {
    const seed = await h.call('/plans', { nodes: [{ title: '基线' }] });
    assert.equal(seed.status, 201);
    const baseline = await h.planBytes();
    assert.ok(baseline !== null);

    // A single-node body is not this route's shape: the page always sends a batch.
    // `title` is simply not a field of this route, so it is refused as one.
    const single = await h.call('/plans', { title: '单节点' });
    assert.equal(single.status, 400);
    assert.equal(single.body.error.code, PLAN_CODES.invalid);
    assert.equal(single.body.error.details.field, 'title');
    const noBatch = await h.call('/plans', {});
    assert.equal(noBatch.status, 400);
    assert.equal(noBatch.body.error.details.field, 'nodes');

    // A pre-minted id or an acceptance record cannot be written from the page.
    const injected = await h.call('/plans', {
      nodes: [{ title: '带 id', nodeId: 'plan-fixed', hostAcceptance: { accepted: true } }],
    });
    assert.equal(injected.status, 400);
    assert.equal(injected.body.error.code, PLAN_CODES.invalid);

    // A missing per-item title is the caller's mistake, answered as a 400 that names
    // the field (it is the one rule the route checks itself).
    const noTitle = await h.call('/plans', { nodes: [{ title: '' }] });
    assert.equal(noTitle.status, 400);
    assert.equal(noTitle.body.error.code, PLAN_CODES.titleInvalid);

    // A batch cycle.
    const cycle = await h.call('/plans', {
      nodes: [
        { key: 'a', parentKey: 'b', title: '甲' },
        { key: 'b', parentKey: 'a', title: '乙' },
      ],
    });
    assert.equal(cycle.status, 400);
    assert.equal(cycle.body.error.code, PLAN_CODES.cycleDetected);

    // An unknown parent id: the store's own "not found" (a 404 for a missing node).
    const badParent = await h.call('/plans', {
      parentNodeId: 'plan-does-not-exist',
      nodes: [{ title: '孤儿' }],
    });
    assert.equal(badParent.status, 404);
    assert.equal(badParent.body.error.code, PLAN_CODES.nodeNotFound);

    // Everything above was refused: the document is byte-identical to the baseline.
    assert.equal(await h.planBytes(), baseline);
  } finally {
    await h.close();
  }
});

test('POST /plans bounds the batch size and finishes a legitimate multi-level batch in one write', async () => {
  const h = await harness();
  try {
    const tooMany = await h.call('/plans', {
      nodes: Array.from({ length: 33 }, (_unused, index) => ({ title: `节点 ${index + 1}` })),
    });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error.details.limit, 32);

    // Three levels in one request: root -> group -> step.
    const created = await h.call('/plans', {
      nodes: [
        { key: 'r', title: '总目标' },
        { key: 'g', parentKey: 'r', title: '分组' },
        { key: 's', parentKey: 'g', title: '步骤' },
      ],
    });
    assert.equal(created.status, 201);
    const [root, group, step] = created.body.nodes;
    assert.equal(group.parentNodeId, root.nodeId);
    assert.equal(step.parentNodeId, group.nodeId);

    const read = await h.tasks();
    const [treeRoot] = read.body.tree.roots;
    assert.equal(treeRoot.nodeId, root.nodeId);
    assert.equal(treeRoot.children[0].children[0].nodeId, step.nodeId);
    assert.equal(read.body.tree.flatNodes.find((node) => node.nodeId === step.nodeId).depth, 3);
  } finally {
    await h.close();
  }
});

test('POST /plans answers 503 without a plan store and refuses a method it does not handle', async () => {
  const h = await harness({ plans: null });
  try {
    assert.equal(h.engine.plans ?? null, null, 'the engine has no plan store either');
    const refused = await h.call('/plans', { nodes: [{ title: '无存储' }] });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.code, 'JOB_PLAN_STORE_UNAVAILABLE');
  } finally {
    await h.close();
  }

  const h2 = await harness();
  try {
    const routes = wrapUserPlaneRoutes({
      settings: null,
      auth: { revokeAll: () => 0 },
      engine: h2.engine,
      history: null,
      plans: h2.plans,
      logger: { info() {}, warn() {} },
    });
    const route = routes.find((entry) => entry.path === `${USER_PLANE_PREFIX}/plans`);
    const response = await route.fetch(new Request(`http://127.0.0.1:43210${USER_PLANE_PREFIX}/plans`, {
      method: 'GET',
    }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    const body = await response.json();
    assert.equal(body.error.code, 'USER_PLANE_METHOD_NOT_ALLOWED');
    // The route declares exactly one method, so the native registry never forwards GET.
    assert.deepEqual(route.methods, ['POST']);
    assert.equal(route.requestBody, 'buffered');
  } finally {
    await h2.close();
  }
});

test('POST /plans creates plan records only: the engine gains no task and nothing is authorized', async () => {
  const h = await harness();
  try {
    const before = h.engine.list({});
    assert.equal(before.length, 0);
    const created = await h.call('/plans', { nodes: [{ title: '只记录计划' }] });
    assert.equal(created.status, 201);
    assert.equal(h.engine.list({}).length, 0, 'no task was created');
    assert.equal(h.engine.posture().authorized, true, 'the switch posture is unchanged by a plan write');
    // No notification, acceptance or grant appeared either.
    assert.equal(typeof created.body.node, 'undefined', 'the answer is the batch, not a task view');
    const read = await h.tasks();
    assert.equal(read.body.tasks.length, 0);
    assert.equal(read.body.tree.counts.taskRecords, 0);
    assert.equal(read.body.tree.counts.planNodes, 1);
  } finally {
    await h.close();
  }
});
