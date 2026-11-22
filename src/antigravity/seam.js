// The seam the user plane and plugin startup use to reach the Antigravity integration.
//
// Mirrors `src/codex/seam.js`: resolves the Antigravity config home per call
// (`ANTIGRAVITY_CONFIG_DIR` / `GEMINI_CONFIG_DIR` → remembered successful install →
// default `~/.gemini/config`), pins the active DSH discovery file, keeps `status`
// strictly read-only, and runs automatic startup refresh only on already-installed
// managed plugin files.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { writeFileAtomic } from '../config/store.js';
import { inspectDirectory } from '../codex/installer.js';
import { resolveEndpointDiscoveryPath } from '../runtime/endpoint-discovery.js';
import {
  ANTIGRAVITY_ENV_VARS,
  readAntigravityStatus,
  refreshManagedAntigravityPlugin,
  requireAntigravityHome,
  resolveAntigravityHome,
  runAntigravityAction,
} from './installer.js';

export function antigravityInstallationRecordPath(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  const dshHome = configured === '' ? join(homedir(), '.dsh') : configured;
  return join(dshHome, 'data', 'dsh-delegate', 'antigravity-installation.json');
}

export async function rememberInstalledAntigravityHome(antigravityHome, env = process.env) {
  if (typeof antigravityHome !== 'string' || antigravityHome.trim() === '') return false;
  try {
    const record = { schemaVersion: 1, antigravityHome, recordedAt: new Date().toISOString() };
    await writeFileAtomic(antigravityInstallationRecordPath(env), `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function readInstalledAntigravityHome(env = process.env) {
  try {
    const text = readFileSync(antigravityInstallationRecordPath(env), 'utf8');
    const record = JSON.parse(text);
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
    if (record.schemaVersion !== 1) return null;
    if (typeof record.antigravityHome !== 'string' || record.antigravityHome.trim() === '') return null;
    return requireAntigravityHome(record.antigravityHome);
  } catch {
    return null;
  }
}

async function resolveHomePreference({ env, explicitHome = '', homeDirectory = undefined, forAction = false }) {
  if (explicitHome !== '') return { home: requireAntigravityHome(explicitHome), blocked: false, source: 'explicit' };
  for (const key of ANTIGRAVITY_ENV_VARS) {
    const configured = typeof env?.[key] === 'string' ? env[key].trim() : '';
    if (configured !== '') return { home: requireAntigravityHome(configured), blocked: false, source: 'explicit' };
  }
  const remembered = readInstalledAntigravityHome(env);
  if (remembered !== null) {
    const kind = await inspectDirectory(remembered);
    if (kind.kind === 'directory') return { home: remembered, blocked: false, source: 'recorded' };
  }
  const fallback = resolveAntigravityHome({ env, ...(homeDirectory === undefined ? {} : { homeDirectory }) });
  const kind = await inspectDirectory(fallback);
  if (kind.kind === 'missing') {
    return forAction
      ? { home: fallback, blocked: false, source: 'default' }
      : { home: null, blocked: false, source: 'none' };
  }
  if (kind.kind === 'directory') return { home: fallback, blocked: false, source: 'default' };
  // A root link is allowed on explicit status/action (the installer pins it to realpath),
  // while startup refresh skips an unrecorded default link.
  if (forAction) return { home: fallback, blocked: false, source: 'default' };
  return { home: fallback, blocked: true, source: 'default' };
}

export function createAntigravitySeam(options = {}) {
  const env = options.env ?? process.env;
  const requestedHome = typeof options.antigravityHome === 'string' && options.antigravityHome.trim() !== ''
    ? options.antigravityHome
    : null;
  const requestedDiscovery = typeof options.discoveryFile === 'string' && options.discoveryFile.trim() !== ''
    ? options.discoveryFile
    : null;
  const homeDirectory = options.homeDirectory;
  const version = typeof options.version === 'string' ? options.version : null;

  const discovery = () => (requestedDiscovery !== null ? requestedDiscovery : resolveEndpointDiscoveryPath(env));
  const baseFor = (home) => ({
    antigravityHome: home,
    env,
    ...(homeDirectory === undefined ? {} : { homeDirectory }),
    ...(options.nodeExecutable === undefined ? {} : { nodeExecutable: options.nodeExecutable }),
    ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
    ...(options.resourcesPath === undefined ? {} : { resourcesPath: options.resourcesPath }),
    ...(options.versions === undefined ? {} : { versions: options.versions }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(discovery() === undefined ? {} : { discoveryFile: discovery() }),
    ...(version === null ? {} : { version }),
  });

  return {
    async startupTarget() {
      const resolved = await resolveHomePreference({ env, explicitHome: requestedHome ?? '', homeDirectory, forAction: false });
      const reason = resolved.home === null ? 'no-antigravity-home'
        : (resolved.blocked === true ? 'default-is-link' : null);
      return { home: resolved.blocked ? null : resolved.home, source: resolved.source, reason };
    },
    async refreshManagedIntegration(callOptions = {}) {
      const target = callOptions?.startupTarget ?? await this.startupTarget();
      if (typeof target?.home !== 'string' || target.home === '') {
        return { changed: [], refused: [], status: null };
      }
      return await refreshManagedAntigravityPlugin(baseFor(target.home));
    },
    async status() {
      const resolved = await resolveHomePreference({ env, explicitHome: requestedHome ?? '', homeDirectory, forAction: true });
      return {
        changed: [],
        refused: [],
        status: await readAntigravityStatus(baseFor(resolved.home)),
      };
    },
    async run(action) {
      const resolved = await resolveHomePreference({ env, explicitHome: requestedHome ?? '', homeDirectory, forAction: true });
      const outcome = await runAntigravityAction(action, baseFor(resolved.home));
      const home = outcome.status?.realAntigravityHome ?? outcome.status?.antigravityHome ?? resolved.home;
      if (action === 'install' && outcome.refused.length === 0 && typeof home === 'string' && home !== '') {
        await rememberInstalledAntigravityHome(home, env);
      }
      return outcome;
    },
  };
}

export function resolveAntigravityActionSeam(options = {}) {
  if (options.disabled === true) return null;
  return createAntigravitySeam(options);
}
