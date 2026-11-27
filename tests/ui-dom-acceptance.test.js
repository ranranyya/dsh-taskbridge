// Real-DOM acceptance for the two UI requirements (TB151 UI round, correction pass).
//
// This file renders the ACTUAL `DelegateConfigPage` component from
// `src/client/index.jsx` into a jsdom document with React's real renderer, and
// dispatches real DOM events on the real controls. It does not pattern-match source and
// does not call store actions on the page's behalf: the click has to travel through the
// rendered tree, the same way it does in the browser.
//
// Covered:
//   A. "详情" opens a detail panel that appears ABOVE the list, is focusable and receives
//      focus/scroll on open; a long review note is shown IN FULL on the first open (no
//      second "展开全文" click); a background list refresh keeps the loaded body; a
//      refused read is visible; a NEW conclusion never shows the previous body.
//   B. Every setting edit auto-saves: a switch saves immediately (0 ms debounce), a text
//      field debounces, and no "保存设置"/"只保存监控间隔" button exists any more.
//   C. Save races: a slow PUT never overwrites a newer edit; an invalid draft is never
//      sent and is kept for correction; a failed save keeps the draft and reports it.
//
// The store is the REAL one from `src/client/api.js`; only the transport (`fetch`) is a
// scripted double, and its answers are the host's NORMALIZED documents (a save always
// answers with the document that was sent, which is what the real user plane does).

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

/**
 * A minimal but real jsdom window for one test.
 *
 * Node 24 exposes `navigator` as a read-only global getter, so every global this test
 * replaces is installed with `defineProperty` (and reverted the same way).
 * @returns {{ dom: object, restore: () => void }} the window and its teardown.
 */
function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3210/',
    pretendToBeVisual: true,
  });
  const keys = ['window', 'document', 'navigator', 'MouseEvent', 'Event', 'Node'];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const define = (key, value) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  define('window', dom.window);
  define('document', dom.window.document);
  define('navigator', dom.window.navigator);
  define('MouseEvent', dom.window.MouseEvent);
  define('Event', dom.window.Event);
  define('Node', dom.window.Node);
  // jsdom has no layout, so `scrollIntoView` is not implemented; record the requests the
  // page makes and let the assertions inspect them (the page keeps no self-report).
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
 * Load the client module the way the browser does: run the BUILT bundle
 * (`lib/client.js`) through `window.__ModuleLoader__`, then materialize its factory with
 * the real `react` / `react/jsx-runtime` instances from this checkout.
 *
 * The `.jsx` source cannot be imported by Node directly (no loader for that extension),
 * and the bundle IS the production artifact the web client evaluates, so rendering it is
 * both the only option and the more faithful one.
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
  // The bundle runs inside a bare vm context; it needs the same timer/globals a browser
  // provides (the auto-refresh hook schedules with `setTimeout`).
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
  const client = registrations[0].factory(require);
  return { react, reactDomClient, client };
}

/**
 * Whether every store load has settled.
 * @param {object} store - the store under test.
 * @returns {boolean} true when nothing is loading.
 */
function loadsSettled(store) {
  const loading = store.getSnapshot().loading ?? {};
  return Object.values(loading).every((value) => value !== true);
}

/**
 * Flush React's scheduler and pending microtasks.
 *
 * Every wait happens INSIDE `act` when a root is known, so updates that the store
 * triggers asynchronously (a save answering, a detail arriving) are accounted for and
 * React does not warn about updates outside `act`.
 * @param {object} [act] - React's `act`; when supplied, the flush runs inside it.
 * @param {object} [store] - when supplied, also wait until every load has settled.
 * @returns {Promise<void>} resolves once the queue is drained.
 */
async function settle(act, store) {
  const flush = async () => {
    // Long enough for: the debounce tick (5 ms), the PUT microtask chain and the store's
    // re-render that follows it. Everything inside `act`, so React accounts for it.
    for (let index = 0; index < 30; index += 1) {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 2); });
    }
    if (store !== undefined && store !== null) {
      for (let attempt = 0; attempt < 200 && !loadsSettled(store); attempt += 1) {
        await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
      }
      // The save flag plus one more frame so the committed DOM matches the store.
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

/** A settings document the client precheck accepts, as the host would serve it. */
function hostSettings(overrides = {}) {
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
    ...overrides,
  };
}

/** One task row/full record shaped like the user plane publishes. */
function taskRecord(overrides = {}) {
  return {
    taskId: 'task-1',
    title: '测试任务',
    state: 'awaiting-host-review',
    phase: 'awaiting-host-review',
    createdAt: 1_763_200_000_000,
    startedAt: 1_763_200_000_000,
    endedAt: 1_763_200_100_000,
    workspacePath: 'C:\\work',
    isolation: 'worktree',
    effective: { worker: { providerId: 'relay', model: 'm', reasoningEffort: 'high' } },
    hostAcceptance: null,
    archived: false,
    live: true,
    ...overrides,
  };
}

/**
 * A store over a scripted user-plane double that behaves like the real one.
 *
 * `putSettings` always answers with the document it received, which is what the real
 * host does (it validates and stores exactly that document); an answer that disagreed
 * with the sent value would make "saved" a lie.
 * @param {object} [options] - `settings`, `tasks`, `getTask`, `putSettings`.
 * @returns {object} `{ store, puts }`.
 */
async function makeStore(options = {}) {
  const { client } = await loadClient();
  // The store lives in the plain-JS `api.js` module (index.jsx re-exports only the
  // documented body helpers), so it is imported directly here — it is the SAME store the
  // built page renders, not a re-implementation.
  const apiModule = await import('../src/client/api.js');
  const puts = [];
  const api = {
    async getStatus() { return { ok: true }; },
    async getSettings() { return { ok: true, settings: options.settings ?? hostSettings() }; },
    async getNativeProviders() { return { ok: true, providers: [] }; },
    async listTasks() {
      return await (options.listTasks ?? (async () => ({ ok: true, tasks: options.tasks ?? [taskRecord()] })))();
    },
    async getTask(taskId) {
      return await (options.getTask ?? (async () => ({ ok: true, task: taskRecord() })))(taskId);
    },
    async putSettings(document) {
      puts.push(document);
      if (typeof options.putSettings === 'function') return await options.putSettings(document);
      return { ok: true, settings: document };
    },
  };
  const store = apiModule.createStore({ api, saveDebounceMs: 5 });
  return { store, puts, client };
}

/** Render the real page into the jsdom root and return a query helper. */
async function renderPage(store) {
  const { react, reactDomClient, client } = await loadClient();
  // Load the store BEFORE the first commit: the page calls `store.init()` on mount, and
  // letting those reads resolve after the first render is exactly what makes React 18
  // warn about updates outside `act`. Pre-loading makes the first paint complete.
  await store.init();
  const root = globalThis.document.getElementById('root');
  const container = reactDomClient.createRoot(root);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // `act` comes from react-dom/test-utils in React 18; `react.act` exists from 18.3.
  // Either way it must wrap the render so effects (init, focus) flush deterministically.
  const testUtils = await import('react-dom/test-utils');
  const act = typeof react.act === 'function' ? react.act : testUtils.act;
  await act(async () => {
    container.render(react.createElement(client.DelegateConfigPage, { store }));
    await settle();
  });
  await act(() => settle(undefined, store));
  return {
    container,
    root,
    act,
    /** Flush inside `act`, so asynchronous store updates are accounted for. */
    settle: () => settle(act, store),
    /** Unmount inside `act` (a root update otherwise warns). */
    async unmount() {
      await act(async () => { container.unmount(); });
    },
    /**
     * Open one settings tab by its visible label, the way an operator does.
     * @param {string} label - tab label text.
     * @returns {void}
     */
    async openTab(label) {
      const tab = [...root.querySelectorAll('[role="tablist"] button')]
        .find((button) => (button.textContent ?? '').includes(label));
      if (tab === undefined) throw new Error(`no tab labelled ${JSON.stringify(label)}`);
      await act(async () => {
        tab.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true }));
        await settle();
      });
    },
    /** Click the first button whose trimmed text equals `text` inside a CSS selector scope. */
    clickText(text, scope = root) {
      const buttons = [...scope.querySelectorAll('button')];
      const target = buttons.find((button) => (button.textContent ?? '').trim() === text);
      if (target === undefined) {
        throw new Error(`no button with text ${JSON.stringify(text)}; saw ${buttons.map((b) => b.textContent.trim()).join(' | ')}`);
      }
      target.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true }));
      return target;
    },
  };
}

test('DOM: clicking 详情 shows the detail ABOVE the list, focuses and scrolls to it, and shows a long review note in FULL at once', async () => {
  const dom = installDom();
  try {
    const longNote = '这是一段很长的审查意见。'.repeat(40);
    const full = taskRecord({
      hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1_763_200_050_000, by: 'host', note: longNote },
    });
    const { store } = await makeStore({ tasks: [taskRecord()], getTask: async () => ({ ok: true, task: full }) });
    const page = await renderPage(store);
    await page.openTab('任务记录');

    // No detail before the click.
    assert.equal(page.root.querySelector('[data-dshdg-task-detail]'), null);

    await page.act(async () => {
      page.clickText('详情');
      await page.settle();
    });
    await page.settle();

    const detail = page.root.querySelector('[data-dshdg-task-detail]');
    assert.ok(detail !== null, 'the detail panel is rendered after the click');
    assert.equal(detail.getAttribute('tabindex'), '-1', 'and it is programmatically focusable');

    // FOCUS: the panel itself took focus in the document.
    assert.equal(globalThis.document.activeElement, detail, 'focus moved to the opened detail panel');
    // SCROLL: the page asked to bring THAT element into view.
    assert.equal(dom.scrolled.length > 0, true, 'the page requested a scroll');
    assert.equal(dom.scrolled.at(-1).node, detail, 'and it scrolled to the detail panel itself');
    assert.equal(dom.scrolled.at(-1).options.block, 'start');

    // The panel sits BEFORE the list in document order: it is not buried under it.
    const list = page.root.querySelector('.dshdg-list');
    assert.ok(list !== null);
    const position = detail.compareDocumentPosition(list);
    assert.equal((position & globalThis.Node.DOCUMENT_POSITION_FOLLOWING) !== 0, true,
      'the detail panel precedes the task list in the document');

    // The full note body is rendered immediately — no second "展开全文" click.
    const note = detail.querySelector('[data-dshdg-note-full] pre');
    assert.ok(note !== null, 'the full review note is rendered on the first open');
    assert.equal(note.textContent, longNote, 'and its text is the WHOLE note');
    assert.equal([...detail.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('展开全文')), false,
      'no second expand step is offered');

    await page.unmount();
    store.dispose();
  } finally {
    dom.restore();
  }
});

test('DOM: every successful open re-focuses and re-scrolls (first / repeat / switch), and a background refresh scrolls 0 times', async () => {
  const dom = installDom();
  try {
    const rowA = taskRecord({ taskId: 'task-a', title: 'A' });
    const rowB = taskRecord({ taskId: 'task-b', title: 'B' });
    const { store } = await makeStore({
      tasks: [rowA, rowB],
      getTask: async (taskId) => ({
        ok: true,
        task: taskRecord({ taskId, title: taskId === 'task-a' ? 'A' : 'B' }),
      }),
    });
    const page = await renderPage(store);
    await page.openTab('任务记录');

    /** The browser's focus, as the operator would find it. */
    const active = () => globalThis.document.activeElement;
    /** How many scroll requests the page made so far. */
    const scrollCount = () => dom.scrolled.length;
    /** Focus the row button like a keyboard user would, then click it. */
    const clickRowButton = async (taskId) => {
      const row = [...page.root.querySelectorAll('.dshdg-item')]
        .find((item) => (item.querySelector('.dshdg-item-head span')?.textContent ?? '') === (taskId === 'task-a' ? 'A' : 'B'));
      assert.ok(row !== undefined, `row ${taskId} is rendered`);
      const button = [...row.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '详情');
      assert.ok(button !== undefined);
      await page.act(async () => {
        button.focus();          // start from the button, NOT from the detail
        button.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true }));
        await page.settle();
      });
      await page.settle();
    };

    // 1. FIRST open: focus moves into the detail, and it scrolled exactly once more.
    await clickRowButton('task-a');
    const first = scrollCount();
    assert.equal(first > 0, true, 'the first open requested a scroll');
    assert.equal(active(), page.root.querySelector('[data-dshdg-task-detail]'),
      'the first open moved focus to the detail');
    assert.equal(dom.scrolled.at(-1).node, page.root.querySelector('[data-dshdg-task-detail]'));
    assert.equal(dom.scrolled.at(-1).options.block, 'start');

    // 2. REPEAT open of the SAME task: focus is taken again and it scrolls once more.
    await clickRowButton('task-a');
    const second = scrollCount();
    assert.equal(second, first + 1, 'a repeat open of the same task scrolled exactly once more');
    assert.equal(active(), page.root.querySelector('[data-dshdg-task-detail]'),
      'a repeat open of the same task re-focused the detail');

    // 3. SWITCH to a different task: same again, and the panel is B's.
    await clickRowButton('task-b');
    const third = scrollCount();
    assert.equal(third, second + 1, 'switching tasks scrolled exactly once more');
    assert.equal(active(), page.root.querySelector('[data-dshdg-task-detail]'));
    assert.equal(page.root.querySelector('[data-dshdg-task-detail]').textContent.includes('B'), true,
      'the switched detail describes the newly opened task');

    // 4. BACKGROUND refresh: it recomposes the same detail but must steal NO focus and
    //    request NO scroll.
    const beforeRefresh = scrollCount();
    await page.act(async () => {
      await store.refreshTasks('auto');
    });
    await page.settle();
    assert.equal(scrollCount(), beforeRefresh, 'a background refresh requested 0 scrolls');
    assert.equal(active(), page.root.querySelector('[data-dshdg-task-detail]'),
      'and it left the focus alone');

    await page.unmount();
    store.dispose();
  } finally {
    dom.restore();
  }
});

test('DOM: 查看完整审查意见 opens the note in ONE click, and repeated clicks / task switches stay consistent', async () => {
  const dom = installDom();
  try {
    const noteA = '任务 A 的完整审查意见。'.repeat(30);
    const noteB = '任务 B 的完整审查意见。'.repeat(30);
    const rowA = taskRecord({
      taskId: 'task-a',
      title: 'A',
      // A compact list row: the body is NOT in the list, which is exactly when the
      // "查看完整审查意见" link appears.
      hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1_000, by: 'host', noteChars: noteA.length, noteOmitted: true },
    });
    const rowB = taskRecord({
      taskId: 'task-b',
      title: 'B',
      hostAcceptance: { accepted: false, state: 'changes-requested', acceptedAt: 2_000, by: 'host', noteChars: noteB.length, noteOmitted: true },
    });
    const fullA = { ...rowA, hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1_000, by: 'host', note: noteA } };
    const fullB = { ...rowB, hostAcceptance: { accepted: false, state: 'changes-requested', acceptedAt: 2_000, by: 'host', note: noteB } };
    const { store } = await makeStore({
      tasks: [rowA, rowB],
      getTask: async (taskId) => ({ ok: true, task: taskId === 'task-a' ? fullA : fullB }),
    });
    const page = await renderPage(store);
    await page.openTab('任务记录');

    // The link is offered because the row carries only the length.
    const links = [...page.root.querySelectorAll('button')].filter((b) => (b.textContent ?? '').includes('查看完整审查意见'));
    assert.equal(links.length, 2, 'one link per compact review row');

    // ONE click on task A's link: the detail opens with the WHOLE body.
    await page.act(async () => {
      links[0].dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true }));
      await page.settle();
    });
    await page.settle();
    const opened = page.root.querySelector('[data-dshdg-task-detail]');
    assert.ok(opened !== null, 'one click opened the detail');
    assert.equal(opened.querySelector('[data-dshdg-note-full] pre')?.textContent, noteA,
      'and the full body of A is shown without a second click');

    // REPEATED clicks on the same link do not corrupt the view.
    await page.act(async () => {
      const again = [...page.root.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('查看完整审查意见'));
      again.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true }));
      await page.settle();
    });
    await page.settle();
    assert.equal(page.root.querySelectorAll('[data-dshdg-task-detail]').length, 1, 'exactly one detail panel exists');
    assert.equal(page.root.querySelector('[data-dshdg-task-detail] [data-dshdg-note-full] pre')?.textContent, noteA);

    // SWITCHING to task B shows B's own body, never A's.
    await page.act(async () => {
      const again = [...page.root.querySelectorAll('button')].filter((b) => (b.textContent ?? '').includes('查看完整审查意见'));
      again[1].dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true }));
      await page.settle();
    });
    await page.settle();
    const switched = page.root.querySelector('[data-dshdg-task-detail] [data-dshdg-note-full] pre');
    assert.equal(switched?.textContent, noteB, 'the switched task shows its own review body');

    await page.unmount();
    store.dispose();
  } finally {
    dom.restore();
  }
});

test('DOM: a background list refresh keeps the loaded review note (compact summary) and a NEW conclusion drops the old text', async () => {
  const dom = installDom();
  try {
    const longNote = '完整审查意见正文。'.repeat(50);
    const full = taskRecord({
      hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1_000, by: 'host', note: longNote },
    });
    // The LIST row carries a COMPACT conclusion: same decision, body omitted.
    const compactRow = taskRecord({
      hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1_000, by: 'host', noteChars: 400, noteOmitted: true },
    });
    let rows = [taskRecord({ hostAcceptance: null })];
    const { store } = await makeStore({
      getTask: async () => ({ ok: true, task: full }),
      listTasks: async () => ({ ok: true, tasks: rows }),
    });
    const page = await renderPage(store);
    await page.openTab('任务记录');
    await page.act(async () => {
      page.clickText('详情');
      await page.settle();
    });
    assert.equal(page.root.querySelector('[data-dshdg-note-full] pre').textContent, longNote);

    // A background refresh returns the compact row for the SAME recorded conclusion.
    rows = [compactRow];
    await page.act(async () => {
      await store.refreshTasks('auto');
    });
    await page.settle();
    const afterRefresh = page.root.querySelector('[data-dshdg-task-detail] [data-dshdg-note-full] pre');
    assert.ok(afterRefresh !== null, 'the note block survives the refresh');
    assert.equal(afterRefresh.textContent, longNote, 'a compact row never empties the body that was already read');

    // A NEW recorded conclusion must NOT inherit the previous body.
    const newNote = '新的审查结论正文。';
    rows = [taskRecord({
      hostAcceptance: { accepted: false, state: 'changes-requested', acceptedAt: 2_000, by: 'host', note: newNote },
    })];
    await page.act(async () => {
      await store.refreshTasks('auto');
    });
    await page.settle();
    const replaced = page.root.querySelector('[data-dshdg-task-detail] [data-dshdg-note-full] pre');
    assert.equal(replaced.textContent, newNote, 'a new conclusion shows its own body, never the old one');

    await page.unmount();
    store.dispose();
  } finally {
    dom.restore();
  }
});

test('DOM: a refused detail read is visible instead of a silent no-op', async () => {
  const dom = installDom();
  try {
    const { store } = await makeStore({
      getTask: async () => { throw Object.assign(new Error('no such task'), { code: 'JOB_TASK_NOT_FOUND' }); },
    });
    const page = await renderPage(store);
    await page.openTab('任务记录');
    await page.act(async () => {
      page.clickText('详情');
      await page.settle();
    });
    const warn = [...page.root.querySelectorAll('[role="alert"], .dshdg-warn')]
      .map((node) => node.textContent).join(' ');
    assert.match(warn, /打开任务详情失败/u, 'the refusal is stated in the panel');
    assert.match(warn, /任务不存在/u, 'and it carries the host refusal reason');

    await page.unmount();
    store.dispose();
  } finally {
    dom.restore();
  }
});

test('DOM: an execution select saves immediately and a text field debounces without a manual save button', async () => {
  const dom = installDom();
  try {
    const { store, puts } = await makeStore();
    const page = await renderPage(store);

    // The old manual save controls are gone.
    const labels = [...page.root.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
    assert.equal(labels.some((label) => label.includes('保存设置')), false, 'no whole-document save button');
    assert.equal(labels.some((label) => label.includes('只保存监控间隔')), false, 'no narrow monitoring save button');

    // The status line exists and starts settled.
    const status = page.root.querySelector('[data-dshdg-autosave]');
    assert.ok(status !== null, 'the auto-save status line is rendered');
    assert.match(status.textContent, /已保存|所有修改已保存/u);

    assert.equal(page.root.querySelector('#dshdg-tab-review'), null);
    await page.openTab('执行设置');
    const isolation = page.root.querySelector('#dshdg-worker-isolation');
    assert.ok(isolation);
    await page.act(async () => {
      isolation.value = isolation.value === 'shared' ? 'worktree' : 'shared';
      isolation.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
      await page.settle();
    });
    await page.settle();
    assert.equal(puts.length, 1, 'the select triggered exactly one whole-document PUT');
    assert.equal(puts[0].worker.isolation, isolation.value);
    assert.equal(Object.hasOwn(puts[0], 'review'), false);
    assert.match(page.root.querySelector('[data-dshdg-autosave]').textContent, /已保存/u);

    // The retired execution timeout is NOT offered any more: an ordinary run has no
    // total deadline, so a control for one would be a setting nobody should tune.
    assert.equal(page.root.querySelector('#dshdg-worker-timeout'), null,
      'the execution timeout control is gone');
    assert.doesNotMatch(page.root.textContent, /超时（秒）/u);
    // A text field debounces: two keystrokes inside the window become one PUT. The
    // selection inputs are selects (immediate), so the debounced control is a numeric
    // one — the parallelism field.
    const parallelism = page.root.querySelector('#dshdg-worker-parallelism');
    assert.ok(parallelism !== null);
    const setValue = globalThis.Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, 'value').set;
    await page.act(async () => {
      setValue.call(parallelism, '2');
      parallelism.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
      setValue.call(parallelism, '3');
      parallelism.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
      await page.settle();
    });
    await page.settle();
    assert.equal(puts.length, 2, 'the debounced pair produced one additional PUT');
    assert.equal(puts[1].worker.maxParallelism, 3, 'the PUT body is the latest value');

    await page.unmount();
    store.dispose();
  } finally {
    dom.restore();
  }
});

test('DOM: an invalid edit is reported in the status line and never sent', async () => {
  const dom = installDom();
  try {
    const { store, puts } = await makeStore();
    const page = await renderPage(store);
    await page.openTab('执行设置');
    // The parallelism field refuses an out-of-range value locally, so nothing is sent
    // and the status line states the refusal with the last valid configuration.
    const parallelism = page.root.querySelector('#dshdg-worker-parallelism');
    const setValue = globalThis.Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, 'value').set;
    await page.act(async () => {
      setValue.call(parallelism, '99');
      parallelism.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
      await page.settle();
    });
    await page.settle();
    assert.equal(puts.length, 0, 'an invalid draft is never sent');
    const status = page.root.querySelector('[data-dshdg-autosave]').textContent;
    assert.match(status, /未保存/u, 'the status line says it was not saved');
    assert.match(page.root.textContent, /上次有效配置仍然生效|最大并发/u, 'and it names the reason / last valid config');

    await page.unmount();
    store.dispose();
  } finally {
    dom.restore();
  }
});
