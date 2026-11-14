// The two predicates the post-decision continuation needs — and nothing else.
//
// `delegate_permission_decide({ waitAfterDecision: true })` answers in the SAME shape a
// `delegate_wait` answers in, because the commander's next decision is the same decision
// either way. That means the continuation must be THE wait loop (`./wait.js`): the same
// 25-second internal observation, the same default deadline, the same heartbeat handling,
// the same `interrupted` classification and the same bounded deadline semantics. This
// module therefore contains no loop, no timeout and no reason vocabulary of its own; it
// supplies only the two facts the shared loop cannot know:
//
//   1. **Rollover.** After a decision the engine may still publish the settled request in
//      `task.permission.pending` until the paused native call actually resumes (the
//      bridge's `onSettled` fires when the call continues, not when the decision is made).
//      A loop that answered that would present the commander's own decision back as a new
//      question. {@link decidedRequestMatcher} is the predicate the shared loop uses to
//      keep waiting, and it matches on the FULL identity — `requestId` AND `fingerprint` —
//      so a new request id, or the same id with a changed operation, is never inherited.
//
//   2. **Receipt evidence.** {@link decisionReceipt} reads the harness's answer to the
//      decision and states exactly what can be proven about it, including the case where
//      the transport failed and nobody can know whether it was applied.

/**
 * The pending operation a wait-shaped answer carries, if any.
 * @param {object | null | undefined} observation - an observation.
 * @returns {object | null} the pending operation.
 */
export function pendingOperationOf(observation) {
  const block = observation?.permission;
  if (block === null || typeof block !== 'object') return null;
  const operation = block.pending !== undefined ? block.pending : block;
  if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) return null;
  return operation;
}

/**
 * Build the predicate that decides whether an observation describes the request this call
 * already decided.
 *
 * The match requires BOTH the request id and the fingerprint. That is the whole rule:
 *
 *   * same id, same fingerprint → the settled request still in its slot → keep waiting;
 *   * a different request id → a NEW question → answered immediately;
 *   * same id, different fingerprint → the operation changed → a NEW question, because a
 *     decision is bound to one exact operation and inheriting it would grant an operation
 *     the commander never reviewed.
 *
 * Cost asymmetry: wrongly treating a settled request as new costs one host turn; wrongly
 * treating a new request as settled would leave a worker paused with nothing reported. So
 * every field is required to match, and nothing is assumed.
 * @param {{ requestId?: string | null, fingerprint?: string | null }} receipt - the decision.
 * @returns {(observation: object) => boolean} predicate for the shared wait loop.
 */
export function decidedRequestMatcher(receipt) {
  const requestId = typeof receipt?.requestId === 'string' && receipt.requestId !== '' ? receipt.requestId : null;
  const fingerprint = typeof receipt?.fingerprint === 'string' && receipt.fingerprint !== ''
    ? receipt.fingerprint
    : null;
  if (requestId === null || fingerprint === null) {
    // Without BOTH halves of the identity nothing can be proven to be the decided request,
    // so nothing is skipped: a request already settled is refused by the engine as
    // `PERMISSION_REQUEST_NOT_PENDING`, which is a refusal the host can act on.
    return () => false;
  }
  return (observation) => {
    const operation = pendingOperationOf(observation);
    if (operation === null) return false;
    return operation.requestId === requestId && operation.fingerprint === fingerprint;
  };
}

/**
 * The ONE settled state that means "this request was decided".
 *
 * `expired`, `cancelled` and `unavailable` are settled records too, but none of them is a
 * decision this call applied — an `expired` request carrying a stale `allowed-once` outcome
 * is exactly the shape that must never read as confirmed.
 */
const CONFIRMED_STATE = 'decided';

/** The closed native outcomes a settled allow/reject record can carry. */
const SETTLED_OUTCOMES = Object.freeze(['allowed-once', 'rejected', 'cancelled', 'unavailable']);

/**
 * The verification checks an `allowed-once` must report as TRUE to confirm the allow.
 *
 * These are the four claims the harness makes when it grants one call: the caller quoted the
 * fingerprint, the arguments were complete, the operation was re-read from the Session log,
 * and the turn was still open. A record that reports any of them false is not evidence for an
 * allow, whatever its `outcome` says. A `reject` needs none of them.
 */
const VERIFIED_REQUIRED = Object.freeze(['fingerprintQuoted', 'argumentsComplete', 'callReread', 'turnOpen']);

const asString = (value) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * What can honestly be said about one decision, from the harness's own answer.
 *
 * The ONLY thing that makes a decision `applied` is a permission answer whose own fields
 * confirm it, and the check is deliberately strict because a false `applied: true` is the
 * worst outcome this tool can produce: it tells a commander an authorization is in force
 * when it is not (or one operation when another was settled). The real permission route
 * answers:
 *
 * ```js
 * { ok: true,
 *   task: { taskId, ... },
 *   permission: { taskId, requestId, fingerprint, state: 'decided',
 *                 outcome: 'allowed-once' | 'rejected', verified?, grant?, decision? } }
 * ```
 *
 * `decision` is sometimes `null` in the real bridge, so it is NOT required; the settled
 * `outcome` is. `verified`/`grant` exist only for an `allowed-once`, so a `reject` is never
 * required to have them.
 *
 * Two outcomes, and the difference between them is the point:
 *
 *   * **applied** — the answer is `ok: true`, names the SAME task (both task ids, when both
 *     appear, must agree), the SAME request and the SAME operation fingerprint the decision
 *     was bound to, is in state `decided`, and its `outcome` matches the decision
 *     (`allowed-once` for allow-once, `rejected` for reject). An allow additionally needs
 *     every {@link VERIFIED_REQUIRED} check to be true. Only then is the decision in force.
 *   * **unknown** — the call failed before an answer existed (transport, timeout, malformed
 *     body), or the answer is `ok: false`, or it lacks the evidence above, or its identity
 *     CONTRADICTS the request that was decided. Nobody can say whether the decision applied,
 *     so it is never claimed, never continued and never resent automatically.
 *   * **refused** — the harness's own refusal code: the decision was definitely not applied.
 *
 * A QUOTED fingerprint must be matched by evidence. The caller's value is never silently
 * replaced by a conflicting backend one, and an answer that omits it cannot confirm that
 * operation. A `reject` that quoted no fingerprint is not required to produce one.
 * @param {object} options - `taskId`, `requestId`, `decision`, `fingerprint` (the quoted one,
 *   or null), `answer` (the harness answer, or null), `error` (the thrown failure, or null).
 * @returns {{ applied: boolean | null, confirmation: 'applied' | 'unknown' | 'refused',
 *   taskId: string | null, requestId: string | null, decision: 'allow-once' | 'reject' | null,
 *   fingerprint: string | null, outcome?: string, verified?: object, grant?: object,
 *   decidedAt?: number, reason?: string, error?: object, evidence?: object }} the receipt fields.
 */
export function decisionReceipt(options) {
  const error = options.error ?? null;
  const answer = options.answer ?? null;
  const settled = answer?.permission ?? null;
  const answerTask = answer?.task ?? null;
  const requestedTaskId = asString(options.taskId);
  const requestedRequestId = asString(options.requestId);
  const quotedFingerprint = asString(options.fingerprint);
  const decision = options.decision === 'allow-once' || options.decision === 'reject'
    ? options.decision
    : null;

  /** The identity the receipt may safely publish: only values the caller itself supplied. */
  const identity = {
    taskId: requestedTaskId,
    requestId: requestedRequestId,
    decision,
    fingerprint: quotedFingerprint,
  };

  /** Build an UNCONFIRMED receipt that keeps the caller's own identity and says why. */
  const unconfirmed = (reason, extra = {}) => ({
    ...identity,
    // Never `false`: "not applied" would be a fact nobody established.
    applied: null,
    confirmation: 'unknown',
    reason,
    ...extra,
  });

  if (error !== null) {
    const code = typeof error.code === 'string' ? error.code : 'MCP_CALL_FAILED';
    // A refusal the harness produced is a fact about the decision; every other failure
    // happened before an answer existed, so the outcome is genuinely unknown.
    if (options.refusedByHarness === true) {
      return {
        ...identity,
        applied: false,
        confirmation: 'refused',
        error: { code, message: 'the harness refused this decision' },
      };
    }
    return unconfirmed(
      'the decision call did not produce a harness answer, so whether it was applied is unknown; '
      + 'read the task\'s real state with delegate_result before deciding whether to send it again',
      { error: { code, message: 'the decision could not be confirmed' } },
    );
  }

  // ---- What the answer itself proves -------------------------------------------------
  if (answer === null || typeof answer !== 'object' || answer.ok !== true) {
    return unconfirmed('the harness answer was not ok, so the decision cannot be confirmed as applied');
  }
  if (settled === null || typeof settled !== 'object' || Array.isArray(settled)) {
    return unconfirmed('the harness answer carried no settled permission record to confirm the decision');
  }
  const settledTaskId = asString(settled.taskId);
  const outerTaskId = asString(answerTask?.taskId);
  const answerRequestId = asString(settled.requestId);
  const answerFingerprint = asString(settled.fingerprint);
  const answerState = asString(settled.state);
  const answerOutcome = asString(settled.outcome);
  if (answerRequestId === null || answerState === null || answerOutcome === null) {
    return unconfirmed('the harness answer did not carry the identity and outcome needed to confirm the decision', {
      evidence: { taskId: settledTaskId ?? outerTaskId, requestId: answerRequestId, state: answerState, outcome: answerOutcome },
    });
  }
  // Identity must MATCH what was decided. A different task, request or operation is a
  // CONTRADICTION: the answer describes something this call did not decide.
  //
  // BOTH task ids are checked when both appear, and they must ALSO agree with each other. A
  // matching outer `task.taskId` cannot vouch for a settled record that names another task:
  // the settled record is the thing being confirmed, so an internal disagreement means the
  // answer is not one coherent settlement of this task.
  if (settledTaskId !== null && outerTaskId !== null && settledTaskId !== outerTaskId) {
    return unconfirmed('the harness answer contradicted itself: its task and its settled record name different tasks', {
      evidence: { answeredTaskId: settledTaskId, surroundingTaskId: outerTaskId },
    });
  }
  const answerTaskId = settledTaskId ?? outerTaskId;
  if (answerTaskId === null) {
    return unconfirmed('the harness answer did not name the task it settled', {
      evidence: { taskId: null },
    });
  }
  if (requestedTaskId !== null && answerTaskId !== requestedTaskId) {
    return unconfirmed('the harness confirmed a DIFFERENT task than the one this decision named', {
      evidence: { answeredTaskId: answerTaskId },
    });
  }
  if (requestedRequestId !== null && answerRequestId !== requestedRequestId) {
    return unconfirmed('the harness confirmed a DIFFERENT request than the one this decision named', {
      evidence: { answeredRequestId: answerRequestId },
    });
  }
  // The operation is part of the identity. A QUOTED fingerprint must be matched by evidence:
  // an answer that omits it cannot confirm that THIS operation was settled, and a conflicting
  // backend value is never allowed to replace the quoted one.
  if (quotedFingerprint !== null) {
    if (answerFingerprint === null) {
      return unconfirmed('the harness settled without reporting the operation fingerprint this decision quoted', {
        evidence: { answeredFingerprint: null },
      });
    }
    if (answerFingerprint !== quotedFingerprint) {
      return unconfirmed('the harness settled a DIFFERENT operation than the fingerprint this decision quoted', {
        evidence: { answeredFingerprint: answerFingerprint },
      });
    }
  }
  // Only `decided` is a settled DECISION. `expired`, `cancelled` and `unavailable` are also
  // settled records, but none of them means "this decision was applied".
  if (answerState !== CONFIRMED_STATE) {
    return unconfirmed(`the harness reported state ${JSON.stringify(answerState)}, which is not a decided request`, {
      evidence: { state: answerState },
    });
  }
  if (!SETTLED_OUTCOMES.includes(answerOutcome)) {
    return unconfirmed(`the harness reported outcome ${JSON.stringify(answerOutcome)}, which is not a settled decision`, {
      evidence: { outcome: answerOutcome },
    });
  }
  // The outcome must be the one this decision asked for. `allowed-once` is the only grant,
  // and a reject must read `rejected`; anything else is not this decision's confirmation.
  const expectedOutcome = decision === 'allow-once' ? 'allowed-once' : decision === 'reject' ? 'rejected' : null;
  if (expectedOutcome === null) {
    return unconfirmed('the decision argument was not a recognized decision');
  }
  if (answerOutcome !== expectedOutcome) {
    return unconfirmed(
      `the harness settled ${JSON.stringify(answerOutcome)}, not the ${JSON.stringify(expectedOutcome)} this decision asked for`,
      { evidence: { outcome: answerOutcome } },
    );
  }
  // An allow must be backed by the checks it claims, and every required one must be TRUE: a
  // record whose own verification says the fingerprint was not quoted, the arguments were not
  // complete, the call was not re-read or the turn was not open is not evidence for an allow.
  // A reject needs none of them.
  if (decision === 'allow-once') {
    const verified = settled.verified;
    if (verified === null || typeof verified !== 'object' || Array.isArray(verified)) {
      return unconfirmed('an allowed-once was reported without the verification evidence an allow requires');
    }
    const failed = VERIFIED_REQUIRED.filter((key) => verified[key] !== true);
    if (failed.length > 0) {
      return unconfirmed(
        `an allowed-once reported verification that does not hold (${failed.join(', ')}), so it cannot confirm the allow`,
        { evidence: { unverified: failed } },
      );
    }
  }
  return {
    taskId: answerTaskId,
    requestId: answerRequestId,
    decision,
    // The confirmed operation. It equals the quoted fingerprint here — a mismatch returned
    // above — so publishing the harness's own value is a restatement, not a substitution.
    fingerprint: answerFingerprint ?? quotedFingerprint,
    applied: true,
    confirmation: 'applied',
    outcome: answerOutcome,
    ...(settled.verified !== undefined ? { verified: settled.verified } : {}),
    ...(settled.decidedAt !== undefined ? { decidedAt: settled.decidedAt } : {}),
    ...(settled.grant !== undefined ? { grant: settled.grant } : {}),
    // Whether the rejection reason reached the worker, stated as the SHORT fact only. The
    // note text is the worker's own message and is stored in history; repeating it here
    // would multiply the receipt for no gain, so only delivery and its reason travel.
    ...(settled.rejectionFeedback !== undefined && settled.rejectionFeedback !== null
      ? {
        rejectionFeedback: {
          delivered: settled.rejectionFeedback.delivered === true,
          reason: typeof settled.rejectionFeedback.reason === 'string'
            ? settled.rejectionFeedback.reason
            : null,
        },
      }
      : {}),
  };
}
