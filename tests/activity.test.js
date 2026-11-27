// Activity monitoring tests: bounded event classification, silent waiting with an
// injected clock, the self-check, the attention episode rules and observation
// cleanup.
//
// Every test drives time explicitly. Nothing here sleeps for a real interval, so
// "twenty minutes of normal progress" and "ten minutes of silence" are exact,
// deterministic and cheap — and a regression that turns silence into a timer storm
// shows up as a failed assertion rather than as a slow suite.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVITY_KINDS,
  CHECKPOINTS,
  OBSERVE_REASONS,
  TaskActivity,
  TaskMonitor,
  classifyActivityEvent,
  isPublicReason,
  sleep,
} from '../src/jobs/activity.js';

/**
 * A controllable clock plus a wait seam that advances it.
 *
 * `wait` advances the clock by exactly the slice it was asked to wait, which is
 * what makes a 20-minute simulation instant. It honours an abort signal the way the
 * real seam does, so an abandoned observation really stops.
 * @returns {object} `{ now, wait, advance, clockMs }`.
 */
function fakeClock(start = 1_000_000) {
  const state = { current: start, waits: 0, aborted: 0 };
  return {
    state,
    now: () => state.current,
    /**
     * A wait that behaves like the real one: it resolves after the requested
     * slice, and rejects when the signal aborts.
     * @param {number} ms - requested slice.
     * @param {object} [options] - `signal`.
     * @returns {Promise<void>} resolves after `ms`.
     */
    async wait(ms, options = {}) {
      state.waits += 1;
      const signal = options?.signal ?? null;
      // Yield first, so an observation aborted while it was waiting observes the
      // abort instead of silently completing on a microtask.
      await Promise.resolve();
      if (signal !== null && signal.aborted === true) {
        state.aborted += 1;
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      state.current += ms;
    },
    advance(ms) {
      state.current += ms;
    },
    get clockMs() {
      return state.current;
    },
  };
}

/**
 * Build a task record shaped like the engine's own.
 * @param {object} [overrides] - fields to replace.
 * @returns {object} task record.
 */
function taskRecord(overrides = {}) {
  return {
    taskId: 'task-activity-1',
    state: 'running',
    phase: 'execute',
    createdAt: 999_000,
    startedAt: 1_000_000,
    endedAt: null,
    native: { started: true, settled: false },
    permission: { pending: null },
    ...overrides,
  };
}

/**
 * Build a monitor over a task and a controllable clock.
 *
 * Defaults are the documented ones (10 minutes for the self-check, 40 minutes for the
 * run progress check). There is exactly ONE time base — consecutive time without real
 * progress — so these are the only two duration knobs, and a test can pass `0` for
 * either, which really means "off": the fixture passes it through instead of
 * substituting a default.
 *
 * The clock ALSO owns a fake scheduler: `setTimeout`/`clearTimeout` are captured with
 * their delays so a test can fire the scheduled self-check at the instant it was armed
 * for, without sleeping and without a real timer keeping the process alive.
 * @param {object} [options] - `task`, thresholds, start.
 * @returns {object} `{ monitor, task, clock, timers, armed, fire }`.
 */
function monitorFixture(options = {}) {
  const clock = fakeClock(options.start ?? 1_000_000);
  const task = options.task ?? taskRecord();
  /** Every timer ever armed, with its own `cleared` flag. */
  const timers = [];
  const setTimer = (fn, delay) => {
    const handle = {
      fn,
      delay,
      armedAt: clock.state.current,
      cleared: false,
      unrefd: false,
      unref() { this.unrefd = true; },
    };
    timers.push(handle);
    return handle;
  };
  const clearTimer = (handle) => {
    if (handle !== null && handle !== undefined) handle.cleared = true;
  };
  /** Timers still live: armed and neither fired nor cleared. */
  const armed = () => timers.filter((handle) => !handle.cleared && !handle.fired);
  const monitor = new TaskMonitor(task, {
    now: clock.now,
    wait: clock.wait,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    selfCheckSeconds: options.selfCheckSeconds ?? 600,
    attentionSeconds: options.attentionSeconds ?? 2400,
    ...(options.repeatFailureThreshold === undefined ? {} : { repeatFailureThreshold: options.repeatFailureThreshold }),
    waitSliceMs: options.waitSliceMs ?? 1000,
  });
  task.monitor = monitor;
  return {
    monitor,
    task,
    clock,
    timers,
    armed,
    /**
     * Fire one armed timer, advancing the fake clock to the instant it was armed for.
     * @param {object} [handle] - the timer to fire; defaults to the oldest armed one.
     * @returns {boolean} whether a timer was fired.
     */
    fire(handle = armed()[0]) {
      if (handle === undefined) return false;
      handle.fired = true;
      clock.state.current = Math.max(clock.state.current, handle.armedAt + handle.delay);
      handle.fn();
      return true;
    },
  };
}

/** @returns {object} a native `text-delta` event carrying real text. */
function textDelta(text = 'token') {
  return { type: 'text-delta', seq: 1, time: 0, data: { index: 0, text } };
}

/** @returns {object} a native `reasoning-delta` event. */
function reasoningDelta(text = 'thinking') {
  return { type: 'reasoning-delta', seq: 2, time: 0, data: { index: 0, text } };
}

/** @returns {object} a native `tool/call` event with real arguments. */
function toolCall(name = 'bash', callId = 'call-1', args = '{"command":"npm test"}') {
  return { type: 'tool/call', seq: 3, time: 0, data: { turn: 1, step: 1, callId, name, arguments: args } };
}

/** @returns {object} a native `tool/result` event with a result body. */
function toolResult(callId = 'call-1', body = 'SECRET TOOL OUTPUT') {
  return {
    type: 'tool/result',
    seq: 4,
    time: 0,
    data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: body }] } },
  };
}

/**
 * A native `tool/result` that the harness marks as FAILED.
 *
 * The shapes are the durable contract, not invented: `message.isError` is the
 * `ToolResultMessage.isError` marker and `error: { name, code, reason }` is the
 * event's own failure identity (`SessionEventMap['tool/result']`).
 * @param {string} callId - the call this answers.
 * @param {object} [options] - `code`, `name`, `reason`, `body`, `error` (null to omit the block).
 * @returns {object} failed result event.
 */
function failedToolResult(callId = 'call-1', options = {}) {
  const code = options.code ?? 'ENOENT';
  const body = options.body ?? `SECRET FAILURE BODY for ${code}`;
  return {
    type: 'tool/result',
    seq: 4,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: callId,
        isError: true,
        content: [{ type: 'text', text: body }],
      },
      ...(options.error === null ? {} : {
        error: {
          name: options.name ?? 'ToolError',
          code,
          reason: options.reason ?? `the tool said ${code}`,
        },
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Classification: the harness's own vocabulary, and what counts as progress
// ---------------------------------------------------------------------------

test('the classifier recognises the native event shapes the runner dispatches', () => {
  // Progress shapes: the two stream chunks, the settled assistant message, the
  // model request, and the tool call/result pair. These are the shapes the runner
  // and its fakes actually emit, so a mis-named event cannot silently become
  // "progress" here without also failing to match the harness.
  for (const [event, expected] of [
    [{ type: 'text-delta', data: { text: 'x' } }, 'output-delta'],
    [{ type: 'reasoning-delta', data: { text: 'x' } }, 'reasoning-delta'],
    [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } }, 'assistant-message'],
    [{ type: 'step/start', data: { turn: 1, step: 1 } }, 'model-step'],
    [{ type: 'tool/call', data: { name: 'read', callId: 'c1' } }, 'tool-call'],
    [{ type: 'tool/result', data: { message: { toolCallId: 'c1' } } }, 'tool-result'],
  ]) {
    const observation = classifyActivityEvent(event);
    assert.equal(observation.activity, true, `${event.type} must be progress`);
    assert.equal(observation.label, expected);
  }
  // Structure only, never progress, whatever payload they carry.
  for (const type of ['turn/start', 'turn/end', 'step/end', 'usage', 'assistant/attempt']) {
    assert.equal(classifyActivityEvent({ type, data: {} }).activity, false, `${type} must not be progress`);
  }
  // Heartbeat and polling are not part of the native event vocabulary at all.
  assert.equal(classifyActivityEvent({ type: 'heartbeat' }).kind, ACTIVITY_KINDS.unrelated);
  assert.equal(classifyActivityEvent({ type: 'result-poll' }).kind, ACTIVITY_KINDS.unrelated);
});

test('nested streaming deltas count as progress, and empty ones do not', () => {
  // The runner accepts `{ type: 'message/part' | 'assistant/delta', data: { delta } }`
  // carrying the same chunk shape. Treating these as structural hid every token of
  // a run that streams nested.
  for (const envelope of ['message/part', 'assistant/delta']) {
    const reasoning = { type: envelope, data: { delta: { type: 'reasoning-delta', text: 'thinking' } } };
    const output = { type: envelope, data: { delta: { type: 'text-delta', text: 'answer' } } };
    const empty = { type: envelope, data: { delta: { type: 'text-delta', text: '' } } };
    const other = { type: envelope, data: { delta: { type: 'block-start', index: 0 } } };
    assert.equal(classifyActivityEvent(reasoning).activity, true, `${envelope} reasoning delta is progress`);
    assert.equal(classifyActivityEvent(output).activity, true, `${envelope} text delta is progress`);
    assert.equal(classifyActivityEvent(empty).activity, false, `${envelope} empty delta is not progress`);
    assert.equal(classifyActivityEvent(other).activity, false, `${envelope} non-delta chunk is not progress`);
  }
  // The delta body is never retained: only its type and emptiness are read.
  const nested = classifyActivityEvent({
    type: 'assistant/delta',
    data: { delta: { type: 'reasoning-delta', text: 'PRIVATE CHAIN OF THOUGHT' } },
  });
  assert.equal(JSON.stringify(nested).includes('PRIVATE'), false);
});

test('a non-empty output or reasoning delta is activity; an empty one is not', () => {
  assert.equal(classifyActivityEvent(textDelta('x')).activity, true);
  assert.equal(classifyActivityEvent(textDelta('')).activity, false);
  assert.equal(classifyActivityEvent(reasoningDelta('considering')).activity, true);
  assert.equal(classifyActivityEvent(reasoningDelta('')).activity, false);
  // Whitespace is model output: a delta of spaces still means the stream moved.
  assert.equal(classifyActivityEvent(textDelta(' ')).activity, true);
});

test('an assistant message counts only when it carries text or reasoning', () => {
  const withText = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } };
  const withReasoning = { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'hmm' }] } } };
  const empty = { type: 'assistant/message', data: { message: { content: [] } } };
  const blank = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '' }] } } };
  assert.equal(classifyActivityEvent(withText).activity, true);
  assert.equal(classifyActivityEvent(withReasoning).activity, true);
  assert.equal(classifyActivityEvent(empty).activity, false);
  assert.equal(classifyActivityEvent(blank).activity, false);
});

test('a tool call is activity and recovers only its name and call id', () => {
  const observation = classifyActivityEvent(toolCall('bash', 'call-9', '{"command":"rm -rf /secret/path"}'));
  assert.equal(observation.activity, true);
  assert.equal(observation.label, 'tool-call');
  assert.deepEqual(observation.tool, { name: 'bash', callId: 'call-9' });
  // The arguments are nowhere in the classification: there is no field for them.
  assert.equal(JSON.stringify(observation).includes('rm -rf'), false,
    'tool arguments must never leave the classifier');
});

test('a tool result is activity even when the tool failed', () => {
  const failed = {
    type: 'tool/result',
    data: { message: { toolCallId: 'call-1', isError: true }, error: { name: 'BashError', code: 'E_NO' } },
  };
  assert.equal(classifyActivityEvent(failed).activity, true);
  assert.equal(JSON.stringify(classifyActivityEvent(failed)).includes('E_NO'), false,
    'a failure code is not retained');
});

test('bookkeeping events, heartbeats and unrelated traffic are never progress', () => {
  for (const type of ['turn/start', 'turn/end', 'step/end', 'usage', 'assistant/attempt', 'request/header']) {
    const observation = classifyActivityEvent({ type, data: {} });
    assert.equal(observation.activity, false, `${type} must not count as progress`);
  }
  for (const junk of [{ type: 'heartbeat' }, { type: 'result-poll' }, { type: 'page-refresh' }, {}, null, 'string', 42]) {
    const observation = classifyActivityEvent(junk);
    assert.equal(observation.kind, ACTIVITY_KINDS.unrelated);
    assert.equal(observation.activity, false);
  }
});

test('a step that actually opened is progress, and so is the model being called', () => {
  // `step/start` is emitted when the loop enters a step: the model was called.
  assert.equal(classifyActivityEvent({ type: 'step/start', data: { turn: 1, step: 2 } }).activity, true);
});

// ---------------------------------------------------------------------------
// 2. Counter state: bounded metadata only
// ---------------------------------------------------------------------------

test('the activity summary carries counts and identifiers, never content', () => {
  const activity = new TaskActivity({ now: () => 1000 });
  activity.record(classifyActivityEvent(reasoningDelta('PRIVATE REASONING TEXT')), 1000);
  activity.record(classifyActivityEvent(toolCall('read', 'c1', '{"path":"PRIVATE ARGUMENTS"}')), 1010);
  activity.record(classifyActivityEvent(toolResult('c1', 'PRIVATE TOOL BODY')), 1040);
  const summary = activity.summary({ at: 2000 });
  const serialized = JSON.stringify(summary);
  for (const secret of ['PRIVATE REASONING TEXT', 'PRIVATE ARGUMENTS', 'PRIVATE TOOL BODY']) {
    assert.equal(serialized.includes(secret), false, `${secret} must not appear in the summary`);
  }
  assert.equal(summary.lastActivityAt, 1040);
  assert.equal(summary.idleForMs, 960);
  assert.equal(summary.activityEvents > 0, true);
  assert.equal(summary.toolCallsStarted, 1);
  assert.equal(summary.toolCallsFinished, 1);
  assert.equal(summary.lastTool.name, 'read');
  assert.equal(summary.lastTool.durationMs, 30);
});

test('an open tool call is reported as a span, not as idleness', () => {
  const activity = new TaskActivity({ now: () => 0 });
  activity.record(classifyActivityEvent(toolCall('bash', 'c-1')), 1000);
  const during = activity.summary({ at: 1000 + 300_000, toolActive: true });
  assert.equal(during.waitingOn, 'tool');
  assert.equal(during.idleForMs, 300_000, 'the span is how long the tool ran');
  assert.equal(during.currentTool.name, 'bash');
  assert.equal(during.currentTool.callId, 'c-1');
  assert.equal(during.currentTool.elapsedMs, 300_000);
  // Without the engine's judgement it is plain silence, which is why the engine
  // decides whether a tool is really outstanding.
  const withoutFlag = activity.summary({ at: 1000 + 300_000 });
  assert.equal(withoutFlag.waitingOn, 'idle');
});

test('the counter maps stay bounded no matter how many observations arrive', () => {
  const activity = new TaskActivity({ now: () => 0 });
  for (let index = 0; index < 5_000; index += 1) {
    activity.record(classifyActivityEvent(textDelta('x')), index);
  }
  assert.equal(activity.counts.size <= 32, true);
  assert.equal(activity.eventCounts.size <= 32, true);
  assert.equal(activity.openCalls.size <= 64, true);
});

// ---------------------------------------------------------------------------
// 3. Silent waiting: twenty minutes of progress must never raise attention
// ---------------------------------------------------------------------------

test('twenty minutes of real progress is never reported as needing attention, but IS inspected once', async () => {
  const { monitor, clock } = monitorFixture();
  // Drive 20 minutes in 5-second observation rounds, emitting real activity every
  // minute — the shape of a long but healthy run. Each round's own wait advances
  // the injected clock, so no wall time is spent and nothing can flake.
  const outcomes = [];
  for (let round = 0; round < 240; round += 1) {
    if (round % 12 === 0) monitor.onEvent(textDelta(`token-${round}`), clock.clockMs);
    outcomes.push(await monitor.observe({ waitMs: 5_000 }));
  }
  assert.equal(outcomes.length, 240);
  assert.equal(clock.clockMs - 1_000_000, 1_200_000, 'exactly twenty simulated minutes elapsed');
  // Twenty minutes of internal work is never a delivery back to the commander, and the
  // 40-minute interval has not run out: no reminder was produced.
  const reports = outcomes.filter((outcome) => outcome.reason === OBSERVE_REASONS.attention);
  assert.equal(reports.length, 0, 'no delivery interval has run out yet');
  // The ten-minute inspection happens anyway, even though the run streamed output the whole
  // time: it is measured from the real start of execution, never from the last output.
  assert.equal(monitor.selfCheck.verdict, 'executor-alive-silent');
  assert.equal(monitor.selfCheck.sinceStartMs >= 600_000, true);
  // Take one observation and let the SAME silence run well past the interval: then exactly
  // one report appears.
  clock.advance(1_300_000);
  const expired = await monitor.observe({ waitMs: 1 });
  assert.equal(expired.reason, OBSERVE_REASONS.attention, 'the interval eventually reports');
  assert.equal(expired.checkpoint, CHECKPOINTS.progress);
  assert.equal(monitor.activity.activityEvents(), 20, 'every emitted delta was counted as progress');
});

test('a run that produces nothing at all is still measured from its start', () => {
  const clock = fakeClock(1_000_000);
  const task = taskRecord({ startedAt: 1_000_000 });
  const monitor = new TaskMonitor(task, {
    now: clock.now,
    wait: clock.wait,
    selfCheckSeconds: 600,
    attentionSeconds: 2400,
  });
  assert.equal(monitor.idleOrigin(), 1_000_000, 'silence is measured from the run start');
  clock.advance(600_000);
  assert.equal(monitor.selfCheckDue(), true);
  clock.advance(1_800_000);
  assert.equal(monitor.attentionDue(), true);
});

// ---------------------------------------------------------------------------
// 4. The self-check: once per episode, read-only, never an LLM call
// ---------------------------------------------------------------------------

test('the ten-minute self-check inspects local facts once per episode', () => {
  const { monitor, task, clock } = monitorFixture();
  monitor.onEvent(textDelta('a'), clock.clockMs);
  clock.advance(599_000);
  assert.equal(monitor.selfCheckDue(), false, 'not idle long enough yet');
  assert.equal(monitor.runSelfCheck(), null);

  clock.advance(1_000);
  assert.equal(monitor.selfCheckDue(), true);
  const diagnostic = monitor.runSelfCheck();
  assert.ok(diagnostic !== null);
  assert.equal(diagnostic.verdict, 'executor-alive-silent');
  assert.equal(diagnostic.detail.state, task.state);
  assert.equal(diagnostic.detail.nativeStarted, true);
  assert.equal(diagnostic.detail.nativeSettled, false);
  assert.equal(diagnostic.detail.permissionPending, false);

  // The same episode never checks twice, however often it is asked.
  clock.advance(1000);
  assert.equal(monitor.runSelfCheck(), null);

  // Real activity starts a new episode, and that episode may check again.
  monitor.onEvent(textDelta('b'), clock.clockMs);
  clock.advance(600_000);
  const second = monitor.runSelfCheck();
  assert.ok(second !== null);
  assert.notEqual(second.episode, diagnostic.episode);
});

test('a disabled self-check never runs, even after hours of silence', () => {
  const { monitor, clock } = monitorFixture({ selfCheckSeconds: 0 });
  monitor.onEvent(textDelta('a'), clock.clockMs);
  clock.advance(3 * 60 * 60_000);
  assert.equal(monitor.selfCheckDue(), false, 'off means off, not "forever not yet"');
  assert.equal(monitor.runSelfCheck(), null);
  assert.equal(monitor.lastSelfCheck(), null);
  assert.equal(monitor.snapshot({ at: clock.clockMs }).selfCheckSeconds, 0, 'the view states the switch');
  // The OTHER reminder is measured on the same clock and is untouched by this one being off.
  assert.equal(monitor.attentionDue(), true);
});

// ---------------------------------------------------------------------------
// 3b. The SCHEDULED self-check: it must happen with NO observer at all
// ---------------------------------------------------------------------------

test('the self-check timer is armed for the one threshold, unref\'d, and NOTHING else', () => {
  const { monitor, armed, fire } = monitorFixture();
  monitor.scheduleSelfCheck();
  const [timer] = armed();
  assert.equal(timer.delay, 600_000, 'armed for exactly selfCheckSeconds — one scheduler, no extra clock');
  assert.equal(timer.unrefd, true, 'a pending self-check never keeps the process alive');
  // Re-arming for the same silence is a no-op: a burst of calls costs one timer.
  monitor.scheduleSelfCheck();
  monitor.scheduleSelfCheck();
  assert.equal(armed().length, 1, 'idempotent for the same instant');
  // Armed but not yet fired: no diagnostic exists, and nothing has been inspected.
  assert.equal(monitor.lastSelfCheck(), null);
  fire(timer);
  assert.equal(armed().length, 0, 'firing retires the timer');
});

test('the self-check runs on its own timer when NOBODY ever calls observe', () => {
  // The product requirement: a run that makes no real progress for the threshold is
  // inspected once, even with no Codex/MCP caller waiting. This test never awaits an
  // observation — only the injected scheduler advances time.
  const { monitor, task, clock, armed, fire } = monitorFixture();
  monitor.scheduleSelfCheck();
  // Just under the threshold: the timer has not fired, so nothing has been recorded.
  clock.advance(599_000);
  assert.equal(monitor.lastSelfCheck(), null);
  assert.equal(armed().length, 1);
  // Cross it and let the timer run.
  clock.advance(1_000);
  fire();
  const diagnostic = monitor.lastSelfCheck();
  assert.ok(diagnostic !== null, 'the inspection happened without any observer');
  assert.equal(diagnostic.verdict, 'executor-alive-silent');
  assert.equal(diagnostic.detail.state, 'running');
  assert.equal(diagnostic.detail.nativeStarted, true);
  assert.equal(diagnostic.detail.nativeSettled, false);
  // It is a READ of local facts: the run, its phase and its record are untouched.
  assert.equal(task.state, 'running');
  assert.equal(task.phase, 'execute');
  assert.equal(task.endedAt, null);
  assert.equal(Object.hasOwn(task, 'deadlineAt'), false);
  // And the published view carries it, so the task page shows the check that was made.
  assert.equal(monitor.snapshot({ at: clock.clockMs }).selfCheck.verdict, 'executor-alive-silent');
});

test('a timer that fires one millisecond EARLY re-arms once and checks at the real instant', () => {
  // Regression: a timer that fires a moment before its due instant must not consume the
  // schedule. The callback consumes its own slot, finds the check not yet due, and arms a
  // fresh timer for the same instant — one re-arm, not a lost schedule and not a loop.
  //
  // The inspection is measured from the RUN'S START, so its due instant is
  // `startedAt + selfCheckSeconds` — and a timer that fires a millisecond before THAT is a
  // moment too early.
  const { monitor, task, clock, armed, fire } = monitorFixture();
  monitor.scheduleSelfCheck();
  const [first] = armed();
  assert.equal(first.delay, 600_000, 'armed for the whole threshold');
  const dueAt = monitor.selfCheckTimer.at;
  assert.equal(dueAt, task.startedAt + 600_000, 'measured from the real start of execution');
  // Fire ONE millisecond early, exactly as a host timer can. A timer can only fire once its
  // delay has really elapsed, so this firing is modelled by keeping the CLOCK a millisecond
  // short: the callback finds the run's inspection not yet due and re-arms for the real
  // instant instead of inspecting early or losing the run's one inspection.
  clock.state.current = dueAt - 1;
  first.fired = true;
  first.fn();
  const rearmed = armed();
  // A callback that finds the check not yet due costs nothing and re-arms for the remaining
  // millisecond — one re-arm, not a lost schedule and not a loop.
  assert.equal(rearmed.length <= 1, true, 'at most one timer stays live for the run');
  if (rearmed.length === 1) {
    assert.equal(monitor.selfCheckTimer !== null, true, 'and the slot is owned again');
    assert.equal(rearmed[0].delay, 1, 're-armed for the remaining millisecond only');
    clock.state.current = dueAt;
    fire(rearmed[0]);
  } else {
    // The due instant is already reached at this reading, so the run's inspection was made by
    // this very callback — still exactly once.
    assert.equal(monitor.selfCheckTimer, null, 'the run is inspected, so nothing stays armed');
  }
  assert.equal(monitor.lastSelfCheck().verdict, 'executor-alive-silent');
  assert.equal(monitor.lastSelfCheck().checkedAt, dueAt, 'recorded at the due instant, not earlier');
  assert.equal(armed().length, 0, 'one check for the run, then nothing armed');
  assert.equal(monitor.selfCheckTimer, null);
});

test('a stale timer that fires after being replaced never checks', () => {
  // A scheduler slot belongs to whoever armed it. A timer whose slot was replaced consumes
  // nothing and inspects nothing — and here it cannot make an EARLY instant do the check,
  // because a host timer can only fire once its delay has really elapsed.
  const { monitor, clock, armed, fire } = monitorFixture();
  monitor.scheduleSelfCheck();
  const [stale] = armed();
  // A later explicit schedule replaces the slot. Time moves first, so the new slot is armed
  // for the SAME due instant with a shorter remaining delay.
  clock.advance(30_000);
  monitor.clearSelfCheckTimer();
  monitor.scheduleSelfCheck();
  const [live] = armed();
  assert.notEqual(live, stale, 'the new schedule owns a new slot');
  assert.equal(live.armedAt + live.delay, stale.armedAt + stale.delay, 'both for the run\'s one due instant');
  // The replaced timer fires anyway: it must leave the CURRENT schedule alone.
  clock.state.current = stale.armedAt + stale.delay;
  stale.fired = true;
  stale.fn();
  // Its own delay HAD elapsed, so the run's due instant has arrived and the check happened
  // exactly once — by whichever timer got there, which is the same instant.
  assert.equal(monitor.lastSelfCheck().verdict, 'executor-alive-silent');
  assert.equal(monitor.lastSelfCheck().checkedAt, stale.armedAt + stale.delay);
  assert.equal(monitor.selfCheckTimer, null, 'and the schedule is retired');
  // The live handle can no longer add a second inspection: the run's one check is done, and
  // its diagnostic — and which handle performed it — do not change.
  const performedAt = monitor.scheduledSelfCheckAt;
  const checkedAt = monitor.lastSelfCheck().checkedAt;
  assert.equal(performedAt, checkedAt, 'the handle that fired AT the due instant performed it');
  clock.state.current = live.armedAt + live.delay;
  live.fired = true;
  live.fn();
  assert.equal(monitor.scheduledSelfCheckAt, performedAt, 'no second inspection is recorded');
  assert.equal(monitor.lastSelfCheck().checkedAt, checkedAt, 'the diagnostic is unchanged');
  void fire;
});

test('one silence is inspected ONCE, even when an observation arrives afterwards', () => {
  const { monitor, clock, armed, fire } = monitorFixture();
  monitor.scheduleSelfCheck();
  clock.advance(600_000);
  fire();
  const checkedAt = monitor.lastSelfCheck().checkedAt;
  assert.ok(checkedAt !== null);
  // A later observation of the SAME silence must not inspect again, and must not arm a
  // new timer for a silence that is already done.
  const settle = monitor.observe({ waitMs: 1 });
  clock.advance(1);
  return settle.then((outcome) => {
    assert.equal(outcome.reason, OBSERVE_REASONS.heartbeat);
    assert.equal(monitor.lastSelfCheck().checkedAt, checkedAt, 'the same silence was not re-inspected');
    assert.equal(armed().length, 0, 'nothing is armed for a silence that is already inspected');
  });
});

test('an observation that arrives FIRST makes the timer a no-op for that silence', () => {
  // The other order of the same latch: whichever entry point gets there first inspects,
  // and the other finds nothing to do.
  const { monitor, clock, armed, fire } = monitorFixture();
  monitor.scheduleSelfCheck();
  clock.advance(600_000);
  const diagnostic = monitor.runSelfCheck();
  assert.ok(diagnostic !== null, 'the direct check won the race');
  // The pending timer is now retired, and firing it does nothing.
  assert.equal(armed().length, 0);
  const checkedAt = monitor.lastSelfCheck().checkedAt;
  fire({ fn: () => {}, delay: 0, armedAt: clock.clockMs }); // a stale handle: harmless
  assert.equal(monitor.lastSelfCheck().checkedAt, checkedAt);
});

test('real progress does not move the self-check: its instant is the run\'s start', () => {
  const { monitor, task, clock, armed, fire } = monitorFixture();
  monitor.scheduleSelfCheck();
  clock.advance(300_000);
  monitor.onEvent(textDelta('still working'), clock.clockMs);
  const live = armed();
  // A BUSY run keeps the ONE timer it already has: the inspection is due at the run's own
  // start + the threshold, and streaming output neither postpones nor multiplies it.
  assert.equal(live.length, 1, 'exactly one timer for the run');
  assert.equal(live[0], monitor.selfCheckTimer.id, 'still the same slot — nothing re-armed it');
  assert.equal(live[0].delay, 600_000, 'still the whole threshold');
  // 9 minutes after the run started: still not due.
  clock.advance(9 * 60_000 - 1_000);
  assert.equal(monitor.lastSelfCheck(), null);
  clock.advance(1_000);
  fire(live[0]);
  assert.equal(monitor.lastSelfCheck().verdict, 'executor-alive-silent', 'the run was inspected while busy');
  assert.equal(armed().length, 0);
});

test('disabled, terminal, cancelled and disposed runs leave NO timer behind', () => {
  const cases = [
    { label: 'disabled with 0', options: { selfCheckSeconds: 0 }, task: taskRecord() },
    { label: 'terminal (awaiting review)', options: {}, task: taskRecord({ state: 'awaiting-host-review' }) },
    { label: 'cancelled', options: {}, task: taskRecord({ state: 'cancelled' }) },
    { label: 'failed', options: {}, task: taskRecord({ state: 'failed' }) },
  ];
  for (const testCase of cases) {
    const fixture = monitorFixture({ ...testCase.options, task: testCase.task });
    fixture.monitor.scheduleSelfCheck();
    assert.equal(fixture.armed().length, 0, `${testCase.label} must arm nothing`);
    assert.equal(fixture.monitor.selfCheckTimer, null);
  }

  // A live monitor that disposes mid-silence clears the pending timer.
  const live = monitorFixture();
  live.monitor.scheduleSelfCheck();
  assert.equal(live.armed().length, 1);
  live.monitor.dispose(live.clock.clockMs);
  assert.equal(live.armed().length, 0, 'disposal clears the scheduled self-check');
  assert.equal(live.monitor.selfCheckTimer, null);
  // A timer that fires after disposal writes nothing.
  const late = live.timers[0];
  assert.equal(late.cleared, true);
});

test('a finished run\'s monitor never inspects, even if a stale timer fires', () => {
  const { monitor, task, clock, armed } = monitorFixture();
  monitor.scheduleSelfCheck();
  const stale = armed()[0];
  // The run ends; the task record is what the scheduler must re-read.
  task.state = 'awaiting-host-review';
  task.endedAt = clock.clockMs;
  clock.advance(600_000);
  // Re-scheduling for a terminal run clears instead of arming.
  monitor.scheduleSelfCheck();
  assert.equal(monitor.lastSelfCheck(), null);
  assert.equal(stale.cleared, true);
});

test('the self-check never mutates the task, the deadline or the run', () => {
  const { monitor, task, clock } = monitorFixture();
  const before = {
    state: task.state,
    phase: task.phase,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    native: { ...task.native },
  };
  monitor.onEvent(textDelta('a'), clock.clockMs);
  clock.advance(300_000);
  monitor.runSelfCheck();
  assert.deepEqual(
    { state: task.state, phase: task.phase, startedAt: task.startedAt, endedAt: task.endedAt, native: { ...task.native } },
    before,
  );
  assert.equal(Object.hasOwn(task, 'deadlineAt'), false, 'no deadline field is invented or extended');
});

// ---------------------------------------------------------------------------
// 5. The run progress check: the DELIVERY clock, once per interval, permission precedence
// ---------------------------------------------------------------------------

test('forty minutes without a delivery reports the run progress check exactly once', async () => {
  const { monitor, task, clock } = monitorFixture();
  // The one time base for THIS reminder: consecutive time with nothing delivered back to the
  // commander. It starts at the run's own start, and internal model output never moves it.
  monitor.onEvent(textDelta('a'), clock.clockMs);
  clock.advance(1_000_000);
  const quiet = await monitor.observe({ waitMs: 25_000 });
  assert.equal(quiet.reason, OBSERVE_REASONS.heartbeat);

  clock.advance(1_300_000);
  // Still short of 40 minutes: nothing is due.
  const stillQuiet = await monitor.observe({ waitMs: 1 });
  assert.equal(stillQuiet.reason, OBSERVE_REASONS.heartbeat);

  clock.advance(200_000);
  const attention = await monitor.observe({ waitMs: 1 });
  assert.equal(attention.reason, OBSERVE_REASONS.attention);
  // WHICH reminder this is: nothing new was delivered for the interval.
  assert.equal(attention.checkpoint, CHECKPOINTS.progress);
  assert.equal(attention.progress.kind, CHECKPOINTS.progress);
  assert.equal(attention.progress.thresholdSeconds, 2400);
  assert.equal(attention.progress.noDeliveryMinutes >= 40, true, 'time without a delivery to the commander');
  assert.equal(attention.progress.noDeliveryForMs >= 2_400_000, true, 'the same span in milliseconds');
  // The two INDEPENDENT fields: how long nothing was returned, and what DSH is doing.
  assert.deepEqual(attention.progress.activity, { kind: 'model-working', currentTool: null });
  assert.equal(attention.progress.runContinues, true);
  // The report is claimed by `observe`, but a report is NOT a delivery of progress.
  assert.equal(monitor.deliveries, 0, 'the check itself is not a delivery');
  assert.equal(monitor.progressOrigin(), task.startedAt, 'so the interval is still the opening one');

  // ONCE per interval: however long it lasts and however often the host asks, the interval is
  // not reported a second time.
  const cooled = await monitor.observe({ waitMs: 25_000 });
  assert.equal(cooled.reason, OBSERVE_REASONS.heartbeat);
  assert.equal(cooled.waitedMs >= 25_000, true, 'the wait actually waits rather than returning at once');
  // Even much later, without any real delivery, the same interval stays quiet: the report
  // is keyed to the interval, not to a cooldown that would nag every interval.
  clock.advance(3 * 60 * 60_000);
  const later = await monitor.observe({ waitMs: 1 });
  assert.equal(later.reason, OBSERVE_REASONS.heartbeat, 'one interval, one report');
  assert.equal(later.checkpoint, null);
});

test('reading the self-check diagnostic never resets the delivery clock', async () => {
  // The defect the host's review locked: treating a readable local self-check as a stage result
  // pushed the 40-minute deadline out. The diagnostic may be READ on any answer — including a
  // plain heartbeat — and that read counts nothing.
  const { monitor, task, clock } = monitorFixture();
  monitor.onEvent(textDelta('a'), clock.clockMs);
  // The engine arms the run's one scheduled inspection when the run starts; the fixture's
  // scheduler is driven by the test, exactly as the host's timer is in production.
  monitor.scheduleSelfCheck();
  // The run's start is the baseline, not a delivery.
  assert.equal(monitor.progressOrigin(), task.startedAt);
  assert.equal(monitor.deliveries, 0);

  // The first wait starts BEFORE the check exists: a heartbeat that carries no diagnostic.
  clock.advance(30_000);
  const before = await monitor.observe({ waitMs: 25_000 });
  assert.equal(before.reason, OBSERVE_REASONS.heartbeat);
  assert.equal(before.selfCheck ?? null, null, 'no self-check has run yet');

  // Now the run is old enough for its scheduled inspection (the first wait already consumed
  // some of the clock), and the SAME task answers with the diagnostic on a plain heartbeat.
  // Reading it must not move the clock.
  clock.state.current = task.startedAt + 600_000;
  const reading = await monitor.observe({ waitMs: 1 });
  assert.equal(reading.reason, OBSERVE_REASONS.heartbeat, 'the answer is still a heartbeat');
  assert.equal(reading.selfCheck.verdict, 'executor-alive-silent', 'but the diagnostic is readable');
  assert.equal(monitor.deliveries, 0, 'reading a diagnostic is not a result');
  assert.equal(monitor.progressOrigin(), task.startedAt, 'the interval is still the opening one');

  // The observation's own bounded wait advances the clock, so it is asked about the instant it
  // will END at. One millisecond before the mark it ends exactly ON the mark: that is the
  // earliest a caller can be told, and it is not before it.
  clock.state.current = task.startedAt + 2_400_000 - 1;
  const atTheMark = await monitor.observe({ waitMs: 1 });
  assert.equal(atTheMark.reason, OBSERVE_REASONS.attention, 'its wait ends exactly at the mark');
  assert.equal(monitor.progressReported.at, task.startedAt + 2_400_000, 'never reported before the mark');
  assert.equal(monitor.deliveries, 0, 'and nothing was counted as a result');

  // The same instant asked again: one interval, one report, and no second one is produced.
  clock.state.current = task.startedAt + 2_400_000;
  const again = await monitor.observe({ waitMs: 1 });
  assert.equal(again.reason, OBSERVE_REASONS.heartbeat, 'the interval was already reported');
  assert.equal(again.checkpoint ?? null, null);
  assert.equal(monitor.progressReported.origin, task.startedAt, 'the report belongs to the opening interval');
  assert.equal(task.state, 'running', 'and the run is untouched');
  assert.equal(monitor.deliveries, 0, 'no diagnostic or internal event was ever counted');
});

test('a real stage result opens the next interval; internal activity and diagnostics never do', async () => {
  const { monitor, clock } = monitorFixture();
  monitor.onEvent(textDelta('a'), clock.clockMs);
  clock.advance(2_400_000);
  const first = await monitor.observe({ waitMs: 1 });
  assert.equal(first.reason, OBSERVE_REASONS.attention);
  assert.equal(first.checkpoint, CHECKPOINTS.progress);

  // Internal activity — a reasoning step, output, a tool call — is NOT a delivery, so the
  // interval and its spent latch are untouched: the clock does not restart.
  clock.advance(5_000);
  monitor.onEvent(reasoningDelta('still thinking'), clock.clockMs);
  monitor.onEvent(textDelta('more output'), clock.clockMs);
  monitor.onEvent(toolCall('bash', 'c-1'), clock.clockMs);
  monitor.onEvent(toolResult('c-1'), clock.clockMs);
  assert.equal(monitor.deliveries, 0, 'no internal event is a delivery');
  assert.equal(monitor.progressOrigin(), monitor.task.startedAt, 'the opening interval is unchanged');
  const settled = await monitor.observe({ waitMs: 100 });
  assert.equal(settled.reason, OBSERVE_REASONS.heartbeat, 'the spent interval stays quiet');
  // The self-check is measured from the run's start, so it is NOT restarted by that activity
  // either: the run has long been running, so it was already inspected — exactly once.
  assert.equal(monitor.lastSelfCheck()?.verdict, 'executor-alive-silent', 'the run was inspected');
  assert.equal(monitor.runSelfCheck(clock.clockMs), null, 'and never twice for one run');

  // A REAL stage result opens the next interval — through the reserved, INTERNAL and
  // event-deduplicated seam. The observation below spans the WHOLE new interval: it must end
  // with that interval's report, not with a heartbeat.
  const deliveryAt = clock.clockMs;
  const delivered = monitor.noteStageResult({ eventId: 'stage-1', deliveredAt: deliveryAt });
  assert.equal(delivered.counted, true, 'a genuine stage result opens the next interval');
  assert.equal(monitor.progressOrigin(), delivered.delivery, 'the new interval begins at the delivery');
  clock.advance(2_400_000 + 1_000);
  const second = await monitor.observe({ waitMs: 1 });
  assert.equal(second.reason, OBSERVE_REASONS.attention, 'the NEXT interval reports in its own turn');
  assert.equal(second.checkpoint, CHECKPOINTS.progress);
  assert.equal(second.progress.noDeliveryForMs >= 2_400_000, true, 'measured from that delivery');
  assert.equal(second.progress.lastDeliveryAt, delivered.delivery);
  // Its own latch: that interval is spent as well.
  const cooledAgain = await monitor.observe({ waitMs: 1 });
  assert.equal(cooledAgain.reason, OBSERVE_REASONS.heartbeat, 'one interval, one report');
});

test('the reserved stage-result seam counts one event ONCE, and only a real delivery moves the clock', () => {
  const { monitor, task, clock } = monitorFixture();
  monitor.onEvent(textDelta('a'), clock.clockMs);

  // The START is a baseline, not a delivery: a stage result dated there changes nothing.
  assert.equal(monitor.noteStageResult({ eventId: 'at-start', deliveredAt: task.startedAt }).counted, false);
  assert.equal(monitor.deliveries, 0);

  // A malformed confirmation is refused, never treated as a delivery.
  assert.equal(monitor.noteStageResult(null).reason, 'stage-required');
  assert.equal(monitor.noteStageResult({ deliveredAt: clock.clockMs }).reason, 'event-id-required');
  assert.equal(monitor.noteStageResult({ eventId: 's-x' }).reason, 'delivery-instant-required');
  assert.equal(monitor.noteStageResult({ eventId: 's-x', deliveredAt: 'later' }).reason, 'delivery-instant-required');
  assert.equal(monitor.deliveries, 0, 'nothing refused was ever counted');

  // ONE genuine stage result advances the clock once.
  clock.advance(120_000);
  const first = monitor.noteStageResult({ eventId: 'stage-A', deliveredAt: clock.clockMs });
  assert.equal(first.counted, true);
  assert.equal(first.reason, null);
  assert.equal(monitor.deliveries, 1);
  const origin = monitor.progressOrigin();
  assert.equal(origin, first.delivery);

  // The SAME event replayed — even with a much later instant — is a duplicate: it must not
  // open a second interval. An instant INSIDE this interval is refused too: accepting it would
  // make the 40-minute clock depend on when a confirmation happened to be produced.
  clock.advance(600_000);
  const replay = monitor.noteStageResult({ eventId: 'stage-A', deliveredAt: clock.clockMs });
  assert.equal(replay.counted, false);
  assert.equal(replay.reason, 'duplicate');
  assert.equal(monitor.progressOrigin(), origin, 'a replay never moves the clock');
  assert.equal(monitor.deliveries, 1);
  const insideInterval = monitor.noteStageResult({ eventId: 'stage-B', deliveredAt: origin - 1 });
  assert.equal(insideInterval.counted, false);
  assert.equal(insideInterval.reason, 'stale', 'an instant inside this interval is refused');
  assert.equal(monitor.progressOrigin(), origin);

  // A really NEW event after that does open the next interval, exactly once.
  clock.advance(1_000);
  const next = monitor.noteStageResult({ eventId: 'stage-B', deliveredAt: clock.clockMs });
  assert.equal(next.counted, true, `refused with ${next.reason} at ${clock.clockMs} vs origin ${origin}`);
  assert.equal(monitor.deliveries, 2);
  assert.equal(monitor.noteStageResult({ eventId: 'stage-B', deliveredAt: clock.clockMs }).counted, false);
});

test('the two reminders are independently switchable on their own clocks', async () => {
  // Self-check OFF: the 40-minute check still fires from the run's start; nothing is inspected.
  const selfOff = monitorFixture({ selfCheckSeconds: 0 });
  selfOff.monitor.onEvent(textDelta('a'), selfOff.clock.clockMs);
  selfOff.clock.advance(2_400_000);
  const reported = await selfOff.monitor.observe({ waitMs: 1 });
  assert.equal(reported.reason, OBSERVE_REASONS.attention, 'the delivery reminder is on its own switch');
  assert.equal(reported.checkpoint, CHECKPOINTS.progress);
  assert.equal(selfOff.monitor.lastSelfCheck(), null, 'and the self-check is off: nothing was inspected');
  assert.equal(selfOff.monitor.selfCheckDue(selfOff.clock.clockMs + 6 * 3_600_000), false);

  // Delivery reminder OFF: the self-check still runs exactly once; no reminder is ever claimed.
  const checkOff = monitorFixture({ attentionSeconds: 0 });
  checkOff.monitor.onEvent(textDelta('a'), checkOff.clock.clockMs);
  checkOff.clock.advance(600_000);
  const check = checkOff.monitor.runSelfCheck();
  assert.ok(check !== null, 'the self-check is on its own switch and still runs');
  assert.equal(check.verdict, 'executor-alive-silent');
  checkOff.clock.advance(10 * 3_600_000);
  const quiet = await checkOff.monitor.observe({ waitMs: 1 });
  assert.equal(quiet.reason, OBSERVE_REASONS.heartbeat, 'the reminder switch is off');
  assert.equal(checkOff.monitor.claimAttention(checkOff.clock.clockMs), false);
  assert.equal(checkOff.monitor.deliveries, 0);
  // And its absence does not disturb the run's one inspection record.
  assert.equal(checkOff.monitor.runSelfCheck(checkOff.clock.clockMs), null, 'still once per run');
});

test('a pending permission request outranks the reminder and never counts as a stall', async () => {
  const { monitor, task, clock } = monitorFixture();
  monitor.onEvent(textDelta('a'), clock.clockMs);
  clock.advance(2_500_000);
  task.permission.pending = { requestId: 'permission-1', state: 'pending' };
  task.phase = 'awaiting-permission';
  const outcome = await monitor.observe({ waitMs: 25_000 });
  assert.equal(outcome.reason, OBSERVE_REASONS.permission);
  // The self-check diagnostic returned with this observation says WHY the run is
  // quiet: it is waiting for a decision, not stalled.
  assert.equal(outcome.selfCheck.verdict, 'waiting-for-permission');
  assert.equal(outcome.selfCheck.detail.permissionRequestId, 'permission-1');
  assert.equal(outcome.selfCheck.detail.phaseIsPermissionWait, true);
  // Waiting is not silence for the purposes of an alert: no attention was delivered.
  assert.equal(monitor.attentionDelivered, null);
});

test('the self-check reports a running tool truthfully', () => {
  const running = monitorFixture();
  running.clock.advance(1);
  running.monitor.onEvent(textDelta('a'), running.clock.clockMs);
  running.clock.advance(1);
  running.monitor.onEvent(toolCall('bash', 'c-1'), running.clock.clockMs);
  running.clock.advance(600_000);
  const toolCheck = running.monitor.runSelfCheck();
  assert.equal(toolCheck.verdict, 'tool-running');
  assert.equal(toolCheck.detail.currentTool.name, 'bash');
});

test('a terminal state outranks everything, including an armed attention', async () => {
  for (const [state, reason] of [
    ['awaiting-host-review', OBSERVE_REASONS.ready],
    ['failed', OBSERVE_REASONS.failed],
    ['cancelled', OBSERVE_REASONS.cancelled],
  ]) {
    const { monitor, task, clock } = monitorFixture();
    monitor.onEvent(textDelta('a'), clock.clockMs);
    clock.advance(2_500_000);
    task.state = state;
    task.endedAt = clock.clockMs;
    const outcome = await monitor.observe({ waitMs: 25_000 });
    assert.equal(outcome.reason, reason, `${state} must report ${reason}`);
    assert.equal(outcome.checkpoint, null, 'a terminal outcome is never dressed up as a reminder');
  }
});

test('a long tool call still counts as no delivery, and duration alone never ends the run', async () => {
  const { monitor, clock } = monitorFixture();
  monitor.onEvent(textDelta('a'), clock.clockMs);
  monitor.onEvent(toolCall('bash', 'c-long'), clock.clockMs);
  // A long build command. An open tool call changes how the interval is DESCRIBED, not
  // whether it counts: a tool that genuinely emits nothing is still no delivery. Nothing
  // here may fail or cancel the run.
  const reasons = [];
  let toolVerdict = null;
  let reports = 0;
  for (let index = 0; index < 50; index += 1) {
    clock.advance(50_000);
    const outcome = await monitor.observe({ waitMs: 1 });
    reasons.push(outcome.reason);
    if (outcome.checkpoint === CHECKPOINTS.progress) reports += 1;
    if (outcome.selfCheck !== null && outcome.selfCheck !== undefined) toolVerdict = outcome.selfCheck.verdict;
    // A settled call and a fresh one every 10 minutes is real internal work — but it is not a
    // DELIVERY, so the delivery clock is not restarted by it.
    if (index % 12 === 11) {
      monitor.onEvent(toolResult(`c-long`), clock.clockMs);
      monitor.onEvent(toolCall('bash', `c-${index}`), clock.clockMs);
    }
  }
  assert.equal(toolVerdict, 'tool-running', 'the diagnostic names the open call as the reason');
  assert.equal(reports, 1, 'one delivery interval, one report — the reminder is never an action');
  assert.equal(reasons.includes(OBSERVE_REASONS.attention), true, 'and it is reported, not hidden');
  // And it is still a running task with its tool intact: a reminder would be a report,
  // never an action.
  assert.equal(monitor.task.state, 'running');
  assert.equal(monitor.activity.tool !== null, true, 'the open call is not dropped or cancelled');

  const summary = monitor.snapshot({ at: clock.clockMs, toolActive: true });
  assert.equal(summary.waitingOn, 'tool');
  assert.equal(summary.currentTool.name, 'bash');
  assert.equal(summary.currentTool.elapsedMs >= 0, true, 'the span is reported, not hidden');
});

test('a genuinely silent long tool IS reported once, and keeps running', async () => {
  // The other half of the same rule: silence with an open tool counts, and reaches the
  // notification interval like any other silence.
  const { monitor, clock } = monitorFixture();
  monitor.onEvent(textDelta('a'), clock.clockMs);
  monitor.onEvent(toolCall('bash', 'c-hung'), clock.clockMs);
  let reports = 0;
  for (let index = 0; index < 60; index += 1) {
    clock.advance(60_000);
    const outcome = await monitor.observe({ waitMs: 1 });
    if (outcome.checkpoint === CHECKPOINTS.progress) {
      reports += 1;
      assert.equal(outcome.progress.currentTool.name, 'bash');
    }
  }
  assert.equal(reports, 1, 'one silence, one report — and it names the open call');
  assert.equal(monitor.task.state, 'running');
  assert.equal(monitor.activity.tool !== null, true, 'the open call is never killed by a reminder');
});

// ---------------------------------------------------------------------------
// 5b. ONE time base: total runtime is never a reminder
// ---------------------------------------------------------------------------

test('a run that keeps making internal progress for HOURS reports the delivery interval only', async () => {
  // A healthy, long run: real output every 5 minutes for three hours. Internal output is not
  // a delivery back to the commander, so the delivery clock is NOT restarted — what it does
  // produce is exactly ONE report, once the interval has run out, while the run keeps going.
  const { monitor, task, clock } = monitorFixture();
  const reports = [];
  for (let minute = 5; minute <= 180; minute += 5) {
    clock.advance(5 * 60_000 - 1_000);
    monitor.onEvent(textDelta(`token-${minute}`), clock.clockMs);
    const outcome = await monitor.observe({ waitMs: 1_000 });
    if (outcome.checkpoint !== null) reports.push({ minute, reason: outcome.reason, checkpoint: outcome.checkpoint });
  }
  assert.equal(reports.length, 1, 'total runtime is not a reminder: one interval, one report');
  assert.equal(reports[0].checkpoint, CHECKPOINTS.progress);
  assert.equal(reports[0].minute, 40, 'and it arrives when the interval has really run out');
  assert.equal(task.state, 'running', 'the run is never stopped by a report');
  assert.equal(monitor.deliveries, 0, 'nothing was delivered, so nothing reset the clock');
});

// ---------------------------------------------------------------------------
// 6. Observation: bounded wait, abort-only cleanup, disposal
// ---------------------------------------------------------------------------

test('an observation is bounded and returns heartbeat when it runs out', async () => {
  const { monitor, clock } = monitorFixture();
  monitor.onEvent(textDelta('a'), clock.clockMs);
  const outcome = await monitor.observe({ waitMs: 25_000 });
  assert.equal(outcome.reason, OBSERVE_REASONS.heartbeat);
  assert.equal(outcome.waitedMs >= 25_000, true);
  assert.equal(clock.state.waits > 0, true, 'the seam was actually used');
});

test('the wait is clamped to 25 seconds and a request completes within the bound', async () => {
  const clock = fakeClock();
  const monitor = new TaskMonitor(taskRecord(), {
    now: clock.now,
    wait: clock.wait,
    waitSliceMs: 100,
  });
  monitor.onEvent(textDelta('a'), clock.clockMs);
  const outcome = await monitor.observe({ waitMs: 10 * 60 * 1000 });
  assert.equal(outcome.waitedMs <= 25_000, true, 'a caller cannot hold the request open longer');
});

test('an aborted observation releases its own waiter and does not touch the task', async () => {
  // The delivery interval is far away, so nothing else can answer before the abort does.
  const { monitor, task, clock } = monitorFixture({ start: 5_000_000, task: taskRecord({ startedAt: 5_000_000 }) });
  monitor.onEvent(textDelta('a'), clock.clockMs);
  const controller = new AbortController();
  const outcome = monitor.observe({ waitMs: 25_000, signal: controller.signal });
  clock.advance(25_000);
  controller.abort();
  const result = await outcome;
  assert.equal(result.reason, OBSERVE_REASONS.interrupted);
  // The task is untouched: no state change, no cancellation, no new phase.
  assert.equal(task.state, 'running');
  assert.equal(task.phase, 'execute');
  assert.equal(task.endedAt, null);
  assert.equal(monitor.waiters.size, 0, 'this observer released only its own waiter');
});

test('an already-aborted signal returns immediately without registering a waiter', async () => {
  const { monitor, clock } = monitorFixture();
  monitor.onEvent(textDelta('a'), clock.clockMs);
  const controller = new AbortController();
  controller.abort();
  const before = clock.state.waits;
  const outcome = await monitor.observe({ waitMs: 25_000, signal: controller.signal });
  assert.equal(outcome.reason, OBSERVE_REASONS.interrupted);
  assert.equal(clock.state.waits, before, 'nothing was scheduled');
});

test('two observers do not interfere with each other', async () => {
  const { monitor, clock } = monitorFixture();
  monitor.onEvent(textDelta('a'), clock.clockMs);
  const first = monitor.observe({ waitMs: 10_000 });
  const second = monitor.observe({ waitMs: 10_000 });
  // Two independent registrations, one per caller.
  assert.equal(monitor.waiters.size, 2, 'each observer owns its own waiter');
  clock.advance(10_000);
  clock.advance(10_000);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(typeof a.reason, 'string');
  assert.equal(typeof b.reason, 'string');
  assert.equal(monitor.waiters.size, 0, 'both registrations are released');
  assert.equal(monitor.disposed, false);
});

test('cancelling one observer leaves the other observing', async () => {
  const { monitor, clock } = monitorFixture();
  monitor.onEvent(textDelta('a'), clock.clockMs);
  const controller = new AbortController();

  const cancelled = monitor.observe({ waitMs: 25_000, signal: controller.signal });
  const survivor = monitor.observe({ waitMs: 25_000 });
  assert.equal(monitor.waiters.size, 2);

  // Abort while both are still blocked. Only the named observer may end.
  controller.abort();
  assert.equal((await cancelled).reason, OBSERVE_REASONS.interrupted);

  // The other observation is untouched: still registered, and it completes on its
  // own bounded wait rather than being woken by the first caller's abort.
  assert.equal(monitor.waiters.size, 1);
  const stillThere = await survivor;
  assert.equal(stillThere.reason, OBSERVE_REASONS.heartbeat);
  assert.equal(monitor.waiters.size, 0);
});

test('concurrent observers claim the one progress report atomically', async () => {
  const { monitor, clock } = monitorFixture();
  monitor.onEvent(textDelta('a'), clock.clockMs);
  clock.advance(2_400_000);
  // All observations are live at the instant the interval is reached. Exactly one may
  // deliver the report; the others must keep waiting, or the host is woken several
  // times for ONE silence.
  const first = monitor.observe({ waitMs: 25_000 });
  const second = monitor.observe({ waitMs: 25_000 });
  const third = monitor.observe({ waitMs: 25_000 });
  clock.advance(25_000);
  const outcomes = await Promise.all([first, second, third]);
  const attention = outcomes.filter((outcome) => outcome.reason === OBSERVE_REASONS.attention);
  assert.equal(attention.length, 1, 'exactly one observer may report the progress check');
  assert.equal(attention[0].checkpoint, CHECKPOINTS.progress);
  for (const outage of outcomes.filter((outcome) => outcome !== attention[0])) {
    assert.equal(outage.reason, OBSERVE_REASONS.heartbeat);
  }
  // One REPORT record, not a collection that grows per claim. It is bound to the interval it
  // describes (`origin`), it is kept apart from the delivery record, and it is never itself a
  // delivery of progress.
  assert.equal(typeof monitor.progressReported, 'object');
  assert.equal(Object.keys(monitor.progressReported).sort().join(','), 'at,origin');
  assert.equal(monitor.progressReported.origin, monitor.progressOrigin(), 'bound to the reported interval');
  assert.equal(monitor.attentionDelivered, null, 'a report is never recorded as a delivery');
  assert.equal(monitor.deliveries, 0, 'and never advances the delivery clock');
  // The published view says the same thing, without exposing either internal record.
  const view = monitor.snapshot({ at: clock.clockMs }).progressCheck;
  assert.equal(view.reportedThisEpisode, true, 'the interval reads as reported');
});

test('disposing a monitor ends every wait without touching the run', async () => {
  const { monitor, task, clock } = monitorFixture();
  monitor.onEvent(textDelta('a'), clock.clockMs);
  const pending = monitor.observe({ waitMs: 25_000 });
  monitor.dispose();
  const outcome = await pending;
  assert.equal(outcome.reason, OBSERVE_REASONS.interrupted);
  assert.equal(task.state, 'running');
  // After disposal, further observations are interrupted immediately and no event
  // is recorded.
  const after = await monitor.observe({ waitMs: 25_000 });
  assert.equal(after.reason, OBSERVE_REASONS.interrupted);
  assert.equal(monitor.onEvent(textDelta('b'), clock.clockMs), false);
});

test('the real wait seam honours an abort and does not keep the process alive', async () => {
  const controller = new AbortController();
  const pending = sleep(30_000, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, (error) => error.name === 'AbortError');
  // A completed short wait resolves normally.
  await sleep(1);
});

test('only real report reasons are public; heartbeat is internal-only', () => {
  assert.equal(isPublicReason(OBSERVE_REASONS.attention), true);
  assert.equal(isPublicReason(OBSERVE_REASONS.permission), true);
  assert.equal(isPublicReason(OBSERVE_REASONS.ready), true);
  assert.equal(isPublicReason(OBSERVE_REASONS.failed), true);
  assert.equal(isPublicReason(OBSERVE_REASONS.cancelled), true);
  assert.equal(isPublicReason(OBSERVE_REASONS.interrupted), true);
  assert.equal(isPublicReason(OBSERVE_REASONS.heartbeat), false);
  assert.equal(isPublicReason('made-up'), false);
});

test('a task that ended wins over a monitor dispose in the same instant', async () => {
  // Engine teardown disposes monitors; if a run reached its outcome first, that
  // outcome is the truth. Reporting `interrupted` would hide a completed task.
  const { monitor, task } = monitorFixture();
  monitor.onEvent(textDelta('a'), monitor.now());
  task.state = 'awaiting-host-review';
  task.endedAt = monitor.now();
  const pending = monitor.observe({ waitMs: 25_000 });
  monitor.dispose(task.endedAt);
  const outcome = await pending;
  assert.equal(outcome.reason, OBSERVE_REASONS.ready);
});

test('a disposed monitor still answers a settled task with its outcome', async () => {
  // Engine teardown must stop observation loops without rewriting history: a run
  // that ended still reports how it ended.
  const { monitor, task } = monitorFixture();
  monitor.onEvent(textDelta('a'), monitor.now());
  monitor.dispose(monitor.now());
  task.state = 'failed';
  task.endedAt = monitor.now();
  const outcome = await monitor.observe({ waitMs: 25_000 });
  assert.equal(outcome.reason, OBSERVE_REASONS.failed);
  // A still-running task on a disposed monitor is interrupted, because there is
  // nothing left that could ever report on it.
  const running = monitorFixture();
  running.monitor.dispose();
  const interrupted = await running.monitor.observe({ waitMs: 25_000 });
  assert.equal(interrupted.reason, OBSERVE_REASONS.interrupted);
});

test('a terminal state freezes every elapsed value at the recorded end', async () => {
  const { monitor, task, clock } = monitorFixture();
  monitor.onEvent(textDelta('a'), clock.clockMs);
  monitor.onEvent(toolCall('bash', 'c-open'), clock.clockMs);
  clock.advance(120_000);

  const live = monitor.snapshot({ at: clock.clockMs, toolActive: true });
  assert.equal(live.currentTool.elapsedMs, 120_000);

  // The run ends here; an hour later the record must not claim a four-hour tool.
  task.state = 'failed';
  task.endedAt = clock.clockMs;
  monitor.dispose(task.endedAt);
  clock.advance(3_600_000);

  const frozen = monitor.snapshot({ at: clock.clockMs, toolActive: true });
  assert.equal(frozen.currentTool.elapsedMs, 120_000, 'the tool span stopped at the end');
  assert.equal(frozen.idleForMs, 120_000, 'the idle span stopped too');
  assert.equal(frozen.finalizedAt, task.endedAt);
  // Measuring against the end is idempotent however often it is read.
  assert.equal(monitor.snapshot({ at: clock.clockMs + 10_000 }).finalizedAt, task.endedAt);
});

test('the published activity count is genuine progress only', () => {
  const activity = new TaskActivity({ now: () => 0 });
  // Progress.
  activity.record(classifyActivityEvent(textDelta('x')), 1);
  activity.record(classifyActivityEvent(reasoningDelta('y')), 2);
  // Structure and unrelated traffic must not inflate it.
  for (const noise of [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'usage', data: {} },
    { type: 'heartbeat' },
    { type: 'result-poll' },
    { type: 'text-delta', data: { text: '' } },
  ]) {
    activity.record(classifyActivityEvent(noise), 3);
  }
  const summary = activity.summary({ at: 100 });
  assert.equal(summary.activityEvents, 2, 'only the two genuine deltas count as activity');
  assert.equal(summary.events, 8, 'every observation is still counted as an event');
});

test('twenty minutes of progress DURING one live observation never reports attention', async () => {
  // The decisive case: a single observation is waiting while the executor keeps
  // producing output. A monitor that treats "an event arrived" as an alert wakes
  // the host on every normal token — exactly what this feature exists to stop.
  const clock = fakeClock(2_000_000);
  const task = taskRecord({ startedAt: 2_000_000 });
  // The wait seam drives both the clock and the executor: every simulated slice
  // delivers real progress, the way a healthy run streams while a client waits.
  let emitted = 0;
  let slices = 0;
  const monitor = new TaskMonitor(task, {
    now: clock.now,
    waitSliceMs: 1_000,
    async wait(ms, options = {}) {
      slices += 1;
      await Promise.resolve();
      if (options?.signal?.aborted === true) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      clock.state.current += ms;
      // One reasoning delta and one output delta per second of simulated time.
      monitor.onEvent(reasoningDelta(`thought-${slices}`), clock.clockMs);
      monitor.onEvent(textDelta(`token-${slices}`), clock.clockMs);
      emitted += 2;
    },
  });
  task.monitor = monitor;

  const outcomes = [];
  // 20 minutes is 48 consecutive 25-second observations, each internally sliced.
  for (let round = 0; round < 48; round += 1) {
    outcomes.push(await monitor.observe({ waitMs: 25_000 }));
  }

  assert.equal(clock.clockMs - 2_000_000, 1_200_000, 'exactly twenty simulated minutes elapsed');
  // Each 25-second observation is sliced into 1-second waits, so 1200 emitted pairs.
  assert.equal(emitted, 2_400, 'the executor emitted throughout the watch');
  for (const outcome of outcomes) {
    assert.notEqual(outcome.reason, OBSERVE_REASONS.attention,
      'normal progress must never be reported as attention');
    assert.equal(outcome.reason, OBSERVE_REASONS.heartbeat);
  }
  // The activity was still RECORDED (it is progress, and the UI shows it)…
  assert.equal(monitor.activity.activityEvents(), 2_400);
  // …and the run was never disturbed.
  assert.equal(task.state, 'running');
  assert.equal(task.endedAt, null);
  assert.equal(monitor.attentionDelivered, null, 'no attention was ever delivered');
});

test('a single observation spanning the no-progress interval reports it once', async () => {
  // The other side of the same rule: an observation that is STILL waiting when the
  // executor falls silent must deliver the report itself, not defer it to the next call.
  const clock = fakeClock(3_000_000);
  const task = taskRecord({ startedAt: 3_000_000 });
  let firstSlice = true;
  const monitor = new TaskMonitor(task, {
    now: clock.now,
    waitSliceMs: 1_000,
    async wait(ms, options = {}) {
      await Promise.resolve();
      if (options?.signal?.aborted === true) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      clock.state.current += ms;
      if (firstSlice) {
        firstSlice = false;
        monitor.onEvent(textDelta('last token'), clock.clockMs);
      }
    },
  });
  task.monitor = monitor;
  // Anchor the silence, then let the observation run through it.
  monitor.onEvent(textDelta('go'), clock.clockMs);
  const outcome = await monitor.observe({ waitMs: 25_000 });
  assert.equal(outcome.reason, OBSERVE_REASONS.heartbeat, 'the first observation is bounded and silent');
  clock.advance(2_400_000);
  const alert = await monitor.observe({ waitMs: 25_000 });
  assert.equal(alert.reason, OBSERVE_REASONS.attention);
  assert.equal(alert.checkpoint, CHECKPOINTS.progress);
});

test('heartbeat, result polling and an empty delta never reset the no-progress clock', async () => {
  const { monitor, clock } = monitorFixture();
  monitor.onEvent(textDelta('a'), clock.clockMs);
  const lastActivity = monitor.activity.lastActivityAt;

  // A minute of pure noise: connection heartbeats, result polls and empty deltas.
  for (let index = 0; index < 60; index += 1) {
    clock.advance(1_000);
    monitor.onEvent({ type: 'heartbeat' }, clock.clockMs);
    monitor.onEvent({ type: 'result-poll' }, clock.clockMs);
    monitor.onEvent(textDelta(''), clock.clockMs);
    monitor.onEvent({ type: 'page-refresh' }, clock.clockMs);
  }
  assert.equal(monitor.activity.lastActivityAt, lastActivity, 'noise is not progress');

  // The counters still recorded the traffic, so an operator can see it happened.
  assert.equal(monitor.activity.totalEvents() > 0, true);

  // Silence therefore keeps accruing: the report is due once the 40-minute mark is
  // crossed, exactly as it would have been without the noise.
  while (!monitor.attentionDue()) clock.advance(1_000);
  const outcome = await monitor.observe({ waitMs: 1 });
  assert.equal(outcome.reason, OBSERVE_REASONS.attention);
  assert.equal(outcome.checkpoint, CHECKPOINTS.progress);
});

// ---------------------------------------------------------------------------
// Repeated-failure reminder: independent of the silence clock
// ---------------------------------------------------------------------------

/**
 * Drive one failing call/result pair through a monitor.
 * @param {object} monitor - the monitor under test.
 * @param {number} at - observation time.
 * @param {object} [options] - `name`, `callId`, `args`, `code`, `reason`, `body`.
 * @returns {void}
 */
function repeatFailure(monitor, at, options = {}) {
  monitor.onEvent(toolCall(options.name ?? 'bash', options.callId ?? 'call-x', options.args ?? '{"command":"npm test"}'), at);
  monitor.onEvent(
    failedToolResult(options.callId ?? 'call-x', {
      code: options.code ?? 'ENOENT',
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      ...(options.body === undefined ? {} : { body: options.body }),
    }),
    at,
  );
}

test('the same tool, operation and failure three times reports once and leaves the task running', async () => {
  const { monitor, task, clock } = monitorFixture({ repeatFailureThreshold: 3 });
  for (const id of ['c1', 'c2', 'c3']) repeatFailure(monitor, clock.clockMs, { callId: id });

  const outcome = await monitor.observe({ waitMs: 1 });
  assert.equal(outcome.reason, OBSERVE_REASONS.attention, 'the reminder rides the existing attention reason');
  assert.equal(outcome.failure.kind, 'repeated-tool-failure');
  assert.equal(outcome.failure.toolName, 'bash');
  assert.equal(outcome.failure.failureCode, 'ENOENT');
  assert.equal(outcome.failure.consecutive, 3);
  assert.match(outcome.failure.eventId, /^[0-9a-f]{16}$/u, 'the reminder carries a stable event identity');
  assert.equal(task.state, 'running', 'a reminder never changes the task state');

  // Delivered once is NOT taken once: the reminder is redelivered with the SAME
  // eventId until a receiver acknowledges it, so a lost answer is recoverable.
  repeatFailure(monitor, clock.clockMs, { callId: 'c4' });
  const again = await monitor.observe({ waitMs: 1 });
  assert.equal(again.failure.eventId, outcome.failure.eventId, 'one repeated failure is ONE notification identity');

  // The ack clears it by its exact eventId; further observations stay quiet.
  const ack = monitor.ackFailureReport(outcome.failure.eventId);
  assert.equal(ack.acknowledged, true);
  const quiet = await monitor.observe({ waitMs: 1 });
  assert.equal(quiet.failure, null, 'acknowledged, then quiet — even with more identical failures');
});

test('fewer than the threshold, a different operation, a different failure or a success all reset the count', async () => {
  const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 3 });
  const BUILD = '{"command":"npm run build"}';
  // Two identical failures are not enough.
  repeatFailure(monitor, clock.clockMs, { callId: 'a1' });
  repeatFailure(monitor, clock.clockMs, { callId: 'a2' });
  assert.equal(monitor.failures.episode.count, 2);
  assert.equal(monitor.pendingFailure, null);

  // A DIFFERENT operation starts a new episode rather than continuing this one.
  repeatFailure(monitor, clock.clockMs, { callId: 'a3', args: BUILD });
  assert.equal(monitor.failures.episode.count, 1);
  assert.equal(monitor.pendingFailure, null);

  // Same operation again, but a DIFFERENT failure code: also its own episode.
  repeatFailure(monitor, clock.clockMs, { callId: 'a4', args: BUILD });
  assert.equal(monitor.failures.episode.count, 2, 'the same operation and code continues its episode');
  repeatFailure(monitor, clock.clockMs, { callId: 'a5', args: BUILD, code: 'EACCES' });
  assert.equal(monitor.failures.episode.count, 1, 'a new failure code restarts the count');
  assert.equal(monitor.pendingFailure, null);

  // A SUCCESS ends the episode entirely.
  monitor.onEvent(toolCall('bash', 'a6', BUILD), clock.clockMs);
  monitor.onEvent(toolResult('a6'), clock.clockMs);
  assert.equal(monitor.failures.episode, null, 'success clears the failure episode');
  assert.equal(monitor.pendingFailure, null);
});

test('a duplicate result for the same callId is counted once', async () => {
  const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 2 });
  repeatFailure(monitor, clock.clockMs, { callId: 'dup-1' });
  // The harness/runner can replay the same settled result; it must not count twice.
  monitor.onEvent(failedToolResult('dup-1', { code: 'ENOENT' }), clock.clockMs);
  monitor.onEvent(failedToolResult('dup-1', { code: 'ENOENT' }), clock.clockMs);
  assert.equal(monitor.failures.episode.count, 1);
  assert.equal(monitor.pendingFailure, null, 'one failure of a two-failure threshold is not a reminder');
});

test('a run whose failures persisted past the threshold reminds until acknowledged, and a new episode may remind again', async () => {
  const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 3 });
  for (const id of ['e1', 'e2', 'e3', 'e4', 'e5']) repeatFailure(monitor, clock.clockMs, { callId: id });
  const first = await monitor.observe({ waitMs: 1 });
  assert.equal(first.failure.consecutive, 3, 'the reminder names the count it first reached');
  const redelivered = await monitor.observe({ waitMs: 1 });
  assert.equal(redelivered.failure.eventId, first.failure.eventId, 'continuous failures redeliver the SAME notification');
  monitor.ackFailureReport(first.failure.eventId);

  // The run recovers and then fails identically again: that is a NEW episode, and it
  // is reported again — once, not per failure.
  monitor.onEvent(toolCall('bash', 'e6', '{"command":"npm test"}'), clock.clockMs);
  monitor.onEvent(toolResult('e6'), clock.clockMs);
  for (const id of ['e7', 'e8', 'e9', 'e10']) repeatFailure(monitor, clock.clockMs, { callId: id });
  const second = await monitor.observe({ waitMs: 1 });
  assert.equal(second.reason, OBSERVE_REASONS.attention);
  assert.equal(second.failure.consecutive, 3, 'the new episode reports its own count');
  assert.notEqual(second.failure.eventId, first.failure.eventId, 'a new episode has its own identity');
  monitor.ackFailureReport(second.failure.eventId);
  assert.equal((await monitor.observe({ waitMs: 1 })).failure, null);
  assert.equal(monitor.failures.reported.length, 2, 'a later episode can report again');
});

test('threshold 0 disables the reminder entirely', async () => {
  const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 0 });
  for (const id of ['z1', 'z2', 'z3', 'z4']) repeatFailure(monitor, clock.clockMs, { callId: id });
  assert.equal(monitor.pendingFailure, null);
  assert.equal(monitor.failures.threshold, 0);
  assert.equal(monitor.snapshot({ at: clock.clockMs }).repeatFailure.reported.length, 0);
});

test('ordinary output with the word error, thinking, long tests and no file change are not failures', async () => {
  const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 3 });
  for (let index = 0; index < 5; index += 1) {
    // A SUCCESSFUL result whose body is full of the word "error".
    monitor.onEvent(toolCall('bash', `ok-${index}`, '{"command":"npm test"}'), clock.clockMs);
    monitor.onEvent(toolResult(`ok-${index}`, 'error: 0, 0 errors, no failures'), clock.clockMs);
  }
  // Reasoning only, and a long-running call with no result at all.
  monitor.onEvent(reasoningDelta('thinking about the error handling'), clock.clockMs);
  monitor.onEvent(toolCall('bash', 'long-1', '{"command":"npm test"}'), clock.clockMs);
  assert.equal(monitor.pendingFailure, null, 'none of these is a structured tool failure');
  assert.equal(monitor.failures.episode, null);
});

test('permission and terminal states outrank a failure reminder', async () => {
  const pendingTask = taskRecord({ permission: { pending: { requestId: 'permission-1', state: 'pending' } } });
  const pending = monitorFixture({ task: pendingTask, repeatFailureThreshold: 3 });
  for (const id of ['p1', 'p2', 'p3']) repeatFailure(pending.monitor, pending.clock.clockMs, { callId: id });
  const permissionOutcome = await pending.monitor.observe({ waitMs: 1 });
  assert.equal(permissionOutcome.reason, OBSERVE_REASONS.permission, 'a decision outranks the reminder');
  assert.equal(permissionOutcome.failure, null);

  const settledTask = taskRecord({ state: 'awaiting-host-review', endedAt: 2_000_000 });
  const settled = monitorFixture({ task: settledTask, repeatFailureThreshold: 3 });
  for (const id of ['t1', 't2', 't3']) repeatFailure(settled.monitor, settled.clock.clockMs, { callId: id });
  const terminal = await settled.monitor.observe({ waitMs: 1 });
  assert.equal(terminal.reason, OBSERVE_REASONS.ready);
  assert.equal(terminal.failure, null, 'a finished run is reported as finished, not as a failure reminder');
});

test('the failure reminder never carries arguments, results, reasoning or error prose', async () => {
  const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 2 });
  for (const id of ['s1', 's2']) {
    repeatFailure(monitor, clock.clockMs, { callId: id, body: 'TOPSECRET-OUTPUT sk-abc123' });
  }
  monitor.onEvent(reasoningDelta('TOPSECRET-REASONING'), clock.clockMs);
  const outcome = await monitor.observe({ waitMs: 1 });
  const serialized = JSON.stringify(outcome.failure);
  for (const secret of ['TOPSECRET', 'sk-abc123', 'npm test', 'SECRET']) {
    assert.equal(serialized.includes(secret), false, `the reminder must not carry ${secret}`);
  }
  // And nothing of it is in the published activity summary either.
  const snapshot = JSON.stringify(monitor.snapshot({ at: clock.clockMs }));
  for (const secret of ['TOPSECRET', 'sk-abc123', 'npm test']) {
    assert.equal(snapshot.includes(secret), false, `the summary must not carry ${secret}`);
  }
  assert.match(outcome.failure.operationDigest, /^[0-9a-f]{16}$/u, 'only a bounded digest of the operation travels');
});

test('repeated failures do not disturb the silence clock, and silence still reports on its own', async () => {
  const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 3 });
  monitor.onEvent(toolCall('bash', 'm1', '{"command":"npm test"}'), clock.clockMs);
  monitor.onEvent(failedToolResult('m1', { code: 'ENOENT' }), clock.clockMs);
  const lastActivity = monitor.activity.lastActivityAt;
  // A failed result IS still activity: the tool ran.
  assert.equal(lastActivity, clock.clockMs);

  // Counted failures alone never manufacture a silence report before the threshold.
  clock.advance(590_000);
  const quiet = await monitor.observe({ waitMs: 1 });
  assert.equal(quiet.reason, OBSERVE_REASONS.heartbeat, '10 minutes of silence is not reached yet');
  assert.equal(quiet.failure, null);
});

test('a cancelled observation releases only the reader and keeps the failure count', async () => {
  const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 3 });
  repeatFailure(monitor, clock.clockMs, { callId: 'k1' });
  const controller = new AbortController();
  const waiting = monitor.observe({ waitMs: 5_000, signal: controller.signal });
  controller.abort();
  const outcome = await waiting;
  assert.equal(outcome.reason, OBSERVE_REASONS.interrupted);
  assert.equal(monitor.failures.episode.count, 1, 'an interrupted observer does not reset the count');
});

test('the same code with a genuinely different reason is a different episode', async () => {
  // The code is only the CLASS of failure. Two ENOENTs for different files are different
  // problems, so counting them together would report a "repeat" that never happened.
  const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 3 });
  repeatFailure(monitor, clock.clockMs, { callId: 'r1', reason: 'no such file: a.txt' });
  repeatFailure(monitor, clock.clockMs, { callId: 'r2', reason: 'no such file: b.txt' });
  repeatFailure(monitor, clock.clockMs, { callId: 'r3', reason: 'no such file: c.txt' });
  assert.equal(monitor.pendingFailure, null, 'three different reasons are not one repeated failure');
  assert.equal(monitor.failures.episode.count, 1);

  // The SAME reason repeated does reach the threshold.
  for (const id of ['r4', 'r5']) repeatFailure(monitor, clock.clockMs, { callId: id, reason: 'no such file: c.txt' });
  assert.equal(monitor.failures.episode.count, 3);
  const outcome = await monitor.observe({ waitMs: 1 });
  assert.equal(outcome.failure.consecutive, 3);
  // The reason itself is never published.
  assert.equal(JSON.stringify(outcome.failure).includes('no such file'), false);
});

test('firstSeenAt is the FIRST failure of the episode, not the one that reached the threshold', async () => {
  const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 3 });
  repeatFailure(monitor, clock.clockMs, { callId: 'f1' });
  const firstAt = clock.clockMs;
  clock.advance(60_000);
  repeatFailure(monitor, clock.clockMs, { callId: 'f2' });
  clock.advance(60_000);
  repeatFailure(monitor, clock.clockMs, { callId: 'f3' });
  const thirdAt = clock.clockMs;

  const outcome = await monitor.observe({ waitMs: 1 });
  assert.equal(outcome.failure.firstSeenAt, firstAt, 'the episode starts at the first failure');
  assert.equal(outcome.failure.lastSeenAt, thirdAt, 'and the last failure is reported separately');
  assert.notEqual(outcome.failure.firstSeenAt, thirdAt);
});

test('a reminder parked before the host observed it is dropped when the episode ends or changes', async () => {
  const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 3 });
  // Reach the threshold, so a reminder is parked but NOT yet delivered.
  for (const id of ['s1', 's2', 's3']) repeatFailure(monitor, clock.clockMs, { callId: id });
  assert.ok(monitor.pendingFailure !== null, 'the reminder is parked');

  // The run then SUCCEEDS before anyone observed: the parked reminder is stale.
  monitor.onEvent(toolCall('bash', 's4', '{"command":"npm test"}'), clock.clockMs);
  monitor.onEvent(toolResult('s4'), clock.clockMs);
  assert.equal(monitor.pendingFailure, null, 'a success clears the parked reminder');
  const afterSuccess = await monitor.observe({ waitMs: 1 });
  assert.equal(afterSuccess.failure, null, 'and a stale reminder is never delivered');
  // The historical evidence survives: it happened, it is just not news.
  assert.equal(monitor.failures.reported.length, 1);
});

test('a parked reminder is dropped when the run switches to a different failure', async () => {
  const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 3 });
  for (const id of ['w1', 'w2', 'w3']) repeatFailure(monitor, clock.clockMs, { callId: id });
  assert.ok(monitor.pendingFailure !== null);

  // A different operation now fails once: the counted episode changed.
  repeatFailure(monitor, clock.clockMs, { callId: 'w4', args: '{"command":"npm run build"}' });
  assert.equal(monitor.pendingFailure, null, 'the parked reminder no longer describes the episode');
  const outcome = await monitor.observe({ waitMs: 1 });
  assert.equal(outcome.failure, null);
  assert.equal(monitor.failures.reported.length, 1, 'the reported history is kept');
});

test('a reminder parked in the same millisecond as a new episode is still dropped', async () => {
  // The exact collision the host reproduced: the clock does NOT advance, so the old
  // `firstSeenAt` comparison saw the same value for both episodes and the stale reminder
  // survived `claimFailureReport()`. Identity is now the episode's own sequence.
  const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 3 });
  const at = clock.clockMs;

  // Episode A reaches the threshold at this instant and parks a reminder.
  for (const id of ['c1', 'c2', 'c3']) repeatFailure(monitor, at, { callId: id, reason: 'reason A' });
  assert.ok(monitor.pendingFailure !== null, 'episode A parked a reminder');
  assert.equal(monitor.pendingFailure.firstSeenAt, at);
  const parkedA = monitor.pendingFailure;
  assert.equal(monitor.failures.isCurrent(parkedA), true, 'while A is the live episode it is current');

  // Episode B starts at the SAME timestamp: same tool, same operation, same code, but a
  // different reason. Under the timestamp comparison its `firstSeenAt` would equal A's.
  repeatFailure(monitor, at, { callId: 'c4', reason: 'reason B' });
  assert.notEqual(monitor.failures.episode.sequence, undefined);
  assert.equal(monitor.failures.episode.firstSeenAt, at, 'the timestamps really do collide');

  // The parked A reminder must no longer be considered current.
  assert.equal(monitor.failures.isCurrent(parkedA), false, 'the sequence tells the two apart');
  assert.equal(monitor.pendingFailure, null, 'the switch cleared it outright');
  assert.equal(monitor.claimFailureReport(), null, 'and claiming it returns nothing stale');

  // Two more B failures complete B's threshold: only B is reported, once.
  for (const id of ['c5', 'c6']) repeatFailure(monitor, at, { callId: id, reason: 'reason B' });
  const outcome = await monitor.observe({ waitMs: 1 });
  assert.equal(outcome.failure.consecutive, 3);
  // The internal episode sequence never reaches a published diagnostic.
  assert.equal('episodeSequence' in outcome.failure, false);
  assert.equal(JSON.stringify(monitor.snapshot({ at })).includes('episodeSequence'), false);
  assert.equal(monitor.failures.reported.length, 2, 'both episodes are kept as history');
});

test('claimFailureReport returns null once the episode has changed, even if still parked', async () => {
  // Defends the guard itself, independent of the eager clearing in `observeFailure`:
  // a reminder from a previous episode must never be handed out as current news.
  const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 2 });
  for (const id of ['g1', 'g2']) repeatFailure(monitor, clock.clockMs, { callId: id, reason: 'A' });
  assert.ok(monitor.pendingFailure !== null, 'a reminder is parked');

  // Simulate a different failure becoming the live episode while the old one is still
  // parked: only the episode identity changes, nothing else about the object does.
  monitor.failures.episode.sequence = monitor.failures.nextEpisode();
  assert.equal(monitor.claimFailureReport(), null, 'a stale episode is never delivered');
  // The parked object stays where it is (claiming is no longer a take-once consume:
  // delivery is gated by `isCurrent` on every observation), but it can never reach a
  // caller while its episode is stale, and a genuinely new episode replaces it.
  assert.ok(monitor.pendingFailure !== null, 'the stale object is parked harmlessly');
  repeatFailure(monitor, clock.clockMs, { callId: 'g3', reason: 'B' });
  repeatFailure(monitor, clock.clockMs, { callId: 'g4', reason: 'B' });
  const fresh = await monitor.observe({ waitMs: 1 });
  assert.ok(fresh.failure, 'the new episode is delivered');
  assert.notEqual(fresh.failure.eventId, undefined);
});

test('ackFailureReport is bound to the exact event and is idempotent', async () => {
  const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 2 });
  for (const id of ['b1', 'b2']) repeatFailure(monitor, clock.clockMs, { callId: id, reason: 'A' });
  const delivered = await monitor.observe({ waitMs: 1 });
  const eventId = delivered.failure.eventId;

  // A wrong id, an empty id, a non-string: none of them clears the reminder.
  for (const bad of ['deadbeef'.repeat(2), '', null, undefined, 42]) {
    const refused = monitor.ackFailureReport(bad);
    assert.equal(refused.acknowledged, false, `an ack of ${JSON.stringify(bad)} must fail`);
    assert.equal(monitor.pendingFailure !== null, true, 'the reminder survives a wrong ack');
  }
  // And the next observation still carries the SAME notification.
  const redelivered = await monitor.observe({ waitMs: 1 });
  assert.equal(redelivered.failure.eventId, eventId);

  // The right ack clears it; a repeat is an idempotent success.
  const ack = monitor.ackFailureReport(eventId);
  assert.equal(ack.acknowledged, true);
  assert.equal(ack.eventId, eventId);
  assert.equal(monitor.pendingFailure, null);
  const repeat = monitor.ackFailureReport(eventId);
  assert.equal(repeat.acknowledged, true, 'a repeated ack of a cleared event is an idempotent success');
  assert.equal((await monitor.observe({ waitMs: 1 })).failure, null);
});

test('an ack that arrives after the episode was superseded is honest but inert', async () => {
  const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 2 });
  for (const id of ['y1', 'y2']) repeatFailure(monitor, clock.clockMs, { callId: id, reason: 'A' });
  const delivered = await monitor.observe({ waitMs: 1 });
  const eventId = delivered.failure.eventId;
  // The episode then switches to a different failure: the parked reminder is gone.
  repeatFailure(monitor, clock.clockMs, { callId: 'y3', reason: 'B' });
  assert.equal(monitor.pendingFailure, null);
  const ack = monitor.ackFailureReport(eventId);
  assert.equal(ack.acknowledged, false, 'a stale event cannot be acknowledged as pending');
  assert.equal(ack.reason, 'unknown-event');
  // The NEW episode is unaffected and still deliverable.
  repeatFailure(monitor, clock.clockMs, { callId: 'y4', reason: 'B' });
  const next = await monitor.observe({ waitMs: 1 });
  assert.ok(next.failure, 'a superseded ack never silences the new notification');
  assert.notEqual(next.failure.eventId, eventId);
});

test('an arbitrary error code or name is never published, even when it is identifier-shaped', async () => {
  // The previous rule replaced punctuation with `_`, which is NOT redaction: these values
  // are already valid identifiers, so they would have travelled through untouched. Only an
  // allowlisted code may be published; everything recognizable-as-anything-else becomes
  // `TOOL_ERROR`.
  for (const secretCode of [
    'ENOENT /home/alice/.ssh/id_rsa sk-live-abc123',
    // Host-reported case: purely identifier-shaped, no punctuation to "clean".
    'sk-TASKBRIDGE-MOCK-SECRET-987654321',
    'alice-token-abcdef123456',
  ]) {
    const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 2 });
    for (const id of ['x1', 'x2']) {
      repeatFailure(monitor, clock.clockMs, { callId: id, code: secretCode, reason: 'boom' });
    }
    const outcome = await monitor.observe({ waitMs: 1 });
    const serialized = JSON.stringify(outcome.failure);
    assert.equal(outcome.failure.failureCode, 'TOOL_ERROR', `a non-allowlisted code must be generic: ${secretCode}`);
    for (const fragment of ['id_rsa', 'sk-live-abc123', 'sk-TASKBRIDGE', 'SECRET', '987654321',
      '/home/alice', 'alice-token', 'abcdef123456']) {
      assert.equal(serialized.includes(fragment), false, `the reminder must not carry ${fragment}`);
    }
    // And the same value is absent from the published activity summary too.
    const snapshot = JSON.stringify(monitor.snapshot({ at: clock.clockMs }));
    for (const fragment of ['sk-TASKBRIDGE', 'id_rsa', 'sk-live-abc123']) {
      assert.equal(snapshot.includes(fragment), false, `the summary must not carry ${fragment}`);
    }
    // It was still USED as identity input, so episodes remain distinguishable.
    assert.match(outcome.failure.operationDigest, /^[0-9a-f]{16}$/u);
  }
});

test('an allowlisted code is published as itself, and unknown codes still separate episodes', async () => {
  // A recognized code is genuinely useful to an operator and carries no content of its own.
  const known = monitorFixture({ repeatFailureThreshold: 2 });
  for (const id of ['k1', 'k2']) repeatFailure(known.monitor, known.clock.clockMs, { callId: id, code: 'ENOENT' });
  const published = await known.monitor.observe({ waitMs: 1 });
  assert.equal(published.failure.failureCode, 'ENOENT');

  // Two DIFFERENT unknown codes both publish TOOL_ERROR, but they are not one episode:
  // the full identity is hashed, so the count does not merge across them.
  const split = monitorFixture({ repeatFailureThreshold: 2 });
  repeatFailure(split.monitor, split.clock.clockMs, { callId: 'u1', code: 'sk-aaaa-1111' });
  repeatFailure(split.monitor, split.clock.clockMs, { callId: 'u2', code: 'sk-bbbb-2222' });
  assert.equal(split.monitor.pendingFailure, null, 'different real codes are different episodes');
  assert.equal(split.monitor.failures.episode.count, 1);
});

test('an isError result with no structured error block still separates by content digest only', async () => {
  // The native contract allows `isError: true` with no `error` block. The identity then
  // comes from a digest of the result content, which is never retained or published.
  const { monitor, clock } = monitorFixture({ repeatFailureThreshold: 2 });
  const body = 'Command failed: SECRET-CONTENT-xyz';
  for (const id of ['n1', 'n2']) {
    monitor.onEvent(toolCall('bash', id, '{"command":"npm test"}'), clock.clockMs);
    monitor.onEvent(failedToolResult(id, { error: null, body }), clock.clockMs);
  }
  const outcome = await monitor.observe({ waitMs: 1 });
  assert.equal(outcome.failure.failureCode, 'TOOL_ERROR');
  assert.equal(outcome.failure.consecutive, 2);
  assert.equal(JSON.stringify(outcome.failure).includes('SECRET-CONTENT'), false);
});
