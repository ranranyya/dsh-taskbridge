// G01 (remaining) + G09 data layer: durable planning nodes (`plan.json`), explicit
// parent-child hierarchy (`planNodeId` / `parentNodeId`), strict separation from
// `continueFromTaskId` rectification chains, same-name project/node isolation,
// legacy record compatibility, orphan retention and cycle breaking.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { JobEngine, JOB_CODES, TASK_STATES } from '../src/jobs/engine.js';
import { HISTORY_CODES, HistoryStore } from '../src/jobs/history.js';
import {
  MAX_PLAN_BATCH,
  MAX_PLAN_DEPTH,
  PLAN_CODES,
  PLAN_TITLE_MAX_CHARS,
  PlanStore,
} from '../src/jobs/plan-store.js';
import {
  UNVERIFIED_PROJECT_KEY,
  buildTaskTree,
  groupContinuationChains,
} from '../src/jobs/task-tree.js';
import { pathDigest } from '../src/jobs/continuation-identity.js';
import { SessionStore } from '../src/runtime/session-placement.js';
import { configureDelegatedSession } from '../src/runtime/sandbox.js';
import { SettingsService } from '../src/config/settings.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import { AuthorizationRegistry } from '../src/auth/grants.js';
import { createExecutionHandler, EXECUTION_PREFIX } from '../src/http/execution-plane.js';
import { USER_PLANE_PREFIX, wrapUserPlaneRoutes } from '../src/http/user-plane.js';
import { LATEST_PROTOCOL_VERSION, createMcpServer } from '../src/mcp/server.js';
import { createExecutionClient } from '../bin/dsh-delegate-mcp.js';
import { mockRequest, mockResponse } from './helpers/node-http-mocks.js';
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

const HEAD = 'c'.repeat(40);
const SECRET = 'sk-plan00000000000000000000';
let nextWsCounter = 0;

function fakeGitClean() {
  return async (_cwd, args) => {
    const key = args.join(' ');
    if (key === '--version') return { stdout: 'git version 2.40.0\n', code: 0 };
    if (key === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', code: 0 };
    if (key === 'rev-parse --verify HEAD') return { stdout: `${HEAD}\n`, code: 0 };
    if (args[0] === 'status') return { stdout: ' M src/feature.js\u0000', code: 0 };
    if (args[0] === 'diff' && args[1] === '--numstat') return { stdout: '3\t1\tsrc/feature.js\u0000', code: 0 };
    if (args[0] === 'diff') return { stdout: 'diff --git a/src/feature.js b/src/feature.js\n+ok\n', code: 0 };
    return { stdout: '', code: 0 };
  };
}

async function createFullHarness(options = {}) {
  const dir = options.dir ?? await makeTempDir();
  const dataPath = join(dir, 'data');
  await mkdir(dataPath, { recursive: true });

  let workspace = options.workspace ?? null;
  if (workspace === null) {
    const wsRoot = join(dir, `ws-${(nextWsCounter += 1)}`);
    await mkdir(wsRoot, { recursive: true });
    workspace = await realpath(wsRoot);
  }

  const settings = new SettingsService(dataPath);
  const existingSettings = options.keepSettings === true;
  if (!existingSettings) {
    const doc = validSettings();
    doc.worker.isolation = 'shared';
    await settings.replace(doc);
  }

  const history = new HistoryStore(dataPath, options.historyLimits ?? {});
  const plans = new PlanStore(dataPath, options.planLimits ?? {});
  const sessionStore = new SessionStore(dataPath);
  const workspaces = options.workspaces ?? fakeWorkspaceController();
  const sessionController = options.sessionController ?? fakeSessionController({
    workspaces,
    respond: { text: 'worker completed step' },
  });
  const services = await nativePolicyServices();

  const engine = new JobEngine({
    agents: fakeAgents({ respond: { text: 'worker completed step' } }),
    agentPresets: {
      async mount(ctx) {
        ctx.tools.schemas = () => [{ name: 'read', description: 'read', parameters: {} }];
        return { id: 'default-preset' };
      },
    },
    sessions: { async flush() {} },
    workspaces,
    sessionController,
    sessionStore,
    configureDelegatedSession,
    policyServices: () => services,
    llm: fakeLlm({ providers: { 'relay-native': llmTable().relay } }),
    settings,
    auth: new AuthorizationRegistry(),
    locks: new WorkspaceLocks(),
    runGit: fakeGitClean(),
    providerRegistry: {
      async ensure(providers) {
        return { routes: new Map(providers.map((p) => [p.id, `${p.id}-native`])) };
      },
    },
    history,
    plans,
    delegationEnabled: options.delegationEnabled ?? true,
    authorizationMode: 'switch',
    logger: { info() {}, warn() {} },
  });

  const deps = {
    settings,
    auth: engine.auth,
    engine,
    history,
    plans,
    runGit: fakeGitClean(),
    logger: { info() {}, warn() {} },
    describeRuntime: () => ({ plugin: 'dsh-taskbridge', version: '1.6.0' }),
  };

  const execHandler = createExecutionHandler({ ...deps, getBindHost: () => '127.0.0.1' });
  const userRoutes = wrapUserPlaneRoutes(deps);

  const callExecutionClient = createExecutionClient(
    { baseUrl: 'http://127.0.0.1:43210', discoveryFile: join(dataPath, 'unused.json'), timeoutMs: 10_000 },
    {
      fetch: async (url, init = {}) => {
        const parsed = new URL(url);
        const req = mockRequest({
          method: init.method ?? 'GET',
          url: `${parsed.pathname}${parsed.search}`,
          headers: { host: '127.0.0.1', ...(init.headers ?? {}) },
          body: typeof init.body === 'string' ? init.body : '',
        });
        const res = mockResponse();
        await execHandler(req, res);
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          json: async () => res.parsed(),
        };
      },
    },
  );
  const mcp = createMcpServer({ callExecution: callExecutionClient });
  await mcp.handle({
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: { protocolVersion: LATEST_PROTOCOL_VERSION },
  });

  return {
    dir,
    dataPath,
    workspace,
    workspaces,
    sessionController,
    settings,
    history,
    plans,
    sessionStore,
    engine,
    deps,
    execHandler,
    userRoutes,
    mcp,
    async callMcp(name, args = {}) {
      const reply = await mcp.handle({
        jsonrpc: '2.0',
        id: `call-${Date.now()}-${Math.random()}`,
        method: 'tools/call',
        params: { name, arguments: args },
      });
      const text = reply?.result?.content?.[0]?.text ?? '{}';
      return {
        isError: reply?.result?.isError === true,
        body: JSON.parse(text),
      };
    },
    async callUserTasks(query = '') {
      const route = userRoutes.find((r) => r.path === `${USER_PLANE_PREFIX}/tasks`);
      const resp = await route.fetch(new Request(`http://127.0.0.1:43210${USER_PLANE_PREFIX}/tasks${query}`, {
        method: 'GET',
      }));
      return { status: resp.status, body: await resp.json() };
    },
    async runTask(submitArgs) {
      const res = await this.callMcp('delegate_submit', {
        workspacePath: workspace,
        ...submitArgs,
      });
      assert.equal(res.isError, false, `submit failed: ${JSON.stringify(res.body)}`);
      const taskId = res.body.task.taskId;
      await engine.tasks.get(taskId).settled;
      await history.flush();
      await sessionStore.flush?.();
      return engine.get(taskId);
    },
    async stopRuntimeOnly() {
      await engine.dispose();
      await history.dispose();
      await plans.dispose();
      await sessionStore.dispose();
    },
    async close() {
      await this.stopRuntimeOnly();
      await cleanup(dir);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. PlanStore (`plan.json`): unexecuted nodes, atomic batch, bounds & review
// ---------------------------------------------------------------------------

test('PlanStore persists unexecuted multi-level nodes in deterministic order and reloads cleanly', async () => {
  const dir = await makeTempDir();
  try {
    const ws = process.platform === 'win32' ? 'C:\\repos\\auto-save' : '/repos/auto-save';
    const store = new PlanStore(dir);

    // Child appears BEFORE parent in the input array to prove topological batch ordering.
    const created = await store.create({
      connectionId: 'conn-1',
      workspacePath: ws,
      nodes: [
        { key: 'debounce', parentKey: 'logic', title: '防抖保存 🚀', goalDescription: '合并连续输入\n延后写入' },
        { key: 'root', title: '实现设置自动保存', goalDescription: '总目标：配置变更自动落盘并展示状态' },
        { key: 'logic', parentKey: 'root', title: '保存逻辑' },
        { key: 'err', parentKey: 'logic', title: '保存失败处理' },
        { key: 'ui', parentKey: 'root', title: '界面反馈' },
      ],
    });
    assert.equal(created.nodes.length, 5);
    const [debounce, root, logic, err, ui] = created.nodes;
    assert.match(root.nodeId, /^plan-/u);
    assert.equal(root.parentNodeId, null);
    assert.equal(logic.parentNodeId, root.nodeId);
    assert.equal(ui.parentNodeId, root.nodeId);
    assert.equal(debounce.parentNodeId, logic.nodeId);
    assert.equal(err.parentNodeId, logic.nodeId);
    assert.equal(debounce.sourcePathDigest, pathDigest(ws));

    await store.dispose();

    // Reload from disk in a brand-new PlanStore instance.
    const reloadedStore = new PlanStore(dir);
    const loaded = await reloadedStore.load({ connectionId: 'conn-1' });
    assert.equal(loaded.length, 5);

    const tree = buildTaskTree({ planNodes: loaded, tasks: [] });
    assert.equal(tree.counts.planNodes, 5);
    assert.equal(tree.counts.unexecutedPlanNodes, 5);
    assert.equal(tree.roots.length, 1);
    assert.equal(tree.roots[0].title, '实现设置自动保存');
    assert.equal(tree.roots[0].executed, false);
    assert.equal(tree.roots[0].nodeStatus, 'planned');
    assert.deepEqual(
      tree.roots[0].children.map((c) => c.title),
      ['保存逻辑', '界面反馈'],
      'sibling order follows commander batch sequence',
    );
    assert.deepEqual(
      tree.roots[0].children[0].children.map((c) => c.title),
      ['防抖保存 🚀', '保存失败处理'],
    );
    assert.equal(tree.roots[0].children[0].children[0].depth, 3);
    await reloadedStore.dispose();
  } finally {
    await cleanup(dir);
  }
});

test('PlanStore refuses batch cycles, bad titles, over-bound descriptions, source mismatches and preserves existing disk bytes', async () => {
  const dir = await makeTempDir();
  try {
    const wsA = process.platform === 'win32' ? 'C:\\repos\\alpha' : '/repos/alpha';
    const wsB = process.platform === 'win32' ? 'C:\\repos\\beta' : '/repos/beta';
    const store = new PlanStore(dir, { maxDepth: 3 });

    const seed = await store.create({
      connectionId: 'conn-1',
      workspacePath: wsA,
      title: '基线总目标',
      goalDescription: `包含密钥 ${SECRET} 的说明`,
    });
    assert.equal(seed.node.goalDescription.includes(SECRET), false, 'secrets are redacted before storage');
    const baselineBytes = await readFile(join(dir, 'plan.json'), 'utf8');
    assert.equal(baselineBytes.includes(SECRET), false);

    // 1. Batch cycle A -> B -> A refused atomically.
    await assert.rejects(
      store.create({
        connectionId: 'conn-1',
        nodes: [
          { key: 'a', parentKey: 'b', title: '节点A' },
          { key: 'b', parentKey: 'a', title: '节点B' },
        ],
      }),
      (err) => err?.code === PLAN_CODES.cycleDetected,
    );

    // 2. Self-cycle refused.
    await assert.rejects(
      store.create({
        connectionId: 'conn-1',
        nodes: [{ key: 'self', parentKey: 'self', title: '自环节点' }],
      }),
      (err) => err?.code === PLAN_CODES.cycleDetected,
    );

    // 3. Title > 120 code points refused; 120 emoji code points (240 UTF-16 units) accepted!
    await assert.rejects(
      store.create({ connectionId: 'conn-1', title: '字'.repeat(PLAN_TITLE_MAX_CHARS + 1) }),
      (err) => err?.code === PLAN_CODES.titleInvalid,
    );

    // 4. Description > 2000 code points refused.
    await assert.rejects(
      store.create({ connectionId: 'conn-1', title: '合法标题', goalDescription: '😀'.repeat(2001) }),
      (err) => err?.code === PLAN_CODES.descriptionInvalid,
    );

    // 5. Child workspacePath mismatching parent's source repository refused.
    await assert.rejects(
      store.create({
        connectionId: 'conn-1',
        parentNodeId: seed.node.nodeId,
        workspacePath: wsB,
        title: '跨仓库子任务',
      }),
      (err) => err?.code === PLAN_CODES.sourceMismatch,
    );

    // 6. Depth > maxDepth (3) refused.
    await assert.rejects(
      store.create({
        connectionId: 'conn-1',
        parentNodeId: seed.node.nodeId,
        nodes: [
          { key: 'lv2', title: '第二层' },
          { key: 'lv3', parentKey: 'lv2', title: '第三层' },
          { key: 'lv4', parentKey: 'lv3', title: '超深第四层' },
        ],
      }),
      (err) => err?.code === PLAN_CODES.depthExceeded,
    );

    // Verify all refused writes left `plan.json` byte-for-byte identical!
    assert.equal(await readFile(join(dir, 'plan.json'), 'utf8'), baselineBytes);

    // Cross-connection isolation: conn-2 sees nothing of conn-1's node.
    assert.equal(await store.get(seed.node.nodeId, 'conn-2'), null);
    await assert.rejects(
      store.update({ connectionId: 'conn-2', nodeId: seed.node.nodeId, title: '越权篡改' }),
      (err) => err?.code === PLAN_CODES.nodeNotFound,
    );

    await store.dispose();
  } finally {
    await cleanup(dir);
  }
});

test('PlanStore review supports changes-requested -> accepted progression, idempotent replay, and seals accepted nodes', async () => {
  const dir = await makeTempDir();
  try {
    const store = new PlanStore(dir);
    const { node } = await store.create({
      connectionId: 'conn-1',
      title: '多轮目标验收测试',
      goalDescription: '验证规划节点验收生命周期',
    });

    const first = await store.review({
      connectionId: 'conn-1',
      nodeId: node.nodeId,
      decision: 'changes-requested',
      note: '子任务尚缺边界测试',
      completionSummary: '已完成基础结构',
    });
    assert.equal(first.replayed, false);
    assert.equal(first.node.hostAcceptance.accepted, false);

    // Exact replay is idempotent.
    const replay1 = await store.review({
      connectionId: 'conn-1',
      nodeId: node.nodeId,
      decision: 'changes-requested',
      note: '子任务尚缺边界测试',
      completionSummary: '已完成基础结构',
    });
    assert.equal(replay1.replayed, true);

    // After fixes, commander records final acceptance on the plan node; prior round is retained in reviewHistory.
    const second = await store.review({
      connectionId: 'conn-1',
      nodeId: node.nodeId,
      decision: 'accepted',
      note: '所有子任务均已通过验收',
      completionSummary: '完整交付并持久化',
    });
    assert.equal(second.replayed, false);
    assert.equal(second.node.hostAcceptance.accepted, true);
    assert.equal(second.node.reviewHistory.length, 1);
    assert.equal(second.node.reviewHistory[0].decision, 'changes-requested');

    // Once accepted, any different review or metadata edit is refused!
    await assert.rejects(
      store.review({
        connectionId: 'conn-1',
        nodeId: node.nodeId,
        decision: 'changes-requested',
        note: '试图推翻已归档通过结论',
      }),
      (err) => err?.code === PLAN_CODES.reviewConflict,
    );
    await assert.rejects(
      store.update({
        connectionId: 'conn-1',
        nodeId: node.nodeId,
        title: '试图改名',
      }),
      (err) => err?.code === PLAN_CODES.reviewConflict,
    );

    await store.dispose();
  } finally {
    await cleanup(dir);
  }
});

test('PlanStore fails closed on malformed JSON or unsupported schemaVersion without overwriting the file', async () => {
  const dir = await makeTempDir();
  try {
    const planPath = join(dir, 'plan.json');
    const corrupt = '{"schemaVersion": 99, "nodes": []}\n';
    await writeFile(planPath, corrupt, 'utf8');

    const store = new PlanStore(dir);
    await assert.rejects(store.load(), (err) => err?.code === PLAN_CODES.schemaUnsupported);
    await assert.rejects(
      store.create({ connectionId: 'conn-1', title: '不会覆盖损坏文件' }),
      (err) => err?.code === PLAN_CODES.schemaUnsupported,
    );
    assert.equal(await readFile(planPath, 'utf8'), corrupt);
    await store.dispose();
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 2. Full MCP + Engine + HistoryStore + Restart End-to-End (A15, A16, A02)
// ---------------------------------------------------------------------------

test('A15 & A16: 3-level plan tree + 2-round subtask rectification + unexecuted node + legacy standalone task survive restart', async () => {
  const h = await createFullHarness();
  try {
    // 1. Commander creates 3-level goal breakdown via MCP `delegate_plan`.
    const planned = await h.callMcp('delegate_plan', {
      action: 'create',
      workspacePath: h.workspace,
      nodes: [
        { key: 'root', title: '实现设置自动保存', goalDescription: '总体目标：修改配置后自动保存并提示结果' },
        { key: 'logic', parentKey: 'root', title: '保存逻辑', goalDescription: '处理防抖与写入队列' },
        { key: 'debounce', parentKey: 'logic', title: '防抖保存', goalDescription: '合并300ms内连续输入' },
        { key: 'err-handle', parentKey: 'logic', title: '保存失败处理', goalDescription: '保留草稿并提示错误' },
        { key: 'ui', parentKey: 'root', title: '界面反馈', goalDescription: '展示保存中与已保存状态' },
      ],
    });
    assert.equal(planned.isError, false, JSON.stringify(planned.body));
    const [rootPlan, logicPlan, debouncePlan, errPlan, uiPlan] = planned.body.nodes;

    // 2. Execute leaf `debouncePlan` -> 1 round, accepted.
    const tDebounce = await h.runTask({
      title: '实现防抖保存函数',
      goalDescription: '完成防抖定时器与取消逻辑',
      planNodeId: debouncePlan.nodeId,
      prompt: 'implement debounce save',
    });
    assert.equal(tDebounce.planNodeId, debouncePlan.nodeId);
    const revDebounce = await h.callMcp('delegate_review', {
      taskId: tDebounce.taskId,
      decision: 'accepted',
      note: '防抖测试全部通过',
      completionSummary: '已实现300ms防抖合并写入',
    });
    assert.equal(revDebounce.isError, false);

    // 3. Execute sibling `uiPlan` -> starts a FRESH DSH Session, then 2 rectification rounds via `continueFromTaskId`!
    const tUiRound1 = await h.runTask({
      title: '界面保存状态条',
      goalDescription: '显示保存状态徽标',
      planNodeId: uiPlan.nodeId,
      prompt: 'implement ui status badge',
    });
    assert.notEqual(
      tUiRound1.execution.sessionId,
      tDebounce.execution.sessionId,
      'separate subtasks under the same goal tree ALWAYS open distinct DSH Sessions',
    );
    await h.callMcp('delegate_review', {
      taskId: tUiRound1.taskId,
      decision: 'changes-requested',
      note: '窄窗口下状态文字未对齐',
      completionSummary: '已完成基础徽标渲染',
    });

    // Round 2 (rectification 1) omits `planNodeId` and automatically inherits `uiPlan.nodeId` + same Session!
    const tUiRound2 = await h.runTask({
      title: '修正窄窗口状态条对齐',
      continueFromTaskId: tUiRound1.taskId,
      prompt: 'fix narrow layout alignment',
    });
    assert.equal(tUiRound2.execution.sessionId, tUiRound1.execution.sessionId, 'continuation reuses exact DSH Session');
    assert.equal(tUiRound2.planNodeId, uiPlan.nodeId, 'continuation inherits planNodeId automatically');
    await h.callMcp('delegate_review', {
      taskId: tUiRound2.taskId,
      decision: 'changes-requested',
      note: '还需补充无障碍 aria-live 属性',
    });

    // Round 3 (rectification 2) accepted!
    const tUiRound3 = await h.runTask({
      title: '补充状态条 aria-live',
      continueFromTaskId: tUiRound2.taskId,
      prompt: 'add aria-live polite',
    });
    assert.equal(tUiRound3.execution.sessionId, tUiRound1.execution.sessionId);
    assert.equal(tUiRound3.planNodeId, uiPlan.nodeId);
    await h.callMcp('delegate_review', {
      taskId: tUiRound3.taskId,
      decision: 'accepted',
      note: '窄窗口排版与无障碍属性均验证通过',
      completionSummary: '完成保存状态徽标、窄窗口换行与 aria-live 提示',
    });

    // 4. Legacy caller submits a standalone task with NO planNodeId and NO parentNodeId.
    const tLegacy = await h.runTask({
      title: '清理构建脚本注释',
      prompt: 'clean build script comment',
    });
    assert.equal(tLegacy.planNodeId, undefined);
    assert.equal(tLegacy.parentNodeId, undefined);

    // 5. Simulate full plugin restart: dispose runtime and construct fresh stores + engine on the same directory!
    const savedDir = h.dir;
    const savedWs = h.workspace;
    const savedWorkspaces = h.workspaces;
    const savedSessions = h.sessionController;
    await h.stopRuntimeOnly();

    const restarted = await createFullHarness({
      dir: savedDir,
      workspace: savedWs,
      workspaces: savedWorkspaces,
      sessionController: savedSessions,
      keepSettings: true,
    });
    try {
      const userResp = await restarted.callUserTasks();
      assert.equal(userResp.status, 200);
      assert.equal(userResp.body.plans.available, true);
      assert.equal(userResp.body.plans.count, 5);

      const tree = userResp.body.tree;
      assert.equal(tree.counts.planNodes, 5);
      assert.equal(tree.counts.taskRecords, 5);
      assert.equal(tree.counts.taskChains, 3, '5 task dispatches collapse into 3 logical chains (1 + 3-round + 1 legacy)');
      assert.equal(tree.counts.orphans, 0);
      assert.equal(tree.roots.length, 2, '1 root goal tree + 1 standalone legacy task');

      const goalRoot = tree.roots.find((r) => r.nodeId === rootPlan.nodeId);
      assert.ok(goalRoot !== undefined);
      assert.equal(goalRoot.title, '实现设置自动保存');
      assert.equal(goalRoot.executed, true);
      // `errPlan` is still unexecuted (`planned`), so `logicPlan` and `goalRoot` must NOT claim `accepted`!
      assert.notEqual(goalRoot.nodeStatus, 'accepted');

      const logicNode = goalRoot.children.find((c) => c.nodeId === logicPlan.nodeId);
      const debounceNode = logicNode.children.find((c) => c.nodeId === debouncePlan.nodeId);
      const errNode = logicNode.children.find((c) => c.nodeId === errPlan.nodeId);
      const uiNode = goalRoot.children.find((c) => c.nodeId === uiPlan.nodeId);

      assert.equal(debounceNode.executed, true);
      assert.equal(debounceNode.nodeStatus, 'accepted');
      assert.equal(debounceNode.executions[0].roundCount, 1);
      assert.equal(debounceNode.executions[0].completionSummary, '已实现300ms防抖合并写入');

      assert.equal(errNode.executed, false, 'unexecuted leaf stays unexecuted without fake task record');
      assert.equal(errNode.nodeStatus, 'planned');
      assert.equal(errNode.executions.length, 0);

      assert.equal(uiNode.executed, true);
      assert.equal(uiNode.nodeStatus, 'accepted');
      assert.equal(uiNode.executions.length, 1);
      assert.equal(uiNode.executions[0].roundCount, 3, 'initial run + 2 rectifications = 3 rounds on one node');
      assert.deepEqual(
        uiNode.executions[0].taskIds,
        [tUiRound1.taskId, tUiRound2.taskId, tUiRound3.taskId],
      );

      const standaloneNode = tree.roots.find((r) => r.nodeId === tLegacy.taskId);
      assert.ok(standaloneNode !== undefined);
      assert.equal(standaloneNode.kind, 'task');
      assert.equal(standaloneNode.standalone, true);

      // MCP `delegate_plan` get & list also report accurate post-restart facts.
      const mcpGet = await restarted.callMcp('delegate_plan', { action: 'get', nodeId: uiPlan.nodeId });
      assert.equal(mcpGet.isError, false);
      assert.equal(mcpGet.body.treeNode.executions[0].roundCount, 3);
    } finally {
      await restarted.close();
    }
  } catch (err) {
    await h.close().catch(() => {});
    throw err;
  }
});

test('Engine enforces hierarchy boundaries: continuation cannot switch nodes, mismatched repo refuses, switch gate holds', async () => {
  const h = await createFullHarness();
  try {
    const otherWsDir = join(h.dir, 'other-repo');
    await mkdir(otherWsDir, { recursive: true });
    const otherWs = await realpath(otherWsDir);

    const created = await h.callMcp('delegate_plan', {
      action: 'create',
      workspacePath: h.workspace,
      nodes: [
        { key: 'root', title: '主目标' },
        { key: 'sub1', parentKey: 'root', title: '子任务一' },
        { key: 'sub2', parentKey: 'root', title: '子任务二' },
      ],
    });
    const [root, sub1, sub2] = created.body.nodes;

    const t1 = await h.runTask({
      title: '执行子任务一',
      planNodeId: sub1.nodeId,
      prompt: 'do sub1',
    });

    // 1. Attempting to use `continueFromTaskId: t1.taskId` while switching `planNodeId` to `sub2.nodeId` MUST refuse!
    const hijackAttempt = await h.callMcp('delegate_submit', {
      workspacePath: h.workspace,
      title: '错误混用续接与新子任务',
      continueFromTaskId: t1.taskId,
      planNodeId: sub2.nodeId,
      prompt: 'do sub2 on sub1 session',
    });
    assert.equal(hijackAttempt.isError, true);
    assert.equal(hijackAttempt.body.error.code, JOB_CODES.planContinuationConflict);

    // 2. Conflicting `planNodeId` + `parentNodeId` refuses!
    const conflictAttempt = await h.callMcp('delegate_submit', {
      workspacePath: h.workspace,
      title: '父节点冲突',
      planNodeId: sub2.nodeId,
      parentNodeId: sub1.nodeId,
      prompt: 'conflict',
    });
    assert.equal(conflictAttempt.isError, true);
    assert.equal(conflictAttempt.body.error.code, JOB_CODES.planRefConflict);

    // 3. Cross-repository `planNodeId` refuses!
    const wrongRepoAttempt = await h.callMcp('delegate_submit', {
      workspacePath: otherWs,
      title: '跨仓库混挂',
      planNodeId: sub2.nodeId,
      prompt: 'wrong repo',
    });
    assert.equal(wrongRepoAttempt.isError, true);
    assert.equal(wrongRepoAttempt.body.error.code, JOB_CODES.planSourceMismatch);

    // 4. Direct `parentNodeId` under `root` without pre-creating a leaf plan node works cleanly!
    const tDirectChild = await h.runTask({
      title: '直接挂载的子任务三',
      parentNodeId: root.nodeId,
      prompt: 'do direct child',
    });
    assert.equal(tDirectChild.parentNodeId, root.nodeId);

    // 5. Turning delegation switch OFF blocks `delegate_plan` create/update, while allowing get/list/review!
    h.engine.setDelegationEnabled(false);
    const blockedCreate = await h.callMcp('delegate_plan', {
      action: 'create',
      title: '开关关闭时禁止新建规划',
    });
    assert.equal(blockedCreate.isError, true);
    assert.equal(blockedCreate.body.error.code, 'DELEGATION_DISABLED');

    const allowedList = await h.callMcp('delegate_plan', { action: 'list' });
    assert.equal(allowedList.isError, false);
    assert.equal(allowedList.body.nodes.length, 3);

    const allowedReview = await h.callMcp('delegate_plan', {
      action: 'review',
      nodeId: root.nodeId,
      decision: 'changes-requested',
      note: '开关关闭后仍可记录规划审查结论',
    });
    assert.equal(allowedReview.isError, false);
    assert.equal(allowedReview.body.node.hostAcceptance.decision, 'changes-requested');
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Same-name projects/nodes, legacy records, HistoryStore protection, orphans & cycles
// ---------------------------------------------------------------------------

test('A01, A03, A06, A07: same-name projects and tasks stay separate, worktrees group by SOURCE, orphans and cycles never drop or guess', () => {
  const repoA = process.platform === 'win32' ? 'C:\\org-one\\portal' : '/org-one/portal';
  const repoB = process.platform === 'win32' ? 'D:\\org-two\\portal' : '/org-two/portal';
  const digestA = pathDigest(repoA);
  const digestB = pathDigest(repoB);

  const planNodes = [
    // Corrupted 2-node parent cycle on disk: cyc1 <-> cyc2 (must break cleanly, never infinite-loop!)
    {
      nodeId: 'plan-cyc-1',
      parentNodeId: 'plan-cyc-2',
      title: '环路节点1',
      sourcePath: repoA,
      sourcePathDigest: digestA,
      sequence: 1,
      createdAt: 1000,
      updatedAt: 1000,
    },
    {
      nodeId: 'plan-cyc-2',
      parentNodeId: 'plan-cyc-1',
      title: '环路节点2',
      sourcePath: repoA,
      sourcePathDigest: digestA,
      sequence: 2,
      createdAt: 2000,
      updatedAt: 2000,
    },
    // Orphan plan node referencing a missing parent
    {
      nodeId: 'plan-orphan',
      parentNodeId: 'plan-evicted-999',
      title: '孤儿规划节点',
      sourcePath: repoB,
      sourcePathDigest: digestB,
      sequence: 3,
      createdAt: 3000,
      updatedAt: 3000,
    },
  ];

  const tasks = [
    // Two isolated worktree executions of `repoA` with IDENTICAL titles ("修复登录") and NO continuation link!
    {
      taskId: 'task-wt-1',
      state: 'awaiting-host-review',
      title: '修复登录',
      sourcePath: repoA,
      sourcePathDigest: digestA,
      executionWorkspacePath: `${repoA}-worktree-1`,
      createdAt: 4000,
    },
    {
      taskId: 'task-wt-2',
      state: 'awaiting-host-review',
      title: '修复登录',
      sourcePath: repoA,
      sourcePathDigest: digestA,
      executionWorkspacePath: `${repoA}-worktree-2`,
      createdAt: 5000,
    },
    // Same project folder basename (`portal`) at `repoB`, ALSO titled "修复登录"!
    {
      taskId: 'task-repo-b',
      state: 'awaiting-host-review',
      title: '修复登录',
      sourcePath: repoB,
      sourcePathDigest: digestB,
      executionWorkspacePath: repoB,
      createdAt: 6000,
    },
    // Legacy task missing both `title` and usable source path (masked without digest) + evicted continuation target!
    {
      taskId: 'task-legacy-notitle',
      state: 'awaiting-host-review',
      continueFromTaskId: 'task-rotated-out',
      sourcePath: 'C:\\Users\\masks-user-profile-segment\\mystery',
      sourcePathDigest: null,
      review: { text: '审查文字绝不能被拿去编造任务标题' },
      createdAt: 7000,
    },
    // Task referencing a missing `planNodeId`
    {
      taskId: 'task-missing-plan',
      state: 'failed',
      title: '缺失规划引用的执行任务',
      planNodeId: 'plan-deleted-404',
      sourcePath: repoA,
      sourcePathDigest: digestA,
      createdAt: 8000,
    },
    // Corrupted continuation cycle between two tasks: task-c1 <-> task-c2
    {
      taskId: 'task-c1',
      state: 'failed',
      title: '续接环A',
      continueFromTaskId: 'task-c2',
      sourcePath: repoA,
      sourcePathDigest: digestA,
      createdAt: 9000,
    },
    {
      taskId: 'task-c2',
      state: 'awaiting-host-review',
      title: '续接环B',
      continueFromTaskId: 'task-c1',
      sourcePath: repoA,
      sourcePathDigest: digestA,
      createdAt: 9500,
    },
  ];

  const chains = groupContinuationChains(tasks);
  // 2 same-name tasks in repoA + 1 in repoB + 1 legacy + 1 missing-plan + 1 broken continuation cycle (2 tasks) = 6 chains
  assert.equal(chains.length, 6);

  const legacyChain = chains.find((c) => c.rootTaskId === 'task-legacy-notitle');
  assert.equal(legacyChain.title, null, 'missing title stays null, never fabricated');
  assert.equal(legacyChain.titleMissing, true);
  assert.match(legacyChain.displayTitle, /^未记录标题/u);
  assert.deepEqual(legacyChain.brokenContinuation, {
    missingTaskId: 'task-rotated-out',
    reason: 'missing-task',
  });

  const cycleChain = chains.find((c) => c.taskIds.includes('task-c1'));
  assert.deepEqual(cycleChain.taskIds, ['task-c1', 'task-c2']);
  assert.equal(cycleChain.brokenContinuation?.reason, 'cycle-broken');

  const tree = buildTaskTree({ planNodes, tasks });
  // Every structural item is preserved: 3 plan nodes + 6 task nodes = 9 flatNodes!
  assert.equal(tree.flatNodes.length, 9);

  // Verify cycle between plan-cyc-1 and plan-cyc-2 was broken deterministically:
  // plan-cyc-1 becomes root with cycle-broken marker, plan-cyc-2 remains its child!
  const cyc1 = tree.roots.find((n) => n.nodeId === 'plan-cyc-1');
  assert.ok(cyc1 !== undefined);
  assert.deepEqual(cyc1.orphan, {
    isOrphan: true,
    kind: 'cycle-broken',
    cycleParentId: 'plan-cyc-2',
  });
  assert.equal(cyc1.children.length, 1);
  assert.equal(cyc1.children[0].nodeId, 'plan-cyc-2');

  // Verify missing-parent and missing-plan-node orphans are retained at root with explicit reasons:
  const orphanPlan = tree.roots.find((n) => n.nodeId === 'plan-orphan');
  assert.deepEqual(orphanPlan.orphan, {
    isOrphan: true,
    kind: 'missing-parent',
    missingParentId: 'plan-evicted-999',
  });
  const orphanTask = tree.roots.find((n) => n.nodeId === 'task-missing-plan');
  assert.deepEqual(orphanTask.orphan, {
    isOrphan: true,
    kind: 'missing-plan-node',
    missingNodeId: 'plan-deleted-404',
  });

  // Verify same-name tasks ("修复登录") were NOT merged!
  const loginNodes = tree.roots.filter((n) => n.title === '修复登录');
  assert.equal(loginNodes.length, 3, 'three independent tasks sharing the same title stay three separate nodes');

  // Verify project grouping: two distinct `portal` projects (disambiguated shortPath) + 1 `unverified` bucket!
  assert.equal(tree.projects.length, 3);
  const portalProjects = tree.projects.filter((p) => p.name === 'portal');
  assert.equal(portalProjects.length, 2, 'two same-named repositories at different paths stay distinct');
  assert.notEqual(portalProjects[0].projectKey, portalProjects[1].projectKey);
  assert.notEqual(portalProjects[0].shortPath, portalProjects[1].shortPath);
  const projectA = tree.projects.find((p) => p.projectKey === digestA);
  assert.ok(projectA.rootNodeIds.includes('task-wt-1') && projectA.rootNodeIds.includes('task-wt-2'),
    'two isolated worktrees from repoA group into the single verified repoA project');
  const unverified = tree.projects.find((p) => p.projectKey === UNVERIFIED_PROJECT_KEY);
  assert.equal(unverified.unverified, true);
  assert.deepEqual(unverified.rootNodeIds, ['task-legacy-notitle']);
});

test('HistoryStore preserves saved planNodeId and parentNodeId across partial saves and refuses conflicting replacements', async () => {
  const dir = await makeTempDir();
  try {
    const store = new HistoryStore(dir);
    await store.save({
      taskId: 'task-hier-1',
      state: 'running',
      phase: 'execute',
      planNodeId: 'plan-leaf-1',
      parentNodeId: 'plan-root-1',
      goalDescription: '初始目标',
      createdAt: 1000,
      sourcePath: 'C:\\repo',
      connectionId: 'local-mcp',
    });

    // Partial terminal snapshot omitting `planNodeId` and `parentNodeId` retains both!
    const merged = await store.save({
      taskId: 'task-hier-1',
      state: 'awaiting-host-review',
      phase: 'awaiting-host-review',
      createdAt: 1000,
      endedAt: 2000,
      sourcePath: 'C:\\repo',
      connectionId: 'local-mcp',
    });
    assert.equal(merged.planNodeId, 'plan-leaf-1');
    assert.equal(merged.parentNodeId, 'plan-root-1');
    assert.equal(merged.goalDescription, '初始目标');

    // Conflicting `planNodeId` on upsert or update is refused!
    await assert.rejects(
      store.save({
        taskId: 'task-hier-1',
        state: 'awaiting-host-review',
        planNodeId: 'plan-different',
        createdAt: 1000,
        endedAt: 2000,
      }),
      (err) => err?.code === HISTORY_CODES.viewInvalid,
    );
    await assert.rejects(
      store.update('task-hier-1', (row) => {
        delete row.planNodeId;
        return row;
      }),
      (err) => err?.code === HISTORY_CODES.viewInvalid,
    );

    await store.dispose();
  } finally {
    await cleanup(dir);
  }
});
