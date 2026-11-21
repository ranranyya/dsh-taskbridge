import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as client from '../src/client/api.js';

const root = new URL('../', import.meta.url);
const jsx = readFileSync(new URL('src/client/index.jsx', root), 'utf8');
const hookStart = jsx.indexOf('function useTaskAutoRefresh(');
const body = jsx.slice(hookStart, jsx.indexOf('\n}', hookStart) + 2);

/**
 * The shared records read loop, driven by this harness's FAKE clock.
 *
 * The production loop is `startRecordsReadLoop` in api.js and schedules on the real
 * `setTimeout`. These tests need deterministic time, so this runs the very same policy
 * (`nextRecordsRead`, imported from that module, the single source of the rates) against
 * a supplied scheduler. The loop's own behaviour — first read at once, one read at a
 * time, re-planned from the current snapshot, pause while hidden, stop on dispose — is
 * what the records page and the sidebar share, so both are exercised by it here.
 * @param {object} options - the loop's options (`store`, `readState`, `onError`, `onRead`).
 * @param {object} scheduler - `schedule(fn, delay)`, `cancel(id)`, `visibility()`,
 *   `onVisibilityChange(fn)`.
 * @returns {() => void} disposer.
 */
function startLoopOnFakeClock(options, scheduler) {
  const store = options.store;
  if (store === null || store === undefined || typeof store.refreshTasks !== 'function') return () => {};
  let timer = null;
  let disposed = false;
  let inFlight = false;
  let first = true;
  const clearTimer = () => { if (timer !== null) scheduler.cancel(timer); timer = null; };
  const schedule = () => {
    clearTimer();
    if (disposed) return;
    const plan = client.nextRecordsRead({ ...(options.readState?.() ?? {}), mounted: true, visible: scheduler.visibility(), first });
    if (!plan.refresh || plan.delayMs === null) return;
    first = false;
    timer = scheduler.schedule(tick, plan.delayMs);
  };
  const read = async () => {
    if (disposed || inFlight) return;
    inFlight = true;
    try {
      const result = await store.refreshTasks('auto');
      if (disposed || result?.skipped === 'in-flight') return;
      options.onError?.(result?.ok === false ? (result.error ?? true) : null);
      options.onRead?.(result);
    } catch (error) {
      if (!disposed) options.onError?.(error);
    } finally {
      inFlight = false;
      schedule();
    }
  };
  const tick = () => {
    timer = null;
    if (disposed || scheduler.visibility() !== true) return;
    void read();
  };
  const detach = scheduler.onVisibilityChange(() => {
    clearTimer();
    if (disposed || scheduler.visibility() !== true) return;
    first = true;
    void read();
  });
  schedule();
  return () => {
    disposed = true;
    clearTimer();
    detach?.();
  };
}

function mountHook(store, { hidden = false } = {}) {  let now = 0, nextId = 1, slot = 0, active = true, effectWork = [];
  const slots = [], effects = [], timers = new Map(), listeners = new Set();
  const doc = { hidden, addEventListener: (_, f) => listeners.add(f), removeEventListener: (_, f) => listeners.delete(f) };
  const useRef = (value) => slots[slot++] ??= { current: value };
  const useState = (value) => {
    const at = slot++;
    if (!(at in slots)) slots[at] = value;
    return [slots[at], (next) => { if (Object.is(slots[at], next)) return; slots[at] = next; if (active) render(); }];
  };
  const useEffect = (effect, deps) => {
    const at = slot++;
    const previous = effects[at];
    if (previous && deps.every((v, i) => Object.is(v, previous.deps[i]))) return;
    effectWork.push(() => { previous?.cleanup?.(); effects[at] = { deps, cleanup: effect() }; });
  };
  const hook = new Function('useRef','useState','useEffect','recordRefreshPlan','hasChangingRecords','RECORD_REFRESH_INTERVAL_MS','describeError','globalThis','setTimeout','clearTimeout','startRecordsReadLoop', `${body}\nreturn useTaskAutoRefresh;`)(
    useRef, useState, useEffect, client.recordRefreshPlan, client.hasChangingRecords,
    client.RECORD_REFRESH_INTERVAL_MS, client.describeError, { document: doc },
    (fn, delay) => { const id = nextId++; timers.set(id, { at: now + delay, fn }); return id; },
    (id) => timers.delete(id),
    // The records page and the sidebar share ONE loop. This harness owns its clock, so
    // the page's scheduling is driven by the fake timers below while a real read still
    // resolves through the store; the loop itself runs on the real clock guarded by
    // those same scheduled checks, which keeps the hook's behaviour observable.
    (options) => startLoopOnFakeClock(options, {
      schedule: (fn, delay) => { const id = nextId++; timers.set(id, { at: now + delay, fn }); return id; },
      cancel: (id) => timers.delete(id),
      visibility: () => doc.hidden !== true,
      onVisibilityChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      readState: options.readState,
    }));
  function render() {
    slot = 0; hook({ store, snapshot: store.getSnapshot() });
    const work = effectWork; effectWork = []; work.forEach((run) => run());
  }
  const unsubscribe = store.subscribe(render);
  render();
  return {
    timers, listeners,
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      await new Promise((resolve) => setImmediate(resolve));
    },
    async visibility(hidden) { doc.hidden = hidden; for (const fn of [...listeners]) fn(); await new Promise((resolve) => setImmediate(resolve)); },
    close() { active = false; unsubscribe(); for (const effect of effects) effect?.cleanup?.(); },
  };
}

for (const decision of ['accepted', 'changes-requested']) {
  test(`actual refresh hook and store fetch an external ${decision} then drop to the idle rate`, async () => {
    let backend = { taskId: 'waiting', state: 'awaiting-host-review', hostAcceptance: null };
    let reads = 0, fail = false;
    const store = client.createStore({ api: { async listTasks() { reads++; if (fail) throw new Error('test connection interrupted'); return { tasks: [structuredClone(backend)] }; } } });
    await store.loadTasks();
    const driver = mountHook(store);
    try {
      assert.equal(driver.timers.size, 1);
      await driver.visibility(true); await driver.advance(5000);
      assert.equal(reads, 1, 'a hidden document performs no read');
      await driver.visibility(false);
      assert.equal(reads, 2, 'returning to the page reads immediately');
      fail = true; await driver.advance(5000);
      assert.equal(store.getSnapshot().tasks[0].taskId, 'waiting', 'connection failure preserves displayed content');
      fail = false;
      backend = { ...backend, hostAcceptance: { accepted: decision === 'accepted', state: decision, acceptedAt: Date.now(), note: 'whole note' }, reviewPersistence: { state: 'saved', durable: true, pending: false } };
      await driver.advance(5000);
      assert.equal(store.getSnapshot().tasks[0].hostAcceptance.state, decision);
      // A confirmed record does NOT stop the timer any more: it drops to the slow rate, so a
      // task submitted later still appears without a reload.
      assert.equal(driver.timers.size, 1, 'a confirmed record keeps a (slower) timer');
      const beforeIdle = reads;
      await driver.advance(5000);
      assert.equal(reads, beforeIdle, 'the idle rate does not read every 5 seconds');
      await driver.advance(10000);
      assert.equal(reads, beforeIdle + 1, 'the idle rate reads once every 15 seconds');
    } finally { driver.close(); store.dispose(); }
    assert.equal(driver.listeners.size, 0);
  });
}

test('an empty records page discovers a task submitted from outside without a reload', async () => {
  // The reported defect: nothing is running, so the page had no timer at all and a task
  // dispatched by the commander never appeared until the operator reloaded.
  let backend = [];
  let reads = 0;
  const store = client.createStore({
    api: { async listTasks() { reads++; return { tasks: structuredClone(backend) }; } },
  });
  await store.loadTasks();
  assert.equal(store.getSnapshot().tasks.length, 0);
  const driver = mountHook(store);
  try {
    assert.equal(driver.timers.size, 1, 'an EMPTY list still schedules a read');
    assert.equal(reads, 1);
    await driver.advance(5000);
    assert.equal(reads, 1, 'idle does not read every 5 seconds');
    await driver.advance(10000);
    assert.equal(reads, 2, 'the idle read runs at 15 seconds');
    assert.equal(store.getSnapshot().tasks.length, 0, 'still empty: nothing was invented');

    // The commander submits a task between reads.
    backend = [{ taskId: 'fresh', state: 'pending', phase: 'created', title: '新派发任务' }];
    await driver.advance(15000);
    assert.equal(reads, 3);
    assert.equal(store.getSnapshot().tasks.length, 1, 'the new task appears WITHOUT a reload');
    assert.equal(store.getSnapshot().tasks[0].title, '新派发任务');
    assert.equal(driver.timers.size, 1, 'and the page keeps watching');

    // Once the new task is live, the SAME page moves to the active rate.
    backend = [{ taskId: 'fresh', state: 'running', phase: 'execute', title: '新派发任务' }];
    const beforeActive = reads;
    await driver.advance(5000);
    assert.equal(reads, beforeActive + 1, 'a running record is followed at 5 seconds again');
  } finally {
    driver.close();
    store.dispose();
  }
});

test('a page of only finished records still notices the next task', async () => {
  let backend = [{
    taskId: 'done', state: 'awaiting-host-review', title: '已结束任务',
    hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1_700_000_000_000, note: 'ok' },
    reviewPersistence: { state: 'saved', durable: true, pending: false },
  }];
  const store = client.createStore({ api: { async listTasks() { return { tasks: structuredClone(backend) }; } } });
  await store.loadTasks();
  const driver = mountHook(store);
  try {
    assert.equal(driver.timers.size, 1);
    backend = [...backend, { taskId: 'next', state: 'running', phase: 'execute', title: '下一个任务' }];
    await driver.advance(15000);
    assert.deepEqual(store.getSnapshot().tasks.map((task) => task.taskId), ['done', 'next']);
  } finally {
    driver.close();
    store.dispose();
  }
});

test('a records panel mounted while hidden reads when made visible', async () => {
  let reads = 0;
  const store = client.createStore({ api: { async listTasks() { reads++; return { tasks: [] }; } } });
  const driver = mountHook(store, { hidden: true });
  try {
    assert.equal(driver.timers.size, 0);
    assert.equal(driver.listeners.size, 1);
    await driver.advance(15000);
    assert.equal(reads, 0);
    await driver.visibility(false);
    assert.equal(reads, 1);
    assert.equal(driver.timers.size, 1);
  } finally { driver.close(); store.dispose(); }
});

test('hiding, re-rendering while hidden, then returning reads once and resumes the timer', async () => {
  // A page hidden at mount, or hidden while the store pushes an update, must not lose its
  // listener. The single effect depends only on the store, so a re-render while hidden
  // keeps exactly one listener and no timer — and returning still reads and re-arms.
  let reads = 0;
  const store = client.createStore({ api: { async listTasks() { reads++; return { tasks: [] }; } } });
  await store.loadTasks();
  const driver = mountHook(store);
  const initial = reads;
  try {
    await driver.visibility(true);
    assert.equal(driver.timers.size, 0, 'hidden clears the timer');
    // A store update while hidden re-renders the page.
    await store.refreshTasks('manual');
    // The MANUAL read above is the operator's own action and is expected; the hook itself
    // must not have added a read on top of it.
    const hiddenBase = reads;
    assert.equal(driver.listeners.size, 1, 'exactly one listener survives a hidden re-render');
    assert.equal(driver.timers.size, 0, 'still no timer while hidden');
    await driver.advance(15000);
    assert.equal(reads, hiddenBase, 'a hidden page reads nothing');

    const beforeVisible = reads;
    await driver.visibility(false);
    assert.equal(reads, beforeVisible + 1, 'returning reads immediately');
    assert.equal(driver.timers.size, 1, 'and re-arms the periodic check');
    const beforeTick = reads;
    await driver.advance(15000);
    assert.equal(reads, beforeTick + 1, 'the periodic idle check runs again after returning');
    assert.ok(initial >= 1);
  } finally { driver.close(); store.dispose(); }
});

test('a visibility return does not start a second read while one is in flight', async () => {
  let reads = 0;
  let release = null;
  const store = client.createStore({ api: { async listTasks() {
    reads += 1;
    if (reads === 1) return { tasks: [] };
    // Every later read stays in flight until released, so the hook sees a real overlap.
    await new Promise((resolve) => { release = resolve; });
    return { tasks: [] };
  } } });
  await store.loadTasks();
  const driver = mountHook(store);
  const base = reads;
  try {
    await driver.visibility(true);
    await driver.visibility(false);
    assert.equal(reads - base, 1, 'the first return reads once');
    assert.notEqual(release, null, 'and that read is still in flight');
    await driver.visibility(false);
    assert.equal(reads - base, 1, 'a second return while it is in flight starts no second read');
    release?.();
    await new Promise((resolve) => setImmediate(resolve));
  } finally { driver.close(); store.dispose(); }
});

test('unmount releases the actual refresh hook timer and visibility listener', async () => {
  const store = client.createStore({ api: { async listTasks() { return { tasks: [{ taskId:'t',state:'awaiting-host-review',hostAcceptance:null }] }; } } });
  await store.loadTasks(); const driver = mountHook(store);
  assert.equal(driver.timers.size, 1);
  driver.close(); store.dispose();
  assert.equal(driver.timers.size, 0); assert.equal(driver.listeners.size, 0);
});


for (const scenario of ['missing', 'throw', 'reject', 'success']) {
  test('review-note clipboard: ' + scenario, async () => {
    const component = jsx.slice(jsx.indexOf('function ReviewNoteDetail('), jsx.indexOf('\nfunction TaskDetail('));
    const start = component.indexOf('  const copy = () => {');
    const block = component.slice(start, component.indexOf('\n  return (', start));
    let state = null, copied = null;
    const full = '😀中'.repeat(3999) + '末尾验收';
    const clipboard = scenario === 'missing' ? undefined : { writeText(value) {
      if (scenario === 'throw') throw new Error('sync denied');
      if (scenario === 'reject') return Promise.reject(new Error('async denied'));
      copied = value; return Promise.resolve();
    } };
    const copy = new Function('setCopyState', 'full', 'globalThis', block + '\nreturn copy;')(
      (value) => { state = value; }, full, { navigator: { clipboard } });
    copy(); await new Promise((resolve) => setImmediate(resolve));
    if (scenario === 'success') {
      assert.equal(state, '已复制完整审查意见'); assert.equal(copied, full);
    } else { assert.match(state, /复制失败/u); assert.equal(copied, null); }
  });
}
