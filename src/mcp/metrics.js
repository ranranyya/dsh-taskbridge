// Minimal, honest accounting for the MCP surface.
//
// What this module is, in one sentence: a bounded census of what this MCP PROCESS did —
// which tools were exercised, how many waits it ran and why they returned, how many
// per-call permission decisions were applied, and how many bytes of tool text it handed
// back — with each post-decision wait tied to the decision that led into it.
//
// What it deliberately is NOT:
//
//   * **Not a wake-up counter.** `delegate_wait` is one MCP call the host chose to make; a
//     count of calls, observations or returns says how much the PROGRAM waited, never how
//     many times a model was woken. The host's own model turns, token usage and cost are
//     not visible to this process at all, so they are reported as `not-integrated` rather
//     than as `0` — a zero would be a measurement this code never took.
//   * **Not a content store.** Every counter is a number, a duration, a closed-vocabulary
//     reason or a byte size. No tool arguments, no reasoning text, no answer body and no
//     credential is retained, so no projection of this module can leak one.
//   * **Not persistent.** The census lives for the life of the MCP process and is reported
//     through one read-only call and the exit diagnostics line.
//
// Two counting rules are load-bearing:
//
//   1. **Totals are cumulative; the sample lists are bounded.** The `recent*` arrays are
//      the last N entries so a caller can audit individual waits. Every total is summed at
//      record time, so a long session's numbers never shrink when the sample rotates.
//   2. **Byte counts are of the FINAL tool text.** They are measured by the server on the
//      bounded, redacted `content[0].text` with `Buffer.byteLength(..., 'utf8')`, after
//      `boundedJson` has decided what the host receives — never `String#length`, which
//      counts UTF-16 units and would misreport Chinese text and emoji, and never a size the
//      answer carries about itself.

/** The closed vocabulary of what one wait returned, mirrored from the wait loop. */
export const METRIC_WAIT_REASONS = Object.freeze([
  'attention', 'permission', 'question', 'ready', 'failed', 'cancelled', 'interrupted', 'wait-limit', 'refused',
]);

/** Outcomes of one decision, as the receipt states them. */
export const METRIC_DECISION_STATES = Object.freeze(['applied', 'unknown', 'refused']);

/**
 * The decision kind that records an ordinary QUESTION answer.
 *
 * Kept apart from `allow-once`/`reject` because answering a question authorizes nothing:
 * counting it in the permission buckets would report a refusal that never happened, or an
 * authorization that does not exist.
 */
export const QUESTION_ANSWER_KIND = 'question-answer';

/**
 * Facts this process cannot observe, and therefore must not report as zero.
 *
 * The host model's own turns, token usage and cost happen in the host process. This one
 * only ever sees the tool calls the host decided to make.
 */
export const NOT_INTEGRATED = 'not-integrated';

/**
 * Create the census for one MCP server instance.
 *
 * Every entry point is defensive: this module is fed by the server's hot paths, and a
 * malformed value must degrade one counter rather than throw inside an answer path.
 * @param {object} [options] - `now` (clock seam), `limit` (how many samples to keep).
 * @returns {object} census with `recordToolCall`, `recordReturn`, `recordWait`,
 *   `recordDecision`, `snapshot`, `diagnosticsLine`.
 */
export function createCallMetrics(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 64;

  /** Cumulative tool calls by name. */
  const toolCalls = new Map();
  /** Cumulative wait returns by reason. */
  const waitReturns = new Map();
  /** Cumulative decision outcomes by state, and by decision kind for the applied ones. */
  const decisionStates = new Map();
  const appliedDecisions = new Map();
  /** Question answers, kept out of the permission buckets. */
  const questionAnswerStates = new Map();

  /** Cumulative totals — summed at record time, never derived from the samples. */
  let returns = 0;
  let returnBytes = 0;
  let unmeasuredReturns = 0;
  let waits = 0;
  let waitedTotalMs = 0;
  let waitObservations = 0;
  let decisions = 0;
  let waitsAfterDecisions = 0;
  let waitQuestionsAnswered = 0;
  let questionAnswers = 0;

  /** Bounded audit samples, newest last. */
  const recentWaits = [];
  const recentDecisions = [];

  /**
   * Count one value in a bounded map.
   * @param {Map<string, number>} map - counter map.
   * @param {string} key - closed-vocabulary key.
   * @returns {void}
   */
  const bump = (map, key) => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  /**
   * A non-negative integer, or 0.
   * @param {unknown} value - candidate.
   * @returns {number} bounded count.
   */
  const count = (value) => (Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);

  return {
    /**
     * Count one tool invocation, whatever its outcome.
     * @param {string} tool - tool name.
     * @returns {void}
     */
    recordToolCall(tool) {
      if (typeof tool === 'string' && tool !== '') bump(toolCalls, tool);
    },

    /**
     * Count one tool TEXT returned to the host, and its size.
     *
     * Called exactly once per `tools/call`, from the server, with the final
     * `content[0].text` — the bounded, redacted text the client parses. `null` means no
     * text was produced at all (which is a fact worth counting, not zero bytes).
     * @param {string | null} text - the answer text, or null.
     * @returns {void}
     */
    recordReturn(text) {
      returns += 1;
      if (typeof text !== 'string') {
        // Stated as unmeasured rather than counted as 0 bytes: "no text" and "empty text"
        // are different, and neither is a size this code guessed.
        unmeasuredReturns += 1;
        return;
      }
      let bytes;
      try {
        bytes = Buffer.byteLength(text, 'utf8');
      } catch {
        // A lone surrogate cannot be encoded; the text is not a size this run can state.
        unmeasuredReturns += 1;
        return;
      }
      returnBytes += bytes;
    },

    /**
     * Record one wait's own accounting.
     *
     * One flat summary shape, whether the wait followed a decision or not: the wait loop
     * reports `waitId`/`afterDecisionId`/`taskId`/`reason`/`durationMs`/counts and nothing
     * else, so a plain wait and a post-decision wait are counted by the same rule.
     * @param {object} summary - the wait loop's summary.
     * @returns {void}
     */
    recordWait(summary) {
      const known = METRIC_WAIT_REASONS.includes(summary?.reason);
      const reason = known ? summary.reason : 'refused';
      const durationMs = count(summary?.durationMs);
      const waitId = typeof summary?.waitId === 'string' ? summary.waitId : null;
      const afterDecisionId = typeof summary?.afterDecisionId === 'string' ? summary.afterDecisionId : null;
      waits += 1;
      waitedTotalMs += durationMs;
      waitObservations += count(summary?.observationRequests);
      bump(waitReturns, reason);
      if (afterDecisionId !== null) waitsAfterDecisions += 1;
      if (afterDecisionId !== null && reason === 'permission') waitQuestionsAnswered += 1;
      recentWaits.push({
        waitId,
        afterDecisionId,
        taskId: typeof summary?.taskId === 'string' ? summary.taskId : null,
        reason,
        durationMs,
        observationRequests: count(summary?.observationRequests),
        heartbeatsConsumed: count(summary?.heartbeatsConsumed),
        settledRequestObservations: count(summary?.settledRequestObservations),
        waitReturns: count(summary?.waitReturns),
        at: now(),
      });
      if (recentWaits.length > limit) recentWaits.shift();
    },

    /**
     * Record one ACTUAL permission decision and how far it got.
     *
     * Only the decision path calls this, and only with what the receipt could prove:
     * `applied` for a confirmed decision, `unknown` when the call failed without an answer,
     * `refused` when the harness said no. A refused or unconfirmed attempt is counted as an
     * attempt and never as an authorization.
     *
     * The `applied` field of the recorded sample is the SAME three-valued fact the permission
     * receipt publishes, not a boolean derived from the state label: `true` for `applied`,
     * `false` for `refused`, and `null` for `unknown`. An unconfirmed attempt whose sample
     * said `false` would contradict both the receipt (`applied: null`) and the cumulative
     * `decisions.unknown` counter, and a reader could take "not applied" for a fact nobody
     * established.
     * @param {object} entry - `taskId`, `requestId`, `decision`, `fingerprint`, `applied`,
     *   `confirmation`, optional `receiptId`, `at`.
     * @returns {void}
     */
    recordDecision(entry) {
      const state = METRIC_DECISION_STATES.includes(entry?.confirmation)
        ? entry.confirmation
        : (entry?.applied === true ? 'applied' : entry?.applied === false ? 'refused' : 'unknown');
      // A QUESTION ANSWER is not a permission decision: it grants nothing, so it is counted
      // on its own axis and NEVER touches the permission buckets (its verb is neither
      // allow-once nor reject, which would otherwise have been reported as a refusal).
      if (entry?.decision === QUESTION_ANSWER_KIND) {
        questionAnswers += 1;
        bump(questionAnswerStates, state);
        recentDecisions.push({
          receiptId: typeof entry?.receiptId === 'string' ? entry.receiptId : null,
          taskId: typeof entry?.taskId === 'string' ? entry.taskId : null,
          requestId: typeof entry?.requestId === 'string' ? entry.requestId : null,
          decision: QUESTION_ANSWER_KIND,
          fingerprint: null,
          applied: state === 'applied' ? true : state === 'refused' ? false : null,
          state,
          at: Number.isFinite(entry?.at) ? entry.at : now(),
        });
        if (recentDecisions.length > limit) recentDecisions.shift();
        return;
      }
      const decision = entry?.decision === 'allow-once' || entry?.decision === 'reject' ? entry.decision : null;
      decisions += 1;
      bump(decisionStates, state);
      if (state === 'applied' && decision !== null) bump(appliedDecisions, decision);
      recentDecisions.push({
        receiptId: typeof entry?.receiptId === 'string' ? entry.receiptId : null,
        taskId: typeof entry?.taskId === 'string' ? entry.taskId : null,
        requestId: typeof entry?.requestId === 'string' ? entry.requestId : null,
        decision,
        // A digest of the arguments the decision was bound to, never the arguments.
        fingerprint: typeof entry?.fingerprint === 'string' ? entry.fingerprint : null,
        // Three-valued on purpose: unknown is `null`, never `false`.
        applied: state === 'applied' ? true : state === 'refused' ? false : null,
        state,
        at: Number.isFinite(entry?.at) ? entry.at : now(),
      });
      if (recentDecisions.length > limit) recentDecisions.shift();
    },

    /**
     * The census, as a bounded read-only answer.
     *
     * The audit SAMPLE is capped well below the internal ring buffer: a long session
     * (hundreds of waits and decisions) must still be able to ANSWER, and the sample
     * lists were the one part `boundedJson` cannot shrink — without this cap they
     * grew the whole answer past the tool-text bound and the caller received
     * `MCP_RESULT_OVER_BUDGET` instead of even the totals. The cap keeps only the
     * MOST RECENT entries and STATES how many were omitted, so a reader can always
     * tell a partial view from the full history; the cumulative counters above are
     * exact regardless of the sample.
     * @returns {object} snapshot with no content and no credentials.
     */
    snapshot() {
      /** How many recent entries the published sample keeps, per list. */
      const sampleLimit = 8;
      const keptWaits = recentWaits.slice(-sampleLimit);
      const keptDecisions = recentDecisions.slice(-sampleLimit);
      return {
        schemaVersion: 1,
        // What each counter MEANS, stated where the numbers are, so no reader can take
        // `waitReturns` for a number of model wake-ups.
        definitions: {
          mcpToolCalls: 'tool invocations the HOST made on this MCP connection, by tool name',
          returnedText: 'answers this process handed back, and their UTF-8 bytes as handed to the transport',
          waitReturns: 'wait answers by reason; one per host call, NOT a model wake-up',
          waitObservations: 'internal bounded observations issued by the wait loop; program-internal',
          decisions: 'permission decisions by outcome; only `applied` authorized anything',
          questionAnswers: 'ordinary question answers by outcome; they authorize NOTHING',
          waitsAfterDecisions: 'waits that continued inside the same call as a permission decision',
          waitQuestionsAnswered: 'post-decision waits that returned ANOTHER pending permission request',
          hostModelResponses: 'host model turns; cannot be observed from this process',
          hostTokenUsage: 'host token usage; cannot be observed from this process',
        },
        hostObservability: {
          hostModelResponses: NOT_INTEGRATED,
          hostTokenUsage: NOT_INTEGRATED,
          hostCost: NOT_INTEGRATED,
          reason: 'the host model runs in its own process; this server only sees the tool calls it receives',
        },
        tools: Object.fromEntries([...toolCalls.entries()].sort(([a], [b]) => a.localeCompare(b))),
        returnedText: {
          count: returns,
          // Bytes of the final bounded, redacted tool text. Not a delivery receipt: the
          // transport accepted it, which is not the same as the host having read it.
          bytes: returnBytes,
          unmeasured: unmeasuredReturns,
          unit: 'utf8-bytes-of-serialized-tool-text',
        },
        waits: {
          count: waits,
          totalMs: waitedTotalMs,
          observations: waitObservations,
          reasons: Object.fromEntries([...waitReturns.entries()].sort(([a], [b]) => a.localeCompare(b))),
        },
        decisions: {
          // Cumulative, not derived from the samples below: a 65th decision still counts.
          count: decisions,
          applied: decisionStates.get('applied') ?? 0,
          unknown: decisionStates.get('unknown') ?? 0,
          refused: decisionStates.get('refused') ?? 0,
          allowed: appliedDecisions.get('allow-once') ?? 0,
          rejected: appliedDecisions.get('reject') ?? 0,
        },
        // Ordinary question answers, reported apart from permission decisions because they
        // authorize nothing. A question answer is never counted as a refusal.
        questionAnswers: {
          count: questionAnswers,
          applied: questionAnswerStates.get('applied') ?? 0,
          unknown: questionAnswerStates.get('unknown') ?? 0,
          refused: questionAnswerStates.get('refused') ?? 0,
        },
        correlation: {
          waitsAfterDecisions,
          waitQuestionsAnswered,
          // The bounded sample is what makes the counts auditable: one identifier per wait,
          // its reason, its duration, and the decision it followed. Published with an
          // explicit omission statement, so a partial sample is never mistaken for the
          // full history. The omission counts are measured against the CUMULATIVE
          // histories (waits; decisions PLUS question answers, which share one sample
          // list), never against the internal ring buffer — so the statement is exactly
          // "how many of the recorded facts this answer does not show", even on a
          // session shorter than the ring.
          recentWaits: keptWaits.map((entry) => ({ ...entry })),
          recentDecisions: keptDecisions.map((entry) => ({ ...entry })),
          omitted: {
            waits: waits - keptWaits.length,
            decisions: (decisions + questionAnswers) - keptDecisions.length,
          },
        },
      };
    },

    /**
     * One bounded line for the exit diagnostics.
     *
     * Counts and byte totals only. Printed when the process ends, so an operator who never
     * called `delegate_metrics` still learns how much this MCP process did — and that the
     * host's own model activity is NOT part of it.
     * @returns {string} single line, no task content.
     */
    diagnosticsLine() {
      const reasons = [...waitReturns.entries()].map(([key, value]) => `${key}=${value}`).join(',') || 'none';
      const total = [...toolCalls.values()].reduce((sum, value) => sum + value, 0);
      return `dsh-delegate-mcp: calls=${total} returns=${returns} returnBytes=${returnBytes} `
        + `waits=${waits} returns(${reasons}) decisions=${decisions} applied=${decisionStates.get('applied') ?? 0} `
        + `waitsAfterDecisions=${waitsAfterDecisions} hostModelResponses=${NOT_INTEGRATED}`;
    },
  };
}

/**
 * Build one stable identifier for a call chain.
 * @param {string} prefix - `wait` or `decision`.
 * @param {number} sequence - per-server counter.
 * @returns {string} identifier.
 */
export function correlationId(prefix, sequence) {
  return `${prefix}-${Number.isInteger(sequence) ? sequence : 0}-${Date.now().toString(36)}`;
}
