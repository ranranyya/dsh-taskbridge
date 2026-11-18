// R2 at the MCP surface: answering a question, the optional continuation, and the two
// shapes a client may see.
//
// The properties this file pins:
//
//  * the tool's schema is closed — no field can grant access, and the MCP-only flag is
//    stripped before the plane;
//  * without `waitAfterAnswer` the answer is the route reply VERBATIM, so a client that
//    only answers sees exactly what it saw before this feature existed;
//  * with it, the answer is the flat wait shape plus a receipt, and an APPLIED answer
//    whose follow-up wait fails still succeeds with the receipt instead of losing it;
//  * an UNCONFIRMED answer is never continued and never reported as applied;
//  * a pending question carried on a wait is complete enough to answer in one round trip.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MCP_ONLY_ARGUMENTS,
  TOOLS,
  LATEST_PROTOCOL_VERSION,
  createMcpServer,
} from '../src/mcp/server.js';

/**
 * A server whose question route answers as the real route does.
 *
 * `now` and `sleep` are seams, so a test that finishes its answer and then follows the task
 * pays no wall time for the wait loop's own pacing.
 * @param {object} [script] - `question`, `observe` overrides.
 * @returns {{ server: object, calls: object[] }} fixture.
 */
function questionFixture(script = {}) {
  const calls = [];
  let observe = 0;
  const clock = { at: 0 };
  const server = createMcpServer({
    now: () => clock.at,
    sleep: async (ms) => { clock.at += ms; },
    async callExecution(route, payload) {
      calls.push({ route, payload });
      if (route === 'question') {
        if (typeof script.question === 'function') return await script.question(payload);
        return {
          ok: true,
          task: { taskId: payload.taskId, state: 'running', phase: 'execute' },
          answer: {
            requestId: payload.requestId,
            taskId: payload.taskId,
            answers: payload.answers,
            answeredAt: 1_700_000_000_000,
          },
          hostAcceptance: null,
        };
      }
      if (route === 'observe') {
        const answer = typeof script.observe === 'function'
          ? await script.observe({ payload, index: observe })
          : { reason: 'heartbeat', task: { taskId: payload.taskId, state: 'running' } };
        observe += 1;
        if (answer instanceof Error) throw answer;
        return { ok: true, ...answer };
      }
      return { ok: true, route };
    },
  });
  return { server, calls, clock };
}

/**
 * Call one tool over the protocol.
 * @param {object} server - the server.
 * @param {string} name - tool name.
 * @param {object} args - arguments.
 * @returns {Promise<{ body: object, text: string, isError: boolean }>} the answer.
 */
async function call(server, name, args) {
  await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION } });
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const text = response.result.content[0].text;
  return { body: JSON.parse(text), text, isError: response.result.isError === true };
}

const ANSWER = { taskId: 'task-1', requestId: 'question-task-1-1', answers: [{ id: 'q1', selected: ['yes'] }] };

test('delegate_question_answer declares a closed schema with no field that could grant access', () => {
  const tool = TOOLS.find((entry) => entry.name === 'delegate_question_answer');
  assert.ok(tool !== undefined);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['taskId', 'requestId', 'answers', 'waitAfterAnswer']);
  assert.deepEqual(tool.inputSchema.required, ['taskId', 'requestId', 'answers']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  // The MCP-only flag is stripped at this boundary and never reaches the plane.
  assert.deepEqual(MCP_ONLY_ARGUMENTS.delegate_question_answer, ['waitAfterAnswer']);
  // It is not a read (it settles a paused call) and not destructive (nothing is stopped).
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
  // The description must not read like an approval.
  assert.match(tool.description, /does NOT grant access/u);
  assert.match(tool.description, /not an approval/u);
});

test('without waitAfterAnswer the route reply is returned verbatim', async () => {
  const { server, calls } = questionFixture();
  const answer = await call(server, 'delegate_question_answer', ANSWER);
  assert.equal(answer.isError, false);
  // No receipt, no added field: the historical shape.
  assert.deepEqual(answer.body.answer.answers, ANSWER.answers);
  assert.equal('answerReceipt' in answer.body, false);
  assert.deepEqual(calls, [{ route: 'question', payload: ANSWER }]);
});

test('waitAfterAnswer is stripped before the plane, and an applied answer continues in the SAME call', async () => {
  const { server, calls } = questionFixture({
    observe: ({ index }) => (index === 0
      ? { reason: 'ready', task: { taskId: 'task-1', state: 'awaiting-host-review', phase: 'awaiting-host-review' } }
      : { reason: 'heartbeat', task: { taskId: 'task-1', state: 'running' } }),
  });
  const answer = await call(server, 'delegate_question_answer', { ...ANSWER, waitAfterAnswer: true });
  assert.equal(answer.isError, false);
  assert.equal(answer.body.reason, 'ready', 'the answer is the flat wait shape');
  assert.equal(answer.body.answerReceipt.applied, true);
  assert.equal(answer.body.answerReceipt.confirmation, 'confirmed');
  assert.equal(answer.body.answerReceipt.requestId, ANSWER.requestId);
  assert.equal(answer.body.answerReceipt.grantsAccess, false);
  // The control flag never reached the plane.
  assert.deepEqual(calls[0], { route: 'question', payload: ANSWER });
});

test('an applied answer whose follow-up wait fails KEEPS its receipt and says only the wait failed', async () => {
  const { server } = questionFixture({
    observe: () => Object.assign(new Error('socket closed'), { code: 'MCP_HARNESS_UNREACHABLE' }),
  });
  const answer = await call(server, 'delegate_question_answer', { ...ANSWER, waitAfterAnswer: true });
  assert.equal(answer.isError, false, 'the answer was applied; only the wait ended');
  assert.equal(answer.body.answerReceipt.applied, true);
  assert.equal(answer.body.reason, null, 'no task state was observed');
  assert.equal(answer.body.actionable, false);
  assert.match(answer.body.instruction, /do not resend/u);
  assert.equal(answer.body.waitError.code, 'MCP_HARNESS_UNREACHABLE');
});

test('an UNCONFIRMED answer is refused, carries its receipt, and never continues', async () => {
  const { server, calls } = questionFixture({
    // The route answers with a DIFFERENT request id: it did not confirm this answer.
    question: (payload) => ({
      ok: true,
      answer: { requestId: 'question-somebody-else-1', taskId: payload.taskId, answers: payload.answers },
    }),
  });
  const answer = await call(server, 'delegate_question_answer', { ...ANSWER, waitAfterAnswer: true });
  assert.equal(answer.isError, true);
  assert.equal(answer.body.error.code, 'MCP_ANSWER_UNCONFIRMED');
  // A route that answered for a DIFFERENT request is a contradiction, not evidence, so
  // nothing is claimed as applied and the caller is told to read the task.
  assert.notEqual(answer.body.error.details.answerReceipt.applied, true);
  assert.match(answer.body.error.message, /read the task/u);
  // Nothing was observed: an unconfirmed answer is never followed by a wait.
  assert.equal(calls.filter((entry) => entry.route === 'observe').length, 0);
});

test('a transport failure is reported as UNKNOWN, not as a clean refusal', async () => {
  const { server } = questionFixture({
    question: () => { throw Object.assign(new Error('timeout'), { code: 'MCP_REQUEST_TIMEOUT' }); },
  });
  // Without the flag the historical refusal is rethrown unchanged.
  const plain = await call(server, 'delegate_question_answer', ANSWER);
  assert.equal(plain.isError, true);
  assert.equal(plain.body.error.code, 'MCP_REQUEST_TIMEOUT');
  // With the flag the caller learns the identity so it can read the task instead of
  // resending an answer that may have landed.
  const flagged = await call(server, 'delegate_question_answer', { ...ANSWER, waitAfterAnswer: true });
  assert.equal(flagged.isError, true);
  assert.equal(flagged.body.error.code, 'MCP_REQUEST_TIMEOUT');
  assert.equal(flagged.body.error.details.answerReceipt.applied, null);
  assert.match(flagged.body.error.message, /read the task/u);
});

test('a mismatched or unproven answer is applied:null with confirmation:unknown, never false', async () => {
  const cases = [
    // The route answered a different request.
    { question: (payload) => ({
      ok: true,
      answer: { requestId: 'question-somebody-else-1', taskId: payload.taskId, answers: payload.answers },
    }) },
    // The route answered for a different TASK.
    { question: (payload) => ({
      ok: true,
      answer: { requestId: payload.requestId, taskId: 'another-task', answers: payload.answers },
    }) },
    // The route normalised the answers differently (a dropped label).
    { question: (payload) => ({
      ok: true,
      answer: { requestId: payload.requestId, taskId: payload.taskId, answers: [{ id: 'q1', selected: [] }] },
    }) },
    // The route answered `ok: true` with no answer block at all.
    { question: () => ({ ok: true }) },
  ];
  for (const script of cases) {
    const { server, calls } = questionFixture(script);
    const answer = await call(server, 'delegate_question_answer', { ...ANSWER, waitAfterAnswer: true });
    assert.equal(answer.isError, true, JSON.stringify(script));
    assert.equal(answer.body.error.code, 'MCP_ANSWER_UNCONFIRMED');
    const receipt = answer.body.error.details.answerReceipt;
    // Not `false` — that would read as "definitely not applied" and invite a resend.
    assert.equal(receipt.applied, null);
    assert.equal(receipt.confirmation, 'unknown');
    // An unconfirmed answer is never followed by a wait.
    assert.equal(calls.filter((entry) => entry.route === 'observe').length, 0);
  }
});

test('a harness refusal with its own code is a clean failure that never claims an answer', async () => {
  const { server, calls } = questionFixture({
    question: () => { throw Object.assign(new Error('the question already settled'), { code: 'QUESTION_ALREADY_ANSWERED' }); },
  });
  const answer = await call(server, 'delegate_question_answer', { ...ANSWER, waitAfterAnswer: true });
  assert.equal(answer.isError, true);
  assert.equal(answer.body.error.code, 'QUESTION_ALREADY_ANSWERED');
  // The harness said NO, which is a definite verdict rather than an unknown one: the refusal
  // is the same clean shape every other client already handles, and no receipt claims
  // anything was applied.
  assert.equal(answer.text.includes('"applied": true'), false);
  // Nothing was observed: a refused answer never starts a wait.
  assert.equal(calls.filter((entry) => entry.route === 'observe').length, 0);
});

test('the echo is compared by id, so a reordered but equal batch still confirms', async () => {
  const { server } = questionFixture({
    question: (payload) => ({
      ok: true,
      answer: {
        requestId: payload.requestId,
        taskId: payload.taskId,
        answers: [...payload.answers].reverse(),
      },
    }),
  });
  const two = {
    taskId: 'task-1',
    requestId: 'question-task-1-1',
    answers: [{ id: 'q1', selected: ['a'] }, { id: 'q2', selected: [], custom: 'text' }],
  };
  const answer = await call(server, 'delegate_question_answer', { ...two, waitAfterAnswer: true });
  assert.equal(answer.isError, false);
  assert.equal(answer.body.answerReceipt.applied, true);
  assert.equal(answer.body.answerReceipt.confirmation, 'confirmed');
});

test('a QUIET skip drops only the request just answered, so a NEW question returns at once', async () => {
  // The first observation still describes the answered request (the engine's slot has not
  // cleared yet); the second is a genuinely new question, which must be surfaced. The clock
  // and the sleep are seams, so the loop's own pacing floor costs no wall time.
  const answered = { requestId: 'question-task-1-1' };
  const fresh = { requestId: 'question-task-1-2', questions: [{ id: 'q9', question: 'Next?' }] };
  let index = 0;
  const clock = { at: 0, sleep: async (ms) => { clock.at += ms; } };
  const server = createMcpServer({
    now: () => clock.at,
    sleep: clock.sleep,
    async callExecution(route, payload) {
      if (route === 'question') {
        return {
          ok: true,
          answer: { requestId: payload.requestId, taskId: payload.taskId, answers: payload.answers, answeredAt: 1 },
        };
      }
      const request = index === 0 ? answered : fresh;
      index += 1;
      return {
        ok: true,
        reason: 'question',
        task: { taskId: payload.taskId, state: 'running', phase: 'awaiting-question' },
        question: {
          ...request,
          taskId: payload.taskId,
          state: 'pending',
          questions: request.questions ?? [{ id: 'q1', question: 'old' }],
        },
      };
    },
  });
  const answer = await call(server, 'delegate_question_answer', { ...ANSWER, waitAfterAnswer: true });
  assert.equal(answer.isError, false);
  assert.equal(answer.body.reason, 'question');
  assert.equal(answer.body.question.requestId, 'question-task-1-2', 'the NEW question is returned, not the answered one');
  assert.equal(index, 2, 'the stale observation was consumed internally, so the new one needed a second look');
});
test('waitAfterAnswer refuses a non-boolean and never answers anything', async () => {
  const { server, calls } = questionFixture();
  for (const value of ['true', 1, {}, null]) {
    const answer = await call(server, 'delegate_question_answer', { ...ANSWER, waitAfterAnswer: value });
    assert.equal(answer.isError, true, JSON.stringify(value));
    assert.equal(answer.body.error.code, 'MCP_ARGUMENT_TYPE');
  }
  assert.deepEqual(calls, [], 'a refused argument never reaches the harness');
});

test('the answer batch is validated per entry, with the position named', async () => {
  const { server, calls } = questionFixture();
  const cases = [
    [{ ...ANSWER, answers: [] }, 'MCP_ARGUMENT_REQUIRED'],
    [{ ...ANSWER, answers: 'yes' }, 'MCP_ARGUMENT_TYPE'],
    [{ ...ANSWER, answers: [{ selected: ['a'] }] }, 'MCP_ARGUMENT_REQUIRED'],
    [{ ...ANSWER, answers: [{ id: 'q1', selected: 'a' }] }, 'MCP_ARGUMENT_TYPE'],
    [{ ...ANSWER, answers: [{ id: 'q1', selected: [1] }] }, 'MCP_ARGUMENT_TYPE'],
    [{ ...ANSWER, answers: [{ id: 'q1', selected: [], extra: 'x' }] }, 'MCP_ARGUMENT_UNKNOWN'],
    [{ ...ANSWER, answers: [{ id: 'q1', selected: [], custom: 5 }] }, 'MCP_ARGUMENT_TYPE'],
  ];
  for (const [args, code] of cases) {
    const answer = await call(server, 'delegate_question_answer', args);
    assert.equal(answer.isError, true, JSON.stringify(args));
    assert.equal(answer.body.error.code, code, JSON.stringify(args));
  }
  assert.deepEqual(calls, []);
});

test('a wait answer carries the whole question so it can be answered in one round trip', async () => {
  const pendingQuestion = {
    requestId: 'question-task-1-1',
    taskId: 'task-1',
    sessionId: 'session-1',
    callId: 'call-9',
    state: 'pending',
    questions: [
      {
        id: 'q1',
        question: 'Which path?',
        header: 'Scope',
        detail: 'two candidates',
        options: [{ label: 'a', description: 'first' }, { label: 'b', description: null }],
        multiSelect: false,
        intent: null,
      },
    ],
    grantsAccess: false,
  };
  const { server } = questionFixture({
    observe: () => ({
      reason: 'question',
      task: { taskId: 'task-1', state: 'running', phase: 'awaiting-question' },
      question: pendingQuestion,
    }),
  });
  const answer = await call(server, 'delegate_wait', { taskId: 'task-1', waitSeconds: 1 });
  assert.equal(answer.isError, false);
  assert.equal(answer.body.reason, 'question', 'the question is actionable, so the wait returns it');
  assert.equal(answer.body.questionAnswerable, true);
  assert.equal(answer.body.grantsAccess, false, 'a question is never an authorization');
  assert.equal(answer.body.question.requestId, pendingQuestion.requestId);
  assert.deepEqual(answer.body.question.questions[0].options.map((option) => option.label), ['a', 'b']);
  assert.equal(answer.body.question.questions[0].detail, 'two candidates');
  // The compact task summary is still compact: no transcript, no model text.
  assert.equal('text' in answer.body.task, false);
});
