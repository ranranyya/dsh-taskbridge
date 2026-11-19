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
}
