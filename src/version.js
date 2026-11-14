// The version this build actually is, read from its own package manifest.
//
// A literal version in the source is a second copy of a fact that already lives in
// `package.json`, and the two drift: the MCP handshake reported `1.4.2` while a
// pre-release tarball of the same source answered `initialize` with that shipped
// number, so a host could not tell which build it was talking to.
//
// The manifest is the ONE source. It is read from disk on demand and is the fixed
// relative location `<package root>/package.json`, where `<package root>` is the
// directory above this module's own `src/`. That is the only layout this build
// supports: a checkout, an installed tarball and the published `files` allowlist all
// keep `src/`, so no other lookup is attempted. A build that cannot read the manifest
// says so instead of inventing a number.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This module's directory (`<package root>/src`). */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The package root this module is loaded from: one directory above `src/`.
 *
 * Derived from the module's own location rather than `process.cwd()`, which a host may
 * have set to anything.
 */
export const PACKAGE_ROOT = resolve(MODULE_DIR, '..');

/** Absolute path of the manifest this module reads. The only location it reads. */
export const MANIFEST_PATH = join(PACKAGE_ROOT, 'package.json');

/** The package name reported when the manifest cannot supply one. */
const FALLBACK_NAME = 'dsh-taskbridge';

/** The memoised manifest answer, or null before the first read. */
let cached = null;

/**
 * Read the manifest this build belongs to.
 *
 * Memoised: the answer cannot change while the process runs, and the handshake may be
 * asked for it repeatedly by an MCP host that reconnects.
 * @returns {{ ok: true, name: string, version: string, path: string }
 *   | { ok: false, reason: string, path: string }} the manifest facts, or why not.
 */
export function readPackageManifest() {
  if (cached !== null) return cached;
  cached = loadPackageManifest();
  return cached;
}

/**
 * Read and parse the manifest without memoising.
 * @returns {{ ok: true, name: string, version: string, path: string }
 *   | { ok: false, reason: string, path: string }} the manifest facts, or why not.
 */
function loadPackageManifest() {
  let text;
  try {
    text = readFileSync(MANIFEST_PATH, 'utf8');
  } catch (error) {
    return { ok: false, path: MANIFEST_PATH, reason: error?.code === 'ENOENT' ? 'manifest-missing' : 'manifest-unreadable' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, path: MANIFEST_PATH, reason: 'manifest-invalid' };
  }
  const version = typeof parsed?.version === 'string' ? parsed.version.trim() : '';
  const name = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
  if (version === '') return { ok: false, path: MANIFEST_PATH, reason: 'manifest-version-missing' };
  return {
    ok: true,
    name: name === '' ? FALLBACK_NAME : name,
    version,
    path: MANIFEST_PATH,
  };
}

/**
 * The version to report, with an explicit fallback when the manifest cannot be read.
 *
 * The fallback version is `'0.0.0-unknown'` rather than a plausible-looking release
 * number: an MCP host that reads it learns the build could not describe itself, which
 * is the true fact, instead of being told a version that belongs to a different build.
 * The fallback NAME is this package's own name, so an unreadable manifest still reports
 * the right package rather than a historical alias.
 * @returns {{ name: string, version: string, source: string }} reported identity.
 *   `source` is `package.json` when the manifest was read, `fallback` otherwise.
 */
export function reportedVersion() {
  const manifest = readPackageManifest();
  if (manifest.ok) {
    return { name: manifest.name, version: manifest.version, source: 'package.json' };
  }
  return { name: FALLBACK_NAME, version: '0.0.0-unknown', source: 'fallback' };
}
