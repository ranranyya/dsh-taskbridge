import test from 'node:test';
import assert from 'node:assert/strict';
import { QUESTION_CALL_BINDING } from '../src/runtime/question-call.js';
import { QuestionBridge, QUESTION_CODES } from '../src/runtime/questions.js';

function fixture() {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { callId: 'c', name: 'ask_user_question', turn: 1 } },
  ];
  const session = { id: 's', get seq() { return events.length; }, eventAt: (i) => events[i] };
  const agent = { session };
  const bridge = new QuestionBridge({ taskId: 'task-binding' });
  bridge.arm(agent);
  const request = { agent, wait: { callId: 'c' }, questions: [{ id: 'q', question: 'Which?' }] };
  return { events, session, agent, bridge, request };
}

test('DSH result.message.toolCallId and legacy result.callId both retire the native question', () => {
  for (const data of [{ message: { toolCallId: 'c' } }, { callId: 'c' }]) {
    const { events, session, bridge } = fixture();
    events.push({ type: 'tool/result', data });
    assert.equal(QUESTION_CALL_BINDING({ session, declaredCallId: 'c' }).ok, false);
    bridge.dispose();
  }
});

for (const mutation of ['new-turn', 'session-object', 'session-id']) {
  test(`an answer cannot resume a replaced question: ${mutation}`, async () => {
    const f = fixture();
    const waiting = f.bridge.answer(f.request).catch((error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    const id = f.bridge.pendingView().requestId;
    if (mutation === 'new-turn') {
      f.events.push({ type: 'turn/end' }, { type: 'turn/start', data: { turn: 2 } },
        { type: 'tool/call', data: { callId: 'c', name: 'ask_user_question', turn: 2 } });
    } else if (mutation === 'session-object') {
      f.agent.session = { ...f.session };
      assert.throws(() => f.bridge.arm(f.agent), (error) => error.code === QUESTION_CODES.unbound);
    } else {
      f.session.id = 'other';
    }
    assert.equal(f.bridge.callStillLive(f.bridge.pending), false);
    assert.throws(() => f.bridge.decide({ requestId: id, answers: [{ id: 'q', selected: [], custom: 'answer' }] }),
      (error) => error.code === QUESTION_CODES.callGone);
    assert.equal((await waiting).code, 'ASK_ABORTED');
    f.bridge.dispose();
  });
}

test('concurrent native questions cannot replace an already-published pending request', async () => {
  const { bridge, request } = fixture();
  const first = bridge.answer(request).catch((error) => error);
  const second = bridge.answer(request).catch((error) => error);
  assert.equal((await second).code, QUESTION_CODES.busy);
  assert.ok(bridge.pendingView());
  bridge.dispose();
  await first;
});

test('private option labels and ids are refused before a redacted question becomes answerable', async () => {
  for (const field of ['id', 'label']) {
    const { bridge, request } = fixture();
    const privateValue = 'sk-123456789012345678901234';
    request.questions = [{ id: field === 'id' ? privateValue : 'q', question: 'Which?',
      options: [{ label: field === 'label' ? privateValue : 'choice' }] }];
    await assert.rejects(bridge.answer(request), (error) => error.code === QUESTION_CODES.redacted);
    assert.equal(bridge.pendingView(), null);
    bridge.dispose();
  }
});
