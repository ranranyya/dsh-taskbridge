// TB151-01: a LONG permission answer must not drop the already-applied failure
// acknowledgement.
//
// The audit reproduced this: the host confirms a repeated-failure reminder with
// `ackFailureEventId`, the server applies it (and reports `acknowledged: true`), but
// the same wait answer also carries a big pending permission operation, so it enters
// `permissionRescue()`. `withReceipt()` there re-attached only `decisionReceipt` and
// `answerReceipt`, so the confirmed `failureAck` vanished from the compressed answer
// while the reminder had already been cleared. A short answer kept it, which is why
// the short control passed.
//
// Cases 1–3 below drive the REAL production `tools/call` handler and the real
// `boundedJson`/rescue path (no internals stubbed, no constructed command executed —
// the command is inert data). Case 4 documents, with explicit reachability reasons,
// why the final `MCP_RESULT_OVER_BUDGET` branch cannot be reached from a wait answer
// under production bounds; part of it is still exercised as a clearly labelled
// SYNTHETIC-boundary unit of the refusal projection.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PERMISSION_BOUNDS, PermissionBridge } from '../src/runtime/permissions.js';
import { QuestionBridge } from '../src/runtime/questions.js';
import { TaskMonitor } from '../src/jobs/activity.js';
import {
  MAX_TOOL_TEXT_CHARS,
  createMcpServer,
} from '../src/mcp/server.js';

/** One confirmed repeated-failure reminder plus its acknowledgement. */
function deliveredFailure() {
  const now = 1_763_200_000_000;
  const task = {
    taskId: 'task-budget',
    state: 'running',
    phase: 'execute',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    permission: { pending: null },
    question: { pending: null },
  };
  const monitor = new TaskMonitor(task, { repeatFailureThreshold: 3 });
  for (let index = 0; index < 3; index += 1) {
    monitor.onEvent({
      type: 'tool/call',
      data: { callId: `failure-${index}`, name: 'pwsh', arguments: '{"command":"npm test"}' },
    });
    monitor.onEvent({
      type: 'tool/result',
      data: {
        message: { role: 'tool', toolCallId: `failure-${index}`, isError: true, content: [] },
        error: { code: 'EACCES', message: 'same fixture failure' },
      },
    });
  }
  return { now, task, monitor };
}

/**
 * A long but VALID and COMPLETE pending permission operation.
 *
 * The command text is inert data (a quoted echo); nothing executes it. It is sized so
 * the published answer can only fit through the rescue path.
 * @param {object} bridge - permission bridge.
 * @param {string} taskId - owning task.
 * @param {number} repeats - backslash-quote repetitions (sizes the command).
 * @returns {object} the production public pending view.
 */
function longPending(bridge, taskId, repeats) {
  const command = `Write-Output '${'\\"'.repeat(repeats)}'`;
  return bridge.publicView(bridge.createPending(
    { reason: 'fixture request' },
    {
      name: 'pwsh',
      callId: 'pending-call',
      turn: 1,
      step: 1,
      seq: 1,
      argumentsText: JSON.stringify({ command, sandbox_permissions: 'danger-full-access' }),
    },
  ));
}

/**
 * One LEGAL pending question set, produced by the production QuestionBridge.
 *
 * The questions carry EVERY field of the real question contract (`id`, `question`,
 * `header`, `detail`, `options`, `multiSelect`, `intent`) and the answer is the
 * bridge's own `publicView`, so the identity (`requestId`, `taskId`, `callId`,
 * `state`) is the production one.
 *
 * `intent` matters: a fixture that omitted it produced `undefined` in the raw
 * object, and `createMcpServer` refuses a value it cannot serialize
 * (`MCP_RESULT_UNSERIALIZABLE`) — the real HTTP wire never carries `undefined`
 * (JSON drops it), so such a fixture tested the in-process shape, not the transport.
 * The `callExecution` double below therefore also normalizes its answer through
 * `JSON.parse(JSON.stringify(...))` to model the real HTTP line format exactly.
 * @param {string} detail - one ordinary detail string (its size drives the rescue).
 * @returns {{ bridge: object, pending: object, close: () => void }} the published view.
 */
function legalQuestionSet(detail) {
  const bridge = new QuestionBridge({
    taskId: 'task-budget',
    timeoutMs: 60_000,
    logger: { warn() {} },
  });
  const asked = [
    {
      id: 'q-0',
      question: 'Which branch should the worker take?',
      header: 'Branch',
      detail,
      options: [
        { label: 'alpha', description: 'take the first branch' },
        { label: 'beta', description: 'take the second branch' },
      ],
      multiSelect: false,
      // Required by the native question contract; omitting it leaves `undefined` in
      // the raw object and is refused as un-serializable before any compression.
      intent: null,
    },
  ];
  const pending = bridge.publicView(bridge.createPending(asked, { callId: 'pending-call', turn: 1, step: 1, seq: 1 }));
  return { bridge, pending, close: () => bridge.dispose?.() };
}

/**
 * A LEGAL, oversized question set for the rescue rung.
 *
 * `QUESTION_BOUNDS` allows at most 24 questions and 8,000 detail characters each, so the
 * largest legal set is 24 questions × 8,000 chars ≈ 196K characters — well past the
 * 20,000-char tool-text bound while every question stays inside the production contract.
 * Each question is a separate, valid entry (not one long string repeated).
 * @returns {{ pending: object, close: () => void }} the published block plus cleanup.
 */
function oversizedQuestionSet() {
  const bridge = new QuestionBridge({ taskId: 'task-budget', timeoutMs: 60_000, logger: { warn() {} } });
  const asked = [];
  for (let index = 0; index < 24; index += 1) {
    asked.push({
      id: `q-${index}`,
      question: `Which branch should the worker take for module ${index}?`,
      header: `Module ${index}`,
      detail: `Detail for module ${index}: `.padEnd(8_000, 'x'),
      options: [
        { label: 'alpha', description: 'take the first branch' },
        { label: 'beta', description: 'take the second branch' },
      ],
      multiSelect: false,
      intent: null,
    });
  }
  const pending = bridge.publicView(bridge.createPending(asked, { callId: 'pending-call', turn: 1, step: 1, seq: 1 }));
  return { pending, close: () => bridge.dispose?.() };
}

/**
 * Run one real `delegate_wait` through the production handler.
 *
 * The `callExecution` double answers in the REAL transport shape: the observation is
 * round-tripped through `JSON.parse(JSON.stringify(...))` before it is returned, which
 * is exactly what the loopback HTTP hop does to a body. That matters for fixtures
 * whose raw object could carry `undefined`: JSON drops such members, and the server
 * refuses an un-serializable value with `MCP_RESULT_UNSERIALIZABLE`, which is an
 * artefact of the in-process fixture, not of the wire.
 * @param {object} options - `task`, `monitor`, `permission`, `question`, `ackFailureEventId`, `now`.
 * @returns {Promise<{ body: object, text: string, monitorAck: object }>} the answer.
 */
async function runWait(options) {
  let monitorAck = null;
  const server = createMcpServer({
    async callExecution(_route, payload) {
      monitorAck = options.monitor.ackFailureReport(payload.ackFailureEventId);
      const observation = {
        ok: true,
        reason: options.question !== undefined ? 'question' : 'permission',
        task: options.task,
        permission: options.permission ?? null,
        question: options.question ?? null,
        failure: null,
        activity: {},
        selfCheck: null,
        failureAck: monitorAck,
        wait: { waitedMs: 0 },
      };
      // Model the wire: the HTTP hop serializes the body, so `undefined` members are
      // gone before the server reads it (and nothing is invented).
      return JSON.parse(JSON.stringify(observation));
    },
    now: () => options.now,
    sleep: async () => {},
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'delegate_wait',
      arguments: { taskId: options.task.taskId, waitSeconds: 1, ackFailureEventId: options.ackFailureEventId },
    },
  });
  const text = response.result.content[0].text;
  return { body: JSON.parse(text), text, monitorAck };
}

test('TB151-01: a LONG permission answer keeps the already-applied failureAck, and the short control is unchanged', async () => {
  const { now, task, monitor } = deliveredFailure();
  const bridge = new PermissionBridge({ taskId: task.taskId, connectionId: 'audit', sessionId: 'session-tb151' });
  try {
    const delivered = await monitor.observe({ waitMs: 1 });
    const eventId = delivered.failure.eventId;
    const pendingLong = longPending(bridge, task.taskId, 3500);
    assert.equal(pendingLong.argumentsComplete, true, 'the production projection keeps the operation complete');

    const long = await runWait({ task, monitor, permission: pendingLong, ackFailureEventId: eventId, now });
    assert.equal(long.monitorAck.acknowledged, true, 'the engine really applied the acknowledgement');
    assert.ok(long.text.length <= MAX_TOOL_TEXT_CHARS, `the answer fits the bound (${long.text.length})`);
    assert.equal(long.text.length > 2000, true, 'the answer is genuinely a long rescue, not the short path');
    assert.deepEqual(
      long.body.failureAck,
      { acknowledged: true, eventId, reason: null },
      'the compressed answer keeps the EXACT applied receipt (eventId unchanged, acknowledged true)',
    );

    // The cut operation must still not be presented as decidable.
    const operation = long.body.permission ?? long.body.task?.permission?.pending ?? null;
    assert.ok(operation !== null, 'the operation survives the rescue');
    assert.equal(long.body.permissionDecidable, false,
      'a capped operation is never advertised as decidable (no accidental allowance)');

    // The SHORT control: same acknowledgement, small operation, normal path.
    const shortCase = deliveredFailure();
    const bridge2 = new PermissionBridge({ taskId: shortCase.task.taskId, connectionId: 'audit', sessionId: 'session-tb151' });
    const delivered2 = await shortCase.monitor.observe({ waitMs: 1 });
    const short = await runWait({
      task: shortCase.task,
      monitor: shortCase.monitor,
      permission: longPending(bridge2, shortCase.task.taskId, 1),
      ackFailureEventId: delivered2.failure.eventId,
      now: shortCase.now,
    });
    assert.deepEqual(
      short.body.failureAck,
      { acknowledged: true, eventId: delivered2.failure.eventId, reason: null },
      'the short control keeps the receipt (unchanged behaviour)',
    );
    bridge2.dispose();
    shortCase.monitor.dispose();
  } finally {
    monitor.dispose();
    bridge.dispose();
  }
});

test('TB151-01: a REFUSED ack is kept verbatim through the long-permission rescue, never rewritten as success', async () => {
  const { now, task, monitor } = deliveredFailure();
  const bridge = new PermissionBridge({ taskId: task.taskId, connectionId: 'audit', sessionId: 'session-tb151' });
  try {
    const delivered = await monitor.observe({ waitMs: 1 });
    const pendingLong = longPending(bridge, task.taskId, 3500);
    const long = await runWait({ task, monitor, permission: pendingLong, ackFailureEventId: 'deadbeefdeadbeef', now });
    assert.equal(long.monitorAck.acknowledged, false);
    assert.deepEqual(
      long.body.failureAck,
      { acknowledged: false, eventId: 'deadbeefdeadbeef', reason: 'unknown-event' },
      'the refusal fact survives compression exactly: same id, acknowledged false, same reason',
    );
    const stillPending = monitor.claimFailureReport();
    assert.ok(stillPending !== null, 'a refused ack never cleared the reminder');
    assert.equal(stillPending.eventId, delivered.failure.eventId);
  } finally {
    monitor.dispose();
    bridge.dispose();
  }
});

test('TB151-01: a long question answer produced by the LEGAL QuestionBridge keeps the acknowledgement', async () => {
  // The question set is one ordinary question whose DETAIL is long: a legal
  // projection from the production bridge (every contract field present, including
  // `intent`), delivered in the real transport shape (serialized, so no `undefined`
  // member survives to trip `MCP_RESULT_UNSERIALIZABLE`). This case does NOT claim to
  // have driven `rescueQuestion()` specifically — the question block is bounded to
  // 16,000 chars before the rescue, so the whole-set path is not what a single long
  // detail exercises. What it pins is the observable contract: the ack verdict is not
  // lost when a question answer is compressed.
  const { now, task, monitor } = deliveredFailure();
  const questionSet = legalQuestionSet('The worker needs a decision about this long detail. '.repeat(60));
  try {
    const delivered = await monitor.observe({ waitMs: 1 });
    const answer = await runWait({
      task, monitor, question: questionSet.pending, ackFailureEventId: delivered.failure.eventId, now,
    });
    assert.equal(answer.body.ok, true, `the question answer is delivered (got ${answer.body.error?.code ?? 'ok'})`);
    assert.ok(answer.body.error === undefined, 'a serializable question answer is never refused as un-serializable');
    assert.ok(answer.text.length <= MAX_TOOL_TEXT_CHARS, `the answer fits the bound (${answer.text.length})`);
    // An ordinary single-question answer may well fit whole; when it was compressed the
    // truncation record is present, and either way the ack verdict must survive.
    if (answer.body.truncation?.truncated === true) {
      assert.equal(answer.body.truncation.fullResultIncluded, false);
    }
    // `grantsAccess: false` is published where the answer is a question answer; the
    // field is asserted only when it is present, never invented.
    if (answer.body.grantsAccess !== undefined) assert.equal(answer.body.grantsAccess, false);
    assert.ok(answer.monitorAck?.acknowledged === true, 'the engine really applied the acknowledgement');
    assert.deepEqual(
      answer.body.failureAck,
      { acknowledged: true, eventId: delivered.failure.eventId, reason: null },
      'the question answer keeps the applied acknowledgement verbatim',
    );
  } finally {
    questionSet.close();
    monitor.dispose();
  }
});

// ---------------------------------------------------------------------------
// The FINAL `MCP_RESULT_OVER_BUDGET` refusal: NOT REPRODUCED here.
//
// No assertion is written for it, and no claim is made that it is unreachable. What
// this file can honestly state:
//   * the audit's independent reproduction only covered the permission-rescue case
//     (a 7,015-char command / 14,072-char projected operation), which is repaired;
//   * reaching the final refusal needs an answer whose CRITICAL fields alone exceed
//     the tool-text bound, and the argument bounds alone do NOT prove that cannot
//     happen: JSON escaping of the published strings, the number of pending requests
//     in one answer, and the identity fields all change the measured size. A
//     "first rescue rung always fits" argument was tried and is not sound for that
//     reason, so it is not used.
//   * the fix nevertheless carries the verdict on that path (`minimalFailureAck` in
//     the `MCP_RESULT_OVER_BUDGET` identity block) as defence in depth; that code is
//     NOT claimed to be covered by a test.
// The two constants below are recorded as the bounds this reasoning depends on, so a
// future change to them re-opens the question.
test('TB151-01: the production bounds this refusal analysis refers to are recorded', () => {
  assert.equal(MAX_TOOL_TEXT_CHARS, 20_000, 'the tool-text bound the analysis refers to');
  assert.equal(PERMISSION_BOUNDS.argumentsChars, 16_384,
    'the engine argument bound the analysis refers to');
});

// ---------------------------------------------------------------------------
// The QUESTION rescue rung, driven directly.
//
// The long-question case above asked ONE question, whose block fits the 16,000-character
// wire budget, so an ordinary stage already fitted and the rescue never ran. This case
// uses the LARGEST set the production QuestionBridge accepts (24 questions × 8,000 detail
// characters, each question a valid separate entry) so the serialized block alone is far
// past the 20,000-character tool-text bound: no stage fits, and `rescueQuestion` runs.
// No internal is stubbed and no bound is redefined.
test('TB151-01: an answer too large for every stage is rescued by the QUESTION rung, keeping the ack verdict', async () => {
  const { now, task, monitor } = deliveredFailure();
  const questionSet = oversizedQuestionSet();
  try {
    const delivered = await monitor.observe({ waitMs: 1 });
    const answer = await runWait({
      task, monitor, question: questionSet.pending, ackFailureEventId: delivered.failure.eventId, now,
    });
    assert.equal(answer.body.ok, true, `the answer was delivered (got ${answer.body.error?.code ?? 'ok'})`);
    assert.ok(answer.text.length <= MAX_TOOL_TEXT_CHARS, `the answer fits the bound (${answer.text.length})`);
    // Reaching this rung is observable: the answer states it is a truncation.
    assert.equal(answer.body.truncation?.truncated, true, 'the answer was compressed to reach this rung');
    assert.equal(answer.body.truncation.fullResultIncluded, false);
    const question = answer.body.question;
    assert.ok(question !== null && typeof question === 'object', 'the question block survived the rescue');
    // Both rungs are legal: the block fit 16,000 whole, or it was replaced by an explicit
    // omission. A SILENT cut is the thing that must never happen.
    if (question.questionsOmitted === true) {
      assert.deepEqual(question.questions, [], 'an omission carries no question text at all');
      assert.equal(question.questionAnswerable, false);
      assert.equal(question.reason, 'question-too-large');
      assert.equal(question.questionCount, 24, 'and still states how many were asked');
    } else {
      assert.ok(Array.isArray(question.questions) && question.questions.length > 0);
      assert.equal(answer.body.questionAnswerable, true);
    }
    assert.equal(answer.body.grantsAccess, false, 'a question answer never grants access');
    // The point of the fix: the applied acknowledgement must arrive verbatim on this rung.
    assert.ok(answer.monitorAck?.acknowledged === true, 'the engine really applied the acknowledgement');
    assert.deepEqual(
      answer.body.failureAck,
      { acknowledged: true, eventId: delivered.failure.eventId, reason: null },
      'the RESCUED question answer keeps the applied acknowledgement verbatim',
    );
  } finally {
    questionSet.close();
    monitor.dispose();
  }
});
