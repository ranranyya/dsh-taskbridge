// Durable job history tests: bounded entries, atomic upserts, restart states and
// the two refusals (untrustworthy document, unsatisfiable limits).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HISTORY_CODES, HistoryError, HistoryStore } from '../src/jobs/history.js';

const SECRET = 'sk-fixture00000000000000000000';

/**
 * Fresh data directory per test.
 * @returns {Promise<string>} absolute temp directory.
 */
async function dataDir() {
  return await mkdtemp(join(tmpdir(), 'dsh-history-'));
}

/** @returns {object} the file path inside a data directory. */
function historyFile(dir) {
  return join(dir, 'history.json');
}

/**
 * A public job view shaped like the engine's projection, with fixture values.
 * @param {object} [overrides] - fields to replace.
 * @returns {object} view.
 */
function fixtureView(overrides = {}) {
  const createdAt = 1_700_000_000_000;
  const base = {
    taskId: 'task-fixture-1',
    state: 'awaiting-host-review',
    phase: 'awaiting-host-review',
    createdAt,
    startedAt: createdAt + 1000,
    endedAt: createdAt + 2000,
    sourcePath: 'C:\\fixtures\\repo',
    workspacePath: 'C:\\fixtures\\repo',
    executionWorkspacePath: 'C:\\fixtures\\repo',
    isolation: 'shared',
    connectionId: 'conn-fixture-1',
    // Authorization state: stored nowhere, even when the caller passes it.
    grantId: 'grant-fixture-1',
    authorization: 'task',
    effective: {
      worker: {
        providerId: 'relay',
        model: 'deepseek-chat',
        reasoningEffort: 'medium',
        timeoutSeconds: 900,
        maxParallelism: 1,
        isolation: 'shared',
      },
      review: { enabled: false, providerId: null, model: null, reasoningEffort: null },
      provenance: { projectPath: 'C:\\fixtures\\repo', projectKey: 'c:\\fixtures\\repo', applied: ['global:worker'] },
    },
    route: { providerId: 'relay', providerRoute: 'relay', model: 'deepseek-chat', reasoningEffort: 'medium' },
    reviewRoute: null,
    reviewRouteError: null,
    worktree: null,
    baseline: {
      head: 'fixturehead0000000000000000000000000000',
      dirtyBaseline: false,
      preexistingChanges: 0,
      preexistingPaths: [],
      statusTruncated: false,
      statusFormat: 'porcelain-v1-z',
      capturedAt: createdAt + 500,
    },
    diff: {
      head: 'fixturehead0000000000000000000000000000',
      baseHead: 'fixturehead0000000000000000000000000000',
      dirtyBaseline: false,
      preexistingChanges: 0,
      files: [{ code: 'M', path: 'src/fixture.js', from: null }],
      fileCount: 1,
      truncatedFiles: false,
      changes: [{ added: 4, removed: 1, path: 'src/fixture.js', from: null }],
      sensitivePaths: [],
      sensitiveTouchedCount: 0,
      sensitiveContentWithheld: true,
      patchWithheld: false,
      patchText: 'diff --git a/src/fixture.js b/src/fixture.js\n+const fixture = 1;',
      patchTruncated: false,
      patchBytes: 64,
      capturedAt: createdAt + 1800,
    },
    execution: {
      workspacePath: 'C:\\fixtures\\repo',
      outcome: 'completed',
      text: 'changed one fixture file',
      reasoningOnly: false,
      textTruncated: false,
      usage: { inputTokens: 42, outputTokens: 7, totalTokens: 49, reasoningTokens: 3 },
      turnEnd: { reason: 'completed' },
      agentId: 'agent-fixture-1',
      sessionId: 'session-fixture-1',
      cancelCause: null,
      error: null,
    },
    review: {
      state: 'not_run',
      verdict: null,
      text: '',
      error: null,
      selection: { providerId: null, model: null, reasoningEffort: null },
      denials: [],
      denialsDelivered: 0,
    },
    error: null,
    cancelledBy: null,
    hostAcceptance: null,
    selfApproved: false,
  };
  return { ...base, ...overrides };
}

/**
 * Write a document exactly as given.
 * @param {string} dir - data directory.
 * @param {unknown} document - JSON value.
 * @returns {Promise<string>} the raw text written.
 */
async function writeDocument(dir, document) {
  const raw = typeof document === 'string' ? document : `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(historyFile(dir), raw, 'utf8');
  return raw;
}

/** @returns {Promise<object>} the parsed document on disk. */
async function readDocument(dir) {
  return JSON.parse(await readFile(historyFile(dir), 'utf8'));
}

/**
 * Assert a promise rejects with one history refusal code.
 * @param {Promise<unknown>} promise - pending call.
 * @param {string} code - expected code.
 * @returns {Promise<HistoryError>} the refusal.
 */
async function rejectsWith(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HistoryError, `expected a HistoryError, got ${error?.name}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected a ${code} refusal`);
}

test('a saved view round-trips through the file and load is newest first', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({ taskId: 'task-old', createdAt: 1000, state: 'failed', error: { code: 'JOB_FAILED', message: 'boom' } }));
    await store.save(fixtureView({ taskId: 'task-new', createdAt: 2000 }));

    const views = await store.load();
    assert.deepEqual(views.map((job) => job.taskId), ['task-new', 'task-old']);

    const document = await readDocument(dir);
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.jobs.length, 2);
    // Creation order on disk keeps serialization deterministic.
    assert.deepEqual(document.jobs.map((job) => job.taskId), ['task-old', 'task-new']);

    const reloaded = new HistoryStore(dir);
    const fromDisk = await reloaded.load();
    assert.equal(fromDisk.length, 2);
    assert.equal(fromDisk[0].taskId, 'task-new');
    assert.equal(fromDisk[0].execution.usage.totalTokens, 49);
    assert.equal(fromDisk[0].diff.patchText.includes('+const fixture = 1;'), true);
    assert.equal(fromDisk[0].selfApproved, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing history file is an empty history and creates nothing', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    assert.deepEqual(await store.load(), []);
    assert.deepEqual(await store.load(), []);
    assert.deepEqual(await readdir(dir), [], 'load must not create a file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parallel saves of distinct views all survive and the document stays valid', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await Promise.all(
      Array.from({ length: 24 }, (_unused, index) => store.save(fixtureView({
        taskId: `task-parallel-${index}`,
        createdAt: 1_700_000_000_000 + index,
      }))),
    );;
    await store.flush();

    const views = await store.load();
    assert.equal(views.length, 24);
    assert.equal(new Set(views.map((job) => job.taskId)).size, 24);
    assert.equal((await readDocument(dir)).jobs.length, 24);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parallel saves of one id upsert rather than duplicate', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await Promise.all(Array.from({ length: 8 }, (_unused, index) => store.save(fixtureView({
      taskId: 'task-same',
      execution: { ...fixtureView().execution, usage: { inputTokens: index } },
    }))));;
    const views = await store.load();
    assert.equal(views.length, 1);
    assert.equal(views[0].execution.usage.inputTokens >= 0, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed write is reported and a later save recovers', async () => {
  const dir = await dataDir();
  try {
    let writes = 0;
    const failingFs = {
      ...nodeFs,
      writeFile: async (...args) => {
        writes += 1;
        if (writes === 1) {
          const error = new Error('injected write failure');
          error.code = 'EIO';
          throw error;
        }
        return await nodeFs.writeFile(...args);
      },
    };
    const store = new HistoryStore(dir, { fs: failingFs });
    const error = await rejectsWith(store.save(fixtureView()), HISTORY_CODES.writeFailed);
    assert.equal(error.details.cause, 'EIO');
    assert.deepEqual(await readdir(dir), [], 'the failed temp file must be cleaned up');

    await store.save(fixtureView({ taskId: 'task-after-failure' }));
    const views = await store.load();
    assert.deepEqual(views.map((job) => job.taskId), ['task-after-failure']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deleteMany removes one batch, keeps the memory view honest and survives a reload', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({ taskId: 'task-one' }));
    await store.save(fixtureView({ taskId: 'task-two', createdAt: 1_700_000_100_000 }));
    await store.save(fixtureView({ taskId: 'task-three', createdAt: 1_700_000_200_000, state: 'failed' }));

    const outcome = await store.deleteMany(['task-one', 'task-three']);
    assert.deepEqual(outcome.deletedTaskIds, ['task-one', 'task-three']);
    assert.equal(outcome.remaining, 1);
    // The in-memory view is replaced only by what the write confirmed.
    assert.deepEqual((await store.load()).map((job) => job.taskId), ['task-two']);

    // …and the document itself lost exactly those records.
    const document = JSON.parse(await readFile(historyFile(dir), 'utf8'));
    assert.equal(document.schemaVersion, 1);
    assert.deepEqual(document.jobs.map((job) => job.taskId), ['task-two']);
    assert.deepEqual(await readdir(dir), ['history.json'], 'no temp file is left behind');
    await store.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deleteMany refuses a batch whole: a live, missing, repeated or malformed id writes nothing', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({ taskId: 'task-done' }));
    await store.save(fixtureView({ taskId: 'task-live', state: 'running', phase: 'execute', startedAt: 1_700_000_005_000, endedAt: null }));
    const before = await readFile(historyFile(dir), 'utf8');

    const live = await rejectsWith(store.deleteMany(['task-done', 'task-live']), HISTORY_CODES.deleteInvalid);
    assert.deepEqual(live.details.live, ['task-live']);
    assert.deepEqual(live.details.missing, []);
    const missing = await rejectsWith(store.deleteMany(['task-done', 'task-ghost']), HISTORY_CODES.deleteInvalid);
    assert.deepEqual(missing.details.missing, ['task-ghost']);
    const repeated = await rejectsWith(store.deleteMany(['task-done', 'task-done']), HISTORY_CODES.deleteInvalid);
    assert.equal(repeated.details.taskId, 'task-done');
    for (const bad of [undefined, null, 'task-done', [], [7], [''], [{ taskId: 'task-done' }]]) {
      await rejectsWith(store.deleteMany(bad), HISTORY_CODES.deleteInvalid);
    }
    const oversized = Array.from({ length: 501 }, (_, index) => `task-${index}`);
    await rejectsWith(store.deleteMany(oversized), HISTORY_CODES.deleteInvalid);

    assert.equal(await readFile(historyFile(dir), 'utf8'), before, 'a refused batch must not write one byte');
    assert.deepEqual((await store.load()).map((job) => job.taskId).sort(), ['task-done', 'task-live']);
    await store.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed delete write keeps the old records visible and a later delete succeeds', async () => {
  const dir = await dataDir();
  try {
    let failDelete = false;
    const failingFs = {
      ...nodeFs,
      writeFile: async (path, ...rest) => {
        // Only the DELETE's temp file fails; the seed save writes normally, so the
        // case under test is exactly "the removal could not be written".
        if (String(path).endsWith('.tmp') && failDelete) {
          failDelete = false;
          const error = new Error('injected write failure');
          error.code = 'EIO';
          throw error;
        }
        return await nodeFs.writeFile(path, ...rest);
      },
    };
    const store = new HistoryStore(dir, { fs: failingFs });
    await store.save(fixtureView({ taskId: 'task-keep' }));
    failDelete = true;
    const error = await rejectsWith(store.deleteMany(['task-keep']), HISTORY_CODES.writeFailed);
    assert.equal(error.details.cause, 'EIO');
    // The record is NOT removed from the cached view, so it stays listed and queryable.
    assert.deepEqual((await store.load()).map((job) => job.taskId), ['task-keep']);
    assert.deepEqual(JSON.parse(await readFile(historyFile(dir), 'utf8')).jobs.map((job) => job.taskId), ['task-keep']);

    // The failure is not cached: the same removal works once the filesystem does.
    const outcome = await store.deleteMany(['task-keep']);
    assert.deepEqual(outcome.deletedTaskIds, ['task-keep']);
    assert.deepEqual(await store.load(), []);
    await store.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a malformed document is refused and never overwritten, even by a later save', async () => {
  const dir = await dataDir();
  try {    const raw = await writeDocument(dir, '{"schemaVersion":1,"jobs":[{"taskId":');
    const store = new HistoryStore(dir);
    await rejectsWith(store.load(), HISTORY_CODES.malformed);
    await rejectsWith(store.load(), HISTORY_CODES.malformed);
    await rejectsWith(store.save(fixtureView()), HISTORY_CODES.malformed);
    assert.equal(await readFile(historyFile(dir), 'utf8'), raw, 'the source document must be untouched');

    // A new store sees the same source: the refusal is about the file, not the instance.
    const second = new HistoryStore(dir);
    await rejectsWith(second.load(), HISTORY_CODES.malformed);
    assert.equal(await readFile(historyFile(dir), 'utf8'), raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unknown schemaVersion is refused and preserved for a later release', async () => {
  const dir = await dataDir();
  try {
    const raw = await writeDocument(dir, { schemaVersion: 99, jobs: [], futureField: true });
    const store = new HistoryStore(dir);
    const error = await rejectsWith(store.load(), HISTORY_CODES.schemaUnsupported);
    assert.equal(error.details.schemaVersion, 99);
    await rejectsWith(store.save(fixtureView()), HISTORY_CODES.schemaUnsupported);
    assert.equal(await readFile(historyFile(dir), 'utf8'), raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an oversized document is refused before it is parsed', async () => {
  const dir = await dataDir();
  try {
    // Valid JSON would parse; the size bound must fire first, so the code proves order.
    const filler = 'x'.repeat(80 * 1024);
    const raw = await writeDocument(dir, JSON.stringify({ schemaVersion: 1, jobs: [], filler }));
    const store = new HistoryStore(dir, { maxEntries: 4, maxBytes: 8192, maxEntryBytes: 8192 });
    await rejectsWith(store.load(), HISTORY_CODES.fileTooLarge);
    assert.equal(await readFile(historyFile(dir), 'utf8'), raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a live job becomes interrupted on load with a restart code, and finished jobs keep their state', async () => {
  const dir = await dataDir();
  try {
    const writer = new HistoryStore(dir);
    await writer.save(fixtureView({ taskId: 'task-pending', state: 'pending', phase: 'authorize', endedAt: null }));
    await writer.save(fixtureView({ taskId: 'task-running', state: 'running', phase: 'execute', endedAt: null }));
    await writer.save(fixtureView({ taskId: 'task-failed', state: 'failed', createdAt: 1, error: { code: 'JOB_TIMEOUT', message: 'too slow' } }));
    await writer.save(fixtureView({ taskId: 'task-awaiting', createdAt: 2 }));
    await writer.dispose();

    const restarted = new HistoryStore(dir);
    const views = await restarted.load();
    const byId = new Map(views.map((job) => [job.taskId, job]));

    for (const id of ['task-pending', 'task-running']) {
      const job = byId.get(id);
      assert.equal(job.state, 'interrupted', id);
      assert.equal(job.error.code, 'JOB_INTERRUPTED_RESTART', id);
      assert.equal(job.interruptedFrom === 'pending' || job.interruptedFrom === 'running', true, id);
      assert.equal(Number.isFinite(job.endedAt), true, id);
    }
    assert.equal(byId.get('task-pending').interruptedFrom, 'pending');
    assert.equal(byId.get('task-running').interruptedFrom, 'running');
    assert.equal(byId.get('task-failed').state, 'failed');
    assert.equal(byId.get('task-failed').error.code, 'JOB_TIMEOUT');
    assert.equal(byId.get('task-awaiting').state, 'awaiting-host-review');
    // The interrupted record is stored, not merely projected.
    assert.deepEqual(
      (await readDocument(dir)).jobs.filter((job) => job.state === 'interrupted').length,
      2,
    );

    // A second restart is stable: nothing is rewritten and nothing is resubmitted.
    const before = await readFile(historyFile(dir), 'utf8');
    const third = new HistoryStore(dir);
    const again = await third.load();
    assert.equal(again.filter((job) => job.state === 'interrupted').length, 2);
    assert.equal(await readFile(historyFile(dir), 'utf8'), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('authorization handles, prompts and native handles are never stored', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const view = fixtureView({
      prompt: `please use ${SECRET}`,
      controller: { aborted: false },
      locks: ['C:\\fixtures\\repo'],
    });
    await store.save(view);
    const raw = await readFile(historyFile(dir), 'utf8');
    for (const forbidden of ['grant-fixture-1', 'grantId', '"authorization"', 'agent-fixture-1', 'session-fixture-1', 'please use']) {
      assert.equal(raw.includes(forbidden), false, `${forbidden} must not be stored`);
    }
    const [job] = await store.load();
    assert.equal(job.grantId, undefined);
    assert.equal(job.authorization, undefined);
    assert.equal(job.execution.agentId, undefined);
    assert.equal(job.execution.sessionId, undefined);
    assert.equal(job.prompt, undefined);
    assert.equal(job.connectionId, 'conn-fixture-1', 'connection provenance is kept');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('credential-shaped values never reach the file or a loaded view', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({
      error: {
        code: 'JOB_EXECUTION_FAILED',
        message: `upstream refused: Authorization: Bearer ${SECRET}`,
        details: {
          apiKey: SECRET,
          endpoint: `https://relay.example/v1?key=${SECRET}`,
          nested: { access_token: SECRET, note: `token=${SECRET}` },
        },
      },
      execution: {
        ...fixtureView().execution,
        outcome: 'failed',
        text: `the model said ${SECRET}`,
        error: `client_secret=${SECRET}`,
        usage: { inputTokens: 11, outputTokens: 0, totalTokens: 11, reasoningTokens: 0 },
      },
    }));

    const raw = await readFile(historyFile(dir), 'utf8');
    assert.equal(raw.includes(SECRET), false, 'the credential value must not be stored');
    const views = await store.load();
    assert.equal(JSON.stringify(views).includes(SECRET), false);
    // The useful structure survives: usage stays numeric and the failure is described.
    assert.deepEqual(views[0].execution.usage, { inputTokens: 11, outputTokens: 0, totalTokens: 11, reasoningTokens: 0 });
    assert.equal(views[0].error.code, 'JOB_EXECUTION_FAILED');
    assert.equal(views[0].error.details.nested.access_token.includes(SECRET), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an oversized entry is truncated, not emptied, and keeps a clear marker', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir, { maxEntries: 4, maxBytes: 64 * 1024, maxEntryBytes: 16 * 1024 });
    const patchText = 'a'.repeat(400 * 1024);
    const text = 'b'.repeat(200 * 1024);
    const saved = await store.save(fixtureView({
      diff: { ...fixtureView().diff, patchText },
      execution: { ...fixtureView().execution, text },
      review: { ...fixtureView().review, text: 'c'.repeat(200 * 1024) },
    }));

    assert.equal(Buffer.byteLength(JSON.stringify(saved), 'utf8') <= 16 * 1024, true);
    assert.equal(saved.diff.patchText.length > 0, true, 'the patch is truncated, not dropped');
    assert.equal(saved.diff.patchText.endsWith('… [truncated]'), true);
    assert.equal(saved.diff.patchTruncated, true);
    assert.equal(saved.execution.usage.totalTokens, 49, 'useful fields survive truncation');
    assert.equal(saved.diff.files.length, 1);
    assert.deepEqual(saved.truncation.fields.includes('diff.patchText'), true);

    const [job] = await new HistoryStore(dir, { maxEntries: 4, maxBytes: 64 * 1024, maxEntryBytes: 16 * 1024 }).load();
    assert.equal(Buffer.byteLength(JSON.stringify(job), 'utf8') <= 16 * 1024, true);
    assert.equal(job.diff.patchText.endsWith('… [truncated]'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('maxEntries evicts the oldest terminal view first', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir, { maxEntries: 3 });
    for (let index = 0; index < 6; index += 1) {
      await store.save(fixtureView({ taskId: `task-${index}`, createdAt: 1_700_000_000_000 + index }));
    }
    const views = await store.load();
    assert.deepEqual(views.map((job) => job.taskId).sort(), ['task-3', 'task-4', 'task-5']);
    assert.equal((await readDocument(dir)).jobs.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('maxBytes evicts until the document fits', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir, { maxEntries: 100, maxBytes: 16 * 1024, maxEntryBytes: 8 * 1024 });
    for (let index = 0; index < 10; index += 1) {
      await store.save(fixtureView({
        taskId: `task-bytes-${index}`,
        createdAt: 1_700_000_000_000 + index,
        diff: { ...fixtureView().diff, patchText: 'p'.repeat(4096) },
      }));
    }
    const raw = await readFile(historyFile(dir), 'utf8');
    assert.equal(Buffer.byteLength(raw, 'utf8') <= 16 * 1024, true);
    const views = await store.load();
    assert.equal(views.length > 0, true);
    assert.equal(views[0].taskId, 'task-bytes-9', 'the newest view is retained');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a live view is never evicted; the save refuses instead', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir, { maxEntries: 1, maxBytes: 64 * 1024, maxEntryBytes: 16 * 1024 });
    await store.save(fixtureView({ taskId: 'task-live', state: 'running', endedAt: null }));

    await rejectsWith(store.save(fixtureView({ taskId: 'task-terminal' })), HISTORY_CODES.limitExceeded);

    const views = await store.load();
    assert.deepEqual(views.map((job) => job.taskId), ['task-live']);
    assert.equal(views[0].state, 'running');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a save updates an existing view in place without duplicating it', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({ taskId: 'task-upsert', state: 'running', endedAt: null, review: null }));
    await store.save(fixtureView({ taskId: 'task-upsert', state: 'awaiting-host-review', endedAt: 1_700_000_002_000 }));

    const views = await store.load();
    assert.equal(views.length, 1);
    assert.equal(views[0].state, 'awaiting-host-review');
    assert.equal(views[0].endedAt, 1_700_000_002_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('input views are not mutated and loaded views are detached', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const view = fixtureView();
    const snapshot = structuredClone(view);
    await store.save(view);
    assert.deepEqual(view, snapshot, 'the caller still owns its view');

    const first = await store.load();
    first[0].taskId = 'mutated';
    first[0].execution.usage.totalTokens = 999;
    first[0].diff.files.push({ code: 'A', path: 'injected.js', from: null });

    const second = await store.load();
    assert.equal(second[0].taskId, 'task-fixture-1');
    assert.equal(second[0].execution.usage.totalTokens, 49);
    assert.equal(second[0].diff.files.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a prototype-polluting view cannot reach Object.prototype', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const view = fixtureView();
    view.error = {
      code: 'JOB_FAILED',
      message: 'boom',
      details: JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"safe":1}'),
    };
    await store.save(view);
    const [job] = await store.load();
    assert.equal({}.polluted, undefined, 'Object.prototype must stay clean');
    assert.equal(job.error.details.safe, 1);
    assert.equal(Object.hasOwn(job.error.details, '__proto__'), false);
    assert.equal(Object.hasOwn(job.error.details, 'constructor'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dispose flushes the last save and refuses every later save', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const pending = store.save(fixtureView({ taskId: 'task-flushed' }));
    await store.dispose();
    await pending;
    await store.flush();
    const [job] = await new HistoryStore(dir).load();
    assert.equal(job.taskId, 'task-flushed');
    await rejectsWith(store.save(fixtureView({ taskId: 'task-late' })), HISTORY_CODES.disposed);
    await store.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bounds are validated at construction and an unusable view is refused', async () => {
  const dir = await dataDir();
  try {
    assert.throws(() => new HistoryStore(''), TypeError);
    assert.throws(() => new HistoryStore(dir, { maxEntries: 0 }), TypeError);
    assert.throws(() => new HistoryStore(dir, { maxEntryBytes: 1024 }), TypeError);
    assert.throws(() => new HistoryStore(dir, { maxBytes: 4096, maxEntryBytes: 8192 }), TypeError);

    const store = new HistoryStore(dir);
    await rejectsWith(store.save({ state: 'running' }), HISTORY_CODES.viewInvalid);
    await rejectsWith(store.save(fixtureView({ state: 'approved' })), HISTORY_CODES.viewInvalid);
    await rejectsWith(store.save(null), HISTORY_CODES.viewInvalid);
    assert.deepEqual(await store.load(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('timestamps and counters are stored only as finite numbers', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({
      createdAt: Number.NaN,
      startedAt: -5,
      endedAt: 1e300,
      execution: {
        ...fixtureView().execution,
        usage: { inputTokens: 12, outputTokens: -1, totalTokens: Number.POSITIVE_INFINITY, reasoningTokens: 4 },
      },
    }));
    const [job] = await store.load();
    assert.equal(job.createdAt, null);
    assert.equal(job.startedAt, null);
    assert.equal(job.endedAt, null);
    assert.deepEqual(job.execution.usage, { inputTokens: 12, reasoningTokens: 4 });
    assert.equal(Number.isFinite(job.execution.usage.inputTokens), true);

    const raw = await readFile(historyFile(dir), 'utf8');
    assert.equal(raw.includes('Infinity'), false);
    assert.equal(raw.includes('NaN'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Activity metadata: safe round-trip and interrupted semantics
// ---------------------------------------------------------------------------

/**
 * An activity block shaped exactly like the engine's projection.
 * @param {object} [overrides] - fields to replace.
 * @returns {object} activity summary.
 */
function fixtureActivity(overrides = {}) {
  return {
    lastActivityAt: 1_700_000_001_500,
    idleForMs: 12_000,
    waitingOn: 'tool',
    currentTool: { name: 'bash', callId: 'call-1', startedAt: 1_700_000_001_500, elapsedMs: 12_000 },
    lastTool: { name: 'read', durationMs: 340 },
    events: 41,
    activityEvents: 17,
    toolCallsStarted: 3,
    toolCallsFinished: 2,
    selfCheckSeconds: 300,
    attentionSeconds: 600,
    selfCheck: { episode: 4, checkedAt: 1_700_000_030_000, verdict: 'tool-running' },
    kinds: { 'text-delta': 9, 'tool-call': 3, 'tool-result': 2 },
    repeatFailure: { threshold: 3, reported: [] },
    ...overrides,
  };
}

test('the stored repeated-failure evidence keeps only bounded facts', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({
      activity: fixtureActivity({
        repeatFailure: {
          threshold: 3,
          reported: [{
            kind: 'repeated-tool-failure',
            toolName: 'bash',
            failureCode: 'ENOENT',
            operationDigest: 'b'.repeat(16),
            consecutive: 3,
            threshold: 3,
            firstSeenAt: 1_700_000_010_000,
            // A field the engine never produces: it must not survive the projection.
            arguments: 'SECRET ARGUMENTS',
            output: 'SECRET OUTPUT',
          }],
        },
      }),
    }));
    await store.flush();
    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.activity.repeatFailure.threshold, 3);
    assert.equal(row.activity.repeatFailure.reported.length, 1);
    const entry = row.activity.repeatFailure.reported[0];
    assert.equal(entry.toolName, 'bash');
    assert.equal(entry.failureCode, 'ENOENT');
    assert.equal(entry.consecutive, 3);
    const serialized = JSON.stringify(row);
    for (const secret of ['SECRET ARGUMENTS', 'SECRET OUTPUT']) {
      assert.equal(serialized.includes(secret), false, `stored history must not carry ${secret}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a bounded activity summary round-trips through the file unchanged', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({ activity: fixtureActivity() }));
    await store.flush();
    const reloaded = new HistoryStore(dir);
    const [row] = await reloaded.load();
    assert.equal(row.activity.events, 41);
    assert.equal(row.activity.activityEvents, 17);
    assert.equal(row.activity.waitingOn, 'tool');
    assert.equal(row.activity.currentTool.name, 'bash');
    assert.equal(row.activity.currentTool.elapsedMs, 12_000);
    assert.equal(row.activity.kinds['text-delta'], 9);
    assert.equal(row.activity.selfCheck.verdict, 'tool-running');
    assert.equal(row.activity.selfCheckSeconds, 300);
    // Storing and reloading twice must not rewrite the document.
    const first = await readFile(historyFile(dir), 'utf8');
    await new HistoryStore(dir).load();
    assert.equal(await readFile(historyFile(dir), 'utf8'), first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('activity content that is not metadata can never reach the file', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({
      activity: fixtureActivity({
        // A hostile/over-eager summary: text, reasoning, arguments and results.
        text: 'MODEL OUTPUT TEXT',
        reasoning: 'PRIVATE CHAIN OF THOUGHT',
        currentTool: {
          name: 'bash',
          callId: 'call-1',
          startedAt: 1_700_000_001_500,
          elapsedMs: 12_000,
          arguments: '{"command":"curl -H Authorization: Bearer sk-live-abcdefghijklmnop"}',
          result: 'TOOL RESULT BODY',
        },
        transcript: [{ role: 'assistant', text: 'PRIVATE ANSWER' }],
        kinds: { 'text-delta': 9, 'made-up-kind-with-a-secret': 'sk-live-abcdefghijklmnop' },
      }),
    }));
    await store.flush();
    const raw = await readFile(historyFile(dir), 'utf8');
    for (const forbidden of ['MODEL OUTPUT TEXT', 'PRIVATE CHAIN', 'TOOL RESULT BODY', 'PRIVATE ANSWER', 'sk-live']) {
      assert.equal(raw.includes(forbidden), false, `${forbidden} must not be stored`);
    }
    const [row] = await new HistoryStore(dir).load();
    assert.equal(Object.hasOwn(row.activity, 'text'), false);
    assert.equal(Object.hasOwn(row.activity.currentTool, 'arguments'), false);
    assert.equal(row.activity.kinds['made-up-kind-with-a-secret'], undefined, 'a non-numeric counter is dropped');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an interrupted run reports its activity as interrupted, never as a growing idle span', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({
      taskId: 'task-live',
      state: 'running',
      phase: 'execute',
      endedAt: null,
      activity: fixtureActivity(),
    }));
    await store.flush();

    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.state, 'interrupted');
    assert.equal(row.interruptedFrom, 'running');
    assert.equal(row.endedAt > 0, true, 'the interrupt is stamped');
    assert.equal(row.activity.interrupted, true);
    // The open span is closed and preserved as evidence rather than reported as
    // current: a restarted record must not claim a tool is still running.
    assert.equal(row.activity.currentTool, null);
    assert.equal(row.activity.waitingOn, null);
    assert.equal(row.activity.idleForMs, null);
    assert.equal(row.activity.interruptedTool.name, 'bash');
    assert.equal(row.activity.interruptedTool.callId, 'call-1');
    // The bounded counts survive, so history still says how much work happened.
    assert.equal(row.activity.events, 41);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history records no executor, no session and no way to replay an approval', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({
      state: 'running',
      activity: fixtureActivity(),
      execution: null,
      permission: {
        bridged: true,
        waiting: true,
        pending: {
          requestId: 'permission-1',
          taskId: 'task-fixture-1',
          callId: 'call-1',
          toolName: 'bash',
          state: 'pending',
          fingerprint: 'a'.repeat(64),
          arguments: '{"command":"npm test"}',
          completeness: 'complete',
        },
        evidence: [],
        pausedExecutionMs: 5000,
      },
    }));
    await store.flush();
    const raw = await readFile(historyFile(dir), 'utf8');
    // The manager/agent/session VALUES are never projected, and the exact
    // fingerprint is deliberately absent from a stored request. (The permission
    // view carries a `sessionId` KEY with a null value by its own allow-list, so
    // this asserts on values rather than on key names.)
    const parsed = JSON.parse(raw);
    const anywhere = JSON.stringify(parsed);
    for (const forbidden of ['agent-fixture-1', 'session-fixture-1', 'a'.repeat(64)]) {
      assert.equal(anywhere.includes(forbidden), false, `${forbidden} must not be stored`);
    }
    const stored = parsed.jobs[0];
    assert.equal(Object.hasOwn(stored, 'controller'), false);
    assert.equal(Object.hasOwn(stored, 'handle'), false);
    assert.equal(stored.execution, null);
    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.activity.interrupted, true);
    assert.equal(row.permission.pending.state, 'unavailable', 'a stored request can never be decided');
    assert.equal(row.permission.interrupted, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the frozen monitoring thresholds are stored with the effective snapshot', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const view = fixtureView();
    // A monitor and the task it measures must agree after a restart, and the live
    // settings may have changed since.
    view.effective = {
      ...view.effective,
      monitoring: { selfCheckSeconds: 120, attentionSeconds: 240 },
    };
    view.activity = fixtureActivity({ selfCheckSeconds: 120, attentionSeconds: 240, finalizedAt: view.endedAt });
    await store.save(view);
    await store.flush();

    const [row] = await new HistoryStore(dir).load();
    // A record written before the failure count existed carries `null` for it rather
    // than inventing a threshold the task never ran under.
    assert.deepEqual(row.effective.monitoring,
      { selfCheckSeconds: 120, attentionSeconds: 240, repeatFailureThreshold: null });
    // The activity block keeps the same thresholds, so a stored "idle for 12 min"
    // can still be interpreted against the threshold it was measured under.
    assert.equal(row.activity.selfCheckSeconds, 120);
    assert.equal(row.activity.attentionSeconds, 240);
    assert.equal(row.activity.finalizedAt, view.endedAt, 'a final span is marked as final');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a frozen activity record does not drift between loads', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const view = fixtureView();
    view.activity = fixtureActivity({ finalizedAt: view.endedAt, idleForMs: 120_000 });
    await store.save(view);
    await store.flush();
    const first = await readFile(historyFile(dir), 'utf8');
    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.activity.idleForMs, 120_000);
    // Reloading rewrites nothing: a stored span is already the final one.
    assert.equal(await readFile(historyFile(dir), 'utf8'), first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an interrupted record keeps the cut-off tool call as evidence', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({
      state: 'running',
      endedAt: null,
      activity: fixtureActivity(),
    }));
    await store.flush();
    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.activity.interrupted, true);
    assert.equal(row.activity.currentTool, null);
    // The call that was in flight is preserved, not deleted: it is how a reader
    // learns the run was cut off mid-tool rather than simply idle.
    assert.equal(row.activity.interruptedTool.name, 'bash');
    assert.equal(row.activity.interruptedTool.callId, 'call-1');
    assert.equal(typeof row.activity.interruptedTool.elapsedMs, 'number');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Title and continuation reference: existing facts only, never inferred
// ---------------------------------------------------------------------------

test('an explicit CJK and emoji title at the engine 48-element bound survives unchanged', async () => {
  const dir = await dataDir();
  try {
    // The engine names a task with at most 48 user-perceived characters, so a title at that
    // bound must be stored and read back character for character — no trim, no ellipsis, no
    // re-derived name. The CJK characters are one UTF-16 unit each and the emoji two, so the
    // unit length differs from the element count while the element count is exactly 48.
    const title = `${'修复历史投影😀🧪保留标题与续接引用'}${'好'.repeat(21)}${'😀'.repeat(10)}`;
    assert.equal(Array.from(title).length, 48, 'the fixture is the engine bound');
    assert.equal(title.length, 60, 'UTF-16 length differs from the element count');
    assert.notEqual(Array.from(title).length, title.length);
    const store = new HistoryStore(dir);
    const saved = await store.save(fixtureView({ title, continueFromTaskId: null }));
    await store.flush();
    assert.equal(saved.title, title);
    assert.equal(saved.truncation ?? null, null, 'a normal title is never marked as cut');
    assert.equal(saved.continueFromTaskId ?? null, null, 'an independent first round names no parent');

    const document = await readDocument(dir);
    assert.equal(document.jobs[0].title, title);

    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.title, title);
    assert.equal(row.continueFromTaskId ?? null, null);
    assert.equal(Array.from(row.title).length, 48, 'no character is dropped or added');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a record with no title, a blank title or a non-string title stores null and invents nothing', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const cases = [
      ['task-no-title', {}],
      ['task-blank-title', { title: '   ' }],
      ['task-null-title', { title: null }],
      ['task-number-title', { title: 42 }],
      ['task-object-title', { title: { text: '标题' } }],
    ];
    for (const [taskId, extra] of cases) {
      const view = fixtureView({ taskId, createdAt: 1_700_000_000_000, ...extra });
      if (!Object.hasOwn(extra, 'title')) delete view.title;
      // Text the engine WOULD have named this task after. It must not become a title now.
      // Only the PROMPT is planted: the execution and review blocks store their own
      // pre-existing `text` by design, so they are checked where they belong — the title.
      view.prompt = '目标：从提示词造出的标题';
      const saved = await store.save(view);
      assert.equal(saved.title ?? null, null, `${taskId} must store no title`);
    }
    await store.flush();
    const raw = await readFile(historyFile(dir), 'utf8');
    assert.equal(raw.includes('从提示词造出的标题'), false, 'a prompt is never turned into a stored title');
    const rows = await new HistoryStore(dir).load();
    assert.equal(rows.length, cases.length);
    for (const row of rows) {
      // Absent and `null` are the same reading: no title and no reference.
      assert.equal(row.title ?? null, null);
      assert.equal(row.continueFromTaskId ?? null, null);
    }

    // Neither the execution output, the review text, the task id nor the timing becomes a
    // title: reading a row back yields exactly the null that was stored.
    await store.save(fixtureView({
      taskId: 'task-texts-not-titles',
      createdAt: 1_700_000_000_001,
      execution: { ...fixtureView().execution, text: 'EXECUTION TEXT SHOULD NOT BE A TITLE' },
      review: { ...fixtureView().review, text: 'REVIEW TEXT SHOULD NOT BE A TITLE' },
    }));
    await store.flush();
    const withTexts = (await new HistoryStore(dir).load()).find((row) => row.taskId === 'task-texts-not-titles');
    assert.equal(withTexts.title ?? null, null);
    assert.equal(withTexts.execution.text, 'EXECUTION TEXT SHOULD NOT BE A TITLE', 'the pre-existing execution text field is unchanged');
    assert.equal(withTexts.review.text, 'REVIEW TEXT SHOULD NOT BE A TITLE');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a title is redacted on the way in but its ordinary text survives', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({ title: `修复 ${SECRET} 相关的标题` }));
    await store.flush();
    const raw = await readFile(historyFile(dir), 'utf8');
    assert.equal(raw.includes(SECRET), false, 'a credential shape in a title is masked');
    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.title.includes(SECRET), false);
    assert.equal(row.title.includes('修复'), true, 'the ordinary part of the title is kept');
    assert.equal(row.title.includes('相关的标题'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an over-bound title is cut once with the truncation marker and is stable across reloads', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const long = '题'.repeat(300);
    const saved = await store.save(fixtureView({ taskId: 'task-long-title', title: long }));
    // The existing bounded-text rule, not a special title rule: 256 kept + the shared marker.
    assert.equal(saved.title, `${'题'.repeat(256)}… [truncated]`);
    assert.equal(saved.title.startsWith(long.slice(0, 256)), true);
    assert.deepEqual(saved.truncation.fields, ['title'], 'the cut is stated, not silent');
    assert.equal(saved.truncation.dropped.length, 0);
    // The title still fits inside the engine's own 48-element budget, so this only comes
    // from a caller that passed something longer.
    assert.equal(Array.from(saved.title).length, 269);
    await store.flush();

    const first = await readFile(historyFile(dir), 'utf8');
    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.title, saved.title, 'the stored title reads back exactly as written');
    assert.deepEqual(row.truncation.fields, ['title'], 'the marker survives the reload');
    // A second load changes nothing: the cut is recorded once, never re-applied.
    assert.equal(await readFile(historyFile(dir), 'utf8'), first, 'a reload is idempotent');

    // Saving the same record again does not double-mark the title.
    const again = await store.save(fixtureView({ taskId: 'task-long-title', title: row.title }));
    assert.equal(again.title, saved.title);
    assert.equal(again.title.includes('[truncated]… [truncated]'), false);
    assert.deepEqual(again.truncation.fields, ['title']);
    await store.flush();
    const [reread] = await new HistoryStore(dir).load();
    assert.equal(reread.title, saved.title);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an explicit continuation reference survives a restart and is never validated or inferred', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    // The parent is never saved here: an explicit reference is stored even when the record
    // it names is absent from this document, and it is never attached to anything.
    const saved = await store.save(fixtureView({
      taskId: 'task-child',
      continueFromTaskId: '  task-parent-único-😀  ',
    }));
    assert.equal(saved.continueFromTaskId, 'task-parent-único-😀', 'only the surrounding whitespace is removed');
    await store.flush();

    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.continueFromTaskId, 'task-parent-único-😀');
    // The row is exactly the record that was saved: the reference did not add a parent
    // record, a conversation fact or any other relationship.
    assert.equal((await store.load()).length, 1, 'no parent record is created from a reference');
    assert.equal(row.execution.conversation ?? null, null, 'no conversation fact is invented from the reference');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a malformed, oversized or self-referential continuation reference stores null', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const longId = `task-${'x'.repeat(251)}`;
    assert.equal(longId.length, 256);
    const cases = [
      ['task-ref-blank', { continueFromTaskId: '   ' }],
      ['task-ref-empty', { continueFromTaskId: '' }],
      ['task-ref-number', { continueFromTaskId: 42 }],
      ['task-ref-object', { continueFromTaskId: { taskId: 'task-parent' } }],
      ['task-ref-too-long', { continueFromTaskId: `${longId}x` }],
      ['task-ref-self', { continueFromTaskId: ' task-ref-self ' }],
    ];
    for (const [taskId, extra] of cases) {
      const saved = await store.save(fixtureView({ taskId, createdAt: 1_700_000_000_000, ...extra }));
      assert.equal(saved.continueFromTaskId ?? null, null, `${taskId} must store no reference`);
    }
    // A reference at the same bound as a stored task id is kept whole (not cut).
    const atBound = await store.save(fixtureView({ taskId: 'task-ref-at-bound', createdAt: 1_700_000_000_001, continueFromTaskId: longId }));
    assert.equal(atBound.continueFromTaskId, longId);
    await store.flush();

    const rows = await new HistoryStore(dir).load();
    const stored = new Map(rows.map((row) => [row.taskId, row]));
    for (const [taskId] of cases) assert.equal(stored.get(taskId).continueFromTaskId ?? null, null);
    assert.equal(stored.get('task-ref-at-bound').continueFromTaskId, longId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two independent records with the same title stay separate and unrelated', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const shared = '同名任务标题 😀';
    // Same title, no continuation on either: two independent rounds, not a chain.
    await store.save(fixtureView({ taskId: 'task-twin-1', createdAt: 1_000, title: shared }));
    await store.save(fixtureView({ taskId: 'task-twin-2', createdAt: 2_000, title: shared }));
    await store.flush();

    const rows = await new HistoryStore(dir).load();
    assert.equal(rows.length, 2, 'a shared title never merges two records');
    const [newer, older] = rows;
    assert.equal(newer.taskId, 'task-twin-2', 'load is newest first');
    assert.equal(older.taskId, 'task-twin-1');
    for (const row of rows) {
      assert.equal(row.title, shared, 'each record keeps the title it was saved with');
      assert.equal(row.continueFromTaskId ?? null, null, 'a similar title is not a continuation');
    }
    // Neither record grew a reference to the other, and no third record appeared.
    const document = await readDocument(dir);
    assert.equal(document.jobs.length, 2);
    assert.equal(JSON.stringify(document).includes('task-twin-1'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a child keeps its explicit reference after the parent record is evicted', async () => {
  const dir = await dataDir();
  try {
    // Room for two records only: saving the child pushes the parent out.
    const store = new HistoryStore(dir, { maxEntries: 2 });
    await store.save(fixtureView({ taskId: 'task-parent-evicted', createdAt: 1_000, title: '将被裁剪的父任务' }));
    await store.save(fixtureView({ taskId: 'task-sibling', createdAt: 2_000 }));
    const saved = await store.save(fixtureView({
      taskId: 'task-child-kept',
      createdAt: 3_000,
      continueFromTaskId: 'task-parent-evicted',
    }));
    assert.equal(saved.continueFromTaskId, 'task-parent-evicted');
    await store.flush();

    const rows = await new HistoryStore(dir).load();
    const ids = rows.map((row) => row.taskId).sort();
    assert.deepEqual(ids, ['task-child-kept', 'task-sibling'], 'the oldest record was evicted');
    const child = rows.find((row) => row.taskId === 'task-child-kept');
    // The reference names a record that is no longer in the document. It is kept as the
    // recorded REQUEST: the child is not deleted, not re-homed onto the surviving sibling,
    // and nothing about the evicted parent is invented.
    assert.equal(child.continueFromTaskId, 'task-parent-evicted');
    assert.equal(child.title ?? null, null, 'the evicted parent title is not borrowed');
    const sibling = rows.find((row) => row.taskId === 'task-sibling');
    assert.equal(sibling.continueFromTaskId ?? null, null, 'the sibling is not made the parent');
    // A restart reads the same facts back.
    const [reloadedChild] = (await new HistoryStore(dir, { maxEntries: 2 }).load())
      .filter((row) => row.taskId === 'task-child-kept');
    assert.equal(reloadedChild.continueFromTaskId, 'task-parent-evicted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a legacy record without the new keys is not rewritten just to add them', async () => {
  const dir = await dataDir();
  try {
    // A record exactly as an earlier release wrote it: neither field exists. It is a
    // shape-stable record (no missing block the re-projection would fill in and no live
    // state to normalize), so the only reason the document could change is the two new
    // keys — and they are omitted rather than added as `null`.
    const legacy = {
      taskId: 'task-legacy',
      state: 'awaiting-host-review',
      phase: 'awaiting-host-review',
      createdAt: 1_700_000_000_000,
      startedAt: 1_700_000_000_100,
      endedAt: 1_700_000_000_900,
      sourcePath: null,
      workspacePath: null,
      executionWorkspacePath: null,
      sourcePathDigest: null,
      executionPathDigest: null,
      workspaceId: null,
      sessionId: null,
      isolation: null,
      interruptedFrom: null,
      connectionId: 'conn-legacy',
      effective: null,
      route: null,
      reviewRoute: null,
      reviewRouteError: null,
      worktree: null,
      baseline: null,
      diff: null,
      execution: null,
      review: null,
      permission: null,
      activity: null,
      error: null,
      cancelledBy: null,
      hostAcceptance: null,
      agentTeams: null,
      team: null,
      selfApproved: false,
    };
    assert.equal(Object.hasOwn(legacy, 'title'), false);
    assert.equal(Object.hasOwn(legacy, 'continueFromTaskId'), false);
    // Written in the same compact serialization the store itself uses, so a rewrite would
    // show up as a difference rather than as formatting.
    const raw = `${JSON.stringify({ schemaVersion: 1, updatedAt: 1_700_000_001_000, jobs: [legacy] })}\n`;
    await writeDocument(dir, raw);

    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.taskId, 'task-legacy');
    assert.equal(row.title ?? null, null, 'a stored record without a title says so instead of guessing');
    assert.equal(row.continueFromTaskId ?? null, null);
    // This load writes nothing: neither the stored job record nor the update stamp changed.
    assert.deepEqual(await readDocument(dir), { schemaVersion: 1, updatedAt: 1_700_000_001_000, jobs: [legacy] });
    assert.equal(await readFile(historyFile(dir), 'utf8'), raw);
    assert.equal((await new HistoryStore(dir).load())[0].title ?? null, null);
    assert.equal(await readFile(historyFile(dir), 'utf8'), raw);

    // A legacy record that was LIVE when the process stopped IS normalized and persisted —
    // the existing load-writes-on-change rule is unchanged — and that rewrite still adds no
    // title and no reference.
    await writeDocument(dir, {
      schemaVersion: 1,
      updatedAt: 1_700_000_001_000,
      jobs: [{ ...legacy, taskId: 'task-legacy-live', state: 'running', endedAt: null }],
    });
    const [interrupted] = await new HistoryStore(dir).load();
    assert.equal(interrupted.state, 'interrupted');
    assert.equal(interrupted.title ?? null, null);
    assert.equal(interrupted.continueFromTaskId ?? null, null);
    const normalized = await readDocument(dir);
    assert.equal(normalized.jobs[0].state, 'interrupted', 'the existing normalization is persisted once');
    assert.equal(Object.hasOwn(normalized.jobs[0], 'title'), false, 'the normalization adds no title key');
    assert.equal(Object.hasOwn(normalized.jobs[0], 'continueFromTaskId'), false);
    // A second load of the normalized document is stable.
    const afterNormalization = await readFile(historyFile(dir), 'utf8');
    await new HistoryStore(dir).load();
    assert.equal(await readFile(historyFile(dir), 'utf8'), afterNormalization);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a stored over-bound title is read back cut and marked, and the reload is idempotent', async () => {
  const dir = await dataDir();
  try {
    // A document another build wrote: the title is past the shared bound. It must stay
    // loadable, be bounded with the shared marker, and be stable on the next load.
    const stored = {
      taskId: 'task-big-title',
      state: 'awaiting-host-review',
      phase: 'awaiting-host-review',
      createdAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_000,
      connectionId: 'conn-big',
      title: `头部${'多'.repeat(4096)}`,
      continueFromTaskId: 'task-parent',
      hostAcceptance: null,
      selfApproved: false,
    };
    await writeDocument(dir, { schemaVersion: 1, updatedAt: 1_700_000_001_000, jobs: [stored] });
    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.title, `头部${'多'.repeat(254)}… [truncated]`, 'the readable prefix is kept and the cut stated');
    assert.equal(row.continueFromTaskId, 'task-parent', 'a reference in the same row is unaffected');

    // The bounded form is what the document now holds, and reloading it changes nothing.
    const afterFirst = await readFile(historyFile(dir), 'utf8');
    const [again] = await new HistoryStore(dir).load();
    assert.equal(again.title, row.title);
    assert.equal(await readFile(historyFile(dir), 'utf8'), afterFirst, 'the second load is a no-op');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('identifying fields survive an entry fitted to its smallest budget', async () => {
  const dir = await dataDir();
  try {
    const limits = { maxEntries: 4, maxBytes: 64 * 1024, maxEntryBytes: 4096 };
    const title = '标题😀 与续接引用';
    const store = new HistoryStore(dir, limits);
    const saved = await store.save(fixtureView({
      title,
      continueFromTaskId: 'task-parent-fit',
      diff: { ...fixtureView().diff, patchText: 'p'.repeat(64 * 1024) },
      execution: { ...fixtureView().execution, text: 'e'.repeat(64 * 1024) },
    }));
    assert.equal(Buffer.byteLength(JSON.stringify(saved), 'utf8') <= 4096, true);
    assert.equal(saved.title, title, 'a normal title is kept whole beside a fitted entry');
    assert.equal(saved.continueFromTaskId, 'task-parent-fit', 'the reference is never cut by the entry fitter');
    assert.equal(saved.diff.patchText.endsWith('… [truncated]'), true, 'the existing cut rule still applies to text');
    await store.flush();

    const [row] = await new HistoryStore(dir, limits).load();
    assert.equal(row.title, title);
    assert.equal(row.continueFromTaskId, 'task-parent-fit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restoring a legacy model review preserves the separate host conclusion', async () => {
  const dir = await dataDir();
  try {
    const history = new HistoryStore(dir);
    const legacy = fixtureView({
      review: {
        state: 'completed',
        verdict: { verdict: 'changes-requested', reason: 'Historical model suggestion' },
        text: 'Historical model findings',
      },
      hostAcceptance: {
        state: 'accepted', accepted: true, note: 'Verified by the host',
        completionSummary: 'Host summary', by: 'host', acceptedAt: 1_700_000_000_500,
      },
    });
    await history.save(legacy);
    const [restored] = await new HistoryStore(dir).load();
    assert.equal(restored.review.text, 'Historical model findings');
    assert.equal(restored.review.verdict.verdict, 'changes-requested');
    assert.equal(restored.hostAcceptance.state, 'accepted');
    assert.equal(restored.hostAcceptance.note, 'Verified by the host');
    assert.equal(restored.hostAcceptance.completionSummary, 'Host summary');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
