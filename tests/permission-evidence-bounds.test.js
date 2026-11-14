// R3: a real Windows command must be fully reviewable, and the bound must stay a bound.
//
// The reported failure: `PERMISSION_BOUNDS.argumentValueChars` was 400 and the whole
// argument object was capped at 4000. A 403-character Windows path plus a write-back
// command does not fit in 400 characters, so the projection cut the command, the cut
// made `argumentsComplete: false`, and the commander could not allow a call it had
// every reason to allow. The cut was not a safety feature in that case — it turned a
// reviewable request into an un-reviewable one.
//
// The caps are now large enough for a normal command (8 KiB per field, 16 KiB for the
// object) and still finite. This file states both halves:
//
//  1. a ~403, ~1000 and ~8000 character command is published WHOLE and stays allowable;
//  2. a command past the cap is `truncated`, says so, and cannot be allowed;
//  3. no later layer (the MCP tool bound, the history projection) re-cuts an operation
//     the engine published whole, and a genuine cut still reads as a cut;
//  4. the fingerprint is still over the complete real arguments.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PERMISSION_BOUNDS,
  PERMISSION_CODES,
  PERMISSION_REASONS,
  PermissionBridge,
  fingerprintOf,
} from '../src/runtime/permissions.js';
import { isPermissionDecidable } from '../src/mcp/server.js';
import { createMcpServer, MAX_TOOL_TEXT_CHARS } from '../src/mcp/server.js';

/** A Windows path of exactly the reported length, plus a read-back command. */
const LONG_PATH = `E:\\deepseek workplace\\dsh-delegate\\${Array.from({ length: 8 }, (_, index) => `segment-with-a-real-name-${index}`).join('\\')}\\src\\index.js`;

/**
 * Build one native Session whose log already holds the tool call.
 * @param {object} args - the arguments the model produced.
 * @param {string} callId - call id.
 * @returns {object} a Session-shaped object `locateToolCall` reads.
 */
function nativeSession(args, callId = 'call-1', name = 'bash') {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args), turn: 1, step: 1 } },
  ];
  return {
    id: 'session-r3',
    seq: events.length,
    eventAt(index) { return events[index]; },
  };
}

/**
 * Ask one bridge about one call and return its pending request.
 * @param {object} args - tool arguments.
 * @returns {Promise<{ pending: object, bridge: object }>} the request and its bridge.
 */
async function ask(args) {
  const session = nativeSession(args);
  const agent = { id: 'session-r3', session };
  const bridge = new PermissionBridge({ taskId: 'task-r3' });
  bridge.arm(agent);
  const waiting = bridge.answer({ agent, toolName: 'bash', callId: 'call-1' });
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  const pending = bridge.pendingView();
  assert.ok(pending !== null, 'the bridge must publish a pending request');
  return { pending, bridge, waiting };
}

test('R3: the bounds are big enough for a real command and still finite', () => {
  assert.ok(PERMISSION_BOUNDS.argumentValueChars >= 8192, 'a single field must hold a real command');
  assert.ok(PERMISSION_BOUNDS.argumentsChars >= 16_384, 'the object must hold a real command plus its path');
  // Still a bound: an absurd value is not accepted forever.
  assert.ok(Number.isFinite(PERMISSION_BOUNDS.argumentValueChars));
  assert.ok(PERMISSION_BOUNDS.argumentsChars < 1_000_000);
});

test('R3: the reported 403-character Windows path plus a read-back command is complete and allowable', async () => {
  const command = `Get-Content -LiteralPath "${LONG_PATH}" -Raw | ForEach-Object { $_ -replace 'a','b' } | Set-Content -LiteralPath "${LONG_PATH}"`;
  assert.ok(command.length > 400, `the fixture command is ${command.length} characters, i.e. past the old 400 cap`);
  const args = { command, sandbox_permissions: 'danger-full-access', justification: 'fix the file' };
  const { pending, bridge, waiting } = await ask(args);
  try {
    assert.equal(pending.completeness, 'complete', `the operation was cut: ${JSON.stringify(pending.boundsApplied)}`);
    assert.equal(pending.argumentsComplete, true);
    assert.equal(pending.allowBlocked, null);
    assert.deepEqual(pending.boundsApplied, []);
    assert.equal(pending.omitted.valueChars, 0);
    // The whole command is in the published text, not a prefix of it. `arguments` is
    // JSON TEXT, so the command appears escaped; comparing the parsed value is the
    // honest check of "nothing was removed".
    const published = JSON.parse(pending.arguments);
    assert.equal(published.command, command, 'the executable material must be published whole');
    assert.equal(published.sandbox_permissions, 'danger-full-access');
    assert.equal(published.justification, 'fix the file');
    assert.equal(isPermissionDecidable(pending), true);
    // And the decision really is available.
    bridge.decide({ requestId: pending.requestId, decision: 'allow-once', fingerprint: pending.fingerprint });
    assert.equal(await waiting, 'allowed-once');
  } finally {
    bridge.dispose();
  }
});

test('R3: 1000 and 8000 character commands are complete, not an "unexpectedly cut" request', async () => {
  for (const size of [1000, 8000]) {
    const tail = ' && Write-Output done';
    const command = `${'x'.repeat(size - tail.length)}${tail}`;
    assert.equal(command.length, size);
    const { pending, bridge, waiting } = await ask({ command, sandbox_permissions: 'danger-full-access' });
    try {
      assert.equal(pending.completeness, 'complete', `${size}: ${JSON.stringify(pending.boundsApplied)}`);
      assert.equal(pending.argumentsComplete, true, String(size));
      assert.equal(JSON.parse(pending.arguments).command, command, `${size}: the tail survived`);
      assert.equal(isPermissionDecidable(pending), true, String(size));
    } finally {
      bridge.decide({ requestId: pending.requestId, decision: 'reject', reason: 'cleanup' });
      await waiting.catch(() => undefined);
      bridge.dispose();
    }
  }
});

test('R3: a command past the cap is reported truncated, states the cut, and cannot be allowed', async () => {
  const tail = ' && rm -rf /important';
  const command = `${'a'.repeat(PERMISSION_BOUNDS.argumentValueChars)}${tail}`;
  const { pending, bridge, waiting } = await ask({ command, sandbox_permissions: 'danger-full-access' });
  try {
    assert.equal(pending.completeness, 'truncated');
    assert.equal(pending.argumentsComplete, false);
    assert.ok(pending.omitted.valueChars > 0, 'the amount dropped is stated');
    assert.equal(pending.boundsApplied.includes('value'), true);
    assert.equal(pending.arguments.includes(tail), false, 'the tail really is absent');
    assert.equal(pending.allowBlocked, PERMISSION_REASONS.incompleteEvidence);
    assert.equal(isPermissionDecidable(pending), false);
    assert.throws(
      () => bridge.decide({ requestId: pending.requestId, decision: 'allow-once', fingerprint: pending.fingerprint }),
      (error) => error.code === PERMISSION_CODES.incomplete,
    );
    // Reject stays available: refusing is always safe.
    bridge.decide({ requestId: pending.requestId, decision: 'reject' });
    assert.equal(await waiting, 'rejected');
  } finally {
    bridge.dispose();
  }
});

test('R3: the object cap still fires, with its own stated marker', async () => {
  // Many mid-sized fields: no single field is cut, the object is.
  const args = {};
  for (let index = 0; index < 12; index += 1) args[`field${index}`] = 'y'.repeat(2000);
  const { pending, bridge, waiting } = await ask(args);
  try {
    assert.ok(pending.arguments.length <= PERMISSION_BOUNDS.argumentsChars + 64);
    assert.equal(pending.argumentsComplete, false);
    assert.equal(isPermissionDecidable(pending), false);
  } finally {
    bridge.decide({ requestId: pending.requestId, decision: 'reject' });
    await waiting.catch(() => undefined);
    bridge.dispose();
  }
});

test('R3: the fingerprint still covers the complete real operation, not the published text', async () => {
  const tail = ' && Write-Output done';
  const command = `${'x'.repeat(500)}${tail}`;
  const args = { command, sandbox_permissions: 'danger-full-access' };
  const { pending, bridge, waiting } = await ask(args);
  try {
    assert.equal(pending.fingerprint, fingerprintOf(args), 'the fingerprint binds the exact arguments');
    // A call differing only in the tail the projection would have removed is a
    // different operation, so this request cannot decide it.
    const other = { ...args, command: `${'x'.repeat(500)} && Write-Output other` };
    assert.notEqual(pending.fingerprint, fingerprintOf(other));
  } finally {
    bridge.decide({ requestId: pending.requestId, decision: 'reject' });
    await waiting.catch(() => undefined);
    bridge.dispose();
  }
});

test('R3: the MCP layer never re-cuts an operation the engine published whole', async () => {
  // A wait answer publishes the pending operation directly. The MCP text bound used to
  // cap that blob at 4000 characters — below the engine's own cap — which silently
  // turned a complete operation back into an unapprovable one at the LAST layer.
  const command = `Get-Content -LiteralPath "${LONG_PATH}" -Raw | ForEach-Object { $_ } | Set-Content -LiteralPath "${LONG_PATH}"`;
  const pending = {
    requestId: 'permission-task-r3-1',
    taskId: 'task-r3',
    sessionId: 'session-r3',
    toolName: 'bash',
    callId: 'call-1',
    state: 'pending',
    completeness: 'complete',
    argumentsComplete: true,
    allowBlocked: null,
    boundsApplied: [],
    omitted: { valueChars: 0, keys: 0, depth: 0, items: 0 },
    fingerprint: fingerprintOf({ command }),
    arguments: JSON.stringify({ command, sandbox_permissions: 'danger-full-access' }),
    reason: 'the sandbox refused the write',
  };
  const server = createMcpServer({
    async callExecution(route, payload) {
      if (route === 'result') return { ok: true, task: { taskId: 'task-r3', state: 'running', phase: 'awaiting-permission', permission: { bridged: true, waiting: true, pending } } };
      throw new Error(`unexpected route ${route} for ${JSON.stringify(payload).length}`);
    },
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  const answer = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'delegate_result', arguments: { taskId: 'task-r3' } },
  });
  const body = JSON.parse(answer.result.content[0].text);
  const published = body.task.permission.pending;
  assert.equal(published.argumentsComplete, true, 'a complete operation must stay complete across the tool bound');
  assert.equal(published.completeness, 'complete');
  assert.deepEqual(published.boundsApplied, []);
  // The operation reaches the host intact: "arguments" is JSON TEXT, so the check is
  // made on the parsed value, which is what a host reads.
  assert.equal(JSON.parse(published.arguments).command, command, 'the full command must reach the host');
  assert.equal(answer.result.isError, undefined);
});

test('R3: an 8000-character command crosses the MCP layer whole and stays decidable', async () => {
  // The engine keeps a value up to `argumentValueChars`; the MCP layer used to re-cut
  // that blob at a smaller, fixed cap. A 8000-character command sits exactly at the
  // engine's field limit, so it is the case that proves no later layer shortens it —
  // and the answer is still published, not refused as over budget.
  const tail = ' && Write-Output done';
  const command = `${'x'.repeat(8000 - tail.length)}${tail}`;
  assert.equal(command.length, 8000);
  const pending = {
    requestId: 'permission-task-r3-8000',
    taskId: 'task-r3',
    sessionId: 'session-r3',
    toolName: 'bash',
    callId: 'call-8000',
    state: 'pending',
    completeness: 'complete',
    argumentsComplete: true,
    allowBlocked: null,
    boundsApplied: [],
    omitted: { valueChars: 0, keys: 0, depth: 0, items: 0 },
    fingerprint: fingerprintOf({ command, sandbox_permissions: 'danger-full-access' }),
    arguments: JSON.stringify({ command, sandbox_permissions: 'danger-full-access' }),
    reason: 'the sandbox refused the write',
  };
  const server = createMcpServer({
    async callExecution() {
      return { ok: true, task: { taskId: 'task-r3', state: 'running', permission: { bridged: true, waiting: true, pending } } };
    },
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  const answer = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'delegate_result', arguments: { taskId: 'task-r3' } },
  });
  const text = answer.result.content[0].text;
  const body = JSON.parse(text);
  assert.equal(body.ok, true, `the answer must be delivered, not refused: ${text.slice(0, 200)}`);
  const published = body.task.permission.pending;
  // Nothing was cut, and the request is decidable with the WHOLE command.
  assert.equal(published.argumentsComplete, true);
  assert.equal(published.completeness, 'complete');
  assert.deepEqual(published.boundsApplied, []);
  assert.equal(published.allowBlocked, null);
  assert.equal(JSON.parse(published.arguments).command, command, 'all 8000 characters reach the host');
  assert.equal(published.arguments.includes('…[+'), false, 'no elision marker appears in the operation');
});

test('R3: an operation past the WHOLE tool-text bound is refused as incomplete, never decidable', async () => {
  // A task record whose permission block alone exceeds the 20 000-character tool-text
  // bound cannot be published whole. The answer may then be refused as data or carry a
  // shortened operation — in neither case may the host be told it is complete and
  // decidable.
  const huge = 'z'.repeat(MAX_TOOL_TEXT_CHARS + 5_000);
  const pending = {
    requestId: 'permission-task-r3-over',
    taskId: 'task-r3',
    state: 'pending',
    completeness: 'truncated',
    argumentsComplete: false,
    allowBlocked: PERMISSION_REASONS.incompleteEvidence,
    boundsApplied: ['value'],
    fingerprint: fingerprintOf({ command: huge }),
    arguments: JSON.stringify({ command: huge }),
  };
  const server = createMcpServer({
    async callExecution() {
      return { ok: true, task: { taskId: 'task-r3', state: 'running', permission: { pending } } };
    },
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  const answer = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'delegate_result', arguments: { taskId: 'task-r3' } },
  });
  const text = answer.result.content[0].text;
  const body = JSON.parse(text);
  // Whatever shape the answer takes, it must never claim a complete operation.
  assert.equal(body.task?.permission?.pending?.argumentsComplete ?? false, false,
    `a truncated operation must never read as complete: ${text.slice(0, 300)}`);
  if (body.ok === false) {
    assert.equal(body.error.code, 'MCP_RESULT_OVER_BUDGET');
    assert.equal(body.error.fullResultIncluded, false);
  } else {
    assert.equal(body.task.permission.pending.completeness, 'truncated');
    assert.ok(body.task.permission.pending.allowBlocked, 'the shortened operation names why it cannot be allowed');
  }
  assert.ok(text.length <= MAX_TOOL_TEXT_CHARS, 'the tool-text bound still holds');
});

test('R3: the MCP layer still reports a genuine over-bound operation as unapprovable', async () => {
  // The cap is the engine's; an operation past it is cut and marked, never allowed. The
  // fixture exceeds the WHOLE tool-text bound, which is the only way to force this
  // server's last-resort cut honestly (a value merely past `argumentsChars` still fits
  // and is published as-is, which the test above covers).
  const huge = 'z'.repeat(MAX_TOOL_TEXT_CHARS + 5_000);
  const pending = {
    requestId: 'permission-task-r3-2',
    taskId: 'task-r3',
    state: 'pending',
    completeness: 'truncated',
    argumentsComplete: false,
    allowBlocked: PERMISSION_REASONS.incompleteEvidence,
    boundsApplied: ['value'],
    fingerprint: fingerprintOf({ command: huge }),
    arguments: JSON.stringify({ command: huge }),
  };
  const server = createMcpServer({
    async callExecution() {
      return { ok: true, task: { taskId: 'task-r3', state: 'running', permission: { pending } } };
    },
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  const answer = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'delegate_result', arguments: { taskId: 'task-r3' } },
  });
  const text = answer.result.content[0].text;
  const body = JSON.parse(text);
  // The answer may be refused as data (MCP_RESULT_OVER_BUDGET) or delivered with the
  // operation marked unapprovable. Either way the host must never be told the operation
  // is complete and decidable, and the bound must hold.
  assert.ok(text.length <= MAX_TOOL_TEXT_CHARS, 'the tool-text bound still holds');
  if (body.ok === false) {
    assert.equal(body.error.code, 'MCP_RESULT_OVER_BUDGET');
    assert.equal(text.includes('"argumentsComplete": true'), false);
    return;
  }
  const published = body.task.permission.pending;
  assert.equal(published.argumentsComplete, false);
  assert.equal(published.completeness, 'truncated');
  assert.equal(published.allowBlocked, PERMISSION_REASONS.incompleteEvidence);
  // The operation is published only as a PREFIX of the real JSON, so it no longer even
  // parses — which is itself proof that no host can reconstruct the operation, and
  // therefore that this request can never be allowed. The test states that directly
  // instead of parsing a value the bound already truncated.
  assert.equal(typeof published.arguments, 'string');
  assert.ok(published.arguments.length < JSON.stringify({ command: huge }).length,
    `the published operation must be shorter than the over-cap input (got ${published.arguments.length})`);
  assert.throws(() => JSON.parse(published.arguments), SyntaxError,
    'a truncated operation is not valid JSON, so it cannot be mistaken for the whole call');
});
