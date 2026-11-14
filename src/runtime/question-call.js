// Which native `ask_user_question` call a pending question belongs to.
//
// An answer is delivered by RESUMING the paused tool call, so the bridge must know exactly
// which call that is. The rule is deliberately narrow, and it never searches for "some"
// call:
//
//  1. the request's own `wait.callId` is the declared identity (the native tool sets it);
//  2. that id must be found in the Session log as a `tool/call` whose name is
//     `ask_user_question`;
//  3. it must be the NEWEST such call: a repeated id is the live one, an older duplicate
//     is a finished turn;
//  4. it must have NO `tool/result` after it — a call that already returned is history, and
//     an answer delivered to it would resume nothing;
//  5. its turn must still be the OPEN turn. A call whose turn closed can only arrive as a
//     new turn, so an answer cannot be replayed onto it.
//
// A legacy request that carries no `wait` at all is bound only when the open turn holds
// exactly ONE live `ask_user_question` call: with one candidate the identity is proven, and
// with two it is ambiguous, which is a refusal rather than a guess.

/** The tool whose calls a question may bind to. */
export const QUESTION_TOOL_NAME = 'ask_user_question';

/**
 * Find one `tool/call` record by id, newest first.
 * @param {object} session - Session with `seq` and `eventAt`.
 * @param {string} callId - the id to find.
 * @returns {{ event: object, index: number } | null} the newest match.
 */
function findCall(session, callId) {
  for (let index = session.seq - 1; index >= 0; index -= 1) {
    const event = session.eventAt(index);
    if (event === null || typeof event !== 'object' || event.type !== 'tool/call') continue;
    if (event.data?.callId === callId) return { event, index };
  }
  return null;
}

/**
 * The index of the last `turn/start` with no `turn/end` after it, or `null`.
 * @param {object} session - Session with `seq` and `eventAt`.
 * @returns {number | null} the open turn's start offset.
 */
function openTurnStart(session) {
  for (let index = session.seq - 1; index >= 0; index -= 1) {
    const event = session.eventAt(index);
    if (event === null || typeof event !== 'object') continue;
    if (event.type === 'turn/end') return null;
    if (event.type === 'turn/start') return index;
  }
  return null;
}

/**
 * The tool-call id one `tool/result` event answers.
 *
 * DSH records the id under `data.message.toolCallId` (the result message carries the call it
 * belongs to); older/synthetic logs put it directly on `data.callId`. BOTH are read, because a
 * matcher that only knew one shape would report "no result yet" for a call that already
 * returned — and an answer would then be delivered to a finished call.
 * @param {object} event - a `tool/result` event.
 * @returns {string | null} the call id, or null when the event names none.
 */
function resultCallId(event) {
  const nested = event?.data?.message?.toolCallId;
  if (typeof nested === 'string' && nested !== '') return nested;
  const flat = event?.data?.callId;
  if (typeof flat === 'string' && flat !== '') return flat;
  return null;
}

/**
 * Whether a call at one offset has already produced a `tool/result`.
 * @param {object} session - Session with `seq` and `eventAt`.
 * @param {string} callId - the call id.
 * @param {number} fromIndex - the call's own offset.
 * @returns {boolean} true when a result was recorded after it.
 */
function hasResult(session, callId, fromIndex) {
  for (let index = fromIndex + 1; index < session.seq; index += 1) {
    const event = session.eventAt(index);
    if (event === null || typeof event !== 'object' || event.type !== 'tool/result') continue;
    if (resultCallId(event) === callId) return true;
  }
  return false;
}

/**
 * The live `ask_user_question` calls of the OPEN turn, oldest first.
 * @param {object} session - Session with `seq` and `eventAt`.
 * @param {number} turnStart - the open turn's start offset.
 * @returns {{ callId: string, seq: number, turn: number | null }[]} live calls.
 */
function liveCallsOfTurn(session, turnStart) {
  const calls = [];
  for (let index = turnStart; index < session.seq; index += 1) {
    const event = session.eventAt(index);
    if (event === null || typeof event !== 'object' || event.type !== 'tool/call') continue;
    const name = event.data?.name;
    const callId = event.data?.callId;
    if (name !== QUESTION_TOOL_NAME || typeof callId !== 'string' || callId === '') continue;
    if (hasResult(session, callId, index)) continue;
    calls.push({
      callId,
      seq: index,
      turn: typeof event.data?.turn === 'number' ? event.data.turn : null,
    });
  }
  return calls;
}

/**
 * Resolve the ONE native call a question belongs to.
 * @param {object} request - `session`, `declaredCallId` (from `request.wait.callId`), `toolName`.
 * @returns {{ ok: true, callId: string, seq: number, turn: number | null }
 *   | { ok: false, detail: string }} the binding, or why it is impossible.
 */
export function QUESTION_CALL_BINDING(request) {
  const session = request?.session ?? null;
  if (session === null || typeof session !== 'object'
    || typeof session.eventAt !== 'function' || !Number.isInteger(session.seq)) {
    return { ok: false, detail: 'the asking session keeps no readable log' };
  }
  const turnStart = openTurnStart(session);
  if (turnStart === null) {
    return { ok: false, detail: 'no turn is open, so the question belongs to no live call' };
  }
  const declared = typeof request?.declaredCallId === 'string' && request.declaredCallId !== ''
    ? request.declaredCallId
    : null;
  if (declared !== null) {
    const found = findCall(session, declared);
    if (found === null) return { ok: false, detail: 'the declared call id is not in the session log' };
    const name = found.event.data?.name;
    if (name !== QUESTION_TOOL_NAME) {
      return { ok: false, detail: `the declared call is a ${String(name)} call, not a question` };
    }
    if (found.index < turnStart) {
      return { ok: false, detail: 'the declared call belongs to an earlier turn' };
    }
    if (hasResult(session, declared, found.index)) {
      return { ok: false, detail: 'the declared call already produced a result' };
    }
    return {
      ok: true,
      callId: declared,
      seq: found.index,
      turn: typeof found.event.data?.turn === 'number' ? found.event.data.turn : null,
    };
  }
  // A legacy request names no call. It is bound only when the open turn holds exactly ONE
  // live question call: two candidates make the identity ambiguous, and a guess could
  // resume the wrong operation.
  const candidates = liveCallsOfTurn(session, turnStart);
  if (candidates.length === 0) {
    return { ok: false, detail: 'the open turn holds no live question call' };
  }
  if (candidates.length > 1) {
    return { ok: false, detail: `the open turn holds ${candidates.length} live question calls, so the binding is ambiguous` };
  }
  return { ok: true, ...candidates[0] };
}
