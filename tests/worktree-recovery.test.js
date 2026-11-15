import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { WorktreeManager, WORKTREE_CODES } from '../src/workspace/worktrees.js';
import { createGitRunner } from '../src/workspace/audit.js';
import { makeTempDir, cleanup } from './helpers/fakes.js';

async function fixture() {
  const root = await makeTempDir();
  const sourcePath = await realpath(await mkdir(join(root, 'source'), { recursive: true }).then(() => join(root, 'source')));
  const calls = [];
  const git = createGitRunner({ timeoutMs: 20000 });
  const runGit = async (cwd, args) => { calls.push({ cwd, args }); return await git(cwd, args); };
  const exec = async (cwd, args) => {
    const result = await runGit(cwd, args);
    assert.equal(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`);
  };
  await exec(sourcePath, ['init', '-q', '.']);
  await writeFile(join(sourcePath, 'README.md'), '# fixture\n');
  await exec(sourcePath, ['add', 'README.md']);
  await exec(sourcePath, ['-c', 'user.name=TaskBridge test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  const rootDir = join(root, 'trees');
  const manager = new WorktreeManager({ runGit }, { rootDir });
  const prepared = await manager.prepare({ taskId: 'task-original', sourcePath });
  manager.markComplete(prepared.workspacePath);
  const identity = { taskId: prepared.taskId, sourcePath, workspacePath: prepared.workspacePath,
    state: 'awaiting-host-review' };
  const reboot = () => new WorktreeManager({ runGit }, { rootDir });
  return { root, sourcePath, prepared, identity, reboot, exec, calls };
}

test('recovery verifies a dirty original tree using only read-only Git commands', async () => {
  const h = await fixture();
  try {
    await writeFile(join(h.prepared.workspacePath, 'candidate.txt'), 'keep me\n');
    await writeFile(join(h.sourcePath, 'source-note.txt'), 'keep source\n');
    const manager = h.reboot();
    const offset = h.calls.length;
    const recovered = await manager.recover(h.identity);
    assert.equal(recovered.workspacePath, h.prepared.workspacePath);
    assert.equal(recovered.taskId, h.prepared.taskId);
    assert.equal(recovered.isolated, true);
    assert.equal(recovered.detached, true);
    assert.equal(recovered.sourcePreexistingChanges, null);
    assert.equal(await readFile(join(recovered.workspacePath, 'candidate.txt'), 'utf8'), 'keep me\n');
    assert.equal(await readFile(join(h.sourcePath, 'source-note.txt'), 'utf8'), 'keep source\n');
    assert.ok(h.calls.slice(offset).every(({ args }) => args[0] === 'rev-parse'
      || args.join(' ') === 'worktree list --porcelain -z'));
    assert.deepEqual(manager.get(recovered.workspacePath), recovered);
  } finally { await cleanup(h.root); }
});

test('recovery refuses a missing original registration without substituting a tree', async () => {
  const h = await fixture();
  try {
    await h.exec(h.sourcePath, ['worktree', 'remove', '--force', h.prepared.workspacePath]);
    await mkdir(h.prepared.workspacePath);
    const manager = h.reboot();
    const offset = h.calls.length;
    await assert.rejects(() => manager.recover(h.identity), { code: WORKTREE_CODES.unknownTree });
    assert.deepEqual(manager.list(), []);
    assert.equal(h.calls.slice(offset).some(({ args }) => args[0] === 'worktree' && args[1] === 'add'), false);
  } finally { await cleanup(h.root); }
});

test('recovery refuses a branch checkout and an unrelated source repository', async () => {
  const h = await fixture();
  try {
    await h.exec(h.prepared.workspacePath, ['checkout', '-qb', 'fixture-child']);
    await assert.rejects(() => h.reboot().recover(h.identity), { code: WORKTREE_CODES.unknownTree });
    await h.exec(h.prepared.workspacePath, ['checkout', '--detach', '-q']);
    const outsider = join(h.root, 'outsider');
    await mkdir(outsider);
    await h.exec(outsider, ['init', '-q', '.']);
    await assert.rejects(() => h.reboot().recover({ ...h.identity, sourcePath: outsider }),
      { code: WORKTREE_CODES.unknownTree });
  } finally { await cleanup(h.root); }
});

test('recovery refuses disposed or mismatched task identities and honours cancellation', async () => {
  const h = await fixture();
  try {
    for (const change of [{ state: 'disposed' }, { taskId: 'task-elsewhere' }, { workspacePath: h.sourcePath }]) {
      const manager = h.reboot();
      await assert.rejects(() => manager.recover({ ...h.identity, ...change }), { code: WORKTREE_CODES.unknownTree });
      assert.deepEqual(manager.list(), []);
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => h.reboot().recover({ ...h.identity, signal: controller.signal }),
      { code: WORKTREE_CODES.cancelled });
  } finally { await cleanup(h.root); }
});
