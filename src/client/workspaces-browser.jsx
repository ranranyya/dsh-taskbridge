// dsh-delegate — how the TaskBridge section appears in the sidebar's workspace area.
//
// WHAT THE HOST ACTUALLY OFFERS (verified in the shipped 0.2.2-rc.5 client bundle)
// --------------------------------------------------------------------------------
// `@deepseek-ai/dsh-client-ui-workspace/lib/client.js` registers the workspace browser like this:
//
//   ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
//     name: 'sidebar.workspaces', children: {
//       'sidebar.workspaces.directoryFlow':          { kind: 'single', scope: 'root' },
//       'sidebar.workspaces.session.row.action':     { kind: 'list',   scope: 'root' },
//       'sidebar.session.row.leading':               { kind: 'list',   scope: 'root', inline: true },
//       'sidebar.session.row.trailing':              { kind: 'list',   scope: 'root', inline: true },
//       'sidebar.session.row.hover':                 { kind: 'list',   scope: 'root' },
//     }, ... }, WorkspaceBrowser))
//
// So the region is a SINGLE slot with no published way to render a sibling section above the
// shipped browser, and its rows are the host's own. What IS published, and what this plugin
// uses, is the set of CHILD slots:
//
//   * `sidebar.workspaces.session.row.action` — a list rendered INSIDE every native session row,
//     next to the host's own archive/pin buttons. This is the supported seam for a per-session
//     affordance and it never replaces a native row;
//   * `sidebar.session.row.leading` / `.trailing` / `.hover` — inline material for a row.
//
// The consequence for the requirement is stated plainly in `docs/workspace-grouping.md`: a
// vertical section ABOVE the native browser, inside the same cell, is not expressible through a
// published slot. This module therefore does NOT take the region over (the earlier build did,
// which is why the native rows disappeared from an acceptance run). Instead it:
//
//   1. keeps the shipped browser exactly as the host renders it — its names, order, search,
//      menus, actions — by *not registering on `sidebar.workspaces` at all* from `apply()`;
//   2. annotates each native session row through the published row-action slot with a TaskBridge
//      marker for conversations this plugin dispatched (proven by the identity map), so an
//      operator can tell them apart in the native tree without a second tree;
//   3. offers the TaskBridge grouping — TaskBridge → 任务工作区 → 对话, one row per dispatched
//      chain — through the plugin's own surfaces, where it can be rendered safely and completely:
//      the task records page (`delegate records`) and its existing content panel. Those are this
//      plugin's own slots, so the grouping costs the host nothing and cannot disturb a native row.
//
// Nothing here patches the DOM, imports a host package, reads a React private field, or invents a
// Workspace/path. A row's identity is its real `(workspaceId, sessionId)` pair, and every action
// goes through an official service with those real ids.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { createApi } from './api.js';
import {
  GROUP_KINDS,
  readWorkspacesSnapshot,
  sessionIndex,
  workspaceGroups,
} from './workspace-groups.js';

/** The host's singleton slot for its own workspace/session browser. */
export const WORKSPACES_SLOT = 'sidebar.workspaces';

/**
 * The published CHILD slot the host renders inside every native session row. This is the seam
 * this plugin uses for a per-row affordance; the parent slot itself is never registered on.
 */
export const SESSION_ROW_ACTION_SLOT = 'sidebar.workspaces.session.row.action';

/**
 * The plugin's row marker: placed AFTER the host's own actions (the host's are 100 = archive and
 * 200 = pin), so it never comes between the operator and a native control.
 */
export const SESSION_ROW_ACTION_ORDER = 900;

/** The id of this plugin's row-action registration, namespaced against other plugins. */
export const SESSION_ROW_ACTION_ID = 'dsh-taskbridge:dispatched';

/** How the plugin's own grouping can present itself. */
export const WORKSPACE_VIEWS = Object.freeze({
  /** Conversations this plugin dispatched were proven: the grouping is shown. */
  grouped: 'grouped',
  /** Nothing proven: the grouping is not invented. */
  passthrough: 'passthrough',
});

/** How many times one mount may re-read the identity map after a record showed a new placement. */
const IDENTITY_REFRESH_LIMIT = 2;

/** The session id a row is rendered with: shortened, never guessed. */
export function shortId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return '';
  return sessionId.length <= 14 ? sessionId : `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`;
}

/**
 * Resolve one host service lazily. An absent service is a capability gap, never an error.
 * @param {object | null | undefined} ctx - client context.
 * @param {string} name - service name.
 * @returns {object | null} the service, or null.
 */
export function hostService(ctx, name) {
  const get = ctx !== null && typeof ctx === 'object' ? ctx.get : null;
  if (typeof get !== 'function') return null;
  try {
    const service = get.call(ctx, name);
    return service !== null && typeof service === 'object' ? service : null;
  } catch {
    return null;
  }
}

/** The object carrying the shell's dialogs (`window` when there is one). */
function shellDialog() {
  const shell = globalThis.window ?? null;
  return shell !== null && typeof shell === 'object' ? shell : globalThis;
}

/**
 * Ask the operator for one line of text, or answer null. A host without `prompt` answers null.
 * @param {string} message - the question.
 * @param {string} initial - the current value.
 * @param {object} [shell] - the object carrying the dialog.
 * @returns {string | null} the operator's text, or null.
 */
export function askText(message, initial, shell = undefined) {
  const host = shell ?? shellDialog();
  const ask = typeof host?.prompt === 'function' ? host.prompt : null;
  if (ask === null) return null;
  try {
    return ask.call(host, message, initial);
  } catch {
    return null;
  }
}

/**
 * Ask the operator to confirm one destructive action. A host without `confirm` answers NO.
 * @param {string} message - the question.
 * @param {object} [shell] - the object carrying the dialog.
 * @returns {boolean} the operator's answer.
 */
export function askConfirm(message, shell = undefined) {
  const host = shell ?? shellDialog();
  const ask = typeof host?.confirm === 'function' ? host.confirm : null;
  if (ask === null) return false;
  try {
    return ask.call(host, message) === true;
  } catch {
    return false;
  }
}

/**
 * Register the per-session row marker into the host's published child slot.
 *
 * This is deliberately the ONLY thing this module does to the shell's workspace region: the
 * parent slot stays the host's, so every native row, name, order, search box, menu and action is
 * exactly as shipped. A host that does not declare the child slot simply never runs this.
 * @param {object} ctx - client Cordis context.
 * @param {object} [options] - `store` (the page store), `sessionMap` (an identity loader), `api`.
 * @returns {() => void} disposer releasing the registration.
 */
export function registerSessionRowMarker(ctx, options = {}) {
  const slots = ctx?.slots;
  if (slots === null || slots === undefined || typeof slots.inject !== 'function') return () => {};
  const store = options.store ?? null;
  const api = options.api ?? createApi();
  const loadIdentity = typeof options.sessionMap === 'function' ? options.sessionMap : () => loadSessionMap(api);
  const services = {
    workspaces: () => hostService(ctx, 'workspaces'),
    uiWorkspace: () => hostService(ctx, 'uiWorkspace'),
  };
  const rowProps = Object.freeze({ store, services, loadIdentity });
  const Marker = (props) => DispatchedSessionMarker({ ...props, ...rowProps });

  try {
    return slots.inject(SESSION_ROW_ACTION_SLOT, () => slots.register({
      name: SESSION_ROW_ACTION_SLOT,
      id: SESSION_ROW_ACTION_ID,
      order: SESSION_ROW_ACTION_ORDER,
    }, Marker));
  } catch {
    return () => {};
  }
}

/** @deprecated Removed: this plugin no longer registers on `sidebar.workspaces` itself. */
export function registerWorkspacesBrowser() {
  return () => {};
}

/** @deprecated The region is the host's; kept only so an older import resolves. */
export const WORKSPACES_PRIORITY = -200;

/**
 * Read the plugin's identity map from the operator plane. A refusal answers an empty list.
 * @param {object} api - user-plane transport.
 * @returns {Promise<object[]>} identity rows (possibly empty).
 */
export async function loadSessionMap(api) {
  try {
    const body = await api.getSessionMap();
    return Array.isArray(body?.sessions) ? body.sessions : [];
  } catch {
    return [];
  }
}

/**
 * A stable snapshot from a host source, safe for `useSyncExternalStore`.
 * @param {object | null} snapshot - raw host snapshot.
 * @param {{ key: string | null, value: object | null }} [cache] - the caller's cache slot.
 * @returns {object | null} stable snapshot.
 */
export function stableSnapshot(snapshot, cache = { key: null, value: null }) {
  if (snapshot === null || typeof snapshot !== 'object') return null;
  const key = JSON.stringify({
    phase: snapshot.phase ?? null,
    items: (Array.isArray(snapshot.items) ? snapshot.items : []).map((item) => [
      item?.workspaceId ?? null, item?.title ?? null, item?.path ?? null,
      Array.isArray(item?.sessionIds) ? item.sessionIds : [],
    ]),
    archived: Array.isArray(snapshot.archivedSessionIds) ? snapshot.archivedSessionIds : [],
    ungrouped: Array.isArray(snapshot.ungroupedSessionIds) ? snapshot.ungroupedSessionIds : [],
  });
  if (cache.key === key && cache.value !== null) return cache.value;
  cache.key = key;
  cache.value = snapshot;
  return snapshot;
}

/**
 * Which presentation the plugin's own grouping calls for.
 * @param {object} input - `ownCount`.
 * @returns {'grouped'|'passthrough'} the mode.
 */
export function workspacesViewMode(input = {}) {
  return typeof input.ownCount === 'number' && input.ownCount > 0
    ? WORKSPACE_VIEWS.grouped
    : WORKSPACE_VIEWS.passthrough;
}

/**
 * The identity map narrowed to a session → proof lookup, memoised by content.
 *
 * The row marker receives only a `sessionId` from the host, so it needs the map (read once) plus
 * the task records (which also prove a NEW dispatch). Both are turned into one lookup here.
 * @param {object[] | null} identities - `/session-map` rows, or null while unread.
 * @param {object[]} tasks - `/tasks` rows.
 * @returns {{ bySession: Map<string, object>, ready: boolean }} the lookup.
 */
export function dispatchProof(identities, tasks) {
  const records = sessionIndex(tasks);
  const bySession = new Map();
  // The record list also carries TITLES, and a title is display evidence, not placement: a
  // session named by a record with no Workspace still tells the marker what it is called.
  for (const [sessionId, title] of records.titles) bySession.set(sessionId, { sessionId, title });
  for (const row of identities ?? []) {
    if (row === null || typeof row !== 'object') continue;
    const sessionId = typeof row.sessionId === 'string' ? row.sessionId.trim() : '';
    if (sessionId === '') continue;
    const previous = bySession.get(sessionId);
    bySession.set(sessionId, { ...previous, ...row });
  }
  for (const [sessionId, pair] of records.pairs) {
    const previous = bySession.get(sessionId);
    bySession.set(sessionId, { ...previous, ...pair });
  }
  return { bySession, ready: identities !== null };
}

// ---------------------------------------------------------------------------
// The per-row marker
// ---------------------------------------------------------------------------

/**
 * The marker the host renders inside one native session row.
 *
 * It is additive and quiet: a small badge naming the isolation ("派工" for a shared run, "派工·
 * 隔离" for a worktree run), with the TaskBridge title as its tooltip. A session this plugin did
 * not dispatch renders NOTHING, so the native row is unchanged.
 * @param {object} props - the slot's own props (`sessionId` among them) plus the injection.
 * @returns {object | null} the badge, or null.
 */
export function DispatchedSessionMarker(props) {
  const sessionId = typeof props?.sessionId === 'string' ? props.sessionId.trim() : '';
  if (sessionId === '') return null;
  const store = props?.store ?? null;

  const [identities, setIdentities] = useState(null);
  const identityLoader = useRef(props?.loadIdentity);
  if (typeof props?.loadIdentity === 'function') identityLoader.current = props.loadIdentity;
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const rows = await identityLoader.current?.();
        if (live) setIdentities(Array.isArray(rows) ? rows : []);
      } catch {
        if (live) setIdentities([]);
      }
    })();
    return () => { live = false; };
    // The mount read is the point of this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emptyRecords = useRef({ tasks: [] });
  const recordCache = useRef({ key: '', value: emptyRecords.current });
  const getRecords = useCallback(() => {
    const raw = typeof store?.getSnapshot === 'function' ? store.getSnapshot() : null;
    const tasks = Array.isArray(raw?.tasks) ? raw.tasks : (Array.isArray(props?.tasks) ? props.tasks : []);
    const key = JSON.stringify(tasks.map((task) => [
      task?.taskId ?? null, task?.sessionId ?? null,
      task?.execution?.sessionId ?? null, task?.execution?.workspaceId ?? null,
    ]));
    const cache = recordCache.current;
    if (key === cache.key) return cache.value;
    cache.key = key;
    cache.value = { tasks };
    return cache.value;
  }, [store, props?.tasks]);
  const subscribeRecords = useCallback((listener) => {
    if (typeof store?.subscribe !== 'function') return () => {};
    let dispose = null;
    try {
      dispose = store.subscribe(listener);
    } catch {
      return () => {};
    }
    return typeof dispose === 'function' ? dispose : () => {};
  }, [store]);
  const records = useSyncExternalStore(subscribeRecords, getRecords, getRecords);

  const proof = useMemo(() => dispatchProof(identities, records.tasks), [identities, records]);
  const identity = proof.bySession.get(sessionId) ?? null;
  if (identity === null) return null;

  const isolated = identity.isolation === 'worktree';
  const label = isolated ? '派工 · 隔离' : '派工';
  const title = identity.title ?? identity.taskId ?? '';
  return (
    <span
      className="dshdg-row-marker"
      data-dshdg-row-marker={sessionId}
      data-dshdg-row-marker-isolation={identity.isolation ?? 'shared'}
      title={title === '' ? '这是一个 TaskBridge 派出的对话' : `TaskBridge 派工：${title}`}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The plugin's own grouping surface
// ---------------------------------------------------------------------------

/**
 * The plugin's OWN grouping surface: TaskBridge → 任务工作区 → 对话.
 *
 * This is the part the host cannot give the shell (a section above its browser), so it lives
 * here, on this plugin's own panel, where it is rendered completely and disturb no native row.
 * Strictly three levels, one task-workspace row per dispatched CHAIN.
 * @param {object} props - `store`, `services`, `loadIdentity`.
 * @returns {object | null} the grouping, or null when nothing is proven.
 */
export function TaskbridgeGrouping(props) {
  const store = props?.store ?? null;
  const services = props?.services ?? {};
  const [identities, setIdentities] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const identityLoader = useRef(props?.loadIdentity);
  if (typeof props?.loadIdentity === 'function') identityLoader.current = props.loadIdentity;

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const rows = await identityLoader.current?.();
        if (live) setIdentities(Array.isArray(rows) ? rows : []);
      } catch {
        if (live) setIdentities([]);
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const snapshotCache = useRef({ key: null, value: null });
  const subscribe = useCallback((listener) => {
    const source = services.workspaces?.()?.list;
    if (source === null || source === undefined || typeof source.subscribe !== 'function') return () => {};
    let dispose = null;
    try {
      dispose = source.subscribe(listener);
    } catch {
      return () => {};
    }
    return typeof dispose === 'function' ? dispose : () => {};
  }, [services]);
  const getSnapshot = useCallback(
    () => stableSnapshot(readWorkspacesSnapshot(services.workspaces?.() ?? null), snapshotCache.current),
    [services],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const emptyRecords = useRef({ tasks: [] });
  const recordCache = useRef({ key: '', value: emptyRecords.current });
  const getRecords = useCallback(() => {
    const raw = typeof store?.getSnapshot === 'function' ? store.getSnapshot() : null;
    const tasks = Array.isArray(raw?.tasks) ? raw.tasks : (Array.isArray(props?.tasks) ? props.tasks : []);
    const key = JSON.stringify(tasks.map((task) => [
      task?.taskId ?? null, task?.title ?? null, task?.sessionId ?? null, task?.continueFromTaskId ?? null,
      task?.execution?.sessionId ?? null, task?.execution?.workspaceId ?? null, task?.execution?.sourcePath ?? null,
    ]));
    const cache = recordCache.current;
    if (key === cache.key) return cache.value;
    cache.key = key;
    cache.value = { tasks };
    return cache.value;
  }, [store, props?.tasks]);
  const subscribeRecords = useCallback((listener) => {
    if (typeof store?.subscribe !== 'function') return () => {};
    let dispose = null;
    try {
      dispose = store.subscribe(listener);
    } catch {
      return () => {};
    }
    return typeof dispose === 'function' ? dispose : () => {};
  }, [store]);
  const records = useSyncExternalStore(subscribeRecords, getRecords, getRecords);

  const view = useMemo(() => workspaceGroups({
    snapshot,
    identities: identities ?? [],
    tasks: records.tasks,
  }), [snapshot, identities, records]);

  const run = useCallback(async (label, work) => {
    setBusy(true);
    setFeedback(null);
    try {
      await work();
    } catch (error) {
      const detail = typeof error?.message === 'string' && error.message !== '' ? error.message.slice(0, 160) : '';
      setFeedback({ ok: false, message: `${label}失败${detail === '' ? '' : `：${detail}`}` });
    } finally {
      setBusy(false);
    }
  }, []);
  const onToggle = useCallback((key) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const onOpenSession = useCallback((sessionId) => {
    const ui = services.uiWorkspace?.() ?? null;
    if (typeof ui?.openSession !== 'function') {
      setFeedback({ ok: false, message: '当前宿主没有提供打开会话的接口，未跳转。' });
      return;
    }
    run('打开会话', () => ui.openSession(sessionId));
  }, [services, run]);
  const onStartSession = useCallback((workspaceId) => {
    const ui = services.uiWorkspace?.() ?? null;
    if (typeof ui?.startSession !== 'function') {
      setFeedback({ ok: false, message: '当前宿主没有提供新建会话的接口，未新建。' });
      return;
    }
    run('新建会话', () => ui.startSession(workspaceId));
  }, [services, run]);
  const onArchive = useCallback((sessionId) => {
    const registry = services.workspaces?.() ?? null;
    if (typeof registry?.archiveSession !== 'function') {
      setFeedback({ ok: false, message: '当前宿主没有提供归档接口，未改变任何会话状态。' });
      return;
    }
    run('归档会话', () => registry.archiveSession(sessionId));
  }, [services, run]);
  const onRestore = useCallback((sessionId) => {
    const registry = services.workspaces?.() ?? null;
    if (typeof registry?.unarchiveSession !== 'function') {
      setFeedback({ ok: false, message: '当前宿主没有提供恢复接口，会话仍保持归档。' });
      return;
    }
    run('恢复会话', () => registry.unarchiveSession(sessionId));
  }, [services, run]);
  const openRename = useCallback((workspace) => {
    const registry = services.workspaces?.() ?? null;
    if (workspace === null || typeof registry?.rename !== 'function') {
      setFeedback({ ok: false, message: '当前宿主没有提供重命名工作区的接口，未改名。' });
      return;
    }
    // A Workspace that also holds the operator's own conversations must never be renamed as a
    // whole: the rename would move that conversation too.
    if (workspace.sharedWithOrdinary === true) {
      setFeedback({ ok: false, message: '这个工作区里也有你自己的普通对话，不能整项重命名。' });
      return;
    }
    const next = askText('工作区名称', workspace.title);
    if (next === null) return;
    const title = String(next).trim();
    if (title === '' || title === workspace.title) return;
    run('重命名工作区', () => registry.rename(workspace.workspaceId, title));
  }, [services, run]);
  const openRemove = useCallback((workspace) => {
    const registry = services.workspaces?.() ?? null;
    if (workspace === null || typeof registry?.delete !== 'function') {
      setFeedback({ ok: false, message: '当前宿主没有提供移除工作区的接口，未移除。' });
      return;
    }
    if (workspace.sharedWithOrdinary === true) {
      setFeedback({ ok: false, message: '这个工作区里也有你自己的普通对话，不能整项移除。' });
      return;
    }
    if (!askConfirm(`从 DSH 移除工作区「${workspace.title}」？目录和记录都会保留。`)) return;
    run('移除工作区', () => registry.delete(workspace.workspaceId));
  }, [services, run]);

  const uiWorkspace = services.uiWorkspace?.() ?? null;
  const registry = services.workspaces?.() ?? null;
  const canOpen = typeof uiWorkspace?.openSession === 'function';
  const canStartSession = typeof uiWorkspace?.startSession === 'function';
  const canRename = typeof registry?.rename === 'function';
  const canRemove = typeof registry?.delete === 'function';
  const canArchive = typeof registry?.archiveSession === 'function';
  const canRestore = typeof registry?.unarchiveSession === 'function';

  const mode = workspacesViewMode({ ownCount: view.ownCount });
  if (mode === WORKSPACE_VIEWS.passthrough) {
    return (
      <p className="dshdg-ws-hint" data-dshdg-ws-empty="">
        {identities === null ? '正在读取 TaskBridge 的会话归属…' : '还没有可核实的 TaskBridge 派工对话。'}
      </p>
    );
  }

  const section = view.groups[0] ?? null;
  const sectionOpen = section === null || !collapsed.has(section.key);
  return (
    <section className="dshdg-ws" data-dshdg-ws-grouping={mode} aria-label="TaskBridge 派工对话">
      <ul className="dshdg-ws-tree">
        <li className="dshdg-ws-root" data-dshdg-ws-root="">
          <div className="dshdg-ws-row dshdg-ws-root-row">
            <Caret open={sectionOpen} onToggle={() => onToggle(section.key)} label={`${sectionOpen ? '收起' : '展开'} TaskBridge`} />
            <span className="dshdg-ws-title">
              <span className="dshdg-ws-root-name">TaskBridge</span>
            </span>
            <span className="dshdg-ws-count">
              {`${section.workspaceCount} 个任务工作区 · ${section.conversationCount} 个对话`}
            </span>
          </div>
          {sectionOpen ? (
            <ul className="dshdg-ws-projects">
              {section.projects.map((project) => (
                <ProjectNode
                  key={project.key}
                  project={project}
                  open={!collapsed.has(`project:${project.key}`)}
                  onToggle={() => onToggle(`project:${project.key}`)}
                >
                  {project.workspaces.map((workspace) => (
                    <TaskWorkspaceNode
                      key={workspace.chainId ?? workspace.workspaceId}
                      workspace={workspace}
                      open={!collapsed.has(`chain:${workspace.chainId ?? workspace.workspaceId}`)}
                      onToggle={() => onToggle(`chain:${workspace.chainId ?? workspace.workspaceId}`)}
                      busy={busy}
                      canStartSession={canStartSession}
                      canRename={canRename}
                      canRemove={canRemove}
                      onStartSession={onStartSession}
                      openRename={openRename}
                      openRemove={openRemove}
                      onOpen={canOpen ? onOpenSession : null}
                      onArchive={canArchive ? onArchive : null}
                    />
                  ))}
                </ProjectNode>
              ))}
            </ul>
          ) : null}
        </li>
      </ul>
      {view.archived.length > 0 ? (
        <details className="dshdg-ws-archived" data-dshdg-ws-archived="">
          <summary>{`TaskBridge 已归档（${view.archived.length}）`}</summary>
          <p className="dshdg-ws-hint">这些会话在 DSH 里已经归档，只能在 DSH 的归档里恢复。</p>
          <ul className="dshdg-ws-tree">
            {view.archived.map((session) => (
              <li className="dshdg-ws-session" key={session.sessionId} data-dshdg-ws-archived-session={session.sessionId}>
                <span className="dshdg-ws-session-title">{session.title !== '' ? session.title : shortId(session.sessionId)}</span>
                <button
                  type="button"
                  className="dshdg-ws-session-action"
                  data-dshdg-ws-action="restore-session"
                  disabled={busy === true || !canRestore}
                  title={canRestore ? '在 DSH 中把这个会话移出归档' : '当前宿主没有提供恢复接口'}
                  onClick={() => onRestore(session.sessionId)}
                >
                  恢复
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {feedback === null ? null : (
        <p className={feedback.ok ? 'dshdg-ws-hint' : 'dshdg-ws-warn'} role="status" aria-live="polite" data-dshdg-ws-feedback="refused">
          {feedback.message}
        </p>
      )}
    </section>
  );
}

/** One row's caret: expand / collapse, with the state announced. */
function Caret({ open, onToggle, label }) {
  return (
    <button
      type="button"
      className="dshdg-ws-caret"
      aria-expanded={open}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {open ? '▾' : '▸'}
    </button>
  );
}

/** One conversation row: the native ids it opens, its isolation and its archive action. */
function SessionRow({ session, onOpen, onArchive, busy }) {
  const title = session.title !== '' ? session.title : shortId(session.sessionId);
  const isolation = session.isolation === 'worktree' ? '隔离副本' : (session.isolation === 'shared' ? '原目录' : '');
  return (
    <li
      className="dshdg-ws-session"
      data-dshdg-ws-session={session.sessionId}
      data-dshdg-ws-session-workspace={session.workspaceId ?? ''}
    >
      <button
        type="button"
        className="dshdg-ws-open"
        title={`${session.sessionId}${session.workspaceId ? `\n工作区：${session.workspaceId}` : ''}`}
        disabled={busy === true || typeof onOpen !== 'function'}
        onClick={() => onOpen(session.sessionId)}
      >
        <span className="dshdg-ws-session-title">{title}</span>
        {isolation !== '' ? <span className="dshdg-ws-faint">{isolation}</span> : null}
      </button>
      <button
        type="button"
        className="dshdg-ws-session-action"
        data-dshdg-ws-action="archive-session"
        disabled={busy === true || typeof onArchive !== 'function'}
        title={typeof onArchive === 'function' ? '在 DSH 中归档这个会话' : '当前宿主没有提供归档接口'}
        onClick={() => onArchive?.(session.sessionId)}
      >
        归档
      </button>
    </li>
  );
}

/** One task workspace: the native Workspace one dispatched chain lives in. */
function TaskWorkspaceNode(props) {
  const {
    workspace, open, onToggle, busy,
    canStartSession, canRename, canRemove,
    onStartSession, openRename, openRemove, onOpen, onArchive,
  } = props;
  const bodyId = `dshdg-ws-body-${encodeURIComponent(workspace.chainId ?? workspace.workspaceId)}`;
  const refusedAsWhole = workspace.sharedWithOrdinary === true;
  return (
    <li
      className="dshdg-ws-workspace"
      data-dshdg-ws-workspace={workspace.workspaceId}
      data-dshdg-ws-chain={workspace.chainId ?? ''}
      data-dshdg-ws-shared={refusedAsWhole ? '' : undefined}
    >
      <div className="dshdg-ws-row">
        <Caret open={open} onToggle={onToggle} label={`${open ? '收起' : '展开'}任务工作区 ${workspace.title}`} />
        <button
          type="button"
          className="dshdg-ws-title"
          title={workspace.path !== '' ? workspace.path : workspace.workspaceId}
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={bodyId}
        >
          {workspace.title}
        </button>
        <span className="dshdg-ws-count">{`${workspace.conversations.length} 个对话`}</span>
        <span className="dshdg-ws-spacer" />
        <span className="dshdg-ws-actions">
          <button
            type="button"
            data-dshdg-ws-action="new-session"
            disabled={busy === true || !canStartSession}
            title={canStartSession ? '在这个任务工作区里新建会话' : '当前宿主没有提供新建会话的接口'}
            onClick={() => onStartSession?.(workspace.workspaceId)}
          >
            新会话
          </button>
          <button
            type="button"
            data-dshdg-ws-action="rename"
            disabled={busy === true || !canRename}
            title={refusedAsWhole
              ? '这个工作区里也有你自己的普通对话，不能整项重命名'
              : (canRename ? '重命名这个任务工作区' : '当前宿主没有提供重命名工作区的接口')}
            onClick={() => openRename?.(workspace)}
          >
            重命名
          </button>
          <button
            type="button"
            data-dshdg-ws-action="remove"
            disabled={busy === true || !canRemove || refusedAsWhole}
            title={refusedAsWhole
              ? '这个工作区里也有你自己的普通对话，不能整项移除'
              : (canRemove ? '从 DSH 移除这个任务工作区（目录与会话保留）' : '当前宿主没有提供移除工作区的接口')}
            onClick={() => openRemove?.(workspace)}
          >
            移除
          </button>
        </span>
      </div>
      {open ? (
        <ul id={bodyId} className="dshdg-ws-conversations" role="group" aria-label={`${workspace.title} 的对话`}>
          {workspace.conversations.map((session) => (
            <SessionRow key={session.sessionId} session={session} onOpen={onOpen} onArchive={onArchive} busy={busy} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** One project: a real source, holding its task workspaces. */
function ProjectNode(props) {
  const { project, open, onToggle, children } = props;
  const bodyId = `dshdg-ws-project-body-${encodeURIComponent(project.key)}`;
  return (
    <li className="dshdg-ws-project" data-dshdg-ws-project={project.key} data-dshdg-ws-project-name={project.name}>
      <div className="dshdg-ws-row dshdg-ws-project-row">
        <Caret open={open} onToggle={onToggle} label={`${open ? '收起' : '展开'}项目 ${project.name}`} />
        <button
          type="button"
          className="dshdg-ws-title"
          title={project.path}
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={bodyId}
        >
          {project.name}
        </button>
        <span className="dshdg-ws-count">
          {`${project.workspaceCount} 个任务工作区 · ${project.conversationCount} 个对话`}
        </span>
      </div>
      {open ? <ul id={bodyId} className="dshdg-ws-workspaces">{children}</ul> : null}
    </li>
  );
}

