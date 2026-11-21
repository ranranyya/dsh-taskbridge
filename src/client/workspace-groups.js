// dsh-delegate — the model behind the TaskBridge section of the sidebar.
//
// WHAT THE TREE IS
// ----------------
// The requirement is one row per DISPATCHED CHAIN, not one row per source directory:
//
//     TaskBridge                      section   — collapsible, no native record
//     └─ 项目（真实 SOURCE）           project   — collapsible
//        └─ 任务工作区（该链的 Workspace） task workspace — collapsible
//           └─ 该任务的原生对话            conversation — real (workspaceId, sessionId)
//
// So two independent new dispatches in the same project are TWO task workspaces, side by side;
// a continuation keeps its parent's Workspace and Session and is therefore the SAME node with
// one conversation row (deduplicated), never a second one.
//
// The tree is derived from what the plugin can PROVE:
//
//   * the durable identity map (`/session-map` → `SessionStore`), read once per mount, and
//   * the task records the page already holds (`/tasks`), which name the chain of a run
//     (`continueFromTaskId`) and, for a dispatch the map has not written yet, its placement.
//
// Ownership is proof, never appearance: a conversation is the plugin's when the map (or its own
// record) names that exact (session, workspace) pair. A plain Workspace, an empty one, the
// managed worktree root, or a "mixed" one whose other conversations nobody recorded is NEVER
// claimed by this tree — the native browser below it already shows them, with their own names,
// order, menus and actions.
//
// This module is pure: no host call, no render, no clock. The same inputs always give the same
// tree, which is what makes it testable without a browser.

/** The plugin's own managed-worktree root directory name, below its data directory. */
const MANAGED_ROOT_SEGMENT = 'worktrees';

/** Sections this model can produce. */
export const GROUP_KINDS = Object.freeze({
  /** The TaskBridge container: projects nest inside it. */
  container: 'container',
  /** One real source project. */
  project: 'project',
});

/**
 * Canonical key of one directory, for grouping only.
 *
 * The same rule `sessionPathKey` applies (trim, strip trailing separators, fold case on Windows)
 * and deliberately not a richer normaliser: two spellings this folds together must be two
 * spellings the session layer treats as one directory, or the tree would merge two projects the
 * harness keeps apart.
 *
 * The platform is read through {@link clientPlatform}, never through `process` directly: a
 * browser bundle has no `process`, so reading it would silently disable the fold.
 * @param {unknown} value - candidate path.
 * @returns {string} canonical key, or '' when the value is not a usable path.
 */
export function sourcePathKey(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const stripped = trimmed.length > 1 ? trimmed.replace(/[\\/]+$/u, '') : trimmed;
  return clientPlatform() === 'win32' ? stripped.toLowerCase() : stripped;
}

/**
 * The platform string esbuild substitutes at build time (`--define`), as a NAMESPACED member
 * expression so the minifier cannot rename a local binding out of the substitution.
 */
export const CLIENT_PLATFORM = globalThis.__DSH_TASKBRIDGE_CLIENT_PLATFORM__;

/**
 * The platform this bundle runs on.
 * @returns {'win32' | 'posix'} the platform.
 */
function clientPlatform() {
  if (typeof CLIENT_PLATFORM === 'string' && CLIENT_PLATFORM !== '') {
    return CLIENT_PLATFORM === 'win32' ? 'win32' : 'posix';
  }
  return typeof process !== 'undefined' && process.platform === 'win32' ? 'win32' : 'posix';
}

/**
 * Whether a path is the plugin's registered managed-worktree root itself.
 * @param {unknown} path - Workspace path.
 * @returns {boolean} true when it is the managed root.
 */
export function isManagedRootPath(path) {
  if (typeof path !== 'string' || path.trim() === '') return false;
  const parts = path.trim().split(/[\\/]+/u).filter((part) => part !== '');
  return parts.length >= 3 && parts[parts.length - 1].toLowerCase() === MANAGED_ROOT_SEGMENT;
}

/**
 * A short, readable label for one path.
 * @param {string} path - directory path.
 * @returns {string} label (its last one or two segments).
 */
export function projectNameOf(path) {
  const parts = String(path ?? '').split(/[\\/]+/u).filter((part) => part !== '');
  if (parts.length === 0) return '未命名项目';
  if (parts.length === 1) return parts[0];
  return parts.slice(-2).join('/');
}

/**
 * Read the host Workspaces snapshot, or `null` when it cannot be read synchronously.
 * @param {object | null | undefined} workspaces - the host `workspaces` service.
 * @returns {object | null} snapshot.
 */
export function readWorkspacesSnapshot(workspaces) {
  const source = workspaces?.list;
  if (source === null || source === undefined || typeof source.getSnapshot !== 'function') return null;
  try {
    const snapshot = source.getSnapshot();
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    return snapshot;
  } catch {
    return null;
  }
}

/**
 * The host's Workspaces, normalized to the fields this model consumes.
 * @param {object | null} snapshot - `readWorkspacesSnapshot` result.
 * @returns {{ ready: boolean, items: object[], archivedSessionIds: string[], ungroupedSessionIds: string[] }} normalized view.
 */
export function workspaceItems(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') {
    return { ready: false, items: [], archivedSessionIds: [], ungroupedSessionIds: [] };
  }
  const archived = new Set((Array.isArray(snapshot.archivedSessionIds) ? snapshot.archivedSessionIds : [])
    .filter((id) => typeof id === 'string' && id !== ''));
  const items = [];
  const placed = new Set();
  for (const entry of Array.isArray(snapshot.items) ? snapshot.items : []) {
    if (entry === null || typeof entry !== 'object') continue;
    const workspaceId = typeof entry.workspaceId === 'string' ? entry.workspaceId : '';
    if (workspaceId === '') continue;
    const sessionIds = (Array.isArray(entry.sessionIds) ? entry.sessionIds : [])
      .filter((id) => typeof id === 'string' && id !== '');
    for (const id of sessionIds) placed.add(id);
    items.push({
      workspaceId,
      title: typeof entry.title === 'string' ? entry.title : '',
      path: typeof entry.path === 'string' ? entry.path : '',
      sessionIds,
    });
  }
  const ungrouped = [];
  for (const id of Array.isArray(snapshot.ungroupedSessionIds) ? snapshot.ungroupedSessionIds : []) {
    if (typeof id === 'string' && id !== '' && !placed.has(id) && !ungrouped.includes(id)) ungrouped.push(id);
  }
  return {
    ready: snapshot.phase === 'ready',
    items,
    archivedSessionIds: [...archived],
    ungroupedSessionIds: ungrouped,
  };
}

/**
 * The identity map, narrowed to what grouping needs. A row that cannot name both a Session and
 * a Workspace proves nothing, so it is dropped here as well as on the host.
 * @param {unknown} rows - `GET /session-map` `sessions` array.
 * @returns {object[]} usable rows.
 */
export function identityRows(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object') continue;
    const sessionId = typeof row.sessionId === 'string' ? row.sessionId.trim() : '';
    const workspaceId = typeof row.workspaceId === 'string' ? row.workspaceId.trim() : '';
    if (sessionId === '' || workspaceId === '') continue;
    out.push({
      taskId: typeof row.taskId === 'string' ? row.taskId.trim() : '',
      sessionId,
      workspaceId,
      sourcePath: typeof row.sourcePath === 'string' ? row.sourcePath.trim() : '',
      executionPath: typeof row.executionPath === 'string' ? row.executionPath.trim() : '',
      isolation: typeof row.isolation === 'string' ? row.isolation : null,
      updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
    });
  }
  return out;
}

/**
 * Task records indexed by the pair they prove, by task id, and by chain.
 *
 * Only a record that states BOTH a session and a workspace proves a placement; the rest are
 * display-only (a title). `chainOf` maps each task to the root of its continuation chain from
 * the records' own `continueFromTaskId` links, which is the identity the tree uses to keep one
 * task workspace per chain.
 * @param {object[]} tasks - `/tasks` rows.
 * @returns {{ titles, pairs, byTask, chainOf }} indexes.
 */
export function sessionIndex(tasks) {
  const titles = new Map();
  const pairs = new Map();
  const byTask = new Map();
  const parentOf = new Map();
  const taskIds = new Set();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task === null || typeof task !== 'object') continue;
    const taskId = typeof task.taskId === 'string' ? task.taskId.trim() : '';
    if (taskId !== '') taskIds.add(taskId);
    const parent = typeof task.continueFromTaskId === 'string' ? task.continueFromTaskId.trim() : '';
    if (taskId !== '' && parent !== '' && parent !== taskId) parentOf.set(taskId, parent);
    const sessionId = [task.sessionId, task.execution?.sessionId, task.conversation?.sessionId]
      .find((value) => typeof value === 'string' && value.trim() !== '');
    const workspaceId = [task.execution?.workspaceId, task.workspaceId, task.conversation?.workspaceId]
      .find((value) => typeof value === 'string' && value.trim() !== '');
    const title = typeof task.title === 'string' ? task.title.trim() : '';
    const sourcePath = [task.sourcePath, task.execution?.sourcePath, task.conversation?.sourcePath]
      .find((value) => typeof value === 'string' && value.trim() !== '');
    const session = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (session !== '' && typeof workspaceId === 'string' && workspaceId.trim() !== '') {
      const pair = {
        taskId,
        sessionId: session,
        workspaceId: workspaceId.trim(),
        sourcePath: typeof sourcePath === 'string' ? sourcePath.trim() : '',
        isolation: typeof task.isolation === 'string' ? task.isolation : null,
        // Records are the newest evidence available for a session the durable map has not
        // recorded yet.
        updatedAt: Number.isFinite(task.updatedAt) ? task.updatedAt : Number.MAX_SAFE_INTEGER,
        fromRecord: true,
      };
      const key = `${pair.workspaceId}\u0000${pair.sessionId}`;
      const previous = pairs.get(key);
      if (previous === undefined || pair.updatedAt >= previous.updatedAt) pairs.set(key, pair);
      if (taskId !== '') byTask.set(taskId, pair);
    }
    if (session !== '' && title !== '' && !titles.has(session)) titles.set(session, title);
  }
  const rootOf = (taskId) => {
    let current = taskId;
    const seen = new Set();
    while (parentOf.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parentOf.get(current);
    }
    return current;
  };
  const chainOf = new Map();
  for (const taskId of taskIds) chainOf.set(taskId, rootOf(taskId));
  return { titles, pairs, byTask, chainOf };
}

/**
 * Display titles for sessions, derived from the task records.
 * @param {object[]} tasks - `/tasks` rows.
 * @returns {Map<string, string>} session id → title.
 */
export function sessionTitles(tasks) {
  return sessionIndex(tasks).titles;
}

/**
 * Build the TaskBridge section.
 *
 * @param {object} input - `snapshot`, `identities`, `titles`, `tasks`.
 * @returns {{ ready, groups, standalone, ungrouped, archived, duplicates, ownCount,
 *   conversationCount, workspaceCount, mixedCount, standaloneCount }} the model.
 */
export function workspaceGroups(input = {}) {
  const host = workspaceItems(input.snapshot ?? null);
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const records = sessionIndex(tasks);
  const titles = input.titles instanceof Map ? input.titles : records.titles;

  // (Session, Workspace) → the newest proof. The durable map wins for a pair it names (it carries
  // the recorded source); a record fills a pair the map has not written yet.
  const byPair = new Map();
  for (const row of identityRows(input.identities)) {
    const key = `${row.workspaceId}\u0000${row.sessionId}`;
    const previous = byPair.get(key);
    if (previous === undefined || row.updatedAt >= previous.updatedAt) byPair.set(key, row);
  }
  for (const [key, pair] of records.pairs) {
    if (!byPair.has(key)) byPair.set(key, pair);
  }
  const bySession = new Map();
  for (const row of byPair.values()) {
    const previous = bySession.get(row.sessionId);
    if (previous === undefined || row.updatedAt > previous.updatedAt) bySession.set(row.sessionId, row);
  }

  /** Host Workspace by id, for a pair whose Workspace the snapshot may no longer list. */
  const hostById = new Map(host.items.map((item) => [item.workspaceId, item]));

  // ---- one node per (project, chain) ---------------------------------------
  // Keyed by project + chain root: two independent dispatches of one project are two nodes, and
  // every round of one chain is the same node.
  const nodes = new Map();
  /** Workspaces whose conversation set is fully explained by this plugin. */
  const fullyProven = new Set();
  for (const item of host.items) {
    const owned = item.sessionIds.filter((sessionId) => byPair.has(`${item.workspaceId}\u0000${sessionId}`));
    if (owned.length === 0) continue;
    if (owned.length === item.sessionIds.length && !isManagedRootPath(item.path)) fullyProven.add(item.workspaceId);
    if (isManagedRootPath(item.path) && owned.length > 0) fullyProven.add(item.workspaceId);
  }
  for (const item of host.items) {
    for (const sessionId of item.sessionIds) {
      const identity = byPair.get(`${item.workspaceId}\u0000${sessionId}`);
      if (identity === undefined) continue;
      const source = sourceOf(identity, item);
      const taskId = typeof identity.taskId === 'string' ? identity.taskId : '';
      // A pair the records do not index (a historical row) is its own chain: its task identity
      // is what the map recorded, and nothing joins it to another round.
      const chainId = (taskId !== '' && records.chainOf.get(taskId)) || (taskId !== '' ? taskId : `${source}\u0000${sessionId}`);
      const key = `${source}\u0000${chainId}`;
      if (!nodes.has(key)) {
        nodes.set(key, {
          key,
          chainId,
          source,
          projectName: projectNameOf(source),
          workspaceId: item.workspaceId,
          workspaceTitle: item.title !== '' ? item.title : projectNameOf(item.path),
          workspacePath: item.path,
          conversations: [],
        });
      }
      nodes.get(key).conversations.push(sessionRow(identity, titles, false));
    }
  }

  // ---- projects ------------------------------------------------------------
  const projects = new Map();
  for (const node of nodes.values()) {
    if (!projects.has(node.source)) {
      projects.set(node.source, {
        kind: GROUP_KINDS.project,
        key: node.source,
        name: node.projectName,
        path: node.source,
        workspaces: [],
        workspaceCount: 0,
        conversationCount: 0,
      });
    }
    const project = projects.get(node.source);
    project.workspaces.push({
      workspaceId: node.workspaceId,
      chainId: node.chainId,
      title: node.workspaceTitle,
      path: node.workspacePath,
      // A Workspace that holds a conversation nobody recorded is shown by the NATIVE browser
      // below; renaming or removing it as a whole would act on those conversations too.
      sharedWithOrdinary: !fullyProven.has(node.workspaceId),
      conversations: node.conversations
        .sort((left, right) => right.updatedAt - left.updatedAt),
    });
  }

  // One row per conversation across the whole section: a continuation keeps its parent's
  // Workspace AND Session, so this collapses it onto the node it already lives in.
  const seen = new Set();
  const duplicates = [];
  for (const project of projects.values()) {
    for (const workspace of project.workspaces) {
      const kept = [];
      for (const conversation of workspace.conversations) {
        if (seen.has(conversation.sessionId)) {
          duplicates.push({ sessionId: conversation.sessionId, workspaceId: workspace.workspaceId });
          continue;
        }
        seen.add(conversation.sessionId);
        kept.push(conversation);
      }
      workspace.conversations = kept;
    }
    // Stable order: task workspaces by their newest conversation, so the run just started is
    // the first row an operator sees.
    project.workspaces.sort((left, right) => {
      const leftAt = left.conversations[0]?.updatedAt ?? 0;
      const rightAt = right.conversations[0]?.updatedAt ?? 0;
      if (leftAt !== rightAt) return rightAt - leftAt;
      return left.workspaceId < right.workspaceId ? -1 : left.workspaceId > right.workspaceId ? 1 : 0;
    });
    project.workspaceCount = project.workspaces.length;
    project.conversationCount = project.workspaces.reduce((total, workspace) => total + workspace.conversations.length, 0);
  }

  const projectNodes = [...projects.values()].sort((left, right) => {
    const byName = String(left.name).localeCompare(String(right.name), 'zh-Hans-CN');
    return byName !== 0 ? byName : (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  });

  // The section exists only when it holds a project: an empty TaskBridge row above the native
  // browser would be a claim the identity map does not make.
  const groups = [];
  if (projectNodes.length > 0) {
    groups.push({
      kind: GROUP_KINDS.container,
      key: 'taskbridge',
      name: 'TaskBridge',
      workspaceId: null,
      projects: projectNodes,
      workspaceCount: projectNodes.reduce((total, project) => total + project.workspaceCount, 0),
      conversationCount: projectNodes.reduce((total, project) => total + project.conversationCount, 0),
    });
  }

  // ---- what the native browser keeps --------------------------------------
  // Reported for measurement and for tests. The native browser shows these itself; this section
  // never repeats them, and never hides one.
  const standalone = host.items
    .filter((item) => !fullyProven.has(item.workspaceId))
    .map((item) => ({ workspaceId: item.workspaceId, title: item.title, path: item.path }));

  const ungrouped = host.ungroupedSessionIds
    .filter((sessionId) => !seen.has(sessionId))
    .map((sessionId) => ({ sessionId, title: titles.get(sessionId) ?? '', owned: bySession.has(sessionId) }));
  for (const entry of ungrouped) seen.add(entry.sessionId);

  const archived = host.archivedSessionIds
    .map((sessionId) => ({ sessionId, identity: bySession.get(sessionId) ?? null }))
    .filter((entry) => entry.identity !== null)
    .filter((entry) => !seen.has(entry.sessionId))
    .map((entry) => ({
      sessionId: entry.sessionId,
      title: titles.get(entry.sessionId) ?? '',
      workspaceId: entry.identity.workspaceId,
      taskId: entry.identity.taskId !== '' ? entry.identity.taskId : null,
    }));
  for (const entry of archived) seen.add(entry.sessionId);

  return {
    ready: host.ready,
    groups,
    standalone,
    ungrouped,
    archived,
    duplicates,
    /** Dispatched conversations shown in the section (one row each). */
    conversationCount: projectNodes.reduce((total, project) => total + project.conversationCount, 0),
    /** Task workspaces shown in the section. */
    workspaceCount: projectNodes.reduce((total, project) => total + project.workspaceCount, 0),
    /** Native Workspaces whose conversations are all this plugin's. */
    ownCount: projectNodes.length > 0 ? projectNodes.reduce((total, project) => total + project.workspaceCount, 0) : 0,
    /** Native Workspaces the section does NOT claim (they also hold unrecorded conversations). */
    mixedCount: standalone.filter((entry) => hostById.has(entry.workspaceId) && byPair.size > 0
      && (hostById.get(entry.workspaceId)?.sessionIds ?? []).some((sessionId) => bySession.has(sessionId))).length,
    standaloneCount: standalone.length,
  };
}

/**
 * The real source project of one dispatched conversation: the recorded SOURCE path, else the
 * directory the run really worked in, else the Workspace's own path.
 * @param {object} identity - the proof row.
 * @param {object} item - the host Workspace it lives in.
 * @returns {string} canonical project key.
 */
function sourceOf(identity, item) {
  const source = sourcePathKey(identity.sourcePath);
  if (source !== '') return source;
  const execution = sourcePathKey(identity.executionPath);
  if (execution !== '') return execution;
  const fallback = sourcePathKey(item.path);
  return fallback === '' ? `workspace:${item.workspaceId}` : fallback;
}

/**
 * One conversation row.
 * @param {object} identity - the proof row (native ids included).
 * @param {Map<string, string>} titles - session titles.
 * @param {boolean} archived - whether DSH archived it.
 * @returns {object} conversation row.
 */
function sessionRow(identity, titles, archived) {
  return {
    sessionId: identity.sessionId,
    workspaceId: identity.workspaceId,
    taskId: typeof identity.taskId === 'string' && identity.taskId !== '' ? identity.taskId : null,
    title: titles.get(identity.sessionId) ?? (typeof identity.title === 'string' ? identity.title : ''),
    isolation: identity.isolation,
    updatedAt: identity.updatedAt,
    archived,
  };
}
