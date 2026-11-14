// The census must count ordinary questions and their answers WITHOUT folding them into the
// permission numbers.
//
// The defect this pins: a question answer was recorded under the permission decision kind, so
// it landed in the `refused` bucket (its verb is neither allow-once nor reject) and reported a
// refusal that never happened. A question answer authorizes nothing, so it needs its own
// counters and its own reason in the wait vocabulary.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  METRIC_WAIT_REASONS,
  QUESTION_ANSWER_KIND,
  createCallMetrics,
} from '../src/mcp/metrics.js';

/** A census over a controlled clock. */
function census() {
  return createCallMetrics({ now: () => 1_000, limit: 8 });
}

test('`question` is a wait reason the census knows, so a wait returning one is counted', () => {
  assert.ok(METRIC_WAIT_REASONS.includes('question'), 'the closed vocabulary includes question');
  const metrics = census();
  metrics.recordWait({ taskId: 't1', reason: 'question', durationMs: 10, observationRequests: 1, waitReturns: 1 });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.waits.reasons.question, 1, 'the question wait is counted under its own reason');
  assert.equal(snapshot.waits.count, 1);
});

test('a question answer is counted on its OWN axis and never as a permission refusal', () => {
  const metrics = census();
  metrics.recordDecision({
    receiptId: 'r1',
    taskId: 't1',
    requestId: 'question-t1-1',
    decision: QUESTION_ANSWER_KIND,
    fingerprint: null,
    applied: true,
    confirmation: 'confirmed',
  });
  metrics.recordDecision({
    receiptId: 'r2',
    taskId: 't1',
    requestId: 'question-t1-2',
    decision: QUESTION_ANSWER_KIND,
    fingerprint: null,
    applied: null,
    confirmation: 'unknown',
  });
  const snapshot = metrics.snapshot();
  // Its own counters.
  assert.equal(snapshot.questionAnswers.count, 2);
  assert.equal(snapshot.questionAnswers.applied, 1);
  assert.equal(snapshot.questionAnswers.unknown, 1);
  assert.equal(snapshot.questionAnswers.refused, 0, 'a question answer is never a refusal');
  // …and the permission buckets are untouched.
  assert.equal(snapshot.decisions.count, 0, 'no permission decision was made');
  assert.equal(snapshot.decisions.refused, 0);
  assert.equal(snapshot.decisions.applied, 0);
});

test('a real permission decision still lands in the permission buckets', () => {
  const metrics = census();
  metrics.recordDecision({
    receiptId: 'r1',
    taskId: 't1',
    requestId: 'permission-t1-1',
    decision: 'reject',
    fingerprint: 'sha256:abc',
    applied: true,
    confirmation: 'confirmed',
  });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.decisions.count, 1);
  assert.equal(snapshot.decisions.rejected, 1);
  assert.equal(snapshot.questionAnswers.count, 0, 'a permission decision is not a question answer');
});

test('the snapshot DEFINES its question counters, so no reader mistakes them for grants', () => {
  const snapshot = census().snapshot();
  assert.match(snapshot.definitions.questionAnswers, /authorize NOTHING/u);
});
