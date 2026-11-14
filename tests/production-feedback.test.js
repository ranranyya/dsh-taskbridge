// The PRODUCTION composition: the plugin's own `apply` must hand the bridge the REAL native
// `createUserMessage`, and a rejection's reason must survive from the native inbox all the
// way into durable history.
//
// A test that stubbed `agent.inject` would prove nothing about production: the defect this
// file pins is that `apply` never passed a factory at all, so the bridge silently built a
// look-alike message instead of a natively normalised one.
//
// Everything here is driven through the real `apply` and the real `PermissionBridge` it
// creates, with a real `@deepseek-ai/dsh-llm` runtime providing the factory.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createUserMessage } from '@deepseek-ai/dsh-llm';

import * as entry from '../src/index.js';
import { HistoryStore } from '../src/jobs/history.js';
import { rejectionFeedbackText } from '../src/runtime/permissions.js';
import { approvalFeedbackMessage } from '../src/runtime/agent-runner.js';
import { makeTempDir, validSettings } from './helpers/fakes.js';

/**
 * Mount the real plugin through `apply` over a fresh data directory.
 * @returns {Promise<{ published: object, directory: string }>} the plugin face.
 */
async function mountPlugin() {
  const directory = await makeTempDir();
  const settingsDir = join(directory, 'dsh-delegate');
  await mkdir(settingsDir, { recursive: true, mode: 0o700 });
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify(validSettings()), 'utf8');

  const routes = new Map();
  // The approval service the bridge factory gates on: it only produces a bridge when the
  // harness can actually service an approval request.
  const approval = { async request() { return 'rejected'; } };
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    reflect: { provide: () => () => {} },
    events: { dispatch: () => [] },
    effect(effect) {
      if (typeof effect === 'function' && effect.constructor?.name !== 'GeneratorFunction') {
        const dispose = effect();
        return typeof dispose === 'function' ? dispose : () => {};
      }
      const iterator = effect.call(ctx);
      const first = iterator.next();
      return typeof first.value === 'function' ? first.value : () => {};
    },
    waterfall: () => Promise.resolve([]),
    get(name) {
      if (name === 'credentials') return null;
      if (name === 'agentPresets') return null;
      if (name === 'approval') return approval;
      return null;
    },
    provide() {},
    agents: { create: async () => ({}) },
    sessions: {},
    tools: {},
    webServer: { host: '127.0.0.1', port: 3210, register: () => () => {} },
    connection: {
      fetch: {
        register(route) {
          if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
  };
  const { LlmRuntime } = await import('@deepseek-ai/dsh-llm');
  ctx.llm = new LlmRuntime(ctx);

  const previousHome = process.env.DSH_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.DSH_HOME = directory;
  process.env.CODEX_HOME = join(directory, 'codex-home');
  let published = null;
  ctx.provide = (_name, value) => { published = value; };
  try {
    await entry.apply(ctx, { dataDir: directory });
  } finally {
    process.env.DSH_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
  return { published, directory, routes };
}

/**
 * A live Agent whose Session log holds one tool call, and which records its inbox.
 * @param {object} [options] - `callId`.
 * @returns {object} agent-shaped object.
 */
function injectableAgent(options = {}) {
  const callId = options.callId ?? 'call-1';
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { callId, name: 'bash', arguments: JSON.stringify({ command: 'x' }), turn: 1, step: 1 } },
  ];
  const injected = [];
  const session = { id: 'session-prod', header: { cwd: 'C:\\work' }, seq: events.length, eventAt: (index) => events[index] };
  return { id: 'session-prod', session, injected, inject(message) { injected.push(message); } };
}

test('the PRODUCTION factory injects the real native createUserMessage, not a look-alike', async () => {
  const { published, directory } = await mountPlugin();
  try {
    const bridge = published.deps.permissionBridge({ taskId: 'task-prod' });
    assert.ok(bridge !== null, 'the production factory produced a bridge');
    // The factory the bridge will use IS the native helper this test imported, so what the
    // worker receives is a message the native inbox normalised.
    assert.equal(bridge.createMessage, approvalFeedbackMessage);
    assert.equal(
      typeof bridge.createMessage('x').id,
      typeof createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user-approval' } }).id,
      'the factory returns a message with the native id shape',
    );

    const agent = injectableAgent();
    bridge.arm(agent);
    const waiting = bridge.answer({ agent, toolName: 'bash', callId: 'call-1', reason: 'need it' });
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    const pending = bridge.pendingView();
    bridge.decide({ requestId: pending.requestId, decision: 'reject', reason: 'shorten the command' });
    assert.equal(await waiting, 'rejected');

    assert.equal(agent.injected.length, 1);
    const message = agent.injected[0];
    // The native helper assigns an id and keeps the content as given; a locally built object
    // would have had no id at all, which is how this defect hid.
    assert.equal(typeof message.id, 'string');
    assert.equal(message.role, 'user');
    assert.deepEqual(message.content, [{ type: 'text', text: message.content[0].text }]);
    assert.match(message.content[0].text, /shorten the command/u);
  } finally {
    await published.history.dispose().catch(() => {});
    await published.sessionStore.dispose().catch(() => {});
    await published.engine.dispose().catch(() => {});
  }
  void directory;
});

test('the rejection note names the task, the request and the call so the worker can place it', () => {
  const text = rejectionFeedbackText(
    { taskId: 'task-9', requestId: 'permission-task-9-2', toolName: 'bash', callId: 'call-7' },
    'the evidence was shortened',
  );
  assert.match(text, /task task-9/u);
  assert.match(text, /request permission-task-9-2/u);
  assert.match(text, /call id call-7/u);
  assert.match(text, /the evidence was shortened/u);
});

test('the WHOLE chain keeps the feedback: bridge evidence, public view, durable history, reload', async () => {
  // One data directory, a real HistoryStore, and the message the native inbox received.
  const dir = await makeTempDir();
  const agent = injectableAgent();
  const bridge = new (await import('../src/runtime/permissions.js')).PermissionBridge({ taskId: 'task-chain' });
  bridge.arm(agent);
  const waiting = bridge.answer({ agent, toolName: 'bash', callId: 'call-1', reason: 'x' });
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  const pending = bridge.pendingView();
  bridge.decide({ requestId: pending.requestId, decision: 'reject', reason: 'narrow it' });
  await waiting;

  // (1) The bridge's own settled view carries the delivery fact and its text.
  const settled = bridge.historyView().at(-1);
  assert.equal(settled.rejectionFeedback.delivered, true);
  assert.equal(settled.rejectionFeedback.reason, 'delivered');
  assert.equal(settled.rejectionFeedback.text, agent.injected[0].content[0].text);

  // (2) Durable history keeps a bounded record of it, and a reload still reports it.
  const store = new HistoryStore(dir);
  await store.save({
    taskId: 'task-chain',
    state: 'running',
    phase: 'execute',
    permission: { bridged: true, waiting: false, pending: null, evidence: [settled], pausedExecutionMs: 0 },
  });
  const reloaded = (await store.load()).find((row) => row.taskId === 'task-chain');
  const stored = reloaded?.permission?.evidence?.[0]?.rejectionFeedback;
  assert.ok(stored !== null && stored !== undefined, 'the feedback survives the durable projection');
  assert.equal(stored.delivered, true);
  assert.equal(stored.reason, 'delivered');
  // The reason text is kept (bounded), because "why" is the whole point of the record.
  assert.match(JSON.stringify(stored), /narrow it/u);
  await store.dispose();
});

test('a failed injection is reported through the same chain, and never claims success', async () => {
  const dir = await makeTempDir();
  const agent = injectableAgent();
  agent.inject = () => { throw Object.assign(new Error('inbox closed'), { code: 'INBOX_CLOSED' }); };
  const { PermissionBridge } = await import('../src/runtime/permissions.js');
  const bridge = new PermissionBridge({ taskId: 'task-fail' });
  bridge.arm(agent);
  const waiting = bridge.answer({ agent, toolName: 'bash', callId: 'call-1' });
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  const pending = bridge.pendingView();
  bridge.decide({ requestId: pending.requestId, decision: 'reject', reason: 'no' });
  // The rejection still stands in the native vocabulary.
  assert.equal(await waiting, 'rejected');
  const settled = bridge.historyView().at(-1);
  assert.equal(settled.outcome, 'rejected');
  assert.equal(settled.rejectionFeedback.delivered, false);
  assert.equal(settled.rejectionFeedback.reason, 'inject-failed');
  assert.equal(settled.rejectionFeedback.text, undefined, 'a failed note has no text to claim');

  const store = new HistoryStore(dir);
  await store.save({
    taskId: 'task-fail',
    state: 'running',
    phase: 'execute',
    permission: { bridged: true, waiting: false, pending: null, evidence: [settled], pausedExecutionMs: 0 },
  });
  const reloaded = (await store.load()).find((row) => row.taskId === 'task-fail');
  const stored = reloaded?.permission?.evidence?.[0]?.rejectionFeedback;
  assert.equal(stored.delivered, false);
  assert.equal(stored.reason, 'inject-failed');
  await store.dispose();
});

test('profile-less fallback: the default message is a recognised native source, not an invented one', async () => {
  // The bridge's own fallback exists only for a harness-free import. It must still use a
  // source the native approval service already emits, never a plugin-private kind.
  const { defaultUserMessage } = await import('../src/runtime/permissions.js');
  const message = defaultUserMessage('hello');
  assert.equal(message.source.kind, 'user-approval');
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }]);
  // The native helper accepts the same source, which is what makes the fallback a
  // stand-in for the real factory rather than a different protocol.
  const native = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user-approval' } });
  assert.equal(native.source.kind, message.source.kind);
});
