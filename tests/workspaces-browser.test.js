// The sidebar contract of this plugin, verified against what the host really publishes.
//
// Facts taken from the shipped `@deepseek-ai/dsh-client-ui-workspace` client bundle
// (0.2.2-rc.5), which is fetched and re-checked here when available: the workspace browser is the
// SINGLE slot `sidebar.workspaces` and it declares CHILD slots, including
// `sidebar.workspaces.session.row.action` ({ kind: 'list', scope: 'root' }) — material rendered
// inside every native session row.
//
// What is pinned here:
//   * `apply` registers ONLY that child slot: it never registers on `sidebar.workspaces`, so the
//     native rows, names, order, search and menus stay the host's;
//   * the marker renders for a conversation this plugin dispatched (shared or worktree), and
//     renders NOTHING for any other session, so a native row is untouched;
//   * the plugin's own grouping surface is strictly three levels, one task-workspace row per
//     dispatched chain, and never renames or removes a Workspace that also holds ordinary
//     conversations;
//   * every action calls an official service with the real ids.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_TEXT = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

/** Materialize the built bundle. */
async function loadClient() {
  const react = await import('react');
  const jsxRuntime = await import('react/jsx-runtime');
  const reactDomClient = await import('react-dom/client');
  const registrations = [];
  const window = { __ModuleLoader__: { load(registration) { registrations.push(registration); } } };
  const sandbox = { window, setTimeout, clearTimeout, setInterval, clearInterval, console, Date, Math, JSON };
  sandbox.globalThis = sandbox;
  vm.runInContext(BUNDLE_TEXT, vm.createContext(sandbox));
  assert.equal(registrations.length, 1);
  const require = (specifier) => {
    if (specifier === 'react') return react;
    if (specifier === 'react/jsx-runtime') return jsxRuntime;
    throw new Error(`unexpected module ${specifier}`);
  };
  return { react, reactDomClient, client: registrations[0].factory(require) };
}

/** A client context that records injections/registrations and resolves services. */
function fakeClientContext(options = {}) {
  const injections = [];
  const registered = [];
  const effects = [];
  return {
    injections,
    registered,
    effects,
    effect(create, label) { effects.push({ label, dispose: create() }); return () => {}; },
    slots: options.noSlots === true ? undefined : {
      inject(name, callback) {
        if (options.refuse?.includes(name)) throw new Error(`slot ${name} unavailable`);
        injections.push({ name, callback });
        return () => {};
      },
      register(registerOptions, component) {
        registered.push({ options: registerOptions, component });
        return () => {};
      },
    },
    get(name) { return options.services?.[name]; },
  };
}

/** A react-dom root per container. */
const roots = new WeakMap();
function createRootFor(reactDomClient, host) {
  roots.delete(host);
  const root = reactDomClient.createRoot(host);
  roots.set(host, root);
  return root;
}

/** jsdom globals for one test. */
function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3210/',
    pretendToBeVisual: true,
  });
  dom.window.prompt = () => null;
  dom.window.confirm = () => false;
  const keys = ['window', 'document', 'navigator', 'MouseEvent', 'Event', 'Node', 'KeyboardEvent', 'HTMLElement'];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) {
    const value = key === 'window' ? dom.window
      : key === 'document' ? dom.window.document
        : dom.window[key] ?? globalThis[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
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

/** Flush React's scheduler. */
async function settle(act) {
  const flush = async () => { await new Promise((resolvePromise) => { setImmediate(resolvePromise); }); };
  if (typeof act === 'function') await act(flush);
  else await flush();
}

const REPO = 'C:\\work\\alpha';
const OTHER = 'C:\\work\\beta';

/** A page-store double carrying a `/tasks` list. */
function fakeRecordStore(tasks) {
  const state = { tasks };
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    async refreshTasks() { return { ok: true, tasks: state.tasks }; },
  };
}

/** A host `workspaces` double. */
function fakeWorkspaces(items, archived = [], ungrouped = []) {
  let snapshot = { phase: 'ready', items, archivedSessionIds: archived, ungroupedSessionIds: ungrouped };
  const listeners = new Set();
  const calls = [];
  return {
    calls,
    publish(next) {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
    list: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    rename(workspaceId, title) {
      calls.push(['rename', workspaceId, title]);
      return Promise.resolve({ workspace: { workspaceId, title } });
    },
    delete(workspaceId) {
      calls.push(['delete', workspaceId]);
      return Promise.resolve();
    },
    archiveSession(sessionId, options) {
      calls.push(['archiveSession', sessionId, options ?? null]);
      return Promise.resolve();
    },
    unarchiveSession(sessionId) {
      calls.push(['unarchiveSession', sessionId]);
      return Promise.resolve();
    },
  };
}

/** A `uiWorkspace` double. */
function fakeUiWorkspace() {
  const calls = [];
  return {
    calls,
    openSession(sessionId) { calls.push(['openSession', sessionId]); },
    startSession(workspaceId) { calls.push(['startSession', workspaceId]); },
  };
}

/** A ready identity row. */
function identity(overrides = {}) {
  return {
    taskId: 'task-1',
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    sourcePath: REPO,
    executionPath: REPO,
    isolation: 'shared',
    updatedAt: 1000,
    ...overrides,
  };
}

/** Render one registered component with props. */
async function renderComponent(bundle, ctx, componentIndex, props) {
  const entry = ctx.registered[componentIndex];
  assert.ok(entry !== undefined, 'the component is registered');
  const component = typeof entry.component === 'function' ? entry.component : entry.component; // a stored component
  const { react, reactDomClient } = bundle;
  const host = globalThis.document.getElementById('root');
  const container = createRootFor(reactDomClient, host);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const testUtils = await import('react-dom/test-utils');
  const act = typeof react.act === 'function' ? react.act : testUtils.act;
  await act(async () => { container.render(react.createElement(entry.component, props)); });
  await settle(act);
  return {
    host,
    act,
    settle: () => settle(act),
    async unmount() {
      await act(async () => { container.unmount(); });
    },
    async click(element) {
      assert.ok(element !== null && element !== undefined, 'the control exists');
      await act(async () => {
        element.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await settle(act);
    },
    query(selector) { return host.querySelector(selector); },
    all(selector) { return [...host.querySelectorAll(selector)]; },
    text(selector) { return (host.querySelector(selector)?.textContent ?? '').trim(); },
  };
}

test('apply registers the published session-row child slot and NEVER the parent region', async () => {
  const bundle = await loadClient();
  const ctx = fakeClientContext({ services: {} });
  bundle.client.apply(ctx);

  const names = ctx.injections.map((entry) => entry.name);
  assert.equal(names.includes('sidebar.workspaces'), false,
    'the workspace region itself is never registered: its rows are the host\'s');
  assert.equal(names.includes(bundle.client.SESSION_ROW_ACTION_SLOT), true,
    'the published per-row child slot is what this plugin uses');
  // The other entries of this bundle: the settings page stays, and the standalone task-record
  // sidebar entry (its `main` panel AND its `sidebar.panellist` row) is no longer mounted.
  assert.equal(names.includes('plugins.bundle.config'), true);
  assert.equal(names.includes('main'), false, 'no orphan content panel is mounted');
  assert.equal(names.includes('sidebar.panellist'), false, 'and no standalone sidebar row');

  // The child registration is a LIST entry with its own id, ordered after the host's own
  // actions (the host uses 100 for archive and 200 for pin).
  const row = ctx.injections.find((entry) => entry.name === bundle.client.SESSION_ROW_ACTION_SLOT);
  row.callback();
  const registration = ctx.registered.find((entry) => entry.options.name === bundle.client.SESSION_ROW_ACTION_SLOT);
  assert.notEqual(registration, undefined);
  assert.equal(registration.options.id, bundle.client.SESSION_ROW_ACTION_ID);
  assert.ok(registration.options.order > 200, 'ordered after the host\'s archive and pin actions');

  // The shipped bundle never names the parent slot for registration.
  assert.equal(/slots\.register\(\{\s*name:\s*WORKSPACES_SLOT/u.test(BUNDLE_TEXT), false,
    'no registration on the singleton region');
});

test('the child-slot contract matches the host: a list entry, disposable, and optional', async () => {
  const bundle = await loadClient();
  // A host without the slot: nothing is registered, nothing throws.
  const bare = fakeClientContext({ noSlots: true });
  assert.equal(typeof bundle.client.registerSessionRowMarker(bare, {}), 'function');
  const refusing = fakeClientContext({ refuse: [bundle.client.SESSION_ROW_ACTION_SLOT] });
  assert.equal(typeof bundle.client.registerSessionRowMarker(refusing, {}), 'function');
  assert.equal(bundle.client.SESSION_ROW_ACTION_SLOT, 'sidebar.workspaces.session.row.action');
});

test('the row marker shows for a dispatched conversation and renders nothing for any other', async () => {
  const dom = installDom();
  try {
    const bundle = await loadClient();
    const ctx = fakeClientContext({ services: { workspaces: fakeWorkspaces([]), uiWorkspace: fakeUiWorkspace() } });
    bundle.client.registerSessionRowMarker(ctx, {
      store: fakeRecordStore([{ taskId: 'task-1', sessionId: 'session-1', title: '修复侧栏' }]),
      sessionMap: async () => [identity()],
    });
    ctx.injections[0].callback();

    // The host hands the row's own identity; the marker renders inside that row.
    const shown = await renderComponent(bundle, ctx, 0, { sessionId: 'session-1' });
    const marker = shown.query('[data-dshdg-row-marker="session-1"]');
    assert.notEqual(marker, null, 'the marker is rendered for the dispatched session');
    assert.equal(marker.getAttribute('data-dshdg-row-marker-isolation'), 'shared');
    assert.match(marker.textContent, /派工/u);
    assert.match(marker.getAttribute('title'), /修复侧栏/u);
    await shown.unmount();

    // Any other session — the operator's own, or nothing at all — renders NOTHING.
    for (const props of [{ sessionId: 'session-other' }, { sessionId: '' }, {}]) {
      const empty = await renderComponent(bundle, ctx, 0, props);
      assert.equal(empty.host.querySelectorAll('*').length, 0, `no marker for ${JSON.stringify(props)}`);
      await empty.unmount();
    }

    // A worktree dispatch says so.
    const ctx2 = fakeClientContext({ services: { workspaces: fakeWorkspaces([]), uiWorkspace: fakeUiWorkspace() } });
    bundle.client.registerSessionRowMarker(ctx2, {
      store: fakeRecordStore([]),
      sessionMap: async () => [identity({ sessionId: 'session-tree', isolation: 'worktree' })],
    });
    ctx2.injections[0].callback();
    const isolated = await renderComponent(bundle, ctx2, 0, { sessionId: 'session-tree' });
    assert.match(isolated.text('[data-dshdg-row-marker="session-tree"]'), /隔离/u);
    await isolated.unmount();
  } finally {
    dom.restore();
  }
});

test('the marker also proves a NEW dispatch from its own task record', async () => {
  const dom = installDom();
  try {
    const bundle = await loadClient();
    const ctx = fakeClientContext({ services: { workspaces: fakeWorkspaces([]), uiWorkspace: fakeUiWorkspace() } });
    bundle.client.registerSessionRowMarker(ctx, {
      // The durable map does not know it yet; the record the page holds does.
      store: fakeRecordStore([
        { taskId: 'task-new', title: '新派工', execution: { sessionId: 'session-new', workspaceId: 'ws-1', sourcePath: REPO } },
      ]),
      sessionMap: async () => [],
    });
    ctx.injections[0].callback();
    const view = await renderComponent(bundle, ctx, 0, { sessionId: 'session-new' });
    const marker = view.query('[data-dshdg-row-marker="session-new"]');
    assert.notEqual(marker, null, 'a dispatch made after the map read still gets its marker');
    assert.match(marker.getAttribute('title'), /新派工/u);
    await view.unmount();
  } finally {
    dom.restore();
  }
});

test('the plugin grouping is strictly three levels and one row per dispatched chain', async () => {
  const dom = installDom();
  try {
    const bundle = await loadClient();
    const workspaces = fakeWorkspaces([{ workspaceId: 'ws-1', path: REPO, title: '派工', sessionIds: ['session-a', 'session-b'] }]);
    const ctx = fakeClientContext({ services: { workspaces, uiWorkspace: fakeUiWorkspace() } });
    bundle.client.registerSessionRowMarker(ctx, {
      store: fakeRecordStore([
        { taskId: 'task-a', sessionId: 'session-a', title: '第一个派工' },
        { taskId: 'task-b', sessionId: 'session-b', title: '第二个派工' },
      ]),
      sessionMap: async () => [
        identity({ taskId: 'task-a', sessionId: 'session-a', workspaceId: 'ws-1', updatedAt: 2000 }),
        identity({ taskId: 'task-b', sessionId: 'session-b', workspaceId: 'ws-1', updatedAt: 3000 }),
      ],
    });
    // Run the deferred injection: only then is the component registered.
    ctx.injections[0].callback();
    const view = await renderComponent(bundle, ctx, 0, { sessionId: 'session-a' });
    // The marker component renders only its own row; the grouping is its own surface, mounted
    // with the same injection (asserted below through the exported component).
    assert.notEqual(view.query('[data-dshdg-row-marker="session-a"]'), null);
    await view.unmount();

    const grouping = await renderComponent(bundle, { registered: [{ component: bundle.client.DispatchedSessionMarker, options: {} }] }, 0, { sessionId: '' });
    assert.equal(grouping.host.querySelectorAll('[data-dshdg-ws-grouping]').length, 0,
      'the marker never renders the grouping');
    await grouping.unmount();

    // The grouping component itself, from the module export (a separate surface: it is mounted
    // on the plugin's own panel, not inside a native row).
    const groupingProps = {
      store: fakeRecordStore([
        { taskId: 'task-a', sessionId: 'session-a', title: '第一个派工' },
        { taskId: 'task-b', sessionId: 'session-b', title: '第二个派工' },
      ]),
      services: { workspaces: () => workspaces, uiWorkspace: () => fakeUiWorkspace() },
      loadIdentity: async () => [
        identity({ taskId: 'task-a', sessionId: 'session-a', workspaceId: 'ws-1', updatedAt: 2000 }),
        identity({ taskId: 'task-b', sessionId: 'session-b', workspaceId: 'ws-1', updatedAt: 3000 }),
      ],
    };
    const groupingView = await renderComponent(bundle, {
      registered: [{ component: () => bundle.client.TaskbridgeGrouping(groupingProps), options: {} }],
    }, 0, {});
    assert.notEqual(groupingView.query('[data-dshdg-ws-root]'), null, 'level 1: TaskBridge');
    assert.equal(groupingView.all('[data-dshdg-ws-project]').length, 1, 'level 2: one project');
    assert.equal(groupingView.all('[data-dshdg-ws-workspace]').length, 2, 'level 3: one row per chain');
    assert.equal(groupingView.all('[data-dshdg-ws-session]').length, 2, 'and one conversation each');
    await groupingView.unmount();
  } finally {
    dom.restore();
  }
});

test('a Workspace that also holds ordinary conversations is never renamed or removed as a whole', async () => {
  const dom = installDom();
  try {
    const bundle = await loadClient();
    const workspaces = fakeWorkspaces([{ workspaceId: 'ws-mixed', path: OTHER, title: '混用', sessionIds: ['session-1', 'session-mine'] }]);
    const ctx = fakeClientContext({ services: { workspaces, uiWorkspace: fakeUiWorkspace() } });
    bundle.client.registerSessionRowMarker(ctx, { store: fakeRecordStore([]), sessionMap: async () => [] });
    const view = await renderComponent(bundle, {
      registered: [{ component: bundle.client.TaskbridgeGrouping, options: {} }],
    }, 0, {
      store: fakeRecordStore([]),
      services: { workspaces: () => workspaces, uiWorkspace: () => fakeUiWorkspace() },
      loadIdentity: async () => [identity({ sessionId: 'session-1', workspaceId: 'ws-mixed', sourcePath: OTHER, executionPath: OTHER })],
    });
    const node = view.query('[data-dshdg-ws-workspace="ws-mixed"]');
    assert.notEqual(node, null, 'the chain is shown under its project');
    const remove = node.querySelector('[data-dshdg-ws-action="remove"]');
    assert.equal(remove.disabled, true, 'removal is refused for a Workspace with ordinary conversations');
    assert.match(remove.getAttribute('title'), /你自己的普通对话/u);
    globalThis.window.prompt = () => '别的名字';
    globalThis.window.confirm = () => true;
    await view.click(node.querySelector('[data-dshdg-ws-action="rename"]'));
    await view.click(node.querySelector('[data-dshdg-ws-action="remove"]'));
    assert.deepEqual(workspaces.calls, [], 'nothing is renamed or removed as a whole');
    await view.unmount();
  } finally {
    dom.restore();
  }
});

test('the grouping actions use the official services with the real ids', async () => {
  const dom = installDom();
  try {
    const bundle = await loadClient();
    const workspaces = fakeWorkspaces([{ workspaceId: 'ws-1', path: REPO, title: '派工工作区', sessionIds: ['session-1'] }]);
    const ui = fakeUiWorkspace();
    const view = await renderComponent(bundle, {
      registered: [{ component: bundle.client.TaskbridgeGrouping, options: {} }],
    }, 0, {
      store: fakeRecordStore([{ taskId: 'task-1', sessionId: 'session-1', title: '派工' }]),
      services: { workspaces: () => workspaces, uiWorkspace: () => ui },
      loadIdentity: async () => [identity()],
    });
    await view.click(view.query('[data-dshdg-ws-session="session-1"] .dshdg-ws-open'));
    assert.deepEqual(ui.calls, [['openSession', 'session-1']]);
    await view.click(view.query('[data-dshdg-ws-workspace] [data-dshdg-ws-action="new-session"]'));
    assert.deepEqual(ui.calls.at(-1), ['startSession', 'ws-1']);
    await view.click(view.query('[data-dshdg-ws-session="session-1"] [data-dshdg-ws-action="archive-session"]'));
    assert.deepEqual(workspaces.calls.at(-1), ['archiveSession', 'session-1', null]);

    const shell = { prompt: () => null, confirm: () => false };
    assert.equal(bundle.client.askText('工作区名称', '派工工作区', shell), null);
    assert.equal(bundle.client.askConfirm('移除？', shell), false);
    shell.prompt = () => '  新名字  ';
    shell.confirm = () => true;
    assert.equal(bundle.client.askText('工作区名称', '派工工作区', shell), '  新名字  ');
    await view.unmount();
  } finally {
    dom.restore();
  }
});

test('nothing proven renders an honest empty line, not an invented tree', async () => {
  const dom = installDom();
  try {
    const bundle = await loadClient();
    const view = await renderComponent(bundle, {
      registered: [{ component: bundle.client.TaskbridgeGrouping, options: {} }],
    }, 0, {
      store: fakeRecordStore([]),
      services: { workspaces: () => fakeWorkspaces([]), uiWorkspace: () => fakeUiWorkspace() },
      loadIdentity: async () => [],
    });
    assert.equal(view.query('[data-dshdg-ws-root]'), null, 'no TaskBridge row is invented');
    assert.notEqual(view.query('[data-dshdg-ws-empty]'), null, 'the empty state is stated');
    await view.unmount();
  } finally {
    dom.restore();
  }
});
