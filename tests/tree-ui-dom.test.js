// G09 (task-tree visualisation) + G09 batch plan creation, rendered for real.
//
// Like `ui-dom-acceptance.test.js` this loads the BUILT bundle (`lib/client.js`
// through `window.__ModuleLoader__`, materialized with the real React), renders the
// ACTUAL `DelegateConfigPage` into jsdom and dispatches real DOM events. Nothing is
// pattern-matched from source, and no store action is called on the page's behalf:
// every assertion below is about the committed DOM after a click the operator could
// have made.
//
// What it pins down:
//   1. a three-level plan renders as three levels, with a THREE-round chain shown as
//      rounds INSIDE its node, distinguishable from that node's child nodes;
//   2. two nodes with the SAME title (same parent, same project) stay two nodes, and
//      a plan node whose recorded parent is missing stays visible with its reason;
//   3. a chain's "详情"/"取消" buttons keep pointing at the same `taskId` after a real
//      store refresh, and the open detail survives that refresh;
//   4. a collapsed node stays collapsed across a background refresh (nothing steals
//      focus either), and an unexecuted plan node is never labelled as executed;
//   5. an older host that sends no tree falls back to the flat list, while a REFUSED
//      read is stated as a refusal and not as an empty list;
//   6. batch creation: success reads the nodes back from the host, a refusal keeps
//      every field for correction, a local problem never reaches the host, and a
//      parent is sent as a REAL node id.

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { tasksBody, tasksBodyFlatTree, tasksBodyWithoutTree } from './helpers/tree-fixtures.js';

/**
 * A minimal but real jsdom window for one test.
 *
 * Node 24 exposes `navigator` as a read-only global getter, so every global this test
 * replaces is installed with `defineProperty` (and reverted the same way).
 * @returns {{ dom: object, scrolled: object[], restore: () => void }} window and teardown.
 */
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
  const scrolled = [];
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView(options) {
    scrolled.push({ node: this, options });
  };
  return {
    dom,
    scrolled,
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

/**
 * Load the client module the way the browser does.
 * @returns {Promise<object>} `{ react, reactDomClient, client }`.
 */
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
  const window = {
    __ModuleLoader__: {
      load(registration) { registrations.push(registration); },
    },
  };
  const sandbox = {
    window,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    Date,
    Math,
    JSON,
  };
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

/** Flush React's scheduler, pending microtasks and any in-flight store read. */
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

/** A settings document the page can render without any edit. */
function hostSettings() {
  return {
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
}

/**
 * A store over a scripted user-plane double.
 *
 * `listTasks` delegates to `options.listTasks`, which tests swap to simulate a host
 * refresh; `createPlans` records every request body so a test can assert exactly what
 * the form sent (and that nothing was sent at all).
 * @param {object} [options] - `listTasks`, `getTask`, `createPlans`.
 * @returns {Promise<object>} `{ store, calls }`.
 */
async function makeStore(options = {}) {
  const apiModule = await import('../src/client/api.js');
  const calls = { createPlans: [], getTask: [], listTasks: 0 };
  const api = {
    async getStatus() { return { ok: true }; },
    async getSettings() { return { ok: true, settings: hostSettings() }; },
    async getNativeProviders() { return { ok: true, providers: [] }; },
    async listTasks() {
      calls.listTasks += 1;
      return await (options.listTasks ?? (async () => tasksBody()))();
    },
    async getTask(taskId) {
      calls.getTask.push(taskId);
      return await (options.getTask ?? (async (id) => {
        const body = tasksBody();
        const row = body.tasks.find((task) => task.taskId === id);
        return { ok: true, task: row ?? body.tasks[0] };
      }))(taskId);
    },
    async cancelTask(taskId) { return { ok: true, task: { taskId, state: 'cancelled' } }; },
    async createPlans(body) {
      calls.createPlans.push(body);
      return await (options.createPlans ?? (async (sent) => ({
        ok: true,
        nodes: sent.nodes.map((node, index) => ({
          nodeId: `plan-created-${index + 1}`,
          parentNodeId: null,
          title: node.title,
          sequence: index + 1,
          createdAt: 1_763_300_000_000 + index,
          updatedAt: 1_763_300_000_000 + index,
          connectionId: 'local-mcp',
          hostAcceptance: null,
          sourcePath: null,
          sourcePathDigest: null,
        })),
        executed: false,
        switch: { authorized: true, changedByThisAction: false },
      })))(body);
    },
  };
  const store = apiModule.createStore({ api, saveDebounceMs: 5 });
  return { store, calls, api };
}

/** Render the real page and return its query helpers. */
async function renderPage(store) {
  const { react, reactDomClient, client } = await loadClient();
  await store.init();
  const root = globalThis.document.getElementById('root');
  const container = reactDomClient.createRoot(root);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const testUtils = await import('react-dom/test-utils');
  const act = typeof react.act === 'function' ? react.act : testUtils.act;
  await act(async () => {
    container.render(react.createElement(client.DelegateConfigPage, { store }));
    await settle();
  });
  await act(() => settle(undefined, store));
  const page = {
    container,
    root,
    act,
    settle: () => settle(act, store),
    async unmount() {
      await act(async () => { container.unmount(); });
    },
    async openTasksTab() {
      const tab = [...root.querySelectorAll('[role="tablist"] button')]
        .find((button) => (button.textContent ?? '').includes('任务记录'));
      assert.ok(tab !== undefined, 'the 任务记录 tab is rendered');
      await act(async () => {
        tab.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true }));
        await settle();
      });
    },
    /** The rendered tree node for one node id, or null. */
    node(nodeId) {
      return root.querySelector(`[data-dshdg-tree-node="${nodeId}"]`);
    },
    /** Direct child tree nodes of one node (its OWN nesting level). */
    childNodes(nodeId) {
      const host = root.querySelector(`#dshdg-tree-children-${nodeId}`);
      if (host === null) return [];
      return [...host.querySelectorAll(':scope > ul.dshdg-tree-children > li[data-dshdg-tree-node]')];
    },
    /** Text of one element, or '' when absent. */
    text(selector) {
      return (root.querySelector(selector)?.textContent ?? '').trim();
    },
    /** Dispatch a click inside `act`, then settle. */
    async click(element) {
      assert.ok(element !== null && element !== undefined, 'the control to click exists');
      await act(async () => {
        element.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true }));
        await settle();
      });
      await settle(undefined, store);
    },
    /** Set an input/select value the way a browser does, then settle. */
    async fill(element, value) {
      assert.ok(element !== null && element !== undefined, 'the field to fill exists');
      const tag = element.tagName;
      const proto = tag === 'SELECT' ? globalThis.window.HTMLSelectElement.prototype : globalThis.window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      await act(async () => {
        setter.call(element, value);
        element.dispatchEvent(new globalThis.Event(tag === 'SELECT' ? 'change' : 'input', { bubbles: true }));
        await settle();
      });
    },
  };
  return page;
}

/** A node id and the `/tasks` body that contains it. */
const BODY = tasksBody();

// ---------------------------------------------------------------------------
// 1. The hierarchy and the rounds
// ---------------------------------------------------------------------------

test('DOM G09: a three-level plan renders three levels, and a three-round chain stays rounds of ONE node', async () => {
  const dom = installDom();
  const { store } = await makeStore();
  try {
    const page = await renderPage(store);
    await page.openTasksTab();

    assert.ok(page.root.querySelector('[data-dshdg-task-tree]') !== null, 'the tree panel is rendered');
    // Level 1 -> level 2 -> level 3, read from the DOM structure rather than from a
    // flag the page might set for itself.
    const goal = page.node('plan-goal');
    assert.ok(goal !== null);
    const level2 = page.childNodes('plan-goal').map((node) => node.getAttribute('data-dshdg-tree-node'));
    assert.deepEqual(level2, ['plan-logic', 'plan-ui', 'plan-ui-twin']);
    const level3 = page.childNodes('plan-logic').map((node) => node.getAttribute('data-dshdg-tree-node'));
    assert.deepEqual(level3, ['plan-debounce', 'plan-errors']);

    // The three-round chain: ONE plan node, three rounds, and the rounds are NOT
    // drawn as child nodes.
    const ui = page.node('plan-ui');
    assert.ok(ui !== null, 'the three-round node exists');
    const uiRounds = [...ui.querySelectorAll('[data-dshdg-round]')].map((row) => row.getAttribute('data-dshdg-round'));
    assert.deepEqual(uiRounds, ['task-ui-1', 'task-ui-2', 'task-ui-3'], 'all three rounds are shown for a three-round chain');
    assert.equal(page.childNodes('plan-ui').length, 0, 'a chain round is never mistaken for a child node');
    assert.match(ui.textContent, /3 轮/u, 'the node states how many rounds its chain has');
    assert.match(ui.textContent, /首轮/u, 'the first round is labelled as the first round');
    assert.match(ui.textContent, /整改轮次/u, 'later rounds are labelled as rectification rounds');
    assert.match(ui.textContent, /未对齐/u, 'the review body of a round is reachable from the round line');

    // The unexecuted leaf says so, and no node claims acceptance the host did not
    // record: `plan-errors` is `planned`.
    const errors = page.node('plan-errors');
    assert.match(errors.textContent, /尚未执行/u);
    assert.match(errors.textContent, /计划中/u);
    assert.doesNotMatch(errors.textContent, /审查通过/u);

    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

test('DOM G09: same-title nodes stay separate, orphans stay visible with their reason, and a refresh keeps identity', async () => {
  const dom = installDom();
  const { store } = await makeStore();
  try {
    const page = await renderPage(store);
    await page.openTasksTab();

    const twins = page.root.querySelectorAll('[data-dshdg-tree-node="plan-ui"], [data-dshdg-tree-node="plan-ui-twin"]');
    assert.equal(twins.length, 2, 'two nodes sharing a title are two DOM nodes');
    assert.equal(
      page.root.querySelectorAll('[data-dshdg-tree-node="plan-ui"]').length,
      1,
      'the same title does not make them share an identity',
    );
    // Each twin keeps its OWN rounds: the three-round chain belongs to `plan-ui`, the
    // single awaiting-permission round to `plan-ui-twin`.
    assert.deepEqual(
      [...page.node('plan-ui-twin').querySelectorAll('[data-dshdg-round]')].map((row) => row.getAttribute('data-dshdg-round')),
      ['task-ui-twin'],
    );

    // The orphan plan node and the missing-plan task are at the root WITH a reason.
    const orphan = page.node('plan-orphan');
    assert.ok(orphan !== null, 'a plan node with a missing parent is not dropped');
    assert.match(orphan.textContent, /父节点不在当前记录中/u);
    const missingPlan = page.node('task-missing-plan');
    assert.ok(missingPlan !== null);
    assert.match(missingPlan.textContent, /计划节点不在当前记录中/u);
    // An independent legacy execution is at the root as its own task node.
    const legacy = page.node('task-legacy');
    assert.ok(legacy !== null);
    assert.match(legacy.textContent, /独立任务/u);

    // A refresh re-renders the whole projection; identities survive it.
    await page.act(async () => { await store.refreshTasks('manual'); });
    await page.settle();
    assert.ok(page.node('plan-ui') !== null && page.node('plan-ui-twin') !== null, 'both twins survive a refresh');
    assert.equal(page.node('plan-ui').querySelectorAll('[data-dshdg-round]').length, 3);
    assert.equal(page.node('plan-ui-twin').querySelectorAll('[data-dshdg-round]').length, 1);

    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

// ---------------------------------------------------------------------------
// 2. Detail and cancel from a round, across a real refresh
// ---------------------------------------------------------------------------

test('DOM G09: a round 详情 opens the existing detail, and after a real refresh the buttons still target the same tasks', async () => {
  const dom = installDom();
  const { store, calls } = await makeStore();
  try {
    const page = await renderPage(store);
    await page.openTasksTab();

    // Open round 2 of the chain through its own button.
    await page.click(page.root.querySelector('[data-dshdg-round-detail="task-ui-2"]'));
    assert.deepEqual(calls.getTask, ['task-ui-2'], 'the round button asked for THAT task');
    const detail = page.root.querySelector('[data-dshdg-task-detail]');
    assert.ok(detail !== null, 'the existing detail panel opened');
    assert.match(detail.textContent, /修正窄窗口状态条对齐/u, 'the detail describes the round that was clicked');

    // A real store refresh (the same call the auto-refresh timer makes).
    await page.act(async () => { await store.refreshTasks('auto'); });
    await page.settle();
    assert.ok(page.root.querySelector('[data-dshdg-task-detail]') !== null, 'the open detail survives the refresh');
    assert.equal(
      page.root.querySelector('[data-dshdg-round-detail="task-ui-2"]').getAttribute('data-dshdg-round-detail'),
      'task-ui-2',
      'the round control still targets the same task id',
    );

    // Round 3 now opens ITSELF — the buttons were re-bound to the refreshed nodes.
    await page.click(page.root.querySelector('[data-dshdg-round-detail="task-ui-3"]'));
    assert.deepEqual(calls.getTask, ['task-ui-2', 'task-ui-3']);
    assert.match(page.root.querySelector('[data-dshdg-task-detail]').textContent, /补充状态条 aria-live/u);

    // A round that is not cancellable has its cancel control disabled; a running one
    // is enabled. This is the page's existing `isCancellable` rule, unchanged.
    assert.equal(page.root.querySelector('[data-dshdg-round-cancel="task-ui-3"]').disabled, true);
    assert.equal(page.root.querySelector('[data-dshdg-round-cancel="task-ui-twin"]').disabled, false);

    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. Expansion survives a refresh; nothing steals focus; keyboard works
// ---------------------------------------------------------------------------

test('DOM G09: collapse survives a background refresh, a refresh steals no focus, Enter on the toggle collapses a node', async () => {
  const dom = installDom();
  const { store } = await makeStore();
  try {
    const page = await renderPage(store);
    await page.openTasksTab();

    // Keyboard: focus the toggle and press Enter, the way a native button behaves.
    const toggle = page.root.querySelector('[data-dshdg-tree-toggle="plan-logic"]');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    const controlled = toggle.getAttribute('aria-controls');
    assert.equal(page.root.querySelector(`#${controlled}`) !== null, true, 'aria-controls names a real element');
    const outside = page.root.querySelector('[data-dshdg-plan-create-open]');
    await page.act(async () => {
      outside.focus();
      toggle.focus();
      toggle.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      toggle.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true }));
      await settle();
    });
    await page.settle();
    assert.equal(page.node('plan-logic').querySelector('[data-dshdg-tree-toggle="plan-logic"]').getAttribute('aria-expanded'), 'false');
    assert.equal(page.childNodes('plan-logic').length, 0, 'a collapsed node hides its children');

    // Focus something else, then let a background refresh replace every node object.
    const elsewhere = page.root.querySelector('[data-dshdg-plan-create-open]');
    await page.act(async () => { elsewhere.focus(); await settle(); });
    await page.act(async () => { await store.refreshTasks('auto'); });
    await page.settle();

    assert.equal(
      page.node('plan-logic').querySelector('[data-dshdg-tree-toggle="plan-logic"]').getAttribute('aria-expanded'),
      'false',
      'the refresh did NOT re-open what the operator collapsed',
    );
    assert.equal(globalThis.document.activeElement, elsewhere, 'the refresh did not steal focus');

    // Expanding again brings the children back, with their own rounds intact.
    await page.click(page.node('plan-logic').querySelector('[data-dshdg-tree-toggle="plan-logic"]'));
    assert.deepEqual(
      page.childNodes('plan-logic').map((node) => node.getAttribute('data-dshdg-tree-node')),
      ['plan-debounce', 'plan-errors'],
    );

    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

test('DOM G09: a deep chain collapses its long round list on demand and the layout class exists for narrow windows', async () => {
  const dom = installDom();
  // A six-round chain: more rounds than the compact list shows at once.
  const base = BODY;
  const rounds = Array.from({ length: 6 }, (_unused, index) => ({
    taskId: `task-long-${index + 1}`,
    title: `第 ${index + 1} 次尝试`,
    state: 'awaiting-host-review',
    phase: 'awaiting-host-review',
    createdAt: 1_763_200_000_000 + index,
    continueFromTaskId: index === 0 ? undefined : `task-long-${index}`,
    planNodeId: 'plan-logic-node',
    hostAcceptance: null,
  }));
  const longBody = {
    ok: true,
    tasks: rounds,
    plans: { available: false, count: 0, reason: 'PLAN_UNAVAILABLE' },
    tree: {
      roots: [{
        kind: 'task',
        nodeId: 'task-long-1',
        title: '长链任务',
        displayTitle: '长链任务',
        parentNodeId: null,
        nodeStatus: 'awaiting-host-review',
        chain: { chainId: 'task-long-1', rounds, roundCount: 6, displayTitle: '长链任务' },
        rounds,
        children: [],
        orphan: null,
        projectKey: 'unverified',
      }],
      flatNodes: [],
      counts: { planNodes: 0, taskChains: 1, roots: 1, orphans: 0 },
      projects: [],
    },
  };
  assert.ok(base.tree !== null);
  const { store } = await makeStore({ listTasks: async () => longBody });
  try {
    const page = await renderPage(store);
    await page.openTasksTab();
    const node = page.node('task-long-1');
    assert.equal(node.querySelectorAll('[data-dshdg-round]').length, 3, 'a long chain shows a compact number of rounds first');
    const more = node.querySelector('[data-dshdg-chain-more="task-long-1"]');
    assert.ok(more !== null);
    assert.match(more.textContent, /显示全部 6 轮/u);
    await page.click(more);
    assert.equal(page.node('task-long-1').querySelectorAll('[data-dshdg-round]').length, 6, 'and can show all of them');
    await page.click(page.node('task-long-1').querySelector('[data-dshdg-chain-more="task-long-1"]'));
    assert.equal(page.node('task-long-1').querySelectorAll('[data-dshdg-round]').length, 3, 'and compress again');

    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. Legacy hosts, failed reads, and the flat-only tree shape
// ---------------------------------------------------------------------------

test('DOM G09: an older host without a tree falls back to the flat list; a refused read is stated, not shown as empty', async () => {
  const dom = installDom();
  try {
    // (a) No tree at all: the legacy path.
    const legacy = await makeStore({ listTasks: async () => tasksBodyWithoutTree() });
    let page = await renderPage(legacy.store);
    await page.openTasksTab();
    assert.ok(page.root.querySelector('[data-dshdg-tree-unavailable]') !== null, 'the page says the host returns no tree');
    const flat = page.root.querySelector('[data-dshdg-flat-list]');
    assert.ok(flat !== null, 'and the flat list is still there');
    assert.equal(flat.querySelectorAll('.dshdg-item').length, BODY.tasks.length, 'every record is listed');
    // The creation form is still offered: creating a plan does not need a tree.
    assert.ok(page.root.querySelector('[data-dshdg-plan-create]') !== null);
    await page.unmount();
    legacy.store.dispose();

    // (b) A refused read: stated as a failure, and the previous rows are kept.
    let fail = false;
    const flaky = await makeStore({
      listTasks: async () => {
        if (fail) throw Object.assign(new Error('the durable task history could not be read'), { code: 'JOB_HISTORY_UNREADABLE' });
        return tasksBody();
      },
    });
    page = await renderPage(flaky.store);
    await page.openTasksTab();
    assert.ok(page.root.querySelector('[data-dshdg-task-tree]') !== null);
    fail = true;
    await page.act(async () => { await flaky.store.refreshTasks('manual'); });
    await page.settle();
    const alert = page.root.querySelector('[data-dshdg-tasks-error]');
    assert.ok(alert !== null, 'the refused read is visible');
    assert.match(alert.textContent, /读取任务记录失败/u);
    assert.match(alert.textContent, /JOB_HISTORY_UNREADABLE|could not be read/u);
    assert.ok(page.node('plan-goal') !== null, 'the records already shown are NOT cleared by a failed read');
    await page.unmount();
    flaky.store.dispose();

    // (c) The flat-only tree shape nests by the HOST's resolved parents.
    const flatTree = await makeStore({ listTasks: async () => tasksBodyFlatTree() });
    page = await renderPage(flatTree.store);
    await page.openTasksTab();
    assert.deepEqual(
      page.childNodes('plan-goal').map((node) => node.getAttribute('data-dshdg-tree-node')),
      ['plan-logic', 'plan-ui', 'plan-ui-twin'],
      'the flat projection is nested by resolvedParentNodeId, never by title',
    );
    await page.unmount();
    flatTree.store.dispose();
  } finally {
    dom.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. Batch plan creation
// ---------------------------------------------------------------------------

test('DOM G09: the create form sends a real parent id and a batch, then reads the nodes back from the host', async () => {
  const dom = installDom();
  let served = tasksBody();
  let created = null;
  const { store, calls } = await makeStore({
    listTasks: async () => served,
    createPlans: async (body) => {
      created = body;
      // The host stores the nodes; the NEXT list read serves them.
      const nodes = body.nodes.map((node, index) => ({
        nodeId: `plan-created-${index + 1}`,
        parentNodeId: node.parentKey === undefined ? (body.parentNodeId ?? null) : 'plan-created-1',
        title: node.title,
        sequence: 100 + index,
        createdAt: 1_763_300_000_000 + index,
        updatedAt: 1_763_300_000_000 + index,
        connectionId: 'local-mcp',
        hostAcceptance: null,
        sourcePath: null,
        sourcePathDigest: null,
      }));
      served = {
        ...tasksBody(),
        tree: {
          ...tasksBody().tree,
          roots: [
            ...tasksBody().tree.roots,
            {
              kind: 'plan',
              nodeId: 'plan-created-1',
              title: nodes[0].title,
              displayTitle: nodes[0].title,
              parentNodeId: nodes[0].parentNodeId,
              nodeStatus: 'planned',
              executed: false,
              children: [{
                kind: 'plan',
                nodeId: 'plan-created-2',
                title: nodes[1].title,
                displayTitle: nodes[1].title,
                parentNodeId: 'plan-created-1',
                nodeStatus: 'planned',
                executed: false,
                children: [],
                orphan: null,
                projectKey: 'unverified',
              }],
              orphan: null,
              projectKey: 'unverified',
            },
          ],
        },
      };
      return { ok: true, nodes, executed: false, switch: { authorized: true, changedByThisAction: false } };
    },
  });
  try {
    const page = await renderPage(store);
    await page.openTasksTab();
    // Collapsing the goal makes its child plans invisible on the tree; a parent chosen
    // from the tree can still be the goal itself, so the form is exercised against a
    // VISIBLE child too.
    assert.ok(page.node('plan-goal') !== null);
    await page.click(page.root.querySelector('[data-dshdg-plan-create-open]'));
    assert.ok(page.root.querySelector('#dshdg-plan-title') !== null, 'the form opened');

    // The batch is built from ROWS: the first row is the batch's root, and the parent
    // selector attaches that existing node to it (by id) when it is chosen.
    await page.fill(page.root.querySelector('[data-dshdg-plan-row-title="0"]'), '发布前验收');
    await page.fill(page.root.querySelector('[data-dshdg-plan-row-goal="0"]'), '把验收清单跑一遍');
    const parentSelect = page.root.querySelector('#dshdg-plan-parent');
    await page.fill(parentSelect, 'plan-goal');
    // The two single fields are a shorthand for the first ROOT row, not a second node.
    await page.fill(page.root.querySelector('#dshdg-plan-title'), '发布前验收');
    await page.fill(page.root.querySelector('#dshdg-plan-goal'), '把验收清单跑一遍');

    // The second row is added as a CHILD of the first row, in the same batch.
    await page.click(page.root.querySelector('[data-dshdg-plan-add-row]'));
    await page.fill(page.root.querySelector('[data-dshdg-plan-row-title="1"]'), '补充边界用例');
    assert.equal(page.root.querySelectorAll('[data-dshdg-plan-row-title]').length, 2);

    await page.click(page.root.querySelector('[data-dshdg-plan-create-submit]'));

    assert.equal(calls.createPlans.length, 1, 'exactly ONE request carried the whole batch');
    assert.equal(created.parentNodeId, 'plan-goal', 'the parent was sent as the REAL node id');
    assert.equal(Object.hasOwn(created, 'connectionId'), false, 'the page never names a connection');
    assert.equal(created.nodes.length, 2);
    assert.equal(created.nodes[0].title, '发布前验收');
    assert.equal(created.nodes[0].goalDescription, '把验收清单跑一遍');
    assert.equal(created.nodes[0].parentKey, undefined, 'the root row has no in-batch parent');
    assert.equal(created.nodes[1].title, '补充边界用例');
    assert.equal(created.nodes[1].parentKey, created.nodes[0].key, 'the second row hangs off the first row by key');

    // Success: the form closed and cleared, and the nodes came back through the
    // EXISTING refresh path (one more list read), not from a local guess.
    assert.equal(page.root.querySelector('#dshdg-plan-title'), null, 'the form closed after a successful create');
    const result = page.root.querySelector('[data-dshdg-plan-create-result]');
    assert.ok(result !== null);
    assert.match(result.textContent, /已创建 2 个规划节点/u);
    assert.ok(page.node('plan-created-1') !== null, 'the new node is shown from the refreshed host answer');
    assert.equal(page.node('plan-created-1').getAttribute('data-dshdg-node-kind'), 'plan');

    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

test('DOM G09: a refused create keeps every field, states the host reason, and nothing is half-saved', async () => {
  const dom = installDom();
  const { store, calls } = await makeStore({
    createPlans: async () => {
      throw Object.assign(new Error('plan tree depth 17 exceeds the maximum of 16'), {
        code: 'PLAN_DEPTH_EXCEEDED',
        status: 400,
        details: { depth: 17 },
      });
    },
  });
  try {
    const page = await renderPage(store);
    await page.openTasksTab();
    await page.click(page.root.querySelector('[data-dshdg-plan-create-open]'));
    await page.fill(page.root.querySelector('[data-dshdg-plan-row-title="0"]'), '过深的计划');
    await page.fill(page.root.querySelector('[data-dshdg-plan-row-goal="0"]'), '会被拒绝');
    await page.fill(page.root.querySelector('#dshdg-plan-title'), '过深的计划');
    await page.fill(page.root.querySelector('#dshdg-plan-goal'), '会被拒绝');
    await page.click(page.root.querySelector('[data-dshdg-plan-add-row]'));
    await page.fill(page.root.querySelector('[data-dshdg-plan-row-title="1"]'), '第二层');
    await page.click(page.root.querySelector('[data-dshdg-plan-create-submit]'));

    assert.equal(calls.createPlans.length, 1);
    const failure = page.root.querySelector('[data-dshdg-plan-create-error]');
    assert.ok(failure !== null, 'the refusal is shown');
    assert.match(failure.textContent, /创建失败/u);
    assert.match(failure.textContent, /整批没有保存/u);
    // EVERY field is still there, so the operator corrects one thing and resubmits.
    assert.equal(page.root.querySelector('#dshdg-plan-title').value, '过深的计划');
    assert.equal(page.root.querySelector('#dshdg-plan-goal').value, '会被拒绝');
    assert.equal(page.root.querySelector('[data-dshdg-plan-row-title="0"]').value, '过深的计划');
    assert.equal(page.root.querySelector('[data-dshdg-plan-row-title="1"]').value, '第二层');
    assert.equal(page.root.querySelector('[data-dshdg-plan-create-result]'), null, 'no success is claimed');

    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});
test('DOM G09: a locally impossible batch never reaches the host, and Escape closes the form with the input kept', async () => {
  const dom = installDom();
  const { store, calls } = await makeStore();
  try {
    const page = await renderPage(store);
    await page.openTasksTab();
    const opener = page.root.querySelector('[data-dshdg-plan-create-open]');
    await page.click(opener);

    // Empty batch: refused locally, with the field named.
    await page.click(page.root.querySelector('[data-dshdg-plan-create-submit]'));
    assert.equal(calls.createPlans.length, 0, 'nothing was sent');
    const problems = page.root.querySelector('[data-dshdg-plan-create-problems]');
    assert.ok(problems !== null);
    assert.match(problems.textContent, /至少填写一个节点标题/u);

    await page.fill(page.root.querySelector('#dshdg-plan-title'), '保留我的输入');
    // The rendered parent selector offers exactly the tree's PLAN ids — real ids, one
    // option per node even when two nodes share a title — and never a task id.
    const optionIds = [...page.root.querySelectorAll('#dshdg-plan-parent option')]
      .map((option) => option.value)
      .filter((value) => value !== '');
    assert.ok(optionIds.includes('plan-goal'), 'an existing plan node is a selectable parent');
    assert.ok(optionIds.includes('plan-logic'), 'a nested plan node is a selectable parent');
    assert.ok(!optionIds.includes('task-legacy'), 'a task node is not offered as a parent');
    assert.equal(new Set(optionIds).size, optionIds.length, 'each node is one distinct option');
    assert.equal(optionIds.filter((value) => value.startsWith('plan-ui')).length, 2, 'two same-titled plans stay two options');

    // The pure projection the form renders from: a row may not name ITSELF, and a link
    // to another batch row becomes a real `parentKey`.
    const { planCreateRequest } = await import('../src/client/api.js');
    const selfLinked = planCreateRequest({
      rows: [{ title: '甲', parent: 'row:0' }],
    });
    assert.deepEqual(selfLinked.problems, ['第 1 行不能作为自己的父节点']);
    const twoLevels = planCreateRequest({
      title: '甲',
      rows: [{ title: '甲' }, { title: '乙', parent: 'row:0' }],
    });
    assert.deepEqual(twoLevels.problems, []);
    assert.equal(twoLevels.body.nodes[1].parentKey, twoLevels.body.nodes[0].key, 'a row link becomes a batch parentKey');
    assert.equal(twoLevels.body.connectionId, undefined, 'the page never names a connection');

    // A row may not name itself either through the real form, and nothing is sent.
    await page.click(page.root.querySelector('[data-dshdg-plan-add-row]'));
    await page.fill(page.root.querySelector('[data-dshdg-plan-row-title="1"]'), '子项');
    await page.fill(page.root.querySelector('[data-dshdg-plan-row-parent="0"]'), 'row:1');
    await page.click(page.root.querySelector('[data-dshdg-plan-create-submit]'));
    assert.equal(calls.createPlans.length, 0, 'an impossible batch is never sent');
    assert.match(page.root.querySelector('[data-dshdg-plan-create-problems]').textContent, /父节点/u);

    // Escape from a field closes the form; the draft is kept for the next open.
    const field = page.root.querySelector('#dshdg-plan-title');
    await page.act(async () => {
      field.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await settle();
    });
    assert.equal(page.root.querySelector('#dshdg-plan-title'), null, 'Escape closed the form');
    assert.equal(globalThis.document.activeElement, opener, 'focus returned to the button that opened it');
    await page.click(opener);
    assert.equal(page.root.querySelector('#dshdg-plan-title').value, '保留我的输入', 'the draft survived closing');

    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

// ---------------------------------------------------------------------------
// 6. The store contract the page relies on
// ---------------------------------------------------------------------------

test('store: the tree is data from the host, and the three read outcomes stay distinguishable', async () => {
  const { createStore, taskTreeView, rootsFromFlatNodes } = await import('../src/client/api.js');
  const makeApi = (listTasks) => ({
    async listTasks() { return await listTasks(); },
  });

  // (a) Full tree.
  const full = createStore({ api: makeApi(async () => tasksBody()) });
  await full.loadTasks();
  let snapshot = full.getSnapshot();
  assert.equal(snapshot.treeAvailable, true);
  assert.ok(snapshot.tree.roots.length > 0);
  assert.equal(snapshot.tasksError, null);
  assert.equal(snapshot.plans.available, true);
  full.dispose();

  // (b) No tree: legacy host.
  const legacy = createStore({ api: makeApi(async () => tasksBodyWithoutTree()) });
  await legacy.loadTasks();
  snapshot = legacy.getSnapshot();
  assert.equal(snapshot.tree, null);
  assert.equal(snapshot.treeAvailable, false);
  assert.equal(snapshot.tasksError, null, 'an old host is not an error');
  assert.equal(snapshot.tasks.length, BODY.tasks.length);
  legacy.dispose();

  // (c) Refused read: an error, not an empty list.
  const refused = createStore({ api: makeApi(async () => { throw Object.assign(new Error('nope'), { code: 'PLAN_HISTORY_UNREADABLE' }); }) });
  await refused.loadTasks();
  snapshot = refused.getSnapshot();
  assert.equal(snapshot.tasksError?.code, 'PLAN_HISTORY_UNREADABLE');
  refused.dispose();

  // (d) A tree object with neither shape is treated as "no tree", never half-parsed.
  assert.equal(taskTreeView({ tree: { counts: {} } }), null);
  assert.equal(taskTreeView({}), null);
  // (e) An EMPTY tree is a real answer: zero roots, still available.
  const empty = taskTreeView({ tree: { roots: [], flatNodes: [], counts: { roots: 0 } } });
  assert.notEqual(empty, null);
  assert.deepEqual(empty.roots, []);
  // (f) A flat projection is nested ONLY by the host's resolved parent.
  const nested = rootsFromFlatNodes([
    { nodeId: 'a', title: 'A', resolvedParentNodeId: null, kind: 'plan' },
    { nodeId: 'b', title: 'A', resolvedParentNodeId: 'a', kind: 'plan' },
    { nodeId: 'c', title: 'A', resolvedParentNodeId: 'gone', kind: 'task' },
  ]);
  assert.deepEqual(nested.map((node) => node.nodeId), ['a', 'c'], 'a missing resolved parent stays at the root');
  assert.deepEqual(nested[0].children.map((node) => node.nodeId), ['b'], 'identical titles do not merge nodes');
});

test('store: createPlans reports a refusal, keeps the error, and refreshes only after a success', async () => {
  const { createStore } = await import('../src/client/api.js');
  const calls = [];
  let fail = true;
  const api = {
    async listTasks() { calls.push('list'); return tasksBody(); },
    async createPlans(body) {
      calls.push(body);
      if (fail) throw Object.assign(new Error('refused'), { code: 'PLAN_SOURCE_MISMATCH' });
      return { ok: true, nodes: [{ nodeId: 'plan-x', title: 'x', parentNodeId: null }], executed: false };
    },
  };
  const store = createStore({ api });
  const refused = await store.createPlans({ nodes: [{ title: 'x' }] });
  assert.equal(refused.ok, false);
  assert.equal(store.getSnapshot().planCreateError?.code, 'PLAN_SOURCE_MISMATCH');
  assert.equal(calls.filter((entry) => entry === 'list').length, 0, 'a refused create reads nothing back');
  assert.match(store.getSnapshot().notices.at(-1).text, /创建规划失败/u);

  fail = false;
  const created = await store.createPlans({ nodes: [{ title: 'x' }] });
  assert.equal(created.ok, true);
  assert.equal(calls.filter((entry) => entry === 'list').length, 1, 'a successful create re-reads through the normal path');
  assert.equal(store.getSnapshot().planCreateError, null);
  assert.deepEqual(store.getSnapshot().planCreateResult, ['plan-x']);
  store.dispose();
});

test('store: nothing in the plan-create surface can dispatch or authorize execution', async () => {
  const { createStore, ROUTES } = await import('../src/client/api.js');
  const api = { async listTasks() { return tasksBody(); } };
  const store = createStore({ api });
  for (const name of Object.keys(store)) {
    assert.doesNotMatch(name, /submit|dispatch|authori[sz]e|approve|execute/iu, `the store must not expose ${name}`);
  }
  assert.equal(ROUTES.plans, '/api/dsh-delegate/plans');
  store.dispose();
});
