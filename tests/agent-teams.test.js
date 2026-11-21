// Per-task DSH "Agent Teams" selection (the model-menu 「Use Agent Teams」 switch).
//
// The switch belongs to DSH: `ctx.agentTeams.setEnabled(rootAgent, enabled)` appends the
// Session's `team/mode` selection and flushes it, and `isEnabled(rootAgent)` reads the
// saved projection back. The model menu reaches it through
// `remote.agentTeams.setEnabled(sessionId, enabled)`.
//
// What this plugin adds is a per-TASK choice the commander can state when submitting, so:
//   * nothing is guessed from the prompt (no heuristics) and no global default is opened;
//   * only THIS run's own Session is written;
//   * "requested" and "applied" are separate facts, and an unavailable or unapplied
//     request is reported accurately instead of being claimed as enabled;
//   * a continuation keeps the chain's decision unless the caller states a new one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { createExecutionHandler, EXECUTION_PREFIX } from '../src/http/execution-plane.js';
import { JobEngine } from '../src/jobs/engine.js';
import { sanitizeOverrides } from '../src/jobs/engine.js';
import { continuationIdentityOf } from '../src/jobs/continuation-identity.js';
import { runAgent } from '../src/runtime/agent-runner.js';
import { SettingsService } from '../src/config/settings.js';
import { SessionStore, rememberSession } from '../src/runtime/session-placement.js';
import { cleanup, makeTempDir } from './helpers/fakes.js';

/**
 * A recording Agent Teams service shaped like the real one.
 * @param {object} [options] - `throwOnSet`, `reportEnabled` (override the read-back).
 * @returns {object} service plus its calls.
 */
function teamService(options = {}) {
  const calls = [];
  let enabled = options.initiallyEnabled === true;
  return {
    calls,
    get enabled() { return enabled; },
    async setEnabled(agent, value) {
      calls.push({ agent, value });
      if (options.throwOnSet === true) throw Object.assign(new Error('persist failed'), { code: 'TEAM_PERSIST_FAILED' });
      enabled = value;
    },
    isEnabled(agent) {
      void agent;
      return options.reportEnabled === undefined ? enabled : options.reportEnabled;
    },
  };
}

/** A minimal runAgent dependency set that reaches prompt delivery. */
function runnerDeps(service) {
  const agent = {
    session: { id: 'session-team', header: { cwd: 'C:\\work' } },
    ctx: { on() { return () => {}; }, get() { return null; } },
    options: {},
    async whenIdle() {},
    followup() {},
    async cancel() {},
  };
  const handle = { agent, dispose() {} };
  return {
    agent,
    deps: {
      agents: {
        async create() { return handle; },
        async get() { return handle; },
      },
      agentPresets: { async mount() { return { id: 'preset' }; } },
      sessions: { async flush() {} },
      policyServices: () => ({ sandboxPolicy: null, approval: null, agentTeams: service }),
      logger: { warn() {} },
    },
  };
}

test('runAgent applies an explicit team choice to its own Session and reports the read-back', async () => {
  const service = teamService();
  const { deps, agent } = runnerDeps(service);
  const result = await runAgent(deps, {
    prompt: 'do the work',
    cwd: 'C:\\work',
    selection: {},
    allowUnplaced: true,
    agentTeams: true,
  });
  assert.equal(service.calls.length, 1, 'exactly one native selection write');
  assert.equal(service.calls[0].agent, agent, 'and it targets THIS run\u2019s own agent');
  assert.equal(service.calls[0].value, true);
  assert.deepEqual(result.team, {
    requested: true,
    implicit: false,
    supported: true,
    applied: true,
    enabled: true,
    reason: null,
  });
});

test('runAgent makes NO team choice when none was given (the Session keeps its own mode)', async () => {
  const service = teamService({ initiallyEnabled: true });
  const { deps } = runnerDeps(service);
  const result = await runAgent(deps, { prompt: 'do the work', cwd: 'C:\\work', selection: {}, allowUnplaced: true });
  assert.equal(service.calls.length, 0, 'no write at all');
  assert.equal(result.team.requested, null);
  assert.equal(result.team.applied, false);
  assert.equal(result.team.reason, 'not-requested');
});

test('a requested team mode that CANNOT be applied stops the run before the prompt', async () => {
  const { deps, agent } = runnerDeps(null);
  let prompted = 0;
  agent.followup = () => { prompted += 1; };
  const result = await runAgent(deps, {
    prompt: 'do the work', cwd: 'C:\\work', selection: {}, allowUnplaced: true, agentTeams: true,
  });
  assert.equal(prompted, 0, 'the worker never received the prompt');
  assert.equal(result.outcome, 'failed', 'the run failed instead of proceeding under the old mode');
  assert.equal(result.team.applied, false);
  assert.equal(result.team.reason, 'agent-teams-unavailable');
  assert.equal(result.error.code, 'RUN_AGENT_TEAMS_UNAVAILABLE');
});

test('a write failure or a read-back mismatch also stops the run before the prompt', async () => {
  for (const [label, service] of [
    ['write failure', teamService({ throwOnSet: true })],
    ['read-back mismatch', teamService({ reportEnabled: false })],
  ]) {
    const { deps, agent } = runnerDeps(service);
    let prompted = 0;
    agent.followup = () => { prompted += 1; };
    const result = await runAgent(deps, {
      prompt: 'x', cwd: 'C:\\work', selection: {}, allowUnplaced: true, agentTeams: true,
    });
    assert.equal(prompted, 0, `${label}: no prompt delivered`);
    assert.equal(result.outcome, 'failed', `${label}: the run failed`);
    assert.equal(result.team.applied, false);
    assert.equal(result.error.code, 'RUN_AGENT_TEAMS_UNAVAILABLE');
  }
});

test('a run cancelled before the team selection is written never prompts', async () => {
  const service = teamService();
  const { deps, agent } = runnerDeps(service);
  let prompted = 0;
  agent.followup = () => { prompted += 1; };
  const controller = new AbortController();
  controller.abort();
  const result = await runAgent(deps, {
    prompt: 'x', cwd: 'C:\\work', selection: {}, allowUnplaced: true, agentTeams: true, signal: controller.signal,
  });
  assert.equal(prompted, 0, 'no prompt after a cancellation');
  assert.equal(service.calls.length, 0, 'and no team write was attempted');
  assert.notEqual(result.outcome, 'completed');
});

test('an explicit `false` is applied even when the Session currently reports true', async () => {
  const service = teamService({ initiallyEnabled: true });
  const { deps } = runnerDeps(service);
  const result = await runAgent(deps, {
    prompt: 'x', cwd: 'C:\\work', selection: {}, allowUnplaced: true, agentTeams: false,
  });
  assert.equal(service.calls[0].value, false, 'the switch was turned off for this run');
  assert.equal(result.team.applied, true);
  assert.equal(result.team.enabled, false);
});

test('the team selection receives a real AbortSignal from the run', async () => {
  let seenSignal = null;
  const service = {
    calls: [],
    async setEnabled(agent, value, signal) {
      this.calls.push({ value });
      seenSignal = signal;
    },
    isEnabled() { return true; },
  };
  const { deps } = runnerDeps(service);
  await runAgent(deps, { prompt: 'x', cwd: 'C:\\work', selection: {}, allowUnplaced: true, agentTeams: true });
  assert.ok(seenSignal instanceof AbortSignal, 'the native service was given an AbortSignal');
  assert.equal(seenSignal.aborted, false, 'and it was not already aborted');
});

test('overrides carry the team choice as a boolean and refuse anything else', () => {
  assert.deepEqual(sanitizeOverrides({ agentTeams: true, model: 'm' }), { model: 'm', agentTeams: true });
  assert.deepEqual(sanitizeOverrides({}), {}, 'an omitted choice stays omitted');
  assert.throws(() => sanitizeOverrides({ agentTeams: 'yes' }), (error) => {
    assert.equal(error.code, 'JOB_OVERRIDE_INVALID');
    return true;
  });
});

test('the continuation identity records the chain\u2019s team decision', () => {
  const identity = continuationIdentityOf({ taskId: 't', sourcePath: 'C:\\w', agentTeams: false }, null, 'shared');
  assert.equal(identity.agentTeams, false);
  const none = continuationIdentityOf({ taskId: 't', sourcePath: 'C:\\w' }, null, 'shared');
  assert.equal(none.agentTeams, null, 'no decision is recorded as null, not as off');
});

/** Minimal engine deps for the submit path (admission is refused early on purpose). */
function submitFixture(options = {}) {
  const engine = new JobEngine({
    settings: { async read() { return { worker: {}, monitoring: {} }; } },
    auth: { assertTaskAuthorized() {}, subscribe() { return () => {}; }, isDelegationAuthorized() { return true; } },
    delegationEnabled: true,
    locks: { acquire() { return { nonce: 'n' }; }, release() {}, releaseAll() {} },
    runGit: async () => ({ stdout: '', code: 0 }),
    // A durable conversation identity for a parent this process does not hold. `admit`
    // reads it through `readContinuationIdentity`, which is what the continuation branch
    // then inherits the team decision from.
    ...(options.sessionStore === undefined ? {} : { sessionStore: options.sessionStore }),
    logger: { info() {}, warn() {} },
  });
  engine.authorizationMode = 'switch';
  engine.posture = () => ({ authorized: true, reason: null, mode: 'switch' });
  const started = [];
  engine.admit = async (task, request) => {
    started.push({ task, request });
    task.agentTeams = undefined;
    throw Object.assign(new Error('admission stopped for the test'), { code: 'JOB_PREFLIGHT_FAILED' });
  };
  const handler = createExecutionHandler({
    engine,
    auth: { authenticate: () => null, listGrants: () => [] },
    settings: {},
    logger: { warn() {} },
    getBindHost: () => '127.0.0.1',
  });
  void options;
  return { engine, handler };
}

/** Drive the plane's submit route with a request double that delivers its body on read. */
async function submit(handler, body) {
  const { Readable } = await import('node:stream');
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const request = Readable.from([payload]);
  request.method = 'POST';
  request.url = `${EXECUTION_PREFIX}/tasks`;
  request.headers = { host: '127.0.0.1:3210', 'sec-fetch-site': 'none', 'content-type': 'application/json' };
  request.socket = { remoteAddress: '127.0.0.1' };
  const result = { text: '' };
  const response = {
    status: 0,
    headersSent: false,
    writableEnded: false,
    writeHead(status) { this.status = status; this.headersSent = true; return this; },
    write(chunk) { result.text += String(chunk); return true; },
    end(chunk) { if (chunk !== undefined) result.text += String(chunk); this.writableEnded = true; return this; },
  };
  await handler(request, response);
  return { status: response.status, body: result.text === '' ? null : JSON.parse(result.text) };
}

test('the engine freezes the team choice on the task and reports it in the view', async () => {
  const { engine } = submitFixture();
  // Let admission run far enough to freeze the choice, then stop before dispatch.
  engine.admit = async (task) => {
    task.agentTeams = true;
    throw Object.assign(new Error('stop'), { code: 'JOB_PREFLIGHT_FAILED' });
  };
  await assert.rejects(() => engine.start({
    connectionId: 'c1', workspacePath: 'C:\\work', prompt: 'go', overrides: { agentTeams: true },
  }));
  const [task] = [...engine.tasks.values()];
  assert.equal(task.agentTeams, true, 'frozen on the record, not only on the request');
});


test('a WAIT answer carries the short team verdict, so a host need not read the full result', async () => {
  const { compactTask } = await import('../src/mcp/wait.js');
  const compact = compactTask({
    taskId: 't1',
    state: 'running',
    phase: 'execute',
    agentTeams: true,
    team: { requested: true, supported: true, applied: true, enabled: true, reason: null },
    diff: { patchText: 'diff --git a b' },
    execution: { text: 'prose' },
  });
  assert.equal(compact.agentTeams, true, 'the request travels');
  assert.deepEqual(compact.team, { requested: true, supported: true, applied: true, enabled: true, reason: null });
  assert.equal('diff' in compact, false);
  assert.equal('execution' in compact, false);

  const refused = compactTask({
    taskId: 't2',
    state: 'failed',
    agentTeams: true,
    team: { requested: true, supported: false, applied: false, enabled: null, reason: 'agent-teams-unavailable' },
  });
  assert.equal(refused.team.reason, 'agent-teams-unavailable');
  assert.equal(refused.team.applied, false);
});

test('POST /tasks carries the commander agentTeams value into the engine and refuses a non-boolean', async () => {
  const { engine, handler } = submitFixture();
  let seen = null;
  engine.admit = async (_task, request) => {
    seen = request;
    throw Object.assign(new Error('stop'), { code: 'JOB_PREFLIGHT_FAILED' });
  };
  await submit(handler, { workspacePath: 'C:\\work', prompt: 'go', agentTeams: true });
  assert.equal(seen.overrides.agentTeams, true, 'the value reached admission through overrides');

  const refused = await submit(handler, { workspacePath: 'C:\\work', prompt: 'go', agentTeams: 'yes' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'AGENT_TEAMS_INVALID');
});

test('a cancellation DURING the team write ends the run as cancelled and never prompts', async () => {
  let release = null;
  const service = {
    calls: [],
    async setEnabled(agent, value, signal) {
      this.calls.push({ value, signal });
      // Never settles until the test releases it — and it observes the abort it is given.
      await new Promise((resolvePromise) => { release = resolvePromise; });
    },
    isEnabled() { return true; },
  };
  const { deps, agent } = runnerDeps(service);
  let prompted = 0;
  agent.followup = () => { prompted += 1; };
  const controller = new AbortController();
  const pending = runAgent(deps, {
    prompt: 'x', cwd: 'C:\\work', selection: {}, allowUnplaced: true, agentTeams: true, signal: controller.signal,
  });
  // Let the run reach the team write, then cancel it mid-flight.
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  assert.equal(service.calls.length, 1, 'the write started');
  controller.abort();
  const result = await pending;
  assert.equal(prompted, 0, 'no prompt after a mid-write cancellation');
  assert.equal(result.outcome, 'cancelled');
  // The native call was TOLD to stop, not merely abandoned.
  assert.equal(service.calls[0].signal.aborted, true, 'the service saw an aborted signal');
  release?.();
});

test('a team write that NEVER settles is bounded by the run\u2019s own deadline and ends timedOut', async () => {
  const service = {
    calls: 0,
    // Deliberately never resolves and never rejects: only the run's own deadline can end it.
    async setEnabled() { this.calls += 1; await new Promise(() => {}); },
    isEnabled() { return true; },
  };
  const { deps, agent } = runnerDeps(service);
  let prompted = 0;
  agent.followup = () => { prompted += 1; };
  const result = await runAgent(deps, {
    prompt: 'x', cwd: 'C:\\work', selection: {}, allowUnplaced: true, agentTeams: true, timeoutMs: 150,
  });
  assert.equal(service.calls, 1, 'the write was attempted once');
  assert.equal(prompted, 0, 'the run never prompted');
  assert.equal(result.outcome, 'timed_out', 'and it ended as timedOut, not as a hang');
});

test('a LATE resolve after the deadline is ignored: no prompt, no unhandled rejection', async () => {
  let release = null;
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const service = {
      async setEnabled() {
        await new Promise((resolvePromise) => { release = resolvePromise; });
        throw new Error('late failure from an abandoned write');
      },
      isEnabled() { return true; },
    };
    const { deps, agent } = runnerDeps(service);
    let prompted = 0;
    agent.followup = () => { prompted += 1; };
    const result = await runAgent(deps, {
      prompt: 'x', cwd: 'C:\\work', selection: {}, allowUnplaced: true, agentTeams: true, timeoutMs: 120,
    });
    assert.equal(result.outcome, 'timed_out');
    assert.equal(prompted, 0);
    // The abandoned write settles (with a rejection) AFTER the run is over.
    release?.();
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 60); });
    assert.equal(prompted, 0, 'still no prompt after the late settle');
    assert.deepEqual(rejections, [], 'the abandoned write did not become an unhandled rejection');
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('a late RESOLVE after the deadline does not turn a timed-out run into a completed one', async () => {
  let release = null;
  const service = {
    async setEnabled() { await new Promise((resolvePromise) => { release = resolvePromise; }); },
    isEnabled() { return true; },
  };
  const { deps, agent } = runnerDeps(service);
  let prompted = 0;
  agent.followup = () => { prompted += 1; };
  const result = await runAgent(deps, {
    prompt: 'x', cwd: 'C:\\work', selection: {}, allowUnplaced: true, agentTeams: true, timeoutMs: 120,
  });
  release?.();
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 40); });
  assert.equal(result.outcome, 'timed_out');
  assert.equal(prompted, 0, 'the late success was not followed by a prompt');
  assert.equal(result.team.applied, false);
  assert.equal(result.team.reason, 'agent-teams-aborted');
});

// ---------------------------------------------------------------------------
// EXEC-1.6.1: the OPERATOR'S new-task default, and where a frozen choice came from.
//
// Three stories must stay distinguishable in the record, because collapsing them is how
// a default gets presented as a request the dispatcher never made:
//   request             — the dispatcher stated it for this task;
//   continuation        — inherited from the chain a follow-up continues;
//   settings-default    — the operator's new-task default filled an absent choice.
// ---------------------------------------------------------------------------

/**
 * Shape a durable parent row AND record its conversation identity.
 *
 * Two pieces of evidence the continuation gate actually reads are produced here, through
 * the real seams a finished task uses:
 *  * a history row in the shape `HistoryStore` publishes — the owner (`connectionId`),
 *    terminal `state`, both paths, the isolation and the conversation placement, which is
 *    what `durableParent` proves ownership and outcome from;
 *  * the identity-map row, written by the same `rememberSession` that a real run calls, so
 *    the gate can resolve the exact Session and workspaces it would join.
 * Nothing in the gate is stubbed: this is the evidence a real finished task leaves.
 * @param {object} fixture - `freezeFixture` result.
 * @param {string} taskId - parent task id.
 * @param {object} overrides - `agentTeams` (the parent's frozen decision) and `state`.
 * @returns {Promise<object>} the parent row.
 */
async function plantParent(fixture, taskId, overrides = {}) {
  const { workspace, sessionStore, plant } = fixture;
  const conversation = {
    kind: 'new',
    workspaceId: 'workspace-1',
    workspacePath: workspace,
    sessionId: `session-${taskId}`,
    reused: false,
  };
  const row = {
    taskId,
    // Switch mode binds every submission to this one verified identity
    // (`task.connectionId = 'local-mcp'`), so the parent row must name it too.
    connectionId: 'local-mcp',
    state: overrides.state ?? 'awaiting-host-review',
    sourcePath: workspace,
    executionWorkspacePath: workspace,
    isolation: 'shared',
    // A legacy row (written before the field existed) reports no decision: `null`.
    agentTeams: typeof overrides.agentTeams === 'boolean' ? overrides.agentTeams : null,
    execution: { outcome: 'completed', conversation },
  };
  // The identity map, written through the production seam so its digests and canonical
  // paths match what the gate will compare.
  await rememberSession(sessionStore, conversation, {
    taskId,
    sourcePath: workspace,
    executionPath: workspace,
    isolation: 'shared',
    agentTeams: row.agentTeams,
  });
  plant(row);
  return row;
}

/**
 * An engine over a REAL settings service, stopped at the concurrency slot.
 *
 * The settings document is genuine (a `SettingsService` on a temp directory), so the
 * operator's default arrives through exactly the path production uses: written by
 * `setExecution`, validated by `validateExecutionSettings`, read back through
 * `settings.read()`. The stop point is the source lock, which the empty `locks` double
 * refuses — that is AFTER the team decision was frozen on the task, and it needs no
 * provider route, workspace audit or native service.
 *
 * `ensureRoutes` resolves to one provider route so the effective-config step completes;
 * the run never reaches a model call.
 * @param {boolean | undefined} agentTeamsDefault - the operator default, written before
 *   the task starts; `undefined` means "never written", i.e. an upgraded document.
 * @returns {Promise<{ engine: JobEngine, workspace: string, dir: string, settings: SettingsService }>} fixture.
 */
async function freezeFixture(agentTeamsDefault, parent = null) {
  const dir = await makeTempDir();
  const workspace = await realpath(await mkdir(join(dir, 'workspace'), { recursive: true }).then(() => join(dir, 'workspace')));
  const settings = new SettingsService(join(dir, 'data'));
  await settings.replace(teamSettings());
  if (agentTeamsDefault !== undefined) await settings.setExecution({ agentTeamsDefault });
  const sessionStore = new SessionStore(dir);
  // The rows the fixture's history answers with. Empty until a test plants one, so a
  // continuation of an unknown task stays the refusal it should be.
  const rows = [];
  const engine = new JobEngine({
    settings,
    auth: { assertTaskAuthorized() {}, subscribe() { return () => {}; }, isDelegationAuthorized() { return true; } },
    delegationEnabled: true,
    // Refuses the source lock: the stop point, chosen because it is after the team
    // decision and needs no provider route or workspace audit.
    locks: { acquire() { throw Object.assign(new Error('stop here'), { code: 'WORKSPACE_BUSY' }); }, release() {}, releaseAll() {} },
    runGit: async () => ({ stdout: '', code: 0 }),
    // The durable history the continuation gate proves ownership from, and the identity
    // map that supplies the exact thread. A test adds its parent row through `plant`,
    // so the gate reads REAL evidence in the shape a finished task leaves — nothing about
    // the gate itself is stubbed. With no parent declared, history stays empty, so a
    // continuation of an unknown task is still the refusal it must be.
    history: {
      async load() {
        return parent === null ? [] : rows;
      },
    },
    sessionStore,
    logger: { info() {}, warn() {} },
  });
  engine.authorizationMode = 'switch';
  engine.posture = () => ({ authorized: true, reason: null, mode: 'switch' });
  engine.ensureRoutes = async () => ({
    routes: [{ id: 'relay', providerRoute: 'relay', model: 'deepseek-chat', reasoningEffort: 'high', models: [] }],
    catalog: null,
  });
  return {
    engine,
    workspace,
    dir,
    settings,
    sessionStore,
    /**
     * Make one planted parent row visible to the continuation gate.
     * @param {object} row - the row `plantParent` built.
     * @returns {void}
     */
    plant(row) { rows.length = 0; rows.push(row); },
  };
}

/**
 * The settings document a freeze test needs.
 *
 * It carries no `execution` block on purpose: that is the shape a document (and a host)
 * written BEFORE the new-task default existed has, so the fixture can prove the upgrade
 * path as well as the explicit values. A test that wants an explicit default writes it
 * through `settings.setExecution`, exactly as the settings page does.
 * @returns {object} settings document.
 */
function teamSettings() {
  return {
    providers: [{
      id: 'relay',
      name: 'Relay',
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:8443/v1',
      credentialRef: 'RELAY_KEY',
      models: [{ id: 'deepseek-chat', efforts: ['high'] }],
    }],
    worker: { providerId: 'relay', model: 'deepseek-chat', reasoningEffort: 'high', isolation: 'shared', maxParallelism: 1 },
    monitoring: {},
  };
}

/**
 * Run admission far enough to observe the frozen team decision.
 *
 * `start` always fails in this fixture — the source lock refuses — and that failure is
 * the point: the frozen fields are already on the task when it happens.
 * @param {object} fixture - `freezeFixture` result.
 * @param {object} request - extra `start` fields.
 * @returns {Promise<object>} the submitted task record.
 */
async function frozenTask(fixture, request) {
  const { engine, workspace } = fixture;
  const before = new Set(engine.tasks.keys());
  await assert.rejects(() => engine.start({
    connectionId: 'c1', workspacePath: workspace, prompt: 'go', ...request,
  }));
  const created = [...engine.tasks.keys()].filter((id) => !before.has(id));
  assert.equal(created.length, 1, 'exactly one task was created by this submission');
  return engine.tasks.get(created[0]);
}

test('a fresh-install / upgraded default of OFF freezes `false` on a new task, as a default', async () => {
  for (const [label, agentTeamsDefault] of [
    ['explicit off', false],
    ['absent block (upgraded document)', undefined],
  ]) {
    const fixture = await freezeFixture(agentTeamsDefault);
    try {
      const task = await frozenTask(fixture, {});
      assert.equal(task.agentTeams, false, `${label}: a new task with no choice takes the default`);
      assert.equal(task.agentTeamsOrigin, 'settings-default', `${label}: and it is recorded AS a default`);
    } finally {
      await cleanup(fixture.dir);
    }
  }
});

test('an operator default of ON freezes `true` on a new task, as a default', async () => {
  const fixture = await freezeFixture(true);
  try {
    const task = await frozenTask(fixture, {});
    assert.equal(task.agentTeams, true);
    assert.equal(task.agentTeamsOrigin, 'settings-default');
  } finally {
    await cleanup(fixture.dir);
  }
});

test('an explicit per-task choice wins over the operator default and is recorded as a request', async () => {
  for (const requested of [true, false]) {
    const fixture = await freezeFixture(!requested);
    try {
      const task = await frozenTask(fixture, { overrides: { agentTeams: requested } });
      assert.equal(task.agentTeams, requested, `explicit ${requested} beat the opposite default`);
      assert.equal(task.agentTeamsOrigin, 'request');
    } finally {
      await cleanup(fixture.dir);
    }
  }
});

test('a continuation inherits the chain\u2019s choice and never applies the current default', async () => {
  // The parent ran with teams OFF; the operator has since turned the default ON. The
  // follow-up must keep OFF — applying today's default would flip a running chain.
  const fixture = await freezeFixture(true, { taskId: 'parent-1' });
  try {
    await plantParent(fixture, 'parent-1', { agentTeams: false });
    const task = await frozenTask(fixture, { continueFromTaskId: 'parent-1' });
    assert.equal(task.agentTeams, false, 'the parent\u2019s mode was inherited');
    assert.equal(task.agentTeamsOrigin, 'continuation');
  } finally {
    await cleanup(fixture.dir);
  }
});

test('a continuation WITH its own explicit choice overrides the inherited one', async () => {
  const fixture = await freezeFixture(false, { taskId: 'parent-2' });
  try {
    await plantParent(fixture, 'parent-2', { agentTeams: false });
    const task = await frozenTask(fixture, { continueFromTaskId: 'parent-2', overrides: { agentTeams: true } });
    assert.equal(task.agentTeams, true);
    assert.equal(task.agentTeamsOrigin, 'request');
  } finally {
    await cleanup(fixture.dir);
  }
});

test('a continuation whose parent recorded NO choice stays ABSENT: no default is invented', async () => {
  // A legacy row (written before the field existed) reports no decision, which reads back
  // as `null`. `null` is NOT "off", and it is equally not an invitation to apply today's
  // new-task default: a follow-up belongs to a conversation whose mode the operator may
  // have set in DSH itself. Inventing a choice there would overwrite that live selection
  // with a setting that was never about it. So nothing is frozen, nothing is sent, and the
  // record says no decision was taken rather than claiming one.
  const fixture = await freezeFixture(true, { taskId: 'parent-3' });
  try {
    await plantParent(fixture, 'parent-3', { agentTeams: null });
    const task = await frozenTask(fixture, { continueFromTaskId: 'parent-3' });
    assert.equal(task.agentTeams, null, 'no choice was invented for the follow-up');
    assert.equal(task.agentTeamsOrigin, null, 'and none is attributed to the setting or the chain');
    assert.equal(task.agentTeamsFromDefault, false, 'the default did not fill it');
  } finally {
    await cleanup(fixture.dir);
  }
});

test('a continuation whose parent recorded no choice still honours an EXPLICIT choice on the follow-up', async () => {
  // The absence above is about not INVENTING a value. A dispatcher that states one is
  // still obeyed, and the record attributes it to the request.
  const fixture = await freezeFixture(false, { taskId: 'parent-4' });
  try {
    await plantParent(fixture, 'parent-4', { agentTeams: null });
    const task = await frozenTask(fixture, { continueFromTaskId: 'parent-4', overrides: { agentTeams: true } });
    assert.equal(task.agentTeams, true);
    assert.equal(task.agentTeamsOrigin, 'request');
    assert.equal(task.agentTeamsFromDefault, false);
  } finally {
    await cleanup(fixture.dir);
  }
});

test('the new-task default is marked as the default, so the runner can treat it differently', async () => {
  const fixture = await freezeFixture(false);
  try {
    const task = await frozenTask(fixture, {});
    assert.equal(task.agentTeams, false);
    assert.equal(task.agentTeamsOrigin, 'settings-default');
    assert.equal(task.agentTeamsFromDefault, true, 'this one IS the setting, not a person');
  } finally {
    await cleanup(fixture.dir);
  }
});

test('an explicit request is never marked as the default', async () => {
  const fixture = await freezeFixture(true);
  try {
    const task = await frozenTask(fixture, { overrides: { agentTeams: false } });
    assert.equal(task.agentTeams, false);
    assert.equal(task.agentTeamsOrigin, 'request');
    assert.equal(task.agentTeamsFromDefault, false, 'a person decided this, even though it matches the default direction');
  } finally {
    await cleanup(fixture.dir);
  }
});

test('the operator default reaches the runner through the frozen task, and is never a global write', async () => {
  // End to end within the runner contract: the engine hands `agentTeams` to the runner,
  // the runner writes ONLY its own Session, and reports what the service confirmed.
  const written = [];
  const service = {
    async setEnabled(agent, value) { written.push({ agent: agent.session.id, value }); },
    isEnabled() { return false; },
  };
  const { deps } = runnerDeps(service);
  const result = await runAgent(deps, {
    prompt: 'x', cwd: 'C:\\work', selection: {}, allowUnplaced: true, agentTeams: false,
  });
  assert.deepEqual(written, [{ agent: 'session-team', value: false }], 'only this run\u2019s own Session was written');
  assert.deepEqual(result.team, {
    requested: false, implicit: false, supported: true, applied: true, enabled: false, reason: null,
  });
});

test('an older DSH with no agent-teams service still runs an ordinary dispatch that asks for nothing', async () => {
  // Compatibility: `requested: null` (no choice at all) must proceed on a host that never
  // had the service. This is the shape a caller gets from an older integration.
  const { deps, agent } = runnerDeps(null);
  let prompted = 0;
  agent.followup = () => { prompted += 1; };
  const result = await runAgent(deps, { prompt: 'x', cwd: 'C:\\work', selection: {}, allowUnplaced: true });
  assert.equal(prompted, 1, 'the ordinary run was prompted normally');
  assert.equal(result.team.requested, null);
  assert.notEqual(result.error?.code, 'RUN_AGENT_TEAMS_UNAVAILABLE', 'and it was not refused for a choice nobody made');
});

test('the wait answer carries the origin, so "you asked" and "the default applied" stay apart', async () => {
  const { compactTask } = await import('../src/mcp/wait.js');
  const asRequest = compactTask({
    taskId: 't1', state: 'running', agentTeams: true, agentTeamsOrigin: 'request',
    team: { requested: true, supported: true, applied: true, enabled: true, reason: null },
  });
  assert.equal(asRequest.agentTeamsOrigin, 'request');
  const asDefault = compactTask({
    taskId: 't2', state: 'running', agentTeams: false, agentTeamsOrigin: 'settings-default',
    team: { requested: false, supported: true, applied: true, enabled: false, reason: null },
  });
  assert.equal(asDefault.agentTeamsOrigin, 'settings-default');
  assert.equal(asDefault.agentTeams, false);
});

// ---------------------------------------------------------------------------
// The host has NO agent-teams service: the refusal matrix.
//
// An explicit `true` AND an explicit `false` are both requests for a mode somebody chose,
// so both are refused rather than run under whatever the Session happens to hold. Only the
// operator's implicit OFF default may proceed — and it must say "not applied", never
// "off".
// ---------------------------------------------------------------------------

/** Run one dispatch against a host with no team service, reporting what happened. */
async function noServiceRun(agentTeams, extra = {}) {
  const { deps, agent } = runnerDeps(null);
  let prompted = 0;
  agent.followup = () => { prompted += 1; };
  const result = await runAgent(deps, {
    prompt: 'x', cwd: 'C:\\work', selection: {}, allowUnplaced: true,
    ...(agentTeams === undefined ? {} : { agentTeams }),
    ...extra,
  });
  return { result, prompted };
}

/**
 * A run whose fake agent actually ANSWERS, so the outcome reflects the team decision
 * rather than the fixture's empty turn.
 *
 * `deriveOutcome` treats a turn with no text and no reasoning as a failure — correctly.
 * The shared `runnerDeps` fixture never calls the `setup` hook a real `agents.create`
 * invokes, so the runner never registers its `session/event` listener and no turn can
 * produce text. This variant honours that contract, keeps the registered handler, and
 * emits one `assistant/message` in the native `(session, event)` shape when the prompt is
 * delivered — which is exactly what a productive run looks like from the runner's side.
 * @param {unknown} agentTeams - the value to send.
 * @param {boolean} implicit - whether it is the operator's default.
 * @returns {Promise<{ result: object, prompted: number }>} outcome.
 */
async function noServiceAnsweringRun(agentTeams, implicit) {
  const handlers = [];
  const agent = {
    session: { id: 'session-answering', header: { cwd: 'C:\\work' } },
    options: {},
    async whenIdle() {},
    followup() {},
    async cancel() {},
  };
  agent.ctx = {
    on(type, handler) {
      if (type === 'session/event') handlers.push(handler);
      return () => {};
    },
    get() { return null; },
  };
  const handle = { agent, dispose() {} };
  let prompted = 0;
  agent.followup = () => {
    prompted += 1;
    for (const handler of handlers) {
      handler(agent.session, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'done' }] } },
      });
    }
  };
  const deps = {
    agents: {
      // The real factory runs `setup` — that is where the runner mounts the preset,
      // installs the policy and registers its event listener. Skipping it here would
      // test a code path no real run takes.
      async create(options) {
        await options?.setup?.(agent.ctx, agent);
        return handle;
      },
      async get() { return handle; },
    },
    agentPresets: { async mount() { return { id: 'preset' }; } },
    sessions: { async flush() {} },
    policyServices: () => ({ sandboxPolicy: null, approval: null, agentTeams: null }),
    logger: { warn() {} },
  };
  const result = await runAgent(deps, {
    prompt: 'x', cwd: 'C:\\work', selection: {}, allowUnplaced: true, agentTeams, agentTeamsImplicit: implicit,
  });
  return { result, prompted };
}

test('no service: an EXPLICIT false is refused and never prompts', async () => {
  const { result, prompted } = await noServiceRun(false);
  assert.equal(prompted, 0, 'the worker never received the prompt');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.team.applied, false);
  assert.equal(result.team.implicit, false, 'a person decided this');
  assert.equal(result.team.reason, 'agent-teams-unavailable');
  assert.equal(result.error.code, 'RUN_AGENT_TEAMS_UNAVAILABLE');
});

test('no service: an EXPLICIT true is refused and never prompts', async () => {
  const { result, prompted } = await noServiceRun(true);
  assert.equal(prompted, 0);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.team.applied, false);
  assert.equal(result.team.implicit, false);
  assert.equal(result.team.reason, 'agent-teams-unavailable');
});

test('no service: an INHERITED chain choice is refused like an explicit one', async () => {
  // A continuation inherits `false` from its parent. That value came from a real decision
  // too, so it is not the operator's default and must not proceed unchecked.
  for (const inherited of [false, true]) {
    const { result, prompted } = await noServiceRun(inherited, { agentTeamsImplicit: false });
    assert.equal(prompted, 0, `inherited ${inherited}: no prompt`);
    assert.equal(result.team.reason, 'agent-teams-unavailable', `inherited ${inherited}: refused`);
  }
});

test('no service: the operator\u2019s implicit OFF default PROCEEDS, and is reported as not applied', async () => {
  const { result, prompted } = await noServiceAnsweringRun(false, true);
  assert.equal(prompted, 1, 'the ordinary older-version dispatch still runs');
  assert.equal(result.outcome, 'completed');
  assert.equal(result.team.requested, false);
  assert.equal(result.team.implicit, true, 'the record says the SETTING was behind it');
  assert.equal(result.team.reason, 'service-absent-default-off');
  // The honesty requirement: nothing was written and nothing was confirmed, so the run
  // must not claim the Session is off.
  assert.equal(result.team.applied, false, 'not applied');
  assert.equal(result.team.supported, false, 'the host has no such capability');
  assert.equal(result.team.enabled, null, 'and it does not assert a Session value it never read');
  assert.notEqual(result.error?.code, 'RUN_AGENT_TEAMS_UNAVAILABLE');
});

test('no service: an implicit ON default is still refused (nothing could carry it)', async () => {
  const { result, prompted } = await noServiceRun(true, { agentTeamsImplicit: true });
  assert.equal(prompted, 0);
  assert.equal(result.team.reason, 'agent-teams-unavailable');
});

test('the read-back is STRICT: a non-boolean is unconfirmed, never read as "off"', async () => {
  // `isEnabled` returning `undefined` means "no saved selection / no runtime root". Reading
  // it as `false` would "confirm" an OFF request nobody observed, which is exactly the
  // false evidence this refuses everywhere else.
  for (const [label, value] of [['undefined', undefined], ['null', null], ['a string', 'false']]) {
    const service = {
      async setEnabled() {},
      isEnabled() { return value; },
    };
    const { deps, agent } = runnerDeps(service);
    let prompted = 0;
    agent.followup = () => { prompted += 1; };
    const result = await runAgent(deps, {
      prompt: 'x', cwd: 'C:\\work', selection: {}, allowUnplaced: true, agentTeams: false,
    });
    assert.equal(prompted, 0, `${label}: not confirmed, so no prompt`);
    assert.equal(result.team.applied, false, `${label}: not applied`);
    assert.equal(result.team.enabled, null, `${label}: no value is asserted`);
    assert.equal(result.team.reason, 'agent-teams-unconfirmed', `${label}: reported as unconfirmed`);
  }
});

test('with the service present, ON, OFF and inheritance all still work', async () => {
  for (const value of [true, false]) {
    const service = teamService();
    const { deps, agent } = runnerDeps(service);
    agent.followup = () => {};
    const result = await runAgent(deps, {
      prompt: 'x', cwd: 'C:\\work', selection: {}, allowUnplaced: true, agentTeams: value,
    });
    assert.equal(service.calls[0].value, value, `${value}: written`);
    assert.equal(result.team.applied, true, `${value}: confirmed`);
    assert.equal(result.team.enabled, value, `${value}: read back`);
    assert.equal(result.team.reason, null);
  }
});
