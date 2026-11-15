// Round-3: the ack receipt must survive EVERY exit path of the wait, and the
// production MCP/stdio boundary must prove it — including a JSON-RPC reply the
// client never receives.
//
// What this file pins, after the independent review rejected round 2:
//
//   A. A confirmed ack followed by a transport failure must still surface the
//      receipt. The wait loop turns a refused observation into an ANSWER carrying
//      `error`; the server's waitAnswer used to read `result.error.failureAck`
//      while the receipt sat at the TOP level of that answer — the wrong level —
//      so the tool text had only code/message. These tests go through
//      `server.handle` (and the stdio framing), not through internals.
//
//   B. The engine's review-settlement branch must also carry the receipt: a task
//      that has settled and whose review write is mid-flight returns through
//      `awaitReviewSettlement`, which used to build its observation without the
//      ack result.
//
//   D. Once a verdict is known, later observations must not OVERWRITE it: the
//      ack is carried on the first observation only; a monitor that is disposed
//      or a task that settles afterwards reports `unknown-event` — that must
//      never replace an already-confirmed fact.
//
//   F. Empty-string and null ack ids are REFUSED with a clear fact, not silently
//      ignored or answered as an honest-but-odd failure.
//
// The fixtures use an in-memory stdio pair and scripted `callExecution` doubles;
// the real loopback HTTP transport is exercised separately in
// tests/repeated-failure-notify.test.js, and that file also drops a generated
// JSON-RPC reply at the stdio boundary (item C). Scope is stated honestly:
// controlled clocks and scripted observations here, real MCP server + stdio
// framing + real loopback HTTP + real engine there.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';

import {
  OBSERVE_REASONS,
  TaskMonitor,
} from '../src/jobs/activity.js';
import {
  LATEST_PROTOCOL_VERSION,
  TOOLS,
  createMcpServer,
  serveStdio,
} from '../src/mcp/server.js';
import { waitForTask } from '../src/mcp/wait.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function taskRecord(taskId) {
  return {
    taskId,
    state: 'running',
    phase: 'execute',
    createdAt: 1_763_200_000_000 - 1_000,
    startedAt: 1_763_200_000_000,
    endedAt: null,
    native: { started: true, settled: false },
    permission: { pending: null },
  };
}

function frozenMonitor(taskId) {
  const task = taskRecord(taskId);
  const monitor = new TaskMonitor(task, {
    now: () => 1_763_200_000_000,
    wait: async () => {},
    selfCheckSeconds: 300,
    attentionSeconds: 600,
    repeatFailureThreshold: 3,
    waitSliceMs: 1000,
  });
  task.monitor = monitor;
  return monitor;
}

function failingPair(monitor, callId) {
  monitor.onEvent({ type: 'tool/call', data: { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' } });
  monitor.onEvent({
    type: 'tool/result',
    data: {
      turn: 1, step: 1,
      message: { role: 'tool', toolCallId: callId, isError: true, content: [] },
      error: {},
    },
  });
}

/** An observation the engine publishes, with an ack result attached. */
function ackObservation(reason, failureAck, overrides = {}) {
  return {
    task: {
      taskId: 'task-wait-1',
      state: reason === 'ready' ? 'awaiting-host-review' : 'running',
      phase: 'execute',
      elapsedMs: 12_000,
      lastActivityAt: 1_760_000_000_000,
      currentTool: null,
      idleForMs: 20,
      route: { providerId: 'relay', model: 'm', reasoningEffort: null },
      createdAt: 1_760_000_000_000,
      startedAt: 1_760_000_000_000,
      endedAt: null,
    },
    reason,
    permission: null,
    question: null,
    failure: null,
    activity: {},
    selfCheck: null,
    failureAck,
    wait: { waitMs: 25_000, waitedMs: 25_000, activitySinceWait: false },
    ...overrides,
  };
}

/** A controlled clock: each observation consumes one tick. */
function tickClock(stepMs = 1_000) {
  let t = 0;
  return { now: () => (t += stepMs), sleep: async () => {} };
}

/**
 * An in-memory stdio harness around a real MCP server, with a WRITABLE sink that
 * can be told to drop the next generated reply — the "client never received the
 * tool result" fact, modelled at the true output boundary.
 * @param {object} server - the MCP server.
 * @returns {object} harness.
 */
function droppingStdioHarness(server) {
  const input = new Readable({ read() {} });
  const kept = [];
  const dropped = [];
  let dropNext = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (dropNext) {
        dropped.push(chunk.toString('utf8'));
        dropNext = false;
      } else {
        kept.push(chunk.toString('utf8'));
      }
      callback();
    },
  });
  const done = serveStdio({ input, output, server });
  const send = (message) => input.push(`${JSON.stringify(message)}\n`);
  const replies = () => kept.join('').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  const replyTo = async (id, occurrence = 0) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const matches = replies().filter((line) => line.id === id);
      const index = occurrence < 0 ? matches.length + occurrence : occurrence;
      if (index >= 0 && matches[index] !== undefined) return matches[index];
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
    }
    throw new Error(`no reply for ${String(id)}`);
  };
  return {
    input, output, done, send, replies, replyTo,
    /** Drop the NEXT reply the server writes (the client never sees it). */
    dropNextReply() { dropNext = true; },
    dropped,
    async close() { input.push(null); await done; },
  };
}

// ---------------------------------------------------------------------------
// A. The receipt survives a transport failure after a confirmed ack
// ---------------------------------------------------------------------------

test('A: server.handle carries failureAck when a confirmed ack is followed by a transport failure', async () => {
  let calls = 0;
  const server = createMcpServer({
    async callExecution() {
      calls += 1;
      if (calls === 1) {
        return { ok: true, ...ackObservation('heartbeat', { acknowledged: true, eventId: 'abc', reason: null }) };
      }
      throw Object.assign(new Error('connection died'), { code: 'MCP_HARNESS_UNREACHABLE' });
    },
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const response = await server.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'delegate_wait', arguments: { taskId: 'task-wait-1', waitSeconds: 60, ackFailureEventId: 'abc' } },
  });
  const body = JSON.parse(response.result.content[0].text);
  assert.equal(body.ok, false, 'the transport failure is a refusal');
  assert.equal(body.error.code, 'MCP_HARNESS_UNREACHABLE');
  assert.deepEqual(
    body.error.details.failureAck, { acknowledged: true, eventId: 'abc', reason: null },
    'the confirmed-ack fact rides the refusal through server.handle',
  );
});

test('A2: the same receipt reaches the stdio wire', async () => {
  let calls = 0;
  const server = createMcpServer({
    async callExecution() {
      calls += 1;
      if (calls === 1) {
        return { ok: true, ...ackObservation('heartbeat', { acknowledged: true, eventId: 'abc', reason: null }) };
      }
      throw Object.assign(new Error('connection died'), { code: 'MCP_HARNESS_UNREACHABLE' });
    },
  });
  const harness = droppingStdioHarness(server);
  harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await harness.replyTo(1);
  harness.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'delegate_wait', arguments: { taskId: 'task-wait-1', waitSeconds: 60, ackFailureEventId: 'abc' } } });
  const reply = await harness.replyTo(2);
  const body = JSON.parse(reply.result.content[0].text);
  assert.equal(body.error.details.failureAck.acknowledged, true, 'the receipt reaches the stdio client');
  await harness.close();
});

test('A3: a cancelled wait after a confirmed ack still carries the receipt through server.handle', async () => {
  const controller = new AbortController();
  const server = createMcpServer({
    async callExecution() {
      controller.abort();
      return { ok: true, ...ackObservation('heartbeat', { acknowledged: true, eventId: 'abc', reason: null }) };
    },
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const response = await server.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'delegate_wait', arguments: { taskId: 'task-wait-1', waitSeconds: 60, ackFailureEventId: 'abc' } },
    signal: controller.signal,
  }, { signal: controller.signal });
  // A cancellation is refused; the ack fact must still be in the refusal.
  const body = JSON.parse(response.result.content[0].text);
  assert.equal(body.ok, false);
  assert.deepEqual(
    body.error.details?.failureAck, { acknowledged: true, eventId: 'abc', reason: null },
    'a cancelled wait does not erase a confirmed ack',
  );
});

// ---------------------------------------------------------------------------
// B. The engine's review-settlement branch carries the receipt
// ---------------------------------------------------------------------------

test('B: observeTask returns the ack receipt on the review-settlement branch', async () => {
  // The REAL JobEngine is subclassed and only the admission/identity helpers the
  // constructor needs are stubbed; observeTask, awaitReviewSettlement,
  // observationOf and observationSummary are the production code paths, and the
  // review write is parked exactly as the review verb parks it.
  const taskId = 'task-review-ack';
  const task = taskRecord(taskId);
  task.state = 'awaiting-host-review';
  task.endedAt = 1_763_200_000_000;
  task.connectionId = 'conn-1';
  const clock = { now: () => 1_763_200_000_000 };
  const monitor = frozenMonitor(taskId);
  task.monitor = monitor;

  class EngineUnderTest extends JobEngine {
    constructor(fixture) {
      super({ logger: { info() {}, warn() {} } });
      this.fixture = fixture;
      // `aborted` is a read-only getter on the real engine; the fixture's engine is
      // never aborted, which the base constructor's own default already encodes.
      Object.defineProperty(this, 'aborted', { get: () => false, configurable: true });
    }
    taskForObservation() { return this.fixture.task; }
    ensureMonitor() { return this.fixture.monitor; }
    settleReason() { return 'ready'; }
    toolActive() { return false; }
    observationRoute() { return null; }
  }
  let engineUnderTest;
  const settleWriteResolve = (() => {
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    return { done, resolve };
  })();
  engineUnderTest = new EngineUnderTest({ task, monitor });
  engineUnderTest.reviewState = new Map([
    [taskId, { state: 'saving', done: settleWriteResolve.done, startedAt: 1 }],
  ]);
  settleWriteResolve.resolve();

  // The ack must reference an event the monitor REALLY delivered: park one episode,
  // observe it, and acknowledge its actual eventId — never an invented 'abc'.
  failingPair(monitor, 'r1');
  failingPair(monitor, 'r2');
  failingPair(monitor, 'r3');
  const parked = await monitor.observe({ waitMs: 1 });
  assert.ok(parked.failure, 'the fixture really delivered a reminder');
  const observation = await engineUnderTest.observeTask(taskId, { ackFailureEventId: parked.failure.eventId });
  assert.equal(observation.reason, 'ready');
  assert.deepEqual(
    observation.failureAck, { acknowledged: true, eventId: parked.failure.eventId, reason: null },
    'the settlement branch must carry the ack receipt',
  );
});

test('B2: three CONCURRENT observations on one settling task do not cross their ack receipts', async () => {
  // The round-3 defect: the settlement receipt lived in the SHARED
  // `monitor.lastAckResult`, so a later observe overwrote an earlier one and an
  // observer that never acked was answered with ANOTHER caller's receipt. The
  // receipt must belong to THIS observeTask call, not to the monitor.
  const taskId = 'task-review-concurrent';
  const task = taskRecord(taskId);
  task.state = 'awaiting-host-review';
  task.endedAt = 1_763_200_000_000;
  task.connectionId = 'conn-1';
  const clock = { now: () => 1_763_200_000_000 };
  const monitor = frozenMonitor(taskId);
  task.monitor = monitor;

  class EngineUnderTest extends JobEngine {
    constructor(fixture) {
      super({ logger: { info() {}, warn() {} } });
      this.fixture = fixture;
      Object.defineProperty(this, 'aborted', { get: () => false, configurable: true });
    }
    taskForObservation() { return this.fixture.task; }
    ensureMonitor() { return this.fixture.monitor; }
    settleReason() { return 'ready'; }
    toolActive() { return false; }
    observationRoute() { return null; }
  }
  const engineUnderTest = new EngineUnderTest({ task, monitor });
  // ONE deferred review write, shared by all three observations: all three enter
  // the settlement branch and wait on the SAME promise, which resolves only after
  // every caller has applied (or declined) its ack.
  let settleWrite;
  const done = new Promise((resolvePromise) => { settleWrite = resolvePromise; });
  engineUnderTest.reviewState = new Map([
    [taskId, { state: 'saving', done, startedAt: 1 }],
  ]);

  // One real delivered reminder, so the successful ack is genuine.
  failingPair(monitor, 'r1');
  failingPair(monitor, 'r2');
  failingPair(monitor, 'r3');
  const parked = await monitor.observe({ waitMs: 1 });
  assert.ok(parked.failure, 'the fixture really delivered a reminder');
  const realEventId = parked.failure.eventId;

  // Start three observations; only after all three have begun (and acked) does the
  // review write complete, so all three answers come from the settlement branch.
  const started = [];
  const first = engineUnderTest.observeTask(taskId, { ackFailureEventId: realEventId })
    .then((observation) => { started.push('A'); return observation; });
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 20); });
  const second = engineUnderTest.observeTask(taskId, {})
    .then((observation) => { started.push('B'); return observation; });
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 20); });
  const third = engineUnderTest.observeTask(taskId, { ackFailureEventId: 'wrongB'.padEnd(16, '0') })
    .then((observation) => { started.push('C'); return observation; });
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 20); });
  assert.deepEqual(started, [], 'all three observations are parked on the review write');
  settleWrite();

  const [obsA, obsB, obsC] = await Promise.all([first, second, third]);
  assert.equal(obsA.reason, 'ready');
  assert.deepEqual(
    obsA.failureAck, { acknowledged: true, eventId: realEventId, reason: null },
    'A carries ITS OWN successful receipt, never a later caller\'s refusal',
  );
  assert.equal(
    'failureAck' in obsB, false,
    'B asked for no ack and must be answered without any ack block',
  );
  assert.deepEqual(
    obsC.failureAck, { acknowledged: false, eventId: 'wrongB'.padEnd(16, '0'), reason: 'unknown-event' },
    'C carries ITS OWN refused receipt with its own wrong id',
  );
});

test('B3: an ordinary observation without an ack never inherits a stale receipt', async () => {
  const taskId = 'task-review-plain';
  const task = taskRecord(taskId);
  task.state = 'awaiting-host-review';
  task.endedAt = 1_763_200_000_000;
  task.connectionId = 'conn-1';
  const clock = { now: () => 1_763_200_000_000 };
  const monitor = frozenMonitor(taskId);
  task.monitor = monitor;
  class EngineUnderTest extends JobEngine {
    constructor(fixture) {
      super({ logger: { info() {}, warn() {} } });
      this.fixture = fixture;
      Object.defineProperty(this, 'aborted', { get: () => false, configurable: true });
    }
    taskForObservation() { return this.fixture.task; }
    ensureMonitor() { return this.fixture.monitor; }
    settleReason() { return 'ready'; }
    toolActive() { return false; }
    observationRoute() { return null; }
  }
  const engineUnderTest = new EngineUnderTest({ task, monitor });
  // A review write that settles BEFORE the observation (so the settlement branch
  // answers immediately), after a DIFFERENT observation on the same monitor acked.
  failingPair(monitor, 'p1');
  failingPair(monitor, 'p2');
  failingPair(monitor, 'p3');
  const parked = await monitor.observe({ waitMs: 1 });
  const acked = monitor.ackFailureReport(parked.failure.eventId);
  assert.equal(acked.acknowledged, true, 'the monitor really holds an acknowledged verdict');
  engineUnderTest.reviewState = new Map([
    [taskId, { state: 'saving', done: Promise.resolve(), startedAt: 1 }],
  ]);
  const observation = await engineUnderTest.observeTask(taskId, {});
  assert.equal(observation.reason, 'ready');
  assert.equal(
    'failureAck' in observation, false,
    'a plain observation must not carry the ack verdict of ANOTHER call',
  );
});

// The real engine prototype methods, imported from the real module: the settlement
// path IS the production code, only the engine shell is stubbed.
import { JobEngine } from '../src/jobs/engine.js';

// ---------------------------------------------------------------------------
// D. A known verdict is never overwritten by a later unknown
// ---------------------------------------------------------------------------

test('D: after a confirmed ack, a disposed monitor answers unknown but the first verdict stands', async () => {
  const monitor = frozenMonitor('task-ack-1');
  for (const id of ['x1', 'x2', 'x3']) failingPair(monitor, id);
  const first = await monitor.observe({ waitMs: 1 });
  const eventId = first.failure.eventId;
  const ack = monitor.ackFailureReport(eventId);
  assert.equal(ack.acknowledged, true);
  // The monitor is then disposed (the run ended): a NEW ack attempt reports
  // unknown — and must never rewrite what the first ack established.
  monitor.dispose(1_763_200_000_000);
  const after = monitor.ackFailureReport(eventId);
  assert.equal(after.acknowledged, false);
  assert.equal(after.reason, 'unknown-event');
});

test('D2: the wait carries the FIRST verdict and stops re-acking once confirmed', async () => {
  const acks = [];
  let calls = 0;
  const result = await waitForTask({
    callExecution: async (_route, payload) => {
      calls += 1;
      acks.push(payload.ackFailureEventId ?? null);
      if (calls === 1) {
        return { ok: true, ...ackObservation('heartbeat', { acknowledged: true, eventId: 'abc', reason: null }) };
      }
      // After confirmation, the task settles; a stale ack would answer
      // unknown-event — but the call must STOP carrying the ack, so this
      // observation reports NO failureAck at all, and the first verdict stands.
      return { ok: true, ...ackObservation('ready', undefined) };
    },
    taskId: 'task-wait-1',
    waitMs: 60_000,
    observeWaitMs: 25_000,
    ...tickClock(),
    ackFailureEventId: 'abc',
  });
  assert.equal(result.reason, 'ready');
  assert.deepEqual(result.failureAck, { acknowledged: true, eventId: 'abc', reason: null },
    'the first (confirmed) verdict stands on the final answer');
  assert.deepEqual(acks, ['abc', null], 'the ack rides the FIRST observation only, not every later one');
});

// ---------------------------------------------------------------------------
// F. Empty and null ack ids are refused with a clear fact
// ---------------------------------------------------------------------------

test('F: an empty-string ack is refused by the MCP schema, not silently ignored', async () => {
  const server = createMcpServer({ async callExecution() { return { ok: true, ...ackObservation('heartbeat', undefined) }; } });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const response = await server.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'delegate_wait', arguments: { taskId: 'task-wait-1', ackFailureEventId: '' } },
  });
  assert.equal(response.result.isError, true, 'an empty ack id must be refused, not swallowed');
  const body = JSON.parse(response.result.content[0].text);
  assert.equal(body.error.code, 'MCP_ARGUMENT_REQUIRED');
});

test('F2: the HTTP layer refuses an empty ack id with the same policy', async () => {
  // The plane-level refusal is pinned in tests/http-wait.test.js; here the ENGINE
  // contract is pinned directly: an empty string is an explicit refusal, a null is
  // a refusal too — never a silent no-op.
  const monitor = frozenMonitor('task-ack-2');
  for (const id of ['x1', 'x2', 'x3']) failingPair(monitor, id);
  await monitor.observe({ waitMs: 1 });
  const pendingBefore = monitor.pendingFailure !== null;
  const empty = monitor.ackFailureReport('');
  assert.equal(empty.acknowledged, false);
  assert.equal(empty.reason, 'event-id-required');
  const nullAck = monitor.ackFailureReport(null);
  assert.equal(nullAck.acknowledged, false);
  assert.equal(nullAck.reason, 'event-id-required');
  assert.equal((monitor.pendingFailure !== null), pendingBefore, 'a refused ack never clears anything');
});

test('F3: the wait loop does not forward an ack at all when none was supplied', async () => {
  const payloads = [];
  const result = await waitForTask({
    callExecution: async (_route, payload) => {
      payloads.push(payload);
      // One early heartbeat (no time passes under the still clock), then the task
      // settles. The wait loop answers on the settled observation — it never
      // returns an internal heartbeat to the host.
      if (payloads.length === 1) return { ok: true, ...ackObservation('heartbeat', undefined) };
      return { ok: true, ...ackObservation('ready', undefined) };
    },
    taskId: 'task-wait-1',
    waitMs: 60_000,
    observeWaitMs: 25_000,
    ...stillWaitClock(),
  });
  assert.equal(result.reason, 'ready');
  for (const payload of payloads) {
    assert.equal('ackFailureEventId' in payload, false, 'no ack field is invented');
  }
});

/**
 * A still clock with a sleep that advances it in fixed slices, so the wait loop's
 * pacing logic terminates deterministically without wall time.
 * @returns {object} `{ now, sleep }`.
 */
function stillWaitClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += Math.max(1, ms); } };
}

// ---------------------------------------------------------------------------
// E. The wait tool is no longer announced read-only
// ---------------------------------------------------------------------------

test('E: delegate_wait annotations state that it mutates the reminder state', () => {
  const tool = TOOLS.find((entry) => entry.name === 'delegate_wait');
  assert.equal(tool.annotations.readOnlyHint, false, 'acknowledging clears reminder state — not read-only');
  assert.equal(tool.annotations.destructiveHint, false, 'and it destroys nothing');
});

// ---------------------------------------------------------------------------
// RED-1 kept from round 2: per-monitor event namespaces (regression guard)
// ---------------------------------------------------------------------------

test('round-1 guard: two tasks failing identically at the same instant mint DIFFERENT eventIds', async () => {
  const a = frozenMonitor('task-A');
  const b = frozenMonitor('task-B');
  for (const id of ['x1', 'x2', 'x3']) failingPair(a, id);
  for (const id of ['x1', 'x2', 'x3']) failingPair(b, id);
  const obsA = await a.observe({ waitMs: 1 });
  const obsB = await b.observe({ waitMs: 1 });
  assert.ok(obsA.failure && obsB.failure);
  assert.notEqual(obsA.failure.eventId, obsB.failure.eventId);
  const crossAck = b.ackFailureReport(obsA.failure.eventId);
  assert.equal(crossAck.acknowledged, false);
  const stillB = await b.observe({ waitMs: 1 });
  assert.equal(stillB.failure.eventId, obsB.failure.eventId);
  assert.equal(a.ackFailureReport(obsA.failure.eventId).acknowledged, true);
});

// Silence the unused-import warning for OBSERVE_REASONS used only in comments.
void OBSERVE_REASONS;
