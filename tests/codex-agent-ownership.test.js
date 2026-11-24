// The Codex agent-ownership record: how a release recognises the template the PREVIOUS release
// wrote, without appending every future digest to `KNOWN_AGENT_TEMPLATES` by hand.
//
// The acceptance below builds TWO real product directories and drives them as two releases:
//
//   * release A installs normally (an explicit install and a startup confirmation) and records
//     the digest of the exact bytes it wrote — the record is never forged;
//   * release B ships a DIFFERENT template body, reuses A's `DSH_HOME`, reads A's record, and
//     updates the file automatically.
//
// Every test uses temporary Codex homes and a temporary `DSH_HOME`, so no real `~/.codex`,
// `~/.dsh` or installed profile is read or written.

import test from 'node:test';
import { readCodexRuleFiles } from './helpers/codex-rule-files.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SKILL_DIR_NAME, SKILL_FILENAME, KNOWN_AGENT_TEMPLATES, digest, isKnownPriorTemplate, renderAgentFile } from '../src/codex/installer.js';
import {
  digestLf,
  ownershipRecordPath,
  pluginDataDirectory,
  recallSkillTemplateDigest,
  skillOwnershipRecordPath,
} from '../src/codex/agent-ownership.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = readFileSync(join(ROOT, 'codex', 'skills', SKILL_DIR_NAME, SKILL_FILENAME), 'utf8');

// Extracted from the actual 1.6.1 tarball. Test.5 and test.6 shipped the same
// body; renderAgentFile stamps the respective package version at install time.
const HISTORICAL_TEMPLATE = readFileSync(join(ROOT, 'tests', 'fixtures', 'codex-agent-1.6.1.toml'), 'utf8');
const PUBLISHED_1_6_1_LF = 'efdef5f6e6ebcb26590ca929e674391b3c4fcdb3c017714d2322615783fdf712';
const PUBLISHED_1_6_1_CRLF = '5da9fd5eb5a89fd3c76365faca78b51e34233d993605f1b55dff4b07ceb88b80';
/** The local 1.6.1-test.5 prerelease: the same body, stamped and written by this renderer. */
const TEST_5_LF = 'bf698c861e7e560c555f8350b711db88627dce4a8752b2cbebe8748b6d640d37';
const TEST_5_CRLF = 'a45e12d0b234e80854e69429518a2def2d00338f968c2ecfc689307b792e4426';

/** A scratch root that is removed when the test ends. */
function scratch(label) {
  const root = mkdtempSync(join(tmpdir(), `dsh-delegate-${label}-`));
  return { root, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

/**
 * One REAL product directory: a copy of the shipped layout with a chosen template body.
 *
 * Nothing is rewritten inside the module: the copy carries `src/`, `bin/`, `codex/` and
 * `package.json`, exactly like an installed package, so importing it exercises the real paths.
 * `body` replaces the shipped instructions, which is how "the next release changed the template"
 * is modelled without shipping a second template in this repository.
 * @param {object} options - `root`, `label`, `body`, `version`.
 * @returns {{ dir: string, import: () => Promise<object> }} the release.
 */
function productRelease({ root, label, body = null, version = '1.6.1', template = TEMPLATE, referenceSuffix = '' }) {
  const dir = join(root, label);
  for (const relative of [
    'src/codex/installer.js',
    'src/codex/seam.js',
    'src/codex/toml.js',
    'src/codex/agent-ownership.js',
    'src/config/store.js',
    'src/runtime/endpoint-discovery.js',
    'bin/dsh-delegate-mcp.js',
    'package.json',
  ]) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(ROOT, relative), target);
  }
  const installDir = join(dir, 'codex', 'skills', SKILL_DIR_NAME);
  mkdirSync(installDir, { recursive: true });
  const { reference, referencePath } = readCodexRuleFiles();
  const referenceText = reference + referenceSuffix;
  const referenceName = `rules-reference-${digestLf(referenceText)}.md`;
  const entry = template.replace(basename(referencePath), referenceName);
  writeFileSync(join(installDir, SKILL_FILENAME), body === null ? entry : `${entry}\n${body}`, 'utf8');
  writeFileSync(join(installDir, referenceName), referenceText, 'utf8');
  // The release's own version, so `renderAgentFile` stamps the same line a real build would.
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  let loaded = null;
  return {
    dir,
    async import() {
      if (loaded === null) {
        // ONE module instance for the release: the installer copy every caller in it shares.
        const installer = await import(pathToFileURL(join(dir, 'src', 'codex', 'installer.js')).href);
        installer.useDirectoryClassifier(classifyByLstat);
        const seam = await import(pathToFileURL(join(dir, 'src', 'codex', 'seam.js')).href);
        loaded = {
          // The release's own installer copy, driven end to end.
          runCodexAction: installer.runCodexAction,
          readCodexStatus: installer.readCodexStatus,
          refreshKnownAgentTemplate: installer.refreshKnownAgentTemplate,
          isKnownPriorTemplate: installer.isKnownPriorTemplate,
          useDirectoryClassifier: installer.useDirectoryClassifier,
          createCodexSeam: seam.createCodexSeam,
          // The release's template text, so a test can state what it writes.
          readAgentTemplate: () => readFileSync(join(dir, 'codex', 'skills', SKILL_DIR_NAME, SKILL_FILENAME), 'utf8'),
        };
      }
      return loaded;
    },
  };
}

/**
 * Verdicts from `lstat` alone.
 *
 * These tests create no junction, so the Windows attribute probe must not be attempted: it
 * cannot spawn a child process in every carrier.
 * @param {string[]} paths - absolute paths.
 * @returns {Promise<Map<string, string>>} verdicts.
 */
async function classifyByLstat(paths) {
  const kinds = new Map();
  for (const path of paths) {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info === undefined) kinds.set(path, 'missing');
    else if (info.isSymbolicLink()) kinds.set(path, 'link');
    else if (info.isDirectory()) kinds.set(path, 'directory');
    else kinds.set(path, 'other');
  }
  return kinds;
}

/**
 * A temporary Codex home and the isolated environment that points the plugin data there.
 * @param {string} root - scratch root.
 * @returns {object} paths and the environment.
 */
function codexHome(root) {
  const home = join(root, 'codex');
  const dshHome = join(root, 'dsh-home');
  mkdirSync(home, { recursive: true });
  return {
    home,
    dshHome,
    agentPath: join(home, 'skills', SKILL_DIR_NAME, SKILL_FILENAME),
    configPath: join(home, 'config.toml'),
    env: { CODEX_HOME: home, DSH_HOME: dshHome, DSH_DELEGATE_DISCOVERY_FILE: '', DSH_DELEGATE_BASE_URL: '' },
  };
}

/** Record paths a release would write for one home (the layout is identical in every release). */
function recordsFor(home, env) {
  const dir = join(pluginDataDirectory(env), 'codex-skill-ownership');
  return { dir, path: skillOwnershipRecordPath(home, env) };
}

/** The digest stored in a record file, or null when there is none. */
function storedDigest(home, env) {
  const { path } = recordsFor(home, env);
  if (path === null || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')).templateLfSha256;
}

/** A stable description of everything a status read must not change. */
function snapshot(home, env) {
  const skillDir = join(home, 'skills', SKILL_DIR_NAME);
  const agent = statSync(join(skillDir, SKILL_FILENAME), { throwIfNoEntry: false });
  const { path } = recordsFor(home, env);
  const record = path === null ? null : statSync(path, { throwIfNoEntry: false });
  return {
    agentMtime: agent?.mtimeMs ?? null,
    recordMtime: record?.mtimeMs ?? null,
    digest: storedDigest(home, env),
    files: existsSync(skillDir) ? readdirSync(skillDir).sort() : [],
  };
}

// ---------------------------------------------------------------------------
// 1. The two proven historical removals stay exact identities
// ---------------------------------------------------------------------------

test('the published 1.6.1 and local 1.6.1-test.5 companions stay enumerated, in both spellings', () => {
  for (const [version, sha256] of [
    ['1.6.1', PUBLISHED_1_6_1_LF],
    ['1.6.1', PUBLISHED_1_6_1_CRLF],
    ['1.6.1-test.5', TEST_5_LF],
    ['1.6.1-test.5', TEST_5_CRLF],
  ]) {
    assert.ok(KNOWN_AGENT_TEMPLATES.some((entry) => entry.version === version && entry.sha256 === sha256),
      `${version} ${sha256.slice(0, 8)}… must stay enumerated`);
  }
  const fixtures = [renderAgentFile(HISTORICAL_TEMPLATE, '1.6.1'), renderAgentFile(HISTORICAL_TEMPLATE, '1.6.1-test.5')];
  assert.equal(digest(fixtures[0]), PUBLISHED_1_6_1_LF);
  assert.equal(digest(fixtures[1]), TEST_5_LF);
  for (const text of fixtures) {
    assert.equal(isKnownPriorTemplate(text), true);
    assert.equal(isKnownPriorTemplate(`${text}\n`), false, 'an added line is an edit');
    assert.equal(isKnownPriorTemplate(text.replace(/^version = ".*"$/mu, 'version = "0.0.1"')), false,
      'a rewritten version line alone is an edit');
  }
});

// ---------------------------------------------------------------------------
// 2. Release A records what it INSTALLED; release B applies it
// ---------------------------------------------------------------------------

test('release A records the template it installed, and a repeat does not rewrite the record', async () => {
  const s = scratch('release-a');
  try {
    const home = codexHome(s.root);
    const a = await productRelease({ root: s.root, label: 'a', version: '1.6.1-test.5' }).import();
    // An explicit install writes both targets and is the action that records the digest.
    const installed = await a.runCodexAction('install', { codexHome: home.home, env: home.env });
    assert.deepEqual(installed.refused, [], JSON.stringify(installed.refused));
    assert.ok(installed.changed.includes('agent'));
    const written = readFileSync(home.agentPath, 'utf8');
    assert.equal(written, renderAgentFile(TEMPLATE, '1.6.1-test.5'));
    assert.equal(storedDigest(home.home, home.env), digestLf(written), 'the record holds the digest of the file');
    // The record itself carries the three fields and nothing else.
    const record = JSON.parse(readFileSync(recordsFor(home.home, home.env).path, 'utf8'));
    assert.deepEqual(Object.keys(record).sort(), ['codexHome', 'schemaVersion', 'templateLfSha256']);
    assert.equal(record.schemaVersion, 1);
    assert.equal(resolve(record.codexHome), resolve(home.home), 'the real home, not a spelling');

    // A second install is a no-op AND does not rewrite the record.
    const before = snapshot(home.home, home.env);
    const again = await a.runCodexAction('install', { codexHome: home.home, env: home.env });
    assert.deepEqual(again.changed, []);
    assert.deepEqual(snapshot(home.home, home.env), before, 'no file and no record changed');
  } finally {
    s.cleanup();
  }
});

test('a status read records NOTHING, even when the file is the current release template', async () => {
  const s = scratch('status-read');
  try {
    const home = codexHome(s.root);
    const a = await productRelease({ root: s.root, label: 'a', version: '1.6.1-test.5' }).import();
    // The file is written directly (no install), so there is nothing to prove yet.
    mkdirSync(dirname(home.agentPath), { recursive: true });
    writeFileSync(home.agentPath, renderAgentFile(TEMPLATE, '1.6.1-test.5'), 'utf8');
    const { referencePath } = readCodexRuleFiles();
    copyFileSync(referencePath, join(dirname(home.agentPath), basename(referencePath)));
    const status = await a.runCodexAction('status', { codexHome: home.home, env: home.env });
    assert.equal(status.status.agent.state, 'installed', 'the live template reads back installed');
    assert.equal(storedDigest(home.home, home.env), null, 'a read never creates the record');
    assert.equal(existsSync(recordsFor(home.home, home.env).dir), false, 'not even the directory');
    // The desktop entry point is the same read.
    await a.readCodexStatus({ codexHome: home.home, env: home.env });
    assert.equal(storedDigest(home.home, home.env), null);
  } finally {
    s.cleanup();
  }
});

test('repair and remove record nothing', async () => {
  const s = scratch('repair-remove');
  try {
    const home = codexHome(s.root);
    const a = await productRelease({ root: s.root, label: 'a', version: '1.6.1-test.5' }).import();
    await a.runCodexAction('install', { codexHome: home.home, env: home.env });
    const installedRecord = storedDigest(home.home, home.env);
    assert.notEqual(installedRecord, null);
    // `repair` writes the MCP entry only: the record is untouched, byte for byte.
    const before = snapshot(home.home, home.env);
    const repaired = await a.runCodexAction('repair', { codexHome: home.home, env: home.env });
    assert.equal(repaired.changed.includes('agent'), false);
    assert.deepEqual(snapshot(home.home, home.env), before, 'repair leaves the record alone');
    // `remove` deletes the managed agent; it never records a new digest on the way out.
    const removed = await a.runCodexAction('remove', { codexHome: home.home, env: home.env });
    assert.ok(removed.changed.includes('agent'));
    assert.equal(existsSync(home.agentPath), false);
    assert.equal(storedDigest(home.home, home.env), installedRecord, 'the record still holds the last INSTALLED digest');
  } finally {
    s.cleanup();
  }
});

test('release B updates an unlisted companion using its recorded ownership', async () => {
  const s = scratch('release-b');
  try {
    const home = codexHome(s.root);
    // A installs a template that the static table does not know.
    const a = await productRelease({ root: s.root, label: 'a', version: '9.8.0', body: '# the A release body\n' }).import();
    await a.runCodexAction('install', { codexHome: home.home, env: home.env });
    const aDigest = storedDigest(home.home, home.env);
    assert.equal(aDigest, digestLf(renderAgentFile(await a.readAgentTemplate(), '9.8.0')));

    // B: a DIFFERENT template body, same DSH_HOME. Its own version is unenumerated too.
    const oldReference = readCodexRuleFiles(home.agentPath);
    const b = await productRelease({
      root: s.root, label: 'b', version: '9.9.0', body: '# the B release body\n',
      referenceSuffix: '\nB reference rules\n',
    }).import();
    const bTemplate = await b.readAgentTemplate();
    assert.notEqual(bTemplate, TEMPLATE);
    const aFile = readFileSync(home.agentPath, 'utf8');
    assert.equal(digestLf(aFile), aDigest);
    assert.equal(b.isKnownPriorTemplate(aFile), false, 'A ownership comes from the install record');
    assert.equal(b.isKnownPriorTemplate(renderAgentFile(bTemplate, '9.9.0')), false,
      'B\'s own template is enumerated by neither table, so only a record can recognise it');

    const before = await b.readCodexStatus({ codexHome: home.home, env: home.env });
    assert.equal(before.agent.state, 'outdated');
    assert.equal(before.agent.recorded, true, 'B proves ownership from the record left by A');

    // B updates the untouched template and records the bytes it installed.
    const refreshed = await b.refreshKnownAgentTemplate({ codexHome: home.home, env: home.env });
    assert.deepEqual(refreshed.refused, []);
    assert.deepEqual(refreshed.changed, ['agent']);
    const updated = readCodexRuleFiles(home.agentPath);
    assert.equal(updated.entry, renderAgentFile(bTemplate, '9.9.0'), 'B wrote its own template');
    assert.notEqual(updated.referencePath, oldReference.referencePath);
    assert.match(updated.reference, /B reference rules/u);
    assert.equal(readFileSync(oldReference.referencePath, 'utf8'), oldReference.reference,
      'sessions with the previous entry can still load its reference');
    assert.equal(storedDigest(home.home, home.env), digestLf(renderAgentFile(bTemplate, '9.9.0')),
      'and B recorded its own template, replacing A\'s');
    assert.notEqual(storedDigest(home.home, home.env), aDigest);
    // B's own file is now recognised THROUGH the record (no enumeration covers it).
    const again = await b.readCodexStatus({ codexHome: home.home, env: home.env });
    assert.equal(again.agent.state, 'installed');
    const third = await productRelease({ root: s.root, label: 'c', version: '9.9.0', body: '# the C release body\n' }).import();
    const seenByC = await third.readCodexStatus({ codexHome: home.home, env: home.env });
    assert.equal(seenByC.agent.state, 'outdated', 'C recognises B\'s file by the record B left');
    assert.equal(seenByC.agent.recorded, true);

    // Repeating B's startup is a no-op: its template is the live one.
    const repeat = await b.refreshKnownAgentTemplate({ codexHome: home.home, env: home.env });
    assert.deepEqual(repeat.changed, []);
  } finally {
    s.cleanup();
  }
});

test(`a repeated startup after B's update leaves the agent AND the record untouched`, async () => {
  const s = scratch('b-repeat');
  try {
    const home = codexHome(s.root);
    const a = await productRelease({ root: s.root, label: 'a', version: '1.6.1-test.5' }).import();
    await a.runCodexAction('install', { codexHome: home.home, env: home.env });
    const b = await productRelease({ root: s.root, label: 'b', version: '9.9.0', body: '# the B release body\n' }).import();
    const seam = b.createCodexSeam({ env: home.env, version: '9.9.0' });
    const first = await seam.refreshManagedIntegration();
    assert.ok(first.changed.includes('agent'), JSON.stringify(first.changed));
    const after = snapshot(home.home, home.env);
    const recordBytes = readFileSync(recordsFor(home.home, home.env).path, 'utf8');
    for (let round = 0; round < 2; round += 1) {
      const again = await b.createCodexSeam({ env: home.env, version: '9.9.0' }).refreshManagedIntegration();
      assert.deepEqual(again.changed, [], `round ${round}: nothing to do`);
      assert.equal(readFileSync(recordsFor(home.home, home.env).path, 'utf8'), recordBytes,
        `round ${round}: the record is not rewritten`);
    }
    assert.deepEqual(snapshot(home.home, home.env), after, 'agent and record mtimes unchanged');
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. A record belongs to ONE Codex home
// ---------------------------------------------------------------------------

test('another Codex home reusing the same DSH_HOME is not authorised by A\'s record', async () => {
  const s = scratch('other-home');
  try {
    const first = codexHome(s.root);
    const a = await productRelease({ root: s.root, label: 'a', version: '1.6.1-test.5' }).import();
    await a.runCodexAction('install', { codexHome: first.home, env: first.env });
    assert.notEqual(storedDigest(first.home, first.env), null);

    // A second home with the SAME DSH_HOME. Its `agents/` directory is a LINK to the first
    // home's, so only a record COULD authorise work here — and the record belongs to the first.
    const second = { home: join(s.root, 'codex-2') };
    mkdirSync(second.home, { recursive: true });
    try {
      symlinkSync(dirname(first.agentPath), join(second.home, 'agents'), 'junction');
    } catch {
      return; // A platform that cannot create one has nothing to prove here.
    }
    const env2 = { ...first.env, CODEX_HOME: second.home };
    const b = await productRelease({ root: s.root, label: 'b', version: '9.9.0', body: '# the B release body\n' }).import();
    assert.equal(storedDigest(second.home, env2), null, 'the record path is keyed by the home');
    assert.equal(b.isKnownPriorTemplate(renderAgentFile(await b.readAgentTemplate(), '9.9.0')), false,
      'B does not enumerate its own template, so only a record for THIS home could recognise it');
    // The installer is told what the platform would answer for the junction it cannot see with
    // `lstat`: this is the documented classifier hook, not a stubbed approval of the write.
    const linkedAgents = join(second.home, 'agents');
    b.useDirectoryClassifier(async (paths) => {
      const kinds = await classifyByLstat(paths);
      if (paths.some((path) => resolve(path) === resolve(linkedAgents))) kinds.set(linkedAgents, 'link');
      return kinds;
    });
    const status = await b.readCodexStatus({ codexHome: second.home, env: env2, version: '9.9.0' });
    // Without a record for THIS home the agents directory is an unproved boundary: nothing is
    // adopted, nothing is written through it, and the file behind it is untouched.
    assert.equal(status.agent.state, 'conflict');
    assert.equal(status.agent.reason, 'agents-dir-is-link');
    assert.equal(status.boundary.blocked, true);
    const outcome = await b.refreshKnownAgentTemplate({ codexHome: second.home, env: env2, version: '9.9.0' });
    assert.deepEqual(outcome.changed, []);
    assert.equal(readFileSync(first.agentPath, 'utf8'), renderAgentFile(TEMPLATE, '1.6.1-test.5'),
      'the first home\'s file is exactly what release A wrote');
  } finally {
    s.cleanup();
  }
});

test('a record reached through a linked ancestor is ignored, and the read creates nothing', async () => {
  const s = scratch('linked-ancestor');
  try {
    const home = codexHome(s.root);
    const a = await productRelease({ root: s.root, label: 'a', version: '1.6.1-test.5' }).import();
    await a.runCodexAction('install', { codexHome: home.home, env: home.env });
    const target = join(s.root, 'real-data');
    // Move the plugin data tree behind a junction and point DSH_HOME at the link.
    mkdirSync(target, { recursive: true });
    rmSync(target, { recursive: true, force: true });
    const link = join(s.root, 'dsh-link');
    try {
      symlinkSync(join(home.dshHome), link, 'junction');
    } catch {
      return; // A platform that cannot create one has nothing to prove here.
    }
    const linkedEnv = { ...home.env, DSH_HOME: link };
    const digestSeen = await recallSkillTemplateDigest({
      codexHome: home.home,
      env: linkedEnv,
      classify: async (path) => {
        const info = lstatSync(path, { throwIfNoEntry: false });
        if (info === undefined) return 'missing';
        // The link itself is reported the way the platform reports a junction: as a link.
        if (resolve(path) === resolve(link) || info.isSymbolicLink()) return 'link';
        return info.isDirectory() ? 'directory' : 'other';
      },
    });
    assert.equal(digestSeen, null, 'a linked ancestor is never followed');
    assert.equal(existsSync(join(target, 'data')), false, 'and nothing was created behind it');
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. User content and the MCP entry stay untouched
// ---------------------------------------------------------------------------

for (const [label, mutate] of [
  ['an added comment', (text) => `${text}\n<!-- my own note -->\n`],
  ['a changed body character', (text) => text.replace('name: dsh-taskbridge', 'name: dsh-taskbridgE')],
  ['only the version line', (text) => text.replace(/^<!-- dsh-taskbridge-version: .* -->$/mu, '<!-- dsh-taskbridge-version: 0.9.0 -->')],
]) {
  test(`a recorded release template customised with ${label} is preserved byte-identically`, async () => {
    const s = scratch('user-edit');
    try {
      const home = codexHome(s.root);
      const a = await productRelease({ root: s.root, label: 'a', version: '1.6.1-test.5' }).import();
      await a.runCodexAction('install', { codexHome: home.home, env: home.env });
      const customised = mutate(readFileSync(home.agentPath, 'utf8'));
      assert.notEqual(customised, readFileSync(home.agentPath, 'utf8'));
      writeFileSync(home.agentPath, customised, 'utf8');
      const status = await a.readCodexStatus({ codexHome: home.home, env: home.env });
      assert.equal(status.agent.state, 'modified', `${label}: the operator's file`);
      assert.equal(status.agent.managed, false);
      const startup = await a.refreshKnownAgentTemplate({ codexHome: home.home, env: home.env });
      assert.deepEqual(startup.changed, []);
      assert.equal(readFileSync(home.agentPath, 'utf8'), customised);
      for (const action of ['install', 'remove']) {
        const outcome = await a.runCodexAction(action, { codexHome: home.home, env: home.env });
        assert.equal(outcome.changed.includes('agent'), false);
        assert.ok(outcome.refused.some((entry) => entry.code === 'AGENT_USER_MODIFIED'), `${label}: ${action}`);
        assert.equal(readFileSync(home.agentPath, 'utf8'), customised);
      }
    } finally {
      s.cleanup();
    }
  });
}

test('a custom mcp_servers entry survives an update that uses the record', async () => {
  const s = scratch('mcp-custom');
  try {
    const home = codexHome(s.root);
    const a = await productRelease({ root: s.root, label: 'a', version: '1.6.1-test.5' }).import();
    await a.runCodexAction('install', { codexHome: home.home, env: home.env });
    const custom = '# operator settings\nmodel = "operator-model"\n\n[mcp_servers.dsh-delegate]\ncommand = "node"\nargs = ["C:/elsewhere/server.mjs"]\n';
    writeFileSync(home.configPath, custom, 'utf8');
    const b = await productRelease({ root: s.root, label: 'b', version: '9.9.0', body: '# the B release body\n' }).import();
    const outcome = await b.createCodexSeam({ env: home.env, version: '9.9.0' })
      .refreshManagedIntegration({ startupTarget: { home: home.home, source: 'explicit', reason: null }, backupDir: join(s.root, 'backup') });
    assert.ok(outcome.changed.includes('agent'), 'the agent half used the record');
    assert.equal(outcome.changed.includes('mcp'), false, 'the custom entry is not ours');
    assert.equal(readFileSync(home.configPath, 'utf8'), custom, 'byte-identical');
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. The record's own bounds
// ---------------------------------------------------------------------------

test('an unusable DSH_HOME or a damaged record is simply no record', async () => {
  const s = scratch('record-bounds');
  try {
    const home = codexHome(s.root);
    assert.equal(ownershipRecordPath(home.home, { DSH_HOME: '' }) !== null, true, 'the default directory applies');
    assert.equal(ownershipRecordPath(home.home, { DSH_HOME: 'relative/dsh' }), null, 'a relative override is refused');
    assert.equal(pluginDataDirectory({ DSH_HOME: 'relative/dsh' }), null);

    const a = await productRelease({ root: s.root, label: 'a', version: '1.6.1-test.5' }).import();
    await a.runCodexAction('install', { codexHome: home.home, env: home.env });
    const { path } = recordsFor(home.home, home.env);
    const original = readFileSync(path, 'utf8');
    const crafted = [
      ['not json', '{ nope'],
      ['unknown schema', JSON.stringify({ schemaVersion: 9, codexHome: home.home, templateLfSha256: 'a'.repeat(64) })],
      ['another home inside', JSON.stringify({ schemaVersion: 1, codexHome: join(s.root, 'elsewhere'), templateLfSha256: 'a'.repeat(64) })],
      ['not a digest', JSON.stringify({ schemaVersion: 1, codexHome: resolve(home.home), templateLfSha256: 'short' })],
      ['over the size bound', JSON.stringify({ schemaVersion: 1, codexHome: resolve(home.home), templateLfSha256: 'a'.repeat(64), pad: 'x'.repeat(5000) })],
    ];
    for (const [label, contents] of crafted) {
      writeFileSync(path, contents, 'utf8');
      assert.equal(await recallSkillTemplateDigest({ codexHome: home.home, env: home.env, classify: (p) => (existsSync(p) ? 'directory' : 'missing') }), null, `${label}: no record`);
    }
    writeFileSync(path, original, 'utf8');
    assert.notEqual(await recallSkillTemplateDigest({
      codexHome: home.home, env: home.env,
      classify: async (p) => {
        const info = lstatSync(p, { throwIfNoEntry: false });
        if (info === undefined) return 'missing';
        return info.isSymbolicLink() ? 'link' : (info.isDirectory() ? 'directory' : 'other');
      },
    }), null, 'the untouched record still reads');
  } finally {
    s.cleanup();
  }
});

test('the record and the template hold no credentials', async () => {
  const s = scratch('no-secrets');
  try {
    const home = codexHome(s.root);
    const a = await productRelease({ root: s.root, label: 'a', version: '1.6.1-test.5' }).import();
    await a.runCodexAction('install', { codexHome: home.home, env: home.env });
    const record = readFileSync(recordsFor(home.home, home.env).path, 'utf8');
    assert.doesNotMatch(record, /developer_instructions/u);
    assert.doesNotMatch(record, /mcp_servers|command|args/u);
    assert.match(JSON.parse(record).templateLfSha256, /^[0-9a-f]{64}$/u);
    // The digest is the LF-normalized one, so the CRLF and LF spellings agree.
    const text = readFileSync(home.agentPath, 'utf8');
    assert.equal(digestLf(text), digestLf(text.replace(/\n/gu, '\r\n')), 'terminator spelling is not content');
    assert.equal(createHash('sha256').update(text.replace(/\r\n/gu, '\n'), 'utf8').digest('hex'), digestLf(text));
  } finally {
    s.cleanup();
  }
});
