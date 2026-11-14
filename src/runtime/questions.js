// The per-run QUESTION bridge: ordinary `ask_user_question` calls from a delegated
// worker, surfaced to the commander as a decision it can actually answer.
//
// The native seam is the Agent-scoped Cordis waterfall `'user-questions/request'`
// (`@deepseek-ai/dsh-user-questions`):
//
//   request = { questions: [{ id, question, header?, detail?, options?, multiSelect?,
//                             intent? }], agent?, signal?, wait?: { callId, timed? } }
//   → { answers: [{ id, selected: string[], custom?: string }] }
//
// A question is NOT an approval: an `approval` intent is refused here so the permission
// bridge stays the only channel that can grant anything.
//
// Two properties carry most of the design:
//
//  * **The question is published WHOLE or refused.** A question set is only accepted if
//    its exact serialised form fits {@link QUESTION_BOUNDS.wireChars}, so no later layer
//    can shorten a question the commander is told it may answer. A set that cannot be
//    published intact is refused at once, with a code the worker can act on.
//  * **An answer is bound to a REAL native tool call.** The call id comes from the
//    request, is verified against the Session log, and is re-checked before the answer is
//    applied, so an answer can never be delivered to an expired or replaced call.

import { QUESTION_CALL_BINDING } from './question-call.js';
import { redactDeep } from '../config/redact.js';

/** What one question answerer may do, as a closed vocabulary. */
export const QUESTION_CODES = Object.freeze({
  unbound: 'QUESTION_UNBOUND',
  busy: 'QUESTION_BUSY',
  approvalIntent: 'QUESTION_APPROVAL_INTENT',
  answerInvalid: 'QUESTION_ANSWER_INVALID',
  questionNotFound: 'QUESTION_QUESTION_NOT_FOUND',
  questionSettled: 'QUESTION_QUESTION_SETTLED',
  notPending: 'QUESTION_NOT_PENDING',
  alreadyAnswered: 'QUESTION_ALREADY_ANSWERED',
  expired: 'QUESTION_EXPIRED',
  // The question set cannot be published whole, so it is refused instead of being shown
  // shortened. `QUESTION_PAYLOAD_TOO_LARGE` names the size bound explicitly.
  payloadTooLarge: 'QUESTION_PAYLOAD_TOO_LARGE',
  redacted: 'QUESTION_PAYLOAD_REDACTED',
  // The question's own identity (id) is missing, too long or duplicated.
  badIdentity: 'QUESTION_IDENTITY_INVALID',
  // No trustworthy native tool call could be bound to this question.
  noCall: 'QUESTION_CALL_UNVERIFIED',
  // The bound call is no longer live, so an answer must not be replayed onto it.
  callGone: 'QUESTION_CALL_GONE',
});

/** Where a pending question set puts the task. */
export const QUESTION_PHASE = Object.freeze({
  pending: 'awaiting-question',
});

/** Fixed refusal reasons, stable machine strings the commander sees verbatim. */
export const QUESTION_REASONS = Object.freeze({
  notArmed: 'the question bridge is not armed for this run',
  disposed: 'the question bridge was disposed, so no answer can be applied',
  foreignAgent: 'the question belongs to a different agent',
  busy: 'another question set is already pending for this run',
  approvalIntent: 'a question that presents an approval cannot be answered through the question channel',
  badBatch: 'the answer batch must name each asked question exactly once',
  unknownQuestion: 'the answer names a question that was not asked',
  unknownOption: 'the answer selects an option the question did not offer',
  tooManySelected: 'a single-select question takes exactly one option',
  noSelection: 'an answer must select an option or carry custom text',
  emptyCustom: 'custom text must be a non-empty string',
  longCustom: 'custom text exceeds the bound',
  expired: 'the question reached its deadline without an answer',
  cancelled: 'the asking tool withdrew the question',
  stop: 'the run stopped while the question was pending',
  dispose: 'the plugin was disposed while the question was pending',
  settled: 'the question set already settled',
  alreadyAnswered: 'this question set was already answered; an answer applies once',
  noQuestions: 'a question request carried no questions',
  tooManyQuestions: 'a question request carried more questions than this channel accepts',
  payloadTooLarge: 'the question set is too large to publish whole, so it cannot be answered here',
  badId: 'a question id is missing, empty, too long or duplicated',
  noCall: 'no native tool call could be bound to this question, so it cannot be answered here',
  callGone: 'the bound native tool call is no longer live',
});

/**
 * Default life of one pending question.
 *
 * Reusing the approval request's ten-minute default keeps ONE operator-facing number, and
 * it is finite on purpose: a question pauses the execution budget, so an unbounded wait
 * would let a run hang forever on a commander that never answers.
 */
export const QUESTION_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** Ceiling on a configured question life. */
export const QUESTION_MAX_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Bounds on one question set and one answer.
 *
 * `wireChars` is the important one: it is a budget on the EXACT JSON the commander will
 * be sent, escapes included. It is set well below the MCP tool-text bound (20 000) so the
 * question block, the receiving answer's other fields and a decision receipt can always
 * travel together. A set that does not fit is refused, never published shortened.
 */
export const QUESTION_BOUNDS = Object.freeze({
  /** Maximum questions in one request. */
  questions: 24,
  /** Maximum options offered by one question. */
  options: 24,
  /** Maximum characters for a question's own text. */
  questionChars: 2_000,
  /** Maximum characters for a question's detail. */
  detailChars: 8_000,
  /** Maximum characters for a header. */
  headerChars: 200,
  /** Maximum characters for one option label. */
  optionLabelChars: 400,
  /** Maximum characters for one option description. */
  optionDescriptionChars: 1_000,
  /** Maximum characters accepted as a custom answer. */
  customChars: 4_000,
  /** Maximum characters for a question id. */
  idChars: 200,
  /**
   * Maximum characters of the exact serialised question block.
   *
   * Deliberately conservative: a wait answer also carries the task summary, routing and
   * metrics, and an answer receipt must fit beside a live question. 12 000 leaves that
   * room and is still far above any question a worker should ask.
   */
  wireChars: 12_000,
});

export const QUESTION_STATES = Object.freeze({
  pending: 'pending',
  answered: 'answered',
  expired: 'expired',
  cancelled: 'cancelled',
  refused: 'refused',
});

/** Raised for every refusal of the answer verb. `details` is bounded and secret-free. */
export class QuestionError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - operator-facing explanation.
   * @param {object} [details] - bounded, non-secret context.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'QuestionError';
    this.code = code;
    this.details = details;
  }
}

/**
 * A copy of one question, exactly as the commander will be shown it.
 *
 * The id is used VERBATIM: it is the value the answer must quote and the value the native
 * answerer echoes, so trimming it or inventing one would break the binding. A question
 * with no usable id is refused by the caller.
 * @param {unknown} question - one native question item.
 * @returns {{ id: string, question: string, header: string | null, detail: string | null,
 *   options: { label: string, description: string | null }[], multiSelect: boolean,
 *   intent: string | null } | null} the projection, or null when unusable.
 */
export function projectQuestion(question) {
  if (question === null || typeof question !== 'object' || Array.isArray(question)) return null;
  if (typeof question.id !== 'string' || question.id === '') return null;
  const text = typeof question.question === 'string' ? question.question : '';
  if (text.trim() === '') return null;
  const options = [];
  if (Array.isArray(question.options)) {
    for (const option of question.options) {
      if (option === null || typeof option !== 'object') return null;
      const label = typeof option.label === 'string' ? option.label : '';
      if (label === '') return null;
      options.push({
        label,
        description: typeof option.description === 'string' && option.description !== ''
          ? option.description
          : null,
      });
    }
  }
  const intent = question.intent !== null && typeof question.intent === 'object'
    && typeof question.intent.kind === 'string'
    ? question.intent.kind
    : null;
  return {
    id: question.id,
    question: text,
    header: typeof question.header === 'string' && question.header !== '' ? question.header : null,
    detail: typeof question.detail === 'string' && question.detail !== '' ? question.detail : null,
    options,
    multiSelect: question.multiSelect === true,
    intent,
  };
}

/**
 * The EXACT serialised form of a question set, as the commander receives it.
 *
 * Measured with `JSON.stringify`, so quotes, backslashes and other escapes count at their
 * real serialised width — a set whose text is 11 000 raw characters but 22 000 escaped
 * characters does NOT fit, and measuring `length` field by field would have missed it.
 * @param {object[]} questions - projected questions.
 * @returns {number} serialised length in UTF-16 units.
 */
export function questionWireLength(questions) {
  return JSON.stringify(questions).length;
}

/**
 * Whether one projected question set fits every bound, measured on the real wire form.
 *
 * Returned as a fact rather than logged: a set that does not fit must be REFUSED, because
 * publishing it shortened would show the commander a question the worker never asked and
 * apply its answer to a call that expected something else.
 * @param {object[]} questions - projected questions.
 * @returns {{ ok: true } | { ok: false, code: string, reason: string, detail: string }} verdict.
 */
export function questionsFit(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, code: QUESTION_CODES.answerInvalid, reason: QUESTION_REASONS.noQuestions, detail: 'no questions were asked' };
  }
  if (questions.length > QUESTION_BOUNDS.questions) {
    return {
      ok: false,
      code: QUESTION_CODES.answerInvalid,
      reason: QUESTION_REASONS.tooManyQuestions,
      detail: `${questions.length} questions exceed the bound of ${QUESTION_BOUNDS.questions}`,
    };
  }
  const seen = new Set();
  for (const question of questions) {
    if (typeof question.id !== 'string' || question.id === '' || question.id.length > QUESTION_BOUNDS.idChars) {
      return { ok: false, code: QUESTION_CODES.badIdentity, reason: QUESTION_REASONS.badId, detail: 'a question id is missing or too long' };
    }
    if (seen.has(question.id)) {
      return { ok: false, code: QUESTION_CODES.badIdentity, reason: QUESTION_REASONS.badId, detail: `duplicate question id ${question.id}` };
    }
    seen.add(question.id);
    if (question.question.length > QUESTION_BOUNDS.questionChars) {
      return { ok: false, code: QUESTION_CODES.answerInvalid, reason: QUESTION_REASONS.badBatch, detail: `question ${question.id} is too long` };
    }
    if (question.detail !== null && question.detail.length > QUESTION_BOUNDS.detailChars) {
      return { ok: false, code: QUESTION_CODES.answerInvalid, reason: QUESTION_REASONS.badBatch, detail: `detail of ${question.id} is too long` };
    }
    if (question.header !== null && question.header.length > QUESTION_BOUNDS.headerChars) {
      return { ok: false, code: QUESTION_CODES.answerInvalid, reason: QUESTION_REASONS.badBatch, detail: `header of ${question.id} is too long` };
    }
    if (question.options.length > QUESTION_BOUNDS.options) {
      return {
        ok: false,
        code: QUESTION_CODES.answerInvalid,
        reason: QUESTION_REASONS.badBatch,
        detail: `${question.id} offers ${question.options.length} options, above the bound of ${QUESTION_BOUNDS.options}`,
      };
    }
    const labels = new Set();
    for (const option of question.options) {
      if (option.label.length > QUESTION_BOUNDS.optionLabelChars) {
        return { ok: false, code: QUESTION_CODES.answerInvalid, reason: QUESTION_REASONS.badBatch, detail: `an option label of ${question.id} is too long` };
      }
      if (option.description !== null && option.description.length > QUESTION_BOUNDS.optionDescriptionChars) {
        return { ok: false, code: QUESTION_CODES.answerInvalid, reason: QUESTION_REASONS.badBatch, detail: `an option description of ${question.id} is too long` };
      }
      // Two options with one label make an answer ambiguous: the worker could not tell
      // which one was chosen.
      if (labels.has(option.label)) {
        return { ok: false, code: QUESTION_CODES.answerInvalid, reason: QUESTION_REASONS.badBatch, detail: `${question.id} repeats the option label ${JSON.stringify(option.label)}` };
      }
      labels.add(option.label);
    }
  }
  const wire = questionWireLength(questions);
  if (wire > QUESTION_BOUNDS.wireChars) {
    return {
      ok: false,
      code: QUESTION_CODES.payloadTooLarge,
      reason: QUESTION_REASONS.payloadTooLarge,
      detail: `the question set serialises to ${wire} characters, above the publishable bound of ${QUESTION_BOUNDS.wireChars}`,
      wireChars: wire,
      limit: QUESTION_BOUNDS.wireChars,
    };
  }
  return { ok: true, wireChars: wire };
}

/**
 * Validate one answer batch against the questions that were ACTUALLY asked.
 *
 * A single-select question may carry BOTH a selection and custom text: the native tool
 * documents `selected` as allowed to accompany custom text, and the UI shows "Other"
 * beside the list. Only a multi-selection is refused there.
 * @param {object[]} asked - the projected questions of the live request.
 * @param {unknown} answers - the commander's proposed answers.
 * @returns {{ ok: true, answers: { id: string, selected: string[], custom?: string }[] }
 *   | { ok: false, reason: string, detail: string }} verdict.
 */
export function validateAnswers(asked, answers) {
  if (!Array.isArray(answers)) {
    return { ok: false, reason: QUESTION_REASONS.badBatch, detail: 'answers must be an array' };
  }
  const byId = new Map(asked.map((question) => [question.id, question]));
  // Membership and uniqueness across the WHOLE batch are checked FIRST, so a batch naming
  // a question nobody asked reports exactly that rather than whatever option it mentioned.
  const seenIds = new Set();
  for (const answer of answers) {
    if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
      return { ok: false, reason: QUESTION_REASONS.badBatch, detail: 'each answer must be an object' };
    }
    const id = typeof answer.id === 'string' ? answer.id : '';
    if (!byId.has(id)) {
      return { ok: false, reason: QUESTION_REASONS.unknownQuestion, detail: `no question with id ${JSON.stringify(id)} was asked` };
    }
    if (seenIds.has(id)) {
      return { ok: false, reason: QUESTION_REASONS.badBatch, detail: `question ${id} is answered more than once` };
    }
    seenIds.add(id);
  }
  if (seenIds.size !== asked.length || !asked.every((question) => seenIds.has(question.id))) {
    return {
      ok: false,
      reason: QUESTION_REASONS.badBatch,
      detail: `the batch must name each of the ${asked.length} questions exactly once`,
    };
  }
  const normalized = [];
  for (const answer of answers) {
    const id = answer.id;
    const question = byId.get(id);
    const selected = answer.selected === undefined ? [] : answer.selected;
    if (!Array.isArray(selected) || selected.some((label) => typeof label !== 'string')) {
      return { ok: false, reason: QUESTION_REASONS.badBatch, detail: `selected of ${id} must be an array of labels` };
    }
    const labels = question.options.map((option) => option.label);
    for (const label of selected) {
      if (!labels.includes(label)) {
        return { ok: false, reason: QUESTION_REASONS.unknownOption, detail: `${JSON.stringify(label)} is not an option of ${id}` };
      }
    }
    if (new Set(selected).size !== selected.length) {
      return { ok: false, reason: QUESTION_REASONS.badBatch, detail: `selected of ${id} repeats a label` };
    }
    let custom;
    if (answer.custom !== undefined && answer.custom !== null) {
      if (typeof answer.custom !== 'string') {
        return { ok: false, reason: QUESTION_REASONS.badBatch, detail: `custom of ${id} must be a string` };
      }
      if (answer.custom.length > QUESTION_BOUNDS.customChars) {
        return { ok: false, reason: QUESTION_REASONS.longCustom, detail: `custom of ${id} exceeds ${QUESTION_BOUNDS.customChars} characters` };
      }
      if (answer.custom.trim() === '') {
        return { ok: false, reason: QUESTION_REASONS.emptyCustom, detail: `custom of ${id} is empty` };
      }
      custom = answer.custom;
    }
    if (question.multiSelect !== true && selected.length > 1) {
      return { ok: false, reason: QUESTION_REASONS.tooManySelected, detail: `${id} is single-select and received ${selected.length} labels` };
    }
    if (selected.length === 0 && custom === undefined) {
      return {
        ok: false,
        reason: QUESTION_REASONS.noSelection,
        detail: question.options.length === 0
          ? `${id} offers no options, so it needs custom text`
          : `${id} carries neither a selection nor custom text`,
      };
    }
    normalized.push({ id, selected: [...selected], ...(custom === undefined ? {} : { custom }) });
  }
  return { ok: true, answers: normalized };
}

/**
 * One run's question bridge. Same shape as `PermissionBridge` on purpose: one Agent, one
 * outstanding request, a bounded evidence trail, a lifecycle that releases the waiter.
 */
export class QuestionBridge {
  /**
   * @param {object} options - `taskId`, optional `connectionId`, `timeoutMs`, `now`,
   *   `onPending`, `onSettled`, `logger`, `resolveCall` (the call-binding probe).
   */
  constructor(options) {
    if (typeof options?.taskId !== 'string' || options.taskId === '') {
      throw new TypeError('QuestionBridge needs the taskId it belongs to');
    }
    this.taskId = options.taskId;
    this.connectionId = typeof options.connectionId === 'string' ? options.connectionId : null;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    const configured = Number(options.timeoutMs);
    this.timeoutMs = Number.isFinite(configured) && configured > 0
      ? Math.min(Math.trunc(configured), QUESTION_MAX_TIMEOUT_MS)
      : QUESTION_DEFAULT_TIMEOUT_MS;
    this.onPending = typeof options.onPending === 'function' ? options.onPending : null;
    this.onSettled = typeof options.onSettled === 'function' ? options.onSettled : null;
    this.logger = options.logger ?? null;
    this.resolveCall = typeof options.resolveCall === 'function' ? options.resolveCall : null;
    this.armed = false;
    this.disposed = false;
    this.agent = null;
    this.session = null;
    this.boundSessionId = null;
    // The exact Agent/Session objects this bridge was armed with; a replaced object is a
    // different conversation even when its id was recycled.
    this.armAgent = null;
    this.armSession = null;
    this.pending = null;
    this.history = [];
    this.sequence = 0;
  }

  static get HISTORY_BOUND() {
    return 8;
  }

  /**
   * Bind the bridge to the Agent/Session it answers for.
   * @param {object} agent - the live native Agent the run will drive.
   * @returns {{ taskId: string, sessionId: string }} what was armed.
   * @throws {QuestionError} when the agent is unusable or is not the bound one.
   */
  arm(agent) {
    if (this.disposed) {
      throw new QuestionError(QUESTION_CODES.unbound, QUESTION_REASONS.disposed);
    }
    const session = agent?.session ?? null;
    const sessionId = typeof session?.id === 'string' ? session.id : null;
    if (session === null || sessionId === null) {
      throw new QuestionError(QUESTION_CODES.unbound, 'the delegated agent exposes no session to bind questions to', {
        reason: 'no session',
      });
    }
    if (this.agent !== null && this.agent !== agent) {
      throw new QuestionError(QUESTION_CODES.unbound, 'the question bridge is already bound to another agent', {
        reason: 'agent mismatch',
      });
    }
    if (this.session !== null && this.session !== session) {
      throw new QuestionError(QUESTION_CODES.unbound, 'the question bridge is already bound to another session');
    }
    this.agent = agent;
    this.session = session;
    this.boundSessionId = sessionId;
    // The EXACT objects this bridge was armed with. `arm()` may be called again for the same
    // Agent (it is idempotent), but a replaced Agent or Session must be detectable, which is a
    // question of object identity rather than of ids.
    this.armAgent = agent;
    this.armSession = session;
    this.armed = true;
    return { taskId: this.taskId, sessionId };
  }

  /**
   * Whether this bridge answers one native question request: the EXACT live Agent object
   * and the same Session, because the seam passes the live Agent and object identity
   * cannot be forged from data.
   * @param {object} request - native question request.
   * @returns {boolean} true when this bridge owns the request.
   */
  owns(request) {
    if (this.armed !== true || this.disposed === true) return false;
    if (this.agent === null || this.session === null) return false;
    const agent = request?.agent;
    if (agent === null || agent === undefined || typeof agent !== 'object') return false;
    const session = agent.session;
    if (session === null || session === undefined || typeof session !== 'object') return false;
    if (agent !== this.agent) return false;
    if (session !== this.session) return false;
    if (this.boundSessionId !== null && typeof session.id === 'string' && session.id !== this.boundSessionId) return false;
    return true;
  }

  /** Whether any question of a set presents an approval decision. */
  static presentsApproval(questions) {
    return questions.some((question) => question.intent === 'approval');
  }

  /**
   * Answer one native question request.
   * @param {object} request - native question request.
   * @returns {Promise<{ answers: object[] }>} the commander's answer.
   * @throws {QuestionError} when this bridge cannot answer the request.
   */
  async answer(request) {
    if (this.armed !== true || this.disposed === true) {
      throw new QuestionError(QUESTION_CODES.unbound, QUESTION_REASONS.notArmed);
    }
    if (!this.owns(request)) {
      throw new QuestionError(QUESTION_CODES.unbound, QUESTION_REASONS.foreignAgent);
    }
    if (this.pending !== null) {
      throw new QuestionError(QUESTION_CODES.busy, QUESTION_REASONS.busy);
    }
    const raw = Array.isArray(request?.questions) ? request.questions : [];
    const questions = [];
    for (const item of raw) {
      const projected = projectQuestion(item);
      if (projected === null) {
        throw new QuestionError(QUESTION_CODES.badIdentity, 'a question could not be described', {
          reason: QUESTION_REASONS.badId,
          detail: 'a question needs a non-empty string id and a non-empty question',
        });
      }
      questions.push(projected);
    }
    const fit = questionsFit(questions);
    if (fit.ok !== true) {
      // Refused BEFORE anything is published: the commander is never offered a question
      // set this channel cannot carry whole, so it can never be answered from a
      // shortened copy.
      throw new QuestionError(fit.code, 'the question set cannot be published whole', fit);
    }
    if (JSON.stringify(redactDeep(questions)) !== JSON.stringify(questions)) {
      throw new QuestionError(QUESTION_CODES.redacted,
        'the question contains private data that cannot be published intact; rephrase it without private values');
    }
    if (QuestionBridge.presentsApproval(questions)) {
      throw new QuestionError(QUESTION_CODES.approvalIntent, QUESTION_REASONS.approvalIntent, {
        reason: QUESTION_REASONS.approvalIntent,
        channel: 'permission',
        hint: 'request the exact tool call through the approval channel; a question cannot grant access',
      });
    }
    const bound = await this.bindCall(request);
    if (bound.ok !== true) {
      throw new QuestionError(bound.code, 'no live native tool call could be bound to this question', {
        reason: bound.reason,
        detail: bound.detail,
      });
    }
    if (!this.owns(request)) {
      throw new QuestionError(QUESTION_CODES.unbound, QUESTION_REASONS.foreignAgent);
    }
    if (this.pending !== null) {
      throw new QuestionError(QUESTION_CODES.busy, QUESTION_REASONS.busy);
    }
    const signal = request?.signal ?? null;
    if (signal?.aborted === true) {
      throw new QuestionError(QUESTION_CODES.questionSettled, QUESTION_REASONS.cancelled);
    }
    const pending = this.createPending(questions, bound.call);
    return await this.waitForAnswer(pending, signal);
  }

  /**
   * Bind this question to the ONE native `ask_user_question` call that is executing it.
   *
   * The call id is taken from the request (`wait.callId`, which the native tool sets) and
   * then VERIFIED against the Session log by {@link QUESTION_CALL_BINDING}: exactly one
   * matching `tool/call` in the open turn, no recorded result for it, owned by this Agent.
   * A question that cannot be bound this way is refused rather than answered against a
   * guess — delivering an answer to the wrong call would resume an operation nobody asked
   * about.
   * @param {object} request - native question request.
   * @returns {Promise<{ ok: true, call: object } | { ok: false, code: string, reason: string, detail: string }>} binding.
   */
  async bindCall(request) {
    const declared = typeof request?.wait?.callId === 'string' ? request.wait.callId : '';
    const probe = typeof this.resolveCall === 'function' ? this.resolveCall : QUESTION_CALL_BINDING;
    let found;
    try {
      found = probe({
        session: this.session,
        agent: this.agent,
        declaredCallId: declared === '' ? null : declared,
        toolName: 'ask_user_question',
      });
    } catch (error) {
      return {
        ok: false,
        code: QUESTION_CODES.noCall,
        reason: QUESTION_REASONS.noCall,
        detail: `the call binding could not be read (${String(error?.code ?? 'error')})`,
      };
    }
    if (found === null || typeof found !== 'object' || found.ok !== true) {
      return {
        ok: false,
        code: QUESTION_CODES.noCall,
        reason: QUESTION_REASONS.noCall,
        detail: typeof found?.detail === 'string' ? found.detail : 'no unique open tool call matches this question',
      };
    }
    return {
      ok: true,
      call: { callId: found.callId, seq: found.seq, turn: found.turn ?? null },
    };
  }

  /**
   * Whether the bound call is still the live one this answer may resume.
   *
   * An id match alone is NOT enough, and the reproduction proved it: after
   * `turn/end, turn/start(turn2), tool/call c turn2` the same id `c` is a DIFFERENT call in a
   * different turn, so an answer bound to the first one would be delivered to an operation
   * that never asked. Nor is it enough that the bridge still holds *a* session: a replaced
   * Session object is a different conversation even when its id was recycled.
   *
   * So four facts must ALL still hold: the same Agent object, the same Session object, the
   * same Session id, and the same call at the same log offset in the same turn.
   * @param {object} pending - pending record.
   * @returns {boolean} true when the call is still live and still the same call.
   */
  callStillLive(pending) {
    if (pending?.call === null || pending?.call === undefined) return false;
    if (!this.owns({ agent: this.agent })) return false;
    // The Agent and the Session must still be the objects this bridge was armed with.
    if (this.armAgent === null || this.agent !== this.armAgent) return false;
    if (this.armSession === null || this.session !== this.armSession) return false;
    if (this.boundSessionId !== null) {
      const liveId = typeof this.session?.id === 'string' ? this.session.id : null;
      if (liveId !== this.boundSessionId) return false;
    }
    const probe = typeof this.resolveCall === 'function' ? this.resolveCall : QUESTION_CALL_BINDING;
    let found;
    try {
      found = probe({
        session: this.session,
        agent: this.agent,
        declaredCallId: pending.call.callId,
        toolName: 'ask_user_question',
      });
    } catch {
      return false;
    }
    if (found === null || typeof found !== 'object' || found.ok !== true) return false;
    if (found.callId !== pending.call.callId) return false;
    // The SAME log record and the SAME turn, not merely the same id: a replayed id in a new
    // turn is a separate call.
    if (found.seq !== pending.call.seq) return false;
    const boundTurn = pending.call.turn;
    if ((found.turn ?? null) !== (boundTurn ?? null)) return false;
    return true;
  }

  /**
   * Build the pending record for one accepted question set.
   * @param {object[]} questions - projected questions.
   * @param {object} call - the verified native call.
   * @returns {object} pending record.
   */
  createPending(questions, call) {
    this.sequence += 1;
    const createdAt = this.now();
    const pending = {
      requestId: `question-${this.taskId}-${this.sequence}`,
      taskId: this.taskId,
      connectionId: this.connectionId,
      sessionId: this.boundSessionId,
      callId: call.callId,
      call,
      questions,
      createdAt,
      // FINITE by construction: a question pauses the execution budget, so an unbounded
      // wait would let a run hang forever on a commander that never answers.
      deadlineAt: createdAt + this.timeoutMs,
      state: QUESTION_STATES.pending,
      answer: null,
      answeredAt: null,
      settledAt: null,
      resolvedWith: null,
      resolve: null,
      reject: null,
      timer: null,
      onAbort: null,
      externalSignal: null,
    };
    this.pending = pending;
    return pending;
  }

  /** Publish one pending question set; an observer throw is contained. */
  emitPending(pending) {
    if (this.onPending === null) return;
    try {
      this.onPending(this.publicView(pending));
    } catch (error) {
      this.logger?.warn?.('dsh-delegate: question observer failed', String(error?.code ?? ''));
    }
  }

  /**
   * Wait, boundedly, for the commander's answer.
   * @param {object} pending - pending record.
   * @param {AbortSignal | null} signal - the asking tool's cancellation.
   * @returns {Promise<{ answers: object[] }>} the answer.
   */
  async waitForAnswer(pending, signal) {
    const settled = new Promise((resolvePromise, rejectPromise) => {
      pending.resolve = resolvePromise;
      pending.reject = rejectPromise;
    });
    pending.timer = setTimeout(() => {
      pending.timer = null;
      this.settle(pending, QUESTION_STATES.expired, QUESTION_REASONS.expired);
    }, Math.max(0, pending.deadlineAt - this.now()));
    pending.timer.unref?.();
    if (signal !== null && typeof signal.addEventListener === 'function') {
      pending.externalSignal = signal;
      pending.onAbort = () => {
        this.settle(pending, QUESTION_STATES.cancelled, QUESTION_REASONS.cancelled);
      };
      signal.addEventListener('abort', pending.onAbort, { once: true });
    }
    this.emitPending(pending);
    try {
      return await settled;
    } finally {
      this.clearPending(pending);
    }
  }

  /**
   * Apply one answer to the LIVE pending question set.
   *
   * The bound native call is re-checked FIRST: an answer must never be replayed onto a
   * call that has already returned, been replaced, or whose turn has closed.
   * @param {object} request - `requestId`, `answers`.
   * @returns {{ requestId: string, taskId: string, callId: string, answers: object[], answeredAt: number }} receipt.
   * @throws {QuestionError} when no live set matches, the call is gone, or the answers are invalid.
   */
  decide(request) {
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    if (requestId === '') {
      throw new QuestionError(QUESTION_CODES.questionNotFound, 'requestId is required', { field: 'requestId' });
    }
    const pending = this.pending;
    if (pending === null || pending.requestId !== requestId) {
      const settled = this.history.find((entry) => entry.requestId === requestId) ?? null;
      if (settled !== null) {
        throw new QuestionError(QUESTION_CODES.alreadyAnswered, QUESTION_REASONS.alreadyAnswered, {
          requestId,
          state: settled.state,
        });
      }
      throw new QuestionError(QUESTION_CODES.notPending, QUESTION_REASONS.notArmed, { requestId });
    }
    if (pending.state !== QUESTION_STATES.pending) {
      throw new QuestionError(QUESTION_CODES.alreadyAnswered, QUESTION_REASONS.alreadyAnswered, {
        requestId,
        state: pending.state,
      });
    }
    if (this.now() >= pending.deadlineAt) {
      this.settle(pending, QUESTION_STATES.expired, QUESTION_REASONS.expired);
      throw new QuestionError(QUESTION_CODES.expired, QUESTION_REASONS.expired, { requestId });
    }
    if (!this.callStillLive(pending)) {
      // The call this question belongs to is gone, so an answer would resume nothing (or
      // the wrong thing). Refused, and the set is closed rather than left answerable.
      this.settle(pending, QUESTION_STATES.refused, QUESTION_REASONS.callGone);
      throw new QuestionError(QUESTION_CODES.callGone, QUESTION_REASONS.callGone, {
        requestId,
        callId: pending.callId,
      });
    }
    const verdict = validateAnswers(pending.questions, request?.answers);
    if (verdict.ok !== true) {
      throw new QuestionError(QUESTION_CODES.answerInvalid, verdict.detail, {
        requestId,
        reason: verdict.reason,
        detail: verdict.detail,
      });
    }
    const answeredAt = this.now();
    this.settle(pending, QUESTION_STATES.answered, null, { answer: verdict.answers, answeredAt });
    return { requestId, taskId: pending.taskId, callId: pending.callId, answers: verdict.answers, answeredAt };
  }

  /** Settle one pending set exactly once and release its waiter. */
  settle(pending, state, reason, extra = {}) {
    if (pending.state !== QUESTION_STATES.pending) return;
    pending.state = state;
    pending.settledAt = this.now();
    if (reason !== null) pending.resolvedWith = reason;
    if (Array.isArray(extra.answer)) {
      pending.answer = extra.answer;
      pending.answeredAt = extra.answeredAt ?? pending.settledAt;
    }
    this.clearPending(pending);
    const entry = this.settledView(pending);
    this.history.push(entry);
    if (this.history.length > QuestionBridge.HISTORY_BOUND) this.history.shift();
    const resolve = pending.resolve;
    const reject = pending.reject;
    if (resolve !== null || reject !== null) {
      if (state === QUESTION_STATES.answered) {
        resolve?.({ answers: pending.answer });
      } else {
        reject?.(nativeRefusal(state, reason));
      }
    }
    try {
      this.onSettled?.(entry);
    } catch (error) {
      this.logger?.warn?.('dsh-delegate: question settled observer failed', String(error?.code ?? ''));
    }
  }

  /** Drop the pending pointer and every timer/listener it owned. */
  clearPending(pending) {
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (pending.externalSignal !== null && pending.onAbort !== null) {
      try {
        pending.externalSignal.removeEventListener?.('abort', pending.onAbort);
      } catch {
        // Removing a listener is best effort; the signal is external.
      }
    }
    pending.externalSignal = null;
    pending.onAbort = null;
    if (this.pending === pending) this.pending = null;
  }

  /** Settle whatever is pending, then refuse every later request. */
  stop(reason = QUESTION_REASONS.stop) {
    const pending = this.pending;
    if (pending !== null) this.settle(pending, QUESTION_STATES.cancelled, reason);
    this.armed = false;
  }

  /** Release everything. Idempotent. */
  dispose() {
    if (this.disposed) return;
    this.stop(QUESTION_REASONS.dispose);
    this.disposed = true;
    this.armed = false;
    this.agent = null;
    this.session = null;
  }

  /** The public projection of the current pending set, or null. */
  pendingView(pending = this.pending) {
    if (pending === null || pending === undefined) return null;
    if (pending.state !== QUESTION_STATES.pending) return null;
    return this.publicView(pending);
  }

  /**
   * Project one pending record for the commander.
   *
   * The questions are published EXACTLY as accepted — this is the same set whose
   * serialised size was checked, so nothing here can shorten them.
   */
  publicView(pending) {
    return {
      requestId: pending.requestId,
      taskId: pending.taskId,
      sessionId: pending.sessionId,
      callId: pending.callId,
      state: QUESTION_STATES.pending,
      createdAt: pending.createdAt,
      deadlineAt: pending.deadlineAt,
      questions: pending.questions.map((question) => ({
        id: question.id,
        question: question.question,
        header: question.header,
        detail: question.detail,
        options: question.options.map((option) => ({ label: option.label, description: option.description })),
        multiSelect: question.multiSelect,
        intent: question.intent,
      })),
      grantsAccess: false,
    };
  }

  /** Project one settled set as evidence. */
  settledView(pending) {
    return {
      requestId: pending.requestId,
      taskId: pending.taskId,
      callId: pending.callId,
      state: pending.state,
      questions: pending.questions.map((question) => ({ id: question.id, question: question.question })),
      answers: pending.answer === null ? null : pending.answer.map((answer) => ({
        id: answer.id,
        selected: [...answer.selected],
        ...(answer.custom === undefined ? {} : { custom: answer.custom }),
      })),
      reason: pending.resolvedWith,
      createdAt: pending.createdAt,
      settledAt: pending.settledAt,
      answeredAt: pending.answeredAt,
    };
  }

  historyView() {
    return this.history.map((entry) => entry);
  }
}

/**
 * The refusal the asking tool receives when a question cannot be answered: shaped like the
 * native `UserQuestionError` so the tool result reads like any other native refusal.
 */
function nativeRefusal(state, reason) {
  const code = state === QUESTION_STATES.expired ? 'ASK_TIMED_OUT' : 'ASK_ABORTED';
  const message = reason ?? (state === QUESTION_STATES.expired
    ? 'ask_user_question timed out before the commander answered'
    : 'ask_user_question was withdrawn before the commander answered');
  const error = new Error(message);
  error.name = 'UserQuestionError';
  error.code = code;
  return error;
}
