// G01-B: the two explicit prose fields of a task record.
//
// `goalDescription` is what the commander said this round of work was FOR, stated at
// submission. `hostAcceptance.completionSummary` is what the commander said was actually
// DONE, stated at review. Both are optional, both are bounded in Unicode CODE POINTS, and
// both must survive the whole chain — MCP → HTTP → JobEngine → HistoryStore → a fresh read
// after a restart — without being silently shortened, coerced or invented.
//
// The rules these tests pin, in the order the sections cover them:
//
//   1. the pure field rule (bound, trim, type refusal, code points vs UTF-16);
//   2. the store: what is written, what is omitted, what a write refuses, and what a load of
//      another writer's document does (bounded with a marker, idempotent on reload);
//   3. the engine: a validation before any side effect, a goal frozen at creation, and a
//      completion summary that is published only once the write confirmed it;
//   4. the review identity: the same decision + note + summary is a no-op, and ANY change —
//      including only the summary — is refused;
//   5. the wire: the real MCP server and the real HTTP handler against the real engine and a
//      real HistoryStore, read back from a NEW store instance as a restart would;
//   6. the projections: a wait carries lengths and omission flags, never the prose, and a
//      small entry budget refuses a legal summary instead of shortening it.
//
// Only the native executor is faked. No model, credential or network is reached.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JobEngine, JOB_CODES, REVIEW_PERSISTENCE_STATES, TASK_STATES } from '../src/jobs/engine.js';
import { HISTORY_CODES, HistoryStore } from '../src/jobs/history.js';
import { redactText } from '../src/config/redact.js';
import {
  TASK_DESCRIPTION_MAX_CHARS,
  canonicalTaskDescription,
  normalizeTaskDescription,
  readTaskDescription,
  taskDescriptionLength,
  taskDescriptionPresent,
  truncateTaskDescription,
} from '../src/jobs/task-descriptions.js';
import { SettingsService } from '../src/config/settings.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import { AuthorizationRegistry } from '../src/auth/grants.js';
import { createExecutionHandler, EXECUTION_PREFIX } from '../src/http/execution-plane.js';
import { mockRequest, mockResponse } from './helpers/node-http-mocks.js';
import {
  createMcpServer,
  MAX_TASK_DESCRIPTION_CHARS,
  MAX_TOOL_TEXT_CHARS,
} from '../src/mcp/server.js';
import { compactTask } from '../src/mcp/wait.js';
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

/** Repository root, for the static type-declaration checks. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HEAD = 'b'.repeat(40);
/** Discriminator so every harness gets a workspace path no earlier run used. */
let nextWorkspace = 0;

/** A credential shape the plugin's redaction must mask. */
const SECRET = 'sk-g01b00000000000000000000';

/**
 * Git fake answering in the NUL-delimited shape the audit layer parses.
 * @returns {Function} runGit fake.
 */
function reviewGit() {
  return async (cwd, args) => {
    const key = args.join(' ');
    if (key === '--version') return { stdout: 'git version 2.0.0\n', code: 0 };
    if (key === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', code: 0 };
    if (key === 'rev-parse --verify HEAD') return { stdout: `${HEAD}\n`, code: 0 };
    if (args[0] === 'status') return { stdout: ' M src/a.js\u0000', code: 0 };
    if (args[0] === 'diff' && args[1] === '--numstat') return { stdout: '2\t0\tsrc/a.js\u0000', code: 0 };
    if (args[0] === 'diff') return { stdout: 'diff --git a/src/a.js b/src/a.js\n+implementation\n', code: 0 };
    return { stdout: '', code: 0 };
  };
}

/**
 * A public job view shaped like the engine's projection, for the store-only tests.
 * @param {object} [overrides] - fields to replace.
 * @returns {object} view.
 */
function fixtureView(overrides = {}) {
  const createdAt = 1_700_000_000_000;
  return {
    taskId: 'task-desc-1',
    state: 'awaiting-host-review',
    phase: 'awaiting-host-review',
    createdAt,
    startedAt: createdAt + 1_000,
    endedAt: createdAt + 2_000,
    sourcePath: 'C:\\fixtures\\repo',
    connectionId: 'conn-desc-1',
    diff: null,
    execution: null,
    review: null,
    error: null,
    cancelledBy: null,
    hostAcceptance: null,
    selfApproved: false,
    ...overrides,
  };
}

/** @returns {Promise<string>} one fresh data directory. */
async function dataDir() {
  return await makeTempDir();
}

/**
 * A real engine over a real HistoryStore on a temp directory, in switch mode.
 * @param {object} [options] - `limits` for the store, `agentsRespond` for the fake turn.
 * @returns {Promise<object>} harness.
 */
async function harness(options = {}) {
  const dir = await makeTempDir();
  const root = await mkdir(join(dir, 'workspace'), { recursive: true }).then(() => join(dir, 'workspace'));
  const unique = join(root, `ws-${(nextWorkspace += 1)}`);
  const workspace = await realpath(await mkdir(unique, { recursive: true }).then(() => unique));
  const settings = new SettingsService(join(dir, 'data'));
  await settings.replace(validSettings());
  const store = new HistoryStore(join(dir, 'data'), options.limits ?? {});
  const agents = fakeAgents({ respond: { text: 'implemented the change' } });
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({ workspaces, respond: { text: 'implemented the change' } });
  const services = await nativePolicyServices();
  const engine = new JobEngine({
    agents,
    agentPresets: {
      async mount(ctx) {
        ctx.tools.schemas = () => [{ name: 'read', description: 'read', parameters: {} }];
        return { id: 'default-preset' };
      },
    },
    sessions: { async flush() {} },
    workspaces,
    sessionController,
    policyServices: () => services,
    llm: fakeLlm({ providers: { 'relay-native': llmTable().relay } }),
    settings,
    auth: new AuthorizationRegistry(),
    locks: new WorkspaceLocks(),
    runGit: reviewGit(),
    providerRegistry: {
      async ensure(providers) {
        return { routes: new Map(providers.map((provider) => [provider.id, `${provider.id}-native`])) };
      },
    },
    history: store,
    delegationEnabled: true,
    authorizationMode: 'switch',
    logger: { info() {}, warn() {} },
  });
  return {
    dir,
    workspace,
    engine,
    settings,
    store,
    async close() {
      await engine.dispose();
      await store.flush().catch(() => undefined);
      await cleanup(dir);
    },
  };
}

/**
 * Start one task and wait for its run AND its terminal history write.
 * @param {object} h - harness.
 * @param {object} [request] - extra submission fields.
 * @returns {Promise<string>} task id.
 */
async function finishedTask(h, request = {}) {
  const started = await h.engine.start({
    connectionId: 'local-mcp', workspacePath: h.workspace, prompt: 'go', ...request,
  });
  await h.engine.tasks.get(started.taskId).settled;
  await h.store.flush();
  assert.equal(h.engine.get(started.taskId).state, TASK_STATES.awaitingHostReview, 'the fixture must really finish');
  return started.taskId;
}

/**
 * Invoke the real execution-plane handler for one JSON request.
 * @param {object} deps - handler deps.
 * @param {string} path - route path below the prefix.
 * @param {object} body - JSON body.
 * @returns {Promise<{ status: number, body: object }>} answer.
 */
async function callPlane(deps, path, body) {
  const handler = createExecutionHandler({ ...deps, getBindHost: () => '127.0.0.1' });
  const req = mockRequest({
    method: 'POST',
    url: `${EXECUTION_PREFIX}${path}`,
    headers: { host: '127.0.0.1' },
    body: JSON.stringify(body),
  });
  const res = mockResponse();
  await handler(req, res);
  return { status: res.status, body: res.parsed() };
}

/**
 * Route the MCP client's `fetch` onto the real execution-plane handler.
 *
 * Exactly what the standalone server does over HTTP: the client builds the URL, method,
 * headers and body, and the plane applies its fence, route table, authentication and
 * ownership rules. Nothing here bypasses a check the plane performs.
 * @param {Function} handler - node-style handler.
 * @param {string} origin - base URL the client is configured with.
 * @param {string[]} [seen] - collects `METHOD /path` for every request actually dispatched.
 * @returns {Promise<{ restore: () => void }>} the installed redirect.
 */
async function installPlaneFetch(handler, origin, seen = []) {
  const { Readable } = await import('node:stream');
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith(`${origin}/`), `the client must address its configured origin, saw ${String(url)}`);
    const target = new URL(String(url));
    seen.push(`${init?.method ?? 'GET'} ${target.pathname}`);
    const request = Readable.from(init?.body === undefined ? [] : [Buffer.from(init.body, 'utf8')]);
    request.url = `${target.pathname}${target.search}`;
    request.method = init?.method ?? 'GET';
    request.headers = { ...init?.headers };
    request.socket = { remoteAddress: '127.0.0.1' };
    if (request.headers.host === undefined) request.headers.host = target.host;
    const chunks = [];
    const headers = {};
    let status = 200;
    let done;
    const barrier = new Promise((resolvePromise) => { done = resolvePromise; });
    const response = {
      headersSent: false,
      writeHead(code, values) {
        status = code;
        this.headersSent = true;
        Object.assign(headers, values);
      },
      end(body) {
        if (body !== undefined && body !== null) chunks.push(Buffer.from(body));
        done();
      },
    };
    await handler(request, response);
    await barrier;
    return new Response(Buffer.concat(chunks).toString('utf8'), { status, headers });
  };
  return { restore() { globalThis.fetch = original; } };
}

/**
 * Boot a SECOND "process" over an existing data directory — a real restart.
 *
 * A new `HistoryStore` (so nothing is cached in this process), a new `SettingsService`, and a
 * new `JobEngine` whose task map starts empty. The engine is given the same fake native
 * services a fresh process would get, so only the DATA DIRECTORY is inherited.
 * @param {string} dir - the data/workspace directory the first process used.
 * @returns {Promise<{ engine: object, store: object, handler: Function, h: object }>} the new process.
 */
async function bootOver(dir) {
  const workspace = await realpath(join(dir, 'workspace', `ws-${nextWorkspace}`));
  const settings = new SettingsService(join(dir, 'data'));
  const store = new HistoryStore(join(dir, 'data'));
  const agents = fakeAgents({ respond: { text: 'implemented the change' } });
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({ workspaces, respond: { text: 'implemented the change' } });
  const services = await nativePolicyServices();
  const engine = new JobEngine({
    agents,
    agentPresets: {
      async mount(ctx) {
        ctx.tools.schemas = () => [{ name: 'read', description: 'read', parameters: {} }];
        return { id: 'default-preset' };
      },
    },
    sessions: { async flush() {} },
    workspaces,
    sessionController,
    policyServices: () => services,
    llm: fakeLlm({ providers: { 'relay-native': llmTable().relay } }),
    settings,
    auth: new AuthorizationRegistry(),
    locks: new WorkspaceLocks(),
    runGit: reviewGit(),
    providerRegistry: {
      async ensure(providers) {
        return { routes: new Map(providers.map((provider) => [provider.id, `${provider.id}-native`])) };
      },
    },
    history: store,
    delegationEnabled: true,
    authorizationMode: 'switch',
    logger: { info() {}, warn() {} },
  });
  const handler = createExecutionHandler({
    engine, auth: engine.auth, settings, logger: { warn() {} }, getBindHost: () => '127.0.0.1',
  });
  return {
    engine,
    store,
    handler,
    h: {
      async close() {
        await engine.dispose();
        await store.flush().catch(() => undefined);
      },
    },
  };
}

/**
 * Call one MCP tool and parse its JSON answer.
 * @param {object} mcp - MCP server.
 * @param {number} id - JSON-RPC id.
 * @param {string} name - tool name.
 * @param {object} args - arguments.
 * @returns {Promise<{ isError: boolean, text: string, body: object }>} the answer.
 */
async function callTool(mcp, id, name, args) {
  const answer = await mcp.handle({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  });
  const text = answer.result?.content?.[0]?.text ?? '';
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { unparsable: text };
  }
  return { isError: answer.result?.isError === true, text, body };
}

// ---------------------------------------------------------------------------
// 1. The pure field rule
// ---------------------------------------------------------------------------

test('the shared bound is 2000 code points and every surface reports the same number', () => {
  assert.equal(TASK_DESCRIPTION_MAX_CHARS, 2_000);
  assert.equal(MAX_TASK_DESCRIPTION_CHARS, TASK_DESCRIPTION_MAX_CHARS);
});

test('exactly 2000 code points is accepted and 2001 is refused, counted in code points', () => {
  // Chinese characters are one UTF-16 unit each; emoji are two. A 2000-code-point text of
  // emoji therefore has 4000 UTF-16 units and must STILL be accepted — measured in UTF-16 it
  // would be refused for being twice the real size.
  const emoji = '😀'.repeat(2_000);
  assert.equal(taskDescriptionLength(emoji), 2_000);
  assert.equal(emoji.length, 4_000);
  const atLimit = readTaskDescription(emoji, 'goalDescription');
  assert.equal(atLimit.ok, true);
  assert.equal(atLimit.value, emoji, 'a legal value is kept exactly');

  const over = readTaskDescription(`${emoji}😀`, 'goalDescription');
  assert.equal(over.ok, false);
  assert.equal(over.refusal.length, 2_001);
  assert.equal(over.refusal.limit, 2_000);
  assert.equal(over.refusal.field, 'goalDescription');
  assert.equal(over.refusal.unit, 'unicode-code-points');
  assert.match(over.refusal.message, /at most 2000 Unicode code points, but it is 2001/u);
  // The refusal never echoes the body it refused.
  assert.equal(over.refusal.message.includes('😀'), false);
  assert.equal(JSON.stringify(over.refusal).includes('😀'), false);
});

test('only undefined and a blank string are absent; null and every other non-string is refused', () => {
  for (const blank of ['', '   ', '\n\t ']) {
    const read = readTaskDescription(blank, 'completionSummary');
    assert.equal(read.ok, true, `${JSON.stringify(blank)} must be accepted as absent`);
    assert.equal(read.value, null, 'a blank value is the same fact as no value');
  }
  // `undefined` alone means "the caller did not send the field".
  const missing = readTaskDescription(undefined, 'completionSummary');
  assert.equal(missing.ok, true);
  assert.equal(missing.value, null);
  // An explicit `null` is NOT absent: it is a value of the wrong type and is refused, so a
  // provider that sends null for every optional field cannot silently skip validation.
  const explicitNull = readTaskDescription(null, 'goalDescription');
  assert.equal(explicitNull.ok, false, 'an explicit null must be refused, not read as "none"');
  assert.equal(explicitNull.refusal.field, 'goalDescription');
  assert.equal(explicitNull.refusal.message, 'goalDescription must be a string of at most 2000 Unicode code points');
  // Every other type is refused too, so nothing is ever stored as `String(x)`.
  for (const wrong of [42, 0, true, false, {}, { text: '完成' }, ['完成'], [1]]) {
    const read = readTaskDescription(wrong, 'completionSummary');
    assert.equal(read.ok, false, `${JSON.stringify(wrong)} must be refused`);
    assert.equal(read.refusal.field, 'completionSummary');
    assert.equal(read.refusal.message, 'completionSummary must be a string of at most 2000 Unicode code points');
  }
  // `taskDescriptionPresent` states the same rule on its own.
  assert.equal(taskDescriptionPresent(undefined), false);
  assert.equal(taskDescriptionPresent('  '), false);
  assert.equal(taskDescriptionPresent(null), true, 'null IS something the caller sent');
  assert.equal(taskDescriptionPresent(0), true);
});

test('only surrounding whitespace is trimmed; inner newlines, Chinese and emoji are kept', () => {
  const text = '  目标：修复登录错误 🎯\n\n第二轮：补齐重启读取  \n';
  assert.equal(normalizeTaskDescription(text), '目标：修复登录错误 🎯\n\n第二轮：补齐重启读取');
  const read = readTaskDescription(text, 'goalDescription');
  assert.equal(read.ok, true);
  assert.equal(read.value, '目标：修复登录错误 🎯\n\n第二轮：补齐重启读取');
  assert.equal(read.length, Array.from(read.value).length);
});

test('a value that only exceeds the bound AFTER redaction is refused, not stored over the bound', () => {
  // Redaction can make a value LONGER: a temporary-directory profile key (`dsh-` plus six
  // characters) is replaced by a much longer mask. Measured before redaction the text fits;
  // measured after it, it does not. Only the canonical form can see this, and it must refuse.
  const key = 'Temp/dsh-abc123/work';
  const masked = redactText(key);
  assert.ok(Array.from(masked).length > Array.from(key).length, 'this mask really is longer than what it replaces');
  assert.equal(masked, 'Temp/masks-user-profile-segment/work');
  // Fill so the RAW text is exactly at the bound; the masked form then grows past it. The
  // key is followed by a newline so the pattern's trailing lookahead still matches it.
  const room = TASK_DESCRIPTION_MAX_CHARS - taskDescriptionLength(key) - 1;
  const value = `${key}\n${'好'.repeat(room)}`;
  assert.equal(taskDescriptionLength(value), TASK_DESCRIPTION_MAX_CHARS, 'the raw text fits exactly');
  assert.equal(taskDescriptionLength(redactText(value)) > TASK_DESCRIPTION_MAX_CHARS, true, 'the masked text does not');

  const refused = canonicalTaskDescription(value, 'goalDescription', redactText);
  assert.equal(refused.ok, false, 'an over-bound-after-redaction value must be refused');
  assert.equal(refused.refusal.field, 'goalDescription');
  assert.equal(refused.refusal.limit, TASK_DESCRIPTION_MAX_CHARS);
  assert.equal(refused.refusal.length, taskDescriptionLength(redactText(value)));
  // The refusal never echoes the text it refused.
  assert.equal(JSON.stringify(refused.refusal).includes('dsh-abc123/work'), false);
  assert.equal(JSON.stringify(refused.refusal).includes('好'), false);

  // Shorter by exactly the mask's growth, the masked form fits, and the canonical value is the
  // MASKED one — the single form that is stored, compared and published.
  const growth = taskDescriptionLength(masked) - taskDescriptionLength(key);
  assert.ok(growth > 0);
  const legal = `${key}\n${'好'.repeat(room - growth)}`;
  assert.equal(taskDescriptionLength(redactText(legal)) <= TASK_DESCRIPTION_MAX_CHARS, true,
    'this fixture really fits once masked');
  const kept = canonicalTaskDescription(legal, 'goalDescription', redactText);
  assert.equal(kept.ok, true);
  assert.equal(kept.value.includes('dsh-abc123/work'), false, 'the canonical value is already masked');
  assert.equal(kept.value.includes(masked), true);
  assert.equal(taskDescriptionLength(kept.value) <= TASK_DESCRIPTION_MAX_CHARS, true);
  // Applying the rule to the canonical value again changes nothing: one normalization.
  const again = canonicalTaskDescription(kept.value, 'goalDescription', redactText);
  assert.equal(again.ok, true);
  assert.equal(again.value, kept.value, 'canonicalization is idempotent');
});

test('a value that only exceeds the bound AFTER redaction is refused at every entry point', async () => {
  const key = 'Temp/dsh-abc123/work';
  const room = TASK_DESCRIPTION_MAX_CHARS - taskDescriptionLength(key) - 1;
  const value = `${key}\n${'好'.repeat(room)}`;
  assert.equal(taskDescriptionLength(value), TASK_DESCRIPTION_MAX_CHARS, 'the raw text fits exactly');
  assert.equal(taskDescriptionLength(redactText(value)) > TASK_DESCRIPTION_MAX_CHARS, true);

  // The engine: refused before a task exists, with the SUBMISSION's own code.
  const h = await harness();
  try {
    await assert.rejects(
      () => h.engine.start({
        connectionId: 'local-mcp', workspacePath: h.workspace, prompt: 'go', goalDescription: value,
      }),
      (error) => error.code === JOB_CODES.descriptionInvalid
        && error.details.field === 'goalDescription'
        && error.details.length === taskDescriptionLength(redactText(value)),
    );
    assert.equal(h.engine.list({ connectionId: 'local-mcp' }).length, 0, 'no task was created');
    assert.equal((await h.store.load()).length, 0, 'nothing was stored');
  } finally {
    await h.close();
  }

  // The HTTP route: refused with its own code before the engine is reached.
  const h2 = await harness();
  try {
    const deps = { engine: h2.engine, auth: h2.engine.auth, settings: h2.settings, logger: { warn() {} } };
    const refused = await callPlane(deps, '/tasks', {
      workspacePath: h2.workspace, prompt: 'go', goalDescription: value,
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, 'TASK_GOAL_DESCRIPTION_INVALID');
    assert.equal(refused.body.error.message.includes('dsh-abc123/work'), false, 'the body is never echoed');
    assert.equal(h2.engine.list({ connectionId: 'local-mcp' }).length, 0);
  } finally {
    await h2.close();
  }

  // The MCP surface: refused at the boundary, so nothing is forwarded.
  const seen = [];
  const mcp = createMcpServer({
    async callExecution(route, payload) { seen.push({ route, payload }); return { ok: true, task: { taskId: 't1' } }; },
  });
  await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const answer = await mcp.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'delegate_submit', arguments: { workspacePath: '/w', prompt: 'go', goalDescription: value } },
  });
  assert.equal(answer.result.isError, true, 'the over-bound-after-redaction goal is refused at the MCP surface');
  assert.deepEqual(seen, [], 'nothing is forwarded');
  assert.equal(answer.result.content[0].text.includes('dsh-abc123/work'), false, 'the refusal does not echo the text');

  // The same rule for a summary, through the engine and the review route.
  const h3 = await harness();
  try {
    const taskId = await finishedTask(h3);
    await assert.rejects(
      () => h3.engine.recordHostReview({
        connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'ok', completionSummary: value,
      }),
      (error) => error.code === JOB_CODES.reviewInvalid && error.details.field === 'completionSummary',
    );
    assert.equal(h3.engine.get(taskId).hostAcceptance, null, 'nothing was recorded');
    const deps = { engine: h3.engine, auth: h3.engine.auth, settings: h3.settings, logger: { warn() {} } };
    const routeRefusal = await callPlane(deps, '/tasks/review', {
      taskId, decision: 'accepted', note: 'ok', completionSummary: value,
    });
    assert.equal(routeRefusal.status, 400);
    assert.equal(routeRefusal.body.error.code, 'REVIEW_COMPLETION_SUMMARY_INVALID');
  } finally {
    await h3.close();
  }
});

test('truncating a stored value reserves room for the marker and can never split a surrogate pair', () => {
  const cut = truncateTaskDescription('😀'.repeat(3_000), 15);
  assert.equal(Array.from(cut).length, 1_985);
  assert.equal(cut.includes('\uFFFD'), false, 'no half surrogate pair is emitted');
  // A value already within the bound is returned untouched.
  assert.equal(truncateTaskDescription('短说明 🎯', 15), '短说明 🎯');
  assert.equal(truncateTaskDescription('', 15), null);
  assert.equal(truncateTaskDescription(42, 15), null);
});

// ---------------------------------------------------------------------------
// 2. The store
// ---------------------------------------------------------------------------

test('a goal and a completion summary round-trip through the document unchanged', async () => {
  const dir = await dataDir();
  try {
    const goal = '目标：让历史记录能说明「要做什么」😀\n第二行';
    const summary = '实际完成：历史白名单、重启读取与裁剪标记\n并且保留了旧记录';
    const store = new HistoryStore(dir);
    const saved = await store.save(fixtureView({
      goalDescription: goal,
      hostAcceptance: {
        accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: '通过',
        completionSummary: summary,
      },
    }));
    assert.equal(saved.goalDescription, goal);
    assert.equal(saved.hostAcceptance.completionSummary, summary);
    assert.equal(saved.truncation ?? null, null, 'a legal value is never marked as cut');
    await store.flush();

    const document = JSON.parse(await readFile(join(dir, 'history.json'), 'utf8'));
    assert.equal(document.jobs[0].goalDescription, goal);
    assert.equal(document.jobs[0].hostAcceptance.completionSummary, summary);
    // There is exactly ONE copy of the summary, inside the acceptance record.
    assert.equal(Object.hasOwn(document.jobs[0], 'completionSummary'), false, 'no second top-level copy');

    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.goalDescription, goal);
    assert.equal(row.hostAcceptance.completionSummary, summary);
  } finally {
    await cleanup(dir);
  }
});

test('an absent goal or summary adds no key, and nothing is invented from the result', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const saved = await store.save(fixtureView({
      execution: { outcome: 'completed', text: '实现完成', error: null },
      // A prompt and an execution outcome the engine would never turn into a goal.
      prompt: '这一段提示词不应该变成目标说明',
      hostAcceptance: {
        accepted: false, state: 'changes-requested', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: '需要修正',
      },
    }));
    assert.equal(Object.hasOwn(saved, 'goalDescription'), false, 'no key is added for a fact nobody stated');
    assert.equal(Object.hasOwn(saved.hostAcceptance, 'completionSummary'), false);
    await store.flush();
    const raw = await readFile(join(dir, 'history.json'), 'utf8');
    assert.equal(raw.includes('goalDescription'), false);
    assert.equal(raw.includes('completionSummary'), false);
    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.goalDescription ?? null, null);
    assert.equal(row.hostAcceptance.completionSummary ?? null, null);
  } finally {
    await cleanup(dir);
  }
});

test('a write refuses an over-bound or non-string description instead of storing a shortened one', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    // Over the bound on the goal.
    await assert.rejects(
      () => store.save(fixtureView({ goalDescription: '题'.repeat(2_001) })),
      (error) => error.code === HISTORY_CODES.viewInvalid
        && error.details.field === 'goalDescription'
        && error.details.length === 2_001
        && error.details.limit === 2_000,
    );
    // Over the bound on the summary, inside the acceptance record. The refusal names the path
    // a reader actually sees, so an operator can find the field the document holds.
    await assert.rejects(
      () => store.save(fixtureView({
        hostAcceptance: {
          accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: 'ok',
          completionSummary: '😀'.repeat(2_001),
        },
      })),
      (error) => error.code === HISTORY_CODES.viewInvalid
        && error.details.field === 'hostAcceptance.completionSummary'
        && error.details.length === 2_001,
    );
    // An explicit `null` is a value of the wrong type, so a WRITE refuses it too — for the
    // goal and for the summary. Silently storing "no goal" would report a different record as
    // saved than the caller proposed.
    await assert.rejects(
      () => store.save(fixtureView({ goalDescription: null })),
      (error) => error.code === HISTORY_CODES.viewInvalid && error.details.field === 'goalDescription',
    );
    await assert.rejects(
      () => store.save(fixtureView({
        hostAcceptance: {
          accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: 'ok',
          completionSummary: null,
        },
      })),
      (error) => error.code === HISTORY_CODES.viewInvalid
        && error.details.field === 'hostAcceptance.completionSummary',
    );
    // A non-string summary on a WRITE is refused rather than silently dropped: the caller
    // proposed a fact, and dropping it would report a different record as saved.
    await assert.rejects(
      () => store.save(fixtureView({
        hostAcceptance: {
          accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: 'ok',
          completionSummary: 42,
        },
      })),
      (error) => error.code === HISTORY_CODES.viewInvalid
        && error.details.field === 'hostAcceptance.completionSummary',
    );
    // Nothing was written by any of the refusals.
    assert.equal((await store.load()).length, 0);
    await assert.rejects(() => readFile(join(dir, 'history.json'), 'utf8'), 'no document exists yet');
  } finally {
    await cleanup(dir);
  }
});

test('a goal is redacted on the way in and its ordinary text survives', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({ goalDescription: `目标：修复 ${SECRET} 相关的问题` }));
    await store.flush();
    const raw = await readFile(join(dir, 'history.json'), 'utf8');
    assert.equal(raw.includes(SECRET), false, 'a credential shape is masked');
    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.goalDescription.includes(SECRET), false);
    assert.equal(row.goalDescription.includes('目标：修复'), true, 'the ordinary part is kept');
  } finally {
    await cleanup(dir);
  }
});

test('an over-bound stored description is cut to the bound with the marker, marked by path and stable', async () => {
  const dir = await dataDir();
  try {
    // A document another writer produced: both values are past the accepted bound.
    const longGoal = `头部${'多'.repeat(3_000)}😀`;
    const longSummary = `实际${'做'.repeat(2_500)}`;
    await writeFile(join(dir, 'history.json'), `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: 1_700_000_003_000,
      jobs: [{
        taskId: 'task-big-desc',
        state: 'awaiting-host-review',
        phase: 'awaiting-host-review',
        createdAt: 1_700_000_000_000,
        endedAt: 1_700_000_001_000,
        connectionId: 'conn-big',
        goalDescription: longGoal,
        hostAcceptance: {
          accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: 'ok',
          noteChars: 2, completionSummary: longSummary,
        },
        selfApproved: false,
      }],
    })}\n`, 'utf8');

    const [row] = await new HistoryStore(dir).load();
    // The kept prefix is capped at the bound MINUS the marker, and the marker is inside the
    // bound — so the stored form itself is a legal value the next writer will not touch.
    assert.equal(row.goalDescription.endsWith('… [truncated]'), true);
    assert.equal(Array.from(row.goalDescription).length <= TASK_DESCRIPTION_MAX_CHARS, true);
    assert.equal(row.hostAcceptance.completionSummary.endsWith('… [truncated]'), true);
    assert.equal(
      Array.from(row.hostAcceptance.completionSummary).length <= TASK_DESCRIPTION_MAX_CHARS,
      true,
    );
    assert.deepEqual(row.truncation.fields.sort(), ['goalDescription', 'hostAcceptance.completionSummary'],
      'both cuts are stated at the path a reader actually sees, not at a bare field name');
    assert.equal(row.truncation.dropped.length, 0);

    // The bounded form is what the document now holds, and a second load is a no-op.
    const afterFirst = await readFile(join(dir, 'history.json'), 'utf8');
    const [again] = await new HistoryStore(dir).load();
    assert.equal(again.goalDescription, row.goalDescription);
    assert.equal(again.hostAcceptance.completionSummary, row.hostAcceptance.completionSummary);
    assert.equal(await readFile(join(dir, 'history.json'), 'utf8'), afterFirst, 'a reload writes nothing');
  } finally {
    await cleanup(dir);
  }
});

test('a stored description of an anomalous type is omitted on load, and the record still reads', async () => {
  const dir = await dataDir();
  try {
    await writeFile(join(dir, 'history.json'), `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: 1_700_000_003_000,
      jobs: [{
        taskId: 'task-odd-desc',
        state: 'awaiting-host-review',
        phase: 'awaiting-host-review',
        createdAt: 1_700_000_000_000,
        endedAt: 1_700_000_001_000,
        connectionId: 'conn-odd',
        goalDescription: { text: '不是字符串' },
        hostAcceptance: {
          accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: 'ok',
          completionSummary: 42,
        },
        selfApproved: false,
      }],
    })}\n`, 'utf8');
    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.taskId, 'task-odd-desc', 'the record itself is not dropped');
    assert.equal(row.goalDescription ?? null, null, 'the anomalous value reads as absent');
    assert.equal(row.hostAcceptance.completionSummary ?? null, null);
    assert.equal(row.truncation ?? null, null, 'an omitted value is not a "cut"');
  } finally {
    await cleanup(dir);
  }
});

test('a saved goal cannot be replaced by a terminal snapshot, and a patch cannot erase either field', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const goal = '目标：保存后不可被覆盖';
    await store.save(fixtureView({
      goalDescription: goal,
      hostAcceptance: {
        accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: 'ok',
        completionSummary: '实际完成：已保存',
      },
    }));
    await store.flush();

    // A snapshot from an older writer carries neither field. It must not erase them.
    const snapshot = fixtureView({ goalDescription: undefined });
    delete snapshot.goalDescription;
    const afterSnapshot = await store.save(snapshot);
    assert.equal(afterSnapshot.goalDescription, goal, 'a stale snapshot keeps the saved goal');
    assert.equal(afterSnapshot.hostAcceptance.completionSummary, '实际完成：已保存');

    // A snapshot that states a DIFFERENT goal is a conflict, refused rather than trusted.
    await assert.rejects(
      () => store.save(fixtureView({ goalDescription: '另一个完全不同的目标' })),
      (error) => error.code === HISTORY_CODES.viewInvalid && error.details.field === 'goalDescription',
    );
    // The same goal in a later snapshot is fine.
    const same = await store.save(fixtureView({ goalDescription: goal }));
    assert.equal(same.goalDescription, goal);

    // An update may not erase the saved goal, nor the saved summary.
    await assert.rejects(
      () => store.update('task-desc-1', (row) => { delete row.goalDescription; return row; }),
      (error) => error.code === HISTORY_CODES.viewInvalid && error.details.field === 'goalDescription',
    );
    await assert.rejects(
      () => store.update('task-desc-1', (row) => {
        row.hostAcceptance = { ...row.hostAcceptance };
        delete row.hostAcceptance.completionSummary;
        return row;
      }),
      (error) => error.code === HISTORY_CODES.viewInvalid && error.details.field === 'completionSummary',
    );
    // An update that keeps both and changes something else is accepted.
    const patched = await store.update('task-desc-1', (row) => ({ ...row, cancelledBy: 'host' }));
    assert.equal(patched.goalDescription, goal);
    assert.equal(patched.hostAcceptance.completionSummary, '实际完成：已保存');
    assert.equal(patched.cancelledBy, 'host');
  } finally {
    await cleanup(dir);
  }
});

test('a credential-shaped summary replays identically before and after a restart', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    const raw = `实际完成：其中包含 ${SECRET} 这样的值`;
    const first = await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'ok', completionSummary: raw,
    });
    // The stored, published value is masked once — and it is what a replay must compare to.
    const canonical = first.hostAcceptance.completionSummary;
    assert.equal(canonical.includes(SECRET), false);
    await h.store.flush();

    // Repeating the SAME raw text is a no-op: the identity is the canonical (already masked)
    // value, so re-redacting it cannot make an identical replay look like a new conclusion.
    const replayed = await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'ok', completionSummary: raw,
    });
    assert.equal(replayed.hostAcceptance.acceptedAt, first.hostAcceptance.acceptedAt, 'the replay is a no-op');
    assert.equal(replayed.hostAcceptance.completionSummary, canonical);

    // A restart, then the same replay through the HISTORICAL path: still a no-op.
    const restarted = new HistoryStore(h.store.dir);
    h.engine.history = restarted;
    const afterRestart = await h.engine.recordHistoricalReview(
      { taskId, connectionId: 'local-mcp' }, 'accepted', 'ok', null, raw,
    );
    assert.equal(afterRestart.hostAcceptance.completionSummary, canonical, 'the masked value is stable');
    assert.equal(afterRestart.hostAcceptance.acceptedAt, first.hostAcceptance.acceptedAt);
    // And a genuinely different summary is still refused after the restart.
    await assert.rejects(
      () => h.engine.recordHistoricalReview(
        { taskId, connectionId: 'local-mcp' }, 'accepted', 'ok', null, `另一个 ${SECRET}`,
      ),
      (error) => error.code === JOB_CODES.reviewNotReviewable,
    );
    // The document still holds exactly one masked value.
    const raw_document = await readFile(join(h.store.dir, 'history.json'), 'utf8');
    assert.equal(raw_document.includes(SECRET), false);
    assert.equal(raw_document.split(canonical).length - 1 >= 1, true);
  } finally {
    await h.close();
  }
});

test('reloading a document that carries both fields is idempotent, byte for byte', async () => {
  const dir = await dataDir();
  try {
    const goal = '目标：重载幂等性 🎯\n第二行';
    const summary = '实际完成：重载幂等性';
    const store = new HistoryStore(dir);
    await store.save(fixtureView({
      goalDescription: `  ${goal}  `,
      hostAcceptance: {
        accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: 'ok',
        completionSummary: `  ${summary}  `,
      },
    }));
    await store.flush();
    const first = await readFile(join(dir, 'history.json'), 'utf8');
    const document = JSON.parse(first);
    // The STORED form is the trimmed one: what was validated is what is on disk.
    assert.equal(document.jobs[0].goalDescription, goal);
    assert.equal(document.jobs[0].hostAcceptance.completionSummary, summary);

    // Two more loads change nothing: no re-trim, no re-redact, no marker added.
    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.goalDescription, goal);
    assert.equal(row.hostAcceptance.completionSummary, summary);
    assert.equal(row.truncation ?? null, null, 'a legal value is never marked');
    await new HistoryStore(dir).load();
    assert.equal(await readFile(join(dir, 'history.json'), 'utf8'), first, 'the document is byte-for-byte stable');
  } finally {
    await cleanup(dir);
  }
});

test('a DIRECT store write refuses a value that only exceeds the bound after redaction', async () => {
  const dir = await dataDir();
  try {
    // 2000 code points before masking, 2016 after it. The projection must apply the SAME
    // contract the engine does, because a store is reachable without going through either the
    // HTTP route or the engine — and this is exactly where the bypass lived.
    const key = 'Temp/dsh-abc123/work';
    const room = TASK_DESCRIPTION_MAX_CHARS - taskDescriptionLength(key) - 1;
    const value = `${key}\n${'好'.repeat(room)}`;
    assert.equal(taskDescriptionLength(value), TASK_DESCRIPTION_MAX_CHARS);
    const maskedLength = taskDescriptionLength(redactText(value));
    assert.equal(maskedLength > TASK_DESCRIPTION_MAX_CHARS, true, 'the fixture really grows past the bound');

    const store = new HistoryStore(dir);
    // Seed a document so "unchanged" is a real byte-for-byte comparison. The seed is its own
    // task, so the protected-goal rule (a saved goal cannot be replaced) is not what refuses
    // the writes under test.
    await store.save(fixtureView({ taskId: 'task-seed', goalDescription: '目标：先写一条' }));
    await store.flush();
    const before = await readFile(join(dir, 'history.json'), 'utf8');

    for (const [label, view, field] of [
      ['goal', fixtureView({ goalDescription: value }), 'goalDescription'],
      ['summary', fixtureView({
        hostAcceptance: {
          accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: 'ok',
          completionSummary: value,
        },
      }), 'hostAcceptance.completionSummary'],
    ]) {
      await assert.rejects(
        () => store.save(view),
        (error) => error.code === HISTORY_CODES.viewInvalid
          && error.details.field === field
          && error.details.length === maskedLength
          && error.details.limit === TASK_DESCRIPTION_MAX_CHARS
          && !JSON.stringify(error.details).includes('dsh-abc123/work'),
        `${label} must be refused on a direct save`,
      );
    }
    // The UPDATE path is the same contract, applied to the record that really exists.
    await assert.rejects(
      () => store.update('task-seed', (row) => ({ ...row, goalDescription: value })),
      (error) => error.code === HISTORY_CODES.viewInvalid && error.details.field === 'goalDescription',
    );
    await assert.rejects(
      () => store.update('task-seed', (row) => ({
        ...row,
        hostAcceptance: {
          accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: 'ok',
          completionSummary: value,
        },
      })),
      (error) => error.code === HISTORY_CODES.viewInvalid
        && error.details.field === 'hostAcceptance.completionSummary',
    );
    // Nothing was written by any refusal: the old document is byte-for-byte what it was.
    assert.equal(await readFile(join(dir, 'history.json'), 'utf8'), before, 'the old document is unchanged');
    // And a value that FITS after masking is stored as its masked, trimmed form.
    const fits = `${key}\n${'好'.repeat(room - (maskedLength - TASK_DESCRIPTION_MAX_CHARS))}`;
    const saved = await store.save(fixtureView({ goalDescription: fits }));
    assert.equal(saved.goalDescription.includes('dsh-abc123/work'), false, 'stored already masked');
    assert.equal(taskDescriptionLength(saved.goalDescription) <= TASK_DESCRIPTION_MAX_CHARS, true);
  } finally {
    await cleanup(dir);
  }
});

test('a direct store write and a load agree on the final (masked) length', async () => {
  const dir = await dataDir();
  try {
    const key = 'Temp/dsh-abc123/work';
    const room = TASK_DESCRIPTION_MAX_CHARS - taskDescriptionLength(key) - 1;
    const value = `${key}\n${'好'.repeat(room)}`;
    // A document another writer produced, carrying the over-bound-after-masking value.
    await writeFile(join(dir, 'history.json'), `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: 1_700_000_003_000,
      jobs: [{
        taskId: 'task-masked', state: 'awaiting-host-review', phase: 'awaiting-host-review',
        createdAt: 1_700_000_000_000, endedAt: 1_700_000_001_000, connectionId: 'conn-m',
        goalDescription: value,
        hostAcceptance: {
          accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: 'ok',
          noteChars: 2, completionSummary: value,
        },
        selfApproved: false,
      }],
    })}\n`, 'utf8');

    const [row] = await new HistoryStore(dir).load();
    // The LOAD judges the FINAL value: masking happens first, so the cut is measured on the
    // masked text and the marked result still fits inside the bound.
    assert.equal(row.goalDescription.endsWith('… [truncated]'), true);
    assert.equal(taskDescriptionLength(row.goalDescription) <= TASK_DESCRIPTION_MAX_CHARS, true);
    assert.equal(row.hostAcceptance.completionSummary.endsWith('… [truncated]'), true);
    assert.equal(taskDescriptionLength(row.hostAcceptance.completionSummary) <= TASK_DESCRIPTION_MAX_CHARS, true);
    assert.deepEqual(row.truncation.fields.sort(), ['goalDescription', 'hostAcceptance.completionSummary'],
      'the cut is stated at the path a reader sees');
    // The masked prefix survived, and the loader did not re-mask or re-trim it away.
    assert.equal(row.goalDescription.includes('masks-user-profile-segment'), true);

    // Reload is idempotent, byte for byte.
    const afterFirst = await readFile(join(dir, 'history.json'), 'utf8');
    const [again] = await new HistoryStore(dir).load();
    assert.equal(again.goalDescription, row.goalDescription);
    assert.equal(again.hostAcceptance.completionSummary, row.hostAcceptance.completionSummary);
    assert.equal(await readFile(join(dir, 'history.json'), 'utf8'), afterFirst, 'no second write');
  } finally {
    await cleanup(dir);
  }
});

test('a saved review with NO summary cannot gain one through a history update', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    // An old review: accepted, with a note, and NO summary — exactly what an earlier build wrote.
    await store.save(fixtureView({
      taskId: 'task-no-summary',
      hostAcceptance: {
        accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: 'ok',
      },
    }));
    await store.flush();
    const before = await readFile(join(dir, 'history.json'), 'utf8');

    // The bypass: an update that only APPENDS a summary to that already saved review.
    await assert.rejects(
      () => store.update('task-no-summary', (row) => ({
        ...row,
        hostAcceptance: { ...row.hostAcceptance, completionSummary: '事后补写' },
      })),
      (error) => error.code === HISTORY_CODES.viewInvalid
        && error.details.field === 'completionSummary',
    );
    // An explicit `null` at that position is the same backfill attempt and is refused too.
    await assert.rejects(
      () => store.update('task-no-summary', (row) => ({
        ...row,
        hostAcceptance: { ...row.hostAcceptance, completionSummary: null },
      })),
      (error) => error.code === HISTORY_CODES.viewInvalid,
    );
    // The document is byte-for-byte unchanged by the refusals.
    assert.equal(await readFile(join(dir, 'history.json'), 'utf8'), before, 'the file is unchanged');

    // The NORMAL update paths still work exactly as before.
    const kept = await store.update('task-no-summary', (row) => ({ ...row, cancelledBy: 'host' }));
    assert.equal(kept.cancelledBy, 'host');
    assert.equal(kept.hostAcceptance.completionSummary ?? null, null, 'the old review stays summary-less');
    assert.equal(kept.hostAcceptance.note, 'ok');

    // A review that DOES have a summary may be copied through unchanged, not replaced.
    await store.save(fixtureView({
      taskId: 'task-with-summary',
      hostAcceptance: {
        accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: 'ok',
        completionSummary: '已存说明',
      },
    }));
    const same = await store.update('task-with-summary', (row) => ({ ...row, cancelledBy: 'host' }));
    assert.equal(same.hostAcceptance.completionSummary, '已存说明');
    await assert.rejects(
      () => store.update('task-with-summary', (row) => ({
        ...row,
        hostAcceptance: { ...row.hostAcceptance, completionSummary: '换成别的' },
      })),
      (error) => error.code === HISTORY_CODES.viewInvalid,
    );

    // An UNREVIEWED task may be updated freely, and its first real review is still recorded.
    await store.save(fixtureView({ taskId: 'task-unreviewed' }));
    const opened = await store.update('task-unreviewed', (row) => ({ ...row, cancelledBy: 'host' }));
    assert.equal(opened.hostAcceptance ?? null, null);
    const firstReview = await store.update('task-unreviewed', (row) => ({
      ...row,
      hostAcceptance: {
        accepted: true, state: 'accepted', acceptedAt: 1_700_000_003_000, by: 'host-commander', note: 'first',
        completionSummary: '首次说明',
      },
    }));
    assert.equal(firstReview.hostAcceptance.completionSummary, '首次说明', 'a first review may carry one');
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 3. The engine: validation before side effects, a frozen goal, a published-once summary
// ---------------------------------------------------------------------------

test('the engine refuses a bad goal before it creates a task, and a legacy omission still works', async () => {
  const h = await harness();
  try {
    // Non-string values are refused rather than coerced — an explicit `null` included, which
    // is the case an over-eager "treat null as absent" would silently accept.
    for (const bad of [null, 42, true, {}, ['完成'], { text: '目标' }]) {
      await assert.rejects(
        () => h.engine.start({
          connectionId: 'local-mcp', workspacePath: h.workspace, prompt: 'go', goalDescription: bad,
        }),
        (error) => error.code === JOB_CODES.descriptionInvalid
          && error.details.field === 'goalDescription'
          && error.message.includes('must be a string'),
        `${JSON.stringify(bad)} must be refused`,
      );
    }
    // An over-bound value is refused with the real length, measured in code points. The code
    // is the SUBMISSION's own (`JOB_DESCRIPTION_INVALID`), never the review verb's.
    await assert.rejects(
      () => h.engine.start({
        connectionId: 'local-mcp', workspacePath: h.workspace, prompt: 'go', goalDescription: '😀'.repeat(2_001),
      }),
      (error) => error.code === JOB_CODES.descriptionInvalid
        && error.code !== JOB_CODES.reviewInvalid
        && error.details.length === 2_001
        && error.details.limit === 2_000,
    );
    // Nothing was created by any refusal: the map is empty and no history was written.
    assert.equal(h.engine.list({ connectionId: 'local-mcp' }).length, 0, 'a refused goal creates no task');
    assert.equal((await h.store.load()).length, 0);

    // An omitted goal is legal and the task carries no goal at all — and neither does the
    // VIEW: no `goalDescription: null` key is added to an old caller's task shape.
    const plain = await h.engine.start({ connectionId: 'local-mcp', workspacePath: h.workspace, prompt: 'go' });
    assert.equal(Object.hasOwn(plain, 'goalDescription'), false, 'an omitted goal adds no key to the view');
    assert.equal(plain.goalDescription, undefined);
    assert.equal(h.engine.get(plain.taskId).goalDescription, undefined);
    await h.engine.tasks.get(plain.taskId).settled;
    // An explicitly null goal is REFUSED, not read as "omitted".
    await assert.rejects(
      () => h.engine.start({
        connectionId: 'local-mcp', workspacePath: h.workspace, prompt: 'go', goalDescription: null,
      }),
      (error) => error.code === JOB_CODES.descriptionInvalid && error.details.field === 'goalDescription',
    );
    // A blank goal is the same fact as omitting it, so it also adds no key.
    const blank = await h.engine.start({
      connectionId: 'local-mcp', workspacePath: h.workspace, prompt: 'go', goalDescription: '   \n ',
    });
    assert.equal(Object.hasOwn(blank, 'goalDescription'), false);
    await h.engine.tasks.get(blank.taskId).settled;
  } finally {
    await h.close();
  }
});

test('a legal goal is frozen at creation and reaches the live view, the list and the record', async () => {
  const h = await harness();
  try {
    const goal = '  目标：让重启后的记录说清「要做什么」🎯\n第二段：补齐历史白名单  ';
    const started = await h.engine.start({
      connectionId: 'local-mcp', workspacePath: h.workspace, prompt: 'do the work', goalDescription: goal,
    });
    // Only the surrounding whitespace is gone; the inner break, the Chinese and the emoji stay.
    assert.equal(started.goalDescription, '目标：让重启后的记录说清「要做什么」🎯\n第二段：补齐历史白名单');
    // The prompt the worker receives is untouched by the goal: it is a record, not an instruction.
    assert.equal(started.prompt, 'do the work');
    const listed = h.engine.list({ connectionId: 'local-mcp' }).find((task) => task.taskId === started.taskId);
    assert.equal(listed.goalDescription, started.goalDescription);
    await h.engine.tasks.get(started.taskId).settled;
  } finally {
    await h.close();
  }
});

test('a reviewed completion summary appears only once the write confirmed it', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    assert.equal(h.engine.get(taskId).hostAcceptance, null);

    const recorded = await h.engine.recordHostReview({
      connectionId: 'local-mcp',
      taskId,
      decision: 'accepted',
      note: 'reviewed',
      completionSummary: '实际完成：历史字段与重启读取',
    });
    assert.equal(recorded.hostAcceptance.completionSummary, '实际完成：历史字段与重启读取');
    assert.equal(recorded.hostAcceptance.accepted, true);
    assert.equal(h.engine.get(taskId).hostAcceptance.completionSummary, '实际完成：历史字段与重启读取');
    await h.store.flush();
    const [row] = await new HistoryStore(h.store.dir).load();
    assert.equal(row.hostAcceptance.completionSummary, '实际完成：历史字段与重启读取');
  } finally {
    await h.close();
  }
});

test('changes-requested with a summary is still not accepted', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    const recorded = await h.engine.recordHostReview({
      connectionId: 'local-mcp',
      taskId,
      decision: 'changes-requested',
      note: 'the retry path is missing',
      completionSummary: '已完成：历史字段；未完成：重试路径',
    });
    assert.equal(recorded.hostAcceptance.accepted, false);
    assert.equal(recorded.hostAcceptance.state, 'changes-requested');
    assert.equal(recorded.hostAcceptance.completionSummary, '已完成：历史字段；未完成：重试路径');
    assert.equal(h.engine.get(taskId).selfApproved, false);
    assert.equal(h.engine.get(taskId).reviewPersistence.accepted, false);
  } finally {
    await h.close();
  }
});

test('a bad completion summary is refused before anything is written, live and historical', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    // `null` is refused like every other non-string: it is what a caller sends when it means
    // "no summary", and the contract says that form is wrong, not absent.
    for (const bad of [null, 42, {}, ['x'], 'z'.repeat(2_001)]) {
      await assert.rejects(
        () => h.engine.recordHostReview({
          connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'ok', completionSummary: bad,
        }),
        (error) => error.code === JOB_CODES.reviewInvalid && error.details.field === 'completionSummary',
        `${String(bad).slice(0, 20)} must be refused`,
      );
    }
    assert.equal(h.engine.get(taskId).hostAcceptance, null, 'a refused summary records nothing');
    assert.equal(h.engine.get(taskId).reviewPersistence.state, REVIEW_PERSISTENCE_STATES.none);
    // The same refusal on the restored path — except that `undefined` there means "the caller
    // stated none", which is the ONLY absent form.
    for (const bad of [null, 42, 'z'.repeat(2_001)]) {
      await assert.rejects(
        () => h.engine.recordHistoricalReview({ taskId, connectionId: 'local-mcp' }, 'accepted', 'ok', null, bad),
        (error) => error.code === JOB_CODES.reviewInvalid && error.details.field === 'completionSummary',
      );
    }
    assert.equal((await h.engine.storedTaskRow(taskId, 'local-mcp')).hostAcceptance, null);
    // A restored review with NO summary is legal and stores none.
    const plain = await h.engine.recordHistoricalReview({ taskId, connectionId: 'local-mcp' }, 'accepted', 'ok', null);
    assert.equal(plain.hostAcceptance.accepted, true);
    assert.equal(plain.hostAcceptance.completionSummary ?? null, null);
  } finally {
    await h.close();
  }
});

test('a credential-shaped summary is redacted before it is stored or published', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    await h.engine.recordHostReview({
      connectionId: 'local-mcp',
      taskId,
      decision: 'accepted',
      note: 'ok',
      completionSummary: `实际完成，其中包含 ${SECRET} 这样的值`,
    });
    const published = h.engine.get(taskId).hostAcceptance.completionSummary;
    assert.equal(published.includes(SECRET), false, 'the credential shape is masked');
    assert.equal(published.includes('实际完成'), true, 'the ordinary text survives');
    await h.store.flush();
    const raw = await readFile(join(h.store.dir, 'history.json'), 'utf8');
    assert.equal(raw.includes(SECRET), false);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 4. The review identity: decision + note + summary
// ---------------------------------------------------------------------------

test('the same three facts replay as a no-op, and changing only the summary is refused', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    const first = await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'ok', completionSummary: '已完成 A',
    });
    const replayed = await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'ok', completionSummary: '已完成 A',
    });
    assert.equal(replayed.hostAcceptance.acceptedAt, first.hostAcceptance.acceptedAt, 'the record is not rewritten');
    assert.equal(replayed.hostAcceptance.completionSummary, '已完成 A');

    // Only the summary differs: a different conclusion, so it is refused like any other.
    await assert.rejects(
      () => h.engine.recordHostReview({
        connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'ok', completionSummary: '已完成 B',
      }),
      (error) => error.code === JOB_CODES.reviewNotReviewable,
    );
    // Adding a summary to a review recorded WITHOUT one is also a change, refused.
    const plainTask = await finishedTask(h);
    await h.engine.recordHostReview({ connectionId: 'local-mcp', taskId: plainTask, decision: 'accepted', note: 'ok' });
    await assert.rejects(
      () => h.engine.recordHostReview({
        connectionId: 'local-mcp', taskId: plainTask, decision: 'accepted', note: 'ok', completionSummary: '后来补的',
      }),
      (error) => error.code === JOB_CODES.reviewNotReviewable,
    );
    // The plain record is untouched: its summary is still absent, not invented.
    assert.equal(h.engine.get(plainTask).hostAcceptance.completionSummary ?? null, null);
    // And replaying it without a summary is still idempotent.
    const again = await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId: plainTask, decision: 'accepted', note: 'ok',
    });
    assert.equal(again.hostAcceptance.completionSummary ?? null, null);
  } finally {
    await h.close();
  }
});

test('the historical review path enforces the same identity, and the summary survives a restart', async () => {
  const h = await harness();
  try {
    const goal = '目标：重启后仍能读到完成说明';
    const taskId = await finishedTask(h, { goalDescription: goal });
    // A NEW store instance reads the document exactly as a restarting process would.
    const restarted = new HistoryStore(h.store.dir);
    const restored = await restarted.load();
    const row = restored.find((entry) => entry.taskId === taskId);
    assert.equal(row.goalDescription, goal, 'the goal survived the restart');

    const recorded = await h.engine.recordHistoricalReview(
      { taskId, connectionId: 'local-mcp' }, 'accepted', 'ok after restart', null, '实际完成：重启后读取',
    );
    assert.equal(recorded.hostAcceptance.completionSummary, '实际完成：重启后读取');
    assert.equal(recorded.hostAcceptance.accepted, true);

    // Replaying the same triple is a no-op; a different summary is refused.
    const replay = await h.engine.recordHistoricalReview(
      { taskId, connectionId: 'local-mcp' }, 'accepted', 'ok after restart', null, '实际完成：重启后读取',
    );
    assert.equal(replay.hostAcceptance.acceptedAt, recorded.hostAcceptance.acceptedAt);
    await assert.rejects(
      () => h.engine.recordHistoricalReview(
        { taskId, connectionId: 'local-mcp' }, 'accepted', 'ok after restart', null, '另一个完成说明',
      ),
      (error) => error.code === JOB_CODES.reviewNotReviewable,
    );

    // A fresh read of the document carries it, and the goal is still there.
    const [final] = (await new HistoryStore(h.store.dir).load()).filter((entry) => entry.taskId === taskId);
    assert.equal(final.hostAcceptance.completionSummary, '实际完成：重启后读取');
    assert.equal(final.goalDescription, goal);
  } finally {
    await h.close();
  }
});

test('an old review without a summary keeps its wire shape, and another connection still cannot review', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    const deps = { engine: h.engine, auth: h.engine.auth, settings: h.settings, logger: { warn() {} } };
    const plain = await callPlane(deps, '/tasks/review', { taskId, decision: 'accepted', note: 'no summary here' });
    assert.equal(plain.status, 200);
    // `deepEqual` on the record, not a smoke assertion: an omitted summary must add NO key.
    assert.deepEqual(Object.keys(plain.body.hostAcceptance).sort(), ['accepted', 'acceptedAt', 'by', 'note', 'state']);

    // A foreign connection gets exactly the unknown-task answer, summary or not.
    const other = await callPlane(deps, '/tasks/review', {
      taskId, decision: 'accepted', note: 'ok', completionSummary: '偷偷写一个',
    });
    assert.equal(other.status >= 400, true);

    // A summary over the bound is refused by the ROUTE before the engine, with the length.
    const tooLong = await callPlane(deps, '/tasks/review', {
      taskId, decision: 'accepted', note: 'ok', completionSummary: 'z'.repeat(2_001),
    });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error.code, 'REVIEW_COMPLETION_SUMMARY_INVALID');
    assert.equal(tooLong.body.error.details.length, 2_001);
    assert.equal(tooLong.body.error.details.limit, 2_000);
    // And a non-string summary is refused by the route too, never coerced.
    const wrongType = await callPlane(deps, '/tasks/review', {
      taskId, decision: 'accepted', note: 'ok', completionSummary: 7,
    });
    assert.equal(wrongType.status, 400);
    assert.equal(wrongType.body.error.code, 'REVIEW_COMPLETION_SUMMARY_INVALID');
  } finally {
    await h.close();
  }
});

test('a running, failed, cancelled or interrupted task cannot be turned into a reviewed one by a summary', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    // Mark the in-memory record as not reviewable, exactly as a running one would be.
    const live = h.engine.tasks.get(taskId);
    const realState = live.state;
    live.state = TASK_STATES.running;
    await assert.rejects(
      () => h.engine.recordHostReview({
        connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'ok', completionSummary: '已完成',
      }),
      (error) => error.code === JOB_CODES.reviewNotReviewable,
    );
    live.state = realState;
    // The stored row is unchanged: no review, no summary.
    assert.equal((await h.engine.storedTaskRow(taskId, 'local-mcp')).hostAcceptance, null);

    // A stored record in a terminal non-review state is refused on the historical path. The
    // state is written by REBUILDING the document and then loading it through the store's own
    // write path, so the record the engine reads is exactly the record on disk.
    const taskDocument = JSON.parse(await readFile(join(h.store.dir, 'history.json'), 'utf8'));
    const stored = taskDocument.jobs.find((entry) => entry.taskId === taskId);
    stored.state = 'interrupted';
    stored.phase = 'interrupted';
    stored.hostAcceptance = null;
    await writeFile(join(h.store.dir, 'history.json'), `${JSON.stringify(taskDocument)}\n`, 'utf8');
    // A FRESH store (as after a restart) reads the document as it now stands.
    const restarted = new HistoryStore(h.store.dir);
    const [interruptedRow] = (await restarted.load()).filter((entry) => entry.taskId === taskId);
    assert.equal(interruptedRow.state, 'interrupted', 'the fixture really stores an interrupted record');
    // Point the engine at that document for the historical call.
    h.engine.history = restarted;
    await assert.rejects(
      () => h.engine.recordHistoricalReview(
        { taskId, connectionId: 'local-mcp' }, 'accepted', 'ok', null, '已完成',
      ),
      (error) => error.code === JOB_CODES.reviewNotReviewable,
    );
    const [row] = (await new HistoryStore(h.store.dir).load()).filter((entry) => entry.taskId === taskId);
    assert.equal(row.state, 'interrupted', 'the real outcome is preserved');
    assert.equal(row.hostAcceptance ?? null, null);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 5. The wire: real MCP server → real HTTP handler → real engine → real store → restart
// ---------------------------------------------------------------------------

test('a real MCP submission of a Chinese/emoji/multiline goal reads back after a RESTART', async () => {
  // A REAL restart, submitted through the REAL MCP surface: `tools/call delegate_submit` from a
  // `createMcpServer` over `createExecutionClient`, whose `fetch` is redirected onto the real
  // execution-plane handler, which drives the real engine and a real `HistoryStore`. The first
  // "process" is then disposed, and a NEW engine/store/handler/server is booted over the SAME
  // data directory, whose in-memory task map is empty — so everything it reads came from disk.
  const first = await harness();
  const goal = '目标：让执行记录说清「要做什么」🎯\n第二行：重启后仍能读到\n第三行：保留内部换行';
  const origin = 'http://127.0.0.1:3210';
  let taskId;
  try {
    const { createExecutionClient } = await import('../bin/dsh-delegate-mcp.js');
    const deps = { engine: first.engine, auth: first.engine.auth, settings: first.settings, logger: { warn() {} } };
    const handler = createExecutionHandler({ ...deps, getBindHost: () => '127.0.0.1' });
    // The requests the MCP client actually sent, so the wire is proven and not assumed.
    const wire = [];
    const originalFetch = await installPlaneFetch(handler, origin, wire);
    try {
      const mcp = createMcpServer({
        callExecution: createExecutionClient({ baseUrl: origin, timeoutMs: 5_000 }),
      });
      await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      const submitted = await callTool(mcp, 2, 'delegate_submit', {
        workspacePath: first.workspace, prompt: 'implement the change', goalDescription: goal,
      });
      assert.equal(submitted.isError, false, submitted.text);
      taskId = submitted.body.task.taskId;
      assert.equal(submitted.body.task.goalDescription, goal, 'the MCP submission answer carries the goal');
      // The submission really travelled MCP → client → the plane's own submit route.
      assert.deepEqual(wire, [`POST ${EXECUTION_PREFIX}/tasks`], 'the goal was submitted over the wire');
    } finally {
      originalFetch.restore();
    }

    // Wait for the run to END (settle resolves after the terminal history write) and then let
    // the store's own queue drain, so the document really carries the record before restart.
    await first.engine.tasks.get(taskId).settled;
    await first.store.flush();
    assert.equal(first.engine.get(taskId).state, 'awaiting-host-review', 'the fixture task really ended');
    const [storedBefore] = (await new HistoryStore(first.store.dir).load())
      .filter((entry) => entry.taskId === taskId);
    assert.ok(storedBefore !== undefined, 'the terminal record is on disk before the restart');
    assert.equal(storedBefore.state, 'awaiting-host-review', 'the fixture task really ended');
    assert.equal(storedBefore.goalDescription, goal);
  } finally {
    await first.engine.dispose();
  }

  // The second process: a new engine over the same data directory.
  const second = await bootOver(first.dir);
  const restore = await installPlaneFetch(second.handler, origin);
  try {
    // Nothing is in this engine's memory: the task exists only on disk. Checked on the raw
    // method (which throws), not through a route that answers with an object.
    assert.throws(() => second.engine.get(taskId), (error) => error.code === JOB_CODES.taskNotFound,
      'a fresh process has no in-memory record of this task');
    const { createExecutionClient } = await import('../bin/dsh-delegate-mcp.js');
    const mcp = createMcpServer({
      callExecution: createExecutionClient({ baseUrl: origin, timeoutMs: 5_000 }),
    });
    await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    // The detail route reads the restored record, goal intact.
    const detail = await callTool(mcp, 4, 'delegate_result', { taskId });
    assert.equal(detail.isError, false, detail.text);
    assert.equal(detail.body.task.goalDescription, goal);
    assert.equal(detail.body.task.source, 'history', 'the answer came from the durable record');

    // A review recorded in the SECOND process carries the summary and survives storage.
    const reviewed = await callTool(mcp, 5, 'delegate_review', {
      taskId, decision: 'accepted', note: 'reviewed after the restart', completionSummary: '实际完成：重启后审查 ✅',
    });
    assert.equal(reviewed.isError, false, reviewed.text);
    assert.equal(reviewed.body.hostAcceptance.completionSummary, '实际完成：重启后审查 ✅');

    // And a THIRD read instance sees both fields.
    const [row] = (await new HistoryStore(second.store.dir).load()).filter((entry) => entry.taskId === taskId);
    assert.equal(row.goalDescription, goal);
    assert.equal(row.hostAcceptance.completionSummary, '实际完成：重启后审查 ✅');
  } finally {
    restore.restore();
    await second.h.close();
    await cleanup(first.dir);
  }
});

test('an omitted goal adds no key to the live view or to the stored record', async () => {
  const h = await harness();
  try {
    const plain = await h.engine.start({
      connectionId: 'local-mcp', workspacePath: h.workspace, prompt: 'another change',
    });
    assert.equal(Object.hasOwn(plain, 'goalDescription'), false, 'not even a null key is added');
    assert.equal(Object.hasOwn(h.engine.get(plain.taskId), 'goalDescription'), false);
    await h.engine.tasks.get(plain.taskId).settled;
    await h.store.flush();
    const [plainRow] = (await new HistoryStore(h.store.dir).load()).filter((entry) => entry.taskId === plain.taskId);
    assert.ok(plainRow !== undefined, 'the terminal record is on disk');
    assert.equal(Object.hasOwn(plainRow, 'goalDescription'), false);
  } finally {
    await h.close();
  }
});

test('the MCP surface refuses a bad goal and a bad summary without reaching the plane', async () => {
  const seen = [];
  const mcp = createMcpServer({
    async callExecution(route, payload) { seen.push({ route, payload }); return { ok: true, task: { taskId: 't1' } }; },
  });
  await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const listed = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const submit = listed.result.tools.find((tool) => tool.name === 'delegate_submit');
  assert.equal(submit.inputSchema.properties.goalDescription.maxLength, 2_000);
  assert.equal(submit.inputSchema.properties.goalDescription.codePointLength, true);
  assert.equal(submit.inputSchema.required.includes('goalDescription'), false, 'the goal stays optional');

  // A 2000-code-point emoji goal is accepted and forwarded unchanged.
  const atLimit = '😀'.repeat(2_000);
  const ok = await mcp.handle({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'delegate_submit', arguments: { workspacePath: '/w', prompt: 'go', goalDescription: atLimit } },
  });
  assert.equal(ok.result.isError, undefined, ok.result.content?.[0]?.text);
  assert.deepEqual(seen, [{ route: 'submit', payload: { workspacePath: '/w', prompt: 'go', goalDescription: atLimit } }]);

  // 2001 code points, a non-string and an undeclared field are all refused before the plane.
  for (const goalDescription of ['😀'.repeat(2_001), 42, null]) {
    seen.length = 0;
    const bad = await mcp.handle({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'delegate_submit', arguments: { workspacePath: '/w', prompt: 'go', goalDescription } },
    });
    assert.equal(bad.result.isError, true, `${String(goalDescription).slice(0, 12)} must be refused`);
    assert.deepEqual(seen, [], 'a refused goal sends nothing');
  }
});

test('a reviewed summary is readable through HTTP detail and the restored route, never before it is durable', async () => {
  const h = await harness();
  try {
    const goal = '目标：审查后可读到完成说明';
    const taskId = await finishedTask(h, { goalDescription: goal });
    const deps = { engine: h.engine, auth: h.engine.auth, settings: h.settings, logger: { warn() {} } };

    const recorded = await callPlane(deps, '/tasks/review', {
      taskId, decision: 'accepted', note: 'reviewed', completionSummary: '实际完成：HTTP 与重启读取 ✅',
    });
    assert.equal(recorded.status, 200);
    assert.equal(recorded.body.hostAcceptance.completionSummary, '实际完成：HTTP 与重启读取 ✅');
    assert.equal(recorded.body.task.goalDescription, goal);

    const got = await callPlane(deps, '/tasks/get', { taskId });
    assert.equal(got.status, 200);
    assert.equal(got.body.task.hostAcceptance.completionSummary, '实际完成：HTTP 与重启读取 ✅');

    // A NEW store instance reads both fields from the document.
    const [row] = (await new HistoryStore(h.store.dir).load()).filter((entry) => entry.taskId === taskId);
    assert.equal(row.goalDescription, goal);
    assert.equal(row.hostAcceptance.completionSummary, '实际完成：HTTP 与重启读取 ✅');

    // An unknown task answers exactly as a foreign one does, summary or not.
    const unknown = await callPlane(deps, '/tasks/review', {
      taskId: 'task-unknown', decision: 'accepted', note: 'ok', completionSummary: '不会保存的',
    });
    assert.equal(unknown.status, 404);
  } finally {
    await h.close();
  }
});

test('POST /tasks forwards a legal goal and refuses an over-long one with its length', async () => {
  const h = await harness();
  try {
    const deps = { engine: h.engine, auth: h.engine.auth, settings: h.settings, logger: { warn() {} } };
    const goal = '目标：通过 HTTP 提交 🎯\n带换行';
    const submitted = await callPlane(deps, '/tasks', {
      workspacePath: h.workspace, prompt: 'go', goalDescription: goal,
    });
    assert.equal(submitted.status, 202);
    assert.equal(submitted.body.task.goalDescription, goal);

    const tooLong = await callPlane(deps, '/tasks', {
      workspacePath: h.workspace, prompt: 'go', goalDescription: 'z'.repeat(2_001),
    });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error.code, 'TASK_GOAL_DESCRIPTION_INVALID');
    assert.equal(tooLong.body.error.details.length, 2_001);
    // The refusal names the field, the length and the limit — and never the body.
    assert.equal(tooLong.body.error.message.includes('zzzz'), false);

    const wrongType = await callPlane(deps, '/tasks', {
      workspacePath: h.workspace, prompt: 'go', goalDescription: { text: '目标' },
    });
    assert.equal(wrongType.status, 400);
    assert.equal(wrongType.body.error.code, 'TASK_GOAL_DESCRIPTION_INVALID');
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Projections and bounds
// ---------------------------------------------------------------------------

test('a wait reports the summary by LENGTH only, and keeps its old shape when there is none', () => {
  const base = {
    taskId: 't', state: 'awaiting-host-review', phase: 'awaiting-host-review', selfApproved: false,
    hostAcceptance: {
      accepted: true, state: 'accepted', acceptedAt: 1_700_000_000_000, by: 'host-commander', note: '审查意见全文',
    },
  };
  const withoutSummary = compactTask(base);
  assert.deepEqual(Object.keys(withoutSummary.hostAcceptance).sort(), ['accepted', 'acceptedAt', 'by', 'noteChars', 'noteOmitted', 'state'],
    'a record with no summary adds no summary field');

  const withSummary = compactTask({
    ...base,
    hostAcceptance: { ...base.hostAcceptance, completionSummary: '实际完成：一段正文 🎯' },
  });
  assert.equal('completionSummary' in withSummary.hostAcceptance, false, 'the body never travels on a wait');
  assert.equal(withSummary.hostAcceptance.completionSummaryChars, Array.from('实际完成：一段正文 🎯').length);
  assert.equal(withSummary.hostAcceptance.completionSummaryOmitted, true);
  assert.equal(withSummary.hostAcceptance.noteOmitted, true);
});

test('a legal summary beside a tiny entry budget either fits whole or refuses the save', async () => {
  // A budget a legal 2000-code-point summary still fits in, with a short note.
  const dir = await dataDir();
  try {
    const limits = { maxEntries: 4, maxBytes: 64 * 1024, maxEntryBytes: 8 * 1024 };
    const store = new HistoryStore(dir, limits);
    const summary = '实际完成：' + '填'.repeat(300);
    const saved = await store.save(fixtureView({
      goalDescription: '目标：短说明',
      // Heavy evidence that the fitter must reduce BEFORE it touches the summary.
      diff: { patchText: 'p'.repeat(48 * 1024), files: [], changes: [], sensitivePaths: [] },
      hostAcceptance: {
        accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: 'ok',
        completionSummary: summary,
      },
    }));
    assert.equal(Buffer.byteLength(JSON.stringify(saved), 'utf8') <= 8 * 1024, true, 'the entry really was fitted');
    assert.equal(saved.hostAcceptance.completionSummary, summary, 'a legal summary is never shortened to fit');
    assert.equal(saved.goalDescription, '目标：短说明');
    assert.equal(saved.diff.patchText.endsWith('… [truncated]'), true, 'the existing text rule did the work instead');
    await store.flush();
    const [row] = await new HistoryStore(dir, limits).load();
    assert.equal(row.hostAcceptance.completionSummary, summary);
  } finally {
    await cleanup(dir);
  }
});

test('a legal summary that cannot fit the budget refuses the save and leaves the document alone', async () => {
  const dir = await dataDir();
  try {
    // The smallest entry budget the store accepts. A 2000-code-point summary is legal and
    // still too large for it: the save must refuse rather than store a shortened summary.
    const limits = { maxEntries: 4, maxBytes: 64 * 1024, maxEntryBytes: 4_096 };
    const store = new HistoryStore(dir, limits);
    await store.save(fixtureView({ taskId: 'task-small', goalDescription: '目标：先写一条短记录' }));
    await store.flush();
    const before = await readFile(join(dir, 'history.json'), 'utf8');

    const legalSummary = '实'.repeat(1_999);
    assert.equal(Array.from(legalSummary).length, 1_999);
    // A large execution text is provided so the failure is about the WHOLE entry, and the
    // fitter's own reductions are exhausted first — but a 2000-code-point summary alone
    // already exceeds this budget.
    await assert.rejects(
      () => store.save(fixtureView({
        taskId: 'task-small',
        goalDescription: '目标：先写一条短记录',
        execution: { outcome: 'completed', text: 'e'.repeat(40_000), error: null },
        hostAcceptance: {
          accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: 'ok',
          completionSummary: legalSummary,
        },
      })),
      (error) => error.code === HISTORY_CODES.entryTooLarge,
    );
    // The document is byte-for-byte what it was: no shortened summary was written.
    assert.equal(await readFile(join(dir, 'history.json'), 'utf8'), before, 'the old document is untouched');
  } finally {
    await cleanup(dir);
  }
});

test('a legal summary survives a bounded answer beside a long note, and no anomaly bypasses the cap', async () => {
  // A legal 2000-code-point summary is SMALL enough to keep while an 8000-code-point note is
  // paged away, so dropping it too would lose a readable fact for nothing. This pins that it
  // is kept, and that the two bodies are handled INDEPENDENTLY.
  const summary = '实'.repeat(2_000);
  const note = '审'.repeat(7_000);
  const fakeTask = {
    taskId: 't-note-long',
    state: 'awaiting-host-review',
    phase: 'awaiting-host-review',
    goalDescription: '目标：解释省略行为',
    execution: { outcome: 'completed', text: 'ok', error: null },
    diff: { patchText: 'd'.repeat(200_000), files: [], changes: [], sensitivePaths: [] },
    review: { state: 'not_run', verdict: null, text: '', error: null },
    hostAcceptance: {
      accepted: true, state: 'accepted', acceptedAt: 1_700_000_000_000, by: 'host-commander', note,
      noteChars: Array.from(note).length, completionSummary: summary,
    },
    selfApproved: false,
  };
  const mcp = createMcpServer({ async callExecution() { return { ok: true, task: fakeTask }; } });
  await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const read = await callTool(mcp, 2, 'delegate_result', { taskId: 't-note-long' });
  assert.equal(read.isError, false, read.text.slice(0, 160));
  assert.ok(read.text.length <= MAX_TOOL_TEXT_CHARS, 'the answer fits the bound');
  const acceptance = read.body.task?.hostAcceptance ?? read.body.hostAcceptance;
  assert.ok(acceptance !== null && acceptance !== undefined);
  // The note is either whole or explicitly omitted — never shortened.
  if (acceptance.note !== undefined) {
    assert.equal(acceptance.note, note, 'a published note is the whole note');
  } else {
    assert.equal(acceptance.noteOmitted, true);
    assert.equal(acceptance.noteChars, Array.from(note).length);
  }
  // The summary is KEPT whole: it is small enough that giving it up would be pointless.
  assert.equal(acceptance.completionSummary, summary, 'a legal summary is not dropped with the note');
  assert.equal(acceptance.completionSummaryOmitted, undefined);
});

test('an over-long same-named field nested anywhere else is still bounded and marked', async () => {
  // The projection must not assume its input is well formed. A field NAMED like a description
  // but sitting somewhere it cannot legally be (a synthetic block, the top level of an
  // arbitrary object, or a task value past the bound) does not get the verbatim exemption: it
  // is bounded like every other string, with its cut stated.
  const huge = 'Z'.repeat(5_000);
  const fakeTask = {
    taskId: 't-anomaly',
    state: 'awaiting-host-review',
    phase: 'awaiting-host-review',
    execution: { outcome: 'completed', text: 'ok', error: null },
    diff: { patchText: 'd'.repeat(120_000), files: [], changes: [], sensitivePaths: [] },
    review: { state: 'not_run', verdict: null, text: '', error: null },
    // Not a task position for a summary, and far past the accepted bound.
    extra: { completionSummary: huge, nested: { deeper: { goalDescription: huge } } },
    // A task-level value past the bound is equally not a validated description.
    goalDescription: `${{ length: 0 }.length}${huge}`,
    hostAcceptance: {
      accepted: true, state: 'accepted', acceptedAt: 1_700_000_000_000, by: 'host-commander',
      note: 'n'.repeat(6_000), noteChars: 6_000, completionSummary: huge,
    },
    selfApproved: false,
  };
  const mcp = createMcpServer({ async callExecution() { return { ok: true, task: fakeTask }; } });
  await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const read = await callTool(mcp, 2, 'delegate_result', { taskId: 't-anomaly' });
  assert.equal(read.isError, false, read.text.slice(0, 160));
  assert.ok(read.text.length <= MAX_TOOL_TEXT_CHARS, 'an anomalous document cannot widen the answer');
  // The goal POSITION is where the contract applies: a value there that is not a validated
  // description must not be published verbatim on the strength of its key name.
  const goal = read.body.task.goalDescription;
  assert.equal(typeof goal, 'string');
  assert.equal(String(goal).length < 5_000, true, 'an over-bound goal is not published verbatim');
  // The acceptance summary position follows the same rule.
  const acceptanceSummary = read.body.task?.hostAcceptance?.completionSummary;
  if (acceptanceSummary !== undefined) {
    assert.equal(String(acceptanceSummary).length < 5_000, true, 'an over-bound summary is not published verbatim');
  }
  // The answer states what was bounded and which fields were cut.
  const truncation = read.body.truncation;
  assert.ok(truncation !== null && truncation !== undefined, 'the answer reports its bound');
  assert.ok(Array.isArray(truncation.fields) && truncation.fields.length > 0, 'the cuts are named');
});

test('the MCP tool-text bound states an omitted summary instead of shortening it', async () => {
  // The engine's own view is injected into a fake execution client, so the projection under
  // test is the REAL one and the answer is over the bound for the real reason: a legal
  // 2000-code-point summary plus an 8000-code-point note cannot both fit.
  const summary = '实'.repeat(1_990);
  const note = '审'.repeat(7_900);
  // The fixture must be far over the bound so the projection really has to give something up;
  // the diff/execution bulk is what gets reduced first, and the two bodies are given up only
  // when even the reduced answer does not fit.
  const fakeTask = {
    taskId: 't-big',
    state: 'awaiting-host-review',
    phase: 'awaiting-host-review',
    goalDescription: '目标：一段很长的目标说明',
    execution: { outcome: 'completed', text: 'x'.repeat(400_000), error: null },
    diff: {
      patchText: 'd'.repeat(400_000),
      files: Array.from({ length: 300 }, (unused, index) => ({ code: 'M', path: `src/file-${index}.js` })),
      changes: Array.from({ length: 300 }, (unused, index) => ({ added: 1, removed: 0, path: `src/file-${index}.js` })),
      sensitivePaths: [],
    },
    review: { state: 'not_run', verdict: null, text: 'r'.repeat(100_000), error: null },
    hostAcceptance: {
      accepted: true, state: 'accepted', acceptedAt: 1_700_000_000_000, by: 'host-commander', note,
      noteChars: Array.from(note).length, completionSummary: summary,
    },
    selfApproved: false,
  };
  assert.ok(JSON.stringify(fakeTask).length > MAX_TOOL_TEXT_CHARS * 5, 'the fixture must really be far over the bound');
  const mcp = createMcpServer({ async callExecution() { return { ok: true, task: fakeTask }; } });
  await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const read = await callTool(mcp, 2, 'delegate_result', { taskId: 't-big' });
  assert.equal(read.isError, false, read.text.slice(0, 200));
  assert.ok(read.text.length <= MAX_TOOL_TEXT_CHARS, 'the answer fits the bound');
  assert.equal(read.body.truncation?.truncated, true, 'the answer states that it was bounded');
  const acceptance = read.body.task?.hostAcceptance ?? read.body.hostAcceptance;
  assert.ok(acceptance !== null && acceptance !== undefined, 'the acceptance block survives');
  // NOTHING about the two bodies may be silently shortened: either the full text is published,
  // or the omission is stated with its real length. A shortened body reads as the whole one.
  if (acceptance.completionSummary !== undefined) {
    assert.equal(acceptance.completionSummary, summary, 'a published summary is the WHOLE summary');
  } else {
    assert.equal(acceptance.completionSummaryOmitted, true, 'a missing summary is an explicit omission');
    assert.equal(acceptance.completionSummaryChars, Array.from(summary).length);
  }
  if (acceptance.note !== undefined) {
    assert.equal(typeof acceptance.noteOmitted === 'boolean' || acceptance.noteOmitted === undefined, true);
    if (acceptance.noteOmitted !== true) assert.equal(acceptance.note, note, 'a published note is the WHOLE note');
  } else {
    assert.equal(acceptance.noteOmitted, true);
  }
  // The goal is the commander's own statement and is carried whole through the bound.
  if (read.body.task?.goalDescription !== undefined) {
    assert.equal(read.body.task.goalDescription, '目标：一段很长的目标说明');
  }
});

// ---------------------------------------------------------------------------
// 7. Static checks: the declarations describe what is really returned
// ---------------------------------------------------------------------------

test('the type declarations state both fields and an omission flag on the compact shape', () => {
  const dts = readFileSync(join(ROOT, 'src', 'index.d.ts'), 'utf8');
  assert.match(dts, /completionSummary\?: string;/u);
  // The wire banner says what a wait carries: lengths and an omission flag. The compact
  // acceptance must NOT require a full summary body, so the Omit key set excludes both bodies.
  assert.match(dts, /completionSummaryChars\?: number;/u);
  assert.match(dts, /completionSummaryOmitted\?: true;/u);
  assert.match(
    dts,
    /interface DelegateCompactHostAcceptance extends Omit<DelegateHostAcceptance, 'note' \| 'completionSummary'>/u,
  );
  // And the compact observation summary declares NO goal text at all: a wait does not return
  // the description prose, so the type must not promise it.
  const observationBlock = dts.slice(
    dts.indexOf('export interface DelegateObservationSummary'),
    dts.indexOf('export interface', dts.indexOf('export interface DelegateObservationSummary') + 1),
  );
  assert.equal(/goalDescription/u.test(observationBlock), false, 'the compact summary must not declare the goal text');
});

// ---------------------------------------------------------------------------
// 8. N154-02: re-validating entry budgets after queue-time fact restoration
// ---------------------------------------------------------------------------

test('N154-02: restoring saved goal/review facts onto a stale snapshot re-validates entry budget and keeps refused files intact', async () => {
  // 1. Small budget: merged goal + accepted note cannot fit -> refuses with HISTORY_ENTRY_TOO_LARGE
  // and leaves history.json byte-for-byte unchanged.
  const smallDir = await dataDir();
  try {
    const limits = { maxEntryBytes: 4_096 };
    const goal = '目'.repeat(800);
    const store = new HistoryStore(smallDir, limits);
    const base = {
      taskId: 'audit-stale-small',
      state: 'awaiting-host-review',
      phase: 'awaiting-host-review',
      createdAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_000,
      connectionId: 'audit-only',
      sourcePath: 'C:/fixture/repo',
      hostAcceptance: null,
    };
    await store.save({ ...base, goalDescription: goal });
    await store.flush();
    const before = await readFile(join(smallDir, 'history.json'), 'utf8');

    await assert.rejects(
      () => store.save({
        ...base,
        hostAcceptance: {
          accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: 'n'.repeat(2_000),
        },
      }),
      (error) => error.code === HISTORY_CODES.entryTooLarge,
    );
    assert.equal(await readFile(join(smallDir, 'history.json'), 'utf8'), before, 'refused merge leaves disk untouched');
    const [reloadedSmall] = await new HistoryStore(smallDir, limits).load();
    assert.equal(reloadedSmall.goalDescription, goal);
    assert.equal(reloadedSmall.hostAcceptance, null);
    await store.dispose();
  } finally {
    await cleanup(smallDir);
  }

  // 2. Default budget: stale snapshot omits goal while carrying 200 long paths and short text fields
  // (including emoji surrogate pairs). Re-fitting trims array evidence identically to the explicit-goal
  // control and reloads byte-for-byte cleanly under the same 256 KiB bound.
  const missingDir = await dataDir();
  const explicitDir = await dataDir();
  try {
    const goal = '目'.repeat(2_000);
    const paths = Array.from({ length: 200 }, (_, i) => `src/${'directory/'.repeat(59)}file-${i}.js`);
    const base = {
      taskId: 'audit-stale-default',
      state: 'awaiting-host-review',
      phase: 'awaiting-host-review',
      createdAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_000,
      connectionId: 'audit-only',
      sourcePath: 'C:/fixture/repo',
      hostAcceptance: null,
    };
    const heavy = {
      ...base,
      diff: {
        files: paths.map((path) => ({ code: 'M', path })),
        changes: paths.map((path) => ({ added: 1, removed: 0, path })),
        fileCount: 200,
        patchText: 'ok',
      },
      execution: { outcome: 'completed', text: 'done' },
    };

    const s1 = new HistoryStore(missingDir);
    await s1.save({ ...base, goalDescription: goal });
    const mergedSaved = await s1.save(heavy);
    await s1.dispose();

    const s2 = new HistoryStore(explicitDir);
    await s2.save({ ...base, goalDescription: goal });
    const explicitSaved = await s2.save({ ...heavy, goalDescription: goal });
    await s2.dispose();

    const rawMissing = await readFile(join(missingDir, 'history.json'), 'utf8');
    const onDiskMissing = JSON.parse(rawMissing).jobs[0];
    const onDiskExplicit = JSON.parse(await readFile(join(explicitDir, 'history.json'), 'utf8')).jobs[0];
    assert.ok(Buffer.byteLength(JSON.stringify(onDiskMissing), 'utf8') <= 262_144);
    assert.equal(Buffer.byteLength(JSON.stringify(onDiskMissing), 'utf8'), Buffer.byteLength(JSON.stringify(onDiskExplicit), 'utf8'));
    assert.equal(mergedSaved.goalDescription, goal);
    assert.equal(explicitSaved.goalDescription, goal);
    assert.equal(mergedSaved.execution.text, 'done', 'short free-text fields are not expanded with truncation markers');

    const [reloadedMissing] = await new HistoryStore(missingDir).load();
    const [reloadedExplicit] = await new HistoryStore(explicitDir).load();
    assert.equal(reloadedMissing.goalDescription, goal);
    assert.equal(reloadedExplicit.goalDescription, goal);
    assert.equal(await readFile(join(missingDir, 'history.json'), 'utf8'), rawMissing, 'reload is byte-for-byte idempotent');
  } finally {
    await cleanup(missingDir);
    await cleanup(explicitDir);
  }

  // 3. Combined restoration of BOTH recorded review (with completionSummary) AND savedGoal on a stale
  // snapshot omitting both: fits by cutting emoji patch text without producing lone surrogates, or
  // refuses cleanly without modifying disk when goal + review alone exceed the budget.
  const bothDir = await dataDir();
  try {
    const limits = { maxEntryBytes: 8_192, maxBytes: 32_768 };
    const goal = '目'.repeat(600);
    const summary = '完'.repeat(600);
    const store = new HistoryStore(bothDir, limits);
    const base = {
      taskId: 'audit-stale-both',
      state: 'awaiting-host-review',
      phase: 'awaiting-host-review',
      createdAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_000,
      connectionId: 'audit-only',
      sourcePath: 'C:/fixture/repo',
    };
    await store.save({
      ...base,
      goalDescription: goal,
      hostAcceptance: {
        accepted: true,
        state: 'accepted',
        acceptedAt: 1_700_000_002_000,
        by: 'host-commander',
        note: '通过',
        completionSummary: summary,
      },
    });
    const staleWithEmojiPatch = {
      ...base,
      hostAcceptance: null,
      diff: { patchText: '😀'.repeat(1_501), patchTruncated: false },
    };
    const mergedBoth = await store.save(staleWithEmojiPatch);
    assert.equal(mergedBoth.goalDescription, goal);
    assert.equal(mergedBoth.hostAcceptance.completionSummary, summary);
    assert.equal(mergedBoth.diff.patchTruncated, true);
    assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(mergedBoth.diff.patchText), false);
    assert.ok(Buffer.byteLength(JSON.stringify(mergedBoth), 'utf8') <= limits.maxEntryBytes);
    await store.dispose();

    const [reloadedBoth] = await new HistoryStore(bothDir, limits).load();
    assert.equal(reloadedBoth.goalDescription, goal);
    assert.equal(reloadedBoth.hostAcceptance.completionSummary, summary);
  } finally {
    await cleanup(bothDir);
  }
});

// ---------------------------------------------------------------------------
// 9. N154-01: field-specific hostAcceptance projection & summary paging
// ---------------------------------------------------------------------------

test('N154-01: skeletonised MCP projections keep legal summaries whole across all four shapes and support verbatim paging when omitted', async () => {
  const dir = await dataDir();
  try {
    const summary = `完成说明 🎯\n第二行：保留换行与多字节字符\n${'实'.repeat(1_968)}`;
    assert.equal(Array.from(summary).length, 1_990);
    const note = `审查意见：\n${'审'.repeat(7_889)}`;
    const goal = `目标：\n${'目'.repeat(1_800)}`;
    const paths = Array.from({ length: 40 }, (_, i) => `src/${'directory/'.repeat(110)}file-${i}.js`);

    const store = new HistoryStore(dir);
    await store.save({
      taskId: 'audit-n154-01',
      state: 'awaiting-host-review',
      phase: 'awaiting-host-review',
      title: '审计夹具',
      createdAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_000,
      connectionId: 'audit-only',
      sourcePath: 'C:/fixture/repo',
      goalDescription: goal,
      diff: {
        files: paths.map((path) => ({ code: 'M', path })),
        changes: paths.map((path) => ({ added: 1, removed: 0, path })),
        fileCount: 40,
        patchText: 'diff'.repeat(10_000),
      },
      execution: { outcome: 'completed', text: 'done' },
      hostAcceptance: {
        accepted: true,
        state: 'accepted',
        acceptedAt: 1_700_000_002_000,
        by: 'host-commander',
        note,
        completionSummary: summary,
      },
    });
    await store.dispose();

    const [stored] = await new HistoryStore(dir).load();
    assert.equal(stored.hostAcceptance.completionSummary, summary);

    // 1. Storage -> reload -> delegate_result (`task.hostAcceptance` skeleton stage).
    const mcpResult = createMcpServer({ async callExecution() { return { ok: true, task: structuredClone(stored) }; } });
    await mcpResult.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const res1 = await callTool(mcpResult, 2, 'delegate_result', { taskId: 'audit-n154-01' });
    assert.equal(res1.isError, false);
    assert.ok(res1.text.length <= MAX_TOOL_TEXT_CHARS);
    assert.equal(res1.body.task.goalDescription, goal);
    assert.equal(res1.body.task.hostAcceptance.completionSummary, summary, 'task.hostAcceptance keeps whole summary');
    if (res1.body.task.hostAcceptance.note !== undefined) {
      assert.equal(res1.body.task.hostAcceptance.note, note);
    } else {
      assert.equal(res1.body.task.hostAcceptance.noteOmitted, true);
      assert.equal(res1.body.task.hostAcceptance.noteChars, Array.from(note).length);
    }

    // 2. Top-level `hostAcceptance` forced into skeletonisation.
    const mcpTop = createMcpServer({
      async callExecution() {
        return {
          ok: true,
          hostAcceptance: structuredClone(stored.hostAcceptance),
          extra: Array.from({ length: 30 }, (_, i) => `${i}:${'x'.repeat(900)}`),
        };
      },
    });
    await mcpTop.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const res2 = await callTool(mcpTop, 2, 'delegate_status', {});
    assert.equal(res2.isError, false);
    assert.ok(res2.text.length <= MAX_TOOL_TEXT_CHARS);
    assert.equal(res2.body.hostAcceptance.completionSummary, summary, 'top-level hostAcceptance keeps whole summary');
    if (res2.body.hostAcceptance.note !== undefined) {
      assert.equal(res2.body.hostAcceptance.note, note);
    } else {
      assert.equal(res2.body.hostAcceptance.noteOmitted, true);
      assert.equal(res2.body.hostAcceptance.noteChars, Array.from(note).length);
    }

    // 3. Task list (`tasks[]` forced to `lists: 1` + skeleton stage).
    const mcpList = createMcpServer({
      async callExecution() {
        return {
          ok: true,
          tasks: [structuredClone(stored), { ...structuredClone(stored), taskId: 'audit-n154-01-second' }],
        };
      },
    });
    await mcpList.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const res3 = await callTool(mcpList, 2, 'delegate_status', {});
    assert.equal(res3.isError, false);
    assert.ok(res3.text.length <= MAX_TOOL_TEXT_CHARS);
    assert.equal(res3.body.tasks[0].hostAcceptance.completionSummary, summary, 'tasks[0] keeps whole summary');

    // 4. `delegate_review` reply carrying BOTH `task.hostAcceptance` and top-level `hostAcceptance`
    // (duplicated 7895-char note exceeds 20,000 in Stage 6a and triggers `omitNote: true`).
    const mcpReview = createMcpServer({
      async callExecution() {
        return {
          ok: true,
          task: structuredClone(stored),
          hostAcceptance: structuredClone(stored.hostAcceptance),
          reviewPersistence: { state: 'saved', decision: 'accepted', accepted: true, durable: true, pending: false },
        };
      },
    });
    await mcpReview.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const res4 = await callTool(mcpReview, 2, 'delegate_review', {
      taskId: 'audit-n154-01', decision: 'accepted', note: 'ok', completionSummary: 'ok',
    });
    assert.equal(res4.isError, false);
    assert.ok(res4.text.length <= MAX_TOOL_TEXT_CHARS);
    assert.equal(res4.body.task.hostAcceptance.completionSummary, summary);
    assert.equal(res4.body.hostAcceptance.completionSummary, summary);
    assert.equal(res4.body.task.hostAcceptance.noteOmitted, true);
    assert.equal(res4.body.hostAcceptance.noteOmitted, true);
    assert.equal(res4.body.task.hostAcceptance.noteChars, Array.from(note).length);
    assert.equal(res4.body.hostAcceptance.noteChars, Array.from(note).length);

    // 5. Extreme JSON-escaped legal descriptions (`\u0001` × 2000 = 12,002 JSON chars each) where
    // keeping both whole exceeds 20,000 chars -> summary is explicitly omitted with length AND
    // recovered verbatim via `completionSummaryOffset` / `completionSummaryLimit`.
    const controlGoal = '\u0001'.repeat(2_000);
    const controlSummary = `${'\u0001'.repeat(1_995)}🎯\n中文完`;
    assert.equal(Array.from(controlSummary).length, 2_000);
    const extremeTask = {
      ...structuredClone(stored),
      goalDescription: controlGoal,
      hostAcceptance: { ...structuredClone(stored.hostAcceptance), completionSummary: controlSummary },
    };
    const mcpExtreme = createMcpServer({
      async callExecution() {
        return { ok: true, task: structuredClone(extremeTask) };
      },
    });
    await mcpExtreme.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const res5 = await callTool(mcpExtreme, 2, 'delegate_result', { taskId: 'audit-n154-01' });
    assert.equal(res5.isError, false);
    assert.ok(res5.text.length <= MAX_TOOL_TEXT_CHARS);
    assert.equal(res5.body.task.hostAcceptance.completionSummary, undefined);
    assert.equal(res5.body.task.hostAcceptance.completionSummaryOmitted, true);
    assert.equal(res5.body.task.hostAcceptance.completionSummaryChars, 2_000);

    // Reassemble the omitted summary across multiple pages (700 code points/page) and check single-page read.
    const singlePage = await callTool(mcpExtreme, 3, 'delegate_result', {
      taskId: 'audit-n154-01', completionSummaryOffset: 0,
    });
    assert.equal(singlePage.isError, false);
    assert.ok(singlePage.text.length <= MAX_TOOL_TEXT_CHARS);
    assert.equal(singlePage.body.completionSummary.text, controlSummary);
    assert.equal(singlePage.body.completionSummary.complete, true);
    assert.equal(singlePage.body.completionSummary.nextOffset, null);

    const chunks = [];
    let offset = 0;
    let reqId = 10;
    while (offset !== null) {
      const page = await callTool(mcpExtreme, reqId++, 'delegate_result', {
        taskId: 'audit-n154-01', completionSummaryOffset: offset, completionSummaryLimit: 700,
      });
      assert.equal(page.isError, false);
      assert.equal(page.body.completionSummary.summaryChars, 2_000);
      assert.equal(page.body.completionSummary.present, true);
      chunks.push(page.body.completionSummary.text);
      offset = page.body.completionSummary.complete ? null : page.body.completionSummary.nextOffset;
    }
    assert.equal(chunks.length, 3);
    assert.equal(chunks.join(''), controlSummary, 'paged reads reassemble the exact omitted summary');

    // Out-of-bounds offset past end returns empty complete slice; invalid args refuse cleanly.
    const pastEnd = await callTool(mcpExtreme, 20, 'delegate_result', {
      taskId: 'audit-n154-01', completionSummaryOffset: 5_000,
    });
    assert.equal(pastEnd.isError, false);
    assert.equal(pastEnd.body.completionSummary.text, '');
    assert.equal(pastEnd.body.completionSummary.offset, 2_000);
    assert.equal(pastEnd.body.completionSummary.complete, true);
    assert.equal(pastEnd.body.completionSummary.nextOffset, null);

    for (const badArgs of [
      { completionSummaryOffset: -1 },
      { completionSummaryOffset: 0, completionSummaryLimit: 0 },
      { completionSummaryOffset: 0, completionSummaryLimit: 2_001 },
      { completionSummaryLimit: 100 },
      { reviewNoteOffset: 0, completionSummaryOffset: 0 },
    ]) {
      const bad = await callTool(mcpExtreme, reqId++, 'delegate_result', { taskId: 'audit-n154-01', ...badArgs });
      assert.equal(bad.isError, true, `invalid paging args must be refused: ${JSON.stringify(badArgs)}`);
    }
  } finally {
    await cleanup(dir);
  }
});

test('N154-01: completionSummaryOffset over the real execution plane enforces task ownership before and after restart', async () => {
  const first = await harness();
  const origin = 'http://127.0.0.1:3211';
  const summary = `完成说明 🚀\n跨重启分页校验\n${'终'.repeat(1_970)}`;
  let ownTaskId;
  const foreignTaskId = 'task-foreign-summary-check';
  try {
    ownTaskId = await finishedTask(first, { goalDescription: '自有任务' });
    await first.engine.recordHostReview({
      connectionId: 'local-mcp', taskId: ownTaskId, decision: 'accepted', note: 'ok', completionSummary: summary,
    });
    await first.store.save({
      taskId: foreignTaskId,
      state: 'awaiting-host-review',
      phase: 'awaiting-host-review',
      createdAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_000,
      connectionId: 'other-conn',
      sourcePath: first.workspace,
      hostAcceptance: {
        accepted: true,
        state: 'accepted',
        acceptedAt: 1_700_000_002_000,
        by: 'host-commander',
        note: 'ok',
        completionSummary: '秘密说明',
      },
    });
    await first.store.flush();

    // Check live in-process paged read + foreign ownership refusal before restart.
    const { createExecutionClient } = await import('../bin/dsh-delegate-mcp.js');
    const liveHandler = createExecutionHandler({
      engine: first.engine, auth: first.engine.auth, settings: first.settings, logger: { warn() {} },
      getBindHost: () => '127.0.0.1',
    });
    const liveFetch = await installPlaneFetch(liveHandler, origin);
    try {
      const liveMcp = createMcpServer({
        callExecution: createExecutionClient({ baseUrl: origin, timeoutMs: 5_000 }),
      });
      await liveMcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      const liveOwn = await callTool(liveMcp, 2, 'delegate_result', {
        taskId: ownTaskId, completionSummaryOffset: 0, completionSummaryLimit: 500,
      });
      assert.equal(liveOwn.isError, false);
      assert.equal(liveOwn.body.completionSummary.text, Array.from(summary).slice(0, 500).join(''));
      const liveForeign = await callTool(liveMcp, 3, 'delegate_result', {
        taskId: foreignTaskId, completionSummaryOffset: 0,
      });
      assert.equal(liveForeign.isError, true);
      assert.equal(liveForeign.body.error.code, JOB_CODES.taskNotFound);
      assert.equal(liveForeign.text.includes('秘密说明'), false);
    } finally {
      liveFetch.restore();
    }
  } finally {
    await first.engine.dispose();
  }

  const second = await bootOver(first.dir);
  const restore = await installPlaneFetch(second.handler, origin);
  try {
    const { createExecutionClient } = await import('../bin/dsh-delegate-mcp.js');
    const mcp = createMcpServer({
      callExecution: createExecutionClient({ baseUrl: origin, timeoutMs: 5_000 }),
    });
    await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    const p1 = await callTool(mcp, 2, 'delegate_result', {
      taskId: ownTaskId, completionSummaryOffset: 0, completionSummaryLimit: 1_000,
    });
    const p2 = await callTool(mcp, 3, 'delegate_result', {
      taskId: ownTaskId, completionSummaryOffset: p1.body.completionSummary.nextOffset, completionSummaryLimit: 1_000,
    });
    assert.equal(p1.isError, false);
    assert.equal(p2.isError, false);
    assert.equal(p2.body.completionSummary.complete, true);
    assert.equal(p1.body.completionSummary.text + p2.body.completionSummary.text, summary);

    // Foreign task is refused identically on paged summary read (no leak of existence or summary).
    const foreign = await callTool(mcp, 4, 'delegate_result', {
      taskId: foreignTaskId, completionSummaryOffset: 0,
    });
    assert.equal(foreign.isError, true);
    assert.equal(foreign.body.error.code, JOB_CODES.taskNotFound);
    assert.equal(foreign.text.includes('秘密说明'), false);
  } finally {
    restore.restore();
    await second.h.close();
    await cleanup(first.dir);
  }
});
