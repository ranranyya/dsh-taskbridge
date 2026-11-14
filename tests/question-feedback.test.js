// R4: the commander's rejection REASON reaches the same Agent.
//
// The acceptance defect: a commander rejected a permission request with a reason
// explaining exactly what to fix ("the evidence was shortened — shorten the command and
// ask again"), and the reason was recorded only as history. The paused tool call resumed
// with the bare native outcome `rejected`, so the worker could not know why, and could not
// know that shortening the operation would let it ask again successfully.
//
// The native approval protocol CANNOT carry prose — `ApprovalService.request()` resolves
// one of the closed outcomes `allowed-once | rejected | cancelled | unavailable` — so the
// reason must travel on the channel that does carry prose into a model's next step: the
// Agent's own inbox, through `agent.inject(createUserMessage(...))`. That is the call the
// native approval service uses for its own policy notices and the one
// `dsh-user-questions` uses to steer a late answer.
//
// Every test here therefore asserts the ACTUAL INJECTION on the bound Agent object — not
// that a reason was stored. A stored reason with no injection is the bug.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PermissionBridge, rejectionFeedbackText, defaultUserMessage } from '../src/runtime/permissions.js';

/**
 * A live Agent stand-in that records what was injected into its inbox.
 *
 * `inject` is the native method the approval service itself calls, so recording its
 * argument is exactly "what the worker's next model step will see".
 * @param {string} id - session id.
 * @returns {object} agent-shaped object with an `injected` log.
 */
function injectableAgent(id = 'session-feedback') {
  const injected = [];
  const session = {
    id,
    header: { cwd: 'C:\\work' },
    seq: 0,
    eventAt() { return undefined; },
  };
  const agent = {
    id,
    session,
    injected,
    inject(message) { injected.push(message); },
  };
  return agent;
}

/**
 * A Session log holding one tool call, so `locateToolCall` can bind a request.
 * @param {object} args - the tool arguments.
 * @returns {object} session-shaped object.
 */
function sessionWithCall(args, callId = 'call-1') {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { callId, name: 'bash', arguments: JSON.stringify(args), turn: 1, step: 1 } },
  ];
  return { id: 'session-feedback', seq: events.length, eventAt: (index) => events[index] };
}

/**
 * Drive one bridge to a settled commander decision.
 * @param {string} decision - `reject` or `allow-once`.
 * @param {object} [options] - `reason`, `agent`.
 * @returns {Promise<{ bridge: object, agent: object, outcome: string, receipt: object }>} the run.
 */
async function decideOnce(decision, options = {}) {
  const agent = options.agent ?? injectableAgent();
  // The session the bridge reads must be the SAME object it is bound to, so the agent's
  // own session is the one carrying the tool call.
  agent.session = sessionWithCall({ command: 'Get-Content x', sandbox_permissions: 'danger-full-access' });
  const bridge = new PermissionBridge({ taskId: 'task-fb' });
  bridge.arm(agent);
  const waiting = bridge.answer({ agent, toolName: 'bash', callId: 'call-1', reason: 'I need wider access' });
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  const pending = bridge.pendingView();
  assert.ok(pending !== null, 'the fixture needs a pending request');
  bridge.decide({
    requestId: pending.requestId,
    decision,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(decision === 'allow-once' ? { fingerprint: pending.fingerprint } : {}),
  });
  const outcome = await waiting;
  const receipt = bridge.historyView().at(-1);
  return { bridge, agent, outcome, receipt };
}

test('a rejection reason is actually INJECTED into the same Agent', async () => {
  const reason = 'the evidence was shortened by a bound; shorten the command and ask again';
  const { agent, outcome, receipt } = await decideOnce('reject', { reason });
  // The rejection still happened, in the native vocabulary.
  assert.equal(outcome, 'rejected');
  // …and the reason really reached the worker's own inbox.
  assert.equal(agent.injected.length, 1, 'exactly one message was injected');
  const message = agent.injected[0];
  assert.equal(message.role, 'user');
  // The source is the one the native approval service itself emits for its policy notices,
  // so the message is a recognised producer's message rather than an invented kind.
  assert.equal(message.source.kind, 'user-approval');
  const body = message.content[0].text;
  // The exact reason the commander typed is in the message — this is the fact the report
  // said was missing.
  assert.equal(body.includes(reason), true, body);
  // The message frames it correctly and cannot be read as a grant.
  assert.match(body, /REJECTED/u);
  assert.match(body, /The rejection stands/u);
  assert.match(body, /NOT a new authorization/u);
  assert.match(body, /request approval again/u);
  assert.match(body, /standing sandbox mode are unchanged/u, 'the note must say the standing mode is unchanged');
  // The receipt records the delivery as a verified fact, with the text as evidence.
  assert.equal(receipt.rejectionFeedback.delivered, true);
  assert.equal(receipt.rejectionFeedback.reason, 'delivered');
  assert.equal(receipt.rejectionFeedback.text, body);
});

test('an allow and a non-commander settlement inject nothing', async () => {
  const allowed = await decideOnce('allow-once', { reason: 'fine for one call' });
  assert.equal(allowed.outcome, 'allowed-once');
  assert.equal(allowed.agent.injected.length, 0, 'an allow needs no explanation');
  assert.equal(allowed.receipt.rejectionFeedback, undefined);
});

test('the injected reason is REDACTED and bounded, exactly like the stored evidence', async () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123';
  const long = `fix the command: ${secret} ${'detail '.repeat(400)}`;
  const { agent, receipt } = await decideOnce('reject', { reason: long });
  const body = agent.injected[0].content[0].text;
  assert.equal(body.includes(secret), false, 'a credential in the reason must not reach the worker');
  // Bounded: the stored decision reason is capped, so the injected text cannot be longer
  // than that cap plus the fixed framing.
  assert.ok(body.length < 1_500, `the message is bounded (got ${body.length})`);
  assert.equal(receipt.rejectionFeedback.delivered, true);
});

test('a repeated reject cannot deliver the reason twice', async () => {
  const agent = injectableAgent();
  const { bridge } = await decideOnce('reject', { reason: 'shorten it', agent });
  assert.equal(agent.injected.length, 1);
  // The same request id again: the decided request is already settled, so a second
  // decision is refused — and no second injection can happen either.
  assert.throws(
    () => bridge.decide({ requestId: bridge.historyView().at(-1).requestId, decision: 'reject', reason: 'again' }),
  );
  assert.equal(agent.injected.length, 1, 'still exactly one delivery');
});

test('a fresh bridge over the same request does not re-deliver a settled note', async () => {
  // A plugin restart builds a new bridge. The settled request is history there too, so a
  // decision naming it is refused — and nothing is injected, which is the property that
  // makes "reject again after a restart" harmless.
  const agent = injectableAgent();
  await decideOnce('reject', { reason: 'first time', agent });
  assert.equal(agent.injected.length, 1);
  const fresh = new PermissionBridge({ taskId: 'task-fb' });
  fresh.arm(injectableAgent());
  assert.equal(fresh.pending, null);
});

test('an AGENT THAT CANNOT BE WRITTEN TO is reported as not delivered, and the rejection stands', async () => {
  const agent = injectableAgent();
  // The native inbox refuses the message. The rejection already happened, so the ONLY
  // honest outcomes are "the decision stands" plus "the note did not arrive".
  agent.inject = () => { throw Object.assign(new Error('inbox closed'), { code: 'INBOX_CLOSED' }); };
  const { outcome, receipt } = await decideOnce('reject', { reason: 'shorten the command', agent });
  assert.equal(outcome, 'rejected', 'the rejection is not undone by a failed note');
  // The settled evidence keeps the outcome in its own closed vocabulary, so the decision
  // is still readable as a rejection rather than as an unknown.
  assert.equal(receipt.outcome, 'rejected');
  assert.equal(receipt.rejectionFeedback.delivered, false);
  assert.equal(receipt.rejectionFeedback.reason, 'inject-failed');
  // It never claims delivery.
  assert.equal(receipt.rejectionFeedback.text, undefined);
});

test('an agent with no injectable inbox is reported, never claimed as fed back', async () => {
  const agent = injectableAgent();
  delete agent.inject;
  const { outcome, receipt } = await decideOnce('reject', { reason: 'no inbox here', agent });
  assert.equal(outcome, 'rejected');
  assert.equal(receipt.rejectionFeedback.delivered, false);
  assert.equal(receipt.rejectionFeedback.reason, 'no-injectable-agent');
});

test('the note names the exact tool call, so a worker knows WHICH call was refused', () => {
  const text = rejectionFeedbackText({ toolName: 'bash', callId: 'call-9' }, 'the path was not authorised');
  assert.match(text, /your bash call/u);
  assert.match(text, /call id call-9/u);
  assert.match(text, /the path was not authorised/u);
  // A decision without a reason still says so plainly instead of inventing one.
  const bare = rejectionFeedbackText({ toolName: 'write', callId: 'c1' }, null);
  assert.match(bare, /no reason was given/u);
});

test('the default message shape is a user message the native inbox accepts', () => {
  const message = defaultUserMessage('hello');
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }]);
  // The fallback carries no invented identity: production injects the real factory, which
  // normalises ids and roles. A hand-built object must not pretend to be that.
  assert.equal(message.id, undefined);
  assert.equal(message.source.kind, 'user-approval', 'a source the native approval service already emits');
});

test('a subsequent escalation is a NEW request with its own approval, and its own note', async () => {
  // The whole point of the feedback: after being told why, the worker may try again. That
  // attempt must be decided on its own — nothing is inherited from the rejected one. Each
  // run gets its OWN bridge (that is what the engine does), so a fresh bridge is the
  // honest model of "one more tool call in the same conversation".
  const agent = injectableAgent();
  const first = await decideOnce('reject', { reason: 'shorten the command', agent });
  assert.equal(agent.injected.length, 1);

  // The same Agent and Session, with a second, genuinely different call in its log.
  agent.session = sessionWithCall({ command: 'short', sandbox_permissions: 'danger-full-access' }, 'call-2');
  const bridge = new PermissionBridge({ taskId: 'task-fb' });
  bridge.arm(agent);
  const waiting = bridge.answer({ agent, toolName: 'bash', callId: 'call-2', reason: 'now shorter' });
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  const pending = bridge.pendingView();
  assert.ok(pending !== null, 'the second escalation is a real pending request');
  // A request id is a per-bridge sequence, so a fresh bridge reuses `-1`. The identity
  // that matters is the OPERATION: a different call with different arguments has a
  // different fingerprint, and a decision made for one can never apply to the other.
  assert.notEqual(pending.callId, first.receipt.callId, 'a new tool call');
  assert.notEqual(pending.fingerprint, first.receipt.fingerprint, 'a different operation is a different decision');
  bridge.decide({ requestId: pending.requestId, decision: 'reject', reason: 'still too broad' });
  const outcome = await waiting;
  assert.equal(outcome, 'rejected');
  assert.equal(agent.injected.length, 2, 'the second rejection carries its OWN reason');
  assert.match(agent.injected[1].content[0].text, /still too broad/u);
  assert.match(agent.injected[1].content[0].text, /call id call-2/u);
});
