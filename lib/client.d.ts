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
 * The host shell slot that lists the sidebar panels (the row). This bundle never
 * registers on `sidebar.workspaces`: two public sibling plugins own or replace it,
 * and competing for it would displace them.
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

/** The user-plane path the Codex panel uses (`GET` diagnoses, `POST` acts). */
export declare const ROUTES: Readonly<Record<string, string>> & { codex: '/api/dsh-delegate/codex' };

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
  /** G09 batch plan creation: the pure form-draft → request projection. */
  planCreateRequest: typeof planCreateRequest;
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
}
