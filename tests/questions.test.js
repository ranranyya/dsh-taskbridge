// R2: a delegated worker's ordinary `ask_user_question` reaches the commander.
//
// The seam is the native Agent-scoped Cordis waterfall `'user-questions/request'`. Every
// test drives the REAL waterfall through a real `Context`, so what is asserted is the
// dispatch rule the native service uses — including that `prepend: true` claims the request
// before an answerer composed earlier, and that another Agent's question is untouched.
//
// What the channel must NOT do is asserted just as hard: a question is not an approval, an
// `approval` intent is refused, and a question set that cannot be published WHOLE is refused
// rather than shown shortened.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Context } from '@deepseek-ai/cordis';

import {
  QUESTION_BOUNDS,
  QUESTION_CODES,
  QUESTION_DEFAULT_TIMEOUT_MS,
  QUESTION_REASONS,
  QuestionBridge,
  QuestionError,
  projectQuestion,
  questionWireLength,
  questionsFit,
  validateAnswers,
} from '../src/runtime/questions.js';
import { QUESTION_CALL_BINDING } from '../src/runtime/question-call.js';

/**
 * A Session log: one open turn holding one live `ask_user_question` call.
 *
 * The bridge binds an answer to a REAL call, so a fixture without one is refused — which is
 * the point of the binding. `events` may be extended to model a closed turn, a recorded
 * result or a competing call.
 * @param {object} [options] - `callId`, `toolName`, `withResult`, `closeTurn`, `extraCalls`.
 * @returns {{ id: string, seq: number, eventAt: Function, events: object[] }} session.
 */
function sessionLog(options = {}) {
  const callId = options.callId ?? 'call-q1';
  const events = [{ type: 'turn/start', data: { turn: 1 } }];
  if (options.closeTurn !== true) {
    events.push({
      type: 'tool/call',
      data: { callId, name: options.toolName ?? 'ask_user_question', arguments: '{}', turn: 1, step: 1 },
    });
    if (options.withResult === true) {
      events.push({ type: 'tool/result', data: { callId, content: 'answered' } });
    }
    for (const extra of options.extraCalls ?? []) {
      events.push({
        type: 'tool/call',
        data: { callId: extra, name: 'ask_user_question', arguments: '{}', turn: 1, step: 1 },
      });
    }
  }
  events.push({ type: 'turn/end', data: { turn: 1, ...(options.closeTurn === true ? { kept: true } : {}) } });
  // Keep the synthetic turn/end OUT of the log when the turn must stay open.
  const effective = options.closeTurn === true ? events : events.slice(0, -1);
  return { id: 'session-q1', seq: effective.length, eventAt: (index) => effective[index], events: effective };
}

/**
 * A live Agent bound to one session log.
 * @param {object} [options] - session options.
 * @returns {object} agent-shaped object with `.session`.
 */
function fakeAgent(options = {}) {
  const session = options.session ?? sessionLog(options);
  session.header = { cwd: 'C:\\work' };
  return { id: 'session-q1', session, ctx: null };
}

/**
 * One armed bridge over a fresh agent whose log holds a live question call.
 * @param {object} [options] - `timeoutMs`, `session` options.
 * @returns {{ bridge: object, agent: object }} the bridge and its agent.
 */
function armedBridge(options = {}) {
  const agent = fakeAgent(options.session ?? {});
  const bridge = new QuestionBridge({ taskId: 'task-q1', timeoutMs: options.timeoutMs });
  bridge.arm(agent);
  return { bridge, agent };
}

/**
 * The questions one realistic worker asks: a single-select with descriptions, a
 * multi-select, and a free-text question with no options.
 * @returns {object[]} native question items.
 */
function sampleQuestions() {
  return [
    {
      id: 'q1',
      header: 'Scope',
      question: 'Which files should the change touch?',
      detail: 'The task says "the config module" but names no path.',
      options: [
        { label: 'src/config only', description: 'the narrowest change' },
        { label: 'everything under src', description: 'a wider refactor' },
      ],
    },
    {
      id: 'q2',
      header: 'Extras',
      question: 'Which extras should I include?',
      options: [{ label: 'tests' }, { label: 'docs' }, { label: 'none' }],
      multiSelect: true,
    },
    { id: 'q3', question: 'Name the exact output file.', detail: 'No option fits; free text is required.' },
  ];
}

/** Ask on a bridge and return the pending view, failing if none appeared. */
async function askAndPending(bridge, agent, questions = sampleQuestions()) {
  const waiting = bridge.answer({ agent, questions }).catch((error) => error);
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  const view = bridge.pendingView();
  assert.ok(view !== null, 'the question must be pending before it is answered');
  return { waiting, view };
}

// ---------------------------------------------------------------------------
// 1. Only its own Agent, and it claims before an older answerer
// ---------------------------------------------------------------------------

/**
 * The terminal fallback of a waterfall: `ctx.waterfall(...args, fallback)` pops the LAST
 * argument as the end of the chain.
 */
const NO_ANSWERER = () => Promise.reject(Object.assign(new Error('no answerer'), {
  name: 'UserQuestionError', code: 'NO_PROVIDER',
}));

test('the answerer is registered with prepend so it claims the question BEFORE an existing UI answerer', async () => {
  const ctx = new Context();
  const agent = fakeAgent();
  const calls = [];
  ctx.on('user-questions/request', async () => {
    calls.push('ui');
    return { answers: [{ id: 'q1', selected: ['from the UI'] }] };
  });
  const bridge = new QuestionBridge({ taskId: 'task-q1' });
  bridge.arm(agent);
  ctx.on('user-questions/request', async (request, next) => {
    if (bridge.owns(request) !== true) return await next();
    calls.push('commander');
    return await bridge.answer(request);
  }, { prepend: true });

  const waiting = ctx.waterfall(agent, 'user-questions/request', {
    agent, questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] }],
  }, NO_ANSWERER);
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  const pending = bridge.pendingView();
  assert.ok(pending !== null, 'the commander must see the question at once');
  assert.deepEqual(calls, ['commander'], 'the commander answers first and the UI answerer is never reached');
  assert.equal(pending.callId, 'call-q1', 'the pending set names the real native call');
  bridge.decide({ requestId: pending.requestId, answers: [{ id: 'q1', selected: ['a'] }] });
  assert.deepEqual(await waiting, { answers: [{ id: 'q1', selected: ['a'] }] });
});

test('another Agent in the same process is never answered, and its own answerer still runs', async () => {
  const ctx = new Context();
  const mine = fakeAgent();
  const other = fakeAgent({ session: sessionLog({ callId: 'call-other' }) });
  const bridge = new QuestionBridge({ taskId: 'task-q1' });
  bridge.arm(mine);
  const reached = [];
  ctx.on('user-questions/request', async (request, next) => {
    if (request?.agent !== other) return await next();
    reached.push('other');
    return { answers: [{ id: 'q1', selected: ['other agent answer'] }] };
  }, { prepend: true });
  ctx.on('user-questions/request', async (request, next) => {
    if (bridge.owns(request) !== true) return await next();
    reached.push('mine');
    return await bridge.answer(request);
  }, { prepend: true });

  const answer = await ctx.waterfall(other, 'user-questions/request', {
    agent: other, questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'x' }] }],
  }, NO_ANSWERER);
  assert.deepEqual(reached, ['other'], 'the question never reached the other run bridge');
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['other agent answer'] }] });
  assert.equal(bridge.pendingView(), null, 'nothing was recorded for a foreign agent');
});

test('a question with no Agent at all is not owned, so an ordinary session keeps its answerer', () => {
  const { bridge } = armedBridge();
  assert.equal(bridge.owns({ questions: [{ id: 'q1', question: 'Which?' }] }), false);
  assert.equal(bridge.owns({ agent: undefined, questions: [] }), false);
  assert.equal(bridge.owns({ agent: null, questions: [] }), false);
  assert.equal(bridge.owns({ agent: {}, questions: [] }), false, 'not an Agent object');
  const mine = armedBridge();
  assert.equal(mine.bridge.owns({ agent: mine.agent, questions: [] }), true);
});

// ---------------------------------------------------------------------------
// 2. Bound to a REAL native call
// ---------------------------------------------------------------------------

test('the question binds to the declared call only when it is a live ask_user_question in the open turn', () => {
  const good = sessionLog();
  assert.deepEqual(
    QUESTION_CALL_BINDING({ session: good, declaredCallId: 'call-q1' }),
    { ok: true, callId: 'call-q1', seq: 1, turn: 1 },
  );
  // A call that is not a question tool.
  const wrongTool = sessionLog({ toolName: 'bash' });
  assert.equal(QUESTION_CALL_BINDING({ session: wrongTool, declaredCallId: 'call-q1' }).ok, false);
  // A call that already returned.
  const returned = sessionLog({ withResult: true });
  assert.match(QUESTION_CALL_BINDING({ session: returned, declaredCallId: 'call-q1' }).detail, /already produced a result/u);
  // A call whose turn has closed.
  const closed = sessionLog({ closeTurn: true });
  assert.equal(QUESTION_CALL_BINDING({ session: closed, declaredCallId: 'call-q1' }).ok, false);
  // An id nobody logged.
  assert.match(QUESTION_CALL_BINDING({ session: good, declaredCallId: 'nope' }).detail, /not in the session log/u);
  // No readable log at all.
  assert.equal(QUESTION_CALL_BINDING({ session: null, declaredCallId: 'call-q1' }).ok, false);
});

test('a legacy request with no wait binds only when the open turn holds exactly one question call', () => {
  const one = sessionLog();
  assert.deepEqual(QUESTION_CALL_BINDING({ session: one }).callId, 'call-q1');
  // Two live question calls make the identity ambiguous: a refusal, never a guess.
  const two = sessionLog({ extraCalls: ['call-q2'] });
  const ambiguous = QUESTION_CALL_BINDING({ session: two });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.detail, /ambiguous/u);
  // A turn with no question call at all.
  const none = sessionLog({ toolName: 'bash' });
  assert.equal(QUESTION_CALL_BINDING({ session: none }).ok, false);
});

test('a question with no bindable call is refused promptly instead of waiting', async () => {
  const { bridge, agent } = armedBridge({ session: { closeTurn: true } });
  const failure = await bridge.answer({ agent, questions: [{ id: 'q', question: 'Which?', options: [{ label: 'a' }] }] })
    .catch((error) => error);
  assert.equal(failure.code, QUESTION_CODES.noCall);
  assert.equal(failure.details.reason, QUESTION_REASONS.noCall);
  assert.equal(bridge.pendingView(), null, 'an unbound question never becomes pending');
});

test('an answer is refused once the bound call is gone, and the set is closed rather than left answerable', async () => {
  const { bridge, agent } = armedBridge();
  const { waiting, view } = await askAndPending(bridge, agent, [{ id: 'q', question: 'Which?', options: [{ label: 'a' }] }]);
  // The call returns: the turn is still open but the call now has a result.
  agent.session.events.push({ type: 'tool/result', data: { callId: 'call-q1', content: 'done' } });
  agent.session.seq = agent.session.events.length;
  assert.throws(
    () => bridge.decide({ requestId: view.requestId, answers: [{ id: 'q', selected: ['a'] }] }),
    (error) => error.code === QUESTION_CODES.callGone,
  );
  const settled = await waiting;
  assert.equal(settled.code, 'ASK_ABORTED', 'the worker is released instead of waiting for an unusable answer');
});

// ---------------------------------------------------------------------------
// 3. Whole or refused
// ---------------------------------------------------------------------------

test('the reviewer\'s oversized set is REFUSED, never published shortened', async () => {
  const longSet = [
    { id: 'a', question: 'a'.repeat(1900), detail: 'b'.repeat(7900) },
    { id: 'b', question: 'a'.repeat(1900), detail: 'b'.repeat(7900) },
  ];
  const projected = longSet.map((question) => projectQuestion(question));
  // The measured size is the REAL serialised form, escapes included.
  assert.equal(questionWireLength(projected), JSON.stringify(projected).length);
  assert.ok(questionWireLength(projected) > QUESTION_BOUNDS.wireChars);
  const fit = questionsFit(projected);
  assert.equal(fit.ok, false);
  assert.equal(fit.code, QUESTION_CODES.payloadTooLarge);
  assert.equal(fit.wireChars, questionWireLength(projected));

  const { bridge, agent } = armedBridge();
  const failure = await bridge.answer({ agent, questions: longSet }).catch((error) => error);
  assert.equal(failure.code, QUESTION_CODES.payloadTooLarge);
  assert.equal(bridge.pendingView(), null, 'nothing is shown, so nothing can be answered from a cut copy');
});

test('escapes count against the publishable budget', () => {
  // 1 900 quote characters serialise to 3 800 escaped characters, so the wire form is
  // roughly twice the raw text. A raw-length rule would have accepted a set far past the
  // budget the tool text can carry.
  const quote = { id: 'q', question: '"'.repeat(1900), header: null, detail: null, options: [], multiSelect: false, intent: null };
  const single = questionWireLength([quote]);
  assert.ok(single > 3800 && single < 4000, `one all-quotes question serialises to ${single}`);
  assert.ok(single < QUESTION_BOUNDS.wireChars, 'one such question still fits');
  // Four of them do not, even though their raw text is only 7 600 characters.
  const quadrupled = [quote, { ...quote, id: 'q2' }, { ...quote, id: 'q3' }, { ...quote, id: 'q4' }];
  assert.ok(quadrupled.reduce((total, item) => total + item.question.length, 0) <= QUESTION_BOUNDS.wireChars,
    'the raw text alone would have been inside the budget');
  const fit = questionsFit(quadrupled);
  assert.equal(fit.ok, false, 'raw lengths alone would have accepted this');
  assert.equal(fit.code, QUESTION_CODES.payloadTooLarge);
});

test('a set at the publishable bound is accepted and published EXACTLY', async () => {
  const questions = Array.from({ length: QUESTION_BOUNDS.questions }, (_, index) => ({
    id: `q${index}`,
    question: `Question ${index}?`,
    options: [{ label: `a${index}` }, { label: `b${index}` }],
  }));
  const projected = questions.map((question) => projectQuestion(question));
  assert.equal(questionsFit(projected).ok, true);
  const { bridge, agent } = armedBridge();
  const { waiting, view } = await askAndPending(bridge, agent, questions);
  // Every question and option is published as asked: nothing is trimmed to fit.
  assert.equal(view.questions.length, QUESTION_BOUNDS.questions);
  assert.deepEqual(view.questions.map((question) => question.id), questions.map((question) => question.id));
  assert.deepEqual(view.questions[23].options.map((option) => option.label), ['a23', 'b23']);
  bridge.decide({
    requestId: view.requestId,
    answers: questions.map((question, index) => ({ id: question.id, selected: [`a${index}`] })),
  });
  assert.equal((await waiting).answers.length, QUESTION_BOUNDS.questions);
});

test('the id is used verbatim, and a missing, empty or duplicated id is refused', async () => {
  const { bridge, agent } = armedBridge();
  // Surrounding spaces are part of the id the worker asked with, so they are preserved.
  const { waiting, view } = await askAndPending(bridge, agent, [
    { id: '  spaced id  ', question: 'Which?', options: [{ label: 'a' }] },
  ]);
  assert.equal(view.questions[0].id, '  spaced id  ');
  bridge.decide({ requestId: view.requestId, answers: [{ id: '  spaced id  ', selected: ['a'] }] });
  await waiting;

  for (const bad of [[{ question: 'no id' }], [{ id: '', question: 'empty id' }]]) {
    const failure = await bridge.answer({ agent, questions: bad }).catch((error) => error);
    assert.equal(failure.code, QUESTION_CODES.badIdentity, JSON.stringify(bad));
  }
  const duplicate = await bridge.answer({
    agent,
    questions: [{ id: 'same', question: 'one' }, { id: 'same', question: 'two' }],
  }).catch((error) => error);
  assert.equal(duplicate.code, QUESTION_CODES.badIdentity);
  assert.match(duplicate.details.detail, /duplicate/u);
});

test('two options with one label are refused, because the answer would be ambiguous', async () => {
  const { bridge, agent } = armedBridge();
  const failure = await bridge.answer({
    agent,
    questions: [{ id: 'q', question: 'Which?', options: [{ label: 'same' }, { label: 'same' }] }],
  }).catch((error) => error);
  assert.equal(failure.code, QUESTION_CODES.answerInvalid);
  assert.match(failure.details.detail, /repeats the option label/u);
});

// ---------------------------------------------------------------------------
// 4. What the commander sees, and what it may answer
// ---------------------------------------------------------------------------

test('the pending view carries the real questions, options and detail — and no transcript', async () => {
  const { bridge, agent } = armedBridge();
  const { waiting, view } = await askAndPending(bridge, agent);
  assert.equal(view.requestId, 'question-task-q1-1');
  assert.equal(view.taskId, 'task-q1');
  assert.equal(view.state, 'pending');
  assert.equal(view.grantsAccess, false, 'a question never grants access');
  assert.ok(Number.isFinite(view.deadlineAt), 'the pending set has a FINITE deadline');
  const [first] = view.questions;
  assert.equal(first.header, 'Scope');
  assert.equal(first.question, 'Which files should the change touch?');
  assert.match(first.detail, /names no path/u);
  assert.deepEqual(first.options.map((option) => option.label), ['src/config only', 'everything under src']);
  assert.equal(first.options[0].description, 'the narrowest change');
  assert.equal(view.questions[1].multiSelect, true);
  const text = JSON.stringify(view);
  assert.equal(/reasoning|assistant|transcript/u.test(text), false);
  bridge.decide({ requestId: view.requestId, answers: [
    { id: 'q1', selected: ['src/config only'] },
    { id: 'q2', selected: ['tests'] },
    { id: 'q3', selected: [], custom: 'out.txt' },
  ] });
  await waiting;
});

test('a single-select question may carry BOTH a selection and custom text', async () => {
  // The native tool documents `selected` as allowed to accompany custom text; only a
  // multi-selection is refused on a single-select question.
  const asked = [{ id: 'q', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }], multiSelect: false }];
  const verdict = validateAnswers(asked, [{ id: 'q', selected: ['a'], custom: 'and also this' }]);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.answers, [{ id: 'q', selected: ['a'], custom: 'and also this' }]);
  // Two labels on a single-select question is still refused.
  assert.equal(validateAnswers(asked, [{ id: 'q', selected: ['a', 'b'] }]).ok, false);
});

test('every answer rule is a refusal, and a refused answer leaves the question pending', async () => {
  const { bridge, agent } = armedBridge();
  const { waiting, view } = await askAndPending(bridge, agent);
  const cases = [
    [[{ id: 'q1', selected: ['x'] }, { id: 'q2', selected: ['tests'] }, { id: 'nope', selected: [], custom: 'y' }],
      QUESTION_REASONS.unknownQuestion],
    [[{ id: 'q1', selected: ['from my imagination'] }, { id: 'q2', selected: ['tests'] },
      { id: 'q3', selected: [], custom: 't' }], QUESTION_REASONS.unknownOption],
    [[{ id: 'q1', selected: ['src/config only', 'everything under src'] }, { id: 'q2', selected: ['tests'] },
      { id: 'q3', selected: [], custom: 't' }], QUESTION_REASONS.tooManySelected],
    [[{ id: 'q1', selected: ['src/config only'] }], QUESTION_REASONS.badBatch],
    [[{ id: 'q1', selected: ['src/config only'] }, { id: 'q1', selected: ['everything under src'] },
      { id: 'q2', selected: ['tests'] }, { id: 'q3', selected: [], custom: 't' }], QUESTION_REASONS.badBatch],
    [[{ id: 'q1', selected: ['src/config only'] }, { id: 'q2', selected: ['tests'] }, { id: 'q3', selected: [] }],
      QUESTION_REASONS.noSelection],
    [[{ id: 'q1', selected: ['src/config only'] }, { id: 'q2', selected: ['tests'] },
      { id: 'q3', selected: [], custom: '   ' }], QUESTION_REASONS.emptyCustom],
  ];
  for (const [answers, reason] of cases) {
    assert.throws(
      () => bridge.decide({ requestId: view.requestId, answers }),
      (error) => {
        assert.equal(error.code, QUESTION_CODES.answerInvalid, JSON.stringify(answers));
        assert.equal(error.details.reason, reason, JSON.stringify(answers));
        return true;
      },
    );
    assert.equal(bridge.pendingView()?.requestId, view.requestId, JSON.stringify(answers));
  }
  bridge.decide({ requestId: view.requestId, answers: [
    { id: 'q1', selected: ['src/config only'] }, { id: 'q2', selected: ['tests'] },
    { id: 'q3', selected: [], custom: 't' },
  ] });
  await waiting;
});

test('custom text is bounded and must be a string', () => {
  const asked = [{ id: 'a', question: 'x', options: [], multiSelect: false }];
  assert.equal(validateAnswers(asked, [{ id: 'a', selected: [], custom: 5 }]).ok, false);
  const long = validateAnswers(asked, [{ id: 'a', selected: [], custom: 'x'.repeat(QUESTION_BOUNDS.customChars + 1) }]);
  assert.equal(long.reason, QUESTION_REASONS.longCustom);
  assert.equal(validateAnswers(asked, [{ id: 'a', selected: [], custom: 'x'.repeat(QUESTION_BOUNDS.customChars) }]).ok, true);
});

// ---------------------------------------------------------------------------
// 5. A question is not an approval
// ---------------------------------------------------------------------------

test('an approval-intent question is REFUSED promptly with its own code, never answered', async () => {
  const { bridge, agent } = armedBridge();
  const failure = await bridge.answer({
    agent,
    questions: [{
      id: 'perm',
      question: 'Allow this command?',
      detail: 'danger-full-access for one call',
      options: [{ label: 'Allow' }, { label: 'Deny' }],
      intent: { kind: 'approval', approve: 'Allow', reject: 'Deny' },
    }],
  }).catch((error) => error);
  assert.ok(failure instanceof QuestionError);
  assert.equal(failure.code, QUESTION_CODES.approvalIntent);
  assert.equal(failure.details.channel, 'permission');
  assert.equal(bridge.pendingView(), null);
});

test('a plan-review question IS answerable, and grants nothing either', async () => {
  const { bridge, agent } = armedBridge();
  const { waiting, view } = await askAndPending(bridge, agent, [{
    id: 'plan',
    question: 'Approve this plan?',
    detail: '1. read\n2. write',
    options: [{ label: 'Approve' }, { label: 'Decline' }],
    intent: { kind: 'plan-review', approve: 'Approve' },
  }]);
  assert.equal(view.questions[0].intent, 'plan-review');
  assert.equal(view.grantsAccess, false);
  bridge.decide({ requestId: view.requestId, answers: [{ id: 'plan', selected: ['Approve'] }] });
  assert.deepEqual((await waiting).answers[0].selected, ['Approve']);
});

// ---------------------------------------------------------------------------
// 6. Lifecycle: single use, expiry, cancellation, teardown
// ---------------------------------------------------------------------------

test('an answer applies ONCE: repeating it is refused as already-answered', async () => {
  const { bridge, agent } = armedBridge();
  const { waiting, view } = await askAndPending(bridge, agent, [{ id: 'q', question: 'Which?', options: [{ label: 'a' }] }]);
  bridge.decide({ requestId: view.requestId, answers: [{ id: 'q', selected: ['a'] }] });
  await waiting;
  assert.throws(
    () => bridge.decide({ requestId: view.requestId, answers: [{ id: 'q', selected: ['a'] }] }),
    (error) => error.code === QUESTION_CODES.alreadyAnswered,
  );
});

test('an unknown request id is refused and cannot answer the live question', async () => {
  const { bridge, agent } = armedBridge();
  const { waiting, view } = await askAndPending(bridge, agent, [{ id: 'q', question: 'Which?', options: [{ label: 'a' }] }]);
  assert.throws(
    () => bridge.decide({ requestId: 'question-somebody-else-1', answers: [{ id: 'q', selected: ['a'] }] }),
    (error) => error.code === QUESTION_CODES.notPending,
  );
  bridge.decide({ requestId: view.requestId, answers: [{ id: 'q', selected: ['a'] }] });
  await waiting;
});

test('an unanswered question EXPIRES on its own finite deadline', async () => {
  // The default is finite: a question pauses the execution budget, so it must not hang.
  assert.ok(QUESTION_DEFAULT_TIMEOUT_MS > 0);
  const { bridge, agent } = armedBridge({ timeoutMs: 5 });
  const failure = await bridge.answer({
    agent, questions: [{ id: 'q', question: 'Which?', options: [{ label: 'a' }] }],
  }).catch((error) => error);
  assert.equal(failure.name, 'UserQuestionError');
  assert.equal(failure.code, 'ASK_TIMED_OUT');
  assert.equal(bridge.pendingView(), null);
  assert.equal(bridge.historyView()[0].state, 'expired');
});

test('the asking tool withdrawing its question releases the wait as cancelled', async () => {
  const { bridge, agent } = armedBridge();
  const controller = new AbortController();
  const waiting = bridge.answer({
    agent, questions: [{ id: 'q', question: 'Which?', options: [{ label: 'a' }] }], signal: controller.signal,
  }).catch((error) => error);
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  controller.abort();
  const settled = await waiting;
  assert.equal(settled.code, 'ASK_ABORTED');
  assert.equal(bridge.historyView()[0].state, 'cancelled');
});

test('stop and dispose release the waiter, and a later request is refused instead of hanging', async () => {
  const first = armedBridge();
  const pendingOne = first.bridge.answer({
    agent: first.agent, questions: [{ id: 'q', question: 'Which?', options: [{ label: 'a' }] }],
  }).catch((error) => error);
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  first.bridge.stop();
  assert.equal((await pendingOne).code, 'ASK_ABORTED');
  await assert.rejects(
    first.bridge.answer({ agent: first.agent, questions: [{ id: 'q', question: 'Again?', options: [{ label: 'a' }] }] }),
    (error) => error.code === QUESTION_CODES.unbound,
  );

  const second = armedBridge();
  const pendingTwo = second.bridge.answer({
    agent: second.agent, questions: [{ id: 'q', question: 'Which?', options: [{ label: 'a' }] }],
  }).catch((error) => error);
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  second.bridge.dispose();
  assert.equal((await pendingTwo).code, 'ASK_ABORTED');
  second.bridge.dispose();
});

test('a second question while one is pending is refused rather than queued behind it', async () => {
  const { bridge, agent } = armedBridge();
  const { waiting, view } = await askAndPending(bridge, agent, [{ id: 'q', question: 'First?', options: [{ label: 'a' }] }]);
  await assert.rejects(
    bridge.answer({ agent, questions: [{ id: 'q', question: 'Second?', options: [{ label: 'a' }] }] }),
    (error) => error.code === QUESTION_CODES.busy,
  );
  bridge.decide({ requestId: view.requestId, answers: [{ id: 'q', selected: ['a'] }] });
  await waiting;
});

test('an oversized or malformed question set is refused instead of publishing a shortened menu', async () => {
  const { bridge, agent } = armedBridge();
  const tooMany = Array.from({ length: QUESTION_BOUNDS.questions + 1 }, (_, index) => ({
    id: `q${index}`, question: 'Which?', options: [{ label: 'a' }],
  }));
  await assert.rejects(bridge.answer({ agent, questions: tooMany }), (error) => error.code === QUESTION_CODES.answerInvalid);
  const badOption = [{ id: 'q', question: 'Which?', options: [{ label: 'x'.repeat(QUESTION_BOUNDS.optionLabelChars + 1) }] }];
  await assert.rejects(bridge.answer({ agent, questions: badOption }), (error) => error.code === QUESTION_CODES.answerInvalid);
  await assert.rejects(bridge.answer({ agent, questions: [{ id: 'q', question: '   ' }] }), (error) => error.code === QUESTION_CODES.badIdentity);
  assert.equal(bridge.pendingView(), null);
});

test('projectQuestion keeps only what was asked, and needs an id and question text', () => {
  const projected = projectQuestion({
    id: 'x', question: 'Why?', header: 'H', detail: 'D',
    options: [{ label: 'a', description: 'b' }], multiSelect: true, intent: { kind: 'plan-review', approve: 'a' },
    reasoning: 'SECRET CHAIN OF THOUGHT', transcript: 'SECRET',
  });
  assert.equal(projected.intent, 'plan-review');
  assert.equal('reasoning' in projected, false);
  assert.equal('transcript' in projected, false);
  assert.equal(projectQuestion({ id: 'x', question: '' }), null);
  assert.equal(projectQuestion({ id: '', question: 'ok' }), null);
  assert.equal(projectQuestion({ question: 'no id' }), null);
  assert.equal(projectQuestion({ id: 'x', question: 'ok', options: [{}] }), null);
});

// ---------------------------------------------------------------------------
// 7. Degrading when the harness has no seam at all
// ---------------------------------------------------------------------------

test('without the native seam nothing is registered, so the run degrades instead of waiting', async () => {
  const ctx = new Context();
  ctx.on('user-questions/request', async () => {
    throw Object.assign(new Error('no user-questions answerer accepted the request'), {
      name: 'UserQuestionError', code: 'NO_PROVIDER',
    });
  }, { prepend: true });
  await assert.rejects(
    ctx.waterfall(fakeAgent(), 'user-questions/request', {
      questions: [{ id: 'q', question: 'Which?', options: [{ label: 'a' }] }],
    }, NO_ANSWERER),
    (error) => error.code === 'NO_PROVIDER',
  );
});
