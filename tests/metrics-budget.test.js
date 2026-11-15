// The metrics budget regression: a LONG session (>= 200 waits and >= 200 decisions)
// must still be able to answer `delegate_metrics` — the cumulative counters are the
// whole point of the census, and refusing the entire read because the audit SAMPLE
// is large would leave the operator with nothing but an error.
//
// The production defect: `snapshot()` published up to 64 `recentWaits` AND up to 64
// `recentDecisions` in full, and `boundedJson` treats those as critical fields it
// cannot shrink, so a long session produced `MCP_RESULT_OVER_BUDGET`
// (fullTextChars 40306 > boundChars 20000) and even the totals became unreadable.
//
// The fix contracts, pinned here against the REAL MCP server (production
// `tools/call` path, real `boundedJson`, no internals mocked):
//   1. `ok: true`, and the serialized answer fits `MAX_TOOL_TEXT_CHARS`;
//   2. cumulative counts stay exact after 200+ waits and 200+ decisions;
//   3. the sample lists keep only a small number of the MOST RECENT entries, with
//      the omission STATED (`omitted` counts), never silently truncated and never
//      presented as the full history;
//   4. `not-integrated` host facts are untouched;
//   5. no new sensitive content appears (the redaction/bounded path is unchanged).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LATEST_PROTOCOL_VERSION,
  MAX_TOOL_TEXT_CHARS,
  createMcpServer,
} from '../src/mcp/server.js';
import { QUESTION_ANSWER_KIND } from '../src/mcp/metrics.js';

/**
 * A production-shaped MCP server whose census is filled by REAL tool calls:
 * `delegate_permission_decide` records decisions through the production path, and
 * scripted observations record waits through the production wait loop.
 * @param {object} options - `waits`: how many waits to run, `decisions`: how many decisions.
 * @returns {Promise<object>} `{ server, call, metrics }`.
 */
async function longSessionFixture(options = {}) {
  const waits = options.waits ?? 0;
  const decisions = options.decisions ?? 0;
  const questions = options.questions ?? 0;
  let seq = 0;
  const server = createMcpServer({
    async callExecution(route, payload) {
      seq += 1;
      if (route === 'question') {
        // The question route's confirmation needs the SAME task, request and the
        // normalised answer batch echoed back.
        return {
          ok: true,
          task: { taskId: payload.taskId, state: 'running', phase: 'execute' },
          answer: { taskId: payload.taskId, requestId: payload.requestId, answers: payload.answers },
        };
      }
      if (route === 'permission') {
        // A real decision answer the production receipt path can confirm: the settled
        // record names the same task/request/operation and carries the outcome (and,
        // for an allow, the verification) the receipt demands.
        const decision = payload.decision;
        const settled = decision === 'allow-once'
          ? {
            taskId: payload.taskId,
            requestId: payload.requestId,
            fingerprint: payload.fingerprint,
            state: 'decided',
            outcome: 'allowed-once',
            verified: { fingerprintQuoted: true, argumentsComplete: true, callReread: true, turnOpen: true },
          }
          : {
            taskId: payload.taskId,
            requestId: payload.requestId,
            fingerprint: payload.fingerprint,
            state: 'decided',
            outcome: 'rejected',
          };
        return { ok: true, task: { taskId: payload.taskId, state: 'running', phase: 'execute' }, permission: settled };
      }
      // The observe route: an immediate heartbeat, so each `delegate_wait` with a
      // 1-second budget returns `wait-limit` quickly (a real production wait).
      return {
        ok: true,
        task: { taskId: payload.taskId, state: 'running', phase: 'execute' },
        reason: 'heartbeat',
        permission: null,
        question: null,
        failure: null,
        activity: {},
        selfCheck: null,
        wait: { waitMs: payload.waitMs, waitedMs: payload.waitMs, activitySinceWait: false },
      };
    },
    now: (() => { let t = 0; return () => (t += 1_000); })(),
    sleep: async () => {},
  });
  await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });

  /** Call one tool through the REAL handler. */
  const call = async (name, args = {}, id) => {
    const response = await server.handle({
      jsonrpc: '2.0', id: id ?? (`call-${name}-${seq}`), method: 'tools/call', params: { name, arguments: args },
    });
    const text = response.result.content[0].text;
    return { body: JSON.parse(text), text, response };
  };

  for (let index = 0; index < decisions; index += 1) {
    // A LEGAL fingerprint: the deterministic test value
    // `sha256:` + a 64-hex lowercase string, unique per decision. It is a
    // well-formed sha256-format test value, not a digest of anything.
    const fingerprint = `sha256:${index.toString(16).padStart(64, '0')}`;
    const answer = await call('delegate_permission_decide', {
      taskId: 'task-long',
      requestId: `permission-task-long-${index + 1}`,
      decision: index % 2 === 0 ? 'allow-once' : 'reject',
      fingerprint,
    }, `dec-${index}`);
    // Every decision call must succeed against the scripted harness (the census is
    // only meaningful if the production path really confirmed each decision). The
    // per-call receipt is published only on the waitAfterDecision form, so the
    // applied outcome is asserted through the census below, which counts exactly
    // what the production receipt path recorded.
    assert.equal(answer.body.ok, true, `decision ${index} must be answered ok`);
  }
  for (let index = 0; index < questions; index += 1) {
    await call('delegate_question_answer', {
      taskId: 'task-long',
      requestId: `question-task-long-${index + 1}`,
      answers: [{ id: 'q1', selected: ['continue'], custom: '' }],
    }, `q-${index}`);
  }
  for (let index = 0; index < waits; index += 1) {
    await call('delegate_wait', { taskId: `task-wait-${index + 1}`, waitSeconds: 1 }, `wait-${index}`);
  }
  return { server, call };
}

test('metrics-budget: a 200-wait 200-decision session still answers delegate_metrics within the tool-text bound', async () => {
  const { call } = await longSessionFixture({ waits: 200, decisions: 200 });

  const { body, text } = await call('delegate_metrics', {}, 'metrics-final');
  assert.equal(body.ok, true, `the census must be readable on a long session (was: ${body.error?.code ?? 'ok'})`);
  assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_TOOL_TEXT_CHARS,
    `the metrics answer must fit the tool-text bound (${Buffer.byteLength(text, 'utf8')} > ${MAX_TOOL_TEXT_CHARS})`);

  // Cumulative counters survive exactly: the SAMPLE being small must never shrink
  // the totals. The fixture asserted each decision call answered `ok`, and the
  // census then shows every one of them counted as applied (200), with unknown and
  // refused both ZERO — the per-call receipt is published only on the
  // `waitAfterDecision` form, so no per-call receipt is asserted here.
  assert.equal(body.metrics.waits.count, 200);
  assert.equal(body.metrics.decisions.count, 200);
  assert.equal(body.metrics.decisions.applied, 200);
  assert.equal(body.metrics.decisions.unknown, 0);
  assert.equal(body.metrics.decisions.refused, 0);
  assert.equal(body.metrics.decisions.allowed, 100);
  assert.equal(body.metrics.decisions.rejected, 100);
  assert.equal(body.metrics.tools.delegate_wait, 200);
  assert.equal(body.metrics.tools.delegate_permission_decide, 200);

  // The host facts this process cannot observe are still honest.
  assert.equal(body.metrics.hostObservability.hostTokenUsage, 'not-integrated');
  assert.equal(body.metrics.hostObservability.hostCost, 'not-integrated');

  // The samples are a stated partial view: recent entries kept, omission counted.
  const recentWaits = body.metrics.correlation.recentWaits;
  const recentDecisions = body.metrics.correlation.recentDecisions;
  assert.ok(Array.isArray(recentWaits) && recentWaits.length > 0, 'a few recent waits are still auditable');
  assert.ok(recentWaits.length < 200, 'the sample is bounded far below the full history');
  assert.ok(Array.isArray(recentDecisions) && recentDecisions.length > 0, 'a few recent decisions are still auditable');
  assert.ok(recentDecisions.length < 200, 'the decision sample is bounded too');
  const omitted = body.metrics.correlation.omitted;
  assert.ok(omitted && typeof omitted.waits === 'number' && typeof omitted.decisions === 'number',
    'the omissions are STATED: { waits, decisions } counts of entries not shown');
  // The omission counts are measured against the CUMULATIVE histories — waits on
  // one axis, decisions PLUS question answers on the shared sample axis — so the
  // statement is exactly "how many recorded facts this answer does not show".
  assert.equal(omitted.waits, body.metrics.waits.count - recentWaits.length);
  assert.equal(
    omitted.decisions,
    (body.metrics.decisions.count + body.metrics.questionAnswers.count) - recentDecisions.length,
  );
  assert.equal(omitted.waits > 0 && omitted.decisions > 0, true, 'the omission is real on a long session');

  // The kept samples are the MOST RECENT ones, in order, with concrete identities.
  // The decisions sample records each caller's own requestId, so the last 8 samples
  // must be exactly the tail of the 200-decision loop: requestIds
  // permission-task-long-193..200, newest last, each with the decision it recorded.
  assert.equal(recentDecisions.length, 8);
  assert.deepEqual(
    recentDecisions.map((entry) => entry.requestId),
    Array.from({ length: 8 }, (_, i) => `permission-task-long-${193 + i}`),
    'the last 8 decisions, newest last, are exactly the tail of the history',
  );
  recentDecisions.forEach((entry, index) => {
    assert.equal(entry.taskId, 'task-long');
    assert.equal(entry.decision, (192 + index) % 2 === 0 ? 'allow-once' : 'reject',
      'the newest samples are the tail of the 200-decision loop, alternating as it did');
    assert.equal(entry.applied, true, 'every kept decision was confirmed applied');
  });
  // The last wait sample is the NEWEST wait: the 200-wait loop ran after the
  // decision loop with per-call task ids task-wait-1..200, so the 8 kept samples
  // are exactly the tail 193..200, newest last, under the 1s budget.
  const newestWait = recentWaits.at(-1);
  assert.deepEqual(
    recentWaits.map((entry) => entry.taskId),
    Array.from({ length: 8 }, (_, i) => `task-wait-${193 + i}`),
    'the last 8 waits are exactly the tail of the history',
  );
  assert.equal(newestWait.reason, 'wait-limit', 'the newest wait returned wait-limit under the 1s budget');
  assert.equal(newestWait.durationMs, 3000, 'the newest wait reports its own measured duration');
  assert.equal(newestWait.waitReturns, 1, 'and exactly one return');

  // No new sensitive content: the answer carries identifiers and counts only.
  const serialized = text;
  for (const forbidden of ['password', 'secret', 'token-value']) {
    assert.equal(serialized.includes(forbidden), false, `the census must not carry ${forbidden}`);
  }
});

test('metrics-budget: question answers share the sample axis, so the omitted statement counts them too', async () => {
  // The omission statement must measure the DECISIONS **plus** QUESTION ANSWERS
  // history (both kinds share the one recentDecisions sample list), or a mixed
  // session would silently understate what the reader cannot see. A SHORT session
  // (under the 64-entry ring) makes the cumulative basis visible: the omitted
  // count must be exact against what was recorded, not against the ring size.
  const { call } = await longSessionFixture({ waits: 2, decisions: 3, questions: 5 });
  const { body, text } = await call('delegate_metrics', {}, 'metrics-mixed');
  assert.equal(body.ok, true);
  assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_TOOL_TEXT_CHARS);

  assert.equal(body.metrics.decisions.count, 3);
  assert.equal(body.metrics.decisions.applied, 3);
  assert.equal(body.metrics.questionAnswers.count, 5, 'the question answers are counted on their own axis');
  assert.equal(body.metrics.waits.count, 2);

  // The shared sample holds the newest entries of BOTH kinds, and the omitted
  // statement covers the full recorded history minus what is shown.
  const recentDecisions = body.metrics.correlation.recentDecisions;
  assert.equal(recentDecisions.length, 8, 'the sample holds decisions AND question answers');
  const decisionsInSample = recentDecisions.filter((entry) => entry.decision === QUESTION_ANSWER_KIND).length;
  assert.equal(decisionsInSample, 5, 'the newest 5 question answers are all in the sample');
  assert.equal(recentDecisions.filter((entry) => entry.decision !== QUESTION_ANSWER_KIND).length, 3);
  const omitted = body.metrics.correlation.omitted;
  assert.equal(omitted.waits, 2 - body.metrics.correlation.recentWaits.length,
    'wait omissions: recorded waits minus displayed');
  assert.equal(omitted.decisions, (3 + 5) - 8, 'decision omissions: (decisions + questionAnswers) minus displayed');
  assert.equal(omitted.waits === 0 && omitted.decisions === 0, true,
    'a short session shows everything: zero omissions, honestly stated');
});
