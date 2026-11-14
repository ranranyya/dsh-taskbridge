// Continuation identity: the real acceptance defect, pinned.
//
// The reported failure was not a wildcard hole — it was the opposite. Redaction
// masked ordinary repository names (`dsh-delegate`, `dsh-taskbridge`) because they
// looked like profile keys, so every durable path of this product's own checkout was
// shortened. A shortened path proves nothing, so after a host restart a cancelled
// task's conversation could not be continued at all.
//
// These tests state both halves of the repair, on the exact paths from the report:
//
//  1. ordinary repositories and installed packages keep their readable path, and only
//     an id-shaped temporary profile segment is masked;
//  2. a path carries a canonical spelling and a digest, so a record that WAS shortened
//     can still prove which directory it named — and a record that proves nothing is
//     refused, never assumed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { redactDeep, redactText } from '../src/config/redact.js';
import {
  PATH_MASK_SEGMENT,
  canonicalPath,
  continuationIdentityOf,
  isPathDigest,
  pathDigest,
  readPathIdentity,
  recordedDirectoryIs,
  recordedPathIsMasked,
  sameCanonicalPath,
  sameRecordedDirectory,
} from '../src/jobs/continuation-identity.js';
import { sameSessionPath } from '../src/runtime/session-placement.js';
import { makeTempDir } from './helpers/fakes.js';

const WORKSPACE = 'E:\\deepseek workplace\\dsh-delegate';
const PACKAGE = 'E:\\deepseek workplace\\dsh-delegate\\node_modules\\dsh-taskbridge';
const TEMP_PROFILE = 'C:\\Users\\24615\\AppData\\Local\\Temp\\dsh-SoexNz';

// ---------------------------------------------------------------------------
// 1. The acceptance paths are not rewritten
// ---------------------------------------------------------------------------

test('R1: this repository and an installed dsh-taskbridge package keep their real path', () => {
  assert.equal(redactText(WORKSPACE), WORKSPACE);
  assert.equal(redactText(join(WORKSPACE, 'src', 'index.js')), join(WORKSPACE, 'src', 'index.js'));
  assert.equal(redactText(join(PACKAGE, 'package.json')), join(PACKAGE, 'package.json'));
  assert.equal(redactText(WORKSPACE).includes(PATH_MASK_SEGMENT), false);
  // An ordinary word in prose is untouched in either direction.
  assert.equal(redactText('dsh-delegate is the plugin, dsh-taskbridge is the package'), 'dsh-delegate is the plugin, dsh-taskbridge is the package');
});

test('R1: a long ordinary path is not a reason to shorten anything', () => {
  // The 403-character Windows path plus a command was the other half of the refusal:
  // the path was fine, the boundary was too small (see `tests/permissions.test.js`).
  const deep = `${WORKSPACE}\\${Array.from({ length: 12 }, (_, index) => `some-rather-long-directory-name-${index}`).join('\\')}\\file.js`;
  assert.ok(deep.length > 400, 'the fixture is a long path');
  assert.equal(redactText(deep), deep);
});

test('R1: a real temporary profile segment is still masked', () => {
  const masked = redactText(join(TEMP_PROFILE, 'work', 'x.txt'));
  assert.equal(masked, join(`C:\\Users\\24615\\AppData\\Local\\Temp\\${PATH_MASK_SEGMENT}`, 'work', 'x.txt'));
  assert.equal(masked.includes('SoexNz'), false, 'the account-identifying key must not survive');
});

test('R1: a profile key is masked only under a temporary root, by its context alone', () => {
  // The rule is about WHERE the key lives, not what it looks like. Under a temp root
  // (`Temp`, `tmp`, `.cache`) a `dsh-`/`profile-` segment with six id characters is
  // masked; the temp-root segment itself is kept so the path stays recognisable.
  const masked = [
    ['C:\\Temp\\dsh-SoexNz\\x', 'C:\\Temp\\masks-user-profile-segment\\x'],
    ['C:\\Temp\\dsh-9Fk2Lm\\x', 'C:\\Temp\\masks-user-profile-segment\\x'],
    ['C:\\Temp\\profile-a1b2c3\\x', 'C:\\Temp\\masks-user-profile-segment\\x'],
    ['/home/u/.cache/dsh-SoexNz/x', '/home/u/.cache/masks-user-profile-segment/x'],
    ['C:\\Users\\u\\AppData\\Local\\Temp\\dsh-VG1MVl\\work', 'C:\\Users\\u\\AppData\\Local\\Temp\\masks-user-profile-segment\\work'],
  ];
  for (const [value, expected] of masked) {
    assert.equal(redactText(value), expected, value);
  }
  // Outside a temporary root the SAME name is an ordinary directory and is kept: a
  // repository may be called `dsh-abc123`, and masking it would break continuation for
  // a path nobody considers private. Case and digits are never a "secret id" signal.
  // A seven-character suffix is not a six-character profile key, even under a root.
  assert.equal(redactText('C:\\Temp\\profile-a1b2c3d\\x'), 'C:\\Temp\\profile-a1b2c3d\\x');
  // Outside a temporary root the SAME name is an ordinary directory and is kept: a
  // repository may be called `dsh-abc123`, and masking it would break continuation for
  // a path nobody considers private. Case and digits are never a "secret id" signal.
  const readable = [
    'E:\\repo\\dsh-abc123\\x',
    'E:\\repo\\dsh-SoexNz\\x',
    'E:\\repo\\profile-a1b2c3\\x',
    'E:\\project\\v2-tools\\src\\a.js',
    'E:\\project\\dsh-Bridge2\\x',
    'C:\\Temp\\dsh-development\\x',
    'C:\\Temp\\profile-settings\\x',
    'C:\\Temp\\dsh-delegate\\x',
    'C:\\Temp\\dsh-taskbridge\\x',
    'C:\\Temp\\dsh-1.4.2-test.1\\x',
    'C:\\Temp\\dsh-mask-user-profile-segment\\x', // the placeholder itself
  ];
  for (const value of readable) {
    assert.equal(redactText(value), value, value);
  }
});

test('R1: redaction is idempotent, so a re-projection never rewrites the placeholder again', () => {
  const once = redactText(join(TEMP_PROFILE, 'work'));
  assert.equal(redactText(once), once);
  // And a real directory whose name merely CONTAINS the placeholder is still its own
  // directory: the mask test is for the whole segment.
  const lookalike = 'C:\\Temp\\not-masks-user-profile-segment\\work';
  assert.equal(recordedPathIsMasked(lookalike), false);
  assert.equal(recordedPathIsMasked(join('C:\\Temp', PATH_MASK_SEGMENT, 'work')), true);
});

test('R1: a projected job record shortens only the account identity it must', async () => {
  const root = await makeTempDir();
  const outside = await mkdir(join(root, 'repo'), { recursive: true }).then(() => join(root, 'repo'));
  // `makeTempDir` builds `<platform temp>/dsh-delegate-test-XXXX`. This session runs
  // under a platform temp root that is itself an id-shaped profile directory
  // (`…/Temp/dsh-VG1MVl`), which redaction MUST still shorten — and the ordinary
  // repository segment it contains must survive verbatim. So the expectation is
  // derived from the real rule, not from a hard-coded assumption about the host.
  const projected = redactDeep({
    sourcePath: outside,
    executionWorkspacePath: outside,
    probe: join(TEMP_PROFILE, 'work'),
  });
  assert.equal(projected.sourcePath, redactText(outside), 'projection applies exactly the text rule');
  // The last whole segment of the repository — its own name — is never touched.
  const segments = outside.split(/[\\/]/).filter(Boolean);
  const lastSegment = segments.at(-2) ?? '';
  assert.ok(lastSegment.startsWith('dsh-delegate-test-'), 'the fixture is this suite\'s own temp tree');
  assert.equal(projected.sourcePath.includes(lastSegment), true, 'the repository segment itself is preserved');
  assert.equal(redactText(projected.probe).includes(PATH_MASK_SEGMENT), true);
  // A path with no profile segment is returned unchanged, which is the acceptance case.
  assert.equal(redactText(join(WORKSPACE, 'src')), join(WORKSPACE, 'src'));
  assert.equal(redactDeep({ path: join(WORKSPACE, 'src') }).path, join(WORKSPACE, 'src'));
});

// ---------------------------------------------------------------------------
// 2. The verifiable identity saved beside a path
// ---------------------------------------------------------------------------

test('canonicalPath is one spelling for one directory, and refuses a masked value', () => {
  // The canonical key is the SAME rule the session layer uses (`sessionPathKey`): trim,
  // strip trailing separators, fold the whole path on Windows, keep case elsewhere.
  // It deliberately does NOT unify `/` with `\` or collapse `..`, because the layer that
  // reaches the Session does not, and a looser key would call two directories equal that
  // the harness treats as different.
  assert.equal(canonicalPath('E:\\deepseek workplace\\dsh-delegate\\'), canonicalPath('E:\\deepseek workplace\\dsh-delegate'));
  assert.equal(
    canonicalPath('E:\\DEEPSEEK WORKPLACE\\DSH-DELEGATE'),
    canonicalPath('E:\\deepseek workplace\\dsh-delegate'),
    'Windows folds case at every level',
  );
  // Two spellings the session layer ALSO treats as different stay different here.
  assert.notEqual(canonicalPath('E:/deepseek workplace/dsh-delegate'), canonicalPath('E:\\deepseek workplace\\dsh-delegate'));
  assert.equal(sameCanonicalPath('E:\\x', 'E:\\x\\'), true);
  assert.equal(sameCanonicalPath('E:\\x', 'E:\\y'), false);
  assert.equal(canonicalPath(''), null);
  assert.equal(canonicalPath('   '), null);
  assert.equal(canonicalPath(42), null);
  // A masked path is not a path: canonicalising it would invent a directory.
  assert.equal(canonicalPath(join('C:\\Temp', PATH_MASK_SEGMENT, 'work')), null);
});

test('the canonical key agrees with the session layer for every spelling', () => {
  // These two normalisers must not disagree: one decides what is written and compared
  // for a continuation, the other what the harness itself keys a Workspace by. A
  // disagreement would admit a thread in one check and refuse it in the next.
  const same = [
    ['E:\\repo', 'E:\\repo'],
    ['E:\\repo', 'E:\\repo\\'],
    ['E:\\repo', 'e:\\repo'],
    ['E:\\REPO', 'E:\\repo'],
    ['/x/Repo', '/x/Repo'],
  ];
  for (const [a, b] of same) {
    assert.equal(sameCanonicalPath(a, b), sameSessionPath(a, b), `${a} vs ${b}`);
    assert.equal(sameCanonicalPath(a, b), true, `${a} vs ${b} must be one directory`);
  }
  // One platform-dependent expectation, derived from the rule rather than hard-coded:
  // POSIX keeps case (two really different directories), Windows folds it.
  const caseFolds = process.platform === 'win32';
  const different = [
    ['E:\\repo', 'E:\\repo2'],
    ['E:\\repo\\a', 'E:\\repo\\b'],
  ];
  for (const [a, b] of different) {
    assert.equal(sameCanonicalPath(a, b), sameSessionPath(a, b), `${a} vs ${b}`);
    assert.equal(sameCanonicalPath(a, b), false, `${a} vs ${b} must not be one directory`);
  }
  // Case-only difference follows the platform, and BOTH normalisers must agree on it.
  assert.equal(sameCanonicalPath('/x/a', '/x/A'), sameSessionPath('/x/a', '/x/A'));
  assert.equal(sameCanonicalPath('/x/a', '/x/A'), caseFolds, 'POSIX distinguishes case; Windows does not');
});

test('a digest is well formed, stable and detects a different directory', () => {
  const digest = pathDigest(WORKSPACE);
  assert.ok(isPathDigest(digest));
  assert.equal(digest, pathDigest(join(WORKSPACE, '.')));
  assert.equal(pathDigest(WORKSPACE), pathDigest(`${WORKSPACE}\\`));
  assert.notEqual(digest, pathDigest(PACKAGE));
  assert.notEqual(digest, pathDigest(`${WORKSPACE}2`));
  assert.equal(pathDigest(join('C:\\Temp', PATH_MASK_SEGMENT)), null);
  assert.equal(isPathDigest('sha256:nope'), false);
  assert.equal(isPathDigest(digest.toUpperCase()), false, 'the digest is lower-case hex');
});

test('the identity saved for a task keeps the REAL spelling and adds the digests', () => {
  const identity = continuationIdentityOf(
    { taskId: 'task-1', sourcePath: 'e:/repo/', executionPath: 'E:\\repo' },
    { workspaceId: 'ws-1', sessionId: 'session-1' },
    'shared',
  );
  assert.ok(identity !== null);
  assert.equal(identity.taskId, 'task-1');
  // The stored path is what an operator and the runtime can USE: never a comparison
  // key. A lower-cased key here would look like success and fail at the first real read.
  assert.equal(identity.sourcePath, 'e:/repo/');
  assert.equal(identity.executionPath, 'E:\\repo');
  // The two stored spellings really are different keys on Windows (slash direction is
  // not unified, exactly as the session layer does not unify it), so their digests
  // differ. The identity still records both faithfully.
  assert.equal(identity.sourcePathDigest, pathDigest('e:/repo/'));
  assert.equal(identity.executionPathDigest, pathDigest('E:\\repo'));
  if (process.platform !== 'win32') {
    assert.notEqual(identity.sourcePathDigest, identity.executionPathDigest);
  }
  assert.equal(identity.workspaceId, 'ws-1');
  assert.equal(identity.sessionId, 'session-1');
  assert.equal(identity.isolation, 'shared');
  // A masked path is not stored as a usable directory.
  const masked = continuationIdentityOf(
    { taskId: 'task-2', sourcePath: join('C:\\Temp', PATH_MASK_SEGMENT), executionPath: 'E:\\repo' },
    {},
    'shared',
  );
  assert.equal(masked.sourcePath, null, 'a mask is never written as a path');
  assert.equal(masked.sourcePathDigest, null);
  // No content: identity only.
  for (const forbidden of ['prompt', 'text', 'transcript', 'output', 'usage']) {
    assert.equal(forbidden in identity, false, forbidden);
  }
  // A task with no id names nothing and is not written.
  assert.equal(continuationIdentityOf({ taskId: '' }, {}, 'shared'), null);
});

test('a stored digest lets a SHORTENED path prove the directory it named', () => {
  const masked = join('C:\\Users\\24615\\AppData\\Local\\Temp', PATH_MASK_SEGMENT, 'work', 'repo');
  const digest = pathDigest('C:\\Users\\24615\\AppData\\Local\\Temp\\dsh-SoexNz\\work\\repo');
  assert.equal(recordedPathIsMasked(masked), true);
  assert.equal(readPathIdentity(masked, null).digest, null, 'a mask with no digest proves nothing');
  assert.equal(readPathIdentity(masked, digest).digest, digest);
  assert.equal(
    recordedDirectoryIs({ path: masked, digest }, 'C:\\Users\\24615\\AppData\\Local\\Temp\\dsh-SoexNz\\work\\repo'),
    true,
  );
  // …and proves a DIFFERENT directory does not match.
  assert.equal(recordedDirectoryIs({ path: masked, digest }, 'C:\\Users\\24615\\AppData\\Local\\Temp\\dsh-Other\\work\\repo'), false);
});

test('a mask with no digest and a missing path are refused alike, never read as a match', () => {
  const masked = join('C:\\Temp', PATH_MASK_SEGMENT, 'work');
  assert.equal(sameRecordedDirectory({ path: masked }, { path: masked }), false, 'a mask never equals itself');
  assert.equal(sameRecordedDirectory({ path: masked }, { path: 'C:\\Temp\\x' }), false);
  assert.equal(sameRecordedDirectory({ path: null }, { path: null }), false, 'absence is not equality');
  assert.equal(sameRecordedDirectory({ path: null, digest: null }, { path: null, digest: null }), false);
  // Two readable paths are compared exactly (the canonical rule: Windows folds case at
  // every level, POSIX does not).
  assert.equal(sameRecordedDirectory({ path: 'E:\\a' }, { path: 'E:\\a\\' }), true);
  assert.equal(sameRecordedDirectory({ path: 'E:\\a' }, { path: 'e:\\a' }), process.platform === 'win32');
  assert.equal(sameRecordedDirectory({ path: 'E:\\a' }, { path: 'E:\\b' }), false);
});

test('two contradictions are refused: a bad digest beside a readable path, and two different digests', () => {
  const readable = { path: WORKSPACE, digest: pathDigest(WORKSPACE) };
  // The readable path is the primary proof, so a digest naming another directory is a
  // record that disagrees with itself and must not be preferred.
  assert.equal(sameRecordedDirectory(readable, { path: WORKSPACE, digest: pathDigest(PACKAGE) }), false);
  assert.equal(
    sameRecordedDirectory(
      { path: join('C:\\Temp', PATH_MASK_SEGMENT, 'a'), digest: pathDigest('C:\\Temp\\dsh-One\\a') },
      { path: join('C:\\Temp', PATH_MASK_SEGMENT, 'b'), digest: pathDigest('C:\\Temp\\dsh-Two\\b') },
    ),
    false,
  );
});

test('a real redacted record keeps a proof: projection shortens the path, the digest survives', () => {
  // End to end through the real projection: the two facts that travel are exactly the
  // digest (unchanged by redaction) and the shortened path.
  const real = 'C:\\Users\\24615\\AppData\\Local\\Temp\\dsh-SoexNz\\work\\repo';
  const record = redactDeep({ path: real, digest: pathDigest(real) });
  assert.equal(recordedPathIsMasked(record.path), true, 'the path really was shortened');
  assert.equal(record.digest, pathDigest(real), 'the digest is opaque to redaction');
  assert.equal(recordedDirectoryIs(record, real), true, 'the record still proves its directory');
});
