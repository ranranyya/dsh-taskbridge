// Type declarations for the dsh-delegate browser half (`lib/client.js`).
//
// `lib/client.js` is not an ordinary ES module: it is a *registration* for the DSH
// client's module table, produced by `scripts/build-client.mjs` from
// `src/client/index.jsx`:
//
//     window.__ModuleLoader__.load({ id: "dsh-taskbridge", factory: (require) => … })
//
// The factory returns `module.exports`, whose shape is declared here as
// {@link DelegateClientModule}. The bundle declares `dsh.client.platform: "web"`,
// which is the only platform `dsh-client-modules` in 0.2.x selects; Desktop and
// Web both run that client module system, so the same declaration serves both.
// Its module requests are limited to the platform table (`react`,
// `react/jsx-runtime`) — that is why no `dsh.client.external` entry is needed.
// Ordering against the Plugins manager comes from `dsh.client.inject`, whose row
// for this package must name `@deepseek-ai/dsh-client-ui-plugin-manager`.
//
// This file documents the contract for editors and type-aware tests; nothing
// imports it at runtime.

/**
 * The slot this page occupies: the Plugins manager's per-bundle configuration
 * slot (`kind: 'keyed'`, `scope: 'root'`), rendered only with `view: 'page'` on
 * the bundle's own details page.
 */
export declare const PLUGIN_CONFIG_SLOT: 'plugins.bundle.config';

/**
 * Key of the registration: exactly the bundle's npm package name. The manager
 * looks the entry up by `pkg.name`; any other key never renders.
 */
export declare const PLUGIN_BUNDLE_KEY: 'dsh-taskbridge';

/** Required client services: slot registration only. */
export declare const inject: readonly ['slots'];

// ---------------------------------------------------------------------------
// Native left navigation (G08)
// ---------------------------------------------------------------------------

/** The host shell slot that holds the sidebar's main entries (the icon). */
export declare const MAIN_SLOT: 'main';

/**
 * The host shell slot that lists the sidebar panels (the row). This registration adds only
 * the task entry; the shell's workspace region (`sidebar.workspaces`) is taken by a SEPARATE,
 * lower-priority registration ({@link registerWorkspacesBrowser}) that can fall back to DSH's
 * own browser. See `docs/workspace-grouping.md`.
 */
export declare const SIDEBAR_PANEL_SLOT: 'sidebar.panellist';

/** Shared id of the two registrations, namespaced against other sidebar plugins. */
export declare const TASKS_NAV_KEY: 'dsh-taskbridge:taskbridge-tasks';

/** Sort key of the row in `sidebar.panellist`. */
export declare const TASKS_NAV_ORDER: number;

/** Operator-facing label of the entry. */
export declare const TASKS_NAV_LABEL: 'TaskBridge 任务';

/**
 * The host's `uiWorkspace` service, or `null`. A host without it is the documented
 * degradation: the panel lists records and offers no navigation.
 */
export declare function resolveUiWorkspace(ctx: unknown): { openSession: (sessionId: string) => unknown } | null;

/**
 * The host's `workspaces` service, or `null`. Its `list` is the subscribable source
 * (`{ getSnapshot, subscribe }`) used to verify a recorded session id.
 */
export declare function resolveWorkspaces(ctx: unknown): unknown;

/** Resolve a service passed either as a value or as a lazy getter (or `null`). */
export declare function resolveService(value: unknown): object | null;

/**
 * Register the FULL CONTENT PANEL on `main` and the SMALL ICON on
 * `sidebar.panellist`, sharing one id.
 *
 * This is the host's own split (0.2.2-rc.5): `main` carries
 * `{ name: 'main', key }` with the page component, and `sidebar.panellist` carries
 * `{ name: 'sidebar.panellist', id, order, label }` with the icon component, where
 * `label` is a function.
 *
 * Both slots are optional host capabilities: a missing `slots` service or an
 * undeclared slot simply registers nothing, and the settings page is unaffected.
 * `store` is the SAME instance the settings page uses; `uiWorkspace`/`workspaces`
 * may be values or lazy getters, resolved each time they are used.
 */
export declare function registerTasksNavigation(
  ctx: unknown,
  options?: {
    store?: unknown;
    uiWorkspace?: unknown;
    workspaces?: unknown;
    registerPanel?: () => () => void;
    registerIcon?: () => () => void;
  },
): () => void;

/**
 * Where a recorded session id sits among the host's Workspaces:
 * `pending` (snapshot not ready), `present` (listed and not archived),
 * `archived` (in the host's `archivedSessionIds`), `missing` (a ready snapshot does
 * not list it), or `unknown` (no service at all).
 */
export type DelegateSessionPlacementState = 'unknown' | 'pending' | 'present' | 'archived' | 'missing';

/** The host's Workspaces snapshot, or `null` when it cannot be read synchronously. */
export declare function workspacesSnapshot(workspaces: unknown): {
  phase?: string;
  items?: Array<{ workspaceId?: string; sessionIds?: string[] }>;
  archivedSessionIds?: string[];
} | null;

/** Every session id a snapshot knows, mapped to its workspace id. */
export declare function knownSessionIds(snapshot: unknown): Map<string, string>;

/** Read one recorded session's placement from the host's `workspaces.list` snapshot. */
export declare function sessionPlacement(
  sessionId: string | null,
  workspaces: unknown,
): { state: DelegateSessionPlacementState; label: string | null; workspaceId: string | null };

/** The session id a `/tasks` row actually recorded, or `null`. */
export declare function taskSessionId(task: unknown): string | null;

/** Short, stable display form of a session id. */
export declare function shortSessionId(sessionId: string | null): string;

/** One project group the navigation panel draws. */
export interface DelegateNavGroup {
  /** Host project key; two same-named projects stay two groups. */
  key: string;
  sessions: Array<{
    taskId: string;
    title: string;
    sessionId: string | null;
    status: { key: string; label: string; tone: string };
    archived: boolean;
  }>;
}

/** The navigation panel's model, projected from the page store and the host tree. */
export interface DelegateNavView {
  groups: DelegateNavGroup[];
  archivedGroups: DelegateNavGroup[];
  activeCount: number;
  archivedCount: number;
  total: number;
  available: boolean;
  meta: Map<string, { name: string | null; shortPath: string | null; unverified: boolean; nodeCount: number }>;
}

/** Project the store snapshot and the host's tree onto the panel's model. */
export declare function navViewModel(snapshot: unknown): DelegateNavView;

/** Fallback label of a project key the host did not name. */
export declare function projectLabel(key: string): string;

/** A group's title: the host's project name, else the key's fallback label. */
export declare function groupTitle(group: DelegateNavGroup, meta: Map<string, unknown>): string;

/** Why archived rows are listed separately (or `null` when none are). */
export declare function archivedSourceNote(snapshot: unknown): string | null;

/**
 * Open one recorded session through the host's own `uiWorkspace.openSession`.
 *
 * Verification comes first and `openSession` is called at most ONCE. Refused (with
 * readable copy, and without navigating) when: there is no `uiWorkspace`; the record
 * has no id; the snapshot is not ready; the id is in the host's
 * `archivedSessionIds`; a ready snapshot does not list it; or there is no
 * `workspaces` service to verify it against. Never renames, moves or archives.
 */
export declare function locateSession(
  uiWorkspace: unknown,
  sessionId: string | null,
  workspaces?: unknown,
): Promise<{ ok: boolean; message: string }>;

/** The small sidebar ICON registered on `sidebar.panellist`. */
export declare function TaskbridgeSidebarIcon(): unknown;

/**
 * The FULL CONTENT PANEL registered on `main`; receives
 * `{ store, uiWorkspace, workspaces }`, where the last two may be lazy getters.
 */
export declare function TaskbridgeNavPanel(props: Record<string, unknown>): unknown;

// ---------------------------------------------------------------------------
// Grouped workspaces (the shell's `sidebar.workspaces` cell)
// ---------------------------------------------------------------------------

/** The host slot the grouped workspaces browser occupies. */
export declare const WORKSPACES_SLOT: 'sidebar.workspaces';

/**
 * The host's published CHILD slot of its workspace browser: a list rendered INSIDE every native
 * session row. This is the only thing this plugin registers in the sidebar's workspace area; the
 * parent slot stays the host's, so native rows, names, order, search and menus are untouched.
 */
export declare const SESSION_ROW_ACTION_SLOT: 'sidebar.workspaces.session.row.action';

/** The id of this plugin's row-action registration, namespaced against other plugins. */
export declare const SESSION_ROW_ACTION_ID: string;

/** Its order: after the host's own row actions (the host uses 100 and 200). */
export declare const SESSION_ROW_ACTION_ORDER: number;

/** @deprecated The plugin no longer registers on `sidebar.workspaces`. */
export declare const WORKSPACES_PRIORITY: number;

/** How the plugin's own grouping presents itself. */
export declare const WORKSPACE_VIEWS: Readonly<{
  grouped: 'grouped';
  passthrough: 'passthrough';
}>;

/** Sections the grouping model can produce. */
export declare const GROUP_KINDS: Readonly<{ container: 'container'; project: 'project' }>;

/** One identity row as `GET /api/dsh-delegate/session-map` publishes it. */
export interface DelegateSessionIdentity {
  taskId: string;
  sessionId: string;
  workspaceId: string;
  sourcePath: string;
  executionPath: string;
  isolation: string | null;
  updatedAt: number;
}

/** One conversation of a task workspace (level 3 of the tree): a real (workspace, session) pair. */
export interface DelegateGroupedSession {
  sessionId: string;
  /** The native Workspace it really lives in; every action on this row addresses this pair. */
  workspaceId: string;
  taskId: string | null;
  title: string;
  isolation: string | null;
  updatedAt: number;
  archived: boolean;
}

/**
 * One TASK WORKSPACE (level 2): the native Workspace one dispatched chain lives in.
 *
 * Two chains of one project can share one native Workspace, so a project can hold two nodes with
 * the same `workspaceId`; the row's identity is `chainId`.
 */
export interface DelegateGroupedWorkspace {
  workspaceId: string;
  /** The continuation chain this node stands for (its root task id, or a pair-derived key). */
  chainId: string;
  title: string;
  /** The real execution path; a display node names the native record, it never impersonates it. */
  path: string;
  /**
   * The Workspace also holds conversations this plugin cannot vouch for, so renaming or removing
   * it as a whole would act on them: both operations are refused.
   */
  sharedWithOrdinary: boolean;
  conversations: DelegateGroupedSession[];
}

/** One node of the tree: the TaskBridge container or one real source project. */
export interface DelegateWorkspaceGroup {
  kind: 'container' | 'project';
  key: string;
  name: string;
  path: string;
  workspaceCount: number;
  conversationCount: number;
  /** Projects of the container. */
  projects?: DelegateWorkspaceGroup[];
  /** A project's task workspaces (one per dispatched chain). */
  workspaces?: DelegateGroupedWorkspace[];
}

/** The TaskBridge section view model. */
export interface DelegateWorkspacesView {
  ready: boolean;
  groups: DelegateWorkspaceGroup[];
  /** Native Workspaces the section does NOT claim; the native browser shows them itself. */
  standalone: Array<{ workspaceId: string; title: string; path: string }>;
  ungrouped: Array<{ sessionId: string; title: string; owned: boolean }>;
  archived: Array<{ sessionId: string; title: string; workspaceId: string; taskId: string | null }>;
  duplicates: Array<{ sessionId: string; workspaceId: string }>;
  /** Task workspaces shown in the section. */
  ownCount: number;
  conversationCount: number;
  workspaceCount: number;
  /** Native Workspaces the section leaves to the browser because they also hold other ones. */
  mixedCount: number;
  standaloneCount: number;
}

/** Canonical key of one directory, folded exactly as `sessionPathKey` folds it. */
export declare function sourcePathKey(value: unknown): string;

/** Whether a path is the plugin's registered managed-worktree root. */
export declare function isManagedRootPath(path: unknown): boolean;

/** Short label of one path node (its last one or two segments). */
export declare function projectNameOf(path: unknown): string;

/** The host's Workspaces snapshot, or `null` when it cannot be read synchronously. */
export declare function readWorkspacesSnapshot(workspaces: unknown): unknown;

/** The snapshot normalized to the fields the model consumes. */
export declare function workspaceItems(snapshot: unknown): {
  ready: boolean;
  items: Array<{ workspaceId: string; title: string; path: string; sessionIds: string[]; pinned: boolean }>;
  archivedSessionIds: string[];
  ungroupedSessionIds: string[];
};

/** Identity rows narrowed to rows that name both a Session and a Workspace. */
export declare function identityRows(rows: unknown): DelegateSessionIdentity[];

/** Session titles derived from `/tasks` rows (id stated by the record, never inferred). */
export declare function sessionTitles(tasks: unknown): Map<string, string>;

/** Task records indexed by the session/workspace pair they prove, plus their titles. */
export declare function sessionIndex(tasks: unknown): {
  titles: Map<string, string>;
  pairs: Map<string, DelegateSessionIdentity>;
  byTask: Map<string, DelegateSessionIdentity>;
  /** Task id → the root task of its continuation chain. */
  chainOf: Map<string, string>;
};

/** Build the TaskBridge section from the host snapshot, the identity map and task records. */
export declare function workspaceGroups(input: {
  snapshot?: unknown;
  identities?: unknown;
  titles?: Map<string, string>;
  tasks?: unknown;
}): DelegateWorkspacesView;

/** Which presentation the plugin's own grouping calls for. */
export declare function workspacesViewMode(input: {
  ownCount?: number;
}): 'grouped' | 'passthrough';

/** Read the identity map from the operator plane; a refusal answers an empty list. */
export declare function loadSessionMap(api: { getSessionMap: () => Promise<unknown> }): Promise<object[]>;

/** Resolve one optional host service through `ctx.get`, or `null`. */
export declare function hostService(ctx: unknown, name: string): object | null;

/** Ask the operator for one line of text (the shell's dialog), or `null`. */
export declare function askText(message: string, initial: string, shell?: unknown): string | null;

/** Ask the operator to confirm a destructive action; an absent dialog answers NO. */
export declare function askConfirm(message: string, shell?: unknown): boolean;

/** Short display form of a session id. */
export declare function shortId(sessionId: unknown): string;

/** A host snapshot reused while its data is unchanged (safe for `useSyncExternalStore`). */
export declare function stableSnapshot(snapshot: unknown, cache?: { key: string | null; value: object | null }): object | null;

/** Session id → what proves it is a TaskBridge dispatch (identity row or record, plus its title). */
export declare function dispatchProof(identities: unknown, tasks: unknown): {
  bySession: Map<string, DelegateSessionIdentity & { title?: string }>;
  ready: boolean;
};

/**
 * Register the per-session marker into the host's published child slot
 * ({@link SESSION_ROW_ACTION_SLOT}). The parent slot is never registered: the native workspace
 * rows, names, order, search, menus and actions stay exactly as the host renders them.
 */
export declare function registerSessionRowMarker(
  ctx: unknown,
  options?: { store?: unknown; api?: unknown; sessionMap?: () => Promise<unknown> },
): () => void;

/** The marker rendered inside one native session row (`sessionId` comes from the host). */
export declare function DispatchedSessionMarker(props: Record<string, unknown>): unknown;

/** The plugin's own grouping surface: TaskBridge → task workspace → conversation. */
export declare function TaskbridgeGrouping(props: Record<string, unknown>): unknown;

/** @deprecated Kept so an older import resolves; the plugin registers no such entry. */
export declare function registerWorkspacesBrowser(...args: unknown[]): () => void;

/** Options accepted by {@link registerBundleConfiguration}. */
export interface DelegateBundleConfigOptions {
  /** Page store; the component subscribes to it itself. */
  store: unknown;
}

/**
 * Register the bundle configuration page on a client context.
 * @param ctx - client context exposing `slots`.
 * @param options - the page store.
 * @returns the slot disposer.
 */
export declare function registerBundleConfiguration(
  ctx: unknown,
  options: DelegateBundleConfigOptions,
): () => void;

/**
 * Client plugin apply hook: injects the scoped stylesheet and registers one
 * `plugins.bundle.config` entry, and nothing else. It never registers a
 * `settings.section`, and it never dispatches a task.
 * @param ctx - client Cordis context.
 */
export declare function apply(ctx: unknown): void;

/**
 * React component that renders the whole configuration page. It receives the
 * registration's `inject` face (`{ store }`) plus the slot owner props
 * (`{ view: 'page', form? }`), and deliberately ignores `form`.
 */
export declare function DelegateConfigPage(props: Record<string, unknown>): unknown;

/** Re-exported client helpers that the page and the tests both use. */
export declare const documentFromDraft: (...args: unknown[]) => unknown;
export declare const describeError: (...args: unknown[]) => string;
export declare const exportDocument: (...args: unknown[]) => unknown;

/**
 * The plan-creation form state, as one editable batch plus the batch's parent.
 *
 * `parent` on a row is `''` (root), `'row:<n>'` (another row of the same batch, by
 * position) or a real plan `nodeId` the host returned. There is no title-based
 * parent, by construction.
 */
export interface DelegatePlanCreateRow {
  title: string;
  goalDescription?: string;
  parent?: string;
}

/** Draft the plan-creation form holds. */
export interface DelegatePlanCreateDraft {
  title?: string;
  goal?: string;
  parentNodeId?: string;
  workspacePath?: string;
  rows?: DelegatePlanCreateRow[];
}

/**
 * The request body `POST /api/dsh-delegate/plans` takes. It names no connection:
 * the host always writes for the fixed local caller and refuses a body that tries.
 */
export interface DelegatePlanCreateRequest {
  nodes: Array<{
    key: string;
    title: string;
    goalDescription?: string;
    parentKey?: string;
    parentNodeId?: string;
  }>;
  parentNodeId?: string;
  workspacePath?: string;
}

/**
 * Project the form draft onto the create request.
 * @returns the request body plus the local precheck problems (empty when valid).
 */
export declare function planCreateRequest(
  draft: DelegatePlanCreateDraft,
): { body: DelegatePlanCreateRequest; problems: string[] };

/**
 * Actions the Codex panel may send. `status` is absent on purpose: the page reads
 * that state through a `GET`, so only a real change is ever a `POST`.
 */
export declare const CODEX_ACTIONS: readonly ['install', 'repair', 'remove'];

/** The user-plane paths the integration panels use (`GET` diagnoses, `POST` acts). */
export declare const ROUTES: Readonly<Record<string, string>> & {
  codex: '/api/dsh-delegate/codex';
  antigravity: '/api/dsh-delegate/antigravity';
};

/**
 * One target's presentation state: agent file, MCP entry or DSH switch.
 *
 * The three are reported separately because they are independent: an installed
 * agent does not imply a configured MCP entry, and neither implies that the DSH
 * local-call switch is on.
 */
export interface DelegateCodexTargetView {
  key: 'agent' | 'mcp' | 'switch';
  label: string;
  state: string;
  tone: 'on' | 'off' | 'warn';
  detail: string;
  path?: string;
  paths?: string[];
}

/** Map a served Codex status document onto one target's presentation state. */
export declare function codexTargetView(
  codex: unknown,
  switchState: unknown,
  target: 'agent' | 'mcp' | 'switch',
): DelegateCodexTargetView;

/** Chinese one-line summary of an action outcome (`changed` / `refused`). */
export declare function describeCodexOutcome(outcome: unknown): string;

/** Actions the Antigravity panel may send (`status` is always `GET`). */
export declare const ANTIGRAVITY_ACTIONS: readonly ['install', 'repair', 'remove'];

/** One Antigravity target's presentation state: plugin bundle, MCP config or DSH switch. */
export interface DelegateAntigravityTargetView {
  key: 'plugin' | 'mcp' | 'switch';
  label: string;
  state: string;
  tone: 'on' | 'off' | 'warn';
  detail: string;
  path?: string;
  paths?: string[];
}

/** Map a served Antigravity status document onto one target's presentation state. */
export declare function antigravityTargetView(
  antigravity: unknown,
  switchState: unknown,
  target: 'plugin' | 'mcp' | 'switch',
): DelegateAntigravityTargetView;

/** Chinese one-line summary of an Antigravity action outcome (`changed` / `refused`). */
export declare function describeAntigravityOutcome(outcome: unknown): string;

/**
 * One execution chain as the cleanup surface sees it.
 *
 * `selectable` is the host's own verdict plus the exact-rounds check made in the page;
 * `blockers` carries the host's stable codes and is what a disabled checkbox explains.
 */
export interface DelegateCleanupCandidate {
  chainId: string;
  taskIds: string[];
  roundCount: number;
  title: string;
  planNodeId: string | null;
  parentNodeId: string | null;
  nodeId: string | null;
  nodeKind: string;
  /**
   * The host's status for the chain (`accepted`, `failed`, `cancelled`, …), or `null`
   * when the projection stated none. It is what the preset shortcuts read; the page
   * never derives it from a title or a time.
   */
  nodeStatus?: string | null;
  /**
   * The chain's isolation (`worktree` or `shared`), when the projection stated one.
   * It is descriptive only: the browser half never decides what may be deleted from it.
   */
  isolation?: string | null;
  selectable: boolean;
  blockers: string[];
  reason: string | null;
}

/** One chain of a cleanup request: its identity and its exact rounds. */
export interface DelegateCleanupChain {
  chainId: string;
  taskIds: string[];
}

/** What the confirmation shows before anything is sent. */
export interface DelegateCleanupSummary {
  chains: number;
  rounds: number;
  empty: boolean;
  executable: boolean;
  problems: string[];
}

/** Once one request may name. Mirrors `MAX_CLEANUP_CHAINS` on the host. */
export declare const MAX_CLEANUP_CHAINS: number;

/** Chinese label for one cleanup blocker code. */
export declare function cleanupBlockerLabel(code: string): string;

/** Every execution chain of a rendered tree, in pre-order, with its eligibility. */
export declare function cleanupCandidates(view: unknown): DelegateCleanupCandidate[];

/** Chain id -> the rounds that were selected; anything stale is disabled. */
export declare function withSelectionState(
  candidate: DelegateCleanupCandidate,
  selectedTaskIds: string[],
): DelegateCleanupCandidate;

/** Drop selections that no longer name a selectable chain of the current tree. */
export declare function pruneCleanupSelection(
  selection: Record<string, string[]>,
  candidates: DelegateCleanupCandidate[],
): { selection: Record<string, string[]>; dropped: string[] };

/** Toggle one chain in a selection (a new object; the input is not mutated). */
export declare function toggleCleanupSelection(
  selection: Record<string, string[]>,
  candidate: DelegateCleanupCandidate,
): Record<string, string[]>;

/** Chain/round counts and any problem that blocks the confirmation. */
export declare function cleanupSelectionSummary(
  selection: Record<string, string[]>,
  candidates: DelegateCleanupCandidate[],
): DelegateCleanupSummary;

/** Project a selection onto the exact request body the host accepts. */
export declare function cleanupRequest(
  selection: Record<string, string[]>,
  candidates: DelegateCleanupCandidate[],
  options?: DelegateCleanupOptions,
): { body: DelegateCleanupRequest; problems: string[] };

/**
 * The linked cleanup choices of one batch. Each flag is independently opt-in and is
 * absent from the request body unless it is `true`; the host treats an absent flag as
 * "leave that alone".
 *
 * - `archiveSessions` archives the dispatched DSH conversation of each removed round.
 * - `removeWorktrees` removes a `worktree`-isolated task's managed tree and its
 *   temporary Workspace; a `shared` task's directory and the source checkout are
 *   never touched.
 * - `cleanPlans` removes planning nodes that no remaining task still references.
 */
export interface DelegateCleanupOptions {
  archiveSessions?: boolean;
  removeWorktrees?: boolean;
  cleanPlans?: boolean;
}

/** The request body of `POST /api/dsh-delegate/tasks/cleanup`. */
export interface DelegateCleanupRequest {
  chains: DelegateCleanupChain[];
  archiveSessions?: true;
  removeWorktrees?: true;
  cleanPlans?: true;
}

/** Which status group one preset shortcut selects. */
export declare const CLEANUP_PRESETS: readonly ['all', 'accepted', 'failed-cancelled'];

/**
 * Batch-select the selectable chains matching a preset, optionally restricted to the
 * chain ids currently visible under the page's own filters.
 * @param candidates - current candidates.
 * @param preset - `all`, `accepted` (chains the host accepted) or `failed-cancelled`.
 * @param visibleChainIds - optional set/array of chain ids the filter leaves visible.
 * @returns the selection map, bounded to `MAX_CLEANUP_CHAINS`.
 */
export declare function selectCleanupCandidatesByPreset(
  candidates: DelegateCleanupCandidate[],
  preset?: 'all' | 'accepted' | 'failed-cancelled',
  visibleChainIds?: Set<string> | string[] | null,
): Record<string, string[]>;

/**
 * The confirmation sentence drawn above the confirm button, before anything is sent.
 * @param summary - the selection's chain/round counts.
 * @param options - the linked cleanup choices currently ticked.
 */
export declare function cleanupConfirmText(
  summary: { chains: number; rounds: number },
  options?: DelegateCleanupOptions,
): string;

/** Plain-Chinese description of one completed orphan worktree/session sweep. */
export declare function describeOrphanCleanupOutcome(outcome: unknown): string;

/** Stable fingerprint of a selection, for change detection across refreshes. */
export declare function cleanupSelectionKey(
  candidates: DelegateCleanupCandidate[],
  selection: Record<string, string[]>,
): string;

/** The removed ids and counts of a completed cleanup. */
export declare function cleanupOutcome(outcome: unknown): {
  chains: number;
  rounds: number;
  deletedTaskIds: string[];
};

/** Plain-Chinese description of one completed cleanup. */
export declare function describeCleanupOutcome(outcome: unknown): string;

/** The irreversible-action warning shown beside the confirm button. */
export declare function cleanupWarningText(): string;

/**
 * The operator's execution-choice block, normalized for display.
 *
 * A document (or a host) that predates the block opens at the OFF default, so an
 * upgraded installation never presents agent collaboration as already decided on.
 */
export declare function executionOf(
  source: unknown,
): { agentTeamsDefault: boolean | unknown };

/** The documented default a NEW task gets when nothing else decides. */
export declare const AGENT_TEAMS_DEFAULT_FOR_NEW_TASKS: false;

/** Where a task's frozen Agent Teams decision came from. */
export declare const AGENT_TEAMS_ORIGIN_LABELS: Readonly<{
  request: string;
  continuation: string;
  'settings-default': string;
}>;

/** Shape the registration factory returns as `module.exports`. */
export interface DelegateClientModule {
  PLUGIN_CONFIG_SLOT: typeof PLUGIN_CONFIG_SLOT;
  PLUGIN_BUNDLE_KEY: typeof PLUGIN_BUNDLE_KEY;
  inject: typeof inject;
  registerBundleConfiguration: typeof registerBundleConfiguration;
  apply: typeof apply;
  DelegateConfigPage: typeof DelegateConfigPage;
  documentFromDraft: typeof documentFromDraft;
  describeError: typeof describeError;
  exportDocument: typeof exportDocument;
  ROUTES: typeof ROUTES;
  CODEX_ACTIONS: typeof CODEX_ACTIONS;
  codexTargetView: typeof codexTargetView;
  describeCodexOutcome: typeof describeCodexOutcome;
  ANTIGRAVITY_ACTIONS: typeof ANTIGRAVITY_ACTIONS;
  antigravityTargetView: typeof antigravityTargetView;
  describeAntigravityOutcome: typeof describeAntigravityOutcome;
  /** G09 batch plan creation: the pure form-draft → request projection. */
  planCreateRequest: typeof planCreateRequest;
  /** Task-record cleanup: the chain projection, selection and confirmation text. */
  MAX_CLEANUP_CHAINS: typeof MAX_CLEANUP_CHAINS;
  cleanupBlockerLabel: typeof cleanupBlockerLabel;
  cleanupCandidates: typeof cleanupCandidates;
  withSelectionState: typeof withSelectionState;
  pruneCleanupSelection: typeof pruneCleanupSelection;
  toggleCleanupSelection: typeof toggleCleanupSelection;
  cleanupSelectionSummary: typeof cleanupSelectionSummary;
  cleanupRequest: typeof cleanupRequest;
  cleanupSelectionKey: typeof cleanupSelectionKey;
  cleanupOutcome: typeof cleanupOutcome;
  describeCleanupOutcome: typeof describeCleanupOutcome;
  cleanupWarningText: typeof cleanupWarningText;
  /** Linked cleanup: preset shortcuts, confirmation text and the orphan sweep summary. */
  selectCleanupCandidatesByPreset: typeof selectCleanupCandidatesByPreset;
  cleanupConfirmText: typeof cleanupConfirmText;
  describeOrphanCleanupOutcome: typeof describeOrphanCleanupOutcome;
  /** Execution choices: the new-task Agent Teams default and its origin labels. */
  executionOf: typeof executionOf;
  AGENT_TEAMS_DEFAULT_FOR_NEW_TASKS: typeof AGENT_TEAMS_DEFAULT_FOR_NEW_TASKS;
  AGENT_TEAMS_ORIGIN_LABELS: typeof AGENT_TEAMS_ORIGIN_LABELS;
  /** G08 native left navigation: slot names, projection and navigation. */
  MAIN_SLOT: typeof MAIN_SLOT;
  SIDEBAR_PANEL_SLOT: typeof SIDEBAR_PANEL_SLOT;
  TASKS_NAV_KEY: typeof TASKS_NAV_KEY;
  TASKS_NAV_LABEL: typeof TASKS_NAV_LABEL;
  resolveUiWorkspace: typeof resolveUiWorkspace;
  resolveWorkspaces: typeof resolveWorkspaces;
  resolveService: typeof resolveService;
  workspacesSnapshot: typeof workspacesSnapshot;
  knownSessionIds: typeof knownSessionIds;
  registerTasksNavigation: typeof registerTasksNavigation;
  navViewModel: typeof navViewModel;
  locateSession: typeof locateSession;
  TaskbridgeSidebarIcon: typeof TaskbridgeSidebarIcon;
  TaskbridgeNavPanel: typeof TaskbridgeNavPanel;
  /**
   * The sidebar integration: the host's published per-session child slot, the marker it renders,
   * and the plugin's own three-level grouping with its pure model.
   */
  SESSION_ROW_ACTION_SLOT: typeof SESSION_ROW_ACTION_SLOT;
  SESSION_ROW_ACTION_ID: typeof SESSION_ROW_ACTION_ID;
  SESSION_ROW_ACTION_ORDER: typeof SESSION_ROW_ACTION_ORDER;
  WORKSPACES_SLOT: typeof WORKSPACES_SLOT;
  WORKSPACES_PRIORITY: typeof WORKSPACES_PRIORITY;
  WORKSPACE_VIEWS: typeof WORKSPACE_VIEWS;
  GROUP_KINDS: typeof GROUP_KINDS;
  registerSessionRowMarker: typeof registerSessionRowMarker;
  DispatchedSessionMarker: typeof DispatchedSessionMarker;
  TaskbridgeGrouping: typeof TaskbridgeGrouping;
  dispatchProof: typeof dispatchProof;
  registerWorkspacesBrowser: typeof registerWorkspacesBrowser;
  workspacesViewMode: typeof workspacesViewMode;
  workspaceGroups: typeof workspaceGroups;
  workspaceItems: typeof workspaceItems;
  identityRows: typeof identityRows;
  sessionTitles: typeof sessionTitles;
  sessionIndex: typeof sessionIndex;
  sourcePathKey: typeof sourcePathKey;
  isManagedRootPath: typeof isManagedRootPath;
  projectNameOf: typeof projectNameOf;
  readWorkspacesSnapshot: typeof readWorkspacesSnapshot;
  loadSessionMap: typeof loadSessionMap;
  hostService: typeof hostService;
  askText: typeof askText;
  askConfirm: typeof askConfirm;
  shortId: typeof shortId;
  stableSnapshot: typeof stableSnapshot;
}
