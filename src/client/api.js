// dsh-delegate settings UI — user-plane client, shared vocabulary and store.
//
// This module is deliberately framework-free: it is the part of the browser
// half that can be reasoned about (and tested) without React. It owns
//
//   1. the transport to the authenticated user plane (`/api/dsh-delegate/*`),
//   2. the operator-facing vocabulary (Chinese labels, state/effort names),
//   3. the editable settings draft and its non-secret projections, and
//   4. a small observable store the React page subscribes to.
//
// Two rules shape everything here, and both are security properties rather than
// style preferences:
//
//   * A credential value and a connection token are *never* part of persisted or
//     rendered state. The credential value travels from a controlled input
//     straight into one request and is dropped. The connection token lives in
//     this in-memory store only until the operator dismisses it; it is not
//     written to a URL, storage, log or clipboard unless the operator explicitly
//     presses copy.
//   * The user plane's authentication is the native browser-session carrier, not
//     something this client adds. Requests therefore carry no `Authorization`
//     header; they rely on `credentials: 'same-origin'`.
//
// Nothing here decides whether a provider/model/effort combination is legal:
// the settings service on the host is the authority, and its refusals are shown
// verbatim. The few checks below exist to keep the operator from submitting an
// obviously broken form, and every one of them is re-checked server-side.

// Task-record cleanup helpers. The page draws the checkbox state from these and the
// store builds its request with them, so both sides share ONE projection. They are
// re-exported rather than imported so this module keeps exactly one import list; the
// store receives the same functions through `options.cleanup` (defaulted by
// `createStore`'s caller in `index.jsx` to `cleanupProjection()`).
export {
  CLEANUP_BLOCKER_LABELS,
  CLEANUP_PRESETS,
  MAX_CLEANUP_CHAINS,
  cleanupBlockerLabel,
  cleanupCandidates,
  cleanupConfirmText,
  cleanupOutcome,
  cleanupProjection,
  cleanupRequest,
  cleanupSelectionKey,
  cleanupSelectionSummary,
  cleanupWarningText,
  describeCleanupOutcome,
  describeOrphanCleanupOutcome,
  pruneCleanupSelection,
  selectCleanupCandidatesByPreset,
  toggleCleanupSelection,
  withSelectionState,
} from './task-cleanup.js';

/** @returns {object} the projection an unconfigured store uses: nothing removable. */
function emptyCleanupProjection() {
  return {
    candidates: () => [],
    request: () => ({ body: { chains: [] }, problems: ['当前宿主未提供记录清理能力。'] }),
    outcome: () => ({ chains: 0, rounds: 0, deletedTaskIds: [] }),
    describe: () => '',
  };
}

/** User-plane prefix. Mirrors `USER_PLANE_PREFIX` in `src/http/user-plane.js`. */
export const USER_PLANE_PREFIX = '/api/dsh-delegate';

/**
 * Exact user-plane routes the page drives.
 *
 * Every route here is served by `src/http/user-plane.js`; the list is the client
 * half of one contract, not a wish list. The page still degrades explicitly when
 * a host predates a route (a 404 becomes "the host does not serve this yet"
 * rather than a fabricated success), because an older plugin version can be
 * mounted against a newer page.
 */
export const ROUTES = Object.freeze({
  status: `${USER_PLANE_PREFIX}/status`,
  delegation: `${USER_PLANE_PREFIX}/delegation`,
  nativeProviders: `${USER_PLANE_PREFIX}/native-providers`,
  settings: `${USER_PLANE_PREFIX}/settings`,
  // One narrow, authenticated operator route for the two silence thresholds. It is
  // a browser-plane write only: the MCP surface never gains a settings write.
  monitoring: `${USER_PLANE_PREFIX}/monitoring`,
  // One narrow, authenticated operator route for the operator's execution choices —
  // today, whether a NEW task gets Agent Teams when its dispatcher states no choice.
  // Browser-plane only: the MCP surface never gains a settings write, and this route
  // cannot touch DSH's global agent-teams switch.
  execution: `${USER_PLANE_PREFIX}/execution`,
  catalog: `${USER_PLANE_PREFIX}/catalog`,
  connections: `${USER_PLANE_PREFIX}/connections`,
  connectionsRevoke: `${USER_PLANE_PREFIX}/connections/revoke`,
  grants: `${USER_PLANE_PREFIX}/grants`,
  grantsRevoke: `${USER_PLANE_PREFIX}/grants/revoke`,
  revokeAll: `${USER_PLANE_PREFIX}/authorization/revoke-all`,
  tasks: `${USER_PLANE_PREFIX}/tasks`,
  tasksGet: `${USER_PLANE_PREFIX}/tasks/get`,
  tasksCancel: `${USER_PLANE_PREFIX}/tasks/cancel`,
  // One explicit action: remove the durable records of the selected finished
  // execution chains. It is a `POST`, never a load-time or refresh-time write, and it
  // only ever names chains and their exact rounds.
  tasksCleanup: `${USER_PLANE_PREFIX}/tasks/cleanup`,
  tasksCleanupOrphans: `${USER_PLANE_PREFIX}/tasks/cleanup-orphans`,
  // The one planning write the page has: a batch of planning nodes. It creates
  // records only — it cannot dispatch, authorize or review anything.
  plans: `${USER_PLANE_PREFIX}/plans`,
  displayArchive: `${USER_PLANE_PREFIX}/tasks/display-archive`,
  // The durable task → Workspace/Session identity map, narrowed to identity fields.
  // The grouped sidebar reads it to know which real DSH sessions this plugin created;
  // it is a read of the operator plane and never a task action.
  sessionMap: `${USER_PLANE_PREFIX}/session-map`,
  models: `${USER_PLANE_PREFIX}/models`,
  credentialsStatus: `${USER_PLANE_PREFIX}/credentials/status`,
  credentialsSet: `${USER_PLANE_PREFIX}/credentials/set`,
  credentialsUnset: `${USER_PLANE_PREFIX}/credentials/unset`,
  connectivity: `${USER_PLANE_PREFIX}/connectivity`,
  // One path, two methods: `GET` diagnoses, `POST` performs one explicit action.
  codex: `${USER_PLANE_PREFIX}/codex`,
  antigravity: `${USER_PLANE_PREFIX}/antigravity`,
});

/** A refusal or transport failure carrying the contract's stable code. */
export class ApiError extends Error {
  /**
   * @param {string} code - stable machine code (`SETTINGS_INVALID`, `HTTP_404`, ...).
   * @param {string} message - short English diagnostic from the host.
   * @param {object} [options] - `status`, `details`.
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = options.status ?? 0;
    this.details = options.details ?? {};
  }
}

/**
 * Create the user-plane transport.
 *
 * URLs are document-relative (`api/dsh-delegate/...`, not `/api/...`) for the
 * same reason the native change routes are: the web app may be mounted under a
 * sub-path, and an absolute path would escape the mount.
 * @param {object} [options] - `fetchImpl` for tests, `base` for a fixed prefix.
 * @returns {object} one method per user-plane route.
 */
export function createApi(options = {}) {
  const fetchImpl = options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const base = typeof options.base === 'string' ? options.base : '';

  /**
   * Send one request and unwrap the contract envelope.
   * @param {string} method - `GET` or `POST`.
   * @param {string} route - route from {@link ROUTES}.
   * @param {object} [body] - JSON body; omitted for a body-less `GET`.
   * @returns {Promise<object>} the parsed `ok:true` body.
   * @throws {ApiError} on transport failure, non-2xx, or `ok:false`.
   */
  async function request(method, route, body) {
    const url = `${base}${route.replace(/^\//, '')}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        // The browser session cookie is the user plane's credential. Sending it
        // cross-origin is impossible here, and the native carrier fences Host and
        // Origin before any handler runs.
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new ApiError('USER_PLANE_UNREACHABLE', 'the delegation settings service could not be reached', {
        details: { detail: String(error?.message ?? error).slice(0, 200) },
      });
    }

    let text = '';
    try {
      text = typeof response.text === 'function' ? await response.text() : '';
    } catch {
      text = '';
    }
    let parsed = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!response.ok || parsed === null || parsed.ok !== true) {
      const failure = parsed !== null && typeof parsed === 'object' ? parsed.error : undefined;
      const code = typeof failure?.code === 'string'
        ? failure.code
        : (response.ok ? 'USER_PLANE_MALFORMED' : `HTTP_${response.status}`);
      const message = typeof failure?.message === 'string'
        ? failure.message
        : `the settings service answered HTTP ${response.status}`;
      throw new ApiError(code, message, {
        status: response.status,
        details: typeof failure?.details === 'object' && failure.details !== null ? failure.details : {},
      });
    }
    return parsed;
  }

  return {
    /** @returns {Promise<object>} plugin/delegation posture. */
    async getStatus() {
      return await request('GET', ROUTES.status);
    },
    /** @param {boolean} enabled - master dispatch switch. */
    async setDelegationEnabled(enabled) {
      return await request('POST', ROUTES.delegation, { enabled });
    },
    /** @returns {Promise<object>} DSH's already registered providers and models. */
    async getNativeProviders() {
      return await request('GET', ROUTES.nativeProviders);
    },
    /** @returns {Promise<object>} `{ settings, secrets }`. */
    async getSettings() {
      return await request('GET', ROUTES.settings);
    },
    /**
     * Replace the whole settings document.
     * @param {object} settings - full document (never carrying a secret).
     * @returns {Promise<object>} `{ settings }`.
     */
    async putSettings(settings) {
      return await request('POST', ROUTES.settings, { settings });
    },
    /**
     * Replace the monitoring block (both no-progress thresholds and the repeated-failure
     * count).
     *
     * This is the narrow route a legacy caller uses, so an operator adjusting a timer
     * cannot accidentally rewrite a provider list. The host re-validates: whole seconds,
     * each in range (`0` = off), and — only when both are enabled — the run progress check
     * strictly after the self-check.
     * @param {{ selfCheckSeconds: number, attentionSeconds: number, repeatFailureThreshold: number }} monitoring - thresholds in seconds.
     * @returns {Promise<object>} `{ monitoring, settings }`.
     */
    async putMonitoring(monitoring) {
      return await request('POST', ROUTES.monitoring, { monitoring });
    },
    /**
     * Replace the operator's execution-choice block — today, the Agent Teams default a
     * NEW task gets when its dispatcher states no per-task choice.
     *
     * The host re-validates: the value must be a real boolean, and an absent block means
     * the documented OFF default. This cannot reach DSH's global agent-teams switch.
     * @param {{ agentTeamsDefault: boolean }} execution - the block as the operator set it.
     * @returns {Promise<object>} `{ execution, settings }`.
     */
    async putExecution(execution) {
      return await request('POST', ROUTES.execution, { execution });
    },
    /**
     * Resolve provider models/efforts plus the composed effective config.
     * @param {object} [body] - `{ projectPath }`.
     * @returns {Promise<object>} `{ catalog, effective }`.
     */
    async getCatalog(body = {}) {
      return await request('POST', ROUTES.catalog, body);
    },
    /** @returns {Promise<object>} `{ connections }`. */
    async listConnections() {
      return await request('GET', ROUTES.connections);
    },
    /**
     * Issue a connection. The response is the only place a token is ever visible.
     * @param {string} label - display label.
     * @returns {Promise<object>} `{ connection, token, tokenReturnedOnce }`.
     */
    async issueConnection(label) {
      return await request('POST', ROUTES.connections, { label });
    },
    /**
     * Revoke one connection and its grants.
     * @param {string} connectionId - server-issued identity.
     * @returns {Promise<object>} `{ grantsRevoked }`.
     */
    async revokeConnection(connectionId) {
      return await request('POST', ROUTES.connectionsRevoke, { connectionId });
    },
    /**
     * List one connection's grants.
     * @param {string} connectionId - server-issued identity.
     * @returns {Promise<object>} `{ grants }`.
     */
    async listGrants(connectionId) {
      return await request('GET', `${ROUTES.grants}?${new URLSearchParams({ connectionId })}`);
    },
    /**
     * Issue one grant.
     * @param {object} body - `{ connectionId, kind, workspacePath, ttlSeconds? }`.
     * @returns {Promise<object>} `{ grant }`.
     */
    async issueGrant(body) {
      return await request('POST', ROUTES.grants, body);
    },
    /**
     * Revoke one grant.
     * @param {string} grantId - grant identity.
     * @returns {Promise<object>} `{ grant }`.
     */
    async revokeGrant(grantId) {
      return await request('POST', ROUTES.grantsRevoke, { grantId });
    },
    /** @returns {Promise<object>} `{ grantsRevoked }`. */
    async revokeAll() {
      return await request('POST', ROUTES.revokeAll, {});
    },
    /**
     * List tasks (never carrying a prompt).
     * @param {string | null} [connectionId] - optional filter.
     * @returns {Promise<object>} `{ tasks }`.
     */
    async listTasks(connectionId = null) {
      const suffix = connectionId === null ? '' : `?${new URLSearchParams({ connectionId })}`;
      return await request('GET', `${ROUTES.tasks}${suffix}`);
    },
    /**
     * Read one task including its prompt.
     * @param {string} taskId - task identity.
     * @returns {Promise<object>} `{ task }`.
     */
    async getTask(taskId) {
      return await request('POST', ROUTES.tasksGet, { taskId });
    },
    /**
     * Read the durable task → Workspace/Session identity map.
     *
     * Identity only: paths, digests, Workspace, Session, isolation. It is what lets the
     * grouped sidebar attribute a real session to this plugin after its task records
     * were cleaned or hidden, without guessing from a title or a directory.
     * @returns {Promise<object>} `{ sessions }`.
     */
    async getSessionMap() {
      return await request('GET', ROUTES.sessionMap);
    },
    /**
     * Cancel a task as the operator.
     * @param {string} taskId - task identity.
     * @returns {Promise<object>} `{ task }`.
     */
    async cancelTask(taskId) {
      return await request('POST', ROUTES.tasksCancel, { taskId });
    },
    /**
     * Remove the durable records of finished execution chains (operator-confirmed).
     *
     * The body is exactly `{ confirm: true, chains: [{ chainId, taskIds }] }`: the
     * chains the operator ticked and the exact rounds the page displayed. The host
     * re-checks every one of them against the unfiltered current records and refuses
     * the whole batch when any is unknown, changed or still depended on, so a refusal
     * means nothing was removed.
     * @param {{ chains: Array<{ chainId: string, taskIds: string[] }> }} body - selected chains.
     * @returns {Promise<object>} `{ chains, tasks, deletedTaskIds, remaining, retained }`.
     */
    async cleanupTasks(body) {
      const chains = Array.isArray(body?.chains) ? body.chains : [];
      const payload = { confirm: true, chains };
      if (body?.archiveSessions === true) payload.archiveSessions = true;
      if (body?.removeWorktrees === true) payload.removeWorktrees = true;
      if (body?.cleanPlans === true) payload.cleanPlans = true;
      return await request('POST', ROUTES.tasksCleanup, payload);
    },
    async cleanupOrphans(options = {}) {
      const payload = { confirm: true };
      if (typeof options?.archiveSessions === 'boolean') payload.archiveSessions = options.archiveSessions;
      if (typeof options?.removeWorktrees === 'boolean') payload.removeWorktrees = options.removeWorktrees;
      return await request('POST', ROUTES.tasksCleanupOrphans, payload);
    },
    /**
     * Create a batch of planning nodes.
     *
     * The body is exactly `{ workspacePath?, parentNodeId?, nodes: [...] }`. It
     * deliberately names no connection: the host always writes for the fixed local
     * caller, and a body that tried to name one is refused rather than ignored.
     * @param {object} body - `{ workspacePath?, parentNodeId?, nodes }`.
     * @returns {Promise<object>} `{ nodes, executed: false, switch }`.
     */
    async createPlans(body) {
      return await request('POST', ROUTES.plans, body);
    },
    async setDisplayArchive(nodeId, archived) {
      return await request('POST', ROUTES.displayArchive, { nodeId, archived });
    },
    /**
     * Discover one provider's model list from its own API (remote discovery).
     *
     * The host performs one authenticated request to the provider's configured
     * base URL with *that profile's* credential reference, so this answers "what
     * does the endpoint say it serves" — not "what can the harness resolve" (that
     * is `getCatalog`). A failed discovery still answers `ok: true` with
     * `models: []` and a `discovery` diagnosis, so a caller must read
     * `body.discovery?.failed` and `body.error` rather than treating an empty list
     * as "the provider has no models".
     * @param {string} providerId - configured provider id.
     * @returns {Promise<object>} `{ models: [{ id, efforts }], source, discovery, error }`.
     */
    async fetchModels(providerId) {
      return await request('POST', ROUTES.models, { providerId });
    },
    /**
     * Read whether a provider's credential is configured (target route).
     * @param {string} providerId - configured provider id.
     * @returns {Promise<object>} `{ credential: { configured, source?, writable? } }`.
     */
    async credentialStatus(providerId) {
      return await request('POST', ROUTES.credentialsStatus, { providerId });
    },
    /**
     * Store a credential value through the separate authenticated seam.
     * @param {string} providerId - configured provider id.
     * @param {string} value - the literal value; never retained by the caller.
     * @returns {Promise<object>} `{ credential }`.
     */
    async setCredential(providerId, value) {
      return await request('POST', ROUTES.credentialsSet, { providerId, value });
    },
    /**
     * Remove a stored credential value.
     * @param {string} providerId - configured provider id.
     * @returns {Promise<object>} `{ credential }`.
     */
    async unsetCredential(providerId) {
      return await request('POST', ROUTES.credentialsUnset, { providerId });
    },
    /**
     * Run the layered connectivity check.
     * @param {object} body - `{ providerId, model?, reasoningEffort? }`.
     * @returns {Promise<object>} `{ report }`.
     */
    async checkConnectivity(body) {
      return await request('POST', ROUTES.connectivity, body);
    },
    /**
     * Diagnose the Codex integration. Read-only on the host.
     * @returns {Promise<object>} `{ codex, switch }`.
     */
    async getCodexStatus() {
      return await request('GET', ROUTES.codex);
    },
    /**
     * Perform one explicit Codex action.
     *
     * Only an operator click reaches this: there is no load-time or save-time
     * caller, so visiting the page never writes into the Codex home.
     * @param {'install'|'repair'|'remove'} action - the action to perform.
     * @returns {Promise<object>} `{ action, changed, refused, codex, switch }`.
     */
    async runCodexAction(action) {
      return await request('POST', ROUTES.codex, { action });
    },
    /** Diagnose the Antigravity plugin integration. Read-only on the host. */
    async getAntigravityStatus() {
      return await request('GET', ROUTES.antigravity);
    },
    /** Perform one explicit Antigravity integration action (`install`, `repair`, `remove`). */
    async runAntigravityAction(action) {
      return await request('POST', ROUTES.antigravity, { action });
    },
  };
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Reasoning-effort ids this build understands, weakest first.
 *
 * This is a *display* mirror of `KNOWN_EFFORTS` in `src/config/defaults.js`; the
 * authority for what a particular model supports is the catalog the host serves,
 * and the authority for what a document may contain is the host's validator.
 */
export const KNOWN_EFFORTS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Chinese labels for effort ids. */
export const EFFORT_LABELS = Object.freeze({
  off: '关闭推理',
  minimal: '最少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
});

/** Sentinel used by a `<select>` for "no explicit effort". */
export const EFFORT_UNSET = '';

/** Workspace isolation modes, strongest first. */
export const ISOLATION_MODES = Object.freeze(['worktree', 'shared']);

/** Chinese labels for isolation modes. */
export const ISOLATION_LABELS = Object.freeze({
  worktree: '独立工作树（临时 git worktree，不碰当前检出）',
  shared: '共享工作区（直接修改所选目录）',
});

/**
 * The retired directory-level conversation modes, kept for display compatibility.
 *
 * They are no longer a choice. A new submission always starts a new DSH
 * conversation, and a follow-up continues only the task thread named by
 * `continueFromTaskId`. The values remain here so a page can still render a task
 * record or a stored document written by an earlier build, and so the migration
 * note can name what went away.
 */
export const CONVERSATION_MODES = Object.freeze(['new', 'reuse']);

/** Chinese labels for the retired conversation modes. */
export const CONVERSATION_LABELS = Object.freeze({
  new: '每个任务新开对话',
  reuse: '复用同一执行目录最近的对话（已移除）',
});

/** Chinese explanation of the conversation policy that replaced the mode setting. */
export const CONVERSATION_POLICY_LABEL = '每次提交默认新开对话；只有带上 continueFromTaskId 的跟进任务才续接同一条对话';

/**
 * The conversation block a draft/request should carry.
 *
 * The value is inert: it is preserved so saving a page never rewrites an operator's
 * stored document into a state it did not choose, and it never influences what a
 * run does. A stored `reuse` is kept verbatim and still means nothing on dispatch.
 * @param {object} [draft] - editable document.
 * @returns {{ mode: string }} conversation block.
 */
export function conversationOf(draft) {
  const requested = draft?.conversation?.mode;
  return { mode: CONVERSATION_MODES.includes(requested) ? requested : CONVERSATION_MODES[0] };
}

/**
 * Chinese label for one conversation mode.
 * @param {string} mode - mode id.
 * @returns {string} label, falling back to the raw id.
 */
export function conversationModeLabel(mode) {
  return CONVERSATION_LABELS[mode] ?? String(mode ?? '未设置');
}

/**
 * The monitoring block a draft carries, normalized to whole seconds.
 *
 * This is a *display/normalization* helper, not the validator: an out-of-range or
 * inconsistent pair is passed through so the operator sees what they typed and the
 * precheck can explain it. Only a missing block, a non-object, or a non-finite value
 * falls back to the documented default — an older stored document (no `monitoring`
 * key) therefore opens at 300/600 s, i.e. 5/10 minutes, with the repeated-failure
 * reminder at its default of 3.
 * @param {object | null} source - served document, draft, or raw block.
 * @returns {{ selfCheckSeconds: number, attentionSeconds: number, repeatFailureThreshold: number }} normalized block.
 */
export function monitoringOf(source) {
  const block = source?.monitoring;
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return { ...MONITORING_DEFAULTS };
  const whole = (value, fallback) => (Number.isFinite(value) ? Math.trunc(value) : fallback);
  return {
    selfCheckSeconds: whole(block.selfCheckSeconds, MONITORING_DEFAULTS.selfCheckSeconds),
    attentionSeconds: whole(block.attentionSeconds, MONITORING_DEFAULTS.attentionSeconds),
    repeatFailureThreshold: whole(block.repeatFailureThreshold, MONITORING_DEFAULTS.repeatFailureThreshold),
  };
}

/**
 * The RAW monitoring block of a draft, for validation only.
 *
 * `monitoringOf` is a display normalizer: it turns a blank or non-finite field into the
 * documented default so the inputs still render. That is exactly wrong for validating
 * an edit — a cleared field would silently look like the default and the save button
 * would stay enabled. This keeps whatever the operator actually typed (including `''`),
 * so the shared precheck can refuse it. Only a missing block falls back to the defaults.
 *
 * One narrow exception: a block that predates the repeated-failure count has no such key
 * at all, and an absent key is not an operator error — it is the documented default. So
 * `undefined` becomes the default value (making the field editable for an older document),
 * while an explicit `''`, `null`, fractional or out-of-range value is preserved exactly so
 * the precheck still refuses it. A stored `0` is a DECISION ("off") and is preserved as
 * `0`, never re-defaulted.
 * @param {object | null} source - draft or served document.
 * @returns {object} the block as stored, or the defaults when there is none.
 */
export function monitoringDraftOf(source) {
  const block = source?.monitoring;
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return { ...MONITORING_DEFAULTS };
  return {
    selfCheckSeconds: block.selfCheckSeconds,
    attentionSeconds: block.attentionSeconds,
    repeatFailureThreshold: block.repeatFailureThreshold === undefined
      ? MONITORING_DEFAULTS.repeatFailureThreshold
      : block.repeatFailureThreshold,
  };
}

/**
 * Convert whole seconds to minutes, for display only.
 *
 * A threshold that is not a whole number of minutes is returned as a fraction so the
 * field shows the stored value instead of a rounded one that would not round-trip.
 * @param {number} seconds - stored threshold.
 * @returns {number} minutes.
 */
export function secondsToMinutes(seconds) {
  if (!Number.isFinite(seconds)) return 0;
  return seconds / 60;
}

/**
 * Convert a minutes input back to whole seconds.
 *
 * The stored unit is seconds: a fractional minute is converted and rounded, because
 * the host accepts integers only. A non-numeric input yields `NaN`, which the local
 * precheck reports rather than silently becoming a zero.
 * @param {unknown} minutes - operator input.
 * @returns {number} whole seconds, or NaN.
 */
export function minutesToSeconds(minutes) {
  // An empty or blank field is NOT zero: `Number('')` is `0`, which would silently
  // persist a threshold of 0 s instead of letting the precheck report the blank.
  if (typeof minutes === 'string' && minutes.trim() === '') return Number.NaN;
  if (minutes === null || minutes === undefined) return Number.NaN;
  const value = typeof minutes === 'number' ? minutes : Number(String(minutes).trim());
  if (!Number.isFinite(value)) return Number.NaN;
  return Math.round(value * 60);
}

/** Grant scopes. */
export const GRANT_KINDS = Object.freeze(['task', 'session']);

/** Chinese labels for grant scopes. */
export const GRANT_KIND_LABELS = Object.freeze({
  task: '单次任务（用掉即失效）',
  session: '本连接会话（限时、可撤销）',
});

/**
 * Chinese labels for the per-call permission states a task can report.
 *
 * The wording is deliberately about ONE call: a decision here never grants a
 * standing permission, and the panel must not read like an approval workflow.
 */
export const PERMISSION_STATE_LABELS = Object.freeze({
  pending: '等待宿主端决定（仅这一次调用）',
  decided: '已决定',
  expired: '已超时（未决定即为拒绝）',
  cancelled: '已撤回',
  unavailable: '无法建立请求身份（已按拒绝处理）',
});

/** Chinese labels for the two decisions the commander may take. */
export const PERMISSION_DECISION_LABELS = Object.freeze({
  'allow-once': '仅本次允许',
  reject: '拒绝',
});

/** Chinese labels for the four closed native approval outcomes. */
export const PERMISSION_OUTCOME_LABELS = Object.freeze({
  'allowed-once': '仅本次允许',
  rejected: '已拒绝',
  cancelled: '已撤回',
  unavailable: '无可用审批通道',
});

/** Chinese label for a task phase, falling back to the raw phase. */
export const TASK_PHASE_LABELS = Object.freeze({
  created: '已创建',
  workspace: '解析工作区',
  authorization: '校验授权',
  settings: '读取设置',
  providers: '确认提供方',
  worktree: '准备工作树',
  audit: '记录基线',
  'before-create': '即将创建执行器',
  execute: '执行中',
  'awaiting-permission': '等待本次调用授权决定',
  // A question is a DIFFERENT wait from an approval: answering it grants nothing, so the
  // label must not read as an authorization either.
  'awaiting-question': '等待回答问题',
  review: '旧版模型复审',
  'awaiting-host-review': '等待宿主审查',
  failed: '已失败',
  cancelled: '已取消',
});

/** Task states, exactly as the engine reports them. */
export const TASK_STATES = Object.freeze(['pending', 'running', 'awaiting-host-review', 'failed', 'cancelled']);

/**
 * Chinese labels for task states.
 *
 * `awaiting-host-review` is deliberately *not* "已完成" or "已接受": execution
 * finished, and acceptance belongs to the host.
 */
export const TASK_STATE_LABELS = Object.freeze({
  pending: '排队中',
  running: '执行中',
  'awaiting-host-review': '等待宿主审查',
  failed: '执行失败',
  cancelled: '已取消',
  // A task persisted by a restart is stored with this state. It is NOT "still
  // running": the execution does not resume, so the panel says exactly that. The
  // engine never sets it for a live run — the same word is also the reason an
  // OBSERVATION was interrupted, and that is a different thing (see
  // `WAIT_REASON_LABELS.interrupted`).
  interrupted: '已中断（进程重启后不会继续执行）',
});

/** Chinese labels for historical model review states. */
export const REVIEW_STATE_LABELS = Object.freeze({
  completed: '已完成',
  failed: '审查失败（与任务成败无关）',
});

/** Chinese labels for review verdicts. */
export const REVIEW_VERDICT_LABELS = Object.freeze({
  approve: '建议通过',
  'changes-requested': '建议修改',
  unknown: '未给出结论',
});

/** Chinese labels for the four connectivity layers. */
export const CONNECTIVITY_LAYERS = Object.freeze([
  { key: 'transport', label: '传输（地址可达）' },
  { key: 'authentication', label: '认证（凭据可用）' },
  { key: 'catalog', label: '模型目录' },
  { key: 'modelResponse', label: '模型实际响应' },
]);

/** Bounds mirrored from the host validator, used for input attributes only. */
export const LIMITS = Object.freeze({
  // LEGACY: no longer offered as a control and no longer bounds an ordinary run. It
  // survives only so an older stored value (or an older client) still round-trips.
  timeoutSecondsMin: 30,
  timeoutSecondsMax: 7200,
  maxParallelismMin: 1,
  maxParallelismMax: 8,
  taskGrantTtlSecondsMin: 30,
  taskGrantTtlSecondsMax: 3600,
  sessionGrantTtlSecondsMin: 60,
  sessionGrantTtlSecondsMax: 43200,
  providers: 32,
  // No-progress thresholds. Mirrors `LIMITS` in `src/config/defaults.js`; the host is
  // still the authority, these only drive input attributes and the local precheck.
  // `0` is legal for either and means "this reminder is off".
  selfCheckSecondsMin: 0,
  selfCheckSecondsMax: 3600,
  attentionSecondsMin: 0,
  attentionSecondsMax: 7200,
  // Repeated-failure reminder: a COUNT of consecutive identical failures, 0 = off.
  repeatFailureThresholdMin: 0,
  repeatFailureThresholdMax: 20,
});

/**
 * Default monitoring thresholds and failure count, mirroring `MONITORING_DEFAULTS`.
 *
 * Stored as whole SECONDS: 10 minutes for the read-only self-check, 40 minutes for the
 * run progress check, and the repeated-failure count. Both durations are measured on
 * the SAME clock — consecutive time without real progress — and each can be switched off
 * with `0`. The panel presents them as minutes because that is how an operator thinks
 * about them; a value that is not a whole number of minutes is still editable and is
 * shown exactly.
 */
export const MONITORING_DEFAULTS = Object.freeze({
  selfCheckSeconds: 600,
  attentionSeconds: 2400,
  repeatFailureThreshold: 3,
});

/**
 * The operator's default for a NEW task's Agent Teams choice, mirroring
 * `DEFAULT_AGENT_TEAMS_FOR_NEW_TASKS`.
 *
 * OFF, so an upgrade or a fresh install never starts collaborating by itself. The host
 * is still the authority; this only fills a draft a host has not answered for yet.
 */
export const AGENT_TEAMS_DEFAULT_FOR_NEW_TASKS = false;

/**
 * Where a task's frozen Agent Teams decision came from.
 *
 * Kept apart from the decision itself: "you asked for this", "this follow-up continues
 * a chain that had it" and "the TaskBridge default applied it" are three different
 * stories, and a record that showed the third as the first would misattribute a choice
 * nobody made.
 */
export const AGENT_TEAMS_ORIGIN_LABELS = Object.freeze({
  request: '本次派工明确指定',
  continuation: '沿用所续接任务的协作选择',
  'settings-default': '按 TaskBridge 的「新任务默认」',
});

/**
 * The execution block a draft carries, normalized.
 *
 * A document written before this block existed, and a host that never served one, both
 * open at the OFF default — never "on" and never a blank control. A stored value that is
 * not a real boolean is passed through unchanged so the precheck can refuse it instead of
 * the page quietly showing "off" for something the host would reject.
 * @param {object | null} source - served document, draft, or raw block.
 * @returns {{ agentTeamsDefault: boolean | unknown }} normalized block.
 */
export function executionOf(source) {
  const block = source?.execution;
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    return { agentTeamsDefault: AGENT_TEAMS_DEFAULT_FOR_NEW_TASKS };
  }
  return {
    agentTeamsDefault: block.agentTeamsDefault === undefined
      ? AGENT_TEAMS_DEFAULT_FOR_NEW_TASKS
      : block.agentTeamsDefault,
  };
}

/** Chinese labels for the self-check verdicts the host publishes. */
export const SELF_CHECK_LABELS = Object.freeze({
  'executor-alive-silent': '执行器健在，这段时间没有新输出',
  'executor-not-started': '执行器尚未开始',
  'idle-between-steps': '两步之间，执行器已停止输出',
  'tool-running': '某个工具调用仍在运行',
  'waiting-for-permission': '正在等待本次调用授权决定',
  settled: '任务已经结束',
});

/** Chinese label for the repeated-failure reminder kind. */
export const REPEATED_FAILURE_LABEL = '同一操作连续失败';

/**
 * One line describing the repeated-failure reminder on a task page.
 *
 * The engine already reduced this to a tool name, a failure code and counts, so this
 * is a formatter and nothing else: no arguments, output or error prose is available
 * here even if a stored record somehow carried it.
 * @param {object | null} activity - the task's activity block.
 * @returns {string} display text.
 */
export function repeatFailureLine(activity) {
  const block = activity?.repeatFailure;
  if (block === null || block === undefined) return '未采集到';
  const reported = Array.isArray(block.reported) ? block.reported : [];
  if (reported.length === 0) {
    return block.threshold === 0 ? '已关闭' : `尚未触发（连续 ${block.threshold} 次才提醒）`;
  }
  return reported
    .map((entry) => `${entry.toolName ?? '工具'} · ${entry.failureCode ?? 'error'} 连续 ${entry.consecutive} 次`)
    .join('；');
}

/** Chinese labels for the reasons a wait returns. */
export const WAIT_REASON_LABELS = Object.freeze({
  heartbeat: '没有需要处理的事（内部心跳）',
  attention: '任务需要你看一下进展（只是提醒，任务仍在运行）',
  permission: '有一次工具调用在等待授权决定',
  ready: '执行已结束，等待宿主审查（不等于已接受）',
  failed: '执行失败',
  cancelled: '已取消',
  // The reason describes the WAIT, and only a TERMINAL answer means the task record is
  // itself interrupted. Both readings are named, because a serialised host reads this
  // through `delegate_wait`'s answer: a live task stays live (`wait-limit`, below), a
  // restart history does not resume.
  interrupted: '这次等待被中断；任务是否仍在运行要看答案里的 terminal/state（任务记录本身中断才是重启历史，不会继续执行）',
  'wait-limit': '本轮等待时间用完，任务仍在运行',
});

/**
 * Actions the Codex panel may send.
 *
 * `status` is deliberately absent: it is a `GET`, so a page that only renders the
 * panel can never be mistaken for one that changes files.
 */
export const CODEX_ACTIONS = Object.freeze(['install', 'repair', 'remove']);

/**
 * The three states the panel reports separately.
 *
 * They are independent on purpose: an agent can be installed while MCP is not
 * configured, and both can be ready while the local-call switch is still off.
 */
export const CODEX_TARGETS = Object.freeze([
  { key: 'agent', label: 'Codex 原生技能（skills/dsh-taskbridge/SKILL.md）' },
  { key: 'mcp', label: 'Codex MCP 条目' },
  { key: 'switch', label: 'DSH 本机调用开关' },
]);

/** Chinese labels for the managed-file states the host reports. */
export const CODEX_STATE_LABELS = Object.freeze({
  'not-installed': '未安装',
  installed: '已安装',
  outdated: '旧版本，可更新',
  modified: '不属于已知版本（插件不会改动）',
  conflict: '存在冲突（插件不会改动）',
  'not-configured': '未配置',
  configured: '已配置',
  unreadable: '无法读取（不会写入）',
});

/**
 * Read one target's status out of a served Codex document, in the panel's terms.
 *
 * Kept as a pure function so the UI and its tests agree on exactly one mapping,
 * and so an older/newer host that omits a block yields "未知" instead of a crash.
 * @param {object | null} codex - served `codex` document.
 * @param {object | null} switchState - served `switch` block, when present.
 * @param {'agent'|'mcp'|'switch'} target - which state to describe.
 * @returns {{ key: string, label: string, state: string, tone: string, detail: string }} description.
 */
export function codexTargetView(codex, switchState, target) {
  const label = CODEX_TARGETS.find((entry) => entry.key === target)?.label ?? target;
  if (target === 'switch') {
    const authorized = switchState?.authorized === true;
    return {
      key: 'switch',
      label,
      state: authorized ? 'on' : 'off',
      tone: authorized ? 'on' : 'off',
      detail: authorized
        ? '已开启：Codex 可以通过 MCP 提交任务。'
        : '已关闭：Codex 可以查询状态，但新任务会被拒绝；本页不会替你打开它。',
    };
  }
  const block = target === 'agent' ? (codex?.skill ?? codex?.agent) : codex?.mcp;
  if (block === null || block === undefined || typeof block !== 'object') {
    return { key: target, label, state: 'unknown', tone: 'off', detail: '宿主尚未回报该状态。' };
  }
  const state = String(block.state ?? 'unknown');
  const done = target === 'agent' ? block.installed === true : block.configured === true;
  const detailParts = [];
  if (typeof block.path === 'string' && block.path !== '') detailParts.push(block.path);
  if (target === 'mcp' && typeof block.script === 'string' && block.script !== '') {
    detailParts.push(`入口：${block.script}`);
  }
  // The executable Codex will launch. `node === null` means this host could not prove
  // one — a desktop application executable is never used and a bare `node` is never
  // written — so the row states the missing fact instead of showing a blank.
  if (target === 'mcp') {
    if (typeof block.node === 'string' && block.node !== '') detailParts.push(`Node：${block.node}`);
    else if (block.nodeResolved === false) detailParts.push('Node：未确定（不会写入桌面应用自身的 exe）');
  }
  return {
    key: target,
    label,
    state,
    tone: done ? 'on' : (state === 'conflict' || state === 'unreadable' || state === 'modified') ? 'warn' : 'off',
    detail: CODEX_STATE_LABELS[state] ?? state,
    path: typeof block.path === 'string' ? block.path : '',
    paths: detailParts,
  };
}

/**
 * One-line summary of an action outcome, for the notice strip.
 * @param {object | null} outcome - `{ action, changed, refused }` from the host.
 * @returns {string} Chinese summary; empty when there was no action.
 */
export function describeCodexOutcome(outcome) {
  if (outcome === null || outcome === undefined) return '';
  const names = { agent: '技能文件（SKILL.md）', legacyAgent: '旧版子智能体文件', mcp: 'MCP 条目' };
  const rawChanged = Array.isArray(outcome.changed) ? outcome.changed : [];
  const refused = Array.isArray(outcome.refused) ? outcome.refused : [];
  const parts = [];
  if (outcome.action === 'remove') {
    if (rawChanged.length > 0) parts.push(`已移除：${rawChanged.map((key) => names[key] ?? key).join('、')}`);
  } else {
    const written = rawChanged.filter((key) => key !== 'legacyAgent').map((key) => names[key] ?? key);
    const cleaned = rawChanged.filter((key) => key === 'legacyAgent').map((key) => names[key] ?? key);
    if (written.length > 0) parts.push(`已写入：${written.join('、')}`);
    if (cleaned.length > 0) parts.push(`已清理：${cleaned.join('、')}`);
  }
  if (refused.length > 0) parts.push(`未改动：${refused.map((entry) => names[entry?.target] ?? entry?.target ?? '未知').join('、')}`);
  if (parts.length === 0) {
    return outcome.action === 'remove' ? '没有需要移除的插件托管文件。' : '已是最新，没有需要写入的内容。';
  }
  return parts.join('；') + '。';
}

export const ANTIGRAVITY_ACTIONS = Object.freeze(['install', 'repair', 'remove']);

export const ANTIGRAVITY_TARGETS = Object.freeze([
  { key: 'plugin', label: 'Antigravity 插件与规则（Skill + 子智能体）' },
  { key: 'mcp', label: 'Antigravity 插件 MCP 配置' },
  { key: 'switch', label: 'DSH 本机调用开关' },
]);

export function antigravityTargetView(antigravity, switchState, target) {
  const label = ANTIGRAVITY_TARGETS.find((entry) => entry.key === target)?.label ?? target;
  if (target === 'switch') {
    const authorized = switchState?.authorized === true;
    return {
      key: 'switch',
      label,
      state: authorized ? 'on' : 'off',
      tone: authorized ? 'on' : 'off',
      detail: authorized
        ? '已开启：Antigravity 可以通过 MCP 提交任务。'
        : '已关闭：Antigravity 可以查询状态，但新任务会被拒绝；本页不会替你打开它。',
    };
  }
  const block = target === 'plugin' ? antigravity?.plugin : antigravity?.mcp;
  if (block === null || block === undefined || typeof block !== 'object') {
    return { key: target, label, state: 'unknown', tone: 'off', detail: '宿主尚未回报该状态。' };
  }
  const state = String(block.state ?? 'unknown');
  const done = target === 'plugin' ? block.installed === true : block.configured === true;
  const detailParts = [];
  if (typeof block.path === 'string' && block.path !== '') detailParts.push(block.path);
  if (target === 'mcp' && typeof block.script === 'string' && block.script !== '') {
    detailParts.push(`入口：${block.script}`);
  }
  if (target === 'mcp') {
    if (typeof block.node === 'string' && block.node !== '') detailParts.push(`Node：${block.node}`);
    else if (block.nodeResolved === false) detailParts.push('Node：未确定（不会写入桌面应用自身的 exe）');
  }
  return {
    key: target,
    label,
    state,
    tone: done ? 'on' : (state === 'conflict' || state === 'unreadable' || state === 'modified') ? 'warn' : 'off',
    detail: CODEX_STATE_LABELS[state] ?? state,
    path: typeof block.path === 'string' ? block.path : '',
    paths: detailParts,
  };
}

export function describeAntigravityOutcome(outcome) {
  if (outcome === null || outcome === undefined) return '';
  const names = { plugin: '插件与规则文件', mcp: 'MCP 配置' };
  const changed = Array.isArray(outcome.changed) ? outcome.changed.map((key) => names[key] ?? key) : [];
  const refused = Array.isArray(outcome.refused) ? outcome.refused : [];
  const parts = [];
  if (changed.length > 0) parts.push(`已写入：${changed.join('、')}`);
  if (refused.length > 0) parts.push(`未改动：${refused.map((entry) => names[entry?.target] ?? entry?.target ?? '未知').join('、')}`);
  if (parts.length === 0) {
    return outcome.action === 'remove' ? '没有需要移除的插件托管文件。' : '已是最新，没有需要写入的内容。';
  }
  return parts.join('；') + '。';
}

/** Provider protocols this stage supports. */
export const SUPPORTED_PROTOCOLS = Object.freeze(['openai-chat']);

// ---------------------------------------------------------------------------
// Settings draft
// ---------------------------------------------------------------------------

/** @param {unknown} value @returns {object} deep JSON clone. */
export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * The document shape a fresh install stores.
 * @returns {object} default editable document.
 */
export function defaultDraft() {
  return {
    schemaVersion: 1,
    delegationEnabled: false,
    providers: [],
    worker: {
      providerId: null,
      model: null,
      reasoningEffort: null,
      timeoutSeconds: 1800,
      maxParallelism: 1,
      isolation: 'worktree',
    },
    authorization: { taskGrantTtlSeconds: 900, sessionGrantTtlSeconds: 14400 },
    // Silence thresholds. Present in a fresh draft so the controls render without a
    // second load, and normalized from the served document below so an older host
    // (or an older stored file) still opens with the documented defaults.
    monitoring: { ...MONITORING_DEFAULTS },
    // The operator's default for NEW tasks only: OFF, so a fresh install and an upgrade
    // both start without agent collaboration. It never opens DSH's global switch.
    execution: { agentTeamsDefault: AGENT_TEAMS_DEFAULT_FOR_NEW_TASKS },
    projectOverrides: {},
    presets: [],
    // Deprecated and inert, kept only so a save round-trips the stored document
    // instead of rewriting it. There is no conversation-mode control: a submission
    // starts a new DSH conversation unless it names `continueFromTaskId`.
    conversation: { mode: CONVERSATION_MODES[0] },
  };
}

/**
 * Turn a served public settings document into an editable draft.
 *
 * The `secrets` block the host adds is documentation, not settings, and is
 * dropped here so it can never be echoed back in a write.
 * @param {object | null} document - `settings` from `GET /settings`.
 * @returns {object} editable document.
 */
export function draftFromSettings(document) {
  const source = document ?? {};
  const base = defaultDraft();
  return {
    schemaVersion: typeof source.schemaVersion === 'number' ? source.schemaVersion : base.schemaVersion,
    delegationEnabled: source.delegationEnabled === true,
    providers: Array.isArray(source.providers)
      ? source.providers.map((provider) => ({
        id: String(provider.id ?? ''),
        name: String(provider.name ?? ''),
        source: provider.source ?? 'custom',
        protocol: provider.source === 'native' ? null : String(provider.protocol ?? 'openai-chat'),
        baseUrl: provider.source === 'native' ? null : String(provider.baseUrl ?? ''),
        credentialRef: provider.source === 'native' ? null : (provider.credentialRef ?? null),
        models: Array.isArray(provider.models)
          ? provider.models.map((model) => ({
            id: String(model.id ?? ''),
            efforts: Array.isArray(model.efforts) ? [...model.efforts] : [],
          }))
          : [],
      }))
      : [],
    worker: { ...base.worker, ...(source.worker ?? {}) },
    authorization: { ...base.authorization, ...(source.authorization ?? {}) },
    // A document written before this block existed has no `monitoring` key at all,
    // and a host that predates it never serves one. Both open with the documented
    // defaults instead of a blank control, and the values are coerced to whole
    // seconds because that is the only shape the host accepts.
    monitoring: monitoringOf(source),
    // The same rule for the operator's new-task default: a document (or a host) that
    // predates the block opens at the documented OFF default, so an upgraded
    // installation never presents agent collaboration as already decided on.
    execution: executionOf(source),
    projectOverrides: Object.fromEntries(Object.entries(source.projectOverrides ?? {})
      .filter(([, block]) => block?.review === undefined || block.worker !== undefined)
      .map(([path, block]) => [path, block?.worker === undefined ? {} : { worker: clone(block.worker) }])),
    presets: Array.isArray(source.presets)
      ? source.presets.filter((preset) => preset.worker != null).map((preset) => ({
        id: String(preset.id ?? ''),
        name: String(preset.name ?? preset.id ?? ''),
        worker: { ...preset.worker },
      }))
      : [],
    // Read back through the same resolver the save path uses, so a document written
    // before this field existed opens with the default and an inert stored `reuse`
    // is preserved verbatim rather than silently rewritten.
    conversation: conversationOf(source),
  };
}

/**
 * Project a draft onto the exact document `POST /settings` accepts.
 * @param {object} draft - editable document.
 * @returns {object} write body value (no `secrets`, no UI-only fields).
 */
export function documentFromDraft(draft) {
  const source = draft ?? defaultDraft();
  return {
    schemaVersion: source.schemaVersion ?? 1,
    delegationEnabled: source.delegationEnabled === true,
    providers: (source.providers ?? []).map((provider) => {
      const common = {
        id: provider.id,
        name: provider.name,
        source: provider.source ?? 'custom',
        models: (provider.models ?? []).map((model) => ({ id: model.id, efforts: [...(model.efforts ?? [])] })),
      };
      if (common.source === 'native') return common;
      return {
        ...common,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        credentialRef: provider.credentialRef === '' ? null : (provider.credentialRef ?? null),
      };
    }),
    worker: { ...source.worker },
    authorization: { ...source.authorization },
    // Sent on every save, normalized to whole seconds: the host refuses anything
    // else, and a document that omitted the block would store the defaults.
    monitoring: monitoringOf(source),
    // Sent on every save so the round-trip is faithful. The value is a plain boolean and
    // a missing one is written as the documented OFF default, exactly as the host would.
    execution: executionOf(source),
    projectOverrides: clone(source.projectOverrides ?? {}),
    presets: (source.presets ?? []).map((preset) => ({
      id: preset.id,
      name: preset.name,
      worker: { ...preset.worker },
    })),
    // Sent on every save only so the round-trip is faithful. It is inert: the host
    // validates it as a retired value and no run consults it.
    conversation: conversationOf(source),
  };
}

/**
 * Nonsecret export text: exactly the public document, formatted for reading.
 *
 * There is no credential value anywhere in a settings document, so an export is
 * safe by construction; the label says so to stop anyone assuming otherwise.
 * @param {object} draft - editable document.
 * @returns {string} JSON text with a trailing newline.
 */
export function exportDocument(draft) {
  return `${JSON.stringify(documentFromDraft(draft), null, 2)}\n`;
}

/**
 * Compose the effective execution snapshot for display.
 *
 * This mirrors `resolveEffectiveConfig` closely enough to show the operator what
 * a save will produce. It is a *preview*: the host composes the snapshot it
 * actually runs with, `catalog.effective` shows that, and job details show the
 * immutable snapshot a running job took.
 * @param {object} draft - editable document.
 * @param {string | null} [projectPath] - optional project layer.
 * @returns {{ worker: object, monitoring: object, applied: string[] }} preview.
 */
export function previewEffective(draft, projectPath = null) {
  const applied = [];
  let worker = { ...(draft?.worker ?? {}) };
  const overrides = draft?.projectOverrides ?? {};
  if (typeof projectPath === 'string' && projectPath.trim() !== '') {
    const wanted = projectPath.trim().replace(/[\\/]+$/, '');
    const key = Object.keys(overrides).find((candidate) => (
      candidate === wanted || candidate.toLowerCase() === wanted.toLowerCase()
    ));
    if (key !== undefined) {
      const block = overrides[key] ?? {};
      if (block.worker !== undefined && block.worker !== null) {
        worker = { ...worker, ...block.worker };
        applied.push('项目覆盖：执行设置');
      }
    }
  }
  return {
    // `executionTimeoutSeconds` mirrors the host: `null` is the documented state "no
    // total execution deadline", and the legacy stored value is carried separately so
    // the preview never presents it as a budget the run gets.
    worker: {
      ...worker,
      providerRoute: worker.providerId ?? null,
      executionTimeoutSeconds: null,
    },
    // Global-only, like the host's own snapshot: no project or per-job layer can
    // retime a task, so the preview reports the same pair the task would freeze.
    monitoring: monitoringOf(draft),
    applied,
  };
}

/**
 * Reusable presets and project overrides live inside the same settings document,
 * so the export above already carries them.

 * @param {object} draft - editable document.
 * @returns {string[]} duplicate provider ids.
 */
export function duplicateProviderIds(draft) {
  const seen = new Set();
  const duplicates = new Set();
  for (const provider of draft?.providers ?? []) {
    if (seen.has(provider.id)) duplicates.add(provider.id);
    seen.add(provider.id);
  }
  return [...duplicates];
}

/**
 * Pre-flight checks for the write button.
 *
 * These are *operator convenience*: they catch a blank field or a numeric field
 * that is not a number before a round trip. They are not the authority — the
 * host re-validates everything and its refusal is what the page reports.
 * @param {object} draft - editable document.
 * @returns {string[]} Chinese problem descriptions; empty when plausible.
 */
export function precheckDraft(draft) {
  const problems = [];
  const providers = draft?.providers ?? [];
  const ids = new Set();
  for (const provider of providers) {
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(String(provider.id ?? ''))) {
      problems.push(`提供方标识「${provider.id || '（空）'}」需为 3–40 位小写字母、数字或连字符`);
    }
    if (ids.has(provider.id)) problems.push(`提供方标识「${provider.id}」重复`);
    ids.add(provider.id);
    if (!String(provider.name ?? '').trim()) problems.push(`提供方「${provider.id}」缺少显示名称`);
    if (provider.source !== 'native' && !String(provider.baseUrl ?? '').trim()) {
      problems.push(`提供方「${provider.id}」缺少接口地址`);
    }
    const modelIds = new Set();
    for (const model of provider.models ?? []) {
      if (!String(model.id ?? '').trim()) problems.push(`提供方「${provider.id}」存在空的模型 ID`);
      if (modelIds.has(model.id)) problems.push(`提供方「${provider.id}」的模型「${model.id}」重复`);
      modelIds.add(model.id);
    }
  }
  const worker = draft?.worker;
  if (worker?.providerId == null) {
    if (providers.length > 0) problems.push('执行设置尚未选择提供方');
  } else {
    const provider = providers.find((entry) => entry.id === worker.providerId);
    if (provider === undefined) {
      problems.push(`执行设置选择了未配置的提供方「${worker.providerId}」`);
    } else {
      const model = (provider.models ?? []).find((entry) => entry.id === worker.model);
      if (model === undefined) {
        problems.push(`执行设置的模型「${worker.model ?? '（空）'}」不在提供方「${provider.id}」的模型列表中`);
      } else if (worker.reasoningEffort != null && !(model.efforts ?? []).includes(worker.reasoningEffort)) {
        problems.push(`执行设置的推理强度「${worker.reasoningEffort}」不是模型「${model.id}」声明的能力`);
      }
    }
  }
  // `worker.timeoutSeconds` is LEGACY: the field is no longer offered, no longer
  // bounds an ordinary run, and the host normalizes a bad stored value instead of
  // refusing the document. So it is deliberately NOT prechecked here — refusing a
  // save over a value the page never shows would block the operator for something
  // they can neither see nor fix.
  const parallelism = Number(draft?.worker?.maxParallelism);
  if (!Number.isInteger(parallelism) || parallelism < LIMITS.maxParallelismMin || parallelism > LIMITS.maxParallelismMax) {
    problems.push(`最大并发需为 ${LIMITS.maxParallelismMin}–${LIMITS.maxParallelismMax} 之间的整数`);
  }
  // The RAW block, not the display-normalized one: a cleared field must be refused
  // here instead of silently becoming the documented default on save. The rules
  // themselves live in exactly one place — `precheckMonitoring` — so a field can never
  // be validated by the narrow monitoring button and forgotten by this whole-draft check
  // (which is what happened to the repeated-failure count).
  problems.push(...precheckMonitoring(monitoringDraftOf(draft)));
  // The new-task Agent Teams default must be a real boolean. A UI switch can only ever
  // produce one, so this only fires for a hand-edited or imported document — and the
  // host would refuse it too, which is why the page says so before sending.
  const teamDefault = executionOf(draft).agentTeamsDefault;
  if (typeof teamDefault !== 'boolean') {
    problems.push('「新任务默认开启智能体协作」只能是开启或关闭');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Task helpers
// ---------------------------------------------------------------------------

/**
 * Chinese label for a task state, falling back to the raw state.
 * @param {string} state - engine state.
 * @returns {string} label.
 */
export function taskStateLabel(state) {
  return TASK_STATE_LABELS[state] ?? String(state ?? '未知状态');
}

/**
 * Whether a task may still be cancelled.
 * @param {string} state - engine state.
 * @returns {boolean} true for non-terminal states.
 */
export function isCancellable(state) {
  return state === 'pending' || state === 'running';
}

/**
 * Chinese label for a task phase, falling back to the raw value.
 * @param {string} phase - engine phase.
 * @returns {string} label.
 */
export function taskPhaseLabel(phase) {
  if (typeof phase !== 'string' || phase === '') return '—';
  return TASK_PHASE_LABELS[phase] ?? phase;
}

/**
 * Whether a task is currently waiting for a per-call permission decision.
 *
 * Read from the task's own permission block when it is present and from the phase
 * otherwise (an older host reports only the phase). It is a WAIT, not a failure and
 * not an execution result, which is what the panel has to say.
 * @param {object} task - task view.
 * @returns {boolean} true when a decision is outstanding.
 */
export function isAwaitingPermission(task) {
  if (task?.permission?.waiting === true) return true;
  return task?.phase === 'awaiting-permission';
}

/**
 * The pending per-call permission request of one task, or `null`.
 * @param {object} task - task view.
 * @returns {object | null} the pending request.
 */
export function pendingPermission(task) {
  const pending = task?.permission?.pending ?? null;
  return pending !== null && typeof pending === 'object' ? pending : null;
}

/**
 * Whether the worker is waiting for an ORDINARY QUESTION answer.
 *
 * Kept separate from {@link isAwaitingPermission}: answering a question authorizes
 * nothing, so a UI must not present it as an approval card.
 * @param {object} task - task view.
 * @returns {boolean} true when a question is outstanding.
 */
export function isAwaitingQuestion(task) {
  if (task?.question?.waiting === true) return true;
  return task?.phase === 'awaiting-question';
}

/**
 * The pending ordinary question set of one task, or `null`.
 * @param {object} task - task view.
 * @returns {object | null} the pending question.
 */
export function pendingQuestion(task) {
  const pending = task?.question?.pending ?? null;
  return pending !== null && typeof pending === 'object' ? pending : null;
}

/**
 * One-line, plain-Chinese summary of what a task's permission state means.
 *
 * It never says "已批准" for a task, because a decision covers one call and not the
 * task: an `allow-once` is reported as "仅本次调用可继续", and a rejection as "该调用
 * 被拒绝", with the task itself still running.
 * @param {object} task - task view.
 * @returns {{ waiting: boolean, label: string, note: string, detail: string }} summary.
 */
export function permissionSummary(task) {
  const permission = task?.permission ?? null;
  const waiting = isAwaitingPermission(task);
  if (waiting) {
    const pending = pendingPermission(task);
    const tool = pending?.toolName ?? '未知工具';
    const access = pending?.requestedAccess?.mode;
    return {
      waiting: true,
      label: '等待本次调用授权决定',
      note: access === null || access === undefined
        ? `工作进程暂停在 ${tool} 这一次调用上，等待宿主端决定。任务仍在运行，未失败，也未完成。`
        : `工作进程暂停在 ${tool} 这一次调用上，请求把该次调用的沙箱权限提升到 ${access}，等待宿主端决定。`
          + '无论是否允许，会话的常规权限（workspace-write）保持不变。',
      detail: `请求编号 ${pending?.requestId ?? '—'} · 调用 ${pending?.callId ?? '—'}`,
    };
  }
  if (permission === null || permission === undefined) {
    return { waiting: false, label: '未使用逐次授权桥', note: '本次任务未挂载逐次授权桥：工作进程的提权请求会被直接拒绝，不会等待。', detail: '' };
  }
  const evidence = Array.isArray(permission.evidence) ? permission.evidence : [];
  if (evidence.length === 0) {
    return { waiting: false, label: '本次任务尚无授权请求', note: '暂无。请求出现时，该次调用会暂停，并在这里显示。', detail: '' };
  }
  const last = evidence[evidence.length - 1];
  const outcome = PERMISSION_OUTCOME_LABELS[last?.outcome] ?? last?.outcome ?? '未知结果';
  return {
    waiting: false,
    label: '最近一次决定',
    note: `最近一次调用授权请求：${outcome}。该决定只对那一次调用有效，不构成常规权限，也不会被后续调用复用。`,
    detail: `请求编号 ${last?.requestId ?? '—'}（共 ${evidence.length} 条记录）`,
  };
}

/**
 * A monitoring threshold in plain Chinese, for a settings summary.
 *
 * A threshold is not an elapsed span, so `0` is not "0 秒": it is the documented
 * "off" and must read as such, or a reader would conclude the reminder fires
 * instantly. Any other value is the ordinary duration (`formatDuration`).
 * @param {number | null | undefined} seconds - stored threshold.
 * @returns {string} Chinese description, or `—` for a value that is not a number.
 */
export function monitoringText(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds === 0) return '已关闭';
  return formatDuration(seconds * 1000);
}

/**
 * Human duration in plain Chinese, bounded to two units.
 *
 * Used for every elapsed span the task panels show ("12 秒", "4 分 12 秒",
 * "2 小时 5 分"). A negative or non-finite value is reported as unknown rather than
 * as a plausible-looking zero.
 * @param {number | null | undefined} ms - milliseconds.
 * @returns {string} Chinese duration, or `—`.
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} 分 ${totalSeconds % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

/**
 * The bounded activity block of a task, normalized for display.
 *
 * Returns `null` for a record that genuinely has none — including every task stored
 * before this feature existed. A caller must render "没有采集到" for `null` rather than
 * inventing a zero, because "no data" and "no activity" are different facts.
 * @param {object} task - task view (list or detail).
 * @returns {object | null} normalized activity, or null when the record has none.
 */
export function taskActivity(task) {
  const activity = task?.activity;
  if (activity === null || typeof activity !== 'object' || Array.isArray(activity)) return null;
  const tool = activity.currentTool;
  const selfCheck = activity.selfCheck;
  return {
    lastActivityAt: Number.isFinite(activity.lastActivityAt) ? activity.lastActivityAt : null,
    idleForMs: Number.isFinite(activity.idleForMs) ? activity.idleForMs : null,
    waitingOn: activity.waitingOn === 'tool' ? 'tool' : 'idle',
    currentTool: tool === null || typeof tool !== 'object'
      ? null
      : {
        name: typeof tool.name === 'string' && tool.name !== '' ? tool.name : '未知工具',
        callId: typeof tool.callId === 'string' ? tool.callId : null,
        startedAt: Number.isFinite(tool.startedAt) ? tool.startedAt : null,
        elapsedMs: Number.isFinite(tool.elapsedMs) ? tool.elapsedMs : null,
      },
    lastTool: activity.lastTool !== null && typeof activity.lastTool === 'object'
      ? { name: activity.lastTool.name ?? null, durationMs: Number.isFinite(activity.lastTool.durationMs) ? activity.lastTool.durationMs : null }
      : null,
    events: Number.isFinite(activity.events) ? activity.events : null,
    activityEvents: Number.isFinite(activity.activityEvents) ? activity.activityEvents : null,
    toolCallsStarted: Number.isFinite(activity.toolCallsStarted) ? activity.toolCallsStarted : null,
    toolCallsFinished: Number.isFinite(activity.toolCallsFinished) ? activity.toolCallsFinished : null,
    selfCheckSeconds: Number.isFinite(activity.selfCheckSeconds) ? activity.selfCheckSeconds : null,
    attentionSeconds: Number.isFinite(activity.attentionSeconds) ? activity.attentionSeconds : null,
    // The run progress check, in the same bounded terms the reminder itself uses: the
    // one time base (no progress for that long), whether this silence already produced a
    // report, and the context facts. Absent in a record written before the fields existed.
    progressCheck: activity.progressCheck !== null && typeof activity.progressCheck === 'object'
      ? {
        thresholdSeconds: Number.isFinite(activity.progressCheck.thresholdSeconds) ? activity.progressCheck.thresholdSeconds : null,
        idleForMs: Number.isFinite(activity.progressCheck.idleForMs) ? activity.progressCheck.idleForMs : null,
        reportedThisEpisode: activity.progressCheck.reportedThisEpisode === true,
        nextDueAt: Number.isFinite(activity.progressCheck.nextDueAt) ? activity.progressCheck.nextDueAt : null,
      }
      : null,
    selfCheck: selfCheck === null || typeof selfCheck !== 'object'
      ? null
      : {
        episode: Number.isFinite(selfCheck.episode) ? selfCheck.episode : null,
        checkedAt: Number.isFinite(selfCheck.checkedAt) ? selfCheck.checkedAt : null,
        verdict: typeof selfCheck.verdict === 'string' ? selfCheck.verdict : null,
      },
    finalizedAt: Number.isFinite(activity.finalizedAt) ? activity.finalizedAt : null,
    interrupted: activity.interrupted === true,
  };
}

/**
 * One plain-Chinese line describing what a running task is doing, from its activity.
 *
 * Rules the wording obeys:
 *
 *  * it never claims a percentage of completion — the plugin does not measure one;
 *  * an open tool call is described as a running tool with its OWN elapsed span,
 *    and the silence is stated separately, because a tool that emits nothing is
 *    still silence and may be reported as needing attention;
 *  * a task with no activity block (an older record, or one that never ran) is
 *    described as "未采集到进展信息", never as "空闲" or "正常".
 * @param {object} task - task view.
 * @returns {{ available: boolean, headline: string, detail: string, tone: 'off'|'on'|'warn' }} progress description.
 */
export function taskProgress(task) {
  const activity = taskActivity(task);
  // The headline must not contradict the task's own status badge. `taskOutcome` owns the
  // headline wording, so a recorded review (or a finished run) says THAT here instead of
  // repeating the raw phase label a second time.
  const outcome = taskOutcome(task);
  const phase = outcome.label;
  if (activity === null) {
    return {
      available: false,
      headline: `${phase} · 未采集到进展信息`,
      detail: '这条记录没有进展信息（可能是旧版本写入的记录，或任务尚未进入执行）。没有信息不等于没有进展，也不代表失败。',
      tone: 'off',
    };
  }
  const settled = typeof activity.finalizedAt === 'number';
  const idle = formatDuration(activity.idleForMs);
  const parts = [phase, `距上次进展 ${idle}`];
  if (activity.currentTool !== null) {
    parts.push(`正在运行 ${activity.currentTool.name}（已 ${formatDuration(activity.currentTool.elapsedMs)}）`);
  }
  const headline = parts.join(' · ');
  const detailParts = [];
  if (activity.currentTool !== null) {
    detailParts.push('有一个工具调用正在运行；它本身耗时较长不算失败，也不会让插件结束任务。');
  }
  if (activity.selfCheck !== null && activity.selfCheck.verdict !== null) {
    detailParts.push(`程序自检结论：${SELF_CHECK_LABELS[activity.selfCheck.verdict] ?? activity.selfCheck.verdict}`);
  }
  if (settled) {
    detailParts.push('任务已结束，这些时间不再变化。');
  } else if (task?.state === 'interrupted') {
    // A restart history: the record has no `finalizedAt` (it was written by a process
    // that then restarted), but the run will NOT resume. This branch exists because the
    // generic wording would otherwise promise progress that can never happen.
    detailParts.push('这条记录来自一次进程重启：任务已经中断，不会继续执行，也不会再有新的进展。');
  } else if (activity.attentionSeconds !== null && activity.attentionSeconds > 0) {
    detailParts.push(`连续 ${formatDuration(activity.attentionSeconds * 1000)} 没有新成果回传给派工方时会提醒一次运行进度检查；读到自检结论不算新成果，提醒只是提示，不会自动判失败。`);
  } else if (activity.attentionSeconds === 0) {
    detailParts.push('运行进度检查提醒已关闭。');
  }
  if (activity.activityEvents !== null && activity.events !== null) {
    detailParts.push(`已记录 ${activity.events} 个执行事件，其中 ${activity.activityEvents} 个是真实输出或工具活动——它们不算回传给派工方的成果。`);
  }
  return {
    available: true,
    headline,
    detail: detailParts.join(' '),
    tone: activity.currentTool !== null ? 'on' : (settled ? 'off' : 'on'),
  };
}

/**
 * Chinese labels for the managed MCP entry's stale owned facts (`mcp.drift`).
 *
 * A state name ("outdated") does not tell an operator what would change, so the panel
 * names each fact. An unknown one falls back to its own name rather than being hidden.
 */
export const CODEX_MCP_DRIFT_LABELS = Object.freeze({
  tool_timeout_sec: '缺少工具超时（部分客户端可能因此提前中断长时间等待）',
  args: '入口脚本路径已变化（插件已升级或移动）',
  command: 'command 仍是旧版写下的路径',
  env: '发现文件的环境变量与当前不一致',
});

/**
 * Describe an `outdated` MCP entry in the panel's terms.
 */
export function codexMcpDriftText(mcp) {
  const drift = Array.isArray(mcp?.drift) ? mcp.drift : [];
  if (drift.length === 0) return '托管 MCP 条目需要更新';
  return drift.map((key) => CODEX_MCP_DRIFT_LABELS[key] ?? key).join('；');
}

/**
 * Whether a task is still live, i.e. a bounded auto-refresh may still learn something.
 *
 * `pending` and `running` are the only states that can change on their own; every
 * other state is terminal and a refresh would only repeat the same bytes.
 * @param {object} task - task view.
 * @returns {boolean} true while the task may still progress.
 */
export function isLiveTask(task) {
  return task?.state === 'pending' || task?.state === 'running';
}

/**
 * Whether a task list contains any live task.
 * @param {object[]} tasks - task views.
 * @returns {boolean} true when at least one is pending or running.
 */
export function hasLiveTasks(tasks) {
  return Array.isArray(tasks) && tasks.some(isLiveTask);
}

/**
 * Whether a task's RECORD may still change, which is a wider question than "is it running".
 *
 * A finished run is terminal as an execution, but its record is not settled: it waits for
 * the host's review, and a review written by the commander can be mid-save. The page must
 * keep refreshing while any of that is true, or a conclusion written from outside appears
 * only after a manual reload — and it must stop once the conclusion is durable, or the page
 * polls a row that will never change again.
 * @param {object} task - task view.
 * @returns {boolean} true while the record may still change.
 */
export function isTaskRecordChanging(task) {
  if (isLiveTask(task)) return true;
  if (task?.state === 'awaiting-host-review') {
    // A stored conclusion still waiting for confirmation is not a fixed record yet.
    const persistence = task.reviewPersistence;
    if (persistence !== null && typeof persistence === 'object') return persistence.durable !== true;
    return task.hostAcceptance === null || task.hostAcceptance === undefined;
  }
  return task?.reviewPersistence?.pending === true;
}

/**
 * Whether any of these tasks has a record that may still change.
 * @param {object[]} tasks - task views.
 * @returns {boolean} true when a refresh could still learn something.
 */
export function hasChangingRecords(tasks) {
  return Array.isArray(tasks) && tasks.some(isTaskRecordChanging);
}

/**
 * Pre-flight checks for the two no-progress thresholds AND the repeated-failure count.
 *
 * Mirrors `validateMonitoringSettings`. Kept separate because the monitoring block has
 * its own rules: a bad timer must not block saving the rest of the settings, and a bad
 * provider block must not block saving a timer.
 *
 * The block passed in must be the RAW one (`monitoringDraftOf`), not the display-normalized
 * `monitoringOf`: the latter replaces a cleared field with the documented default, which
 * would make an empty input look valid. This is the single validation path — `precheckDraft`
 * and the monitoring card both delegate here, so no field can be checked in one place
 * and forgotten in another.
 *
 * Backwards compatible with an older document or an older host that has no
 * `repeatFailureThreshold` at all: an ABSENT value takes the documented default, exactly as
 * the host validator does. A value that is present but wrong is still refused. `0` is
 * ALWAYS valid for either duration and for the count — it is the documented "off" — so
 * only a missing or non-numeric value is an error there.
 * @param {{ selfCheckSeconds: number, attentionSeconds: number, repeatFailureThreshold?: number }} monitoring - raw block.
 * @returns {string[]} Chinese problem descriptions; empty when plausible.
 */
export function precheckMonitoring(monitoring) {
  const problems = [];
  const self = monitoring?.selfCheckSeconds;
  const attention = monitoring?.attentionSeconds;
  // An ABSENT count is not an operator error: a document written before the setting
  // existed has no such key, and the host fills in the documented default. Anything the
  // operator actually supplied — `''`, `null`, a fraction, an out-of-range number — is
  // validated exactly as given. There is deliberately no `Number()` coercion and no
  // rounding, so nothing is "repaired" into a value nobody chose.
  const repeat = monitoring?.repeatFailureThreshold === undefined
    ? MONITORING_DEFAULTS.repeatFailureThreshold
    : monitoring.repeatFailureThreshold;
  if (!Number.isInteger(self) || self < LIMITS.selfCheckSecondsMin || self > LIMITS.selfCheckSecondsMax) {
    problems.push(`程序自检间隔需为 ${LIMITS.selfCheckSecondsMin}–${LIMITS.selfCheckSecondsMax} 秒之间的整数（0 表示关闭）`);
  }
  if (!Number.isInteger(attention) || attention < LIMITS.attentionSecondsMin || attention > LIMITS.attentionSecondsMax) {
    problems.push(`运行进度检查间隔需为 ${LIMITS.attentionSecondsMin}–${LIMITS.attentionSecondsMax} 秒之间的整数（0 表示关闭）`);
  }
  // The ordering rule applies only when BOTH reminders are on: a disabled threshold has
  // no instant of its own, so it can never be "too early".
  if (Number.isInteger(self) && Number.isInteger(attention) && self > 0 && attention > 0 && attention <= self) {
    problems.push('运行进度检查间隔必须大于程序自检间隔（或把其中一项设为 0 关闭）');
  }
  // The repeated-failure reminder is a COUNT of consecutive identical failures; `0` is a
  // legal "off" value, so the range starts at zero rather than at one.
  if (!Number.isInteger(repeat)
    || repeat < LIMITS.repeatFailureThresholdMin
    || repeat > LIMITS.repeatFailureThresholdMax) {
    problems.push(`重复失败提醒次数需为 ${LIMITS.repeatFailureThresholdMin}–${LIMITS.repeatFailureThresholdMax} 之间的整数（0 表示关闭）`);
  }
  return problems;
}

/**
 * Honest execution/acceptance summary for one task — the ONE source of a task's headline.
 *
 * The engine reports `awaiting-host-review` after successful execution. That is NOT
 * acceptance: `selfApproved` is always false, and only a recorded host decision with
 * `accepted === true` counts. A recorded `changes-requested` is a real conclusion too —
 * "reviewed and needs correction" — and must never read as accepted.
 *
 * `label` is what a list or a detail header shows INSTEAD of the raw state, so a task with
 * a recorded conclusion never keeps reading "等待宿主审查". The underlying `state` is
 * untouched (older clients and `continueFromTaskId` depend on it); this is presentation
 * only.
 * @param {object} task - task view.
 * @returns {{ label: string, tone: string, executed: boolean, accepted: boolean, decided: boolean,
 *   phaseLabel: string | null, note: string }} summary. `phaseLabel` is `null` when the
 *   phase would repeat the label.
 */
export function taskOutcome(task) {
  const state = String(task?.state ?? '');
  const acceptance = task?.hostAcceptance;
  const persistence = task?.reviewPersistence;
  // Only an explicit `accepted === true` is acceptance. The presence of an object is NOT
  // enough: a `changes-requested` record is also an object — and neither is a conclusion
  // that is still being written, which is why a non-durable record is not `decided`.
  const decided = (acceptance !== null && acceptance !== undefined)
    && (persistence === null || persistence === undefined || persistence.durable !== false);
  const accepted = decided && acceptance?.accepted === true;
  const executed = state === 'awaiting-host-review' || decided;
  let label;
  let tone;
  let note;
  let phaseLabel;
  // A conclusion that is being written, or whose write was never confirmed, is its OWN
  // state: the page must not claim 审查通过 before the record is durable, and must not
  // hide a pending decision behind "等待宿主审查".
  const saving = persistence?.pending === true;
  const failedWrite = persistence?.state === 'failed';
  if (accepted) {
    label = '审查通过';
    tone = 'on';
    note = '宿主已记录验收结论：审查通过。';
    // The run is over AND reviewed, so the phase would only repeat itself.
    phaseLabel = null;
  } else if (decided) {
    label = '需要修正';
    tone = 'warn';
    note = '宿主已记录验收结论：需要修正（本任务的执行结果未被接受）。';
    phaseLabel = null;
  } else if (saving) {
    label = persistence.state === 'timed-out' ? '审查结论保存未确认' : '审查结论保存中';
    tone = 'warn';
    note = persistence.state === 'timed-out'
      ? '审查结论已发出但尚未确认写入；插件会继续读取同一任务直到确认，不要重新派工。'
      : '审查结论正在写入，确认保存后才会显示审查通过或需要修正。';
    phaseLabel = null;
  } else if (failedWrite) {
    label = '审查结论保存失败';
    tone = 'warn';
    note = '审查结论未能写入，未记录为已验收；可对同一任务重试。';
    phaseLabel = null;
  } else if (state === 'awaiting-host-review') {
    label = '等待宿主审查';
    tone = 'warn';
    note = '执行已完成，等待宿主端审查；插件不会自行验收。';
    // Stated once, as the headline above; a second identical phase badge is noise.
    phaseLabel = null;
  } else if (state === 'failed') {
    label = taskStateLabel(state);
    tone = 'warn';
    note = '执行失败；错误详情见下方证据。';
    phaseLabel = null;
  } else if (state === 'cancelled') {
    label = taskStateLabel(state);
    tone = 'off';
    note = '任务已取消，未产生验收结论。';
    phaseLabel = null;
  } else {
    label = taskStateLabel(state);
    tone = state === 'running' ? 'on' : 'off';
    note = '任务尚未产生结果。';
    // A live run DOES keep a distinct phase badge: it says what is happening right now,
    // which the state label does not. That is information, not a contradiction.
    phaseLabel = taskPhaseLabel(task?.phase);
  }
  return { label, tone, executed, accepted, decided, phaseLabel, note };
}

/**
 * The host-review badge for one task, or `null` when the headline already says it.
 *
 * `taskOutcome(...).label` is the primary status; this exists so a caller that wants a
 * SEPARATE review badge gets exactly the same wording and tone rather than a second,
 * possibly contradictory, string. It returns `null` whenever the headline already carries
 * the review state, which is what keeps "等待审查" from appearing twice — or alongside
 * "审查通过".
 * @param {object} task - task view.
 * @returns {{ label: string, tone: string } | null} badge, or null to show nothing.
 */
export function hostReviewBadge(task) {
  const acceptance = task?.hostAcceptance;
  if (acceptance === null || acceptance === undefined) return null;
  // Derive from the same helper, so the two can never disagree.
  const { label, tone } = taskOutcome(task);
  return { label, tone };
}

/**
 * A task's recorded review conclusion as one SHORT display line.
 *
 * This line carries the conclusion and its time — nothing else. The note BODY deliberately
 * does not appear here: this row sits beside the detail's own "完整审查意见" block, which
 * renders the saved text whole. Splicing a bounded cut of it in here produced a second,
 * truncated copy that read as if the stored text itself had been cut (the misleading
 * "已截断" line G10 fixes).
 *
 * The wording comes from `taskOutcome(...)` and only from there, so this row can never
 * claim a conclusion the headline contradicts — notably `accepted: true` with a review
 * record that is not durable yet (a save in flight, a timed-out unconfirmed write, a
 * failed one). A record written before `reviewPersistence` existed keeps the old
 * compatibility meaning (stored), which is again exactly what `taskOutcome` decides.
 * @param {object} task - task view.
 * @param {(at: number) => string} formatTime - time formatter from the page.
 * @returns {string} display text.
 */
export function hostReviewLine(task, formatTime) {
  const outcome = taskOutcome(task);
  const acceptance = task?.hostAcceptance;
  if (acceptance === null || acceptance === undefined) {
    // Nothing recorded. A write that is pending or already failed is its own state, and
    // `taskOutcome` has already named it — repeating that here would say it twice.
    const persistence = task?.reviewPersistence;
    if (persistence?.pending === true || persistence?.state === 'failed') return outcome.label;
    return '未记录（插件不会自行验收）';
  }
  const at = typeof acceptance.acceptedAt === 'number' ? `（${formatTime(acceptance.acceptedAt)}）` : '';
  // Only a CONFIRMED record is described as saved; an unconfirmed write keeps its own
  // label and never borrows this suffix.
  return outcome.decided ? `${outcome.label}${at}（结论已保存）` : `${outcome.label}${at}`;
}

/**
 * Length of a review note in Unicode code points.
 * @param {unknown} value - note.
 * @returns {number} code-point count (0 for a non-string).
 */
export function reviewNoteChars(value) {
  return typeof value === 'string' ? Array.from(value).length : 0;
}

/** How many code points of a review note a LIST shows. */
export const REVIEW_NOTE_PREVIEW_CHARS = 200;

/**
 * The list preview of a recorded review note, and whether the whole note is longer.
 *
 * The preview is a display cut of the SAVED body: the body itself is never shortened (that
 * is a storage rule), and `truncated` tells the page to offer the full text.
 * @param {object} task - task view.
 * @returns {{ text: string, chars: number, truncated: boolean, omitted: boolean } | null} preview.
 */
export function reviewNotePreview(task) {
  const acceptance = task?.hostAcceptance;
  if (acceptance === null || acceptance === undefined) return null;
  // A note read back from a compact answer is stated as omitted: the text exists, the
  // answer does not carry it, so the page must offer the full read instead of "no note".
  if (acceptance.noteOmitted === true && typeof acceptance.note !== 'string') {
    const chars = Number.isFinite(acceptance.noteChars) ? acceptance.noteChars : 0;
    return { text: '', chars, truncated: chars > 0, omitted: true };
  }
  const note = typeof acceptance.note === 'string' ? acceptance.note : '';
  const all = Array.from(note);
  return {
    text: all.slice(0, REVIEW_NOTE_PREVIEW_CHARS).join(''),
    chars: all.length,
    truncated: all.length > REVIEW_NOTE_PREVIEW_CHARS,
    omitted: false,
  };
}

/**
 * How often the page refreshes while a record may still change, in milliseconds.
 *
 * Kept here rather than in the page so the hook and the page share one number.
 */
export const RECORD_REFRESH_INTERVAL_MS = 5000;

/**
 * How often a visible records page re-reads the list when NO record may change.
 *
 * This is the case that used to stop polling entirely, and it left an open page unable to
 * notice a task submitted from outside (Codex dispatching while the operator watches): an
 * empty list stays empty, and a page full of settled records stays settled, until the
 * operator reloads. The idle read is a plain read of the same list — no model call, no
 * task action, no settings write — so it is bounded and deliberately slower than the
 * active rate: a task that started elsewhere shows up within this interval, while an idle
 * page does not hammer the host.
 */
export const RECORD_IDLE_REFRESH_INTERVAL_MS = 15000;

/**
 * Which rate a visible records page is polling at, or `null` when it must not poll.
 *
 * Three answers, because the page has three states:
 *   * `active`  — a record may still change (running, awaiting review, conclusion being
 *                 written): read quickly, so a conclusion appears without a reload;
 *   * `idle`    — nothing of ours may change: keep a SLOW read so a task submitted from
 *                 outside the page is still discovered;
 *   * `null`    — do not poll: the document is hidden, the records page is not open, or a
 *                 read is already in flight.
 * @param {object} input - `tasks`, `selectedTask`, `visible`, `mounted`, `loading`.
 * @returns {'active' | 'idle' | null} the polling mode.
 */
export function recordRefreshMode(input = {}) {
  // Off the records page or hidden: nothing is watching, so nothing is read. Checked before
  // the in-flight case so an unmounted page reports "not polling" rather than "busy".
  if (input.mounted === false) return null;
  if (input.visible === false) return null;
  // One request at a time: a read already in flight owns the next tick.
  if (input.loading === true) return null;
  const all = [];
  if (Array.isArray(input.tasks)) all.push(...input.tasks);
  if (input.selectedTask !== null && input.selectedTask !== undefined) all.push(input.selectedTask);
  return hasChangingRecords(all) ? 'active' : 'idle';
}

/**
 * The refresh decision for one render of the task view.
 *
 * Separates "is the execution running" (a status display question) from "may the RECORD
 * still change" (a polling question): a task waiting for review, or a review mid-save,
 * keeps the page at the ACTIVE rate even though nothing is executing, and a settled list
 * drops to the IDLE rate instead of stopping. Only a hidden page, an unopened records page
 * or an in-flight read suppresses the next tick.
 * @param {object} input - `tasks`, `selectedTask`, `visible`, `mounted`, `loading`.
 * @returns {{ refresh: boolean, intervalMs: number, reason: string }} plan.
 */
export function recordRefreshPlan(input = {}) {
  const mode = recordRefreshMode(input);
  if (mode === null) {
    // The reason distinguishes the three suppression cases for the page and for tests.
    if (input.mounted === false) return { refresh: false, intervalMs: RECORD_REFRESH_INTERVAL_MS, reason: 'unmounted' };
    if (input.visible === false) return { refresh: false, intervalMs: RECORD_REFRESH_INTERVAL_MS, reason: 'hidden' };
    return { refresh: false, intervalMs: RECORD_REFRESH_INTERVAL_MS, reason: 'loading' };
  }
  if (mode === 'active') {
    return { refresh: true, intervalMs: RECORD_REFRESH_INTERVAL_MS, reason: 'changing' };
  }
  return { refresh: true, intervalMs: RECORD_IDLE_REFRESH_INTERVAL_MS, reason: 'idle' };
}

/**
 * The next read of a visible records surface: when to do it, and why not.
 *
 * ONE plan for every surface that shows the shared task records — the records page
 * and the sidebar's TaskBridge view alike — so an open list that is waiting for a
 * task dispatched from OUTSIDE (Codex, an MCP host) is discovered by both, on the same
 * bounded rates, instead of each surface inventing its own policy:
 *
 *   * the first read after mount is IMMEDIATE (`delayMs: 0`): a panel that opens on an
 *     empty list must not wait a whole idle interval to learn whether anything exists;
 *   * afterwards the ACTIVE rate applies while a record may still change, and the IDLE
 *     rate otherwise — both plain list reads, no model call and no task action. An
 *     already-loaded surface uses those rates from its very first tick (the immediate
 *     read only happens when nothing has been read yet: `loading === false` marks that);
 *   * a hidden document, an unmounted surface or a read already in flight schedules
 *     nothing, and the surface re-checks when it becomes visible again.
 * @param {object} input - `tasks`, `selectedTask`, `visible`, `mounted`, `loading`,
 *   `first` (true for the read right after mount).
 * @returns {{ refresh: boolean, delayMs: number | null, intervalMs: number, reason: string }} plan.
 */
export function nextRecordsRead(input = {}) {
  if (input.mounted === false) return { refresh: false, delayMs: null, intervalMs: RECORD_REFRESH_INTERVAL_MS, reason: 'unmounted' };
  if (input.visible === false) return { refresh: false, delayMs: null, intervalMs: RECORD_REFRESH_INTERVAL_MS, reason: 'hidden' };
  if (input.loading === true) return { refresh: false, delayMs: null, intervalMs: RECORD_REFRESH_INTERVAL_MS, reason: 'loading' };
  if (input.first === true && input.hydrated !== true) {
    return { refresh: true, delayMs: 0, intervalMs: RECORD_REFRESH_INTERVAL_MS, reason: 'initial' };
  }
  const plan = recordRefreshPlan(input);
  return { refresh: plan.refresh, delayMs: plan.refresh ? plan.intervalMs : null, intervalMs: plan.intervalMs, reason: plan.reason };
}

/**
 * Drive the records reads of ONE live surface for as long as it stays mounted.
 *
 * The single loop behind both surfaces that show the shared task records (the records
 * page and the sidebar's TaskBridge view). It reads through `store.refreshTasks`, so
 * the two surfaces never issue duplicate requests for the same store, it never reads a
 * row on its own, and it stops completely on dispose:
 *
 *   * the first read is scheduled at once (an empty panel must not sit empty for a
 *     whole interval while a task is waiting to be discovered);
 *   * each read is followed by exactly ONE timer at the planned rate, re-planned from
 *     the CURRENT snapshot passed in `readState()` so the rate follows the records;
 *   * a hidden document pauses the loop, and becoming visible reads once immediately;
 *   * an in-flight read owns the next tick (the plan returns `refresh: false`).
 *
 * Nothing here runs during render: a caller starts it from an effect and disposes it
 * with that effect's cleanup.
 * @param {object} options - `store` (with `refreshTasks`), `readState()` returning
 *   `{ tasks, selectedTask, loading }`, `visible()` (default: document not hidden),
 *   `onError(messageOrNull)`, `onRead()` (called after every attempt).
 * @returns {() => void} disposer: cancels the timer, drops the listener and never reads again.
 */
export function startRecordsReadLoop(options = {}) {
  const store = options?.store ?? null;
  if (store === null || typeof store.refreshTasks !== 'function') return () => {};
  const doc = globalThis.document;
  const visible = typeof options.visible === 'function'
    ? options.visible
    : () => doc?.hidden !== true;
  const readState = typeof options.readState === 'function' ? options.readState : () => ({});
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const onRead = typeof options.onRead === 'function' ? options.onRead : () => {};

  let timer = null;
  let disposed = false;
  let inFlight = false;
  let first = true;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clearTimer();
    if (disposed) return;
    const plan = nextRecordsRead({ ...readState(), mounted: true, visible: visible(), first });
    if (!plan.refresh || plan.delayMs === null) return;
    first = false;
    // NO `unref()`: this timer is the surface's own life. Unref'd, a process whose only
    // pending work was this tick (DSH's web host, a Node-driven host) would be free to
    // exit the moment its last request finished — and the panel would silently stop
    // noticing anything until the operator clicked. Disposal ends it explicitly.
    timer = setTimeout(tick, plan.delayMs);
  };
  const read = async () => {
    if (disposed || inFlight) return;
    inFlight = true;
    try {
      const result = await store.refreshTasks('auto');
      if (disposed || result?.skipped === 'in-flight') return;
      onError(result?.ok === false ? (result.error ?? true) : null);
      onRead(result);
    } catch (error) {
      if (!disposed) onError(error);
    } finally {
      inFlight = false;
      schedule();
    }
  };
  const tick = () => {
    timer = null;
    if (disposed || visible() !== true) return;
    void read();
  };
  const onVisibility = () => {
    clearTimer();
    if (disposed) return;
    if (visible() !== true) return;
    // Back in view: read now rather than waiting out the remainder of an interval.
    first = true;
    void read();
  };

  doc?.addEventListener?.('visibilitychange', onVisibility);
  schedule();
  return () => {
    disposed = true;
    clearTimer();
    doc?.removeEventListener?.('visibilitychange', onVisibility);
  };
}

/**
 * Discoverable changed-file list in a task's diff payload.
 *
 * The engine's `diff.files` entries carry `{ code, path, from, status, sensitive }`;
 * older or partial payloads may carry plain strings instead. Anything else
 * returns `null`, and the page then shows the bounded raw diff rather than
 * inventing a summary.
 * @param {object} task - task view.
 * @returns {string[] | null} one display line per changed file, or null.
 */
export function changedFiles(task) {
  const candidates = [task?.diff?.files, task?.diff?.changedFiles, task?.changedFiles];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const files = [];
    for (const entry of candidate) {
      if (typeof entry === 'string') {
        if (entry !== '') files.push(entry);
        continue;
      }
      const path = entry?.path ?? entry?.file;
      if (typeof path !== 'string' || path === '') continue;
      const code = typeof entry?.status === 'string' && entry.status !== ''
        ? entry.status
        : (typeof entry?.code === 'string' && entry.code !== '' ? entry.code : null);
      const from = typeof entry?.from === 'string' && entry.from !== '' ? entry.from : null;
      const label = from === null ? path : `${from} → ${path}`;
      // A withheld file is flagged rather than hidden: the operator must be able
      // to see that something changed without seeing its content.
      const mark = entry?.sensitive === true ? '（内容已扣留）' : '';
      files.push(code === null ? `${label}${mark}` : `${code} ${label}${mark}`);
    }
    if (files.length > 0) return files;
  }
  return null;
}

/**
 * Bounded, single-line-safe text for a monospace block.
 * @param {unknown} value - any server text.
 * @param {number} [max] - maximum characters kept.
 * @returns {string} text.
 */
export function boundedText(value, max = 20_000) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text;
}

/**
 * Format a millisecond timestamp for display.
 * @param {number | null | undefined} value - epoch milliseconds.
 * @returns {string} local time, or an em dash.
 */
export function formatTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return new Date(value).toISOString();
  }
}

/**
 * State of one grant, derived from its four timestamps.
 * @param {object} grant - grant view.
 * @param {number} now - current epoch milliseconds.
 * @returns {{ key: string, label: string }} state.
 */
export function grantState(grant, now = Date.now()) {
  if (grant?.revokedAt !== null && grant?.revokedAt !== undefined) return { key: 'revoked', label: '已撤销' };
  if (grant?.consumedAt !== null && grant?.consumedAt !== undefined) return { key: 'consumed', label: '已使用（单次授权已用完）' };
  if (typeof grant?.expiresAt === 'number' && grant.expiresAt <= now) return { key: 'expired', label: '已过期' };
  return { key: 'live', label: '有效' };
}

/**
 * Chinese, actionable description of one failure.
 * @param {unknown} error - `ApiError` or anything else.
 * @returns {string} message with the stable code appended for support purposes.
 */
export function describeError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const messages = {
    USER_PLANE_UNREACHABLE: '无法连接宿主设置接口：请确认 DSH 网页仍在运行，并刷新页面后重试。',
    USER_PLANE_MALFORMED: '宿主返回了无法识别的内容。',
    TASK_DISPLAY_NOT_ACCEPTED: '任务通过验收后才能归档。',
    TASK_DISPLAY_NOT_FOUND: '任务已不在当前历史中，请刷新。',
    TASK_DISPLAY_UNAVAILABLE: '归档暂不可用，请刷新后再试。',
    TASK_DISPLAY_LIMIT: '归档记录已达上限，请恢复部分记录后再试。',
    SETTINGS_MISSING: '请求中没有设置文档。',
    SETTINGS_INVALID: '设置内容不合法，已保留你的草稿。',
    SETTINGS_NO_PROVIDERS: '至少需要配置一个提供方。',
    SETTINGS_SCHEMA_UNSUPPORTED: '设置文档版本不被当前插件支持。',
    PROVIDER_ID_INVALID: '提供方标识格式不合法。',
    PROVIDER_NAME_INVALID: '提供方显示名称不合法。',
    PROVIDER_BASE_URL_INVALID: '接口地址不合法（需为 http/https，且不得包含账号密码、查询串或片段）。',
    PROVIDER_CREDENTIAL_REF_INVALID: '凭据引用名不合法（需为环境变量风格名称）。',
    PROVIDER_PROTOCOL_UNSUPPORTED: '该协议当前不受支持。',
    PROVIDER_SECRET_IN_SETTINGS: '设置文档中不能包含密钥；请使用单独的凭据输入框。',
    PROVIDER_DUPLICATE: '提供方标识重复。',
    PROVIDER_IN_USE: '该提供方仍被当前设置引用，无法删除。',
    MODEL_INVALID: '模型条目不合法。',
    MODEL_DUPLICATE: '模型 ID 重复。',
    MODEL_EFFORTS_INVALID: '模型的推理强度声明不合法。',
    SELECTION_PROVIDER_REQUIRED: '请选择提供方。',
    SELECTION_PROVIDER_UNKNOWN: '所选提供方未配置。',
    SELECTION_MODEL_REQUIRED: '请选择模型。',
    SELECTION_MODEL_UNKNOWN: '所选模型不在该提供方的模型列表中。',
    SELECTION_EFFORT_UNKNOWN: '推理强度取值不存在。',
    SELECTION_EFFORT_UNSUPPORTED: '该模型未声明此推理强度。',
    WORKER_TIMEOUT_INVALID: '超时时间超出允许范围。',
    WORKER_PARALLELISM_INVALID: '最大并发超出允许范围。',
    WORKER_ISOLATION_INVALID: '工作区隔离方式不受支持。',
    AUTHORIZATION_INVALID: '授权有效期取值不合法。',
    PRESET_INVALID: '预设内容不合法。',
    PRESET_DUPLICATE: '预设标识重复。',
    PROJECT_OVERRIDE_INVALID: '项目覆盖内容不合法。',
    PROJECT_OVERRIDE_DUPLICATE: '同一项目存在重复覆盖。',
    CONNECTION_ID_REQUIRED: '缺少连接标识。',
    CONNECTION_UNKNOWN: '该连接不存在或已失效。',
    CONNECTION_LIMIT: '连接数量已达上限，请先撤销不用的连接。',
    GRANT_ID_REQUIRED: '缺少授权标识。',
    GRANT_UNKNOWN: '该授权不存在。',
    GRANT_KIND_INVALID: '授权范围不合法。',
    GRANT_TTL_INVALID: '授权有效期不合法。',
    GRANT_LIMIT: '授权数量已达上限。',
    GRANT_MISMATCH: '该授权不适用于当前连接或工作区。',
    JOB_TASK_NOT_FOUND: '任务不存在或已被清理。',
    PROVIDER_ID_REQUIRED: '请选择一个提供方。',
    PROVIDER_UNKNOWN: '该提供方不在当前设置中，请先保存配置文件。',
    PROVIDER_CREDENTIAL_REF_MISSING: '该提供方未声明凭据引用名，无法保存密钥；请先在提供方设置中填写引用名。',
    CREDENTIAL_EMPTY: '请先输入密钥内容。',
    CREDENTIAL_VALUE_REQUIRED: '请先输入密钥内容；如需删除请使用「清除密钥」。',
    CREDENTIAL_VALUE_TOO_LARGE: '密钥内容超出长度上限。',
    CREDENTIAL_OPERATION_FAILED: '宿主凭据服务拒绝了本次操作。',
    CREDENTIAL_READ_ONLY: '该凭据引用为只读（由外部环境提供），无法在此修改。',
    CREDENTIAL_REF_INVALID: '凭据引用名不合法。',
    CREDENTIAL_SEAM_UNAVAILABLE: '当前宿主尚未提供凭据写入接口，密钥无法保存。',
    ROUTING_PROVIDER_NOT_REGISTERED: '该提供方尚未注册到宿主模型路由中。',
    ROUTING_MODEL_UNRESOLVED: '该模型无法在宿主模型路由中解析。',
    ROUTING_EFFORT_UNSUPPORTED: '该模型不支持所选推理强度。',
    ROUTING_SERVICE_UNAVAILABLE: '宿主模型服务当前不可用。',
    // Remote model discovery: each code is a different fix, so each gets its own
    // sentence. None of them can quote the endpoint, the credential or the body.
    DISCOVERY_PROVIDER_UNKNOWN: '未找到该提供方配置。',
    DISCOVERY_BASE_URL_INVALID: '接口地址不可用于获取模型列表（需为 http/https，且不含账号密码、查询串或片段）。',
    DISCOVERY_CREDENTIAL_REF_MISSING: '该提供方未设置凭据引用名，无法向提供方取模型；请先填写引用名并保存。',
    DISCOVERY_CREDENTIAL_SEAM_UNAVAILABLE: '当前宿主未提供凭据服务，无法带上密钥向提供方取模型。',
    DISCOVERY_CREDENTIAL_UNAVAILABLE: '宿主凭据服务无法读取该引用名对应的密钥。',
    DISCOVERY_CREDENTIAL_NOT_CONFIGURED: '该凭据引用名尚未保存密钥，请先在「密钥」处保存。',
    DISCOVERY_CREDENTIAL_EMPTY: '该凭据引用名的密钥内容为空，请重新保存。',
    DISCOVERY_AUTH_REFUSED: '提供方拒绝了该密钥（401/403）：请确认密钥是否有效、是否属于该接口地址。',
    DISCOVERY_HTTP_ERROR: '提供方返回了错误状态码；详情见上方诊断。',
    DISCOVERY_REDIRECT_REFUSED: '提供方返回了重定向，为保护密钥没有跟随；请直接填写最终接口地址。',
    DISCOVERY_NETWORK_FAILED: '无法连接提供方接口地址：请检查地址、端口与网络。',
    DISCOVERY_TIMEOUT: '提供方在规定时间内没有响应，请稍后重试。',
    DISCOVERY_CANCELLED: '获取模型的请求已被取消。',
    DISCOVERY_MALFORMED_RESPONSE: '提供方返回的内容不是可识别的模型列表（需要 OpenAI 兼容的 {"data":[{"id":...}]}）。',
    DISCOVERY_BODY_TOO_LARGE: '提供方返回的内容超过大小上限，已中止读取。',
    USER_PLANE_METHOD_NOT_ALLOWED: '该请求方法不被允许。',
    // Task-record cleanup. Each code names a different fix, and none of them removed a
    // record: a refusal is whole-batch.
    CLEANUP_INVALID: '清理请求不完整或超出范围，未删除任何记录。',
    CLEANUP_CHAIN_NOT_FOUND: '所选执行链已不在当前记录中，未删除任何记录；请刷新后重新选择。',
    CLEANUP_STALE: '任务记录已变化，所选轮次与当前记录不一致，未删除任何记录；请刷新后重新选择。',
    CLEANUP_CHAIN_LIVE: '所选执行链仍在执行或尚未结束，未删除任何记录。',
    CLEANUP_NOT_DURABLE: '所选记录尚未写入或未正常结束，未删除任何记录。',
    CLEANUP_NEXT_ROUND: '所选执行链还有后续续接轮次，未删除任何记录；请把整条链一起选中。',
    CLEANUP_PLAN_CHILDREN: '所选执行链下还有规划子节点，未删除任何记录；请先处理这些子节点。',
    CLEANUP_HIERARCHY_CHILDREN: '仍有子任务依赖这条记录，未删除任何记录。',
    CLEANUP_REVIEW_WRITE: '该任务的审查意见正在写入，未删除任何记录；请稍后重试。',
    CLEANUP_UNAVAILABLE: '当前宿主不提供记录清理能力（或记录暂时无法读取），未删除任何记录。',
    CLEANUP_FAILED: '记录写入失败，未删除任何记录；旧记录仍会显示。',
    CODEX_INTEGRATION_UNAVAILABLE: '当前宿主未提供 Codex 集成接口。',
    CODEX_HOME_INVALID: 'Codex 配置目录路径不合法（必须为绝对路径）。',
    CODEX_ACTION_INVALID: '不支持的 Codex 集成操作。',
    CODEX_CONFIG_UNSUPPORTED: 'Codex 配置文件存在冲突或不受支持的格式，插件未改动。',
    ANTIGRAVITY_INTEGRATION_UNAVAILABLE: '当前宿主未提供 Antigravity 集成接口。',
    ANTIGRAVITY_HOME_INVALID: 'Antigravity 配置目录路径不合法（必须为绝对路径）。',
    ANTIGRAVITY_HOME_UNUSABLE: 'Antigravity 配置目录不可用（非普通目录或链接无法解析）。',
    ANTIGRAVITY_ACTION_INVALID: '不支持的 Antigravity 集成操作。',
    ANTIGRAVITY_PATH_CONFLICT: 'Antigravity 插件目录存在冲突或符号链接边界，插件未写入。',
  };
  const known = messages[code];
  if (known !== undefined) return `${known}（${code}）`;
  if (code.startsWith('HTTP_')) return `宿主返回 ${code.slice(5)}，请刷新后重试。`;
  const detail = typeof error?.message === 'string' && error.message !== '' ? error.message.slice(0, 200) : '未知错误';
  return code === '' ? detail : `${detail}（${code}）`;
}

// ---------------------------------------------------------------------------
// Task tree: the host's projection, read as data (never re-derived here)
// ---------------------------------------------------------------------------

/**
 * Chinese label for one projected node status.
 *
 * These are the host's own status keys (`src/jobs/task-tree.js`). The page maps the
 * key to a word; it never invents a status, and an unknown key is shown verbatim so
 * a newer host degrades to a readable string instead of a blank.
 */
export const TREE_STATUS_LABELS = Object.freeze({
  planned: '计划中（尚未执行）',
  running: '执行中',
  'awaiting-permission': '等待逐次授权',
  'awaiting-question': '等待回答问题',
  'awaiting-host-review': '等待宿主审查',
  'changes-requested': '需要修正',
  accepted: '审查通过',
  'children-accepted': '子项均已通过，等待汇总审查',
  'in-progress': '进行中',
  failed: '已失败',
  cancelled: '已取消',
  interrupted: '已中断',
  unknown: '状态未知',
});

/** Badge tone for one projected node status. */
export const TREE_STATUS_TONES = Object.freeze({
  accepted: 'on',
  running: 'on',
  planned: 'off',
  'children-accepted': 'warn',
  'in-progress': 'off',
  'awaiting-host-review': 'warn',
  'awaiting-permission': 'warn',
  'awaiting-question': 'warn',
  'changes-requested': 'warn',
  failed: 'warn',
  cancelled: 'off',
  interrupted: 'warn',
  unknown: 'off',
});

/** How a broken relation is described, in the operator's own terms. */
export const TREE_ORPHAN_LABELS = Object.freeze({
  'missing-parent': '父节点不在当前记录中，暂列在此',
  'missing-plan-node': '计划节点不在当前记录中，暂列在此',
  'cycle-broken': '检测到父节点环路，已在此处断开',
});

/**
 * The tree as the page should render it, or `null` when there is nothing to draw.
 *
 * Two inputs are accepted, both from the host: the structured `tree` (with `roots`)
 * and the flat `tree` (`flatNodes` only). The flat form is not re-parented — doing
 * that in the browser would be exactly the relation guessing the projection
 * exists to prevent — it only ORDERs the host's own `depth` values per `nodeId`,
 * and every identity still comes from the host.
 *
 * A host that answered no tree at all (an older version) yields `null`, and the
 * caller falls back to the flat list. An EMPTY tree is a real answer and is
 * reported separately (`roots: []` with counts), so "nothing planned yet" never
 * reads like "this host cannot show plans".
 *
 * `cleanupAvailable`/`cleanupError` are carried through when the host states them, and
 * are ABSENT when it does not: a page must not offer a removal action an older host
 * would refuse.
 * @param {object} body - the `/tasks` response body.
 * @returns {{ roots: object[], flatNodes: object[], counts: object, projects: object[] } | null} view.
 */
export function taskTreeView(body) {
  const tree = body?.tree;
  if (tree === null || tree === undefined || typeof tree !== 'object' || Array.isArray(tree)) return null;
  const projects = Array.isArray(tree.projects) ? tree.projects : [];
  const counts = tree.counts !== null && typeof tree.counts === 'object' && !Array.isArray(tree.counts)
    ? tree.counts
    : {};
  const display = tree.displayArchiveAvailable === undefined ? {} : {
    displayArchiveAvailable: tree.displayArchiveAvailable, displayArchiveError: tree.displayArchiveError,
  };
  // Task-record cleanup. An absent block means the host predates the feature (the page
  // then hides the action), while a present one states whether it is available and why.
  const cleanup = tree.cleanupAvailable === undefined ? {} : {
    cleanupAvailable: tree.cleanupAvailable === true,
    cleanupError: typeof tree.cleanupError === 'string' ? tree.cleanupError : null,
  };
  if (Array.isArray(tree.roots)) {
    return { roots: tree.roots.filter(isRenderableNode), flatNodes: flatOfRoots(tree.roots), counts, projects, ...display, ...cleanup };
  }
  if (Array.isArray(tree.flatNodes)) {
    const roots = rootsFromFlatNodes(tree.flatNodes);
    // The flat shape carries no chain detail, so its chains expose no cleanup facts:
    // the page then hides the action instead of offering a checkbox that would fail.
    return { roots, flatNodes: tree.flatNodes.filter(isRenderableNode), counts, projects, ...display, ...cleanup };
  }
  // A tree object with neither shape is not a tree: treat it as an older host.
  return null;
}

/**
 * Rebuild the nesting a flat projection already describes.
 *
 * Only `resolvedParentNodeId` (the host's RESOLVED parent, after orphan detection
 * and cycle breaking) is used, and only to nest; nothing is matched by title,
 * time or position. A node whose resolved parent is missing from the same answer
 * stays at the root rather than disappearing.
 * @param {object[]} flatNodes - host `flatNodes` in pre-order.
 * @returns {object[]} root nodes with `children`.
 */
export function rootsFromFlatNodes(flatNodes) {
  const list = Array.isArray(flatNodes) ? flatNodes.filter(isRenderableNode) : [];
  const byId = new Map();
  const wrappers = list.map((node) => {
    const wrapper = { ...node, children: [] };
    if (!byId.has(node.nodeId)) byId.set(node.nodeId, wrapper);
    return wrapper;
  });
  const roots = [];
  for (const wrapper of wrappers) {
    const parentId = typeof wrapper.resolvedParentNodeId === 'string' ? wrapper.resolvedParentNodeId : null;
    const parent = parentId === null || parentId === wrapper.nodeId ? undefined : byId.get(parentId);
    if (parent === undefined) roots.push(wrapper);
    else parent.children.push(wrapper);
  }
  return roots;
}

/** Pre-order flatten of structured roots, for counting and for tests. */
function flatOfRoots(roots) {
  const out = [];
  const walk = (node) => {
    if (!isRenderableNode(node)) return;
    out.push(node);
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child);
  };
  for (const node of roots) walk(node);
  return out;
}

/** A node the page can key and draw: a stable identity is the one hard requirement. */
function isRenderableNode(node) {
  return node !== null && typeof node === 'object' && typeof node.nodeId === 'string' && node.nodeId !== '';
}

/** The tree slice of one `/tasks` answer, or null when the host sent none. */
function treeOf(body) {
  return taskTreeView(body);
}

/** The plan-document section of one `/tasks` answer, bounded to what the page states. */
function plansSummaryOf(body) {
  const plans = body?.plans;
  if (plans === null || plans === undefined || typeof plans !== 'object' || Array.isArray(plans)) return null;
  return {
    available: plans.available === true,
    count: Number.isFinite(plans.count) ? plans.count : 0,
    reason: typeof plans.reason === 'string' ? plans.reason : null,
  };
}

/** The state patch one successful list read produces. */
function listPatchOf(body) {
  const view = treeOf(body);
  return {
    tasks: Array.isArray(body?.tasks) ? body.tasks : [],
    tree: view,
    treeAvailable: view !== null,
    plans: plansSummaryOf(body),
    tasksError: null,
    // Every successful list read marks the surface as hydrated, empty or not.
    tasksLoaded: true,
  };
}

/**
 * Project the plan-creation form state onto the request body `PlanStore.create` takes.
 *
 * It lives in this framework-free module so the browser page, the DOM tests and any
 * future caller share ONE projection; `src/client/index.jsx` re-exports it.
 *
 * Rules:
 *   * rows become a batch with positional keys (`row-1`, `row-2`, …), so two rows may
 *     carry the SAME title and still be two distinct nodes;
 *   * a row pointing at another row becomes `parentKey` — the only in-batch link
 *     `plan.json` understands, and how one request builds several levels;
 *   * a row pointing at an existing node, or a whole batch attached through the
 *     selector, becomes `parentNodeId` with the REAL id (never a title);
 *   * a blank row is dropped, so an empty trailing row cannot fail a valid batch; a
 *     link to a row that is blank or gone is REFUSED rather than quietly creating the
 *     node at another level;
 *   * a root row keeps its own title/goal; the form's dedicated title/goal describe
 *     the FIRST root, and are refused when every row already has a parent (they would
 *     otherwise become a node nobody asked for);
 *   * nothing is invented: no `connectionId` (the host fixes the owner), no id, no
 *     acceptance, and a workspace only when one was actually chosen.
 * @param {object} draft - `{ title, goal, parentNodeId, workspacePath, rows }`.
 * @returns {{ body: object, problems: string[] }} request and local precheck problems.
 */
export function planCreateRequest(draft) {
  const rows = Array.isArray(draft?.rows) ? draft.rows : [];
  const problems = [];
  const kept = [];
  const batchKeyOf = new Map();
  rows.forEach((row, index) => {
    const title = typeof row?.title === 'string' ? row.title.trim() : '';
    if (title === '') return;
    kept.push({ row, index, title });
    batchKeyOf.set(index, `row-${kept.length}`);
  });
  if (kept.length === 0) {
    problems.push('至少填写一个节点标题');
    return { body: { nodes: [] }, problems };
  }
  const items = kept.map(({ row, index, title }) => {
    const item = { key: batchKeyOf.get(index), title };
    const goal = typeof row.goalDescription === 'string' ? row.goalDescription.trim() : '';
    if (goal !== '') item.goalDescription = goal;
    const parent = typeof row.parent === 'string' ? row.parent : '';
    if (parent.startsWith('row:')) {
      const target = Number.parseInt(parent.slice(4), 10);
      const key = Number.isInteger(target) ? batchKeyOf.get(target) : undefined;
      if (key === undefined) {
        problems.push(`第 ${index + 1} 行的父节点“第 ${target + 1} 行”没有标题，无法作为父节点`);
      } else if (key === item.key) {
        problems.push(`第 ${index + 1} 行不能作为自己的父节点`);
      } else {
        item.parentKey = key;
      }
    } else if (parent !== '') {
      item.parentNodeId = parent;
    }
    return item;
  });
  if (problems.length > 0) return { body: { nodes: items }, problems };

  const firstRoot = items.findIndex((item) => item.parentKey === undefined && item.parentNodeId === undefined);
  const formTitle = typeof draft?.title === 'string' ? draft.title.trim() : '';
  const formGoal = typeof draft?.goal === 'string' ? draft.goal.trim() : '';
  if (firstRoot >= 0) {
    if (formTitle !== '') items[firstRoot].title = formTitle;
    if (formGoal !== '') items[firstRoot].goalDescription = formGoal;
  } else if (formTitle !== '') {
    // Every row already names a parent: the batch is a set of children, and the title
    // cannot silently become a node the operator did not add a row for.
    problems.push('所有行都指定了父节点；标题只用于根节点，请清空标题或加一行根节点');
  }

  const body = { nodes: items };
  const attachTo = typeof draft?.parentNodeId === 'string' ? draft.parentNodeId : '';
  if (attachTo !== '') body.parentNodeId = attachTo;
  const workspacePath = typeof draft?.workspacePath === 'string' ? draft.workspacePath.trim() : '';
  if (workspacePath !== '') body.workspacePath = workspacePath;
  return { body, problems };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Create the page store.
 *
 * The store owns the served data, the editable draft, and the transients an
 * operator asked for (a model catalog, a connectivity report, a one-time token).
 * It never owns a credential value: {@link DelegateStore#setCredential} forwards
 * one and forgets it.
 * @param {object} options - `api` transport, `now` clock.
 * @returns {object} store with `subscribe`, `getSnapshot` and action methods.
 */
/** Backoff schedule (ms) when `init()` hits a startup 404 right after "Enable immediately". */
const DEFAULT_INIT_RETRY_DELAYS_MS = Object.freeze([250, 500, 1000, 1500, 2000, 2500, 3000]);

/** Whether an error indicates the plugin backend HTTP routes have not mounted yet. */
function isStartupRoutePendingError(error) {
  return error?.code === 'HTTP_404'
    || error?.code === 'USER_PLANE_UNKNOWN_ROUTE'
    || error?.code === 'USER_PLANE_UNREACHABLE';
}

export function createStore(options = {}) {
  const api = options.api ?? createApi();
  // The task-record cleanup projection. It is injected rather than imported so this
  // module keeps one import list; `index.jsx` passes `cleanupProjection()`, and a
  // caller that passes nothing gets a projection that removes nothing.
  const cleanup = options.cleanup ?? emptyCleanupProjection();
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  // Debounce for the automatic save. Text inputs arrive one keystroke at a time, so a
  // short quiet period merges them into ONE whole-document PUT; switches and selects
  // are single discrete actions and are saved on the next tick (0 delay).
  const saveDebounceMs = Number.isFinite(options.saveDebounceMs) && options.saveDebounceMs >= 0
    ? Math.trunc(options.saveDebounceMs)
    : 700;
  const initRetryDelaysMs = Array.isArray(options.initRetryDelaysMs)
    ? options.initRetryDelaysMs.filter((ms) => Number.isFinite(ms) && ms >= 0).map((ms) => Math.trunc(ms))
    : DEFAULT_INIT_RETRY_DELAYS_MS;
  const scheduleImpl = typeof options.schedule === 'function'
    ? options.schedule
    : (fn, ms) => setTimeout(fn, ms);
  const cancelScheduleImpl = typeof options.cancelSchedule === 'function'
    ? options.cancelSchedule
    : (handle) => clearTimeout(handle);
  /**
   * The serialization gate for whole-document PUTs.
   *
   * At most ONE settings PUT is in flight at any time. Further edits (during the
   * debounce window OR while a PUT is in flight) only mark `saveAgainSince` and are
   * merged into the NEXT PUT, whose body is taken from the LATEST draft at send time.
   * That is what makes a slow response unable to overwrite a newer edit.
   */
  let saveInFlight = false;
  /** Every draft edit bumps this; a straggler response may only clear `dirty` for it. */
  let draftGeneration = 0;
  /** Pending debounce handle, or null. */
  let saveTimer = null;
  /** Explicit discard marker: the next debounce tick must not resurrect edits. */
  let saveSuppressed = false;
  /** Coalesced in-flight `init()` promise so remounting while bootstrapping never overlaps. */
  let initInFlight = null;
  /** Pending startup retry timer handle and canceller for `dispose()`. */
  let initRetryTimer = null;
  let cancelInitRetryWait = null;
  /** Last startup-failure notice emitted by `init()`, cleared automatically on recovery. */
  let initErrorNoticeId = null;
  /**
   * Sequence of `openTask` calls. A detail read may only publish its answer if no
   * NEWER read started meanwhile, so a slow response for an old row cannot replace the
   * detail the operator is looking at now.
   */
  let openTaskRequest = 0;

  let state = {
    revision: 0,
    loading: {},
    notices: [],
    status: null,
    nativeProviders: [],
    nativeProvidersError: null,
    settings: null,
    draft: null,
    dirty: false,
    // Automatic-save state for the settings document. `idle` before any change, then
    // `pending` (debounce window or waiting for the in-flight PUT), `saving`, `saved`,
    // `invalid` (local precheck refused the draft; the LAST VALID document stays
    // committed) or `failed` (the host refused / the transport failed).
    saveState: 'idle',
    saveError: null,
    saveProblems: [],
    catalog: null,
    catalogError: null,
    modelCatalog: {},
    connections: [],
    selectedConnectionId: null,
    grants: [],
    tasks: [],
    /**
     * The host's task-tree projection, exactly as `/tasks` served it.
     *
     * `null` means "this host answered no tree" — either an older host (the key is
     * absent) or a failed read. The two are kept apart on purpose: a failed read
     * publishes `tasksError`, an older host only publishes `treeAvailable: false`,
     * and the page falls back to the flat list in BOTH cases instead of rendering
     * an invented hierarchy. Relations are never re-derived in the browser.
     */
    tree: null,
    treeAvailable: false,
    plans: null,
    /**
     * Whether a `/tasks` read has ever SUCCEEDED in this store.
     *
     * The records surfaces (the page and the sidebar) decide whether their first tick
     * must read at once or may wait a full interval: a store that already holds a
     * published list does not need an immediate read, an UNREAD one does. A list of
     * zero tasks cannot express that distinction by itself — "empty" and "never read"
     * look identical — which is why this fact is recorded rather than inferred.
     */
    tasksLoaded: false,
    /** The refused list read, or null. Distinguishes "failed" from "empty". */
    tasksError: null,
    /** The last refused plan create, or null; the form shows it and keeps its input. */
    planCreateError: null,
    /** Node ids of the last SUCCESSFUL plan create, in the host's order. */
    planCreateResult: null,
    taskDetail: null,
    // Visible feedback for the detail click: a spinner flag, and the refusal itself so
    // the panel can say WHY nothing opened instead of staying silent.
    taskDetailLoading: false,
    taskDetailError: null,
    /**
     * Monotonic count of SUCCESSFUL `openTask` calls. The page focuses and scrolls to the
     * detail on every change of this number — and only on that — so a repeated open of
     * the same task behaves like the first one, while a background list refresh (which
     * recomposes `taskDetail`) never steals focus.
     */
    taskDetailView: 0,
    token: null,
    tokenConnectionId: null,
    credentials: {},
    connectivity: {},
    // Codex integration. `codex` holds the last served status document,
    // `codexError` its last refusal, `codexOutcome` the last action's result. None
    // of them is a credential: the status document is a file/config diagnosis.
    codex: null,
    codexError: null,
    codexOutcome: null,
    antigravity: null,
    antigravityError: null,
    antigravityOutcome: null,
  };
  /** @type {Set<() => void>} */
  const listeners = new Set();
  let disposed = false;

  function emit() {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A subscriber's own render error must not break the store.
      }
    }
  }

  function patch(next) {
    if (disposed) return;
    state = { ...state, ...next, revision: state.revision + 1 };
    emit();
  }

  /**
   * Append one operator-facing message, deduplicating identical live notices so
   * parallel transient failures never stack repeated identical banners.
   * @param {'info'|'error'|'success'} level - severity.
   * @param {string} text - Chinese text.
   * @returns {number} notice id.
   */
  function notify(level, text) {
    const existing = state.notices.find((notice) => notice.level === level && notice.text === text);
    if (existing !== undefined) return existing.id;
    const id = state.revision + 1 + Math.random();
    patch({ notices: [...state.notices, { id, level, text }].slice(-6) });
    return id;
  }

  function dismissNotice(id) {
    patch({ notices: state.notices.filter((notice) => notice.id !== id) });
  }

  /** Wait `ms` before retrying startup readiness; resolves `false` if disposed meanwhile. */
  function waitForInitRetry(ms) {
    return new Promise((resolve) => {
      if (disposed) {
        resolve(false);
        return;
      }
      let settled = false;
      const finish = (keepGoing) => {
        if (settled) return;
        settled = true;
        initRetryTimer = null;
        cancelInitRetryWait = null;
        resolve(keepGoing);
      };
      cancelInitRetryWait = () => {
        if (initRetryTimer !== null) {
          try { cancelScheduleImpl(initRetryTimer); } catch { /* ignore */ }
        }
        finish(false);
      };
      initRetryTimer = scheduleImpl(() => finish(!disposed), Math.max(0, ms));
    });
  }

  async function track(key, work) {
    patch({ loading: { ...state.loading, [key]: true } });
    try {
      return await work();
    } finally {
      if (!disposed) patch({ loading: { ...state.loading, [key]: false } });
    }
  }

  /** Drop a pending debounce tick, if any. */
  function cancelPendingSave() {
    if (saveTimer === null) return;
    const handle = saveTimer;
    saveTimer = null;
    try {
      cancelScheduleImpl(handle);
    } catch {
      // A cancelled timer that already fired is harmless: the tick re-checks state.
    }
  }

  /**
   * Schedule the automatic save after `ms`.
   *
   * A later edit REPLACES the earlier tick, so a burst of keystrokes becomes one PUT.
   * @param {number} ms - debounce delay.
   * @returns {void}
   */
  function scheduleAutoSave(ms) {
    cancelPendingSave();
    if (saveSuppressed) return;
    if (saveInFlight) {
      // A PUT is already running: it will pick this edit up in its follow-up pass.
      patch({ saveState: 'pending' });
      return;
    }
    saveTimer = scheduleImpl(() => {
      saveTimer = null;
      void runSave();
    }, Math.max(0, ms));
  }

  /**
   * Validate the CURRENT draft and write the whole document, serialized.
   *
   * Rules this implements, each one a consequence of a real failure mode:
   *   * an INVALID draft is never sent: the last valid document stays committed, the
   *     draft is kept so the operator can fix it, and the exact reason is published;
   *   * at most one PUT is in flight; the body is read from the LATEST draft at the
   *     moment of the send, so a slow response cannot overwrite a newer edit;
   *   * the response never replaces newer local edits: it only clears `dirty` when the
   *     generation it saved is still the newest one;
   *   * a throwing transport/refusal leaves the draft and reports the failure;
   *   * while more edits arrived during the PUT, a follow-up save is scheduled.
   * @returns {Promise<{ ok: boolean, error?: unknown, problems?: string[] }>} outcome.
   */
  async function runSave() {
    if (disposed) return { ok: false, error: new Error('disposed') };
    if (state.draft === null) return { ok: false };
    if (saveInFlight) {
      // Someone asked to save while another PUT runs: let that PUT finish and let its
      // follow-up pass cover the newer draft. Nothing is dropped.
      return { ok: false, pending: true };
    }
    const problems = precheckDraft(state.draft);
    if (problems.length > 0) {
      // The invalid draft is PRESERVED (never silently replaced by the saved values)
      // so the operator can keep fixing it, and the last valid config stays live.
      patch({ saveState: 'invalid', saveProblems: problems.slice(0, 4), saveError: null });
      return { ok: false, problems };
    }
    const generationAtSend = draftGeneration;
    const document = documentFromDraft(state.draft);
    saveInFlight = true;
    patch({ loading: { ...state.loading, save: true }, saveState: 'saving', saveError: null, saveProblems: [] });
    try {
      const body = await api.putSettings(document);
      const stillCurrent = draftGeneration === generationAtSend;
      // `settings` is ALWAYS the host's normalized answer (the host is the authority on
      // what was stored), while the draft is re-seeded from it ONLY when this save still
      // covers the newest edit: the normalized document is the truth for that generation,
      // and keeping a draft that disagrees with what the host stored would leave the page
      // showing values nobody saved. A newer edit made during the PUT is kept untouched
      // and written by the follow-up save.
      const next = {
        settings: body.settings ?? null,
        saveState: stillCurrent ? 'saved' : 'pending',
        saveError: null,
        saveProblems: [],
      };
      if (stillCurrent) {
        next.draft = body.settings === null || body.settings === undefined
          ? state.draft
          : draftFromSettings(body.settings);
        next.dirty = false;
      }
      patch(next);
      return { ok: true };
    } catch (error) {
      // The refusals arrive verbatim (the host is the authority); nothing is guessed.
      patch({ saveState: 'failed', saveError: error });
      return { ok: false, error };
    } finally {
      saveInFlight = false;
      if (!disposed) {
        patch({
          loading: { ...state.loading, save: false },
          ...(draftGeneration !== generationAtSend && !saveSuppressed
            ? { saveState: 'pending' }
            : {}),
        });
      }
      // Edits that arrived while this PUT was in flight are written by a follow-up
      // save, debounced again so a burst of typing still merges.
      if (!disposed && !saveSuppressed && draftGeneration !== generationAtSend) {
        scheduleAutoSave(saveDebounceMs);
      }
    }
  }

  const store = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return state;
    },
    notify,
    dismissNotice,

    /** Read the delegation posture. */
    async refreshStatus() {
      return await track('status', async () => {
        try {
          const body = await api.getStatus();
          patch({ status: body });
          return { ok: true, body };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /** Load configured provider connections from the native DSH registry. */
    async loadNativeProviders() {
      return await track('nativeProviders', async () => {
        try {
          const body = await api.getNativeProviders();
          patch({ nativeProviders: Array.isArray(body.providers) ? body.providers : [], nativeProvidersError: body.error ?? null });
          return { ok: true, providers: body.providers ?? [], error: body.error ?? null };
        } catch (error) {
          patch({ nativeProvidersError: describeError(error) });
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /** Persist and immediately apply the single authorization switch. */
    async setDelegationEnabled(enabled) {
      if (typeof enabled !== 'boolean') return { ok: false };
      return await track('delegationSwitch', async () => {
        try {
          const body = await api.setDelegationEnabled(enabled);
          const settings = state.settings === null ? null : { ...state.settings, delegationEnabled: enabled };
          const draft = state.draft === null ? null : { ...state.draft, delegationEnabled: enabled };
          patch({ status: { ...(state.status ?? {}), delegation: body.delegation }, settings, draft });
          notify('success', enabled ? '本机 DSH 委派已开启。' : '本机 DSH 委派已关闭，运行中的任务已请求停止。');
          return { ok: true, delegation: body.delegation };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /** Read the committed document (and reset the draft unless it is dirty). */
    async loadSettings() {
      return await track('settings', async () => {
        try {
          const body = await api.getSettings();
          patch({
            settings: body.settings ?? null,
            draft: state.dirty && state.draft !== null ? state.draft : draftFromSettings(body.settings),
            ...(state.dirty && state.draft !== null ? {} : { dirty: false }),
          });
          return { ok: true, settings: body.settings ?? null };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /** Read the served catalog (models, effort capabilities, effective config). */
    async loadCatalog(projectPath = null) {
      return await track('catalog', async () => {
        try {
          const body = await api.getCatalog(projectPath === null ? {} : { projectPath });
          patch({ catalog: body, catalogError: null });
          return { ok: true, catalog: body };
        } catch (error) {
          patch({ catalogError: { code: error?.code ?? '', text: describeError(error) } });
          return { ok: false, error };
        }
      });
    },

    /** Read the connection list. */
    async loadConnections() {
      return await track('connections', async () => {
        try {
          const body = await api.listConnections();
          const connections = Array.isArray(body.connections) ? body.connections : [];
          const live = connections.filter((entry) => entry.revoked !== true);
          const selected = connections.some((entry) => entry.connectionId === state.selectedConnectionId && entry.revoked !== true)
            ? state.selectedConnectionId
            : (live[0]?.connectionId ?? null);
          patch({ connections, selectedConnectionId: selected });
          if (selected !== null && selected !== state.selectedConnectionId) await store.loadGrants(selected);
          return { ok: true, connections };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Issue a connection. The token is kept in memory, tied to its connection id.
     * @param {string} label - display label.
     */
    async issueConnection(label) {
      return await track('issueConnection', async () => {
        try {
          const body = await api.issueConnection(String(label ?? '').trim() || 'codex');
          patch({
            token: typeof body.token === 'string' ? body.token : null,
            tokenConnectionId: body.connection?.connectionId ?? null,
            selectedConnectionId: body.connection?.connectionId ?? state.selectedConnectionId,
          });
          await store.loadConnections();
          notify('success', '连接已签发。授权令牌只显示这一次，请立即复制到 MCP 宿主配置。');
          return { ok: true, connection: body.connection, token: body.token };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /** Drop the one-time token from memory. */
    clearToken() {
      patch({ token: null, tokenConnectionId: null });
    },

    /**
     * Revoke one connection (and every grant it holds).
     * @param {string} connectionId - server-issued identity.
     */
    async revokeConnection(connectionId) {
      return await track('revokeConnection', async () => {
        try {
          const body = await api.revokeConnection(connectionId);
          if (state.tokenConnectionId === connectionId) patch({ token: null, tokenConnectionId: null });
          await store.loadConnections();
          await store.refreshStatus();
          notify('success', `已撤销该连接及其授权（${body.grantsRevoked ?? 0} 条授权）。`);
          return { ok: true, grantsRevoked: body.grantsRevoked ?? 0 };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /** Revoke every grant and connection ("stop everything now"). */
    async revokeAll() {
      return await track('revokeAll', async () => {
        try {
          const body = await api.revokeAll();
          patch({ token: null, tokenConnectionId: null, grants: [] });
          await store.loadConnections();
          await store.refreshStatus();
          notify('success', `已撤销全部授权与连接（${body.grantsRevoked ?? 0} 条授权）。当前委托已关闭。`);
          return { ok: true, grantsRevoked: body.grantsRevoked ?? 0 };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Select a server-issued connection identity and load its grants.
     * @param {string} connectionId - connection id from the served list.
     */
    async selectConnection(connectionId) {
      patch({ selectedConnectionId: connectionId, grants: [] });
      return await store.loadGrants(connectionId);
    },

    /**
     * Load the grants of one connection.
     * @param {string} connectionId - connection id.
     */
    async loadGrants(connectionId) {
      return await track('grants', async () => {
        try {
          const body = await api.listGrants(connectionId);
          patch({ grants: Array.isArray(body.grants) ? body.grants : [] });
          return { ok: true, grants: body.grants ?? [] };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Issue one grant for the selected connection.
     * @param {object} form - `{ connectionId, kind, workspacePath, ttlSeconds }`.
     */
    async issueGrant(form) {
      const connectionId = form?.connectionId ?? state.selectedConnectionId;
      const workspacePath = String(form?.workspacePath ?? '').trim();
      const kind = form?.kind === 'session' ? 'session' : 'task';
      if (typeof connectionId !== 'string' || connectionId === '') {
        notify('error', '请先签发并选择一个连接，授权只能绑定到宿主签发的连接身份。');
        return { ok: false };
      }
      if (workspacePath === '') {
        notify('error', '请填写授权的绝对工作区路径。');
        return { ok: false };
      }
      return await track('issueGrant', async () => {
        try {
          const body = {
            connectionId,
            kind,
            workspacePath,
          };
          const ttl = Number(form?.ttlSeconds);
          if (Number.isInteger(ttl) && ttl > 0) body.ttlSeconds = ttl;
          const answer = await api.issueGrant(body);
          await store.loadGrants(connectionId);
          await store.refreshStatus();
          notify('success', kind === 'task' ? '已签发单次任务授权（用掉即失效）。' : '已签发本连接会话授权（限时、可撤销）。');
          return { ok: true, grant: answer.grant };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Revoke one grant.
     * @param {string} grantId - grant identity.
     */
    async revokeGrant(grantId) {
      return await track('revokeGrant', async () => {
        try {
          await api.revokeGrant(grantId);
          if (state.selectedConnectionId !== null) await store.loadGrants(state.selectedConnectionId);
          await store.refreshStatus();
          notify('success', '已撤销该授权。');
          return { ok: true };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Apply an edit to the draft and schedule the automatic save.
     *
     * The edit itself is synchronous and safe during a save: it bumps the draft
     * generation, so a response that arrives later can only confirm the document it
     * actually wrote and can never replace this newer draft.
     * @param {(draft: object) => void} mutate - edits the cloned draft in place.
     * @param {{ immediate?: boolean }} [editOptions] - `immediate: true` skips the
     *   debounce window (used by switches and selects, which are discrete actions).
     */
    editDraft(mutate, editOptions = {}) {
      const draft = clone(state.draft ?? defaultDraft());
      mutate(draft);
      draftGeneration += 1;
      saveSuppressed = false;
      patch({ draft, dirty: true, saveState: 'pending', saveError: null, saveProblems: [] });
      scheduleAutoSave(editOptions?.immediate === true ? 0 : saveDebounceMs);
    },

    /**
     * Run the automatic save now, cancelling any pending debounce.
     * @returns {Promise<{ ok: boolean, error?: unknown, problems?: string[] }>} outcome.
     */
    async saveNow() {
      cancelPendingSave();
      return await runSave();
    },

    /**
     * Discard uncommitted edits (an explicit operator action; never automatic).
     *
     * Discarding is a real state change, so it bumps the draft generation: an
     * in-flight PUT that finishes afterwards sees `draftGeneration !== generationAtSend`
     * and must NOT re-seed the draft nor schedule a follow-up write. The UI additionally
     * disables the control while a save is running, so the two can never disagree about
     * what the operator is looking at.
     * @returns {void}
     */
    resetDraft() {
      cancelPendingSave();
      draftGeneration += 1;
      saveSuppressed = true;
      patch({
        draft: draftFromSettings(state.settings),
        dirty: false,
        saveState: 'idle',
        saveError: null,
        saveProblems: [],
      });
    },

    /**
     * Validate the draft locally, then replace the stored document.
     *
     * Kept as the explicit "flush now" entry point (and the contract older callers
     * used); under automatic saving the same serialization gate applies, so calling it
     * while a PUT is in flight waits for that PUT instead of racing it.
     * @returns {Promise<{ ok: boolean, error?: unknown, problems?: string[] }>} outcome.
     */
    async saveSettings() {
      cancelPendingSave();
      return await runSave();
    },

    /**
     * Discover one provider's models from its own API, then keep the result.
     *
     * This is remote discovery, not a catalog read: the host calls the provider's
     * configured endpoint with that provider's credential reference. Consequences
     * this function has to honour:
     *
     *   * an empty list plus a `discovery` diagnosis is a *failure*, not "the
     *     provider serves nothing", so it is reported as one and no merge is
     *     attempted;
     *   * discovery never returns capabilities. New ids arrive with `efforts: []`,
     *     so the operator still has to declare what a model supports;
     *   * a host that predates the route (a carrier 404) gets the old fallback,
     *     which is then labelled honestly as a catalog read rather than as
     *     discovery.
     * @param {string} providerId - provider id.
     */
    async fetchModels(providerId) {
      patch({ loading: { ...state.loading, [`models:${providerId}`]: true } });
      try {
        let models = [];
        let source = 'remote';
        let providerError = null;
        let discovery = null;
        try {
          const body = await api.fetchModels(providerId);
          models = Array.isArray(body.models) ? body.models : [];
          providerError = body.error ?? null;
          discovery = body.discovery ?? null;
          source = typeof body.source === 'string' ? body.source : 'remote';
        } catch (error) {
          // Only a carrier-level 404 means "this host does not serve the route".
          // Our own handler answers 404 with a JSON `PROVIDER_UNKNOWN` code, and
          // that is a real refusal to report, not a reason to fall back.
          const routeMissing = error?.code === 'HTTP_404' || error?.code === 'USER_PLANE_UNKNOWN_ROUTE';
          if (!routeMissing) throw error;
          const body = await api.getCatalog({});
          const entry = (body.catalog ?? []).find((candidate) => candidate.providerId === providerId);
          models = Array.isArray(entry?.models) ? entry.models : [];
          providerError = entry?.error ?? null;
          source = 'catalog';
          discovery = {
            attempted: false,
            failed: providerError !== null,
            code: providerError?.code ?? null,
            message: 'this host does not serve model discovery yet; the configured catalog was read instead',
          };
        }
        const failed = source === 'remote' && discovery?.failed === true;
        patch({
          modelCatalog: {
            ...state.modelCatalog,
            [providerId]: { models, source, error: providerError, discovery, fetchedAt: now() },
          },
        });
        if (source === 'catalog') {
          notify('info', '宿主尚未提供从提供方获取模型的接口，已改用模型目录结果（不是远程模型列表）。');
        }
        if (source === 'remote' && discovery?.failed !== true && providerError !== null) {
          notify('error', `提供方「${providerId}」无法解析模型：${providerError.message ?? providerError.code ?? ''}`);
        }
        if (failed) {
          notify('error', `从提供方「${providerId}」获取模型失败：${describeError(providerError ?? discovery)}`);
          return { ok: false, models: [], source, error: providerError };
        }
        return { ok: true, models, source, discovery };
      } catch (error) {
        patch({
          modelCatalog: {
            ...state.modelCatalog,
            [providerId]: {
              models: [],
              source: 'error',
              error: { code: error?.code ?? '', message: describeError(error) },
              discovery: { attempted: true, failed: true, code: error?.code ?? '' },
              fetchedAt: now(),
            },
          },
        });
        notify('error', describeError(error));
        return { ok: false, error };
      } finally {
        if (!disposed) patch({ loading: { ...state.loading, [`models:${providerId}`]: false } });
      }
    },

    /**
     * Merge discovered models into the draft provider, keeping manual-only entries.
     *
     * The asymmetry is the point: a model the operator already declared keeps its
     * declared `efforts` (discovery cannot lend or revoke a capability), a newly
     * discovered id arrives with no efforts at all, and an id the endpoint did not
     * list is never removed — a manual entry stays configured.
     * @param {string} providerId - provider id.
     * @param {object[]} models - `[{ id, efforts }]`.
     */
    mergeModelsIntoDraft(providerId, models) {
      store.editDraft((draft) => {
        const provider = draft.providers.find((entry) => entry.id === providerId);
        if (provider === undefined) return;
        for (const model of models) {
          if (typeof model?.id !== 'string' || model.id === '') continue;
          const existing = provider.models.find((entry) => entry.id === model.id);
          if (existing !== undefined) {
            // Nothing to do: the operator's own declaration wins, and discovery
            // never returns a capability to fill in.
            continue;
          }
          const served = Array.isArray(model.efforts) ? [...model.efforts] : [];
          provider.models.push({ id: model.id, efforts: served });
        }
      });
    },

    /**
     * Read whether one provider's credential is configured.
     * @param {string} providerId - provider id.
     */
    async credentialStatus(providerId) {
      patch({ loading: { ...state.loading, [`credential:${providerId}`]: true } });
      try {
        const body = await api.credentialStatus(providerId);
        patch({
          credentials: {
            ...state.credentials,
            [providerId]: { ...(body.credential ?? {}), loaded: true },
          },
        });
        return { ok: true, credential: body.credential };
      } catch (error) {
        patch({
          credentials: {
            ...state.credentials,
            [providerId]: {
              configured: null,
              loaded: true,
              unavailable: true,
              reason: describeError(error),
            },
          },
        });
        return { ok: false, error };
      } finally {
        if (!disposed) patch({ loading: { ...state.loading, [`credential:${providerId}`]: false } });
      }
    },

    /**
     * Forward a credential value to the host and forget it.
     * @param {string} providerId - provider id.
     * @param {string} value - the literal; discarded immediately after the call.
     */
    async setCredential(providerId, value) {
      const literal = typeof value === 'string' ? value : '';
      if (literal.trim() === '') {
        notify('error', describeError(new ApiError('CREDENTIAL_EMPTY', 'no value was entered')));
        return { ok: false };
      }
      return await track(`credential:${providerId}`, async () => {
        try {
          const body = await api.setCredential(providerId, literal);
          patch({
            credentials: { ...state.credentials, [providerId]: { ...(body.credential ?? {}), loaded: true } },
          });
          notify('success', `已保存提供方「${providerId}」的密钥（值不会回显）。`);
          return { ok: true, credential: body.credential };
        } catch (error) {
          // A carrier-level 404 is "this host has no credential route"; a JSON
          // refusal with its own code is a real answer and is shown as such.
          notify('error', error?.code === 'HTTP_404' || error?.code === 'USER_PLANE_UNKNOWN_ROUTE'
            ? describeError(new ApiError('CREDENTIAL_SEAM_UNAVAILABLE', 'credential route unavailable'))
            : describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Remove one provider's stored credential.
     * @param {string} providerId - provider id.
     */
    async unsetCredential(providerId) {
      return await track(`credential:${providerId}`, async () => {
        try {
          const body = await api.unsetCredential(providerId);
          patch({
            credentials: { ...state.credentials, [providerId]: { ...(body.credential ?? {}), loaded: true } },
          });
          notify('success', `已清除提供方「${providerId}」的密钥。`);
          return { ok: true, credential: body.credential };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Run one provider's layered connectivity check.
     * @param {object} form - `{ providerId, model, reasoningEffort }`.
     */
    async checkConnectivity(form) {
      const providerId = String(form?.providerId ?? '');
      if (providerId === '') {
        notify('error', '请先选择提供方。');
        return { ok: false };
      }
      return await track(`connectivity:${providerId}`, async () => {
        try {
          const body = { providerId };
          if (typeof form.model === 'string' && form.model !== '') body.model = form.model;
          if (typeof form.reasoningEffort === 'string' && form.reasoningEffort !== '') body.reasoningEffort = form.reasoningEffort;
          const answer = await api.checkConnectivity(body);
          patch({ connectivity: { ...state.connectivity, [providerId]: answer.report ?? null } });
          return { ok: true, report: answer.report };
        } catch (error) {
          patch({ connectivity: { ...state.connectivity, [providerId]: null } });
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Read the Codex integration status. Read-only: this is what `init()` calls,
     * so opening the page never writes to the Codex home.
     */
    async refreshCodexStatus() {
      return await track('codexStatus', async () => {
        try {
          const body = await api.getCodexStatus();
          patch({ codex: body.codex ?? null, codexError: null });
          return { ok: true, codex: body.codex ?? null, switch: body.switch ?? null };
        } catch (error) {
          // A host that predates this route answers 404: that is "not served
          // here", not "Codex is not installed", so it is shown as unavailable.
          const unavailable = error?.code === 'HTTP_404' || error?.code === 'USER_PLANE_UNKNOWN_ROUTE';
          patch({
            codex: null,
            codexError: unavailable
              ? '当前宿主未提供 Codex 集成接口（插件版本可能较旧）。'
              : describeError(error),
          });
          return { ok: false, error };
        }
      });
    },

    /**
     * Perform one explicit Codex action and keep its outcome.
     *
     * This is only reachable from a button click: nothing calls it from `init()`,
     * from `saveSettings()` or from a render pass. Installed files are therefore
     * always the result of an operator decision.
     * @param {'install'|'repair'|'remove'} action - action to perform.
     */
    async runCodexAction(action) {
      if (!CODEX_ACTIONS.includes(action)) {
        notify('error', `未知的 Codex 操作：${String(action)}`);
        return { ok: false };
      }
      return await track('codexAction', async () => {
        try {
          const body = await api.runCodexAction(action);
          const outcome = {
            action: body.action ?? action,
            changed: Array.isArray(body.changed) ? body.changed : [],
            refused: Array.isArray(body.refused) ? body.refused : [],
          };
          const codex = body.codex ?? state.codex;
          patch({ codex, codexError: null, codexOutcome: outcome });
          const summary = describeCodexOutcome(outcome);
          const failed = outcome.refused.length > 0;
          notify(failed ? 'error' : 'success', summary === '' ? '操作完成。' : summary);
          return { ok: !failed, outcome, codex };
        } catch (error) {
          patch({ codexOutcome: null });
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /** Read the Antigravity integration status. Strictly read-only. */
    async refreshAntigravityStatus() {
      if (typeof api.getAntigravityStatus !== 'function') {
        patch({
          antigravity: null,
          antigravityError: '当前宿主未提供 Antigravity 集成接口（插件版本可能较旧）。',
        });
        return { ok: false };
      }
      return await track('antigravityStatus', async () => {
        try {
          const body = await api.getAntigravityStatus();
          patch({ antigravity: body.antigravity ?? null, antigravityError: null });
          return { ok: true, antigravity: body.antigravity ?? null, switch: body.switch ?? null };
        } catch (error) {
          const unavailable = error?.code === 'HTTP_404' || error?.code === 'USER_PLANE_UNKNOWN_ROUTE';
          patch({
            antigravity: null,
            antigravityError: unavailable
              ? '当前宿主未提供 Antigravity 集成接口（插件版本可能较旧）。'
              : describeError(error),
          });
          return { ok: false, error };
        }
      });
    },

    /** Perform one explicit Antigravity integration action (`install`, `repair`, `remove`). */
    async runAntigravityAction(action) {
      if (!ANTIGRAVITY_ACTIONS.includes(action)) {
        notify('error', `未知的 Antigravity 操作：${String(action)}`);
        return { ok: false };
      }
      if (typeof api.runAntigravityAction !== 'function') {
        notify('error', '当前宿主未提供 Antigravity 集成接口。');
        return { ok: false };
      }
      return await track('antigravityAction', async () => {
        try {
          const body = await api.runAntigravityAction(action);
          const outcome = {
            action: body.action ?? action,
            changed: Array.isArray(body.changed) ? body.changed : [],
            refused: Array.isArray(body.refused) ? body.refused : [],
          };
          const antigravity = body.antigravity ?? state.antigravity;
          patch({ antigravity, antigravityError: null, antigravityOutcome: outcome });
          const summary = describeAntigravityOutcome(outcome);
          const failed = outcome.refused.length > 0;
          notify(failed ? 'error' : 'success', summary === '' ? '操作完成。' : summary);
          return { ok: !failed, outcome, antigravity };
        } catch (error) {
          patch({ antigravityOutcome: null });
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Replace the silence thresholds, the progress-check cadence and the repeated-failure count.
     *
     * The narrow route exists so an operator adjusting a timer cannot rewrite a
     * provider list. On success the committed document is adopted for `settings` and
     * the draft's monitoring block, and OTHER unsaved draft edits are left alone —
     * a timer save must never discard a half-finished provider edit.
     *
     * Order matters: the RAW block is validated first and only then normalized for the
     * wire. Validating the normalized block would accept a cleared field, because
     * `monitoringOf` replaces it with the documented default.
     *
     * KNOWN BOUNDARY (stated rather than hidden): this is a LEGACY compatibility entry
     * point. The settings page no longer calls it — the monitoring fields are ordinary
     * draft edits saved by the whole-document queue — so nothing in the UI can race it.
     * A caller that still uses it writes through the NARROW `/monitoring` route, which is
     * a different write from the whole-document PUT; it therefore takes the same
     * `saveInFlight` gate (a narrow write never overlaps a whole-document write) but it
     * cannot merge partial documents. Prefer `editDraft` + `saveNow` for anything new.
     * @param {{ selfCheckSeconds: number, attentionSeconds: number, repeatFailureThreshold: number }} monitoring - the block as the operator typed it.
     * @returns {Promise<{ ok: boolean, error?: unknown }>} outcome.
     */
    async saveMonitoring(monitoring) {
      const problems = precheckMonitoring(monitoring);
      if (problems.length > 0) {
        notify('error', `未保存：${problems.join('；')}`);
        return { ok: false, problems };
      }
      if (saveInFlight) return { ok: false, pending: true };
      const normalized = monitoringOf({ monitoring });
      saveInFlight = true;
      return await track('monitoring', async () => {
        try {
          const body = await api.putMonitoring(normalized);
          const committed = body.settings ?? null;
          const draft = state.draft === null
            ? draftFromSettings(committed)
            : { ...state.draft, monitoring: monitoringOf(committed ?? { monitoring: normalized }) };
          patch({ settings: committed, draft });
          notify('success', '监控间隔已保存。已开始运行的任务保留它自己的快照，新任务使用新值。');
          return { ok: true, monitoring: body.monitoring ?? normalized };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        } finally {
          saveInFlight = false;
        }
      });
    },

    /**
     * Set ONLY the operator's Agent Teams default for new tasks.
     *
     * Kept beside {@link saveMonitoring} for the same reason it is narrow: an operator
     * flipping one switch must not be able to rewrite a provider list through the same
     * call. It writes through the narrow `/execution` route and adopts the committed
     * document, leaving OTHER unsaved draft edits alone.
     *
     * It never touches DSH's global agent-teams switch, and it never changes a task that
     * already ran: each task froze its own choice at admission.
     * @param {boolean} enabled - the default a NEW task without its own choice gets.
     * @returns {Promise<{ ok: boolean, error?: unknown }>} outcome.
     */
    async saveAgentTeamsDefault(enabled) {
      if (typeof enabled !== 'boolean') {
        const problems = ['「新任务默认开启智能体协作」只能是开启或关闭'];
        notify('error', `未保存：${problems.join('；')}`);
        return { ok: false, problems };
      }
      if (saveInFlight) return { ok: false, pending: true };
      saveInFlight = true;
      return await track('execution', async () => {
        try {
          const body = await api.putExecution({ agentTeamsDefault: enabled });
          const committed = body.settings ?? null;
          const draft = state.draft === null
            ? draftFromSettings(committed)
            : { ...state.draft, execution: executionOf(committed ?? { execution: { agentTeamsDefault: enabled } }) };
          patch({ settings: committed, draft });
          notify('success', '新任务的智能体协作默认已保存。只影响之后没有单独指定协作选择的新派工。');
          return { ok: true, execution: body.execution ?? { agentTeamsDefault: enabled } };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        } finally {
          saveInFlight = false;
        }
      });
    },

    /**
     * Refresh the task list without operator-facing noise.
     *
     * Used by the bounded auto-refresh only. It differs from {@link store.loadTasks}
     * in three ways that matter for a background read: it never notifies on failure
     * (a transient blip must not spam the page), it never clears a previously loaded
     * list on error, and it is a pure read — no model call, no task action — so a
     * visible page cannot cause work by being visible.
     * @param {string} [reason] - `auto` for the timer, `manual` for an explicit click.
     * @returns {Promise<{ ok: boolean, tasks?: object[] }>} outcome.
     */
    async refreshTasks(reason = 'auto') {
      if (state.loading?.tasks === true) return { ok: false, skipped: 'in-flight' };
      patch({ loading: { ...state.loading, tasks: true } });
      try {
        const body = await api.listTasks();
        const tasks = Array.isArray(body.tasks) ? body.tasks : [];
        // The selected detail is refreshed from the SAME list snapshot rather than a
        // second request, so the panel never shows a detail older than its row, and
        // the operator's selection is never changed by a background read.
        //
        // The row is MERGED onto the open detail, and the review conclusion is merged
        // one level deeper: a list row may carry `hostAcceptance` in a COMPACT shape
        // (`noteOmitted`, no body), and a plain shallow spread would replace the loaded
        // full note with that compact block — silently emptying the text the operator
        // was reading. Only the SAME recorded conclusion reuses the loaded body; a
        // DIFFERENT conclusion (a new decision) never inherits the old text.
        const detail = state.taskDetail === null
          ? null
          : (() => {
            const row = tasks.find((task) => task.taskId === state.taskDetail.taskId);
            if (row === undefined) return state.taskDetail;
            const merged = { ...state.taskDetail, ...row };
            const loaded = state.taskDetail.hostAcceptance ?? null;
            const incoming = row.hostAcceptance ?? null;
            if (loaded !== null && incoming !== null
              && loaded.state === incoming.state
              && loaded.acceptedAt === incoming.acceptedAt
              && typeof loaded.note === 'string'
              && (incoming.noteOmitted === true || typeof incoming.note !== 'string')) {
              // Same conclusion, compact row: keep the body that was already read.
              merged.hostAcceptance = { ...incoming, note: loaded.note };
            }
            return merged;
          })();
        patch({
          ...listPatchOf(body),
          tasks,
          taskDetail: detail,
        });
        return { ok: true, tasks, reason };
      } catch (error) {
        if (reason === 'manual') notify('error', describeError(error));
        // The REASON a read failed is kept even for a silent background refresh: the
        // page must be able to say "this list is stale" instead of presenting the
        // previous rows as current. A failed read never clears the rows already shown.
        patch({ tasksError: error });
        return { ok: false, error };
      } finally {
        if (!disposed) patch({ loading: { ...state.loading, tasks: false } });
      }
    },

    /**
     * Create planning nodes from the page, then read them back from the host.
     *
     * The form owns its own input (the page keeps the draft, including on failure, so
     * a refused batch never costs the operator what they typed); this method only
     * sends one batch and then re-reads the records through the EXISTING refresh
     * path, which is what makes the new nodes appear with the host's own status,
     * sequence and parent resolution instead of a locally guessed one.
     * @param {object} body - `{ workspacePath?, parentNodeId?, nodes }`.
     * @returns {Promise<{ ok: boolean, nodes?: object[], error?: unknown }>} outcome.
     */
    async setDisplayArchive(nodeId, archived) {
      return await track('displayArchive', async () => {
        try {
          await api.setDisplayArchive(nodeId, archived);
          const outcome = await store.refreshTasks('manual');
          if (outcome.skipped === 'in-flight') await store.loadTasks();
          return { ok: true };
        } catch (error) {
          notify('error', `无法更新展示归档。${describeError(error)}`);
          return { ok: false, error };
        }
      });
    },

    async createPlans(body) {
      return await track('planCreate', async () => {
        let created = [];
        try {
          const answer = await api.createPlans(body);
          created = Array.isArray(answer.nodes) ? answer.nodes : [];
          patch({ planCreateError: null, planCreateResult: created.map((node) => node.nodeId) });
          notify('success', `已创建 ${created.length} 个规划节点（只记录计划，不会执行）。`);
        } catch (error) {
          // The refusal is KEPT so the form can show why nothing was created and let
          // the operator fix one field; nothing was written (the host validates the
          // whole batch atomically).
          patch({ planCreateError: error, planCreateResult: null });
          notify('error', `创建规划失败：${describeError(error)}`);
          return { ok: false, error };
        }
        // Re-read through the normal path. A failure here is reported separately: the
        // nodes exist on disk even when this read failed, and saying otherwise would
        // invite a duplicate create.
        const refreshed = await store.refreshTasks('manual');
        if (refreshed?.ok === false) {
          notify('error', '规划已写入，但列表暂时读取失败；可点“刷新”重试（不要重复创建）。');
          return { ok: true, nodes: created, refreshFailed: true };
        }
        return { ok: true, nodes: created };
      });
    },

    /** Read the task list. */
    async loadTasks() {
      return await track('tasks', async () => {
        try {
          const body = await api.listTasks();
          patch(listPatchOf(body));
          return { ok: true, tasks: body.tasks ?? [] };
        } catch (error) {
          patch({ tasksError: error });
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Read one task with its prompt and evidence.
     *
     * A click must ALWAYS produce visible feedback: the detail panel appears as soon as
     * the request is acknowledged, and a refusal is reported with its own reason instead
     * of leaving the previous view silently unchanged. The last successful detail is
     * kept while a new read is in flight, so the panel does not blink empty.
     * @param {string} taskId - task identity.
     * @returns {Promise<{ ok: boolean, task?: object, error?: unknown }>} outcome.
     */
    async openTask(taskId) {
      const requested = typeof taskId === 'string' ? taskId : '';
      if (requested === '') {
        notify('error', '无法打开详情：缺少任务标识。');
        return { ok: false };
      }
      // A stale response for an EARLIER selection must not replace the newer detail.
      openTaskRequest += 1;
      const request = openTaskRequest;
      patch({ taskDetailLoading: true, taskDetailError: null });
      try {
        const body = await api.getTask(requested);
        if (request !== openTaskRequest) return { ok: false, stale: true };
        // `taskDetailView` counts SUCCESSFUL opens. It only changes when the operator
        // opened a detail (first open, a repeat open of the same task, or a different
        // task) — never on a background list refresh, which is what makes it the right
        // dependency for "focus and scroll to the newly opened detail".
        patch({
          taskDetail: body.task ?? null,
          taskDetailLoading: false,
          taskDetailError: null,
          taskDetailView: state.taskDetailView + 1,
        });
        return { ok: true, task: body.task };
      } catch (error) {
        if (request !== openTaskRequest) return { ok: false, stale: true };
        // The refusal is stated in the panel AND in the notices: an operator who clicked
        // must never be left guessing whether the click registered.
        patch({ taskDetailLoading: false, taskDetailError: error });
        notify('error', `打开任务详情失败：${describeError(error)}`);
        return { ok: false, error };
      }
    },

    /** Close the open task detail (a pure view change, no request). */
    closeTask() {
      openTaskRequest += 1;
      patch({ taskDetail: null, taskDetailLoading: false, taskDetailError: null });
    },

    /**
     * Cancel one task as the operator.
     * @param {string} taskId - task identity.
     */
    async cancelTask(taskId) {
      return await track('cancelTask', async () => {
        try {
          const body = await api.cancelTask(taskId);
          patch({
            tasks: state.tasks.map((task) => (task.taskId === taskId ? { ...task, ...body.task } : task)),
            taskDetail: state.taskDetail?.taskId === taskId ? { ...state.taskDetail, ...body.task } : state.taskDetail,
          });
          notify('success', '已请求取消。');
          return { ok: true, task: body.task };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /** Remove a confirmed selection whose exact rounds still match the current tree. */
    async cleanupTasks(selection, options = {}) {
      const view = cleanup;
      const candidates = view.candidates(state.tree ?? null);
      const prepared = view.request(selection ?? {}, candidates, options);
      if (prepared.problems.length > 0) {
        notify('error', prepared.problems[0]);
        return { ok: false, error: new ApiError('CLEANUP_INVALID', prepared.problems[0]) };
      }
      return await track('cleanup', async () => {
        try {
          const outcome = await api.cleanupTasks(prepared.body);
          if (outcome?.cleaned && options?.hostWorkspaces) {
            await reconcileHostWorkspacesWithCleaned(options.hostWorkspaces, outcome.cleaned);
          }
          const deleted = view.outcome(outcome);
          const sentence = view.describe(outcome);
          if (sentence === '') throw new ApiError('CLEANUP_RESULT_UNCONFIRMED', '宿主未确认删除结果');
          notify('success', sentence);
          if (state.taskDetail !== null && deleted.deletedTaskIds.includes(state.taskDetail.taskId)) {
            store.closeTask();
          }
          // Re-read through the normal path: the tree, the counts and each chain's
          // eligibility come from the host, never from this response.
          const refreshed = await store.refreshTasks('manual');
          if (refreshed?.ok === false) {
            notify('error', '记录已删除，但列表暂时读取失败；请点“刷新”重试。');
            return { ok: true, outcome, refreshFailed: true };
          }
          return { ok: true, outcome };
        } catch (error) {
          const refused = error?.code?.startsWith('CLEANUP_') && error.code !== 'CLEANUP_RESULT_UNCONFIRMED';
          notify('error', refused ? describeError(error) : '未能确认清理结果，请查看刷新后的任务记录。');
          // The selection was made from a tree this host no longer agrees with.
          await store.refreshTasks('manual');
          return { ok: false, error };
        }
      });
    },

    /** Sweep residual worktrees and dispatched sessions whose task records were already removed. */
    async cleanupOrphans(options = {}) {
      if (typeof api.cleanupOrphans !== 'function') {
        notify('error', '当前宿主未提供残留清理接口。');
        return { ok: false };
      }
      return await track('cleanupOrphans', async () => {
        try {
          const outcome = await api.cleanupOrphans({
            archiveSessions: options?.archiveSessions !== false,
            removeWorktrees: options?.removeWorktrees !== false,
          });
          if (outcome?.cleaned && options?.hostWorkspaces) {
            await reconcileHostWorkspacesWithCleaned(options.hostWorkspaces, outcome.cleaned);
          }
          const sentence = typeof cleanup.describeOrphans === 'function'
            ? cleanup.describeOrphans(outcome)
            : '已完成残留隔离工作树与已删记录派工对话清理。';
          notify('success', sentence || '已完成残留清理。');
          await store.refreshTasks('manual');
          return { ok: true, outcome };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Load everything the page needs; tolerates the short cold-start window right after
     * "Enable immediately" when the frontend mounts before backend HTTP routes finish
     * registering, retrying `/status` silently instead of stacking 404 banners.
     */
    async init() {
      if (disposed) return;
      if (initInFlight !== null) return await initInFlight;
      const run = (async () => {
        let startupNoticeId = null;
        let statusOutcome = null;
        let statusReady = false;
        let lastStartupError = null;

        for (let attempt = 0; attempt <= initRetryDelaysMs.length; attempt += 1) {
          if (disposed) return;
          statusOutcome = await track('status', async () => {
            try {
              const body = await api.getStatus();
              patch({ status: body });
              return { ok: true, body };
            } catch (error) {
              return { ok: false, error };
            }
          });
          if (statusOutcome.ok) {
            statusReady = true;
            break;
          }
          if (!isStartupRoutePendingError(statusOutcome.error) || attempt === initRetryDelaysMs.length) {
            lastStartupError = statusOutcome.error;
            break;
          }
          if (startupNoticeId === null) {
            startupNoticeId = notify('info', '插件服务正在启动，正在自动重试连接…');
          }
          const keepGoing = await waitForInitRetry(initRetryDelaysMs[attempt]);
          if (!keepGoing || disposed) return;
        }

        if (startupNoticeId !== null) {
          dismissNotice(startupNoticeId);
          startupNoticeId = null;
        }
        if (disposed) return;

        if (statusReady && initErrorNoticeId !== null) {
          dismissNotice(initErrorNoticeId);
          initErrorNoticeId = null;
        }

        if (!statusReady) {
          const err = lastStartupError ?? statusOutcome?.error;
          if (err !== undefined && err !== null) {
            initErrorNoticeId = notify('error', describeError(err));
            if (isStartupRoutePendingError(err)) {
              patch({ nativeProvidersError: describeError(err), tasksError: err });
              return;
            }
          }
        }

        await Promise.all([store.loadSettings(), store.loadNativeProviders(), store.loadTasks()]);
        if (disposed) return;
        // Diagnostic read only. `init` must never perform a Codex write: installing
        // files is an explicit operator action, not a side effect of opening a page.
        void store.refreshCodexStatus();
        void store.refreshAntigravityStatus();
        void store.loadCatalog();
      })().finally(() => {
        if (initInFlight === run) initInFlight = null;
      });
      initInFlight = run;
      return await run;
    },

    /** Release subscriptions and drop the one-time token. */
    dispose() {
      cancelPendingSave();
      disposed = true;
      if (typeof cancelInitRetryWait === 'function') cancelInitRetryWait();
      state = { ...state, token: null, tokenConnectionId: null };
      listeners.clear();
    },
  };

  return store;
}

function normalizeClientPathKey(pathValue) {
  if (typeof pathValue !== 'string') return '';
  const trimmed = pathValue.trim().replace(/[\\/]+$/u, '');
  return trimmed.toLowerCase();
}

async function reconcileHostWorkspacesWithCleaned(hostWorkspacesOrGetter, cleaned) {
  if (!cleaned || typeof cleaned !== 'object') return;
  let wsService = null;
  try {
    wsService = typeof hostWorkspacesOrGetter === 'function' ? hostWorkspacesOrGetter() : hostWorkspacesOrGetter;
  } catch {
    wsService = null;
  }
  if (!wsService || typeof wsService !== 'object') return;

  if (typeof wsService.archiveSession === 'function' && Array.isArray(cleaned.archivedSessionIds)) {
    for (const sessionId of cleaned.archivedSessionIds) {
      if (typeof sessionId === 'string' && sessionId !== '') {
        try {
          await wsService.archiveSession(sessionId);
        } catch {
          // Best-effort client-side session archive.
        }
      }
    }
  }

  let snapshot = null;
  try {
    snapshot = wsService.list?.getSnapshot?.() ?? null;
  } catch {
    snapshot = null;
  }
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const itemById = new Map();
  for (const item of items) {
    if (typeof item?.workspaceId === 'string' && item.workspaceId !== '') {
      itemById.set(item.workspaceId, item);
    }
  }

  const removedWorkspaceIds = Array.isArray(cleaned.removedWorkspaceIds) ? cleaned.removedWorkspaceIds : [];
  const workspaceSet = new Set(removedWorkspaceIds);

  if (Array.isArray(cleaned.removedWorktreePaths) && cleaned.removedWorktreePaths.length > 0 && items.length > 0) {
    const removedPathKeys = new Set(cleaned.removedWorktreePaths.map(normalizeClientPathKey).filter(Boolean));
    for (const item of items) {
      const key = normalizeClientPathKey(item?.path);
      if (key !== '' && removedPathKeys.has(key) && typeof item.workspaceId === 'string' && !workspaceSet.has(item.workspaceId)) {
        workspaceSet.add(item.workspaceId);
        removedWorkspaceIds.push(item.workspaceId);
      }
    }
    cleaned.removedWorkspaceIds = removedWorkspaceIds;
  }

  if (typeof wsService.delete === 'function' && removedWorkspaceIds.length > 0) {
    for (const workspaceId of removedWorkspaceIds) {
      if (typeof workspaceId !== 'string' || workspaceId === '') continue;
      const item = itemById.get(workspaceId) ?? null;
      if (item !== null && typeof item.path === 'string' && /[\\/]worktrees[\\/]*$/iu.test(item.path.trim())) {
        // Never remove the parent TaskBridge worktrees root container workspace itself.
        continue;
      }
      try {
        await wsService.delete(workspaceId);
      } catch {
        // Best-effort client-side workspace removal.
      }
    }
  }
}
