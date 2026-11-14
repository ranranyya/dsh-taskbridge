// R2 at the execution plane: POST /tasks/question.
//
// The route is the only way a local caller can answer a paused question, so it is checked
// on its own terms: the connection identity comes from authentication (never the body, so
// a caller can only answer its OWN task), the body is a closed shape validated before the
// engine reads anything, the switch gates it like a submission, and it can never grant
// access.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createExecutionHandler, EXECUTION_PREFIX } from '../src/http/execution-plane.js';

/**
 * A handler over a recording engine.
 * @param {object} [options] - `authorized`, `answer`, `mode`.
 * @returns {{ handler: object, seen: object[] }} the handler and its calls.
 */
function planeWithQuestions(options = {}) {
  const seen = [];
  const engine = {
    authorizationMode: options.mode ?? 'switch',
    posture() { return { authorized: options.authorized !== false }; },
    async decideQuestion(request) {
      seen.push(request);
      if (options.answer instanceof Error) throw options.answer;
      return options.answer ?? {
        task: { taskId: request.taskId, state: 'running', phase: 'execute' },
        question: { bridged: true, waiting: false, pending: null, grantsAccess: false },
        answer: { requestId: request.requestId, taskId: request.taskId, answers: request.answers, answeredAt: 1 },
        hostAcceptance: null,
      };
    },
  };
  return { handler: createExecutionHandler({ engine, logger: null }), seen };
}

/**
 * Call one plane route with a minimal request/response pair.
 * @param {object} handler - the route handler.
 * @param {string} path - path under the execution prefix.
 * @param {object} body - JSON body.
 * @param {object} [options] - `connectionId`.
 * @returns {Promise<{ status: number, body: object }>} the answer.
 */
async function post(handler, path, body, options = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const req = {
    method: 'POST',
    url: `http://127.0.0.1:3210${EXECUTION_PREFIX}${path}`,
    headers: {
      host: '127.0.0.1:3210',
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:3210',
    },
    // The transport fence requires a loopback SOCKET, not only a loopback Host.
    socket: { remoteAddress: '127.0.0.1' },
    // The plane reads the body with `for await`, so the request is an async iterable.
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  };
  let status = 0;
  let text = '';
  const res = {
    headersSent: false,
    writeHead(code) { status = code; res.headersSent = true; return res; },
    end(chunk) { if (chunk !== undefined) text += chunk.toString('utf8'); },
    write(chunk) { text += chunk.toString('utf8'); },
  };
  await handler(req, res, { connection: { connectionId: options.connectionId ?? 'local-mcp' } });
  return { status, body: text === '' ? null : JSON.parse(text) };
}

const ANSWER = { taskId: 'task-1', requestId: 'question-task-1-1', answers: [{ id: 'q1', selected: ['yes'] }] };

test('the question route forwards the authenticated connection identity, not the body\'s', async () => {
  const { handler, seen } = planeWithQuestions();
  // The body's field set is CLOSED, so an attempt to name an owner is refused outright
  // rather than accepted-and-ignored: a caller must never believe it changed something.
  const injected = await post(handler, '/tasks/question', { ...ANSWER, connectionId: 'somebody-else' });
  assert.equal(injected.status, 400);
  assert.equal(injected.body.error.code, 'QUESTION_FIELD_UNKNOWN');
  assert.deepEqual(seen, [], 'a body naming an owner never reaches the engine');

  const clean = await post(handler, '/tasks/question', ANSWER);
  assert.equal(clean.status, 200);
  assert.deepEqual(seen, [{
    connectionId: 'local-mcp',
    taskId: 'task-1',
    requestId: 'question-task-1-1',
    answers: [{ id: 'q1', selected: ['yes'] }],
  }], 'the owner is the authenticated connection');
  assert.equal(clean.body.hostAcceptance, null, 'answering a question is never an acceptance');
});

test('the route refuses an unknown top-level or per-answer field instead of dropping it', async () => {
  const { handler, seen } = planeWithQuestions();
  const cases = [
    // A transport CONTROL field belongs to the MCP boundary, not to this route.
    [{ ...ANSWER, waitAfterAnswer: true }, 'QUESTION_FIELD_UNKNOWN'],
    [{ ...ANSWER, extra: 1 }, 'QUESTION_FIELD_UNKNOWN'],
    [{ ...ANSWER, answers: [{ id: 'q1', selected: ['a'], note: 'x' }] }, 'QUESTION_ANSWER_INVALID'],
    [{ ...ANSWER, answers: [{ id: 'q1', selected: ['a'], grant: true }] }, 'QUESTION_ANSWER_INVALID'],
  ];
  for (const [body, code] of cases) {
    const answer = await post(handler, '/tasks/question', body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.body.error.code, code, JSON.stringify(body));
  }
  assert.deepEqual(seen, [], 'a refused body never reaches the engine');
});

test('the route validates its body before the engine reads anything', async () => {
  const { handler, seen } = planeWithQuestions();
  const cases = [
    [{ requestId: 'r', answers: [] }, 'TASK_ID_REQUIRED'],
    [{ taskId: 't', answers: [] }, 'QUESTION_REQUEST_ID_REQUIRED'],
    [{ taskId: 't', requestId: 'r' }, 'QUESTION_ANSWERS_REQUIRED'],
    [{ taskId: 't', requestId: 'r', answers: ['x'] }, 'QUESTION_ANSWER_INVALID'],
    [{ taskId: 't', requestId: 'r', answers: [{ selected: ['a'] }] }, 'QUESTION_ANSWER_INVALID'],
    [{ taskId: 't', requestId: 'r', answers: [{ id: 'q', selected: 'a' }] }, 'QUESTION_ANSWER_INVALID'],
    [{ taskId: 't', requestId: 'r', answers: [{ id: 'q', selected: [1] }] }, 'QUESTION_ANSWER_INVALID'],
    [{ taskId: 't', requestId: 'r', answers: [{ id: 'q', custom: 5 }] }, 'QUESTION_ANSWER_INVALID'],
  ];
  for (const [body, code] of cases) {
    const answer = await post(handler, '/tasks/question', body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.body.error.code, code, JSON.stringify(body));
  }
  assert.deepEqual(seen, [], 'a refused body never reaches the engine');
});

test('a custom answer is forwarded, and an omitted selection becomes an empty list', async () => {
  const { handler, seen } = planeWithQuestions();
  await post(handler, '/tasks/question', {
    taskId: 'task-1', requestId: 'question-task-1-1', answers: [{ id: 'q1', custom: 'my own text' }],
  });
  assert.deepEqual(seen[0].answers, [{ id: 'q1', selected: [], custom: 'my own text' }]);
});

test('the question route is gated by the switch, like a submission', async () => {
  const { handler, seen } = planeWithQuestions({ authorized: false });
  const answer = await post(handler, '/tasks/question', ANSWER);
  assert.equal(answer.status, 403);
  assert.equal(answer.body.error.code, 'DELEGATION_DISABLED');
  assert.deepEqual(seen, [], 'a switched-off deployment applies no answer');
});

test('an engine refusal keeps its own code and status', async () => {
  const refusal = Object.assign(new Error('this task has no pending question'), { code: 'QUESTION_NOT_PENDING' });
  const { handler } = planeWithQuestions({ answer: refusal });
  const answer = await post(handler, '/tasks/question', ANSWER);
  // The plane maps an unknown code to a refusal carrying it, never to a success.
  assert.notEqual(answer.status, 200);
  assert.equal(answer.body.ok, false);
  assert.equal(answer.body.error.code, 'QUESTION_NOT_PENDING');
});
