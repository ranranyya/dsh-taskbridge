// dsh-delegate — native left navigation: the TaskBridge task entry and its panel.
//
// This file is the ONLY thing in the bundle that touches the host's main/sidebar
// slot names. It is deliberately small: the panel it registers reads the task data
// the bundle already fetched, and its own collapse state is local. It draws no
// second task tree and performs no navigation of its own beyond asking DSH's own
// Workspace service to open a session whose identity TaskBridge recorded.
//
// What is registered, and against WHAT CONTRACT
// --------------------------------------------
// Two registrations, both through `ctx.slots.inject(name, register)`, matching the
// host exactly (0.2.2-rc.5,
// `@deepseek-ai/dsh-client-ui-plugin-manager/src/client/index.ts`):
//
//   * `main`             — the FULL CONTENT PANEL,
//                          `{ name: 'main', key }`, registered with the panel
//                          component. The host hands the owner `size`/`active`.
//   * `sidebar.panellist`— the SMALL ICON,
//                          `{ name: 'sidebar.panellist', id, order, label }`,
//                          registered with the icon component. `label` is a FUNCTION
//                          the host calls for the row's text.
// The two share one id (`TASKS_NAV_KEY`), which is how the row selects the panel.
//
// Both slots belong to the host's own shell. They are OPTIONAL here: a host (or a
// shell rebuild) that never declares them simply never runs the registrations, and
// `inject` disposes them on the way out. That matters because the bundle's existing
// `plugins.bundle.config` page must keep working on a host without a sidebar — so
// nothing in this module is a prerequisite for the settings page.
//
// The shell's own workspace/session browsing region belongs to DSH: THIS module never
// registers there, and no TaskBridge task view replaces it. The grouped workspaces
// browser is a SEPARATE registration (`workspaces-browser.jsx`, `sidebar.workspaces`,
// lower priority than the shipped entry) whose identity rules are stated there and in
// `docs/workspace-grouping.md`; it keeps ordinary Workspaces, and it falls back to the
// shipped browser whenever it cannot prove what belongs to which project.
//
// What the panel may and may not do
// ---------------------------------
//   * It reads records from the SAME page store `apply` already built, so opening it
//     never duplicates a read. The initial load runs in an effect (never in render);
//     there is no per-row request and no timer.
//   * A session is offered for navigation only when the record carries the host's
//     real session id AND the host's own `workspaces` snapshot can vouch for it.
//   * It never renames, moves, archives or deletes a session. Archiving stays a DSH
//     action performed in DSH's own UI.
//
// Rendering rules worth keeping:
//   * same-titled projects stay separate entries (identity is the host's project
//     key, never the title);
//   * a record whose source could not be confirmed is shown as such, in its own
//     group, and is never folded into a real project;
//   * a historical record without a navigation identifier stays listed, with the
//     reason stated, rather than disappearing.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { taskOutcome, TREE_STATUS_LABELS, TREE_STATUS_TONES } from './api.js';

// ---------------------------------------------------------------------------
// Slot names and registration keys
// ---------------------------------------------------------------------------

/** The host's registry slot: main-area entries (the sidebar icon). */
export const MAIN_SLOT = 'main';

/** The host's registry slot: the left sidebar's panel list (the row). */
export const SIDEBAR_PANEL_SLOT = 'sidebar.panellist';

/**
 * One id for both registrations.
 *
 * The icon in `main` and the row in `sidebar.panellist` are two halves of the same
 * entry, so they share an identity. It is namespaced because the sidebar is shared
 * with other plugins.
 */
export const TASKS_NAV_KEY = 'dsh-taskbridge:taskbridge-tasks';

/** Smallest order that keeps this entry at the front without taking part 100. */
export const TASKS_NAV_ORDER = 20;

/** Operator-facing label of the entry. */
export const TASKS_NAV_LABEL = 'TaskBridge 任务';

// ---------------------------------------------------------------------------
// Pure helpers (exported so a test can drive them without a browser)
// ---------------------------------------------------------------------------

/**
 * The host Workspace service, if this host has one.
 *
 * `ctx.get` is the Cordis lookup; a host that does not compose Workspace answering
 * with nothing here is the documented degradation, not an error.
 * @param {object | null | undefined} ctx - client context.
 * @returns {object | null} service exposing `openSession`.
 */
export function resolveUiWorkspace(ctx) {
  const get = ctx !== null && typeof ctx === 'object' ? ctx.get : null;
  if (typeof get !== 'function') return null;
  let service = null;
  try {
    service = get.call(ctx, 'uiWorkspace');
  } catch {
    service = null;
  }
  if (service === null || typeof service !== 'object') return null;
  return typeof service.openSession === 'function' ? service : null;
}

/**
 * The host's `workspaces` service, if this host has one.
 *
 * It is a separate service from `uiWorkspace`: `uiWorkspace` opens a session, while
 * `workspaces.list` is the subscribable source (`{ getSnapshot, subscribe }`) whose
 * snapshot says which sessions exist and which are archived. Both are looked up
 * lazily, because the host may compose them after this plugin mounts.
 * @param {object | null | undefined} ctx - client context.
 * @returns {object | null} service exposing `list.getSnapshot`.
 */
export function resolveWorkspaces(ctx) {
  const get = ctx !== null && typeof ctx === 'object' ? ctx.get : null;
  if (typeof get !== 'function') return null;
  let service = null;
  try {
    service = get.call(ctx, 'workspaces');
  } catch {
    service = null;
  }
  if (service === null || typeof service !== 'object') return null;
  return typeof service.list?.getSnapshot === 'function' ? service : null;
}

/**
 * Resolve one service that may be a value or a lazy getter.
 *
 * `apply` passes getters so a host service composed AFTER this plugin mounts is still
 * found when it is finally used; a plain value (a test double, or a host that had it
 * ready) is returned as-is.
 * @param {unknown} value - service, getter, or nothing.
 * @returns {object | null} the service.
 */
export function resolveService(value) {
  if (typeof value === 'function') {
    try {
      const resolved = value();
      return resolved !== null && typeof resolved === 'object' ? resolved : null;
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === 'object' ? value : null;
}

/**
 * Register the entry on a client context.
 *
 * The split matches the host exactly (0.2.2-rc.5,
 * `dsh-client-ui-plugin-manager/src/client/index.ts`):
 *   * `main`              — the FULL CONTENT PANEL, `{ name: 'main', key: PANEL_ID }`,
 *                           registered with the page component. The host gives the
 *                           owner its `size`/`active` seats.
 *   * `sidebar.panellist` — the SMALL ICON, `{ name: 'sidebar.panellist', id, order,
 *                           label }`, registered with the icon component. `label` is
 *                           a function the host calls for the row's text.
 * The two share one id, which is how the row selects the panel.
 *
 * Exactly ONE store instance is passed in and used by both halves, so opening the
 * entry never issues a second read for records the page already holds.
 *
 * Split out from `apply` so a test can hand it a fake `ctx` and assert the exact
 * registration shape without a browser. A missing `slots` service is a host without
 * the sidebar: both registrations are skipped and this returns a no-op.
 * @param {object} ctx - client Cordis context.
 * @param {object} options - `store`, `uiWorkspace`, `workspaces`.
 * @returns {() => void} disposer releasing both registrations.
 */
export function registerTasksNavigation(ctx, options = {}) {
  const slots = ctx?.slots;
  if (slots === null || slots === undefined || typeof slots.inject !== 'function') return () => {};
  const { store = null, uiWorkspace = null, workspaces = null } = options;

  const panel = () => TaskbridgeNavPanel({ store, uiWorkspace, workspaces });
  const icon = TaskbridgeSidebarIcon;

  const registerPanel = options.registerPanel ?? (() => slots.inject(MAIN_SLOT, () => slots.register({
    name: MAIN_SLOT,
    key: TASKS_NAV_KEY,
  }, panel)));

  const registerIcon = options.registerIcon ?? (() => slots.inject(SIDEBAR_PANEL_SLOT, () => slots.register({
    name: SIDEBAR_PANEL_SLOT,
    id: TASKS_NAV_KEY,
    order: TASKS_NAV_ORDER,
    label: () => TASKS_NAV_LABEL,
  }, icon)));

  const disposers = [];
  // Each registration stands on its own: a host that declares only one of the two
  // slots still gets the half it declares, and a refusal of one never cancels the
  // other. `inject` itself only defers; nothing here throws for a missing slot.
  for (const register of [registerPanel, registerIcon]) {
    try {
      const dispose = register();
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch {
      // A host whose slot API refuses this registration keeps working; the entry
      // simply does not appear. Nothing else in the bundle depends on it.
    }
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // Disposal is best-effort: a disposer that already ran must not fail twice.
      }
    }
  };
}

/** The label a session id is shown with: shortened, never guessed. */
export function shortSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return '';
  return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 6)}…${sessionId.slice(-4)}`;
}

/**
 * The navigation identifier TaskBridge recorded for ONE task, or null.
 *
 * Only a host-recorded identity counts. Order of evidence, strongest first:
 *   1. the record's OWN top-level `sessionId` — a historical (restored) record keeps
 *      its thread there, and that is the record alive in the current host;
 *   2. the run's `execution.sessionId`;
 *   3. the conversation's own `sessionId`.
 * Nothing is derived from the task id, a title, a workspace path or a position,
 * because none of those identify a native session.
 * @param {object | null | undefined} task - one `/tasks` row.
 * @returns {string | null} session id.
 */
export function taskSessionId(task) {
  if (task === null || task === undefined || typeof task !== 'object') return null;
  for (const candidate of [task.sessionId, task.execution?.sessionId, task.conversation?.sessionId]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return null;
}

/**
 * Read the host's Workspaces snapshot, or null when it cannot be read synchronously.
 *
 * The host service is `{ getSnapshot, subscribe }`; its snapshot is
 * `{ phase, items: [{ workspaceId, sessionIds, ... }], archivedSessionIds }`. Anything
 * else (an absent service, a throwing/suspending source) yields null, which the caller
 * treats as "cannot check" rather than guessing.
 * @param {object | null | undefined} workspaces - host `workspaces` service.
 * @returns {object | null} the snapshot.
 */
export function workspacesSnapshot(workspaces) {
  const source = workspaces?.list;
  if (source === null || source === undefined || typeof source.getSnapshot !== 'function') return null;
  let snapshot = null;
  try {
    snapshot = source.getSnapshot();
  } catch {
    return null;
  }
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  return snapshot;
}

/**
 * Every session id the host's snapshot knows, with the workspace it belongs to.
 * @param {object | null} snapshot - `workspacesSnapshot(...)`.
 * @returns {Map<string, string>} session id → workspace id.
 */
export function knownSessionIds(snapshot) {
  const index = new Map();
  for (const item of Array.isArray(snapshot?.items) ? snapshot.items : []) {
    if (item === null || typeof item !== 'object') continue;
    const workspaceId = typeof item.workspaceId === 'string' ? item.workspaceId : '';
    for (const sessionId of Array.isArray(item.sessionIds) ? item.sessionIds : []) {
      if (typeof sessionId === 'string' && sessionId !== '' && !index.has(sessionId)) index.set(sessionId, workspaceId);
    }
  }
  return index;
}

/**
 * Where an id sits among the host's own Workspaces.
 *
 * Read from `workspaces.list.getSnapshot()`. The answers are kept apart on purpose,
 * because each calls for a different action:
 *   * `pending`  — the snapshot is not ready yet (a phase other than ready, or no
 *                  snapshot). Nothing can be verified, so the operator is told to
 *                  retry later rather than sent somewhere unverified.
 *   * `present`  — the host lists this session in a workspace, and it is not archived.
 *                  This is the only state that may be opened.
 *   * `archived` — the id is in the host's own `archivedSessionIds`. Refused, and NOT
 *                  reported as missing: DSH archived it, and only DSH can put it back.
 *   * `missing`  — the snapshot is ready and lists neither, so the id is not a live
 *                  session here. Refused explicitly instead of opened on faith.
 *   * `unknown`  — no service at all (a host without Workspaces).
 * @param {string | null} sessionId - host session id.
 * @param {object | null | undefined} workspaces - host Workspace service.
 * @returns {{ state: 'unknown'|'pending'|'present'|'archived'|'missing', label: string | null, workspaceId: string | null }} placement.
 */
export function sessionPlacement(sessionId, workspaces) {
  const label = () => (typeof sessionId === 'string' && sessionId !== '' ? shortSessionId(sessionId) : null);
  const snapshot = workspacesSnapshot(workspaces);
  if (snapshot === null) return { state: 'unknown', label: label(), workspaceId: null };
  // The host publishes its own readiness; anything but `ready` means "cannot tell yet".
  if (snapshot.phase !== 'ready') return { state: 'pending', label: label(), workspaceId: null };
  if (typeof sessionId !== 'string' || sessionId === '') return { state: 'missing', label: null, workspaceId: null };
  const archived = Array.isArray(snapshot.archivedSessionIds) ? snapshot.archivedSessionIds : [];
  if (archived.includes(sessionId)) return { state: 'archived', label: label(), workspaceId: null };
  const workspaceId = knownSessionIds(snapshot).get(sessionId) ?? null;
  if (workspaceId === null) return { state: 'missing', label: label(), workspaceId: null };
  return { state: 'present', label: label(), workspaceId };
}

/** Use the task page's status, including whether its review was saved. */
function statusOf(row) {
  const key = typeof row.nodeStatus === 'string' ? row.nodeStatus : (typeof row.state === 'string' ? row.state : 'unknown');
  const { label, tone } = taskOutcome(row);
  if (label !== '') return { key, label, tone };
  return { key, label: TREE_STATUS_LABELS[key] ?? key, tone: TREE_STATUS_TONES[key] ?? 'off' };
}

/**
 * The panel's model: projects, their sessions, and what may be opened.
 *
 * Groups are keyed by the host's project key — never by a title — so two projects
 * with the same name stay two entries; `tree.projects` carries the host's own
 * display name and short path for each key, and a key it does not name falls back to
 * the key itself. `unverified` (the projection's "来源未确认") is its own group and is
 * never merged into a named one.
 *
 * A session row is a task the host recorded. Its navigation identity is only ever
 * the host-recorded session id; a row without one is still listed, marked, and its
 * locate control is disabled — a historical record must not vanish just because it
 * cannot be opened.
 *
 * Archived records come from the OPTIONAL `displayArchived` boolean G07 adds to each
 * tree node. That flag is read, never written: toggling this list cannot archive,
 * rename or move anything in DSH. A record's own `archived` field is NOT this flag —
 * it marks a record recovered from durable history, which is a live record and stays
 * in the active list. When G07 has not published the flag, every record is treated as
 * an ordinary historical one.
 * @param {object} snapshot - page store snapshot.
 * @returns {object} `{ groups, archivedGroups, activeCount, archivedCount, total, available, projectName }`.
 */
export function navViewModel(snapshot) {
  const tree = snapshot?.tree ?? null;
  const rows = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];

  // The host's project summaries, by key: display name, short path and order.
  const meta = new Map();
  for (const project of Array.isArray(tree?.projects) ? tree.projects : []) {
    if (project === null || typeof project !== 'object') continue;
    const key = typeof project.projectKey === 'string' && project.projectKey !== '' ? project.projectKey : null;
    if (key === null || meta.has(key)) continue;
    meta.set(key, {
      name: typeof project.name === 'string' && project.name !== '' ? project.name : null,
      shortPath: typeof project.shortPath === 'string' && project.shortPath !== '' ? project.shortPath : null,
      unverified: project.unverified === true,
      nodeCount: Number.isFinite(project.nodeCount) ? project.nodeCount : 0,
    });
  }
  const groupOf = (groups, key) => {
    if (!groups.has(key)) groups.set(key, { key, sessions: [], archived: [] });
    return groups.get(key);
  };

  const archivedTasks = new Set();
  const nodeProjects = new Map();
  const walk = (node, parentArchived = false) => {
    if (node === null || typeof node !== 'object') return;
    const archived = parentArchived || node.displayArchived === true;
    const chains = node.kind === 'plan' ? (node.executions ?? []) : (node.chain ? [node.chain] : []);
    const taskIds = chains.flatMap((chain) => chain.taskIds ?? []);
    if (node.kind === 'task' && taskIds.length === 0) taskIds.push(node.nodeId);
    for (const id of [node.nodeId, ...taskIds]) {
      if (typeof id === 'string' && typeof node.projectKey === 'string' && node.projectKey !== '') {
        nodeProjects.set(id, node.projectKey);
      }
    }
    if (archived) for (const taskId of taskIds) archivedTasks.add(taskId);
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child, archived);
  };
  for (const root of Array.isArray(tree?.roots) ? tree.roots : []) walk(root);
  // A flat-only projection (the execution plane's `/plans list` shape) is read the
  // same way: each entry names its own project key.
  for (const node of Array.isArray(tree?.flatNodes) ? tree.flatNodes : []) {
    if (node !== null && typeof node === 'object' && typeof node.nodeId === 'string'
      && typeof node.projectKey === 'string' && node.projectKey !== '' && !nodeProjects.has(node.nodeId)) {
      nodeProjects.set(node.nodeId, node.projectKey);
    }
  }

  const active = new Map();
  const archived = new Map();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const taskId = typeof row.taskId === 'string' ? row.taskId : '';
    // ONLY the G07 flag counts as TaskBridge-archived. A record's own `archived`
    // field means "recovered from durable history" — a live historical record, NOT an
    // archive — so it must stay in the active list and remain openable.
    const isArchived = taskId !== '' && (row.displayArchived === true || archivedTasks.has(taskId));
    // The project of a row comes from the HOST's projection: a `/tasks` row carries
    // no project key of its own, so its key is the one the tree node with the same
    // identity has. A row the projection no longer contains (an evicted or
    // history-only record) falls back to its own recorded source, which is a fact the
    // record states — never a guess.
    const key = projectKeyOfRow(row, nodeProjects);
    const entry = {
      taskId,
      title: typeof row.title === 'string' && row.title !== '' ? row.title : '未记录标题',
      sessionId: taskSessionId(row),
      status: statusOf(row),
      archived: isArchived,
    };
    groupOf(isArchived ? archived : active, key).sessions.push(entry);
  }

  // A project the host named is shown even when none of its nodes has executed yet,
  // so "planned, nothing dispatched" and "no such project" read differently. The
  // `unverified` bucket is NOT created here: it appears only when a record really has
  // an unconfirmed source, so an empty "来源未确认" group is never invented.
  for (const [key, info] of meta) {
    if (info.nodeCount > 0 && key !== 'unverified') groupOf(active, key);
  }

  const order = (left, right) => {
    const leftInfo = meta.get(left.key) ?? null;
    const rightInfo = meta.get(right.key) ?? null;
    const leftUnverified = left.key === 'unverified' || leftInfo?.unverified === true;
    const rightUnverified = right.key === 'unverified' || rightInfo?.unverified === true;
    if (leftUnverified !== rightUnverified) return leftUnverified ? 1 : -1;
    const leftName = leftInfo?.name ?? projectLabel(left.key);
    const rightName = rightInfo?.name ?? projectLabel(right.key);
    if (leftName !== rightName) return leftName < rightName ? -1 : 1;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  };

  const groups = [...active.values()].sort(order);
  const archivedGroups = [...archived.values()].sort(order);
  const activeCount = groups.reduce((total, group) => total + group.sessions.length, 0);
  const archivedCount = archivedGroups.reduce((total, group) => total + group.sessions.length, 0);
  return {
    groups,
    archivedGroups,
    activeCount,
    archivedCount,
    /// Live rounds plus archived rows: everything the record holds.
    total: rows.length,
    available: tree !== null && (Array.isArray(tree.roots) || Array.isArray(tree.flatNodes)),
    meta,
  };
}

/**
 * One record's project key, from the host's own statements.
 *
 * Order of evidence, strongest first:
 *   1. the projection's key for the node with this row's identity (the host already
 *      resolved the project for it);
 *   2. the row's own recorded digest, which is the key the projection uses for a
 *      verified source;
 *   3. the row's own recorded path, for a legacy record without a digest;
 *   4. `unverified` when the row recorded a source at all, else `unconfirmed`.
 * A row is never attributed by title, position or a path guess; `unverified` and
 * `unconfirmed` stay their own groups precisely so nothing is invented.
 * @param {object} row - one `/tasks` row.
 * @param {Map<string, string>} nodeProjects - projected node id → project key.
 * @returns {string} project key.
 */
function projectKeyOfRow(row, nodeProjects) {
  const taskId = typeof row?.taskId === 'string' ? row.taskId : '';
  if (taskId !== '' && nodeProjects instanceof Map) {
    const projected = nodeProjects.get(taskId);
    if (typeof projected === 'string' && projected !== '') return projected;
  }
  if (typeof row?.projectKey === 'string' && row.projectKey !== '') return row.projectKey;
  const digest = typeof row?.sourcePathDigest === 'string' ? row.sourcePathDigest.trim() : '';
  if (digest !== '') return digest;
  const sourcePath = typeof row?.sourcePath === 'string' ? row.sourcePath.trim() : '';
  if (sourcePath !== '') return `path:${sourcePath.replace(/[\\/]+$/u, '')}`;
  return 'unconfirmed';
}

/**
 * Where the archived rows came from, in operator words.
 * @param {object} snapshot - page store snapshot.
 * @returns {string | null} a short reason, or null when there is nothing to explain.
 */
export function archivedSourceNote(snapshot) {
  const total = navViewModel(snapshot).archivedCount;
  if (total === 0) return null;
  return snapshot?.tree !== null && snapshot?.tree !== undefined
    ? '这些记录带 TaskBridge 的归档标记（displayArchived）。这里只是把它们单独列出，DSH 的归档状态没有改变。从历史恢复出来的记录不算归档，仍在上方的列表里。'
    : '宿主没有返回任务树，已归档标记无法核实；这里只按记录自身的归档状态列出。';
}

/**
 * The human-readable label of one project group, when the host did not name it.
 * @param {string} key - host project key.
 * @returns {string} label.
 */
export function projectLabel(key) {
  if (key === 'unverified') return '来源未确认的记录';
  if (key === 'unconfirmed') return '没有项目信息的记录';
  if (key.startsWith('path:')) {
    const parts = key.slice(5).split(/[\\/]+/u).filter(Boolean);
    return parts.slice(-2).join('/') || key;
  }
  if (key.startsWith('sha256:')) return `项目 ${key.slice(-6)}`;
  return key.length <= 28 ? key : `${key.slice(0, 24)}…`;
}

/**
 * A group's title: the host's own project name first, then the key itself.
 * @param {object} group - one `navViewModel` group.
 * @param {Map} meta - the view's project metadata.
 * @returns {string} title.
 */
export function groupTitle(group, meta) {
  const info = meta instanceof Map ? meta.get(group.key) : null;
  if (typeof info?.name === 'string' && info.name !== '') {
    return info.shortPath !== null && info.shortPath !== undefined && info.shortPath !== info.name
      ? `${info.name}（${info.shortPath}）`
      : info.name;
  }
  return projectLabel(group.key);
}

// ---------------------------------------------------------------------------
// Navigation through DSH's own Workspace service
// ---------------------------------------------------------------------------

/**
 * Open one recorded session in DSH, if and only if the host can vouch for it.
 *
 * The order is deliberate: VERIFY, then call `openSession` EXACTLY ONCE. A plugin that
 * opened first and apologised later could move the operator into another
 * conversation, and a retry loop around `openSession` could open it twice.
 *
 * Every refusal is stated, and none of them is a navigation attempt:
 *   * no `uiWorkspace`        → the host cannot navigate at all;
 *   * no recorded id          → nothing to open;
 *   * snapshot not ready      → "retry later", because nothing is verified yet;
 *   * id in `archivedSessionIds` → DSH archived it; only DSH can bring it back;
 *   * id absent from a ready snapshot → refused explicitly, not opened on faith;
 *   * no `workspaces` service → DSH cannot verify it, so it does not open it.
 * @param {object | null} uiWorkspace - `ctx.get('uiWorkspace')`, or null.
 * @param {string | null} sessionId - the host-recorded session id.
 * @param {object | null} workspaces - the host `workspaces` service (its own source).
 * @returns {Promise<{ ok: boolean, message: string }>} outcome with readable copy.
 */
export async function locateSession(uiWorkspace, sessionId, workspaces = null) {
  if (uiWorkspace === null || uiWorkspace === undefined || typeof uiWorkspace.openSession !== 'function') {
    return { ok: false, message: '当前宿主没有提供会话定位能力（uiWorkspace），只显示记录，不跳转。' };
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, message: '这条记录没有可核实的会话标识，无法定位到原生会话。' };
  }
  const placement = sessionPlacement(sessionId, workspaces);
  const short = shortSessionId(sessionId);
  if (placement.state === 'pending') {
    return { ok: false, message: 'DSH 的会话列表还没准备好，请稍后重试。' };
  }
  if (placement.state === 'archived') {
    return { ok: false, message: `会话 ${short} 已在 DSH 中归档，请到 DSH 的归档里打开。` };
  }
  if (placement.state === 'missing') {
    return { ok: false, message: `DSH 当前的会话列表里没有 ${short}，不打开它。` };
  }
  if (placement.state === 'unknown') {
    // No verification is possible on this host, so the plugin does not guess at an
    // identity it cannot check. This is the documented degradation, stated plainly.
    return { ok: false, message: '当前宿主没有提供会话列表（workspaces），无法核实这条记录，未跳转。' };
  }
  try {
    const result = uiWorkspace.openSession(sessionId);
    if (result !== null && typeof result?.then === 'function') await result;
  } catch (error) {
    const detail = typeof error?.message === 'string' && error.message !== '' ? error.message : '';
    return { ok: false, message: `定位会话失败：${detail === '' ? '宿主没有接受这次定位' : detail.slice(0, 160)}` };
  }
  return { ok: true, message: `已在 DSH 中定位会话 ${short}。` };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * Decorative icon rendered inside the host’s sidebar button.
 *
 * Decorative on purpose: the row in `sidebar.panellist` carries the label, so the
 * icon is hidden from assistive technology rather than announcing the entry twice.
 * @returns {object} an inline SVG.
 */
export function TaskbridgeSidebarIcon({ size = 16 } = {}) {
  return (
    <svg
      className="dshdg-nav-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-dshdg-nav-icon=""
    >
      <path d="M2.5 4.2h4.2l1.2 1.4h5.6v6.6a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1z" />
      <path d="M5.4 9.1l1.5 1.5 2.7-2.9" />
    </svg>
  );
}

/** One session row. */
function SessionRow({ entry, onLocate, locating }) {
  const verified = typeof entry.sessionId === 'string' && entry.sessionId !== '';
  return (
    <li className="dshdg-nav-session" data-dshdg-nav-session={entry.taskId}>
      <span className="dshdg-nav-session-title" title={entry.title}>{entry.title}</span>
      <span className={`dshdg-badge dshdg-badge-${entry.status.tone}`}>{entry.status.label}</span>
      <span className="dshdg-spacer" />
      {verified ? (
        <span className="dshdg-faint dshdg-mono" title={entry.sessionId}>{shortSessionId(entry.sessionId)}</span>
      ) : (
        <span className="dshdg-faint" data-dshdg-nav-unverified="">无原生会话标识</span>
      )}
      <button
        type="button"
        data-dshdg-nav-locate={entry.taskId}
        disabled={!verified || locating}
        title={verified ? '在 DSH 中打开这条记录对应的原生会话' : '这条历史记录没有记录会话标识，无法定位'}
        onClick={() => { void onLocate(entry); }}
      >
        定位
      </button>
    </li>
  );
}

/** One project group, collapsible. */
function ProjectGroup({ group, meta, open, onToggle, onLocate, locating }) {
  const key = group.key;
  const title = groupTitle(group, meta);
  const controlId = `dshdg-nav-body-${key}`;
  const unverified = key === 'unverified';
  return (
    <li className="dshdg-nav-project" data-dshdg-nav-project={key}>
      <div className="dshdg-nav-project-head">
        <button
          type="button"
          className="dshdg-tree-toggle"
          data-dshdg-nav-toggle={key}
          aria-expanded={open}
          aria-controls={controlId}
          onClick={() => onToggle(key)}
        >
          {open ? '收起' : '展开'}
        </button>
        <span className="dshdg-nav-project-title" title={key}>{title}</span>
        {unverified ? <span className="dshdg-badge dshdg-badge-warn">来源未确认</span> : null}
        <span className="dshdg-spacer" />
        <span className="dshdg-faint">{`${group.sessions.length} 个会话`}</span>
      </div>
      {open ? (
        <ul id={controlId} className="dshdg-nav-sessions" role="group" aria-label={`${title} 的会话`}>
          {group.sessions.map((entry) => (
            <SessionRow key={entry.taskId} entry={entry} onLocate={onLocate} locating={locating} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The panel registered in `sidebar.panellist`.
 *
 * Its clock is the page store it is handed (`inject` face). Opening the panel does
 * not read anything on its own beyond that store's own subscription; the explicit
 * refresh button is the only thing here that asks the host for a list.
 *
 * A panel rendered without a store (a host that hands the slot no props) says so
 * instead of throwing, so a slot-shape change can never take the shell down.
 * @param {object} props - `store`, `uiWorkspace`, `workspaces`.
 * @returns {object} the panel.
 */
export function TaskbridgeNavPanel(props) {
  const store = props?.store ?? null;
  const uiWorkspace = props?.uiWorkspace ?? null;
  const workspaces = props?.workspaces ?? null;
  const [showArchived, setShowArchived] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [locating, setLocating] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const requested = useRef(false);

  const subscribe = useCallback(
    (listener) => (typeof store?.subscribe === 'function' ? store.subscribe(listener) : () => {}),
    [store],
  );
  // `useSyncExternalStore` requires getSnapshot to be REFERENTIALLY stable between
  // renders while nothing changed: a new object per call re-renders forever. The page
  // store returns its own state object (stable), so the identity is reused as-is; a
  // store-less panel returns the module's frozen empty snapshot; anything else that
  // hands back a fresh object is cached until its `revision` moves.
  const stable = useRef({ raw: EMPTY_SNAPSHOT, value: EMPTY_SNAPSHOT, revision: null });
  const getSnapshot = useCallback(() => {
    const raw = store === null ? EMPTY_SNAPSHOT : (typeof store?.getSnapshot === 'function' ? store.getSnapshot() : EMPTY_SNAPSHOT);
    const cache = stable.current;
    if (raw === cache.raw) return cache.value;
    // A store that already hands out stable objects (the page store does) is used
    // directly; a `revision` counter, when present, is the store's own promise that
    // an unchanged number means unchanged data.
    const revision = typeof raw?.revision === 'number' ? raw.revision : null;
    if (revision !== null && revision === cache.revision && cache.raw !== EMPTY_SNAPSHOT) {
      cache.raw = raw;
      return cache.value;
    }
    cache.raw = raw;
    cache.value = raw;
    cache.revision = revision;
    return raw;
  }, [store]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // The initial read happens in an EFFECT, never during render: writing to the store
  // while rendering would be a side effect on another component's state. It runs at
  // most once per panel instance, and only when the shared store holds no records yet
  // (the settings page, or a G07 refresh, may already have read them).
  useEffect(() => {
    if (requested.current) return;
    if (store === null || typeof store.loadTasks !== 'function') return;
    const loaded = Array.isArray(snapshot.tasks) && snapshot.tasks.length > 0;
    if (loaded) {
      requested.current = true;
      return;
    }
    requested.current = true;
    void Promise.resolve(store.loadTasks()).catch(() => {});
    // `snapshot.tasks` is read once at mount on purpose; later refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  const view = useMemo(() => navViewModel(snapshot), [snapshot]);
  const archivedNote = useMemo(() => archivedSourceNote(snapshot), [snapshot]);
  // Records exist but none of them is live: the empty line below must not claim the
  // host has no records at all.
  const liveEmpty = view.activeCount === 0 && view.archivedCount > 0;
  const onToggle = useCallback((key) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const onLocate = useCallback(async (entry) => {
    setLocating(true);
    try {
      // Resolved here, not at render: the host services may mount after the panel.
      const outcome = await locateSession(resolveService(uiWorkspace), entry.sessionId, resolveService(workspaces));
      setFeedback({ ok: outcome.ok, message: outcome.message });
    } finally {
      setLocating(false);
    }
  }, [uiWorkspace, workspaces]);
  const onRefresh = useCallback(() => { void Promise.resolve(store?.loadTasks?.()).catch(() => {}); }, [store]);

  return (
    <section className="dshdg-nav" aria-labelledby="dshdg-nav-title" data-dshdg-nav-panel="">
      <div className="dshdg-nav-head">
        <h3 id="dshdg-nav-title">{TASKS_NAV_LABEL}</h3>
        <span className="dshdg-spacer" />
        <button type="button" data-dshdg-nav-refresh="" onClick={onRefresh}>刷新</button>
      </div>
      <p className="dshdg-faint dshdg-nav-note">
        {`按项目列出 TaskBridge 的逻辑任务与它们的原生会话（${view.activeCount} 个会话${view.archivedCount > 0 ? `，另有 ${view.archivedCount} 条已归档` : ''}）。这里只读 TaskBridge 记录，不改名、不移动、不归档 DSH 会话。`}
      </p>
      {snapshot.tasksError !== null && snapshot.tasksError !== undefined ? (
        <p className="dshdg-warn" data-dshdg-nav-error="">任务记录这次没有读到；下方显示的是已有的内容。</p>
      ) : null}
      {view.total === 0 ? (
        <p className="dshdg-faint" data-dshdg-nav-empty="">还没有执行记录。</p>
      ) : (
        <ul className="dshdg-nav-projects">
          {liveEmpty ? (
            <li className="dshdg-faint" data-dshdg-nav-all-archived="">没有进行中的记录；已归档的记录在下方。</li>
          ) : null}
          {view.groups.map((group) => (
            <ProjectGroup
              key={group.key}
              group={group}
              meta={view.meta}
              open={!collapsed.has(group.key)}
              onToggle={onToggle}
              onLocate={onLocate}
              locating={locating}
            />
          ))}
        </ul>
      )}
      {view.archivedCount > 0 ? (
        <div className="dshdg-nav-archived">
          <label className="dshdg-nav-toggle-row">
            <input
              type="checkbox"
              data-dshdg-nav-archived-toggle=""
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            <span>{`显示 TaskBridge 已归档的记录（${view.archivedCount}）`}</span>
          </label>
          <p className="dshdg-faint">{archivedNote}</p>
          {showArchived ? (
            <ul className="dshdg-nav-projects">
              {view.archivedGroups.map((group) => (
                <li className="dshdg-nav-project" key={group.key} data-dshdg-nav-archived-project={group.key}>
                  <div className="dshdg-nav-project-head">
                    <span className="dshdg-nav-project-title" title={group.key}>{groupTitle(group, view.meta)}</span>
                    <span className="dshdg-faint">{`${group.sessions.length} 条已归档`}</span>
                  </div>
                  <ul className="dshdg-nav-sessions">
                    {group.sessions.map((entry) => (
                      <li className="dshdg-nav-session" key={entry.taskId} data-dshdg-nav-archived-session={entry.taskId}>
                        <span className="dshdg-nav-session-title" title={entry.title}>{entry.title}</span>
                        <span className={`dshdg-badge dshdg-badge-${entry.status.tone}`}>{entry.status.label}</span>
                        <span className="dshdg-faint">已归档</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {feedback === null ? null : (
        <p
          className={feedback.ok ? 'dshdg-hint' : 'dshdg-warn'}
          role="status"
          aria-live="polite"
          data-dshdg-nav-feedback={feedback.ok ? 'ok' : 'refused'}
        >
          {feedback.message}
        </p>
      )}
    </section>
  );
}

/** Stable empty snapshot, so a store-less panel never allocates per render. */
const EMPTY_SNAPSHOT = Object.freeze({ tasks: [], tree: null, tasksError: null });
