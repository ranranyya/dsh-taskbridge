import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { taskTitle } from '../src/jobs/title.js';
import { placeSession, ensureWorkspace } from '../src/runtime/session-placement.js';
import {
  runCodexAction,
  refreshKnownAgentTemplate,
  SKILL_DIR_NAME,
  SKILL_FILENAME,
  isExplicitlyMigratableScript,
  useDirectoryClassifier,
} from '../src/codex/installer.js';
import { fakeWorkspaceController, fakeSessionController } from './helpers/fakes.js';

test('titles use the task goal rather than an executor role and preserve Chinese content', () => {
  assert.equal(taskTitle(null, 'You are a delegated implementer.\n目标：制作潘德 G 版装备表\n范围：兵种与装备'), '制作潘德 G 版装备表');
  assert.equal(taskTitle('修复登录错误', 'other instructions'), '修复登录错误');
  assert.equal(taskTitle('', 'You are an executor.\nFix the login error'), 'Fix the login error');
  assert.equal(taskTitle('', 'You are an executor.\n## Goal\n修复授权界面'), '修复授权界面');
  assert.equal(Array.from(taskTitle('中'.repeat(70))).length, 48);
});

test('new workspaces get task titles, existing workspaces retain their name, duplicates get a short suffix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'taskbridge-names-'));
  const workspaces = fakeWorkspaceController();
  try {
    const first = await ensureWorkspace(workspaces, join(root, 'task-uuid-one'), '制作装备表', 'task-abc123');
    assert.equal(first.workspaceTitle, '制作装备表');
    const existing = await ensureWorkspace(workspaces, join(root, 'task-uuid-one'), 'another task', 'task-def456');
    assert.equal(existing.workspaceTitle, '制作装备表');
    assert.equal(workspaces.renames.length, 1);
    const second = await ensureWorkspace(workspaces, join(root, 'task-uuid-two'), '制作装备表', 'task-def456');
    assert.equal(second.workspaceTitle, '制作装备表 · def456');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('placement carries the title into the native workspace for worktree runs, and keeps project name for shared runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'taskbridge-placement-'));
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({ workspaces });
  try {
    const worktreePlaced = await placeSession(
      { workspaces, sessionController },
      { path: join(root, 'wt-1'), title: '修复授权界面', taskId: 'task-123456', isolation: 'worktree' },
    );
    assert.equal(worktreePlaced.workspaceTitle, '修复授权界面');
    assert.equal(workspaces.renames.length, 1);
    assert.equal(workspaces.renames[0].workspaceId, worktreePlaced.workspaceId);

    const sharedPlaced = await placeSession(
      { workspaces, sessionController },
      { path: join(root, 'repo-shared'), title: '单次共享任务标题', taskId: 'task-789012', isolation: 'shared' },
    );
    assert.equal(sharedPlaced.workspaceTitle, 'repo-shared');
    assert.equal(workspaces.renames.length, 1, 'shared-mode runs must not overwrite a newly created project workspace name');
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const action of ['install', 'startup']) test(`${action} migrates the actual published legacy agent into the native skill without leaving duplicate files`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'taskbridge-agent-'));
  const legacy = join(home, 'agents', 'dsh-delegate.toml');
  const current = join(home, 'skills', SKILL_DIR_NAME, SKILL_FILENAME);
  const published = await readFile(new URL('./fixtures/codex-agent-1.3.1.toml', import.meta.url));
  const env = { CODEX_HOME: home, DSH_HOME: home };
  // The boundary check asks Windows for `ReparsePoint` through one PowerShell child, and
  // this carrier cannot spawn children at all (EPERM). The seam answers the real question
  // — "is this a plain directory?" — from Node, so the migration path is exercised
  // instead of being refused as `boundary-unverified`.
  const restoreClassifier = useDirectoryClassifier(async (paths) => new Map(paths.map((path) => [path, 'directory'])));
  try {
    await mkdir(join(home, 'agents'));
    await writeFile(legacy, published);
    const options = { codexHome: home, env, version: '1.9.0' };
    const result = action === 'startup' ? await refreshKnownAgentTemplate(options) : await runCodexAction('install', options);
    assert.equal(result.status.agent.state, 'installed');
    assert.match(await readFile(current, 'utf8'), /^name:\s*dsh-taskbridge$/mu);
    await assert.rejects(access(legacy), { code: 'ENOENT' });
    if (action === 'startup') await assert.rejects(access(join(home, 'config.toml')), { code: 'ENOENT' });
    assert.deepEqual((await refreshKnownAgentTemplate(options)).changed, []);
  } finally {
    restoreClassifier();
    await rm(home, { recursive: true, force: true });
  }
});

test('an edited old agent is preserved without creating a skill, and an occupied custom skill is preserved while untouched legacy is retired', async () => {
  const home = await mkdtemp(join(tmpdir(), 'taskbridge-custom-'));
  const legacy = join(home, 'agents', 'dsh-delegate.toml');
  const current = join(home, 'skills', SKILL_DIR_NAME, SKILL_FILENAME);
  const restoreClassifier = useDirectoryClassifier(async (paths) => new Map(paths.map((path) => [path, 'directory'])));
  try {
    await mkdir(join(home, 'agents'));
    const published = await readFile(new URL('./fixtures/codex-agent-1.3.1.toml', import.meta.url), 'utf8');
    await writeFile(legacy, published + '\n# my edit\n');
    const options = { codexHome: home, env: { CODEX_HOME: home, DSH_HOME: home }, version: '1.9.0' };
    assert.deepEqual((await refreshKnownAgentTemplate(options)).changed, []);
    await assert.rejects(access(current), { code: 'ENOENT' });
    assert.equal(await readFile(legacy, 'utf8'), published + '\n# my edit\n');
    await mkdir(join(home, 'skills', SKILL_DIR_NAME), { recursive: true });
    await writeFile(legacy, published);
    await writeFile(current, '---\nname: my-taskbridge\n---\ncustom skill\n');
    await refreshKnownAgentTemplate(options);
    assert.equal(await readFile(current, 'utf8'), '---\nname: my-taskbridge\n---\ncustom skill\n');
    await assert.rejects(access(legacy), { code: 'ENOENT' });
  } finally {
    restoreClassifier();
    await rm(home, { recursive: true, force: true });
  }
});

test('explicit MCP migration accepts an uninstalled legacy sibling and rejects other locations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'taskbridge-removed-'));
  const modules = join(root, 'node_modules');
  const installed = join(modules, 'dsh-taskbridge', 'bin', 'dsh-delegate-mcp.js');
  try {
    await mkdir(join(modules, 'dsh-taskbridge', 'bin'), { recursive: true });
    assert.equal(await isExplicitlyMigratableScript(join(modules, 'dsh-delegate', 'bin', 'dsh-delegate-mcp.js'), installed), true);
    assert.equal(await isExplicitlyMigratableScript(join(root, 'elsewhere', 'dsh-delegate', 'bin', 'dsh-delegate-mcp.js'), installed), false);
    assert.equal(await isExplicitlyMigratableScript(join(modules, 'custom-wrapper', 'bin', 'dsh-delegate-mcp.js'), installed), false);
    await mkdir(join(modules, 'dsh-delegate'));
    assert.equal(await isExplicitlyMigratableScript(join(modules, 'dsh-delegate', 'bin', 'dsh-delegate-mcp.js'), installed), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
