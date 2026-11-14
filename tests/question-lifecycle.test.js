// R2 at the ENGINE level: the question is visible immediately, answerable once, and
// released by every path that ends a run.
//
// The bridge tests prove the wire contract. These prove the task lifecycle: that a pending
// question makes an observation answer `reason: 'question'` with the real questions (NOT
// `attention` ten minutes later), that the task stays `running` with phase
// `awaiting-question`, that an answer resumes the run, that a wrong or repeated answer is
// refused, and that cancel / switch-off / dispose release a paused worker instead of
// leaving it waiting.
//
// The engine is exercised through its OWN hooks and its OWN bridge factory, so what is
// tested is the wiring the plugin uses rather than a parallel implementation.

import test from 'node:test';
import assert from 'node:assert/strict';

import { QuestionBridge, QUESTION_CODES } from '../src/runtime/questions.js';
import { JobEngine, JOB_CODES, OBSERVE_TASK_REASONS, TASK_STATES } from '../src/jobs/engine.js';

/**
 * The engine's authorization stand-in: delegation is ON, and no task-level grant is
 * checked (the switch posture is what `decideQuestion` re-reads).
 * @returns {object} auth-shaped object.
 */
function openAuth() {
  return {
    assertTaskAuthorized() {},
    subscribe() { return () => {}; },
    isDelegationAuthorized() { return true; },
  };
}

/**
 * A minimal engine whose only interesting dependency is the question-bridge factory.
 *
 * The engine's admission path is not under test here (it needs native services and is
 * covered elsewhere); what IS under test is the question lifecycle, so the engine is
 * constructed and a task record is installed the way admission would leave it.
 * @param {object} [options] - `timeoutMs`.
 * @returns {{ engine: object, created: object[] }} the engine and the bridges it made.
 */
function engineWithQuestions(options = {}) {
  const created = [];
  const engine = new JobEngine({
    settings: { async read() { return { worker: {}, monitoring: {} }; } },
    auth: openAuth(),
    // The switch is ON: a question is answered only while the run is authorised, and this
    // fixture models a normal enabled deployment.
    delegationEnabled: true,
    locks: { acquire() { return { nonce: 'n' }; }, release() {}, releaseAll() {} },
    runGit: async () => ({ stdout: '', code: 0 }),
    questionBridge(request) {
      // The observers are the ENGINE's, and they are the whole point: they are what turn
      // a pending question into a task phase and a `question` observation. A test factory
      // that dropped them would be testing a bridge nobody is watching.
      const bridge = new QuestionBridge({
        taskId: request.taskId,
        timeoutMs: options.timeoutMs,
        onPending: request.onPending,
        onSettled: request.onSettled,
      });
      created.push(bridge);
      return bridge;
    },
    logger: { info() {}, warn() {} },
  });
  return { engine, created };
}

/**
 * Install one running task record, as admission would leave it.
 * @param {object} engine - the engine.
 * @param {object} [overrides] - fields to replace.
 * @returns {object} the task record.
 */
function installTask(engine, overrides = {}) {
  const task = {
    taskId: 'task-q',
    state: TASK_STATES.running,
    phase: 'execute',
    connectionId: 'local-mcp',
    sourcePath: 'C:\\work',
    executionPath: 'C:\\work',
    prompt: 'do the work',
    createdAt: Date.now(),
    startedAt: Date.now(),
    endedAt: null,
    controller: new AbortController(),
    cancelRequested: false,
    cancelledBy: null,
    authorization: 'switch',
    grantId: null,
    effective: {
      worker: { isolation: 'shared', maxParallelism: 1, providerId: 'relay', model: 'm', reasoningEffort: 'medium' },
      review: { enabled: false },
      conversation: {},
      monitoring: {},
      provenance: {},
    },
    route: { providerRoute: 'relay-native', model: 'm', reasoningEffort: 'medium' },
    reviewRoute: null,
    reviewRouteError: null,
    permission: { bridge: null, pending: null, evidence: [], pausedAt: null, pausedExecutionMs: 0 },
    question: { bridge: null, pending: null, evidence: [], pausedAt: null, pausedExecutionMs: 0 },
    execution: null,
    monitor: null,
    // A record with no executor: `dispose` must not wait for one, and `releaseTask`
    // marks this handled so a test pays no settle timeout.
    native: { started: true, settled: false, promise: null },
    settlement: null,
    ...overrides,
  };
  task.settled = new Promise((resolvePromise) => { task.settle = resolvePromise; });
  engine.tasks.set(task.taskId, task);
  return task;
}

/**
 * Release one task the way a real run would, so `engine.dispose()` has nothing to wait
 * for. `dispose` waits (boundedly) for a live native executor to confirm it stopped; a
 * record with no executor must say so, or every test here would pay that timeout.
 * @param {object} task - the task record.
 * @returns {void}
 */
function releaseTask(task) {
  task.native.settled = true;
  task.state = TASK_STATES.cancelled;
  task.settle?.();
}

/**
 * A live Agent whose Session log holds one open `ask_user_question` call.
 *
 * The bridge binds an answer to a REAL native call, so the fixture must provide one; a
 * session without a readable log is refused, which is the binding's whole purpose.
 * @param {string} callId - the call id.
 * @returns {object} agent-shaped object.
 */
function callableAgent(callId = 'call-q') {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { callId, name: 'ask_user_question', arguments: '{}', turn: 1, step: 1 } },
  ];
  const session = { id: 's1', header: { cwd: 'C:\\work' }, seq: events.length, eventAt: (index) => events[index] };
  return { id: 's1', session };
}

/** Ask one question through a task's own bridge, as the runner's answerer would.
 * @param {object} task - task record with an armed bridge.
 * @param {object[]} [questions] - questions to ask.
 * @returns {Promise<object>} the answer promise.
 */
function askOn(task, questions = [{ id: 'q1', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] }]) {
  const agent = task.question.bridge.agent;
  return task.question.bridge.answer({ agent, questions });
}

test('a pending question makes an observation answer `question` at once, with the real questions', async () => {
  const { engine, created } = engineWithQuestions();
  const task = installTask(engine);
  // The engine's own factory wiring: it hands the bridge the observers that keep the task
  // record honest. A bridge built directly would never publish a pending question, so the
  // factory — not the class — is what these tests drive.
  task.question.bridge = engine.createQuestionBridge(task);
  task.question.bridge.arm(callableAgent());

  const waiting = askOn(task);
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });

  // The task is still `running` — neither failed nor finished — with its own phase.
  assert.equal(task.state, TASK_STATES.running);
  assert.equal(task.phase, 'awaiting-question');
  assert.equal(created.length, 1);

  const observation = await engine.observeTask('task-q', { connectionId: 'local-mcp', waitMs: 1 });
  assert.equal(observation.reason, OBSERVE_TASK_REASONS.question,
    'the question is reported immediately, not after a silence threshold');
  assert.equal(observation.question.requestId, task.question.pending.requestId);
  assert.equal(observation.question.questions[0].question, 'Which?');
  assert.deepEqual(observation.question.questions[0].options.map((option) => option.label), ['a', 'b']);
  assert.equal(observation.question.grantsAccess, false);
  // The task summary is still the compact one: no transcript, no model text.
  assert.equal(observation.task.state, TASK_STATES.running);
  assert.equal(observation.task.phase, 'awaiting-question');
  assert.equal('text' in observation.task, false);

  // Answer it through the engine's own verb, which is what the route calls.
  const result = engine.decideQuestion({
    connectionId: 'local-mcp',
    taskId: 'task-q',
    requestId: observation.question.requestId,
    answers: [{ id: 'q1', selected: ['b'] }],
  });
  assert.equal(result.answer.requestId, observation.question.requestId);
  assert.equal(result.hostAcceptance, null, 'a question answer is never an acceptance');
  assert.deepEqual(await waiting, { answers: [{ id: 'q1', selected: ['b'] }] });
  // Back to execution, and the settled trail records the answer.
  assert.equal(task.phase, 'execute');
  assert.equal(task.question.pending, null);
  assert.equal(task.question.evidence.length, 1);
  assert.equal(task.question.evidence[0].state, 'answered');
  releaseTask(task);
  await engine.dispose();
});

test('the answer verb refuses another connection, a wrong id, a repeated answer and a terminal task', async () => {
  const { engine } = engineWithQuestions();
  const task = installTask(engine);
  task.question.bridge = engine.createQuestionBridge(task);
  task.question.bridge.arm(callableAgent());
  const waiting = askOn(task);
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  const requestId = task.question.pending.requestId;

  // Another connection is answered exactly like an unknown task: no discovery oracle.
  assert.throws(
    () => engine.decideQuestion({ connectionId: 'somebody-else', taskId: 'task-q', requestId, answers: [] }),
    (error) => error.code === JOB_CODES.taskNotFound,
  );
  // A wrong request id cannot answer the live one.
  assert.throws(
    () => engine.decideQuestion({ connectionId: 'local-mcp', taskId: 'task-q', requestId: 'question-other-1', answers: [{ id: 'q1', selected: ['a'] }] }),
    (error) => error.code === QUESTION_CODES.notPending,
  );
  // A valid answer applies once.
  engine.decideQuestion({ connectionId: 'local-mcp', taskId: 'task-q', requestId, answers: [{ id: 'q1', selected: ['a'] }] });
  await waiting;
  assert.throws(
    () => engine.decideQuestion({ connectionId: 'local-mcp', taskId: 'task-q', requestId, answers: [{ id: 'q1', selected: ['a'] }] }),
    (error) => error.code === QUESTION_CODES.alreadyAnswered,
  );
  // A terminal task has no pending question, and the refusal says so.
  task.state = TASK_STATES.cancelled;
  assert.throws(
    () => engine.decideQuestion({ connectionId: 'local-mcp', taskId: 'task-q', requestId, answers: [] }),
    (error) => error.code === QUESTION_CODES.questionSettled,
  );
  releaseTask(task);
  await engine.dispose();
});

test('an answer resumes the run, so the very next observation is a heartbeat again', async () => {
  const { engine } = engineWithQuestions();
  const task = installTask(engine);
  task.question.bridge = engine.createQuestionBridge(task);
  task.question.bridge.arm(callableAgent());
  const waiting = askOn(task);
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  engine.decideQuestion({
    connectionId: 'local-mcp', taskId: 'task-q', requestId: task.question.pending.requestId,
    answers: [{ id: 'q1', selected: ['a'] }],
  });
  await waiting;
  const after = await engine.observeTask('task-q', { connectionId: 'local-mcp', waitMs: 1 });
  assert.notEqual(after.reason, OBSERVE_TASK_REASONS.question, 'the answered question is no longer offered');
  assert.equal(after.question, null, 'no question block on an answer that carries none');
  releaseTask(task);
  await engine.dispose();
});

test('cancelling the task releases a paused question with a native refusal', async () => {
  const { engine } = engineWithQuestions();
  const task = installTask(engine);
  task.question.bridge = engine.createQuestionBridge(task);
  task.question.bridge.arm(callableAgent());
  const waiting = askOn(task).catch((error) => error);
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });

  engine.abortTask(task, 'operator');
  const refusal = await waiting;
  assert.equal(refusal.code, 'ASK_ABORTED', 'the worker is told the channel went away');
  assert.equal(task.question.pending, null);
  assert.equal(task.question.bridge.armed, false, 'the bridge accepts nothing after a stop');
  releaseTask(task);
  await engine.dispose();
});

test('disposing the engine releases a paused question as unavailable', async () => {
  const { engine } = engineWithQuestions();
  const task = installTask(engine);
  task.question.bridge = engine.createQuestionBridge(task);
  task.question.bridge.arm(callableAgent());
  const waiting = askOn(task).catch((error) => error);
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });

  releaseTask(task);
  await engine.dispose();
  const refusal = await waiting;
  assert.equal(refusal.code, 'ASK_ABORTED');
  assert.equal(task.question.pending, null);
});

test('a question that expires is settled and reported as no longer answerable', async () => {
  const { engine } = engineWithQuestions({ timeoutMs: 5 });
  const task = installTask(engine);
  task.question.bridge = engine.createQuestionBridge(task);
  task.question.bridge.arm(callableAgent());
  const failure = await askOn(task).catch((error) => error);
  assert.equal(failure.code, 'ASK_TIMED_OUT');
  const observation = await engine.observeTask('task-q', { connectionId: 'local-mcp', waitMs: 1 });
  assert.notEqual(observation.reason, OBSERVE_TASK_REASONS.question);
  assert.equal(task.question.evidence[0].state, 'expired');
  releaseTask(task);
  await engine.dispose();
});

test('a deployment with no question factory reports no bridge and never a question reason', async () => {
  const engine = new JobEngine({
    settings: { async read() { return { worker: {}, monitoring: {} }; } },
    auth: openAuth(),
    locks: { acquire() { return { nonce: 'n' }; }, release() {}, releaseAll() {} },
    runGit: async () => ({ stdout: '', code: 0 }),
  });
  const task = installTask(engine);
  assert.equal(engine.createQuestionBridge(task), null, 'no factory means no bridge');
  const observation = await engine.observeTask('task-q', { connectionId: 'local-mcp', waitMs: 1 });
  assert.notEqual(observation.reason, OBSERVE_TASK_REASONS.question);
  const view = engine.questionView(task);
  assert.equal(view.bridged, false);
  assert.equal(view.waiting, false);
  assert.equal(view.grantsAccess, false);
  releaseTask(task);
  await engine.dispose();
});
