// Settings auto-save + task-detail click behaviour (TB151 UI round).
//
// Two user-visible defects are pinned here, both at the STORE level (the part that owns
// the state machine and the transport, and the part that can be tested without a DOM):
//
//   A. The settings page used to require a manual "保存设置" click, and a save response
//      could replace the draft while the operator was still typing. Auto-save must:
//        * merge a burst of edits into ONE whole-document PUT;
//        * serialize PUTs (never two in flight) and take the body from the latest draft;
//        * never let a response overwrite edits made while it was in flight;
//        * keep an INVALID draft (last valid document stays live) and report the reason;
//        * report a failed save and keep the draft so the operator can fix it.
//
//   B. "详情" / "查看完整审查意见" appeared to do nothing. The detail click must show
//      loading, keep the previous detail visible, and report a refusal; a background list
//      refresh must never substitute a summary row for the open detail (which silently
//      emptied the fields the operator was reading).
//
// A DOM-level click test is not available in this repository (no jsdom / react-dom /
// testing-library dependency is installed), so the click path is exercised through the
// SAME handlers the buttons call, and the page's own subscriptions are asserted by
// reading the store the component subscribes to. See `.tb151-ui-delivery.md`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore, defaultDraft, draftFromSettings } from '../src/client/api.js';

/** A deferred promise. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A configured settings document the precheck accepts, as the host would serve it. */
function validSettingsDoc() {
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
    review: { enabled: false, providerId: null, model: null, reasoningEffort: null },
    authorization: { taskGrantTtlSeconds: 900, sessionGrantTtlSeconds: 14400 },
    monitoring: { selfCheckSeconds: 300, attentionSeconds: 600, repeatFailureThreshold: 3 },
    projectOverrides: {},
    presets: [],
    conversation: { mode: 'new' },
  };
}

/**
 * The host's normalized ANSWER for one PUT.
 *
 * The real user plane validates and stores exactly the document it received and echoes
 * it back; a double that answered with a DIFFERENT document would let a test assert
 * "saved" against values nobody sent. Every mock below answers with this.
 * @param {object} document - the body that was PUT.
 * @returns {Promise<object>} the `ok: true` envelope.
 */
async function echoDocument(document) {
  return { ok: true, settings: document };
}

/**
 * A store over a scripted settings transport.
 * @param {object} [options] - `putSettings`, `getTask`, `listTasks`, `saveDebounceMs`.
 * @returns {object} `{ store, puts, timers }`.
 */
function storeFixture(options = {}) {
  const puts = [];
  const timers = [];
  const api = {
    async getStatus() { return { ok: true }; },
    async getSettings() { return { ok: true, settings: validSettingsDoc() }; },
    async getNativeProviders() { return { ok: true, providers: [] }; },
    async listTasks() { return options.listTasks ? await options.listTasks() : { ok: true, tasks: [] }; },
    async getTask(taskId) { return await options.getTask(taskId); },
    async putSettings(document) {
      puts.push(document);
      return await options.putSettings(document);
    },
  };
  const store = createStore({
    api,
    now: () => 1_763_200_000_000,
    saveDebounceMs: options.saveDebounceMs ?? 5,
    // Deterministic scheduler: the test decides when the debounce fires.
    schedule: (fn, ms) => { const entry = { fn, ms, cancelled: false }; timers.push(entry); return entry; },
    cancelSchedule: (entry) => { entry.cancelled = true; },
  });
  return { store, puts, timers };
}

/** Fire every live debounce tick (only the newest one matters). */
async function flushTimers(timers) {
  for (const entry of timers.splice(0)) {
    if (entry.cancelled) continue;
    entry.fn();
  }
  // Let the microtask queue drain so the PUT promise chain settles.
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// A. Automatic saving
// ---------------------------------------------------------------------------

test('auto-save: a burst of edits merges into ONE whole-document PUT', async () => {
  const pending = deferred();
  const fixture = storeFixture({ putSettings: async () => pending.promise });
  const { store, puts, timers } = fixture;
  await store.loadSettings();
  assert.equal(store.getSnapshot().saveState, 'idle');

  // Three keystrokes land inside one debounce window.
  store.editDraft((draft) => { draft.worker.timeoutSeconds = 90; });
  store.editDraft((draft) => { draft.worker.timeoutSeconds = 900; });
  store.editDraft((draft) => { draft.worker.timeoutSeconds = 1700; });
  assert.equal(store.getSnapshot().saveState, 'pending');
  assert.equal(puts.length, 0, 'nothing is sent before the debounce window closes');

  await flushTimers(timers);
  assert.equal(puts.length, 1, 'the burst became exactly one PUT');
  assert.equal(puts[0].worker.timeoutSeconds, 1700, 'the body is the LATEST draft, not the first edit');
  assert.equal(store.getSnapshot().saveState, 'saving');

  pending.resolve(await echoDocument({ ...validSettingsDoc(), worker: { ...validSettingsDoc().worker, timeoutSeconds: 1700 } }));
  await flushTimers(timers);
  assert.equal(store.getSnapshot().saveState, 'saved');
  assert.equal(store.getSnapshot().dirty, false);
});

test('auto-save: an edit made while a PUT is in flight is not overwritten by the response', async () => {
  const first = deferred();
  let call = 0;
  const fixture = storeFixture({
    putSettings: async (document) => {
      call += 1;
      // The first answer resolves the deferred (the caller decides when); every answer
      // is the document the host received, so "saved" never refers to other values.
      return call === 1 ? await first.promise : await echoDocument(document);
    },
  });
  const { store, puts, timers } = fixture;
  await store.loadSettings();

  store.editDraft((draft) => { draft.worker.timeoutSeconds = 1200; });
  await flushTimers(timers);
  assert.equal(puts.length, 1);
  assert.equal(store.getSnapshot().saveState, 'saving');

  // The operator keeps typing while that PUT is outstanding.
  store.editDraft((draft) => { draft.worker.timeoutSeconds = 600; });
  assert.equal(store.getSnapshot().draft.worker.timeoutSeconds, 600, 'the newer edit is in the draft');
  assert.equal(store.getSnapshot().dirty, true, 'and the document is still dirty');

  // The FIRST response arrives with the OLD document (1200 — what the host stored for
  // that PUT); it must not clobber the newer draft.
  first.resolve({ ok: true, settings: { ...validSettingsDoc(), worker: { ...validSettingsDoc().worker, timeoutSeconds: 1200 } } });
  await flushTimers(timers);
  assert.equal(store.getSnapshot().draft.worker.timeoutSeconds, 600,
    'a response for an older generation never replaces the newer draft');
  assert.equal(store.getSnapshot().dirty, true, 'the newer edit is still unsaved');

  // The follow-up save is scheduled by the finishing PUT; one more debounce window
  // (the same one a real typist would wait out) sends the newer value.
  await flushTimers(timers);
  assert.equal(puts.length, 2, 'the outstanding edit is written by a follow-up PUT');
  assert.equal(puts[1].worker.timeoutSeconds, 600);
});

test('auto-save: PUTs are serialized even when several saves are requested at once', async () => {
  const gate = deferred();
  let inFlight = 0;
  let maxInFlight = 0;
  const fixture = storeFixture({
    putSettings: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await gate.promise;
      } finally {
        inFlight -= 1;
      }
    },
  });
  const { store, timers } = fixture;
  await store.loadSettings();
  store.editDraft((draft) => { draft.worker.timeoutSeconds = 1200; });
  await flushTimers(timers);
  // Three more explicit saves while the first is in flight.
  const results = await Promise.all([store.saveSettings(), store.saveSettings(), store.saveSettings()]);
  assert.equal(maxInFlight, 1, 'never two PUTs in flight at once');
  for (const result of results) assert.equal(result.ok, false, 'an overlapping request defers instead of racing');
  gate.resolve(await echoDocument({ ...validSettingsDoc(), worker: { ...validSettingsDoc().worker, timeoutSeconds: 1200 } }));
  await flushTimers(timers);
});

test('auto-save: an invalid draft is never sent, is kept for correction, and states the reason', async () => {
  const fixture = storeFixture({ putSettings: (document) => echoDocument(document) });
  const { store, puts, timers } = fixture;
  await store.loadSettings();
  const before = store.getSnapshot().settings;

  // An invalid value the local precheck refuses. The retired execution timeout is no
  // longer a control (and no longer prechecked), so the gate is demonstrated on a value
  // the page still shows: an attention interval that is not after the self-check.
  store.editDraft((draft) => { draft.monitoring = { ...draft.monitoring, attentionSeconds: 60 }; });
  await flushTimers(timers);

  assert.equal(puts.length, 0, 'an invalid draft is never PUT');
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.saveState, 'invalid');
  assert.ok(snapshot.saveProblems.length > 0, 'the exact precheck problem is published');
  assert.equal(snapshot.draft.monitoring.attentionSeconds, 60, 'the invalid draft is KEPT so it can be fixed');
  assert.deepEqual(snapshot.settings, before, 'the last valid document stays committed');

  // The operator fixes it: the next save succeeds.
  store.editDraft((draft) => { draft.monitoring = { ...draft.monitoring, attentionSeconds: 2400 }; });
  await flushTimers(timers);
  assert.equal(puts.length, 1);
  assert.equal(store.getSnapshot().saveState, 'saved');
});

test('auto-save: a retired legacy timeout is no longer a save gate', async () => {
  // The field is not shown and does not bound a run, so an old document holding an
  // out-of-range value must still be SAVABLE — the operator could neither see nor fix it.
  const fixture = storeFixture({ putSettings: (document) => echoDocument(document) });
  const { store, puts, timers } = fixture;
  await store.loadSettings();
  store.editDraft((draft) => {
    draft.worker.timeoutSeconds = 1;
    draft.worker.maxParallelism = 2;
  });
  await flushTimers(timers);
  assert.equal(puts.length, 1, 'the save is not blocked over a field the page no longer offers');
  assert.equal(store.getSnapshot().saveState, 'saved');
});

test('auto-save: a failed save is reported, keeps the draft, and a later fix saves', async () => {
  let attempt = 0;
  const fixture = storeFixture({
    putSettings: async (document) => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('the host refused'), { code: 'SETTINGS_INVALID' });
      return await echoDocument(document);
    },
  });
  const { store, puts, timers } = fixture;
  await store.loadSettings();

  store.editDraft((draft) => { draft.worker.maxParallelism = 2; });
  await flushTimers(timers);
  const failed = store.getSnapshot();
  assert.equal(failed.saveState, 'failed');
  assert.ok(failed.saveError !== null && failed.saveError !== undefined, 'the refusal itself is kept for display');
  assert.equal(failed.draft.worker.maxParallelism, 2, 'the draft survives a failed save');
  assert.equal(failed.dirty, true);

  store.editDraft((draft) => { draft.worker.maxParallelism = 3; });
  await flushTimers(timers);
  assert.equal(puts.length, 2, 'a corrected draft is retried');
  assert.equal(store.getSnapshot().saveState, 'saved');
});

test('auto-save: an immediate (switch/select) edit skips the debounce window', async () => {
  const fixture = storeFixture({ putSettings: (document) => echoDocument(document) });
  const { store, timers } = fixture;
  await store.loadSettings();
  store.editDraft((draft) => { draft.worker.isolation = 'shared'; }, { immediate: true });
  const [tick] = timers.slice(-1);
  assert.equal(tick.ms, 0, 'a discrete control is scheduled with no delay');
  await flushTimers(timers);
  assert.equal(store.getSnapshot().saveState, 'saved');
});

test('auto-save: discard is explicit and cancels a pending save', async () => {
  const fixture = storeFixture({ putSettings: (document) => echoDocument(document) });
  const { store, puts, timers } = fixture;
  await store.loadSettings();
  store.editDraft((draft) => { draft.worker.timeoutSeconds = 1500; });
  store.resetDraft();
  await flushTimers(timers);
  assert.equal(puts.length, 0, 'a discarded draft is never written');
  assert.equal(store.getSnapshot().dirty, false);
  assert.equal(store.getSnapshot().draft.worker.timeoutSeconds, 1800, 'the draft is the committed document again');
});

test('auto-save: the confirmed server document re-seeds the draft (no draft that disagrees with what was stored)', async () => {
  // The host normalizes: it may add/clamp a field. After a save that still covers the
  // newest edit, the draft must be the SERVER's document, not the operator's raw input.
  const fixture = storeFixture({
    putSettings: async (document) => ({
      ok: true,
      settings: { ...document, worker: { ...document.worker, timeoutSeconds: 3600 } },
    }),
  });
  const { store, timers } = fixture;
  await store.loadSettings();
  store.editDraft((draft) => { draft.worker.timeoutSeconds = 1700; });
  await flushTimers(timers);
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.saveState, 'saved');
  assert.equal(snapshot.dirty, false);
  assert.equal(snapshot.settings.worker.timeoutSeconds, 3600, 'the host answer is the stored truth');
  assert.equal(snapshot.draft.worker.timeoutSeconds, 3600,
    'and the draft is rebuilt from it, so the page never shows an unsaved value as saved');
});

test('auto-save: a monitoring edit rides the same serialized queue as the whole document', async () => {
  const gate = deferred();
  let puts = 0;
  const fixture = storeFixture({
    putSettings: async () => { puts += 1; return await gate.promise; },
  });
  const { store, timers } = fixture;
  await store.loadSettings();
  // A whole-document PUT is in flight …
  store.editDraft((draft) => { draft.worker.timeoutSeconds = 1200; });
  await flushTimers(timers);
  assert.equal(puts, 1);
  // … while a monitoring edit arrives. It becomes part of the SAME draft and is written
  // by the follow-up PUT — the narrow `/monitoring` route is not used at all any more,
  // so a whole-document write and a narrow write can never race each other.
  store.editDraft((draft) => {
    draft.monitoring = { ...(draft.monitoring ?? {}), selfCheckSeconds: 120, attentionSeconds: 300 };
  });
  gate.resolve({ ok: true, settings: validSettingsDoc() });
  await flushTimers(timers);
  await flushTimers(timers);
  assert.equal(puts, 2, 'the monitoring change was carried by the follow-up whole-document PUT');
});

test('auto-save: discarding DURING a save leaves the view settled and writes nothing new', async () => {
  // The UI disables the discard control while a save runs; the store must agree with it
  // if a caller reaches it anyway: no follow-up write, no re-seeded draft.
  const gate = deferred();
  let puts = 0;
  const fixture = storeFixture({
    putSettings: async () => { puts += 1; return (await gate.promise); },
  });
  const { store, timers } = fixture;
  await store.loadSettings();
  store.editDraft((draft) => { draft.worker.timeoutSeconds = 1200; });
  await flushTimers(timers);
  assert.equal(puts, 1);
  store.resetDraft();
  const discarded = store.getSnapshot();
  assert.equal(discarded.dirty, false, 'the discard is reflected immediately');
  assert.equal(discarded.saveState, 'idle');
  assert.equal(discarded.draft.worker.timeoutSeconds, 1800, 'and the draft is the committed document');
  // The in-flight answer lands afterwards: it must not re-seed the draft nor trigger a
  // second write for a value the operator already discarded.
  gate.resolve(await echoDocument({ ...validSettingsDoc(), worker: { ...validSettingsDoc().worker, timeoutSeconds: 1200 } }));
  await flushTimers(timers);
  await flushTimers(timers);
  assert.equal(puts, 1, 'a discarded draft is not written again');
  assert.equal(store.getSnapshot().draft.worker.timeoutSeconds, 1800,
    'and the discarded draft is not replaced by the old in-flight answer');
});

// ---------------------------------------------------------------------------
// B. Task detail / review note clicks
// ---------------------------------------------------------------------------

test('detail click: shows loading, then publishes the loaded detail', async () => {
  const pending = deferred();
  const fixture = storeFixture({
    getTask: async () => await pending.promise,
    listTasks: async () => ({ ok: true, tasks: [] }),
  });
  const { store } = fixture;

  // A click with a pending request must publish `taskDetailLoading` at once.
  const opening = store.openTask('task-1');
  assert.equal(store.getSnapshot().taskDetailLoading, true, 'the click registers visibly');
  assert.equal(store.getSnapshot().taskDetailError, null);

  pending.resolve({ ok: true, task: { taskId: 'task-1', title: 'one', state: 'running' } });
  await opening;
  assert.equal(store.getSnapshot().taskDetailLoading, false);
  assert.equal(store.getSnapshot().taskDetail.taskId, 'task-1');

  // A refused read: the previous detail stays visible AND the reason is published.
  const failing = deferred();
  const store2 = createStore({
    api: { async getTask() { return await failing.promise; } },
    now: () => 1,
  });
  const opening2 = store2.openTask('task-2');
  failing.reject(Object.assign(new Error('no such task'), { code: 'JOB_TASK_NOT_FOUND' }));
  const outcome = await opening2;
  assert.equal(outcome.ok, false);
  const snapshot2 = store2.getSnapshot();
  assert.equal(snapshot2.taskDetailLoading, false, 'the spinner stops on failure too');
  assert.ok(snapshot2.taskDetailError !== null, 'the refusal is published for the panel to show');
  assert.ok(snapshot2.notices.some((notice) => notice.level === 'error'), 'and it is also surfaced as a notice');
});

test('detail click: a background list refresh merges the row instead of emptying the open detail', async () => {
  const row = { taskId: 'task-9', title: 'nine', state: 'awaiting-host-review' };
  const full = {
    ...row,
    hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1, by: 'host', note: '完整审查意见正文'.repeat(30) },
    diff: { patchText: 'diff --git a b', files: [{ path: 'a.js', status: 'M' }] },
  };
  let listRows = [row];
  const store = createStore({
    api: {
      async getTask() { return { ok: true, task: full }; },
      async listTasks() { return { ok: true, tasks: listRows }; },
    },
    now: () => 1,
  });
  await store.openTask('task-9');
  assert.equal(store.getSnapshot().taskDetail.hostAcceptance.note.length > 0, true);

  // A background refresh returns only the summary row for this task.
  listRows = [{ taskId: 'task-9', title: 'nine', state: 'awaiting-host-review' }];
  await store.refreshTasks('auto');
  const detail = store.getSnapshot().taskDetail;
  assert.equal(detail.taskId, 'task-9');
  assert.ok(typeof detail.hostAcceptance?.note === 'string' && detail.hostAcceptance.note.length > 0,
    'the open detail keeps the review note a list row does not carry');
});

test('detail click: a stale response for an earlier row never replaces the newer selection', async () => {
  const slow = deferred();
  const fast = deferred();
  const store = createStore({
    api: {
      async getTask(taskId) {
        return await (taskId === 'old' ? slow.promise : fast.promise);
      },
    },
    now: () => 1,
  });
  const firstOpen = store.openTask('old');
  const secondOpen = store.openTask('new');
  fast.resolve({ ok: true, task: { taskId: 'new', title: 'new' } });
  await secondOpen;
  // The slow, older response lands afterwards.
  slow.resolve({ ok: true, task: { taskId: 'old', title: 'old' } });
  const stale = await firstOpen;
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.equal(store.getSnapshot().taskDetail.taskId, 'new', 'the newer selection survives the older response');
});
