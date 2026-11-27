// Job engine tests: the authorization → configuration → workspace → route →
// execution chain, end to end, and every refusal in it.
//
// These tests run the real engine. Only native services are faked, so a
// regression in ordering (for example, creating an agent before consuming the
// grant) fails here.
//
// The fakes are deliberately closed: no `allowLegacyProviderRoutes` escape hatch
// is used, `providerRegistry` is a deterministic mapping, and the git fake answers
// in the NUL-delimited format the audit module requires. A fixture that let a
// missing service look like a working one would make these tests prove nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { AuthorizationRegistry } from '../src/auth/grants.js';
import { JobEngine, JOB_CODES, OBSERVE_TASK_REASONS, TASK_STATES } from '../src/jobs/engine.js';
import { SettingsService } from '../src/config/settings.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import { DEFAULT_MAX_TOKENS } from '../src/runtime/agent-runner.js';
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

/** The pinned commit the fake repository always reports. */
const HEAD = 'a'.repeat(40);

/**
 * Public provider profile id → native route id.
 *
 * The two ids are deliberately different: a job records the profile the operator
 * chose and hands the native route to the harness, so a test that conflates them
 * would hide a routing bug.
 */
const NATIVE_ROUTES = Object.freeze({ relay: 'relay-native' });

/**
 * Build a git runner that answers in the NUL-delimited format the audit layer
 * parses. A line-format answer is refused by the parser, which is why the fixture
 * must produce the real shape rather than a convenient one.
 * @returns {object} runner function with `calls` history.
 */
function engineGit() {
  const calls = [];
  const runner = async (cwd, args) => {
    calls.push({ cwd, args });
    const key = args.join(' ');
    if (key === '--version') return { stdout: 'git version 2.0.0\n', code: 0 };
    if (key === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', code: 0 };
    if (key === 'rev-parse --verify HEAD') return { stdout: `${HEAD}\n`, code: 0 };
    if (args[0] === 'status') return { stdout: ' M src/a.js\u0000', code: 0 };
    if (args[0] === 'diff' && args[1] === '--numstat') return { stdout: '2\t0\tsrc/a.js\u0000', code: 0 };
    if (args[0] === 'diff') return { stdout: 'diff --git a/src/a.js b/src/a.js\n+implementation\n', code: 0 };
    if (args[0] === 'ls-files') return { stdout: '', code: 0 };
    return { stdout: '', code: 0 };
  };
  runner.calls = calls;
  return runner;
}

/**
 * Build the provider registry the production entry point injects.
 *
 * `ensure(providers)` returns one deterministic profile → native-route mapping,
 * so a job can only route to a profile the registry actually mapped. That keeps
 * the engine's fail-closed check (`JOB_PROVIDER_REGISTRY_REQUIRED`) intact: the
 * fixture satisfies the contract instead of disabling the check.
 * @param {object} [options] - `fail`: error to reject with, `defer`: promise to await first.
 * @returns {object} registry with `calls` history.
 */
export function fakeProviderRegistry(options = {}) {
  const calls = [];
  return {
    calls,
    async ensure(providers) {
      calls.push(providers.map((provider) => provider.id));
      if (options.defer !== undefined) await options.defer;
      if (options.fail !== undefined) throw options.fail;
      const routes = new Map();
      for (const provider of providers) {
        routes.set(provider.id, NATIVE_ROUTES[provider.id] ?? `${provider.id}-native`);
      }
      return { routes };
    },
  };
}

/**
 * Build the agent preset registry an agent needs before it can run.
 *
 * Mounting a preset is what installs an agent's tool composition, so this
 * fixture also answers the tool inventory from the mount: without it the
 * additional review has no inventory to restrict and would (correctly) refuse.
 * @param {string[]} [inventory] - tool names the mounted composition offers.
 * @returns {object} preset registry with `mounts` history.
 */
function enginePresets(inventory = ['read', 'glob', 'grep', 'read_image']) {
  const mounts = [];
  return {
    mounts,
    async mount(ctx, id) {
      mounts.push({ ctx, id });
      ctx.tools.schemas = () => inventory.map((name) => ({ name, description: name, parameters: {} }));
      return { id: id ?? 'default-preset' };
    },
  };
}

/**
 * Build an engine over temporary storage, a real workspace directory and faked
 * native services.
 *
 * The workspace must exist because the engine resolves it before use; a
 * nonexistent path is itself a refusal and has its own test.
 * @param {object} [options] - `agents`, `git`, `settings`, `worktrees`,
 *   `providerRegistry`, `ensureRoutes`, `agentPresets`, `preflightTimeoutMs`,
 *   `sessionController`, `sessionStore`, `now`, `wait`, `observeSliceMs`.
 * @returns {Promise<object>} harness with engine, auth, workspace and cleanup.
 */
async function harness(options = {}) {
  const dir = await makeTempDir();
  const workspace = await realpath(await mkdir(join(dir, 'workspace'), { recursive: true }).then(() => join(dir, 'workspace')));
  const settings = new SettingsService(join(dir, 'data'));
  await settings.replace(options.settings ?? validSettings());
  const auth = new AuthorizationRegistry();
  const locks = new WorkspaceLocks();
  const agents = options.agents ?? fakeAgents({ respond: { text: 'implemented the change' } });
  const providerRegistry = options.providerRegistry ?? fakeProviderRegistry();
  const presets = options.agentPresets ?? enginePresets();
  // The native policy services every delegated run verifies its policy through.
  // Built once per harness because they own no per-run state: the mode override
  // and the approval stance are folded out of each Session's own log.
  const defaultPolicyServices = await nativePolicyServices();
  // Placement, wired the way `src/index.js` wires it: the Workspace controller
  // and the SESSION controller are two distinct services, and the native
  // `sessions` service above is neither of them. Every worker run the engine
  // executes is grouped into a Workspace keyed by its ACTUAL execution directory,
  // so a harness without these two controllers would (correctly) refuse every
  // task with `JOB_CONVERSATION_UNAVAILABLE`.
  // A controller handed in by a test may bring its own Workspace registry (a busy
  // or scripted resolve needs one it can populate); otherwise both are fresh.
  const workspaces = options.workspaces ?? options.sessionController?.boundWorkspaces ?? fakeWorkspaceController();
  const sessionController = options.sessionController ?? fakeSessionController({
    workspaces,
    // The same scripted turn the agent fake would produce, because a placed run
    // drives the Agent the controller resolves rather than one it creates.
    ...(agents.respondPlan === undefined ? {} : { respond: agents.respondPlan }),
  });
  const deps = {
    agents,
    agentPresets: presets,
    sessions: { async flush() {} },
    workspaces,
    sessionController,
    // `ctx.sandboxPolicy` and `ctx.approval`, as the entry point publishes them.
    // Every worker run is a delegated run, and it fails closed before its prompt
    // unless the policy it wrote resolves back through these services.
    policyServices: () => options.policyServices ?? defaultPolicyServices,
    // The native route is not the profile id; the model table is keyed by the
    // route the harness will be asked to resolve.
    llm: fakeLlm({ providers: { 'relay-native': llmTable().relay } }),
    settings,
    auth,
    locks,
    runGit: options.git ?? engineGit(),
    providerRegistry,
    // The entry point's full-snapshot seam. Only injected when a test asks for it,
    // so the registry fallback is exercised by default.
    ...(options.ensureRoutes === undefined ? {} : { ensureRoutes: options.ensureRoutes }),
    ...(options.worktrees === undefined ? {} : { worktrees: options.worktrees }),
    ...(options.preflightTimeoutMs === undefined ? {} : { preflightTimeoutMs: options.preflightTimeoutMs }),
    ...(options.sessionStore === undefined ? {} : { sessionStore: options.sessionStore }),
    // Observation seams. A test that exercises silent waiting injects a clock and a
    // wait it can advance, so twenty minutes of idleness costs no wall time.
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.wait === undefined ? {} : { wait: options.wait }),
    ...(options.observeSliceMs === undefined ? {} : { observeSliceMs: options.observeSliceMs }),
    // The scheduler seam for the monitor's own scheduled self-check, so a test can fire
    // it at the instant it was armed for instead of waiting ten real minutes.
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    authorizationMode: options.authorizationMode ?? 'grants',
    delegationEnabled: options.delegationEnabled === true,
    logger: { info() {}, warn() {} },
  };
  const engine = new JobEngine(deps);

  /**
   * Issue a connection plus a grant covering this harness's workspace.
   * @param {'task'|'session'} [kind] - grant kind.
   * @param {object} [input] - extra `issueGrant` fields (e.g. `overrides`).
   * @returns {object} connection and grant records.
   */
  function authorize(kind = 'task', input = {}) {
    const connection = auth.issueConnection({ label: 'codex' });
    const grant = auth.issueGrant(connection.connectionId, {
      kind,
      workspacePath: workspace,
      ttlSeconds: 600,
      ...input,
    });
    return { connectionId: connection.connectionId, token: connection.token, grant };
  }

  return {
    dir,
    workspace,
    engine,
    auth,
    settings,
    agents,
    deps,
    providerRegistry,
    workspaces,
    sessionController,
    /**
     * The Agent a settled task actually drove.
     *
     * A placed run never calls `agents.create`, so `agents.created` stays empty by
     * design; the conversation it drove is the one `sessionController` resolved
     * for its Session. Engine assertions follow the run, not the old creation
     * path, so they keep proving "the selected triple reached the agent".
     * @param {object} task - settled task view.
     * @returns {object} the resolved agent.
     */
    drivenAgent(task) {
      const sessionId = task?.execution?.conversation?.sessionId ?? task?.execution?.sessionId;
      return sessionController.agents.get(sessionId);
    },
    authorize,
    async close() {
      await engine.dispose();
      await cleanup(dir);
    },
  };
}

/**
 * Wait until a task reaches a terminal state.
 * @param {object} engine - job engine.
 * @param {string} taskId - task id.
 * @param {number} [attempts] - polling bound.
 * @returns {Promise<object>} settled task view.
 */
async function settle(engine, taskId, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const task = engine.get(taskId);
    if (task.state !== TASK_STATES.running && task.state !== TASK_STATES.pending) return task;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  }
  return engine.get(taskId);
}

test('a job refuses to start with no authorization at all', async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () => h.engine.start({
        connectionId: 'conn-none',
        grantId: 'grant-none',
        workspacePath: h.workspace,
        prompt: 'do work',
      }),
      (error) => error.code === JOB_CODES.notAuthorized,
    );
    assert.equal(h.agents.created.length, 0, 'no agent may exist for an unauthorized job');
  } finally {
    await h.close();
  }
});

test('an authorized task runs and ends awaiting host review, never approved', async () => {
  const h = await harness();
  const packet = 'Use the existing formatter in src/a.js. Add the fallback first, then run its unit test.';
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: packet,
    });

    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview);
    assert.equal(settled.selfApproved, false);
    assert.equal(settled.hostAcceptance, null, 'the plugin must not record acceptance');
    assert.equal(settled.execution.outcome, 'completed');
    assert.match(settled.execution.text, /implemented the change/);
    // The run was grouped into a real Workspace keyed by its execution directory,
    // and started a fresh conversation there (the only thing a new submission does).
    const conversation = settled.execution.conversation;
    assert.ok(conversation !== null && conversation !== undefined, 'a worker run must report where it was placed');
    assert.equal(conversation.kind, 'new');
    assert.equal(conversation.continuedFromTaskId, null);
    assert.equal(conversation.reused, false, 'a new submission starts a new conversation');
    assert.equal(settled.continueFromTaskId, null, 'the task states it continues nothing');
    assert.equal(h.workspaces.workspaces.get(conversation.workspaceId)?.path, h.workspace,
      'the Workspace is keyed by the actual execution directory');
    assert.equal(h.agents.created.length, 0, 'a placed run must not create a second agent');
    const [message] = h.drivenAgent(settled).followups;
    assert.ok(message.content.some((entry) => entry.type === 'text' && entry.text.includes(packet)),
      'the worker receives the implementation steps, not just a summary of the goal');
    // Evidence was measured, not reported.
    assert.equal(settled.diff.fileCount, 1);
    assert.equal(settled.diff.files[0].path, 'src/a.js');
  } finally {
    await h.close();
  }
});

test('the effective configuration is captured immutably on the task', async () => {
  const h = await harness();
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.effective.worker.model, 'deepseek-chat');
    assert.equal(settled.effective.worker.reasoningEffort, 'medium');
    assert.equal(settled.route.providerId, 'relay');
    // The run reports the triple it actually installed on the agent it drove, and
    // that agent really received it. A placed run never goes through
    // `agents.create`, so the fact is read from the run and from the agent.
    assert.equal(settled.execution.selection.model, 'deepseek-chat');
    assert.equal(settled.execution.selection.reasoningEffort, 'medium');
    assert.equal(settled.execution.selection.provider, settled.route.providerRoute);
    const driven = h.drivenAgent(settled);
    assert.ok(driven !== undefined, 'the task\'s conversation must expose the agent it drove');
    assert.equal(driven.followups.length, 1, 'exactly one prompt reached that agent');
  } finally {
    await h.close();
  }
});

test('replaying a spent task grant cannot start a second task', async () => {
  const h = await harness();
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'first',
    });
    await settle(h.engine, started.taskId);

    await assert.rejects(
      () => h.engine.start({
        connectionId,
        grantId: grant.grantId,
        workspacePath: h.workspace,
        prompt: 'second',
      }),
      (error) => error.code === 'GRANT_CONSUMED' || error.code === JOB_CODES.notAuthorized,
    );
    assert.equal(h.agents.created.length, 0, 'a placed run creates no agent through the registry');
    assert.equal(h.sessionController.creates.length, 1, 'exactly one conversation may exist for one grant');
  } finally {
    await h.close();
  }
});

test('starting never happens without a configured provider', async () => {
  const h = await harness({ settings: { schemaVersion: 1, providers: [] } });
  try {
    const { connectionId, grant } = h.authorize();
    await assert.rejects(
      () => h.engine.start({
        connectionId,
        grantId: grant.grantId,
        workspacePath: h.workspace,
        prompt: 'go',
      }),
      (error) => error.code === JOB_CODES.noProviders,
    );
    assert.equal(h.agents.created.length, 0);
  } finally {
    await h.close();
  }
});

test('an unsupported effort in settings refuses the job before an agent exists', async () => {
  // The document itself cannot hold this combination — settings validation
  // refuses to save it — so the refusal is exercised through the per-job
  // override that carries the same bad triple into the effective snapshot.
  const h = await harness();
  try {
    const { connectionId, grant } = h.authorize('task', {
      overrides: { model: 'deepseek-reasoner', reasoningEffort: 'low' },
    });
    await assert.rejects(
      () => h.engine.start({
        connectionId,
        grantId: grant.grantId,
        workspacePath: h.workspace,
        prompt: 'go',
      }),
      (error) => error.code === JOB_CODES.routingRefused,
    );
    assert.equal(h.agents.created.length, 0);
  } finally {
    await h.close();
  }
});

test('saving an unsupported effort is refused by the settings document itself', async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () => h.settings.replace(validSettings({ worker: { model: 'deepseek-reasoner', reasoningEffort: 'low' } })),
      (error) => error.code === 'SELECTION_EFFORT_UNSUPPORTED',
    );
    // The stored document is unchanged, so no job can inherit the bad triple.
    const stored = await h.settings.read();
    assert.equal(stored.worker.model, 'deepseek-chat');
    assert.equal(stored.worker.reasoningEffort, 'medium');
  } finally {
    await h.close();
  }
});

test('a task override that names an undeclared model is refused', async () => {
  const h = await harness();
  try {
    const connection = h.auth.issueConnection({});
    const grant = h.auth.issueGrant(connection.connectionId, {
      kind: 'task',
      workspacePath: h.workspace,
      ttlSeconds: 600,
      overrides: { model: 'ghost-model' },
    });
    await assert.rejects(
      () => h.engine.start({
        connectionId: connection.connectionId,
        grantId: grant.grantId,
        workspacePath: h.workspace,
        prompt: 'go',
      }),
      (error) => error.code === 'JOB_ROUTING_REFUSED',
    );
    assert.equal(h.agents.created.length, 0);
  } finally {
    await h.close();
  }
});

test('a grant for another workspace cannot be spent here', async () => {
  const h = await harness();
  try {
    const connection = h.auth.issueConnection({});
    const elsewhere = process.platform === 'win32' ? 'C:\\work\\elsewhere' : '/work/elsewhere';
    const grant = h.auth.issueGrant(connection.connectionId, {
      kind: 'task',
      workspacePath: elsewhere,
      ttlSeconds: 600,
    });
    await assert.rejects(
      () => h.engine.start({
        connectionId: connection.connectionId,
        grantId: grant.grantId,
        workspacePath: h.workspace,
        prompt: 'go',
      }),
      (error) => error.code === 'GRANT_MISMATCH',
    );
    assert.equal(h.agents.created.length, 0);
  } finally {
    await h.close();
  }
});

test('worktree isolation is refused instead of silently downgraded', async () => {
  const h = await harness({ settings: validSettings({ worker: { isolation: 'worktree' } }) });
  try {
    const { connectionId, grant } = h.authorize();
    await assert.rejects(
      () => h.engine.start({
        connectionId,
        grantId: grant.grantId,
        workspacePath: h.workspace,
        prompt: 'go',
      }),
      (error) => error.code === JOB_CODES.isolationRefused,
    );
    assert.equal(h.agents.created.length, 0);
  } finally {
    await h.close();
  }
});

test('a workspace that cannot be audited refuses the job', async () => {
  const denial = new Error('spawn EPERM');
  denial.code = 'EPERM';
  const h = await harness({ git: async () => { throw denial; } });
  try {
    const { connectionId, grant } = h.authorize();
    await assert.rejects(
      () => h.engine.start({
        connectionId,
        grantId: grant.grantId,
        workspacePath: h.workspace,
        prompt: 'go',
      }),
      (error) => error.code === 'JOB_AUDIT_UNAVAILABLE',
    );
    assert.equal(h.agents.created.length, 0);
  } finally {
    await h.close();
  }
});

test('a nonexistent workspace is refused', async () => {
  const h = await harness();
  try {
    const missing = join(h.dir, 'does-not-exist');
    const connection = h.auth.issueConnection({});
    const grant = h.auth.issueGrant(connection.connectionId, {
      kind: 'task',
      workspacePath: missing,
      ttlSeconds: 600,
    });
    await assert.rejects(
      () => h.engine.start({
        connectionId: connection.connectionId,
        grantId: grant.grantId,
        workspacePath: missing,
        prompt: 'go',
      }),
      (error) => error.code === JOB_CODES.workspaceRequired,
    );
  } finally {
    await h.close();
  }
});

test('two concurrent jobs in one workspace are refused', async () => {
  // Raise the parallelism limit above one so the refusal under test is the
  // workspace lock, not the concurrency cap. The first job must still be RUNNING
  // when the second is submitted, which is what the busy conversation models.
  const h = await harness({
    sessionController: busySessionController(),
    settings: validSettings({ worker: { maxParallelism: 2 } }),
  });
  try {
    const first = h.authorize();
    const second = h.authorize();
    await h.engine.start({
      connectionId: first.connectionId,
      grantId: first.grant.grantId,
      workspacePath: h.workspace,
      prompt: 'first',
    });
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });
    await assert.rejects(
      () => h.engine.start({
        connectionId: second.connectionId,
        grantId: second.grant.grantId,
        workspacePath: h.workspace,
        prompt: 'second',
      }),
      (error) => error.code === JOB_CODES.busy,
    );
  } finally {
    await h.close();
  }
});

test('the parallelism cap refuses a second concurrent job', async () => {
  // The busy conversation keeps the first job running, so the second is refused
  // by the cap rather than admitted behind a finished task.
  const h = await harness({ sessionController: busySessionController() });
  try {
    const first = h.authorize();
    const second = h.authorize();
    await h.engine.start({
      connectionId: first.connectionId,
      grantId: first.grant.grantId,
      workspacePath: h.workspace,
      prompt: 'first',
    });
    await assert.rejects(
      () => h.engine.start({
        connectionId: second.connectionId,
        grantId: second.grant.grantId,
        // A different workspace, so only the parallelism cap can refuse this.
        workspacePath: h.workspace,
        prompt: 'second',
      }),
      (error) => error.code === JOB_CODES.concurrency || error.code === JOB_CODES.busy,
    );
  } finally {
    await h.close();
  }
});

test('a session grant starts repeated tasks', async () => {
  const h = await harness();
  try {
    const { connectionId } = h.authorize('session');
    const one = await h.engine.start({
      connectionId,
      authorization: 'session',
      workspacePath: h.workspace,
      prompt: 'first',
    });
    await settle(h.engine, one.taskId);
    // A terminal task keeps its record, so the slot has to be returned
    // explicitly; otherwise it would go on occupying capacity forever.
    assert.equal(h.engine.tasks.get(one.taskId).slotHeld, false, 'a settled task must not keep its slot');

    const two = await h.engine.start({
      connectionId,
      authorization: 'session',
      workspacePath: h.workspace,
      prompt: 'second',
    });
    assert.notEqual(one.taskId, two.taskId);
    await settle(h.engine, two.taskId);
    // An unrelated second submission starts its own conversation in the SAME
    // Workspace group rather than continuing the first.
    const firstRun = h.engine.get(one.taskId).execution;
    const secondRun = h.engine.get(two.taskId).execution;
    assert.notEqual(firstRun.conversation.sessionId, secondRun.conversation.sessionId, 'two tasks, two conversations');
    assert.equal(firstRun.conversation.workspaceId, secondRun.conversation.workspaceId, 'in one Workspace group');
    assert.equal(firstRun.conversation.kind, 'new');
    assert.equal(secondRun.conversation.kind, 'new', 'nothing continues without an explicit continuation');
    assert.equal(h.sessionController.creates.length, 2);
  } finally {
    await h.close();
  }
});

test('a refusal after the slot is reserved releases it for the next job', async () => {
  // The route registry fails on the first call, which is the first preflight step
  // *after* the concurrency slot was claimed, and succeeds afterwards. A leaked
  // claim would make the second start refuse with JOB_CONCURRENCY_LIMIT even
  // though no native executor ever existed.
  let calls = 0;
  const providerRegistry = {
    async ensure(providers) {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('registry unavailable'), { code: 'REGISTRY_UNAVAILABLE' });
      const routes = new Map(providers.map((provider) => [provider.id, NATIVE_ROUTES[provider.id] ?? `${provider.id}-native`]));
      return { routes };
    },
  };
  const h = await harness({ providerRegistry });
  try {
    const first = h.authorize();
    await assert.rejects(
      () => h.engine.start({
        connectionId: first.connectionId,
        grantId: first.grant.grantId,
        workspacePath: h.workspace,
        prompt: 'doomed',
      }),
      (error) => error.code === JOB_CODES.routingRefused,
    );
    const refused = [...h.engine.tasks.values()].at(-1);
    assert.equal(refused.state, TASK_STATES.failed);
    assert.equal(refused.slotHeld, false, 'a refused admission must not keep its slot');

    // maxParallelism is 1, so any leak is observable here.
    const second = h.authorize();
    const next = await h.engine.start({
      connectionId: second.connectionId,
      grantId: second.grant.grantId,
      workspacePath: h.workspace,
      prompt: 'next job',
    });
    assert.notEqual(next.taskId, refused.taskId);
    await settle(h.engine, next.taskId);
  } finally {
    await h.close();
  }
});

test('capacity is not returned while the native executor may still be running', async () => {
  const h = await harness();
  try {
    // Drive finalize directly with a native executor that has started and has not
    // confirmed it stopped. This is the one state the release gate exists for; the
    // fakes cannot reach it through a real cancel, because cancelling makes the
    // runner settle immediately.
    const task = h.engine.createTask('held job', 'task');
    h.engine.tasks.set(task.taskId, task);
    const lease = h.engine.locks.acquire(h.workspace, { taskId: task.taskId });
    task.leases.push({ path: h.workspace, nonce: lease.nonce });
    task.slotHeld = true;
    task.state = TASK_STATES.cancelled;
    let release;
    task.native = {
      started: true,
      settled: false,
      promise: new Promise((resolvePromise) => { release = resolvePromise; }),
    };

    const finalizing = h.engine.finalize(task);
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 20); });
    assert.equal(task.slotHeld, true, 'the slot must not be handed back while the executor may still write');
    assert.equal(h.engine.locks.isLocked(h.workspace), true, 'the workspace lease must still be held');
    assert.equal(task.finalizedAt, null);

    // Once the executor confirms it stopped, the same finalize call releases both.
    task.native.settled = true;
    release();
    assert.equal(await finalizing, true);
    assert.equal(task.slotHeld, false);
    assert.equal(h.engine.locks.isLocked(h.workspace), false);
    assert.equal(task.cleanupError, null);
    // Release the harness's own settlement wait; the record was created outside
    // a start, so nothing else will ever settle it.
    task.settle();
  } finally {
    await h.close();
  }
});

test('finalize is idempotent when several terminal paths race', async () => {
  const h = await harness();
  try {
    const task = h.engine.createTask('raced job', 'task');
    h.engine.tasks.set(task.taskId, task);
    const lease = h.engine.locks.acquire(h.workspace, { taskId: task.taskId });
    task.leases.push({ path: h.workspace, nonce: lease.nonce });
    task.slotHeld = true;

    // Count the actual lease releases: a second release would be a silent no-op
    // inside WorkspaceLocks, so only counting proves the latch worked.
    let releases = 0;
    const realRelease = h.engine.locks.release.bind(h.engine.locks);
    h.engine.locks.release = (workspacePath, nonce) => {
      releases += 1;
      return realRelease(workspacePath, nonce);
    };

    // Three callers, one release: a success path racing a cancellation path.
    const [first, , third] = await Promise.all([
      h.engine.finalize(task),
      h.engine.finishTask(task),
      h.engine.finalize(task),
    ]);
    assert.equal(first, true, 'the racing caller must observe the release');
    assert.equal(third, true, 'every caller sees the same outcome');
    assert.equal(releases, 1, 'the lease must be released exactly once');
    assert.equal(task.slotHeld, false);
    assert.equal(task.leases.length, 0);
    assert.equal(h.engine.locks.isLocked(h.workspace), false);
  } finally {
    await h.close();
  }
});

/**
 * A session controller whose resolved agents absorb their prompt and stay busy.
 *
 * A placed run never creates an agent through `agents.create`, so "a run that is
 * still working" has to be modelled on the conversation the run actually drives.
 * Only the runner's own cancel (or timeout) can end such a run, which is what a
 * cancellation test needs to observe.
 * @returns {object} fake session controller bound to the harness's Workspace controller.
 */
function busySessionController() {
  const workspaces = fakeWorkspaceController();
  const controller = fakeSessionController({ workspaces });
  const resolveOriginal = controller.resolveAgent.bind(controller);
  controller.resolveAgent = async (sessionId) => {
    const found = await resolveOriginal(sessionId);
    const agent = found.agent;
    if (agent !== undefined) {
      agent.followup = (message) => { agent.followups.push(message); };
      // Never idle: nothing but `cancel` (or the runner's timeout) can settle this.
      agent.whenIdle = async () => { await new Promise(() => {}); };
    }
    return found;
  };
  // The harness wires its own Workspace controller, so hand this one over instead.
  controller.boundWorkspaces = workspaces;
  return controller;
}

test('cancelling a running task reaches the agent and states why', async () => {
  // A placed run drives a RESOLVED agent, so the busy turn is modelled on the
  // session controller's side: prompt delivery absorbs the turn and the agent
  // never becomes idle, which leaves the operator's cancel as the only ending.
  const h = await harness({
    sessionController: busySessionController(),
  });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'long job',
    });
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });

    const cancelled = await h.engine.cancel(started.taskId, 'operator');
    assert.equal(cancelled.state, TASK_STATES.cancelled);
    assert.equal(cancelled.cancelledBy, 'operator');
    // The native agent received a cancel, and the workspace lock was released.
    const driven = h.drivenAgent(cancelled);
    assert.ok(driven !== undefined, 'the task\'s conversation must expose the agent it drove');
    assert.ok(driven.cancels.length >= 1, 'the agent must be cancelled');
    assert.equal(h.engine.locks.isLocked(h.workspace), false);
  } finally {
    await h.close();
  }
});

test('the master switch blocks new work while off and cancels live work when disabled', async () => {
  const sessionController = busySessionController();
  const h = await harness({ authorizationMode: 'switch', delegationEnabled: false, sessionController });
  try {
    assert.deepEqual(h.engine.posture(), { authorized: false, reason: 'delegation is disabled', mode: 'switch' });
    await assert.rejects(
      () => h.engine.start({ workspacePath: h.workspace, prompt: 'must stay blocked' }),
      (error) => error.code === JOB_CODES.notAuthorized,
    );
    assert.equal(sessionController.creates.length, 0, 'a disabled switch must not create a conversation');

    h.engine.setDelegationEnabled(true);
    const started = await h.engine.start({ workspacePath: h.workspace, prompt: 'long job' });
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });
    h.engine.setDelegationEnabled(false);
    const cancelled = await settle(h.engine, started.taskId);

    assert.equal(cancelled.state, TASK_STATES.cancelled);
    assert.equal(cancelled.cancelledBy, 'delegation-disabled');
    assert.ok(h.drivenAgent(cancelled).cancels.length >= 1, 'disabling must reach the native agent');
    assert.equal(h.engine.posture().authorized, false);
    await assert.rejects(
      () => h.engine.start({ workspacePath: h.workspace, prompt: 'must stay blocked' }),
      (error) => error.code === JOB_CODES.notAuthorized,
    );
  } finally {
    await h.close();
  }
});

test('a cancelled task releases the workspace for the next job', async () => {
  const agents = fakeAgents({
    script: async ({ record }) => {
      record.agent.followup = (message) => {
        record.followups.push(message);
        record.idle = false;
      };
    },
  });
  const h = await harness({ agents });
  try {
    const first = h.authorize();
    const started = await h.engine.start({
      connectionId: first.connectionId,
      grantId: first.grant.grantId,
      workspacePath: h.workspace,
      prompt: 'long job',
    });
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });
    await h.engine.cancel(started.taskId, 'operator');

    const second = h.authorize();
    const next = await h.engine.start({
      connectionId: second.connectionId,
      grantId: second.grant.grantId,
      workspacePath: h.workspace,
      prompt: 'next job',
    });
    assert.notEqual(next.taskId, started.taskId);
    await settle(h.engine, next.taskId);
  } finally {
    await h.close();
  }
});

test('a legacy enabled model review goes straight to host acceptance with one worker and no reviewer', async () => {
  // Submit with settings from an installation that had enabled model review.
  const agents = fakeAgents({ respond: { text: 'completed by the worker' } });
  const h = await harness({
    agents,
    settings: validSettings({ review: { enabled: true, providerId: 'relay', model: 'deepseek-reasoner', reasoningEffort: 'high' } }),
  });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({ connectionId, grantId: grant.grantId, workspacePath: h.workspace, prompt: 'go' });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview);
    assert.equal(settled.phase, 'awaiting-host-review');
    assert.equal(settled.hostAcceptance, null);
    assert.equal(agents.created.length, 0, 'no independent reviewer was started');
    assert.equal(h.sessionController.creates.length, 1, 'the worker has its own native session');
    assert.equal(settled.execution.selection.model, 'deepseek-chat');
    const task = h.engine.tasks.get(started.taskId);
    assert.equal(task.execution.maxTokens, DEFAULT_MAX_TOKENS);
    assert.ok(task.execution.maxTokens >= 32768);
  } finally {
    await h.close();
  }
});

test('a failing execution is reported as failed, not as awaiting review', async () => {
  const agents = fakeAgents({ respond: { error: new Error('provider exploded') } });
  const h = await harness({ agents });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.failed);
    assert.equal(settled.error.code, 'JOB_EXECUTION_FAILED');
    // Evidence is still captured so the host can see partial work.
    assert.ok(settled.diff !== null);
    // The phase states the same ending: it must not still describe a creation or an
    // execution for a run that failed. (`provider exploded` above is the
    // agent-reported error path; the timeout and empty-output paths have their own
    // regression below.)
    assert.equal(settled.phase, 'failed');
  } finally {
    await h.close();
  }
});

test('a reasoning-only run is a completed run, not an empty-output failure', async () => {
  // The recorded turn carries reasoning and no visible text: activity the job must
  // credit. The turn-end event the fake can express is the reasoning block, which
  // is exactly the shape a provider with no deltas produces.
  const agents = fakeAgents({ respond: { reasoningBlock: 'weighing the change' } });
  const h = await harness({ agents });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview);
    assert.equal(settled.error, null, 'reasoning is output: it must never be reported as JOB_NO_OUTPUT');
    assert.equal(settled.execution.outcome, 'completed');
    assert.equal(settled.execution.reasoningOnly, true);
    assert.equal(settled.execution.text, '');
    assert.equal(settled.selfApproved, false);
  } finally {
    await h.close();
  }
});

test('a reasoning-only run that stops at its output budget is completed, not failed', async () => {
  // `max-tokens` is how the native loop ends a turn that filled its budget. A
  // reasoning model does exactly that on a thinking answer, and reporting it as a
  // failure was the false negative this test pins down.
  const agents = fakeAgents({ respond: { reasoning: 'long deliberation', reason: 'max-tokens' } });
  const h = await harness({ agents });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview);
    assert.equal(settled.error, null);
    assert.equal(settled.execution.outcome, 'completed');
    assert.equal(settled.execution.reasoningOnly, true);
    // The budget fact stays visible on the turn record instead of being invented
    // as an error, so an operator can raise the budget knowingly.
    assert.equal(settled.execution.turnEnd.reason, 'max-tokens');
  } finally {
    await h.close();
  }
});

test('a visible answer that stops at its budget is completed and keeps its text', async () => {
  const agents = fakeAgents({ respond: { text: 'partially implemented', reason: 'max-tokens' } });
  const h = await harness({ agents });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview);
    assert.equal(settled.execution.outcome, 'completed');
    assert.equal(settled.execution.text, 'partially implemented');
    assert.equal(settled.execution.reasoningOnly, false);
  } finally {
    await h.close();
  }
});

test('a run that stops at its budget without any content is reported as a budget failure, not an empty one', async () => {
  const agents = fakeAgents({ respond: { reason: 'max-tokens' } });
  const h = await harness({ agents });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.failed);
    assert.equal(settled.error.code, JOB_CODES.outputTruncated, JSON.stringify(settled.error));
    assert.match(settled.error.message, /budget/);
    // The turn fact that explains the ending travels with the refusal.
    assert.deepEqual(settled.error.details.turnEnd, { reason: 'max-tokens' });
    // Evidence is still captured for a partial change.
    assert.ok(settled.diff !== null);
  } finally {
    await h.close();
  }
});

test('a run that genuinely produced nothing is still a failure with its own message', async () => {
  // The distinction the fix must not erase: no text, no reasoning, no budget
  // ending. The runner records its empty-turn diagnostic, so the job reports an
  // execution failure — never a completion, and never a budget problem.
  const agents = fakeAgents({ respond: { reason: 'completed' } });
  const h = await harness({ agents });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.failed);
    assert.equal(settled.error.code, JOB_CODES.executionFailed, JSON.stringify(settled.error));
    assert.match(settled.error.message, /no assistant text/);
    assert.notEqual(settled.error.code, JOB_CODES.outputTruncated, 'an empty turn is not a budget ending');
    assert.equal(settled.error.details, undefined, 'a silent run carries no budget facts');
    assert.equal(settled.execution.outcome, 'failed');
    assert.equal(settled.execution.reasoningOnly, false);
    assert.equal(settled.selfApproved, false);
  } finally {
    await h.close();
  }
});

test('starting a job with an empty prompt is refused', async () => {
  const h = await harness();
  try {
    const { connectionId, grant } = h.authorize();
    await assert.rejects(
      () => h.engine.start({ connectionId, grantId: grant.grantId, workspacePath: h.workspace, prompt: '   ' }),
      (error) => error.code === JOB_CODES.promptRequired,
    );
  } finally {
    await h.close();
  }
});

test('the task view never contains provider endpoints or secrets', async () => {
  const h = await harness();
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    await settle(h.engine, started.taskId);
    const view = JSON.stringify(h.engine.get(started.taskId, { includePrompt: true }));
    assert.equal(view.includes('127.0.0.1:8443'), false, 'the provider endpoint must not leak into a task view');
    assert.equal(view.includes('DSH_DELEGATE_RELAY_KEY'), false, 'a credential reference must not leak into a task view');
  } finally {
    await h.close();
  }
});

test('listing tasks filters by connection', async () => {
  const h = await harness();
  try {
    const mine = h.authorize();
    const other = h.authorize();
    const started = await h.engine.start({
      connectionId: mine.connectionId,
      grantId: mine.grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    await settle(h.engine, started.taskId);

    assert.equal(h.engine.list({ connectionId: mine.connectionId }).length, 1);
    assert.equal(h.engine.list({ connectionId: other.connectionId }).length, 0);
  } finally {
    await h.close();
  }
});

test('dispose cancels live tasks and marks the plugin unusable', async () => {
  // A live (never-idle) placed run, so dispose has something to stop.
  const h = await harness({ sessionController: busySessionController() });
  try {
    const { connectionId, grant } = h.authorize();
    await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'long job',
    });
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });
    const stopped = await h.engine.dispose();
    assert.equal(stopped, 1);
    assert.deepEqual(h.engine.posture(), { authorized: false, reason: 'the plugin has been disposed' });
    assert.equal(h.engine.locks.isLocked(h.workspace), false);
  } finally {
    await cleanup(h.dir);
  }
});

// ---------------------------------------------------------------------------
// Silent waiting and concentrated host review: engine-owned monitoring
// ---------------------------------------------------------------------------

/**
 * A controllable clock and a wait seam for a live run.
 *
 * The agent a test drives never settles, so every observation below happens while
 * the task is genuinely `running`. The delay is applied through the injected wait,
 * so an interval costs no wall time.
 * @param {number} [start] - first clock value.
 * @returns {object} `{ now, wait, advance, clockMs }`.
 */
function observedClock(start = 5_000_000) {
  const state = { current: start };
  return {
    state,
    now: () => state.current,
    async wait(ms, options = {}) {
      await Promise.resolve();
      if (options?.signal?.aborted === true) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      state.current += ms;
    },
    advance(ms) {
      state.current += ms;
    },
    get clockMs() {
      return state.current;
    },
  };
}

/**
 * A task record whose monitor is fed by hand, as the runner would feed it.
 * @param {object} engine - the harness engine.
 * @param {string} taskId - the started task.
 * @returns {object} the live task record.
 */
function liveTask(engine, taskId) {
  const task = engine.tasks.get(taskId);
  assert.ok(task !== undefined, 'the started task must exist');
  return task;
}

/**
 * Wait until a task actually holds a driven executor.
 *
 * A fixed delay is a race: admission has several awaits, so the exact instant the
 * run reaches its native call varies with machine load. The observable fact is the
 * task STATE `running` plus a live monitor, which together mean admission finished
 * and the engine is driving the executor — the phase after that varies with what the
 * (faked) executor does next, so it is not asserted here.
 * @param {object} engine - the harness engine.
 * @param {string} taskId - the started task.
 * @param {number} [attempts] - polling bound.
 * @returns {Promise<object>} the live task record.
 */
async function waitForExecute(engine, taskId, attempts = 400) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const task = engine.tasks.get(taskId);
    if (task !== undefined && task.state === 'running' && task.monitor !== null && task.monitor !== undefined) return task;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
  }
  assert.fail('the run never started its executor');
}

test('a settled task freezes the monitoring thresholds it ran under', async () => {
  const h = await harness();
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.effective.monitoring.selfCheckSeconds, 600);
    assert.equal(settled.effective.monitoring.attentionSeconds, 2400);
    // The activity summary is published on an ordinary view, and carries no text.
    assert.ok(settled.activity !== null);
    assert.equal(typeof settled.activity.activityEvents, 'number');
    assert.equal(JSON.stringify(settled.activity).includes('implemented the change'), false,
      'the activity summary must not carry the run text');
  } finally {
    await h.close();
  }
});

test('a task keeps its frozen thresholds when settings change mid-run', async () => {
  const h = await harness({ sessionController: busySessionController() });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'long job',
    });
    await h.settings.setMonitoring({ selfCheckSeconds: 60, attentionSeconds: 120 });
    const live = liveTask(h.engine, started.taskId);
    assert.equal(live.effective.monitoring.selfCheckSeconds, 600, 'the running task kept its own snapshot');
    assert.equal(live.effective.monitoring.attentionSeconds, 2400);
    await h.engine.cancel(started.taskId, 'test-end');
  } finally {
    await h.close();
  }
});

test('the runner feeds the monitor, and reasoning-only progress counts', async () => {
  const plan = { reasoningBlock: 'thinking hard about the problem' };
  const h = await harness({ agents: fakeAgents({ respond: plan }) });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'reason only',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.execution.reasoningOnly, true);
    const activity = settled.activity;
    assert.ok(activity !== null);
    assert.equal(activity.activityEvents > 0, true, 'a reasoning block is genuine activity');
    assert.equal(activity.kinds['reasoning-delta'] ?? 0, 0);
    // Nothing of the reasoning text is anywhere in the summary.
    assert.equal(JSON.stringify(activity).includes('thinking hard'), false);
  } finally {
    await h.close();
  }
});

test('observing an unknown or another connection\'s task is one identical refusal', async () => {
  const h = await harness({ sessionController: busySessionController() });
  try {
    const mine = h.authorize();
    const theirs = h.authorize();
    const started = await h.engine.start({
      connectionId: mine.connectionId,
      grantId: mine.grant.grantId,
      workspacePath: h.workspace,
      prompt: 'long job',
    });
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });

    const collect = async (taskId, connectionId) => {
      try {
        await h.engine.observeTask(taskId, { connectionId, waitMs: 1 });
      } catch (error) {
        return { code: error.code, message: error.message, details: JSON.stringify(error.details) };
      }
      assert.fail('the observation should have been refused');
    };
    const unknown = await collect('task-does-not-exist', mine.connectionId);
    const foreign = await collect(started.taskId, theirs.connectionId);
    const anonymous = await collect(started.taskId, null);
    assert.equal(unknown.code, JOB_CODES.taskNotFound);
    // Indistinguishable in everything that could reveal existence: the code, the
    // message, and the shape of the details. The details echo only the id the
    // caller itself supplied, which is why the ids differ and nothing else does.
    assert.equal(foreign.code, unknown.code);
    assert.equal(foreign.message, unknown.message);
    assert.deepEqual(Object.keys(JSON.parse(foreign.details)), Object.keys(JSON.parse(unknown.details)));
    assert.equal(JSON.parse(foreign.details).taskId, started.taskId, 'the echo is the caller\'s own argument');
    assert.equal(anonymous.code, JOB_CODES.taskNotFound);
    await h.engine.cancel(started.taskId, 'test-end');
  } finally {
    await h.close();
  }
});

test('a healthy run crossing the legacy 1800-second point keeps running, with no delivery reminder and ONE self-check', async () => {
  // The decisive regression for this packet: the retired global timeout was 1800 s, and a
  // run that used to be killed there must now simply continue — for hours — as long as it
  // keeps making real progress. Total runtime is not a reminder either.
  //
  // The two reminders are measured by DIFFERENT clocks, and this test pins both down:
  //  * the ten-minute self-check runs from the real start of execution, so a BUSY run is
  //    inspected exactly once (never skipped because the model kept streaming), and reading
  //    that diagnostic is NOT a result returned to anyone;
  //  * the forty-minute check is measured from the last real delivery to the commander (the
  //    run's own start opens the first interval), so a run whose every answer is an ordinary
  //    heartbeat — carrying a readable self-check diagnostic — never advances it: it reaches
  //    the reminder on schedule, and that report still leaves the run running.
  const clock = observedClock();
  // The scheduled self-check runs on a platform timer in production. The host owns that
  // timer, so this test plays its part: each round fires the armed timer once its instant
  // has passed, which is exactly what the real timer would do.
  const pendingTimers = [];
  const setTimer = (fn, delay) => {
    const handle = { fn, delay, armedAt: clock.clockMs, cleared: false, fired: false, unref() {} };
    pendingTimers.push(handle);
    return handle;
  };
  const clearTimer = (handle) => { if (handle !== null && handle !== undefined) handle.cleared = true; };
  const h = await harness({
    sessionController: busySessionController(),
    now: clock.now,
    wait: clock.wait,
    observeSliceMs: 1_000,
    timers: { setTimeout: setTimer, clearTimeout: clearTimer },
  });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'long healthy job',
    });
    const task = await waitForExecute(h.engine, started.taskId);
    // The defaults froze on the task, and NO budget bounds an ordinary run.
    assert.equal(task.effective.monitoring.selfCheckSeconds, 600);
    assert.equal(task.effective.monitoring.attentionSeconds, 2400);
    assert.equal(task.effective.worker.executionTimeoutSeconds, null);
    assert.equal(task.deadlineAt, null, 'no deadline is armed for an ordinary run');
    // The stored legacy value is still READABLE on the document; it simply does not bound

    // this run (a fresh document defaults it to 1800, and nothing applies it).
    assert.equal(typeof (await h.settings.read()).worker.timeoutSeconds, 'number');
    h.engine.onExecutionEvent(task, { type: 'turn/start', data: {} });

    // THREE hours of real output every 10 minutes, crossing 1800 s and the 40-minute
    // interval many times over. Nothing may end, and a busy run that delivered nothing new
    // produces exactly ONE reminder: the forty-minute check on its first active interval.
    let reports = 0;
    let selfCheckVerdict = null;
    /** What the engine armed and what the monitor thinks it owes, for the failure message. */
    const diagnostics = [];
    for (let minute = 10; minute <= 180; minute += 10) {
      clock.advance(10 * 60_000 - 1_000);
      // Play the host's part: fire the armed self-check timer once it is due.
      for (const handle of pendingTimers) {
        if (handle.cleared || handle.fired) continue;
        if (clock.clockMs >= handle.armedAt + handle.delay) {
          handle.fired = true;
          handle.fn();
        }
      }
      // Minute 10 is a REAL DELIVERY: the ten-minute self-check diagnostic is handed back to
      // the commander for the first time, which opens the interval the next check describes.
      const delivering = minute === 10;
      const before = task.monitor.deliveries;
      // The self-check diagnostic IS readable on this answer — and reading it must count
      // NOTHING: the run produced no new result for anyone.
      h.engine.onExecutionEvent(task, { type: 'text-delta', data: { index: 0, text: `step-${minute}` } });
      const observation = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 1_000 });
      if (observation.checkpoint === 'progress') reports += 1;
      if (observation.selfCheck !== null && observation.selfCheck.verdict !== null) selfCheckVerdict = observation.selfCheck.verdict;
      if (delivering) {
        assert.equal(observation.selfCheck.verdict, 'executor-alive-silent');
        assert.equal(task.monitor.deliveries, before,
          'reading the first self-check diagnostic is NOT a delivery and must not postpone the clock');
      }
      diagnostics.push(`minute ${minute} ${observation.reason} origin=${task.monitor.progressOrigin() - task.runStartedAt}`
        + ` due=${task.monitor.attentionDue()} delivered=${JSON.stringify(task.monitor.attentionDelivered)}`
        + ` returned=${observation.returnState?.returned}`
        + ` timer=${task.monitor.selfCheckTimer === null ? 'none' : task.monitor.selfCheckTimer.at - task.runStartedAt}`);
      assert.equal(observation.task.state, 'running', `minute ${minute}: a busy run keeps running`);
      assert.notEqual(observation.reason, OBSERVE_TASK_REASONS.ready, 'a busy run is never reported as finished');
      // A BUSY run still delivers nothing new, so every answer is a plain heartbeat except
      // the one progress check — which is a report, not a verdict.
      if (observation.reason === OBSERVE_TASK_REASONS.attention) {
        assert.equal(observation.checkpoint, 'progress');
        assert.equal(observation.task.state, 'running', 'a reminder never ends the run');
      }
    }
    // The progress check fires once the FIRST delivery interval is spent (the run start),
    // and every later heartbeat is not a delivery, so that ONE interval keeps its latch.
    assert.equal(reports, 1, `one delivery interval, one report — duration alone is never a reminder\n${diagnostics.join('\n')}`);
    // The check exists and was made once: its verdict is reported on every later answer, and
    // the run's own record shows the ONE inspection the timer performed.
    assert.equal(selfCheckVerdict, 'executor-alive-silent', 'the run was inspected, though it kept working');
    // ONE inspection for the whole run: its instant is the run's own ten-minute mark, and
    // the check was performed either by the host's timer or by the very answer that carried
    // it — never twice.
    const performed = task.monitor.lastSelfCheck();
    assert.equal(performed.sinceStartMs >= 600_000, true, 'the inspection states the run time it saw');
    const firstPerformed = task.monitor.scheduledSelfCheckAt ?? performed.checkedAt;
    assert.equal(firstPerformed - task.runStartedAt >= 600_000, true,
      `inspected ${firstPerformed - task.runStartedAt} ms after the real start, never earlier`);
    assert.equal(task.monitor.selfCheckTimer, null, 'and nothing stays armed afterwards');
    // 180 rounds of 10 minutes: thirty simulated hours, far past the retired 1800 s budget.
    // (The engine clamps one observation to 25 s, so the seam — not the wait — moves time.)
    assert.equal(Number.isFinite(task.monitor.runOrigin()), true, 'the run has a real start');
    // Nothing has been DELIVERED for hours, so the delivery clock is due and already spent.
    assert.equal(task.monitor.attentionDue(), true, 'nothing was delivered back for the whole interval');
    assert.equal(task.monitor.progressReported.origin, task.monitor.progressOrigin(), 'that interval was reported once');
    const live = h.engine.get(started.taskId);
    assert.equal(live.state, TASK_STATES.running, 'the run survived far beyond the retired 1800-second budget');
    assert.equal(live.phase, 'execute');
    assert.equal(task.slotHeld, true, 'it still holds its own concurrency slot');
    await h.engine.cancel(started.taskId, 'test-end');
  } finally {
    await h.close();
  }
});

test('a run that delivers nothing reports once, and stays running through every reminder', async () => {
  // The delivery clock: internal model steps, turn boundaries, tool activity AND the local
  // self-check diagnostic are NOT deliveries back to the commander, so they never postpone the
  // check. Only a new result the commander really receives does — and this wait channel
  // delivers that when the task ENDS.
  const clock = observedClock();
  const h = await harness({ sessionController: busySessionController(), now: clock.now, wait: clock.wait, observeSliceMs: 1_000 });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'quiet job',
    });
    const task = await waitForExecute(h.engine, started.taskId);
    // A busy executor: a real step/start and turn boundaries all the way through. NONE of
    // them is news the commander received, so the delivery clock keeps running.
    h.engine.onExecutionEvent(task, { type: 'step/start', data: {} });

    // Nine busy minutes: nothing has run its course yet, so every answer is a heartbeat even
    // though the model and its turn boundaries never stopped.
    for (let minute = 0; minute < 9; minute += 1) {
      clock.advance(60_000);
      h.engine.onExecutionEvent(task, { type: 'turn/start', data: {} });
    }
    assert.equal(task.monitor.claimAttention(clock.clockMs), false,
      'nothing is due yet, however busy the run is');
    for (let round = 0; round < 3; round += 1) {
      const quiet = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 1_000 });
      assert.equal(quiet.reason, OBSERVE_TASK_REASONS.heartbeat);
      assert.equal(quiet.checkpoint ?? null, null);
    }

    // Forty minutes of a busy run with NO delivery: the opening interval is spent, so the
    // check fires — the model's own activity never postponed it.
    clock.advance(40 * 60_000);
    const first = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 1_000 });
    assert.equal(first.reason, OBSERVE_TASK_REASONS.attention, 'a busy run with no delivery is reported');
    assert.equal(first.checkpoint, 'progress');
    // A reminder is a REPORT about the interval that just ran out, never a delivery of progress:
    // the clock is measured from the run's own start and nothing since then moved it.
    assert.equal(first.returnState.returned, false, 'the reminder itself is not a delivery');
    assert.equal(task.monitor.deliveries, 0, 'and no diagnostic or internal event counted as one');

    // Nothing about the run changed: same state, same phase, still holding its slot.
    assert.equal(h.engine.get(started.taskId).state, TASK_STATES.running);
    assert.equal(h.engine.get(started.taskId).phase, 'execute');
    assert.equal(task.slotHeld, true, 'a reminder never releases or takes a concurrency slot');
    assert.equal(h.engine.locks.isLocked(h.workspace), true, 'nor a workspace lease');

    // Hours later, with nothing delivered in between: at most ONE report per interval. A
    // single long wait can legitimately be answered on its way out, so the assertion is on
    // the LATENCY — an answer that is not a reminder is never starved for long.
    clock.advance(3 * 60 * 60_000);
    const later = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 1_000 });
    if (later.reason === OBSERVE_TASK_REASONS.attention) {
      assert.equal(later.checkpoint, 'progress', 'only the run progress check can be reported');
      assert.equal(later.task.state, TASK_STATES.running, 'and the run keeps running');
    } else {
      assert.equal(later.reason, OBSERVE_TASK_REASONS.heartbeat, 'a quiet answer is a heartbeat');
      assert.equal(later.checkpoint ?? null, null);
    }

    await h.engine.cancel(started.taskId, 'test-end');
  } finally {
    await h.close();
  }
});

test('each reminder can be switched off without disturbing the other', async () => {
  const cases = [
    // self-check off: nothing is ever inspected, and the delivery check is unaffected.
    { monitoring: { selfCheckSeconds: 0, attentionSeconds: 2400 }, expectSelfCheckOff: true },
    // delivery check off: the self-check keeps its own clock and still runs once.
    { monitoring: { selfCheckSeconds: 600, attentionSeconds: 0 }, expectSelfCheckOff: false },
  ];
  for (const testCase of cases) {
    const clock = observedClock();
    const h = await harness({
      sessionController: busySessionController(),
      now: clock.now,
      wait: clock.wait,
      observeSliceMs: 1_000,
      settings: validSettings({ monitoring: testCase.monitoring }),
    });
    try {
      const { connectionId, grant } = h.authorize();
      const started = await h.engine.start({
        connectionId,
        grantId: grant.grantId,
        workspacePath: h.workspace,
        prompt: 'quiet job',
      });
      const task = await waitForExecute(h.engine, started.taskId);
      // A busy run for an hour: real `step/start` events throughout. The delivery clock is
      // NOT moved by them, and each switch must hold on its OWN interval.
      let reports = 0;
      for (let minute = 0; minute < 60; minute += 1) {
        clock.advance(60_000);
        h.engine.onExecutionEvent(task, { type: 'step/start', data: {} });
        const observation = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 1 });
        if (observation.checkpoint === 'progress') reports += 1;
        else if (observation.checkpoint === 'stall') assert.fail('no second checkpoint label exists');
        assert.equal(observation.reason === OBSERVE_TASK_REASONS.attention, observation.checkpoint === 'progress',
          'attention and the progress checkpoint are the same event');
        assert.equal(observation.task.state, TASK_STATES.running, 'no reminder ends the run');
      }
      // ONE interval of no delivery, so at most ONE report — and a disabled reminder never
      // reports at all.
      assert.equal(reports, testCase.monitoring.attentionSeconds === 0 ? 0 : 1,
        `the delivery check fires once, or never when it is off (${JSON.stringify(testCase.monitoring)})`);
      // The self-check is its own switch, read from the monitor's own state.
      if (testCase.expectSelfCheckOff) {
        assert.equal(task.monitor.selfCheckMs, 0, 'a disabled self-check is OFF in the monitor');
        assert.equal(task.monitor.selfCheckDue(clock.clockMs + 10 * 60 * 60_000), false);
        assert.equal(task.monitor.runSelfCheck(clock.clockMs), null, 'and it never runs');
        // A disabled check does not disturb the reminder measured beside it.
        assert.equal(task.monitor.attentionMs, 2_400_000);
      } else {
        assert.equal(task.monitor.selfCheckMs, 600_000, 'an enabled self-check keeps its interval');
        // The inspection happened on the run's own ten-minute mark, even though the run was
        // busy the whole time — that is the point of measuring from the start.
        assert.equal(task.monitor.lastSelfCheck()?.verdict, 'executor-alive-silent');
        assert.equal(task.monitor.lastSelfCheck().sinceStartMs >= 600_000, true);
        // A self-check is a READ: it never changes the run.
        assert.equal(h.engine.get(started.taskId).state, TASK_STATES.running);
        // A disabled delivery check never reports.
        assert.equal(task.monitor.attentionMs, 0);
        assert.equal(task.monitor.attentionDue(clock.clockMs + 10 * 60 * 60_000), true,
          'due is true by duration, but the switch still refuses to report');
        assert.equal(task.monitor.claimAttention(clock.clockMs), false, 'an off reminder can never be claimed');
      }
      await h.engine.cancel(started.taskId, 'test-end');
    } finally {
      await h.close();
    }
  }
});

test('a live run gets its scheduled self-check with no observer, and teardown leaves no timer', async () => {
  // The product requirement: ten minutes after the run REALLY started, the engine inspects
  // it ONCE — even though nothing ever calls observe, and even if the run is busy.
  const clock = observedClock();
  const timers = [];
  // The fake mirrors the REAL delay cap: a delay a platform timer cannot express is
  // clamped to the platform maximum, so the test sees the same scheduling the engine does.
  const setTimer = (fn, delay) => {
    const handle = { fn, delay: Math.min(delay, 2_147_483_647), armedAt: clock.clockMs, cleared: false, fired: false, unref() {} };
    timers.push(handle);
    return handle;
  };
  const clearTimer = (handle) => { if (handle !== null && handle !== undefined) handle.cleared = true; };
  const armed = () => timers.filter((handle) => !handle.cleared && !handle.fired);
  const h = await harness({
    sessionController: busySessionController(),
    now: clock.now,
    wait: clock.wait,
    observeSliceMs: 1_000,
    timers: { setTimeout: setTimer, clearTimeout: clearTimer },
  });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'quiet job',
    });
    const task = await waitForExecute(h.engine, started.taskId);
    // The run armed exactly ONE timer for its frozen 10-minute threshold, from the real
    // start of execution (the engine's own stamp, in the clock the monitor reads).
    const first = armed();
    assert.equal(first.length, 1, 'one scheduled self-check for the run');
    assert.equal(first[0].delay, 600_000, 'armed for selfCheckSeconds, not a third clock');
    assert.equal(task.monitor.selfCheckTimer.at, task.runStartedAt + 600_000, 'measured from the real start');
    // NO OBSERVATION AT ALL — and a BUSY executor: internal output the whole way must not
    // postpone the inspection.
    clock.advance(300_000);
    h.engine.onExecutionEvent(task, { type: 'text-delta', data: { index: 0, text: 'still working' } });
    assert.equal(task.monitor.lastSelfCheck(), null, 'halfway: nothing inspected yet');
    assert.equal(task.monitor.selfCheckTimer !== null, true, 'and the one timer is still pending');
    assert.equal(armed().length, 1, 'a busy run does not stack timers');
    // Move the clock to the instant the timer was armed for and fire it, exactly as the
    // platform would.
    clock.advance(300_000);
    first[0].fired = true;
    first[0].fn();
    const diagnostic = task.monitor.lastSelfCheck();
    assert.ok(diagnostic !== null, 'the inspection happened with no observer, during a busy run');
    assert.equal(diagnostic.verdict, 'executor-alive-silent');
    assert.equal(diagnostic.sinceStartMs >= 600_000, true, 'the check states the time since the run started');
    assert.equal(task.monitor.scheduledSelfCheckAt, diagnostic.checkedAt, 'the timer is what performed it');
    // The two independent fields are both stated by the check.
    assert.equal(typeof diagnostic.noDeliveryMs, 'number', 'how long nothing was returned');
    assert.equal(diagnostic.detail.activity.kind, 'model-working', 'and what DSH is doing');
    // The run itself is untouched by a read-only inspection.
    assert.equal(h.engine.get(started.taskId).state, TASK_STATES.running);
    assert.equal(task.slotHeld, true, 'a self-check never releases or takes a slot');
    // Once per RUN, not once per silence: more output arms NOTHING new.
    h.engine.onExecutionEvent(task, { type: 'step/start', data: {} });
    assert.equal(armed().length, 0, 'the run is inspected once, so nothing stays armed');

    // Cancelling the run clears it: a terminal task leaves no timer behind.
    await h.engine.cancel(started.taskId, 'test-end');
    assert.equal(armed().length, 0, 'cancel clears the scheduled self-check');
    assert.equal(task.monitor.selfCheckTimer, null);
  } finally {
    await h.close();
  }
});

test('a busy long run is inspected once on its own timer and never stacks timers', async () => {
  const clock = observedClock();
  const timers = [];
  // The fake mirrors the REAL delay cap: a delay a platform timer cannot express is
  // clamped to the platform maximum, so the test sees the same scheduling the engine does.
  const setTimer = (fn, delay) => {
    const handle = { fn, delay: Math.min(delay, 2_147_483_647), armedAt: clock.clockMs, cleared: false, fired: false, unref() {} };
    timers.push(handle);
    return handle;
  };
  const clearTimer = (handle) => { if (handle !== null && handle !== undefined) handle.cleared = true; };
  const armed = () => timers.filter((handle) => !handle.cleared && !handle.fired);
  const h = await harness({
    sessionController: busySessionController(),
    now: clock.now,
    wait: clock.wait,
    observeSliceMs: 1_000,
    timers: { setTimeout: setTimer, clearTimeout: clearTimer },
  });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'busy job',
    });
    const task = await waitForExecute(h.engine, started.taskId);
    // Real output every 5 minutes for an hour — a busy run. The ten-minute inspection is
    // measured from the START, so it happens exactly once, at ~10 minutes, and never
    // again: the HOST is what fires the scheduled timer here (the platform owns it), so
    // this test plays that role at the instant the engine armed it for.
    let inspectedAt = [];
    for (let minute = 5; minute <= 60; minute += 5) {
      clock.advance(5 * 60_000 - 1_000);
      h.engine.onExecutionEvent(task, { type: 'text-delta', data: { index: 0, text: `step-${minute}` } });
      // At most ONE timer exists at any moment, armed for the run's own start instant.
      assert.equal(armed().filter((handle) => handle.cleared === false).length <= 1, true,
        `at most one timer exists (minute ${minute})`);
      const pending = armed()[0];
      if (pending !== undefined && clock.clockMs >= pending.armedAt + pending.delay) {
        pending.fired = true;
        pending.fn();
      }
      const diagnostic = task.monitor.lastSelfCheck();
      if (diagnostic !== null && diagnostic.checkedAt > (inspectedAt.at(-1) ?? -1)) inspectedAt.push(diagnostic.checkedAt);
      if (diagnostic === null) assert.equal(task.monitor.selfCheckTimer !== null, true, `the timer is still pending (minute ${minute})`);
      else assert.equal(task.monitor.selfCheckTimer, null, `no timer survives its one inspection (minute ${minute})`);
    }
    assert.equal(inspectedAt.length, 1, 'a busy run is inspected ONCE, not skipped and not repeated');
    assert.equal(inspectedAt[0] - task.runStartedAt >= 600_000, true,
      `inspected ${inspectedAt[0] - task.runStartedAt} ms after the real start, never earlier`);
    await h.engine.cancel(started.taskId, 'test-end');
    assert.equal(armed().length, 0, 'and teardown leaves none');
  } finally {
    await h.close();
  }
});

test('a run whose tools stay busy is reported at the 40-minute mark, even though its self-check is readable', async () => {
  // The defect this test pins down: the FIRST wait starts BEFORE the local self-check has run;
  // the observer then reads that self-check diagnostic on the SAME task; and the run keeps a
  // tool, a tool result and a model step going the whole time. Reading the diagnostic is a read
  // of local facts, NOT a result returned to anyone, so it must NOT reset the 40-minute clock.
  // One millisecond before the interval the answer is a heartbeat; AT it the SAME taskId reports
  // the run progress check, the run is still `running`, and its real delivery is untouched.
  const clock = observedClock();
  const h = await harness({ sessionController: busySessionController(), now: clock.now, wait: clock.wait, observeSliceMs: 1_000 });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'busy job with a tool',
    });
    const task = await waitForExecute(h.engine, started.taskId);
    // The baseline: the run really started, and nothing has been delivered to anyone yet.
    assert.equal(Number.isFinite(task.runStartedAt), true, 'the run has a real start');
    assert.equal(task.monitor.progressOrigin(), task.runStartedAt, 'the first interval begins at the start');
    assert.equal(task.monitor.deliveries, 0, 'the start is a baseline, not a delivery');

    // THE FIRST WAIT, before the self-check exists. The executor is busy: a step, a tool call
    // and its result — real internal work, and none of it is a result for the commander.
    clock.advance(30_000);
    h.engine.onExecutionEvent(task, { type: 'step/start', data: {} });
    h.engine.onExecutionEvent(task, { type: 'tool/call', data: { callId: 'c-1', name: 'bash', arguments: '{"command":"npm test"}' } });
    const early = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 25_000 });
    assert.equal(early.reason, OBSERVE_TASK_REASONS.heartbeat, 'the first wait answers a heartbeat');
    assert.equal(early.selfCheck.verdict, null, 'and no self-check has run yet');

    // The tool settles and the model keeps working: still internal, still not a delivery. The
    // clock is placed exactly at the run's own ten-minute mark, where its armed inspection is due.
    clock.state.current = task.runStartedAt + 600_000;
    h.engine.onExecutionEvent(task, { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'c-1', content: [{ type: 'text', text: 'ok' }] } } });
    h.engine.onExecutionEvent(task, { type: 'text-delta', data: { index: 0, text: 'continuing' } });

    // The run is now past its own ten-minute mark, so the inspection it armed at the start is
    // due. The observer reads the diagnostic on the same task: it is available, and reading it
    // moves nothing.
    const checked = task.monitor.runSelfCheck();
    assert.ok(checked !== null, 'the run is inspected at its own ten-minute mark');
    const reading = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 1_000 });
    assert.equal(reading.selfCheck.verdict, 'executor-alive-silent', 'the diagnostic is readable');
    assert.notEqual(reading.selfCheck.checkedAt, null, 'and it states when it ran');
    assert.equal(reading.returnState.returned, false, 'reading it is not a delivery');
    assert.equal(task.monitor.progressOrigin(), task.runStartedAt, 'the interval is still the opening one');
    assert.equal(task.monitor.deliveries, 0, 'no diagnostic counted as a result');

    // Keep the tool activity going all the way to the mark, so nothing here is "silence".
    const dueAt = task.runStartedAt + task.effective.monitoring.attentionSeconds * 1_000;
    for (let step = 0; step < 6; step += 1) {
      clock.advance(Math.floor((dueAt - 1_000 - clock.clockMs) / (6 - step)));
      h.engine.onExecutionEvent(task, { type: 'tool/call', data: { callId: `c-${step + 2}`, name: 'bash', arguments: '{"command":"ls"}' } });
      h.engine.onExecutionEvent(task, { type: 'tool/result', data: { message: { role: 'tool', toolCallId: `c-${step + 2}`, content: [{ type: 'text', text: 'ok' }] } } });
    }
    // ONE MILLISECOND BEFORE the interval, asked with a wait that ends BEFORE the mark: no
    // reminder is produced. (A wait that ends exactly ON the mark is reported — that is the
    // earliest a caller can be told, and it is not early.)
    clock.state.current = dueAt - 2_000;
    const justBefore = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 1_000 });
    assert.equal(justBefore.reason, OBSERVE_TASK_REASONS.heartbeat, 'before the mark is not a reminder');
    assert.equal(justBefore.checkpoint ?? null, null);
    assert.equal(task.monitor.progressReported, null, 'and nothing was reported yet');

    // AT the interval, on the SAME taskId: the progress check, once, and the run still runs.
    clock.state.current = dueAt;
    const attention = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 1_000 });
    assert.equal(attention.reason, OBSERVE_TASK_REASONS.attention, 'the interval is reported at its mark');
    assert.equal(attention.checkpoint, 'progress');
    assert.equal(attention.task.taskId, started.taskId, 'on the SAME taskId');
    assert.equal(attention.task.state, TASK_STATES.running, 'the run keeps running');
    assert.equal(attention.progress.noDeliveryForMs, 2_400_000, 'measured from the start baseline');
    assert.equal(attention.progress.activity.kind, 'model-working', 'and it states what DSH is doing');
    assert.equal(attention.returnState.returned, false, 'the reminder is not a delivery');
    // And only ONE: asking again at the same instant answers nothing new.
    const again = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 1_000 });
    assert.equal(again.reason, OBSERVE_TASK_REASONS.heartbeat, 'one interval, one report');

    // The real delivery is untouched by all of this: the run ends normally and IS the result.
    const settled = await h.engine.cancel(started.taskId, 'test-end');
    assert.equal(settled.state, TASK_STATES.cancelled, 'a reminder never stopped or changed the run');
  } finally {
    await h.close();
  }
});

test('a single observation that spans the whole interval reports it once, on the same task', async () => {
  const clock = observedClock();
  const h = await harness({ sessionController: busySessionController(), now: clock.now, wait: clock.wait, observeSliceMs: 1_000 });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'long job',
    });
    const task = await waitForExecute(h.engine, started.taskId);
    // Anchor the episode on one real event, through the engine hook the runner uses.
    h.engine.onExecutionEvent(task, { type: 'step/start', data: {} });

    // Well under the threshold, while the executor is BUSY: the answer is a heartbeat and
    // nothing is due. Internal activity is never a delivery, so it cannot postpone the check
    // either — it simply does not advance the clock. (The loop stops BEFORE the threshold, so
    // the reminder below is produced by the single wait that spans it.)
    for (let minute = 1; minute <= 36; minute += 1) {
      clock.advance(60_000);
      h.engine.onExecutionEvent(task, { type: 'step/start', data: {} });
      if (minute % 10 !== 0) continue;
      const busy = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 1_000 });
      assert.equal(busy.reason, OBSERVE_TASK_REASONS.heartbeat, `minute ${minute}: a busy run answers nothing new`);
      assert.equal(busy.checkpoint ?? null, null);
      assert.equal(busy.task.phase, 'execute', 'a run the engine has seen working reports execute');
    }

    // Cross that interval, one waiting turn at a time: the reminder arrives as soon as the due
    // instant has passed. Each turn waits as long as the documented bound allows, so the
    // observation that spans the due instant answers on its way out.
    let attention = null;
    for (let turn = 0; turn < 8; turn += 1) {
      attention = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 25_000 });
      if (attention.reason === OBSERVE_TASK_REASONS.attention) break;
      assert.equal(attention.reason, OBSERVE_TASK_REASONS.heartbeat, `turn ${turn}: a bounded wait may end first`);
      clock.advance(20 * 60_000);
    }
    assert.equal(attention.reason, OBSERVE_TASK_REASONS.attention,
      `now=${clock.clockMs - task.runStartedAt} origin=${task.monitor.progressOrigin() - task.runStartedAt}`
      + ` due=${task.monitor.attentionDue()} next=${task.monitor.nextAttentionAt() - task.runStartedAt}`
      + ` delivered=${JSON.stringify(task.monitor.attentionDelivered)}`
      + ` reported=${JSON.stringify(task.monitor.progressReported)}`
      + ` waited=${attention.wait.waitedMs} state=${attention.task.state}`);
    assert.equal(attention.checkpoint, 'progress', 'the run progress check');
    assert.equal(attention.progress.thresholdSeconds, 2400);
    assert.equal(attention.progress.noDeliveryForMs >= 2_400_000, true, 'nothing was delivered in that interval');
    // The reminder is a report about the interval that ran out, never a delivery of progress.
    assert.equal(attention.returnState.returned, false, 'the check itself is not a delivery');
    // The two independent fields: how long nothing was returned, and what DSH is doing.
    assert.equal(typeof attention.progress.activity.kind, 'string');
    assert.equal(attention.progress.activity.kind, 'model-working', 'a busy run is described as working');

    // The interval's latch: the next request stays silent, and stays silent for the rest of
    // this interval however long it lasts — the heartbeat is not a delivery.
    clock.advance(1_000);
    const cooled = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 1_000 });
    assert.equal(cooled.reason, OBSERVE_TASK_REASONS.heartbeat);
    clock.advance(3 * 60 * 60_000);
    const later = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 1_000 });
    // One interval, one report: nothing new can be reported for the interval the reminder
    // already described, so the only answers are heartbeats.
    assert.equal(later.reason, OBSERVE_TASK_REASONS.heartbeat, 'one interval, one report');
    assert.equal(later.checkpoint ?? null, null);
    await h.engine.cancel(started.taskId, 'test-end');
  } finally {
    await h.close();
  }
});
test('an observation returns a compact summary with the self-check diagnostic', async () => {
  const clock = observedClock();
  const h = await harness({ sessionController: busySessionController(), now: clock.now, wait: clock.wait });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'long job',
    });
    const task = await waitForExecute(h.engine, started.taskId);
    task.monitor.onEvent({ type: 'text-delta', data: { text: 'working' } }, clock.clockMs);
    // Past the 10-minute self-check mark, inside the 40-minute progress interval: the
    // observation stays a heartbeat and its own bounded wait spans the check.
    clock.advance(660_000);

    const observation = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 25_000 });
    assert.equal(observation.reason, OBSERVE_TASK_REASONS.heartbeat);
    const { task: summary } = observation;
    for (const field of ['taskId', 'state', 'phase', 'elapsedMs', 'lastActivityAt', 'currentTool', 'idleForMs']) {
      assert.equal(Object.hasOwn(summary, field), true, `the summary must state ${field}`);
    }
    assert.equal(summary.taskId, started.taskId);
    assert.equal(summary.route.providerId, 'relay');
    assert.equal(summary.route.model, 'deepseek-chat');
    assert.equal(summary.route.monitoring.selfCheckSeconds, 600, 'the 10-minute default is frozen on the task');
    // The ten-minute self-check ran inside the wait and is reported.
    assert.equal(observation.selfCheck.verdict, 'executor-alive-silent');
    assert.equal(summary.selfCheck.verdict, 'executor-alive-silent');
    assert.equal(observation.wait.waitMs, 25_000);
    // No transcript, no execution text, no diff on a running summary.
    assert.equal(Object.hasOwn(summary, 'execution'), false);
    assert.equal(Object.hasOwn(summary, 'diff'), false);
    assert.equal(Object.hasOwn(summary, 'prompt'), false);
    await h.engine.cancel(started.taskId, 'test-end');
  } finally {
    await h.close();
  }
});

test('a pending permission is reported with its full decidable view', async () => {
  const clock = observedClock();
  const h = await harness({ sessionController: busySessionController(), now: clock.now, wait: clock.wait });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'long job',
    });
    const task = await waitForExecute(h.engine, started.taskId);
    const pendingView = {
      requestId: 'permission-1',
      taskId: started.taskId,
      toolName: 'bash',
      callId: 'call-1',
      state: 'pending',
      arguments: '{"command":"npm test"}',
      argumentsRedacted: true,
      completeness: 'complete',
      argumentsComplete: true,
      boundsApplied: [],
      allowBlocked: null,
      fingerprint: 'f'.repeat(64),
      standingModeUnchanged: true,
    };
    h.engine.onPermissionPending(task, pendingView);

    const observation = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 25_000 });
    assert.equal(observation.reason, OBSERVE_TASK_REASONS.permission);
    assert.ok(observation.permission !== null, 'the permission reason must carry the request');
    // The WHLE operation travels: without the fingerprint and completeness facts a
    // decision could not be made.
    assert.equal(observation.permission.fingerprint, 'f'.repeat(64));
    assert.equal(observation.permission.completeness, 'complete');
    assert.equal(observation.permission.arguments, '{"command":"npm test"}');
    assert.equal(observation.permission.callId, 'call-1');
    assert.equal(observation.permission.toolName, 'bash');
    await h.engine.cancel(started.taskId, 'test-end');
  } finally {
    await h.close();
  }
});

test('a terminal task reports its outcome, never a heartbeat', async () => {
  const h = await harness();
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    await settle(h.engine, started.taskId);
    const observation = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 25_000 });
    assert.equal(observation.reason, OBSERVE_TASK_REASONS.ready);
    assert.equal(observation.task.state, 'awaiting-host-review');
    assert.equal(observation.permission, null);
  } finally {
    await h.close();
  }
});

test('an aborted observation releases only the reader and leaves the worker running', async () => {
  const clock = observedClock();
  const h = await harness({ sessionController: busySessionController(), now: clock.now, wait: clock.wait });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'long job',
    });
    const task = await waitForExecute(h.engine, started.taskId);
    task.monitor.onEvent({ type: 'text-delta', data: { text: 'working' } }, clock.clockMs);

    const controller = new AbortController();
    const pending = h.engine.observeTask(started.taskId, { connectionId, waitMs: 25_000, signal: controller.signal });
    clock.advance(25_000);
    controller.abort();
    const observation = await pending;
    assert.equal(observation.reason, OBSERVE_TASK_REASONS.interrupted);
    // The worker is untouched: same state, same phase, still holding its slot.
    assert.equal(task.state, 'running');
    assert.equal(typeof task.phase, 'string');
    assert.equal(task.endedAt, null);
    assert.equal(task.slotHeld, true);
    assert.equal(task.cancelRequested, false);
    assert.equal(h.engine.observers.size, 0, 'the observer registration is released');
    await h.engine.cancel(started.taskId, 'test-end');
  } finally {
    await h.close();
  }
});

test('disposing the engine releases every observation and stops the monitors', async () => {
  const clock = observedClock();
  const h = await harness({ sessionController: busySessionController(), now: clock.now, wait: clock.wait });
  const { connectionId, grant } = h.authorize();
  const started = await h.engine.start({
    connectionId,
    grantId: grant.grantId,
    workspacePath: h.workspace,
    prompt: 'long job',
  });
  const pending = h.engine.observeTask(started.taskId, { connectionId, waitMs: 25_000 });
  await h.engine.dispose();
  const observation = await pending;
  assert.equal(observation.reason, OBSERVE_TASK_REASONS.interrupted);
  assert.equal(h.engine.observers.size, 0);
  await cleanup(h.dir);
});

test('the task view publishes bounded activity without any model text', async () => {
  const h = await harness({ agents: fakeAgents({ respond: { reasoning: 'PRIVATE THOUGHTS', text: 'PRIVATE ANSWER' } }) });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    const serialized = JSON.stringify(settled.activity);
    assert.equal(serialized.includes('PRIVATE THOUGHTS'), false);
    assert.equal(serialized.includes('PRIVATE ANSWER'), false);
    assert.equal(settled.activity.events > 0, true);
  } finally {
    await h.close();
  }
});

test('one observation never exceeds its documented bound, whatever it finds', async () => {
  // A caller (the HTTP adapter) promises <=25 s. An internal re-wait would double
  // that and blow the adapter's own request timeout, so exactly ONE bounded wait is
  // allowed per call — a heartbeat must be returned, not silently extended.
  const clock = observedClock();
  const h = await harness({ sessionController: busySessionController(), now: clock.now, wait: clock.wait });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'long job',
    });
    const task = await waitForExecute(h.engine, started.taskId);
    task.monitor.onEvent({ type: 'text-delta', data: { text: 'working' } }, clock.clockMs);

    const before = clock.clockMs;
    const observation = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 25_000 });
    const elapsed = clock.clockMs - before;
    assert.equal(observation.reason, OBSERVE_TASK_REASONS.heartbeat);
    assert.equal(elapsed <= 25_000, true, `one call must not exceed 25 s (observed ${elapsed} ms)`);
    assert.equal(observation.wait.waitedMs <= 25_000, true);
    await h.engine.cancel(started.taskId, 'test-end');
  } finally {
    await h.close();
  }
});

test('an observation started before execute() keeps receiving the run\'s events', async () => {
  // A task can be observed while still `pending` (admitted, thresholds frozen). If
  // `execute` replaced the monitor, that observer would watch an object that never
  // receives another event and stay silent forever.
  const clock = observedClock();
  const h = await harness({ sessionController: busySessionController(), now: clock.now, wait: clock.wait });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'long job',
    });
    const task = await waitForExecute(h.engine, started.taskId);
    const monitor = task.monitor;
    assert.ok(monitor !== null && monitor !== undefined);

    // The monitor the observation used is the SAME object the executor feeds.
    task.monitor = monitor;
    monitor.onEvent({ type: 'text-delta', data: { text: 'delivered' } }, clock.clockMs);
    assert.equal(monitor.activity.activityEvents(), 1, 'events reach the one monitor');
    assert.equal(h.engine.ensureMonitor(task), monitor, 'ensureMonitor never replaces a live monitor');

    clock.advance(590_000);
    const observation = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 1_000 });
    // 590 s of silence is under the 600 s threshold, so it is still silent — which
    // is only true if the observed monitor is the one that recorded the activity.
    assert.equal(observation.reason, OBSERVE_TASK_REASONS.heartbeat);
    assert.equal(observation.activity.activityEvents, 1);
    await h.engine.cancel(started.taskId, 'test-end');
  } finally {
    await h.close();
  }
});

test('a settled task with a stale permission block reports the outcome, not a decision', async () => {
  // A run stopped while a request was outstanding keeps the block as history. It
  // must not be offered as a live decision forever.
  const h = await harness();
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, 'awaiting-host-review');
    const task = h.engine.tasks.get(started.taskId);
    // Simulate the stale block a stopped run leaves behind.
    task.permission.pending = { requestId: 'permission-stale', state: 'pending' };

    const observation = await h.engine.observeTask(started.taskId, { connectionId, waitMs: 25_000 });
    assert.equal(observation.reason, OBSERVE_TASK_REASONS.ready, 'the outcome outranks the stale block');
    assert.equal(observation.permission, null, 'no decision is offered for a call that no longer exists');
  } finally {
    await h.close();
  }
});

test('a settled task reports a frozen idle span', async () => {
  const h = await harness();
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.activity.finalizedAt, settled.endedAt, 'the record is frozen at the end');
    // The delivery clock is frozen too: once the run has ended nobody can be told anything
    // more, so "nothing returned for N" stops growing instead of describing a wait that no
    // action could have shortened. It is not negative, and it is not re-derived afterwards.
    const frozen = settled.activity.progressCheck;
    assert.equal(Number.isFinite(frozen.noDeliveryForMs), true, 'the delivery span is a real number');
    assert.equal(frozen.noDeliveryForMs >= 0, true, 'a frozen span is never negative');
    // A settled run also says WHERE its span was frozen at: the recorded end, not the wall
    // clock, so the value cannot keep growing after the reader stopped watching.
    const live = liveTask(h.engine, started.taskId);
    assert.equal(live.monitor.deliveredAtMs !== null, true, 'the delivery span is frozen once the run ends');
    assert.equal(Number.isFinite(live.monitor.deliveredAtMs), true, 'and it is frozen at a real instant');
    // The frozen origin never moves again, whoever asks and whenever.
    const originBefore = live.monitor.progressOrigin();
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 25); });
    assert.equal(live.monitor.progressOrigin(), originBefore, 'a frozen delivery origin never drifts');

    // A later read cannot grow: the same query returns the same spans.
    const first = h.engine.get(started.taskId).activity;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });
    const second = h.engine.get(started.taskId).activity;
    assert.deepEqual(second, first, 'terminal metadata does not drift');
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Truthful execution phases: the phase follows the executor, not a promise
// ---------------------------------------------------------------------------
//
// These tests drive the engine's OWN event hook (`engine.onExecutionEvent`, exactly
// what the runner's `onEvent` calls) against a task record the engine just made
// live. They deliberately do not reach into a resolved Agent's listener list: the
// listeners belong to a native service whose setup order is not this contract, and a
// test that raced that setup would fail for a reason the phase rule does not have.

/**
 * Start a real task through the engine and hand back its live record.
 * @param {object} h - harness.
 * @param {string} [prompt] - task prompt.
 * @returns {Promise<object>} the live task record.
 */
async function startedTask(h, prompt = 'go', overrides = undefined) {
  const { connectionId, grant } = h.authorize();
  const started = await h.engine.start({
    connectionId,
    grantId: grant.grantId,
    workspacePath: h.workspace,
    prompt,
    ...(overrides === undefined ? {} : { overrides }),
  });
  return h.engine.tasks.get(started.taskId);
}

/**
 * Start a task whose executor never settles, so it stays live for the assertions.
 * @param {object} h - harness built over {@link busySessionController}.
 * @param {object} [overrides] - bounded per-job overrides (for example an explicit
 *   `timeoutSeconds`, the one retained way to give a run a total budget).
 * @returns {Promise<object>} the live task record.
 */
async function startedLongTask(h, overrides = undefined) {
  const task = await startedTask(h, 'long job', overrides);
  await waitForExecute(h.engine, task.taskId);
  return task;
}

test('recognised executor activity advances a live task from before-create to execute', async () => {
  const h = await harness({ sessionController: busySessionController() });
  try {
    const task = await startedLongTask(h);

    // Nothing has been emitted, so the executor's work is not yet visible: the task
    // is live, past admission, and does NOT claim execution.
    assert.equal(task.state, TASK_STATES.running);
    assert.equal(task.phase, 'before-create',
      'a pending native create is not execution, so the phase must not claim it');

    // The native loop opens a turn: that is the executor working.
    h.engine.onExecutionEvent(task, { type: 'turn/start', data: {} });
    assert.equal(task.phase, 'execute', 'recognised executor activity publishes execute');
    assert.equal(h.engine.get(task.taskId).phase, 'execute', 'the published view agrees');

    await h.engine.cancel(task.taskId, 'test-end');
  } finally {
    await h.close();
  }
});

test('a later tool step keeps a running task in execute and never rewinds the phase', async () => {
  const h = await harness({ sessionController: busySessionController() });
  try {
    const task = await startedLongTask(h);

    h.engine.onExecutionEvent(task, { type: 'step/start', data: {} });
    assert.equal(task.phase, 'execute');

    // Streaming output and a settled tool result are ordinary running activity: the
    // phase is already past `before-create`, so nothing here moves it back.
    h.engine.onExecutionEvent(task, { type: 'text-delta', index: 0, text: 'partial answer' });
    h.engine.onExecutionEvent(task, { type: 'tool/call', data: { name: 'read', callId: 'c-1' } });
    h.engine.onExecutionEvent(task, { type: 'tool/result', data: { message: { toolCallId: 'c-1' } } });
    assert.equal(task.phase, 'execute');
    assert.equal(task.state, TASK_STATES.running);

    await h.engine.cancel(task.taskId, 'test-end');
  } finally {
    await h.close();
  }
});

test('events that carry no execution evidence do not assert execution', async () => {
  // The phase is a claim about the executor. A bookkeeping event or an
  // unrecognised type is not evidence anything ran, so a run whose model has not
  // started is not described as executing yet.
  const h = await harness({ sessionController: busySessionController() });
  try {
    const task = await startedLongTask(h);

    h.engine.onExecutionEvent(task, { type: 'usage', data: {} });
    h.engine.onExecutionEvent(task, { type: 'some/unknown-event', data: {} });
    assert.equal(task.phase, 'before-create', 'a non-evidence event must not assert execution');

    // A streaming chunk alone is not proof either: it can arrive empty while a
    // provider is still connecting.
    h.engine.onExecutionEvent(task, { type: 'text-delta', index: 0, text: 'hi' });
    assert.equal(task.phase, 'before-create');

    await h.engine.cancel(task.taskId, 'test-end');
  } finally {
    await h.close();
  }
});

test('a pending permission wait is never overwritten by a late event', async () => {
  const h = await harness({ sessionController: busySessionController() });
  try {
    const task = await startedLongTask(h);
    h.engine.onExecutionEvent(task, { type: 'turn/start', data: {} });
    assert.equal(task.phase, 'execute');

    // The worker pauses on a per-call decision: the phase now states the WAIT.
    h.engine.onPermissionPending(task, {
      requestId: 'permission-phase', taskId: task.taskId, callId: 'c-1', toolName: 'write', state: 'pending',
    });
    assert.equal(task.phase, 'awaiting-permission');

    // A late event belongs to the paused call, not to a resumption.
    h.engine.onExecutionEvent(task, { type: 'tool/result', data: { message: { toolCallId: 'c-1' } } });
    h.engine.onExecutionEvent(task, { type: 'step/start', data: {} });
    assert.equal(task.phase, 'awaiting-permission', 'a late event never overwrites the permission wait');
    assert.equal(task.state, TASK_STATES.running, 'waiting is not a new state');

    // Settling returns the task to execution.
    h.engine.onPermissionSettled(task, {
      requestId: 'permission-phase', outcome: 'allowed-once', state: 'decided', decidedBy: 'commander',
    });
    assert.equal(task.phase, 'execute');
    // The internal record has no `waiting` field (that is a projection concern), so the
    // internal assertion is on the pending slot itself; `waiting` is checked on the
    // public view, which is where the engine actually derives it.
    assert.equal(task.permission.pending, null);
    assert.equal(h.engine.get(task.taskId).permission.waiting, false);

    await h.engine.cancel(task.taskId, 'test-end');
  } finally {
    await h.close();
  }
});

test('a failed execution publishes the failed phase while keeping its own error', async () => {
  const agents = fakeAgents({ respond: { error: new Error('provider exploded') } });
  const h = await harness({ agents });
  try {
    const task = await startedTask(h);
    const settled = await settle(h.engine, task.taskId);
    assert.equal(settled.state, TASK_STATES.failed);
    assert.equal(settled.error.code, JOB_CODES.executionFailed, JSON.stringify(settled.error));
    assert.equal(settled.phase, 'failed', 'the phase states the same ending as the state');
    // The separate diagnostic is preserved, not folded into the phase.
    assert.match(settled.error.message, /provider exploded/);
  } finally {
    await h.close();
  }
});

test('a run that produced no output ends failed with the failed phase', async () => {
  const agents = fakeAgents({ respond: { reason: 'completed' } });
  const h = await harness({ agents });
  try {
    const task = await startedTask(h);
    const settled = await settle(h.engine, task.taskId);
    assert.equal(settled.state, TASK_STATES.failed);
    assert.equal(settled.phase, 'failed');
    assert.equal(settled.error.code, JOB_CODES.executionFailed);
  } finally {
    await h.close();
  }
});

test('a timed-out run ends failed with the failed phase instead of a pre-creation one', async () => {
  // The execution budget is a real `setTimeout` inside the runner. It is no longer taken
  // from the settings document (`worker.timeoutSeconds` is retired and bounds nothing),
  // so this run asks for the budget the ONE retained way: an explicit per-job override.
  // Mocking the timer was tried and is NOT reliable here: the deadline is armed only
  // after the native placement resolves, so a tick that lands before that point expires
  // nothing and the run hangs. This test therefore spends the real 30 s, which is the
  // honest way to exercise the production path without adding a test-only seam to the
  // runner. It is the only slow test in the suite.
  const h = await harness({ sessionController: busySessionController() });
  try {
    const task = await startedLongTask(h, { timeoutSeconds: 30 });
    // The task froze an explicit cap (the compatibility path) rather than a retired
    // global default: that is what makes the deadline real here.
    assert.equal(task.effective.worker.executionTimeoutSeconds, 30);
    // The executor was seen working, so the phase is execution, not creation.
    h.engine.onExecutionEvent(task, { type: 'turn/start', data: {} });
    assert.equal(task.phase, 'execute');

    // The never-idle agent stays busy, so ONLY the execution budget can end this run.
    const settled = await settle(h.engine, task.taskId, 8_000);
    assert.equal(settled.state, TASK_STATES.failed, JSON.stringify(settled.error));
    assert.equal(settled.error.code, JOB_CODES.timeout, JSON.stringify(settled.error));
    assert.equal(settled.phase, 'failed', 'a timed-out task must not still describe creation or execution');
  } finally {
    await h.close();
  }
});

test('a cancelled run keeps the cancelled phase and a late event cannot revive it', async () => {
  const h = await harness({ sessionController: busySessionController() });
  try {
    const task = await startedLongTask(h);
    h.engine.onExecutionEvent(task, { type: 'turn/start', data: {} });
    assert.equal(task.phase, 'execute');

    const cancelled = await h.engine.cancel(task.taskId, 'operator');
    assert.equal(cancelled.state, TASK_STATES.cancelled);
    assert.equal(cancelled.phase, 'cancelled');
    assert.equal(cancelled.cancelledBy, 'operator');

    // An event that settles after the cancellation reaches this class through the
    // same hook. It is evidence about a run that already ended, not a revival.
    h.engine.onExecutionEvent(task, { type: 'turn/start', data: {} });
    h.engine.onExecutionEvent(task, { type: 'tool/call', data: { name: 'read', callId: 'c-late' } });
    assert.equal(task.state, TASK_STATES.cancelled);
    assert.equal(task.phase, 'cancelled', 'a late event never overwrites a terminal phase');
  } finally {
    await h.close();
  }
});

test('a completed run ends awaiting host review with its own phase, not execute', async () => {
  const h = await harness();
  try {
    const task = await startedTask(h);
    // A late event arriving while the task is still running is real evidence, so it
    // publishes execute — then the run finishes and the phase must say so.
    h.engine.onExecutionEvent(task, { type: 'turn/start', data: {} });
    const settled = await settle(h.engine, task.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview);
    assert.equal(settled.phase, 'awaiting-host-review', 'review phase, never a running one');
    assert.equal(settled.selfApproved, false);
    assert.equal(settled.hostAcceptance, null);

    // A late event after review ended describes nothing the task still does.
    h.engine.onExecutionEvent(h.engine.tasks.get(task.taskId), { type: 'turn/start', data: {} });
    assert.equal(h.engine.get(task.taskId).phase, 'awaiting-host-review');
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Repeated-failure reminder through the engine's own wait chain
// ---------------------------------------------------------------------------

test('repeated identical tool failures reach the host once as a typed failure diagnostic', async () => {
  // The no-progress reminder is switched OFF for this fixture so the failure reminder is
  // the only `attention` reason in play: the two are now separate checkpoints, and this
  // test is about the failure one.
  const h = await harness({
    sessionController: busySessionController(),
    settings: validSettings({ monitoring: { selfCheckSeconds: 600, attentionSeconds: 0 } }),
  });
  try {
    const task = await startedLongTask(h);
    const args = '{"command":"npm test"}';
    const code = 'ENOENT';
    // Three identical structured failures, fed through the engine's own event hook —
    // the same path the runner uses, so the reminder is produced by production code.
    for (const id of ['f1', 'f2', 'f3']) {
      h.engine.onExecutionEvent(task, {
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: id, name: 'bash', arguments: args },
      });
      h.engine.onExecutionEvent(task, {
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          message: { role: 'tool', toolCallId: id, isError: true, content: [{ type: 'text', text: 'SECRET BODY' }] },
          error: { name: 'ToolError', code, reason: 'the tool said so' },
        },
      });
    }

    const observation = await h.engine.observeTask(task.taskId, { connectionId: task.connectionId, waitMs: 1 });
    assert.equal(observation.reason, OBSERVE_TASK_REASONS.attention);
    assert.equal(observation.checkpoint, 'failure', 'the answer says WHICH reminder this is');
    assert.equal(observation.failure.kind, 'repeated-tool-failure');
    assert.equal(observation.failure.toolName, 'bash');
    assert.equal(observation.failure.failureCode, code);
    assert.equal(observation.failure.consecutive, 3);
    // The task is still running: a reminder is not a verdict.
    assert.equal(h.engine.get(task.taskId).state, TASK_STATES.running);

    // Nothing secret reaches the answer, and the reminder carries its stable identity.
    const serialized = JSON.stringify(observation);
    for (const secret of ['SECRET BODY', 'npm test', 'the tool said so']) {
      assert.equal(serialized.includes(secret), false, `the observation must not carry ${secret}`);
    }
    assert.match(observation.failure.eventId, /^[0-9a-f]{16}$/u, 'the reminder has a stable event identity');

    // The reminder is redelivered with the SAME identity until a receiver acks it —
    // the server's having answered once proves nothing about what the receiver got.
    const again = await h.engine.observeTask(task.taskId, { connectionId: task.connectionId, waitMs: 1 });
    assert.equal(again.failure.eventId, observation.failure.eventId, 'one repeated failure is ONE notification identity');

    // A wrong eventId never clears anything; the ack result is echoed honestly.
    const wrongAck = await h.engine.observeTask(task.taskId, {
      connectionId: task.connectionId, waitMs: 1, ackFailureEventId: '0'.repeat(16),
    });
    assert.equal(wrongAck.failureAck.acknowledged, false);
    assert.equal(wrongAck.failureAck.reason, 'unknown-event');

    // The ack clears it by the exact eventId; the next observation is quiet again.
    const ack = await h.engine.observeTask(task.taskId, {
      connectionId: task.connectionId, waitMs: 1, ackFailureEventId: observation.failure.eventId,
    });
    assert.equal(ack.failureAck.acknowledged, true);
    assert.equal(ack.failureAck.eventId, observation.failure.eventId);
    const quiet = await h.engine.observeTask(task.taskId, { connectionId: task.connectionId, waitMs: 1 });
    assert.equal(quiet.failure, null, 'reported, acknowledged, then quiet');

    // The task page reads the same bounded evidence from the public view.
    const view = h.engine.get(task.taskId);
    assert.equal(view.activity.repeatFailure.threshold, 3);
    assert.equal(view.activity.repeatFailure.reported.length, 1);
    assert.equal(view.effective.monitoring.repeatFailureThreshold, 3, 'the frozen value is published');

    await h.engine.cancel(task.taskId, 'test-end');
  } finally {
    await h.close();
  }
});

test('the reminder is frozen per task, and threshold 0 disables it', async () => {
  const h = await harness({
    sessionController: busySessionController(),
    settings: validSettings({
      monitoring: { selfCheckSeconds: 600, attentionSeconds: 2400, repeatFailureThreshold: 0 },
    }),
  });
  try {
    const task = await startedLongTask(h);
    for (const id of ['d1', 'd2', 'd3', 'd4']) {
      h.engine.onExecutionEvent(task, { type: 'tool/call', data: { callId: id, name: 'bash', arguments: '{"command":"npm test"}' } });
      h.engine.onExecutionEvent(task, {
        type: 'tool/result',
        data: { message: { role: 'tool', toolCallId: id, isError: true, content: [] }, error: { name: 'ToolError', code: 'ENOENT' } },
      });
    }
    assert.equal(task.monitor.failures.threshold, 0, 'the frozen value is what the monitor uses');
    // The task snapshot itself says 0 — proving the fixture's override really reached
    // the settings document instead of the test silently running on the default.
    assert.equal(task.effective.monitoring.repeatFailureThreshold, 0, 'the frozen snapshot is 0');
    const observation = await h.engine.observeTask(task.taskId, { connectionId: task.connectionId, waitMs: 1 });
    assert.equal(observation.failure, null, 'disabled means no reminder at all');
    await h.engine.cancel(task.taskId, 'test-end');
  } finally {
    await h.close();
  }
});
