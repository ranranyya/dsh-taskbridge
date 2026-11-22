// Antigravity integration, 1.7.1 Codex upgrade, and worker-prompt black-box tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANTIGRAVITY_ACTIONS,
  ANTIGRAVITY_MCP_SERVER_NAME,
  ANTIGRAVITY_PLUGIN_NAME,
  readAntigravityStatus,
  refreshManagedAntigravityPlugin,
  resolveAntigravityHome,
  runAntigravityAction,
  useDirectoryClassifier,
} from '../src/antigravity/installer.js';
import { createAntigravitySeam } from '../src/antigravity/seam.js';
import { isKnownPriorTemplate, refreshKnownAgentTemplate } from '../src/codex/installer.js';
import { buildWorkerPrompt } from '../src/runtime/worker-prompt.js';
import {
  ANTIGRAVITY_ACTIONS as CLIENT_ANTIGRAVITY_ACTIONS,
  ROUTES,
  antigravityTargetView,
  createStore,
  defaultDraft,
  describeAntigravityOutcome,
  describeError,
} from '../src/client/api.js';
import { classifyError } from '../src/http/respond.js';
import { wrapUserPlaneRoutes } from '../src/http/user-plane.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

useDirectoryClassifier(async (paths) => {
  const kinds = new Map();
  for (const path of paths) {
    let info = null;
    try { info = lstatSync(path); } catch { info = null; }
    if (info === null) kinds.set(path, 'missing');
    else if (info.isSymbolicLink()) kinds.set(path, 'link');
    else if (info.isDirectory()) kinds.set(path, 'directory');
    else kinds.set(path, 'other');
  }
  return kinds;
});

function tempEnv() {
  const root = mkdtempSync(join(tmpdir(), 'taskbridge-agy-'));
  const agyHome = join(root, '.gemini', 'config');
  const dshHome = join(root, '.dsh');
  mkdirSync(agyHome, { recursive: true });
  mkdirSync(dshHome, { recursive: true });
  return {
    root,
    agyHome,
    dshHome,
    env: {
      ANTIGRAVITY_CONFIG_DIR: agyHome,
      DSH_HOME: dshHome,
      DSH_DELEGATE_DISCOVERY_FILE: '',
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('resolveAntigravityHome honors ANTIGRAVITY_CONFIG_DIR, GEMINI_CONFIG_DIR, and defaults to ~/.gemini/config', () => {
  const customA = join(tmpdir(), 'agy-a');
  const customB = join(tmpdir(), 'agy-b');
  const homeDirectory = join(tmpdir(), 'agy-user');
  assert.equal(resolveAntigravityHome({ env: { ANTIGRAVITY_CONFIG_DIR: customA, GEMINI_CONFIG_DIR: customB } }), resolve(customA));
  assert.equal(resolveAntigravityHome({ env: { GEMINI_CONFIG_DIR: customB } }), resolve(customB));
  assert.equal(resolveAntigravityHome({ env: {}, homeDirectory }), join(resolve(homeDirectory), '.gemini', 'config'));
  assert.throws(() => resolveAntigravityHome({ env: { ANTIGRAVITY_CONFIG_DIR: 'relative/path' } }), /ANTIGRAVITY_CONFIG_DIR/);
});

test('status is strictly read-only and install/repair/remove manage only plugins/dsh-taskbridge without touching global files', async () => {
  const fx = tempEnv();
  try {
    const globalMcp = join(fx.agyHome, 'mcp_config.json');
    const globalConfig = join(fx.agyHome, 'config.json');
    writeFileSync(globalMcp, '{"mcpServers":{"user-server":{"command":"echo"}}}\n');
    writeFileSync(globalConfig, '{"userSettings":{"theme":"dark"}}\n');

    // Status creates nothing
    const before = await readAntigravityStatus({ antigravityHome: fx.agyHome, env: fx.env, version: '1.8.0' });
    assert.equal(before.plugin.state, 'not-installed');
    assert.equal(before.mcp.state, 'not-configured');
    assert.equal(before.ready, false);
    assert.equal(existsSync(join(fx.agyHome, 'plugins')), false);

    // Install writes the complete self-contained plugin bundle
    const installed = await runAntigravityAction('install', { antigravityHome: fx.agyHome, env: fx.env, version: '1.8.0' });
    assert.deepEqual(installed.changed.sort(), ['mcp', 'plugin']);
    assert.deepEqual(installed.refused, []);
    assert.equal(installed.status.ready, true);
    assert.equal(installed.status.plugin.state, 'installed');
    assert.equal(installed.status.mcp.state, 'configured');

    const pluginDir = join(fx.agyHome, 'plugins', ANTIGRAVITY_PLUGIN_NAME);
    const manifest = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'));
    assert.equal(manifest.name, ANTIGRAVITY_PLUGIN_NAME);
    assert.equal(manifest.version, '1.8.0');
    assert.equal(manifest.logo, 'assets/logo.svg');
    const mcpDoc = JSON.parse(readFileSync(join(pluginDir, 'mcp_config.json'), 'utf8'));
    assert.ok(mcpDoc.mcpServers[ANTIGRAVITY_MCP_SERVER_NAME]);
    assert.equal(mcpDoc.mcpServers[ANTIGRAVITY_MCP_SERVER_NAME].args[0], join(ROOT, 'bin', 'dsh-delegate-mcp.js'));
    assert.match(readFileSync(join(pluginDir, 'skills', 'dsh-taskbridge', 'SKILL.md'), 'utf8'), /name: dsh-taskbridge/u);
    assert.match(readFileSync(join(pluginDir, 'agents', 'dsh-taskbridge.md'), 'utf8'), /subagent: true/u);

    // Global files untouched
    assert.equal(readFileSync(globalMcp, 'utf8'), '{"mcpServers":{"user-server":{"command":"echo"}}}\n');
    assert.equal(readFileSync(globalConfig, 'utf8'), '{"userSettings":{"theme":"dark"}}\n');

    // Idempotent repeat install
    const repeat = await runAntigravityAction('install', { antigravityHome: fx.agyHome, env: fx.env, version: '1.8.0' });
    assert.deepEqual(repeat.changed, []);
    assert.deepEqual(repeat.refused, []);

    // Remove cleans up managed files and empty plugin directories
    const removed = await runAntigravityAction('remove', { antigravityHome: fx.agyHome, env: fx.env, version: '1.8.0' });
    assert.deepEqual(removed.changed.sort(), ['mcp', 'plugin']);
    assert.equal(removed.status.plugin.state, 'not-installed');
    assert.equal(removed.status.mcp.state, 'not-configured');
    assert.equal(existsSync(pluginDir), false);
    assert.equal(readFileSync(globalMcp, 'utf8'), '{"mcpServers":{"user-server":{"command":"echo"}}}\n');
  } finally {
    fx.cleanup();
  }
});

test('user edits to SKILL.md are preserved across install, repair, startup refresh, and remove', async () => {
  const fx = tempEnv();
  try {
    await runAntigravityAction('install', { antigravityHome: fx.agyHome, env: fx.env, version: '1.8.0' });
    const pluginDir = join(fx.agyHome, 'plugins', ANTIGRAVITY_PLUGIN_NAME);
    const skillPath = join(pluginDir, 'skills', 'dsh-taskbridge', 'SKILL.md');
    const customSkill = `${readFileSync(skillPath, 'utf8')}\n# User custom note\n`;
    writeFileSync(skillPath, customSkill);

    const status = await readAntigravityStatus({ antigravityHome: fx.agyHome, env: fx.env, version: '1.8.0' });
    assert.equal(status.plugin.state, 'modified');

    // Startup refresh upgrades unmodified managed files (plugin.json) while preserving customized SKILL.md
    const refreshed = await refreshManagedAntigravityPlugin({ antigravityHome: fx.agyHome, env: fx.env, version: '1.8.1' });
    assert.ok(refreshed.changed.includes('plugin'));
    assert.ok(refreshed.refused.some((r) => r.code === 'PLUGIN_USER_MODIFIED'));
    assert.equal(readFileSync(skillPath, 'utf8'), customSkill);
    const refreshedManifest = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'));
    assert.equal(refreshedManifest.version, '1.8.1');

    // Repair still repairs mcp_config.json without touching customized SKILL.md
    rmSync(join(pluginDir, 'mcp_config.json'));
    const repaired = await runAntigravityAction('repair', { antigravityHome: fx.agyHome, env: fx.env, version: '1.8.1' });
    assert.deepEqual(repaired.changed, ['mcp']);
    assert.equal(repaired.status.mcp.state, 'configured');
    assert.equal(readFileSync(skillPath, 'utf8'), customSkill);

    // Remove deletes managed files but preserves the user's edited SKILL.md
    const removed = await runAntigravityAction('remove', { antigravityHome: fx.agyHome, env: fx.env, version: '1.8.1' });
    assert.ok(removed.refused.some((r) => r.code === 'PLUGIN_USER_MODIFIED'));
    assert.equal(readFileSync(skillPath, 'utf8'), customSkill);
    assert.equal(existsSync(join(pluginDir, 'plugin.json')), false);

    // Re-install restores missing managed files while still preserving the user's edited SKILL.md
    const reinstalled = await runAntigravityAction('install', { antigravityHome: fx.agyHome, env: fx.env, version: '1.8.1' });
    assert.ok(reinstalled.changed.includes('plugin'));
    assert.ok(reinstalled.changed.includes('mcp'));
    assert.ok(reinstalled.refused.some((r) => r.code === 'PLUGIN_USER_MODIFIED'));
    assert.equal(existsSync(join(pluginDir, 'plugin.json')), true);
    assert.equal(existsSync(join(pluginDir, 'agents', 'dsh-taskbridge.md')), true);
    assert.equal(existsSync(join(pluginDir, 'mcp_config.json')), true);
    assert.equal(readFileSync(skillPath, 'utf8'), customSkill);

    // Unmodified plugin.json still upgrades even if the ownership directory is absent (e.g. different DSH_HOME)
    rmSync(join(fx.dshHome, 'data', 'dsh-delegate', 'antigravity-plugin-ownership'), { recursive: true, force: true });
    const crossProfile = await refreshManagedAntigravityPlugin({ antigravityHome: fx.agyHome, env: fx.env, version: '1.9.0' });
    assert.ok(crossProfile.changed.includes('plugin'));
    const upgradedManifest = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'));
    assert.equal(upgradedManifest.version, '1.9.0');
    assert.equal(readFileSync(skillPath, 'utf8'), customSkill);
  } finally {
    fx.cleanup();
  }
});

test('startup refresh upgrades an unmodified older Antigravity plugin version in place and skips fresh installs', async () => {
  const fx = tempEnv();
  try {
    const seam = createAntigravitySeam({ antigravityHome: fx.agyHome, env: fx.env, version: '1.8.0' });
    // Fresh home: startup refresh must NOT perform a first install
    const fresh = await seam.refreshManagedIntegration();
    assert.deepEqual(fresh.changed, []);
    assert.equal(existsSync(join(fx.agyHome, 'plugins', ANTIGRAVITY_PLUGIN_NAME)), false);

    // Explicit install at 1.8.0
    const install = await seam.run('install');
    assert.equal(install.status.ready, true);

    // Newer build 1.9.0 refreshes unmodified managed plugin on startup
    const seamNext = createAntigravitySeam({ antigravityHome: fx.agyHome, env: fx.env, version: '1.9.0' });
    const upgraded = await seamNext.refreshManagedIntegration();
    assert.ok(upgraded.changed.includes('plugin'));
    assert.equal(upgraded.status.plugin.state, 'installed');
    const manifest = JSON.parse(readFileSync(join(fx.agyHome, 'plugins', ANTIGRAVITY_PLUGIN_NAME, 'plugin.json'), 'utf8'));
    assert.equal(manifest.version, '1.9.0');
  } finally {
    fx.cleanup();
  }
});

test('user-plane /api/dsh-delegate/antigravity serves GET status and POST actions without changing the switch', async () => {
  const fx = tempEnv();
  try {
    const seam = createAntigravitySeam({ antigravityHome: fx.agyHome, env: fx.env, version: '1.8.0' });
    const routes = wrapUserPlaneRoutes({
      antigravity: seam,
      engine: { posture: () => ({ authorized: false, mode: 'switch', reason: 'off' }) },
    });
    const route = routes.find((r) => r.path === '/api/dsh-delegate/antigravity');
    assert.ok(route, 'antigravity route must be registered');

    const getRes = await route.fetch(new Request('http://localhost/api/dsh-delegate/antigravity', { method: 'GET' }));
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.ok, true);
    assert.equal(getBody.antigravity.plugin.state, 'not-installed');
    assert.equal(getBody.switch.authorized, false);
    assert.equal(getBody.switch.changedByThisAction, false);

    const postRes = await route.fetch(new Request('http://localhost/api/dsh-delegate/antigravity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'install' }),
    }));
    assert.equal(postRes.status, 200);
    const postBody = await postRes.json();
    assert.equal(postBody.ok, true);
    assert.equal(postBody.antigravity.ready, true);
    assert.equal(postBody.switch.authorized, false);

    const badRes = await route.fetch(new Request('http://localhost/api/dsh-delegate/antigravity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'status' }),
    }));
    assert.equal(badRes.status, 400);
  } finally {
    fx.cleanup();
  }
});

test('client store and built bundle expose Antigravity integration tab and actions', async () => {
  assert.equal(ROUTES.antigravity, '/api/dsh-delegate/antigravity');
  assert.deepEqual([...CLIENT_ANTIGRAVITY_ACTIONS], ['install', 'repair', 'remove']);
  assert.match(BUNDLE, /Antigravity 集成（插件包 \+ Skill \+ 子智能体 \+ MCP）/u);
  assert.match(BUNDLE, /安装 \/ 更新 Antigravity 插件/u);
  assert.match(BUNDLE, /key:\s*"antigravity"/u);
  assert.match(BUNDLE, /AntigravityPanel/u);

  const calls = [];
  const api = {
    async getStatus() { return { ok: true, delegation: { authorized: false }, runtime: {} }; },
    async getSettings() { return { ok: true, settings: defaultDraft() }; },
    async getNativeProviders() { return { ok: true, providers: [] }; },
    async listTasks() { return { ok: true, tasks: [] }; },
    async getCatalog() { return { ok: true, catalog: [], effective: null }; },
    async getCodexStatus() { return { ok: true, codex: { ready: false }, switch: { authorized: false } }; },
    async getAntigravityStatus() {
      calls.push('GET antigravity');
      return {
        ok: true,
        antigravity: {
          antigravityHome: 'C:\\Users\\demo\\.gemini\\config',
          plugin: { state: 'not-installed', installed: false, path: 'P' },
          mcp: { state: 'not-configured', configured: false, path: 'M', script: 'S' },
          ready: false,
          notes: [],
        },
        switch: { authorized: false },
      };
    },
    async runAntigravityAction(action) {
      calls.push(`POST antigravity ${action}`);
      const ready = action !== 'remove';
      return {
        ok: true,
        action,
        changed: ['plugin', 'mcp'],
        refused: [],
        antigravity: {
          antigravityHome: 'C:\\Users\\demo\\.gemini\\config',
          plugin: { state: ready ? 'installed' : 'not-installed', installed: ready, path: 'P' },
          mcp: { state: ready ? 'configured' : 'not-configured', configured: ready, path: 'M', script: 'S' },
          ready,
          notes: [],
        },
        switch: { authorized: false, changedByThisAction: false },
      };
    },
  };
  const store = createStore({ api });
  await store.init();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls.includes('GET antigravity'));
  assert.deepEqual(calls.filter((c) => c.startsWith('POST antigravity')), []);

  const result = await store.runAntigravityAction('install');
  assert.equal(result.ok, true);
  assert.equal(store.getSnapshot().antigravity.ready, true);
  assert.equal(antigravityTargetView(store.getSnapshot().antigravity, null, 'plugin').tone, 'on');
  assert.match(describeAntigravityOutcome({ action: 'install', changed: ['plugin', 'mcp'], refused: [] }), /插件与规则文件、MCP 配置/u);
});

test('worker-prompt automatically protects uncommitted changes for shared or dirty checkouts, prefers native file tools, and cleans temp logs', () => {
  const shared = buildWorkerPrompt({ taskId: 't1', prompt: 'Fix bug', workspacePath: '/repo', isolation: 'shared' });
  assert.match(shared, /Preserve existing uncommitted changes and unrelated files/u);
  assert.match(shared, /remove those untracked temporary log files before finishing/u);
  assert.match(shared, /Always prefer native file\/search\/edit tools/u);
  assert.match(shared, /Do not install packages or make external network requests/u);
  const dirty = buildWorkerPrompt({ taskId: 't2', prompt: 'Fix bug', workspacePath: '/repo', isolation: 'worktree', baseline: { dirtyBaseline: true } });
  assert.match(dirty, /Preserve existing uncommitted changes and unrelated files/u);
  const clean = buildWorkerPrompt({ taskId: 't3', prompt: 'Fix bug', workspacePath: '/repo', isolation: 'worktree', baseline: { dirtyBaseline: false } });
  assert.doesNotMatch(clean, /Preserve existing uncommitted changes/u);
});

test('createAntigravitySeam forwards homeDirectory and ANTIGRAVITY error codes map cleanly', async () => {
  const fx = tempEnv();
  try {
    const customUserHome = join(fx.root, 'fake-user');
    const seam = createAntigravitySeam({ homeDirectory: customUserHome, env: { DSH_HOME: fx.dshHome }, version: '1.8.0' });
    const status = await seam.status();
    assert.equal(status.status.antigravityHome, resolve(join(customUserHome, '.gemini', 'config')));

    assert.equal(classifyError({ code: 'ANTIGRAVITY_INTEGRATION_UNAVAILABLE', message: 'off' }).status, 503);
    assert.equal(classifyError({ code: 'ANTIGRAVITY_HOME_INVALID', message: 'bad' }).status, 400);
    assert.equal(classifyError({ code: 'ANTIGRAVITY_PATH_CONFLICT', message: 'conflict' }).status, 409);
    assert.match(describeError({ code: 'ANTIGRAVITY_PATH_CONFLICT', message: 'raw' }), /Antigravity 插件目录存在冲突/u);
  } finally {
    fx.cleanup();
  }
});

test('published 1.7.1 Codex companion fixture upgrades cleanly to 1.8.0 in both LF and CRLF forms', async () => {
  const prior = readFileSync(join(ROOT, 'tests', 'fixtures', 'agent-1.7.1.toml'), 'utf8');
  const lf = prior.replace(/\r\n/gu, '\n');
  assert.equal(isKnownPriorTemplate(prior), true);
  assert.equal(isKnownPriorTemplate(lf), true);
  const home = mkdtempSync(join(tmpdir(), 'taskbridge-171-upgrade-'));
  try {
    mkdirSync(join(home, 'agents'));
    writeFileSync(join(home, 'agents', 'dsh-taskbridge.toml'), lf);
    const res = await refreshKnownAgentTemplate({
      codexHome: home,
      env: { DSH_HOME: join(home, '.dsh') },
      version: '1.8.0',
    });
    assert.deepEqual(res.changed, ['agent']);
    assert.deepEqual(res.refused, []);
    assert.match(readFileSync(join(home, 'agents', 'dsh-taskbridge.toml'), 'utf8'), /^version = "1\.8\.0"$/mu);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('antigravity subagent omits call_mcp_tool from tools frontmatter (auto-injected via mcp_config.json) and SKILL defaults to flash subagent', () => {
  const agent = readFileSync(join(ROOT, 'antigravity', 'agents', 'dsh-taskbridge.md'), 'utf8');
  const skill = readFileSync(join(ROOT, 'antigravity', 'skills', 'dsh-taskbridge', 'SKILL.md'), 'utf8');
  // Listing `call_mcp_tool` in Antigravity YAML `tools:` causes executor startup failure:
  // "unknown component: tool \"call_mcp_tool\" not found in registry". Antigravity injects
  // MCP tools automatically from the plugin's `mcp_config.json`.
  assert.doesNotMatch(agent, /^\s*-\s*call_mcp_tool\s*$/mu);
  assert.match(agent, /^\s*-\s*read_file\s*$/mu);
  assert.match(agent, /^\s*-\s*send_message\s*$/mu);
  assert.match(skill, /Model:\s*"flash"/u);
  assert.match(skill, /PREFLIGHT_NO_COMMITS/u);
  assert.match(skill, /answerReceipt\.applied === true/u);
});
