// The question answerer must be REMOVED when its run ends, on every exit path.
//
// The defect: `installQuestionAnswerer` returned a disposer the runner ignored, and the
// `finally` block only cleaned up the approval answerer — so a finished run kept a listener
// on that Agent's context, and could keep answering that conversation's questions from a task
// that no longer runs. The approval path has always cleaned up in `finally`; the question
// path must do the same, and not merely at plugin dispose.
//
// These tests drive the REAL `runAgent` with a real Cordis context per Agent, so what is
// asserted is the listener set the runtime actually holds.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Context } from '@deepseek-ai/cordis';

import { QuestionBridge } from '../src/runtime/questions.js';
import { PermissionBridge } from '../src/runtime/permissions.js';
import { RUN_CODES, runAgent } from '../src/runtime/agent-runner.js';
import { fakeAgentPresets, fakeAgents, fakeSessionController, fakeWorkspaceController, nativePolicyServices } from './helpers/fakes.js';

const SELECTION = { providerRoute: 'relay-native', model: 'deepseek-chat', reasoningEffort: 'medium' };
const CWD = process.platform === 'win32' ? 'C:\\work\\listener' : '/work/listener';

/**
 * A Session log with one open turn holding one live `ask_user_question` call.
 * @param {string} callId - the call id.
 * @returns {object} session-shaped object.
 */
function questionSession(callId) {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { callId, name: 'ask_user_question', arguments: '{}', turn: 1, step: 1 } },
  ];
  return { id: `session-${callId}`, header: { cwd: CWD }, seq: events.length, eventAt: (index) => events[index] };
}

/**
 * The dependencies one delegated run needs, with a real Cordis context per Agent.
 * @returns {Promise<object>} deps plus the shared controllers.
 */
async function runnerDeps() {
  const services = await nativePolicyServices();
  const agents = fakeAgents({ respond: { text: 'done' } });
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({ workspaces, respond: { text: 'done' } });
  // A placed run gets its Agent from the session CONTROLLER's `resolveAgent`, not from
  // `agents.create`, so the Session is enriched there. Each Agent keeps its own listener log
  // (the fake registry's `ctx.on` records them), which is what makes a leftover listener
  // observable after the run.
  const contexts = new Map();
  const resolveOriginal = sessionController.resolveAgent.bind(sessionController);
  let created = 0;
  sessionController.resolveAgent = async (sessionId) => {
    const found = await resolveOriginal(sessionId);
    const agent = found?.agent;
    if (agent === undefined || agent === null) return found;
    if (contexts.has(agent)) return found;
    created += 1;
    // The two things the question bridge needs and the fake registry does not provide: a
    // stable Session `id`, and a readable `eventAt` log holding the live question call.
    const log = questionSession(`call-${created}`);
    agent.session = { ...agent.session, id: log.id, seq: log.seq, eventAt: log.eventAt };
    contexts.set(agent, agent.ctx);
    return found;
  };
  return {
    deps: {
      agents,
      agentPresets: fakeAgentPresets(),
      workspaces,
      sessionController,
      policyServices: () => services,
    },
    contexts,
    agents,
    sessionController,
  };
}

/**
 * How many `user-questions/request` listeners one context holds.
 * @param {object} ctx - the Agent's context.
 * @returns {number} listener count.
 */
function questionListeners(ctx) {
  return ctx.events?.dispatch
    ? (ctx.events.dispatch('user-questions/request', []).length ?? 0)
    : 0;
}

/**
 * Run one delegated turn carrying a question bridge.
 *
 * A placed run with an ARMED approval bridge is the ordinary delegated case (the stance is
 * `ask`, and its answerer is what makes that true), so one is supplied here; the question
 * bridge is the surface under test.
 * @param {object} deps - runner dependencies.
 * @param {object} [options] - `prompt`.
 * @returns {Promise<object>} the run result.
 */
async function runWithQuestionBridge(deps, options = {}) {
  const bridge = new QuestionBridge({ taskId: `task-${Math.random().toString(16).slice(2)}` });
  const permissionBridge = new PermissionBridge({ taskId: 'task-permission' });
  return await runAgent(deps, {
    prompt: options.prompt ?? 'do the delegated thing',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5_000,
    delegated: true,
    permissionBridge,
    questionBridge: bridge,
  }).then((result) => ({ result, bridge, permissionBridge }));
}

test('a COMPLETED run removes its question answerer, so the conversation gets its own back', async () => {
  const { deps, contexts } = await runnerDeps();
  const { result } = await runWithQuestionBridge(deps);
  assert.equal(result.outcome, 'completed', JSON.stringify(result.error));
  const [agent] = [...contexts.keys()];
  const ctx = contexts.get(agent);
  assert.equal(agent.listeners.some((entry) => entry.event === 'user-questions/request'), false,
    'no stale question listener may outlive the run');
  void ctx;
});

test('a CANCELLED run removes it too', async () => {
  const { deps, contexts } = await runnerDeps();
  const controller = new AbortController();
  const bridge = new QuestionBridge({ taskId: 'task-cancel' });
  const pending = runAgent(deps, {
    prompt: 'x',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5_000,
    delegated: true,
    questionBridge: bridge,
    signal: controller.signal,
  });
  controller.abort();
  const result = await pending;
  assert.notEqual(result.outcome, 'completed');
  const [agent] = [...contexts.keys()];
  assert.equal(agent.listeners.some((entry) => entry.event === 'user-questions/request'), false);
});

test('a FAILED run removes it as well', async () => {
  const { deps, contexts } = await runnerDeps();
  // The preset refuses to mount, so the run fails before its prompt.
  deps.agentPresets = { async mount() { throw new Error('no preset'); } };
  const result = await runAgent(deps, {
    prompt: 'x',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5_000,
    delegated: true,
    questionBridge: new QuestionBridge({ taskId: 'task-fail' }),
  }).catch((error) => ({ error }));
  assert.ok(result.error !== undefined || result.outcome !== 'completed');
  for (const agent of contexts.keys()) {
    assert.equal(agent.listeners.some((entry) => entry.event === 'user-questions/request'), false,
      'a failed run leaves no listener behind');
  }
});

test('SEVERAL turns on one Session: after each ends, no question listener is left behind', async () => {
  const { deps, contexts } = await runnerDeps();
  const leftovers = [];
  for (let turn = 0; turn < 3; turn += 1) {
    const { result } = await runWithQuestionBridge(deps, { prompt: `turn ${turn}` });
    assert.equal(result.outcome, 'completed', JSON.stringify(result.error));
    const [agent] = [...contexts.keys()];
    leftovers.push(agent.listeners.some((entry) => entry.event === 'user-questions/request'));
  }
  // Every turn was checked, and none ended with the listener still registered. Pushing the
  // observation makes the assertion non-vacuous: a loop that never ran would fail here.
  assert.equal(leftovers.length, 3);
  assert.deepEqual(leftovers, [false, false, false], 'no turn left a question listener behind');
});

test('a context that cannot register a listener is a REFUSAL, not a silent empty disposer', async () => {
  const { deps, sessionController } = await runnerDeps();
  // The Agent's context can register the APPROVAL answerer but not the question one. That is
  // the case the defect hid in: the question answerer must refuse rather than return an empty
  // disposer and let the run claim a channel it never wired.
  const resolveOriginal = sessionController.resolveAgent.bind(sessionController);
  let stripped = 0;
  sessionController.resolveAgent = async (sessionId) => {
    const found = await resolveOriginal(sessionId);
    if (found?.agent !== undefined && found.agent !== null) {
      const original = found.agent.ctx?.on?.bind(found.agent.ctx);
      found.agent.ctx = {
        logger: { warn() {} },
        // Only the approval event may be registered; the question event is refused, which is
        // exactly what a context that does not implement that seam does.
        on(event, listener, options) {
          if (event === 'user-questions/request') {
            throw Object.assign(new Error('unsupported event'), { code: 'EVENT_UNSUPPORTED' });
          }
          return typeof original === 'function' ? original(event, listener, options) : () => {};
        },
      };
      stripped += 1;
    }
    return found;
  };
  const failure = await runAgent(deps, {
    prompt: 'x',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5_000,
    delegated: true,
    permissionBridge: new PermissionBridge({ taskId: 'task-permission-noctx' }),
    questionBridge: new QuestionBridge({ taskId: 'task-no-ctx' }),
  }).catch((error) => error);
  assert.ok(failure instanceof Error, 'the run was refused');
  assert.equal(failure.code, RUN_CODES.questionBridgeUnavailable);
  assert.equal(stripped, 1, 'the refusal came from the context that could not register');
});
