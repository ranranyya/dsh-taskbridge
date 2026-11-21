// G08: the bundle's native left-navigation entry.
//
// Three kinds of checks, each picking the cheapest faithful one for its claim:
//
//   1. REGISTRATION against the real slot names, driven through the BUILT bundle
//      (`lib/client.js`) and a fake client context. Slot names, ids and the inject
//      face are facts about the host contract, so they are asserted on what is
//      actually registered, never pattern-matched from source.
//   2. PROJECTION through `navViewModel`, on the same `/tasks` fixture the tree
//      tests use (built by the REAL `buildTaskTree`), so the fields are the host's.
//   3. RENDERING of the real panel into jsdom, with real clicks: collapsing,
//      showing TaskBridge-archived rows, and asking DSH to open a session.
//
// What is pinned here, in the words of the work unit:
//   * both entries register on the real slot names, sharing one id;
//   * a host with only one slot (or none) still gets the half it declares, and the
//     settings page is untouched either way;
//   * same-titled projects stay two groups, and "来源未确认" never merges into one;
//   * a record with no recorded session id is listed but cannot be opened;
//   * `openSession` is only called with an id TaskBridge actually recorded, and a
//     refusal (archived / unknown / no service) is stated in readable copy;
//   * the archived toggle only changes this list: no host call is made for it;
//   * nothing is renamed, moved or archived, and the panel issues no per-row read.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';

import { tasksBody, tasksBodyFlatTree, tasksBodyWithoutTree, threeLevelProjection } from './helpers/tree-fixtures.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Materialize the built bundle the way `@deepseek-ai/dsh-client-modules` does.
 * @returns {Promise<object>} `{ react, reactDomClient, client, requests }`.
 */
async function loadClient() {
  const react = await import('react');
  const jsxRuntime = await import('react/jsx-runtime');
  const reactDomClient = await import('react-dom/client');
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const registrations = [];
  const window = { __ModuleLoader__: { load(registration) { registrations.push(registration); } } };
  const sandbox = { window, setTimeout, clearTimeout, setInterval, clearInterval, console, Date, Math, JSON };
  sandbox.globalThis = sandbox;
  vm.runInContext(bundle, vm.createContext(sandbox));
  assert.equal(registrations.length, 1, 'lib/client.js registers exactly one module');
  const requests = [];
  const require = (specifier) => {
    requests.push(specifier);
    if (specifier === 'react') return react;
    if (specifier === 'react/jsx-runtime') return jsxRuntime;
    throw new Error(`lib/client.js requested an unexpected module ${JSON.stringify(specifier)}`);
  };
  return { react, reactDomClient, client: registrations[0].factory(require), requests };
}

/** A client context that records every slot injection and registration. */
function fakeClientContext(options = {}) {
  const effects = [];
  const injections = [];
  const registered = [];
  const ctx = {
    effects,
    injections,
    registered,
    effect(create, label) {
      effects.push({ label, disposer: create() });
      return () => {};
    },
    slots: options.noSlots === true ? undefined : {
      inject(name, callback) {
        if (options.refuse?.includes(name)) throw new Error(`slot ${name} is not available`);
        injections.push({ name, callback });
        return () => {};
      },
      register(registerOptions, component) {
        registered.push({ options: registerOptions, component });
        const entry = registered[registered.length - 1];
        return () => { entry.disposed = true; };
      },
    },
    get(name) {
      return options.services?.[name];
    },
  };
  return ctx;
}

/**
 * A jsdom window for one test, with the globals the real page needs.
 * @returns {{ dom: object, restore: () => void }} window and teardown.
 */
function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3210/',
    pretendToBeVisual: true,
  });
  const keys = ['window', 'document', 'navigator', 'MouseEvent', 'Event', 'Node', 'KeyboardEvent', 'HTMLElement',
    // The bundle runs in a vm context over the Node globals, so a test in the SAME
    // process must hand it the globals it reads, or scheduling (and its cleanup)
    // would silently miss this realm.
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];
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

/** Flush React's scheduler and pending microtasks. */
async function settle(act) {
  const flush = async () => {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 2); });
    }
  };
  if (typeof act === 'function') {
    await act(flush);
    return;
  }
  await flush();
}

/**
 * A store over a scripted user-plane double, plus the call counters a test asserts on.
 * @param {object} [options] - `listTasks`, `fail`.
 * @returns {Promise<object>} `{ store, calls }`.
 */
async function makeStore(options = {}) {
  const apiModule = await import('../src/client/api.js');
  const calls = { listTasks: 0 };
  const api = {
    async listTasks() {
      calls.listTasks += 1;
      if (options.fail === true) throw Object.assign(new Error('the durable task history could not be read'), { code: 'JOB_HISTORY_UNREADABLE' });
      return await (options.listTasks ?? (async () => tasksBody()))();
    },
  };
  const store = apiModule.createStore({ api, saveDebounceMs: 5 });
  return { store, calls };
}

/**
 * Render the real panel into `#root`.
 * @param {object} bundle - `loadClient()` result.
 * @param {object} props - panel props.
 * @returns {Promise<object>} render helpers.
 */
async function renderPanel(bundle, props) {
  const { react, reactDomClient } = bundle;
  const component = bundle.client.TaskbridgeNavPanel;
  assert.equal(typeof component, 'function', 'the bundle exports the panel');
  const root = globalThis.document.getElementById('root');
  const container = reactDomClient.createRoot(root);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const testUtils = await import('react-dom/test-utils');
  const act = typeof react.act === 'function' ? react.act : testUtils.act;
  await act(async () => {
    container.render(react.createElement(component, props));
  });
  await settle(act);
  return {
    root,
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
    text(selector) {
      return (root.querySelector(selector)?.textContent ?? '').trim();
    },
  };
}

// G10: the TaskBridge view inside the shell's workspace region.
//
// The claims pinned here are the ones a reviewer can re-check in a real DSH:
//   * every recorded task is listed, SHARED ones included, under the project its
//     record names, and a continuation is one row with its rounds, not a second
//     task;
//   * a row opens only a session the host's own snapshot vouches for, through the
//     same `openSession` call the native rows use;
//   * a missing / archived session is still listed and says why it cannot open;
//   * "原视图" hands the region back to the host's own `<slot>` view, and back;
//   * the view issues no request of its own beyond the one initial list read.

/** Render the workspace view into `#root` with the real bundle. */
/** A host Workspace service double over a fixed snapshot. */
function fakeWorkspaces(items, archived = []) {
  const snapshot = { phase: 'ready', items, archivedSessionIds: archived, pinnedSessionIds: [] };
  return {
    list: { getSnapshot: () => snapshot, subscribe: () => () => {} },
  };
}

/**
 * The same double, answering with a FRESH object per read (what a foreign or older
 * host may do). The view must still verify sessions instead of drifting to "unknown".
 */
/**
 * A host Workspace service double whose published snapshot can CHANGE while the view
 * is mounted - the case a real DSH produces when a Session starts after the sidebar
 * has subscribed. `publish()` replaces the whole value (as DSH does) and notifies.
 */
/** A `uiWorkspace` double that records every open. */
/**
 * Two records in one real task-body shape: an isolated round continued by a second
 * round, and a later shared task in the user's own project directory.
 */
/** Poll a predicate on real time (a background read is not driven by act()). */
async function untilTrue(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (await predicate() === true) return true;
    } catch { /* re-check */ }
    if (Date.now() > deadline) return false;
    await new Promise((resolvePending) => { setTimeout(resolvePending, 100); });
  }
}

/**

/**
 * A chain fixture whose rounds arrive NEWEST FIRST, as DSH's activity order does:
 * round 1 created the session, round 2 continued it, round 3 failed before it ever
 * created one (no session, no Workspace). One row must represent all three.
 */
/** A `slots` double that really registers, disposes and re-registers entries. */
/** A per-call preference store, so the controller's memory is observable. */
test('G08: `main` carries the full content panel and `sidebar.panellist` the small icon, sharing one id', async () => {
  const client = await loadClient();
  assert.deepEqual([...new Set(client.requests)].sort(), ['react', 'react/jsx-runtime'], 'still only platform modules');
  assert.equal(client.client.MAIN_SLOT, 'main');
  assert.equal(client.client.SIDEBAR_PANEL_SLOT, 'sidebar.panellist');
  assert.equal(client.client.TASKS_NAV_LABEL, 'TaskBridge 任务');

  const store = { init() {}, getSnapshot() { return { tasks: [], tree: null, tasksError: null, loading: {} }; }, subscribe() { return () => {}; } };
  const ctx = fakeClientContext();
  const dispose = client.client.registerTasksNavigation(ctx, { store, uiWorkspace: null, workspaces: null });
  assert.equal(typeof dispose, 'function');
  assert.deepEqual(ctx.injections.map((entry) => entry.name), ['main', 'sidebar.panellist']);

  for (const injection of ctx.injections) injection.callback();
  assert.equal(ctx.registered.length, 2, 'each injection registers exactly one entry');

  const [main, row] = ctx.registered;
  // `main` = the full content panel, keyed by the shared id.
  assert.equal(main.options.name, 'main');
  assert.equal(main.options.key, 'dsh-taskbridge:taskbridge-tasks');
  assert.equal(typeof main.component, 'function', '`main` registers the page component');

  // `sidebar.panellist` = the small icon; its `label` is a FUNCTION the host calls.
  assert.equal(row.options.name, 'sidebar.panellist');
  assert.equal(row.options.id, 'dsh-taskbridge:taskbridge-tasks', 'both halves share one id');
  assert.equal(row.options.id, main.options.key);
  assert.equal(typeof row.options.label, 'function', 'the host calls label(), so it must be a function');
  assert.equal(row.options.label(), 'TaskBridge 任务');
  assert.equal(typeof row.options.order, 'number');
  assert.equal(typeof row.component, 'function', '`sidebar.panellist` registers the icon component');

  // The two components are DIFFERENT: the row draws an icon, the panel draws the list.
  assert.notEqual(row.component, main.component, 'the icon and the panel are not the same component');
  dispose();
});

test('G08: selecting the entry renders the icon in the row and the panel in main, over the same store', async () => {
  const dom = installDom();
  const { store, calls } = await makeStore();
  try {
    const client = await loadClient();
    const ctx = fakeClientContext();
    // Exactly what `apply` wires: ONE store instance for both halves.
    client.client.registerTasksNavigation(ctx, { store, uiWorkspace: null, workspaces: null });
    for (const injection of ctx.injections) injection.callback();
    const [main, row] = ctx.registered;

    const iconHost = globalThis.document.createElement('div');
    const panelHost = globalThis.document.createElement('div');
    globalThis.document.body.appendChild(iconHost);
    globalThis.document.body.appendChild(panelHost);
    const { react, reactDomClient } = client;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const testUtils = await import('react-dom/test-utils');
    const act = typeof react.act === 'function' ? react.act : testUtils.act;

    const iconRoot = reactDomClient.createRoot(iconHost);
    const panelRoot = reactDomClient.createRoot(panelHost);
    await act(async () => {
      iconRoot.render(react.createElement(row.component));
      panelRoot.render(react.createElement(main.component));
    });
    await settle(act);

    // The ROW is the small icon the host's sidebar draws.
    assert.ok(iconHost.querySelector('[data-dshdg-nav-icon]') !== null, 'the row renders the sidebar icon');
    assert.equal(iconHost.querySelector('[data-dshdg-nav-panel]'), null, 'the row does not render the panel');

    // The MAIN panel is the content panel, reading the same store.
    assert.ok(panelHost.querySelector('[data-dshdg-nav-panel]') !== null, 'main renders the navigation panel');
    assert.ok(panelHost.querySelector('[data-dshdg-nav-project]') !== null, 'and it shows the records');
    assert.equal(calls.listTasks, 1, 'the shared store was read once, not once per half');

    await act(async () => {
      iconRoot.unmount();
      panelRoot.unmount();
    });
    await act(async () => { await store.loadTasks(); });
  } finally {
    store.dispose();
    dom.restore();
  }
});

test('the real apply mounts NO task-record sidebar entry: no row, no panel', async () => {
  const client = await loadClient();
  const ctx = fakeClientContext();
  client.client.apply(ctx);

  const names = ctx.injections.map((entry) => entry.name);
  // The requirement: the standalone 「TaskBridge 任务」 row is gone. `registerTasksNavigation`
  // registers `main` (panel) AND `sidebar.panellist` (row) in one call, so BOTH must be absent
  // from the real apply — keeping either would either restore the row or orphan a panel.
  assert.equal(names.includes('sidebar.panellist'), false, 'no sidebar row is registered');
  assert.equal(names.includes('main'), false, 'and no orphan content panel either');
  // The sidebar keeps only the host's native tree plus this plugin's row marker.
  assert.deepEqual(names, ['plugins.bundle.config', 'sidebar.workspaces.session.row.action'],
    'apply injects the settings page and the published per-row child slot, nothing else');
  // No effect mounts the record navigation.
  assert.equal(ctx.effects.some((effect) => /sidebar navigation/u.test(effect.label)), false,
    'the task-navigation effect is not mounted');
  assert.ok(ctx.effects.some((effect) => /dispatched session marker/u.test(effect.label)),
    'the native row marker still has its own effect');
});

test('the task-record entry stays a published, working helper even though apply does not mount it', async () => {
  const client = await loadClient();
  // Kept for compatibility (and for `lib/client.d.ts`): a caller that mounts it still gets the
  // panel and the row, and a host without either slot still degrades to a no-op.
  assert.equal(typeof client.client.registerTasksNavigation, 'function');
  const ctx = fakeClientContext();
  client.client.registerTasksNavigation(ctx, {});
  assert.deepEqual(ctx.injections.map((entry) => entry.name), ['main', 'sidebar.panellist']);
  assert.equal(typeof client.client.TaskbridgeNavPanel, 'function', 'the panel component is still exported');

  const bare = fakeClientContext({ noSlots: true });
  assert.equal(typeof client.client.registerTasksNavigation(bare, {}), 'function');
  assert.equal(bare.injections.length, 0);
});

test('G08: a host with no slots, or with only one of the two, still works and never throws', async () => {
  const client = await loadClient();

  // (a) No slot service at all: registration is a no-op disposer.
  const bare = fakeClientContext({ noSlots: true });
  const disposeBare = client.client.registerTasksNavigation(bare, {});
  assert.equal(typeof disposeBare, 'function');
  disposeBare();
  assert.equal(bare.injections.length, 0);

  // (b) The host declares only `main`: the panel registers, the missing row slot is skipped.
  const half = fakeClientContext({ refuse: ['sidebar.panellist'] });
  const disposeHalf = client.client.registerTasksNavigation(half, {});
  assert.deepEqual(half.injections.map((entry) => entry.name), ['main']);
  disposeHalf();

  // (c) `apply` keeps the settings page and the native row marker, and mounts nothing else.
  const ctx = fakeClientContext();
  client.client.apply(ctx);
  assert.ok(ctx.injections.some((entry) => entry.name === 'plugins.bundle.config'),
    'the plugins-manager page is still registered on the same context');
  assert.ok(ctx.injections.some((entry) => entry.name === 'sidebar.workspaces.session.row.action'),
    'the native session-row marker is still registered');
  assert.equal(ctx.injections.some((entry) => entry.name === 'main'), false);
  assert.equal(ctx.injections.some((entry) => entry.name === 'sidebar.panellist'), false);
});

test('G08: the workspace service is taken from `ctx.get` and a host without it degrades to null', async () => {
  const client = await loadClient();
  const openSession = () => {};
  assert.equal(client.client.resolveUiWorkspace(fakeClientContext({ services: { uiWorkspace: { openSession } } })).openSession, openSession);
  assert.equal(client.client.resolveUiWorkspace(fakeClientContext({ services: {} })), null);
  assert.equal(client.client.resolveUiWorkspace(fakeClientContext({ services: { uiWorkspace: { list() {} } } })), null,
    'a service without openSession is not a navigation capability');
  assert.equal(client.client.resolveUiWorkspace({}), null);
  assert.equal(client.client.resolveUiWorkspace({ get() { throw new Error('no such service'); } }), null);
});

// ---------------------------------------------------------------------------
// 2. The projection: projects, sessions, archived
// ---------------------------------------------------------------------------

/** One `/tasks` body whose rows DO carry a recorded session id. */
function bodyWithSessions(extra = {}) {
  const body = tasksBody();
  const withSession = (taskId, sessionId) => ({ taskId, sessionId });
  const ids = extra.sessions ?? [];
  const tasks = body.tasks.map((task) => {
    const hit = ids.find((entry) => entry.taskId === task.taskId);
    return hit === undefined ? task : { ...task, execution: { sessionId: hit.sessionId } };
  });
  return { ...body, tasks, withSession };
}

test('G08: the panel groups by the host project key, so same-titled projects stay separate', async () => {
  const client = await loadClient();
  const body = tasksBody();
  const view = client.client.navViewModel({ tasks: body.tasks, tree: body.tree });
  // Every fixture row shares one confirmed source, so there is exactly ONE group and
  // no empty "来源未确认" group is invented.
  assert.equal(view.groups.length, 1, 'one project, one group');
  assert.equal(view.groups[0].key, body.tree.projects[0].projectKey);
  assert.equal(view.groups[0].sessions.length, body.tasks.length);

  // Two projects that share a NAME are still two KEYS — the invariant the grouping
  // rests on — and each keeps its own host display name plus short path.
  const projectA = { ...body.tree.projects[0], projectKey: 'sha256:aaaa', name: 'portal', shortPath: 'one/portal' };
  const projectB = { ...body.tree.projects[0], projectKey: 'sha256:bbbb', name: 'portal', shortPath: 'two/portal' };
  const twinTree = { ...body.tree, projects: [projectA, projectB] };
  const twins = client.client.navViewModel({ tasks: body.tasks, tree: twinTree });
  const keys = twins.groups.map((group) => group.key);
  assert.ok(keys.includes('sha256:aaaa') && keys.includes('sha256:bbbb'), 'both same-named projects are present as distinct keys');
  const titles = twins.groups
    .filter((group) => group.key.startsWith('sha256:'))
    .map((group) => client.client.groupTitle(group, twins.meta));
  assert.ok(titles.includes('portal（one/portal）'), 'the host short path disambiguates the first');
  assert.ok(titles.includes('portal（two/portal）'), 'and the second');
  // A same-titled project does not steal the other's sessions: rows are attributed
  // through the projection's own node→project key, so the real project keeps them all.
  assert.equal(twins.groups.find((group) => group.key === body.tree.projects[0].projectKey).sessions.length, body.tasks.length);
});

test('G08: records with an unconfirmed source form their own group and never join a named project', async () => {
  const client = await loadClient();
  const body = tasksBody();
  // A row with NO source and no projection entry: the only honest bucket is its own.
  const tasks = [...body.tasks, {
    taskId: 'task-no-source',
    title: '来源未知的记录',
    state: 'awaiting-host-review',
    phase: 'awaiting-host-review',
    sourcePath: null,
    sourcePathDigest: null,
    archived: false,
    live: true,
    execution: { sessionId: 'session-nosource-111222' },
  }];
  const view = client.client.navViewModel({ tasks, tree: body.tree });
  const own = view.groups.find((group) => group.key === 'unconfirmed');
  assert.ok(own !== undefined, 'the record with no source at all has its own group');
  // The projection runs inside the bundle's vm context, so its arrays are that
  // realm's; compare their contents in this realm.
  assert.deepEqual([...own.sessions.map((row) => row.taskId)], ['task-no-source']);
  const named = view.groups.filter((group) => group.key !== 'unconfirmed');
  assert.ok(named.every((group) => !group.sessions.some((row) => row.taskId === 'task-no-source')),
    'such a record is never attributed to a named project');

  // A row whose source is recorded but whose project could not be confirmed is the
  // projection's own "来源未确认" bucket, and stays separate from the verified one.
  const unverifiedTree = {
    ...body.tree,
    roots: body.tree.roots.map((node) => (node.nodeId === 'task-legacy' ? { ...node, projectKey: 'unverified' } : node)),
  };
  const mixed = client.client.navViewModel({ tasks: body.tasks, tree: unverifiedTree });
  const unverified = mixed.groups.find((group) => group.key === 'unverified');
  assert.ok(unverified !== undefined, 'the unconfirmed-source node has its own group');
  assert.deepEqual([...unverified.sessions.map((row) => row.taskId)], ['task-legacy']);
  const verified = mixed.groups.filter((group) => group.key !== 'unverified');
  assert.ok(verified.every((group) => !group.sessions.some((row) => row.taskId === 'task-legacy')));
  assert.equal(view.groups.filter((group) => group.key === 'unverified').length, 0,
    'no empty "来源未确认" group is invented when every record has a confirmed source');
});

test('G08: a row without a recorded session id is listed but carries no navigation identity', async () => {
  const client = await loadClient();
  const body = bodyWithSessions({ sessions: [{ taskId: 'task-legacy', sessionId: 'session-abc-123456' }] });
  const view = client.client.navViewModel({ tasks: body.tasks, tree: body.tree });
  const rows = view.groups.flatMap((group) => group.sessions);
  const discussed = rows.find((row) => row.taskId === 'task-legacy');
  assert.equal(discussed.sessionId, 'session-abc-123456', 'the recorded id is used as-is');
  const others = rows.filter((row) => row.taskId !== 'task-legacy');
  assert.ok(others.length > 0);
  for (const row of others) assert.equal(row.sessionId, null, 'nothing is derived from a task id or a title');
  // Nothing is dropped: every fixture row is represented exactly once.
  assert.equal(rows.length, tasksBody().tasks.length);
});

test('G08: the record\'s own top-level sessionId wins over the nested identities', async () => {
  const client = await loadClient();
  const id = client.client.taskSessionId;
  // A restored historical record: the top-level sessionId is the thread that is live.
  assert.equal(id({ sessionId: 'top-level', execution: { sessionId: 'run-id' } }), 'top-level');
  // Without one, the existing nested fallbacks still apply, in their own order.
  assert.equal(id({ execution: { sessionId: 'run-id' }, conversation: { sessionId: 'conv-id' } }), 'run-id');
  assert.equal(id({ conversation: { sessionId: 'conv-id' } }), 'conv-id');
  // Nothing recorded anywhere: no identity, and nothing invented from the task id.
  assert.equal(id({ taskId: 'task-legacy' }), null);
  assert.equal(id({ sessionId: '   ' }), null);
  assert.equal(id(null), null);
});

test('G08: a history-restored record is NOT a TaskBridge-archived record', async () => {
  const client = await loadClient();
  const body = tasksBody();
  // `archived: true` alone (recovered from durable history) must stay live.
  const restored = body.tasks.map((task) => (task.taskId === 'task-legacy' ? { ...task, archived: true } : task));
  const live = client.client.navViewModel({ tasks: restored, tree: body.tree });
  const liveIds = live.groups.flatMap((group) => group.sessions).map((row) => row.taskId);
  assert.ok(liveIds.includes('task-legacy'), 'a restored record stays in the active list');
  assert.equal(live.archivedCount, 0, 'history-restore is not counted as archived');
  assert.equal(client.client.archivedSourceNote({ tasks: restored, tree: body.tree }), null);

  // Only G07's explicit `displayArchived` moves a record into the archived list.
  const marked = {
    ...body,
    tree: { ...body.tree, roots: body.tree.roots.map((node) => (node.nodeId === 'task-legacy' ? { ...node, displayArchived: true } : node)) },
  };
  const flagged = client.client.navViewModel({ tasks: restored, tree: marked.tree });
  assert.ok(!flagged.groups.flatMap((group) => group.sessions).some((row) => row.taskId === 'task-legacy'));
  assert.equal(flagged.archivedCount, 1);
});

test('G08: `displayArchived` splits rows out of the live list, and an older host still works', async () => {
  const client = await loadClient();
  const body = tasksBody();
  // Mark ONE chain's node archived the way G07 would: a boolean on the tree node.
  const marked = {
    ...body,
    tree: {
      ...body.tree,
      roots: body.tree.roots.map((node) => (node.nodeId === 'task-legacy' ? { ...node, displayArchived: true } : node)),
    },
  };
  const view = client.client.navViewModel({ tasks: body.tasks, tree: marked.tree });
  const live = view.groups.flatMap((group) => group.sessions).map((row) => row.taskId);
  const archived = view.archivedGroups.flatMap((group) => group.sessions).map((row) => row.taskId);
  assert.ok(!live.includes('task-legacy'), 'the archived row left the live list');
  assert.ok(archived.includes('task-legacy'), 'and it is still available in the archived list');
  assert.equal(view.archivedCount, 1);
  assert.equal(view.total, body.tasks.length, 'no record is lost by the split');
  assert.ok(client.client.archivedSourceNote({ tasks: body.tasks, tree: marked.tree }).includes('displayArchived'));

  // An older host (no tree at all) reports no archived rows and says why.
  const legacy = client.client.navViewModel({ tasks: tasksBodyWithoutTree().tasks, tree: null });
  assert.equal(legacy.archivedCount, 0);
  assert.equal(legacy.available, false);
  assert.ok(legacy.groups.length >= 1, 'the rows are still grouped by their own source');
});

test('G08: an archived plan groups every execution round under the projected source', async () => {
  const bundle = await loadClient();
  const tree = { roots: [{ nodeId: 'plan-parent', kind: 'plan', projectKey: 'confirmed', displayArchived: true,
    children: [{ nodeId: 'plan-child', kind: 'plan', projectKey: 'confirmed',
      executions: [{ taskIds: ['initial', 'correction'] }], children: [] }] }] };
  const tasks = [{ taskId: 'initial', archived: true }, { taskId: 'correction' }, { taskId: 'unchanged', archived: true }];
  const view = bundle.client.navViewModel({ tree, tasks });
  assert.deepEqual(Array.from(view.archivedGroups[0].sessions, (row) => row.taskId), ['initial', 'correction']);
  assert.equal(view.archivedGroups[0].key, 'confirmed');
  assert.equal(view.activeCount, 1);
});

test('G08: the panel model issues no requests of its own — it is a pure function of the snapshot', async () => {
  const client = await loadClient();
  const snapshot = { tasks: tasksBody().tasks, tree: tasksBody().tree };
  const first = client.client.navViewModel(snapshot);
  const second = client.client.navViewModel(snapshot);
  assert.deepEqual(
    [...first.groups.map((group) => [group.key, group.sessions.length])],
    [...second.groups.map((group) => [group.key, group.sessions.length])],
    'same snapshot, same projection',
  );
  // The flat-only tree shape the execution plane publishes is read the same way.
  const flat = client.client.navViewModel({ tasks: tasksBodyFlatTree().tasks, tree: tasksBodyFlatTree().tree });
  assert.equal(flat.available, true);
  assert.ok(flat.groups.length >= 1);
});

// ---------------------------------------------------------------------------
// 3. Session placement and navigation through DSH
// ---------------------------------------------------------------------------

/**
 * A `workspaces` service double with the host's own shape:
 * `{ list: { getSnapshot, subscribe } }`, snapshot
 * `{ phase, items: [{ workspaceId, sessionIds }], archivedSessionIds }`.
 * @param {object} snapshot - what `getSnapshot()` returns.
 * @returns {object} service.
 */
function workspaceService(snapshot) {
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
    },
  };
}

test('G08: placement reads the host snapshot and keeps ready/archived/missing/pending apart', async () => {
  const client = await loadClient();
  const where = client.client.sessionPlacement;

  // No service at all: the host cannot vouch for anything.
  assert.equal(where('session-1', null).state, 'unknown');
  assert.equal(where('session-1', { list: {} }).state, 'unknown', 'a list without getSnapshot is not a source');
  assert.equal(
    where('session-1', { list: { getSnapshot() { throw new Error('suspending'); } } }).state,
    'unknown',
    'a source that cannot be read synchronously is not a guess',
  );

  // Not-ready phases: nothing is verified, so the answer is "retry later".
  for (const phase of ['loading', 'idle', 'connecting', 'reconnecting']) {
    assert.equal(where('session-1', workspaceService({ phase, items: [], archivedSessionIds: [] })).state, 'pending', phase);
  }

  // A READY snapshot: `sessionIds` inside `items` is the identity list.
  const ready = workspaceService({
    phase: 'ready',
    items: [
      { workspaceId: 'ws-a', sessionIds: ['session-a1', 'session-a2'] },
      { workspaceId: 'ws-b', sessionIds: ['session-b1'] },
    ],
    archivedSessionIds: ['session-old'],
  });
  const present = where('session-a2', ready);
  assert.equal(present.state, 'present', 'a listed session is openable');
  assert.equal(present.workspaceId, 'ws-a', 'and its workspace is reported');
  assert.equal(where('session-b1', ready).workspaceId, 'ws-b');

  // A session in the host's own archive set: REFUSED, and NOT reported as missing.
  assert.equal(where('session-old', ready).state, 'archived');

  // An id the ready snapshot simply does not list: refused explicitly as missing.
  assert.equal(where('session-nowhere', ready).state, 'missing');
  assert.notEqual(where('session-nowhere', ready).state, 'archived', 'missing is never reported as archived');

  // An EMPTY but ready snapshot lists nothing, so every id is missing.
  const empty = workspaceService({ phase: 'ready', items: [], archivedSessionIds: [] });
  assert.equal(where('session-a1', empty).state, 'missing');

  // An id in the archive set is archived even when it is absent from `items`,
  // because archiving is exactly what removes it from the live list.
  const archivedOnly = workspaceService({ phase: 'ready', items: [], archivedSessionIds: ['session-gone'] });
  assert.equal(where('session-gone', archivedOnly).state, 'archived', 'the archive set wins over absence');

  // An empty id has nothing to verify.
  assert.equal(where(null, ready).state, 'missing');
});

test('G08: locateSession opens a verified id exactly once and states every refusal', async () => {
  const client = await loadClient();
  const opened = [];
  const uiWorkspace = { openSession(sessionId) { opened.push(sessionId); } };
  const ready = workspaceService({
    phase: 'ready',
    items: [{ workspaceId: 'ws-a', sessionIds: ['session-abc-123456'] }],
    archivedSessionIds: ['session-old-1'],
  });

  // A verified session: opened ONCE, with the recorded id untouched.
  const ok = await client.client.locateSession(uiWorkspace, 'session-abc-123456', ready);
  assert.equal(ok.ok, true);
  assert.deepEqual(opened, ['session-abc-123456'], 'exactly one call, with the real id');
  assert.match(ok.message, /已在 DSH 中定位会话/u);

  // No navigation capability.
  const noNav = await client.client.locateSession(null, 'session-abc-123456', ready);
  assert.equal(noNav.ok, false);
  assert.match(noNav.message, /没有提供会话定位能力/u);

  // No recorded id.
  const none = await client.client.locateSession(uiWorkspace, null, ready);
  assert.equal(none.ok, false);
  assert.match(none.message, /没有可核实的会话标识/u);

  // Not ready: "retry later", and nothing is opened.
  const pending = await client.client.locateSession(uiWorkspace, 'session-abc-123456',
    workspaceService({ phase: 'loading', items: [], archivedSessionIds: [] }));
  assert.equal(pending.ok, false);
  assert.match(pending.message, /还没准备好.*稍后重试/u);

  // Archived by DSH: its own sentence, not "missing".
  const archived = await client.client.locateSession(uiWorkspace, 'session-old-1', ready);
  assert.equal(archived.ok, false);
  assert.match(archived.message, /归档/u);
  assert.doesNotMatch(archived.message, /列表里没有/u);

  // Missing from a ready snapshot: refused explicitly, NOT reported as archived.
  const missing = await client.client.locateSession(uiWorkspace, 'session-nowhere', ready);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /列表里没有/u);
  assert.doesNotMatch(missing.message, /归档/u);

  // No workspaces service: unverifiable, so it does not open on faith.
  const unverifiable = await client.client.locateSession(uiWorkspace, 'session-abc-123456', null);
  assert.equal(unverifiable.ok, false);
  assert.match(unverifiable.message, /无法核实/u);

  // Every refusal above left the host untouched: only the ONE verified call happened.
  assert.deepEqual(opened, ['session-abc-123456'], 'refusals never reach openSession');

  // A refusal from the host becomes a stated message, and is NOT retried.
  let attempts = 0;
  const broken = await client.client.locateSession(
    { openSession() { attempts += 1; throw new Error('no such panel'); } },
    'session-abc-123456',
    ready,
  );
  assert.equal(broken.ok, false);
  assert.match(broken.message, /定位会话失败/u);
  assert.match(broken.message, /no such panel/u);
  assert.equal(attempts, 1, 'openSession is attempted once, never in a retry loop');
});

// ---------------------------------------------------------------------------
// 4. The rendered panel
// ---------------------------------------------------------------------------

test('G08 DOM: the panel lists projects, collapses, and never reads a detail per row', async () => {
  const dom = installDom();
  const { store, calls } = await makeStore();
  try {
    const client = await loadClient();
    const page = await renderPanel(client, { store, uiWorkspace: null });

    // The panel itself made at most one list read, through the page's own store.
    assert.equal(calls.listTasks, 1, 'one read for records the page had not loaded yet');
    const listed = [...page.root.querySelectorAll('[data-dshdg-nav-project]')].map((node) => node.getAttribute('data-dshdg-nav-project'));
    assert.ok(listed.length >= 1, 'projects are listed');
    assert.ok(page.root.querySelector('[data-dshdg-nav-session]') !== null, 'their sessions are listed');

    // Collapse: the children leave the DOM and the control reports the state.
    const key = listed[0];
    const collapse = (id) => `[data-dshdg-nav-project="${id}"] > ul.dshdg-nav-sessions`;
    const toggle = page.root.querySelector(`[data-dshdg-nav-toggle="${key}"]`);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    await page.click(toggle);
    assert.equal(page.root.querySelector(collapse(key)), null, 'a collapsed group draws no session list');
    assert.equal(page.root.querySelector(`[data-dshdg-nav-toggle="${key}"]`).getAttribute('aria-expanded'), 'false');
    await page.click(page.root.querySelector(`[data-dshdg-nav-toggle="${key}"]`));
    assert.ok(page.root.querySelector(collapse(key)) !== null, 'expanding restores it');

    // A second read only happens when the operator asks for one.
    assert.equal(calls.listTasks, 1, 'no pulse, no timer, no per-row request');
    await page.click(page.root.querySelector('[data-dshdg-nav-refresh]'));
    assert.equal(calls.listTasks, 2, 'the refresh button is the only other reader');

    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

test('G08 DOM: the sidebar reports saved reviews and keeps unconfirmed reviews distinct', async () => {
  const dom = installDom();
  const body = tasksBody();
  const tasks = body.tasks.map((task) => (task.taskId === 'task-legacy'
    ? {
        ...task,
        hostAcceptance: { accepted: true, state: 'accepted' },
        reviewPersistence: { state: 'timed-out', pending: true, durable: false },
      }
    : task));
  const { store } = await makeStore({ listTasks: async () => ({ ...body, tasks }) });
  try {
    const client = await loadClient();
    const page = await renderPanel(client, { store });
    try {
      const status = (id) => page.text(`[data-dshdg-nav-session="${id}"] .dshdg-badge`);
      assert.equal(status('task-debounce'), '审查通过');
      assert.equal(status('task-ui-1'), '需要修正');
      assert.equal(status('task-legacy'), '审查结论保存未确认');
    } finally {
      await page.unmount();
    }
  } finally {
    store.dispose();
    dom.restore();
  }
});

test('G08 DOM: 定位 opens the recorded session, is disabled without one, and reports a refusal', async () => {
  const dom = installDom();
  const body = tasksBody();
  // A historical record keeps its thread in the record's OWN top-level `sessionId`,
  // which is exactly the shape a restored record has.
  const tasks = body.tasks.map((task) => (task.taskId === 'task-legacy'
    ? { ...task, sessionId: 'session-legacy-987654', archived: true }
    : task));
  const { store } = await makeStore({ listTasks: async () => ({ ...body, tasks }) });
  try {
    const client = await loadClient();
    const opened = [];
    const page = await renderPanel(client, {
      store,
      uiWorkspace: { openSession(sessionId) { opened.push(sessionId); } },
      workspaces: workspaceService({
        phase: 'ready',
        items: [{ workspaceId: 'ws-1', sessionIds: ['session-legacy-987654'] }],
        archivedSessionIds: [],
      }),
    });

    const withId = page.root.querySelector('[data-dshdg-nav-locate="task-legacy"]');
    assert.ok(withId !== null);
    assert.equal(withId.disabled, false, 'a recorded id can be located');
    assert.ok(page.root.querySelector('[data-dshdg-nav-session="task-legacy"]').textContent.includes('session-legacy'.slice(0, 6)));

    // A row without a recorded id stays visible and its control is disabled.
    const withoutId = page.root.querySelector('[data-dshdg-nav-locate="task-debounce"]');
    assert.ok(withoutId !== null, 'the history-only record is still listed');
    assert.equal(withoutId.disabled, true);
    assert.ok(page.root.querySelector('[data-dshdg-nav-session="task-debounce"] [data-dshdg-nav-unverified]') !== null);

    // A record recovered from history (`archived: true`) is NOT a TaskBridge-archived
    // record: it stays in the active list and is openable.
    assert.equal(page.root.querySelector('[data-dshdg-nav-archived-session="task-legacy"]'), null,
      'history-restore is never shown as archived');
    assert.ok(page.root.querySelector('[data-dshdg-nav-session="task-legacy"]') !== null,
      'a restored record stays in the live list');

    await page.click(withId);
    assert.deepEqual(opened, ['session-legacy-987654'], 'exactly the recorded id was opened');
    assert.ok(page.root.querySelector('[data-dshdg-nav-feedback="ok"]') !== null, 'the successful locate is stated');
    assert.match(page.text('[data-dshdg-nav-feedback]'), /已在 DSH 中定位会话/u);

    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

test('G08 DOM: an archived or not-ready host snapshot refuses to navigate and says why', async () => {
  const dom = installDom();
  const body = tasksBody();
  const tasks = body.tasks.map((task) => (task.taskId === 'task-legacy'
    ? { ...task, sessionId: 'session-legacy-987654' }
    : task.taskId === 'task-ui-twin'
      ? { ...task, sessionId: 'session-twin-000111' }
      : task));
  const { store } = await makeStore({ listTasks: async () => ({ ...body, tasks }) });
  try {
    const client = await loadClient();

    // (a) The id is in the host's own archive set.
    const opened = [];
    const archivedPage = await renderPanel(client, {
      store,
      uiWorkspace: { openSession(sessionId) { opened.push(sessionId); } },
      workspaces: workspaceService({ phase: 'ready', items: [], archivedSessionIds: ['session-legacy-987654'] }),
    });
    await archivedPage.click(archivedPage.root.querySelector('[data-dshdg-nav-locate="task-legacy"]'));
    assert.match(archivedPage.text('[data-dshdg-nav-feedback]'), /DSH 中归档/u);
    assert.deepEqual(opened, [], 'an archived session is never opened');
    await archivedPage.unmount();

    // (b) The snapshot is not ready yet: retry later, nothing opened.
    const pendingPage = await renderPanel(client, {
      store,
      uiWorkspace: { openSession(sessionId) { opened.push(sessionId); } },
      workspaces: workspaceService({ phase: 'loading', items: [], archivedSessionIds: [] }),
    });
    await pendingPage.click(pendingPage.root.querySelector('[data-dshdg-nav-locate="task-ui-twin"]'));
    assert.match(pendingPage.text('[data-dshdg-nav-feedback]'), /稍后重试/u);
    assert.deepEqual(opened, [], 'a not-ready host opens nothing');
    await pendingPage.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

test('G08 DOM: a host without navigation services lists records and refuses to jump', async () => {
  const dom = installDom();
  const body = tasksBody();
  const tasks = body.tasks.map((task) => (task.taskId === 'task-legacy'
    ? { ...task, sessionId: 'session-legacy-987654' }
    : task));
  const { store } = await makeStore({ listTasks: async () => ({ ...body, tasks }) });
  try {
    const client = await loadClient();
    const opened = [];

    // (a) No uiWorkspace: the capability itself is missing.
    const noNav = await renderPanel(client, { store, uiWorkspace: null, workspaces: null });
    await noNav.click(noNav.root.querySelector('[data-dshdg-nav-locate="task-legacy"]'));
    assert.match(noNav.text('[data-dshdg-nav-feedback]'), /没有提供会话定位能力/u);
    assert.ok(noNav.root.querySelector('[data-dshdg-nav-project]') !== null, 'the records are still listed');
    await noNav.unmount();

    // (b) `uiWorkspace` present but no `workspaces` source: the id cannot be verified,
    // so the plugin does not open it on faith.
    const unverifiable = await renderPanel(client, {
      store,
      uiWorkspace: { openSession(sessionId) { opened.push(sessionId); } },
      workspaces: null,
    });
    await unverifiable.click(unverifiable.root.querySelector('[data-dshdg-nav-locate="task-legacy"]'));
    assert.match(unverifiable.text('[data-dshdg-nav-feedback]'), /无法核实/u);
    assert.deepEqual(opened, [], 'an unverifiable id is never opened');
    await unverifiable.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

test('G08 DOM: the archived toggle only changes this list — no host call, no archive action', async () => {
  const dom = installDom();
  const body = tasksBody();
  const tasks = body.tasks.map((task) => (task.taskId === 'task-ui-twin'
    ? { ...task, execution: { sessionId: 'session-twin-000111' } }
    : task));
  const marked = {
    ...body,
    tasks,
    tree: {
      ...body.tree,
      roots: body.tree.roots.map((node) => (node.nodeId === 'task-legacy' ? { ...node, displayArchived: true } : node)),
    },
  };
  const { store, calls } = await makeStore({ listTasks: async () => marked });
  try {
    const client = await loadClient();
    const opened = [];
    const page = await renderPanel(client, {
      store,
      uiWorkspace: { openSession(sessionId) { opened.push(sessionId); } },
    });
    const readsBefore = calls.listTasks;

    // Hidden by default, and the count is stated.
    assert.equal(page.root.querySelector('[data-dshdg-nav-archived-session]'), null);
    const toggle = page.root.querySelector('[data-dshdg-nav-archived-toggle]');
    assert.ok(toggle !== null, 'the toggle exists because the host marked a record archived');
    assert.match(page.text('.dshdg-nav-archived'), /显示 TaskBridge 已归档的记录（1）/u);

    await page.act(async () => {
      toggle.click();
    });
    await page.settle();
    const archivedRow = page.root.querySelector('[data-dshdg-nav-archived-session="task-legacy"]');
    assert.ok(archivedRow !== null, 'the archived record is shown');
    assert.match(archivedRow.textContent, /已归档/u);
    assert.equal(page.root.querySelector('[data-dshdg-nav-session="task-legacy"]'), null, 'and it is not listed twice');
    assert.equal(calls.listTasks, readsBefore, 'toggling the view issued no read');
    assert.deepEqual(opened, [], 'and opened nothing');

    // It carries no locate control: an archived row is not a navigation target here.
    assert.equal(page.root.querySelector('[data-dshdg-nav-locate="task-legacy"]'), null);

    await page.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

test('G08 DOM: a refused list read is stated, and the panel survives a slot with no props', async () => {
  const dom = installDom();
  const { store } = await makeStore({ fail: true });
  try {
    const client = await loadClient();
    const page = await renderPanel(client, { store, uiWorkspace: null });
    assert.ok(page.root.querySelector('[data-dshdg-nav-error]') !== null, 'the refused read is visible');
    assert.ok(page.root.querySelector('[data-dshdg-nav-empty]') !== null, 'nothing is invented');
    await page.unmount();

    // A host that hands the slot no props: readable line, no crash.
    const bare = await renderPanel(client, {});
    assert.ok(bare.root.querySelector('[data-dshdg-nav-panel]') !== null);
    assert.ok(bare.root.querySelector('[data-dshdg-nav-empty]') !== null);
    await bare.unmount();
  } finally {
    store.dispose();
    dom.restore();
  }
});

// ---------------------------------------------------------------------------
// 5. The task tree page is unchanged by all of this
// ---------------------------------------------------------------------------

test('G08: task records open the recent table and keep the project tree available', async () => {
  const dom = installDom();
  const apiModule = await import('../src/client/api.js');
  // A full-enough user-plane double: this test opens the REAL settings page, whose
  // `init` reads status, settings and the native provider list as well as records.
  const api = {
    async getStatus() { return { ok: true }; },
    async getSettings() {
      return {
        ok: true,
        settings: {
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
        },
      };
    },
    async getNativeProviders() { return { ok: true, providers: [] }; },
    async listTasks() { return tasksBody(); },
    async getTask(taskId) { return { ok: true, task: tasksBody().tasks.find((task) => task.taskId === taskId) }; },
    async cancelTask(taskId) { return { ok: true, task: { taskId, state: 'cancelled' } }; },
  };
  const store = apiModule.createStore({ api, saveDebounceMs: 5 });
  try {
    const client = await loadClient();
    assert.equal(typeof client.client.DelegateConfigPage, 'function', 'the bundle exports the settings page');
    const { react, reactDomClient } = client;
    const root = globalThis.document.getElementById('root');
    const container = reactDomClient.createRoot(root);
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const testUtils = await import('react-dom/test-utils');
    const act = typeof react.act === 'function' ? react.act : testUtils.act;
    await store.init();
    await act(async () => {
      container.render(react.createElement(client.client.DelegateConfigPage, { store }));
    });
    await settle(act);
    const tab = [...root.querySelectorAll('[role="tablist"] button')]
      .find((button) => (button.textContent ?? '').includes('任务记录'));
    assert.ok(tab !== undefined, 'the settings page still owns the task records tab');
    await act(async () => {
      tab.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle(act);
    assert.ok(root.querySelector('[data-dshdg-records-table]'), 'the default is the recent records table');
    const treeButton = root.querySelector('[data-dshdg-record-view="tree"]');
    await act(async () => { treeButton.click(); });
    assert.ok(root.querySelector('[data-dshdg-task-tree]') !== null, 'the project tree is still available');
    const nodes = [...root.querySelectorAll('[data-dshdg-tree-node]')].map((node) => node.getAttribute('data-dshdg-tree-node'));
    for (const nodeId of ['plan-goal', 'plan-ui', 'plan-orphan', 'task-legacy']) {
      assert.ok(nodes.includes(nodeId), `the tree still shows ${nodeId}`);
    }
    // A chain's rounds are drawn INSIDE its node, not as child nodes — the G09
    // structure this work unit must not disturb.
    const uiRounds = [...root.querySelectorAll('[data-dshdg-round]')].map((row) => row.getAttribute('data-dshdg-round'));
    for (const roundId of ['task-ui-1', 'task-ui-2', 'task-ui-3']) {
      assert.ok(uiRounds.includes(roundId), `the chain still shows ${roundId} as a round`);
    }
    // The navigation surface is NOT rendered on the settings page.
    assert.equal(root.querySelector('[data-dshdg-nav-panel]'), null);
    await act(async () => { container.unmount(); });
  } finally {
    store.dispose();
    dom.restore();
  }
});

test('G08: the fixture itself records no session ids, which is why the panel shows history-only rows', async () => {
  // A guard on the fixture rather than on the code: if `/tasks` rows ever start
  // carrying sessions, the "no identity" assertions above must be revisited.
  const { tasks } = threeLevelProjection();
  for (const task of tasks) {
    assert.equal(task.execution, undefined, `${task.taskId} has no execution block in the fixture`);
  }
});
