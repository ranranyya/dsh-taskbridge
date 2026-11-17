// G10 / G11 — the host-acceptance row and the review-note block.
//
// G10: the detail's "宿主验收" row used to splice a 200-code-point cut of the saved review
// note into its own sentence. Past 200 code points that produced a SECOND, truncated copy
// of the note that read as if the stored text itself had been cut ("…（已截断）"),
// contradicting the "完整审查意见" block right below it, which shows the whole body.
//
// G11: the note block had no width boundary, so a long unbroken run (a 270-code-point
// Chinese sentence, a path, an emoji run) could push it wider than the settings panel. It
// now wraps inside its own track and is never clipped.
//
// What is asserted here, as USER BEHAVIOUR:
//   * the row states the conclusion, its time and that the conclusion is saved — never
//     the note body, and never a conclusion the headline does not carry (accepted:true with
//     a write that is not durable stays "保存中"/"未确认"/"保存失败");
//   * the REAL built page (lib/client.js through `window.__ModuleLoader__`, the same loader
//     `tests/ui-dom-acceptance.test.js` uses) shows that row and the whole note once, and a
//     copy hands the clipboard exactly the saved string;
//   * a compact (noteOmitted) row reads the full task on demand and keeps the body across a
//     background refresh;
//   * a note the HOST really truncated keeps its own marker — the display never invents or
//     removes one;
//   * the stylesheet gives the note its width boundary and wrap rules with nothing clipping.
//
// The store is the real one from `src/client/api.js`; only the transport is a double.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { formatTime, hostReviewLine, taskOutcome } from '../src/client/api.js';
import { CSS_TEXT } from '../src/client/styles.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Sample notes: real host text is Chinese, multi-paragraph, emoji-heavy and sometimes
// carries a very long unbroken path. Each is built to an EXACT code-point count.
// ---------------------------------------------------------------------------

/**
 * A note of an exact number of code points made of Chinese text and emoji.
 * @param {number} count - code points.
 * @returns {string} note.
 */
function longNote(count) {
  const pieces = ['审查意见：', '这一项需要修正，', '因为排版问题。', '😀', '🧪', '🚧'];
  let out = '';
  for (let index = 0; Array.from(out).length < count; index += 1) out += pieces[index % pieces.length];
  return Array.from(out).slice(0, count).join('');
}

const NOTE_253 = longNote(253);
const NOTE_270 = longNote(270);
const NOTE_MULTI = [
  '第一段：正文必须完整显示，不能被截断，也不能靠裁切来修布局。',
  '',
  '第二段：中文、emoji 😀🧪 混排，段落之间保留空行，空格也保留。',
  '',
  '第三段：连续长路径 C:\\Users\\worker\\AppData\\Local\\dsh-delegate\\node_modules\\@deepseek-ai\\dsh-client-modules\\lib\\client.js 应当自行换行。',
  '',
  '第四段：结尾。',
].join('\n');
/** No break opportunity at all: one very long unbroken run. */
const NOTE_UNBROKEN = `${'A'.repeat(120)}${'/'.repeat(60)}${'连续中文没有空格的超长审查意见'.repeat(6)}`;
/** A note the HOST itself stored with a truncation marker (a real historical cut). */
const NOTE_HOST_TRUNCATED = `${longNote(240)}\n…（已截断）`;

/**
 * A format-time double that names the instant it was asked about: it echoes the stored
 * `acceptedAt` verbatim, so a row that dropped or invented a time cannot pass.
 * @param {number} at - epoch ms.
 * @returns {string} stable token.
 */
function stamp(at) {
  return `@${at}`;
}

/**
 * The row a caller's formatter produces for a recorded decision: the helper hands the
 * stored `acceptedAt` to the caller's `formatTime`, so the expectation is derived from the
 * same function rather than a hard-coded locale string.
 * @param {string} label - conclusion the headline carries.
 * @param {string} [suffix] - extra statement after the time.
 * @returns {string} expected row text.
 */
function expectedRow(label, suffix = '') {
  return `${label}（${stamp(ACCEPTANCE.acceptedAt)}）${suffix}`;
}

/**
 * The time label the PAGE prints for a recorded decision.
 *
 * The built page formats with its own copy of the documented `formatTime` helper, so the
 * DOM expectation is computed by that helper in this locale rather than hard-coded — under
 * a different ICU build it is merely another rendering of the same instant.
 */
function pageTime() {
  return formatTime(ACCEPTANCE.acceptedAt);
}

/** A task shaped like the user plane publishes it. */
function taskRecord(overrides = {}) {
  return {
    taskId: 'task-1',
    title: '测试任务',
    state: 'awaiting-host-review',
    phase: 'awaiting-host-review',
    createdAt: 1_763_200_000_000,
    endedAt: 1_763_200_100_000,
    workspacePath: 'C:\\work',
    isolation: 'worktree',
    effective: { worker: { providerId: 'relay', model: 'm', reasoningEffort: 'high' } },
    hostAcceptance: null,
    archived: false,
    live: true,
    ...overrides,
  };
}

const ACCEPTANCE = Object.freeze({
  accepted: true, state: 'accepted', acceptedAt: 1_763_200_050_000, by: 'host', note: NOTE_270,
});
const SAVED = Object.freeze({ state: 'saved', durable: true, pending: false });

// ---------------------------------------------------------------------------
// G10: the row
// ---------------------------------------------------------------------------

test('G10: the host-acceptance row carries the conclusion and time, never the note body', () => {
  for (const [name, note] of [['253', NOTE_253], ['270', NOTE_270], ['multi-paragraph', NOTE_MULTI],
    ['unbroken', NOTE_UNBROKEN], ['host-truncated', NOTE_HOST_TRUNCATED], ['empty', '']]) {
    const task = taskRecord({
      hostAcceptance: { ...ACCEPTANCE, note },
      reviewPersistence: SAVED,
    });
    const line = hostReviewLine(task, stamp);
    if (note !== '') {
      assert.equal(line.includes(Array.from(note).slice(0, 40).join('')), false,
        `${name}: the body (or its first 40 code points) does not appear in the row`);
    }
    assert.equal(line.includes('已截断'), false, `${name}: no truncation marker on the row`);
    // What the operator reads: the conclusion, its time, and that it is stored.
    assert.equal(line, expectedRow('审查通过', '（结论已保存）'), `${name}: conclusion, time, saved`);
  }
});

test('G10: the row repeats taskOutcome and never claims a conclusion that is not stored', () => {
  const cases = [
    ['accepted, durable', { hostAcceptance: ACCEPTANCE, reviewPersistence: SAVED }, expectedRow('审查通过', '（结论已保存）')],
    ['accepted, older record (no reviewPersistence)', { hostAcceptance: ACCEPTANCE }, expectedRow('审查通过', '（结论已保存）')],
    ['changes-requested, durable', {
      hostAcceptance: { ...ACCEPTANCE, accepted: false, state: 'changes-requested' },
      reviewPersistence: SAVED,
    }, expectedRow('需要修正', '（结论已保存）')],
    // accepted:true is NOT acceptance while the record is not durable. The row keeps the
    // helper's own wording and adds no "saved" suffix of its own.
    ['accepted + saving', {
      hostAcceptance: ACCEPTANCE, reviewPersistence: { state: 'saving', durable: false, pending: true, decision: 'accepted' },
    }, expectedRow('审查结论保存中')],
    ['accepted + timed out', {
      hostAcceptance: ACCEPTANCE, reviewPersistence: { state: 'timed-out', durable: false, pending: true, decision: 'accepted' },
    }, expectedRow('审查结论保存未确认')],
    ['accepted + failed write', {
      hostAcceptance: ACCEPTANCE, reviewPersistence: { state: 'failed', durable: false, pending: false, decision: 'accepted' },
    }, expectedRow('审查结论保存失败')],
  ];
  for (const [name, overrides, expected] of cases) {
    const task = { ...taskRecord(), ...overrides };
    const outcome = taskOutcome(task);
    assert.equal(hostReviewLine(task, stamp), expected, name);
    // The row's conclusion is literally the headline's conclusion.
    assert.equal(expected.startsWith(outcome.label), true, `${name}: the row starts with the headline label`);
    // Only a DECIDED record adds the saved suffix; only an ACCEPTED one says 审查通过.
    assert.equal(expected.includes('（结论已保存）'), outcome.decided, `${name}: saved suffix iff decided`);
    assert.equal(expected.includes('审查通过'), outcome.accepted, `${name}: 审查通过 iff accepted`);
  }
});

test('G10: nothing recorded keeps the compatibility sentence; a pending write is not silence', () => {
  const cases = [
    ['no record', { hostAcceptance: null }, '未记录（插件不会自行验收）'],
    ['explicit none', { hostAcceptance: null, reviewPersistence: { state: 'none', durable: false, pending: false } },
      '未记录（插件不会自行验收）'],
    // A write in flight or failed without an acceptance object is its own state, and
    // taskOutcome has already named it — stated once, not spliced into a second sentence.
    ['saving', { hostAcceptance: null, reviewPersistence: { state: 'saving', durable: false, pending: true } },
      '审查结论保存中'],
    ['timed-out', { hostAcceptance: null, reviewPersistence: { state: 'timed-out', durable: false, pending: true } },
      '审查结论保存未确认'],
    ['failed', { hostAcceptance: null, reviewPersistence: { state: 'failed', durable: false } },
      '审查结论保存失败'],
    // A record with no time invents none.
    ['no acceptedAt', { hostAcceptance: { accepted: true, state: 'accepted' } }, '审查通过（结论已保存）'],
  ];
  for (const [name, overrides, expected] of cases) {
    assert.equal(hostReviewLine({ ...taskRecord(), ...overrides }, stamp), expected, name);
  }
});

// ---------------------------------------------------------------------------
// The real page: the built bundle, the real React tree, real DOM clicks.
// ---------------------------------------------------------------------------

/**
 * A jsdom window with the globals React needs.
 *
 * The clipboard is installed on the jsdom navigator BEFORE that navigator becomes the Node
 * global: the page's copy handler reads `globalThis.navigator.clipboard` when the click
 * happens, and the bundle resolves `navigator` from the Node global scope, not from the
 * window object. Installing it later (or only on `window`) silently loses the write.
 * @returns {object} window, recorded clipboard writes, and teardown.
 */
function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3210/',
    pretendToBeVisual: true,
  });
  const writes = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    value: { writeText(value) { writes.push(value); return Promise.resolve(); } },
    configurable: true,
  });
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  const keys = ['window', 'document', 'navigator', 'MouseEvent', 'Event', 'Node'];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    MouseEvent: dom.window.MouseEvent,
    Event: dom.window.Event,
    Node: dom.window.Node,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return {
    dom,
    writes,
    restore() {
      for (const key of keys) {
        const descriptor = previous.get(key);
        if (descriptor === undefined) delete globalThis[key];
        else Object.defineProperty(globalThis, key, descriptor);
      }
      dom.window.close();
    },
  };
}

/**
 * Run the BUILT bundle through the native module loader, exactly as the web client does.
 *
 * A browser page always has a `navigator`; a bare `vm` sandbox does not, so the sandbox is
 * given the test window's `navigator` (including the clipboard stub). That completes the
 * environment the bundle expects — it does not change any shipped code.
 * @returns {Promise<object>} `{ react, reactDomClient, client }`.
 */
async function loadClient() {
  const react = await import('react');
  const jsxRuntime = await import('react/jsx-runtime');
  const reactDomClient = await import('react-dom/client');
  const { createContext, runInContext } = await import('node:vm');
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const registrations = [];
  const window = { __ModuleLoader__: { load(registration) { registrations.push(registration); } } };
  const sandbox = {
    window,
    navigator: globalThis.navigator,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    Date,
    Math,
    JSON,
  };
  sandbox.globalThis = sandbox;
  runInContext(bundle, createContext(sandbox));
  if (registrations.length !== 1) throw new Error('lib/client.js must register exactly one module');
  const require = (specifier) => {
    if (specifier === 'react') return react;
    if (specifier === 'react/jsx-runtime') return jsxRuntime;
    throw new Error(`lib/client.js requested an unexpected module ${JSON.stringify(specifier)}`);
  };
  return { react, reactDomClient, client: registrations[0].factory(require) };
}

/** Flush timers and microtasks; inside `act` when one is supplied. */
async function settle(act) {
  const flush = async () => {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((done) => { setTimeout(done, 2); });
    }
  };
  if (typeof act === 'function' && globalThis.IS_REACT_ACT_ENVIRONMENT === true) {
    await act(flush);
    return;
  }
  await flush();
}

/** A settings document the client precheck accepts, as the host serves it. */
function hostSettings() {
  return {
    schemaVersion: 1,
    delegationEnabled: false,
    providers: [{ id: 'relay', name: 'Relay', source: 'native', models: [{ id: 'm', efforts: ['high'] }] }],
    worker: {
      providerId: 'relay', model: 'm', reasoningEffort: 'high',
      timeoutSeconds: 1800, maxParallelism: 1, isolation: 'worktree',
    },
    review: { enabled: false, providerId: null, model: null, reasoningEffort: null },
    authorization: { taskGrantTtlSeconds: 900, sessionGrantTtlSeconds: 14400 },
    monitoring: { selfCheckSeconds: 300, attentionSeconds: 600, repeatFailureThreshold: 3 },
    projectOverrides: {},
    presets: [],
    conversation: { mode: 'new' },
  };
}

/**
 * A store over a scripted user plane.
 * @param {object} options - `tasks` (list rows), `getTask` (full record read).
 * @returns {Promise<object>} store plus a way to change the next list answer.
 */
async function makeStore(options = {}) {
  const apiModule = await import('../src/client/api.js');
  let rows = options.tasks ?? [taskRecord()];
  const api = {
    async getStatus() { return { ok: true }; },
    async getSettings() { return { ok: true, settings: hostSettings() }; },
    async getNativeProviders() { return { ok: true, providers: [] }; },
    async listTasks() { return { ok: true, tasks: rows }; },
    async getTask(taskId) { return await options.getTask(taskId); },
    async putSettings(document) { return { ok: true, settings: document }; },
  };
  const store = apiModule.createStore({ api, saveDebounceMs: 5 });
  return { store, setRows(next) { rows = next; } };
}

/**
 * Render the real page, switch to the task records tab, and expose query helpers.
 * @param {object} store - store under test.
 * @returns {Promise<object>} page helpers.
 */
async function renderPage(store) {
  const { react, reactDomClient, client } = await loadClient();
  await store.init();
  const container = reactDomClient.createRoot(globalThis.document.getElementById('root'));
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const testUtils = await import('react-dom/test-utils');
  const act = typeof react.act === 'function' ? react.act : testUtils.act;
  await act(async () => {
    container.render(react.createElement(client.DelegateConfigPage, { store }));
    await settle();
  });
  await act(() => settle());
  const root = globalThis.document.getElementById('root');
  const click = async (node) => {
    await act(async () => {
      node.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, cancelable: true }));
      await settle();
    });
    await settle(act);
  };
  const page = {
    root,
    act,
    settle: () => settle(act),
    click,
    async unmount() { await act(async () => { container.unmount(); }); },
    /** The button whose trimmed text equals `text`. */
    button(text) {
      const found = [...root.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === text);
      assert.ok(found !== undefined,
        `button ${JSON.stringify(text)} exists; saw ${[...root.querySelectorAll('button')].map((b) => b.textContent.trim()).join(' | ')}`);
      return found;
    },
    /** The 宿主验收 value cell of the open detail. */
    hostReviewCell() {
      const detail = root.querySelector('[data-dshdg-task-detail]');
      assert.ok(detail !== null, 'the detail panel is open');
      const dt = [...detail.querySelectorAll('dl.dshdg-kv > dt')]
        .find((node) => (node.textContent ?? '').trim() === '宿主验收');
      assert.ok(dt !== undefined, 'the detail has a 宿主验收 row');
      return dt.nextElementSibling;
    },
    /** The <pre> holding the whole note. */
    noteBody() {
      const body = root.querySelector('[data-dshdg-task-detail] [data-dshdg-note-full] pre');
      assert.ok(body !== null, 'the full note block is rendered');
      return body;
    },
  };
  const tab = [...root.querySelectorAll('[role="tablist"] button')]
    .find((button) => (button.textContent ?? '').includes('任务记录'));
  assert.ok(tab !== undefined, 'the 任务记录 tab exists');
  await click(tab);
  return page;
}

/** Render one full task's detail and return the page (caller unmounts). */
async function openDetail(hostTask, options = {}) {
  const fixture = await makeStore({
    tasks: options.rows ?? [taskRecord()],
    getTask: async () => ({ ok: true, task: hostTask }),
  });
  const page = await renderPage(fixture.store);
  await page.click(page.button('详情'));
  return { page, store: fixture.store, setRows: fixture.setRows };
}

test('G10/G11 DOM: 253 / 270 / multi-paragraph / unbroken notes are whole in 完整审查意见 and absent from 宿主验收', async () => {
  // One page per sample: the review note is the point, so each sample gets its own render.
  for (const [name, note] of [['253 code points', NOTE_253], ['270 code points', NOTE_270],
    ['multi-paragraph', NOTE_MULTI], ['unbroken run', NOTE_UNBROKEN]]) {
    const dom = installDom();
    try {
      const { page, store } = await openDetail(taskRecord({
        hostAcceptance: { ...ACCEPTANCE, note },
        reviewPersistence: SAVED,
      }));

      // 1. What the operator reads in 宿主验收: conclusion, time, stored — no body.
      const lineText = (page.hostReviewCell().textContent ?? '').trim();
      assert.equal(lineText, `审查通过（${pageTime()}）（结论已保存）`, name);
      assert.equal(lineText.includes(Array.from(note).slice(0, 24).join('')), false,
        `${name}: no body fragment in the status row`);
      assert.equal(lineText.includes('已截断'), false, `${name}: no truncation marker in the status row`);

      // 2. The body is shown once, whole: textContent equals the input character for character.
      const body = page.noteBody();
      assert.equal(body.textContent, note, `${name}: textContent is the saved string`);
      // Each (non-empty) line appears exactly once, so a line the note itself repeats is not
      // mistaken for a second copy of the body somewhere else on the page.
      for (const line of note.split('\n').filter((part) => part !== '')) {
        const escaped = line.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        assert.equal((body.textContent.match(new RegExp(escaped, 'gu')) ?? []).length, 1, `${name}: the line occurs once`);
      }
      assert.equal(page.root.querySelectorAll('[data-dshdg-note-full]').length, 1,
        `${name}: exactly one note block is rendered`);

      // 3. Copy hands the clipboard EXACTLY the saved note: click the real button and read
      //    what the component wrote through `navigator.clipboard.writeText`.
      await page.click(page.button('复制全文'));
      assert.equal(dom.writes.length, 1, `${name}: one click wrote to the clipboard`);
      assert.equal(dom.writes[0], note, `${name}: the clipboard holds exactly the saved note`);
      assert.match(page.root.textContent, /已复制完整审查意见/u, `${name}: and the page says so`);

      await page.unmount();
      store.dispose();
    } finally {
      dom.restore();
    }
  }
});

test('G10 DOM: an accepted decision whose write is not durable is never shown as 审查通过', async () => {
  for (const [state, pending, expected] of [
    ['saving', true, `审查结论保存中（${pageTime()}）`],
    ['timed-out', true, `审查结论保存未确认（${pageTime()}）`],
    ['failed', false, `审查结论保存失败（${pageTime()}）`],
  ]) {
    const dom = installDom();
    try {
      const { page, store } = await openDetail(taskRecord({
        hostAcceptance: ACCEPTANCE,
        reviewPersistence: { state, durable: false, pending, decision: 'accepted' },
      }));
      const lineText = (page.hostReviewCell().textContent ?? '').trim();
      assert.equal(lineText, expected, `${state}: the row states the real save state`);
      assert.equal(lineText.includes('审查通过'), false, `${state}: not accepted before the record is durable`);
      assert.equal(lineText.includes('结论已保存'), false, `${state}: and never described as saved`);
      // The unconfirmed state hides the conclusion, not the text.
      assert.equal(page.noteBody().textContent, NOTE_270);
      await page.unmount();
      store.dispose();
    } finally {
      dom.restore();
    }
  }
});

test('G10 DOM: 需要修正 reads as a conclusion, and an empty note still states the decision', async () => {
  {
    const dom = installDom();
    try {
      const { page, store } = await openDetail(taskRecord({
        hostAcceptance: { ...ACCEPTANCE, accepted: false, state: 'changes-requested' },
        reviewPersistence: SAVED,
      }));
      const lineText = (page.hostReviewCell().textContent ?? '').trim();
      assert.equal(lineText, `需要修正（${pageTime()}）（结论已保存）`);
      assert.equal(lineText.includes('审查通过'), false);
      assert.equal(page.noteBody().textContent, NOTE_270);
      await page.unmount();
      store.dispose();
    } finally {
      dom.restore();
    }
  }
  {
    const dom = installDom();
    try {
      const { page, store } = await openDetail(taskRecord({
        hostAcceptance: { ...ACCEPTANCE, note: '' },
        reviewPersistence: SAVED,
      }));
      assert.equal((page.hostReviewCell().textContent ?? '').trim(), `审查通过（${pageTime()}）（结论已保存）`,
        'the conclusion is stated even with no note body');
      assert.equal(page.root.querySelector('[data-dshdg-note-full]'), null, 'no note block is invented for an empty note');
      assert.match(page.root.textContent, /无审查意见正文/u);
      await page.unmount();
      store.dispose();
    } finally {
      dom.restore();
    }
  }
});

test('G10 DOM: a compact row reads the whole note on demand and keeps it across a refresh', async () => {
  const dom = installDom();
  try {
    const note = NOTE_MULTI;
    const compact = (overrides = {}) => taskRecord({
      hostAcceptance: { ...ACCEPTANCE, noteChars: Array.from(note).length, noteOmitted: true },
      reviewPersistence: SAVED,
      ...overrides,
    });
    const fullTask = taskRecord({ hostAcceptance: { ...ACCEPTANCE, note }, reviewPersistence: SAVED });
    const fixture = await makeStore({ tasks: [compact()], getTask: async () => ({ ok: true, task: fullTask }) });
    const page = await renderPage(fixture.store);

    // The list row carries only the length, so the body cannot be there yet.
    assert.equal(page.root.querySelector('[data-dshdg-note-full] pre'), null);
    const link = [...page.root.querySelectorAll('button')]
      .find((b) => (b.textContent ?? '').includes('查看完整审查意见'));
    assert.ok(link !== undefined, 'the compact row offers the full read');
    await page.click(link);

    assert.equal(page.noteBody().textContent, note, 'one click reads the whole note');
    const before = (page.hostReviewCell().textContent ?? '').trim();
    assert.equal(before, `审查通过（${pageTime()}）（结论已保存）`);
    assert.equal(before.includes(Array.from(note).slice(0, 24).join('')), false, 'and the row still holds no body');

    // A background refresh answers with the COMPACT row for the same conclusion.
    fixture.setRows([compact()]);
    await page.act(async () => { await fixture.store.refreshTasks('auto'); });
    await page.settle();
    assert.equal(page.noteBody().textContent, note, 'the whole body survives the refresh');
    assert.equal((page.hostReviewCell().textContent ?? '').trim(), before, 'and the row is unchanged');

    await page.unmount();
    fixture.store.dispose();
  } finally {
    dom.restore();
  }
});

test('G10 DOM: a note the host really truncated keeps its own marker, and the row does not adopt it', async () => {
  const dom = installDom();
  try {
    const { page, store } = await openDetail(taskRecord({
      hostAcceptance: { ...ACCEPTANCE, note: NOTE_HOST_TRUNCATED },
      reviewPersistence: SAVED,
    }));
    const body = page.noteBody();
    assert.equal(body.textContent, NOTE_HOST_TRUNCATED, 'the stored text is shown as stored');
    assert.match(body.textContent, /…（已截断）$/u, 'the host marker is not deleted');
    assert.equal((page.hostReviewCell().textContent ?? '').trim(), `审查通过（${pageTime()}）（结论已保存）`,
      'the marker belongs to the body, not to the status row');
    await page.unmount();
    store.dispose();
  } finally {
    dom.restore();
  }
});

// ---------------------------------------------------------------------------
// G11: the stylesheet
// ---------------------------------------------------------------------------

/**
 * The declarations of one CSS rule in the injected sheet, comments stripped.
 *
 * The sheet is authored with one declaration per line, so a line break ends a declaration
 * even without a trailing semicolon; a single-line rule (`a: b; c: d;`) is split on `;`.
 * @param {string} sheet - CSS text.
 * @param {string} selector - exact selector (`".name"`).
 * @returns {Map<string, string>} property -> value.
 */
function declarationsOf(sheet, selector) {
  const start = sheet.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `${selector} has a rule`);
  const open = start + selector.length + 2;
  const body = sheet.slice(open, sheet.indexOf('}', open)).replace(/\/\*[\s\S]*?\*\//gu, '');
  const map = new Map();
  for (const line of body.split('\n')) {
    for (const piece of line.split(';')) {
      const at = piece.indexOf(':');
      if (at < 0) continue;
      const property = piece.slice(0, at).trim();
      if (property === '') continue;
      map.set(property, piece.slice(at + 1).trim());
    }
  }
  return map;
}

/** The raw text of one rule (selector plus declarations), for clip/height checks. */
function ruleText(sheet, selector) {
  const start = sheet.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `${selector} has a rule`);
  return sheet.slice(start, sheet.indexOf('}', start) + 1);
}

test('G11: the note block is bounded by its parent, wraps, and is never clipped', () => {
  const note = declarationsOf(CSS_TEXT, '.dshdg-note');
  const body = declarationsOf(CSS_TEXT, '.dshdg-note-full');
  const dd = declarationsOf(CSS_TEXT, '.dshdg-kv dd');
  const kv = declarationsOf(CSS_TEXT, '.dshdg-kv');

  // The value cell is a grid item: without min-width it grows to its content width.
  assert.equal(dd.get('min-width'), '0');
  assert.equal(dd.get('overflow-wrap'), 'anywhere');
  assert.equal(dd.get('margin'), '0', 'the original reset is preserved');
  assert.equal(kv.get('min-width'), '0', 'the grid itself cannot be widened by its contents');
  assert.equal(kv.get('grid-template-columns'), 'minmax(96px, 140px) minmax(0, 1fr)', 'the value track stays shrinkable');

  // The block and the body keep every character and line break, and cannot overflow.
  for (const [name, declared] of [['.dshdg-note', note], ['.dshdg-note-full', body]]) {
    assert.equal(declared.get('min-width'), '0', `${name}: may shrink below its content`);
    assert.equal(declared.get('max-width'), '100%', `${name}: bounded by its parent`);
    assert.equal(declared.get('overflow-wrap'), 'anywhere', `${name}: long runs break`);
  }
  assert.equal(body.get('white-space'), 'pre-wrap', 'paragraph breaks and spaces survive');
  assert.equal(body.get('word-break'), 'break-word');
  // No hiding, clipping or height cap anywhere in the note rules.
  for (const selector of ['.dshdg-note', '.dshdg-note-full']) {
    const text = ruleText(CSS_TEXT, selector);
    assert.equal(/overflow:\s*(hidden|clip)/u.test(text), false, `${selector}: no overflow clip`);
    assert.equal(/line-clamp|text-overflow|max-height/u.test(text), false,
      `${selector}: no line clamp, no cut-off, no height cap`);
  }
  // The list preview wraps too, and is a separate rule from the full body.
  assert.equal(declarationsOf(CSS_TEXT, '.dshdg-note-preview').get('overflow-wrap'), 'anywhere');
});

test('G11: the shipped bundle carries the current stylesheet', () => {
  // `npm run build:client` inlines CSS_TEXT into lib/client.js; a stale bundle would ship
  // the old rules while every source-level test still passed.
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  assert.equal(bundle.includes('.dshdg-note-full'), true, 'the bundle knows the note class');
  assert.equal(bundle.includes('white-space: pre-wrap'), true, 'and carries the wrap rule');
  assert.equal(bundle.includes('.dshdg-kv dd'), true, 'and the grid-item fix');
  assert.equal(bundle.includes('（结论已保存）'), true, 'and the simplified acceptance row');
  assert.equal(bundle.includes('已截断'), true, 'while the note text itself is still bounded elsewhere');
});
