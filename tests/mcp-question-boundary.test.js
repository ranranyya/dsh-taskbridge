// The MCP composition boundary: a question must be published WHOLE or be explicitly
// unanswerable, and an already-applied receipt must never be lost to a bound.
//
// The reproduced defect: `delegate_question_answer({ waitAfterAnswer: true })` with a large
// answer batch, followed by a fresh legitimate question in the same call. The generic
// skeleton stage cut `question`/`detail` to 240 characters while the answer still said
// `questionAnswerable: true`, so the commander could answer a question it never saw.
//
// Every test here drives the REAL `createMcpServer` with a fake plane, so what is asserted is
// the text the host receives — not `questionsFit` in isolation.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LATEST_PROTOCOL_VERSION,
  MAX_TOOL_TEXT_CHARS,
  createMcpServer,
  isQuestionAnswerable,
} from '../src/mcp/server.js';

/**
 * One legitimate pending question at the engine's own accepted size.
 * @param {string} [requestId] - the request id.
 * @returns {object} pending question block.
 */
function legitimateQuestion(requestId = 'question-task-1-2') {
  return {
    requestId,
    taskId: 'task-1',
    sessionId: 's1',
    callId: 'call-2',
    state: 'pending',
    createdAt: 1,
    deadlineAt: 600_000,
    questions: [
      {
        id: 'q1',
        question: 'A'.repeat(1900),
        detail: 'B'.repeat(7900),
        header: null,
        options: [],
        multiSelect: false,
        intent: null,
      },
    ],
    grantsAccess: false,
  };
}

/**
 * The reviewer's large answer batch: 24 answers of 4 000 characters each.
 * @returns {object[]} answers.
 */
function largeAnswers() {
  return Array.from({ length: 24 }, (_, index) => ({ id: `old${index}`, selected: [], custom: 'C'.repeat(4000) }));
}

/**
 * A server whose question route echoes what it was sent and whose observe returns `observe()`.
 * @param {Function} observe - returns the observation for one call.
 * @param {object} [script] - `question` override.
 * @returns {{ server: object, calls: object[] }} fixture.
 */
function fixture(observe, script = {}) {
  const calls = [];
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
          answer: { requestId: payload.requestId, taskId: payload.taskId, answers: payload.answers, answeredAt: 1 },
          hostAcceptance: null,
        };
      }
      return { ok: true, ...observe(payload) };
    },
  });
  return { server, calls };
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

/** The answer request the tests send. */
const ANSWER = { taskId: 'task-1', requestId: 'question-task-1-1', answers: largeAnswers(), waitAfterAnswer: true };

test('the reproduced case: a big answer batch plus a new legitimate question keeps the question WHOLE', async () => {
  const question = legitimateQuestion();
  const { server } = fixture(() => ({
    reason: 'question',
    task: { taskId: 'task-1', state: 'running', phase: 'awaiting-question' },
    question,
  }));
  const answer = await call(server, 'delegate_question_answer', ANSWER);
  assert.equal(answer.isError, false);
  assert.ok(answer.text.length <= MAX_TOOL_TEXT_CHARS);
  const published = answer.body.question;
  // Not cut: the exact text the worker asked with.
  assert.equal(published.questions[0].question.length, 1900, 'the question text is NOT shortened');
  assert.equal(published.questions[0].detail.length, 7900, 'the detail is NOT shortened');
  assert.equal(published.questionsOmitted, false);
  assert.equal(answer.body.questionAnswerable, true);
  // The applied answer is still reported as applied.
  assert.equal(answer.body.answerReceipt.applied, true);
  assert.equal(answer.body.answerReceipt.confirmation, 'confirmed');
});

test('the answer batch is explicitly omitted, not carried, when it is huge', async () => {
  const { server } = fixture(() => ({ reason: 'heartbeat', task: { taskId: 'task-1', state: 'running' } }));
  const answer = await call(server, 'delegate_question_answer', ANSWER);
  assert.equal(answer.isError, false);
  const receipt = answer.body.answerReceipt;
  assert.equal(receipt.applied, true);
  assert.equal(receipt.confirmation, 'confirmed');
  // 24 x 4 000 characters is 96 K: it must not be echoed in full.
  assert.ok(answer.text.length <= MAX_TOOL_TEXT_CHARS);
  const echoed = JSON.stringify(receipt);
  assert.ok(echoed.length < 4_000, `the receipt stays small (${echoed.length})`);
  assert.equal(echoed.includes('C'.repeat(200)), false, 'the custom text is not repeated');
  // The omission is stated, so a reader knows answers existed.
  assert.equal(receipt.answersOmitted === true || receipt.answerCount === 24, true);
});

test('an oversized question set is published as an explicit omission and is NOT answerable', async () => {
  // Twelve questions at the engine's maximum size cannot fit one tool answer.
  const huge = {
    requestId: 'question-task-1-9',
    taskId: 'task-1',
    sessionId: 's1',
    callId: 'call-9',
    state: 'pending',
    createdAt: 1,
    deadlineAt: 600_000,
    questions: Array.from({ length: 12 }, (_, index) => ({
      id: `q${index}`, question: 'A'.repeat(1900), detail: 'B'.repeat(7900), header: null, options: [], multiSelect: false, intent: null,
    })),
    grantsAccess: false,
  };
  const { server } = fixture(() => ({
    reason: 'question',
    task: { taskId: 'task-1', state: 'running', phase: 'awaiting-question' },
    question: huge,
  }));
  const answer = await call(server, 'delegate_question_answer', ANSWER);
  assert.equal(answer.isError, false);
  assert.ok(answer.text.length <= MAX_TOOL_TEXT_CHARS);
  const published = answer.body.question;
  assert.equal(published.questionsOmitted, true, 'the omission is explicit');
  assert.equal(published.reason, 'question-too-large');
  assert.deepEqual(published.questions, [], 'no shortened question is carried');
  assert.equal(published.questionCount, 12, 'the count still tells the host one exists');
  // The published flag and the block agree, and no partial text leaks.
  assert.equal(answer.body.questionAnswerable, false);
  assert.equal(published.questionAnswerable, false);
  assert.equal(answer.text.includes('B'.repeat(200)), false, 'no truncated detail is published');
  // The applied receipt is still there.
  assert.equal(answer.body.answerReceipt.applied, true);
});

test('JSON escapes count: an all-quotes question set is measured at its serialised width', async () => {
  const quote = { id: 'q', question: '"'.repeat(1900), detail: null, header: null, options: [], multiSelect: false, intent: null };
  const one = { ...legitimateQuestion(), questions: [quote] };
  const single = fixture(() => ({ reason: 'question', task: { taskId: 'task-1', state: 'running' }, question: one }));
  const a = await call(single.server, 'delegate_question_answer', ANSWER);
  // One such question is ~3 800 serialised characters: it fits and is published verbatim.
  assert.equal(a.body.question.questions[0].question, '"'.repeat(1900));

  const four = { ...legitimateQuestion(), questions: Array.from({ length: 5 }, (_, index) => ({ ...quote, id: `q${index}` })) };
  const many = fixture(() => ({ reason: 'question', task: { taskId: 'task-1', state: 'running' }, question: four }));
  const b = await call(many.server, 'delegate_question_answer', ANSWER);
  // Five are over the whole-block budget, so explicitly omitted.
  assert.equal(b.body.question.questionsOmitted, true);
  assert.equal(b.body.questionAnswerable, false);
});

test('24 questions with options: the tail of the last option survives intact when it fits', async () => {
  const questions = Array.from({ length: 24 }, (_, index) => ({
    id: `q${index}`,
    question: `Question ${index}?`,
    detail: null,
    header: null,
    options: [{ label: `a${index}` }, { label: `tail-${index}-ZZZ` }],
    multiSelect: false,
    intent: null,
  }));
  const block = { ...legitimateQuestion(), questions };
  const { server } = fixture(() => ({
    reason: 'question',
    task: { taskId: 'task-1', state: 'running', phase: 'awaiting-question' },
    question: block,
  }));
  const answer = await call(server, 'delegate_question_answer', ANSWER);
  const published = answer.body.question;
  assert.equal(published.questionsOmitted, false);
  assert.equal(published.questions.length, 24);
  assert.equal(published.questions[23].options[1].label, 'tail-23-ZZZ');
  assert.equal(answer.body.questionAnswerable, true);
});

test('the flag is derived from the PUBLISHED block, never from the pre-bound value', async () => {
  // A block that arrives already marked omitted must not be advertised as answerable.
  const omitted = { ...legitimateQuestion(), questionsOmitted: true, questions: [] };
  const { server } = fixture(() => ({ reason: 'question', task: { taskId: 'task-1', state: 'running' }, question: omitted }));
  const answer = await call(server, 'delegate_question_answer', ANSWER);
  assert.equal(answer.body.questionAnswerable, false);

  // And the predicate itself is the one rule.
  assert.equal(isQuestionAnswerable({ state: 'pending', questions: [{ id: 'q', question: 'x' }] }), true);
  assert.equal(isQuestionAnswerable({ state: 'pending', questions: [], questionsOmitted: true }), false);
  assert.equal(isQuestionAnswerable({ state: 'answered', questions: [{ id: 'q', question: 'x' }] }), false);
  assert.equal(isQuestionAnswerable(null), false);
});

test('an ERROR path keeps the minimal receipt identity, applied and confirmation', async () => {
  const { server } = fixture(() => ({ reason: 'heartbeat', task: { taskId: 'task-1', state: 'running' } }), {
    // The answer itself is refused, and the refusal carries the receipt.
    question: () => { throw Object.assign(new Error('boom'), { code: 'MCP_REQUEST_TIMEOUT' }); },
  });
  const answer = await call(server, 'delegate_question_answer', ANSWER);
  assert.equal(answer.isError, true);
  const receipt = answer.body.error.details?.answerReceipt;
  assert.ok(receipt !== null && receipt !== undefined, 'the refusal carries its receipt');
  assert.equal(receipt.taskId, 'task-1');
  assert.equal(receipt.requestId, 'question-task-1-1');
  // Unknown is `null`, never `false`.
  assert.equal(receipt.applied, null);
  assert.equal(receipt.confirmation, 'unknown');
  assert.ok(answer.text.length <= MAX_TOOL_TEXT_CHARS);
});
