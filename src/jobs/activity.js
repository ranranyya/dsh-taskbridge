// Bounded activity bookkeeping for one running delegated task.
//
// This module answers exactly one question — "has this executor been silent, and
// for how long?" — and records the minimum needed to answer it. It is deliberately
// not a transcript, not a progress model and not a log:
//
//   * **Only metadata is retained.** An event contributes a KIND, a COUNT and a
//     timestamp. Reasoning text, assistant text, tool result bodies and tool
//     arguments are read only far enough to decide *whether the event was
//     non-empty*; nothing derived from them is stored, so no buffer here can grow
//     with model output and nothing here can leak a transcript into a view,
//     a history row or a diagnostic.
//   * **A published failure label is allowlisted, never echoed.** A tool's own
//     `error.code`/`error.name` is free text that can carry a path or a token, so it
//     travels only when it matches a small set of well-known codes; otherwise the
//     generic `TOOL_ERROR` is published. The complete native identity is hashed for
//     episode distinction only, and no free text (reason, result content) is retained.
//   * **The vocabulary is the harness's own.** The classified names are the
//     durable `SessionEventMap` types of `@deepseek-ai/dsh-session` (`step/start`,
//     `assistant/message`, `tool/call`, `tool/result`, plus the turn/step/usage
//     boundaries), the two stream-chunk types `@deepseek-ai/dsh-llm` emits
//     (`text-delta`, `reasoning-delta`), and the nested streaming envelopes the
//     runner accepts (`message/part`, `assistant/delta` wrapping a delta). An
//     event this module does not recognise is `unrelated`, which by contract never
//     resets idleness.
//   * **Only real activity resets the clock.** A non-empty output or reasoning
//     delta — top-level OR nested inside a streaming envelope — an assistant
//     message carrying text or reasoning, a step that actually started, a native
//     tool call and a tool result are activity. Empty deltas, bookkeeping events,
//     connection heartbeats and result polling are NOT: if they reset the clock, a
//     hung executor would look busy forever and the whole silent-wait mechanism
//     would never fire.
//   * **Silence, not duration, raises attention.** An open tool call changes how the
//     silence is DESCRIBED (`waitingOn: 'tool'`, with the call's elapsed span and a
//     `tool-running` self-check verdict) but not WHETHER it counts: a tool that
//     emits nothing for five minutes gets the self-check and for ten minutes gets
//     attention, exactly like any other silent executor. Treating an open call as
//     proof of progress would hide a genuinely hung tool. Nothing here ever fails,
//     cancels or restarts a run because of duration.
//
// The clock is injected (`now`) so tests can simulate twenty minutes of real
// progress deterministically instead of sleeping.

import { createHash, randomBytes } from 'node:crypto';
import { REPEATED_FAILURE_KIND } from './diagnostics.js';

/**
 * How one event kind is classified for idleness.
 *
 * `activity` — the executor demonstrably produced something; resets the idle clock.
 * `structure` — a lifecycle boundary (turn/step boundaries, usage, an empty
 * delta). Observed and counted, never treated as progress.
 * `unrelated` — anything this build does not classify, including heartbeat and
 * polling traffic on an unrelated channel.
 */
export const ACTIVITY_KINDS = Object.freeze({
  activity: 'activity',
  structure: 'structure',
  unrelated: 'unrelated',
});

/** How many distinct event types one summary keeps counts for. */
const MAX_KIND_COUNTS = 32;

/** Bound on a recorded tool name or call id; they are identifiers, not content. */
const MAX_IDENTIFIER_CHARS = 200;

/** Settled call ids remembered so a completion can be matched to its start. */
const MAX_TRACKED_CALL_IDS = 64;

/**
 * Stage-result identities remembered for per-event deduplication.
 *
 * An id is remembered only after a stage result really advanced the clock, so the bound costs
 * nothing but memory: past it, the oldest identity is forgotten and would count once more.
 */
const MAX_TRACKED_STAGE_EVENTS = 64;

/**
 * Session event types that are PROGRESS, keyed to the evidence they carry.
 *
 * These are `SessionEventMap` members of `@deepseek-ai/dsh-session` (and, for the
 * two delta names, `StreamChunk` types of `@deepseek-ai/dsh-llm`, which reach the
 * same listener). Whether a given event is *genuine* progress is decided by
 * {@link observeProgress}: several of these can arrive carrying nothing.
 */
const ACTIVITY_EVENT_TYPES = Object.freeze({
  // The loop streamed model output. Genuine only when the delta is non-empty.
  'text-delta': 'output-delta',
  'reasoning-delta': 'reasoning-delta',
  // Nested streaming envelopes: `data.delta` carries the same chunk shape. The
  // runner accepts both spellings, so both must be classified — treating them as
  // structural would hide every token of a run that streams nested.
  'message/part': 'output-delta',
  'assistant/delta': 'output-delta',
  // The settled assistant message for one step. Genuine only when it carries text
  // or reasoning; an empty message is a structural event.
  'assistant/message': 'assistant-message',
  // A step actually opened: the model was called.
  'step/start': 'model-step',
  // The model requested one tool invocation.
  'tool/call': 'tool-call',
  // One tool call settled with a model-facing result.
  'tool/result': 'tool-result',
});

/**
 * Session event types that only ever open, close or describe a step.
 *
 * `assistant/message` is handled separately: it is progress only when it carries
 * content, which is the difference between the settled answer and an empty message.
 */
const STRUCTURE_EVENT_TYPES = Object.freeze(new Set([
  'turn/start',
  'turn/end',
  'step/end',
  'assistant/attempt',
  'usage',
]));

/**
 * Classify one native event.
 *
 * @param {unknown} event - the object handed to `request.onEvent`.
 * @returns {{ kind: string, type: string | null, label: string, activity: boolean, tool: object | null }} classification.
 */
export function classifyActivityEvent(event) {
  const unrelated = { kind: ACTIVITY_KINDS.unrelated, type: null, label: 'unrelated', activity: false, tool: null };
  if (event === null || typeof event !== 'object') return unrelated;
  const type = typeof event.type === 'string' ? event.type : null;
  if (type === null) return unrelated;

  const progress = ACTIVITY_EVENT_TYPES[type];
  if (progress !== undefined) {
    const observed = observeProgress(type, event);
    return {
      kind: observed.activity ? ACTIVITY_KINDS.activity : ACTIVITY_KINDS.structure,
      type,
      label: observed.activity ? progress : `${progress}-empty`,
      activity: observed.activity,
      tool: observed.tool,
    };
  }
  if (STRUCTURE_EVENT_TYPES.has(type)) {
    return { kind: ACTIVITY_KINDS.structure, type, label: type, activity: false, tool: null };
  }
  return unrelated;
}

/**
 * Read one progress-shaped event far enough to decide whether it carried
 * anything, and to recover the tool identity when it names one.
 *
 * This is the only place that touches payload fields. It reads text/content ONLY
 * to test emptiness: no string is returned, stored or concatenated.
 * @param {string} type - event type.
 * @param {object} event - event object.
 * @returns {{ activity: boolean, tool: object | null }} observation.
 */
function observeProgress(type, event) {
  if (type === 'text-delta' || type === 'reasoning-delta') {
    const text = payloadOf(event).text;
    // A delta that carries no characters says nothing about progress: the loop
    // can emit an empty chunk while waiting on the provider. A whitespace-only
    // delta is still model output, so it counts.
    return { activity: typeof text === 'string' && text !== '', tool: null };
  }
  if (type === 'message/part' || type === 'assistant/delta') {
    // Nested streaming envelope: the chunk lives under `data.delta` (the runner
    // accepts `data.delta`, `delta`, then `data` itself). Only the delta's TYPE and
    // the emptiness of its text are read; the text is never returned.
    const payload = payloadOf(event);
    const delta = payload.delta ?? event.delta ?? payload;
    if (delta === null || typeof delta !== 'object') return { activity: false, tool: null };
    const deltaType = delta.type;
    if (deltaType !== 'text-delta' && deltaType !== 'reasoning-delta') {
      return { activity: false, tool: null };
    }
    const text = delta.text;
    return { activity: typeof text === 'string' && text !== '', tool: null };
  }
  if (type === 'assistant/message') {
    const payload = payloadOf(event);
    const message = payload.message ?? event.message ?? null;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      if ((block.type === 'text' || block.type === 'reasoning')
        && typeof block.text === 'string' && block.text !== '') {
        return { activity: true, tool: null };
      }
    }
    return { activity: false, tool: null };
  }
  if (type === 'tool/call') {
    // `payloadOf` already falls back to the event object itself, so this reads
    // `data.name` when the native envelope is present and a top-level `name`
    // otherwise. The ARGUMENTS are deliberately not read at all, so this module
    // cannot retain or forward them.
    const payload = payloadOf(event);
    const name = identifier(payload.name);
    const callId = identifier(payload.callId ?? payload.id);
    return { activity: name !== null, tool: { name, callId } };
  }
  if (type === 'tool/result') {
    // Native shape: `data.message.toolCallId` (the tool-role result message).
    const message = payloadOf(event).message;
    const callId = identifier(message?.toolCallId ?? payloadOf(event).callId);
    // Any settled tool result is progress, including a failed one: the tool ran.
    return { activity: true, tool: { name: null, callId } };
  }
  if (type === 'step/start') {
    return { activity: true, tool: null };
  }
  return { activity: false, tool: null };
}

/**
 * The payload of a native event.
 *
 * Native events carry their payload under `data` (`{ type, seq, time, data }`),
 * and the streaming shapes a fake or a legacy emitter produces put the same fields
 * at the top level. Both spellings are accepted, `data` first.
 * @param {object} event - event object.
 * @returns {object} payload object (never null).
 */
function payloadOf(event) {
  const data = event.data;
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) return data;
  return event;
}

/**
 * Bound an identifier-shaped value (a tool name or a call id).
 *
 * Bounded and type-checked, never interpreted: these names are published so an
 * operator can see WHAT is running, and a pathological value cannot grow a view.
 * @param {unknown} value - candidate.
 * @returns {string | null} bounded identifier, or null.
 */
function identifier(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.slice(0, MAX_IDENTIFIER_CHARS);
  return trimmed === '' ? null : trimmed;
}

/**
 * Bounded activity state of one running task.
 *
 * Owned by the engine's per-task monitor. Every field is a scalar or a small
 * bounded map; there is no reference to the event object that produced it.
 */
export class TaskActivity {
  /**
   * @param {object} [options] - `now` clock override (tests).
   */
  constructor(options = {}) {
    /** @type {() => number} */
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    /** @type {number | null} */
    this.lastActivityAt = null;
    /** @type {number} */
    this.replacements = 0;
    /** @type {{ name: string | null, callId: string | null, startedAt: number } | null} */
    this.tool = null;
    /** Settled tool calls represented as a count only — never their content. */
    this.toolCallsStarted = 0;
    this.toolCallsFinished = 0;
    this.lastToolName = null;
    this.lastToolDurationMs = null;
    /** @type {Map<string, number>} */
    this.counts = new Map();
    /** @type {Map<string, number>} */
    this.openCalls = new Map();
    /** @type {Map<string, number>} */
    this.eventCounts = new Map();
    /** Bumped on every genuine activity; used to reset one wait's episode view. */
    this.sequence = 0;
    /**
     * Genuine activity events, counted independently of the label map.
     *
     * The map is bounded and its keys can be evicted, so summing it would make the
     * published count both imprecise (structure and unrelated labels would be
     * included) and lossy. This counter is only ever incremented for real progress.
     */
    this.activityCount = 0;
    /** Total observations, counted independently of the bounded per-type map. */
    this.eventCount = 0;
    /**
     * Set once the run reached a terminal state. From then on every elapsed value is
     * measured against the recorded end, so a stored record cannot appear to keep
     * growing (a "tool running for 4 hours" that ended twenty minutes ago).
     * @type {{ endedAt: number } | null}
     */
    this.final = null;
  }

  /**
   * Record one observation.
   *
   * @param {object} observation - result of {@link classifyActivityEvent}.
   * @param {number} [at] - observation timestamp.
   * @returns {boolean} whether this observation was real activity.
   */
  record(observation, at = this.now()) {
    assertObservation(observation);
    if (this.final !== null) return false;
    this.replacements += 1;
    if (this.eventCount < Number.MAX_SAFE_INTEGER) this.eventCount += 1;
    const counted = this.counts.get(observation.label) ?? 0;
    if (counted < Number.MAX_SAFE_INTEGER) this.counts.set(observation.label, counted + 1);
    if (observation.type !== null) {
      const perType = this.eventCounts.get(observation.type) ?? 0;
      if (perType < Number.MAX_SAFE_INTEGER) this.eventCounts.set(observation.type, perType + 1);
    }
    this.pruneCounts();
    if (observation.tool !== null) this.recordTool(observation.tool, at);
    if (observation.activity !== true) return false;
    if (this.activityCount < Number.MAX_SAFE_INTEGER) this.activityCount += 1;
    this.lastActivityAt = at;
    this.sequence += 1;
    return true;
  }

  /**
   * Freeze every elapsed value at the instant the run ended.
   *
   * Called once, when the task reaches a terminal state. A view or a stored record
   * read an hour later then reports the span the run actually had, not an idle or
   * tool-elapsed duration that keeps growing for a run nobody is following.
   * @param {number} endedAt - the recorded end time.
   * @returns {void}
   */
  finalize(endedAt) {
    if (this.final !== null) return;
    const at = Number.isFinite(endedAt) ? endedAt : this.now();
    this.final = { endedAt: at };
  }

  /**
   * The reference time elapsed values are measured against.
   *
   * Live: the caller's `at`. Finalized: the recorded end, so nothing grows.
   * @param {number} at - requested reference time.
   * @returns {number} the effective reference time.
   */
  referenceTime(at) {
    if (this.final !== null) return this.final.endedAt;
    return at;
  }

  /**
   * Track the tool call a `tool/call` (or `tool/result`) event named.
   *
   * A start opens a span; a result closes the matching span and records how long
   * it ran. Nothing about the tool's arguments or result is kept.
   * @param {{ name: string | null, callId: string | null }} tool - identity.
   * @param {number} at - observation timestamp.
   * @returns {void}
   */
  recordTool(tool, at) {
    const callId = tool.callId;
    if (tool.name !== null) {
      this.lastToolName = tool.name;
      this.toolCallsStarted += 1;
      this.tool = { name: tool.name, callId, startedAt: at };
      if (callId !== null) {
        this.openCalls.set(callId, at);
        while (this.openCalls.size > MAX_TRACKED_CALL_IDS) {
          const oldest = this.openCalls.keys().next();
          if (oldest.done === true) break;
          this.openCalls.delete(oldest.value);
        }
      }
      return;
    }
    if (callId !== null && this.openCalls.has(callId)) {
      const startedAt = this.openCalls.get(callId);
      this.openCalls.delete(callId);
      this.lastToolDurationMs = Math.max(0, at - startedAt);
      this.toolCallsFinished += 1;
      if (this.tool !== null && this.tool.callId === callId) this.tool = null;
    }
  }

  /**
   * Keep the counters bounded.
   *
   * Both maps are keyed by a closed vocabulary (the labels and types this module
   * classifies), so they cannot grow with model output; the cap exists so a future
   * classifier that learns more keys cannot turn this into unbounded memory.
   * @returns {void}
   */
  pruneCounts() {
    while (this.counts.size > MAX_KIND_COUNTS) {
      const oldest = this.counts.keys().next();
      if (oldest.done === true) break;
      this.counts.delete(oldest.value);
    }
    while (this.eventCounts.size > MAX_KIND_COUNTS) {
      const oldest = this.eventCounts.keys().next();
      if (oldest.done === true) break;
      this.eventCounts.delete(oldest.value);
    }
  }

  /** @returns {number} total observations recorded. */
  totalEvents() {
    return this.eventCount;
  }

  /** @returns {number} genuine activity events. */
  activityEvents() {
    return this.activityCount;
  }

  /**
   * Milliseconds since the last genuine activity, or null when there was none.
   * @param {number} [at] - reference time.
   * @returns {number | null} idle span.
   */
  idleForMs(at = this.now()) {
    if (this.lastActivityAt === null) return null;
    return Math.max(0, this.referenceTime(at) - this.lastActivityAt);
  }

  /**
   * The pending tool span, described without any argument or result text.
   * @param {number} [at] - reference time.
   * @returns {{ name: string | null, callId: string | null, startedAt: number, elapsedMs: number } | null} span.
   */
  toolSpan(at = this.now()) {
    if (this.tool === null) return null;
    return {
      name: this.tool.name,
      callId: this.tool.callId,
      startedAt: this.tool.startedAt,
      elapsedMs: Math.max(0, this.referenceTime(at) - this.tool.startedAt),
    };
  }

  /**
   * The bounded, publishable summary of this activity.
   *
   * Everything here is a count, a timestamp or an identifier. There is no field a
   * text fragment, an argument or a result body could be carried in.
   * @param {object} [options] - `at` reference time, `toolActive` whether a tool
   *   call is currently outstanding.
   * @returns {object} summary.
   */
  summary({ at = this.now(), toolActive = false } = {}) {
    const span = toolActive ? this.toolSpan(at) : null;
    return {
      lastActivityAt: this.lastActivityAt,
      // `idleForMs` is the honest silence span. While a native tool call is
      // outstanding the executor is working, not idle, so the same field reports
      // the tool's elapsed span and `waitingOn` says which of the two it is.
      idleForMs: span === null ? this.idleForMs(at) : span.elapsedMs,
      waitingOn: span === null ? 'idle' : 'tool',
      currentTool: span === null
        ? null
        : { name: span.name, callId: span.callId, startedAt: span.startedAt, elapsedMs: span.elapsedMs },
      lastTool: this.lastToolName === null
        ? null
        : { name: this.lastToolName, durationMs: this.lastToolDurationMs },
      events: this.totalEvents(),
      activityEvents: this.activityEvents(),
      toolCallsStarted: this.toolCallsStarted,
      toolCallsFinished: this.toolCallsFinished,
      // Stated when the record was frozen, so a reader can tell "this is the final
      // span" from "this is still being measured".
      finalizedAt: this.final === null ? null : this.final.endedAt,
      // Per-kind counts, bounded and sorted for a stable view.
      kinds: Object.fromEntries([...this.counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    };
  }
}

/**
 * Guard against a caller passing a value this class cannot read.
 * @param {unknown} observation - candidate observation.
 * @returns {void}
 */
function assertObservation(observation) {
  if (observation === null || typeof observation !== 'object') {
    throw new TypeError('activity observation must be an object');
  }
}

/** The kind carried in an `attention` diagnostic that reports repeated failures. */
export { REPEATED_FAILURE_KIND };

/** Bound on tracked calls and on retained failure episodes. */
const MAX_TRACKED_FAILURES = 32;

/**
 * Detects the same tool failing the same way over and over, and says so ONCE.
 *
 * Independent of the silence clock: a run can be busy and still be retrying the same
 * broken operation, which is exactly what neither existing timer catches.
 *
 * What is a failure: ONLY the native structured marker on a settled call —
 * `tool/result.message.isError === true` (the durable `ToolResultMessage` contract).
 * Text containing "error", a quiet run, reasoning-only output, a long test or a run
 * that changed no files are never treated as failures.
 *
 * What is retained: a tool name, a sanitized failure code, a 16-hex digest of
 * (tool + operation + code + the error's own reason text), counts and two timestamps.
 * Arguments, result content, the reason text itself and model output are read only to
 * compute that digest and are never stored, published or forwarded.
 *
 * Identity: tool + operation + code + reason digest. Two failures with the same code but
 * a different REAL reason ("file not found: a.txt" vs "file not found: b.txt") are
 * different episodes, because the operation arguments are equal and the code is only the
 * class of failure.
 *
 * When it fires: the same identity failing `threshold` times CONSECUTIVELY. A different
 * identity starts a new episode; a success ends the current one; further failures in an
 * already-reported episode do not report again. A later episode can report again.
 */
export class RepeatedFailureTracker {
  /**
   * @param {object} [options] - `threshold` (0 disables), `digest` seam (tests only).
   */
  constructor(options = {}) {
    const threshold = Number(options.threshold);
    this.threshold = Number.isSafeInteger(threshold) && threshold > 0 ? threshold : 0;
    this.digest = typeof options.digest === 'function' ? options.digest : sha256Hex;
    // A per-monitor random nonce, folded into every eventId this monitor mints.
    // Two tasks whose monitors freeze the same clock, run the same tool, the same
    // operation and the same failure would otherwise hash identical episode
    // identities to the SAME eventId — and then one task's ack could acknowledge
    // (and silence) the other task's reminder. The nonce namespaces the event
    // identity per monitor; it carries no content of its own. SIXTEEN random bytes:
    // the collision space of two monitors in the same process must be far larger
    // than any plausible task count, and a smaller nonce would shrink it for no
    // benefit — the id is 16 hex chars of digest, not of entropy.
    this.nonce = randomHex16();
    /** callId -> { name, operationDigest } for calls whose result has not arrived yet. */
    this.openCalls = new Map();
    /**
     * The episode being counted, or null:
     * `{ identity, count, reported, code, tool, operationDigest, firstSeenAt, lastSeenAt }`.
     */
    this.episode = null;
    /** Bounded evidence of reported episodes: hash and counts only. */
    this.reported = [];
  }

  /**
   * Record one `tool/call`. Arguments are hashed now and immediately dropped.
   * @param {object} event - native `tool/call` event.
   * @returns {void}
   */
  onCall(event) {
    if (this.threshold === 0) return;
    const payload = payloadOf(event);
    const callId = identifier(payload.callId ?? payload.id);
    const name = identifier(payload.name);
    if (callId === null || name === null) return;
    // The raw arguments string exists only as hash input; it is never retained.
    const operation = typeof payload.arguments === 'string' ? payload.arguments : '';
    this.openCalls.set(callId, { name, operationDigest: this.digest(operation).slice(0, 16) });
    while (this.openCalls.size > MAX_TRACKED_FAILURES) {
      const oldest = this.openCalls.keys().next();
      if (oldest.done === true) break;
      this.openCalls.delete(oldest.value);
    }
  }

  /**
   * Record one `tool/result`.
   *
   * Answers whether this result is the threshold-th consecutive identical failure, in
   * which case the caller reports it exactly once.
   * @param {object} event - native `tool/result` event.
   * @param {number} at - observation time.
   * @returns {object | null} the diagnostic to report, or null.
   */
  onResult(event, at) {
    if (this.threshold === 0) return null;
    const payload = payloadOf(event);
    const message = payload.message ?? null;
    const callId = identifier(message?.toolCallId ?? payload.callId);
    // A result with no matching call cannot be attributed. A DUPLICATE result for the
    // same call is dropped here, because the call was consumed by the first one.
    const call = callId === null ? undefined : this.openCalls.get(callId);
    if (callId === null || call === undefined) return null;
    this.openCalls.delete(callId);

    if (message?.isError !== true) {
      // A completed call ends the episode: whatever was failing is not failing now.
      this.episode = null;
      return null;
    }
    // The PUBLISHED label is an allowlisted code or the generic one; the COMPLETE native
    // identity (code/name/reason, or the result content when the block is absent) is hashed
    // so two failures that both publish `TOOL_ERROR` still separate into their own episodes.
    // No free text is retained: only this 16-hex digest.
    const code = failureCode(payload.error);
    const identityHash = this.digest(failureIdentity(payload.error, message)).slice(0, 16);
    const identity = `${call.name}\u0000${call.operationDigest}\u0000${code}\u0000${identityHash}`;
    if (this.episode === null || this.episode.identity !== identity) {
      this.episode = {
        identity,
        count: 0,
        reported: false,
        code,
        tool: call.name,
        operationDigest: call.operationDigest,
        // A monotonically increasing internal sequence identifies the episode itself, so a
        // parked reminder can be matched to it EXACTLY. A timestamp cannot do that: several
        // episodes can start in the same millisecond, which is precisely how a stale
        // reminder used to survive a switch to a different failure.
        sequence: this.nextEpisode(),
        // The FIRST failure of this episode, not the one that reached the threshold.
        firstSeenAt: at,
        lastSeenAt: at,
      };
    }
    this.episode.count += 1;
    this.episode.lastSeenAt = at;
    if (this.episode.reported || this.episode.count < this.threshold) return null;
    this.episode.reported = true;
    // The stable event identity of THIS reminder. It is a digest of the episode's
    // own hashed identity and its internal sequence — never the raw arguments,
    // the error prose or the result body, which exist only as hash input. The
    // receiver acknowledges THIS id, so a lost answer can be recovered by
    // replaying exactly this event and an ack can be bound to it precisely.
    const eventId = this.digest(`event\u0000${this.nonce}\u0000${identity}\u0000${this.episode.sequence}\u0000${this.episode.firstSeenAt}`).slice(0, 16);
    const entry = {
      kind: REPEATED_FAILURE_KIND,
      eventId,
      toolName: call.name,
      failureCode: code,
      operationDigest: call.operationDigest,
      consecutive: this.episode.count,
      threshold: this.threshold,
      firstSeenAt: this.episode.firstSeenAt,
      lastSeenAt: this.episode.lastSeenAt,
      // Internal only: matched against the parked reminder, never published.
      episodeSequence: this.episode.sequence,
    };
    this.reported.push(entry);
    while (this.reported.length > MAX_TRACKED_FAILURES) this.reported.shift();
    // The internal `episodeSequence` stays on this object (the parked reminder is matched
    // against the live episode through it) and is stripped at every PUBLICATION boundary:
    // `claimFailureReport` and the snapshot projection below both drop it.
    return { ...entry };
  }

  /** @returns {number} the next internal episode identifier. */
  nextEpisode() {
    this.episodeSequence = (this.episodeSequence ?? 0) + 1;
    return this.episodeSequence;
  }

  /**
   * Whether the currently parked reminder still describes the CURRENT episode.
   *
   * Matched by the episode's internal SEQUENCE, not by its fields or its start time. The
   * fields can collide (two episodes can share a tool, a code, an operation digest and even
   * a start millisecond), so any comparison built from them would let a stale reminder
   * survive a switch to a genuinely different failure. A reminder is valid only while the
   * sequence it was produced for is still the live one; `reported` stays as evidence.
   * @param {object | null} report - a parked diagnostic.
   * @returns {boolean} true when it still belongs to the live episode.
   */
  isCurrent(report) {
    if (report === null || report === undefined) return false;
    const episode = this.episode;
    if (episode === null) return false;
    return report.episodeSequence === episode.sequence;
  }

  /** Release the open-call map. The reported trail survives as bounded evidence. */
  dispose() {
    this.openCalls.clear();
  }
}

/**
 * Common tool failure codes that are safe to publish as-is.
 *
 * A closed allowlist, not a character filter. Substituting the punctuation of an arbitrary
 * string does not redact it: `sk-TASKBRIDGE-MOCK-SECRET-987654321` and
 * `/home/alice/.ssh/id_rsa` are already identifier-shaped, so a `[A-Za-z0-9._-]` cleanup
 * would publish both unchanged. Only a value this list recognizes travels; everything else
 * becomes {@link GENERIC_FAILURE_CODE}, and the FULL error identity is hashed internally so
 * different failures still form different episodes.
 * @type {ReadonlySet<string>}
 */
const KNOWN_FAILURE_CODES = Object.freeze(new Set([
  'ABORT_ERR', 'ABORTED', 'ALREADY_EXISTS', 'AUTH', 'BUGBUG', 'CANCELLED', 'CONFLICT',
  'DENIED', 'EACCES', 'EAGAIN', 'EBADF', 'EBADMSG', 'EBUSY', 'ECANCELED', 'ECONNREFUSED',
  'ECONNRESET', 'EEXIST', 'EFBIG', 'EINTR', 'EINVAL', 'EIO', 'EISDIR', 'ELOOP', 'EMFILE',
  'ENAMETOOLONG', 'ENENT', 'ENFILE', 'ENOENT', 'ENOEXEC', 'ENOMEM', 'ENOSPC', 'ENOSYS',
  'ENOTDIR', 'ENOTEMPTY', 'ENOTFOUND', 'ENOTSUP', 'EPERM', 'EPIPE', 'ERANGE', 'EROFS',
  'ESRCH', 'ETIMEDOUT', 'ETXTBSY', 'EXDEV', 'FAILED', 'FORBIDDEN', 'INTERNAL', 'INVALID',
  'LIMIT', 'MISSING', 'NETWORK', 'NOTFOUND', 'NOT_FOUND', 'PERMISSION_DENIED', 'RATE_LIMIT',
  'REFUSED', 'SERVICE_UNAVAILABLE', 'TIMEOUT', 'UNAUTHORIZED', 'UNAVAILABLE', 'UNKNOWN',
  'UNSUPPORTED', 'VALIDATION',
]));

/** The published code for any failure this build does not positively recognize. */
const GENERIC_FAILURE_CODE = 'TOOL_ERROR';

/**
 * The stable, PUBLISHABLE failure code carried by a settled tool result.
 *
 * Both native fields (`error.code`, then `error.name`) are free-form strings a tool can fill
 * with anything — including a path or a token that happens to be identifier-shaped. So the
 * value is published only when it matches the closed allowlist above; otherwise the generic
 * label is used. Nothing about the original string travels when it is not recognized, and
 * the complete identity is still hashed internally for episode distinction.
 * @param {unknown} error - the event's `error` block.
 * @returns {string} an allowlisted code or {@link GENERIC_FAILURE_CODE}.
 */
function failureCode(error) {
  if (error !== null && typeof error === 'object') {
    for (const key of ['code', 'name']) {
      const value = error[key];
      if (typeof value !== 'string') continue;
      if (KNOWN_FAILURE_CODES.has(value.toUpperCase())) return value.toUpperCase();
    }
  }
  return GENERIC_FAILURE_CODE;
}

/**
 * The COMPLETE failure identity, used only as hash input for episode distinction.
 *
 * This is where an unrecognized code, a name and the free-text reason are allowed to
 * appear — as input to a one-way digest that is never published. So two failures that both
 * publish `TOOL_ERROR` still separate into different episodes when their real identity
 * differs.
 * @param {unknown} error - the event's `error` block.
 * @param {unknown} message - the settled `ToolResultMessage` (the fallback identity).
 * @returns {string} hash input; never published.
 */
function failureIdentity(error, message) {
  if (error !== null && typeof error === 'object') {
    const code = typeof error.code === 'string' ? error.code : '';
    const name = typeof error.name === 'string' ? error.name : '';
    const reason = typeof error.reason === 'string' ? error.reason : '';
    if (code !== '' || name !== '' || reason !== '') return `${code}\u0000${name}\u0000${reason}`;
  }
  // A native `isError` result whose structured `error` block is absent still has content;
  // its digest is what distinguishes one such failure from another. Only the SHA is kept.
  const content = Array.isArray(message?.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (typeof block.text === 'string' && block.text !== '') parts.push(block.text);
  }
  return parts.length === 0 ? '' : `content\u0000${parts.join('\u0000')}`;
}

/** @param {string} value - text @returns {string} lowercase hex sha256. */
function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * One 32-hex random nonce (16 random bytes), the per-monitor namespace of every
 * eventId it mints.
 * @returns {string} 32 lowercase hex characters.
 */
function randomHex16() {
  return randomBytes(16).toString('hex');
}

/** Why one observation wait ended. */
export const OBSERVE_REASONS = Object.freeze({
  heartbeat: 'heartbeat',
  /**
   * The run needs the commander.
   *
   * Two DIFFERENT reminders share this reason because they all mean "look at it".
   * `checkpoint` says which one it is:
   *  * `checkpoint: 'progress'` — the run has produced no real progress for the
   *    configured interval (default 40 minutes) while its executor is still alive. The
   *    host is asked to check the run's progress, and the default answer is to keep
   *    waiting on the same task.
   *  * `checkpoint: 'failure'` — the repeated-tool-failure reminder (`failure` block;
   *    older hosts read only that block, so they keep working unchanged).
   *
   * Both are measured on ONE clock for the progress report: consecutive time WITHOUT
   * real progress, reset only by real progress. Total runtime is never a reminder.
   * Nothing is ever cancelled, restarted, resubmitted or re-queued by one.
   */
  attention: 'attention',
  permission: 'permission',
  // The worker asked a human an ordinary question. It is its own reason because answering
  // it grants nothing, and it must be reported at once rather than as silence.
  question: 'question',
  ready: 'ready',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
});

/**
 * The closed vocabulary of `attention` checkpoints.
 *
 * A host that reads only `reason` keeps the previous behaviour; a host that reads
 * `checkpoint` can tell "the run made no real progress for the interval" from "the
 * worker kept failing the same call" without parsing prose.
 *
 * There are exactly TWO reminders: `progress` (the run progress check on the one
 * no-progress clock) and `failure` (the repeated-tool-failure reminder). `stall` is
 * accepted ONLY as a legacy label — a host or a fixture written by the earlier candidate
 * may still send it — and this monitor never emits it: there is no second duration to
 * report a shorter threshold under.
 */
export const CHECKPOINTS = Object.freeze({
  progress: 'progress',
  stall: 'stall',
  failure: 'failure',
});

/**
 * Reasons no caller may ever receive from {@link TaskMonitor#observe}.
 *
 * `heartbeat` means "nothing to report, ask again"; handing it to a caller would
 * be indistinguishable from a real report, so the loop treats it as an internal
 * re-wait instead.
 */
const INTERNAL_REASONS = Object.freeze(new Set([OBSERVE_REASONS.heartbeat]));

/**
 * The task states that end an observation, mapped to the reason reported.
 *
 * Read from the engine's own lifecycle vocabulary rather than re-declared, so a
 * new terminal state cannot leave the monitor silently reporting `heartbeat` for a
 * finished run.
 */
const TERMINAL_REASON = Object.freeze({
  'awaiting-host-review': OBSERVE_REASONS.ready,
  failed: OBSERVE_REASONS.failed,
  cancelled: OBSERVE_REASONS.cancelled,
});

/** The phase a running task reports while a permission request is outstanding. */
const PHASE_AWAITING_PERMISSION = 'awaiting-permission';

/**
 * One task's activity monitor.
 *
 * Owned by the engine and attached to the task record, so the counters live next
 * to the run that produced them and die with it. It owns three things and nothing
 * else:
 *
 *  1. the bounded activity state ({@link TaskActivity}), fed from the native
 *     `onEvent` callback the runner already invokes;
 *  2. the *episode* bookkeeping that makes silent waiting silent — a
 *     self-check fires once per idle episode, and an `attention` report is not
 *     repeated until the interval has really elapsed and the caller has asked
 *     again;
 *  3. the observation wait itself, built from injected `now`/`wait` seams so a test
 *     can simulate twenty minutes in microseconds.
 *
 * What it must never do, and does not: run an LLM, read a diff or a workspace
 * file, mutate the task, restart/cancel/resubmit a run, or extend a deadline. The
 * self-check and the progress checkpoint are reads of facts the engine already
 * holds; a checkpoint is a report to the commander, never a control action.
 */
export class TaskMonitor {
  /**
   * @param {object} task - the engine's own task record for this run.
   * @param {object} [options] - seams and thresholds.
   * @param {() => number} [options.now] - clock.
   * @param {(ms: number) => Promise<void>} [options.wait] - bounded sleep.
   * @param {number} [options.selfCheckSeconds] - no-progress span for the self-check, or 0 to disable it.
   * @param {number} [options.attentionSeconds] - no-progress span for the run progress
   *   check (default 40 minutes), or 0 to disable it. This is the ONLY notification
   *   clock: a run that keeps producing real progress never reaches it, whatever its
   *   total duration.
   * @param {number} [options.repeatFailureThreshold] - consecutive identical tool
   *   failures reported once, or 0 to disable that reminder.
   * @param {number} [options.waitSliceMs] - internal polling slice.
   * @param {(message: string, detail?: unknown) => void} [options.log] - diagnostic sink.
   */
  constructor(task, options = {}) {
    this.task = task;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.wait = typeof options.wait === 'function' ? options.wait : sleep;
    // `0` is a DECISION ("this reminder is off"), not a missing value. Only a value
    // that is not a usable threshold at all falls back to the documented default.
    //
    // TWO independent clocks, which is the whole difference between the two:
    //  * the self-check is armed from the moment DSH actually STARTED running this task
    //    (see {@link TaskMonitor#runOrigin}) — a run whose model keeps streaming and
    //    whose tools keep answering is still inspected once at ten minutes, because the
    //    product asks for that one local look rather than for "time without progress";
    //  * the run progress check is armed from the last genuine DELIVERY back to the
    //    commander (see {@link TaskMonitor#progressOrigin}) — internal model steps,
    //    text deltas, tool activity, heartbeats and the check itself never move it.
    this.selfCheckMs = thresholdToMs(options.selfCheckSeconds, 10 * 60);
    this.attentionMs = thresholdToMs(options.attentionSeconds, 40 * 60);
    this.waitSliceMs = Number.isSafeInteger(options.waitSliceMs) && options.waitSliceMs > 0
      ? options.waitSliceMs
      : 1000;
    this.log = typeof options.log === 'function' ? options.log : null;
    // Timers. `setTimeout`/`clearTimeout` are injectable so a test can drive the
    // scheduled self-check deterministically instead of sleeping for ten minutes.
    this.setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
    this.clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
    this.activity = new TaskActivity({ now: this.now });
    /**
     * The repeated-failure detector. It is a SEPARATE clock from the two silence
     * thresholds on purpose: it counts distinct failed operations, not quiet time.
     */
    this.failures = new RepeatedFailureTracker({ threshold: options.repeatFailureThreshold });
    /**
     * The one failure reminder waiting to be DELIVERED AND ACKNOWLEDGED, or null.
     *
     * A single slot, not a queue: the reminder is about the CURRENT episode, and an
     * undelivered older one is superseded rather than replayed. Unlike a take-once
     * claim, this reminder STAYS parked until a receiver acknowledges it by its
     * `eventId`: the server's having written one answer out is not proof that the
     * receiver ever read it, and an answer lost on the wire must be recoverable by
     * the client's own retry — the retry observes the SAME event, not a heartbeat.
     * @type {object | null}
     */
    this.pendingFailure = null;
    /**
     * The eventId of the most recently acknowledged reminder, kept so a repeated
     * (idempotent) ack of a cleared event still answers success, and so an ack
     * can be checked against what this monitor actually delivered.
     * @type {string | null}
     */
    this.ackedEventId = null;
    /** Episode identity: bumped whenever genuine activity ends the idle episode. */
    this.episode = 0;
    /**
     * The fixed origin used when the task's recorded start cannot be compared with this
     * monitor's clock, or null while the recorded start is usable.
     * @type {number | null}
     */
    this.originFallback = null;
    /** The episode the self-check already ran for, or null. */
    this.checkedEpisode = null;
    /**
     * The one ON-DEMAND self-check timer, or null.
     *
     * A run must be inspected even when NO observer is waiting (a commander that is not
     * polling, or no client at all). So the monitor arms exactly ONE timer, at
     * `runOrigin + selfCheckMs` — the instant the run really started plus the interval,
     * whether or not the run is busy in between. It is cleared on disable, terminal
     * state, cancellation and disposal. It is a SCHEDULER, not a clock: the instant it
     * fires at comes from the same `runOrigin`/`selfCheckMs` the observation loop uses,
     * and the latch that makes it run once per run is the same `checkedEpisode`.
     * @type {{ id: unknown, at: number, episode: number } | null}
     */
    this.selfCheckTimer = null;
    /** The last self-check diagnostic, published on every summary. */
    this.selfCheck = {
      episode: null,
      checkedAt: null,
      verdict: null,
      detail: null,
      sinceStartMs: null,
      noDeliveryMs: null,
    };
    /**
     * The most recent REAL delivery of this task's progress to the commander: the interval it
     * opened, and when.
     *
     * This is the ONLY thing that advances the run progress check's clock (see
     * {@link progressOrigin}). It is not "the last time an observation returned": a
     * heartbeat, a `wait-limit`, a permission or question wait, a page refresh, the
     * self-check and the 40-minute check itself are all REPORTED without being deliveries of
     * progress, so they never move it.
     * @type {{ delivery: number, origin: number, at: number } | null}
     */
    this.attentionDelivered = null;
    /**
     * Whether the run progress check has already been REPORTED for the current delivery
     * interval.
     *
     * A latch, not a counter: the check fires at most once per interval, and a genuine
     * delivery (or the run's own start) opens the next one and clears it. It is deliberately
     * SEPARATE state from {@link attentionDelivered}: a report is not a delivery, and keeping
     * them apart is what lets the monitor tell "this interval was already reported" from "a
     * new interval opened".
     * @type {{ origin: number, at: number } | null}
     */
    this.progressReported = null;
    /**
     * The origin of the interval the last delivery opened, or null.
     *
     * One latch shared by every way a delivery can arrive — the run's terminal outcome through
     * {@link delivery}, and a real stage result through {@link noteStageResult} — so two
     * confirmations for ONE interval advance the clock ONCE. Without it, a duplicate would be a
     * second reset.
     * @type {number | null}
     */
    this.deliveryCountedInterval = null;
    /**
     * When this run's scheduled self-check performed its inspection, or null.
     *
     * Kept apart from `selfCheck.checkedAt` because the two answer different questions:
     * `checkedAt` is "which inspection is the latest" (a diagnostic), while this is "when
     * the one timer fired" (a fact the check itself must be able to state). A diagnostic
     * published by an observation says nothing about whether the timer was allowed to run.
     * @type {number | null}
     */
    this.scheduledSelfCheckAt = null;
    /**
     * The instant the delivery interval was frozen at, or null while it is still measured.
     *
     * Set once when the run reaches a terminal state, to the run's recorded end. A finished
     * run can deliver nothing more, so "nothing returned for N" stops growing there instead
     * of describing a wait nobody could have shortened.
     * @type {number | null}
     */
    this.deliveredAtMs = null;
    /**
     * Every genuine delivery this monitor observed, as bounded evidence.
     *
     * A count plus the last interval/instant: never text, never a payload. This is what
     * lets the published state say "no delivery for 41 minutes" honestly instead of
     * inferring it from internal model activity.
     */
    this.deliveries = 0;
    /**
     * The identities of the stage results already counted, bounded.
     *
     * Only event ids, never content. It is what makes a stage result count AT MOST ONCE: a
     * retried or replayed confirmation with the same event id is a duplicate and moves nothing.
     * @type {Set<string>}
     */
    this.stageEvents = new Set();
    /**
     * Every observation currently waiting, so each one owns its own controller and
     * one observer can never cancel another. Bounded by the number of callers; an
     * entry is removed in its own `finally`.
     * @type {Set<object>}
     */
    this.waiters = new Set();
    this.disposed = false;
  }

  /**
   * Record one native event.
   *
   * Called from the runner's `onEvent` hook, which means it runs inside the
   * native dispatch path: nothing here may throw, await, or retain the event.
   * @param {unknown} event - native event object.
   * @param {number} [at] - observation time.
   * @returns {boolean} whether this event was real activity.
   */
  onEvent(event, at = this.now()) {
    if (this.disposed) return false;
    let observation;
    try {
      observation = classifyActivityEvent(event);
    } catch {
      // A malformed event is not a reason to disturb the run that produced it.
      return false;
    }
    // The failure detector reads the same events but keeps its own, separate state.
    // It never feeds the silence clock, and a modelled output delta never clears it.
    try {
      this.observeFailure(event, at);
    } catch {
      // Same rule as above: bookkeeping must never disturb the run.
    }
    try {
      const active = this.activity.record(observation, at);
      // Real activity ends the current idle episode. The episode identity is what
      // makes "once per episode" true for the self-check and the attention latch:
      // without it, a run that goes quiet, wakes, and goes quiet again would be
      // treated as the SAME silence and could never alert a second time.
      if (active) {
        this.episode += 1;
        // The self-check clock reads the run's start, not this event, so nothing is
        // re-armed here: `scheduleSelfCheck` is a pure recompute and the engine calls it
        // once the run is really started. The episode identity is what keeps the
        // "already inspected" latch and the progress-report latch coherent across a run
        // that wakes and sleeps many times.
      }
      return active;
    } catch {
      return false;
    }
  }

  /**
   * Feed one event to the repeated-failure detector.
   *
   * Only the two native tool events matter; everything else is ignored. When the
   * detector decides the threshold was reached it parks the diagnostic here, and the
   * next observation delivers it — so the reminder rides the existing wait loop
   * instead of starting a poller of its own.
   * @param {object} event - native event.
   * @param {number} at - observation time.
   * @returns {void}
   */
  observeFailure(event, at) {
    if (event === null || typeof event !== 'object') return;
    if (event.type === 'tool/call') this.failures.onCall(event);
    else if (event.type === 'tool/result') {
      const diagnostic = this.failures.onResult(event, at);
      if (diagnostic !== null) this.pendingFailure = diagnostic;
      // A completed or differently-failing result ends the episode that a parked
      // reminder belonged to, so that reminder is no longer news.
      else if (!this.failures.isCurrent(this.pendingFailure)) this.pendingFailure = null;
    }
  }

  /**
   * Take the failure reminder that is waiting to be delivered, if any.
   *
   * The reminder is NOT consumed here: it stays parked until it is acknowledged by
   * its `eventId` through {@link ackFailureReport}. That is what makes a lost HTTP
   * answer recoverable — the client's retry observes the same reminder again,
   * because the server's having generated one answer proves nothing about what the
   * receiver got. A reminder whose episode has ended or changed since it was parked
   * is DROPPED rather than delivered: the run already recovered or moved on, so it
   * is history, not news. Every observation returns the SAME event (same `eventId`),
   * so one repeated failure is one notification identity, never several.
   * @returns {object | null} the published diagnostic, or null.
   */
  claimFailureReport() {
    const report = this.pendingFailure;
    if (!this.failures.isCurrent(report)) return null;
    // Published form: the internal episode sequence does not leave this module.
    const { episodeSequence, ...published } = report;
    void episodeSequence;
    return published;
  }

  /**
   * Acknowledge one delivered failure reminder by its exact event identity.
   *
   * The ack is bound to what THIS monitor parked: a matching `eventId` clears the
   * reminder, a second ack of the same (now cleared) event is an idempotent
   * success, and anything else — an unknown id, a stale one, garbage — leaves the
   * pending reminder untouched. A NEW episode keeps parking its own reminder, so
   * clearing one event can never silence the next notification.
   * @param {unknown} eventId - the `eventId` the receiver observed.
   * @returns {{ acknowledged: boolean, eventId: string | null, reason: string | null }} ack result.
   */
  ackFailureReport(eventId) {
    const requested = typeof eventId === 'string' && eventId !== '' ? eventId : null;
    let result;
    if (requested === null) {
      result = { acknowledged: false, eventId: null, reason: 'event-id-required' };
    } else if (requested === this.ackedEventId) {
      // Idempotent: the receiver repeats an ack that already landed.
      result = { acknowledged: true, eventId: requested, reason: null };
    } else {
      const report = this.pendingFailure;
      if (report === null || report.eventId !== requested) {
        // Wrong, unknown or stale id. The pending reminder (if any) is NOT cleared:
        // a bad ack must not silence a live notification.
        result = { acknowledged: false, eventId: requested, reason: 'unknown-event' };
      } else if (!this.failures.isCurrent(report)) {
        // The episode ended before the ack arrived (recovery, or a different
        // failure took over). The reminder is dropped here — it was superseded,
        // and a late ack must not resurrect it — but it is honest that nothing
        // pending was acknowledged.
        this.pendingFailure = null;
        result = { acknowledged: false, eventId: requested, reason: 'superseded' };
      } else {
        this.pendingFailure = null;
        this.ackedEventId = requested;
        result = { acknowledged: true, eventId: requested, reason: null };
      }
    }
    return { ...result };
  }

  /**
   * The instant the current idle episode began.
   *
   * Before the executor has produced anything, the episode begins when its run
   * began — a model that never streams a token is silent from the start, and
   * measuring from "never" would hide it.
   *
   * This is the EXECUTOR's silence measure. It describes the run ("quiet for 90 s", the
   * idle tool span) and it no longer arms anything: the ten-minute self-check runs from
   * {@link runOrigin} and the forty-minute check from {@link progressOrigin}, because
   * neither may be postponed by internal model activity.
   * @returns {number} epoch milliseconds.
   */
  idleOrigin() {
    if (this.activity.lastActivityAt !== null) return this.activity.lastActivityAt;
    const now = this.now();
    // A run whose recorded start was already inconsistent with this monitor's clock gets
    // ONE fixed origin — the instant that was first ruled unusable. Re-deriving it on
    // every read would slide the origin forward with the clock, and a sliding origin can
    // never become old enough for the threshold.
    if (this.originFallback !== null) return this.originFallback;
    // Before any real progress has been observed, the silence is measured from the run's
    // recorded start — but ONLY if that start is usable by THIS monitor's clock. The
    // engine stamps `startedAt`/`createdAt` from the wall clock, while this monitor reads
    // its injected `now`; a start in the future (a frozen or offset clock) or one so far
    // in the past that the threshold would look long spent must not be taken literally,
    // or a silence span would be invented. In production the two clocks agree and the
    // recorded start is used verbatim.
    for (const candidate of [this.task?.startedAt, this.task?.createdAt]) {
      if (!Number.isFinite(candidate) || candidate <= 0) continue;
      if (candidate > now || now - candidate > MAX_PLAUSIBLE_IDLE_MS) {
        this.originFallback = now;
        return this.originFallback;
      }
      return candidate;
    }
    return now;
  }

  /**
   * Whether this run's ONE self-check is due.
   *
   * Measured from the instant DSH demonstrably STARTED running the task
   * ({@link runOrigin}), NOT from the last output. The product asks for one local look
   * ten minutes into a real run, whatever the run is doing: a model that never stops
   * streaming and tools that keep answering still get that look. Queueing, creating a
   * Session and a mere request acknowledgement are not the start, so a task that has
   * not reached execution is never due.
   *
   * A disabled self-check (`selfCheckSeconds: 0`) is never due, which is the whole
   * point of the switch: the operator asked for no local inspection at all.
   * @param {number} [at] - reference time.
   * @returns {boolean} true when one read-only inspection is due.
   */
  selfCheckDue(at = this.now()) {
    if (!enabled(this.selfCheckMs)) return false;
    const origin = this.runOrigin();
    if (origin === null) return false;
    return at - origin >= this.selfCheckMs;
  }

  /**
   * Perform the read-only inspection, at most once per run.
   *
   * The inspection reads only what the engine itself already holds: whether the
   * task is alive, whether its executor settled, the phase, whether a permission
   * request is pending, and which tool call is outstanding — plus the two facts the
   * commander needs when it is reminded: how long nothing was delivered and what the
   * run is currently doing. It performs no model call, reads no diff or workspace
   * file, changes no task state, and does not touch the deadline. Disabled means
   * disabled: it returns null immediately.
   *
   * The same method serves both entry points — the observation loop and the scheduled
   * timer — so `checkedEpisode` is the ONE latch: whichever runs first makes the check,
   * and the other finds nothing to do for this run.
   * @param {number} [at] - reference time.
   * @returns {object | null} the diagnostic, or null when none was due.
   */
  runSelfCheck(at = this.now()) {
    if (this.disposed) return null;
    if (!enabled(this.selfCheckMs)) return null;
    if (!this.selfCheckDue(at)) return null;
    const episode = this.episode;
    if (this.checkedEpisode === episode) return null;
    if (terminalReason(this.task) !== null) return null;
    this.checkedEpisode = episode;
    this.selfCheck = this.inspect(at, episode);
    // This run's inspection is done, so its timer has nothing left to do.
    this.clearSelfCheckTimer();
    return this.selfCheck;
  }

  // -------------------------------------------------------------------------
  // The scheduled self-check: a read-only inspection with NO observer
  // -------------------------------------------------------------------------
  //
  // WHY a timer at all: the product requires that a run is inspected ONCE when it has
  // really been running for `selfCheckSeconds`, even when no Codex/MCP caller is
  // waiting — a commander that is not polling, or a closed client, must not leave a run
  // uninspected. It is a SCHEDULER, not a third clock:
  //
  //   * the instant is computed from the SAME `runOrigin`/`selfCheckMs` the loop uses;
  //   * it is measured from the real start of execution, so a busy run (model steps,
  //     text deltas and tool receipts the whole way) is inspected all the same, and a
  //     run that has not started yet is never inspected;
  //   * `0` (disabled), a terminal state, cancellation and disposal leave NO timer;
  //   * it is `unref`'d, so it can never keep the process alive;
  //   * an EPOCH-DOMAIN monitor (the engine's) hands the real timer the exact epoch instant
  //     the run's start and threshold produce, with the DELAY computed against this clock;
  //   * it calls `runSelfCheck` — the same read-only inspection, no I/O, no model call,
  //     no task action — and shares the `checkedEpisode` latch, so one run is
  //     inspected ONCE whichever entry point got there first.

  /**
   * (Re-)arm the one self-check timer for this run, or clear it.
   *
   * Safe to call at any time and as often as the caller likes: it is a pure recompute of
   * "should a timer exist, and when should it fire". Idempotent when the target instant
   * has not moved, so a burst of events costs at most one `setTimeout`.
   * @returns {void}
   */
  scheduleSelfCheck() {
    if (this.disposed) return this.clearSelfCheckTimer();
    // Off, already inspected for this run, or over: nothing may be scheduled.
    if (!enabled(this.selfCheckMs) || this.checkedEpisode === this.episode) return this.clearSelfCheckTimer();
    if (terminalReason(this.task) !== null) return this.clearSelfCheckTimer();
    const origin = this.runOrigin();
    // The run never really started (queueing, an unacknowledged request): no instant to
    // arm for. The next evidence of execution re-arms it, because the engine calls this
    // again whenever the run's real start becomes known.
    if (origin === null) return this.clearSelfCheckTimer();
    const dueAt = origin + this.selfCheckMs;
    const armed = this.selfCheckTimer;
    if (armed !== null && armed.at === dueAt && armed.episode === this.episode) return undefined;
    this.clearSelfCheckTimer();
    this.armSelfCheckTimer(dueAt, this.episode);
    return undefined;
  }

  /**
   * Arm the one timer that owes this run's self-check at `dueAt`.
   *
   * The callback owns its slot: it records which slot it was armed for and CLEARS that
   * slot before doing anything else. That is what makes a timer which fires a moment too
   * early work instead of wedging — the next `scheduleSelfCheck()` then sees an empty slot
   * and arms a fresh timer for the same instant, instead of deduplicating against a slot
   * whose timer has already fired and can never run again.
   * @param {number} dueAt - the instant the check is owed.
   * @param {number} [episode] - the episode identity; defaults to the current one.
   * @returns {void}
   */
  armSelfCheckTimer(dueAt, episode = this.episode) {
    const now = this.now();
    // `setTimeout` cannot be trusted past its platform maximum (a delay beyond it fires
    // at once, in a tight loop). A threshold that is further away than a timer can express
    // therefore uses a SHORT poll: each one re-reads `now` and re-arms for the distance
    // that is really left, so it fires exactly when the threshold is reached. This is the
    // only case that repeats, and it still calls the same `runSelfCheck` with the same
    // latch — it is a scheduler, never a second clock.
    const remaining = dueAt - now;
    // A clock that is already past the threshold gets one tick, never a negative delay.
    const delay = remaining > MAX_TIMER_DELAY_MS
      ? SELF_CHECK_POLL_MS
      : Math.max(0, remaining);
    const slot = { id: null, at: dueAt, episode };
    // The epoch-domain instant this slot fires at, for a real platform timer: a timer armed
    // with a small delay can fire LATE, but the check belongs at the instant the threshold
    // was reached, so it is recorded there — bounded by this monitor's clock so an injected
    // (non-epoch) time base can never record a check at an invented future instant.
    const dueEpoch = Number.isFinite(dueAt) && Math.abs(dueAt - now) <= MAX_EPOCH_DOMAIN_MS ? dueAt : null;
    const handle = this.setTimer(() => {
      // Consume THIS slot first, whoever owns it now. A stale timer (its slot was replaced
      // or cleared) leaves the current slot alone.
      if (this.selfCheckTimer === slot) this.selfCheckTimer = null;
      else this.clearTimerOf(slot);
      // A disposed monitor, or a finished run, owes nothing.
      if (this.disposed) return;
      if (terminalReason(this.task) !== null) return;
      try {
        // A pure read of what the engine already holds: no I/O, no model, no task change.
        const checked = this.runSelfCheck(dueEpoch ?? this.now());
        if (checked !== null) {
          // Recorded on its own field: this is the one timer having fired, which is a
          // different fact from "which diagnostic is the latest".
          this.scheduledSelfCheckAt = checked.checkedAt;
          return;
        }
      } catch {
        // A diagnostic must never disturb the run that produced it.
      }
      // Not due yet by the clock's own reading (a timer that fired a moment early, or a
      // clock that moved): the run still owes a check, so re-arm for the SAME instant —
      // and only once this slot is already consumed.
      if (this.disposed) return;
      if (terminalReason(this.task) !== null) return;
      if (!enabled(this.selfCheckMs) || this.checkedEpisode === this.episode) return;
      this.scheduleSelfCheck();
    }, delay);
    // `unref` where the platform supports it: a pending self-check must not be a reason
    // for the process to stay alive.
    if (handle !== null && typeof handle === 'object' && typeof handle.unref === 'function') handle.unref();
    slot.id = handle;
    this.selfCheckTimer = slot;
  }

  /**
   * Clear one specific timer handle, ignoring a failure.
   * @param {{ id: unknown }} slot - the slot whose timer should be cancelled.
   * @returns {void}
   */
  clearTimerOf(slot) {
    try {
      this.clearTimer(slot.id);
    } catch {
      // A timer that cannot be cleared is already gone; the slot is what matters.
    }
  }

  /**
   * Clear the scheduled self-check, if any. Idempotent.
   * @returns {void}
   */
  clearSelfCheckTimer() {
    const armed = this.selfCheckTimer;
    if (armed === null) return;
    this.selfCheckTimer = null;
    this.clearTimerOf(armed);
  }

  /**
   * The last self-check diagnostic, or null when none ever ran.
   * @returns {object | null} diagnostic.
   */
  lastSelfCheck() {
    return this.selfCheck.checkedAt === null ? null : this.selfCheck;
  }

  /**
   * Build the read-only diagnostic for the current episode.
   *
   * It states the TWO facts a reminder must keep apart, and never merges them:
   *
   *  1. `noDeliveryForMs` / `noDeliveryMinutes` — how long NOTHING new was delivered back
   *     to the commander. Internal model output, tool receipts and heartbeats do not move
   *     this clock; only a real delivery to the commander does.
   *  2. `detail.activity` — what DSH is doing right now, from the same bounded activity
   *     facts the task page uses (phase, open tool, counters). "I am working" and "I have
   *     told the commander nothing for 41 minutes" are both true at once, and an operator
   *     needs both sentences rather than one blended one.
   * @param {number} at - reference time.
   * @param {number} episode - episode identity.
   * @returns {object} bounded diagnostic.
   */
  inspect(at, episode) {
    const task = this.task ?? {};
    const pending = task.permission?.pending ?? null;
    const span = this.activity.toolSpan(at);
    const nativeStarted = task.native?.started === true;
    const nativeSettled = task.native?.settled === true;
    // Both origins are bounded instants (see `runOrigin` / `progressOrigin`), so neither
    // can produce a nonsense duration from a host clock that disagrees with this one.
    const sinceStartMs = Math.max(0, at - this.runOrigin());
    const noDeliveryMs = Math.max(0, at - this.progressOrigin());
    let verdict;
    if (task.state === 'pending' || task.state === 'running') {
      if (pending !== null) verdict = 'waiting-for-permission';
      else if (span !== null) verdict = 'tool-running';
      else if (nativeStarted && !nativeSettled) verdict = 'executor-alive-silent';
      else if (!nativeStarted) verdict = 'executor-not-started';
      else verdict = 'idle-between-steps';
    } else {
      verdict = 'settled';
    }
    return {
      episode,
      checkedAt: at,
      sinceStartMs,
      noDeliveryMs,
      noDeliveryMinutes: Math.floor(noDeliveryMs / 60_000),
      verdict,
      detail: {
        state: typeof task.state === 'string' ? task.state : null,
        phase: typeof task.phase === 'string' ? task.phase : null,
        nativeStarted,
        nativeSettled,
        permissionPending: pending !== null,
        permissionRequestId: pending !== null && typeof pending.requestId === 'string' ? pending.requestId : null,
        phaseIsPermissionWait: task.phase === PHASE_AWAITING_PERMISSION,
        currentTool: span === null ? null : { name: span.name, callId: span.callId, elapsedMs: span.elapsedMs },
        lastActivityAt: this.activity.lastActivityAt,
        activityEvents: this.activity.activityEvents(),
        events: this.activity.totalEvents(),
        // The independent "what is DSH doing" field. A closed vocabulary plus the open
        // tool name, so it cannot become a transcript.
        activity: this.runActivity(at),
        // The independent "how long has nothing been returned" field, restated here so
        // the diagnostic can be read on its own.
        noDeliveryForMs: noDeliveryMs,
      },
    };
  }

  /**
   * What the run is currently doing, in a closed vocabulary.
   *
   * It describes the EXECUTOR, not the delivery: a run can be `model-working` while the
   * commander has heard nothing for an hour. Nothing here reads output, arguments or
   * files.
   * @param {number} [at] - reference time.
   * @returns {{ kind: string, currentTool: object | null }} bounded activity description.
   */
  runActivity(at = this.now()) {
    const task = this.task ?? {};
    const span = this.activity.toolSpan(at);
    let kind;
    if (task.state === 'pending') kind = 'queued';
    else if (task.state !== 'running') kind = 'settled';
    else if (task.permission?.pending !== null && task.permission?.pending !== undefined) kind = 'waiting-for-permission';
    else if (task.question?.pending !== null && task.question?.pending !== undefined) kind = 'waiting-for-answer';
    else if (span !== null) kind = 'tool-running';
    else if (this.activity.lastActivityAt !== null) kind = 'model-working';
    else kind = 'not-started';
    return {
      kind,
      currentTool: span === null ? null : { name: span.name, callId: span.callId, elapsedMs: span.elapsedMs },
    };
  }

  /**
   * Whether the current delivery interval is old enough for an attention report, ignoring
   * whether this interval was already reported.
   * @param {number} [at] - reference time.
   * @returns {boolean} true when the no-delivery span has reached the threshold.
   */
  attentionDue(at = this.now()) {
    return at - this.progressOrigin() >= this.attentionMs;
  }

  /**
   * The instant the run progress check is due, or `Infinity` while it is impossible.
   *
   * A disabled interval is never due. Otherwise it is `progressOrigin + attentionSeconds`;
   * once this interval has been reported, the value is `Infinity` (the recorded delivery
   * is kept for the view) and the loop never wakes for an instant that can no longer
   * produce an answer.
   * @returns {number} the next deliverable instant.
   */
  nextAttentionAt() {
    if (!enabled(this.attentionMs)) return Number.POSITIVE_INFINITY;
    const origin = this.progressOrigin();
    // Once THIS interval has been reported, no instant can produce a second answer for it. A
    // real delivery opens a NEW interval (a new origin), and that interval's instant is
    // reachable again.
    if (this.progressReported !== null && this.progressReported.origin === origin) {
      return Number.POSITIVE_INFINITY;
    }
    return origin + this.attentionMs;
  }

  /**
   * Whether the run progress check may be delivered at `at`, and atomically claims it
   * if so.
   *
   * The claim happens in the same synchronous step as the test, so two observers
   * reaching the threshold together cannot both return `attention`: the first
   * claims, the second observes the fresh interval record and keeps waiting.
   *
   * ONE report per DELIVERY INTERVAL. The interval is the consecutive time with nothing
   * delivered back to the commander, measured from its origin — so a run that keeps
   * producing internal work while the commander hears nothing still reaches it, and one
   * interval can never be reported twice. The record this claim writes is the report itself,
   * never a delivery: it does not move {@link progressOrigin}, and the next interval begins
   * only when a genuine delivery arrives.
   * @param {number} [at] - delivery instant.
   * @returns {boolean} true for the observer that won the claim.
   */
  claimAttention(at = this.now()) {
    if (!enabled(this.attentionMs)) return false;
    const origin = this.progressOrigin();
    // Already reported for THIS interval: nothing new to say.
    if (this.progressReported !== null && this.progressReported.origin === origin) return false;
    if (at - origin < this.attentionMs) return false;
    return this.claimAttentionAt(origin, at);
  }

  // -------------------------------------------------------------------------
  // The two reminders: two SEPARATE clocks, each a REPORT worth acting on
  // -------------------------------------------------------------------------
  //
  // They are measured differently on purpose, and neither is gated on the run's total
  // duration:
  //
  //   * `selfCheckSeconds` (default 10 min) — ONE read-only local inspection, armed from
  //     the instant DSH really started running the task (`runOrigin`). A busy run is
  //     inspected too: the product asks for that look, not for a long silence.
  //   * `attentionSeconds` (default 40 min) — ONE notification to the commander asking it
  //     to check the run's progress, armed from the last genuine DELIVERY to the
  //     commander (`progressOrigin`).
  //
  // What moves the 40-minute clock: ONLY a new, effective result that TaskBridge actually
  // handed back to the commander. What does NOT move it — exhaustively, because each of
  // these was a way to hide a stuck delivery:
  //
  //   * the run's own START — it opens the FIRST interval (the baseline), it is not a return;
  //   * the LOCAL self-check diagnostic, on any answer, including a plain heartbeat: reading
  //     facts the plugin already holds is not work returned to anyone, and letting it reset
  //     the clock would let the run's own inspection hide the stall it exists to notice;
  //   * DSH-internal model steps, streamed text, reasoning, tool calls and tool results
  //     (they keep `idleOrigin`, the "how silent is the executor" measure, separate);
  //   * heartbeats, empty polls, `wait-limit`, page refreshes and a plain state read;
  //   * permission and ordinary-question waits;
  //   * the repeated-failure reminder, and the 40-minute check itself.
  //
  // The protocol has to be honest about one limitation: there is no mid-run stage result in
  // it. {@link observe} delivers the run's result when the task ENDS; nothing in between is
  // handed to the commander. So this build advances the clock only on the terminal outcome,
  // plus one reserved, INTERNAL, event-deduplicated entry point for a real stage result that
  // a future producer could confirm ({@link noteStageResult}, unused by this build and
  // covered by its own test). Neither invents a delivery, and no tool, assistant text or
  // diagnostic is ever passed off as one.

  /**
   * The instant DSH demonstrably STARTED running this task, or `null` when it has not.
   *
   * `runStartedAt` is the engine's own stamp at the one place it starts driving the run —
   * expressed in the clock this monitor reads — and it is preferred. `startedAt` is the
   * wall-clock fallback for a record built without that stamp (a fixture, or a record
   * restored before the engine drove it).
   *
   * Waiting in a queue, creating the DSH Session and having the request acknowledged are
   * all BEFORE that instant, so none of them can arm the ten-minute inspection.
   *
   * The value is only usable if THIS monitor's clock can compare with it: a start in the
   * future (a frozen or offset clock) or one so old that the threshold looks long spent is
   * not a real elapsed time, and `null` is the honest answer — nothing is scheduled or
   * reported until real evidence of execution arrives.
   * @returns {number | null} epoch milliseconds, or null.
   */
  runOrigin() {
    const now = this.now();
    for (const candidate of [this.task?.runStartedAt, this.task?.startedAt]) {
      if (!Number.isFinite(candidate) || candidate <= 0) continue;
      if (candidate > now || now - candidate > MAX_PLAUSIBLE_IDLE_MS) return null;
      return candidate;
    }
    return null;
  }

  /**
   * The instant the current delivery interval began.
   *
   * That is the last genuine delivery to the commander, or the run's own start when
   * nothing has been delivered yet — a run that never delivered anything is "not returned
   * for" its whole life, which is exactly what the commander must be told. Before the run
   * has started, `now` is used so the interval is a zero-length fact rather than a
   * measurement of the queue.
   *
   * A finished run freezes it at the recorded end (`deliveredAtMs`), exactly like every
   * other elapsed value: "nothing returned for 40 minutes" must not keep growing after the
   * run stopped and nobody could have been told anything.
   * @returns {number} epoch milliseconds.
   */
  progressOrigin() {
    if (this.deliveredAtMs !== null) return this.deliveredAtMs;
    // A terminal run cannot deliver anything more, so its interval is frozen at the recorded
    // end. This is read from the RECORD rather than only from `dispose`, so the values are
    // frozen the moment the run ends — before any persist, view or wait reads them.
    if (terminalReason(this.task) !== null) {
      const endedAt = this.task?.endedAt;
      if (Number.isFinite(endedAt)) {
        this.freezeDelivery(endedAt);
        return this.deliveredAtMs;
      }
    }
    const delivered = this.attentionDelivered;
    if (delivered !== null) return delivered.delivery;
    // Before the run has started there is no interval to measure, and the RUN'S START is where
    // the FIRST interval begins — so a monitor that did not see the start (it may be created
    // by an observation while the task is still `pending`) adopts that same origin as soon as
    // it can read it.
    //
    // Every instant a caller passes to a delivery entry point is measured on THIS monitor's
    // clock, so the origin always belongs to the same time base. That is what lets the first
    // real delivery open a genuinely new interval instead of being refused as "already passed".
    return this.runOrigin() ?? this.now();
  }

  /**
   * Whether the run progress check has already been reported for the current interval.
   * @returns {boolean} true when this interval's one report is spent.
   */
  progressReported() {
    return this.progressReported !== null && this.progressReported.origin === this.progressOrigin();
  }

  /**
   * Claim one interval's progress check AT a specific instant, without recursing.
   *
   * The claim is bound to the interval's ORIGIN, so the same interval can never be reported
   * twice however often this is called, and a later interval (opened by a real delivery) is
   * unaffected. It writes the report latch only — never the delivery record: a report is not
   * a delivery, and a delivery is not a report.
   * @param {number} origin - the interval origin.
   * @param {number} at - the instant to judge at.
   * @returns {boolean} whether the check was claimed.
   */
  claimAttentionAt(origin, at = this.now()) {
    if (!enabled(this.attentionMs)) return false;
    if (this.progressReported !== null && this.progressReported.origin === origin) return false;
    if (at - origin < this.attentionMs) return false;
    this.progressReported = { origin, at };
    return true;
  }

  /**
   * Count one REAL delivery to the commander and open the next interval.
   *
   * A delivery is a result the commander did not have before. In THIS protocol that means the
   * run's terminal outcome (and, once a producer exists, a stage result through
   * {@link noteStageResult}). A local self-check diagnostic, internal model/tool activity, a
   * heartbeat, an empty poll, an approval or question wait, the progress check itself and the
   * run's own start are NOT deliveries: if any of them opened a new interval, polling or the
   * run's own inspection would postpone the reminder it exists to raise.
   *
   * Three rules keep the clock honest:
   *
   *  * an instant that does not move past the current interval's origin (including the run's
   *    start, which opens the FIRST interval) is refused as `opening-interval`/`stale`;
   *  * a `stale` confirmation is refused explicitly and changes nothing;
   *  * the result is IDEMPOTENT per interval: two confirmations between the same two
   *    deliveries advance the clock ONCE.
   * @param {number} [at] - the delivery instant.
   * @param {object} [options] - `stale` for a confirmation known to be superseded.
   * @returns {{ counted: boolean, delivery: number, reason: string | null }} result.
   */
  noteDelivery(at = this.now(), options = {}) {
    const current = this.progressOrigin();
    if (options.stale === true) {
      return { counted: false, delivery: current, reason: 'stale' };
    }
    const instant = Number.isFinite(at) ? at : this.now();
    // A delivery must be dated AFTER the interval it opens. This check comes first, so every
    // refusal states the real reason (`opening-interval` / `stale`) instead of hiding behind the
    // per-interval duplicate below: an instant at or before the origin is not inside this
    // interval at all, it is the interval's own starting point.
    if (instant < current || (this.attentionDelivered === null && instant <= current)) {
      return {
        counted: false,
        delivery: current,
        reason: this.attentionDelivered === null ? 'opening-interval' : 'stale',
      };
    }
    // IDEMPOTENT per interval: a second confirmation for the SAME interval must not advance the
    // clock again. "Same interval" means the origin the last delivery opened is still the current
    // origin AND the confirmation is not dated later than that delivery — i.e. it describes the
    // interval that is already open. A confirmation dated after it belongs to the next interval
    // and must be able to open it.
    const opened = this.attentionDelivered;
    if (opened !== null && this.deliveryCountedInterval === current && instant <= opened.delivery) {
      return { counted: false, delivery: current, reason: null };
    }
    this.attentionDelivered = { delivery: instant, origin: instant, at: instant };
    this.deliveryCountedInterval = instant;
    this.deliveries += 1;
    // A new interval begins HERE, so its one report is unspent. The latch is keyed by the
    // interval origin, so it already reads as unspent — clearing it explicitly keeps the two
    // records impossible to contradict.
    this.progressReported = null;
    return { counted: true, delivery: instant, reason: null };
  }

  /**
   * The INTERNAL entry point for a stage result that was really handed to the commander.
   *
   * This is the only way a mid-run result can advance the clock, and it is deliberately
   * minimal and closed:
   *
   *  * it reads an opaque `eventId` and a `deliveredAt` instant, and NOTHING else — no content,
   *    no prose, no diagnostics, so no transcript can travel through it;
   *  * a stage result is counted AT MOST ONCE BY ITS EVENT: replaying the same `eventId` is a
   *    duplicate and moves nothing, whatever instant the replay carries;
   *  * it is accepted only for an event that already happened (`deliveredAt`); a missing or
   *    unusable value is refused, because an unconfirmed result is not news anyone received;
   *  * it is NOT an MCP argument, a tool schema, a settings field or a client route — no
   *    public interface is widened by it.
   *
   * Nothing in this build produces such a stage result: the wait channel delivers the run's
   * result when the task ENDS. A caller that later has one (a real host-side delivery) may
   * confirm it here; tests drive this seam directly, which is what proves the rule.
   * @param {{ eventId?: unknown, deliveredAt?: unknown } | null} stage - the delivered stage result.
   * @returns {{ counted: boolean, delivery: number | null, reason: string | null }} result.
   */
  noteStageResult(stage) {
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
      return { counted: false, delivery: null, reason: 'stage-required' };
    }
    const eventId = typeof stage.eventId === 'string' && stage.eventId !== '' ? stage.eventId : null;
    if (eventId === null) {
      return { counted: false, delivery: null, reason: 'event-id-required' };
    }
    const at = stage.deliveredAt;
    if (!Number.isFinite(at) || at <= 0) {
      return { counted: false, delivery: null, reason: 'delivery-instant-required' };
    }
    // Per-event deduplication: ONE stage result advances the clock once, however often it is
    // replayed or retried. The set is bounded, and only event identities are kept.
    if (this.stageEvents.has(eventId)) {
      return { counted: false, delivery: this.progressOrigin(), reason: 'duplicate' };
    }
    const result = this.noteDelivery(at);
    if (result.counted === true) {
      this.stageEvents.add(eventId);
      while (this.stageEvents.size > MAX_TRACKED_STAGE_EVENTS) {
        const oldest = this.stageEvents.values().next();
        if (oldest.done === true) break;
        this.stageEvents.delete(oldest.value);
      }
    }
    // The refusal reason is passed through, so a caller can tell "counted", "duplicate" and
    // "stale instant" apart instead of reading `counted: false` blindly.
    return { counted: result.counted, delivery: result.delivery, reason: result.reason };
  }

  /**
   * Build the bounded diagnostic carried by the run progress check.
   *
   * Everything here is a fact the engine already holds: how long nothing was delivered to
   * the commander, what the run is doing, how long it has existed, the phase, the open tool
   * (if any) and the self-check verdict. There is no model text, no diff, no file content
   * and no review prose, so a check can never become a second, larger wait answer.
   * @param {number} at - reference time.
   * @returns {object} bounded diagnostic.
   */
  progressCheckpoint(at = this.now()) {
    const noDeliveryMs = Math.max(0, at - this.progressOrigin());
    return {
      kind: CHECKPOINTS.progress,
      thresholdMs: this.attentionMs,
      thresholdSeconds: Math.round(this.attentionMs / 1000),
      // Field one: how long NOTHING new reached the commander.
      noDeliveryMs,
      noDeliveryMinutes: Math.floor(noDeliveryMs / 60_000),
      lastDeliveryAt: this.attentionDelivered === null ? null : this.attentionDelivered.at,
      deliveries: this.deliveries,
      // Context only: a long run is not a reminder on its own.
      runElapsedMs: Math.max(0, at - (this.runOrigin() ?? at)),
      ...this.checkpointFacts(at),
      // Stated once, machine-readably, so a host never has to infer from prose that
      // this reminder did not touch the run.
      runContinues: true,
    };
  }

  /**
   * The bounded facts a checkpoint reports, shared by every level of the view.
   *
   * At the instant a checkpoint fires no self-check has necessarily run yet (a busy run
   * reaches the delivery threshold long after its ten-minute inspection, and a disabled
   * self-check never runs at all), so the failure a reader would otherwise take for "we
   * inspected and found nothing" is avoided by publishing the verdict verbatim — `null`
   * means "not inspected", which is the honest answer.
   *
   * Two field groups are kept apart on purpose: `noDeliveryForMs` says how long nothing
   * reached the commander, and `activity` says what DSH is doing. A run that is actively
   * working has BOTH a long `noDeliveryForMs` and `activity.kind: "model-working"`, and an
   * operator must see both rather than one blended sentence.
   * @param {number} at - reference time.
   * @returns {object} bounded facts.
   */
  checkpointFacts(at = this.now()) {
    const task = this.task ?? {};
    const pending = task.permission?.pending ?? null;
    const span = this.activity.toolSpan(at);
    return {
      state: typeof task.state === 'string' ? task.state : null,
      phase: typeof task.phase === 'string' ? task.phase : null,
      // Field one, at the top level, so no reader has to know where to look. Measured
      // against the reference instant this view was asked for, and never at the wall clock,
      // so a settled run reports the frozen span its reader asked about.
      noDeliveryForMs: Math.max(0, at - this.progressOrigin()),
      // Field two: what the run is doing right now, in a closed vocabulary.
      activity: this.runActivity(at),
      // The executor-side measure, kept separate from the delivery clock: a long tool
      // call is described as an open call, not as idleness.
      lastActivityAt: this.activity.lastActivityAt,
      idleForMs: this.activity.idleForMs(at),
      currentTool: span === null ? null : { name: span.name, callId: span.callId, elapsedMs: span.elapsedMs },
      waitingOn: span === null ? 'idle' : 'tool',
      activityEvents: this.activity.activityEvents(),
      events: this.activity.totalEvents(),
      selfCheckVerdict: this.selfCheck.verdict,
      permissionPending: pending !== null,
    };
  }

  /**
   * Publishable activity summary for a task view.
   *
   * `toolActive` is passed by the caller because only the engine can decide what a
   * long tool span means: a pending permission request already reports its own
   * reason, and a settled run is not "waiting on a tool" at all.
   * @param {object} [options] - `at` reference time, `toolActive`.
   * @returns {object} bounded summary.
   */
  snapshot({ at = this.now(), toolActive = false } = {}) {
    const summary = this.activity.summary({ at, toolActive });
    const noDeliveryMs = Math.max(0, at - this.progressOrigin());
    return {
      ...summary,
      // Stated so a reader never has to derive the thresholds from a settings
      // document that may have changed since this task froze its own. `0` means the
      // reminder is switched off for this run. `attentionSeconds` is the run progress
      // check: the ONE notification interval this product has.
      selfCheckSeconds: Math.round(this.selfCheckMs / 1000),
      attentionSeconds: Math.round(this.attentionMs / 1000),
      // The self-check, described exactly as the timer arms it: measured from the real
      // start of execution, ONCE per run, and never due before the run started. When the
      // record carries a start this monitor's clock cannot compare with, the instant is
      // stated as `null` — "no usable start" is the honest answer, and it is checked
      // BEFORE adding, so `NaN` can never leak into a view.
      selfCheckDueAt: enabled(this.selfCheckMs) && this.runOrigin() !== null
        ? this.runOrigin() + this.selfCheckMs
        : null,
      // The run progress check, described in the same bounded terms the reminder itself
      // uses, so the task page and a wait answer agree without either reading a settings
      // document. There is no separate cadence and no total-runtime clock.
      progressCheck: {
        thresholdSeconds: Math.round(this.attentionMs / 1000),
        // Field one: consecutive time with NOTHING delivered to the commander.
        noDeliveryForMs: noDeliveryMs,
        noDeliveryMinutes: Math.floor(noDeliveryMs / 60_000),
        lastActivityAt: this.activity.lastActivityAt,
        lastDeliveryAt: this.attentionDelivered === null ? null : this.attentionDelivered.at,
        deliveries: this.deliveries,
        reportedThisEpisode: this.progressReported !== null && this.progressReported.origin === this.progressOrigin() && enabled(this.attentionMs),
        nextDueAt: Number.isFinite(this.nextAttentionAt()) ? this.nextAttentionAt() : null,
        ...this.checkpointFacts(at),
      },
      idleForMs: this.activity.idleForMs(at),
      selfCheck: {
        episode: this.selfCheck.episode,
        checkedAt: this.selfCheck.checkedAt,
        verdict: this.selfCheck.verdict,
        // Both independent fields, straight from the diagnostic.
        sinceStartMs: this.selfCheck.sinceStartMs ?? null,
        noDeliveryForMs: this.selfCheck.noDeliveryForMs ?? null,
      },
      // The repeated-failure reminder, as bounded evidence: one small object per
      // reported episode, never arguments, output or error prose.
      repeatFailure: {
        threshold: this.failures.threshold,
        // Projected field by field, so the internal episode sequence cannot reach a view,
        // a stored record or a client.
        reported: this.failures.reported.map((entry) => ({
          kind: entry.kind,
          eventId: entry.eventId,
          toolName: entry.toolName,
          failureCode: entry.failureCode,
          operationDigest: entry.operationDigest,
          consecutive: entry.consecutive,
          threshold: entry.threshold,
          firstSeenAt: entry.firstSeenAt,
          lastSeenAt: entry.lastSeenAt,
        })),
      },
    };
  }

  /**
   * Release every waiter this monitor owns. Called only by {@link dispose}.
   *
   * Each waiter aborts its own controller; one observation ending never touches
   * another.
   * @returns {void}
   */
  releaseWaiters() {
    for (const waiter of [...this.waiters]) {
      try {
        waiter.controller.abort();
      } catch {
        // Abort is idempotent.
      }
    }
    this.waiters.clear();
  }

  /**
   * The bounded observation wait documented for adapters (HTTP/MCP).
   *
   * What it reports, in precedence order, re-checked on every slice:
   *
   *  1. `interrupted` — this observer's own signal aborted, or the monitor was
   *     disposed. The WORKER is untouched;
   *  2. `ready`/`failed`/`cancelled` — the task reached a terminal state. This wins
   *     over a disposal wake, so an observation released by engine teardown still
   *     reports the outcome the run actually reached;
   *  3. `permission` / `question` — a human decision is outstanding. Waiting for an
   *     answer is not a stall;
   *  3b. `attention` with `checkpoint: "failure"` — the repeated-tool-failure reminder.
   *     Independent of any clock: a busy run can fail the same call over and over;
   *  4. `attention` with `checkpoint: "progress"` — the run has DELIVERED nothing new to
   *     the commander for `attentionSeconds` (default 40 minutes) and the claim for this
   *     delivery interval was won. DSH-internal model steps, text, tool activity,
   *     heartbeats, the self-check and this very check never count as a delivery, so a
   *     run that is visibly busy can still reach it — and one interval produces at most
   *     one report;
   *  5. `heartbeat` — the bounded wait expired with nothing to report.
   *
   * The self-check runs inside the loop AND on its own scheduled timer (see
   * {@link scheduleSelfCheck}): an observation finds it already done for this run when no
   * caller was waiting, and a run with no observer at all is still inspected. The diagnostic
   * it produces travels on the answer as a READ of local facts; it is not a delivery and does
   * not advance the 40-minute clock. Neither does a heartbeat, an empty poll, a `wait-limit`,
   * a permission/question wait, a failure reminder or the check itself — this channel
   * delivers the run's result when the task ENDS, and nothing before that is a result. A real
   * stage result could only arrive through {@link noteStageResult}.
   * Every caller gets its own controller and timer, so an observation never cancels
   * another.
   * @param {object} [options] - `waitMs`, `signal`.
   * @returns {Promise<{ reason: string, checkpoint: string | null, activitySinceWait: boolean, waitedMs: number, selfCheck: object | null }>} outcome.
   */
  async observe(options = {}) {
    const signal = options.signal ?? null;
    // A terminal outcome is a READ of the task record, so it is answered even by a
    // disposed monitor: engine teardown stops the observation loops, but it must
    // never turn a finished run into "interrupted".
    const settledNow = terminalReason(this.task);
    if (settledNow !== null) return this.outcome(settledNow, false, 0, this.lastSelfCheck());
    if (this.disposed) return this.outcome(OBSERVE_REASONS.interrupted, false, 0, null);
    if (signal !== null && signal.aborted === true) return this.outcome(OBSERVE_REASONS.interrupted, false, 0, null);

    const waitMs = boundedWait(options.waitMs);
    const startedAt = this.now();
    const startingSequence = this.activity.sequence;
    const waiter = { controller: new AbortController() };
    this.waiters.add(waiter);
    const onAbort = () => {
      try {
        waiter.controller.abort();
      } catch {
        // Unreachable; abort is idempotent.
      }
    };
    if (signal !== null) signal.addEventListener?.('abort', onAbort, { once: true });

    let selfCheck = null;
    try {
      for (;;) {
        const at = this.now();
        const activitySinceWait = this.activity.sequence !== startingSequence;
        // A pure read of local facts, run BEFORE any reason is returned so every
        // report carries the diagnostic that explains the run's state.
        const checked = this.runSelfCheck(at);
        if (checked !== null) selfCheck = checked;

        // (2) The run's own outcome outranks a wake-up: a task that ended must be
        // reported as ended even if the monitor was disposed in the same instant. The
        // outcome is a delivery only when THIS answer is the one that releases it, and the
        // engine decides that at the single place an answer is built (`observationOf`) — a
        // monitor-level pre-answer would claim a delivery nobody necessarily received.
        const terminal = terminalReason(this.task);
        if (terminal !== null) {
          return this.outcome(terminal, activitySinceWait, at - startedAt, selfCheck);
        }

        // (1) Only one's OWN abort (or disposal) interrupts.
        if (this.disposed || waiter.controller.aborted === true || (signal !== null && signal.aborted === true)) {
          return this.outcome(OBSERVE_REASONS.interrupted, activitySinceWait, at - startedAt, selfCheck);
        }

        // A permission or question wait is NOT a delivery of progress: the commander is
        // being asked something, and the 40-minute interval must keep running so a task
        // that is blocked on a human is still reported as "not returned for X minutes".
        if (this.task?.permission?.pending !== null && this.task?.permission?.pending !== undefined) {
          return this.outcome(OBSERVE_REASONS.permission, activitySinceWait, at - startedAt, selfCheck);
        }
        if (this.task?.question?.pending !== null && this.task?.question?.pending !== undefined) {
          // A question is checked with the same precedence as a permission (and AFTER it, so
          // the one wait that can grant is reported first): the worker is paused on a human
          // and the host must act now. The self-check above still runs, but it can never
          // turn this into `attention`.
          return this.outcome(OBSERVE_REASONS.question, activitySinceWait, at - startedAt, selfCheck);
        }
        // (3b) Repeated failures. Same reason as the progress check — it needs the
        // commander — but it carries its own typed diagnostic and is NOT gated on the
        // delivery clock: a busy run that keeps failing the same operation must still
        // reach the host. Permission and a terminal state above outrank it. It is not a
        // delivery of progress either: a reminder is not a new result.
        const failure = this.claimFailureReport();
        if (failure !== null) {
          return this.outcome(OBSERVE_REASONS.attention, activitySinceWait, at - startedAt, selfCheck, failure, CHECKPOINTS.failure);
        }
        // (4) The run progress check, measured on the DELIVERY clock (see
        // `progressOrigin`): it fires at most once per delivery interval and asks the
        // commander to check the run — it never cancels, restarts or resubmits anything,
        // and reporting it does NOT advance the clock.
        //
        // It is CLAIMED at the instant it became due (bounded by this reading), because a
        // single bounded wait routinely spans that instant: a caller must be told as soon as
        // the wait ends instead of keeping quiet. The diagnostic is still reported at THIS
        // reading, so the span it states is the time that has really passed.
        const dueAt = this.nextAttentionAt();
        if (Number.isFinite(dueAt) && dueAt <= at && this.claimAttention(dueAt)) {
          return this.outcome(
            OBSERVE_REASONS.attention,
            activitySinceWait,
            at - startedAt,
            selfCheck,
            null,
            CHECKPOINTS.progress,
            this.progressCheckpoint(at),
          );
        }
        const elapsed = at - startedAt;
        if (elapsed >= waitMs) {
          // A heartbeat is nothing new: it is explicitly NOT a delivery, so the
          // 40-minute clock is untouched by a commander that polls.
          return this.outcome(OBSERVE_REASONS.heartbeat, activitySinceWait, elapsed, selfCheck);
        }
        // Wake for the next reminder the run could actually produce. A disabled reminder
        // contributes `Infinity`, so "off" cannot make the slice shorter.
        //
        // The slice is a TIME TO WAIT, so it is floored at 1 ms even when the next reminder
        // is already due: waking in the same millisecond would spin on a due instant the loop
        // is about to handle, which is how an interval could be claimed between two readings.
        const untilNext = Math.max(1, this.nextAttentionAt() - at);
        const slice = Math.max(1, Math.min(this.waitSliceMs, waitMs - elapsed, untilNext));
        try {
          await this.wait(slice, { signal: waiter.controller.signal });
        } catch {
          // A wait seam that rejects ends THIS observation only. The worker and
          // every other observer are untouched.
          return this.outcome(OBSERVE_REASONS.interrupted, activitySinceWait, this.now() - startedAt, selfCheck);
        }
      }
    } finally {
      this.waiters.delete(waiter);
      if (signal !== null) signal.removeEventListener?.('abort', onAbort);
    }
  }

  /**
   * Build one observation outcome.
   * @param {string} reason - reported reason.
   * @param {boolean} activitySinceWait - whether progress arrived during the wait.
   * @param {number} waitedMs - observed duration.
   * @param {object | null} selfCheck - the last self-check diagnostic.
   * @param {object | null} [failure] - the repeated-failure diagnostic, when that is
   *   what ended the wait.
   * @param {string | null} [checkpoint] - which `attention` reminder this is
   *   (`progress`/`stall`/`failure`), or null for a reason that is not one.
   * @param {object | null} [progress] - the bounded progress-checkpoint diagnostic.
   * @returns {object} outcome.
   */
  outcome(reason, activitySinceWait, waitedMs, selfCheck, failure = null, checkpoint = null, progress = null) {
    return {
      reason,
      // Only an `attention` reason has a checkpoint; stating one for any other reason
      // would invite a host to act on a reminder that was never made.
      checkpoint: reason === OBSERVE_REASONS.attention ? checkpoint : null,
      failure,
      progress,
      activitySinceWait: activitySinceWait === true,
      waitedMs: Math.max(0, Math.trunc(waitedMs)),
      selfCheck,
    };
  }

  /**
   * Publish the bounded delivery state, and count a delivery the ENGINE confirmed.
   *
   * Two things in one place so the engine never has to know how the interval is derived:
   *
   *  * it reports how long the current interval is (`noDeliveryForMs`) and what the run is
   *    doing (`activity`), which is exactly the pair of independent fields the reminder
   *    must state;
  /**
   * Publish the bounded delivery state, and count the ONE delivery the engine can name.
   *
   * Two things in one place so the engine never has to know how the interval is derived:
   *
   *  * it reports how long the current interval is (`noDeliveryForMs`) and what the run is
   *    doing (`activity`) — exactly the pair of independent fields the reminder must state;
   *  * when the engine passes `delivered: true`, the run reached its terminal outcome, which
   *    IS the result the commander receives, so the clock advances once and `counted` says so.
   *    Every other answer — a heartbeat, an empty poll, a self-check diagnostic, a permission
   *    or question wait, a failure reminder, the progress check itself — counts nothing.
   * @param {object} [options] - `at`, `delivered`.
   * @returns {{ noDeliveryForMs: number, noDeliveryMinutes: number, lastDeliveryAt: number | null,
   *   deliveries: number, activity: object, counted: boolean, countReason: string | null }} delivery state.
   */
  delivery({ at = this.now(), delivered = false } = {}) {
    const noted = delivered === true ? this.noteDelivery(at) : null;
    const noDeliveryMs = Math.max(0, at - this.progressOrigin());
    return {
      noDeliveryForMs: noDeliveryMs,
      noDeliveryMinutes: Math.floor(noDeliveryMs / 60_000),
      lastDeliveryAt: this.attentionDelivered === null ? null : this.attentionDelivered.at,
      deliveries: this.deliveries,
      activity: this.runActivity(at),
      counted: noted !== null && noted.counted === true,
      countReason: noted === null ? null : noted.reason,
    };
  }

  /**
   * Freeze every elapsed value — including the delivery interval — at the run's end.
   *
   * Called once by {@link dispose}, so a stored record reports the spans the run really
   * had. The delivery interval is frozen only if it is not already frozen.
   * @param {number} endedAt - the recorded end instant.
   * @returns {void}
   */
  freezeDelivery(endedAt) {
    if (this.deliveredAtMs !== null) return;
    if (!Number.isFinite(endedAt)) return;
    this.deliveredAtMs = endedAt;
  }

  /**
   * Drop every listener/timer this monitor owns. Idempotent.
   *
   * Marking the activity final first freezes the elapsed values at the end
   * recorded on the task, so nothing published afterwards grows.
   * @param {number} [endedAt] - the run's recorded end, when known.
   * @returns {void}
   */
  dispose(endedAt = undefined) {
    if (typeof endedAt === 'number') {
      this.activity.finalize(endedAt);
      // A finished run can deliver nothing more, so its delivery interval stops being
      // measured at the recorded end instead of reporting a wait nobody could shorten.
      this.freezeDelivery(endedAt);
    }
    if (this.disposed) return;
    this.disposed = true;
    // The scheduled self-check goes with the run: a disposed monitor leaves no timer.
    this.clearSelfCheckTimer();
    // Open calls can never produce a result for a run that has ended; the reported
    // trail stays as bounded evidence. The undelivered reminder is dropped with it.
    this.failures.dispose();
    this.pendingFailure = null;
    this.ackedEventId = null;
    this.releaseWaiters();
  }
}

/**
 * Whether one internal reason may be handed to a caller.
 * @param {string} reason - reason value.
 * @returns {boolean} true when a caller should receive it.
 */
export function isPublicReason(reason) {
  return typeof reason === 'string' && Object.values(OBSERVE_REASONS).includes(reason) && !INTERNAL_REASONS.has(reason);
}

/**
 * The reason a task's current state implies, or null while it is still running.
 * @param {object} task - engine task record.
 * @returns {string | null} reason.
 */
export function terminalReason(task) {
  const state = task?.state;
  if (typeof state !== 'string') return null;
  return TERMINAL_REASON[state] ?? null;
}

/**
 * Clamp a caller-requested wait to the documented bound.
 * @param {unknown} waitMs - requested wait.
 * @returns {number} a whole number of milliseconds within bounds.
 */
function boundedWait(waitMs) {
  if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs <= 0) return 25_000;
  return Math.min(25_000, Math.max(1, Math.trunc(waitMs)));
}

/**
 * Convert a validated seconds threshold to milliseconds.
 *
 * Three cases, deliberately distinct:
 *  * a missing/invalid value takes the documented default — a monitor built without
 *    a threshold must behave like the configured default, not like "off";
 *  * `0` (or a negative value) is DISABLED and becomes `0` ms, which every caller
 *    treats as "this reminder never fires";
 *  * any other whole number of seconds becomes that many milliseconds.
 * @param {unknown} value - seconds.
 * @param {number} fallbackSeconds - documented default.
 * @returns {number} milliseconds, `0` meaning disabled.
 */
function thresholdToMs(value, fallbackSeconds) {
  const seconds = Number.isSafeInteger(value) ? value : fallbackSeconds;
  if (seconds <= 0) return 0;
  return seconds * 1000;
}

/** Whether a milliseconds threshold is enabled. */
function enabled(ms) {
  return Number.isFinite(ms) && ms > 0;
}

/**
 * The longest delay a `setTimeout` honours on both Node and the browser (~24.8 days).
 *
 * A longer delay is a platform-dependent overflow (Node clamps it to 1 ms), so it is never
 * passed to the timer: see the poll in {@link TaskMonitor#scheduleSelfCheck}.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Short poll used only when the threshold is further away than a timer can express. */
const SELF_CHECK_POLL_MS = 60_000;

/**
 * How close an armed instant must be to the monitor's own clock to be treated as an epoch
 * instant a real platform timer can be given.
 *
 * A production monitor reads `Date.now()`, so its due instant is an epoch millisecond and is
 * handed to `setTimeout` verbatim: a timer that fires late still records the check at the
 * instant the threshold was reached. A monitor built over an injected (arbitrary) clock has
 * an instant that means nothing to the platform timer, so it is not handed over at all and
 * the check is recorded at that clock's own reading instead.
 */
const MAX_EPOCH_DOMAIN_MS = 24 * 60 * 60 * 1000;

/**
 * The oldest recorded run start this monitor will measure silence from, relative to its
 * own clock.
 *
 * A task record carries its start from the HOST wall clock while the monitor reads its
 * injected clock. A difference beyond this is not a real elapsed time but two clocks that
 * disagree (a test's frozen clock, or a clock that moved); measuring from it would make a
 * fresh run look long silent. Past this bound the monitor measures from its own `now`,
 * which is the only instant it can honestly compare against.
 */
const MAX_PLAUSIBLE_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * Default wait seam: a real, unref'd timeout that honours an abort signal.
 *
 * `unref()` matters: an observation waiting on a timer must not by itself keep the
 * process alive, and the timer is cleared on abort so an abandoned observation
 * leaves nothing behind.
 * @param {number} ms - slice length.
 * @param {object} [options] - `signal`.
 * @returns {Promise<void>} resolves after the slice.
 */
export function sleep(ms, options = {}) {
  const signal = options?.signal ?? null;
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal !== null && signal.aborted === true) {
      rejectPromise(abortError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      cleanup();
      rejectPromise(abortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (signal !== null) signal.removeEventListener?.('abort', onAbort);
    };
    if (signal !== null) signal.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** @returns {Error} a DOM-shaped abort error. */
function abortError() {
  const error = new Error('the wait was aborted');
  error.name = 'AbortError';
  return error;
}

