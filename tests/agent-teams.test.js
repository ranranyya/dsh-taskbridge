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

import { createExecutionHandler, EXECUTION_PREFIX } from '../src/http/execution-plane.js';
import { JobEngine } from '../src/jobs/engine.js';
import { sanitizeOverrides } from '../src/jobs/engine.js';
import { continuationIdentityOf } from '../src/jobs/continuation-identity.js';
import { runAgent } from '../src/runtime/agent-runner.js';

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
