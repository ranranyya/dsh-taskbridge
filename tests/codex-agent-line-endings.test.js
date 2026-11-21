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
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_PATH = join(ROOT, 'codex', 'dsh-taskbridge.toml');
const FIXTURES = join(ROOT, 'tests', 'fixtures');
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
  return [
    ['lf', lf],
    ['crlf', crlf],
    ['version-mixed', withOneBareLf(crlf)],
    ['mixed', withOneBareLf(crlf, /^# dsh-taskbridge Codex companion.*/mu)],
    ['alternating', alternating(lf)],
  ];
}

/** A temporary Codex home with its own `agents` directory. */
function temporaryCodexHome() {
  const home = temporaryDirectory('codex-home');
  mkdirSync(join(home, 'agents'), { recursive: true });
  return home;
}

/** Environment naming only this Codex home, so no operator override leaks in. */
function isolatedEnv(codexHome) {
  return { CODEX_HOME: codexHome, DSH_HOME: join(codexHome, '.dsh-test-home'), DSH_DELEGATE_DISCOVERY_FILE: '' };
}

/** The agent file path inside a Codex home. */
function agentPathOf(home) {
  return join(home, 'agents', 'dsh-taskbridge.toml');
}

/**
 * A Codex home with an operator `config.toml` whose bytes must survive any agent action.
 * @returns {{ home: string, configPath: string, config: string, agentPath: string }} facts.
 */
function homeWithConfig() {
  const home = temporaryCodexHome();
  const configPath = join(home, 'config.toml');
  const config = '# operator config\r\nmodel = "keep-me"\r\n';
  writeFileSync(configPath, config);
  return { home, configPath, config, agentPath: agentPathOf(home) };
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
async function runAgainstAgent(home, body, action) {
  const agentPath = agentPathOf(home);
  writeFileSync(agentPath, body, 'utf8');
  const beforeMtime = lstatSync(agentPath).mtimeMs;
  const outcome = await ACTIONS[action](home);
  const stillThere = lstatSync(agentPath, { throwIfNoEntry: false });
  const after = stillThere === undefined ? null : readFileSync(agentPath, 'utf8');
  const untouched = stillThere !== undefined && stillThere.mtimeMs === beforeMtime && after === body;
  return { before: body, after, outcome, untouched };
}

/** The edited bodies every negative case must preserve, as `[label, edit]` pairs. */
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
  // The current template is `installed`, not `outdated`: it is the text this build writes, in
  // any of its spellings.
  for (const [variant, form] of spellingVariants(current)) {
    const home = temporaryCodexHome();
    writeFileSync(agentPathOf(home), form, 'utf8');
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
  const bases = {
    '1.5.1': readFileSync(FIXTURE_1_5_1, 'utf8'),
    '1.5.2': readFileSync(FIXTURE_1_5_2, 'utf8'),
    current: current,
  };
  for (const [name, base] of Object.entries(bases)) {
    for (const [variant, form] of spellingVariants(base)) {
      for (const [editLabel, edit] of Object.entries(USER_EDITS)) {
        const edited = edit(form);
        assert.notEqual(edited, form, `${name} ${variant} ${editLabel}: the edit changed the text`);
        assert.equal(isKnownPriorTemplate(edited), false, `${name} ${variant} ${editLabel} is not a known build`);
        assert.equal(isKnownPriorTemplate(edited, { ignoreVersion: true }), false, `${name} ${variant} ${editLabel} is not a known body either`);
      }
    }
  }
  // Two terminators folded onto one line is an edit, not a spelling.
  const lf = asLf(bases['1.5.1']);
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
    assert.equal(isKnownPriorTemplate(text, { ignoreVersion: true }), false, `${release} ${shape} is not a known body`);
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

test('an extra-CR file is modified and install, refresh and remove all keep its bytes', async () => {
  for (const [release, shape, text] of extraCarriageReturnShapes()) {
    for (const action of ['install', 'refresh', 'remove']) {
      const { home, agentPath } = homeWithConfig();
      const facts = await runAgainstAgent(home, text, action);
      const status = facts.outcome.status;
      assert.equal(status.agent.state, 'modified', `${release} ${shape} ${action}: reported modified`);
      assert.equal(status.agent.managed, false, `${release} ${shape} ${action}: not managed`);
      assert.equal(facts.after, text, `${release} ${shape} ${action}: the bytes are unchanged`);
      assert.equal(facts.untouched, true, `${release} ${shape} ${action}: the file was not rewritten or deleted`);
      assert.equal(facts.outcome.changed.includes('agent'), false, `${release} ${shape} ${action}: no agent write`);
      if (action === 'install') {
        assert.ok(
          facts.outcome.refused.some((entry) => entry.target === 'agent' && entry.code === 'AGENT_USER_MODIFIED'),
          `${release} ${shape} ${action}: install refuses it as the operator's`,
        );
      }
      assert.equal(readFileSync(agentPath, 'utf8'), text, `${release} ${shape} ${action}: still the same file`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. readAgentState through the real status read
// ---------------------------------------------------------------------------

test('a mixed-spelling 1.5.1 installation is outdated (upgradable), not modified', async () => {
  const home = temporaryCodexHome();
  const mixed = withOneBareLf(asCrlf(readFileSync(FIXTURE_1_5_1, 'utf8')));
  writeFileSync(agentPathOf(home), mixed, 'utf8');
  const status = await statusOf(home);
  assert.equal(status.agent.state, 'outdated', 'the untouched mixed 1.5.1 install is a known prior build');
  assert.equal(status.agent.reason, null);
  assert.equal(status.agent.managed, true);
  assert.equal(status.agent.expect, mixed, 'expect stays the exact bytes that were read');
  assert.ok(status.notes.some((note) => note.code === 'AGENT_OUTDATED'));
  assert.equal(status.notes.some((note) => note.code === 'AGENT_USER_MODIFIED'), false);
});

test('an installed current agent is never re-blamed for an older version line it does not carry', async () => {
  // The same body at another marker is a different identity: it must not be reported as
  // `installed`, and nothing may invent a version line for it.
  const other = renderAgentFile(await readAgentTemplate(), '0.0.0-older');
  for (const [variant, form] of spellingVariants(other)) {
    const { home, agentPath, config } = homeWithConfig();
    const status = await statusOf(home);
    assert.equal(status.agent.state, 'not-installed');
    const facts = await runAgainstAgent(home, form, 'install');
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
  assert.match(template, /^version[ \t]*=/mu);

  // A template whose version line must be INSERTED, with body bytes that must survive. The
  // sample is minimal on purpose: the insertion lands on the first non-comment, non-blank line,
  // so the input states that line explicitly.
  const withoutVersion = [
    '# header comment',
    '',
    'name = "x"  ',
    '\ttabbed = 1',
    '',
    // Every line except the marker and the first `name = …` line: the filter drops a version
    // line in either spelling (`\r?`, because this text is not normalized before filtering).
    ...asLf(template).split('\n').filter((line) => !/^version[ \t]*="?/u.test(line) && !/^name = /u.test(line)),
  ].join('\n');
  assert.doesNotMatch(withoutVersion, /^version[ \t]*=/mu);

  for (const [label, input] of spellingVariants(template)) {
    const rendered = renderAgentFile(input, VERSION);
    assert.equal(measure(rendered).crlf, 0, `${label}: the managed file is LF only`);
    assert.equal(measure(rendered).bareLf, measure(asLf(input)).bareLf, `${label}: the line count is unchanged`);
    assert.equal(rendered, renderAgentFile(template, VERSION), `${label}: every spelling renders the same bytes`);
    assert.ok(`\n${rendered}`.includes(`\nversion = "${VERSION}"\n`), `${label}: the version line is stamped`);
    assert.equal(/\r/u.test(rendered), false, `${label}: no CR survives into the managed file`);
  }

  // This input has no version line at all, so the sampled line is its header comment: the
  // variants still cover LF, CRLF, a one-terminator mixture and alternation.
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
    // A header comment and a blank line come first, so the marker goes right after them.
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

test('a rendered file read back is installed, whatever spelling it was written from', async () => {
  const template = await readAgentTemplate();
  for (const [label, input] of spellingVariants(template)) {
    const rendered = renderAgentFile(input, VERSION);
    const home = temporaryCodexHome();
    writeFileSync(agentPathOf(home), rendered, 'utf8');
    const status = await statusOf(home);
    assert.equal(status.agent.state, 'installed', `${label}: the written file reads back as installed`);
    assert.equal(status.agent.expect, rendered);
  }
});

// ---------------------------------------------------------------------------
// 5. The upgrade path: install / refresh / remove across a real temporary home
// ---------------------------------------------------------------------------

test('every prior build is upgraded by install and by startup refresh, idempotently', async () => {
  const template = renderAgentFile(await readAgentTemplate(), VERSION);
  for (const [fixtureLabel, fixture] of [['1.5.1', FIXTURE_1_5_1], ['1.5.2', FIXTURE_1_5_2]]) {
    for (const [label, form] of spellingVariants(readFileSync(fixture, 'utf8'))) {
      for (const action of ['install', 'refresh']) {
        const { home, configPath, config, agentPath } = homeWithConfig();
        writeFileSync(agentPath, form, 'utf8');
        const first = await ACTIONS[action](home);
        assert.equal(first.changed.includes('agent'), true, `${fixtureLabel} ${label} ${action}: the agent is upgraded`);
        assert.equal(first.changed.includes('mcp'), action === 'install', `${fixtureLabel} ${label} ${action}: only install writes the MCP entry`);
        assert.equal(readFileSync(agentPath, 'utf8'), template, `${fixtureLabel} ${label} ${action}: the template is written`);
        assert.equal(measure(readFileSync(agentPath, 'utf8')).crlf, 0, `${fixtureLabel} ${label} ${action}: written as LF`);

        // A fresh read of the same filesystem state, then the same action again: nothing left.
        const reread = await statusOf(home);
        assert.equal(reread.agent.state, 'installed', `${fixtureLabel} ${label} ${action}: reads back installed`);
        const second = await ACTIONS[action](home);
        assert.deepEqual(second.changed, [], `${fixtureLabel} ${label} ${action}: a repeat changes nothing`);
        const third = await ACTIONS[action](home);
        assert.deepEqual(third.changed, [], `${fixtureLabel} ${label} ${action}: still idempotent`);
        assert.equal(readFileSync(agentPath, 'utf8'), template);

        // `refresh` is the unattended path and must never write config.toml at all; `install`
        // writes its MCP entry by contract, so only the operator's own bytes are required to
        // survive there.
        if (action === 'refresh') assert.equal(readFileSync(configPath, 'utf8'), config, `${fixtureLabel} ${label}: config.toml untouched`);
        else assert.ok(readFileSync(configPath, 'utf8').startsWith(config), `${fixtureLabel} ${label}: operator bytes survive`);
      }
    }
  }
});

test('an operator edit survives install, refresh and remove without a byte of change', async () => {
  const template = renderAgentFile(await readAgentTemplate(), VERSION);
  for (const [variant, base] of spellingVariants(template)) {
    for (const [editLabel, edit] of Object.entries(USER_EDITS)) {
      const edited = edit(base);
      for (const action of ['install', 'refresh', 'remove']) {
        const { home, agentPath } = homeWithConfig();
        const facts = await runAgainstAgent(home, edited, action);
        assert.equal(facts.outcome.status?.agent?.state ?? 'modified', 'modified', `${editLabel} (${variant}) ${action}: modified`);
        assert.equal(facts.after, edited, `${editLabel} (${variant}) ${action}: the bytes are unchanged`);
        assert.equal(facts.untouched, true, `${editLabel} (${variant}) ${action}: the file was not rewritten`);
        if (action === 'install') {
          assert.ok(
            facts.outcome.refused.some((entry) => entry.target === 'agent' && entry.code === 'AGENT_USER_MODIFIED'),
            `${editLabel} (${variant}) ${action}: install refuses explicitly as the operator's file`,
          );
        }
        assert.equal(readFileSync(agentPath, 'utf8'), edited, `${editLabel} (${variant}) ${action}: still the same file`);
      }
    }
  }
});

test('an edited prior build is never upgraded by install or refresh, nor deleted by remove', async () => {
  for (const [fixtureLabel, fixture] of [['1.5.1', FIXTURE_1_5_1], ['1.5.2', FIXTURE_1_5_2]]) {
    for (const [variant, base] of spellingVariants(readFileSync(fixture, 'utf8'))) {
      for (const [editLabel, edit] of Object.entries(USER_EDITS)) {
        const edited = edit(base);
        for (const action of ['install', 'refresh', 'remove']) {
          const { home, agentPath } = homeWithConfig();
          const facts = await runAgainstAgent(home, edited, action);
          assert.equal(facts.after, edited, `${fixtureLabel} ${editLabel} (${variant}) ${action}: bytes unchanged`);
          assert.equal(facts.untouched, true, `${fixtureLabel} ${editLabel} (${variant}) ${action}: not replaced or deleted`);
          assert.equal(facts.outcome.changed.includes('agent'), false, `${fixtureLabel} ${editLabel} (${variant}) ${action}: nothing written`);
        }
      }
    }
  }
});

test('the delete re-proof stays byte-exact, so a file changed after the read survives', async () => {
  const home = temporaryCodexHome();
  const agentPath = agentPathOf(home);
  const template = renderAgentFile(await readAgentTemplate(), VERSION);
  writeFileSync(agentPath, template, 'utf8');
  const status = await statusOf(home);
  assert.equal(status.agent.state, 'installed');
  // A rewrite that only changes the terminator spelling is still a different byte identity than
  // the `expect` the status captured, so the removal must refuse rather than delete.
  const respelled = asCrlf(template);
  assert.notEqual(respelled, template);
  writeFileSync(agentPath, respelled, 'utf8');
  const verdict = await removeManagedAgentFile(status.agent);
  assert.equal(verdict.code, 'AGENT_USER_MODIFIED');
  assert.equal(verdict.reason, 'modified-before-removal');
  assert.equal(readFileSync(agentPath, 'utf8'), respelled, 'the file was kept');
});

// ---------------------------------------------------------------------------
// 6. repair keeps its MCP-only contract, and config.toml is never touched by an upgrade
// ---------------------------------------------------------------------------

test('repair never repairs the agent, whatever the agent spelling is', async () => {
  const mixed = withOneBareLf(asCrlf(readFileSync(FIXTURE_1_5_1, 'utf8')));
  const { home, configPath, config, agentPath } = homeWithConfig();
  writeFileSync(agentPath, mixed, 'utf8');
  const repaired = await runCodexAction('repair', { codexHome: home, env: isolatedEnv(home), version: VERSION });
  assert.equal(repaired.changed.includes('agent'), false, 'repair does not touch the agent file');
  assert.equal(readFileSync(agentPath, 'utf8'), mixed, 'the outdated agent is left exactly as it was');
  assert.equal(repaired.status.agent.state, 'outdated', 'and the status still reports why');
  assert.ok(readFileSync(configPath, 'utf8').startsWith(config), 'the operator config bytes survive');
  assert.equal(repaired.refused.some((entry) => entry.target === 'agent'), false, 'repair makes no agent claim either way');
});

test('a recognized mixed build is removable and config.toml stays byte-identical', async () => {
  const { home, configPath, config, agentPath } = homeWithConfig();
  writeFileSync(agentPath, withOneBareLf(asCrlf(readFileSync(FIXTURE_1_5_1, 'utf8'))), 'utf8');
  const removed = await runCodexAction('remove', { codexHome: home, env: isolatedEnv(home), version: VERSION });
  assert.deepEqual(removed.changed.filter((entry) => entry === 'agent'), ['agent'], 'the known build is removable');
  assert.equal(lstatSync(agentPath, { throwIfNoEntry: false }), undefined, 'the agent is gone');
  assert.equal(readFileSync(configPath, 'utf8'), config, 'config.toml is byte-identical');
});

// ---------------------------------------------------------------------------
// 7. The PRODUCT layout: no `tests/` directory at all
// ---------------------------------------------------------------------------

/**
 * Copy the module and its direct dependencies into a directory layout that ships in the package
 * (`src/`, `codex/`, `package.json`) and carries NO `tests/` tree.
 *
 * This is the regression the review required: the first attempt read byte identities out of
 * `tests/fixtures`, which `npm pack` never installs, so it passed in this checkout and failed in
 * an installation. Only file copies happen here — no source rewriting, no module stubbing.
 * @returns {string} absolute path of the copied package root.
 */
function productLayout() {
  const root = temporaryDirectory('product-layout');
  for (const relative of [
    'src/codex/installer.js',
    'src/codex/toml.js',
    'src/codex/agent-ownership.js',
    'src/config/store.js',
    'codex/dsh-taskbridge.toml',
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
  // The layout is a real package copy, not a checkout: it has no fixtures to fall back to.
  assert.equal(lstatSync(join(root, 'tests'), { throwIfNoEntry: false }), undefined, 'no tests directory is shipped');
  assert.equal(lstatSync(join(root, 'src', 'codex', 'installer.js'), { throwIfNoEntry: false })?.isFile(), true);

  // Import the COPIED module, so its own relative paths (template, package.json) resolve here.
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

  // The same identities the source checkout recognizes, recognized without tests/fixtures.
  assert.equal(shipped.isKnownPriorTemplate(fixture), true, '1.5.1 LF is known in the shipped layout');
  assert.equal(shipped.isKnownPriorTemplate(crlf), true, '1.5.1 CRLF is known in the shipped layout');
  assert.equal(shipped.isKnownPriorTemplate(mixed), true, 'the version-mixed form is known in the shipped layout');
  assert.equal(shipped.isKnownPriorTemplate(alternating(asLf(fixture))), true, 'the alternating form is known in the shipped layout');
  // ...and an edit is still an edit there.
  assert.equal(shipped.isKnownPriorTemplate(crlf.replace('\nname = ', '\n# mine\nname = ')), false);

  // A real status read through the COPIED module: the upgrade is not blocked any more.
  const home = temporaryDirectory('layout-codex-home');
  mkdirSync(join(home, 'agents'), { recursive: true });
  writeFileSync(join(home, 'agents', 'dsh-taskbridge.toml'), mixed, 'utf8');
  const status = await shipped.readCodexStatus({ codexHome: home, env: isolatedEnv(home) });
  assert.equal(status.agent.state, 'outdated', 'the shipped layout reports the mixed install as upgradable');

  const refreshed = await shipped.refreshKnownAgentTemplate({ codexHome: home, env: isolatedEnv(home), version: status.packageVersion });
  assert.deepEqual(refreshed.changed, ['agent'], 'the shipped layout upgrades it');
  const written = readFileSync(join(home, 'agents', 'dsh-taskbridge.toml'), 'utf8');
  assert.equal(measure(written).crlf, 0, 'written LF');
  // The written file is the release template itself here, so it reads back `installed`; what
  // matters is that an EDITED file above was never claimed, which the assertions above prove.
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
    // No tests/fixtures exist in this layout, so this is the packaged module's own answer.
    assert.equal(await shipped.isKnownPriorTemplate(text), false, `${release} ${shape}: not known in the shipped layout`);
    const home = temporaryDirectory('layout-cr-home');
    mkdirSync(join(home, 'agents'), { recursive: true });
    writeFileSync(join(home, 'agents', 'dsh-taskbridge.toml'), text, 'utf8');
    const status = await shipped.readCodexStatus({ codexHome: home, env: isolatedEnv(home) });
    assert.equal(status.agent.state, 'modified', `${release} ${shape}: modified in the shipped layout`);
    const refreshed = await shipped.refreshKnownAgentTemplate({ codexHome: home, env: isolatedEnv(home), version: status.packageVersion });
    assert.deepEqual(refreshed.changed, [], `${release} ${shape}: the shipped layout refuses to upgrade it`);
    assert.equal(readFileSync(join(home, 'agents', 'dsh-taskbridge.toml'), 'utf8'), text, `${release} ${shape}: bytes kept`);

    // The legal spellings are still recognized there, so the guard did not just disable the fix.
    const legal = asCrlf(publishedTexts()[release]);
    assert.equal(await shipped.isKnownPriorTemplate(legal), true, `${release}: the published CRLF form is still known`);
    assert.equal(
      await shipped.isKnownPriorTemplate(withOneBareLf(legal)),
      true,
      `${release}: the version-line mixture is still known`,
    );
  }
});
