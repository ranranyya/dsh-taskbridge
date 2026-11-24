// End-to-end and contract tests for 1.9.0-test6 enhancements:
//   1. Multi-stage isolated worktree reuse (`reuseWorktreeFromTaskId`) with fresh DSH Sessions
//   2. Per-call approvals for legacy preview scope inputs
//   3. MCP round-trip compression (`delegate_submit` `autoPreflight`/`wait`, `delegate_result` `includeDiff: false`)
//   4. Usage receipt delta & cumulative counters across continuations
//   5. Worker prompt hygiene (no `.cache/` temp log creation) & anti-fuzzing layered rules + test5 upgrade hash

import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Session, SessionId } from '@deepseek-ai/dsh-session';

import { JobEngine, JOB_CODES } from '../src/jobs/engine.js';
import { HistoryStore } from '../src/jobs/history.js';
import { PlanStore } from '../src/jobs/plan-store.js';
import { CLEANUP_CODES, cleanupOverview, runCleanup, runOrphanCleanup } from '../src/jobs/record-cleanup.js';
import { WorktreeManager } from '../src/workspace/worktrees.js';
import { createGitRunner } from '../src/workspace/audit.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import { AuthorizationRegistry } from '../src/auth/grants.js';
import { SettingsService } from '../src/config/settings.js';
import { SessionStore } from '../src/runtime/session-placement.js';
import { PermissionBridge, PERMISSION_CODES } from '../src/runtime/permissions.js';
import { buildWorkerPrompt } from '../src/runtime/worker-prompt.js';
import { createMcpServer } from '../src/mcp/server.js';
import { KNOWN_SKILL_TEMPLATES } from '../src/codex/installer.js';
import { readAntigravityStatus, useDirectoryClassifier } from '../src/antigravity/installer.js';
import { codexRuleText } from './helpers/codex-rule-files.js';
import {
  cleanup,
  fakeAgents,
  fakeAgentPresets,
  fakeLlm,
  fakeSessionController,
  fakeToolRegistry,
  fakeWorkspaceController,
  makeTempDir,
  nativePolicyServices,
  validSettings,
} from './helpers/fakes.js';

async function initGitRepo(dir) {
  const git = createGitRunner({ timeoutMs: 20000 });
  const exec = async (args) => {
    const res = await git(dir, args);
    assert.equal(res.code, 0, `git ${args.join(' ')}: ${res.stderr}`);
  };
  await exec(['init', '-q', '.']);
  await writeFile(join(dir, 'README.md'), '# test6 fixture\n');
  await exec(['add', 'README.md']);
  await exec([
    '-c', 'user.name=TaskBridge Test',
    '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '-qm', 'initial commit',
  ]);
  return git;
}

async function createWorktreeEngineFixture({ onTurn, wrapSettings }) {
  const root = await makeTempDir();
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const sourceDir = join(root, 'repo');
  await mkdir(sourceDir, { recursive: true });
  const sourcePath = await realpath(sourceDir);
  const runGit = await initGitRepo(sourcePath);
  const worktrees = new WorktreeManager({ runGit }, { rootDir: join(root, 'trees') });
  const settings = new SettingsService(dataDir);
  await settings.replace(validSettings({ worker: { isolation: 'worktree', maxParallelism: 2 } }));
  const engineSettings = typeof wrapSettings === 'function' ? wrapSettings(settings) : settings;
  const auth = new AuthorizationRegistry();
  const history = new HistoryStore(dataDir);
  const plans = new PlanStore(dataDir);
  const sessionStore = new SessionStore(dataDir);
  const workspaces = fakeWorkspaceController();
  const baseSessions = fakeSessionController({ workspaces });
  const sessionController = {
    ...baseSessions,
    async resolveAgent(sessionId) {
      const resolved = await baseSessions.resolveAgent(sessionId);
      if (resolved.agent && !resolved.agent._test6Wrapped) {
        resolved.agent._test6Wrapped = true;
        const agent = resolved.agent;
        agent.followup = (message) => {
          agent.followups.push(message);
          agent.turns.push(message);
          agent.idle = false;
          const emit = (event) => {
            for (const entry of agent.listeners) {
              if (entry.event === 'session/event') entry.listener({ id: agent.session.id }, event);
            }
          };
          const cwd = baseSessions.sessions.get(sessionId)?.cwd ?? agent.session.header?.cwd;
          const out = onTurn({ cwd, sessionId, message }) ?? { text: 'done' };
          emit({
            type: 'assistant/message',
            data: {
              message: { content: [{ type: 'text', text: out.text ?? 'done' }] },
              ...(out.usage === undefined ? {} : { usage: out.usage }),
            },
          });
          emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
          agent.idle = true;
          for (const waiter of agent.idleWaiters.splice(0)) waiter();
        };
      }
      return resolved;
    },
  };
  const defaultPolicyServices = await nativePolicyServices();
  const llm = fakeLlm({ providers: { relay: { 'deepseek-chat': ['low', 'medium', 'high'] } } });
  const agents = fakeAgents({ respond: { text: 'unused' } });
  const presets = fakeAgentPresets();
  const tools = fakeToolRegistry({ global: ['read'] });
  const engine = new JobEngine({
    authorizationMode: 'switch',
    allowLegacyProviderRoutes: true,
    settings: engineSettings,
    auth,
    history,
    plans,
    locks: new WorkspaceLocks(),
    worktrees,
    sessionStore,
    runGit,
    llm,
    tools,
    agents,
    agentPresets: presets,
    sessions: { async flush() {} },
    workspaces,
    sessionController,
    policyServices: () => defaultPolicyServices,
  });
  engine.setDelegationEnabled(true);
  async function waitReady(taskId, connectionId = 'local-mcp') {
    const obs = await engine.observeTask(taskId, { connectionId, waitMs: 10_000 });
    const record = engine.tasks.get(taskId);
    if (record?.settled !== undefined) await record.settled;
    return engine.get(taskId, { connectionId }) ?? obs.task;
  }
  return { root, sourcePath, runGit, worktrees, settings, history, plans, sessionStore, workspaces, sessionController, engine, waitReady };
}

test('reuseWorktreeFromTaskId reuses upstream isolated worktree with a fresh DSH Session and keeps source clean', async () => {
  let callIndex = 0;
  const fx = await createWorktreeEngineFixture({
    onTurn: ({ cwd }) => {
      callIndex += 1;
      if (callIndex === 1) {
        writeFileSync(join(cwd, 'domain1.js'), 'export const d1 = 1;\n');
        return { text: 'domain 1 done', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
      }
      const upstream = readFileSync(join(cwd, 'domain1.js'), 'utf8');
      assert.match(upstream, /d1 = 1/u, 'downstream subtask must see upstream worktree file');
      writeFileSync(join(cwd, 'domain2.js'), 'export const d2 = 2;\n');
      return { text: 'domain 2 done', usage: { inputTokens: 80, outputTokens: 15, totalTokens: 95 } };
    },
  });
  try {
    const plan = await fx.plans.create({
      connectionId: 'local-mcp',
      workspacePath: fx.sourcePath,
      nodes: [
        { key: 'root', title: 'Multi-stage goal' },
        { key: 'd1', title: 'Domain 1', parentKey: 'root' },
        { key: 'd2', title: 'Domain 2', parentKey: 'root' },
      ],
    });
    const d1Node = plan.nodes.find((n) => n.title === 'Domain 1');
    const d2Node = plan.nodes.find((n) => n.title === 'Domain 2');

    const t1 = await fx.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fx.sourcePath,
      title: 'Domain 1',
      prompt: 'Build Domain 1',
      planNodeId: d1Node.nodeId,
    });
    const done1 = await fx.waitReady(t1.taskId);
    assert.equal(done1.state, 'awaiting-host-review');
    assert.equal(done1.isolation, 'worktree');
    assert.notEqual(done1.executionWorkspacePath, fx.sourcePath);

    await fx.engine.recordHostReview({
      connectionId: 'local-mcp',
      taskId: done1.taskId,
      decision: 'accepted',
      note: 'Domain 1 accepted',
    });

    const t2 = await fx.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fx.sourcePath,
      title: 'Domain 2',
      prompt: 'Build Domain 2 on top of Domain 1',
      planNodeId: d2Node.nodeId,
      reuseWorktreeFromTaskId: done1.taskId,
    });
    const done2 = await fx.waitReady(t2.taskId);
    assert.equal(done2.state, 'awaiting-host-review');
    assert.equal(done2.isolation, 'worktree');
    assert.equal(done2.executionWorkspacePath, done1.executionWorkspacePath);
    assert.equal(done2.worktree.reused, true);
    assert.equal(done2.reuseWorktreeFromTaskId, done1.taskId);
    assert.equal(done2.planNodeId, d2Node.nodeId);
    assert.equal(done2.conversation.kind, 'new', 'must start a fresh DSH Session');
    assert.equal(done2.conversation.reused, false);
    assert.notEqual(done2.conversation.sessionId, done1.conversation.sessionId);

    // Source checkout remains completely clean.
    const status = await fx.runGit(fx.sourcePath, ['status', '--porcelain']);
    assert.equal(status.stdout.trim(), '');

    // Refuses combining continueFromTaskId and reuseWorktreeFromTaskId.
    await assert.rejects(() => fx.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fx.sourcePath,
      prompt: 'conflict',
      continueFromTaskId: done1.taskId,
      reuseWorktreeFromTaskId: done1.taskId,
    }), { code: JOB_CODES.isolationRefused });

    // Refuses overrides.isolation: 'shared' with reuseWorktreeFromTaskId.
    await assert.rejects(() => fx.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fx.sourcePath,
      prompt: 'bad isolation',
      reuseWorktreeFromTaskId: done1.taskId,
      overrides: { isolation: 'shared' },
    }), { code: JOB_CODES.isolationRefused });

    // Refuses unknown task id and foreign-owned durable task identically as absent (never an existence oracle).
    await assert.rejects(() => fx.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fx.sourcePath,
      prompt: 'unknown upstream',
      reuseWorktreeFromTaskId: 'task-does-not-exist',
    }), { code: JOB_CODES.taskNotFound });
    await fx.history.save({
      ...done1,
      taskId: 'task-foreign-owned',
      connectionId: 'other-connection',
    });
    await assert.rejects(() => fx.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fx.sourcePath,
      prompt: 'foreign upstream',
      reuseWorktreeFromTaskId: 'task-foreign-owned',
    }), { code: JOB_CODES.taskNotFound });

    // Linked cleanup of task 1 while task 2 still references the shared worktree preserves the worktree.
    await fx.engine.recordHostReview({
      connectionId: 'local-mcp',
      taskId: done2.taskId,
      decision: 'accepted',
      note: 'Domain 2 accepted',
    });
    const cleanup1 = await runCleanup({
      engine: fx.engine,
      history: fx.history,
      plans: fx.plans,
      worktrees: fx.worktrees,
      sessionStore: fx.sessionStore,
    }, {
      confirm: true,
      removeWorktrees: true,
      chains: [{ chainId: done1.taskId, taskIds: [done1.taskId] }],
    });
    assert.equal(cleanup1.tasks, 1);
    assert.deepEqual(cleanup1.cleaned.removedWorktreePaths, [], 'worktree stays while task 2 references it');
    assert.equal(await readFile(join(done2.executionWorkspacePath, 'domain2.js'), 'utf8'), 'export const d2 = 2;\n');
  } finally {
    await fx.engine.dispose();
    await cleanup(fx.root);
  }
});

test('linked and orphan cleanup protect a worktree selected by a pending reuseWorktreeFromTaskId task', async () => {
  let pauseNextSettingsRead = false;
  let pausedResolve;
  let resumeGateResolve;
  const paused = new Promise((resolve) => { pausedResolve = resolve; });
  const resumeGate = new Promise((resolve) => { resumeGateResolve = resolve; });

  let turn = 0;
  const fx = await createWorktreeEngineFixture({
    wrapSettings: (settings) => ({
      async read() {
        if (pauseNextSettingsRead) {
          pauseNextSettingsRead = false;
          pausedResolve();
          await resumeGate;
        }
        return await settings.read();
      },
    }),
    onTurn: ({ cwd }) => {
      turn += 1;
      if (turn === 1) {
        writeFileSync(join(cwd, 'upstream.txt'), 'stage-1\n');
        return { text: 'stage 1 done' };
      }
      assert.equal(readFileSync(join(cwd, 'upstream.txt'), 'utf8'), 'stage-1\n');
      writeFileSync(join(cwd, 'downstream.txt'), 'stage-2\n');
      return { text: 'stage 2 done' };
    },
  });
  try {
    const t1 = await fx.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fx.sourcePath,
      prompt: 'Stage 1',
    });
    const done1 = await fx.waitReady(t1.taskId);
    assert.equal(done1.state, 'awaiting-host-review');
    assert.equal(done1.isolation, 'worktree');

    // Start downstream task and pause right after assertWorktreeReuse (at settings.read).
    pauseNextSettingsRead = true;
    const t2Start = fx.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fx.sourcePath,
      prompt: 'Stage 2',
      reuseWorktreeFromTaskId: done1.taskId,
    });
    await paused;

    const deps = {
      engine: fx.engine,
      history: fx.history,
      plans: fx.plans,
      worktrees: fx.worktrees,
      sessionStore: fx.sessionStore,
    };
    const overview = await cleanupOverview(deps);
    const chain1 = overview.chains.find((entry) => entry.chainId === done1.taskId);
    assert.equal(chain1.eligible, false);
    assert.ok(chain1.blockers.includes(CLEANUP_CODES.hierarchyChildren));

    // Linked cleanup of upstream task must be refused while downstream is pending.
    await assert.rejects(() => runCleanup(deps, {
      confirm: true,
      removeWorktrees: true,
      chains: [{ chainId: done1.taskId, taskIds: [done1.taskId] }],
    }), { code: CLEANUP_CODES.hierarchyChildren });
    await access(done1.executionWorkspacePath);

    // Orphan cleanup while downstream is pending must also keep the selected worktree intact.
    const orphanRes = await runOrphanCleanup(deps, { confirm: true, removeWorktrees: true });
    assert.deepEqual(orphanRes.cleaned.removedWorktreePaths, []);
    await access(done1.executionWorkspacePath);

    // Downstream resumes and completes cleanly inside the preserved worktree.
    resumeGateResolve();
    const t2 = await t2Start;
    const done2 = await fx.waitReady(t2.taskId);
    assert.equal(done2.state, 'awaiting-host-review');
    assert.equal(done2.executionWorkspacePath, done1.executionWorkspacePath);
    assert.equal(await readFile(join(done2.executionWorkspacePath, 'downstream.txt'), 'utf8'), 'stage-2\n');

    // Once downstream has finished, cleaning upstream record succeeds while preserving shared worktree.
    const cleanupAfter = await runCleanup(deps, {
      confirm: true,
      removeWorktrees: true,
      chains: [{ chainId: done1.taskId, taskIds: [done1.taskId] }],
    });
    assert.equal(cleanupAfter.tasks, 1);
    assert.deepEqual(cleanupAfter.cleaned.removedWorktreePaths, []);
    await access(done2.executionWorkspacePath);
  } finally {
    resumeGateResolve();
    await fx.engine.dispose();
    await cleanup(fx.root);
  }
});

test('orphan cleanup protects upstream session, workspace, and worktree claimed by a pending continueFromTaskId task', async () => {
  let pauseNextSettingsRead = false;
  let pausedResolve;
  let resumeGateResolve;
  const paused = new Promise((resolve) => { pausedResolve = resolve; });
  const resumeGate = new Promise((resolve) => { resumeGateResolve = resolve; });

  const fx = await createWorktreeEngineFixture({
    wrapSettings: (settings) => ({
      async read() {
        if (pauseNextSettingsRead) {
          pauseNextSettingsRead = false;
          pausedResolve();
          await resumeGate;
        }
        return await settings.read();
      },
    }),
    onTurn: ({ cwd }) => {
      writeFileSync(join(cwd, 'cont.txt'), 'ok\n');
      return { text: 'continuation ok' };
    },
  });
  try {
    const t1 = await fx.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fx.sourcePath,
      prompt: 'Round 1',
    });
    const done1 = await fx.waitReady(t1.taskId);
    assert.equal(done1.state, 'awaiting-host-review');
    assert.equal(done1.isolation, 'worktree');
    const upstreamSessionId = done1.conversation.sessionId;
    const upstreamWorkspaceId = done1.conversation.workspaceId;

    // Start continuation and pause right after assertContinuation (at settings.read).
    pauseNextSettingsRead = true;
    const t2Start = fx.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fx.sourcePath,
      prompt: 'Round 2',
      continueFromTaskId: done1.taskId,
    });
    await paused;

    // Simulate upstream record being rotated out of history and pruned from memory while its
    // sessionStore entry remains.
    await fx.history.deleteMany([done1.taskId]);
    fx.engine.tasks.delete(done1.taskId);

    const archivedCalls = [];
    const deletedWorkspaces = [];
    const orphanRes = await runOrphanCleanup({
      engine: fx.engine,
      history: fx.history,
      plans: fx.plans,
      worktrees: fx.worktrees,
      sessionStore: fx.sessionStore,
      workspaces: {
        async archiveSession(id) { archivedCalls.push(id); },
        async delete(id) { deletedWorkspaces.push(id); },
      },
    }, { confirm: true, archiveSessions: true, removeWorktrees: true });

    assert.equal(orphanRes.orphanSessionsForgotten, 0);
    assert.deepEqual(orphanRes.cleaned.archivedSessionIds, []);
    assert.deepEqual(orphanRes.cleaned.removedWorkspaceIds, []);
    assert.deepEqual(orphanRes.cleaned.removedWorktreePaths, []);
    assert.deepEqual(archivedCalls, []);
    assert.deepEqual(deletedWorkspaces, []);
    assert.ok((await fx.sessionStore.get(done1.taskId)) !== null);
    await access(done1.executionWorkspacePath);

    // Resuming the continuation completes cleanly on the preserved session and worktree.
    resumeGateResolve();
    const t2 = await t2Start;
    const done2 = await fx.waitReady(t2.taskId);
    assert.equal(done2.state, 'awaiting-host-review');
    assert.equal(done2.conversation.sessionId, upstreamSessionId);
    assert.equal(done2.conversation.workspaceId, upstreamWorkspaceId);
    assert.equal(done2.executionWorkspacePath, done1.executionWorkspacePath);
  } finally {
    resumeGateResolve();
    await fx.engine.dispose();
    await cleanup(fx.root);
  }
});

test('usage receipt reports delta and cumulative counters on fresh runs and continuations without redaction loss', async () => {
  let round = 0;
  const fx = await createWorktreeEngineFixture({
    onTurn: () => {
      round += 1;
      if (round === 1) {
        return {
          text: 'round 1',
          usage: { inputTokens: 3094, outputTokens: 1122, totalTokens: 52984, reasoningTokens: 400 },
        };
      }
      // Mimics DSH behavior: totalTokens accumulates across the session while last-turn inputTokens can be smaller.
      return {
        text: 'round 2',
        usage: { inputTokens: 2452, outputTokens: 1246, totalTokens: 163186, reasoningTokens: 900 },
      };
    },
  });
  try {
    const t1 = await fx.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fx.sourcePath,
      prompt: 'Round 1',
    });
    const done1 = await fx.waitReady(t1.taskId);
    assert.deepEqual(done1.execution.usage.delta, {
      inputTokens: 3094, outputTokens: 1122, totalTokens: 52984, reasoningTokens: 400,
    });
    assert.deepEqual(done1.execution.usage.cumulative, {
      inputTokens: 3094, outputTokens: 1122, totalTokens: 52984, reasoningTokens: 400,
    });

    const t2 = await fx.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fx.sourcePath,
      prompt: 'Round 2 follow-up',
      continueFromTaskId: done1.taskId,
    });
    const done2 = await fx.waitReady(t2.taskId);
    assert.equal(done2.execution.usage.totalTokens, 163186);
    assert.deepEqual(done2.execution.usage.cumulative, {
      inputTokens: 2452, outputTokens: 1246, totalTokens: 163186, reasoningTokens: 900,
    });
    assert.deepEqual(done2.execution.usage.delta, {
      inputTokens: 2452,
      outputTokens: 124,
      totalTokens: 110202,
      reasoningTokens: 500,
    });

    // Survives durable HistoryStore reload intact.
    const rows = await fx.history.load();
    const stored2 = rows.find((r) => r.taskId === done2.taskId);
    assert.deepEqual(stored2.execution.usage.delta, done2.execution.usage.delta);
    assert.deepEqual(stored2.execution.usage.cumulative, done2.execution.usage.cumulative);
  } finally {
    await fx.engine.dispose();
    await cleanup(fx.root);
  }
});

test('a preview task-command approval is single-use, including for identical overwriting calls', async () => {
  const cwd = process.platform === 'win32' ? 'C:\\work\\fixture' : '/work/fixture';
  const sessionId = SessionId('session-preview-permission');
  const session = Session.create(sessionId, [], {
    version: 4,
    id: sessionId,
    createdAt: Date.now(),
    cwd,
    isSeeded: false,
  });
  const agent = { id: 'agent-permission', session };
  const pendingEvents = [];
  const bridge = new PermissionBridge({
    taskId: 'task-preview-permission',
    connectionId: 'local-mcp',
    onPending: (view) => pendingEvents.push(view),
  });
  bridge.arm(agent);

  const ask = (turn, command) => {
    const callId = `call-${turn}`;
    session.append('turn/start', { turn });
    session.append('tool/call', {
      turn,
      step: 1,
      callId,
      name: 'shell',
      arguments: JSON.stringify({ command, cwd }),
    });
    return bridge.answer({ agent, toolName: 'shell', callId, reason: 'fixture approval only' });
  };
  const closeTurn = (turn) => session.append('turn/end', { turn, reason: 'stop' });

  try {
    const command = 'Copy-Item fixture.txt copied.txt -Force';
    const first = ask(1, command);
    const initial = bridge.pendingView();
    assert.throws(() => bridge.decide({
      requestId: initial.requestId,
      decision: 'allow-once',
      scope: 'task-command',
      fingerprint: 'wrong-fingerprint',
    }), { code: PERMISSION_CODES.changed });
    const receipt = bridge.decide({
      requestId: initial.requestId,
      decision: 'allow-once',
      scope: 'task-command',
      fingerprint: initial.fingerprint,
    });
    assert.equal(await first, 'allowed-once');
    assert.equal(receipt.verified.scope, 'once');
    assert.equal(receipt.grant.reusable, false);
    closeTurn(1);

    const repeat = ask(2, command);
    assert.equal(pendingEvents.length, 2);
    const next = bridge.pendingView();
    assert.notEqual(next.requestId, initial.requestId);
    assert.equal(next.fingerprint, initial.fingerprint);
    bridge.decide({ requestId: next.requestId, decision: 'reject' });
    assert.equal(await repeat, 'rejected');
    closeTurn(2);
  } finally {
    bridge.dispose();
  }
});

test('MCP delegate_submit supports autoPreflight + wait, preserves submitReceipt on waitError, and delegate_result supports includeDiff: false', async () => {
  const calls = [];
  let observeMode = 'ready';
  let preflightIso = 'worktree';
  const server = createMcpServer({
    callExecution: async (route, payload) => {
      calls.push({ route, payload });
      if (route === 'preflight') {
        return { ok: true, isolation: preflightIso, reason: preflightIso === 'block' ? 'PREFLIGHT_NO_COMMITS' : 'PREFLIGHT_CLEAN_REPOSITORY' };
      }
      if (route === 'submit') {
        return {
          ok: true,
          task: {
            taskId: 'task-mcp-1',
            state: 'pending',
            sourcePath: payload.workspacePath,
            executionWorkspacePath: '/trees/task-mcp-1',
            isolation: payload.overrides?.isolation ?? 'worktree',
            worktree: { reused: Boolean(payload.reuseWorktreeFromTaskId) },
            ...(payload.reuseWorktreeFromTaskId ? { reuseWorktreeFromTaskId: payload.reuseWorktreeFromTaskId } : {}),
            agentTeams: false,
            agentTeamsOrigin: 'settings-default',
          },
        };
      }
      if (route === 'observe') {
        if (observeMode === 'fail') {
          const err = new Error('transient disconnect');
          err.code = 'MCP_TRANSPORT_LOST';
          throw err;
        }
        return {
          ok: true,
          reason: 'ready',
          state: 'awaiting-host-review',
          actionable: true,
          terminal: true,
          task: { taskId: 'task-mcp-1', state: 'awaiting-host-review' },
        };
      }
      if (route === 'result') {
        return {
          ok: true,
          task: {
            taskId: payload.taskId,
            state: 'awaiting-host-review',
            diff: {
              fileCount: 1,
              files: [{ path: 'src/a.js', status: 'M' }],
              patchText: '+++ huge diff content +++',
            },
          },
        };
      }
      throw new Error(`unexpected route ${route}`);
    },
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  // 1. autoPreflight stops without submitting when blocked.
  preflightIso = 'block';
  const blockedRes = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'delegate_submit',
      arguments: { workspacePath: '/repo', prompt: 'fix', autoPreflight: true, wait: true },
    },
  });
  const blockedBody = JSON.parse(blockedRes.result.content[0].text);
  assert.equal(blockedBody.ok, true);
  assert.equal(blockedBody.submitted, false);
  assert.equal(blockedBody.preflight.isolation, 'block');
  assert.deepEqual(calls.map((c) => c.route), ['preflight']);

  // 2. autoPreflight + wait submits and waits in ONE MCP call.
  calls.length = 0;
  preflightIso = 'worktree';
  observeMode = 'ready';
  const combinedRes = await server.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'delegate_submit',
      arguments: { workspacePath: '/repo', prompt: 'fix', autoPreflight: true, wait: true },
    },
  });
  const combinedBody = JSON.parse(combinedRes.result.content[0].text);
  assert.equal(combinedBody.ok, true);
  assert.equal(combinedBody.submitted, true);
  assert.equal(combinedBody.reason, 'ready');
  assert.equal(combinedBody.submitReceipt.taskId, 'task-mcp-1');
  assert.equal(combinedBody.submitReceipt.executionWorkspacePath, '/trees/task-mcp-1');
  assert.deepEqual(calls.map((c) => c.route), ['preflight', 'submit', 'observe']);
  assert.equal('autoPreflight' in calls[1].payload, false, 'MCP-only flag must be stripped before plane');
  assert.equal('wait' in calls[1].payload, false, 'MCP-only flag must be stripped before plane');

  // 3. wait: true preserves submitReceipt + taskId if follow-up wait fails after submit succeeded.
  calls.length = 0;
  observeMode = 'fail';
  const errWaitRes = await server.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'delegate_submit',
      arguments: { workspacePath: '/repo', prompt: 'fix', wait: true },
    },
  });
  assert.notEqual(errWaitRes.result.isError, true);
  const errWaitBody = JSON.parse(errWaitRes.result.content[0].text);
  assert.equal(errWaitBody.submitted, true);
  assert.equal(errWaitBody.taskId, 'task-mcp-1');
  assert.equal(errWaitBody.submitReceipt.taskId, 'task-mcp-1');
  assert.equal(errWaitBody.waitError.code, 'MCP_TRANSPORT_LOST');

  // 4. delegate_result with includeDiff: false strips patchText while keeping files & counts.
  calls.length = 0;
  const slimRes = await server.handle({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'delegate_result',
      arguments: { taskId: 'task-mcp-1', includeDiff: false },
    },
  });
  const slimBody = JSON.parse(slimRes.result.content[0].text);
  assert.equal(slimBody.task.diff.patchText, '');
  assert.equal(slimBody.task.diff.patchOmitted, true);
  assert.equal(slimBody.task.diff.omittedByRequest, true);
  assert.equal(slimBody.task.diff.fileCount, 1);
  assert.equal('includeDiff' in calls[0].payload, false);

  // 5. Validation refuses waitSeconds without wait: true and allowShared without autoPreflight: true.
  const bad1 = await server.handle({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'delegate_submit', arguments: { workspacePath: '/repo', prompt: 'x', waitSeconds: 60 } },
  });
  assert.equal(bad1.result.isError, true);
  assert.equal(JSON.parse(bad1.result.content[0].text).error.code, 'MCP_ARGUMENT_REQUIRED');

  const bad2 = await server.handle({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'delegate_submit', arguments: { workspacePath: '/repo', prompt: 'x', allowShared: true } },
  });
  assert.equal(bad2.result.isError, true);
  assert.equal(JSON.parse(bad2.result.content[0].text).error.code, 'MCP_ARGUMENT_REQUIRED');
});

test('MCP delegate_submit cancels without calling submit when aborted before or during autoPreflight', async () => {
  const routes = [];
  let preflightSignal = null;
  let preflightStartedResolve;
  let releasePreflight;
  const preflightStarted = new Promise((resolve) => { preflightStartedResolve = resolve; });
  const preflightGate = new Promise((resolve) => { releasePreflight = resolve; });

  const server = createMcpServer({
    callExecution: async (route, payload, ctx) => {
      routes.push(route);
      if (route === 'preflight') {
        preflightSignal = ctx?.signal ?? null;
        preflightStartedResolve();
        await preflightGate;
        // Even if the underlying preflight transport ignores signal and resolves, submit must not run.
        return { ok: true, isolation: 'worktree', reason: 'PREFLIGHT_CLEAN_REPOSITORY' };
      }
      if (route === 'submit') {
        return { ok: true, task: { taskId: 'task-should-not-submit', state: 'pending', sourcePath: payload.workspacePath } };
      }
      throw new Error(`unexpected route ${route}`);
    },
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  // 1. Cancel while preflight is still in flight.
  const c1 = new AbortController();
  const req1 = server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'delegate_submit', arguments: { workspacePath: '/repo', prompt: 'fix', autoPreflight: true, wait: true } },
  }, { signal: c1.signal });
  await preflightStarted;
  assert.equal(preflightSignal, c1.signal, 'preflight must receive the request AbortSignal');
  const cancelErr = Object.assign(new Error('the request was cancelled by the host'), {
    name: 'AbortError',
    code: 'MCP_REQUEST_CANCELLED',
  });
  c1.abort(cancelErr);
  releasePreflight();
  const res1 = await req1;
  assert.equal(res1.result.isError, true);
  assert.equal(JSON.parse(res1.result.content[0].text).error.code, 'MCP_REQUEST_CANCELLED');
  assert.deepEqual(routes, ['preflight'], 'submit must never be called after cancellation during preflight');

  // 2. Already-aborted request does not invoke preflight or submit at all.
  routes.length = 0;
  const c2 = new AbortController();
  c2.abort(cancelErr);
  const res2 = await server.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'delegate_submit', arguments: { workspacePath: '/repo', prompt: 'fix', autoPreflight: true } },
  }, { signal: c2.signal });
  assert.equal(res2.result.isError, true);
  assert.equal(JSON.parse(res2.result.content[0].text).error.code, 'MCP_REQUEST_CANCELLED');
  assert.deepEqual(routes, []);
});

test('worker-prompt, layered rules, and Antigravity test5 upgrade recognition align with test6 design', async () => {
  const prompt = buildWorkerPrompt({ taskId: 't-1', prompt: 'Fix pricing', workspacePath: '/repo', isolation: 'shared' });
  assert.match(prompt, /Do NOT create `\.cache\/` or temporary log files inside the workspace/u);
  assert.match(prompt, /node --test.*npm\.cmd test/u);

  const codex = codexRuleText().replace(/\s+/gu, ' ');
  assert.match(codex, /reuseWorktreeFromTaskId/u);
  assert.match(codex, /fingerprint/u);
  assert.doesNotMatch(codex, /task-command/u);
  assert.match(codex, /includeDiff: false/u);
  assert.match(codex, /Do NOT invent adversarial out-of-spec fuzz probes/u);
  assert.match(codex, /returns `submitted: true` with `waitError`/u);

  // Exact 1.9.0-test6 Codex SKILL.md LF & CRLF digests are registered for seamless upgrade to 1.9.0.
  for (const sha of [
    'c2477b9233f4f9b4e36c59f8544f607249b2f96be0aeba0a013525e18c4eab38',
    '238366a0ebaa543d6b09fd1a94d5507a22d5ba0d19fee32539c429d1ded2182c',
  ]) {
    assert.ok(KNOWN_SKILL_TEMPLATES.some((entry) => entry.version === '1.9.0-test6' && entry.sha256 === sha));
  }

  // Antigravity installer recognizes untouched 1.9.0-test5 SKILL.md as outdated (not modified).
  const root = await makeTempDir();
  const restore = useDirectoryClassifier(async (paths) => {
    const kinds = new Map();
    for (const p of paths) {
      let info = null;
      try { info = lstatSync(p); } catch { info = null; }
      if (info === null) kinds.set(p, 'missing');
      else if (info.isSymbolicLink()) kinds.set(p, 'link');
      else if (info.isDirectory()) kinds.set(p, 'directory');
      else kinds.set(p, 'other');
    }
    return kinds;
  });
  try {
    const agyHome = join(root, 'agy');
    await mkdir(agyHome, { recursive: true });
    const dshHome = join(root, 'dsh');
    await mkdir(dshHome, { recursive: true });
    const status = await readAntigravityStatus({ antigravityHome: agyHome, env: { DSH_HOME: dshHome } });
    assert.equal(status.plugin.state, 'not-installed');
  } finally {
    restore();
    await cleanup(root);
  }
});
