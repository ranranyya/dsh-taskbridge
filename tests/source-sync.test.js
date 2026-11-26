// Post-acceptance worktree-to-source synchronization (`delegate_review({ applyToSource: true })`).
//
// Exercises REAL Git repositories and detached Git worktrees through both `syncWorktreeToSource`
// directly and the full MCP -> HTTP Execution Plane -> JobEngine -> HistoryStore stack.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { syncWorktreeToSource, SOURCE_SYNC_REASONS } from '../src/workspace/sync-source.js';
import { createGitRunner } from '../src/workspace/audit.js';
import { LOCK_MODES, WorkspaceLocks } from '../src/workspace/locks.js';
import { WorktreeManager } from '../src/workspace/worktrees.js';
import { JobEngine, TASK_STATES } from '../src/jobs/engine.js';
import { HistoryStore } from '../src/jobs/history.js';
import { SessionStore } from '../src/runtime/session-placement.js';
import { SettingsService } from '../src/config/settings.js';
import { AuthorizationRegistry } from '../src/auth/grants.js';
import { createExecutionHandler } from '../src/http/execution-plane.js';
import { createMcpServer } from '../src/mcp/server.js';
import { mockRequest, mockResponse } from './helpers/node-http-mocks.js';
import {
  cleanup,
  fakeAgentPresets,
  fakeAgents,
  fakeLlm,
  fakeSessionController,
  fakeToolRegistry,
  fakeWorkspaceController,
  makeTempDir,
  nativePolicyServices,
  validSettings,
} from './helpers/fakes.js';

const lf = (text) => text.replace(/\r\n/gu, '\n');

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function initRepoWithWorktree() {
  const root = await makeTempDir('dsh-sync-');
  const sourcePath = join(root, 'source');
  const execPath = join(root, 'wt');
  await mkdir(join(sourcePath, 'src', 'old-dir'), { recursive: true });
  await mkdir(join(sourcePath, 'assets'), { recursive: true });
  await writeFile(join(sourcePath, 'README.md'), '# Project\nOriginal readme.\n', 'utf8');
  await writeFile(join(sourcePath, 'src', 'a.js'), 'export const value = 1;\n', 'utf8');
  await writeFile(join(sourcePath, 'src', 'remove-me.js'), 'export const obsolete = true;\n', 'utf8');
  await writeFile(join(sourcePath, 'src', 'old-dir', 'rename-me.js'), 'export const legacy = 1;\n', 'utf8');
  await writeFile(join(sourcePath, 'assets', 'logo.bin'), Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]));

  git(sourcePath, ['init', '-b', 'main']);
  git(sourcePath, ['config', 'user.email', 'test@example.com']);
  git(sourcePath, ['config', 'user.name', 'Test User']);
  git(sourcePath, ['add', '.']);
  git(sourcePath, ['commit', '-m', 'initial commit']);

  const baseHead = git(sourcePath, ['rev-parse', 'HEAD']).trim();
  git(sourcePath, ['worktree', 'add', '--detach', execPath, baseHead]);
  return {
    root,
    sourcePath: await realpath(sourcePath),
    execPath: await realpath(execPath),
    baseHead,
    async close() {
      try { git(sourcePath, ['worktree', 'remove', '--force', execPath]); } catch { /* ignore */ }
      await cleanup(root);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Direct `syncWorktreeToSource` guarantees on real Git repositories
// ---------------------------------------------------------------------------

test('syncWorktreeToSource applies modify, delete, rename, binary, staged-new and untracked files without committing, and replays idempotently', async () => {
  const repo = await initRepoWithWorktree();
  const locks = new WorkspaceLocks();
  try {
    // Modify tracked text, delete tracked, rename+edit tracked, modify binary, stage+edit new file, add untracked text & binary.
    await writeFile(join(repo.execPath, 'src', 'a.js'), 'export const value = 42; // 中文验证\n', 'utf8');
    await unlink(join(repo.execPath, 'src', 'remove-me.js'));
    await mkdir(join(repo.execPath, 'src', 'new-dir'), { recursive: true });
    await writeFile(join(repo.execPath, 'src', 'new-dir', 'renamed.js'), 'export const modern = 2;\n', 'utf8');
    await unlink(join(repo.execPath, 'src', 'old-dir', 'rename-me.js'));
    const nextBin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    await writeFile(join(repo.execPath, 'assets', 'logo.bin'), nextBin);
    await writeFile(join(repo.execPath, 'src', 'staged.js'), 'export const staged = 1;\n', 'utf8');
    git(repo.execPath, ['add', 'src/staged.js']);
    await writeFile(join(repo.execPath, 'src', 'staged.js'), 'export const staged = 2;\n', 'utf8');
    await mkdir(join(repo.execPath, 'tests'), { recursive: true });
    await writeFile(join(repo.execPath, 'tests', 'new.test.js'), 'export const ok = true;\n', 'utf8');
    const untrackedBin = Buffer.from([0x00, 0x10, 0x20, 0xff, 0x00]);
    await writeFile(join(repo.execPath, 'assets', 'untracked.bin'), untrackedBin);

    const first = await syncWorktreeToSource({
      sourcePath: repo.sourcePath,
      executionPath: repo.execPath,
      baseHead: repo.baseHead,
      locks,
      taskId: 'task-sync-1',
    });
    assert.equal(first.applied, true);
    assert.equal(first.reason, SOURCE_SYNC_REASONS.synced);
    assert.deepEqual(first.conflictingPaths, []);
    assert.ok(first.changedFiles.includes('src/a.js'));
    assert.ok(first.changedFiles.includes('src/remove-me.js'));
    assert.ok(first.changedFiles.includes('src/staged.js'));
    assert.ok(first.changedFiles.includes('tests/new.test.js'));
    assert.ok(first.changedFiles.includes('assets/untracked.bin'));

    assert.equal(lf(await readFile(join(repo.sourcePath, 'src', 'a.js'), 'utf8')), 'export const value = 42; // 中文验证\n');
    assert.equal(existsSync(join(repo.sourcePath, 'src', 'remove-me.js')), false);
    assert.equal(existsSync(join(repo.sourcePath, 'src', 'old-dir', 'rename-me.js')), false);
    assert.equal(existsSync(join(repo.sourcePath, 'src', 'old-dir')), false, 'empty deleted parent dir is cleaned up');
    assert.equal(lf(await readFile(join(repo.sourcePath, 'src', 'new-dir', 'renamed.js'), 'utf8')), 'export const modern = 2;\n');
    assert.ok((await readFile(join(repo.sourcePath, 'assets', 'logo.bin'))).equals(nextBin));
    assert.equal(lf(await readFile(join(repo.sourcePath, 'src', 'staged.js'), 'utf8')), 'export const staged = 2;\n');
    assert.equal(lf(await readFile(join(repo.sourcePath, 'tests', 'new.test.js'), 'utf8')), 'export const ok = true;\n');
    assert.ok((await readFile(join(repo.sourcePath, 'assets', 'untracked.bin'))).equals(untrackedBin));

    // Must never stage or commit in sourcePath.
    assert.equal(git(repo.sourcePath, ['rev-parse', 'HEAD']).trim(), repo.baseHead);
    assert.equal(git(repo.sourcePath, ['diff', '--cached', '--name-only']).trim(), '');
    assert.equal(locks.isLocked(repo.sourcePath), false);
    assert.equal(locks.isLocked(repo.execPath), false);

    // Idempotent second call recognizes already-synced state.
    const replay = await syncWorktreeToSource({
      sourcePath: repo.sourcePath,
      executionPath: repo.execPath,
      baseHead: repo.baseHead,
      locks,
      taskId: 'task-sync-1',
    });
    assert.equal(replay.applied, true);
    assert.equal(replay.reason, SOURCE_SYNC_REASONS.alreadySynced);
    assert.deepEqual(replay.conflictingPaths, []);
  } finally {
    await repo.close();
  }
});

test('syncWorktreeToSource coexists with non-overlapping dirty edits in sourcePath', async () => {
  const repo = await initRepoWithWorktree();
  try {
    await writeFile(join(repo.sourcePath, 'README.md'), '# Project\nUser WIP draft.\n', 'utf8');
    await writeFile(join(repo.sourcePath, 'notes-wip.txt'), 'do not touch\n', 'utf8');
    await writeFile(join(repo.execPath, 'src', 'a.js'), 'export const value = 99;\n', 'utf8');
    await writeFile(join(repo.execPath, 'src', 'added.js'), 'export const added = true;\n', 'utf8');

    const res = await syncWorktreeToSource({
      sourcePath: repo.sourcePath,
      executionPath: repo.execPath,
      baseHead: repo.baseHead,
    });
    assert.equal(res.applied, true);
    assert.equal(res.reason, SOURCE_SYNC_REASONS.synced);
    assert.equal(lf(await readFile(join(repo.sourcePath, 'src', 'a.js'), 'utf8')), 'export const value = 99;\n');
    assert.equal(lf(await readFile(join(repo.sourcePath, 'src', 'added.js'), 'utf8')), 'export const added = true;\n');
    assert.equal(lf(await readFile(join(repo.sourcePath, 'README.md'), 'utf8')), '# Project\nUser WIP draft.\n');
    assert.equal(lf(await readFile(join(repo.sourcePath, 'notes-wip.txt'), 'utf8')), 'do not touch\n');
  } finally {
    await repo.close();
  }
});

test('syncWorktreeToSource refuses overlapping tracked or untracked conflicts with zero bytes modified', async () => {
  const repo = await initRepoWithWorktree();
  try {
    // Case A: tracked overlap on src/a.js while execPath also adds src/extra.js
    await writeFile(join(repo.sourcePath, 'src', 'a.js'), 'export const value = 777; // user edit\n', 'utf8');
    await writeFile(join(repo.execPath, 'src', 'a.js'), 'export const value = 888; // worker edit\n', 'utf8');
    await writeFile(join(repo.execPath, 'src', 'extra.js'), 'export const extra = 1;\n', 'utf8');

    const trackedConflict = await syncWorktreeToSource({
      sourcePath: repo.sourcePath,
      executionPath: repo.execPath,
      baseHead: repo.baseHead,
    });
    assert.equal(trackedConflict.applied, false);
    assert.equal(trackedConflict.reason, SOURCE_SYNC_REASONS.conflict);
    assert.deepEqual(trackedConflict.conflictingPaths, ['src/a.js']);
    assert.equal(await readFile(join(repo.sourcePath, 'src', 'a.js'), 'utf8'), 'export const value = 777; // user edit\n');
    assert.equal(existsSync(join(repo.sourcePath, 'src', 'extra.js')), false, 'zero bytes written on tracked conflict');

    // Case B: untracked collision on src/extra.js when tracked src/a.js is clean in sourcePath
    git(repo.sourcePath, ['checkout', '--', 'src/a.js']);
    await writeFile(join(repo.sourcePath, 'src', 'extra.js'), 'export const extra = "user";\n', 'utf8');

    const untrackedConflict = await syncWorktreeToSource({
      sourcePath: repo.sourcePath,
      executionPath: repo.execPath,
      baseHead: repo.baseHead,
    });
    assert.equal(untrackedConflict.applied, false);
    assert.equal(untrackedConflict.reason, SOURCE_SYNC_REASONS.conflict);
    assert.deepEqual(untrackedConflict.conflictingPaths, ['src/extra.js']);
    assert.equal(lf(await readFile(join(repo.sourcePath, 'src', 'a.js'), 'utf8')), 'export const value = 1;\n', 'tracked file untouched on untracked conflict');
    assert.equal(lf(await readFile(join(repo.sourcePath, 'src', 'extra.js'), 'utf8')), 'export const extra = "user";\n');
  } finally {
    await repo.close();
  }
});

test('syncWorktreeToSource refuses sensitive paths, git symlink mode 120000, HEAD drift, and busy locks', async () => {
  const repo = await initRepoWithWorktree();
  const locks = new WorkspaceLocks();
  try {
    // 1. Sensitive path refusal (.env.local) leaves non-sensitive changes unapplied.
    await writeFile(join(repo.execPath, 'src', 'a.js'), 'export const value = 10;\n', 'utf8');
    await writeFile(join(repo.execPath, '.env.local'), 'SECRET=1\n', 'utf8');
    const sensitive = await syncWorktreeToSource({
      sourcePath: repo.sourcePath,
      executionPath: repo.execPath,
      baseHead: repo.baseHead,
    });
    assert.equal(sensitive.applied, false);
    assert.equal(sensitive.reason, SOURCE_SYNC_REASONS.sensitivePathBlocked);
    assert.deepEqual(sensitive.conflictingPaths, ['.env.local']);
    assert.equal(lf(await readFile(join(repo.sourcePath, 'src', 'a.js'), 'utf8')), 'export const value = 1;\n');
    assert.equal(existsSync(join(repo.sourcePath, '.env.local')), false);
    await unlink(join(repo.execPath, '.env.local'));

    // 2. Git mode 120000 symlink refusal (cross-platform via index entry).
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repo.execPath,
      input: '../outside.txt',
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    git(repo.execPath, ['update-index', '--add', '--cacheinfo', `120000,${blob},evil-link`]);
    const symlinkRes = await syncWorktreeToSource({
      sourcePath: repo.sourcePath,
      executionPath: repo.execPath,
      baseHead: repo.baseHead,
    });
    assert.equal(symlinkRes.applied, false);
    assert.equal(symlinkRes.reason, SOURCE_SYNC_REASONS.unsafePath);
    assert.ok(symlinkRes.conflictingPaths.includes('evil-link'));
    assert.equal(lf(await readFile(join(repo.sourcePath, 'src', 'a.js'), 'utf8')), 'export const value = 1;\n');
    git(repo.execPath, ['rm', '--cached', '-f', 'evil-link']);

    // 3. Busy workspace lock refusal.
    const lease = locks.acquire(repo.sourcePath, { taskId: 'other-job', mode: LOCK_MODES.exclusive });
    try {
      const busy = await syncWorktreeToSource({
        sourcePath: repo.sourcePath,
        executionPath: repo.execPath,
        baseHead: repo.baseHead,
        locks,
      });
      assert.equal(busy.applied, false);
      assert.equal(busy.reason, SOURCE_SYNC_REASONS.workspaceBusy);
    } finally {
      locks.release(lease.workspacePath, lease.nonce);
    }

    // 4. Source HEAD drift refusal.
    await writeFile(join(repo.sourcePath, 'README.md'), '# Moved HEAD\n', 'utf8');
    git(repo.sourcePath, ['add', 'README.md']);
    git(repo.sourcePath, ['commit', '-m', 'user moved head']);
    const drifted = await syncWorktreeToSource({
      sourcePath: repo.sourcePath,
      executionPath: repo.execPath,
      baseHead: repo.baseHead,
    });
    assert.equal(drifted.applied, false);
    assert.equal(drifted.reason, SOURCE_SYNC_REASONS.sourceHeadChanged);
    assert.equal(lf(await readFile(join(repo.sourcePath, 'src', 'a.js'), 'utf8')), 'export const value = 1;\n');
  } finally {
    await repo.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Full-stack integration: MCP -> HTTP Execution Plane -> JobEngine -> Git worktree
// ---------------------------------------------------------------------------

async function createRealWorktreeHarness(onRun) {
  const dir = await makeTempDir('dsh-sync-e2e-');
  const dataDir = join(dir, 'data');
  await mkdir(dataDir, { recursive: true });
  const sourcePath = join(dir, 'repo');
  await mkdir(join(sourcePath, 'src'), { recursive: true });
  await writeFile(join(sourcePath, 'src', 'calc.js'), 'export const x = 1;\n', 'utf8');
  git(sourcePath, ['init', '-b', 'main']);
  git(sourcePath, ['config', 'user.email', 'test@example.com']);
  git(sourcePath, ['config', 'user.name', 'Test User']);
  git(sourcePath, ['add', '.']);
  git(sourcePath, ['commit', '-m', 'init']);
  const realSource = await realpath(sourcePath);

  const settings = new SettingsService(dataDir);
  await settings.replace(validSettings({ worker: { isolation: 'worktree', maxParallelism: 2 } }));
  const history = new HistoryStore(dataDir);
  const sessionStore = new SessionStore(dataDir);
  const runGit = createGitRunner();
  const worktrees = new WorktreeManager({ runGit }, { rootDir: join(dir, 'worktrees') });
  const workspaces = fakeWorkspaceController();
  const baseSessions = fakeSessionController({ workspaces });
  let runIndex = 0;
  const sessionController = {
    ...baseSessions,
    async resolveAgent(sessionId) {
      const resolved = await baseSessions.resolveAgent(sessionId);
      if (resolved.agent && !resolved.agent._syncWrapped) {
        resolved.agent._syncWrapped = true;
        const agent = resolved.agent;
        agent.followup = (message) => {
          agent.followups.push(message);
          agent.turns.push(message);
          agent.idle = false;
          const emit = (event) => {
            for (const entry of agent.listeners) {
              if (entry.event === 'session/event') entry.listener({ id: agent.session.id }, event);
            }
          };
          const cwd = baseSessions.sessions.get(sessionId)?.cwd ?? agent.session.header?.cwd;
          runIndex += 1;
          const currentRound = runIndex;
          Promise.resolve(typeof onRun === 'function' ? onRun({ workspacePath: cwd, runIndex: currentRound, prompt: message }) : undefined)
            .then(() => {
              emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `done round ${currentRound}` }] } } });
              emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
              agent.idle = true;
              for (const waiter of agent.idleWaiters.splice(0)) waiter();
            });
        };
      }
      return resolved;
    },
  };
  const services = await nativePolicyServices();
  const auth = new AuthorizationRegistry();
  const locks = new WorkspaceLocks();
  const llm = fakeLlm({ providers: { relay: { 'deepseek-chat': ['low', 'medium', 'high'] } } });
  const presets = fakeAgentPresets();
  const tools = fakeToolRegistry({ global: ['read'] });

  const buildEngine = (opts = {}) => new JobEngine({
    authorizationMode: 'switch',
    allowLegacyProviderRoutes: true,
    agents: fakeAgents({ respond: { text: 'unused' } }),
    agentPresets: presets,
    tools,
    sessions: { async flush() {} },
    workspaces,
    sessionController,
    sessionStore,
    worktrees,
    policyServices: () => services,
    llm,
    settings,
    auth,
    locks,
    runGit,
    history,
    delegationEnabled: opts.delegationEnabled ?? true,
    logger: { info() {}, warn() {} },
  });

  const engine = buildEngine();
  const handler = createExecutionHandler({
    engine,
    auth,
    settings,
    authorizationMode: 'switch',
    logger: { info() {}, warn() {} },
    getBindHost: () => '127.0.0.1',
  });
  const callExecution = async (route, payload) => {
    const pathMap = {
      status: ['GET', '/dsh-delegate/x/status'],
      submit: ['POST', '/dsh-delegate/x/tasks'],
      result: ['POST', '/dsh-delegate/x/tasks/get'],
      review: ['POST', '/dsh-delegate/x/tasks/review'],
    };
    const [method, url] = pathMap[route];
    const req = mockRequest({
      method,
      url,
      headers: {
        host: '127.0.0.1',
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      body: method === 'POST' ? JSON.stringify(payload) : undefined,
    });
    const res = mockResponse();
    await handler(req, res);
    return res.parsed();
  };
  const mcp = createMcpServer({ callExecution });
  await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  const callTool = async (name, args) => {
    const res = await mcp.handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name, arguments: args } });
    return { isError: res.result.isError === true, data: JSON.parse(res.result.content[0].text) };
  };

  async function settle(taskId) {
    for (let i = 0; i < 400; i += 1) {
      const view = engine.get(taskId);
      if (view.state !== TASK_STATES.pending && view.state !== TASK_STATES.running) return view;
      await new Promise((r) => setTimeout(r, 10));
    }
    return engine.get(taskId);
  }

  return {
    dir,
    sourcePath: realSource,
    engine,
    buildEngine,
    callTool,
    settle,
    async close() {
      await engine.dispose();
      await cleanup(dir);
    },
  };
}

test('multi-stage reuseWorktreeFromTaskId chain keeps source clean on intermediate accept and syncs full chain on final applyToSource: true', async () => {
  const h = await createRealWorktreeHarness(async ({ workspacePath, runIndex }) => {
    if (runIndex === 1) {
      await writeFile(join(workspacePath, 'src', 'stage1.js'), 'export const s1 = 1;\n', 'utf8');
    } else {
      await writeFile(join(workspacePath, 'src', 'stage2.js'), 'export const s2 = 2;\n', 'utf8');
      await writeFile(join(workspacePath, 'src', 'calc.js'), 'export const x = 2;\n', 'utf8');
    }
  });
  try {
    const t1 = await h.engine.start({ connectionId: 'local-mcp', workspacePath: h.sourcePath, prompt: 'stage 1' });
    const s1 = await h.settle(t1.taskId);
    assert.equal(s1.state, TASK_STATES.awaitingHostReview);

    // Intermediate subtask accepted WITHOUT applyToSource -> sourcePath stays clean.
    const r1 = await h.engine.recordHostReview({
      connectionId: 'local-mcp',
      taskId: t1.taskId,
      decision: 'accepted',
      note: 'stage 1 verified',
    });
    assert.equal(r1.sourceSync, undefined);
    assert.equal(existsSync(join(h.sourcePath, 'src', 'stage1.js')), false);

    // Stage 2 reuses Stage 1's isolated worktree.
    const t2 = await h.engine.start({
      connectionId: 'local-mcp',
      workspacePath: h.sourcePath,
      prompt: 'stage 2',
      reuseWorktreeFromTaskId: t1.taskId,
    });
    const s2 = await h.settle(t2.taskId);
    assert.equal(s2.state, TASK_STATES.awaitingHostReview);
    assert.equal(s2.executionWorkspacePath, s1.executionWorkspacePath);

    // Final stage accepted WITH applyToSource: true -> BOTH stages sync in one shot!
    const r2 = await h.engine.recordHostReview({
      connectionId: 'local-mcp',
      taskId: t2.taskId,
      decision: 'accepted',
      note: 'final stage verified',
      applyToSource: true,
    });
    assert.equal(r2.reviewPersistence.state, 'saved');
    assert.equal(r2.sourceSync.applied, true);
    assert.equal(r2.sourceSync.reason, SOURCE_SYNC_REASONS.synced);
    assert.equal(lf(await readFile(join(h.sourcePath, 'src', 'stage1.js'), 'utf8')), 'export const s1 = 1;\n');
    assert.equal(lf(await readFile(join(h.sourcePath, 'src', 'stage2.js'), 'utf8')), 'export const s2 = 2;\n');
    assert.equal(lf(await readFile(join(h.sourcePath, 'src', 'calc.js'), 'utf8')), 'export const x = 2;\n');
  } finally {
    await h.close();
  }
});

test('MCP delegate_review with receiptOnly + applyToSource returns sourceSync, keeps accepted durable on conflict, and gates disk writes on the master switch', async () => {
  const h = await createRealWorktreeHarness(async ({ workspacePath, runIndex }) => {
    await writeFile(join(workspacePath, 'src', 'calc.js'), `export const x = ${runIndex + 10};\n`, 'utf8');
  });
  try {
    // Task 1: clean sync over real MCP + HTTP execution plane with receiptOnly: true
    const sub1 = await h.callTool('delegate_submit', { workspacePath: h.sourcePath, prompt: 'round 1' });
    assert.equal(sub1.isError, false);
    const settled1 = await h.settle(sub1.data.task.taskId);
    assert.equal(settled1.state, TASK_STATES.awaitingHostReview);

    // changes-requested + applyToSource: true must be refused at MCP layer.
    const bad = await h.callTool('delegate_review', {
      taskId: sub1.data.task.taskId,
      decision: 'changes-requested',
      note: 'nope',
      applyToSource: true,
    });
    assert.equal(bad.isError, true);

    const rev1 = await h.callTool('delegate_review', {
      taskId: sub1.data.task.taskId,
      decision: 'accepted',
      note: 'verified',
      receiptOnly: true,
      applyToSource: true,
    });
    assert.equal(rev1.isError, false);
    assert.equal(rev1.data.reviewPersistence.state, 'saved');
    assert.equal(rev1.data.sourceSync.applied, true);
    assert.equal(rev1.data.sourceSync.reason, SOURCE_SYNC_REASONS.synced);
    assert.equal(lf(await readFile(join(h.sourcePath, 'src', 'calc.js'), 'utf8')), 'export const x = 11;\n');

    // Commit synced file so next task starts clean, then create a local conflict before review.
    git(h.sourcePath, ['add', 'src/calc.js']);
    git(h.sourcePath, ['commit', '-m', 'user committed round 1']);

    const sub2 = await h.callTool('delegate_submit', { workspacePath: h.sourcePath, prompt: 'round 2' });
    const settled2 = await h.settle(sub2.data.task.taskId);
    assert.equal(settled2.state, TASK_STATES.awaitingHostReview);
    await writeFile(join(h.sourcePath, 'src', 'calc.js'), 'export const x = 999; // local user conflict\n', 'utf8');

    const rev2 = await h.callTool('delegate_review', {
      taskId: sub2.data.task.taskId,
      decision: 'accepted',
      note: 'verified despite local edit',
      receiptOnly: true,
      applyToSource: true,
    });
    assert.equal(rev2.isError, false);
    assert.equal(rev2.data.reviewPersistence.state, 'saved');
    assert.equal(rev2.data.reviewPersistence.accepted, true);
    assert.equal(rev2.data.sourceSync.applied, false);
    assert.equal(rev2.data.sourceSync.reason, SOURCE_SYNC_REASONS.conflict);
    assert.deepEqual(rev2.data.sourceSync.conflictingPaths, ['src/calc.js']);
    assert.equal(await readFile(join(h.sourcePath, 'src', 'calc.js'), 'utf8'), 'export const x = 999; // local user conflict\n');

    // Task 3: switch turned off before review -> acceptance still persists, disk write is blocked.
    git(h.sourcePath, ['checkout', '--', 'src/calc.js']);
    const sub3 = await h.callTool('delegate_submit', { workspacePath: h.sourcePath, prompt: 'round 3' });
    const settled3 = await h.settle(sub3.data.task.taskId);
    assert.equal(settled3.state, TASK_STATES.awaitingHostReview);
    h.engine.setDelegationEnabled(false);

    const rev3 = await h.callTool('delegate_review', {
      taskId: sub3.data.task.taskId,
      decision: 'accepted',
      note: 'accepted after switch off',
      receiptOnly: true,
      applyToSource: true,
    });
    assert.equal(rev3.isError, false);
    assert.equal(rev3.data.reviewPersistence.state, 'saved');
    assert.equal(rev3.data.sourceSync.applied, false);
    assert.equal(rev3.data.sourceSync.reason, SOURCE_SYNC_REASONS.delegationDisabled);
    assert.equal(lf(await readFile(join(h.sourcePath, 'src', 'calc.js'), 'utf8')), 'export const x = 11;\n');
  } finally {
    await h.close();
  }
});

test('historical review after engine restart supports applyToSource: true and shared tasks report shared-in-place', async () => {
  const h = await createRealWorktreeHarness(async ({ workspacePath, runIndex }) => {
    await writeFile(join(workspacePath, 'src', `after-restart-${runIndex}.js`), `export const r = ${runIndex};\n`, 'utf8');
  });
  let restarted = null;
  try {
    // Worktree task finished before restart.
    const started = await h.engine.start({ connectionId: 'local-mcp', workspacePath: h.sourcePath, prompt: 'before restart' });
    const settled = await h.settle(started.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview);

    // Shared task on same sourcePath.
    const sharedStarted = await h.engine.start({
      connectionId: 'local-mcp',
      workspacePath: h.sourcePath,
      prompt: 'shared run',
      overrides: { isolation: 'shared' },
    });
    const sharedSettled = await h.settle(sharedStarted.taskId);
    assert.equal(sharedSettled.state, TASK_STATES.awaitingHostReview);
    const sharedRev = await h.engine.recordHostReview({
      connectionId: 'local-mcp',
      taskId: sharedStarted.taskId,
      decision: 'accepted',
      note: 'shared verified',
      applyToSource: true,
    });
    assert.equal(sharedRev.sourceSync.applied, true);
    assert.equal(sharedRev.sourceSync.reason, SOURCE_SYNC_REASONS.sharedInPlace);

    // New engine instance reviewing the historical worktree task from disk history.
    restarted = h.buildEngine({ delegationEnabled: true });
    const histRev = await restarted.recordHistoricalReview(
      { taskId: started.taskId, connectionId: 'local-mcp' },
      'accepted',
      'historical accepted',
      null,
      undefined,
      { applyToSource: true },
    );
    assert.equal(histRev.reviewPersistence.state, 'saved');
    assert.equal(histRev.sourceSync.applied, true);
    assert.equal(histRev.sourceSync.reason, SOURCE_SYNC_REASONS.synced);
    assert.equal(lf(await readFile(join(h.sourcePath, 'src', 'after-restart-1.js'), 'utf8')), 'export const r = 1;\n');
  } finally {
    if (restarted !== null) await restarted.dispose();
    await h.close();
  }
});
