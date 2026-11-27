// Antigravity integration: install the self-contained DSH TaskBridge plugin bundle
// into `<ANTIGRAVITY_CONFIG_DIR>/plugins/dsh-taskbridge/` (default `~/.gemini/config`).
//
// Everything lives inside that single plugin directory so Antigravity can toggle or
// uninstall it cleanly without touching `~/.gemini/config/mcp_config.json` or
// `~/.gemini/config/config.json`:
//
//   plugins/dsh-taskbridge/
//   ├── plugin.json
//   ├── mcp_config.json
//   ├── assets/logo.svg
//   ├── skills/dsh-taskbridge/SKILL.md
//   └── agents/dsh-taskbridge.md
//
// Safety and ownership mirror `src/codex/installer.js`:
//   * `status` is strictly read-only and never creates directories or files;
//   * root symlink/junction is resolved and pinned once; links inside the plugin
//     tree are refused as `conflict`;
//   * ownership is proved by content digest (current template or recorded managed
//     digest for this home) rather than by filename alone, so operator-edited
//     skills, agents or MCP entries are preserved and never overwritten or deleted;
//   * `install` manages both the plugin files and `mcp_config.json`, `repair` fixes
//     MCP (plus a missing/outdated `plugin.json` manifest only) without touching
//     skills or agents, and `remove` deletes only verified plugin-managed files;
//   * startup refresh updates already-installed, unmodified outdated files in place
//     and never performs a first install.

import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeFileAtomic } from '../config/store.js';
import { digestLf, pluginDataDirectory } from '../codex/agent-ownership.js';
import {
  DISCOVERY_ENV_VAR,
  MCP_ENTRY_RELATIVE,
  digest,
  inspectDirectories,
  inspectDirectory,
  isNodeExecutableName,
  isOwnedEntryScript,
  resolveNodeExecutable,
  useDirectoryClassifier,
} from '../codex/installer.js';
import { resolveDefaultEndpointDiscoveryPath, resolveEndpointDiscoveryPath } from '../runtime/endpoint-discovery.js';

function sameFsPath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export const ANTIGRAVITY_PLUGIN_NAME = 'dsh-taskbridge';
export const ANTIGRAVITY_MCP_SERVER_NAME = 'dsh-taskbridge';
export const ANTIGRAVITY_ACTIONS = Object.freeze(['status', 'install', 'repair', 'remove']);

export const ANTIGRAVITY_PLUGIN_STATES = Object.freeze({
  missing: 'not-installed',
  installed: 'installed',
  outdated: 'outdated',
  modified: 'modified',
  conflict: 'conflict',
});

export const ANTIGRAVITY_MCP_STATES = Object.freeze({
  missing: 'not-configured',
  configured: 'configured',
  outdated: 'outdated',
  conflict: 'conflict',
  unreadable: 'unreadable',
});

export const ANTIGRAVITY_ENV_VARS = Object.freeze(['ANTIGRAVITY_CONFIG_DIR', 'GEMINI_CONFIG_DIR']);

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGE_MANIFEST_PATH = join(PACKAGE_ROOT, 'package.json');
const SKILL_TEMPLATE_PATH = join(PACKAGE_ROOT, 'integrations', 'targets', 'antigravity', 'skills', 'dsh-taskbridge', 'SKILL.md');
const AGENT_TEMPLATE_PATH = join(PACKAGE_ROOT, 'integrations', 'targets', 'antigravity', 'agents', 'dsh-taskbridge.md');
const LOGO_TEMPLATE_PATH = join(PACKAGE_ROOT, 'icon.svg');

const PLUGIN_FILE_KEYS = Object.freeze([
  'plugin.json',
  'skills/dsh-taskbridge/SKILL.md',
  'agents/dsh-taskbridge.md',
  'assets/logo.svg',
]);

const MCP_FILE_KEY = 'mcp_config.json';
const OWNERSHIP_DIR_NAME = 'antigravity-plugin-ownership';
const OWNERSHIP_SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OWNERSHIP_BYTES = 8192;
const SHA256_RE = /^[0-9a-f]{64}$/u;

const ALLOWED_MCP_ENTRY_KEYS = new Set(['command', 'args', 'env']);

export class AntigravityInstallError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AntigravityInstallError';
    this.code = code;
    this.details = details;
  }
}

export { useDirectoryClassifier };

function normalizeLf(text) {
  return String(text ?? '').replace(/\r\n/gu, '\n');
}

function sameTextLf(left, right) {
  if (left === right) return true;
  const a = normalizeLf(left);
  const b = normalizeLf(right);
  if (a.includes('\r') || b.includes('\r')) return false;
  return a === b;
}

export function resolveAntigravityHome({ env = process.env, homeDirectory = homedir() } = {}) {
  for (const key of ANTIGRAVITY_ENV_VARS) {
    const configured = typeof env?.[key] === 'string' ? env[key].trim() : '';
    if (configured !== '') {
      if (!isAbsolute(configured)) {
        throw new AntigravityInstallError('ANTIGRAVITY_HOME_INVALID', `${key} must be an absolute path`);
      }
      return resolve(configured);
    }
  }
  return resolve(join(homeDirectory, '.gemini', 'config'));
}

export function requireAntigravityHome(antigravityHome) {
  if (typeof antigravityHome !== 'string' || antigravityHome.trim() === '' || !isAbsolute(antigravityHome)) {
    throw new AntigravityInstallError('ANTIGRAVITY_HOME_INVALID', 'the Antigravity config directory must be an absolute path');
  }
  return resolve(antigravityHome);
}

async function readPackageVersion() {
  try {
    const manifest = JSON.parse(await readFile(PACKAGE_MANIFEST_PATH, 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : '';
  } catch {
    return '';
  }
}

export function renderAntigravityManifest(version) {
  const manifest = {
    name: ANTIGRAVITY_PLUGIN_NAME,
    displayName: 'DSH TaskBridge',
    version: version || '0.0.0',
    description: '通过 DSH TaskBridge MCP 服务向 DeepSeek Harness 派工，支持先定方案后派工、后台静默等待、逐次权限审批与集中审查验收。',
    logo: 'assets/logo.svg',
    suggestedPrompts: [
      '把当前仓库的功能修改交给 DSH TaskBridge 执行并在交付后审查',
      '检查 DSH TaskBridge 本机调用状态和当前工作区预检结果',
      '把多阶段目标拆成 TaskBridge 任务树并按顺序派给 DSH 执行',
    ],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function readAntigravityTemplates(versionOverride = null) {
  const version = typeof versionOverride === 'string' && versionOverride.trim() !== ''
    ? versionOverride.trim()
    : await readPackageVersion();
  const [skill, agent, logo] = await Promise.all([
    readFile(SKILL_TEMPLATE_PATH, 'utf8'),
    readFile(AGENT_TEMPLATE_PATH, 'utf8'),
    readFile(LOGO_TEMPLATE_PATH, 'utf8'),
  ]);
  return {
    version,
    files: {
      'plugin.json': renderAntigravityManifest(version),
      'skills/dsh-taskbridge/SKILL.md': normalizeLf(skill),
      'agents/dsh-taskbridge.md': normalizeLf(agent),
      'assets/logo.svg': normalizeLf(logo),
    },
  };
}

function pluginPathsFor(realHome) {
  const pluginsDir = join(realHome, 'plugins');
  const pluginDir = join(pluginsDir, ANTIGRAVITY_PLUGIN_NAME);
  return {
    pluginsDir,
    pluginDir,
    files: {
      'plugin.json': join(pluginDir, 'plugin.json'),
      'skills/dsh-taskbridge/SKILL.md': join(pluginDir, 'skills', 'dsh-taskbridge', 'SKILL.md'),
      'agents/dsh-taskbridge.md': join(pluginDir, 'agents', 'dsh-taskbridge.md'),
      'assets/logo.svg': join(pluginDir, 'assets', 'logo.svg'),
    },
    mcpPath: join(pluginDir, MCP_FILE_KEY),
    dirs: [
      pluginsDir,
      pluginDir,
      join(pluginDir, 'skills'),
      join(pluginDir, 'skills', 'dsh-taskbridge'),
      join(pluginDir, 'agents'),
      join(pluginDir, 'assets'),
    ],
  };
}

function ownershipPathFor(realHome, env = process.env) {
  const dataDir = pluginDataDirectory(env);
  if (dataDir === null) return null;
  const key = createHash('sha256').update(resolve(realHome), 'utf8').digest('hex');
  return join(dataDir, OWNERSHIP_DIR_NAME, `${key}.json`);
}

async function readOwnershipRecord(realHome, env = process.env) {
  const path = ownershipPathFor(realHome, env);
  if (path === null) return null;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_OWNERSHIP_BYTES) return null;
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.schemaVersion !== OWNERSHIP_SCHEMA_VERSION) return null;
    if (typeof parsed.antigravityHome !== 'string' || resolve(parsed.antigravityHome) !== resolve(realHome)) return null;
    if (parsed.files === null || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) return null;
    const files = {};
    for (const [k, v] of Object.entries(parsed.files)) {
      if (typeof v === 'string' && SHA256_RE.test(v)) files[k] = v;
    }
    return { path, files };
  } catch {
    return null;
  }
}

async function writeOwnershipRecord(realHome, pluginDir, fileDigests, env = process.env) {
  const path = ownershipPathFor(realHome, env);
  if (path === null) return false;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const record = {
      schemaVersion: OWNERSHIP_SCHEMA_VERSION,
      antigravityHome: resolve(realHome),
      pluginDir: resolve(pluginDir),
      files: fileDigests,
    };
    await writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

async function pinAntigravityHome(selected) {
  const info = await inspectDirectory(selected).catch(() => ({ kind: 'unknown' }));
  if (info.kind === 'missing' || info.kind === 'directory' || info.kind === 'unknown') {
    return { selected, real: selected, linked: false, linkTarget: null, error: null };
  }
  if (info.kind === 'link') {
    let resolved;
    try {
      resolved = await realpath(selected);
    } catch {
      return {
        selected,
        real: selected,
        linked: true,
        linkTarget: info.target ?? null,
        error: {
          code: 'ANTIGRAVITY_HOME_UNUSABLE',
          reason: 'antigravity-home-link-unresolvable',
          message: 'the Antigravity config directory link cannot be resolved to a real directory',
        },
      };
    }
    const targetInfo = await inspectDirectory(resolved).catch(() => ({ kind: 'unknown' }));
    if (targetInfo.kind !== 'directory') {
      return {
        selected,
        real: resolved,
        linked: true,
        linkTarget: info.target ?? null,
        error: {
          code: 'ANTIGRAVITY_HOME_UNUSABLE',
          reason: 'antigravity-home-target-not-a-directory',
          message: 'the Antigravity config directory link does not point at a real directory',
        },
      };
    }
    return { selected, real: resolved, linked: true, linkTarget: info.target ?? null, error: null };
  }
  return {
    selected,
    real: selected,
    linked: false,
    linkTarget: null,
    error: {
      code: 'ANTIGRAVITY_HOME_UNUSABLE',
      reason: 'antigravity-home-not-a-directory',
      message: 'the Antigravity config path exists but is not a directory',
    },
  };
}

async function inspectFileSafe(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { kind: 'missing' };
    throw error;
  }
  if (info.isSymbolicLink()) return { kind: 'link' };
  if (!info.isFile()) return { kind: 'other' };
  if (info.size > MAX_FILE_BYTES) return { kind: 'other' };
  return { kind: 'file', contents: await readFile(path, 'utf8') };
}

async function inspectBoundaries(realHome, paths) {
  let inspected;
  try {
    inspected = await inspectDirectories([realHome, ...paths.dirs]);
  } catch {
    inspected = new Map();
  }
  const rootInfo = inspected.get(realHome) ?? { kind: 'unknown' };
  if (rootInfo.kind !== 'missing' && rootInfo.kind !== 'directory') {
    return { ok: false, reason: rootInfo.kind === 'unknown' ? 'boundary-unverified' : 'antigravity-home-invalid', path: realHome };
  }
  for (const dir of paths.dirs) {
    const info = inspected.get(dir) ?? { kind: 'unknown' };
    if (info.kind === 'missing' || info.kind === 'directory') continue;
    return {
      ok: false,
      reason: info.kind === 'link' ? 'plugin-dir-is-link' : (info.kind === 'unknown' ? 'boundary-unverified' : 'plugin-dir-not-a-directory'),
      path: dir,
    };
  }
  return { ok: true, reason: null, path: null };
}

function desiredMcpConfig(options = {}) {
  const env = options.env ?? process.env;
  const script = resolve(join(PACKAGE_ROOT, MCP_ENTRY_RELATIVE));
  let node = null;
  let nodeError = null;
  try {
    node = typeof options.nodeExecutable === 'string' && options.nodeExecutable.trim() !== ''
      ? resolve(options.nodeExecutable)
      : resolveNodeExecutable({ env, execPath: options.execPath, resourcesPath: options.resourcesPath, versions: options.versions, platform: options.platform });
  } catch (error) {
    nodeError = {
      code: typeof error?.code === 'string' ? error.code : 'MCP_EXECUTABLE_UNRESOLVED',
      message: String(error?.message ?? 'no Node.js executable could be proved'),
    };
  }
  let discoveryFile = null;
  if (typeof options.discoveryFile === 'string' && options.discoveryFile.trim() !== '') {
    discoveryFile = resolve(options.discoveryFile);
  } else {
    const resolved = resolveEndpointDiscoveryPath(env);
    const defaultPath = resolveDefaultEndpointDiscoveryPath(env);
    if (resolved !== undefined && !sameFsPath(resolved, defaultPath)) {
      discoveryFile = resolve(resolved);
    }
  }
  const serverEntry = node === null ? null : {
    command: node,
    args: [script],
    ...(discoveryFile === null ? {} : { env: { [DISCOVERY_ENV_VAR]: discoveryFile } }),
  };
  return { node, nodeError, script, discoveryFile, serverEntry };
}

function renderMcpDocument(existingDoc, serverEntry) {
  const base = existingDoc !== null && typeof existingDoc === 'object' && !Array.isArray(existingDoc)
    ? { ...existingDoc }
    : {};
  const servers = base.mcpServers !== null && typeof base.mcpServers === 'object' && !Array.isArray(base.mcpServers)
    ? { ...base.mcpServers }
    : {};
  servers[ANTIGRAVITY_MCP_SERVER_NAME] = serverEntry;
  base.mcpServers = servers;
  return `${JSON.stringify(base, null, 2)}\n`;
}

function sameMcpEnv(actualEnv, desiredEnv) {
  const a = actualEnv === undefined ? null : actualEnv;
  const b = desiredEnv === undefined ? null : desiredEnv;
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || Array.isArray(a)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => typeof a[key] === 'string' && typeof b[key] === 'string' && sameFsPath(a[key], b[key]));
}

function isManagedMcpShape(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  for (const key of Object.keys(entry)) {
    if (!ALLOWED_MCP_ENTRY_KEYS.has(key)) return false;
  }
  if (typeof entry.command !== 'string' || !isNodeExecutableName(entry.command)) return false;
  if (!Array.isArray(entry.args) || entry.args.length !== 1 || typeof entry.args[0] !== 'string') return false;
  if (entry.env !== undefined) {
    if (entry.env === null || typeof entry.env !== 'object' || Array.isArray(entry.env)) return false;
    const keys = Object.keys(entry.env);
    if (keys.some((key) => key !== DISCOVERY_ENV_VAR || typeof entry.env[key] !== 'string')) return false;
  }
  return true;
}

async function classifyMcpFile({ mcpPath, desired, recordedDigest }) {
  const file = await inspectFileSafe(mcpPath);
  if (file.kind === 'missing') {
    return {
      path: mcpPath,
      state: ANTIGRAVITY_MCP_STATES.missing,
      configured: false,
      managed: true,
      serverName: ANTIGRAVITY_MCP_SERVER_NAME,
      script: desired.script,
      node: desired.node,
      nodeResolved: desired.node !== null,
      nodeError: desired.nodeError,
      reason: null,
      existingDoc: null,
      expectDigest: null,
    };
  }
  if (file.kind !== 'file') {
    return {
      path: mcpPath,
      state: ANTIGRAVITY_MCP_STATES.conflict,
      configured: false,
      managed: false,
      serverName: ANTIGRAVITY_MCP_SERVER_NAME,
      script: desired.script,
      node: desired.node,
      nodeResolved: desired.node !== null,
      nodeError: desired.nodeError,
      reason: file.kind === 'link' ? 'mcp-file-is-link' : 'mcp-file-not-regular',
      existingDoc: null,
      expectDigest: null,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(file.contents);
  } catch {
    return {
      path: mcpPath,
      state: ANTIGRAVITY_MCP_STATES.unreadable,
      configured: false,
      managed: false,
      serverName: ANTIGRAVITY_MCP_SERVER_NAME,
      script: desired.script,
      node: desired.node,
      nodeResolved: desired.node !== null,
      nodeError: desired.nodeError,
      reason: 'mcp-json-invalid',
      existingDoc: null,
      expectDigest: digest(file.contents),
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      path: mcpPath,
      state: ANTIGRAVITY_MCP_STATES.unreadable,
      configured: false,
      managed: false,
      serverName: ANTIGRAVITY_MCP_SERVER_NAME,
      script: desired.script,
      node: desired.node,
      nodeResolved: desired.node !== null,
      nodeError: desired.nodeError,
      reason: 'mcp-json-not-object',
      existingDoc: null,
      expectDigest: digest(file.contents),
    };
  }
  const servers = parsed.mcpServers;
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    return {
      path: mcpPath,
      state: ANTIGRAVITY_MCP_STATES.unreadable,
      configured: false,
      managed: false,
      serverName: ANTIGRAVITY_MCP_SERVER_NAME,
      script: desired.script,
      node: desired.node,
      nodeResolved: desired.node !== null,
      nodeError: desired.nodeError,
      reason: 'mcp-servers-not-object',
      existingDoc: null,
      expectDigest: digest(file.contents),
    };
  }
  const entry = servers?.[ANTIGRAVITY_MCP_SERVER_NAME];
  const fileDigest = digest(file.contents);
  if (entry === undefined) {
    return {
      path: mcpPath,
      state: ANTIGRAVITY_MCP_STATES.missing,
      configured: false,
      managed: true,
      serverName: ANTIGRAVITY_MCP_SERVER_NAME,
      script: desired.script,
      node: desired.node,
      nodeResolved: desired.node !== null,
      nodeError: desired.nodeError,
      reason: null,
      existingDoc: parsed,
      expectDigest: fileDigest,
    };
  }
  if (!isManagedMcpShape(entry)) {
    return {
      path: mcpPath,
      state: ANTIGRAVITY_MCP_STATES.conflict,
      configured: false,
      managed: false,
      serverName: ANTIGRAVITY_MCP_SERVER_NAME,
      script: desired.script,
      node: desired.node,
      nodeResolved: desired.node !== null,
      nodeError: desired.nodeError,
      reason: 'mcp-entry-customized',
      existingDoc: parsed,
      expectDigest: fileDigest,
    };
  }
  const exactMatch = desired.serverEntry !== null
    && sameFsPath(entry.command, desired.serverEntry.command)
    && sameFsPath(entry.args[0], desired.serverEntry.args[0])
    && sameMcpEnv(entry.env, desired.serverEntry.env);
  if (exactMatch) {
    return {
      path: mcpPath,
      state: ANTIGRAVITY_MCP_STATES.configured,
      configured: true,
      managed: true,
      serverName: ANTIGRAVITY_MCP_SERVER_NAME,
      script: desired.script,
      node: desired.node,
      nodeResolved: desired.node !== null,
      nodeError: desired.nodeError,
      reason: null,
      existingDoc: parsed,
      expectDigest: fileDigest,
    };
  }
  const recordedMatch = typeof recordedDigest === 'string' && digestLf(file.contents) === recordedDigest;
  const sameScript = sameFsPath(entry.args[0], desired.script);
  const ownedMovedScript = !sameScript && await isOwnedEntryScript(entry.args[0], desired.script);
  if (recordedMatch || sameScript || ownedMovedScript) {
    const reasons = [];
    if (desired.node !== null && !sameFsPath(entry.command, desired.node)) reasons.push('node-path-changed');
    if (!sameScript) reasons.push('script-path-changed');
    if (desired.serverEntry !== null && !sameMcpEnv(entry.env, desired.serverEntry.env)) reasons.push('discovery-env-changed');
    return {
      path: mcpPath,
      state: ANTIGRAVITY_MCP_STATES.outdated,
      configured: false,
      managed: true,
      serverName: ANTIGRAVITY_MCP_SERVER_NAME,
      script: desired.script,
      node: desired.node,
      nodeResolved: desired.node !== null,
      nodeError: desired.nodeError,
      reason: reasons.join(',') || 'mcp-outdated',
      movedScript: ownedMovedScript,
      existingDoc: parsed,
      expectDigest: fileDigest,
    };
  }
  return {
    path: mcpPath,
    state: ANTIGRAVITY_MCP_STATES.conflict,
    configured: false,
    managed: false,
    serverName: ANTIGRAVITY_MCP_SERVER_NAME,
    script: desired.script,
    node: desired.node,
    nodeResolved: desired.node !== null,
    nodeError: desired.nodeError,
    reason: 'mcp-script-unowned',
    existingDoc: parsed,
    expectDigest: fileDigest,
  };
}

/**
 * Exact LF SHA-256 digests of prior published Antigravity managed files.
 * Allows an untouched published installation (such as 1.8.0) to be recognized as
 * `outdated` and upgraded cleanly even if the local ownership sidecar is absent,
 * while any operator-edited file still classifies as `modified` and is preserved.
 */
const KNOWN_PRIOR_ANTIGRAVITY_FILES = Object.freeze({
  'skills/dsh-taskbridge/SKILL.md': Object.freeze([
    // Published 1.8.0 SKILL.md (LF)
    '9e83135ece937dbc0b73f5098509daac2fe4b973fe4dcd2ed75186745cf3cfee',
    // Published 1.8.1 SKILL.md (LF)
    'cb4b0645dbe0de74dce89c286ab61d91e258f24b85edfe6e6ade9362c9f31c14',
    // Published 1.9.0 / 1.9.1 SKILL.md (LF)
    '0a3f0e10cb627de8a8b5c02d92352226d233291294599ea8b824bb250b9ea2ab',
    // Published 1.9.2 SKILL.md (LF)
    'fcafaf1fcd90844e08d70676051c85187b00cecfd557637860292c3596e795b3',
  ]),
  'agents/dsh-taskbridge.md': Object.freeze([
    // Published 1.8.0 agents/dsh-taskbridge.md (LF)
    'df1418abe2c58c535734ecf6619bd027ca251d2dd6043cec9f41561d8e0a432b',
    // Published 1.8.1 agents/dsh-taskbridge.md (LF)
    'cadb5f5f4de640c89b924a75f53a09d38ee68df22086b5aa4aa516192970055b',
  ]),
});

function isManagedAntigravityManifest(contents) {
  try {
    const parsed = JSON.parse(contents);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    if (typeof parsed.version !== 'string' || parsed.version.trim() === '') return false;
    return sameTextLf(contents, renderAntigravityManifest(parsed.version));
  } catch {
    return false;
  }
}

async function classifyPluginFiles({ paths, templates, recordedFiles }) {
  const details = {};
  for (const key of PLUGIN_FILE_KEYS) {
    const targetPath = paths.files[key];
    const desiredText = templates.files[key];
    const file = await inspectFileSafe(targetPath);
    if (file.kind === 'missing') {
      details[key] = { path: targetPath, state: 'not-installed', expectDigest: null };
      continue;
    }
    if (file.kind !== 'file') {
      details[key] = {
        path: targetPath,
        state: 'conflict',
        reason: file.kind === 'link' ? 'file-is-link' : 'file-not-regular',
        expectDigest: null,
      };
      continue;
    }
    const rawDigest = digest(file.contents);
    if (sameTextLf(file.contents, desiredText)) {
      details[key] = { path: targetPath, state: 'installed', expectDigest: rawDigest };
      continue;
    }
    const recorded = recordedFiles?.[key] ?? null;
    const lfDigest = digestLf(file.contents);
    if (typeof recorded === 'string' && lfDigest === recorded) {
      details[key] = { path: targetPath, state: 'outdated', expectDigest: rawDigest };
      continue;
    }
    if (Array.isArray(KNOWN_PRIOR_ANTIGRAVITY_FILES[key]) && KNOWN_PRIOR_ANTIGRAVITY_FILES[key].includes(lfDigest)) {
      details[key] = { path: targetPath, state: 'outdated', expectDigest: rawDigest };
      continue;
    }
    if (key === 'plugin.json' && isManagedAntigravityManifest(file.contents)) {
      details[key] = { path: targetPath, state: 'outdated', expectDigest: rawDigest };
      continue;
    }
    details[key] = { path: targetPath, state: 'modified', expectDigest: rawDigest };
  }
  const states = Object.values(details).map((entry) => entry.state);
  let state;
  if (states.includes('conflict')) state = ANTIGRAVITY_PLUGIN_STATES.conflict;
  else if (states.includes('modified')) state = ANTIGRAVITY_PLUGIN_STATES.modified;
  else if (states.every((s) => s === 'not-installed')) state = ANTIGRAVITY_PLUGIN_STATES.missing;
  else if (states.every((s) => s === 'installed')) state = ANTIGRAVITY_PLUGIN_STATES.installed;
  else state = ANTIGRAVITY_PLUGIN_STATES.outdated;
  return {
    path: paths.pluginDir,
    state,
    installed: state === ANTIGRAVITY_PLUGIN_STATES.installed,
    managed: state !== ANTIGRAVITY_PLUGIN_STATES.modified && state !== ANTIGRAVITY_PLUGIN_STATES.conflict,
    files: details,
  };
}

export async function readAntigravityStatus(options = {}) {
  const env = options.env ?? process.env;
  const selectedHome = typeof options.antigravityHome === 'string' && options.antigravityHome.trim() !== ''
    ? requireAntigravityHome(options.antigravityHome)
    : resolveAntigravityHome({ env, homeDirectory: options.homeDirectory });

  const pinned = await pinAntigravityHome(selectedHome);
  const templates = await readAntigravityTemplates(options.version ?? null);
  const paths = pluginPathsFor(pinned.real);
  const desiredMcp = desiredMcpConfig(options);
  const notes = [];

  if (pinned.error !== null) {
    notes.push({ code: pinned.error.reason, text: pinned.error.message });
    return {
      antigravityHome: pinned.selected,
      realAntigravityHome: pinned.real,
      pluginDir: paths.pluginDir,
      packageVersion: templates.version,
      plugin: { path: paths.pluginDir, state: ANTIGRAVITY_PLUGIN_STATES.conflict, installed: false, managed: false, files: {} },
      mcp: {
        path: paths.mcpPath,
        state: ANTIGRAVITY_MCP_STATES.conflict,
        configured: false,
        managed: false,
        serverName: ANTIGRAVITY_MCP_SERVER_NAME,
        script: desiredMcp.script,
        node: desiredMcp.node,
        nodeResolved: desiredMcp.node !== null,
        nodeError: desiredMcp.nodeError,
        reason: pinned.error.reason,
      },
      ready: false,
      notes,
    };
  }

  const boundary = await inspectBoundaries(pinned.real, paths);
  if (!boundary.ok) {
    notes.push({
      code: boundary.reason,
      text: `检测到非普通目录边界（${boundary.path}），插件不会穿过软链接或异常路径写入文件。`,
    });
    return {
      antigravityHome: pinned.selected,
      realAntigravityHome: pinned.real,
      pluginDir: paths.pluginDir,
      packageVersion: templates.version,
      plugin: { path: paths.pluginDir, state: ANTIGRAVITY_PLUGIN_STATES.conflict, installed: false, managed: false, files: {} },
      mcp: {
        path: paths.mcpPath,
        state: ANTIGRAVITY_MCP_STATES.conflict,
        configured: false,
        managed: false,
        serverName: ANTIGRAVITY_MCP_SERVER_NAME,
        script: desiredMcp.script,
        node: desiredMcp.node,
        nodeResolved: desiredMcp.node !== null,
        nodeError: desiredMcp.nodeError,
        reason: boundary.reason,
      },
      ready: false,
      notes,
    };
  }

  const ownership = await readOwnershipRecord(pinned.real, env);
  const plugin = await classifyPluginFiles({
    paths,
    templates,
    recordedFiles: ownership?.files ?? {},
  });
  const mcp = await classifyMcpFile({
    mcpPath: paths.mcpPath,
    desired: desiredMcp,
    recordedDigest: ownership?.files?.[MCP_FILE_KEY] ?? null,
  });

  if (desiredMcp.nodeError !== null) {
    notes.push({
      code: desiredMcp.nodeError.code,
      text: '未找到可用的 Node.js 运行时，无法写入 MCP 配置（不会写入桌面应用自身的 exe）。',
    });
  }
  if (plugin.state === ANTIGRAVITY_PLUGIN_STATES.modified) {
    notes.push({
      code: 'PLUGIN_USER_MODIFIED',
      text: '检测到插件目录内有你自定义修改过的文件，安装与卸载都会保留它们；若仅需恢复连接，可点「仅修复 MCP 配置」。',
    });
  }
  if (mcp.state === ANTIGRAVITY_MCP_STATES.conflict || mcp.state === ANTIGRAVITY_MCP_STATES.unreadable) {
    notes.push({
      code: 'MCP_CONFLICT',
      text: 'plugins/dsh-taskbridge/mcp_config.json 存在自定义内容或格式错误，插件不会覆盖。',
    });
  }

  return {
    antigravityHome: pinned.selected,
    realAntigravityHome: pinned.real,
    pluginDir: paths.pluginDir,
    packageVersion: templates.version,
    plugin,
    mcp,
    ready: plugin.installed && mcp.configured,
    notes,
  };
}

async function ensureManagedDirs(paths) {
  for (const dir of paths.dirs) {
    const info = await inspectDirectory(dir).catch(() => ({ kind: 'unknown' }));
    if (info.kind === 'directory') continue;
    if (info.kind !== 'missing') {
      throw new AntigravityInstallError('ANTIGRAVITY_PATH_CONFLICT', `refused to traverse non-directory ${dir}`);
    }
    await mkdir(dir, { mode: 0o700 });
    const after = await inspectDirectory(dir).catch(() => ({ kind: 'unknown' }));
    if (after.kind !== 'directory') {
      throw new AntigravityInstallError('ANTIGRAVITY_PATH_CONFLICT', `created directory ${dir} could not be verified`);
    }
  }
}

async function ensureRootDir(realHome) {
  const info = await inspectDirectory(realHome).catch(() => ({ kind: 'unknown' }));
  if (info.kind === 'directory') return;
  if (info.kind !== 'missing') {
    throw new AntigravityInstallError('ANTIGRAVITY_HOME_UNUSABLE', `refused to use non-directory ${realHome}`);
  }
  await mkdir(realHome, { recursive: true, mode: 0o700 });
}

async function verifyUnchanged(filePath, expectDigest) {
  const current = await inspectFileSafe(filePath);
  if (expectDigest === null) return current.kind === 'missing';
  return current.kind === 'file' && digest(current.contents) === expectDigest;
}

async function removeEmptyDirs(dirs) {
  for (const dir of [...dirs].reverse()) {
    try {
      const entries = await readdir(dir);
      if (entries.length === 0) await rmdir(dir);
    } catch {
      // ignore missing or non-empty dirs
    }
  }
}

export async function runAntigravityAction(action, options = {}) {
  if (!ANTIGRAVITY_ACTIONS.includes(action)) {
    throw new AntigravityInstallError('ANTIGRAVITY_ACTION_INVALID', `unknown action ${String(action)}`);
  }
  if (action === 'status') {
    return { changed: [], refused: [], status: await readAntigravityStatus(options) };
  }

  const env = options.env ?? process.env;
  const before = await readAntigravityStatus(options);
  const templates = await readAntigravityTemplates(options.version ?? null);
  const paths = pluginPathsFor(before.realAntigravityHome);
  const desiredMcp = desiredMcpConfig(options);
  const ownership = await readOwnershipRecord(before.realAntigravityHome, env);
  const nextDigests = { ...(ownership?.files ?? {}) };
  const changed = [];
  const refused = [];

  if (before.plugin.state === ANTIGRAVITY_PLUGIN_STATES.conflict) {
    refused.push({ target: 'plugin', code: 'ANTIGRAVITY_PATH_CONFLICT', message: 'plugin directory boundary conflict' });
    refused.push({ target: 'mcp', code: 'ANTIGRAVITY_PATH_CONFLICT', message: 'plugin directory boundary conflict' });
    return { changed, refused, status: before };
  }

  if (action === 'install') {
    await ensureRootDir(before.realAntigravityHome);
    await ensureManagedDirs(paths);

    // 1. Plugin bundle files (per-file: write missing/outdated managed files, preserve user-modified ones)
    let wrotePlugin = false;
    let modifiedPlugin = false;
    let pluginConflict = false;
    for (const key of PLUGIN_FILE_KEYS) {
      const entry = before.plugin.files[key];
      if (entry?.state === 'installed') {
        nextDigests[key] = digestLf(templates.files[key]);
        continue;
      }
      if (entry?.state === 'modified') {
        modifiedPlugin = true;
        continue;
      }
      if (entry?.state !== 'not-installed' && entry?.state !== 'outdated') {
        pluginConflict = true;
        continue;
      }
      if (!(await verifyUnchanged(paths.files[key], entry?.expectDigest ?? null))) {
        pluginConflict = true;
        break;
      }
      await writeFileAtomic(paths.files[key], templates.files[key]);
      nextDigests[key] = digestLf(templates.files[key]);
      wrotePlugin = true;
    }
    if (wrotePlugin) changed.push('plugin');
    if (pluginConflict) {
      refused.push({ target: 'plugin', code: 'PLUGIN_CHANGED_CONCURRENTLY', message: 'plugin file changed during install' });
    } else if (modifiedPlugin) {
      refused.push({ target: 'plugin', code: 'PLUGIN_USER_MODIFIED', message: 'customized plugin files were preserved' });
    }

    // 2. MCP config file
    await applyMcpWrite({ before, desiredMcp, paths, nextDigests, changed, refused });
    await writeOwnershipRecord(before.realAntigravityHome, paths.pluginDir, nextDigests, env);
  } else if (action === 'repair') {
    await ensureRootDir(before.realAntigravityHome);
    await ensureManagedDirs(paths);

    // Repair touches mcp_config.json (and creates/updates plugin.json only if missing/outdated
    // so Antigravity discovers the plugin), never touching SKILL.md or agents/dsh-taskbridge.md.
    const manifestEntry = before.plugin.files['plugin.json'];
    if (manifestEntry?.state === 'not-installed' || manifestEntry?.state === 'outdated') {
      if (await verifyUnchanged(paths.files['plugin.json'], manifestEntry.expectDigest ?? null)) {
        await writeFileAtomic(paths.files['plugin.json'], templates.files['plugin.json']);
        nextDigests['plugin.json'] = digestLf(templates.files['plugin.json']);
      }
    }
    await applyMcpWrite({ before, desiredMcp, paths, nextDigests, changed, refused });
    await writeOwnershipRecord(before.realAntigravityHome, paths.pluginDir, nextDigests, env);
  } else if (action === 'remove') {
    // 1. Remove verified managed plugin files only
    let removedPlugin = false;
    let refusedPlugin = false;
    for (const key of PLUGIN_FILE_KEYS) {
      const entry = before.plugin.files[key];
      if (!entry || entry.state === 'not-installed') {
        delete nextDigests[key];
        continue;
      }
      if (entry.state !== 'installed' && entry.state !== 'outdated') {
        refusedPlugin = true;
        continue;
      }
      if (!(await verifyUnchanged(paths.files[key], entry.expectDigest))) {
        refusedPlugin = true;
        continue;
      }
      await unlink(paths.files[key]);
      delete nextDigests[key];
      removedPlugin = true;
    }
    if (removedPlugin) changed.push('plugin');
    if (refusedPlugin) {
      refused.push({ target: 'plugin', code: 'PLUGIN_USER_MODIFIED', message: 'customized plugin files were preserved' });
    }

    // 2. Remove managed MCP entry only
    if (before.mcp.state === ANTIGRAVITY_MCP_STATES.configured || before.mcp.state === ANTIGRAVITY_MCP_STATES.outdated) {
      if (await verifyUnchanged(paths.mcpPath, before.mcp.expectDigest)) {
        const doc = { ...(before.mcp.existingDoc ?? {}) };
        const servers = { ...(doc.mcpServers ?? {}) };
        delete servers[ANTIGRAVITY_MCP_SERVER_NAME];
        if (Object.keys(servers).length === 0 && Object.keys(doc).every((k) => k === 'mcpServers')) {
          await unlink(paths.mcpPath);
        } else {
          doc.mcpServers = servers;
          await writeFileAtomic(paths.mcpPath, `${JSON.stringify(doc, null, 2)}\n`);
        }
        delete nextDigests[MCP_FILE_KEY];
        changed.push('mcp');
      } else {
        refused.push({ target: 'mcp', code: 'MCP_CHANGED_CONCURRENTLY', message: 'mcp_config.json changed during remove' });
      }
    } else if (before.mcp.state === ANTIGRAVITY_MCP_STATES.conflict || before.mcp.state === ANTIGRAVITY_MCP_STATES.unreadable) {
      refused.push({ target: 'mcp', code: 'MCP_USER_MODIFIED', message: 'customized mcp_config.json was preserved' });
    }

    await writeOwnershipRecord(before.realAntigravityHome, paths.pluginDir, nextDigests, env);
    // Clean empty directories inside plugins/dsh-taskbridge only (never remove plugins/ itself).
    await removeEmptyDirs(paths.dirs.slice(1));
  }

  return { changed, refused, status: await readAntigravityStatus(options) };
}

async function applyMcpWrite({ before, desiredMcp, paths, nextDigests, changed, refused }) {
  if (desiredMcp.serverEntry === null) {
    refused.push({
      target: 'mcp',
      code: desiredMcp.nodeError?.code ?? 'MCP_EXECUTABLE_UNRESOLVED',
      message: desiredMcp.nodeError?.message ?? 'no Node.js executable available',
    });
    return;
  }
  if (before.mcp.state === ANTIGRAVITY_MCP_STATES.configured) {
    const existing = await inspectFileSafe(paths.mcpPath);
    if (existing.kind === 'file') nextDigests[MCP_FILE_KEY] = digestLf(existing.contents);
    return;
  }
  if (before.mcp.state !== ANTIGRAVITY_MCP_STATES.missing && before.mcp.state !== ANTIGRAVITY_MCP_STATES.outdated) {
    refused.push({
      target: 'mcp',
      code: before.mcp.state === ANTIGRAVITY_MCP_STATES.unreadable ? 'MCP_UNREADABLE' : 'MCP_CONFLICT',
      message: 'mcp_config.json cannot be overwritten safely',
    });
    return;
  }
  if (!(await verifyUnchanged(paths.mcpPath, before.mcp.expectDigest ?? null))) {
    refused.push({ target: 'mcp', code: 'MCP_CHANGED_CONCURRENTLY', message: 'mcp_config.json changed during write' });
    return;
  }
  const rendered = renderMcpDocument(before.mcp.existingDoc, desiredMcp.serverEntry);
  await writeFileAtomic(paths.mcpPath, rendered);
  nextDigests[MCP_FILE_KEY] = digestLf(rendered);
  changed.push('mcp');
}

export async function refreshManagedAntigravityPlugin(options = {}) {
  const before = await readAntigravityStatus(options);
  const env = options.env ?? process.env;
  const templates = await readAntigravityTemplates(options.version ?? null);
  const paths = pluginPathsFor(before.realAntigravityHome);
  const desiredMcp = desiredMcpConfig(options);
  const ownership = await readOwnershipRecord(before.realAntigravityHome, env);
  const nextDigests = { ...(ownership?.files ?? {}) };
  const changed = [];
  const refused = [];

  // Never create a fresh installation on startup. Upgrade only provably existing
  // managed plugin files (per-file when another file was customized by the user).
  const pluginEntries = Object.values(before.plugin.files ?? {});
  const hasOutdatedPluginFile = before.plugin.state !== ANTIGRAVITY_PLUGIN_STATES.conflict
    && pluginEntries.some((entry) => entry?.state === 'outdated');
  const hasExistingManagedPlugin = before.plugin.state === ANTIGRAVITY_PLUGIN_STATES.outdated || hasOutdatedPluginFile;
  const hasExistingStaleMcp = before.mcp.state === ANTIGRAVITY_MCP_STATES.outdated && before.mcp.movedScript !== true;
  if (!hasExistingManagedPlugin && !hasExistingStaleMcp) {
    return { changed, refused, status: before };
  }

  if (hasExistingManagedPlugin) {
    await ensureManagedDirs(paths);
    const fillMissing = before.plugin.state === ANTIGRAVITY_PLUGIN_STATES.outdated;
    let wrotePlugin = false;
    let modifiedPlugin = false;
    let pluginConflict = false;
    for (const key of PLUGIN_FILE_KEYS) {
      const entry = before.plugin.files[key];
      if (entry?.state === 'modified') {
        modifiedPlugin = true;
        continue;
      }
      const shouldWrite = entry?.state === 'outdated' || (fillMissing && entry?.state === 'not-installed');
      if (!shouldWrite) continue;
      if (!(await verifyUnchanged(paths.files[key], entry?.expectDigest ?? null))) {
        pluginConflict = true;
        break;
      }
      await writeFileAtomic(paths.files[key], templates.files[key]);
      nextDigests[key] = digestLf(templates.files[key]);
      wrotePlugin = true;
    }
    if (wrotePlugin) changed.push('plugin');
    if (pluginConflict) {
      refused.push({ target: 'plugin', code: 'PLUGIN_CHANGED_CONCURRENTLY', message: 'plugin file changed during refresh' });
    } else if (modifiedPlugin) {
      refused.push({ target: 'plugin', code: 'PLUGIN_USER_MODIFIED', message: 'customized plugin files were preserved' });
    }
  }

  if (hasExistingStaleMcp) {
    await ensureManagedDirs(paths);
    await applyMcpWrite({ before, desiredMcp, paths, nextDigests, changed, refused });
  }

  if (changed.length > 0) {
    await writeOwnershipRecord(before.realAntigravityHome, paths.pluginDir, nextDigests, env);
  }
  return { changed, refused, status: await readAntigravityStatus(options) };
}

export function publicAntigravityStatus(status) {
  if (status === null || typeof status !== 'object') return status;
  const files = {};
  for (const [key, entry] of Object.entries(status.plugin?.files ?? {})) {
    const { expectDigest: _ignored, ...pub } = entry ?? {};
    files[key] = pub;
  }
  const { existingDoc: _doc, expectDigest: _digest, ...mcp } = status.mcp ?? {};
  return {
    ...status,
    plugin: { ...(status.plugin ?? {}), files },
    mcp,
  };
}
