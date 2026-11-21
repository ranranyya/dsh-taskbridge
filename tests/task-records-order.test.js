// The 最近任务 table's default order, pinned as a property of the row projection.
//
// The table sorts by the host's own activity timestamp — no client-side invention of
// a "different" time — and several records can legitimately share one timestamp (a
// batch submitted at the same instant). The order must therefore also be decided by
// the records' own identities, so a re-read that returns the same records in another
// array order still draws exactly the same table, and an ascending sort is the exact
// mirror of the descending one.
//
// Rendered for real below: the built bundle, real React, real DOM clicks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3210/',
    pretendToBeVisual: true,
  });
  const keys = ['window', 'document', 'navigator', 'MouseEvent', 'Event', 'Node', 'KeyboardEvent', 'HTMLElement'];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const define = (key, value) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  define('window', dom.window);
  define('document', dom.window.document);
  define('navigator', dom.window.navigator);
  define('MouseEvent', dom.window.MouseEvent);
  define('Event', dom.window.Event);
  define('KeyboardEvent', dom.window.KeyboardEvent);
  define('Node', dom.window.Node);
  define('HTMLElement', dom.window.HTMLElement);
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  return {
    dom,
    restore() {
      for (const key of keys) {
        const descriptor = previous.get(key);
        if (descriptor === undefined) delete globalThis[key];
        else Object.defineProperty(globalThis, key, descriptor);
      }
      dom.window.close();
    },
  };
}

async function loadClient() {
  const react = await import('react');
  const jsxRuntime = await import('react/jsx-runtime');
  const reactDomClient = await import('react-dom/client');
  const { readFileSync } = await import('node:fs');
  const { dirname, join, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { createContext, runInContext } = await import('node:vm');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
  const registrations = [];
  const window = { __ModuleLoader__: { load(registration) { registrations.push(registration); } } };
  const sandbox = { window, setTimeout, clearTimeout, setInterval, clearInterval, console, Date, Math, JSON };
  sandbox.globalThis = sandbox;
  runInContext(bundle, createContext(sandbox));
  if (registrations.length !== 1) throw new Error('lib/client.js must register exactly one module');
  const require = (specifier) => {
    if (specifier === 'react') return react;
    if (specifier === 'react/jsx-runtime') return jsxRuntime;
    throw new Error(`lib/client.js requested an unexpected module ${JSON.stringify(specifier)}`);
  };
  return { react, reactDomClient, client: registrations[0].factory(require) };
}

async function settle(act, store) {
  const flush = async () => {
    for (let index = 0; index < 30; index += 1) {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 2); });
    }
    if (store !== undefined && store !== null) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const loading = store.getSnapshot().loading ?? {};
        if (Object.values(loading).every((value) => value !== true)) break;
        await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
      }
      for (let index = 0; index < 6; index += 1) {
        await new Promise((resolvePromise) => { setTimeout(resolvePromise, 2); });
      }
    }
  };
  if (typeof act === 'function' && globalThis.IS_REACT_ACT_ENVIRONMENT === true) {
    await act(flush);
    return;
  }
  await flush();
}

const TIE_AT = 1_763_200_900_000;

/**
 * Independent standalone tasks, each in its OWN tree root, in a given array order.
 *
 * The rows are the host's `/tasks` shape. The tree roots below are written out here
 * rather than through `buildTaskTree` because that projection recomputes a chain's
 * activity from the round's `startedAt`; this test needs the timestamps it states to
 * reach the table unchanged, so it states the whole chain object.
 * @param {object[]} rows - `{ taskId, createdAt, updatedAt }`.
 * @returns {object} a `/tasks`-shaped body.
 */
async function tasksBodyOf(rows) {
  const tasks = rows.map(({ taskId, createdAt, updatedAt }) => ({
    taskId,
    title: `任务 ${taskId}`,
    state: 'awaiting-host-review',
    phase: 'awaiting-host-review',
    createdAt,
    startedAt: createdAt,
    activity: { lastActivityAt: Math.max(createdAt, updatedAt) },
    archived: false,
    live: true,
    hostAcceptance: null,
  }));
  return {
    ok: true,
    tasks,
    plans: { available: false, count: 0, reason: 'PLAN_UNAVAILABLE' },
    tree: {
      // Built by hand, one root per standalone task, so the 最近活动 column reads the
      // timestamps this test states. `buildTaskTree` derives a chain's activity from
      // the round's own `startedAt`, which would rewrite deliberate ties.
      roots: rows.map(({ taskId, createdAt, updatedAt }) => ({
        kind: 'task',
        nodeId: taskId,
        title: `任务 ${taskId}`,
        displayTitle: `任务 ${taskId}`,
        parentNodeId: null,
        nodeStatus: 'awaiting-host-review',
        chain: { chainId: taskId, rounds: [], roundCount: 1, displayTitle: `任务 ${taskId}`,
          nodeStatus: 'awaiting-host-review', createdAt, updatedAt },
        rounds: [],
        children: [],
        orphan: null,
        projectKey: 'unverified',
        createdAt: updatedAt,
        updatedAt,
      })),
      flatNodes: [],
      counts: { planNodes: 0, taskChains: rows.length, roots: rows.length, orphans: 0 },
      projects: [],
    },
  };
}

const SETTINGS = {
  schemaVersion: 1,
  delegationEnabled: true,
  providers: [{ id: 'relay', name: 'Relay', source: 'native', models: [{ id: 'm', efforts: ['high'] }] }],
  worker: { providerId: 'relay', model: 'm', reasoningEffort: 'high', timeoutSeconds: 1800, maxParallelism: 1, isolation: 'worktree' },
  review: { enabled: false, providerId: null, model: null, reasoningEffort: null },
  authorization: { taskGrantTtlSeconds: 900, sessionGrantTtlSeconds: 14400 },
  monitoring: { selfCheckSeconds: 300, attentionSeconds: 600, repeatFailureThreshold: 3 },
  projectOverrides: {},
  presets: [],
  conversation: { mode: 'new' },
};

async function makeStore(listTasks) {
  const apiModule = await import('../src/client/api.js');
  const api = {
    async getStatus() { return { ok: true }; },
    async getSettings() { return { ok: true, settings: SETTINGS }; },
    async getNativeProviders() { return { ok: true, providers: [] }; },
    async listTasks() {
      // The host's reply shape: the rows AND the projection, side by side.
      return listTasks();
    },
    async getTask(taskId) { return { ok: true, task: { taskId, title: taskId, state: 'accepted' } }; },
    async cancelTask(taskId) { return { ok: true, task: { taskId, state: 'cancelled' } }; },
  };
  return apiModule.createStore({ api, saveDebounceMs: 5 });
}

async function renderRecent(store) {
  const { react, reactDomClient, client } = await loadClient();
  await store.init();
  const root = globalThis.document.getElementById('root');
  const container = reactDomClient.createRoot(root);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const testUtils = await import('react-dom/test-utils');
  const act = typeof react.act === 'function' ? react.act : testUtils.act;
  const actAsync = async (callback) => {
    await act(async () => { await callback(); await settle(); });
  };
  await actAsync(async () => {
    container.render(react.createElement(client.DelegateConfigPage, { store }));
  });
  await settle(act, store);
  const tab = [...root.querySelectorAll('[role="tablist"] button')]
    .find((button) => (button.textContent ?? '').includes('任务记录'));
  assert.ok(tab !== undefined, 'the 任务记录 tab is rendered');
  await actAsync(async () => { tab.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true })); });
  await settle(act, store);
  const table = () => root.querySelector('[data-dshdg-records-table]');
  const ids = () => [...table().querySelectorAll('[data-dshdg-record]')].map((el) => el.dataset.dshdgRecord);
  return {
    root,
    table,
    ids,
    settle: () => settle(act, store),
    async refresh() {
      await actAsync(async () => { await store.refreshTasks('manual'); });
      await settle(act, store);
    },
    async click(element) {
      assert.ok(element !== null && element !== undefined, 'the control to click exists');
      await actAsync(async () => { element.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true })); });
      await settle(act, store);
    },
    async unmount() { await act(async () => { container.unmount(); }); },
  };
}

const TITLES = ['task-b', 'task-c', 'task-a'];
const OLDER = 'task-older';
const OLDER_AT = TIE_AT - 3_600_000;

/** The tied records first (in `TITLES` order), then one older record. */
const ROWS = [
  { taskId: 'task-b', createdAt: TIE_AT, updatedAt: TIE_AT },
  { taskId: 'task-c', createdAt: TIE_AT, updatedAt: TIE_AT },
  { taskId: 'task-a', createdAt: TIE_AT, updatedAt: TIE_AT },
  { taskId: OLDER, createdAt: OLDER_AT, updatedAt: OLDER_AT },
];

/** The same records, in a deliberately different array order. */
function permuted(rows, order) {
  return order.map((taskId) => rows.find((row) => row.taskId === taskId));
}

test('DOM order: records sharing one activity time keep one deterministic order across a re-read', async () => {
  const dom = installDom();
  let body = await tasksBodyOf(ROWS);
  const store = await makeStore(() => body);
  try {
    const page = await renderRecent(store);
    assert.ok(page.table() !== null, 'the recent table is the DEFAULT view');
    assert.equal(page.table().querySelector('[data-column="updatedAt"]').getAttribute('aria-sort'), 'descending');
    const desc = page.ids();
    assert.equal(desc.length, 4, 'one row per execution chain');
    // Newest first; the tied rows are ordered newest-first by their own identity, never
    // by the position the API happened to send them in. The older record comes last.
    assert.deepEqual(desc, ['task-c', 'task-b', 'task-a', OLDER]);
    // The column prints the SAME value it sorts by (the host's latest activity).
    const cellOf = (taskId) => page.table()
      .querySelector(`[data-dshdg-record="${taskId}"] [data-column="updatedAt"]`).textContent;
    assert.equal(cellOf('task-c'), cellOf('task-b'));
    assert.equal(cellOf('task-c'), cellOf('task-a'));
    assert.notEqual(cellOf('task-c'), cellOf(OLDER));

    // The SAME records arrive in a different array order (a re-read, or another store
    // order). The table must not move.
    body = await tasksBodyOf(permuted(ROWS, [OLDER, 'task-c', 'task-a', 'task-b']));
    await page.refresh();
    assert.deepEqual(page.ids(), desc, 'a re-read in another order draws the same table');

    // Ascending is the exact mirror: the tie-break runs in the same direction, so no
    // row depends on which direction the operator happens to be in.
    await page.click(page.table().querySelector('th[data-column="updatedAt"] button'));
    assert.equal(page.table().querySelector('[data-column="updatedAt"]').getAttribute('aria-sort'), 'ascending');
    assert.deepEqual(page.ids(), [...desc].reverse(), 'ascending is the mirror of descending');
    // ...and it survives another re-read in yet another array order.
    body = await tasksBodyOf(permuted(ROWS, ['task-b', OLDER, 'task-c', 'task-a']));
    await page.refresh();
    assert.deepEqual(page.ids(), [...desc].reverse(), 'the ascending order is stable too');

    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

test('DOM order: equal activity times are broken by creation time, then by the chain id', async () => {
  const dom = installDom();
  // A four-round pool where every record reports the SAME activity timestamp but a
  // DIFFERENT creation time: a whole-table tie, decided by the creation times.
  const rows = [
    { taskId: 'task-b', createdAt: TIE_AT - 2_000, updatedAt: TIE_AT },
    { taskId: 'task-a', createdAt: TIE_AT - 1_000, updatedAt: TIE_AT },
    { taskId: 'task-d', createdAt: TIE_AT - 4_000, updatedAt: TIE_AT },
    { taskId: 'task-c', createdAt: TIE_AT - 3_000, updatedAt: TIE_AT },
  ];
  const store = await makeStore(() => tasksBodyOf(rows));
  try {
    const page = await renderRecent(store);
    assert.deepEqual(page.ids(), ['task-a', 'task-b', 'task-c', 'task-d'], 'the newest CREATION time comes first');
    await page.click(page.table().querySelector('th[data-column="updatedAt"] button'));
    assert.deepEqual(page.ids(), ['task-d', 'task-c', 'task-b', 'task-a'],
      'and the oldest creation time comes first ascending — the exact mirror');    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

test('DOM order: a full tie falls back to the recorded chain id, and says so in both directions', async () => {
  const dom = installDom();
  // Same activity AND same creation time: only the recorded identity can decide.
  const ids = ['task-3', 'task-1', 'task-2'];
  const store = await makeStore(() => tasksBodyOf(ids.map((taskId) => ({ taskId, createdAt: TIE_AT, updatedAt: TIE_AT }))));
  try {
    const page = await renderRecent(store);
    assert.deepEqual(page.ids(), ['task-3', 'task-2', 'task-1'], 'the chain id breaks the tie, newest first');
    await page.click(page.table().querySelector('th[data-column="updatedAt"] button'));
    assert.deepEqual(page.ids(), ['task-1', 'task-2', 'task-3'], 'and the same key reverses exactly');
    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

test('DOM order: the default is the recent table, and the project tree is one click away', async () => {
  const dom = installDom();
  const store = await makeStore(() => tasksBodyOf(ROWS));
  try {
    const page = await renderRecent(store);
    const recent = page.root.querySelector('[data-dshdg-record-view="recent"]');
    const tree = page.root.querySelector('[data-dshdg-record-view="tree"]');
    assert.equal(recent.getAttribute('aria-pressed'), 'true', '最近任务 is pressed on first open');
    assert.equal(tree.getAttribute('aria-pressed'), 'false');
    await page.click(tree);
    assert.equal(page.root.querySelector('[data-dshdg-record-view="tree"]').getAttribute('aria-pressed'), 'true');
    assert.equal(page.root.querySelector('[data-dshdg-records-table]'), null, 'the table gives way to the tree');
    assert.notEqual(page.root.querySelector('[data-dshdg-task-tree]'), null);
    await page.click(page.root.querySelector('[data-dshdg-record-view="recent"]'));
    assert.deepEqual(page.ids(), ['task-c', 'task-b', 'task-a', OLDER], 'coming back restores the same order');
    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

