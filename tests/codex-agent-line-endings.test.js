// G12 regression: a managed Codex agent file whose bytes differ from the template only in how
// its line terminators are spelled (LF, CRLF, a version-line mixture, or alternation) is the
// SAME text and must be recognized as a managed file.
//
// The defect this file pins: this repository stores `codex/dsh-taskbridge.toml` with CRLF
// terminators while `renderAgentFile` writes the managed copy with LF, so byte equality alone
// reported a file with the other spelling as `modified` — "somebody else's file" — which
// blocked the upgrade of an otherwise untouched installation. The observed 1.5.1 case is
// reproduced exactly below (version line LF, every other line CRLF: 40258 bytes, 515 CRLF and
// 1 bare LF).
//
// Two more properties are pinned here, because they decide whether this fix is real:
//   * it must work in the PRODUCT layout. `installer.js` may only depend on files that ship in
//     the package, so a copy of the module without `tests/` (that is, exactly what `npm pack`
//     installs) must classify the same mixed file correctly. No test here stubs the module or
//     rewrites its source: the layout test copies the real files and imports that copy.
//   * only the CRLF/LF spelling is tolerated. A comment, a blank line, a trailing space, a tab,
//     a BOM, a lone CR, a changed version line or any other edit is still `modified`, and every
//     action leaves those bytes untouched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative as relativePath, resolve } from 'node:path';
import { readCodexRuleFiles } from './helpers/codex-rule-files.js';
import { fileURLToPath } from 'node:url';

import {
  digest,
  isKnownPriorTemplate,
  packageVersion,
  readAgentTemplate,
  readCodexStatus,
  refreshKnownAgentTemplate,
  removeManagedAgentFile,
  renderAgentFile,
  runCodexAction,
  useDirectoryClassifier,
} from '../src/codex/installer.js';
import { describeCodexOutcome } from '../src/client/api.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_PATH = join(ROOT, 'codex', 'skills', 'dsh-taskbridge', 'SKILL.md');
const FIXTURES = join(ROOT, 'tests', 'fixtures');

function writeCurrentSkill(path, entry) {
  const { reference, referencePath } = readCodexRuleFiles();
  writeFileSync(path, entry, 'utf8');
  writeFileSync(join(dirname(path), basename(referencePath)), reference, 'utf8');
}
const FIXTURE_1_5_1 = join(FIXTURES, 'agent-1.5.1.toml');
const FIXTURE_1_5_2 = join(FIXTURES, 'agent-1.5.2.toml');

// The boundary proof asks the platform whether `$CODEX_HOME` and `$CODEX_HOME/agents` are real
// directories; on Windows that spawns a `powershell.exe` child. This suite answers through the
// documented classifier hook so it runs where a child cannot be spawned; everything else —
// `lstat`, the content comparisons, the writes — is the product code.
useDirectoryClassifier(async (paths) => {
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

/** The package version this checkout reports, so a status and an install agree on it. */
const VERSION = await packageVersion();

/** Every temporary directory this file created, removed in `after()`. */
const createdDirectories = [];
test.after(() => {
  for (const directory of createdDirectories) rmSync(directory, { recursive: true, force: true });
});

/**
 * Create a temporary directory under the OS temp root and register it for cleanup.
 * @param {string} label - prefix that names the purpose.
 * @returns {string} absolute path.
 */
function temporaryDirectory(label) {
  const directory = mkdtempSync(join(tmpdir(), `dsh-delegate-${label}-`));
  createdDirectories.push(directory);
  return directory;
}

/**
 * Count line terminators the way the failure was reported: CRLF pairs and bare LFs.
 * @param {string} text - text.
 * @returns {{ bytes: number, chars: number, crlf: number, bareLf: number }} measurements.
 */
function measure(text) {
  let crlf = 0;
  let bareLf = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue;
    if (index > 0 && text[index - 1] === '\r') crlf += 1;
    else bareLf += 1;
  }
  return { bytes: Buffer.byteLength(text, 'utf8'), chars: text.length, crlf, bareLf };
}

/** The same text with every terminator spelled CRLF. */
function asCrlf(text) {
  return text.replace(/\r?\n/gu, '\r\n');
}

/** The same text with every terminator spelled LF. */
function asLf(text) {
  return text.replace(/\r\n/gu, '\n');
}

/**
 * Replace the terminator of the FIRST line matching `pattern` with a bare LF.
 *
 * This is the only edit a spelling variant makes: one terminator changes spelling, no line is
 * added, removed or trimmed. The pattern excludes its own terminator, and the caller's assertion
 * proves the replaced two characters are exactly `\r\n`, so an off-by-one cannot silently turn
 * the sample into a different text.
 * @param {string} text - CRLF text.
 * @param {RegExp} [pattern] - line pattern (multiline, anchored at `^`, excluding the terminator).
 * @returns {string} the text with that one terminator spelled LF.
 */
function withOneBareLf(text, pattern = /^version[ \t]*=[ \t]*"[^"]*"/mu) {
  const match = pattern.exec(text);
  assert.ok(match !== null, `no line matches ${String(pattern)}`);
  // The line start is `match.index`; its content is the first line of the match, and the
  // terminator begins right after that line's content (never at an offset derived from the
  // match LENGTH, which would be off by one when the pattern also spans a `\r`).
  const lineContent = match[0].replace(/\r?\n[\s\S]*$/u, '').replace(/\r$/u, '');
  const terminator = match.index + lineContent.length;
  assert.equal(text.slice(terminator, terminator + 2), '\r\n', 'the matched line ends CRLF');
  return text.slice(0, terminator) + '\n' + text.slice(terminator + 2);
}

/**
 * Every line terminator, alternating LF and CRLF (the first line terminator stays CRLF).
 * @param {string} text - LF text.
 * @returns {string} the same text with alternating terminators.
 */
function alternating(text) {
  let index = 0;
  return text.replace(/\n/gu, () => {
    index += 1;
    return index % 2 === 0 ? '\n' : '\r\n';
  });
}

/**
 * The spelling variants of one text, each with a stable label.
 *
 * `version-mixed` is the observed failure shape (version line LF, everything else CRLF);
 * `mixed` respells a different single line so the tolerance cannot be woken up by the version
 * line alone; `alternating` is the task-required every-other-line form.
 * @param {string} text - the reference text.
 * @returns {Array<[string, string]>} `[label, text]` pairs.
 */
function spellingVariants(text) {
  const lf = asLf(text);
  const crlf = asCrlf(text);
  const isSkill = /^---\r?\n/u.test(crlf);
  const versionPattern = isSkill ? /^<!-- dsh-taskbridge-version: .* -->/mu : /^version[ \t]*=[ \t]*"[^"]*"/mu;
  const headerPattern = isSkill ? /^<!-- dsh-taskbridge-managed:.*/mu : /^# dsh-taskbridge Codex companion.*/mu;
  return [
    ['lf', lf],
    ['crlf', crlf],
    ['version-mixed', withOneBareLf(crlf, versionPattern)],
    ['mixed', withOneBareLf(crlf, headerPattern)],
    ['alternating', alternating(lf)],
  ];
}

/** A temporary Codex home with its own `skills/dsh-taskbridge` and `agents` directories. */
function temporaryCodexHome() {
  const home = temporaryDirectory('codex-home');
  mkdirSync(join(home, 'skills', 'dsh-taskbridge'), { recursive: true });
  mkdirSync(join(home, 'agents'), { recursive: true });
  return home;
}

/** Environment naming only this Codex home, so no operator override leaks in. */
function isolatedEnv(codexHome) {
  return { CODEX_HOME: codexHome, DSH_HOME: join(codexHome, '.dsh-test-home'), DSH_DELEGATE_DISCOVERY_FILE: '' };
}

/** The managed skill file path inside a Codex home. */
function skillPathOf(home) {
  return join(home, 'skills', 'dsh-taskbridge', 'SKILL.md');
}

/** The legacy retired agent file path inside a Codex home. */
function agentPathOf(home) {
  return join(home, 'agents', 'dsh-taskbridge.toml');
}

/**
 * A Codex home with an operator `config.toml` whose bytes must survive any skill/agent action.
 */
function homeWithConfig() {
  const home = temporaryCodexHome();
  const configPath = join(home, 'config.toml');
  const config = '# operator config\r\nmodel = "keep-me"\r\n';
  writeFileSync(configPath, config);
  return { home, configPath, config, skillPath: skillPathOf(home), agentPath: agentPathOf(home) };
}

/**
 * The status document the installer itself derives for a home: `expect` is the exact bytes a
 * write or delete will re-prove against.
 * @param {string} home - Codex home.
 * @returns {Promise<object>} status.
 */
async function statusOf(home) {
  return await readCodexStatus({ codexHome: home, env: isolatedEnv(home), version: VERSION });
}

/** Every action runner, keyed by the action name a test uses. */
const ACTIONS = {
  install: home => runCodexAction('install', { codexHome: home, env: isolatedEnv(home), version: VERSION }),
  refresh: home => refreshKnownAgentTemplate({ codexHome: home, env: isolatedEnv(home), version: VERSION }),
  remove: home => runCodexAction('remove', { codexHome: home, env: isolatedEnv(home), version: VERSION }),
};

/**
 * Place exact bytes at the agent path, run an action, and report what happened to those bytes.
 * @param {string} home - Codex home.
 * @param {string} body - exact bytes to place at the agent path.
 * @param {'install' | 'refresh' | 'remove'} action - which action to run.
 * @returns {Promise<{ before: string, after: string | null, outcome: object, untouched: boolean }>}
 *   `after` is null when the action deleted the file; `untouched` means the very same file (same
 *   bytes, same timestamp) is still in place.
 */
async function runAgainstFile(home, filePath, body, action) {
  writeFileSync(filePath, body, 'utf8');
  const beforeMtime = lstatSync(filePath).mtimeMs;
  const outcome = await ACTIONS[action](home);
  const stillThere = lstatSync(filePath, { throwIfNoEntry: false });
  const after = stillThere === undefined ? null : readFileSync(filePath, 'utf8');
  const untouched = stillThere !== undefined && stillThere.mtimeMs === beforeMtime && after === body;
  return { before: body, after, outcome, untouched };
}

async function runAgainstAgent(home, body, action) {
  return await runAgainstFile(home, agentPathOf(home), body, action);
}

async function runAgainstSkill(home, body, action) {
  return await runAgainstFile(home, skillPathOf(home), body, action);
}

/** The edited bodies every negative case must preserve, as `[label, edit]` pairs (legacy TOML). */
const USER_EDITS = {
  'an added comment': (text) => text.replace('\nname = ', '\n# mine\nname = '),
  'an added blank line': (text) => text.replace('\nname = ', '\n\nname = '),
  'a trailing space': (text) => text.replace('\nname = ', ' \nname = '),
  'a tab': (text) => text.replace('\nname = ', '\t\nname = '),
  'a removed blank line': (text) => text.replace(/^description = "[^"]*"\r?\n\r?\n/mu, (match) => match.replace(/\r?\n\r?\n$/u, '\n')),
  'a byte-order mark': (text) => `\uFEFF${text}`,
  'a lone CR': (text) => text.replace(/\nname = /u, '\rname = '),
  'a new version line': (text) => text.replace(/^version = ".*"$/mu, 'version = "9.9.9"'),
  'an older version line': (text) => text.replace(/^version = ".*"$/mu, 'version = "1.0.0"'),
  'a removed version line': (text) => text.replace(/^version = ".*"\r?\n/mu, ''),
};

/** The edited bodies every negative case must preserve for the native SKILL.md template. */
const SKILL_USER_EDITS = {
  'an added comment': (text) => `${text}\n<!-- mine -->\n`,
  'an added blank line': (text) => text.replace('\nname: ', '\n\nname: '),
  'a trailing space': (text) => text.replace('\nname: ', ' \nname: '),
  'a tab': (text) => text.replace('\nname: ', '\t\nname: '),
  'a removed blank line': (text) => text.replace(/^<!-- dsh-taskbridge-version: .* -->\r?\n\r?\n/mu, (match) => match.replace(/\r?\n\r?\n$/u, '\n')),
  'a byte-order mark': (text) => `\uFEFF${text}`,
  'a lone CR': (text) => text.replace(/\nname: /u, '\rname: '),
  'a new version comment': (text) => text.replace(/^<!-- dsh-taskbridge-version: .* -->$/mu, '<!-- dsh-taskbridge-version: 9.9.9 -->'),
  'an older version comment': (text) => text.replace(/^<!-- dsh-taskbridge-version: .* -->$/mu, '<!-- dsh-taskbridge-version: 1.0.0 -->'),
  'a removed version comment': (text) => text.replace(/^<!-- dsh-taskbridge-version: .* -->\r?\n/mu, ''),
};

// ---------------------------------------------------------------------------
// 1. Reproduction and the spelling variants a known build can take
// ---------------------------------------------------------------------------

test('the observed 1.5.1 mixed file is exactly the published text with one terminator respelled', () => {
  const fixture = readFileSync(FIXTURE_1_5_1, 'utf8');
  const mixed = withOneBareLf(asCrlf(fixture));
  // The sample is byte-for-byte the reported shape, so this is the real defect, not a proxy.
  assert.deepEqual(measure(mixed), { bytes: 40258, chars: 40140, crlf: 515, bareLf: 1 });
  assert.deepEqual(measure(asCrlf(fixture)), { bytes: 40259, chars: 40141, crlf: 516, bareLf: 0 });
  // Only the terminator spelling differs: normalizing both gives the same text.
  assert.equal(asLf(mixed), asLf(fixture));
  // And it is a DIFFERENT byte identity, which is why byte equality alone said `modified`.
  assert.notEqual(digest(mixed), digest(asCrlf(fixture)));
  assert.notEqual(digest(mixed), digest(fixture));
});

test('every 1.5.1, 1.5.2 and current-template spelling is recognized, and nothing else is', async () => {
  const current = renderAgentFile(await readAgentTemplate(), VERSION);
  const sources = [
    ['1.5.1', readFileSync(FIXTURE_1_5_1, 'utf8')],
    ['1.5.2', readFileSync(FIXTURE_1_5_2, 'utf8')],
  ];
  for (const [label, text] of sources) {
    for (const [variant, form] of spellingVariants(text)) {
      assert.equal(isKnownPriorTemplate(form), true, `${label} ${variant} is a known published build`);
    }
  }
  // The current skill template is `installed`, not `outdated`: it is the text this build writes,
  // in any of its spellings.
  for (const [variant, form] of spellingVariants(current)) {
    const home = temporaryCodexHome();
    writeCurrentSkill(skillPathOf(home), form);
    const status = await statusOf(home);
    assert.equal(status.agent.state, 'installed', `current template ${variant} is installed`);
    assert.equal(status.agent.expect, form, `current template ${variant}: expect is the exact bytes`);
  }
});

// ---------------------------------------------------------------------------
// 2. What must still be `modified`, in every spelling
// ---------------------------------------------------------------------------

test('every operator edit is still modified, in every spelling of every known text', async () => {
  const current = renderAgentFile(await readAgentTemplate(), VERSION);
  const legacyBases = {
    '1.5.1': readFileSync(FIXTURE_1_5_1, 'utf8'),
    '1.5.2': readFileSync(FIXTURE_1_5_2, 'utf8'),
  };
  for (const [name, base] of Object.entries(legacyBases)) {
    for (const [variant, form] of spellingVariants(base)) {
      for (const [editLabel, edit] of Object.entries(USER_EDITS)) {
        const edited = edit(form);
        assert.notEqual(edited, form, `${name} ${variant} ${editLabel}: the edit changed the text`);
        assert.equal(isKnownPriorTemplate(edited), false, `${name} ${variant} ${editLabel} is not a known build`);
      }
    }
  }
  for (const [variant, form] of spellingVariants(current)) {
    for (const [editLabel, edit] of Object.entries(SKILL_USER_EDITS)) {
      const edited = edit(form);
      assert.notEqual(edited, form, `current ${variant} ${editLabel}: the edit changed the text`);
      assert.equal(isKnownPriorTemplate(edited), false, `current ${variant} ${editLabel} is not a known build`);
    }
  }
  // Two terminators folded onto one line is an edit, not a spelling.
  const lf = asLf(legacyBases['1.5.1']);
  assert.equal(isKnownPriorTemplate(`${lf.slice(0, 10)}\r\r\n${lf.slice(10)}`), false, 'a lone CR before a CRLF is an edit');
  assert.equal(isKnownPriorTemplate(`${lf}\r`), false, 'a trailing CR is an edit');
});

// ---------------------------------------------------------------------------
// 2b. A CR per line is a CHARACTER, not a spelling (second-review blocker)
// ---------------------------------------------------------------------------

/** The published text of each release under test, as LF. */
function publishedTexts() {
  return {
    '1.5.1': asLf(readFileSync(FIXTURE_1_5_1, 'utf8')),
    '1.5.2': asLf(readFileSync(FIXTURE_1_5_2, 'utf8')),
  };
}

/**
 * The file shapes a single CRLF→LF fold does not normalize away, per release.
 *
 * `cr-crlf` rewrites EVERY CRLF terminator to `\r\r\n`, so one fold leaves a CR in front of each
 * terminator and the folded text is itself CRLF. That is exactly the shape that was wrongly
 * claimed as a published CRLF build and then overwritten. `cr-cr-crlf` doubles the extra CR, and
 * `embedded-cr` is one bare CR inside a body line, which is also a character of the file.
 * @returns {Array<[string, string, string]>} `[release, shape, text]` triples.
 */
function extraCarriageReturnShapes() {
  const shapes = [];
  for (const [release, lf] of Object.entries(publishedTexts())) {
    const crlf = asCrlf(lf);
    shapes.push([release, 'cr-crlf', crlf.replace(/\r\n/gu, '\r\r\n')]);
    shapes.push([release, 'cr-cr-crlf', crlf.replace(/\r\n/gu, '\r\r\r\n')]);
    shapes.push([release, 'embedded-cr', lf.replace(/\nname = /u, '\rname = ')]);
  }
  return shapes;
}

test('a file with an extra CR per line is never claimed as a known build', async () => {
  for (const [release, shape, text] of extraCarriageReturnShapes()) {
    assert.ok(text.includes('\r'), `${release} ${shape}: the sample carries a CR`);
    assert.equal(isKnownPriorTemplate(text), false, `${release} ${shape} is not a known build`);
  }
  // The samples are genuinely different files from the published CRLF form, and one fold leaves a
  // CR behind — which is exactly why a plain fold cannot be trusted as an identity.
  for (const [release, lf] of Object.entries(publishedTexts())) {
    const crlf = asCrlf(lf);
    const doubled = crlf.replace(/\r\n/gu, '\r\r\n');
    assert.notEqual(digest(doubled), digest(crlf), `${release}: the doubled form has its own digest`);
    assert.ok(asLf(doubled).includes('\r'), `${release}: a leftover CR survives the fold`);
    assert.notEqual(asLf(doubled), lf, `${release}: the doubled form is not the published text`);
  }
});

test('an extra-CR legacy file is modified-legacy and install, refresh and remove all keep its bytes', async () => {
  for (const [release, shape, text] of extraCarriageReturnShapes()) {
    for (const action of ['install', 'refresh', 'remove']) {
      const { home, agentPath } = homeWithConfig();
      const facts = await runAgainstAgent(home, text, action);
      const status = facts.outcome.status;
      assert.equal(status.legacyAgents.state, 'modified-legacy', `${release} ${shape} ${action}: reported modified-legacy`);
      assert.equal(facts.after, text, `${release} ${shape} ${action}: the bytes are unchanged`);
      assert.equal(facts.untouched, true, `${release} ${shape} ${action}: the file was not rewritten or deleted`);
      if (action !== 'install') {
        assert.equal(facts.outcome.changed.includes('agent'), false, `${release} ${shape} ${action}: no write`);
      }
      assert.equal(readFileSync(agentPath, 'utf8'), text, `${release} ${shape} ${action}: still the same file`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. readAgentState through the real status read
// ---------------------------------------------------------------------------

test('a mixed-spelling 1.5.1 legacy installation is managed-legacy (upgradable), not modified-legacy', async () => {
  const home = temporaryCodexHome();
  const mixed = withOneBareLf(asCrlf(readFileSync(FIXTURE_1_5_1, 'utf8')));
  writeFileSync(agentPathOf(home), mixed, 'utf8');
  const status = await statusOf(home);
  assert.equal(status.legacyAgents.state, 'managed-legacy', 'the untouched mixed 1.5.1 install is a known prior build');
  assert.equal(status.legacyAgents.entries[0].expect, mixed, 'expect stays the exact bytes that were read');
  assert.ok(status.notes.some((note) => note.code === 'LEGACY_AGENT_MIGRATION_PENDING'));
  assert.equal(status.notes.some((note) => note.code === 'LEGACY_AGENT_USER_MODIFIED'), false);
});

test('an installed current skill is never re-blamed for an older version marker it does not carry', async () => {
  const other = renderAgentFile(await readAgentTemplate(), '0.0.0-older');
  for (const [variant, form] of spellingVariants(other)) {
    const { home, config } = homeWithConfig();
    const status = await statusOf(home);
    assert.equal(status.agent.state, 'not-installed');
    const facts = await runAgainstSkill(home, form, 'install');
    assert.notEqual(facts.outcome.status.agent.state, 'installed', `${variant}: a foreign marker is never adopted`);
    if (facts.after === null) continue;
    assert.equal(facts.after, form, `${variant}: install did not rewrite it`);
    assert.equal(facts.untouched, true, `${variant}: install left the file as it was`);
    assert.ok(readFileSync(join(home, 'config.toml'), 'utf8').startsWith(config) || config.length === 0);
  }
});

// ---------------------------------------------------------------------------
// 4. renderAgentFile
// ---------------------------------------------------------------------------

test('renderAgentFile writes LF for LF, CRLF and mixed input and keeps the body verbatim', async () => {
  const template = await readAgentTemplate();
  assert.match(template, /^<!-- dsh-taskbridge-version: .* -->$/mu);

  // Legacy TOML input without a version line still gets `version = "<VERSION>"` inserted cleanly.
  const withoutVersion = [
    '# header comment',
    '',
    'name = "x"  ',
    '\ttabbed = 1',
    '',
    'body = "keep"',
  ].join('\n');
  assert.doesNotMatch(withoutVersion, /^version[ \t]*=/mu);

  for (const [label, input] of spellingVariants(template)) {
    const rendered = renderAgentFile(input, VERSION);
    assert.equal(measure(rendered).crlf, 0, `${label}: the managed file is LF only`);
    assert.equal(measure(rendered).bareLf, measure(asLf(input)).bareLf, `${label}: the line count is unchanged`);
    assert.equal(rendered, renderAgentFile(template, VERSION), `${label}: every spelling renders the same bytes`);
    assert.ok(`\n${rendered}`.includes(`\n<!-- dsh-taskbridge-version: ${VERSION} -->\n`), `${label}: the version comment is stamped`);
    assert.equal(/\r/u.test(rendered), false, `${label}: no CR survives into the managed file`);
  }

  // Legacy TOML insertion path remains verbatim-preserving.
  const insertions = [];
  const sampleLine = /^# header comment/mu;
  const insertVariants = [
    ['lf', withoutVersion],
    ['crlf', asCrlf(withoutVersion)],
    ['version-mixed', withOneBareLf(asCrlf(withoutVersion), sampleLine)],
    ['mixed', withOneBareLf(asCrlf(withoutVersion), /^name = "x"  /mu)],
    ['alternating', alternating(asLf(withoutVersion))],
  ];
  for (const [label, input] of insertVariants) {
    assert.equal(asLf(input), asLf(withoutVersion), `${label}: the input is the same text`);
    const rendered = renderAgentFile(input, VERSION);
    assert.equal(measure(rendered).crlf, 0, `${label}: the inserted-line output is LF only`);
    const lines = rendered.split('\n');
    assert.equal(lines[2], `version = "${VERSION}"`, `${label}: the marker follows the provenance header`);
    assert.equal(lines[3], 'name = "x"  ', `${label}: the body continues unchanged after the marker`);
    insertions.push(rendered);
    assert.equal(rendered.replace(`version = "${VERSION}"\n`, ''), asLf(input), `${label}: nothing but the marker was added`);
  }
  assert.equal(new Set(insertions).size, 1, 'every spelling of the input produces identical output');
  for (const rendered of insertions) {
    assert.ok(rendered.includes('name = "x"  \n'), 'trailing spaces are preserved');
    assert.ok(rendered.includes('\ttabbed = 1\n'), 'a leading tab is preserved');
    assert.ok(rendered.includes('comment\n\nversion = '), 'the blank line after the comment is preserved');
  }

  // The shipped template file itself is never modified by rendering.
  assert.equal(readFileSync(TEMPLATE_PATH, 'utf8'), template);
});

// Extracted byte-for-byte from the archived test2 package, not from the current template.
const test2Skill = readFileSync(join(FIXTURES, 'skill-1.9.0-test2.md'), 'utf8');

for (const [ending, prior] of [['LF', test2Skill], ['CRLF', asCrlf(test2Skill)]]) {
  test(`an untouched test2 skill (${ending}) upgrades without an ownership record`, async () => {
    for (const action of ['install', 'refresh']) {
      const { home, skillPath } = homeWithConfig();
      writeFileSync(skillPath, prior);
      const before = await statusOf(home);
      assert.equal(before.agent.state, 'outdated');
      assert.notEqual(before.agent.recorded, true);
      const result = await ACTIONS[action](home);
      assert.deepEqual(result.changed, action === 'install' ? ['agent', 'mcp'] : ['agent']);
      assert.deepEqual(result.refused, []);
      assert.equal(result.status.agent.state, 'installed');
      assert.equal(readFileSync(skillPath, 'utf8'), renderAgentFile(await readAgentTemplate(), VERSION));
    }
  });

  test(`an edited test2 skill (${ending}) survives install, startup refresh and removal`, async () => {
    const edited = prior.replace('delegate_preflight', 'delegate_preflight_custom');
    assert.notEqual(edited, prior);
    for (const action of ['install', 'refresh', 'remove']) {
      const result = await runAgainstSkill(temporaryCodexHome(), edited, action);
      assert.equal(result.outcome.status.agent.state, 'modified');
      assert.equal(result.outcome.status.agent.reason, 'unknown-content');
      assert.equal(result.outcome.changed.includes('agent'), false);
      assert.equal(result.untouched, true);
    }
  });
}

test('install and startup report legacy cleanup separately when the skill is already installed', async () => {
  const prior = readFileSync(FIXTURE_1_5_2, 'utf8');
  for (const action of ['install', 'refresh']) {
    const { home, skillPath, agentPath } = homeWithConfig();
    await ACTIONS.install(home);
    const skill = readFileSync(skillPath, 'utf8');
    const skillMtime = lstatSync(skillPath).mtimeMs;
    writeFileSync(agentPath, prior);
    const result = await ACTIONS[action](home);
    assert.deepEqual(result.changed, ['legacyAgent']);
    assert.deepEqual(result.refused, []);
    assert.equal(describeCodexOutcome(result), '已清理：旧版子智能体文件。');
    assert.equal(existsSync(agentPath), false);
    assert.equal(readFileSync(skillPath, 'utf8'), skill);
    assert.equal(lstatSync(skillPath).mtimeMs, skillMtime);
  }
});

test('removing a legacy subagent by itself does not report removing a skill', async () => {
  const { home, skillPath, agentPath } = homeWithConfig();
  writeFileSync(agentPath, readFileSync(FIXTURE_1_5_2, 'utf8'));
  const result = await ACTIONS.remove(home);
  assert.deepEqual(result.changed, ['legacyAgent']);
  assert.deepEqual(result.refused, []);
  assert.equal(describeCodexOutcome(result), '已移除：旧版子智能体文件。');
  assert.equal(existsSync(agentPath), false);
  assert.equal(existsSync(skillPath), false);
});

test('a rendered skill read back is installed, whatever spelling it was written from', async () => {
  const template = await readAgentTemplate();
  for (const [label, input] of spellingVariants(template)) {
    const rendered = renderAgentFile(input, VERSION);
    const home = temporaryCodexHome();
    writeCurrentSkill(skillPathOf(home), rendered);
    const status = await statusOf(home);
    assert.equal(status.agent.state, 'installed', `${label}: the written file reads back as installed`);
    assert.equal(status.agent.expect, rendered);
  }
});

// ---------------------------------------------------------------------------
// 5. The upgrade path: install / refresh / remove across a real temporary home
// ---------------------------------------------------------------------------

test('every prior build is migrated to native skill by install and startup refresh, idempotently, retiring old toml', async () => {
  const template = renderAgentFile(await readAgentTemplate(), VERSION);
  for (const [fixtureLabel, fixture] of [['1.5.1', FIXTURE_1_5_1], ['1.5.2', FIXTURE_1_5_2]]) {
    for (const [label, form] of spellingVariants(readFileSync(fixture, 'utf8'))) {
      for (const action of ['install', 'refresh']) {
        const { home, configPath, config, skillPath, agentPath } = homeWithConfig();
        writeFileSync(agentPath, form, 'utf8');
        const first = await ACTIONS[action](home);
        assert.equal(first.changed.includes('agent'), true, `${fixtureLabel} ${label} ${action}: the skill is migrated`);
        assert.equal(first.changed.includes('legacyAgent'), true, `${fixtureLabel} ${label} ${action}: the legacy subagent is removed`);
        assert.equal(first.changed.includes('mcp'), action === 'install', `${fixtureLabel} ${label} ${action}: only install writes the MCP entry`);
        assert.equal(readFileSync(skillPath, 'utf8'), template, `${fixtureLabel} ${label} ${action}: the skill template is written`);
        assert.equal(measure(readFileSync(skillPath, 'utf8')).crlf, 0, `${fixtureLabel} ${label} ${action}: written as LF`);
        assert.equal(existsSync(agentPath), false, `${fixtureLabel} ${label} ${action}: untouched legacy toml is retired`);

        // A fresh read of the same filesystem state, then the same action again: nothing left.
        const reread = await statusOf(home);
        assert.equal(reread.agent.state, 'installed', `${fixtureLabel} ${label} ${action}: reads back installed`);
        assert.equal(reread.legacyAgents.state, 'absent');
        const second = await ACTIONS[action](home);
        assert.deepEqual(second.changed, [], `${fixtureLabel} ${label} ${action}: a repeat changes nothing`);
        const third = await ACTIONS[action](home);
        assert.deepEqual(third.changed, [], `${fixtureLabel} ${label} ${action}: still idempotent`);
        assert.equal(readFileSync(skillPath, 'utf8'), template);

        if (action === 'refresh') assert.equal(readFileSync(configPath, 'utf8'), config, `${fixtureLabel} ${label}: config.toml untouched`);
        else assert.ok(readFileSync(configPath, 'utf8').startsWith(config), `${fixtureLabel} ${label}: operator bytes survive`);
      }
    }
  }
});

test('an operator edit to SKILL.md survives install, refresh and remove without a byte of change', async () => {
  const template = renderAgentFile(await readAgentTemplate(), VERSION);
  for (const [variant, base] of spellingVariants(template)) {
    for (const [editLabel, edit] of Object.entries(SKILL_USER_EDITS)) {
      const edited = edit(base);
      for (const action of ['install', 'refresh', 'remove']) {
        const { home, skillPath } = homeWithConfig();
        const facts = await runAgainstSkill(home, edited, action);
        assert.equal(facts.outcome.status?.agent?.state ?? 'modified', 'modified', `${editLabel} (${variant}) ${action}: modified`);
        assert.equal(facts.after, edited, `${editLabel} (${variant}) ${action}: the bytes are unchanged`);
        assert.equal(facts.untouched, true, `${editLabel} (${variant}) ${action}: the file was not rewritten`);
        if (action === 'install') {
          assert.ok(
            facts.outcome.refused.some((entry) => entry.target === 'agent' && entry.code === 'AGENT_USER_MODIFIED'),
            `${editLabel} (${variant}) ${action}: install refuses explicitly as the operator's file`,
          );
        }
        assert.equal(readFileSync(skillPath, 'utf8'), edited, `${editLabel} (${variant}) ${action}: still the same file`);
      }
    }
  }
});

test('an edited prior build is never deleted by install, refresh or remove', async () => {
  for (const [fixtureLabel, fixture] of [['1.5.1', FIXTURE_1_5_1], ['1.5.2', FIXTURE_1_5_2]]) {
    for (const [variant, base] of spellingVariants(readFileSync(fixture, 'utf8'))) {
      for (const [editLabel, edit] of Object.entries(USER_EDITS)) {
        const edited = edit(base);
        for (const action of ['install', 'refresh', 'remove']) {
          const { home } = homeWithConfig();
          const facts = await runAgainstAgent(home, edited, action);
          assert.equal(facts.after, edited, `${fixtureLabel} ${editLabel} (${variant}) ${action}: bytes unchanged`);
          assert.equal(facts.untouched, true, `${fixtureLabel} ${editLabel} (${variant}) ${action}: not replaced or deleted`);
          if (action !== 'install') {
            assert.equal(facts.outcome.changed.includes('agent'), false, `${fixtureLabel} ${editLabel} (${variant}) ${action}: nothing written`);
          }
        }
      }
    }
  }
});

test('the delete re-proof stays byte-exact, so a skill file changed after the read survives', async () => {
  const home = temporaryCodexHome();
  const skillPath = skillPathOf(home);
  const template = renderAgentFile(await readAgentTemplate(), VERSION);
  writeCurrentSkill(skillPath, template);
  const status = await statusOf(home);
  assert.equal(status.agent.state, 'installed');
  const respelled = asCrlf(template);
  assert.notEqual(respelled, template);
  writeFileSync(skillPath, respelled, 'utf8');
  const verdict = await removeManagedAgentFile(status.agent);
  assert.equal(verdict.code, 'AGENT_USER_MODIFIED');
  assert.equal(verdict.reason, 'modified-before-removal');
  assert.equal(readFileSync(skillPath, 'utf8'), respelled, 'the file was kept');
});

// ---------------------------------------------------------------------------
// 6. repair keeps its MCP-only contract, and config.toml is never touched by an upgrade
// ---------------------------------------------------------------------------

test('repair never touches the skill or legacy agent, whatever the spelling is', async () => {
  const mixed = withOneBareLf(asCrlf(readFileSync(FIXTURE_1_5_1, 'utf8')));
  const { home, configPath, config, skillPath, agentPath } = homeWithConfig();
  writeFileSync(agentPath, mixed, 'utf8');
  const repaired = await runCodexAction('repair', { codexHome: home, env: isolatedEnv(home), version: VERSION });
  assert.equal(repaired.changed.includes('agent'), false, 'repair does not touch the skill or legacy agent file');
  assert.equal(readFileSync(agentPath, 'utf8'), mixed, 'the legacy agent is left exactly as it was');
  assert.equal(existsSync(skillPath), false, 'repair does not create the skill');
  assert.equal(repaired.status.legacyAgents.state, 'managed-legacy', 'and the status still reports pending migration');
  assert.ok(readFileSync(configPath, 'utf8').startsWith(config), 'the operator config bytes survive');
  assert.equal(repaired.refused.some((entry) => entry.target === 'agent'), false, 'repair makes no agent claim either way');
});

test('a recognized mixed build is removable and config.toml stays byte-identical', async () => {
  const { home, configPath, config, agentPath } = homeWithConfig();
  writeFileSync(agentPath, withOneBareLf(asCrlf(readFileSync(FIXTURE_1_5_1, 'utf8'))), 'utf8');
  const removed = await runCodexAction('remove', { codexHome: home, env: isolatedEnv(home), version: VERSION });
  assert.deepEqual(removed.changed, ['legacyAgent'], 'the known legacy build is removable');
  assert.equal(lstatSync(agentPath, { throwIfNoEntry: false }), undefined, 'the legacy agent is gone');
  assert.equal(readFileSync(configPath, 'utf8'), config, 'config.toml is byte-identical');
});

// ---------------------------------------------------------------------------
// 7. The PRODUCT layout: no `tests/` directory at all
// ---------------------------------------------------------------------------

function productLayout() {
  const root = temporaryDirectory('product-layout');
  for (const relative of [
    'src/codex/installer.js',
    'src/codex/toml.js',
    'src/codex/agent-ownership.js',
    'src/config/store.js',
    'codex/skills/dsh-taskbridge/SKILL.md',
    relativePath(ROOT, readCodexRuleFiles().referencePath),
    'package.json',
  ]) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(ROOT, relative)));
  }
  return root;
}

test('the mixed-line-ending fix holds in a package layout that ships no tests directory', async () => {
  const root = productLayout();
  assert.equal(lstatSync(join(root, 'tests'), { throwIfNoEntry: false }), undefined, 'no tests directory is shipped');
  assert.equal(lstatSync(join(root, 'src', 'codex', 'installer.js'), { throwIfNoEntry: false })?.isFile(), true);

  const shipped = await import(`${new URL(`file:///${join(root, 'src', 'codex', 'installer.js').replace(/\\/gu, '/')}`).href}?layout=${Date.now()}`);
  shipped.useDirectoryClassifier(async (paths) => {
    const kinds = new Map();
    for (const path of paths) {
      const info = lstatSync(path, { throwIfNoEntry: false });
      if (info === undefined) kinds.set(path, 'missing');
      else if (info.isSymbolicLink()) kinds.set(path, 'link');
      else if (info.isDirectory()) kinds.set(path, 'directory');
      else kinds.set(path, 'other');
    }
    return kinds;
  });

  const fixture = readFileSync(FIXTURE_1_5_1, 'utf8');
  const crlf = asCrlf(fixture);
  const mixed = withOneBareLf(crlf);
  assert.equal(measure(mixed).bytes, 40258, 'the real observed mixed sample');
  assert.deepEqual(measure(mixed), { bytes: 40258, chars: 40140, crlf: 515, bareLf: 1 });

  assert.equal(shipped.isKnownPriorTemplate(fixture), true, '1.5.1 LF is known in the shipped layout');
  assert.equal(shipped.isKnownPriorTemplate(crlf), true, '1.5.1 CRLF is known in the shipped layout');
  assert.equal(shipped.isKnownPriorTemplate(mixed), true, 'the version-mixed form is known in the shipped layout');
  assert.equal(shipped.isKnownPriorTemplate(alternating(asLf(fixture))), true, 'the alternating form is known in the shipped layout');
  assert.equal(shipped.isKnownPriorTemplate(crlf.replace('\nname = ', '\n# mine\nname = ')), false);

  const home = temporaryDirectory('layout-codex-home');
  mkdirSync(join(home, 'agents'), { recursive: true });
  writeFileSync(join(home, 'agents', 'dsh-taskbridge.toml'), mixed, 'utf8');
  const status = await shipped.readCodexStatus({ codexHome: home, env: isolatedEnv(home) });
  assert.equal(status.legacyAgents.state, 'managed-legacy', 'the shipped layout reports the mixed legacy install as upgradable');

  const refreshed = await shipped.refreshKnownAgentTemplate({ codexHome: home, env: isolatedEnv(home), version: status.packageVersion });
  assert.deepEqual(refreshed.changed, ['agent', 'legacyAgent'], 'the shipped layout migrates it');
  assert.equal(existsSync(join(home, 'agents', 'dsh-taskbridge.toml')), false, 'and retires the old toml');
  const written = readFileSync(join(home, 'skills', 'dsh-taskbridge', 'SKILL.md'), 'utf8');
  assert.equal(measure(written).crlf, 0, 'written LF');
  const after = await shipped.readCodexStatus({ codexHome: home, env: isolatedEnv(home), version: status.packageVersion });
  assert.equal(after.agent.state, 'installed', 'and reads back installed in the shipped layout');
});

test('the shipped layout also refuses a file with an extra CR per line', async () => {
  const root = productLayout();
  const shipped = await import(`${new URL(`file:///${join(root, 'src', 'codex', 'installer.js').replace(/\\/gu, '/')}`).href}?layout=${Date.now()}&cr`);
  shipped.useDirectoryClassifier(async (paths) => {
    const kinds = new Map();
    for (const path of paths) {
      const info = lstatSync(path, { throwIfNoEntry: false });
      if (info === undefined) kinds.set(path, 'missing');
      else if (info.isSymbolicLink()) kinds.set(path, 'link');
      else if (info.isDirectory()) kinds.set(path, 'directory');
      else kinds.set(path, 'other');
    }
    return kinds;
  });

  for (const [release, shape, text] of extraCarriageReturnShapes()) {
    assert.equal(await shipped.isKnownPriorTemplate(text), false, `${release} ${shape}: not known in the shipped layout`);
    const home = temporaryDirectory('layout-cr-home');
    mkdirSync(join(home, 'agents'), { recursive: true });
    writeFileSync(join(home, 'agents', 'dsh-taskbridge.toml'), text, 'utf8');
    const status = await shipped.readCodexStatus({ codexHome: home, env: isolatedEnv(home) });
    assert.equal(status.legacyAgents.state, 'modified-legacy', `${release} ${shape}: modified-legacy in the shipped layout`);
    const refreshed = await shipped.refreshKnownAgentTemplate({ codexHome: home, env: isolatedEnv(home), version: status.packageVersion });
    assert.deepEqual(refreshed.changed, [], `${release} ${shape}: the shipped layout refuses to upgrade it`);
    assert.equal(readFileSync(join(home, 'agents', 'dsh-taskbridge.toml'), 'utf8'), text, `${release} ${shape}: bytes kept`);

    const legal = asCrlf(publishedTexts()[release]);
    assert.equal(await shipped.isKnownPriorTemplate(legal), true, `${release}: the published CRLF form is still known`);
    assert.equal(
      await shipped.isKnownPriorTemplate(withOneBareLf(legal)),
      true,
      `${release}: the version-line mixture is still known`,
    );
  }
});
