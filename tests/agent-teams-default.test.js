// EXEC-1.6.1 — the operator's Agent Teams default for NEW tasks, and the record it produces.
//
// The product rule under test, in one sentence: the user controls ONE default, it decides
// only what a new task does when its dispatcher states no per-task choice, an explicit
// per-task choice always wins, a continuation keeps its chain's decision, and the record
// says WHERE each decision came from instead of presenting a default as a request.
//
// These are the client/contract halves of that rule: the draft round-trip (so the page can
// show and save it), the precheck, the narrow write, the task-detail wording and the MCP
// wait answer. The engine half lives in `agent-teams.test.js`.

import test from 'node:test';
import { codexRuleText } from './helpers/codex-rule-files.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  AGENT_TEAMS_DEFAULT_FOR_NEW_TASKS,
  AGENT_TEAMS_ORIGIN_LABELS,
  ROUTES,
  createStore,
  defaultDraft,
  documentFromDraft,
  draftFromSettings,
  executionOf,
  precheckDraft,
} from '../src/client/api.js';

/** A configured settings document the precheck accepts, as the host would serve it. */
function validSettingsDoc(extra = {}) {
  return {
    schemaVersion: 1,
    delegationEnabled: false,
    providers: [{
      id: 'relay',
      name: 'Relay',
      source: 'native',
      models: [{ id: 'm', efforts: ['high'] }],
    }],
    worker: {
      providerId: 'relay',
      model: 'm',
      reasoningEffort: 'high',
      timeoutSeconds: 1800,
      maxParallelism: 1,
      isolation: 'worktree',
    },
    authorization: { taskGrantTtlSeconds: 900, sessionGrantTtlSeconds: 14400 },
    monitoring: { selfCheckSeconds: 300, attentionSeconds: 600, repeatFailureThreshold: 3 },
    projectOverrides: {},
    presets: [],
    conversation: { mode: 'new' },
    ...extra,
  };
}

test('a draft from a document that predates the block opens the default OFF', () => {
  // `validSettingsDoc()` has no `execution` key: this is the upgraded-install shape.
  const draft = draftFromSettings(validSettingsDoc());
  assert.deepEqual(draft.execution, { agentTeamsDefault: false });
  assert.equal(AGENT_TEAMS_DEFAULT_FOR_NEW_TASKS, false, 'and that is the documented default');
});

test('a fresh draft and the served value agree, so the control never shows a phantom edit', () => {
  assert.deepEqual(defaultDraft().execution, { agentTeamsDefault: false });
  const on = draftFromSettings(validSettingsDoc({ execution: { agentTeamsDefault: true } }));
  assert.deepEqual(on.execution, { agentTeamsDefault: true });
  const off = draftFromSettings(validSettingsDoc({ execution: { agentTeamsDefault: false } }));
  assert.deepEqual(off.execution, { agentTeamsDefault: false });
});

test('an explicit OFF round-trips as OFF instead of being re-defaulted', () => {
  const doc = documentFromDraft({ ...draftFromSettings(validSettingsDoc()), execution: { agentTeamsDefault: false } });
  assert.deepEqual(doc.execution, { agentTeamsDefault: false });
  const onDoc = documentFromDraft({ ...draftFromSettings(validSettingsDoc()), execution: { agentTeamsDefault: true } });
  assert.deepEqual(onDoc.execution, { agentTeamsDefault: true });
});

test('a hand-edited non-boolean is refused by the precheck instead of silently reading as OFF', () => {
  const draft = { ...draftFromSettings(validSettingsDoc()), execution: { agentTeamsDefault: 'yes' } };
  const problems = precheckDraft(draft);
  assert.ok(
    problems.some((line) => line.includes('新任务默认开启智能体协作')),
    `the problem is stated in the operator's language: ${JSON.stringify(problems)}`,
  );
  // And the same document is refused on the way out, so a bad value never reaches the host.
  assert.equal(executionOf({ execution: { agentTeamsDefault: 'yes' } }).agentTeamsDefault, 'yes');
});

test('the narrow execution route exists and is the only write for this block', () => {
  assert.equal(ROUTES.execution, `${ROUTES.settings.split('/settings')[0]}/execution`);
  assert.notEqual(ROUTES.execution, ROUTES.settings, 'it is NOT the whole-document write');
  assert.notEqual(ROUTES.execution, ROUTES.delegation, 'and it is NOT the local-call switch');
});

test('saving the default writes through the narrow route and adopts the committed document', async () => {
  const puts = [];
  const api = {
    async getStatus() { return { ok: true }; },
    async getSettings() { return { ok: true, settings: validSettingsDoc() }; },
    async getNativeProviders() { return { ok: true, providers: [] }; },
    async listTasks() { return { ok: true, tasks: [] }; },
    async putSettings() { throw new Error('the whole document must not be rewritten by this control'); },
    async putExecution(execution) {
      puts.push(execution);
      // The host validates and echoes the committed document, exactly as the real route does.
      return {
        ok: true,
        execution: { ...execution },
        settings: validSettingsDoc({ execution: { ...execution } }),
      };
    },
  };
  const store = createStore({ api, now: () => 1_763_200_000_000, saveDebounceMs: 5 });
  await store.loadSettings();
  const outcome = await store.saveAgentTeamsDefault(true);
  assert.equal(outcome.ok, true);
  assert.deepEqual(puts, [{ agentTeamsDefault: true }], 'one narrow write, only this block');
  assert.deepEqual(store.getSnapshot().settings.execution, { agentTeamsDefault: true });
  assert.deepEqual(store.getSnapshot().draft.execution, { agentTeamsDefault: true });
});

test('a non-boolean is refused locally, so no request is sent for it', async () => {
  const puts = [];
  const api = {
    async getStatus() { return { ok: true }; },
    async getSettings() { return { ok: true, settings: validSettingsDoc() }; },
    async getNativeProviders() { return { ok: true, providers: [] }; },
    async listTasks() { return { ok: true, tasks: [] }; },
    async putExecution(execution) { puts.push(execution); return { ok: true, execution }; },
  };
  const store = createStore({ api, now: () => 1_763_200_000_000, saveDebounceMs: 5 });
  await store.loadSettings();
  const outcome = await store.saveAgentTeamsDefault('on');
  assert.equal(outcome.ok, false);
  assert.deepEqual(puts, [], 'nothing was sent');
});

test('the three origins are distinguishable and each has operator-readable wording', () => {
  assert.deepEqual(
    Object.keys(AGENT_TEAMS_ORIGIN_LABELS).sort(),
    ['continuation', 'request', 'settings-default'],
  );
  for (const [key, label] of Object.entries(AGENT_TEAMS_ORIGIN_LABELS)) {
    assert.equal(typeof label, 'string', `${key} has wording`);
    assert.ok(label.length > 0, `${key} wording is not empty`);
  }
  // The default wording must not read like something the dispatcher asked for.
  assert.ok(AGENT_TEAMS_ORIGIN_LABELS['settings-default'].includes('默认'));
});

test('a wait answer carries the origin, and a compact row never invents one', async () => {
  const { compactTask } = await import('../src/mcp/wait.js');
  const withOrigin = compactTask({
    taskId: 't1', state: 'running', agentTeams: false, agentTeamsOrigin: 'settings-default',
    team: { requested: false, supported: true, applied: true, enabled: false, reason: null },
  });
  assert.equal(withOrigin.agentTeamsOrigin, 'settings-default');
  // An older host never sent the field: the wait answer says nothing rather than "request".
  const legacy = compactTask({ taskId: 't2', state: 'running', agentTeams: true });
  assert.equal('agentTeamsOrigin' in legacy, false, 'an absent origin stays absent, not guessed');
});

test('the submit tool documents user control, per-task precedence and the continuation rule', async () => {
  const { TOOLS } = await import('../src/mcp/server.js');
  const submit = TOOLS.find((entry) => entry.name === 'delegate_submit');
  const description = submit.inputSchema.properties.agentTeams.description;
  assert.ok(description.includes('operator'), 'the operator owns the default');
  assert.ok(description.includes('wins over'), 'an explicit choice wins over the default');
  assert.ok(description.includes('continueFromTaskId'), 'a follow-up keeps its chain');
  assert.ok(description.includes('agentTeamsOrigin'), 'the origin is reported');
  // A follow-up whose parent recorded nothing writes nothing.
  assert.ok(description.includes('recorded none'), 'the no-recorded-choice case is stated');
  // An explicit value on a host without the capability is refused, not downgraded.
  assert.ok(description.includes('REFUSED'), 'the refusal is stated');
  assert.ok(description.includes('not applied'), 'and the implicit default is reported honestly');
  // The old blanket advice ("send false by habit") is exactly what must be gone.
  assert.equal(description.includes('should stay `false`'), false,
    'the rule no longer tells a dispatcher to send false by default');
});

test('the template says a follow-up with no recorded choice writes nothing, and refuses both explicit values', () => {
  const text = codexRuleText().replace(/\s+/gu, ' ');
  // Rule 4a: the continuation-with-no-record case applies nothing at all.
  assert.match(text, /if that task recorded no choice at all[\s\S]{0,120}writes nothing/u);
  assert.match(text, /the Session keeps\s+the mode it already has/u);
  // Rule 4a: BOTH explicit values are refused when the capability is missing.
  assert.match(text, /an explicit `true` OR an explicit `false`[\s\S]{0,80}stops BEFORE the prompt/u);
  // And the implicit default must never be described as "off".
  assert.match(text, /`applied: false` \(NOT\s+"off"\)/u);
  assert.match(text, /Do not describe that run as\s+"teams turned off"/u);
});

test('the settings card states the no-recorded-choice continuation rule and the refusal matrix', () => {
  const source = readFileSync(new URL('../src/client/index.jsx', import.meta.url), 'utf8');
  // The typo the host flagged must not come back.
  assert.equal(source.includes('已经开始的任保留'), false, 'the typo is fixed');
  assert.ok(source.includes('已经开始的任务保留'), 'and the corrected wording is present');
  // The card must state that a continuation with no recorded choice writes nothing.
  assert.ok(source.includes('原任务没有记录过（旧记录）'), 'the no-record case is explained');
  assert.ok(source.includes('不套用这里的默认、也不写入任何协作值'), 'and says nothing is written');
  // And it must not promise that only "on" is refused.
  assert.ok(source.includes('明确的开/关都会在发送提示词之前被拒绝'), 'both explicit values are refused');
  assert.ok(source.includes('未应用'), 'the implicit default is reported as not applied');
});
