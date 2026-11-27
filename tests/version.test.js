// R5: the version a host is told is the version this build actually is.
//
// The defect: `SERVER_INFO.version` was a literal `1.4.2` in `src/mcp/server.js`, so a
// pre-release tarball built from the same source answered `initialize` with the last
// released number. A host could not tell which build it was talking to.
//
// These tests read the manifest and assert the handshake agrees with it, including for
// a LOCAL PRE-RELEASE build, which is the case the report names. They never change the
// manifest: the version is a fact about this build, not something to edit here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANIFEST_PATH, PACKAGE_ROOT, readPackageManifest, reportedVersion } from '../src/version.js';
import { SERVER_INFO, createMcpServer, LATEST_PROTOCOL_VERSION } from '../src/mcp/server.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** A server over a recording stub; the handshake never reaches the plane. */
function fixture() {
  return createMcpServer({ async callExecution() { return { ok: true }; } });
}

test('the manifest read is this package\'s own manifest, and its version is well formed', () => {
  assert.equal(MANIFEST_PATH, join(PACKAGE_ROOT, 'package.json'));
  const manifest = readPackageManifest();
  assert.equal(manifest.ok, true, JSON.stringify(manifest));
  assert.equal(manifest.path, join(ROOT, 'package.json').replace(/[\\/]$/u, ''));
  assert.equal(manifest.name, MANIFEST.name);
  assert.equal(manifest.version, MANIFEST.version);
  // A semver core plus optional prerelease/build, as npm writes it.
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
});

test('the version source is the manifest, not a literal in the source', () => {
  assert.deepEqual(reportedVersion(), {
    name: MANIFEST.name,
    version: MANIFEST.version,
    source: 'package.json',
  });
  // The MCP server must carry the manifest's version…
  assert.equal(SERVER_INFO.version, MANIFEST.version);
  assert.equal(SERVER_INFO.name, MANIFEST.name);
  // …and must not carry a hard-coded copy of it anywhere in the module that builds the
  // handshake. A literal there is exactly the drift this repair removes.
  const source = readFileSync(join(ROOT, 'src', 'mcp', 'server.js'), 'utf8');
  const literal = new RegExp(`version:\\s*['"]${MANIFEST.version.replaceAll('.', '\\.')}['"]`, 'u');
  assert.equal(literal.test(source), false, 'src/mcp/server.js must not hard-code the version');
  assert.match(source, /version:\s*REPORTED\.version/u);
});

test('a LOCAL PRE-RELEASE build reports its own prerelease version in the handshake', async () => {
  // This is the acceptance case: `npm pack` of an uncommitted tree, installed locally,
  // must answer with ITS version — the prerelease one — not with the released number.
  // The fixture is a real `node_modules`-shaped directory whose `package.json` carries a
  // prerelease version, with `src/version.js` copied into it, so the module resolves the
  // manifest exactly the way an installed copy does.
  const { cp, mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-version-'));
  try {
    const packageRoot = join(sandbox, 'node_modules', 'dsh-taskbridge');
    await mkdir(join(packageRoot, 'src'), { recursive: true });
    await cp(join(ROOT, 'src', 'version.js'), join(packageRoot, 'src', 'version.js'));
    await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
      name: 'dsh-taskbridge',
      version: '1.4.3-test.1',
    }, null, 2)}\n`, 'utf8');
    const installed = await import(pathToFileURL(join(packageRoot, 'src', 'version.js')).href);
    assert.deepEqual(installed.reportedVersion(), {
      name: 'dsh-taskbridge',
      version: '1.4.3-test.1',
      source: 'package.json',
    });
    // And the handshake of the real server module, when its manifest is that prerelease
    // one, would report it: the value is read, never remembered at import time.
    assert.equal(installed.readPackageManifest().version, '1.4.3-test.1');
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('the server advertises the manifest version over the wire, on every supported revision', async () => {
  const { server } = { server: fixture() };
  for (const [index, protocolVersion] of [LATEST_PROTOCOL_VERSION, '2025-03-26', '1999-01-01'].entries()) {
    const answer = await server.handle({ jsonrpc: '2.0', id: index + 1, method: 'initialize', params: { protocolVersion } });
    assert.equal(answer.result.serverInfo.version, MANIFEST.version, protocolVersion);
    assert.equal(answer.result.serverInfo.name, MANIFEST.name, protocolVersion);
  }
});

test('a manifest that cannot be read yields a stated fallback, never a plausible number', async () => {
  // A build whose manifest is missing must not claim to be some release it is not.
  const { mkdtemp, rm, mkdir, cp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-version-missing-'));
  try {
    const packageRoot = join(sandbox, 'node_modules', 'dsh-taskbridge');
    await mkdir(join(packageRoot, 'src'), { recursive: true });
    await cp(join(ROOT, 'src', 'version.js'), join(packageRoot, 'src', 'version.js'));
    const orphan = await import(pathToFileURL(join(packageRoot, 'src', 'version.js')).href);
    assert.equal(orphan.readPackageManifest().ok, false);
    assert.equal(orphan.readPackageManifest().reason, 'manifest-missing');
    assert.deepEqual(orphan.reportedVersion(), { name: 'dsh-taskbridge', version: '0.0.0-unknown', source: 'fallback' });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('the manifest and its module are published, so an installed copy can read them', () => {
  // `version.js` must be inside `src/` (the allowlist covers `src/**/*.js`) and
  // `package.json` is force-included by npm, which is what makes the read work from a
  // tarball. Assert the allowlist really covers the module, since a file outside it
  // would make the version unreadable exactly in the installed case.
  const allowlist = MANIFEST.files;
  assert.ok(allowlist.includes('src/**/*.js'), 'src modules must be published');
  assert.equal(allowlist.some((pattern) => pattern === 'package.json'), false,
    'package.json is force-included by npm; it needs no allowlist entry');
  // The module itself really exists at the location the allowlist covers, and the
  // manifest it reads is the one in that same tree.
  assert.equal(existsSync(join(ROOT, 'src', 'version.js')), true, 'the version module must exist under src/');
  assert.equal(MANIFEST_PATH, join(ROOT, 'package.json'), 'the module reads this repository\'s manifest');
  // The declared version has no surrounding whitespace, so the trim in the reader
  // never has to hide a malformed field.
  assert.equal(MANIFEST.version, MANIFEST.version.trim());
});

// ---------------------------------------------------------------------------
// Hot update: the manifest changes on disk while the SAME module instance lives.
// ---------------------------------------------------------------------------
// A DSH hot update replaces the installed package under a running process: the module
// object (and its memo) is the one already loaded, while `package.json` on disk is the
// new build. The plugin activation must therefore be able to re-read it, or it stamps the
// Codex integration with the PREVIOUS version and the next start calls that fresh file
// "custom".

/**
 * An installed-shaped copy of `src/version.js` whose manifest can be rewritten in place.
 * @param {string} version - initial `version` value.
 * @returns {Promise<object>} sandbox with the imported module and a rewrite helper.
 */
async function hotUpdateSandbox(version) {
  const { cp, mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-version-hot-'));
  const packageRoot = join(sandbox, 'node_modules', 'dsh-taskbridge');
  await mkdir(join(packageRoot, 'src'), { recursive: true });
  await cp(join(ROOT, 'src', 'version.js'), join(packageRoot, 'src', 'version.js'));
  const manifestPath = join(packageRoot, 'package.json');
  const writeManifest = async (next) => {
    await writeFile(manifestPath, `${JSON.stringify({ name: 'dsh-taskbridge', version: next }, null, 2)}\n`, 'utf8');
  };
  await writeManifest(version);
  const module = await import(pathToFileURL(join(packageRoot, 'src', 'version.js')).href);
  return {
    module,
    writeManifest,
    async cleanup() { await rm(sandbox, { recursive: true, force: true }); },
  };
}

test('a hot update is seen by a FORCED re-read, while the ordinary call keeps its memo', async () => {
  const box = await hotUpdateSandbox('1.5.0');
  try {
    const first = box.module.reportedVersion();
    assert.equal(first.version, '1.5.0', 'the loaded build');

    // The host replaces the package on disk; this module instance does NOT reload.
    await box.writeManifest('1.5.1-test.2');

    // Ordinary calls stay memoised: that is the documented process-lifetime semantics
    // every MCP handshake relies on.
    assert.equal(box.module.reportedVersion().version, '1.5.0', 'the memo still answers the old value');
    assert.equal(box.module.readPackageManifest().version, '1.5.0');

    // The activation path forces one read and sees the new build.
    assert.equal(box.module.reportedVersion({ refresh: true }).version, '1.5.1-test.2',
      'refresh: true reads the manifest on disk');
    // ...and the refreshed answer becomes the memo, so later ordinary calls agree.
    assert.equal(box.module.reportedVersion().version, '1.5.1-test.2');

    // `refreshPackageManifest()` invalidates without reading: the next ordinary call
    // goes back to disk rather than answering from the old memo.
    await box.writeManifest('1.5.1-test.3');
    box.module.refreshPackageManifest();
    assert.equal(box.module.readPackageManifest().version, '1.5.1-test.3');
  } finally {
    await box.cleanup();
  }
});

test('a forced re-read still fails SAFELY when the manifest is broken', async () => {
  const box = await hotUpdateSandbox('1.5.0');
  try {
    assert.equal(box.module.reportedVersion().version, '1.5.0');
    const { unlink } = await import('node:fs/promises');
    const { join: joinPath } = await import('node:path');
    // Point at a package whose manifest is gone.
    await unlink(joinPath(box.module.PACKAGE_ROOT, 'package.json'));
    const fallback = box.module.reportedVersion({ refresh: true });
    assert.deepEqual(fallback, { name: 'dsh-taskbridge', version: '0.0.0-unknown', source: 'fallback' });
    assert.equal(box.module.readPackageManifest().ok, false, 'and the failure is memoised as the answer');
    assert.equal(box.module.readPackageManifest().reason, 'manifest-missing');
  } finally {
    await box.cleanup();
  }
});
