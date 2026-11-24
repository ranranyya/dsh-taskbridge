// The Codex agent-ownership record: ONE small JSON file per real Codex home, holding the
// LF-normalized SHA-256 of the agent template this plugin last proved it wrote there.
//
// Why it exists
// -------------
// Ownership of `$CODEX_HOME/agents/dsh-taskbridge.toml` is decided by CONTENT, never by the
// file name, a marker or a version line (see `src/codex/installer.js`). A template whose byte
// form was not enumerated in `KNOWN_AGENT_TEMPLATES` therefore looked like "somebody else's
// file" after an upgrade, and the plugin refused to refresh a file it had written itself.
// Enumerating every future release by hand does not scale, so this record answers the OTHER
// half of the question — "is this reachable file the current release's template?" — without
// either a per-release digest table or a heuristic on names, markers or version lines.
//
// What it is
// ----------
// `<plugin data dir>/codex-agent-ownership/<sha256 of the real home>.json`:
//
//   { "schemaVersion": 1, "codexHome": "<real home>", "templateLfSha256": "<64 hex>" }
//
// * keyed by the REAL home this plugin pinned, never by a spelling of it: the file name is a
//   digest of that path, so two different homes can never collide even on a case-sensitive
//   filesystem, and no case equivalence is ever inferred;
// * ONE digest, LF-normalized: CRLF and LF spellings of the same text agree, and nothing else
//   is normalized — an edited character, an added line, a tab or a rewritten `version` line all
//   change the digest. The template body and the record hold no credentials and no config.
//
// Reading is bounded and non-creating: an absolute `DSH_HOME` or the existing default only, a
// regular file of bounded size, and every ancestor proved to be a REAL directory (a link or a
// reparse point anywhere on the way is "no record" — such a directory is never created here).
// A missing, unreadable, malformed, differently-keyed or over-sized record is NO record: the
// file is then classified exactly as before, which is what keeps an operator's file theirs.

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Schema version of the record this module writes. */
export const OWNERSHIP_SCHEMA_VERSION = 1;

/** Directory, inside the plugin data directory, that holds one legacy agent record per Codex home. */
export const OWNERSHIP_DIR_NAME = 'codex-agent-ownership';

/** Directory, inside the plugin data directory, that holds one skill record per Codex home. */
export const SKILL_OWNERSHIP_DIR_NAME = 'codex-skill-ownership';

/** A digest: lowercase hex SHA-256. */
const SHA256 = /^[0-9a-f]{64}$/u;

/** Bound on a record file this module is willing to parse (~1 KB, never content). */
const MAX_RECORD_BYTES = 4096;

/**
 * The plugin's own data directory: `$DSH_HOME/data/dsh-delegate`.
 *
 * An ABSOLUTE `DSH_HOME` is the only accepted override — a relative one would resolve against
 * the harness working directory and let the record land somewhere nobody named. Without one the
 * documented `~/.dsh` default applies, exactly as for the installation record.
 * @param {Record<string, string | undefined>} [env] - environment (`DSH_HOME`).
 * @returns {string | null} absolute plugin data directory, or null when `DSH_HOME` is unusable.
 */
export function pluginDataDirectory(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (configured === '') return join(resolve(homedir()), '.dsh', 'data', 'dsh-delegate');
  if (!isAbsolute(configured)) return null;
  return join(resolve(configured), 'data', 'dsh-delegate');
}

/**
 * The record path for one Codex home.
 *
 * The file name is the digest of the REAL home path, so it identifies a directory rather than
 * reproducing its spelling — no case folding, no separator guessing, no collision between two
 * homes that differ only in case on a case-sensitive filesystem.
 * @param {string} codexHome - the REAL (pinned) Codex home.
 * @param {Record<string, string | undefined>} [env] - environment (`DSH_HOME`).
 * @returns {string | null} absolute record path, or null when the data directory is unusable.
 */
export function ownershipRecordPath(codexHome, env = process.env, dirName = OWNERSHIP_DIR_NAME) {
  const dataDir = pluginDataDirectory(env);
  if (dataDir === null) return null;
  if (typeof codexHome !== 'string' || codexHome.trim() === '' || !isAbsolute(codexHome)) return null;
  const key = createHash('sha256').update(resolve(codexHome), 'utf8').digest('hex');
  return join(dataDir, dirName, `${key}.json`);
}

/** The skill ownership record path for one Codex home. */
export function skillOwnershipRecordPath(codexHome, env = process.env) {
  return ownershipRecordPath(codexHome, env, SKILL_OWNERSHIP_DIR_NAME);
}

/**
 * Check that every existing ancestor of `target` is a REAL directory.
 *
 * A link, a junction/reparse point that `lstat` reports as a directory, an unreadable level or a
 * non-directory refuses the whole path. A missing level is reported as `missing` instead of
 * being created, so a READ can never build the data tree it is inspecting — the writer decides
 * whether to create it. The components come from the host's own path rules, so a POSIX `/`, a
 * Windows drive and a UNC share all keep their root.
 * @param {string} target - absolute path to inspect (the file itself is not inspected).
 * @param {Function} classify - the installer's own boundary proof, bound to `lstat` and the
 *   platform attribute read. Injected so this module never grows a second, weaker copy of it.
 * @returns {Promise<{ ok: boolean, missing: boolean, reason: string }>} verdict.
 */
export function chainPathsOf(target) {
  const absolute = resolve(target);
  const root = rootOf(absolute);
  const paths = [root];
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]+/u).filter((part) => part !== '')) {
    current = join(current, part);
    paths.push(current);
  }
  return paths;
}

async function inspectRealChain(target, classify, classifyMany = null) {
  const paths = chainPathsOf(target);
  if (typeof classifyMany === 'function') {
    const verdicts = await classifyMany(paths);
    if (verdicts.get(paths[0]) !== 'directory') return { ok: false, missing: false, reason: 'ancestor-not-a-directory' };
    for (let i = 1; i < paths.length; i += 1) {
      const kind = verdicts.get(paths[i]);
      if (kind === 'directory') continue;
      if (kind === 'missing') return { ok: false, missing: true, reason: 'ancestor-missing' };
      if (kind === 'link') return { ok: false, missing: false, reason: 'ancestor-is-a-link' };
      return { ok: false, missing: false, reason: 'ancestor-not-a-directory' };
    }
    return { ok: true, missing: false, reason: 'ok' };
  }
  if ((await classify(paths[0])) !== 'directory') return { ok: false, missing: false, reason: 'ancestor-not-a-directory' };
  for (let i = 1; i < paths.length; i += 1) {
    const kind = await classify(paths[i]);
    if (kind === 'directory') continue;
    if (kind === 'missing') return { ok: false, missing: true, reason: 'ancestor-missing' };
    if (kind === 'link') return { ok: false, missing: false, reason: 'ancestor-is-a-link' };
    return { ok: false, missing: false, reason: 'ancestor-not-a-directory' };
  }
  return { ok: true, missing: false, reason: 'ok' };
}

/**
 * The volume root of an absolute path, using the host's own rules.
 * @param {string} absolute - resolved absolute path.
 * @returns {string} the root (`/`, `C:\` or `\\host\share\`).
 */
function rootOf(absolute) {
  const drive = /^[A-Za-z]:[\\/]/u.exec(absolute);
  // The separator is part of the root: without it `join('C:', 'Users')` yields `C:Users`, a
  // RELATIVE path, and the walk would leave the tree it is supposed to prove.
  if (drive !== null) return `${drive[0].slice(0, 2)}${drive[0][2] === '/' ? '/' : '\\'}`;
  const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]/u.exec(absolute);
  if (unc !== null) return unc[0];
  return /^[\\/]/u.test(absolute) ? absolute[0] : '';
}

/**
 * The template digest this plugin last proved it wrote into one Codex home, or null.
 *
 * Returns null — "no record" — for every case that cannot be proved: an unusable data directory,
 * a path that does not exist yet, a link anywhere on the way, a file that is not a regular,
 * bounded, exactly-keyed record of this home, or any I/O failure. Null only ever means the file
 * on disk is classified by its content alone, never that something was adopted.
 * @param {object} options - `codexHome` (real, pinned), `env`, `classify` (see {@link inspectRealChain}).
 * @returns {Promise<string | null>} LF-normalized template digest, or null.
 */
export async function recallTemplateDigest({ codexHome, env = process.env, classify, classifyMany = null, dirName = OWNERSHIP_DIR_NAME } = {}) {
  const path = ownershipRecordPath(codexHome, env, dirName);
  if (path === null) return null;
  if (typeof classify !== 'function' && typeof classifyMany !== 'function') return null;
  const chain = await inspectRealChain(dirname(path), classify, classifyMany);
  if (chain.ok !== true) return null;
  const info = await lstat(path).catch(() => null);
  // A junction is a directory to `lstat`, and a symlink is not a regular file: both are refused.
  if (info === null || info.isSymbolicLink() || !info.isFile()) return null;
  if (info.size > MAX_RECORD_BYTES) return null;
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.schemaVersion !== OWNERSHIP_SCHEMA_VERSION) return null;
  // The interior must name THIS home. A record copied from another home (or hand-edited to a
  // different path) therefore authorizes nothing, whatever its file name says.
  if (typeof parsed.codexHome !== 'string' || resolve(parsed.codexHome) !== resolve(codexHome)) return null;
  if (typeof parsed.templateLfSha256 !== 'string' || !SHA256.test(parsed.templateLfSha256)) return null;
  return parsed.templateLfSha256;
}

/**
 * Record the digest of the template this plugin has just proved it wrote into one home.
 *
 * The digest is recomputed from the CURRENT file, which the caller has already proved is exactly
 * the template this build renders — never from a value the caller remembered. An unchanged
 * record is not rewritten (no write, no mtime change). An unusable or unproved path writes
 * nothing.
 * @param {object} options - `codexHome` (real, pinned), `env`, `template` (the rendered text
 *   the file must equal), `readFile` (`(path) => Promise<string>`, injected for the installer's
 *   own compare-before-write step), `writeFileAtomic`, `classify`.
 * @returns {Promise<{ ok: true, written: boolean } | { ok: false, reason: string }>} outcome.
 */
export async function rememberTemplateDigest({
  codexHome,
  env = process.env,
  template,
  agentPath,
  readFile: read = readFile,
  writeFileAtomic,
  mkdir: makeDirectory,
  classify,
  classifyMany = null,
  dirName = OWNERSHIP_DIR_NAME,
} = {}) {
  const path = ownershipRecordPath(codexHome, env, dirName);
  if (path === null) return { ok: false, reason: 'record-path-unusable' };
  if (typeof template !== 'string' || template === '') return { ok: false, reason: 'no-template' };
  if (typeof classify !== 'function') return { ok: false, reason: 'no-classifier' };
  if (typeof writeFileAtomic !== 'function' || typeof makeDirectory !== 'function') {
    return { ok: false, reason: 'no-writer' };
  }
  // Re-read the file NOW. If it is not exactly what this build renders, nothing is recorded:
  // the proof must come from the bytes on disk, not from the caller's intention.
  let current;
  try {
    current = await read(agentPath);
  } catch {
    return { ok: false, reason: 'agent-unreadable' };
  }
  if (current !== template) return { ok: false, reason: 'agent-not-this-template' };

  const chain = await inspectRealChain(dirname(path), classify, classifyMany);
  if (chain.ok !== true) {
    if (chain.reason !== 'ancestor-missing') return { ok: false, reason: chain.reason };
    // The record directory does not exist yet: create it one level at a time and re-prove.
    if (!(await createArchiveDirectory(dirname(path), classify, makeDirectory))) {
      return { ok: false, reason: 'record-directory-unusable' };
    }
  }
  const document = `${JSON.stringify({
    schemaVersion: OWNERSHIP_SCHEMA_VERSION,
    codexHome: resolve(codexHome),
    templateLfSha256: digestLf(template),
  })}\n`;
  const existing = await read(path).catch(() => null);
  if (existing === document) return { ok: true, written: false };
  try {
    await writeFileAtomic(path, document);
  } catch {
    return { ok: false, reason: 'record-write-failed' };
  }
  return { ok: true, written: true };
}

/**
 * Create the record directory (and any missing level of it), proving each one after creating it.
 *
 * Never recursive: a recursive create would walk through a link that appeared in the window.
 * @param {string} directory - absolute directory to create.
 * @param {Function} classify - boundary proof.
 * @param {Function} makeDirectory - `mkdir(path, { mode })`.
 * @returns {Promise<boolean>} whether a real directory now exists there.
 */
async function createArchiveDirectory(directory, classify, makeDirectory) {
  const absolute = resolve(directory);
  const root = rootOf(absolute);
  let current = root;
  // The ROOT itself is a boundary, not a level to create: `C:\` or `/` cannot be a link this
  // module may create, but a reparse point at the volume root is refused like any other.
  if ((await classify(root)) !== 'directory') return false;
  for (const part of absolute.slice(root.length).split(/[\\/]+/u).filter((part) => part !== '')) {
    current = join(current, part);
    const kind = await classify(current);
    if (kind === 'directory') continue;
    if (kind !== 'missing') return false;
    try {
      await makeDirectory(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
    }
    if ((await classify(current)) !== 'directory') return false;
  }
  return true;
}

/**
 * The LF-normalized SHA-256 of an agent text.
 *
 * Folding CRLF to LF is the ONLY tolerated difference, exactly as `isKnownPriorTemplate` treats
 * the published identities: the shipped template is stored with CRLF while the managed file is
 * written with LF, so the terminator spelling is not a content difference. Nothing else is
 * normalized — a version line, a comment, a blank line, a tab, a trailing space or a BOM all
 * survive and change the digest. A `\r` left after the fold is a character of the file, not a
 * spelling, and is therefore hashed as it is.
 * @param {string} text - agent file or template text.
 * @returns {string} lowercase hex SHA-256.
 */
export async function recallSkillTemplateDigest({ codexHome, env = process.env, classify, classifyMany = null } = {}) {
  return await recallTemplateDigest({ codexHome, env, classify, classifyMany, dirName: SKILL_OWNERSHIP_DIR_NAME });
}

export async function rememberSkillTemplateDigest({
  codexHome,
  env = process.env,
  template,
  skillPath,
  readFile: read = readFile,
  writeFileAtomic,
  mkdir: makeDirectory,
  classify,
  classifyMany = null,
} = {}) {
  return await rememberTemplateDigest({
    codexHome,
    env,
    template,
    agentPath: skillPath,
    readFile: read,
    writeFileAtomic,
    mkdir: makeDirectory,
    classify,
    classifyMany,
    dirName: SKILL_OWNERSHIP_DIR_NAME,
  });
}

export function digestLf(text) {
  return createHash('sha256').update(String(text).replace(/\r\n/gu, '\n'), 'utf8').digest('hex');
}
