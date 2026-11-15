// TB-09/TB-10 regression: a repeated-tool-failure reminder must survive a lost
// HTTP answer, and must be re-delivered until the receiver ACKNOWLEDGES it —
// not until the server has merely written it out.
//
// The defect: `RepeatedFailureTracker` parked the diagnostic with
// `episode.reported = true` and `claimFailureReport()` took it away in one
// synchronous step. The HTTP answer of the one observation that claimed it
// could be lost after the server had generated it (connection reset while the
// response was in flight, a client that died mid-read). The client's retry
// then observed only heartbeats, the reminder was gone, and every later
// identical failure stayed silent for the rest of the episode.
//
// This file drives the REAL loopback HTTP server, the REAL execution plane,
// the REAL JobEngine and the REAL `createExecutionClient` — no failure
// boundary is mocked away. The one simulated fact is the lost response: the
// server generates the full observation and then destroys the socket instead
// of writing it, which is exactly what a mid-response reset does to a client.
//
// What must hold afterwards:
//   1. The reminder carries a stable `eventId` that names the event without
//      carrying any argument or error text.
//   2. A retry observes the SAME reminder (same eventId) even though the
//      episode keeps failing up to and beyond the threshold — the server's
//      having written the answer once is NOT "the receiver has it".
//   3. Acknowledgment is bound to the same connection, the same task and the
//      exact eventId. A wrong eventId, an unknown event or an ack for another
//      task never clears the pending reminder.
//   4. Acknowledgment is idempotent; after it lands the reminder is not
//      delivered again.
//   5. A NEW episode (recovery, then the same failure again) has its own
//      identity and can be delivered again.
//   6. Concurrent observations cannot lose the reminder, and one repeated
//      failure is ONE notification identity, not several.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { listenLoopback } from './helpers/http.js';
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
import { AuthorizationRegistry } from '../src/auth/grants.js';
import { createExecutionHandler } from '../src/http/execution-plane.js';
import { JobEngine, OBSERVE_TASK_REASONS, TASK_STATES } from '../src/jobs/engine.js';
import { SettingsService } from '../src/config/settings.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import { createExecutionClient } from '../bin/dsh-delegate-mcp.js';

/** The pinned commit the fake git runner reports. */
const HEAD = 'a'.repeat(40);

/** Tool arguments used for every failing call; only their digest ever travels. */
const FAILING_ARGS = '{"command":"npm test"}';

function gitRunner() {
  return async (_cwd, args) => {
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
}

/**
 * The full production composition over loopback HTTP: engine, execution plane,
 * a real listening server and the real MCP execution client.
 * @param {object} [options] - `dropResponses`: number of initial `observe`
 *   responses to generate and then destroy instead of sending.
 * @returns {Promise<object>} fixture.
 */
async function loopbackFixture(options = {}) {
  let remainingDrops = options.dropResponses ?? 0;
  const dir = await makeTempDir();
  const workspace = await realpath(await mkdir(join(dir, 'workspace'), { recursive: true }).then(() => join(dir, 'workspace')));
  const settings = new SettingsService(join(dir, 'data'));
  await settings.replace({
    ...validSettings(),
    delegationEnabled: true,
    // Two live tasks at once, so the double-task isolation case can run.
    worker: { ...validSettings().worker, maxParallelism: 2 },
  });
  const auth = new AuthorizationRegistry();
  const locks = new WorkspaceLocks();
  const agents = fakeAgents({ respond: { text: 'implemented the change' } });
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({ workspaces });
  const resolveOriginal = sessionController.resolveAgent.bind(sessionController);
  // Never idle: the reminder must arrive while the run is still live, and only
  // a cancel can end such a run.
  sessionController.resolveAgent = async (sessionId) => {
    const found = await resolveOriginal(sessionId);
    if (found.agent !== undefined) {
      found.agent.followup = (message) => { found.agent.followups.push(message); };
      found.agent.whenIdle = async () => { await new Promise(() => {}); };
    }
    return found;
  };
  const policyServices = await nativePolicyServices();
  const presets = { async mount(ctx, id) { ctx.tools.schemas = () => ['read'].map((n) => ({ name: n, description: n, parameters: {} })); return { id: id ?? 'preset' }; } };
  const deps = {
    agents,
    agentPresets: presets,
    sessions: { async flush() {} },
    workspaces,
    sessionController,
    policyServices: () => policyServices,
    llm: fakeLlm({ providers: { 'relay-native': llmTable().relay } }),
    settings,
    auth,
    locks,
    runGit: gitRunner(),
    providerRegistry: { async ensure(providers) { const routes = new Map(); for (const p of providers) routes.set(p.id, `${p.id}-native`); return { routes }; } },
    logger: { info() {}, warn() {} },
    authorizationMode: 'switch',
    delegationEnabled: true,
  };
  const engine = new JobEngine(deps);
  deps.engine = engine;
  const innerHandler = createExecutionHandler({ ...deps, getBindHost: () => '127.0.0.1' });

  const dropped = [];
  /**
   * A response shim that lets the handler generate the FULL observation and then
   * loses it: writes and the final end() are swallowed and the socket is destroyed,
   * which is what a mid-response reset looks like to the client. Reads (writable
   * flags, the socket reference) fall through to the real response, so the plane's
   * own writability checks behave exactly as they would against a dying socket.
   * @param {object} res - the real server response.
   * @returns {object} the swallowing shim.
   */
  function swallowResponse(res) {
    const shim = Object.create(res);
    shim.writeHead = () => res;
    shim.write = (...args) => {
      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (callback !== null) callback();
      setImmediate(() => { res.socket?.destroy(); });
      return true;
    };
    shim.end = (...args) => {
      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (callback !== null) callback();
      setImmediate(() => { res.socket?.destroy(); });
      return res;
    };
    return shim;
  }
  const server = createServer((req, res) => {
    const isObserve = (req.url ?? '').includes('/tasks/observe');
    if (isObserve && remainingDrops > 0) {
      remainingDrops -= 1;
      dropped.push(req.url);
      // The handler runs to completion — the observation IS computed, exactly as it
      // would be for a caller that stays connected — but the answer is destroyed
      // instead of being written, so the client sees the connection die.
      void innerHandler(req, swallowResponse(res)).catch(() => {});
      return;
    }
    void innerHandler(req, res);
  });
  await listenLoopback(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  // The real MCP execution client, configured against the real loopback server.
  const client = createExecutionClient({ baseUrl: origin, timeoutMs: 5_000 });

  const connection = auth.issueConnection({ label: 'test' });
  const grant = auth.issueGrant(connection.connectionId, { kind: 'session', workspacePath: workspace, ttlSeconds: 3_600 });
  // A SECOND workspace under the same grant scope, so a second task can run
  // concurrently (one workspace holds exactly one live job).
  const workspace2 = await realpath(await mkdir(join(dir, 'workspace-2'), { recursive: true }).then(() => join(dir, 'workspace-2')));
  auth.issueGrant(connection.connectionId, { kind: 'session', workspacePath: workspace2, ttlSeconds: 3_600 });
  const started = await engine.start({
    connectionId: connection.connectionId,
    grantId: grant.grantId,
    workspacePath: workspace,
    prompt: 'long job',
  });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const task = engine.tasks.get(started.taskId);
    if (task !== undefined && task.state === 'running' && task.monitor) break;
    await new Promise((r) => { setTimeout(r, 5); });
  }
  const task = engine.tasks.get(started.taskId);
  assert.ok(task && task.monitor, 'the run must be live');

  /**
   * Feed one failing tool call/result through the engine's own event hook.
   * @param {string} callId - call identity.
   * @param {{ code?: string, reason?: string, args?: string }} [overrides].
   * @returns {void}
   */
  function failOnce(callId, overrides = {}) {
    engine.onExecutionEvent(task, { type: 'tool/call', data: { turn: 1, step: 1, callId, name: 'bash', arguments: overrides.args ?? FAILING_ARGS } });
    engine.onExecutionEvent(task, {
      type: 'tool/result',
      data: {
        turn: 1, step: 1,
        message: { role: 'tool', toolCallId: callId, isError: true, content: [{ type: 'text', text: `SECRET BODY ${callId}` }] },
        error: { name: 'ToolError', code: overrides.code ?? 'ENOENT', ...(overrides.reason === undefined ? {} : { reason: overrides.reason }) },
      },
    });
  }

  return {
    engine, task, client, origin, server, dropped,
    connectionId: connection.connectionId,
    grantId: grant.grantId,
    workspace,
    workspace2,
    failOnce,
    ack: (eventId) => client('observe', { taskId: task.taskId, waitMs: 1, ackFailureEventId: eventId }, { retry: false }),
    observe: () => client('observe', { taskId: task.taskId, waitMs: 1 }, { retry: false }),
    async close() {
      server.close();
      await engine.dispose();
      await cleanup(dir);
    },
  };
}

// ---------------------------------------------------------------------------
// The end-to-end defect: response generated, answer lost, retry must recover
// ---------------------------------------------------------------------------

test('a lost observe answer does not lose the reminder: the retry and every later failure get the same eventId', async () => {
  const f = await loopbackFixture({ dropResponses: 1 });
  try {
    // Three identical failures reach the default threshold; the ONE observation
    // that would deliver them is generated and lost on the wire.
    f.failOnce('c1');
    f.failOnce('c2');
    f.failOnce('c3');
    assert.equal(f.dropped.length, 0);
    await assert.rejects(() => f.observe(), (error) => {
      // The socket was destroyed mid-response, so the client's fetch rejects with a
      // transport-level loss: exactly the shape the retry policy is designed for.
      assert.equal(error.code, 'MCP_HARNESS_UNREACHABLE');
      return true;
    });
    assert.equal(f.dropped.length, 1, 'the server really generated and destroyed one response');

    // The retry — the same observation the client re-issues — still gets the
    // original reminder, not a heartbeat.
    const retry = await f.observe();
    assert.equal(retry.reason, 'attention');
    assert.ok(retry.failure, 'the reminder must survive the lost answer');
    assert.equal(retry.failure.kind, 'repeated-tool-failure');
    assert.equal(retry.failure.toolName, 'bash');
    assert.equal(retry.failure.consecutive, 3);
    const eventId = retry.failure.eventId;
    assert.match(eventId, /^[0-9a-f]{16}$/u, 'the reminder has a stable identity');

    // The episode keeps failing (up to the 6th failure from the scenario): the
    // reminder identity stays THE SAME — one notification, not a new one per failure.
    f.failOnce('c4');
    f.failOnce('c5');
    f.failOnce('c6');
    const later = await f.observe();
    assert.equal(later.reason, 'attention');
    assert.equal(later.failure.eventId, eventId, 'later identical failures do not mint a new notification');
    // And nothing about the arguments or bodies travels.
    const serialized = JSON.stringify(later);
    assert.equal(serialized.includes('npm test'), false);
    assert.equal(serialized.includes('SECRET BODY'), false);

    // A third connection observing ITS view is impossible here (switch mode is
    // one local caller), so the binding is proven at the ack boundary instead:
    // an ack with a wrong eventId never clears it.
    const badAck = await f.ack('0'.repeat(16));
    assert.equal(badAck.failureAck.acknowledged, false);
    const stillThere = await f.observe();
    assert.equal(stillThere.failure.eventId, eventId, 'a wrong ack does not clear the reminder');

    // The correct ack clears it — and stays cleared under repeated observation.
    const ack = await f.ack(eventId);
    assert.equal(ack.failureAck.acknowledged, true);
    assert.equal(ack.failureAck.eventId, eventId);
    const quiet = await f.observe();
    assert.equal(quiet.failure ?? null, null, 'after acknowledgment the reminder is not delivered again');
    const quietAgain = await f.observe();
    assert.equal(quietAgain.failure ?? null, null, 'acknowledgment is durable for the episode');

    await f.engine.cancel(f.task.taskId, 'test-end');
  } finally {
    await f.close();
  }
});

test('acknowledgment is idempotent and a second ack of a cleared event answers acknowledged: true', async () => {
  const f = await loopbackFixture();
  try {
    f.failOnce('a1');
    f.failOnce('a2');
    f.failOnce('a3');
    const first = await f.observe();
    const eventId = first.failure.eventId;
    const ack1 = await f.ack(eventId);
    assert.equal(ack1.failureAck.acknowledged, true);
    // Idempotent: acking the same (now cleared) event again is a success, not an error.
    const ack2 = await f.ack(eventId);
    assert.equal(ack2.failureAck.acknowledged, true, 'repeat ack is idempotent');
    const ack3 = await f.ack(eventId);
    assert.equal(ack3.failureAck.acknowledged, true);
    await f.engine.cancel(f.task.taskId, 'test-end');
  } finally {
    await f.close();
  }
});

test('an unknown eventId and a malformed ack never clear the pending reminder', async () => {
  const f = await loopbackFixture();
  try {
    f.failOnce('u1');
    f.failOnce('u2');
    f.failOnce('u3');
    const first = await f.observe();
    const eventId = first.failure.eventId;
    // Unknown and wrong ids are honest unacknowledged answers; an EMPTY string is
    // refused outright by the HTTP layer (the unified validation policy: non-empty,
    // at most 64 chars, exactly like the MCP schema's minLength/maxLength).
    for (const wrong of ['deadbeef'.repeat(2), 'x'.repeat(15), eventId.slice(0, 15) + 'z']) {
      const answer = await f.ack(wrong);
      assert.equal(answer.failureAck.acknowledged, false, `a wrong ack (${JSON.stringify(wrong)}) must not succeed`);
    }
    await assert.rejects(() => f.ack(''), (error) => {
      assert.equal(error.code, 'OBSERVE_ACK_INVALID', 'an empty ack id is refused, not silently ignored');
      return true;
    });
    const still = await f.observe();
    assert.equal(still.failure.eventId, eventId, 'the reminder survives every wrong ack');
    const good = await f.ack(eventId);
    assert.equal(good.failureAck.acknowledged, true);
    await f.engine.cancel(f.task.taskId, 'test-end');
  } finally {
    await f.close();
  }
});

test('concurrent observations both see the same reminder identity, and none of them loses it', async () => {
  const f = await loopbackFixture();
  try {
    f.failOnce('p1');
    f.failOnce('p2');
    f.failOnce('p3');
    const [one, two] = await Promise.all([f.observe(), f.observe()]);
    assert.ok(one.failure && two.failure, 'both concurrent observers got the reminder');
    assert.equal(one.failure.eventId, two.failure.eventId, 'one repeated failure is ONE notification identity');
    const ack = await f.ack(one.failure.eventId);
    assert.equal(ack.failureAck.acknowledged, true);
    const after = await f.observe();
    assert.equal(after.failure ?? null, null, 'one ack clears it for every observer');
    await f.engine.cancel(f.task.taskId, 'test-end');
  } finally {
    await f.close();
  }
});

test('a reminder superseded by recovery is dropped, and a new episode after recovery has its own identity', async () => {
  const f = await loopbackFixture();
  try {
    f.failOnce('n1');
    f.failOnce('n2');
    f.failOnce('n3');
    const first = await f.observe();
    const firstEventId = first.failure.eventId;
    // The ack never arrives; instead the run RECOVERS (a success ends the episode).
    f.engine.onExecutionEvent(f.task, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'ok1', name: 'bash', arguments: FAILING_ARGS } });
    f.engine.onExecutionEvent(f.task, { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'ok1', content: [{ type: 'text', text: 'fine' }] } } });
    const afterRecovery = await f.observe();
    assert.equal(afterRecovery.failure ?? null, null, 'a recovered episode is history, not news');
    // Late ack of the stale event: honest but inert.
    const staleAck = await f.ack(firstEventId);
    assert.equal(staleAck.failureAck.acknowledged, false, 'a stale event can no longer be acknowledged as pending');

    // A new episode of the same failure starts: independent identity, delivered again.
    f.failOnce('n4');
    f.failOnce('n5');
    f.failOnce('n6');
    const second = await f.observe();
    assert.ok(second.failure, 'a new episode is delivered again');
    assert.notEqual(second.failure.eventId, firstEventId, 'a new episode has its own identity');
    assert.equal(second.failure.consecutive, 3);
    await f.engine.cancel(f.task.taskId, 'test-end');
  } finally {
    await f.close();
  }
});

test('terminal and permission states still outrank the reminder, and cancel wins over a pending reminder', async () => {
  const f = await loopbackFixture();
  try {
    f.failOnce('t1');
    f.failOnce('t2');
    f.failOnce('t3');
    // Do not observe: park the reminder, then cancel.
    const cancelled = await f.engine.cancel(f.task.taskId, 'operator');
    assert.equal(cancelled.state, TASK_STATES.cancelled);
    const observation = await f.observe();
    assert.equal(observation.reason, OBSERVE_TASK_REASONS.cancelled);
    assert.equal(observation.failure ?? null, null, 'a cancelled run reports the cancellation, not a reminder');
    const staleAck = await f.ack('0'.repeat(16));
    assert.equal(staleAck.failureAck.acknowledged, false, 'nothing is acknowledged on a settled run');
  } finally {
    await f.close();
  }
});

test('an old-style observe body (no ack field) still works unchanged and gets the failureAck echo omitted', async () => {
  const f = await loopbackFixture();
  try {
    const heartbeat = await f.observe();
    assert.equal(heartbeat.ok, true);
    assert.equal('failureAck' in heartbeat, false, 'a call that did not ask to ack is not answered with an ack block');
    f.failOnce('o1');
    f.failOnce('o2');
    f.failOnce('o3');
    const withFailure = await f.observe();
    assert.ok(withFailure.failure);
    assert.equal('failureAck' in withFailure, false);
    await f.engine.cancel(f.task.taskId, 'test-end');
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// MCP boundary: `delegate_wait` surfaces the eventId, forwards a host ack, and
// the loopback wait through the real plane replays after a lost answer.
// ---------------------------------------------------------------------------

test('HTTP transport: a plain observe carries the failure eventId and a host ack through the real plane lands', async () => {
  // NOTE: this exercises the HTTP transport only — no MCP server participates.
  // The production MCP/stdio boundary is proven separately below.
  const f = await loopbackFixture();
  try {
    f.failOnce('m1');
    f.failOnce('m2');
    f.failOnce('m3');
    // A plain observe (what delegate_wait issues internally) carries the identity.
    const observation = await f.observe();
    const eventId = observation.failure.eventId;

    // The host acks through the same observe route; the wait loop forwards it.
    const acked = await f.ack(eventId);
    assert.equal(acked.failureAck.acknowledged, true);

    // The engine answer stays quiet afterwards: the next wait cannot re-wake.
    const quiet = await f.observe();
    assert.equal(quiet.failure ?? null, null);
    await f.engine.cancel(f.task.taskId, 'test-end');
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// The PRODUCTION MCP/stdio boundary over the real loopback HTTP plane: a real
// MCP server (createMcpServer) speaking JSON-RPC over real stdio streams, with
// a real createExecutionClient against the real listening plane and engine.
// ---------------------------------------------------------------------------

import { createMcpServer, serveStdio } from '../src/mcp/server.js';

/**
 * Wrap a stdio server pair around a real MCP server instance.
 * @param {object} server - the MCP server.
 * @returns {object} in-memory stdio harness (`send`, `replies`, `replyTo`, `done`, `close`).
 */
function stdioHarness(server, options = {}) {
  const input = new Readable({ read() {} });
  const chunks = [];
  const droppedChunks = [];
  let dropNextReply = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString('utf8');
      if (dropNextReply) {
        // The stdio boundary loses one fully generated JSON-RPC reply: the server
        // wrote it, the client never received it. This is the transport fact the
        // redelivery must cover, modelled where it actually happens.
        droppedChunks.push(text);
        dropNextReply = false;
      } else {
        chunks.push(text);
      }
      callback();
    },
  });
  const done = serveStdio({ input, output, server, ...options });
  const send = (message) => input.push(`${JSON.stringify(message)}\n`);
  const replies = () => chunks.join('').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
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
    input, output, chunks, done, send, replies, replyTo,
    /** Drop the NEXT reply the server writes (the client never sees it). */
    dropNextReply() { dropNextReply = true; },
    /** The replies that were generated and then lost at the stdio boundary. */
    dropped: droppedChunks,
    async close() {
      input.push(null);
      await done;
    },
  };
}

test('PRODUCTION MCP/stdio over real loopback HTTP: lost answer, same-id replay, ack, quiet, wrong ack, concurrency', async () => {
  // One fixture carries TWO live tasks failing identically at the same wall-clock
  // time, so the double-task isolation is proven on the production path too.
  const f = await loopbackFixture({ dropResponses: 1 });
  try {
    // Second live task on the same engine: identical failure episode, same instant.
    const second = await f.engine.start({
      connectionId: f.connectionId,
      grantId: f.grantId,
      workspacePath: f.workspace2,
      prompt: 'second long job',
    });
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const t = f.engine.tasks.get(second.taskId);
      if (t !== undefined && t.state === 'running' && t.monitor) break;
      await new Promise((r) => { setTimeout(r, 5); });
    }
    const task2 = f.engine.tasks.get(second.taskId);
    const failOnce2 = (callId) => {
      f.engine.onExecutionEvent(task2, { type: 'tool/call', data: { turn: 1, step: 1, callId, name: 'bash', arguments: FAILING_ARGS } });
      f.engine.onExecutionEvent(task2, {
        type: 'tool/result',
        data: {
          turn: 1, step: 1,
          message: { role: 'tool', toolCallId: callId, isError: true, content: [{ type: 'text', text: `SECRET BODY ${callId}` }] },
          error: { name: 'ToolError', code: 'ENOENT', reason: 'the tool said so' },
        },
      });
    };
    f.failOnce('c1');
    f.failOnce('c2');
    f.failOnce('c3');
    failOnce2('d1');
    failOnce2('d2');
    failOnce2('d3');

    // The real MCP server wired to the real HTTP client.
    const server = createMcpServer({ callExecution: f.client });
    const harness = stdioHarness(server);
    harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await harness.replyTo(1);

    // 1. The first delegate_wait call: its FIRST internal observe is the one whose
    //    answer the fixture drops. The real client retries the observation once
    //    (1 s backoff), and the retry is answered with the SAME reminder — so the
    //    host never even notices the loss. The reminder cannot be lost here.
    harness.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'delegate_wait', arguments: { taskId: f.task.taskId, waitSeconds: 1 } } });
    const lost = await harness.replyTo(2);
    const lostBody = JSON.parse(lost.result.content[0].text);
    assert.equal(lostBody.reason, 'attention');
    assert.ok(lostBody.failure, 'the retry recovered the reminder the lost answer carried');
    assert.equal(f.dropped.length, 1, 'the server really destroyed one generated answer');
    assert.equal(lostBody.failureAck, undefined, 'a call that did not ack publishes no ack block');
    const eventId = lostBody.failure.eventId;

    // 2. The host retries WITHOUT its own ack: the replayed reminder is the SAME
    //    event (same eventId) — redelivery, not a second notification.
    harness.send({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'delegate_wait', arguments: { taskId: f.task.taskId, waitSeconds: 1 } } });
    const replay = await harness.replyTo(3);
    const replayBody = JSON.parse(replay.result.content[0].text);
    assert.equal(replayBody.reason, 'attention');
    assert.ok(replayBody.failure, 'the replayed wait carries the reminder');
    assert.equal(replayBody.failure.eventId, eventId, 'one repeated failure is one notification identity');

    // 3. Double-task isolation: the second task's reminder (same wall-clock instant,
    //    same failure shape) carries a DIFFERENT identity.
    harness.send({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'delegate_wait', arguments: { taskId: second.taskId, waitSeconds: 1 } } });
    const secondAnswer = await harness.replyTo(4);
    const secondBody = JSON.parse(secondAnswer.result.content[0].text);
    assert.ok(secondBody.failure, 'the second task delivered its own reminder');
    assert.notEqual(secondBody.failure.eventId, eventId, 'two tasks at the same instant never share an eventId');

    // 4. A WRONG ack (task B's id against task A) is refused and changes nothing;
    //    the refusal carries the refused-ack fact as details.failureAck.
    harness.send({ jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'delegate_wait', arguments: { taskId: f.task.taskId, waitSeconds: 1, ackFailureEventId: secondBody.failure.eventId } } });
    const wrongAck = await harness.replyTo(5);
    const wrongBody = JSON.parse(wrongAck.result.content[0].text);
    assert.equal(wrongBody.reason, 'attention', 'a wrong ack is refused; the reminder rides attention again');
    assert.deepEqual(wrongBody.failureAck, { acknowledged: false, eventId: secondBody.failure.eventId, reason: 'unknown-event' },
      'the refused-ack fact reaches the host on the wait answer');

    // 5. The CORRECT ack lands; the answer carries the acknowledged fact.
    harness.send({ jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'delegate_wait', arguments: { taskId: f.task.taskId, waitSeconds: 1, ackFailureEventId: eventId } } });
    const ackAnswer = await harness.replyTo(6);
    const ackBody = JSON.parse(ackAnswer.result.content[0].text);
    assert.equal(ackBody.failureAck.acknowledged, true, 'the ack receipt reaches the host end to end');

    // 6. Quiet afterwards: the wait for the acked task stops re-waking on the reminder.
    harness.send({ jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'delegate_wait', arguments: { taskId: f.task.taskId, waitSeconds: 1 } } });
    const quiet = await harness.replyTo(7);
    const quietBody = JSON.parse(quiet.result.content[0].text);
    assert.equal(quietBody.failure ?? null, null, 'no redelivery after the ack');
    assert.equal('failureAck' in quietBody, false, 'a call that did not ack publishes no ack block');

    // 7. Terminal wins: cancel beats any parked reminder on task 2, and a wrong ack
    //    against the cancelled (live-monitor) task is honestly refused as unknown.
    await f.engine.cancel(second.taskId, 'operator');
    harness.send({ jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'delegate_wait', arguments: { taskId: second.taskId, waitSeconds: 1, ackFailureEventId: '0'.repeat(16) } } });
    const cancelled = await harness.replyTo(8);
    const cancelledBody = JSON.parse(cancelled.result.content[0].text);
    assert.equal(cancelledBody.reason, 'cancelled');
    assert.equal(cancelledBody.failureAck.acknowledged, false, 'nothing is acknowledged on a settled run');
    assert.equal(['unknown-event', 'no-pending'].includes(cancelledBody.failureAck.reason), true,
      'the refusal names its reason honestly (unknown-event for a live monitor, no-pending for a stored history)');

    // 8. Concurrency: two waits on the two tasks in flight at once both answer.
    harness.send({ jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'delegate_wait', arguments: { taskId: f.task.taskId, waitSeconds: 1 } } });
    harness.send({ jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'delegate_wait', arguments: { taskId: second.taskId, waitSeconds: 1 } } });
    const [nine, ten] = await Promise.all([harness.replyTo(9), harness.replyTo(10)]);
    assert.ok(nine.result && ten.result, 'two concurrent waits both answer over stdio');

    await harness.close();
    await f.engine.cancel(f.task.taskId, 'test-end');
  } finally {
    await f.close();
  }
});

test('PRODUCTION MCP/stdio: a generated tool reply lost at the stdio boundary is recovered by a NEW wait call', async () => {
  // The failure boundary the round-2 e2e did NOT cover: the HTTP observe answer
  // arrives fine, the MCP server generates the full tool reply, and the stdio
  // client never receives it. The host then re-waits (a NEW requestId, no ack)
  // and must get the SAME reminder identity back.
  const f = await loopbackFixture();
  try {
    f.failOnce('s1');
    f.failOnce('s2');
    f.failOnce('s3');
    const server = createMcpServer({ callExecution: f.client });
    const harness = stdioHarness(server);
    harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await harness.replyTo(1);

    // The first wait's reply is generated and then dropped at the stdio boundary.
    harness.dropNextReply();
    harness.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'delegate_wait', arguments: { taskId: f.task.taskId, waitSeconds: 1 } } });
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 400); });
    assert.equal(harness.dropped.length, 1, 'the server really wrote one reply that was lost');
    const lostReply = JSON.parse(harness.dropped[0]);
    const lostBody = JSON.parse(lostReply.result.content[0].text);
    assert.ok(lostBody.failure, 'the LOST reply really carried the reminder');
    const eventId = lostBody.failure.eventId;

    // The host re-waits with a NEW requestId and no ack: the SAME eventId returns.
    harness.send({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'delegate_wait', arguments: { taskId: f.task.taskId, waitSeconds: 1 } } });
    const replay = await harness.replyTo(3);
    const replayBody = JSON.parse(replay.result.content[0].text);
    assert.equal(replayBody.reason, 'attention');
    assert.equal(replayBody.failure.eventId, eventId, 'the lost reminder is redelivered with the SAME identity');

    // The lost ack reply: the server generates an acknowledged receipt, stdio drops
    // it; the host retries the SAME ack id and gets the same idempotent receipt,
    // never a duplicate reminder or a second notification.
    harness.dropNextReply();
    harness.send({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'delegate_wait', arguments: { taskId: f.task.taskId, waitSeconds: 1, ackFailureEventId: eventId } } });
    // The ack wait can consume an internal heartbeat before answering; poll until
    // its (dropped) reply has really been generated.
    for (let attempt = 0; attempt < 100 && harness.dropped.length < 2; attempt += 1) {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 20); });
    }
    assert.equal(harness.dropped.length, 2, 'the ack reply was also generated and lost');
    const lostAckReply = JSON.parse(harness.dropped[1]);
    const lostAck = JSON.parse(lostAckReply.result.content[0].text);
    assert.equal(lostAck.failureAck.acknowledged, true, 'the lost reply really carried the acknowledged receipt');

    harness.send({ jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'delegate_wait', arguments: { taskId: f.task.taskId, waitSeconds: 1, ackFailureEventId: eventId } } });
    const ackRetry = await harness.replyTo(5);
    const ackRetryBody = JSON.parse(ackRetry.result.content[0].text);
    assert.deepEqual(ackRetryBody.failureAck, { acknowledged: true, eventId, reason: null },
      'the retried ack is idempotent and quiet — no reminder, no new notification');
    assert.equal(ackRetryBody.failure ?? null, null);

    await harness.close();
    await f.engine.cancel(f.task.taskId, 'test-end');
  } finally {
    await f.close();
  }
});
