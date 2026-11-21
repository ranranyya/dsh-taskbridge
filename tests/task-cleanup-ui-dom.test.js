// "清理记录" (task-record cleanup) in the REAL built page.
//
// Like `tree-ui-dom.test.js` this loads `lib/client.js` through the same
// `__ModuleLoader__` registration the DSH web client uses, materializes it with the
// real React, renders the ACTUAL `DelegateConfigPage` into jsdom and dispatches real
// DOM events. Nothing is pattern-matched from source.
//
// What it pins down, in the order an operator performs it:
//   1. the removal action is only offered when the host says it is available;
//   2. entering the mode draws ONE checkbox per execution chain — including the chain
//      attached to a planning node — and an ineligible chain is drawn disabled with
//      its reason;
//   3. the bar counts the selected chains and rounds BEFORE anything is sent;
//   4. cancelling the confirmation sends nothing at all (the list is not re-read, no
//      request is made), and leaving the mode sends nothing either;
//   5. confirming sends exactly the selected chains with their exact rounds, then
//      re-reads the list through the normal refresh;
//   6. a refused batch is reported as a failure with nothing removed, and the page
//      re-reads rather than pretending the rows went away.

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { tasksBody, tasksBodyWithoutTree } from './helpers/tree-fixtures.js';

/**
 * A minimal but real jsdom window for one test.
 * @returns {{ dom: object, restore: () => void }} window and teardown.
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

/** A settings document the page renders without any edit. */
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
 * @param {object} [options] - `listTasks`, `cleanupResponse`.
 * @returns {Promise<object>} `{ store, calls }`.
 */
async function makeStore(options = {}) {
  const apiModule = await import('../src/client/api.js');
  const calls = { cleanup: [], listTasks: 0 };
  const api = {
    async getStatus() { return { ok: true }; },
    async getSettings() { return { ok: true, settings: hostSettings() }; },
    async getNativeProviders() { return { ok: true, providers: [] }; },
    async listTasks() {
      calls.listTasks += 1;
      return await (options.listTasks ?? (async () => tasksBody()))();
    },
    async getTask(taskId) {
      const body = tasksBody();
      return { ok: true, task: body.tasks.find((task) => task.taskId === taskId) ?? body.tasks[0] };
    },
    async cancelTask(taskId) { return { ok: true, task: { taskId, state: 'cancelled' } }; },
    cleanupTasks: apiModule.createApi({
      fetchImpl: async (url, init) => {
        assert.equal(url, 'api/dsh-delegate/tasks/cleanup');
        assert.equal(init.method, 'POST');
        const body = JSON.parse(init.body);
        calls.cleanup.push(body);
        if (options.cleanupResponse) return options.cleanupResponse;
        return Response.json({
          ok: true,
          chains: body.chains.length,
          tasks: body.chains.reduce((sum, chain) => sum + chain.taskIds.length, 0),
          deletedTaskIds: body.chains.flatMap((chain) => chain.taskIds),
          remaining: 0,
          retained: { sessions: true, workspaces: true, worktrees: true, sourceFiles: true, plans: true },
        });
      },
    }).cleanupTasks,
  };
  // The cleanup projection `index.jsx` injects into the real store; the store itself
  // keeps no copy of the selection rules.
  const { cleanupProjection } = await import('../src/client/task-cleanup.js');
  const store = apiModule.createStore({ api, saveDebounceMs: 5, cleanup: cleanupProjection() });
  return { store, calls };
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
    root,
    async unmount() { await act(async () => { container.unmount(); }); },
    async openTasksTab() {
      const tab = [...root.querySelectorAll('[role="tablist"] button')]
        .find((button) => (button.textContent ?? '').includes('任务记录'));
      assert.ok(tab !== undefined, 'the 任务记录 tab is rendered');
      await act(async () => {
        tab.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true }));
        await settle();
      });
    },
    text(selector) { return (root.querySelector(selector)?.textContent ?? '').trim(); },
    all(selector) { return [...root.querySelectorAll(selector)]; },
    async click(element) {
      assert.ok(element !== null && element !== undefined, 'the control to click exists');
      await act(async () => {
        element.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true }));
        await settle();
      });
      await settle(undefined, store);
    },
    async fillDate(selector, value) {
      const input = root.querySelector(selector);
      assert.ok(input);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        await settle();
      });
    },
    async toggle(checkbox) {
      assert.ok(checkbox !== null && checkbox !== undefined, 'the checkbox exists');
      await act(async () => {
        checkbox.click();
        await settle();
      });
      await settle(undefined, store);
    },
  };
  return page;
}

// ---------------------------------------------------------------------------

test('DOM cleanup: the action appears only when the host offers it', async () => {
  const dom = installDom();
  const { store } = await makeStore({ listTasks: async () => tasksBodyWithoutTree() });
  try {
    const page = await renderPage(store);
    await page.openTasksTab();
    assert.equal(page.all('[data-dshdg-cleanup-toggle]').length, 0, 'no tree, no cleanup action');
    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

test('DOM cleanup: selection, confirmation, cancel and the exact request body', async () => {
  const dom = installDom();
  const { store, calls } = await makeStore();
  try {
    const page = await renderPage(store);
    await page.openTasksTab();
    const listReadsAfterOpen = calls.listTasks;

    // 1. Entering the mode draws a checkbox per chain, and nothing is sent.
    const toggle = page.root.querySelector('[data-dshdg-cleanup-toggle]');
    assert.ok(toggle !== null, 'the cleanup action is offered on a tree with cleanup facts');
    await page.click(toggle);
    assert.equal(calls.cleanup.length, 0, 'entering the mode sends nothing');
    const checks = page.all('[data-dshdg-cleanup-check]');
    assert.deepEqual(
      checks.map((input) => input.getAttribute('data-dshdg-cleanup-check')).sort(),
      ['task-debounce', 'task-legacy', 'task-missing-plan', 'task-ui-1', 'task-ui-twin'],
      'one checkbox per execution chain, including the chain under a planning node',
    );

    // 2. An ineligible chain is disabled AND explains itself.
    const twin = page.root.querySelector('[data-dshdg-cleanup-check="task-ui-twin"]');
    assert.equal(twin.disabled, true);
    assert.match(page.text('[data-dshdg-cleanup-blocked="task-ui-twin"]'), /仍在执行/u);

    // 3. The bar counts what is selected before anything is sent.
    const legacy = page.root.querySelector('[data-dshdg-cleanup-check="task-legacy"]');
    assert.equal(legacy.disabled, false);
    await page.toggle(legacy);
    assert.match(page.text('[data-dshdg-cleanup-counts]'), /已选 1 条执行链 \/ 共 1 轮/u);
    const ui = page.root.querySelector('[data-dshdg-cleanup-check="task-ui-1"]');
    await page.toggle(ui);
    assert.match(page.text('[data-dshdg-cleanup-counts]'), /已选 2 条执行链 \/ 共 4 轮/u);
    assert.equal(calls.cleanup.length, 0, 'selecting sends nothing');

    // 4. The confirmation states the permanent consequence, and CANCEL sends nothing.
    await page.click(page.root.querySelector('[data-dshdg-cleanup-review]'));
    const dialog = page.root.querySelector('[data-dshdg-cleanup-confirm-dialog]');
    assert.ok(dialog !== null, 'the confirmation is drawn');
    assert.match(dialog.textContent, /确认永久删除 2 条执行链、共 4 轮/u);
    assert.match(dialog.textContent, /会话、工作区与源文件不会被删除/u);
    await page.click(page.root.querySelector('[data-dshdg-cleanup-cancel]'));
    assert.equal(calls.cleanup.length, 0, 'cancelling the confirmation must not send a request');
    assert.equal(page.root.querySelector('[data-dshdg-cleanup-confirm-dialog]'), null);
    // The selection is still there, so the operator can re-confirm deliberately.
    assert.match(page.text('[data-dshdg-cleanup-counts]'), /已选 2 条执行链/u);

    // 5. Leaving the mode sends nothing either, and clears the selection.
    await page.click(page.root.querySelector('[data-dshdg-cleanup-toggle]'));
    assert.equal(calls.cleanup.length, 0, 'leaving the mode must not send a request');
    assert.equal(page.all('[data-dshdg-cleanup-check]').length, 0, 'the checkboxes are gone');
    await page.click(page.root.querySelector('[data-dshdg-cleanup-toggle]'));
    await page.toggle(page.root.querySelector('[data-dshdg-cleanup-check="task-legacy"]'));
    await page.click(page.root.querySelector('[data-dshdg-cleanup-review]'));
    await page.click(page.root.querySelector('[data-dshdg-cleanup-confirm]'));

    // 6. The ONE request names exactly the selected chains and their exact rounds.
    assert.equal(calls.cleanup.length, 1, 'confirming sends exactly one request');
    assert.deepEqual(calls.cleanup[0], {
      confirm: true,
      chains: [{ chainId: 'task-legacy', taskIds: ['task-legacy'] }],
    });
    // …and the list was re-read afterwards through the normal refresh path.
    assert.ok(calls.listTasks > listReadsAfterOpen, 'a successful cleanup re-reads the list');
    // The mode closed on success.
    assert.equal(page.all('[data-dshdg-cleanup-check]').length, 0);
    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

test('DOM cleanup: a refused batch is reported as a failure and nothing is claimed to be removed', async () => {
  const dom = installDom();
  const { store, calls } = await makeStore({
    cleanupResponse: Response.json({
      ok: false,
      error: {
        code: 'CLEANUP_STALE',
        message: 'the selected execution chains cannot be removed as one batch',
        details: { chains: [{ chainId: 'task-legacy', code: 'CLEANUP_STALE', blockers: ['CLEANUP_STALE'] }], deleted: 0 },
      },
    }, { status: 409 }),
  });
  try {
    const page = await renderPage(store);
    await page.openTasksTab();
    const readsBefore = calls.listTasks;
    await page.click(page.root.querySelector('[data-dshdg-cleanup-toggle]'));
    await page.toggle(page.root.querySelector('[data-dshdg-cleanup-check="task-legacy"]'));
    await page.click(page.root.querySelector('[data-dshdg-cleanup-review]'));
    await page.click(page.root.querySelector('[data-dshdg-cleanup-confirm]'));

    assert.equal(calls.cleanup.length, 1);
    const notices = store.getSnapshot().notices.map((notice) => notice.text).join('\n');
    assert.match(notices, /未删除任何记录/u, 'the failure must be stated plainly');
    assert.match(notices, /CLEANUP_STALE/u, 'the refusal code is shown for support');
    assert.doesNotMatch(notices, /已永久删除/u, 'a refused batch must never read as a success');
    // The tree is re-read so the operator sees the host's current rows; the chain is
    // still there because nothing was removed.
    assert.ok(calls.listTasks > readsBefore, 'a refusal re-reads the list');
    assert.ok(page.root.querySelector('[data-dshdg-cleanup-check="task-legacy"]') !== null);
    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

test('DOM cleanup: changing a date while confirming clears the selection and limits the next batch to visible records', async () => {
  const dom = installDom();
  const fixture = tasksBody();
  const legacy = fixture.tree.roots.find((node) => node.nodeId === 'task-legacy');
  const createdAt = new Date(2026, 10, 20, 12).getTime();
  legacy.createdAt = createdAt;
  legacy.chain.createdAt = createdAt;
  legacy.chain.rounds[0].createdAt = createdAt;
  const { store, calls } = await makeStore({ listTasks: async () => fixture });
  let page;
  try {
    page = await renderPage(store);
    await page.openTasksTab();
    await page.click(page.root.querySelector('[data-dshdg-cleanup-toggle]'));
    await page.toggle(page.root.querySelector('[data-dshdg-cleanup-check="task-ui-1"]'));
    await page.click(page.root.querySelector('[data-dshdg-cleanup-review]'));
    assert.ok(page.root.querySelector('[data-dshdg-cleanup-confirm-dialog]'));
    await page.fillDate('[data-dshdg-tree-day-from]', '2026-11-20');
    assert.equal(page.root.querySelector('[data-dshdg-cleanup-confirm-dialog]'), null);
    assert.equal(page.root.querySelector('[data-dshdg-cleanup-check="task-ui-1"]'), null);
    assert.equal(page.root.querySelector('[data-dshdg-cleanup-review]').disabled, true);
    assert.deepEqual(calls.cleanup, []);
    await page.toggle(page.root.querySelector('[data-dshdg-cleanup-check="task-legacy"]'));
    await page.click(page.root.querySelector('[data-dshdg-cleanup-review]'));
    await page.click(page.root.querySelector('[data-dshdg-cleanup-confirm]'));
    assert.deepEqual(calls.cleanup, [{ confirm: true, chains: [{ chainId: 'task-legacy', taskIds: ['task-legacy'] }] }]);
  } finally {
    await page?.unmount();
    store.dispose();
    dom.restore();
  }
});
