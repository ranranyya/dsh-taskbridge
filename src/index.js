// dsh-delegate — native DSH plugin entry point.
//
// Load order matters and is visible here: services are injected, configuration is
// read, the native provider/adapter/worktree/history machinery is constructed,
// both HTTP planes are registered on their respective carriers immediately, and
// byte-exact shipped Codex / Antigravity integrations are refreshed in parallel.
// The persisted local-call switch is restored at startup and defaults to OFF;
// no task is dispatched until an operator enables it in the DSH plugin settings.
//
// Service access is deliberately split in three:
//
//   * `inject` lists the services this plugin cannot work without at all. While
//     any is missing, Cordis does not activate the plugin — which is the correct
//     outcome for a harness that cannot host it.
//   * `ctx.get(name, false)` reads the services that are *optional*: the credential
//     seam (a harness may have none, and the UI must then say so instead of the
//     plugin failing to load) and the agent preset registry. A bare property read
//     would throw `cannot get property "…" without inject`, so the non-strict
//     accessor is the only safe way to express "optional".
//   * the two native placement controllers (`workspaceController`,
//     `sessionController`) are optional TOO, but read through a live accessor and
//     not through a `ctx.get` call performed during activation: DSH may compose
//     them after this plugin activated, and the snapshot would then be `null`
//     forever, refusing every run with `SESSION_*_UNAVAILABLE`. A dispatch that
//     meets no controller still fails closed; it just cannot be decided at load.
//
// The plugin's own face is published with `ctx.provide('dshDelegate', …)` rather
// than by assigning `ctx.dshDelegate`: an unprovided property assignment throws
// `cannot set property "…" without provide` in Cordis, and provide/effect is what
// makes the face disappear again on unload.

import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import z from '@deepseek-ai/schemastery';

import { SCHEMA_VERSION } from './config/defaults.js';
import { SettingsService } from './config/settings.js';
import { AuthorizationRegistry } from './auth/grants.js';
import { bindAllowsExternalConnections } from './auth/fence.js';
import { JobEngine } from './jobs/engine.js';
import { HistoryStore } from './jobs/history.js';
import { PlanStore } from './jobs/plan-store.js';
import { TaskDisplayStore } from './jobs/task-display.js';
import { WorkspaceLocks } from './workspace/locks.js';
import { createGitRunner } from './workspace/audit.js';
import { WorktreeManager } from './workspace/worktrees.js';
import { createCredentialGateway } from './credentials/seam.js';
import { createOpenAiAdapter } from './model/openai-adapter.js';
import { createProviderRegistry, nativeProvidersOf, managedProvidersOf } from './model/providers.js';
import { describeCatalog, resolveRoute } from './model/routing.js';
import { checkProviderConnectivity } from './model/connectivity.js';
import { probeModel } from './model/probe.js';
import { createExecutionHandler, EXECUTION_PREFIX } from './http/execution-plane.js';
import { wrapUserPlaneRoutes } from './http/user-plane.js';
import { diagnostic } from './runtime/agent-runner.js';
import { ensureWorkspace, SessionStore, liveControllerAccessor } from './runtime/session-placement.js';
import { publishRuntimeEndpoint, resolveDefaultEndpointDiscoveryPath } from './runtime/endpoint-discovery.js';
import { resolveCodexActionSeam } from './codex/seam.js';
import { resolveAntigravityActionSeam } from './antigravity/seam.js';
import { configureDelegatedSession, policyServicesOf } from './runtime/sandbox.js';
import { PermissionBridge, PERMISSION_DEFAULT_TIMEOUT_MS } from './runtime/permissions.js';
import { QuestionBridge } from './runtime/questions.js';
import { redactText, isSecretKey } from './config/redact.js';
import { approvalFeedbackMessage } from './runtime/agent-runner.js';
import { reportedVersion } from './version.js';

/** Stable Cordis plugin name; also the settings/document namespace. */
export const name = 'dsh-taskbridge';

/**
 * Injected native services. Listing them explicitly means the plugin is not
 * activated until each one exists, so no handler can run against a half-built
 * harness. Two services are deliberately NOT injected:
 *
 *   * `credentials` — the plugin must load and report state in a harness with no
 *     credential seam, and it only touches that seam when an operator asks about a
 *     reference or presses save;
 *   * `agentPresets` — a run works without a preset registry (it asks the runtime
 *     for its configured default), so a missing registry must not disable
 *     configuration.
 */
export const inject = ['agents', 'sessions', 'llm', 'tools', 'webServer', 'connection'];

/**
 * Plugin configuration schema.
 *
 * Cordis validates a plugin's config before `apply` runs by calling
 * `runtime.Config['~standard'].validate(config)` (see `resolveConfig` in
 * `@deepseek-ai/cordis`, 0.2.0-rc.2 / 4.0.5). A plain object has no
 * `~standard` member, so it dereferences `undefined.validate` and the plugin
 * fails to activate. Every native DSH plugin declares its schema with
 * `@deepseek-ai/schemastery`, whose schemas carry that interface; this one must
 * too, and `schemastery` is then also a real runtime dependency rather than a
 * host-provided accident.
 */
export const Config = z.object({
  /** Data directory root; the plugin appends `dsh-delegate`. */
  dataDir: z.string().default(''),
});

/**
 * Mount the delegation service.
 *
 * `config` is the operator's settings document and is validated by {@link Config}
 * before this runs.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - plugin config.
 * @returns {Promise<void>} resolves after registration.
 */
export async function apply(ctx, config = {}) {
  const logger = ctx.logger;
  const dataDir = await resolveDataDir(ctx, config);
  // Re-read THIS build's manifest on every activation.
  //
  // A host can replace the installed package on disk while this module stays loaded (a
  // DSH hot update: `package.json` becomes 1.5.1-test.2, the code that is running is the
  // new one). The process-lifetime manifest memo then still answers the PREVIOUS version,
  // and this activation would stamp the Codex integration with it — so the next start,
  // reading the real manifest, sees a freshly written file as operator-customised. One
  // forced read per activation is the whole fix; nothing else bypasses the cache.
  const pluginVersion = reportedVersion({ refresh: true }).version;

  const settings = new SettingsService(dataDir);
  // Read once at load so an unusable document fails the plugin loudly instead of
  // surfacing as a confusing refusal on the first request.
  const initialSettings = await settings.read();

  // Optional services, read non-strictly so their absence is a fact and not a throw.
  const credentialsService = ctx.get('credentials', false) ?? null;
  const agentPresets = ctx.get('agentPresets', false) ?? null;

  const auth = new AuthorizationRegistry();
  const locks = new WorkspaceLocks();
  const runGit = createGitRunner();

  // The credential gateway is what both the native adapter and the user plane use.
  // It reads the seam lazily, so a service that appears (or disappears) after load
  // is observed on the next operation instead of being frozen at startup.
  const credentials = createCredentialGateway(() => ctx.get('credentials', false) ?? credentialsService);

  // Native adapter + route registry. Without these a dispatch must refuse
  // (`JOB_PROVIDER_REGISTRY_REQUIRED`) rather than silently route to a profile id
  // that the harness never registered.
  //
  // `createOpenAiAdapter` returns a *management facade* around one `PiAiAdapter`.
  // The registry is given the facade and unwraps it, because the only object the
  // native core may be handed is the adapter itself: it calls
  // `providerInfo`/`providerRetryPolicy` during registration and `prepareCall`/
  // `stream` on every request. Registering the facade produced exactly the
  // observed failure — the route existed, and every model call on it resolved
  // `ROUTING_MODEL_UNRESOLVED` because no streamable adapter was ever attached.
  const adapter = createOpenAiAdapter({ credentials });
  const providerRegistry = createProviderRegistry({ llm: ctx.llm, adapter });

  const history = new HistoryStore(dataDir);
  const plans = new PlanStore(dataDir);
  const taskDisplay = new TaskDisplayStore(dataDir);
  const worktrees = new WorktreeManager({ runGit }, { rootDir: join(dataDir, 'worktrees') });
  // The task-thread identity map: task id -> the DSH Workspace/Session that task
  // drove, plus the paths and (for an isolated run) the tree ownership facts a
  // `continueFromTaskId` follow-up is validated against. Keyed by task, never by
  // directory, so nothing here can make a new submission continue an old
  // conversation. Stores identities only, never transcript content.
  const sessionStore = new SessionStore(dataDir, { logger });

  /**
   * Report a native controller whose read was refused, on the plugin's logger.
   *
   * The accessors below are non-strict by design (`ctx.get(name, false)`), so a
   * service the harness does not expose answers `undefined` rather than throwing.
   * A throw can still happen when the service's own resolution fails; that must
   * reach the operator's log instead of vanishing into the fail-closed refusal the
   * run then reports.
   * @param {string} serviceName - `workspaceController` or `sessionController`.
   * @param {unknown} error - whatever the accessor threw.
   * @returns {void}
   */
  const warnControllerRead = (serviceName, error) => {
    logger?.warn?.(`dsh-delegate: the DSH ${serviceName} could not be read (${diagnostic(error?.message ?? error, 200)})`);
  };

  // DSH's Workspace Tree computes parents from registered directories. The plugin
  // already puts isolated checkouts below this root, so no task directory moves.
  //
  // The root is the managed worktrees directory the manager itself owns
  // (`<data>/dsh-delegate/worktrees`), which `WorktreeManager.ensureRoot` creates with
  // the same 0o700 mode a first isolated run would use — nothing from an earlier
  // version has to move, and no user Workspace is renamed or reparented. Registering it
  // is what makes DSH's own "按工作区树" (视图选项 → 分组方式) nest every isolated task
  // Workspace under one TaskBridge group; the plugin never draws that tree itself.
  //
  // Registration is idempotent and reversible: one pending attempt at a time, a success
  // is remembered (so a later failure cannot loop), and the disposer forgets it. It
  // never deletes a Workspace, so no user data is touched.
  let worktreeWorkspaceRegistration = null;
  let worktreeWorkspaceRegistered = false;
  function registerWorktreeWorkspace() {
    if (worktreeWorkspaceRegistered) return Promise.resolve({ registered: true });
    if (worktreeWorkspaceRegistration !== null) return worktreeWorkspaceRegistration;
    worktreeWorkspaceRegistration = (async () => {
      try {
        const workspaces = deps.workspaces.current;
        if (typeof workspaces?.create !== 'function') return { registered: false, reason: 'WORKSPACES_UNAVAILABLE' };
        // Create-if-missing, then resolve: DSH compares real paths when it derives the
        // tree, and every containment check below already works on real paths.
        const path = await worktrees.ensureRoot();
        if (!(await stat(path)).isDirectory()) return { registered: false, reason: 'ROOT_NOT_A_DIRECTORY' };
        const workspace = await ensureWorkspace(workspaces, path, 'TaskBridge');
        if (workspace.namingError) logger?.warn?.('dsh-delegate: could not name the TaskBridge workspace', workspace.namingError);
        worktreeWorkspaceRegistered = true;
        return { registered: true, workspaceId: workspace.workspaceId, path };
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          logger?.warn?.('dsh-delegate: could not register the TaskBridge workspace', diagnostic(error?.message ?? error, 200));
        }
        return { registered: false, reason: typeof error?.code === 'string' ? error.code : 'REGISTRATION_FAILED' };
      }
    })().finally(() => { worktreeWorkspaceRegistration = null; });
    return worktreeWorkspaceRegistration;
  }

  const deps = {
    agents: ctx.agents,
    agentPresets,
    sessions: ctx.sessions,
    // The native Workspace and Session controllers. Both are read non-strictly
    // and, more importantly, LAZILY: a harness that does not compose them must
    // load the plugin and then refuse a dispatch with a stated code
    // (`SESSION_*_UNAVAILABLE`), not fail to activate — and a harness that
    // composes them AFTER this plugin activated (or replaces one) must still be
    // able to place the next run. These are therefore live accessors, not the
    // snapshot `ctx.get` would return here: see {@link liveControllerAccessor}.
    // A run is never created outside a Workspace as a fallback.
    workspaces: liveControllerAccessor(
      () => ctx.get('workspaceController', false),
      { onError: (error) => warnControllerRead('workspaceController', error) },
    ),
    sessionController: liveControllerAccessor(
      () => ctx.get('sessionController', false),
      { onError: (error) => warnControllerRead('sessionController', error) },
    ),
    sessionStore,
    llm: ctx.llm,
    tools: ctx.tools,
    settings,
    auth,
    locks,
    runGit,
    worktrees,
    registerWorktreeWorkspace,
    history,
    plans,
    taskDisplay,
    providerRegistry,
    credentials,
    logger,
    delegationEnabled: initialSettings.delegationEnabled === true,
    authorizationMode: 'switch',
    // Startup only refreshes an agent file whose bytes match a shipped template.
    // Agent creation and MCP registration remain explicit settings-page actions.
    codex: resolveCodexActionSeam({
      version: pluginVersion,
      // The automatic upgrade's protected backup location, inside this activation's own
      // data directory: never the package, never the Codex home, never a user home. The
      // seam supplies it to a caller that does not pass one, so the unattended MCP write
      // always has a place to keep the original bytes.
      backupDir: join(dataDir, 'codex-config-backup'),
    }),
    antigravity: resolveAntigravityActionSeam({
      version: pluginVersion,
    }),
    configureDelegatedSession,
    // `ctx.sandboxPolicy` and `ctx.approval` own the two facts the delegated
    // policy writes, so the runner reads them back through these live services
    // and refuses the run when either cannot answer. Read per run, never at
    // activation: a service composed later must still be observed.
    policyServices: () => policyServicesOf(ctx),
    // The per-call permission bridge factory. It produces a bridge only when this
    // harness can actually service an approval request: a live `ctx.approval` with
    // a callable `request()`, which is the seam the native tools ask through. When
    // that seam is absent the factory returns null, the engine offers no bridge,
    // and every worker run keeps the original fail-closed `never` stance — this
    // plugin must never install an `ask` it cannot answer.
    permissionBridge: createPermissionBridgeFactory({
      getApprovalService: () => readOptionalApprovalService(ctx),
      logger,
    }),
    // The ordinary-question bridge factory. It does NOT depend on the approval service:
    // asking a question is not granting anything, so a run keeps its fail-closed `never`
    // approval stance and may still ask. A question is only surfaced when the harness
    // actually composes the native `userQuestions` seam; otherwise the factory returns
    // null and nothing is registered, which is the safe default.
    questionBridge: createQuestionBridgeFactory({
      hasQuestionService: () => hasQuestionService(ctx),
      logger,
    }),
    codexStartupRefresh: null,
    antigravityStartupRefresh: null,
  };

  /**
   * Bring the native routes and the adapter's served snapshot to the state this
   * settings snapshot describes, and return the mapping both sides agree on.
   *
   * One registration owns the route set. The whole transition below is a single
   * synchronous section — `transaction()` never awaits, and the registry refuses
   * a callback that returns a thenable — because the two sides must move together:
   *
   *   1. `registry.register(providers, adapt)` validates the candidate list, then
   *      checks that no candidate route is owned by another registration;
   *   2. `adapt` publishes the matching snapshot on the adapter
   *      (`prepareRoutes`), which is the state `prepareRoutes()` in the core reads
   *      synchronously when it validates the routes;
   *   3. `adapt` calls the `commit()` the registry handed it, which is where the
   *      core validates and commits — synchronously, still inside `adapt`'s own
   *      stack — so no native observer, and no second ensure, can see the adapter
   *      serving a generation the core has not accepted;
   *   4. a refusal at step 3 rolls the snapshot back to the generation it
   *      displaced before the error leaves this function, so a failed
   *      re-registration leaves both the native route set and the adapter on the
   *      old generation.
   *
   * There is no fallback: a failed registration throws, and every caller
   * (job preflight, `/models`, `/catalog`, connectivity) turns that into an
   * honest refusal instead of routing to an ambient `relay`/`workbuddy` route.
   *
   * The native/custom split is {@link managedProvidersOf}, the same helper
   * `JobEngine.leaseProviders()` uses. That is load bearing, not tidiness: the
   * registry fingerprints whichever list it is given, so the task's long-lived
   * lease and this registration have to describe one set. A native-only
   * configuration therefore leases and registers the same empty custom set
   * instead of leasing `[workbuddy]` and then being refused by its own lease when
   * it registers `[]`.
   * @param {object} snapshot - validated settings snapshot.
   * @returns {Promise<Map<string, string>>} public provider id -> native route id.
   */
  const ensureRoutes = async (snapshot) => {
    const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
    const nativeProviders = nativeProvidersOf(providers);
    const customProviders = managedProvidersOf(providers);
    const registered = await ctx.llm.listProviders();
    const available = new Set((Array.isArray(registered) ? registered : []).map((entry) => entry.id));
    const routes = new Map();
    for (const provider of nativeProviders) {
      if (!available.has(provider.id)) {
        const error = new Error(`native provider ${provider.id} is no longer registered with DSH`);
        error.code = 'NATIVE_PROVIDER_UNAVAILABLE';
        throw error;
      }
      routes.set(provider.id, provider.id);
    }
    if (customProviders.length === 0) {
      await providerRegistry.register([], () => {});
      return routes;
    }
    /**
     * The transaction body. Everything here is synchronous on purpose: the adapter
     * is the only party that may restore the snapshot, and it must have done so
     * before the registry's callback returns and the error propagates.
     *
     * `commit()` is called by the registry at this point in the sequence, from
     * inside this callback's own stack, so the native registration can never land
     * in a microtask after a publication that a second ensure could already have
     * displaced.
     * @param {Map<string, string>} routes - the candidate mapping to register.
     * @param {() => void} commit - perform the native registration.
     * @returns {void}
     */
    const adapt = (routes, commit) => {
      const prepared = adapter.prepareRoutes({ providers: customProviders, routes });
      if (!adapter.describes(prepared, routes)) {
        prepared.rollback();
        throw new Error('dsh-delegate: the adapter and the registry planned different route sets');
      }
      try {
        commit();
      } catch (error) {
        prepared.rollback();
        throw error;
      }
    };
    const ensured = await providerRegistry.register(customProviders, adapt);
    for (const [id, route] of ensured.routes) routes.set(id, route);
    return routes;
  };
  deps.ensureRoutes = ensureRoutes;
  /**
   * The route set, or the reason there is none — for read paths that must answer
   * with a body instead of a thrown refusal.
   * @param {object} snapshot - validated settings snapshot.
   * @param {string} operation - what was being attempted, for the log line.
   * @returns {Promise<{ routes: Map<string, string> | null, error: { code: string, message: string } | null }>} outcome.
   */
  deps.resolveRoutes = async (snapshot, operation) => {
    try {
      return { routes: await ensureRoutes(snapshot), error: null };
    } catch (error) {
      const outcome = {
        code: typeof error?.code === 'string' ? error.code : 'ROUTE_REGISTRATION_REFUSED',
        message: diagnostic(error?.message ?? 'the native provider routes could not be registered', 300),
      };
      logger?.warn?.(`dsh-delegate: provider route registration failed during ${operation}`, outcome.code);
      return { routes: null, error: outcome };
    }
  };
  /** The adapter's own view of what it serves; used only for diagnostics/tests. */
  deps.adapterSnapshot = () => adapter.snapshot();
  deps.probeModel = (route, options) => probeModel(deps, route, options ?? {});

  const engine = new JobEngine(deps);
  deps.engine = engine;
  deps.describeRuntime = () => ({
    plugin: name,
    version: pluginVersion,
    schemaVersion: SCHEMA_VERSION,
    // Facts an operator needs to reason about exposure. Never a secret.
    bind: ctx.webServer?.host ?? null,
    port: ctx.webServer?.port ?? null,
    executionPlane: EXECUTION_PREFIX,
    executionPlaneLocalOnly: ctx.webServer?.host === '127.0.0.1',
    credentialSeam: credentialsService === null ? 'unavailable' : 'available',
    presetRegistry: agentPresets === null ? 'unavailable' : 'available',
    // Whether this harness can group a run into a DSH Workspace and create the
    // session inside it. Reported so an operator can tell a configuration problem
    // from a missing native service before dispatching. Read at report time, so a
    // controller composed after activation is reported as available instead of
    // being described by the load-time snapshot.
    workspaceController: deps.workspaces?.current === null ? 'unavailable' : 'available',
    sessionController: deps.sessionController?.current === null ? 'unavailable' : 'available',
    // The conversation rule, not a stored setting: a new submission starts a new DSH
    // conversation, and a follow-up continues only the task named by
    // `continueFromTaskId`. Reported so an operator can see that there is no longer
    // a directory-level mode to configure.
    conversation: 'per-task',
    conversationContinuation: 'continueFromTaskId',
  });

  // ---- user plane: authenticated DSH settings and task controls --------------
  const userRoutes = wrapUserPlaneRoutes(deps);
  for (const route of userRoutes) {
    const dispose = ctx.connection.fetch.register(route);
    ctx.effect(() => dispose);
  }

  // ---- execution plane: loopback MCP; only new submissions need the switch --
  const bindVerdict = bindAllowsExternalConnections(ctx.webServer?.host ?? '127.0.0.1');
  if (bindVerdict.ok === true) {
    const handler = createExecutionHandler({
      ...deps,
      getBindHost: () => ctx.webServer?.host ?? null,
    });
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: EXECUTION_PREFIX,
      handler: (req, res) => handler(req, res),
    });
    ctx.effect(() => dispose);
    try {
      const endpointLease = await publishRuntimeEndpoint({
        filePath: resolveDefaultEndpointDiscoveryPath(),
        host: ctx.webServer?.host,
        port: ctx.webServer?.port,
      });
      ctx.effect(() => () => endpointLease.dispose());
    } catch (error) {
      logger?.warn?.(`dsh-delegate: could not publish MCP endpoint discovery (${diagnostic(error?.message, 200)})`);
    }
  } else {
    // Registering an unauthenticated external surface on a public bind would be
    // worse than not having one. Refuse and record the reason.
    logger?.warn?.(
      `dsh-delegate: the execution plane is not registered because the webserver binds ${ctx.webServer?.host ?? 'unknown'} (${bindVerdict.code}). `
      + 'Delegation requests from external connections will be refused.',
    );
  }

  // Register the managed root at every activation, so a fresh install (no worktree yet)
  // gets the TaskBridge group too, and an upgrade groups the child Workspaces that
  // already exist under it. An isolate that has not created its tree is what this makes
  // possible: the directory is created inside the plugin's own managed data directory.
  void registerWorktreeWorkspace();

  // ---- stop everything on unload ------------------------------------------
  ctx.effect(() => async () => {
    await engine.dispose();
    // History is flushed before the store is closed so a task that finished during
    // teardown is still durable. The session map is flushed on the same terms.
    await history.dispose();
    await plans.dispose();
    await sessionStore.dispose();
    providerRegistry.dispose();
    auth.revokeAll();
    locks.releaseAll();
  });

  logger?.info?.(`dsh-delegate: loaded (local MCP switch ${initialSettings.delegationEnabled === true ? 'on' : 'off'}, `
    + 'conversation per task: new unless continueFromTaskId names the task to continue)');

  // Published as a Cordis service, not assigned: `ctx.provide` is the only legal
  // way to add a property, and its disposer removes the face on unload.
  ctx.provide('dshDelegate', {
    settings,
    auth,
    engine,
    locks,
    history,
    plans,
    sessionStore,
    worktrees,
    providerRegistry,
    credentials,
    deps,
  });

  // Run Codex and Antigravity startup refreshes AFTER both HTTP planes are registered
  // (and in parallel), so clicking "Enable immediately" in DSH Desktop never leaves
  // `/api/dsh-delegate/*` returning 404 while Windows PowerShell checks symlink paths.
  // The `/codex` and `/antigravity` user-plane routes await their respective refresh
  // promise before reading or mutating files so there is no startup read/write race.
  const codexStartupRefresh = (async () => {
    try {
      // Both halves of the installed-integration check: a byte-exact shipped agent is
      // refreshed, and an ALREADY INSTALLED managed `mcp_servers.dsh-delegate` entry that
      // is merely stale (for example one written before `tool_timeout_sec` existed) is
      // upgraded in place. Nothing is created here — a home without an entry stays
      // without one — and an entry this plugin cannot prove it wrote is refused and left
      // byte-identical.
      //
      // The TARGET is the seam's own decision (`startupTarget`), not a second read of
      // `process.env`: an explicit `CODEX_HOME`, else the home this plugin recorded from a
      // successful install, else the default only when it is a real directory. A default
      // that is a link is reported instead of walked, so the automatic upgrade never
      // writes into a tree nobody named.
      const target = await deps.codex?.startupTarget?.();
      let migration = null;
      if (target?.home) {
        migration = await deps.codex?.refreshManagedIntegration({
          startupTarget: target,
          // The pre-write copy lives in the plugin's own data directory: supportable, not
          // packaged, and never inside the Codex home.
          backupDir: join(dataDir, 'codex-config-backup'),
        });
      } else if (target !== undefined && target !== null) {
        logger?.info?.(`dsh-delegate: Codex integration check skipped (${target.reason})`);
      }
      if (migration?.changed.includes('agent')) {
        logger?.info?.(`dsh-delegate: refreshed a managed Codex skill template to ${pluginVersion}`);
      }
      if (migration?.changed.includes('legacyAgent')) {
        logger?.info?.('dsh-delegate: removed managed legacy Codex subagent files');
      }
      if (migration?.changed.includes('mcp')) {
        logger?.info?.('dsh-delegate: upgraded a stale managed Codex MCP entry in place');
      }
      for (const refusal of migration?.refused ?? []) {
        logger?.warn?.(`dsh-delegate: Codex integration refresh was refused (${refusal.code})`);
      }
    } catch (error) {
      logger?.warn?.(`dsh-delegate: Codex integration refresh check failed (${diagnostic(error?.message ?? error, 200)})`);
    }
  })().finally(() => {
    if (deps.codexStartupRefresh === codexStartupRefresh) deps.codexStartupRefresh = null;
  });
  deps.codexStartupRefresh = codexStartupRefresh;

  const antigravityStartupRefresh = (async () => {
    try {
      const agyTarget = await deps.antigravity?.startupTarget?.();
      let agyMigration = null;
      if (agyTarget?.home) {
        agyMigration = await deps.antigravity?.refreshManagedIntegration({ startupTarget: agyTarget });
      } else if (agyTarget !== undefined && agyTarget !== null) {
        logger?.info?.(`dsh-delegate: Antigravity integration check skipped (${agyTarget.reason})`);
      }
      if (agyMigration?.changed.includes('plugin')) {
        logger?.info?.(`dsh-delegate: refreshed a managed Antigravity plugin bundle to ${pluginVersion}`);
      }
      if (agyMigration?.changed.includes('mcp')) {
        logger?.info?.('dsh-delegate: upgraded a stale managed Antigravity MCP entry in place');
      }
      for (const refusal of agyMigration?.refused ?? []) {
        logger?.warn?.(`dsh-delegate: Antigravity integration refresh was refused (${refusal.code})`);
      }
    } catch (error) {
      logger?.warn?.(`dsh-delegate: Antigravity integration refresh check failed (${diagnostic(error?.message ?? error, 200)})`);
    }
  })().finally(() => {
    if (deps.antigravityStartupRefresh === antigravityStartupRefresh) deps.antigravityStartupRefresh = null;
  });
  deps.antigravityStartupRefresh = antigravityStartupRefresh;

  await Promise.all([codexStartupRefresh, antigravityStartupRefresh]);
}

/**
 * Version reported by the runtime facts block and stamped into the Codex integration.
 *
 * Read from the package manifest this build ships in, never written as a literal: two
 * copies of one fact drift, and a host asking a pre-release build which version it is
 * must not be told the last released number.
 *
 * There is deliberately NO module-level constant: a host hot update replaces the manifest
 * under a running instance, so the value is taken per activation
 * (`reportedVersion({ refresh: true })` at the top of {@link apply}) rather than frozen
 * when this module was first loaded.
 */

/**
 * Read the native approval service without turning absence into a throw.
 *
 * The bridge is offered only when this service exists AND exposes `request()`,
 * because that call is the seam a native tool uses to ask. A service that is
 * present but cannot be asked through (a half-composed or replaced approval
 * runtime) is treated as absent, so the run keeps the deterministic `never`
 * stance instead of installing an `ask` nobody services.
 * @param {object} ctx - plugin context.
 * @returns {object | null} the approval service, or null.
 */
function readOptionalApprovalService(ctx) {
  if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return null;
  let service;
  try {
    service = ctx.get('approval', false) ?? null;
  } catch {
    return null;
  }
  if (service === null || typeof service !== 'object' || typeof service.request !== 'function') return null;
  return service;
}

/**
 * Build the per-run permission bridge factory the job engine calls.
 *
 * The factory returns a bridge ONLY when the deployment can service the request it
 * would surface: the native approval seam must be composed and askable. It returns
 * `null` otherwise, which the engine treats as "this run is not bridged" — the
 * stance stays `never` and nothing about the run changes.
 *
 * The bridge it returns carries:
 *
 *  * the task and connection identity the commander's decision is checked against;
 *  * the deployment's own redaction (`redactText`), so no argument value or asker
 *    claim can publish a credential;
 *  * a per-request deadline of {@link PERMISSION_DEFAULT_TIMEOUT_MS} — a fixed,
 *    documented bound, never an infinite wait;
 *  * the observers the ENGINE owns (it records the phase and accounts the wait),
 *    supplied by the engine's own call so this factory holds no task state.
 * @param {object} options - `getApprovalService` (live accessor), `logger`.
 * @returns {(request: object) => object | null} factory.
 */
function createPermissionBridgeFactory(options) {
  return function permissionBridge(request) {
    const approval = typeof options?.getApprovalService === 'function' ? options.getApprovalService() : null;
    if (approval === null) return null;
    try {
      return new PermissionBridge({
        taskId: request?.taskId,
        connectionId: request?.connectionId,
        timeoutMs: PERMISSION_DEFAULT_TIMEOUT_MS,
        // BOTH halves of redaction: the scalar patterns AND the key-aware predicate.
        // The second one is what stops `{"apiKey":"…"}` being published verbatim,
        // because that secret carries no credential-shaped TEXT at all.
        redact: (text) => redactText(text),
        isSecretKey,
        // The REAL native message factory. Without it the bridge would fall back to a
        // locally built object, and the note reaching the worker would be a look-alike
        // rather than a message the native inbox normalised.
        createUserMessage: approvalFeedbackMessage,
        onPending: request?.onPending,
        onSettled: request?.onSettled,
        logger: options?.logger ?? null,
      });
    } catch (error) {
      options?.logger?.warn?.('dsh-delegate: the permission bridge could not be constructed', String(error?.code ?? ''));
      return null;
    }
  };
}

/**
 * Whether this harness composes the native user-questions seam.
 *
 * Read live, per run, through the non-strict accessor: DSH may compose
 * `ctx.userQuestions` after this plugin activated, and a missing seam is a fact (the
 * worker's tool surface then simply has no `ask_user_question`), not a failure.
 * @param {object} ctx - plugin context.
 * @returns {boolean} true when the native service is present.
 */
function hasQuestionService(ctx) {
  if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return false;
  try {
    return ctx.get('userQuestions', false) !== undefined && ctx.get('userQuestions', false) !== null;
  } catch {
    // A service whose read is refused is treated as absent, never as present.
    return false;
  }
}

/**
 * Build the ordinary-question bridge factory.
 *
 * A bridge is produced only when the harness composes the native question seam AND the
 * Agent-scoped answerer can be registered, which is decided per run by the runner. The
 * factory itself holds no task state: the observers belong to the engine, which is what
 * records the phase and accounts the paused budget.
 * @param {object} options - `hasQuestionService` (live predicate), `logger`.
 * @returns {(request: object) => object | null} factory.
 */
function createQuestionBridgeFactory(options) {
  return function questionBridge(request) {
    const present = typeof options?.hasQuestionService === 'function' ? options.hasQuestionService() : false;
    if (present !== true) return null;
    try {
      return new QuestionBridge({
        taskId: request?.taskId,
        connectionId: request?.connectionId,
        onPending: request?.onPending,
        onSettled: request?.onSettled,
        logger: options?.logger ?? null,
      });
    } catch (error) {
      options?.logger?.warn?.('dsh-delegate: the question bridge could not be constructed', String(error?.code ?? ''));
      return null;
    }
  };
}

/**
 * Resolve the plugin's own data directory.
 *
 * Precedence matches the harness's own home resolution: an explicit plugin config
 * path, then `$DSH_HOME`, then `~/.dsh`. A blank `DSH_HOME` is treated as unset so
 * a whitespace override can never resolve state into the current directory.
 * @param {object} ctx - plugin context (unused for paths; kept for signature symmetry).
 * @param {object} config - plugin config.
 * @returns {Promise<string>} absolute data directory.
 */
async function resolveDataDir(ctx, config) {
  const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : '';
  const base = configured !== '' ? configured : defaultHome();
  const target = join(configured !== '' ? base : join(base, 'data'), 'dsh-delegate');
  await mkdir(target, { recursive: true, mode: 0o700 });
  return target;
}

function defaultHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  if (fromEnv !== '') return fromEnv;
  return join(homedir(), '.dsh');
}

/**
 * Whole-configuration connectivity report.
 *
 * Kept as an exported function because it is the shape an operator-facing
 * diagnostic and a test both want: one call, every configured provider, no HTTP
 * surface involved. The per-provider implementation lives in
 * `src/model/connectivity.js`; this function is the fan-out over the document.
 *
 * The four layers are reported independently because they fail for different
 * reasons and a caller must not conclude "the model is broken" from "the endpoint
 * is unreachable". The model layer sends a real, short request with a usable token
 * budget and treats a reasoning-only answer as success — reasoning models that
 * spend their budget thinking are working, not timing out.
 * @param {object} deps - dependency object with `settings`, `credentials`,
 *   `ensureRoutes`, `llm`, `probeModel`.
 * @returns {Promise<object>} `{ settings: object, providers: object[] }` report.
 */
export async function checkConnectivity(deps) {
  let snapshot;
  try {
    snapshot = await deps.settings.read();
  } catch (error) {
    return {
      ok: false,
      providers: [],
      error: { code: error?.code ?? 'SETTINGS_UNREADABLE', message: diagnostic(error?.message, 300) },
    };
  }
  const providers = [];
  for (const provider of snapshot.providers) {
    try {
      providers.push(await checkProviderConnectivity(deps, { providerId: provider.id }));
    } catch (error) {
      providers.push({
        providerId: provider.id,
        providerName: provider.name,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'CONNECTIVITY_FAILED',
          message: diagnostic(error?.message, 300),
        },
      });
    }
  }
  return {
    ok: providers.length > 0 && providers.every((entry) => entry.error === undefined || entry.error === null),
    providers,
  };
}

export { describeCatalog, resolveRoute };
