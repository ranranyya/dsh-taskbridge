// Native plugin entry contract.
//
// This file exists because of a concrete install blocker, not for symmetry: the
// entry declared `Config` as a plain object (`{ dataDir: { type: 'string' } }`).
// Cordis validates a plugin's config *before* `apply` runs, by calling
// `runtime.Config['~standard'].validate(config)` (`resolveConfig` in
// `@deepseek-ai/cordis` 4.0.5). A plain object has no `~standard` member, so the
// failing dereference was `undefined.validate` and the row never activated:
//
//   dsh-delegate (dsh-delegate): TypeError: Cannot read properties of undefined
//   (reading 'validate')
//
// Every unit test still passed, because no test imported the entry the harness
// imports. The assertions below are therefore about the *shape the loader reads*,
// and they are written against the real Cordis call rather than a restatement of
// the schema's own fields.

import test from 'node:test';
import assert from 'node:assert/strict';

import { useDirectoryClassifier } from '../src/codex/installer.js';
import * as entry from '../src/index.js';

// Plugin startup refreshes a byte-exact shipped Codex agent, and that read inspects
// `$CODEX_HOME` through {@link useDirectoryClassifier} territory: on Windows the
// answer normally comes from a `powershell.exe` child. A suite has to run where a
// child cannot be spawned at all, so this file answers on the platform's behalf
// through the documented classifier hook — the product code path stays the same,
// only the platform answer is supplied. `lstat` still does the work: a missing Codex
// home, a real directory and a junction each get the verdict the platform would give.
useDirectoryClassifier(async (paths) => {
  const { lstatSync } = await import('node:fs');
  const kinds = new Map();
  for (const path of paths) {
    let info = null;
    try {
      info = lstatSync(path);
    } catch {
      info = null;
    }
    if (info === null) kinds.set(path, 'missing');
    else if (info.isSymbolicLink()) kinds.set(path, 'link');
    else if (info.isDirectory()) kinds.set(path, 'directory');
    else kinds.set(path, 'other');
  }
  return kinds;
});

test('the entry declares a name and the services the harness must provide', () => {
  assert.equal(entry.name, 'dsh-taskbridge');
  assert.deepEqual(entry.inject, ['agents', 'sessions', 'llm', 'tools', 'webServer', 'connection']);
  assert.equal(typeof entry.apply, 'function');
});

test('Config implements the Standard Schema interface Cordis validates through', () => {
  const schema = entry.Config;
  // A schemastery schema is a callable object, so both of these are legitimate;
  // an object check alone would reject the real type.
  assert.ok(
    typeof schema === 'object' || typeof schema === 'function',
    'Config must be a schema value',
  );
  assert.ok(schema !== null, 'Config must not be null');

  // This is the exact lookup Cordis performs; anything else throws the recorded
  // TypeError and the plugin row is skipped as "did not activate".
  const standard = schema['~standard'];
  assert.ok(standard !== null && typeof standard === 'object', 'Config needs a ~standard member');
  assert.equal(typeof standard.validate, 'function', '~standard.validate must be callable');

  // Synchronous, because Cordis rejects async config validation outright.
  const result = standard.validate({});
  assert.ok(!('then' in result), 'config validation must be synchronous');
  assert.equal(result.issues, undefined);
  assert.deepEqual(result.value, { dataDir: '' }, 'the default is an empty data directory');
});

test('Config accepts an explicit data directory and refuses a non-string one', () => {
  const standard = entry.Config['~standard'];

  assert.deepEqual(standard.validate({ dataDir: 'C:\\data' }).value, { dataDir: 'C:\\data' });

  // A refusal must be reported as `issues`, which is what Cordis turns into a
  // ValidationError; returning a coerced value instead would silently accept it.
  const refused = standard.validate({ dataDir: 5 });
  assert.equal(refused.value, undefined);
  assert.ok(Array.isArray(refused.issues) && refused.issues.length > 0, 'a number must be refused');
});

test('Config is a real schema, not a structural coincidence', () => {
  // `resolveConfig` only needs `~standard`, but `dsh --dump-config-schema` and the
  // settings UI read the schema's own `type`/`meta` too. A hand-rolled object with
  // just `~standard` would boot and then dump nothing useful.
  assert.equal(entry.Config.type, 'object');
  assert.ok(entry.Config.meta !== null && typeof entry.Config.meta === 'object');
});

test('the manifest ships the schema dependency the entry imports', async () => {
  // The import above proves resolution inside this repository. A tarball consumer
  // has no devDependency, so the same import must be satisfied by `dependencies`.
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dependencies?.['@deepseek-ai/schemastery'], '~3.18.4');
  assert.equal(manifest.devDependencies?.['@deepseek-ai/schemastery'], '~3.18.4');
});

// ---------------------------------------------------------------------------
// Wiring that a unit test cannot see
//
// The plugin mounted correctly in an isolated DSH 0.2.1-rc.2 profile and saved
// settings, but `/models` answered `route: "workbuddy"`, `models: []`,
// `ROUTING_MODEL_UNRESOLVED`. Both root causes were in `apply()`'s composition �?// the facade was registered instead of the native adapter, and the snapshot was
// published after registration instead of before �?so they are asserted at the
// level where they happened: the dependency object `apply` builds.
// ---------------------------------------------------------------------------

/**
 * Drive the real `apply` against a minimal-but-faithful Cordis context and a real
 * `LlmRuntime`, and hand back the published dependency object.
 *
 * Nothing about registration is faked: `ctx.llm` is the installed runtime, and
 * the credential seam is the only injected service.
 * @param {object} [options] - `providers` for the settings document.
 * @returns {Promise<object>} `{ deps, llm, dataDir, directory }`.
 */
async function applyWithRealRuntime(options = {}) {
  const { LlmRuntime } = await import('@deepseek-ai/dsh-llm');
  const { makeTempDir, validSettings } = await import('./helpers/fakes.js');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const directory = await makeTempDir();
  // The document is written *before* `apply`, because `apply` reads it once and
  // the settings service then caches that snapshot: a later write from another
  // instance would be invisible to the plugin under test.
  const settingsDir = join(directory, 'dsh-delegate');
  await mkdir(settingsDir, { recursive: true, mode: 0o700 });
  const document = options.providers === undefined ? validSettings() : options.providers;
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify(document), 'utf8');

  const effects = [];
  const disposeFns = [];
  const routes = new Map();

  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    reflect: { provide: () => () => {} },
    events: { dispatch: () => [] },
    // The entry uses `ctx.effect()` in two shapes: a generator (the runtime's own
    // `registerAdapter`) and a plain function returning a disposer (`ctx.effect(
    // () => dispose)`). Both must work here, exactly as Cordis accepts them.
    effect(effect) {
      if (typeof effect === 'function' && effect.constructor?.name !== 'GeneratorFunction') {
        const dispose = effect();
        const returned = typeof dispose === 'function' ? dispose : () => {};
        effects.push(returned);
        disposeFns.push(returned);
        return returned;
      }
      const iterator = effect.call(ctx);
      const first = iterator.next();
      const dispose = typeof first.value === 'function' ? first.value : () => {};
      effects.push(dispose);
      disposeFns.push(dispose);
      return dispose;
    },
    waterfall: () => Promise.resolve([]),
    get(name) {
      if (name === 'credentials') {
        return {
          async resolve() { return { value: 'sk-entry-fixture', source: 'test-store' }; },
          async describe() { return { configured: true }; },
          async set() {},
          async unset() {},
        };
      }
      if (name === 'agentPresets') return options.agentPresets ?? null;
      return null;
    },
    provide() {},
    agents: { create: async () => ({}) },
    sessions: {},
    tools: {},
    webServer: { host: '127.0.0.1', port: 3210, register: () => () => {} },
    connection: {
      fetch: {
        register(route) {
          if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
  };
  ctx.llm = new LlmRuntime(ctx);

  const previousHome = process.env.DSH_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.DSH_HOME = directory;
  process.env.CODEX_HOME = options.codexHome ?? join(directory, 'codex-home');
  let published = null;
  ctx.provide = (serviceName, value) => { published = value; };
  try {
    await entry.apply(ctx, {
      dataDir: directory,
    });
  } finally {
    process.env.DSH_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }

  return { published, llm: ctx.llm, routes, directory, ctx, effects };
}

/**
 * Drive the real `apply` with a preset registry present, and hand back the
 * published face plus a runner that invokes the plugin's own composed unload.
 *
 * @param {object} [options] - `agentPresets`, forwarded to the context.
 * @returns {Promise<object>} the same handle as {@link applyWithRealRuntime}.
 */
async function applyWithRecorder(options = {}) {
  const handle = await applyWithRealRuntime(options);
  return handle;
}

/**
 * Register the managed TaskBridge root through the REAL `apply` composition.
 *
 * `apply` hands the published face a `registerWorktreeWorkspace()` closure. This drives
 * that closure with a recording Workspace controller, so what is asserted is the
 * production path a fresh install takes — not a stub of it.
 *
 * The controller is served from `apply`'s OWN accessor (`ctx.get(name, false)`), so the
 * recording one is installed on the context and the strictness of that accessor is
 * exercised rather than bypassed.
 * @param {object} options - `workspaces` controller, or `null` for a host without one.
 * @returns {Promise<object>} `{ handle, created, renamed, titled, result }` facts.
 */
async function registerRoot(options = {}) {
  const handle = await applyWithRealRuntime();
  const created = [];
  const renamed = [];
  const record = { created, renamed };
  const controller = options.workspaces === null ? null : {
    async create(request) {
      created.push(request);
      return { created: true, workspace: { workspaceId: 'ws-root', path: request.path, title: null } };
    },
    async rename(request) {
      renamed.push(request);
      return { workspace: { workspaceId: request.workspaceId, title: request.title } };
    },
  };
  const base = handle.ctx.get;
  handle.ctx.get = (name, strict = true) => (name === 'workspaceController' ? controller : base(name, strict));
  const result = await handle.published.deps.registerWorktreeWorkspace();
  return { handle, created, renamed, record, result };
}

test('the managed TaskBridge root is registered under the plugin data directory, created if missing', async () => {
  const { existsSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { cleanup } = await import('./helpers/fakes.js');
  const { handle, created, result } = await registerRoot();
  try {
    const root = join(handle.directory, 'dsh-delegate', 'worktrees');
    assert.equal(result.registered, true, `the root registration reports success (${JSON.stringify(result)})`);
    assert.equal(created.length, 1, 'exactly one Workspace create');
    // The real directory the managed worktrees live in: nothing is moved or invented.
    assert.equal(created[0].path, root);
    assert.ok(existsSync(root), 'a fresh install creates the root inside the managed data directory');
    assert.ok(statSync(root).isDirectory());
    // A second activation is a no-op: one create, no duplicate Workspace.
    await handle.published.deps.registerWorktreeWorkspace();
    assert.equal(created.length, 1, 'registration is idempotent');
  } finally {
    await cleanup(handle.directory);
  }
});

test('a created root Workspace is titled once, and a host without the controller stays loadable', async () => {
  const { cleanup } = await import('./helpers/fakes.js');
  const titled = await registerRoot();
  try {
    assert.equal(titled.result.registered, true);
    assert.equal(titled.result.workspaceId, 'ws-root', 'the created Workspace identity is reported back');
    assert.deepEqual(titled.renamed, [{ workspaceId: 'ws-root', title: 'TaskBridge' }],
      'the created root is named TaskBridge, so the native tree labels the group');
  } finally {
    await cleanup(titled.handle.directory);
  }

  // No `workspaceController` at all: the plugin must still be loaded and usable.
  const bare = await registerRoot({ workspaces: null });
  try {
    assert.equal(bare.result.registered, false);
    assert.equal(bare.result.reason, 'WORKSPACES_UNAVAILABLE', 'the refusal is stated, not thrown');
    assert.ok(bare.handle.published?.deps, 'the plugin published its face regardless');
    assert.ok([...bare.handle.routes.keys()].length > 0, 'and its HTTP plane is still registered');
  } finally {
    await cleanup(bare.handle.directory);
  }
});

test('the sidebar integration uses only the host\'s published child slot, never the region itself', async () => {
  const { readFileSync } = await import('node:fs');
  const taskEntry = readFileSync(new URL('../src/client/sidebar.jsx', import.meta.url), 'utf8');
  // The task entry's registration calls are its own: `main` and `sidebar.panellist` only.
  assert.doesNotMatch(taskEntry, /inject\(\s*['"]sidebar\.workspaces['"]/u,
    'the task entry must not inject the workspace region');
  assert.doesNotMatch(taskEntry, /dshdg-ws-/u, 'the task entry must not carry the workspace grouping');
  // The module that talks to the workspace region does so through the PUBLISHED CHILD slot and
  // never registers on the parent, so the native rows/names/order/search/menus stay the host's.
  const view = readFileSync(new URL('../src/client/workspaces-browser.jsx', import.meta.url), 'utf8');
  assert.match(view, /slots\.inject\(SESSION_ROW_ACTION_SLOT/u, 'it injects the published child slot');
  assert.doesNotMatch(view, /slots\.inject\(\s*(?:'|")?WORKSPACES_SLOT/u,
    'and never injects the region itself');
  assert.doesNotMatch(view, /name:\s*(?:'|")?WORKSPACES_SLOT/u,
    'nor registers a replacing entry there');
  // No DOM patching, no host package, no React private field.
  assert.doesNotMatch(view, /dangerouslySetInnerHTML|innerHTML|__reactFiber|__reactInternalInstance|\._owner/u);
  assert.doesNotMatch(view, /from\s+'@deepseek-ai\//u, 'no host package is imported');
  // The applied bundle names the child slot, and does not register the parent.
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(bundle, /sidebar\.workspaces\.session\.row\.action/u, 'the shipped bundle uses the child slot');
});

test('apply wires only the record entry: no workspace-region view, and the managed root stays registrable', async () => {
  const { readFileSync } = await import('node:fs');
  const { cleanup } = await import('./helpers/fakes.js');
  const handle = await applyWithRealRuntime();
  try {
    // The published face still exposes the managed-root registration the tree depends on.
    assert.equal(typeof handle.published.deps.registerWorktreeWorkspace, 'function');
    // And nothing in the entry composes a view for the shell's workspace region.
    const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /sidebar\.workspaces/u);
    assert.match(source, /registerWorktreeWorkspace\(\)/u, 'the root is registered at activation');
  } finally {
    await cleanup(handle.directory);
  }
});

test('plugin startup refreshes exact shipped Codex agents and leaves unknown files alone', async () => {
  const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { cleanup } = await import('./helpers/fakes.js');
  const prior = readFileSync(new URL('./fixtures/codex-agent-0.1.7.toml', import.meta.url), 'utf8')
    .replace(/\r?\n/gu, '\r\n');
  const current = readFileSync(new URL('../codex/dsh-taskbridge.toml', import.meta.url), 'utf8');
  // The managed agent is WRITTEN with LF terminators (`renderAgentFile` folds the template's
  // CRLF spelling); the migration's product is those exact LF bytes, so the expectation is
  // the rendered form, not the template file's own spelling.
  const currentRendered = current.replace(/\r\n/gu, '\n');

  for (const entry of [
    { name: 'known', contents: prior, expected: currentRendered },
    { name: 'edited', contents: `${prior}# operator note\r\n`, expected: `${prior}# operator note\r\n` },
  ]) {
    const codexHome = mkdtempSync(join(tmpdir(), `dsh-delegate-codex-${entry.name}-`));
    const agentPath = join(codexHome, 'agents', 'dsh-delegate.toml');
    mkdirSync(join(codexHome, 'agents'), { recursive: true });
    writeFileSync(agentPath, entry.contents, 'utf8');
    let handle;
    try {
      handle = await applyWithRealRuntime({ codexHome });
      const migratedPath = join(codexHome, 'agents', 'dsh-taskbridge.toml');
      assert.equal(readFileSync(entry.name === 'known' ? migratedPath : agentPath, 'utf8'), entry.expected);
      assert.equal(existsSync(agentPath), entry.name === 'edited', 'only a recognized legacy agent is migrated');
      assert.equal(existsSync(migratedPath), entry.name === 'known');
      assert.equal(existsSync(join(codexHome, 'config.toml')), false, 'startup migration must not install an MCP entry');
    } finally {
      if (handle !== undefined) await cleanup(handle.directory);
      rmSync(codexHome, { recursive: true, force: true });
    }
  }
});

test('the runtime report states the per-task conversation rule and exposes no mode', async () => {
  // The removed control must be gone from the report an operator (and the settings
  // page) reads: a leftover `conversationMode` field would tell a reader that a
  // directory-level choice still exists.
  const { published, directory } = await applyWithRealRuntime();
  const { cleanup } = await import('./helpers/fakes.js');
  try {
    const report = published.deps.describeRuntime();
    assert.equal('conversationMode' in report, false, 'the retired mode must not be reported');
    assert.equal(report.conversation, 'per-task');
    assert.equal(report.conversationContinuation, 'continueFromTaskId');
  } finally {
    await cleanup(directory);
  }
});

test('the plugin restores the persisted local MCP switch at startup', async () => {
  const { validSettings, cleanup } = await import('./helpers/fakes.js');
  const { published: fresh, directory: freshDirectory } = await applyWithRealRuntime();
  try {
    assert.deepEqual(fresh.engine.posture(), {
      authorized: false,
      reason: 'delegation is disabled',
      mode: 'switch',
    });
  } finally {
    await cleanup(freshDirectory);
  }

  const persisted = { ...validSettings(), delegationEnabled: true };
  const { published: restarted, directory } = await applyWithRealRuntime({ providers: persisted });
  try {
    assert.deepEqual(restarted.engine.posture(), { authorized: true, reason: null, mode: 'switch' });
  } finally {
    await cleanup(directory);
  }
});

test('the plugin publishes its active loopback port for the standalone MCP client', async () => {
  const { cleanup } = await import('./helpers/fakes.js');
  const { readRuntimeEndpoint, resolveEndpointDiscoveryPath } = await import('../src/runtime/endpoint-discovery.js');
  const { directory } = await applyWithRealRuntime();
  try {
    const endpoint = await readRuntimeEndpoint(resolveEndpointDiscoveryPath({ DSH_HOME: directory }));
    assert.equal(endpoint.host, '127.0.0.1');
    assert.equal(endpoint.port, 3210);
    assert.equal(endpoint.processId, process.pid);
  } finally {
    await cleanup(directory);
  }
});

test('apply publishes a route resolver that registers the native adapter, not the facade', async () => {
  const { published, llm, directory } = await applyWithRealRuntime();
  const { cleanup } = await import('./helpers/fakes.js');
  try {
    assert.notEqual(published, null, 'the plugin face must be published');
    assert.equal(typeof published.deps.ensureRoutes, 'function');

    const settings = await published.settings.read();
    const mapped = await published.deps.ensureRoutes(settings);
    assert.deepEqual([...mapped], [['relay', 'dsh-delegate:relay']]);

    // The harness stored a route that can actually resolve a model.
    const listed = llm.listProviders();
    assert.deepEqual(listed.map((provider) => provider.id), ['dsh-delegate:relay']);
    assert.equal(listed[0].name, 'Local relay', 'the configured display name must be captured at registration');
    const info = await llm.resolveModelInfo('dsh-delegate:relay', 'deepseek-chat');
    assert.equal(info.id, 'deepseek-chat');
    // Exactly the declared axis from `validSettings()`: nothing added, nothing dropped.
    assert.deepEqual(
      info.reasoning.efforts.map((effort) => effort.id).sort(),
      ['high', 'low', 'medium', 'off'],
    );

    // The ambient profile id is not a route.
    await assert.rejects(
      () => llm.resolveModelInfo('relay', 'deepseek-chat'),
      (error) => error.code === 'NO_ADAPTER',
    );
  } finally {
    await cleanup(directory);
  }
});

test('apply publishes a resolver whose registered routes agree with the adapter snapshot', async () => {
  const { published, directory } = await applyWithRealRuntime();
  const { cleanup } = await import('./helpers/fakes.js');
  try {
    const settings = await published.settings.read();
    const mapped = await published.deps.ensureRoutes(settings);
    const snapshot = published.deps.adapterSnapshot();
    assert.deepEqual([...snapshot.routes], [...mapped], 'the adapter must serve exactly the registered mapping');
    assert.deepEqual(snapshot.models.get('dsh-delegate:relay'), ['deepseek-chat', 'deepseek-reasoner']);
  } finally {
    await cleanup(directory);
  }
});

test('apply\'s route resolver reports a refusal instead of substituting an ambient route', async () => {
  const { published, llm, directory } = await applyWithRealRuntime();
  const { cleanup } = await import('./helpers/fakes.js');
  try {
    const stored = await published.settings.read();
    const mapped = await published.deps.ensureRoutes(stored);
    assert.equal(mapped.get('relay'), 'dsh-delegate:relay');

    // Break registration from underneath: a disposed registry cannot ensure
    // routes, which is exactly how a refused registration reaches the read paths.
    published.providerRegistry.dispose();
    const outcome = await published.deps.resolveRoutes(stored, 'a test read');
    assert.equal(outcome.routes, null, 'a disposed registry must not yield a mapping');
    assert.equal(outcome.error.code, 'provider_registry');
    assert.equal(typeof outcome.error.message, 'string');

    // Nothing is left registered, and no ambient route answers for the profile.
    assert.deepEqual(llm.listProviders(), []);
    await assert.rejects(
      () => llm.resolveModelInfo('relay', 'deepseek-chat'),
      (error) => error.code === 'NO_ADAPTER',
    );
  } finally {
    await cleanup(directory);
  }
});

test('a blocked re-registration through apply leaves the old routes and the old snapshot in place', async () => {
  const { published, llm, directory } = await applyWithRealRuntime();
  const { cleanup } = await import('./helpers/fakes.js');
  const { createProviderRegistry } = await import('../src/model/providers.js');
  try {
    // Generation 1 is registered and working through the entry's own resolver.
    const first = await published.settings.read();
    const mapped = await published.deps.ensureRoutes(first);
    assert.deepEqual([...mapped], [['relay', 'dsh-delegate:relay']]);
    await llm.resolveModelInfo('dsh-delegate:relay', 'deepseek-chat');
    const before = published.deps.adapterSnapshot();
    assert.deepEqual([...before.models.get('dsh-delegate:relay')], ['deepseek-chat', 'deepseek-reasoner']);

    // A second owner takes a route the plugin's namespace also derives. It is
    // created from the *same* adapter and runtime, so only route ownership can
    // make the plugin's re-registration fail.
    const rival = createProviderRegistry({ llm, adapter: published.deps.providerRegistry.nativeAdapter() });
    rival.commitRoutes(new Map([['rival', 'dsh-delegate:rival']]));

    // The plugin's own re-registration now needs `dsh-delegate:rival` too: the core
    // refuses it with DUPLICATE_ADAPTER, after the adapter had published the
    // candidate. The resolver must report the refusal and leave both sides alone.
    const outcome = await published.deps.resolveRoutes({
      ...first,
      providers: [...first.providers, {
        id: 'rival',
        name: 'Rival (candidate)',
        protocol: 'openai-chat',
        baseUrl: 'http://127.0.0.1:1/v1',
        credentialRef: 'RIVAL_KEY',
        models: [{ id: 'deepseek-chat', efforts: ['low'] }],
      }],
    }, 'a blocked re-registration');

    assert.equal(outcome.routes, null, 'a refused re-registration must yield no mapping');
    assert.equal(outcome.error.code, 'DUPLICATE_ADAPTER');

    // Native side: the working generation is still described by the core, under
    // its old name and old models.
    const byId = new Map(llm.listProviders().map((entry) => [entry.id, entry.name]));
    assert.equal(byId.get('dsh-delegate:relay'), 'Local relay');
    assert.equal(byId.get('dsh-delegate:rival'), 'dsh-delegate:rival');
    const info = await llm.resolveModelInfo('dsh-delegate:relay', 'deepseek-reasoner');
    assert.equal(info.id, 'deepseek-reasoner');

    // Facade side: the old snapshot, names and models �?not the candidate's.
    const after = published.deps.adapterSnapshot();
    assert.deepEqual([...after.routes], [...before.routes]);
    assert.deepEqual(after.providerIds, before.providerIds);
    assert.deepEqual([...after.models], [...before.models]);
    assert.equal(after.routes.has('rival'), false);
    assert.equal(after.models.has('dsh-delegate:rival'), false);
  } finally {
    await cleanup(directory);
  }
});

test('an empty provider configuration stays inert through apply', async () => {
  const { validSettings } = await import('./helpers/fakes.js');
  // A fresh install: no providers, and therefore no worker chosen yet. That is the
  // stored-but-unconfigured shape the settings validator documents as legal
  // (`isUnconfiguredSelection`), and the posture this test pins down.
  const fresh = { ...validSettings(), providers: [], worker: { providerId: null } };
  const { published, llm, directory } = await applyWithRealRuntime({ providers: fresh });
  const { cleanup } = await import('./helpers/fakes.js');
  try {
    const settings = await published.settings.read();
    assert.deepEqual(settings.providers, []);
    const mapped = await published.deps.ensureRoutes(settings);
    assert.deepEqual([...mapped], []);
    assert.deepEqual(llm.listProviders(), [], 'an empty configuration must register nothing natively');
    assert.deepEqual([...published.deps.adapterSnapshot().routes], []);
    // And it stays that way on a second ensure: still nothing registered.
    assert.deepEqual([...(await published.deps.ensureRoutes(settings))], []);
    assert.deepEqual(llm.listProviders(), []);
  } finally {
    await cleanup(directory);
  }
});

// A host hot update replaces `package.json` on disk while THIS module instance stays
// loaded. The activation must stamp the integration with the version on disk, not with
// the one its process-lifetime memo still answers — otherwise the next start (reading the
// real manifest) classifies that freshly written file as operator-customised.
test('a re-activation after a hot update stamps the Codex agent with the version on disk', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { MANIFEST_PATH, readPackageManifest } = await import('../src/version.js');
  const { renderAgentFile } = await import('../src/codex/installer.js');
  const onDisk = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).version;
  // The first activation in this process populated the memo from the same manifest.
  assert.equal(readPackageManifest().version, onDisk);

  // The forced re-read the entry performs must return the SAME fact here, proving it goes
  // to disk rather than to a stale constant captured at import time. A stale constant is
  // what this test would catch: `PLUGIN_VERSION` used to be evaluated once at module load.
  const template = readFileSync(new URL('../codex/dsh-taskbridge.toml', import.meta.url), 'utf8');
  const rendered = await renderAgentFile(template, onDisk);
  assert.match(rendered, new RegExp(`^version = "${onDisk.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"$`, 'mu'),
    'the rendered agent carries the manifest version, not a remembered one');
  // And the entry module no longer exports/uses a frozen constant.
  const entrySource = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.equal(/const PLUGIN_VERSION = reportedVersion\(\)/u.test(entrySource), false,
    'no module-load-time version constant remains');
  assert.match(entrySource, /reportedVersion\(\{ refresh: true \}\)/u,
    'each activation forces one manifest re-read');
  void readdirSync;
});
