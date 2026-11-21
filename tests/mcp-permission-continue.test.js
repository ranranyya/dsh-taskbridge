// `delegate_permission_decide({ waitAfterDecision: true })` and the accounting around it.
//
// What this file is about, in one sentence: after a commander decides a paused per-call
// permission request, ONE MCP call must be enough to learn what the task did next — and
// the answer must never let the commander mistake "the decision was applied but the
// following wait ended" for "the decision failed", nor let a new request inherit the
// previous allow.
//
// Four properties are the whole point, and every test below serves one of them:
//
//   1. **Historical compatibility.** Without the flag the answer is the permission route's
//      own reply, unchanged: no receipt, no extra field.
//   2. **One call, one shared loop.** The continuing answer is the SAME flat shape
//      `delegate_wait` returns, produced by the SAME wait loop — the only addition is a
//      `decisionReceipt`. There is no second loop, no second deadline and no second reason
//      vocabulary.
//   3. **The receipt survives everything.** The following wait may answer, reach its own
//      deadline, fail or be cancelled; `decisionReceipt.applied` stays true and the
//      decision is never re-sent. A call that failed BEFORE the harness answered is
//      `applied: null` with `confirmation: "unknown"` — never a fabricated `false`.
//   4. **The control field never reaches the backend.** `waitAfterDecision` is stripped at
//      the MCP boundary; the permission route's existing closed validation is the guard.
//
// The clock and the sleep are injected, so these tests model minutes in milliseconds.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';

import {
  DEFAULT_WAIT_SECONDS,
  LATEST_PROTOCOL_VERSION,
  MAX_INFLIGHT_REQUESTS,
  MCP_ONLY_ARGUMENTS,
  OBSERVE_WAIT_MS,
  TOOLS,
  WAIT_LIMIT_REASON,
  createMcpServer,
  serveStdio,
} from '../src/mcp/server.js';
import { decidedRequestMatcher, decisionReceipt } from '../src/mcp/continuation.js';
import { NOT_INTEGRATED, createCallMetrics } from '../src/mcp/metrics.js';
import { MAX_OBSERVE_WAIT_MS } from '../src/http/execution-plane.js';
import { buildWorkerPrompt } from '../src/runtime/worker-prompt.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A compact task summary in the shape the engine publishes. */
function summary(overrides = {}) {
  return {
    taskId: 'task-1',
    state: 'running',
    phase: 'execute',
    elapsedMs: 5_000,
    lastActivityAt: 1_760_000_000_000,
    currentTool: 'pwsh',
    idleForMs: 10,
    route: { providerId: 'relay', providerRoute: 'relay-native', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
    activity: { toolCalls: 2, turns: 1 },
    selfCheck: { ok: true },
    // Never part of a wait answer.
    diff: { patchText: 'diff --git a/secret b/secret\n+leak\n' },
    execution: { text: 'the whole execution prose' },
    ...overrides,
  };
}

/** A pending per-call permission request with the identity a decision is bound to. */
function pending(overrides = {}) {
  const requestId = overrides.requestId ?? 'permission-task-1-1';
  return {
    requestId,
    taskId: 'task-1',
    sessionId: 'session-1',
    toolName: 'pwsh',
    callId: `call-${requestId}`,
    state: 'pending',
    completeness: 'complete',
    argumentsComplete: true,
    allowBlocked: null,
    fingerprint: `sha256:${'a'.repeat(64)}`,
    arguments: JSON.stringify({ command: 'Get-ChildItem C:\\outside' }),
    argumentKeys: ['command'],
    requestedAccess: { kind: 'sandbox-escalation', mode: 'danger-full-access' },
    reason: 'listing a directory outside the workspace',
    reasonSource: 'asker-claim',
    boundsApplied: [],
    omitted: { valueChars: 0, keys: 0, depth: 0, items: 0 },
    ...overrides,
  };
}

/** One observation answer. */
function observation(reason, overrides = {}) {
  return {
    task: summary(),
    reason,
    permission: reason === 'permission' ? (overrides.permission ?? pending()) : null,
    activity: { toolCalls: 2 },
    selfCheck: { ok: true },
    wait: { waitMs: OBSERVE_WAIT_MS, waitedMs: OBSERVE_WAIT_MS, activitySinceWait: false },
    ...overrides,
  };
}

/** A clock advanced only by `sleep`. */
function fakeClock(start = 1_760_000_000_000) {
  let time = start;
  return {
    now: () => time,
    sleep: async (ms) => { time += ms; },
    advance: (ms) => { time += ms; },
    elapsed: () => time - start,
  };
}

/**
 * Build the answer the harness gives for one applied decision.
 *
 * It models the REAL permission route's success shape:
 * `{ ok: true, task: { taskId, … }, permission: { taskId, requestId, fingerprint,
 * state: 'decided', outcome: 'allowed-once' | 'rejected', verified?, grant?, decision? } }`.
 *
 * The settled request is the one the HARNESS settled: `requests` is the task's live request
 * table, so the fixture reports the real `requestId`+`fingerprint` of the request being
 * decided. `decision` is left `null` on purpose — the real bridge reports it that way — so
 * nothing can pass by reading a field the harness does not always fill.
 * @param {object} args - the validated decision arguments the server sent.
 * @param {object[]} requests - the task's live request table.
 * @returns {object} a permission-route answer body.
 */
function decisionAnswer(args, requests = []) {
  const known = requests.find((entry) => entry.requestId === args.requestId);
  // The settled record is the LIVE request with its decision applied: the harness reports
  // the operation it decided, including the arguments, not a re-generated summary.
  const request = known ?? pending({
    requestId: args.requestId,
    fingerprint: args.fingerprint ?? `sha256:${'a'.repeat(64)}`,
  });
  const settled = {
    ...request,
    state: 'decided',
    decision: null,
    outcome: args.decision === 'allow-once' ? 'allowed-once' : 'rejected',
    decidedAt: 1_760_000_000_100,
    decidedBy: 'commander',
    ...(args.decision === 'allow-once'
      ? {
        verified: {
          fingerprintQuoted: true, argumentsComplete: true, callReread: true, turnOpen: true, boundsApplied: [],
        },
        grant: { kind: 'allowed-once', appliesTo: 'this-call-only', callId: request.callId, reusable: false },
      }
      : {}),
  };
  return {
    ok: true,
    task: summary({ taskId: request.taskId, state: 'running', phase: 'execute' }),
    permission: settled,
    hostAcceptance: null,
  };
}

/**
 * Build a server whose `callExecution` is scripted per route.
 * @param {object} script - `permission` (function of the body, may throw), `observe`
 *   (function of `{ payload, index, clock }`).
 * @param {object} [options] - `clock`.
 * @returns {object} fixture.
 */
function decisionFixture(script, options = {}) {
  const calls = [];
  const clock = options.clock ?? fakeClock();
  let observeIndex = 0;
  const server = createMcpServer({
    now: clock.now,
    sleep: clock.sleep,
    async callExecution(route, payload, context) {
      calls.push({ route, payload, signal: context?.signal });
      if (route === 'permission') {
        if (typeof script.permission === 'function') return await script.permission(payload, { clock, calls });
        return decisionAnswer(payload);
      }
      if (route === 'observe') {
        const answered = typeof script.observe === 'function'
          ? await script.observe({ payload, index: observeIndex, clock, calls })
          : observation('heartbeat');
        observeIndex += 1;
        if (answered instanceof Error) throw answered;
        return { ok: true, ...answered };
      }
      if (route === 'status') return { ok: true, delegated: { authorized: true } };
      if (route === 'cancel') return { ok: true, task: { taskId: payload.taskId, state: 'cancelled' } };
      return { ok: true, route };
    },
  });
  const lastFor = (route) => [...calls].reverse().find((call) => call.route === route)?.payload;
  return { server, calls, clock, lastFor };
}

/**
 * Initialize a server and call one tool, returning the parsed answer and its raw text.
 * @param {object} server - MCP server.
 * @param {string} name - tool name.
 * @param {object} args - arguments.
 * @param {object} [context] - per-request context (`signal`).
 * @returns {Promise<{ body: object, text: string, isError: boolean }>} outcome.
 */
async function call(server, name, args, context = {}) {
  await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION } });
  const response = await server.handle(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    context,
  );
  const text = response.result.content[0].text;
  return { body: JSON.parse(text), text, isError: response.result.isError === true };
}

/** Three requests of the sequential scenario, each with its own fingerprint. */
function sequenceRequests() {
  return [
    pending({ requestId: 'permission-task-1-1', fingerprint: `sha256:${'1'.repeat(64)}` }),
    pending({ requestId: 'permission-task-1-2', fingerprint: `sha256:${'2'.repeat(64)}` }),
    pending({ requestId: 'permission-task-1-3', fingerprint: `sha256:${'3'.repeat(64)}` }),
  ];
}

// ---------------------------------------------------------------------------
// 1. The tool surface
// ---------------------------------------------------------------------------

test('waitAfterDecision is an OPTIONAL boolean, and the historical argument set is unchanged', () => {
  const tool = TOOLS.find((entry) => entry.name === 'delegate_permission_decide');
  assert.deepEqual(Object.keys(tool.inputSchema.properties), [
    'taskId', 'requestId', 'decision', 'reason', 'fingerprint', 'waitAfterDecision',
  ]);
  const field = tool.inputSchema.properties.waitAfterDecision;
  assert.equal(field.type, 'boolean', 'a model that sends "true" must be refused, not coerced');
  assert.match(field.description, /default false/u, 'the copy must state that the historical behaviour is the default');
  assert.match(field.description, /never .{0,20}inherited|NOT inherited/u, 'the copy must deny inheritance');
  assert.deepEqual(tool.inputSchema.required, ['taskId', 'requestId', 'decision']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(MCP_ONLY_ARGUMENTS.delegate_permission_decide, ['waitAfterDecision']);
});

test('waitAfterDecision refuses a non-boolean, and nothing is decided when it does', async () => {
  const { server, calls } = decisionFixture({});
  for (const value of ['true', 1, {}, null]) {
    const answer = await call(server, 'delegate_permission_decide', {
      taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'reject', waitAfterDecision: value,
    });
    assert.equal(answer.isError, true, `${JSON.stringify(value)} must be refused`);
    assert.equal(answer.body.error.code, 'MCP_ARGUMENT_TYPE');
  }
  assert.deepEqual(calls, [], 'a refused argument never reaches the harness');
});

test('the control field is stripped at the MCP boundary and never reaches the permission route', async () => {
  const { server, lastFor } = decisionFixture({
    permission: (body) => decisionAnswer(body),
    observe: () => observation('ready', { task: summary({ state: 'awaiting-host-review', phase: 'review' }) }),
  });
  const answer = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'allow-once',
    fingerprint: `sha256:${'a'.repeat(64)}`, waitAfterDecision: true,
  });
  assert.equal(answer.isError, false);
  const sent = lastFor('permission');
  assert.equal('waitAfterDecision' in sent, false, 'the decision body is exactly the pre-existing one');
  assert.deepEqual(sent, {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'allow-once', fingerprint: `sha256:${'a'.repeat(64)}`,
  });
  assert.deepEqual(lastFor('observe'), { taskId: 'task-1', waitMs: OBSERVE_WAIT_MS },
    'the continuing wait issues the same observation a plain wait issues');
});

// ---------------------------------------------------------------------------
// 2. Historical compatibility
// ---------------------------------------------------------------------------

test('without the flag the answer is the permission route reply, verbatim', async () => {
  const { server, calls } = decisionFixture({ permission: (body) => decisionAnswer(body) });
  const plain = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'reject',
  });
  assert.equal(plain.isError, false);
  assert.deepEqual(Object.keys(plain.body), ['ok', 'task', 'permission', 'hostAcceptance'],
    'the historical answer shape is byte-for-byte what it was: no receipt, no added field');
  assert.equal(plain.body.permission.state, 'decided');
  assert.deepEqual(calls.map((entry) => entry.route), ['permission'], 'no observation is issued for a plain decision');
  // The internal census still records it — accounting is not part of the answer.
  const census = server.metrics();
  assert.equal(census.decisions.count, 1);
  assert.equal(census.decisions.applied, 1);

  calls.length = 0;
  const explicit = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'reject', waitAfterDecision: false,
  });
  assert.deepEqual(explicit.body, plain.body, 'an explicit false is the same call');
  assert.deepEqual(calls.map((entry) => entry.route), ['permission']);
});

test('a refusal without the flag is rethrown unchanged, code and all', async () => {
  const { server, calls } = decisionFixture({
    permission: () => {
      const error = new Error('the permission request expired before this decision');
      error.code = 'PERMISSION_REQUEST_EXPIRED';
      throw error;
    },
  });
  const answer = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'allow-once',
    fingerprint: `sha256:${'a'.repeat(64)}`,
  });
  assert.equal(answer.isError, true);
  assert.equal(answer.body.error.code, 'PERMISSION_REQUEST_EXPIRED');
  assert.deepEqual(Object.keys(answer.body), ['ok', 'error'], 'no receipt on a refusal');
  assert.deepEqual(calls.map((entry) => entry.route), ['permission']);
});

// ---------------------------------------------------------------------------
// 3. The continuing answer is the SAME flat wait shape
// ---------------------------------------------------------------------------

test('the continuing answer is the flat wait shape plus a receipt, never a nested block', async () => {
  const { server } = decisionFixture({
    permission: (body) => decisionAnswer(body, [pending({ requestId: 'permission-task-1-9' })]),
    observe: () => observation('permission', { permission: pending({ requestId: 'permission-task-1-9' }) }),
  });
  const answer = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'reject', waitAfterDecision: true,
  });
  assert.equal(answer.isError, false);
  // Top-level wait fields, exactly where a plain wait puts them.
  assert.equal(answer.body.reason, 'permission');
  assert.equal(answer.body.state, 'running');
  assert.equal(answer.body.actionable, true);
  assert.equal(answer.body.terminal, false);
  assert.equal(answer.body.taskId, 'task-1');
  assert.equal(typeof answer.body.instruction, 'string');
  assert.ok(answer.body.task !== undefined, 'the compact task is at the top level');
  assert.equal(answer.body.followUpWait, undefined, 'no nested follow-up block');
  // The whole redacted operation, with the facts a decision needs.
  assert.equal(answer.body.permission.requestId, 'permission-task-1-9');
  assert.equal(answer.body.permission.completeness, 'complete');
  assert.equal(answer.body.permissionDecidable, true);
  // The receipt, alongside it.
  assert.equal(answer.body.decisionReceipt.taskId, 'task-1');
  assert.equal(answer.body.decisionReceipt.requestId, 'permission-task-1-1');
  assert.equal(answer.body.decisionReceipt.decision, 'reject');
  assert.equal(answer.body.decisionReceipt.applied, true);
  assert.equal(answer.body.decisionReceipt.confirmation, 'applied');
  // And no evidence: the wait shape never carries the diff or the execution prose.
  const text = JSON.stringify(answer.body);
  assert.equal(text.includes('diff --git'), false);
  assert.equal(text.includes('the whole execution prose'), false);
});

test('an oversized live operation is still kept, marked unapprovable, and the receipt survives', async () => {
  // A 40,000-character operation cannot be published whole inside the tool-text bound. What
  // must survive is the LIVE REQUEST (so it can be rejected) and the RECEIPT (so the
  // decision is not lost) — and the shortened operation must never read as decidable.
  const oversized = pending({
    requestId: 'permission-task-1-big',
    arguments: JSON.stringify({ body: 'x'.repeat(40_000) }),
  });
  const { server } = decisionFixture({
    permission: (body) => decisionAnswer(body, [oversized]),
    observe: () => observation('permission', { permission: oversized }),
  });
  const answer = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'reject', waitAfterDecision: true,
  });
  assert.equal(answer.isError, false);
  assert.ok(answer.text.length <= 20_000, 'the answer respects the tool-text bound');
  assert.equal(answer.body.decisionReceipt.applied, true, 'the receipt survives the bound');
  assert.equal(answer.body.decisionReceipt.confirmation, 'applied');
  assert.equal(answer.body.decisionReceipt.requestId, 'permission-task-1-1');
  assert.equal(answer.body.decisionReceipt.fingerprint, `sha256:${'a'.repeat(64)}`);
  const published = answer.body.permission;
  assert.ok(published !== null && published !== undefined, 'the live request is never dropped');
  assert.equal(published.requestId, 'permission-task-1-big');
  assert.equal(published.argumentsComplete, false, 'a shortened operation is not complete');
  assert.notEqual(published.completeness, 'complete',
    'and it is never advertised as decidable');
  assert.equal(answer.body.permissionDecidable, false);
  assert.equal(answer.body.reason, 'permission');
  // Rejecting it is still possible, which is exactly why the request is kept.
  assert.match(answer.body.instruction, /reject/u);
});

test('a huge grant cannot push the receipt out of an oversized answer', async () => {
  // The exact shape the independent probe reproduces: the settled record carries a
  // 600-key grant that makes the natural answer far larger than the tool-text bound.
  const hugeGrant = Object.fromEntries(Array.from({ length: 600 }, (_, index) => [`audit${index}`, 'x'.repeat(800)]));
  const settled = pending({ requestId: 'permission-task-1-1' });
  const { server } = decisionFixture({
    permission: () => ({
      ok: true,
      task: summary({ taskId: 'task-1', state: 'running' }),
      permission: {
        ...settled,
        state: 'decided',
        decision: null,
        outcome: 'allowed-once',
        verified: { fingerprintQuoted: true, argumentsComplete: true, callReread: true, turnOpen: true },
        grant: hugeGrant,
      },
    }),
    observe: () => observation('permission', {
      permission: pending({
        requestId: 'permission-task-1-2',
        arguments: JSON.stringify({ command: 'Get-Content result.log' }),
      }),
    }),
  });
  const answer = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'allow-once',
    fingerprint: `sha256:${'a'.repeat(64)}`, waitAfterDecision: true,
  });
  assert.equal(answer.isError, false);
  assert.ok(answer.text.length <= 20_000, 'the rescue still respects the tool-text bound');
  // The receipt survives, minimally, with the facts that cannot be recovered elsewhere.
  const receipt = answer.body.decisionReceipt;
  assert.ok(receipt !== null && receipt !== undefined, 'the receipt is never rescued away');
  assert.equal(receipt.applied, true);
  assert.equal(receipt.confirmation, 'applied');
  assert.equal(receipt.taskId, 'task-1');
  assert.equal(receipt.requestId, 'permission-task-1-1');
  assert.equal(receipt.fingerprint, `sha256:${'a'.repeat(64)}`);
  assert.equal(receipt.evidenceOmitted, true, 'the bulky evidence is stated as omitted, not silently dropped');
  assert.equal(receipt.grant, undefined, 'an unbounded backend object is never copied into the answer');
  // Dropping bulky receipt evidence leaves the complete NEW operation decidable.
  assert.equal(answer.body.permission.requestId, 'permission-task-1-2');
  assert.equal(answer.body.permission.argumentsComplete, true);
  assert.equal(answer.body.permissionDecidable, true);
});

test('three consecutive requests: three decisions continue inside the same calls', async () => {
  const requests = sequenceRequests();
  const timeline = [
    // Call 1: the request just decided is still in its slot, then heartbeat, then request 2.
    'settled-1', 'settled-1', 'heartbeat', 'pending-2',
    // Call 2: request 2 settled, then request 3 (a NEW id, so it is answered).
    'settled-2', 'pending-3',
    // Call 3: request 3 settled, then the run finishes.
    'settled-3', 'ready',
  ];
  let cursor = 0;
  const { server, calls } = decisionFixture({
    permission: (body) => decisionAnswer(body, requests),
    observe: () => {
      const step = timeline[cursor];
      cursor += 1;
      if (step === 'ready') {
        return observation('ready', { task: summary({ state: 'awaiting-host-review', phase: 'review' }) });
      }
      if (step === 'heartbeat') return observation('heartbeat');
      const index = Number(step.at(-1)) - 1;
      return observation('permission', { permission: requests[index] });
    },
  });

  const answers = [];
  for (const request of requests) {
    const answer = await call(server, 'delegate_permission_decide', {
      taskId: 'task-1', requestId: request.requestId, decision: 'allow-once',
      fingerprint: request.fingerprint, waitAfterDecision: true,
    });
    assert.equal(answer.isError, false, `deciding ${request.requestId} must succeed`);
    answers.push(answer.body);
  }

  // Each call carries its own receipt naming exactly the request it decided.
  answers.forEach((body, index) => {
    assert.equal(body.decisionReceipt.applied, true);
    assert.equal(body.decisionReceipt.requestId, requests[index].requestId);
    assert.equal(body.decisionReceipt.fingerprint, requests[index].fingerprint);
    assert.equal(body.decisionReceipt.decision, 'allow-once');
  });
  // The first two continue into the NEXT request without a separate wait call.
  assert.equal(answers[0].reason, 'permission');
  assert.equal(answers[0].permission.requestId, 'permission-task-1-2');
  assert.equal(answers[0].metrics.settledRequestObservations, 2,
    'the settled request is stated as skipped, not re-asked');
  assert.equal(answers[1].reason, 'permission');
  assert.equal(answers[1].permission.requestId, 'permission-task-1-3');
  // The third continues into the completion.
  assert.equal(answers[2].reason, 'ready');
  assert.equal(answers[2].terminal, true);
  assert.equal(answers[2].permission, undefined);
  // Every observation belonged to one of the three decision calls.
  assert.equal(calls.filter((entry) => entry.route === 'permission').length, 3);
  assert.equal(calls.filter((entry) => entry.route === 'observe').length, 8);
  assert.equal(cursor, 8, 'the whole scripted timeline was consumed inside the three calls');
});

test('a NEW request id or a changed operation is never inherited from the previous allow', () => {
  const receipt = { requestId: 'permission-task-1-1', fingerprint: `sha256:${'1'.repeat(64)}` };
  const match = decidedRequestMatcher(receipt);
  const same = observation('permission', {
    permission: pending({ requestId: 'permission-task-1-1', fingerprint: `sha256:${'1'.repeat(64)}` }),
  });
  assert.equal(match(same), true, 'the settled request in its slot is not a new question');
  assert.equal(match(observation('permission', {
    permission: pending({ requestId: 'permission-task-1-2', fingerprint: `sha256:${'1'.repeat(64)}` }),
  })), false, 'a new request id is a new question');
  assert.equal(match(observation('permission', {
    permission: pending({ requestId: 'permission-task-1-1', fingerprint: `sha256:${'9'.repeat(64)}` }),
  })), false, 'the same id with a changed operation is NOT inherited');
  assert.equal(match(observation('ready')), false, 'a non-permission answer is never skipped');
  // Without a provable identity nothing is skipped: the engine's own refusal is the guard.
  assert.equal(decidedRequestMatcher({ requestId: 'permission-task-1-1', fingerprint: null })(same), false);
  assert.equal(decidedRequestMatcher({ requestId: null, fingerprint: 'x' })(same), false);
});

// ---------------------------------------------------------------------------
// 4. Decision failures and the honest receipt
// ---------------------------------------------------------------------------

test('every harness refusal is unchanged and never starts a wait', async () => {
  const cases = [
    ['PERMISSION_REQUEST_EXPIRED', 'the permission request expired before this decision'],
    ['PERMISSION_REQUEST_CHANGED', 'the pending operation does not match the fingerprint supplied'],
    ['PERMISSION_EVIDENCE_INCOMPLETE', 'the operation was shortened by a bound'],
    ['PERMISSION_REQUEST_NOT_PENDING', 'this permission request is already settled'],
    ['PERMISSION_REQUEST_NOT_FOUND', 'no pending permission request matches this identity'],
    ['JOB_TASK_NOT_FOUND', 'no such task for this connection'],
    ['DELEGATION_DISABLED', 'delegation is disabled in DSH settings'],
  ];
  for (const [code, message] of cases) {
    const { server, calls } = decisionFixture({
      permission: () => {
        const error = new Error(message);
        error.code = code;
        throw error;
      },
    });
    const answer = await call(server, 'delegate_permission_decide', {
      taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'allow-once',
      fingerprint: `sha256:${'a'.repeat(64)}`, waitAfterDecision: true,
    });
    assert.equal(answer.isError, true, `${code} must be a refusal`);
    assert.equal(answer.body.error.code, code);
    assert.equal(answer.body.decisionReceipt, undefined, 'a refused decision is never dressed as a receipt');
    assert.deepEqual(calls.map((entry) => entry.route), ['permission'],
      `${code}: a refused decision must not issue an observation`);
  }
});

test('a refusal produced by the harness is counted as refused, never as applied', async () => {
  const { server } = decisionFixture({
    permission: () => {
      const error = new Error('the pending operation does not match the fingerprint supplied');
      error.code = 'PERMISSION_REQUEST_CHANGED';
      throw error;
    },
  });
  await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'allow-once',
    fingerprint: `sha256:${'0'.repeat(64)}`, waitAfterDecision: true,
  });
  const census = server.metrics();
  assert.equal(census.decisions.count, 1, 'the attempt is counted');
  assert.equal(census.decisions.applied, 0);
  assert.equal(census.decisions.refused, 1);
  assert.equal(census.waits.count, 0, 'and no wait happened');
});

test('a call that failed BEFORE an answer is confirmation "unknown", with its identity', async () => {
  const { server, calls } = decisionFixture({
    permission: () => {
      const error = new Error('the DSH delegation endpoint could not be reached (TypeError)');
      error.code = 'MCP_HARNESS_UNREACHABLE';
      throw error;
    },
  });
  const answer = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'allow-once',
    fingerprint: `sha256:${'a'.repeat(64)}`, waitAfterDecision: true,
  });
  assert.equal(answer.isError, true, 'an unconfirmed decision is not reported as success');
  assert.equal(answer.body.error.code, 'MCP_HARNESS_UNREACHABLE');
  assert.match(answer.body.error.message, /unknown whether it was applied/u,
    'the caller is told the outcome is unknown, not that it failed');
  assert.match(answer.body.error.message, /delegate_result/u, 'and told how to find out');
  assert.match(answer.body.error.message, /sending it again/u);
  // The refusal CARRIES the structured receipt: message text alone is not enough to query a
  // task by name, and a coordinator must never have to guess which request it tried.
  const receipt = answer.body.error.details.decisionReceipt;
  assert.equal(receipt.applied, null, 'unknown is never a fabricated false');
  assert.equal(receipt.confirmation, 'unknown');
  assert.equal(receipt.taskId, 'task-1');
  assert.equal(receipt.requestId, 'permission-task-1-1');
  assert.equal(receipt.fingerprint, `sha256:${'a'.repeat(64)}`);
  assert.equal(receipt.decision, 'allow-once');
  assert.match(receipt.reason, /unknown/u);
  assert.deepEqual(calls.map((entry) => entry.route), ['permission'], 'nothing is retried automatically');
  const census = server.metrics();
  assert.equal(census.decisions.unknown, 1, 'the census states it as unknown');
  assert.equal(census.decisions.applied, 0);
});

test('without the flag an unconfirmed decision keeps the historical refusal exactly', async () => {
  const { server } = decisionFixture({
    permission: () => {
      const error = new Error('the DSH delegation endpoint could not be reached (TypeError)');
      error.code = 'MCP_HARNESS_UNREACHABLE';
      throw error;
    },
  });
  const plain = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'allow-once',
    fingerprint: `sha256:${'a'.repeat(64)}`,
  });
  assert.equal(plain.isError, true);
  assert.equal(plain.body.error.code, 'MCP_HARNESS_UNREACHABLE');
  assert.equal(plain.body.error.details, undefined, 'the historical refusal shape has no added details');
  assert.equal(plain.body.decisionReceipt, undefined);
  assert.doesNotMatch(plain.body.error.message, /unknown whether it was applied/u,
    'the historical message is not rewritten without the flag');
});

test('a meta-refusal (ok:true with no usable settlement) is unknown and STOPS instead of waiting', async () => {
  const { server, calls } = decisionFixture({
    // A 200 that carries `{ ok: true }` but no settled record: nothing is proven.
    permission: () => ({ ok: true }),
  });
  const answer = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'allow-once',
    fingerprint: `sha256:${'a'.repeat(64)}`, waitAfterDecision: true,
  });
  assert.equal(answer.isError, true);
  assert.equal(answer.body.error.code, 'MCP_DECISION_UNCONFIRMED');
  const receipt = answer.body.error.details.decisionReceipt;
  assert.equal(receipt.applied, null);
  assert.equal(receipt.confirmation, 'unknown');
  assert.equal(receipt.taskId, 'task-1');
  assert.equal(receipt.requestId, 'permission-task-1-1');
  assert.deepEqual(calls.map((entry) => entry.route), ['permission'],
    'an unconfirmed decision never continues into a wait');
});

test('a CONTRADICTED decision is unknown and stops: no wait, no substituted fingerprint', async () => {
  const { server, calls } = decisionFixture({
    // The harness reports a DIFFERENT operation settled than the one quoted.
    permission: (body) => decisionAnswer(body, [pending({ fingerprint: `sha256:${'b'.repeat(64)}` })]),
  });
  const answer = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'allow-once',
    fingerprint: `sha256:${'a'.repeat(64)}`, waitAfterDecision: true,
  });
  assert.equal(answer.isError, true);
  assert.equal(answer.body.error.code, 'MCP_DECISION_UNCONFIRMED');
  const receipt = answer.body.error.details.decisionReceipt;
  assert.equal(receipt.applied, null);
  assert.equal(receipt.fingerprint, `sha256:${'a'.repeat(64)}`,
    'the quoted operation is never replaced by the conflicting backend value');
  assert.deepEqual(calls.map((entry) => entry.route), ['permission']);
});

test('a receipt is applied ONLY on matching evidence, and every mismatch or gap is unknown', () => {
  const taskId = 'task-1';
  const requestId = 'permission-task-1-1';
  const fingerprint = `sha256:${'1'.repeat(64)}`;
  const verified = { fingerprintQuoted: true, argumentsComplete: true, callReread: true, turnOpen: true };
  /** The real success shape, with `decision: null` exactly as the live bridge reports it. */
  const appliedAnswer = (overrides = {}) => ({
    ok: true,
    task: { taskId },
    permission: {
      taskId, requestId, fingerprint, state: 'decided', decision: null, outcome: 'allowed-once', verified,
      ...overrides,
    },
  });
  const base = { taskId, requestId, decision: 'allow-once', fingerprint };

  // 1. A matching allow is applied, and `decision: null` is not required to be filled.
  const applied = decisionReceipt({ ...base, answer: appliedAnswer() });
  assert.equal(applied.applied, true);
  assert.equal(applied.confirmation, 'applied');
  assert.equal(applied.outcome, 'allowed-once');
  assert.equal(applied.fingerprint, fingerprint);
  assert.deepEqual(applied.verified, verified);

  // 2. A CONFLICTING backend fingerprint is NOT a correction: it contradicts the operation
  //    this decision quoted, so nothing is confirmed and the quoted value is never replaced.
  const conflicting = decisionReceipt({
    ...base,
    answer: appliedAnswer({ fingerprint: `sha256:${'2'.repeat(64)}` }),
  });
  assert.equal(conflicting.applied, null, 'a conflicting operation is never confirmed');
  assert.equal(conflicting.confirmation, 'unknown');
  assert.equal(conflicting.fingerprint, fingerprint, 'the quoted fingerprint is never silently replaced');
  assert.match(conflicting.reason, /DIFFERENT operation/u);

  // 3. A different request id contradicts the decision just as plainly.
  const otherRequest = decisionReceipt({ ...base, answer: appliedAnswer({ requestId: 'permission-other' }) });
  assert.equal(otherRequest.applied, null);
  assert.equal(otherRequest.requestId, requestId, 'the receipt keeps the identity that was decided');

  // 4. A different TASK is a contradiction too. The task id lives on BOTH the answer's task
  //    and the settled record; overriding only `taskId` would be swallowed by the spread, so
  //    the override is applied to the settled record after it is built.
  const otherTask = decisionReceipt({
    ...base,
    answer: {
      ok: true,
      task: { taskId: 'task-other' },
      permission: { ...appliedAnswer().permission, taskId: 'task-other' },
    },
  });
  assert.equal(otherTask.applied, null);
  assert.match(otherTask.reason, /DIFFERENT task/u);

  // 5. `ok: false` proves nothing at all.
  assert.equal(decisionReceipt({ ...base, answer: { ok: false } }).applied, null);
  // 6. A bare `ok: true` with no settled record proves nothing either.
  assert.equal(decisionReceipt({ ...base, answer: { ok: true } }).applied, null);
  // 7. A still-pending record is not a settled decision.
  assert.equal(decisionReceipt({ ...base, answer: appliedAnswer({ state: 'pending' }) }).applied, null);
  // 8. The OUTCOME must be the one this decision asked for: an allow confirmed by a
  //    `rejected` outcome is not this decision's confirmation.
  const wrongOutcome = decisionReceipt({ ...base, answer: appliedAnswer({ outcome: 'rejected' }) });
  assert.equal(wrongOutcome.applied, null);
  assert.match(wrongOutcome.reason, /asked for/u);
  // 9. An allow without its verification evidence is not confirmable.
  assert.equal(decisionReceipt({ ...base, answer: appliedAnswer({ verified: undefined }) }).applied, null);
  // 10. A reject needs NO verification and is confirmed by its own outcome.
  const rejected = decisionReceipt({
    taskId, requestId, decision: 'reject', fingerprint: null,
    answer: appliedAnswer({ outcome: 'rejected', verified: undefined }),
  });
  assert.equal(rejected.applied, true);
  assert.equal(rejected.outcome, 'rejected');

  // 11. A failure before an answer is unknown and keeps the caller's identity.
  const unknown = decisionReceipt({ ...base, decision: 'reject', fingerprint: null, error: { code: 'MCP_REQUEST_CANCELLED' } });
  assert.equal(unknown.applied, null, 'neither true nor false: it is unknown');
  assert.equal(unknown.confirmation, 'unknown');
  assert.equal(unknown.taskId, taskId, 'the task identity is kept');
  assert.equal(unknown.requestId, requestId, 'and so is the request identity');
  assert.equal(unknown.fingerprint, null, 'a fingerprint nobody supplied is not invented');
  // 12. A refusal the harness itself produced IS a definite "not applied".
  const refused = decisionReceipt({ ...base, error: { code: 'PERMISSION_REQUEST_CHANGED' }, refusedByHarness: true });
  assert.equal(refused.applied, false);
  assert.equal(refused.confirmation, 'refused');
});

// ---------------------------------------------------------------------------
// 4b. The four boundaries that are NOT sufficient confirmation
// ---------------------------------------------------------------------------
//
// Each of these once read as `applied: true` even though nothing sufficient had been
// established. They are pinned one per test so a regression names the exact boundary that
// broke, not just "the receipt is wrong".

/** A settled allow record in the real shape, with overrides applied AFTER the spread. */
function settledAllow(overrides = {}, outer = {}) {
  const taskId = 'task-1';
  return {
    ok: true,
    task: { taskId: outer.taskId ?? taskId },
    permission: {
      taskId: overrides.taskId ?? taskId,
      requestId: 'permission-task-1-1',
      fingerprint: `sha256:${'a'.repeat(64)}`,
      state: 'decided',
      decision: null,
      outcome: 'allowed-once',
      verified: { fingerprintQuoted: true, argumentsComplete: true, callReread: true, turnOpen: true },
      ...overrides,
    },
  };
}

/** The decision arguments those records answer. */
const quotedBase = {
  taskId: 'task-1',
  requestId: 'permission-task-1-1',
  decision: 'allow-once',
  fingerprint: `sha256:${'a'.repeat(64)}`,
};

test('boundary: a quoted fingerprint is NOT confirmed by an answer that omits it', () => {
  const answer = settledAllow();
  // The record reports no operation at all, so nothing ties it to the quoted operation.
  delete answer.permission.fingerprint;
  const receipt = decisionReceipt({ ...quotedBase, answer });
  assert.equal(receipt.applied, null, 'an omitted fingerprint cannot confirm a quoted one');
  assert.equal(receipt.confirmation, 'unknown');
  assert.equal(receipt.fingerprint, quotedBase.fingerprint, 'the quoted operation is kept as the identity');
  assert.match(receipt.reason, /without reporting the operation fingerprint/u);
  // `null` and an empty string are omissions too, not a match.
  for (const omitted of [null, '']) {
    const withBlank = decisionReceipt({ ...quotedBase, answer: settledAllow({ fingerprint: omitted }) });
    assert.equal(withBlank.applied, null, `fingerprint ${JSON.stringify(omitted)} is not evidence`);
  }
});

test('boundary: two disagreeing taskIds on one answer are a contradiction, not a match', () => {
  // The surrounding task matches the request, but the settled record names another task.
  const receipt = decisionReceipt({ ...quotedBase, answer: settledAllow({ taskId: 'task-other' }) });
  assert.equal(receipt.applied, null, 'a matching outer task cannot vouch for a different settled task');
  assert.equal(receipt.confirmation, 'unknown');
  assert.equal(receipt.taskId, quotedBase.taskId, 'the identity is the one that was decided');
  assert.match(receipt.reason, /contradicted itself/u);
  assert.equal(receipt.evidence.surroundingTaskId, 'task-1');
  assert.equal(receipt.evidence.answeredTaskId, 'task-other');
});

test('boundary: an allowed-once whose own verification is false is NOT confirmed', () => {
  const receipt = decisionReceipt({
    ...quotedBase,
    answer: settledAllow({
      verified: {
        fingerprintQuoted: false, argumentsComplete: false, callReread: false, turnOpen: false,
      },
    }),
  });
  assert.equal(receipt.applied, null, 'unverified checks are not evidence for an allow');
  assert.equal(receipt.confirmation, 'unknown');
  assert.deepEqual(receipt.evidence.unverified,
    ['fingerprintQuoted', 'argumentsComplete', 'callReread', 'turnOpen'],
    'every failing check is named');
  // A single failing required check is enough to refuse confirmation.
  const partial = decisionReceipt({
    ...quotedBase,
    answer: settledAllow({ verified: { fingerprintQuoted: true, argumentsComplete: true, callReread: false, turnOpen: true } }),
  });
  assert.equal(partial.applied, null);
  assert.deepEqual(partial.evidence.unverified, ['callReread']);
});

test('boundary: state "expired" with an allowed-once outcome is NOT a confirmed decision', () => {
  const receipt = decisionReceipt({ ...quotedBase, answer: settledAllow({ state: 'expired' }) });
  assert.equal(receipt.applied, null, 'only a `decided` request can confirm a decision');
  assert.equal(receipt.confirmation, 'unknown');
  assert.match(receipt.reason, /not a decided request/u);
  // The other settled-but-not-decided states are refused the same way.
  for (const state of ['cancelled', 'unavailable']) {
    const other = decisionReceipt({ ...quotedBase, answer: settledAllow({ state }) });
    assert.equal(other.applied, null, `state ${state} is not a decision`);
  }
});

test('the normal shapes still confirm: decision:null, and a reject that quoted no fingerprint', () => {
  // The real bridge leaves `decision` null; that is NOT a reason to withhold confirmation.
  const normal = decisionReceipt({ ...quotedBase, answer: settledAllow({ decision: null }) });
  assert.equal(normal.applied, true);
  assert.equal(normal.confirmation, 'applied');
  assert.equal(normal.outcome, 'allowed-once');

  // A reject that quoted no fingerprint is not forced to produce one, and needs no
  // allow-only verification evidence.
  const rejected = decisionReceipt({
    taskId: 'task-1',
    requestId: 'permission-task-1-1',
    decision: 'reject',
    fingerprint: null,
    answer: settledAllow({ outcome: 'rejected', verified: undefined }),
  });
  assert.equal(rejected.applied, true);
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(rejected.fingerprint, `sha256:${'a'.repeat(64)}`,
    'the receipt reports the harness record of what was settled, not an invented quotation');
  assert.equal(rejected.verified, undefined, 'a reject carries no allow verification');

  // A reject that DID quote a fingerprint still needs that operation matched.
  const rejectedQuoted = decisionReceipt({
    ...quotedBase,
    decision: 'reject',
    answer: settledAllow({ outcome: 'rejected' }),
  });
  assert.equal(rejectedQuoted.applied, true);
});

test('a rejected fingerprint is refused as it always was, even with the flag set', async () => {
  const seen = [];
  const { server, calls } = decisionFixture({
    permission: async (body) => {
      seen.push(body);
      if (body.fingerprint !== `sha256:${'a'.repeat(64)}`) {
        const error = new Error('the pending operation does not match the fingerprint supplied');
        error.code = 'PERMISSION_REQUEST_CHANGED';
        throw error;
      }
      return decisionAnswer(body);
    },
  });
  const answer = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'allow-once',
    fingerprint: `sha256:${'0'.repeat(64)}`, waitAfterDecision: true,
  });
  assert.equal(answer.body.error.code, 'PERMISSION_REQUEST_CHANGED');
  assert.deepEqual(seen.map((body) => body.fingerprint), [`sha256:${'0'.repeat(64)}`],
    'the caller\'s fingerprint reaches the harness, which is the only thing that validates it');
  assert.deepEqual(calls.map((entry) => entry.route), ['permission']);
});

test('an incomplete operation is never decidable, and reject still decides and continues', async () => {
  const truncated = pending({
    completeness: 'truncated',
    argumentsComplete: false,
    allowBlocked: 'the operation was shortened by a bound',
    boundsApplied: ['value'],
  });
  // The harness applies a `reject` and refuses an `allow-once` on the same request.
  const { server, calls } = decisionFixture({
    permission: async (body) => {
      if (body.decision === 'allow-once') {
        const error = new Error('the operation was shortened by a bound, so it cannot be allowed');
        error.code = 'PERMISSION_EVIDENCE_INCOMPLETE';
        throw error;
      }
      return decisionAnswer(body, [truncated]);
    },
    observe: () => observation('permission', { permission: truncated }),
  });
  const refused = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: truncated.requestId, decision: 'allow-once',
    fingerprint: truncated.fingerprint, waitAfterDecision: true,
  });
  assert.equal(refused.body.error.code, 'PERMISSION_EVIDENCE_INCOMPLETE');
  assert.deepEqual(calls.map((entry) => entry.route), ['permission'], 'an unapprovable operation is not waited on');

  // `reject` stays available on the same request, and it continues normally. The settled
  // record keeps the operation exactly as it was (still `truncated`), so the reject is
  // confirmed by its own outcome and needs no allow-only verification evidence.
  const rejected = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: truncated.requestId, decision: 'reject', waitAfterDecision: true,
  });
  assert.equal(rejected.isError, false);
  assert.equal(rejected.body.decisionReceipt.applied, true);
  assert.equal(rejected.body.decisionReceipt.outcome, 'rejected');
  assert.equal(rejected.body.decisionReceipt.verified, undefined, 'a reject carries no allow verification');
  // The rollover skipped the request it just decided (same id, same fingerprint) and kept
  // waiting until its own deadline; the skipped count is what proves it was not re-asked.
  assert.ok(rejected.body.metrics.observationRequests > 0);
  // Whatever comes next, a shortened operation is never published as decidable.
  const waited = await call(server, 'delegate_wait', { taskId: 'task-1', waitSeconds: 1 });
  assert.equal(waited.body.reason, 'permission');
  assert.equal(waited.body.permission.completeness, 'truncated');
  assert.equal(waited.body.permissionDecidable, false);
});

// ---------------------------------------------------------------------------
// 5. The wait may end; the decision may not
// ---------------------------------------------------------------------------

test('an APPLIED decision whose following wait fails keeps its receipt and says only the wait failed', async () => {
  const { server } = decisionFixture({
    permission: (body) => decisionAnswer(body),
    observe: () => {
      const error = new Error('the DSH delegation endpoint could not be reached');
      error.code = 'MCP_HARNESS_UNREACHABLE';
      return error;
    },
  });
  const answer = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'allow-once',
    fingerprint: `sha256:${'a'.repeat(64)}`, waitAfterDecision: true,
  });
  // The decision was applied, so the call is NOT a failure: turning this into a bare error
  // is exactly how a coordinator loses track of an authorization that IS in force.
  assert.equal(answer.isError, false);
  assert.equal(answer.body.ok, true);
  assert.equal(answer.body.decisionReceipt.applied, true, 'the receipt survives the wait failure');
  assert.equal(answer.body.decisionReceipt.confirmation, 'applied');
  assert.equal(answer.body.decisionReceipt.taskId, 'task-1');
  assert.equal(answer.body.decisionReceipt.requestId, 'permission-task-1-1');
  // The wait is reported as a WAIT failure, not as a task state and not as a decision failure.
  assert.equal(answer.body.reason, null, 'no task state was observed, so none is claimed');
  assert.equal(answer.body.actionable, false);
  assert.equal(answer.body.terminal, false);
  assert.equal(answer.body.waitError.code, 'MCP_HARNESS_UNREACHABLE');
  assert.equal(answer.body.waitError.phase, 'follow-up-wait');
  assert.match(answer.body.instruction, /do not resend it/u);
  assert.match(answer.body.instruction, /delegate_wait/u);
  // The census still knows the decision was applied and the wait was refused.
  const census = server.metrics();
  assert.equal(census.decisions.applied, 1, 'the decision stands');
  assert.equal(census.waits.count, 1);
  assert.equal(census.waits.reasons.refused, 1);
  assert.equal(census.correlation.recentWaits[0].afterDecisionId, census.correlation.recentDecisions[0].receiptId,
    'the refused wait is still tied to the decision that led into it');
});

test('a following wait cancelled by the host does not unsay the decision', async () => {
  const controller = new AbortController();
  const { server } = decisionFixture({
    permission: (body) => decisionAnswer(body),
    observe: async () => {
      controller.abort();
      const error = new Error('the request was cancelled by the host');
      error.code = 'MCP_REQUEST_CANCELLED';
      return error;
    },
  });
  const answer = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'reject', waitAfterDecision: true,
  }, { signal: controller.signal });
  // A cancellation releases the OBSERVATION. The decision stands, so its receipt is returned
  // and the failure is named as the wait's, not the decision's.
  assert.equal(answer.isError, false);
  assert.equal(answer.body.decisionReceipt.applied, true, 'the cancellation never unsays the decision');
  assert.equal(answer.body.decisionReceipt.confirmation, 'applied');
  assert.equal(answer.body.reason, null, 'no task state is invented after an interrupted wait');
  assert.equal(answer.body.waitError.code, 'MCP_REQUEST_CANCELLED');
  const census = server.metrics();
  assert.equal(census.decisions.applied, 1, 'the cancellation released the observation, never the decision');
  assert.equal(census.waits.reasons.refused, 1);
  assert.equal(census.waits.reasons.ready, undefined);
});

test('the continuing wait keeps the wait default, and a spent deadline is wait-limit on the same task', async () => {
  const clock = fakeClock();
  // An engine that answers instantly and never changes: the loop paces itself at one
  // observation per second, exactly as a plain wait does.
  const { server } = decisionFixture({
    permission: (body) => decisionAnswer(body),
    observe: () => observation('heartbeat'),
  }, { clock });
  const answer = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'reject', waitAfterDecision: true,
  });
  assert.equal(answer.body.reason, WAIT_LIMIT_REASON);
  assert.equal(answer.body.actionable, false, 'a spent budget is not a business event');
  assert.equal(answer.body.terminal, false);
  assert.equal(answer.body.taskId, 'task-1');
  assert.equal(answer.body.decisionReceipt.applied, true, 'the receipt survives the deadline');
  // The same default a plain wait has: one hour, not a business-specific short timeout.
  assert.equal(answer.body.metrics.deadlineMs, DEFAULT_WAIT_SECONDS * 1_000);
  assert.equal(DEFAULT_WAIT_SECONDS, 3_600);
  assert.equal(OBSERVE_WAIT_MS, MAX_OBSERVE_WAIT_MS, 'one observation uses the plane\'s own ceiling');
  assert.ok(answer.body.metrics.observationRequests > 3_500,
    `an hour of instant heartbeats is paced at one per second, saw ${answer.body.metrics.observationRequests}`);
  assert.match(answer.body.instruction, /again/iu);
});

test('twenty minutes of continuous activity is ~48 observations and ONE answer, in the continuing call', async () => {
  const clock = fakeClock();
  const OBSERVATIONS = 48;
  let issued = 0;
  const { server } = decisionFixture({
    permission: (body) => decisionAnswer(body),
    observe: () => {
      issued += 1;
      // Every observation, the last included, spends its whole bound inside the engine.
      clock.advance(OBSERVE_WAIT_MS);
      const wait = { waitMs: OBSERVE_WAIT_MS, waitedMs: OBSERVE_WAIT_MS, activitySinceWait: issued === OBSERVATIONS };
      if (issued < OBSERVATIONS) return observation('heartbeat', { wait });
      return observation('ready', {
        task: summary({ state: 'awaiting-host-review', phase: 'review' }), wait,
      });
    },
  }, { clock });
  const answer = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'reject', waitAfterDecision: true,
  });
  assert.equal(answer.body.reason, 'ready');
  assert.equal(answer.body.metrics.observationRequests, OBSERVATIONS, 'twenty minutes is 48 bounded observations');
  assert.equal(answer.body.metrics.heartbeatsConsumed, OBSERVATIONS - 1);
  assert.equal(answer.body.metrics.waitReturns, 1, 'the host receives exactly one answer');
  assert.equal(answer.body.metrics.elapsedMs, 1_200_000, 'and it really waited twenty minutes');
  assert.equal(answer.body.decisionReceipt.applied, true);
});

test('terminal answers win over attention', async () => {
  for (const [state, reason, terminal] of [
    ['awaiting-host-review', 'ready', true],
    ['failed', 'failed', true],
    ['cancelled', 'cancelled', true],
  ]) {
    const { server } = decisionFixture({
      permission: (body) => decisionAnswer(body),
      observe: () => observation(reason, { task: summary({ state, phase: reason, endedAt: 1_760_000_000_500 }) }),
    });
    const answer = await call(server, 'delegate_permission_decide', {
      taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'reject', waitAfterDecision: true,
    });
    assert.equal(answer.body.reason, reason);
    assert.equal(answer.body.state, state);
    assert.equal(answer.body.terminal, terminal);
    assert.equal(answer.body.actionable, true);
    assert.equal(answer.body.decisionReceipt.applied, true);
  }
});

// ---------------------------------------------------------------------------
// 6. Accounting: real final bytes, cumulative counts, honest host gaps
// ---------------------------------------------------------------------------

test('returned bytes are the FINAL tool text, measured once by the server', async () => {
  // A Chinese pending operation makes UTF-8 bytes exceed UTF-16 units, which is exactly the
  // mistake a `String#length` count would make. The continuing call must PUBLISH that
  // operation, so it answers with a NEW request (a different id), not the one just decided.
  const chinese = pending({
    requestId: 'permission-task-1-new',
    arguments: JSON.stringify({ command: '读取目录 C:\\外部数据' }),
  });
  const { server } = decisionFixture({
    permission: (body) => decisionAnswer(body),
    observe: () => observation('permission', { permission: chinese }),
  });
  const answer = await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'reject', waitAfterDecision: true,
  });
  assert.equal(answer.isError, false);
  assert.equal(answer.body.reason, 'permission');
  assert.ok(answer.text.includes('读取目录') || answer.text.includes('\\u8bfb\\u53d6'),
    `the fixture really carries the Chinese operation (saw ${answer.text.slice(0, 200)})`);
  const firstText = answer.text;
  const firstBytes = Buffer.byteLength(firstText, 'utf8');
  assert.ok(firstBytes > firstText.length,
    `UTF-8 bytes must exceed UTF-16 units for this text (saw ${firstBytes} vs ${firstText.length})`);

  const census = (await call(server, 'delegate_metrics', {})).body.metrics;
  // The census answer is the SECOND return. Its own final text is measured here
  // independently — by re-rendering the payload the server published — so the assertion is
  // against two real texts, never against the answer's own claim about itself.
  const censusBytes = Buffer.byteLength(JSON.stringify({ ok: true, metrics: census }, null, 2), 'utf8');
  assert.equal(census.returnedText.unit, 'utf8-bytes-of-serialized-tool-text');
  assert.equal(census.returnedText.count, 1,
    'the census is built before its own text exists, so it counts the decision answer only');
  assert.equal(census.returnedText.unmeasured, 0);
  assert.equal(census.returnedText.bytes, firstBytes,
    'the total equals the final tool text, measured with Buffer.byteLength');
  // The next read DOES include the previous census answer: the count is of real returns.
  const second = (await call(server, 'delegate_metrics', {})).body.metrics;
  const secondBytes = Buffer.byteLength(JSON.stringify({ ok: true, metrics: second }, null, 2), 'utf8');
  assert.equal(second.returnedText.count, 2);
  assert.equal(second.returnedText.bytes, firstBytes + censusBytes,
    'and the total is now exactly the sum of both final texts');
  // The answer does NOT carry its own size back into the body: a value about itself would
  // be self-referential and could never be exact.
  assert.equal(answer.body.responseBytes, undefined);
  assert.equal(answer.body.metrics.responseBytes, undefined);
});

test('wait correlation is recorded for a plain wait as well, in one flat shape', async () => {
  const clock = fakeClock();
  const server = createMcpServer({
    now: clock.now,
    sleep: clock.sleep,
    async callExecution(route) {
      if (route !== 'observe') return { ok: true };
      return { ok: true, ...observation('ready', { task: summary({ state: 'awaiting-host-review' }) }) };
    },
  });
  await call(server, 'delegate_wait', { taskId: 'task-1' });
  const census = server.metrics();
  assert.equal(census.waits.count, 1);
  assert.equal(census.waits.reasons.ready, 1);
  const [wait] = census.correlation.recentWaits;
  assert.equal(wait.afterDecisionId, null, 'a plain wait follows no decision');
  assert.equal(wait.taskId, 'task-1', 'but it still names its task');
  assert.equal(typeof wait.waitId, 'string');
  assert.equal(typeof wait.durationMs, 'number');
  assert.equal(wait.waitReturns, 1);
  assert.equal(census.correlation.waitsAfterDecisions, 0);
});

test('decision totals are cumulative: they do not shrink when the sample rotates', async () => {
  const metrics = createCallMetrics({ limit: 3, now: () => 1 });
  for (let index = 0; index < 70; index += 1) {
    metrics.recordDecision({
      receiptId: `d-${index}`,
      taskId: 't',
      requestId: `r-${index}`,
      decision: index % 2 === 0 ? 'allow-once' : 'reject',
      applied: true,
      confirmation: 'applied',
    });
  }
  metrics.recordDecision({ receiptId: 'd-bad', requestId: 'r-bad', decision: 'reject', applied: null, confirmation: 'unknown' });
  metrics.recordDecision({ receiptId: 'd-no', requestId: 'r-no', decision: 'allow-once', applied: false, confirmation: 'refused' });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.decisions.count, 72, 'every attempt is counted');
  assert.equal(snapshot.decisions.applied, 70, 'past the sample limit, all 70 applied decisions still count');
  assert.equal(snapshot.decisions.allowed, 35);
  assert.equal(snapshot.decisions.rejected, 35);
  assert.equal(snapshot.decisions.unknown, 1);
  assert.equal(snapshot.decisions.refused, 1);
  assert.equal(snapshot.correlation.recentDecisions.length, 3, 'only the SAMPLE is bounded');
  assert.deepEqual(snapshot.correlation.recentDecisions.map((entry) => entry.receiptId), ['d-69', 'd-bad', 'd-no'],
    'the sample keeps the newest three, whatever their outcome');
});

test('a decision sample keeps `applied` three-valued: applied/refused/unknown, never false for unknown', () => {
  // The sample's `applied` is the SAME fact the permission receipt publishes. Turning
  // `unknown` into `false` would contradict both the receipt (`applied: null`) and the
  // cumulative `decisions.unknown` counter, and would report a refusal nobody established.
  const metrics = createCallMetrics({ limit: 8, now: () => 7 });
  metrics.recordDecision({ receiptId: 'd-ok', taskId: 't', requestId: 'r-ok', decision: 'allow-once', applied: true, confirmation: 'applied' });
  metrics.recordDecision({ receiptId: 'd-no', taskId: 't', requestId: 'r-no', decision: 'allow-once', applied: false, confirmation: 'refused' });
  metrics.recordDecision({ receiptId: 'd-unk', taskId: 't', requestId: 'r-unk', decision: 'allow-once', applied: null, confirmation: 'unknown' });
  // The DERIVED path (no explicit `confirmation`) must agree with the explicit one.
  metrics.recordDecision({ receiptId: 'd-ok-2', requestId: 'r-ok-2', decision: 'reject', applied: true });
  metrics.recordDecision({ receiptId: 'd-no-2', requestId: 'r-no-2', decision: 'reject', applied: false });
  metrics.recordDecision({ receiptId: 'd-unk-2', requestId: 'r-unk-2', decision: 'reject', applied: null });
  const samples = new Map(metrics.snapshot().correlation.recentDecisions.map((entry) => [entry.receiptId, entry]));

  const expected = [
    ['d-ok', true, 'applied'],
    ['d-no', false, 'refused'],
    ['d-unk', null, 'unknown'],
    ['d-ok-2', true, 'applied'],
    ['d-no-2', false, 'refused'],
    ['d-unk-2', null, 'unknown'],
  ];
  for (const [receiptId, applied, state] of expected) {
    const sample = samples.get(receiptId);
    assert.ok(sample !== undefined, `${receiptId} must be in the sample`);
    assert.equal(sample.applied, applied, `${receiptId}.applied must be ${JSON.stringify(applied)}`);
    assert.equal(sample.state, state, `${receiptId}.state must be ${state}`);
  }
  // The unknown samples are `null` specifically, not merely falsy.
  for (const receiptId of ['d-unk', 'd-unk-2']) {
    assert.strictEqual(samples.get(receiptId).applied, null, `${receiptId} is null, not false`);
  }
  // And the sample agrees with the cumulative census it sits beside.
  const census = metrics.snapshot().decisions;
  assert.equal(census.count, 6);
  assert.equal(census.applied, 2);
  assert.equal(census.refused, 2);
  assert.equal(census.unknown, 2);
});

test('wait totals are cumulative and the sample stays bounded', async () => {
  const metrics = createCallMetrics({ limit: 2, now: () => 5 });
  for (let index = 0; index < 10; index += 1) {
    metrics.recordWait({
      waitId: `w-${index}`,
      afterDecisionId: index < 4 ? `d-${index}` : null,
      taskId: 't',
      reason: index % 2 === 0 ? 'ready' : 'permission',
      durationMs: 10,
      observationRequests: 2,
      waitReturns: 1,
    });
  }
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.waits.count, 10);
  assert.equal(snapshot.waits.totalMs, 100);
  assert.equal(snapshot.waits.observations, 20);
  assert.equal(snapshot.waits.reasons.ready, 5);
  assert.equal(snapshot.waits.reasons.permission, 5);
  assert.equal(snapshot.correlation.waitsAfterDecisions, 4);
  assert.equal(snapshot.correlation.waitQuestionsAnswered, 2, 'only permission returns count as questions');
  assert.equal(snapshot.correlation.recentWaits.length, 2);
  // A malformed summary degrades one counter instead of throwing into an answer path.
  metrics.recordWait({ reason: 'not-a-reason', durationMs: 'nope' });
  const after = metrics.snapshot();
  assert.equal(after.waits.reasons.refused, 1);
  assert.equal(after.waits.totalMs, 100, 'an unparseable duration adds nothing');
  assert.match(metrics.diagnosticsLine(), /hostModelResponses=not-integrated/u);
});

test('an unmeasured return is stated, never counted as zero bytes', () => {
  const metrics = createCallMetrics({ now: () => 1 });
  metrics.recordReturn('hello');
  metrics.recordReturn(null);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.returnedText.count, 2);
  assert.equal(snapshot.returnedText.bytes, 5, 'only the measured text contributed');
  assert.equal(snapshot.returnedText.unmeasured, 1, 'the missing text is stated');
});

test('the census never claims to know the host model, and never invents wake-ups', async () => {
  const { server } = decisionFixture({ permission: (body) => decisionAnswer(body) });
  await call(server, 'delegate_permission_decide', {
    taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'reject',
  });
  const census = (await call(server, 'delegate_metrics', {})).body.metrics;
  assert.equal(census.hostObservability.hostModelResponses, NOT_INTEGRATED);
  assert.equal(census.hostObservability.hostTokenUsage, NOT_INTEGRATED);
  assert.equal(census.hostObservability.hostCost, NOT_INTEGRATED);
  assert.match(census.definitions.waitReturns, /NOT a model wake-up/u);
  assert.equal(/"(wakeups|gptWakes|wakeCount)"/u.test(JSON.stringify(census)), false);
  // The census itself is a read-only tool with no plane route and no arguments.
  const tool = TOOLS.find((entry) => entry.name === 'delegate_metrics');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), []);
});

test('a malformed argument call is not counted: the program never saw it', async () => {
  const server = createMcpServer({ async callExecution() { return { ok: true }; } });
  const bad = await call(server, 'delegate_status', { surprise: true });
  assert.equal(bad.body.error.code, 'MCP_ARGUMENT_UNKNOWN');
  const census = server.metrics();
  assert.equal(census.tools.delegate_status, undefined, 'a refused argument reached no tool');
  assert.equal(census.returnedText.count, 0);
});

// ---------------------------------------------------------------------------
// 7. Concurrency: the continuing wait does not block the session
// ---------------------------------------------------------------------------

test('a continuing decision does not block a status read, a cancel or another decision', async () => {
  let releaseWait;
  const gate = new Promise((resolvePromise) => { releaseWait = resolvePromise; });
  const clock = fakeClock();
  const server = createMcpServer({
    now: clock.now,
    sleep: clock.sleep,
    async callExecution(route, payload) {
      if (route === 'permission') return decisionAnswer(payload);
      if (route === 'observe') {
        await gate;
        return { ok: true, ...observation('ready', { task: summary({ state: 'awaiting-host-review' }) }) };
      }
      if (route === 'status') return { ok: true, delegated: { authorized: true } };
      if (route === 'cancel') return { ok: true, task: { taskId: payload.taskId, state: 'cancelled' } };
      return { ok: true };
    },
  });
  const input = new Readable({ read() {} });
  const chunks = [];
  const output = new Writable({ write(chunk, _e, callback) { chunks.push(chunk.toString('utf8')); callback(); } });
  const done = serveStdio({ input, output, server });
  const send = (message) => input.push(`${JSON.stringify(message)}\n`);
  const replies = () => chunks.join('').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  const replyTo = async (id) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const found = replies().find((line) => line.id === id);
      if (found !== undefined) return found;
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
    }
    throw new Error(`no reply for ${String(id)}`);
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await replyTo(1);
  send({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: {
      name: 'delegate_permission_decide',
      arguments: { taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'reject', waitAfterDecision: true },
    },
  });
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });
  // The continuing decision is parked inside its wait. Everything else still answers.
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delegate_status', arguments: {} } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delegate_cancel', arguments: { taskId: 'task-1' } } });
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'delegate_metrics', arguments: {} } });
  const status = await replyTo(3);
  const cancelled = await replyTo(4);
  const census = await replyTo(5);
  assert.equal(JSON.parse(status.result.content[0].text).delegated.authorized, true);
  assert.equal(JSON.parse(cancelled.result.content[0].text).task.state, 'cancelled');
  assert.equal(JSON.parse(census.result.content[0].text).metrics.decisions.count, 1);
  releaseWait();
  const decided = await replyTo(2);
  const body = JSON.parse(decided.result.content[0].text);
  assert.equal(body.decisionReceipt.applied, true);
  assert.equal(body.reason, 'ready');
  input.push(null);
  const drained = await done;
  assert.equal(drained.drained, true, 'every reply was written before the transport returned');
  assert.ok(replies().length >= 5);
  assert.ok(MAX_INFLIGHT_REQUESTS >= 32);
});

test('notifications/cancelled ends the continuing wait and nothing else', async () => {  const clock = fakeClock();
  const observed = [];
  const server = createMcpServer({
    now: clock.now,
    sleep: clock.sleep,
    async callExecution(route, payload, context) {
      if (route === 'permission') return decisionAnswer(payload);
      observed.push({ taskId: payload.taskId });
      await new Promise((resolvePromise) => {
        if (context.signal.aborted) { resolvePromise(); return; }
        context.signal.addEventListener('abort', resolvePromise, { once: true });
      });
      throw Object.assign(new Error('the request was cancelled by the host'), { code: 'MCP_REQUEST_CANCELLED' });
    },
  });
  const input = new Readable({ read() {} });
  const chunks = [];
  const output = new Writable({ write(chunk, _e, callback) { chunks.push(chunk.toString('utf8')); callback(); } });
  const done = serveStdio({ input, output, server });
  const send = (message) => input.push(`${JSON.stringify(message)}\n`);
  const replies = () => chunks.join('').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  const replyTo = async (id) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const found = replies().find((line) => line.id === id);
      if (found !== undefined) return found;
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
    }
    throw new Error(`no reply for ${String(id)}`);
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await replyTo(1);
  send({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: {
      name: 'delegate_permission_decide',
      arguments: { taskId: 'task-1', requestId: 'permission-task-1-1', decision: 'reject', waitAfterDecision: true },
    },
  });
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
  const reply = await replyTo(2);
  const body = JSON.parse(reply.result.content[0].text);
  // A cancellation releases the observation. The decision was applied, so the call succeeds
  // with its receipt and names the cancellation as the WAIT's end, never the decision's.
  assert.equal(reply.result.isError, undefined, 'an applied decision is not turned into a failure');
  assert.equal(body.decisionReceipt.applied, true);
  assert.equal(body.reason, null, 'no task state is invented after an interrupted wait');
  assert.equal(body.waitError.code, 'MCP_REQUEST_CANCELLED');
  assert.deepEqual(observed, [{ taskId: 'task-1' }], 'only the wait observation was issued; the decision was made');
  const census = server.metrics();
  assert.equal(census.decisions.applied, 1, 'the decision remains applied');
  input.push(null);
  await done;
});

// ---------------------------------------------------------------------------
// 8. The worker prompt's execution habits (TB-01/03/04/05)
// ---------------------------------------------------------------------------
//
// Pinned HERE rather than beside the other prompt tests because this file runs without the
// DSH runtime packages (`@deepseek-ai/dsh-llm` and friends) that `tests/review.test.js`
// needs to import the engine. The rules themselves are the delegation contract, so they are
// asserted against the reflowed prompt text: the requirement survives, the line wrapping does
// not become part of the assertion.

test('the worker prompt states how to read logs, run tests and ask for extra permission', () => {
  const flat = buildWorkerPrompt({
    taskId: 'task-1',
    prompt: 'fix the parser',
    workspacePath: 'C:\\work\\repo',
    isolation: 'worktree',
  }).replace(/\s+/gu, ' ');
  // Ordinary reads must not become permission requests.
  assert.match(flat, /Read ordinary files and logs with the normal file tools and the ordinary workspace permission/u);
  assert.match(flat, /Do not ask for elevated access merely to read a log/u);
  // Ordinary permission first; a concrete environment error is kept, not retried with more access.
  assert.match(flat, /Run tests under the ordinary permission first/u);
  assert.match(flat, /a CONCRETE environment reason/u);
  assert.match(flat, /keep that error text and report it rather than retrying the same command with more access/u);
  // Extra permission: one complete bounded command, one call, never permanent.
  assert.match(flat, /Ask for extra permission only for the one complete, bounded command that genuinely needs it/u);
  assert.match(flat, /A permission granted for one call never covers a later call/u);
  assert.match(flat, /never widens the sandbox permanently/u);
  // One combined command with a saved log; a filter change is not a reason to re-run.
  assert.match(flat, /Run one combined test command, save its FULL stdout\/stderr, its real exit code/u);
  assert.match(flat, /Do not re-run a test merely to change a filter/u);
  assert.match(flat, /`Select-String` pattern or a `Select-Object -First N`/u);
  // A missing dependency is verified, never papered over with access.
  assert.match(flat, /check whether the module exists before concluding the test failed/u);
  assert.match(flat, /never use extra permission to paper over a module-not-found error/u);
  assert.match(flat, /Fix a failing test before running the suite again/u);
  // The pre-existing invariants are still there.
  assert.match(flat, /Do not commit, push, tag, or rewrite git history/u);
  assert.match(flat, /You cannot approve your own work/u);
});

test('the delegated worker cannot approve its own work or rewrite history', () => {
  const prompt = buildWorkerPrompt({ taskId: 'task-1', prompt: 'Add a function', isolation: 'shared' });
  assert.match(prompt, /Do not commit, push, tag, or rewrite git history/);
  assert.match(prompt, /the host decides acceptance/);
  assert.match(prompt, /Do not claim checks you did not run/);
});
