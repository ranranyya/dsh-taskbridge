// The monitor must report a question AS SOON AS it appears.
//
// The acceptance defect was timing, not wiring: once an observation was already inside its
// bounded wait, a question raised afterwards was not noticed until the wait expired, and the
// engine only learned about it on its SECOND check — up to 25 seconds later.
//
// These tests drive the REAL `TaskMonitor.observe` loop with a controlled clock and a real
// sleep seam, and they raise the question AFTER the wait has started, so a monitor that only
// looks at `permission` cannot pass.

import test from 'node:test';
import assert from 'node:assert/strict';

import { OBSERVE_REASONS, TaskMonitor } from '../src/jobs/activity.js';

/**
 * A monitor over a live task, with a clock that only moves when something sleeps.
 * @param {object} [options] - `selfCheckSeconds`, `attentionSeconds`.
 * @returns {{ monitor: object, task: object, advance: Function }} fixture.
 */
function monitorFixture(options = {}) {
  let now = 1_000;
  const sleepers = [];
  const task = {
    taskId: 'task-m',
    state: 'running',
    phase: 'execute',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    permission: { pending: null },
    question: { pending: null },
    effective: {
      monitoring: {
        selfCheckSeconds: options.selfCheckSeconds ?? 300,
        attentionSeconds: options.attentionSeconds ?? 600,
        repeatFailureThreshold: 3,
      },
    },
  };
  const monitor = new TaskMonitor(task, {
    now: () => now,
    selfCheckSeconds: task.effective.monitoring.selfCheckSeconds,
    attentionSeconds: task.effective.monitoring.attentionSeconds,
    repeatFailureThreshold: 3,
    waitSliceMs: options.waitSliceMs ?? 1_000,
    // A real sleep seam: it parks the caller and resolves only when the test advances
    // the clock, exactly like a timer that fires.
    wait: (ms) => new Promise((resolvePromise) => {
      sleepers.push({ ms, resolvePromise, dueAt: now + ms });
    }),
  });
  /**
   * Advance the clock, releasing every sleeper whose slice is due.
   * @param {number} ms - how far to advance.
   */
  const advance = (ms) => {
    now += ms;
    for (let index = sleepers.length - 1; index >= 0; index -= 1) {
      if (sleepers[index].dueAt <= now) {
        const [sleeper] = sleepers.splice(index, 1);
        sleeper.resolvePromise();
      }
    }
  };
  return { monitor, task, advance, clock: () => now };
}

/** Let every already-resolved promise settle before the next assertion. */
const tick = () => new Promise((resolvePromise) => { setImmediate(resolvePromise); });

test('a question raised AFTER the wait began returns at once, not when the wait expires', async () => {
  const f = monitorFixture();
  const started = f.monitor.observe({ waitMs: 25_000 });
  // Let the loop enter its first slice. Nothing is pending yet.
  await tick();
  assert.equal(f.monitor.outcomeReason?.(null) ?? null, null);

  // Raise the question while the observation is asleep.
  f.task.question.pending = { requestId: 'question-task-m-1', questions: [{ id: 'q', question: 'Which?' }] };
  const before = f.clock();
  // One slice covers the 1 000 ms poll: advancing by that must be enough.
  f.advance(1_000);
  const outcome = await started;
  assert.equal(outcome.reason, OBSERVE_REASONS.question, 'the monitor reports the question itself');
  assert.ok(f.clock() - before <= 1_000, `it reported within one slice, not after the wait (${f.clock() - before} ms)`);
  assert.ok(outcome.waitedMs < 25_000, 'the observation did NOT run to its full bound');
});

test('the question outranks the silence thresholds, and a self-check cannot turn it into attention', async () => {
  // A five-minute self-check and a ten-minute attention with a question already pending:
  // the question must win at the very first slice, before either could fire.
  const f = monitorFixture({ selfCheckSeconds: 30, attentionSeconds: 31 });
  f.task.question.pending = { requestId: 'q-1', questions: [{ id: 'q', question: 'Which?' }] };
  const started = f.monitor.observe({ waitMs: 25_000 });
  await tick();
  const outcome = await started;
  assert.equal(outcome.reason, OBSERVE_REASONS.question);
  assert.notEqual(outcome.reason, OBSERVE_REASONS.attention, 'silence never overrides a pending question');
});

test('a permission request still wins over a question, because it is the one that can grant', async () => {
  const f = monitorFixture();
  f.task.permission.pending = { requestId: 'permission-m-1' };
  f.task.question.pending = { requestId: 'question-m-1' };
  const outcome = await f.monitor.observe({ waitMs: 1_000 });
  assert.equal(outcome.reason, OBSERVE_REASONS.permission);
});

test('a task with NO question keeps the ordinary silent wait', async () => {
  const f = monitorFixture();
  const started = f.monitor.observe({ waitMs: 3_000 });
  await tick();
  // Ten slices of real waiting, then the bound is reached.
  for (let index = 0; index < 3; index += 1) f.advance(1_000);
  const outcome = await started;
  assert.equal(outcome.reason, OBSERVE_REASONS.heartbeat, 'nothing is pending, so nothing is reported');
  f.monitor.dispose();
});

test('a terminal state still outranks a pending question', async () => {
  const f = monitorFixture();
  f.task.question.pending = { requestId: 'q-1' };
  f.task.state = 'awaiting-host-review';
  const outcome = await f.monitor.observe({ waitMs: 1_000 });
  assert.equal(outcome.reason, OBSERVE_REASONS.ready);
  f.monitor.dispose();
});
