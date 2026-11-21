// Concurrency across isolation modes: several delegated runs of ONE source
// repository, and the locks, slots and Git preparation they must (and must not)
// share.
//
// The bug these tests exist for: two ISOLATED submissions against one clean source
// were submitted at the same time, and the second was refused with
// `JOB_WORKSPACE_BUSY` even though the parallelism cap still had a free slot. The
// engine held the source directory exclusively for the whole run, so two runs that
// write to two different checkouts were serialised by a lock neither of them needed.
//
// What must hold now, and is asserted here from the engine's own records:
//  - two isolated runs of one source really reach the runner at the same time, in
//    DIFFERENT directories and with DIFFERENT sessions;
//  - the parallelism cap still refuses the third one, and its refusal is the cap,
//    not the workspace;
//  - two SHARED runs of one source still refuse each other;
//  - two continuations that drive the SAME tree are mutually exclusive;
//  - preparation is serialised inside one source but NOT across sources, and a
//    preparation that is cancelled, abandoned or settles late leaves no lease, no
//    slot and no phantom queue entry behind — and never lets a cancelled task start;
//  - an active execution lease never expires by wall clock, however long the run.
//
// Timing discipline: every test that needs to control preparation timing HOLDS the
// in-flight `engine.start()` promise and reads the task record for the id — it never
// awaits an admission that is waiting for a gate, which is what made earlier versions
// of this file hang for minutes. Every gate is released in `finally`.
//
// The Git worktree service is faked where deterministic timing is needed; the real
// manager's own contract is covered by tests/worktrees.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { AuthorizationRegistry } from '../src/auth/grants.js';
import { HistoryStore } from '../src/jobs/history.js';
import { JobEngine, JOB_CODES, TASK_STATES } from '../src/jobs/engine.js';
import { SettingsService } from '../src/config/settings.js';
import { SessionStore } from '../src/runtime/session-placement.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import {
  cleanup,
  fakeAgents,
  fakeLlm,
  fakeSessionController,
  fakeWorkspaceController,
  llmTable,
  makeTempDir,
  nativePolicyServices,
  validSettings,
} from './helpers/fakes.js';

/** The pinned commit every fake tree reports. */
const HEAD = 'a'.repeat(40);

/** Public provider profile id → native route id (the two ids must differ). */
const NATIVE_ROUTES = Object.freeze({ relay: 'relay-native' });

/** Terminal task states. */
const TERMINAL = new Set([TASK_STATES.awaitingHostReview, TASK_STATES.failed, TASK_STATES.cancelled]);

/**
 * A git runner answering in the NUL-delimited shapes the audit layer parses.
 * @returns {object} runner with `calls` history.
 */
function auditGit() {
  const calls = [];
  const runner = async (cwd, args) => {
    calls.push({ cwd, args });
    const key = args.join(' ');
    if (key === '--version') return { stdout: 'git version 2.54.0\n', code: 0 };
    if (key === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', code: 0 };
    if (key === 'rev-parse --verify HEAD') return { stdout: `${HEAD}\n`, code: 0 };
    if (key === 'rev-parse --show-toplevel') return { stdout: `${cwd}\n`, code: 0 };
    if (args[0] === 'status') return { stdout: ' M src/a.js\u0000', code: 0 };
    if (args[0] === 'diff' && args[1] === '--numstat') return { stdout: '2\t0\tsrc/a.js\u0000', code: 0 };
    if (args[0] === 'diff') return { stdout: 'diff --git a/src/a.js b/src/a.js\n+implementation\n', code: 0 };
    if (args[0] === 'ls-files') return { stdout: '', code: 0 };
    return { stdout: '', code: 0 };
  };
  runner.calls = calls;
  return runner;
}

/**
 * A worktree service that records every call and hands out a distinct directory.
 *
 * `prepare` really creates its directory (the engine resolves the execution path
 * before auditing it), and `options.gate(request, index)` is awaited INSIDE it. A test
 * that gates holds the start promise and opens the gate when it decides to.
 *
 * `options.interruptible` models the two kinds of Git work a caller can be waiting on:
 *  - `false` (the default, and what `git worktree add` really is once it has spawned)
 *    — the call runs to completion no matter what happens to the caller, so the source
 *    must stay protected until it answers;
 *  - `true` — the call checks `request.signal` and refuses with `WORKTREE_CANCELLED`,
 *    which is what the real manager does for the steps it can still skip.
 * @param {object} [options] - `gate`, `fail`, `interruptible`.
 * @returns {object} service with `prepares`, `completes`, `trees`.
 */
function fakeWorktrees(options = {}) {
  const prepares = [];
  const completes = [];
  const trees = new Map();
  const cancelled = () => Object.assign(new Error('the worktree was cancelled before the run could start'), {
    code: 'WORKTREE_CANCELLED',
  });
  const service = {
    prepares,
    completes,
    trees,
    async prepare(request) {
      const index = prepares.length + 1;
      prepares.push({ taskId: request.taskId, sourcePath: request.sourcePath, at: Date.now() });
      if (options.interruptible === true && request.signal?.aborted === true) throw cancelled();
      if (typeof options.gate === 'function') await options.gate(request, index);
      if (options.interruptible === true && request.signal?.aborted === true) throw cancelled();
      if (options.fail !== undefined) throw options.fail;
      const base = request.sourcePath;
      const target = join(base, '..', `tree-${index}`);
      const workspacePath = await realpath(await mkdir(target, { recursive: true }).then(() => target));
      const view = {
        taskId: request.taskId,
        workspacePath,
        sourcePath: base,
        baseHead: HEAD,
        isolated: true,
        detached: true,
        state: 'active',
        createdAt: Date.now(),
        completedAt: null,
      };
      trees.set(workspacePath.toLowerCase(), view);
      return view;
    },
    markComplete(workspacePath) {
      const view = trees.get(String(workspacePath).toLowerCase());
      if (view === undefined) {
        throw Object.assign(new Error('no such managed worktree'), { code: 'WORKTREE_UNKNOWN_TREE' });
      }
      view.state = 'awaiting-host-review';
      completes.push(workspacePath);
      return { ...view };
    },
    get(workspacePath) {
      return trees.get(String(workspacePath).toLowerCase()) ?? null;
    },
  };
  return service;
}

/**
 * A gate that a test opens deliberately.
 * @returns {{ wait: (index: number) => Promise<void>, open: (index?: number) => void, opened: number[] }}
 */
function gate() {
  const waiters = new Map();
  const opened = [];
  return {
    opened,
    wait(index) {
      if (opened.includes(index)) return Promise.resolve();
      return new Promise((resolvePromise) => {
        const list = waiters.get(index) ?? [];
        list.push(resolvePromise);
        waiters.set(index, list);
      });
    },
    open(index) {
      const targets = index === undefined ? [...waiters.keys()] : [index];
      for (const target of targets) {
        opened.push(target);
        for (const resolvePromise of waiters.get(target) ?? []) resolvePromise();
        waiters.delete(target);
      }
    },
    get pending() {
      return [...waiters.keys()];
    },
  };
}

/**
 * A session controller whose every resolved agent stays busy until it is cancelled.
 *
 * A placed run drives a RESOLVED agent, so "still working" has to be modelled on the
 * conversation the run actually drives. This keeps an admitted run alive so a test can
 * observe a second submission while the first holds its directory.
 * @returns {object} fake session controller.
 */
function blockingSessionController() {
  const workspaces = fakeWorkspaceController();
  const controller = fakeSessionController({ workspaces });
  const resolveOriginal = controller.resolveAgent.bind(controller);
  controller.entered = [];
  controller.resolveAgent = async (sessionId) => {
    const found = await resolveOriginal(sessionId);
    const agent = found.agent;
    if (agent !== undefined) {
      controller.entered.push({ sessionId, at: Date.now() });
      agent.followup = (message) => {
        agent.followups.push(message);
        // A turn that never ends: nothing but the runner's cancel settles it.
        agent.idle = false;
      };
      agent.cancel = (cause) => {
        agent.cancels.push({ cause });
        agent.idle = true;
        for (const waiter of agent.idleWaiters.splice(0)) waiter();
      };
      agent.whenIdle = async () => {
        if (agent.idle) return;
        await new Promise((resolvePromise) => { agent.idleWaiters.push(resolvePromise); });
      };
    }
    return found;
  };
  controller.boundWorkspaces = workspaces;
  return controller;
}

/**
 * A session controller whose agents finish immediately, so a run settles at once.
 * @returns {object} fake session controller.
 */
function idleSessionController() {
  const workspaces = fakeWorkspaceController();
  const controller = fakeSessionController({ workspaces, respond: { text: 'implemented the change' } });
  controller.boundWorkspaces = workspaces;
  return controller;
}

/**
 * Build an engine over temporary storage and a real source directory.
 * @param {object} [options] - `settings`, `worktrees`, `git`, `sessionController`,
 *   `locks`, `preflightTimeoutMs`, `now`.
 * @returns {Promise<object>} harness.
 */
async function harness(options = {}) {
  const dir = await makeTempDir();
  const workspace = await realpath(
    await mkdir(join(dir, 'workspace'), { recursive: true }).then(() => join(dir, 'workspace')),
  );
  const settings = new SettingsService(join(dir, 'data'));
  await settings.replace(options.settings ?? validSettings());
  const auth = new AuthorizationRegistry();
  const locks = options.locks ?? new WorkspaceLocks(options.now === undefined ? {} : { now: options.now });
  const agents = fakeAgents({ respond: { text: 'implemented the change' } });
  // A host that HAS the DSH Agent Teams service. A continuation inherits `false` from
  // its chain, and from 1.6.1 an inherited or explicit choice that cannot be applied is
  // REFUSED before the prompt — so a harness without the service would fail every
  // follow-up for a reason this file is not about.
  const policyServices = await nativePolicyServices({
    agentTeams: {
      async setEnabled() {},
      isEnabled() { return false; },
    },
  });
  // The SESSION controller resolves its Workspaces against ONE registry, so the
  // engine's Workspace controller must be that same registry or a placed run is
  // refused with `SESSION_CREATE_FAILED`/`workspace/not-found`.
  const sessionController = options.sessionController ?? idleSessionController();
  const workspaces = sessionController.boundWorkspaces ?? fakeWorkspaceController();
  // A follow-up is judged from two durable documents: the task-to-conversation
  // identity map and the job history row. Both live under the data directory.
  const sessionStore = new SessionStore(join(dir, 'data'));
  const history = new HistoryStore(join(dir, 'data'));
  const engine = new JobEngine({
    agents,
    agentPresets: {
      async mount(ctx, id) {
        ctx.tools.schemas = () => [
          { name: 'read', description: 'read', parameters: {} },
          { name: 'glob', description: 'glob', parameters: {} },
          { name: 'grep', description: 'grep', parameters: {} },
          { name: 'read_image', description: 'read_image', parameters: {} },
        ];
        return { id: id ?? 'default-preset' };
      },
    },
    sessions: { async flush() {} },
    workspaces,
    sessionController,
    policyServices: () => policyServices,
    llm: fakeLlm({ providers: { 'relay-native': llmTable().relay } }),
    settings,
    auth,
    locks,
    runGit: options.git ?? auditGit(),
    providerRegistry: {
      async ensure(providers) {
        const routes = new Map();
        for (const provider of providers) routes.set(provider.id, NATIVE_ROUTES[provider.id] ?? `${provider.id}-native`);
        return { routes };
      },
    },
    ...(options.worktrees === undefined ? {} : { worktrees: options.worktrees }),
    ...(options.preflightTimeoutMs === undefined ? {} : { preflightTimeoutMs: options.preflightTimeoutMs }),
    sessionStore,
    history,
    authorizationMode: 'grants',
    delegationEnabled: true,
    logger: { info() {}, warn() {} },
  });

  /**
   * Issue a connection plus one task grant covering a workspace.
   * @param {string} [workspacePath] - source the grant must cover.
   * @returns {{ connectionId: string, grant: object }} credentials.
   */
  function authorize(workspacePath = workspace) {
    const connection = auth.issueConnection({ label: 'codex' });
    const grant = auth.issueGrant(connection.connectionId, {
      kind: 'task',
      workspacePath,
      ttlSeconds: 600,
    });
    return { connectionId: connection.connectionId, grant };
  }

  /**
   * Start one task with a fresh grant, WITHOUT awaiting admission's side effects
   * beyond what `start` itself resolves.
   * @param {string} prompt - task prompt.
   * @param {object} [extra] - extra start fields.
   * @returns {Promise<object>} the started task view (may reject).
   */
  async function submit(prompt, extra = {}) {
    const { connectionId, grant } = authorize();
    return await engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: workspace,
      prompt,
      ...extra,
    });
  }

  /**
   * Start one task on a NAMED source with a fresh grant for it.
   * @param {string} workspacePath - source to submit against.
   * @param {string} prompt - task prompt.
   * @returns {Promise<object>} the started task view.
   */
  async function submitIn(workspacePath, prompt) {
    const { connectionId, grant } = authorize(workspacePath);
    return await engine.start({ connectionId, grantId: grant.grantId, workspacePath, prompt });
  }

  /**
   * Submit as ONE connection (a follow-up must be owned by the parent's owner).
   * @param {object} credentials - connection from {@link authorize}.
   * @param {string} prompt - task prompt.
   * @param {object} [extra] - extra start fields.
   * @returns {Promise<object>} the started task view.
   */
  async function submitAs(credentials, prompt, extra = {}) {
    const grant = auth.issueGrant(credentials.connectionId, {
      kind: 'task', workspacePath: workspace, ttlSeconds: 600,
    });
    return await engine.start({
      connectionId: credentials.connectionId,
      grantId: grant.grantId,
      workspacePath: workspace,
      prompt,
      ...extra,
    });
  }

  /**
   * The newest task record the engine holds, for a submission whose `start()` has
   * not returned yet (it may be waiting for a preparation turn).
   * @param {string} [excludeTaskId] - an id to skip.
   * @returns {object|undefined} task record.
   */
  function newestTask(excludeTaskId) {
    return [...engine.tasks.values()].filter((task) => task.taskId !== excludeTaskId).at(-1);
  }

  return {
    dir,
    workspace,
    engine,
    auth,
    settings,
    locks,
    sessionController,
    workspaces,
    authorize,
    submit,
    submitIn,
    submitAs,
    newestTask,
    async close() {
      await engine.dispose();
      await cleanup(dir);
    },
  };
}

/**
 * Wait until a task is terminal and its own lifecycle promise has settled.
 * @param {object} engine - job engine.
 * @param {string} taskId - task id.
 * @param {number} [attempts] - polling bound.
 * @returns {Promise<object>} task record.
 */
async function settle(engine, taskId, attempts = 2000) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const task = engine.tasks.get(taskId);
    if (task === undefined) return undefined;
    if (TERMINAL.has(task.state)) {
      await Promise.race([
        task.settled,
        new Promise((resolvePromise) => { setTimeout(resolvePromise, 25); }),
      ]);
      return engine.tasks.get(taskId);
    }
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
  }
  return engine.tasks.get(taskId);
}

/**
 * Wait until a predicate holds, polling briefly.
 * @param {() => boolean} predicate - condition.
 * @param {() => string} describe - message built lazily on failure.
 * @param {number} [attempts] - polling bound.
 * @returns {Promise<void>} resolves when the predicate holds.
 */
async function waitFor(predicate, describe, attempts = 2000) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
  }
  assert.fail(typeof describe === 'function' ? describe() : describe);
}

/**
 * Account for every task the engine holds, for a failure message.
 * @param {object} engine - job engine.
 * @returns {string} compact summary.
 */
function tasksBrief(engine) {
  return JSON.stringify([...engine.tasks.values()].map((task) => ({
    state: task.state,
    phase: task.phase,
    error: task.error?.code ?? null,
    path: task.executionPath,
  })));
}

// ---------------------------------------------------------------------------
// Isolated runs of one source
// ---------------------------------------------------------------------------

test('two isolated runs of one source reach the runner at the same time, in different directories', async () => {
  const worktrees = fakeWorktrees();
  const sessions = blockingSessionController();
  const h = await harness({
    worktrees,
    sessionController: sessions,
    settings: validSettings({ worker: { isolation: 'worktree', maxParallelism: 2 } }),
  });
  try {
    // BOTH submissions are in flight before either is awaited: this is the field
    // case (two worktree packages accepted through one MCP connection at once).
    const [first, second] = await Promise.all([h.submit('first isolated package'), h.submit('second isolated package')]);
    assert.notEqual(first.taskId, second.taskId);
    assert.equal(first.isolation, 'worktree');
    assert.equal(second.isolation, 'worktree');

    await waitFor(
      () => sessions.entered.length === 2,
      () => `both runs must reach the runner; ${tasksBrief(h.engine)}`,
    );
    const one = h.engine.tasks.get(first.taskId);
    const two = h.engine.tasks.get(second.taskId);
    assert.equal(one.state, TASK_STATES.running, 'the first run is really running');
    assert.equal(two.state, TASK_STATES.running, 'the second run is really running');
    assert.notEqual(one.executionPath, two.executionPath, 'two runs, two checkouts');
    assert.notEqual(one.executionPath, h.workspace, 'neither run writes to the source');
    // Each run drives its OWN DSH conversation: concurrency is not "one session
    // shared", it is two sessions inside the one outer work package's budget.
    const sessionsUsed = [...sessions.agents.keys()];
    assert.equal(sessionsUsed.length, 2, 'the controller resolved one Agent per run');
    assert.equal(new Set(sessionsUsed).size, 2, 'two runs, two Sessions');
    const sessionRecords = sessionsUsed.map((id) => sessions.sessions.get(id));
    assert.equal(new Set(sessionRecords.map((record) => record.workspaceId)).size, 2,
      'each run is grouped under its own execution directory');
    for (const record of sessionRecords) {
      assert.ok([one.executionPath, two.executionPath].includes(record.cwd),
        'every Session is rooted in one of the two checkouts, never in the source');
    }
    // Each holds exactly ONE exclusive lease, on its own checkout — never on the
    // shared source, which is what used to refuse the second submission.
    for (const task of [one, two]) {
      const exclusive = task.leases.filter((lease) => lease.mode === 'exclusive');
      assert.equal(exclusive.length, 1, 'an isolated run holds one exclusive lease');
      assert.equal(exclusive[0].path, task.executionPath, 'the exclusive lease is its own checkout');
      assert.equal(task.leases.some((lease) => lease.path === h.workspace), false,
        'the source is not held while the run works');
    }
    assert.equal(h.locks.isLocked(h.workspace), false, 'the source is free while both runs work');
    assert.equal(h.locks.isLocked(one.executionPath, { mode: 'exclusive' }), true);
    assert.equal(h.locks.isLocked(two.executionPath, { mode: 'exclusive' }), true);
    assert.equal(worktrees.prepares.length, 2, 'both submissions created their own tree');
  } finally {
    await h.close();
  }
});

test('a third run over the parallelism cap is refused by the cap, not by the workspace', async () => {
  const worktrees = fakeWorktrees();
  const sessions = blockingSessionController();
  const h = await harness({
    worktrees,
    sessionController: sessions,
    settings: validSettings({ worker: { isolation: 'worktree', maxParallelism: 2 } }),
  });
  try {
    const [first, second] = await Promise.all([h.submit('one'), h.submit('two')]);
    await waitFor(() => sessions.entered.length === 2, () => `both admitted runs must reach the runner; ${tasksBrief(h.engine)}`);
    await assert.rejects(
      () => h.submit('three'),
      (error) => {
        assert.equal(error.code, JOB_CODES.concurrency, `expected the cap, got ${error.code}: ${error.message}`);
        assert.equal(error.details.limit, 2);
        return true;
      },
    );
    assert.equal(worktrees.prepares.length, 2, 'a task refused by the cap starts no Git preparation');
    assert.equal(sessions.entered.length, 2, 'and drives no session');
    assert.equal(h.engine.tasks.get(first.taskId).slotHeld, true);
    assert.equal(h.engine.tasks.get(second.taskId).slotHeld, true);
  } finally {
    await h.close();
  }
});

test('Git preparation of one source is serialised, but other sources prepare in parallel', async () => {
  // The gate records how many preparations are INSIDE `prepare` at once, which is
  // what proves "one at a time per source" and "two at once across sources".
  let inside = 0;
  let peak = 0;
  const worktrees = fakeWorktrees({
    async gate() {
      inside += 1;
      peak = Math.max(peak, inside);
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });
      inside -= 1;
    },
  });
  const h = await harness({
    worktrees,
    settings: validSettings({ worker: { isolation: 'worktree', maxParallelism: 4 } }),
  });
  try {
    const other = await realpath(
      await mkdir(join(h.dir, 'other-workspace'), { recursive: true }).then(() => join(h.dir, 'other-workspace')),
    );

    // Two submissions against ONE source: the Git step is serialised.
    const sameSource = await Promise.all([
      h.submitIn(h.workspace, 'same source A'),
      h.submitIn(h.workspace, 'same source B'),
    ]);
    await settle(h.engine, sameSource[0].taskId);
    await settle(h.engine, sameSource[1].taskId);
    assert.equal(peak, 1, `one source prepared two trees at once (peak ${peak})`);
    assert.equal(worktrees.prepares.length, 2, 'both isolated runs still got their tree');
    assert.notEqual(sameSource[0].workspacePath, sameSource[1].workspacePath);

    // Two DIFFERENT sources: the queues are per source, so the Git steps overlap.
    peak = 0;
    const crossSource = await Promise.all([
      h.submitIn(other, 'other source task'),
      h.submitIn(h.workspace, 'source task again'),
    ]);
    await settle(h.engine, crossSource[0].taskId);
    await settle(h.engine, crossSource[1].taskId);
    assert.equal(worktrees.prepares.length, 4, 'every submission prepared a tree');
    assert.equal(peak, 2, `two different sources must prepare in parallel (peak ${peak})`);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Shared runs of one source
// ---------------------------------------------------------------------------

test('two shared runs of one source still refuse each other', async () => {
  const worktrees = fakeWorktrees();
  const sessions = blockingSessionController();
  const h = await harness({
    worktrees,
    sessionController: sessions,
    // Shared is the fixture default; the cap is raised so only the workspace lock
    // can refuse the second submission.
    settings: validSettings({ worker: { isolation: 'shared', maxParallelism: 2 } }),
  });
  try {
    const first = await h.submit('shared one');
    await waitFor(() => sessions.entered.length === 1, 'the shared run must reach the runner');
    assert.equal(h.locks.isLocked(h.workspace, { mode: 'exclusive' }), true,
      'a shared run holds the source exclusively while it writes');

    await assert.rejects(
      () => h.submit('shared two'),
      (error) => {
        assert.equal(error.code, JOB_CODES.busy, `expected the workspace refusal, got ${error.code}`);
        assert.equal(error.details.purpose, 'source');
        return true;
      },
    );
    const refused = [...h.engine.tasks.values()].find((task) => task.taskId !== first.taskId);
    assert.equal(refused.state, TASK_STATES.failed);
    assert.equal(refused.error.code, JOB_CODES.busy);
    assert.equal(worktrees.prepares.length, 0, 'no tree is prepared for a shared run');
    assert.equal(sessions.entered.length, 1, 'the refused submission never reached a session');
  } finally {
    await h.close();
  }
});

test('a shared run and an isolated run of one source exclude each other', async () => {
  const worktrees = fakeWorktrees();
  const sessions = blockingSessionController();
  const h = await harness({
    worktrees,
    sessionController: sessions,
    settings: validSettings({ worker: { isolation: 'shared', maxParallelism: 2 } }),
  });
  try {
    // A shared run writes to the source and holds it exclusively, so an isolated
    // submission must not prepare a tree from a directory being edited: the tree would
    // be pinned to a commit without those edits, and the status read would race them.
    const shared = await h.submit('shared work');
    await waitFor(() => sessions.entered.length === 1, 'the shared run must reach the runner');
    await assert.rejects(
      () => h.submit('isolated work', { overrides: { isolation: 'worktree' } }),
      (error) => {
        assert.equal(error.code, JOB_CODES.busy, `expected the source refusal, got ${error.code}: ${error.message}`);
        assert.equal(error.details.purpose, 'source');
        return true;
      },
    );
    assert.equal(worktrees.prepares.length, 0, 'no tree may be created from a source being written to');
    await h.engine.cancel(shared.taskId, 'test-cleanup');
    await settle(h.engine, shared.taskId);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Continuations onto the same tree
// ---------------------------------------------------------------------------

test('two continuations that drive the same tree are mutually exclusive', async () => {
  const worktrees = fakeWorktrees();
  const h = await harness({
    worktrees,
    settings: validSettings({ worker: { isolation: 'worktree', maxParallelism: 2 } }),
  });
  try {
    // A follow-up must be owned by the connection that owns the parent, so ONE
    // connection submits both — a fresh connection per submission is a different owner
    // and would be refused for ownership, not for the tree.
    const owner = h.authorize();
    const parent = await h.submitAs(owner, 'original package');
    await settle(h.engine, parent.taskId);
    const parentRecord = h.engine.tasks.get(parent.taskId);
    assert.equal(parentRecord.state, TASK_STATES.awaitingHostReview,
      `the parent must end before it can be continued: ${JSON.stringify(parentRecord.error)}`);
    const tree = parentRecord.executionPath;
    assert.equal(h.locks.isLocked(tree, { mode: 'exclusive' }), false, 'a settled run releases its tree');

    // Hold the tree the way a live continuation does, then submit the follow-up.
    const holder = h.locks.acquire(tree, { taskId: 'task-other-continuation', mode: 'exclusive' });
    try {
      await assert.rejects(
        () => h.submitAs(owner, 'continue the same tree', { continueFromTaskId: parent.taskId }),
        (error) => {
          assert.equal(error.code, JOB_CODES.busy, `expected the tree refusal, got ${error.code}: ${error.message}`);
          assert.equal(error.details.purpose, 'execution');
          return true;
        },
      );
    } finally {
      h.locks.release(tree, holder.nonce);
    }
    // With the tree free the same follow-up is admitted and drives the SAME
    // directory: the exclusivity above was about the tree, not about continuing.
    const child = await h.submitAs(owner, 'continue the same tree', { continueFromTaskId: parent.taskId });
    await settle(h.engine, child.taskId);
    const childRecord = h.engine.tasks.get(child.taskId);
    assert.equal(childRecord.state, TASK_STATES.awaitingHostReview,
      `the follow-up must run: ${JSON.stringify(childRecord.error)}`);
    assert.equal(childRecord.executionPath, parentRecord.executionPath, 'a follow-up drives its parent\'s tree');
    assert.equal(h.locks.isLocked(tree, { mode: 'exclusive' }), false, 'and releases it when it ends');
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Cancellation, queueing and late settlement during preparation
// ---------------------------------------------------------------------------

test('cancelling the task inside Git preparation lets the queued one proceed and never runs it', async () => {
  const gates = gate();
  const worktrees = fakeWorktrees({ gate: (_request, index) => gates.wait(index) });
  const h = await harness({
    worktrees,
    settings: validSettings({ worker: { isolation: 'worktree', maxParallelism: 2 } }),
  });
  try {
    // The first submission is INSIDE Git and its `start()` cannot resolve yet: hold
    // the promise and read the id from the record instead of awaiting it.
    let firstId;
    const firstStart = h.submit('first preparation');
    firstStart.catch(() => {});
    await waitFor(() => worktrees.prepares.length === 1, () => `the first task must be inside Git preparation; ${tasksBrief(h.engine)}`);
    firstId = h.newestTask().taskId;

    // The second queues behind it: same source, so one Git preparation at a time.
    const secondStart = h.submit('second preparation');
    secondStart.catch(() => {});
    await waitFor(
      () => h.newestTask(firstId) !== undefined,
      () => `the second submission is recorded while it waits; ${tasksBrief(h.engine)}`,
    );
    const waitingId = h.newestTask(firstId).taskId;
    assert.equal(worktrees.prepares.length, 1, 'the second preparation has not started');
    assert.equal(h.engine.tasks.get(waitingId).state, TASK_STATES.pending, 'the queued one is pending, not refused');

    // Cancel the one INSIDE Git. Git answers with WORKTREE_CANCELLED, the queue then
    // releases the source and the queued submission takes its turn.
    await h.engine.cancel(firstId, 'request');
    await assert.rejects(() => firstStart, (error) => error.code === JOB_CODES.cancelled);
    const firstRecord = h.engine.tasks.get(firstId);
    assert.equal(firstRecord.state, TASK_STATES.cancelled);
    assert.equal(firstRecord.execution, null, 'a cancelled preparation never starts a run');

    gates.open(1);
    // Its own gate comes next: the queued submission takes the turn once the cancelled
    // one has answered, then enters Git itself.
    await waitFor(
      () => worktrees.prepares.length === 2,
      () => `the queued one must start its own preparation; ${tasksBrief(h.engine)}`,
    );
    gates.open(2);
    const second = await secondStart;
    await settle(h.engine, second.taskId);
    assert.equal(second.taskId, waitingId, 'the queued submission is the one that proceeded');
    const secondRecord = h.engine.tasks.get(second.taskId);
    assert.equal(secondRecord.state, TASK_STATES.awaitingHostReview,
      `the queued submission must run normally: ${JSON.stringify(secondRecord.error)}`);
    assert.equal(worktrees.prepares.length, 2, 'the queued one started its own Git preparation');
    await waitFor(
      () => h.locks.describe(h.workspace).length === 0,
      () => `no lease of any mode may be left on the source; ${JSON.stringify(h.locks.describe(h.workspace))}`,
    );
  } finally {
    gates.open();
    await h.close();
  }
});

test('a cancelled queued submission leaves the queue, takes no slot, and never starts Git', async () => {
  const gates = gate();
  const worktrees = fakeWorktrees({ gate: (_request, index) => gates.wait(index) });
  const h = await harness({
    worktrees,
    settings: validSettings({ worker: { isolation: 'worktree', maxParallelism: 3 } }),
  });
  try {
    const firstStart = h.submit('holds the turn');
    firstStart.catch(() => {});
    await waitFor(() => worktrees.prepares.length === 1, () => `the first task must be inside Git preparation; ${tasksBrief(h.engine)}`);
    const firstId = h.newestTask().taskId;

    const queuedStart = h.submit('queued and cancelled');
    queuedStart.catch(() => {});
    await waitFor(
      () => h.newestTask(firstId) !== undefined,
      () => `the queued submission is recorded while it waits; ${tasksBrief(h.engine)}`,
    );
    const queuedId = h.newestTask(firstId).taskId;
    assert.equal(h.engine.tasks.get(queuedId).state, TASK_STATES.pending);

    await h.engine.cancel(queuedId, 'request');
    await assert.rejects(
      () => queuedStart,
      (error) => {
        assert.equal(error.code, JOB_CODES.cancelled, `a cancelled waiter is refused as cancelled, got ${error.code}`);
        return true;
      },
    );
    const queuedRecord = h.engine.tasks.get(queuedId);
    assert.equal(queuedRecord.state, TASK_STATES.cancelled, 'a cancelled waiter ends as cancelled');
    assert.equal(queuedRecord.execution, null, 'and never starts a run');
    assert.equal(queuedRecord.slotHeld, false, 'and returns its slot');
    assert.equal(worktrees.prepares.length, 1, 'a cancelled waiter never starts its own Git preparation');

    // The survivor finishes; nothing is left behind.
    gates.open(1);
    const first = await firstStart;
    await settle(h.engine, first.taskId);
    assert.equal(h.engine.tasks.get(first.taskId).state, TASK_STATES.awaitingHostReview,
      `the survivor must run normally: ${JSON.stringify(h.engine.tasks.get(first.taskId).error)}`);
    assert.deepEqual(h.engine.preparationTurns.get(h.workspace.toLowerCase()) ?? [], [],
      'the queue is empty once every submission is done');
    assert.equal(h.locks.describe(h.workspace).length, 0, 'the source is free at the end');
  } finally {
    gates.open();
    await h.close();
  }
});

test('a preparation that settles after its task was cancelled keeps the source protected until it finishes', async () => {
  // The gate ignores cancellation, like a real `git worktree add` that has already
  // started: the process cannot stop it, so the source must stay protected.
  const gates = gate();
  const worktrees = fakeWorktrees({ gate: (_request, index) => gates.wait(index) });
  const h = await harness({
    worktrees,
    settings: validSettings({ worker: { isolation: 'worktree', maxParallelism: 2 } }),
  });
  try {
    const started = h.submit('abandoned preparation');
    started.catch(() => {});
    await waitFor(() => worktrees.prepares.length === 1, () => `the task must be inside Git preparation; ${tasksBrief(h.engine)}`);
    const taskId = h.newestTask().taskId;

    await h.engine.cancel(taskId, 'request');
    await assert.rejects(() => started, (error) => error.code === JOB_CODES.cancelled);
    assert.equal(h.engine.tasks.get(taskId).state, TASK_STATES.cancelled);
    // The Git call is still running, so the source is still protected: a shared
    // submission must not take it while `git worktree add` writes its index. The head
    // holds it as an EXCLUSIVE lease (the same kind a shared run takes), taken locally
    // so an ordinary finalize cannot return it early.
    assert.equal(h.locks.isLocked(h.workspace), true,
      'the abandoned Git attempt keeps its source lease until it finishes');
    await assert.rejects(
      () => h.submit('shared while git writes', { overrides: { isolation: 'shared' } }),
      (error) => {
        assert.equal(error.code, JOB_CODES.busy,
          `a shared run must be refused while Git writes; got ${error.code}: ${error.message} `
          + `phase=${error.details?.phase ?? '-'} tasks=${tasksBrief(h.engine)}`);
        assert.equal(error.details.purpose, 'source');
        return true;
      },
    );

    gates.open(1);
    await waitFor(
      () => h.locks.describe(h.workspace).length === 0,
      () => `the preparation lease must be released once the late attempt finishes; ${JSON.stringify(h.locks.describe(h.workspace))} tasks=${tasksBrief(h.engine)}`,
    );
    assert.equal(h.locks.isLocked(h.workspace), false, 'and the source protection is gone');
    // The source is usable again: this submission has its own gate, opened after it
    // has entered Git.
    const nextStart = h.submit('after the late attempt');
    await waitFor(
      () => worktrees.prepares.length === 2,
      () => `the next submission must reach Git; ${tasksBrief(h.engine)}`,
    );
    gates.open(2);
    const next = await nextStart;
    await settle(h.engine, next.taskId);
    assert.equal(h.engine.tasks.get(next.taskId).state, TASK_STATES.awaitingHostReview,
      `the next submission must run normally: ${JSON.stringify(h.engine.tasks.get(next.taskId).error)}`);
  } finally {
    gates.open();
    await h.close();
  }
});

test('a preparation that exceeds its budget fails as a timeout and frees its place', async () => {
  const gates = gate();
  const worktrees = fakeWorktrees({ gate: (_request, index) => gates.wait(index) });
  const h = await harness({
    worktrees,
    // A short admission budget: the gated Git call cannot finish inside it.
    preflightTimeoutMs: 60,
    settings: validSettings({ worker: { isolation: 'worktree', maxParallelism: 2 } }),
  });
  try {
    await assert.rejects(
      () => h.submit('too slow to prepare'),
      (error) => {
        assert.equal(error.code, JOB_CODES.timeout, `expected the preflight timeout, got ${error.code}`);
        return true;
      },
    );
    const task = [...h.engine.tasks.values()][0];
    assert.equal(task.state, TASK_STATES.failed);
    assert.equal(task.execution, null, 'a timed-out preparation never runs');
    assert.equal(task.slotHeld, false, 'and returns its slot');
    // The abandoned Git call still protects the source while it runs.
    assert.equal(h.locks.isLocked(h.workspace), true,
      'the timed-out Git attempt keeps its source lease until it finishes');
    gates.open(1);
    await waitFor(
      () => h.locks.describe(h.workspace).length === 0,
      () => `the abandoned attempt releases the source when Git finally answers; ${JSON.stringify(h.locks.describe(h.workspace))}`,
    );
    const nextStart = h.submit('after the timeout');
    await waitFor(
      () => worktrees.prepares.length === 2,
      () => `the next submission must reach Git; ${tasksBrief(h.engine)}`,
    );
    gates.open(2);
    const next = await nextStart;
    await settle(h.engine, next.taskId);
    assert.equal(h.engine.tasks.get(next.taskId).state, TASK_STATES.awaitingHostReview,
      `the next submission must run normally: ${JSON.stringify(h.engine.tasks.get(next.taskId).error)}`);
  } finally {
    gates.open();
    await h.close();
  }
});

test('a malformed worktree result is a refusal for that task only, and the next submission still prepares', async () => {
  let calls = 0;
  const service = {
    async prepare(request) {
      calls += 1;
      if (calls === 1) {
        // A service that answers with no path: a refusal, never a silent fallback to
        // shared execution.
        return { taskId: request.taskId, isolated: true };
      }
      const target = join(request.sourcePath, '..', 'tree-ok');
      const workspacePath = await realpath(await mkdir(target, { recursive: true }).then(() => target));
      return {
        taskId: request.taskId,
        workspacePath,
        sourcePath: request.sourcePath,
        baseHead: HEAD,
        isolated: true,
        detached: true,
        state: 'active',
        createdAt: Date.now(),
      };
    },
    markComplete() { return {}; },
    get() { return null; },
  };
  const h = await harness({
    worktrees: service,
    settings: validSettings({ worker: { isolation: 'worktree', maxParallelism: 2 } }),
  });
  try {
    await assert.rejects(() => h.submit('first'), (error) => error.code === JOB_CODES.isolationRefused);
    assert.equal(h.locks.describe(h.workspace).length, 0, 'a refused preparation leaves no lease on the source');
    const second = await h.submit('second');
    await settle(h.engine, second.taskId);
    const secondRecord = h.engine.tasks.get(second.taskId);
    assert.equal(secondRecord.state, TASK_STATES.awaitingHostReview,
      `the next submission must run normally: ${JSON.stringify(secondRecord.error)}`);
  } finally {
    await h.close();
  }
});

test('two submissions after an abandoned Git attempt queue behind it instead of overlapping it', async () => {
  // Two REAL submissions, the first cancelled while Git is still writing. The cancelled
  // task's `start()` has already returned, so nothing in the engine's task table still
  // "holds" the source — the protection has to come from the preparation turn itself.
  //
  // The handshake below is the point of the test: after the second submission has had
  // every chance to be scheduled, `prepare` must still have been entered exactly ONCE.
  // If the head ever stepped aside before its Git call finished, the second one would
  // enter here and `peak` would be 2 — which is the defect this test pins down.
  const gates = gate();
  let inside = 0;
  let peak = 0;
  const worktrees = fakeWorktrees({
    gate: async (_request, index) => {
      inside += 1;
      peak = Math.max(peak, inside);
      await gates.wait(index);
      inside -= 1;
    },
  });
  const h = await harness({
    worktrees,
    settings: validSettings({ worker: { isolation: 'worktree', maxParallelism: 3 } }),
  });
  try {
    const abandoned = h.submit('abandoned attempt');
    abandoned.catch(() => {});
    await waitFor(() => worktrees.prepares.length === 1, () => `the first attempt must be inside Git; ${tasksBrief(h.engine)}`);
    const abandonedId = h.newestTask().taskId;

    // Cancel while Git is blocked. `cancel()` resolves once the task has observed the
    // cancellation, which is BEFORE `git worktree add` answers.
    await h.engine.cancel(abandonedId, 'request');
    await assert.rejects(() => abandoned, (error) => error.code === JOB_CODES.cancelled);
    assert.equal(worktrees.prepares.length, 1, 'the cancelled attempt is still inside Git');

    // A second real submission now arrives and joins the source's queue.
    const nextStart = h.submit('next attempt');
    nextStart.catch(() => {});
    await waitFor(
      () => h.newestTask(abandonedId) !== undefined,
      () => `the next submission is recorded; ${tasksBrief(h.engine)}`,
    );
    const nextId = h.newestTask(abandonedId).taskId;

    // The handshake: let the event loop, timers and any polling run freely, then insist
    // that the second preparation has NOT entered Git. One `prepare`, still.
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 250); });
    assert.equal(worktrees.prepares.length, 1,
      `the next attempt must wait for the abandoned Git call, not start beside it; ${tasksBrief(h.engine)}`);
    assert.equal(peak, 1, `only one preparation may be inside the source (peak ${peak})`);

    // Release the first gate: the abandoned call finishes, and only then may the second
    // enter. Its own gate is opened once it has actually started.
    gates.open(1);
    await waitFor(
      () => worktrees.prepares.length === 2,
      () => `the next attempt must start Git once the source is free; ${tasksBrief(h.engine)}`,
    );
    assert.equal(peak, 1, `the two preparations never overlapped (peak ${peak})`);
    gates.open(2);
    const next = await nextStart;
    await settle(h.engine, next.taskId);
    assert.equal(next.taskId, nextId);
    assert.equal(h.engine.tasks.get(nextId).state, TASK_STATES.awaitingHostReview,
      `the next attempt must run normally: ${JSON.stringify(h.engine.tasks.get(nextId).error)}`);
    assert.equal(peak, 1, `two Git preparations were inside the source at once (peak ${peak})`);
    assert.equal(h.locks.describe(h.workspace).length, 0, 'the source is free at the end');
  } finally {
    gates.open();
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Lock registry semantics
// ---------------------------------------------------------------------------

test('the lock registry refuses to mix modes on one path, and releases exactly the lease named', async () => {
  const locks = new WorkspaceLocks();
  const path = join('C:', 'fake', 'workspace');
  const prepA = locks.acquire(path, { taskId: 'a', mode: 'preparation' });
  const prepB = locks.acquire(path, { taskId: 'b', mode: 'preparation' });
  assert.equal(locks.describe(path).length, 2, 'several preparations may share a directory');
  assert.throws(
    () => locks.acquire(path, { taskId: 'c' }),
    (error) => error.code === 'WORKSPACE_BUSY' && error.details.mode === 'preparation',
  );
  assert.equal(locks.release(path, prepA.nonce), true);
  assert.equal(locks.isLocked(path), true, 'the sibling preparation still holds it');
  // An exclusive lease cannot be taken while another preparation is still live.
  assert.throws(
    () => locks.acquire(path, { taskId: 'd' }),
    (error) => error.code === 'WORKSPACE_BUSY' && error.details.preparations === 1,
  );
  assert.equal(locks.release(path, prepB.nonce), true);
  assert.equal(locks.isLocked(path), false, 'the last preparation leaves the path free');
  const exclusive = locks.acquire(path, { taskId: 'd' });
  assert.equal(exclusive.mode, 'exclusive');
  assert.throws(
    () => locks.acquire(path, { taskId: 'e', mode: 'preparation' }),
    (error) => error.code === 'WORKSPACE_BUSY' && error.details.mode === 'exclusive',
  );
  // A stale nonce releases nothing it does not hold.
  assert.equal(locks.release(path, prepA.nonce), false);
  assert.equal(locks.isLocked(path, { mode: 'exclusive' }), true);
  assert.equal(locks.isLocked(path, { mode: 'preparation' }), false);
  assert.equal(locks.release(path, exclusive.nonce), true);
  assert.equal(locks.isLocked(path), false);
  assert.equal(locks.describe(path).length, 0);
});

test('an explicitly released lease never expires, while an ordinary lease still does', async () => {
  // A controlled clock: a delegated run has no total time limit by default, so an
  // execution lease must survive far beyond the 150-minute hold bound — otherwise a
  // long run would lose its directory to a second job mid-write.
  let now = 1_000_000;
  const locks = new WorkspaceLocks({ now: () => now, maxHoldMs: 150 * 60 * 1000 });
  const path = join('C:', 'fake', 'long');
  const execution = locks.acquire(path, { taskId: 'long-run', explicitRelease: true });
  assert.equal(execution.explicitRelease, true);
  // 150 minutes later — the ordinary bound — it is still held.
  now += 150 * 60 * 1000;
  assert.equal(locks.isLocked(path), true, 'an execution lease must outlive the hold bound');
  assert.throws(() => locks.acquire(path, { taskId: 'intruder' }), (error) => error.code === 'WORKSPACE_BUSY');
  // A year later it is still held: only an explicit release returns it.
  now += 365 * 24 * 60 * 60 * 1000;
  assert.equal(locks.isLocked(path), true, 'and it never expires by wall clock');
  assert.equal(locks.release(path, execution.nonce), true);
  assert.equal(locks.isLocked(path), false, 'the explicit release returns it');

  // The ordinary (bounded) lease keeps its documented behaviour.
  const bounded = locks.acquire(path, { taskId: 'bounded' });
  now += 150 * 60 * 1000;
  assert.equal(locks.isLocked(path), false, 'an ordinary lease still expires after its hold bound');
  void bounded;
});

test('a long-running isolated task keeps its execution lease well past the hold bound', async () => {
  // End to end with the real engine and a controlled clock.
  let now = 1_000_000;
  const sessions = blockingSessionController();
  const h = await harness({
    worktrees: fakeWorktrees(),
    sessionController: sessions,
    now: () => now,
    settings: validSettings({ worker: { isolation: 'worktree', maxParallelism: 2 } }),
  });
  try {
    const first = await h.submit('long isolated run');
    await waitFor(() => sessions.entered.length === 1, 'the run must reach the runner');
    const record = h.engine.tasks.get(first.taskId);
    assert.equal(record.state, TASK_STATES.running);
    const tree = record.executionPath;
    // Four hours of virtual time: far past the 150-minute hold bound.
    now += 4 * 60 * 60 * 1000;
    assert.equal(h.locks.isLocked(tree, { mode: 'exclusive' }), true,
      'a running task keeps its checkout no matter how long it has been running');
    // The task's own record of the lease survives the clock advance too.
    assert.equal(record.leases.some((lease) => lease.path === tree), true);
  } finally {
    await h.close();
  }
});
