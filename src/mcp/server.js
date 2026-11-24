// MCP server: the bounded external surface.
//
// Design rule taken from SPEC §10–11: an external MCP client may *exercise* an
// authorization the operator already created, and may do nothing else. So this
// server exposes eleven tools and maps each execution tool onto one execution-plane route:
//
//   delegate_status            → GET  /dsh-delegate/x/status
//   delegate_submit            → POST /dsh-delegate/x/tasks
//   delegate_result            → POST /dsh-delegate/x/tasks/get
//   delegate_wait              → POST /dsh-delegate/x/tasks/observe  (repeated)
//   delegate_cancel            → POST /dsh-delegate/x/tasks/cancel
//   delegate_permission_decide → POST /dsh-delegate/x/tasks/permission
//   delegate_question_answer   → POST /dsh-delegate/x/tasks/question
//   delegate_review            → POST /dsh-delegate/x/tasks/review
//   delegate_plan              → POST /dsh-delegate/x/plans
//   delegate_preflight         → POST /dsh-delegate/x/workspace/preflight
//   delegate_metrics           → local process census (no plane route)
//
// `delegate_wait` is a read like `delegate_result`, and it is the one tool whose
// single call may take a long time: it composes several BOUNDED observation
// requests (each ≤ {@link OBSERVE_WAIT_MS}) into one host-visible wait, and returns
// as soon as the task reaches a state the host must act on — a permission request,
// a finished run, a failure, a cancellation — or when the caller's own deadline is
// reached. It never calls `delegate_result`: a wait answer is compact by design, and
// the full snapshot stays behind its own bounded projection.
//
// `delegate_permission_decide` is the one NARROW EXCEPTION to the sentence above,
// and it is narrow in exactly one way: it consumes an ALREADY PENDING per-call
// permission request that a delegated worker raised, and it can answer only
// `allow-once` or `reject` for that one exact tool call. It cannot create a
// connection, cannot issue, widen or extend a grant, cannot change settings, the
// switch, the provider/model or a credential, and cannot pre-approve any future
// operation: the request is bound to one Session, one tool call id and an exact
// fingerprint of the real arguments, and it is consumed by the decision. The
// worker's standing sandbox mode is never changed by it. This tool is NOT part of the
// native worker's declared tool catalog, so the worker's own model is never handed it —
// a real tool-surface restriction, but NOT a claim that a process running as the same OS
// user could not reach the shared local-MCP endpoint directly. See `runtime/permissions.js`.
//
// `delegate_review` is the second narrow write, and it is the ONLY thing that records a
// task's `hostAcceptance`: the commander's own delivery conclusion (`accepted` or
// `changes-requested`). A finished run stays `awaiting-host-review` — that underlying
// state is what keeps older clients and `continueFromTaskId` compatible — and the review
// lives in its own field. It cannot approve a permission, change the switch, a provider,
// a model, the isolation or a credential, merge a diff, or create work; it also cannot
// be reached by the worker's own catalog, for the same reason as above.
//
// `delegate_metrics` is the one tool with NO plane route at all: it reports this MCP
// process's own bounded accounting (tool calls, wait answers and their reasons, durations,
// UTF-8 byte sizes, applied decisions and the waits that followed them). It is a read of
// a census this process kept — not of the host's model, whose turns, tokens and cost are
// reported as `not-integrated` rather than as zero.
//
// `delegate_permission_decide`'s optional `waitAfterDecision` is the one argument this
// surface adds for itself. It is a CONTROL field of the MCP call, stripped at this
// boundary and never sent to the plane; its continuation reuses the bounded observation
// loop in `./wait.js` through `./continuation.js` rather than growing a second one.
//
// `delegate_preflight` is the one addition that is not an authorization at all: it
// is a read-only measurement of a workspace, and it exists so a dispatcher can
// learn before submitting that a checkout is dirty, is not a repository, or would
// need an isolation decision — instead of learning it from a failed job. It still
// cannot authorize, configure or write anything, and the execution plane does not
// gate it on the switch, so an answer is available while delegation is off.
//
// There is no tool that issues a connection, issues or widens a grant, changes
// settings, or touches a credential. Those actions live on the authenticated user
// plane, which is reachable only from the operator's own browser session.
//
// The connection token is read from the environment and is never placed in a
// tool result, an error, or a log line. Every answer is bounded and is the
// server's own already-redacted projection; this process adds no data of its own.
//
// The protocol is implemented directly rather than through
// `@modelcontextprotocol/server`, which is not installed in this environment (only
// `@modelcontextprotocol/client` and `@modelcontextprotocol/core` are). What that
// costs is stated in the README: this server speaks the `initialize` handshake and
// the tools capability only, and it is not a general-purpose MCP SDK.

// Only `diagnostic` is needed here, and it is imported from the redaction module
// rather than from `runtime/agent-runner.js`. That distinction is load-bearing:
// the agent runner statically imports `@deepseek-ai/dsh-llm` and
// `@deepseek-ai/dsh-agent`, which only a running DSH installation provides. This
// executable is spawned by an arbitrary MCP host, so reaching through the runner
// made it fail at link time with `ERR_MODULE_NOT_FOUND` before it could report
// anything at all.
import { diagnostic, redactText } from '../config/redact.js';
import {
  REVIEW_NOTE_MAX_CHARS,
  normalizeReviewNote,
  reviewNoteLength,
  reviewNoteOverflow,
  truncateCodePoints,
} from '../jobs/review-note.js';
import {
  TASK_DESCRIPTION_FIELDS,
  TASK_DESCRIPTION_MAX_CHARS,
  canonicalTaskDescription,
  readTaskDescription,
} from '../jobs/task-descriptions.js';
import {
  MAX_PLAN_BATCH,
  PLAN_TITLE_MAX_CHARS,
} from '../jobs/plan-store.js';
import { waitForTask } from './wait.js';
import { QUESTION_ANSWER_KIND, createCallMetrics, correlationId } from './metrics.js';
// The engine's own per-call permission bounds. Imported rather than re-stated so this
// layer can never publish a SMALLER operation cap than the engine allowed: a smaller
// one here re-cuts an operation the engine already published whole and turns a
// reviewable request into an unapprovable one.
import { PERMISSION_BOUNDS } from '../runtime/permissions.js';
import { reportedVersion } from '../version.js';
// The question answer's own bounds, re-exported so the MCP schema and the runtime agree on
// the custom-text limit rather than restating it.
import { QUESTION_BOUNDS } from '../runtime/questions.js';
import {
  decidedRequestMatcher,
  decisionReceipt,
} from './continuation.js';

/** Protocol revisions this server can speak, newest first (as the SDK lists them). */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

/** The revision answered when a client asks for one this server does not know. */
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/**
 * Identifies this server in the handshake.
 *
 * The version is read from the package manifest this file ships in, never written
 * here: a literal is a second copy of the same fact and the two drift, so a
 * pre-release tarball answered `initialize` with the last released number and a host
 * could not tell which build it was talking to. `delegate_metrics` and the exit
 * diagnostics report the same value through {@link reportedVersion}.
 */
const REPORTED = reportedVersion();

export const SERVER_INFO = Object.freeze({ name: REPORTED.name, version: REPORTED.version });

/** Bound on a tool result's text. A task view can be large; a model's context cannot. */
export const MAX_TOOL_TEXT_CHARS = 20_000;

/**
 * Largest page of a review note one `delegate_result` call returns, in code points.
 *
 * A page is deliberately small: it exists so a note far larger than the tool-text bound can
 * be read in full, a page at a time, without one answer blowing a model's context.
 */
export const MAX_REVIEW_NOTE_PAGE_CHARS = 2_000;

/** Default page size of a `reviewNoteOffset` read. */
export const DEFAULT_REVIEW_NOTE_PAGE_CHARS = 2_000;

/** Largest and default page size of a `completionSummaryOffset` read, in code points. */
export const MAX_COMPLETION_SUMMARY_PAGE_CHARS = TASK_DESCRIPTION_MAX_CHARS;
export const DEFAULT_COMPLETION_SUMMARY_PAGE_CHARS = TASK_DESCRIPTION_MAX_CHARS;

/** Bound on one execution-plane request. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Longest single observation request `delegate_wait` issues, in milliseconds.
 *
 * Deliberately equal to the execution plane's own bound (`MAX_OBSERVE_WAIT_MS`):
 * the plane clamps anything larger, so a longer value here would only make the
 * client believe it had asked for something the server does not do.
 */
export const OBSERVE_WAIT_MS = 25_000;

/** Default deadline of one `delegate_wait` call, in seconds (one hour). */
export const DEFAULT_WAIT_SECONDS = 3_600;

/** Longest deadline one `delegate_wait` call may ask for, in seconds (one hour). */
export const MAX_WAIT_SECONDS = 3_600;

/** Shortest deadline one `delegate_wait` call may ask for, in seconds. */
export const MIN_WAIT_SECONDS = 1;

/**
 * Longest `delegate_review` note, in Unicode code points.
 *
 * This is the shared definition (`src/jobs/review-note.js`), re-exported because the MCP
 * catalog is the first surface a client sees. The same value bounds the execution plane,
 * the engine and the durable history projection, and all of them count CODE POINTS, not
 * UTF-16 units: a note written in Chinese or with emoji gets the same room, and a
 * surrogate pair cannot be split by a bound.
 */
export const MAX_REVIEW_NOTE_CHARS = REVIEW_NOTE_MAX_CHARS;

/** Longest `goalDescription` / `completionSummary`, in Unicode code points. */
export const MAX_TASK_DESCRIPTION_CHARS = TASK_DESCRIPTION_MAX_CHARS;

/**
 * How many requests may be in flight at once on the stdio transport.
 *
 * A request that takes minutes (a wait) must not stop the host from sending
 * `tools/call` for a status read, a cancel or a permission decision. Concurrency is
 * bounded anyway: each in-flight request holds a socket, a promise and its own
 * encoded reply, and an unbounded number of those is a memory bound the host, not
 * this server, controls. Beyond the cap the request is REFUSED explicitly rather
 * than queued silently, so a host learns its situation instead of wondering.
 */
export const MAX_INFLIGHT_REQUESTS = 32;

/** How many call records are retained for tests/diagnostics. */
export const MAX_CALL_LOG = 256;

/**
 * Reasons on which `delegate_wait` returns to the host.
 *
 * `question` is here for the same reason `permission` is: the worker is PAUSED on an
 * ordinary question it cannot answer itself, so the host must act now. Surfacing it only
 * through the silence threshold is the acceptance defect this reason removes — a question
 * asked at minute one used to be reported at minute ten.
 *
 * `heartbeat` is deliberately absent: it is the engine's internal "nothing changed
 * yet" signal, consumed by the wait loop and never surfaced as an answer.
 */
export const ACTIONABLE_REASONS = Object.freeze([
  'attention', 'permission', 'question', 'ready', 'failed', 'cancelled', 'interrupted',
]);

/** The reason a wait that reached its own deadline reports. */
export const WAIT_LIMIT_REASON = 'wait-limit';

/** JSON-RPC error codes used here (the standard set, not invented ones). */
export const RPC_ERRORS = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
});

/**
 * A refusal this server produced itself. Distinct from a transport failure so a
 * caller can tell "the harness said no" from "the harness could not be reached".
 */
export class McpError extends Error {
  /**
   * @param {string} code - stable machine code, surfaced to the client as text.
   * @param {string} message - explanation, already free of secrets.
   * @param {object} [options] - `rpcCode` for a protocol-level refusal, `details` for the
   *   bounded, already-redacted facts the refusal must carry (for example a decision
   *   receipt whose outcome is unknown). Details are published as `error.details`.
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.rpcCode = options.rpcCode ?? null;
    this.details = options.details ?? null;
  }
}

/**
 * Tool catalog.
 *
 * `inputSchema` is deliberately closed (`additionalProperties: false`): a model
 * that invents a field gets a clear protocol error instead of a silently ignored
 * argument, and no tool can grow an undeclared parameter by accident.
 *
 * Every tool also carries MCP `annotations` (`readOnlyHint` / `destructiveHint` /
 * `idempotentHint` / `openWorldHint`). They are an accurate DESCRIPTION of what each
 * tool does — a read is marked read-only, cancelling is marked destructive and not
 * idempotent — and they let a concurrency-aware client know that a long wait is a
 * read and must not be treated as a mutating call that blocks the session. They are
 * not the fix for a serialising host: a client that forwards one call at a time
 * ignores every annotation, which is exactly why the independent
 * `bin/dsh-delegate-control.js` channel exists. Nothing here claims that annotations
 * make a serial client concurrent.
 */
export const TOOLS = Object.freeze([
  Object.freeze({
    name: 'delegate_status',
    title: 'Delegation status',
    description: 'Report whether delegation is enabled in DSH for this local MCP connection.',
    // A pure read of the plane's own posture: no task, no grant, no write.
    annotations: Object.freeze({
      title: 'Delegation status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
    inputSchema: Object.freeze({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'delegate_submit',
    title: 'Submit delegated task',
    description: 'Submit one prompt to run as a delegated task while the DSH delegation switch is enabled. '
      + 'Returns the task identity and state (or follows the first wait in the same call when `wait: true` is set); '
      + 'submission is not host approval. '
      + 'workspacePath is the operator-authorized SOURCE repository or checkout the task runs against; '
      + 'a source root may legitimately be a Git checkout or a Git worktree (subject to the usual preflight). '
      + 'A follow-up keeps that same source path as the task it continues. '
      + 'Omit continueFromTaskId to start a NEW task conversation (always a fresh DSH session, even in a '
      + 'directory used before). Set it to the task id of the earlier delegated task this submission is a '
      + 'follow-up to, to continue exactly that task thread (same DSH Workspace and Session): the plugin '
      + 'reuses that task\u2019s recorded execution checkout and DSH Session internally, taking no execution '
      + 'location from '
      + 'the caller. An unknown, unfinished, removed or differently-sourced parent is refused rather than '
      + 'started as a new conversation. For a new dependent subtask that starts a fresh DSH Session directly on '
      + 'an earlier finished isolated worktree under the same source repository, pass reuseWorktreeFromTaskId '
      + 'instead (never combined with continueFromTaskId). '
      + 'The commander must first plan and scope ONE cohesive, independently verifiable work packet. '
      + 'Inspect the project and prior delivery, choose the next ready packet, and tell the operator the approach and reuse decision. '
      + 'Put clear architectural direction, exported contracts, owned scope redlines and acceptance checks in the prompt (without dictating line-by-line code). '
      + 'Group dependent packets with delegate_plan. A simple task can use one brief. '
      + 'Rules, planning and final review stay with the commander. Verification-only packets are read-only.',
    // It creates work, so it is not a read; it is not destructive of anything the
    // operator already has, and repeating it creates ANOTHER task (never idempotent).
    annotations: Object.freeze({
      title: 'Submit delegated task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    }),
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        workspacePath: {
          type: 'string',
          description: 'Absolute path of the operator-authorized SOURCE repository or checkout \u2014 the path '
            + 'the authorization names, not a location chosen while a task runs. A source root may itself be '
            + 'a Git checkout or a Git worktree, which is not rejected for that reason; it still goes through '
            + 'the same preflight as any other path. '
            + 'For a continueFromTaskId follow-up, pass the SAME source path the parent task was submitted '
            + 'with: the plugin reuses the parent\u2019s recorded execution checkout and DSH Session internally, so do not '
            + 'send '
            + 'an execution.workspacePath or any other internal execution location in its place, because a '
            + 'different source path names a different repository and the continuation is refused.',
        },
        prompt: {
          type: 'string',
          description: 'Give DSH the objective, verified starting facts, code/spec entry points, architectural direction and exported contracts/invariants, owned scope redlines, and acceptance evidence (do not dictate line-by-line implementation code). '
            + 'Roadmap context does not authorize future packets. A verification-only packet permits checks and evidence only.',
        },
        title: { type: 'string', maxLength: 120, description: 'Short work-content title in the operator\'s language, e.g. 修复登录错误. Used to name the new DSH Workspace; omit role instructions and task ids. A follow-up keeps its existing Workspace name.' },
        overrides: {
          type: 'object',
          description: 'Optional per-task overrides (model/effort/timeout). Validated by the harness.',
          additionalProperties: true,
        },
        agentTeams: {
          type: 'boolean',
          description: 'OPTIONAL. Your Agent Teams decision for THIS task\u2019s own DSH Session: the same switch the '
            + 'DSH model menu exposes as \u300cUse Agent Teams\u300d/\u300c\u542f\u7528\u667a\u80fd\u4f53\u56e2\u961f\u534f\u4f5c\u300d. '
            + 'Send `true` or `false` only when the operator chooses a mode for this task. An explicit value wins over the operator\u2019s '
            + 'TaskBridge default. Leave it absent, including inside overrides, when the operator leaves it unspecified. A new task follows the operator\u2019s '
            + '\u300c\u65b0\u4efb\u52a1\u9ed8\u8ba4\u5f00\u542f\u667a\u80fd\u4f53\u534f\u4f5c\u300d setting (off on a fresh install and after an '
            + 'upgrade), and a follow-up (`continueFromTaskId`) keeps the mode the task it continues ran with \u2014 if that '
            + 'task recorded none, its Session keeps the existing mode. '
            + 'The plugin applies it to this run only and never opens a global default. Teams never replaces your '
            + 'approval or your final review, and this flag never selects a model or an effort \u2014 those come from the '
            + 'task\u2019s frozen configuration. On a DSH without agent-teams support, an explicit `true` or `false` is '
            + 'REFUSED (the worker is not prompted and the task records why); only the operator\u2019s implicit off default '
            + 'still runs, reported as not applied. The task record reports `agentTeams` (the choice that was '
            + 'applied), `agentTeamsOrigin` (`request`, `continuation` or `settings-default`) and `team` (what DSH '
            + 'confirmed, or why it could not).',
        },
        continueFromTaskId: {
          type: 'string',
          description: 'Task id of the earlier delegated task this submission continues. '
            + 'Use it only for a follow-up change or retry that belongs to that same task; '
            + 'omit it for an unrelated task. It names a task thread, not a directory: keep passing the '
            + 'parent\u2019s original authorized source repository in workspacePath and do not send the parent\u2019s '
            + 'execution location, because the plugin reuses the parent\u2019s recorded execution checkout and DSH Session '
            + 'internally and pins the follow-up to the parent\u2019s recorded isolation; do not select a new '
            + 'isolation override either. An unknown, still-running, removed or differently-sourced parent is '
            + 'refused, never replaced by a new conversation.',
        },
        reuseWorktreeFromTaskId: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: 'OPTIONAL. Task id of an earlier finished (`awaiting-host-review`) isolated worktree task '
            + 'under the SAME source repository whose managed worktree this NEW independent subtask should reuse. '
            + 'Starts a FRESH DSH Session (clean worker context) and may bind its own `planNodeId`, while editing '
            + 'directly on top of the upstream task\u2019s worktree without touching or committing to the user\u2019s source '
            + 'checkout. Mutually exclusive with `continueFromTaskId` (which reuses both session and worktree for '
            + 'rectification of the same item).',
        },
        autoPreflight: {
          type: 'boolean',
          description: 'OPTIONAL, default false (MCP-only control flag). For a new task chain (neither '
            + '`continueFromTaskId` nor `reuseWorktreeFromTaskId`), run `delegate_preflight` automatically before '
            + 'submitting. If preflight returns `block`, stops without submitting and returns `{ ok: true, '
            + 'submitted: false, preflight }`; if clean (`worktree`, or `shared` with `allowShared: true`), proceeds '
            + 'straight to submit inside this same call.',
        },
        allowShared: {
          type: 'boolean',
          description: 'OPTIONAL, default false (only valid with `autoPreflight: true`). Forwarded to automatic '
            + 'preflight when explicitly authorizing in-place `shared` execution on a dirty Git repository root.',
        },
        wait: {
          type: 'boolean',
          description: 'OPTIONAL, default false (MCP-only control flag). After the task is submitted, immediately '
            + 'follow it via `delegate_wait` inside this same MCP call and return the compact wait answer plus '
            + '`submitted: true` and `submitReceipt`. If the follow-up wait fails after submission succeeded, this '
            + 'call still returns `submitted: true`, `taskId`, `submitReceipt` and `waitError` so you never lose the '
            + 'task id or resubmit a duplicate.',
        },
        waitSeconds: {
          type: 'integer',
          minimum: MIN_WAIT_SECONDS,
          maximum: MAX_WAIT_SECONDS,
          description: 'OPTIONAL (only valid with `wait: true`). Wait budget in seconds; omit to use the default 3600s.',
        },
        goalDescription: {
          type: 'string',
          maxLength: MAX_TASK_DESCRIPTION_CHARS,
          // The bound is counted in Unicode code points, not in UTF-16 units.
          codePointLength: true,
          description: 'OPTIONAL. What THIS round of work is for, in your own words: the goal you planned, '
            + 'not the packet of instructions (that is `prompt`). At most 2000 Unicode code points, so Chinese, '
            + 'line breaks and emoji each count once; surrounding whitespace is trimmed and inner line breaks are '
            + 'kept. A longer value, or one that is not a string (including `null`), is REFUSED before a task '
            + 'exists \u2014 it is never shortened \u2014 and a blank value is the same as omitting it. It is stored with the '
            + 'task record and appears in the `goalDescription` field of the task view that `delegate_submit` '
            + 'returns and of `delegate_result`; it is never derived from the prompt, a parent task or the result, '
            + 'and it does not change what the worker is told.',
        },
        planNodeId: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: 'OPTIONAL. The `nodeId` (`plan-...`) of an existing planning node created with `delegate_plan` '
            + 'that THIS execution task carries out. Starts a new DSH Session for that planned item; later '
            + 'rectification rounds of this same item use `continueFromTaskId` and automatically inherit `planNodeId`. '
            + 'Do NOT pass a sibling subtask\u2019s `planNodeId` together with `continueFromTaskId`.',
        },
        parentNodeId: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: 'OPTIONAL. The `nodeId` (`plan-...`) or `taskId` (`task-...`) of the parent goal or parent task '
            + 'when submitting a child subtask directly without pre-creating a leaf `planNodeId`. Starts a NEW DSH '
            + 'Session under that parent; never reuses the parent\u2019s Session (`continueFromTaskId` is for rectification '
            + 'rounds of the SAME item only).',
        },
      },
      required: ['workspacePath', 'prompt'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'delegate_result',
    title: 'Read task result',
    description: 'Read one task this connection submitted: state, effective provider/model/effort, '
      + 'changed-file summary, bounded diff, validation evidence and review outcome. '
      + 'A finished execution is not host acceptance. '
      + 'The review note and completion summary are returned in full when they fit; when the whole answer is '
      + 'too large they are marked `hostAcceptance.noteOmitted: true` (read with `reviewNoteOffset`/'
      + '`reviewNoteLimit`) or `hostAcceptance.completionSummaryOmitted: true` (read with '
      + '`completionSummaryOffset`/`completionSummaryLimit`), never silently shortened.',
    // A read of a stored task: no work is created, changed or cancelled.
    annotations: Object.freeze({
      title: 'Read task result',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task identity returned by delegate_submit.' },
        reviewNoteOffset: {
          type: 'integer',
          minimum: 0,
          description: 'Read the review note from this CODE-POINT offset. Omit it for the normal full result; '
            + 'supplying it (with or without reviewNoteLimit) returns ONLY the note slice plus its total '
            + 'length, nextOffset and complete.',
        },
        reviewNoteLimit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_REVIEW_NOTE_PAGE_CHARS,
          description: `Code points of the review note to return per page (1..${MAX_REVIEW_NOTE_PAGE_CHARS}, `
            + 'default 2000). Only meaningful together with reviewNoteOffset.',
        },
        completionSummaryOffset: {
          type: 'integer',
          minimum: 0,
          description: 'Read hostAcceptance.completionSummary from this CODE-POINT offset when '
            + 'completionSummaryOmitted is true. Returns ONLY the summary slice plus summaryChars, nextOffset and complete.',
        },
        completionSummaryLimit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_COMPLETION_SUMMARY_PAGE_CHARS,
          description: `Code points of completionSummary per page (1..${MAX_COMPLETION_SUMMARY_PAGE_CHARS}, `
            + 'default 2000). Only meaningful together with completionSummaryOffset.',
        },
        includeDiff: {
          type: 'boolean',
          description: 'OPTIONAL, default true (MCP-only control flag). Set to false to omit `task.diff.patchText` '
            + 'while keeping changed file paths, counts, summary, execution receipt and review state — useful when '
            + 'the commander inspects the diff directly inside `executionWorkspacePath` to avoid duplicate context.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'delegate_wait',
    title: 'Wait for a task to need you',
    description: 'Follow ONE task this connection submitted and return as soon as it needs the host. '
      + 'A single call blocks for up to waitSeconds (default 3600) and returns a COMPACT answer: '
      + '`reason` is `permission` (a per-call request is pending), `question` (the worker asked a native '
      + 'question that needs `delegate_question_answer`), `attention` (a progress check because nothing new was '
      + 'returned to the host for the operator-configured delivery interval in DSH settings — 40 minutes by '
      + 'default; internal worker activity does not reset this clock and it does NOT imply the run is stuck — '
      + 'or a `repeated-tool-failure` reminder), `ready` (the run ended and is awaiting host review), `failed`, '
      + '`cancelled` or `interrupted`. '
      + 'An `attention` answer may instead carry a `failure` block (kind `repeated-tool-failure`, with '
      + 'a stable `eventId`, toolName/failureCode/consecutive): the worker repeated the SAME operation and failed the same way '
      + 'several times in a row. It is a question for the host, and it is REDELIVERED until you acknowledge it with '
      + '`ackFailureEventId` (the eventId you saw), so a lost answer is never a lost reminder; acknowledging stops the '
      + 'redelivery and does not decide anything about the task. Nothing is cancelled, retimed '
      + 'or reconfigured automatically. '
      + '`reason: "wait-limit"` means only that this call\u2019s own budget ran out with nothing changed: it is '
      + 'reported with `actionable: false` and `terminal: false`. Call delegate_wait again with the same '
      + 'taskId and omit waitSeconds — do not review, resubmit, restart or cancel the task. '
      + 'Normal use is delegate_wait({ taskId }) with no second argument: the default already covers a full '
      + 'hour and the call re-issues its own internal observations, so there is no reason to shorten it or to '
      + 'poll delegate_result or delegate_status while a task runs. A shorter waitSeconds is accepted for a '
      + 'one-off diagnostic you were explicitly asked for. '
      + 'The internal observation cadence (about one bounded request every 25 seconds) belongs to THIS '
      + 'program; it is not a polling rate for the agent, and nothing about it requires action while nothing '
      + 'has changed. '
      + 'Heartbeats are internal to this call and are never returned. '
      + 'This tool reads; it never submits, cancels or decides anything, and it does not fetch the task\u2019s '
      + 'diff or full result (use delegate_result for that, after an actionable reason). '
      + 'On `permission`, the returned `permission` block carries the pending request with its requestId, '
      + 'its exact fingerprint and the full existing redacted operation, so delegate_permission_decide can '
      + 'be sent without another read. '
      + '`interrupted` does NOT mean the execution stopped. This call answers it immediately, once: '
      + 'when the task is still pending or running the answer is `reason: "interrupted"` with '
      + '`terminal: false` and the real task state, and YOU wait again on the same taskId. '
      + '`terminal: true` with `state: "interrupted"` means the task record itself is a restart history '
      + 'and will not resume. If the reason carried a settled state it is reported as that outcome '
      + '(`ready`/`failed`/`cancelled`). A missing or unrecognized state is reported as '
      + '`terminal: false` with nothing asserted: check before deciding. '
      + 'This call ending, or your own client tool timeout firing, says NOTHING about the execution: the task '
      + 'may still be running. Keep its taskId, and if you need to know more read one compact fact with '
      + 'delegate_result rather than assuming either way; never submit a duplicate, restart or cancel it '
      + 'because a wait or a client timeout ended. '
      + 'A host may hand a wait back early on its own tool/exec time limit even though this call asked for an '
      + 'hour. That outer event is not `wait-limit` and is not a result: the MCP observation did not end and the '
      + 'worker did not stop. Continue the SAME exec cell (do not open a second wait, read delegate_result, poll '
      + 'delegate_status or submit a duplicate) and ask for the longest yield the host supports — when a yield or '
      + 'pragmas parameter exists, an ordinary wait should request roughly 1200000 ms (20 minutes), not a minute, '
      + 'and re-issuing every second is polling rather than waiting. A one-minute return is a caller choice, not a '
      + 'documented hard limit, so do not present it as the client maximum and do not claim every client offers '
      + 'the same yield. This plugin cannot create a background waiter or wake the agent: if the available yield '
      + 'is genuinely short with no automatic continuation, a long wait costs one resumed turn per yield window, '
      + 'and that limit must be reported honestly rather than worked around.',
    // A LONG read, and that is the point: `readOnlyHint` is what tells a
    // concurrency-aware client this call may be held for an hour without being a
    // mutating operation. A serialising host still ignores it; the independent
    // `dsh-delegate-control` channel is the answer there.
    // A LONG read of the task that can also ACKNOWLEDGE a reminder: the
    // `ackFailureEventId` argument clears the monitor's reminder state, which is a
    // state change even though it never touches the task, a decision or a run — so
    // `readOnlyHint` is FALSE and must stay false. `destructiveHint` stays false:
    // acknowledging stops nothing, decides nothing and rewinds nothing. The
    // annotations are a description of the tool, not an execution-permission guard.
    annotations: Object.freeze({
      title: 'Wait for a task to need you',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task identity returned by delegate_submit.' },
        waitSeconds: {
          type: 'integer',
          minimum: MIN_WAIT_SECONDS,
          maximum: MAX_WAIT_SECONDS,
          description: 'OPTIONAL. Omit it for normal waiting: the default is 3600 seconds (one hour). '
            + 'Set it only for a shorter, one-off diagnostic you were explicitly asked to make. It cannot '
            + 'extend a wait beyond 3600. A returned `wait-limit` with `actionable: false` means this '
            + 'deadline was reached, not that the task stalled or ended.',
        },
        ackFailureEventId: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description: 'OPTIONAL. The `failure.eventId` from an earlier delegate_wait answer. A repeated-failure '
            + 'reminder is redelivered until you acknowledge it: pass its eventId here to say you received it. '
            + 'Acknowledging does not decide anything about the task and does not stop the run, but it DOES '
            + 'clear the reminder state, which is why this tool is not announced read-only. A wrong eventId is '
            + 'refused in the answer (`failureAck.acknowledged: false`) and changes nothing. An empty string is '
            + 'refused, not ignored.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'delegate_cancel',
    title: 'Cancel task',
    description: 'Ask the harness to stop one task this connection submitted, and return its state afterwards.',
    // It stops running work: destructive of the run (never of the workspace), and a
    // second call on an already-cancelled task changes nothing.
    annotations: Object.freeze({
      title: 'Cancel task',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    }),
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task identity returned by delegate_submit.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'delegate_permission_decide',
    title: 'Decide a paused permission request',
    description: 'Decide ONE per-call permission request that a delegated task is waiting on. '
      + 'A delegated worker runs in its own workspace with a standing `workspace-write` sandbox; '
      + 'when it asks to widen access for a single tool call, that call PAUSES and the request appears '
      + 'in delegate_result as `permission.pending` (state stays `running`, phase `awaiting-permission`). '
      + 'Read `permission.pending.arguments`/`argumentKeys` for the exact operation and `permission.pending.reason` '
      + 'for the asker\u2019s claim — the claim is not the operation. Answer `allow-once` to let THAT ONE call '
      + 'proceed, or `reject` to keep it denied. Every later escalation requires a separate decision. '
      + 'This cannot grant an account, a workspace or a standing policy, cannot change settings, credentials, '
      + 'the switch, the provider/model or the isolation, and cannot grant cross-task or standing permissions. '
      + '`allow-once` REQUIRES the pending request\u2019s `fingerprint` and is refused when `permission.pending.'
      + 'completeness` is not `complete` (the operation was shortened by a bound, so an allow cannot be granted '
      + 'on it). `reject` needs neither and is therefore always available. '
      + 'OPTIONAL `waitAfterDecision` (default false) decides and then keeps following the SAME task inside this '
      + 'same call, answering in the compact `delegate_wait` shape plus a `decisionReceipt`. Use it when your '
      + 'channel supports it: deciding and then waiting is what resumes the task without a second call. The '
      + 'receipt states what happened to the decision: `applied: true` ONLY when the harness confirmed the same '
      + 'task, request and operation, and `applied: null` with `confirmation: "unknown"` when nothing was '
      + 'established (the call failed before an answer, or the answer contradicted or lacked the evidence to '
      + 'confirm it — then read the task with delegate_result before sending it again). An unconfirmed decision is '
      + 'refused and never continued. A refused decision never waits, a new request is never inherited, and when '
      + 'an APPLIED decision\'s follow-up wait fails or is cancelled this call still succeeds with the receipt, '
      + '`reason: null` and a `waitError` block: the decision is never unsaid.',
    // It does not read and it does not write a configuration: it settles ONE paused
    // call. A repeated decision for the same request is refused, so it is not
    // idempotent — the second call is a different outcome by design.
    annotations: Object.freeze({
      title: 'Decide a paused permission request',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    }),
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task identity returned by delegate_submit.' },
        requestId: { type: 'string', description: 'The pending request\u2019s `requestId`, copied from delegate_result.' },
        decision: {
          type: 'string',
          enum: ['allow-once', 'reject'],
          description: 'allow-once permits exactly the paused call; reject keeps it denied.',
        },
        reason: {
          type: 'string',
          description: 'Optional bounded note recorded with the decision. It is evidence, never a grant.',
        },
        fingerprint: {
          type: 'string',
          description: 'The pending request\u2019s `fingerprint`. REQUIRED for `allow-once`: the decision must name '
            + 'the exact operation it grants, and an allow that omits it is refused. Optional for `reject` (a '
            + 'refusal is safe without it); when supplied, a request whose operation no longer matches is refused.',
        },
        scope: {
          type: 'string',
          enum: ['once', 'task-command'],
          description: 'OPTIONAL, default `once`. Use `once` to permit only this exact paused call. The preview '
            + 'value `task-command` is accepted with `allow-once` as a compatibility alias for `once`.',
        },
        waitAfterDecision: {
          type: 'boolean',
          description: 'OPTIONAL, default false: the historical behaviour — decide only, and the answer is the '
            + 'permission route\'s own reply, unchanged. Set it to true to keep following the SAME task inside this '
            + 'same call after the decision is applied and confirmed. The answer is then the SAME compact shape '
            + '`delegate_wait` returns — `reason`/`state`/`actionable`/`terminal`/`task`, and for a new request the '
            + 'whole redacted `permission` operation with its `completeness` and `fingerprint` — plus '
            + '`decisionReceipt` (taskId, requestId, decision, fingerprint, `applied`, `confirmation`, `outcome`). '
            + '`applied: true` is claimed only when the harness confirmed the SAME task, request and operation; a '
            + 'CONTRADICTED or evidence-free answer is `applied: null` with `confirmation: "unknown"`, which is '
            + 'refused (MCP_DECISION_UNCONFIRMED) and never continued. The request you just decided is never asked '
            + 'again and never re-approved: the wait continues past it. A NEW request id, or the same id with a '
            + 'changed operation, is a new question and is NOT inherited. A decision that is refused never starts a '
            + 'wait. When the decision IS applied but the following wait fails, is cancelled or is interrupted, '
            + 'this call still SUCCEEDS with `decisionReceipt.applied: true`, `reason: null`, `actionable: false` '
            + 'and a `waitError` block: the decision stands, only the waiting ended, the execution was not stopped, '
            + 'and the decision must not be resent. For the same waiting rules as `delegate_wait`: omit '
            + 'waitSeconds, expect `wait-limit` to mean "wait again on the same taskId", and never read intermediate '
            + 'code while it waits.',
        },
      },
      required: ['taskId', 'requestId', 'decision'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'delegate_question_answer',
    title: 'Answer a question a delegated worker asked',
    description: 'Answer ONE ordinary question that a delegated task is waiting on. '
      + 'A delegated worker may ask a human a question with the native `ask_user_question` tool — typically '
      + 'because something is ambiguous, or because it needs a choice it must not make itself. That tool call '
      + 'PAUSES, the task stays `running` with phase `awaiting-question`, and the question appears in '
      + '`delegate_wait` as `reason: "question"` with the full `question` block: `requestId`, `taskId`, '
      + '`sessionId`, `callId` and `questions[]` (`id`, `question`, `header`, `detail`, `options[]` with '
      + '`label`/`description`, `multiSelect`). Nothing about the worker\u2019s reasoning or transcript is included. '
      + 'Answer with `answers`: one entry per question, each naming that question\u2019s `id` exactly once, with '
      + '`selected` (labels that question actually offered) and/or non-empty `custom` text. A single-select '
      + 'question takes at most one offered label; every asked question must be answered; an unknown id or a label the '
      + 'question did not offer is refused and the question STAYS PENDING so a correct answer can still be made. '
      + 'This tool does NOT grant access. Answering a question is not an approval and creates no authorization, '
      + 'sandbox widening, standing grant or policy change; a worker that needs wider access must still request '
      + 'it through `delegate_permission_decide`, and a question that presents an approval (`intent` of '
      + '`approval`) is REFUSED here with `QUESTION_APPROVAL_INTENT` — that channel is the only one that can '
      + 'grant, and the refused question fails promptly instead of hanging. A `plan-review` question is an '
      + 'information answer and grants nothing either. '
      + 'An answer applies ONCE: repeating it is refused as `QUESTION_ALREADY_ANSWERED`, an expired or '
      + 'cancelled question cannot be answered, and a question is never answerable across tasks or after a '
      + 'restart. '
      + 'OPTIONAL `waitAfterAnswer` (default false) answers and then keeps following the SAME task inside this '
      + 'same call, answering in the compact `delegate_wait` shape plus an `answerReceipt`. When the answer IS '
      + 'applied but the following wait fails, is cancelled or is interrupted, this call still SUCCEEDS with '
      + '`answerReceipt.applied: true`, `reason: null` and a `waitError` block: the answer stands and must not be '
      + 'sent again.',
    // It settles ONE paused question. It cannot read a configuration, create work or grant
    // anything, and a second answer to the same question is refused — so it is not
    // idempotent by design.
    annotations: Object.freeze({
      title: 'Answer a question a delegated worker asked',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    }),
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task identity returned by delegate_submit.' },
        requestId: {
          type: 'string',
          description: 'The pending question\u2019s `requestId`, copied from the `question` block of delegate_wait.',
        },
        answers: {
          type: 'array',
          description: 'One entry per asked question, each naming that question\u2019s id exactly once.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'The question id, copied from `questions[].id`.' },
              selected: {
                type: 'array',
                items: { type: 'string' },
                description: 'Labels this question actually offered. A single-select question takes at most one.',
              },
              custom: {
                type: 'string',
                maxLength: QUESTION_BOUNDS.customChars,
                description: 'Optional free-text answer. Required when the question offers no options.',
              },
            },
            required: ['id'],
            additionalProperties: false,
          },
        },
        waitAfterAnswer: {
          type: 'boolean',
          description: 'OPTIONAL, default false: answer only, and the answer is the question route\u2019s own reply. '
            + 'Set it to true to keep following the SAME task inside this same call after the answer is applied. '
            + 'The answer is then the SAME compact shape `delegate_wait` returns plus `answerReceipt` '
            + '(taskId, requestId, `applied`, `confirmation`, answers). When the answer IS applied but the '
            + 'following wait fails, is cancelled or is interrupted, this call still SUCCEEDS with '
            + '`answerReceipt.applied: true`, `reason: null`, `actionable: false` and a `waitError` block: the '
            + 'answer stands, only the waiting ended, and it must not be resent. A refused answer never starts a '
            + 'wait.',
        },
      },
      required: ['taskId', 'requestId', 'answers'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'delegate_review',
    title: 'Record the host review of a delivered task',
    description: 'Record YOUR OWN delivery review of one task this connection submitted. A finished run stays '
      + '\u0060awaiting-host-review\u0060 until you say what you concluded: this tool records that conclusion, and it '
      + 'is the only thing that does. '
      + '\u0060decision: "accepted"\u0060 means you reviewed the evidence with \u0060delegate_result\u0060 and it is right; '
      + '\u0060decision: "changes-requested"\u0060 means it needs correction. Either way \u0060note\u0060 is required and '
      + 'bounded (at most 8000 Unicode code points, so Chinese, line breaks and emoji all count once) — it is the '
      + 'recorded conclusion, not a place for secrets. A longer note is refused before anything is written; it is '
      + 'never silently shortened. '
      + 'This cannot approve a permission request, change the switch, a provider, a model, the isolation or a '
      + 'credential, merge or apply the diff, or create another task. Execution completion is never accepted '
      + 'automatically: until this is called the task stays unreviewed. '
      + 'Only a task awaiting host review (execution finished) can be reviewed; a running, failed, cancelled or '
      + 'interrupted task, or another connection\u2019s task, is refused. '
      + 'The first decision is final for this task: repeating the SAME decision with the SAME note is an '
      + 'idempotent no-op, and a DIFFERENT conclusion is refused \u2014 send a follow-up task with '
      + '\u0060continueFromTaskId\u0060 instead, so the original conclusion is preserved.',
    // It records a conclusion on an existing task. It can neither read a workspace nor
    // start, stop or re-configure anything, and a replayed identical decision changes
    // nothing — but a DIFFERENT second decision is a refusal, so it is not fully
    // idempotent either.
    annotations: Object.freeze({
      title: 'Record the host review of a delivered task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    }),
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task identity returned by delegate_submit.' },
        decision: {
          type: 'string',
          enum: ['accepted', 'changes-requested'],
          description: 'accepted records that you reviewed the result and accept it; changes-requested records '
            + 'that it needs correction.',
        },
        note: {
          type: 'string',
          maxLength: MAX_REVIEW_NOTE_CHARS,
          // The bound is counted in Unicode code points, not in UTF-16 units.
          codePointLength: true,
          description: 'Required non-empty bounded conclusion (at most 8000 Unicode code points), stored redacted. '
            + 'The count is Unicode code points, so Chinese text, line breaks and emoji each count once; a longer '
            + 'note is refused with its actual length instead of being cut. '
            + 'It is evidence of your review, never a grant and never a place for credentials.',
        },
        completionSummary: {
          type: 'string',
          maxLength: MAX_TASK_DESCRIPTION_CHARS,
          codePointLength: true,
          description: 'OPTIONAL. What was actually DONE in this round, in your own words, after reviewing the '
            + 'evidence \u2014 the counterpart of the submission\u2019s `goalDescription`. At most 2000 Unicode code points '
            + '(Chinese, line breaks and emoji count once); surrounding whitespace is trimmed and inner line breaks '
            + 'are kept; a longer or non-string value is refused, never shortened; a blank value is the same as '
            + 'omitting it. It may accompany `accepted` or `changes-requested` \u2014 with the latter it states only the '
            + 'part that was completed and does NOT mean the task passed. It is recorded inside the same review '
            + 'write as `decision` and `note`, under `hostAcceptance.completionSummary`, and becomes visible only '
            + 'once that write is durable. A finished execution, worker output or a run that merely looked '
            + 'successful never produces one. It is part of the review\u2019s identity: repeating the same decision and '
            + 'note WITH the same summary is an idempotent no-op, and a different summary \u2014 or adding one to an '
            + 'already recorded review \u2014 is refused like any other different conclusion.',
        },
        receiptOnly: {
          type: 'boolean',
          description: 'Set true to return the task ID and reviewPersistence only. Read full details with delegate_result.',
        },
      },
      required: ['taskId', 'decision', 'note'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'delegate_plan',
    title: 'Manage multi-level task plan tree',
    description: 'Create, update, review or read durable planning nodes (`plan-...`) for a multi-stage goal without '
      + 'fabricating dummy worker executions. Use `action: "create"` to record a root goal and optional multi-level '
      + 'subtask breakdown (single node via `title`, or atomic batch via `nodes[]` using `key`/`parentKey` or '
      + '`parentNodeId`). Then dispatch each executable leaf packet with `delegate_submit` passing `planNodeId` (or '
      + '`parentNodeId` for a direct child subtask); use `continueFromTaskId` ONLY for rectification rounds of that '
      + 'same node. Use `action: "review"` to record the commander\u2019s conclusion (`accepted` or `changes-requested`, '
      + '`note`, optional `completionSummary`) on a goal/plan node once its required children are verified. Use '
      + '`action: "get"` or `action: "list"` to inspect planning nodes, hierarchy, orphans and source-project grouping. '
      + 'Creates no grant, changes no setting/provider/switch, and starts no worker.',
    annotations: Object.freeze({
      title: 'Manage multi-level task plan tree',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    }),
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'review', 'get', 'list'],
          description: 'Operation to perform on the plan store.',
        },
        nodeId: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: 'Target `plan-...` node id (required for `update`, `review` and `get`).',
        },
        parentNodeId: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: 'Optional existing parent `plan-...` or `task-...` id when creating child plan node(s).',
        },
        workspacePath: {
          type: 'string',
          minLength: 1,
          maxLength: 4096,
          description: 'Absolute path of the operator-authorized SOURCE repository this goal belongs to (used for '
            + 'verified project grouping and source consistency checks; filter on `list`).',
        },
        title: {
          type: 'string',
          minLength: 1,
          maxLength: PLAN_TITLE_MAX_CHARS,
          codePointLength: true,
          description: 'Readable node title (1..120 Unicode code points; required for single-node `create`).',
        },
        goalDescription: {
          type: 'string',
          maxLength: MAX_TASK_DESCRIPTION_CHARS,
          codePointLength: true,
          description: 'Optional planned objective of this node (at most 2000 Unicode code points).',
        },
        decision: {
          type: 'string',
          enum: ['accepted', 'changes-requested'],
          description: 'Commander review decision for `action: "review"`.',
        },
        note: {
          type: 'string',
          maxLength: MAX_REVIEW_NOTE_CHARS,
          codePointLength: true,
          description: 'Required review conclusion note (at most 8000 Unicode code points) for `action: "review"`.',
        },
        completionSummary: {
          type: 'string',
          maxLength: MAX_TASK_DESCRIPTION_CHARS,
          codePointLength: true,
          description: 'Optional summary of what was actually accomplished (at most 2000 Unicode code points) for `action: "review"`.',
        },
        nodes: {
          type: 'array',
          description: `Optional atomic batch of 1..${MAX_PLAN_BATCH} plan nodes for \`action: "create"\`.`,
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', minLength: 1, maxLength: 64, description: 'Local batch key so children in the same batch can reference `parentKey`.' },
              parentKey: { type: 'string', minLength: 1, maxLength: 64, description: 'References `key` of a parent item in this same `nodes` batch.' },
              parentNodeId: { type: 'string', minLength: 1, maxLength: 256, description: 'References an already-stored `plan-...` or `task-...` parent (mutually exclusive with `parentKey`).' },
              title: { type: 'string', minLength: 1, maxLength: PLAN_TITLE_MAX_CHARS, codePointLength: true, description: 'Node title (1..120 Unicode code points).' },
              goalDescription: { type: 'string', maxLength: MAX_TASK_DESCRIPTION_CHARS, codePointLength: true, description: 'Optional planned objective (at most 2000 Unicode code points).' },
              workspacePath: { type: 'string', minLength: 1, maxLength: 4096, description: 'Optional absolute source repository path (must match parent when parent has one).' },
            },
            required: ['title'],
            additionalProperties: false,
          },
        },
      },
      required: ['action'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'delegate_preflight',
    title: 'Inspect workspace before dispatch',
    description: 'Read-only preflight of one absolute workspace path: whether it is a git repository with a commit, '
      + 'whether it is clean, how many files are changed (with a bounded path list), and the isolation to request '
      + '(worktree / shared / block) with a stable reason code. '
      + 'It creates no commit, stash, worktree or task and changes no setting; '
      + 'passing allowShared acknowledges a dirty workspace but does not dispatch anything.',
    // A read-only measurement of a directory: nothing is created or changed.
    annotations: Object.freeze({
      title: 'Inspect workspace before dispatch',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        workspacePath: { type: 'string', description: 'Absolute path of the workspace to inspect.' },
        allowShared: {
          type: 'boolean',
          description: 'Set only after deciding explicitly that a dirty workspace may run in place (shared isolation). '
            + 'Omit it to be told that a decision is required instead.',
        },
      },
      required: ['workspacePath'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'delegate_metrics',
    title: 'Read this MCP session\'s accounting',
    description: 'Report bounded accounting for THIS MCP process only: how many times each tool was called, how '
      + 'many wait answers were handed back and why, how much data they carried (UTF-8 bytes), how many PER-CALL '
      + 'permission decisions were applied, and the wait that followed each decision with its own reason, '
      + 'duration and size. '
      + 'These are counts of the PROGRAM (this process and its internal observations), not of model activity: '
      + 'the host model\u2019s own turns, token usage and cost are not observable from here and are returned as '
      + '"not-integrated", never as 0. A read-only census of THIS connection with no task identity required; '
      + 'it carries no tool arguments, no reasoning, no answer body, no credential and no task content, and it '
      + 'cannot change anything. The counters live in memory and reset when this MCP process restarts.',
    annotations: Object.freeze({
      title: 'Read this MCP session\'s accounting',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
    inputSchema: Object.freeze({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
  }),
]);

/**
 * Refusal codes that mean "the harness never answered", so a decision's outcome is UNKNOWN.
 *
 * Every other code the permission route can produce (`PERMISSION_REQUEST_CHANGED`,
 * `PERMISSION_EVIDENCE_INCOMPLETE`, `DELEGATION_DISABLED`, `JOB_TASK_NOT_FOUND`, …) is the
 * harness's own verdict: the decision was definitely NOT applied. The distinction matters
 * because a clean "failed" invites a resend, while an unconfirmed decision might already be
 * in force — a resend there is a second authorization attempt, and the caller must read the
 * task first.
 * @type {ReadonlySet<string>}
 */
const UNCONFIRMED_DECISION_CODES = new Set([
  'MCP_HARNESS_UNREACHABLE',
  'MCP_HARNESS_MALFORMED',
  'MCP_REQUEST_CANCELLED',
  'MCP_CALL_FAILED',
  'MCP_CONFIG_INVALID',
  // The request outlived its own timeout. The plane may have applied the decision or
  // answer before the connection was abandoned, so this is UNKNOWN in the same way as a
  // dropped connection — not a clean refusal that invites a resend.
  'MCP_REQUEST_TIMEOUT',
]);

/** Tool name → the execution-plane call it makes. */
const TOOL_ROUTES = Object.freeze({
  delegate_status: 'status',
  delegate_submit: 'submit',
  delegate_result: 'result',
  delegate_wait: 'observe',
  delegate_cancel: 'cancel',
  delegate_permission_decide: 'permission',
  delegate_question_answer: 'question',
  delegate_review: 'review',
  delegate_plan: 'plan',
  delegate_preflight: 'preflight',
  // No plane route: the census is this process's own and travels to no backend.
  delegate_metrics: null,
});

/** Canonicalize a description argument (enforcing post-redaction code-point bound). */
function canonicalizeToolDescription(tool, key, field) {
  const read = canonicalTaskDescription(field, key, redactText);
  if (read.ok === false) {
    throw new McpError('MCP_ARGUMENT_RANGE',
      `${tool.name}.${key} must be at most ${read.refusal.limit} Unicode code points, but it is ${read.refusal.length}`);
  }
  return read.value ?? '';
}

/**
 * The one argument this surface adds to a request it forwards.
 *
 * `waitAfterDecision` is a CONTROL field of the MCP call: it tells this server to keep
 * following the task after the decision. It is NOT part of the permission request, and
 * the decision route validates a closed field set, so forwarding it would turn every such
 * call into a refusal. It is stripped once — at the MCP boundary, in
 * {@link validateArgs} — and never reintroduced anywhere else.
 */
export const MCP_ONLY_ARGUMENTS = Object.freeze({
  delegate_submit: Object.freeze(['autoPreflight', 'allowShared', 'wait', 'waitSeconds']),
  delegate_result: Object.freeze(['includeDiff']),
  delegate_permission_decide: Object.freeze(['waitAfterDecision']),
  delegate_question_answer: Object.freeze(['waitAfterAnswer']),
});

/**
 * Validate one entry of a declared array argument.
 *
 * Handles exactly the item shapes this catalog declares — a string, or a closed object
 * with `string` and `string[]` fields plus an optional bounded `custom` string — so an
 * undeclared or wrong-typed entry is refused HERE, with its position named, instead of
 * reaching the plane. That matters for the answer batch: an answer that silently lost
 * or gained a label would be applied to a question it does not answer.
 * @param {object} tool - tool definition.
 * @param {string} key - the array argument's name.
 * @param {object} items - declared item schema.
 * @param {unknown} entry - one item.
 * @param {number} index - its position.
 * @returns {unknown} the validated item.
 */
function validateArrayItem(tool, key, items, entry, index) {
  const where = `${tool.name}.${key}[${index}]`;
  if (items.type === 'string' || items.type === undefined) {
    if (typeof entry !== 'string') throw new McpError('MCP_ARGUMENT_TYPE', `${where} must be a string`);
    return entry;
  }
  if (items.type !== 'object') throw new McpError('MCP_ARGUMENT_TYPE', `${where} has an unsupported item shape`);
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new McpError('MCP_ARGUMENT_TYPE', `${where} must be an object`);
  }
  const allowed = Object.keys(items.properties ?? {});
  for (const field of Object.keys(entry)) {
    if (!allowed.includes(field)) {
      throw new McpError('MCP_ARGUMENT_UNKNOWN', `${where} does not accept field ${JSON.stringify(field)}`);
    }
  }
  for (const field of items.required ?? []) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
      throw new McpError('MCP_ARGUMENT_REQUIRED', `${where}.${field} must be a non-empty string`);
    }
  }
  const out = {};
  for (const field of allowed) {
    if (!(field in entry)) continue;
    const declared = items.properties[field];
    const value = entry[field];
    if (declared.type === 'string') {
      if (typeof value !== 'string') throw new McpError('MCP_ARGUMENT_TYPE', `${where}.${field} must be a string`);
      if (typeof declared.maxLength === 'number' && declared.codePointLength === true) {
        const points = reviewNoteLength(normalizeReviewNote(value));
        if (points > declared.maxLength) {
          throw new McpError('MCP_ARGUMENT_RANGE',
            `${where}.${field} must be at most ${declared.maxLength} Unicode code points, but it is ${points}`);
        }
      } else if (typeof declared.maxLength === 'number' && value.length > declared.maxLength) {
        throw new McpError('MCP_ARGUMENT_RANGE',
          `${where}.${field} must be at most ${declared.maxLength} characters`);
      }
      if (typeof declared.minLength === 'number' && value.trim().length < declared.minLength) {
        throw new McpError('MCP_ARGUMENT_REQUIRED', `${where}.${field} must not be empty`);
      }
      out[field] = (field === TASK_DESCRIPTION_FIELDS.goal || field === TASK_DESCRIPTION_FIELDS.summary)
        ? canonicalizeToolDescription({ name: where }, field, value)
        : value;
      continue;
    }
    if (declared.type === 'array') {
      const itemType = declared.items?.type ?? 'string';
      if (!Array.isArray(value)) throw new McpError('MCP_ARGUMENT_TYPE', `${where}.${field} must be an array`);
      for (const item of value) {
        if (itemType === 'string' && typeof item !== 'string') {
          throw new McpError('MCP_ARGUMENT_TYPE', `${where}.${field} must contain strings only`);
        }
      }
      out[field] = [...value];
      continue;
    }
    throw new McpError('MCP_ARGUMENT_TYPE', `${where}.${field} has an unsupported type`);
  }
  return out;
}

/**
 * Validate one tool's arguments against its own schema.
 *
 * Written by hand rather than pulled from a schema validator because the shapes
 * here are four small objects; a validator dependency would be the largest thing
 * in this file for no extra safety.
 *
 * The returned object is the argument set this server will act on. Every declared
 * field survives; nothing undeclared does. The MCP-only control fields listed in
 * {@link MCP_ONLY_ARGUMENTS} stay in the object because they are declared — they are
 * removed at the point where a body is forwarded to the plane, which is the boundary
 * that must not see them.
 * @param {object} tool - definition from {@link TOOLS}.
 * @param {unknown} args - caller-supplied arguments.
 * @returns {object} the arguments to forward.
 */
function validateArgs(tool, args) {
  const value = args === undefined || args === null ? {} : args;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new McpError('MCP_ARGUMENTS_INVALID', `${tool.name} expects an object of arguments`);
  }
  const allowed = Object.keys(tool.inputSchema.properties ?? {});
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      // An undeclared argument is a caller bug or an attempt to reach a parameter
      // this surface does not have. Both are refused, and the message names the
      // field so the caller can fix it.
      throw new McpError('MCP_ARGUMENT_UNKNOWN', `${tool.name} does not accept argument ${JSON.stringify(key)}`);
    }
  }
  for (const key of tool.inputSchema.required ?? []) {
    const field = value[key];
    const declared = tool.inputSchema.properties?.[key] ?? {};
    if (declared.type === 'array') {
      // An array argument is required when it is present AND non-empty: an empty answer
      // batch is not an answer, and accepting one would settle a question with nothing.
      // A NON-array value is a type error, which is a different fact from a missing one
      // and is reported as such below by the per-field pass.
      if (field === undefined || field === null) {
        throw new McpError('MCP_ARGUMENT_REQUIRED', `${tool.name} requires a non-empty ${key}`);
      }
      if (Array.isArray(field) && field.length === 0) {
        throw new McpError('MCP_ARGUMENT_REQUIRED', `${tool.name} requires a non-empty ${key}`);
      }
      continue;
    }
    if (typeof field !== 'string' || field.trim() === '') {
      throw new McpError('MCP_ARGUMENT_REQUIRED', `${tool.name} requires a non-empty ${key}`);
    }
  }
  const out = {};
  for (const key of allowed) {
    if (!(key in value)) continue;
    const declared = tool.inputSchema.properties[key];
    const field = value[key];
    if (declared.type === 'string') {
      if (typeof field !== 'string') throw new McpError('MCP_ARGUMENT_TYPE', `${tool.name}.${key} must be a string`);
      // A declared bound is enforced, not merely advertised: a note over the limit is
      // refused with the field named instead of reaching the plane and being cut there.
      // A `maxLength` is a code-point bound (the shared review-note rule), so it is
      // measured the same way every other surface measures it: `.length` would count an
      // emoji twice and refuse a note the plane would have accepted.
      if (typeof declared.maxLength === 'number' && declared.codePointLength === true) {
        // Measured on the NORMALIZED text (the shared trim), so surrounding whitespace
        // cannot make this layer refuse a note the plane would have accepted.
        const points = reviewNoteLength(normalizeReviewNote(field));
        if (points > declared.maxLength) {
          throw new McpError('MCP_ARGUMENT_RANGE',
            `${tool.name}.${key} must be at most ${declared.maxLength} Unicode code points, but it is ${points}`);
        }
      } else if (typeof declared.maxLength === 'number' && field.length > declared.maxLength) {
        throw new McpError('MCP_ARGUMENT_RANGE', `${tool.name}.${key} must be at most ${declared.maxLength} characters`);
      }
      // A declared minLength is enforced too: an empty string is REFUSED with the field
      // named, never silently ignored — an ack whose id is empty is a caller bug, and
      // letting it through would answer "nothing to acknowledge" instead of the truth.
      if (typeof declared.minLength === 'number' && field.length < declared.minLength) {
        throw new McpError('MCP_ARGUMENT_REQUIRED', `${tool.name}.${key} must not be empty`);
      }
      // The two commander descriptions also pass the redaction-length half of the rule.
      out[key] = (key === TASK_DESCRIPTION_FIELDS.goal || key === TASK_DESCRIPTION_FIELDS.summary)
        ? canonicalizeToolDescription(tool, key, field)
        : field;
    } else if (declared.type === 'boolean') {
      // Strict: a model that sends the string "true" gets a refusal naming the
      // field instead of a silently truthy value reaching the plane.
      if (typeof field !== 'boolean') throw new McpError('MCP_ARGUMENT_TYPE', `${tool.name}.${key} must be a boolean`);
      out[key] = field;
    } else if (declared.type === 'integer') {
      // Strict for the same reason: `"3600"` and `3600.5` are refused with the
      // field named rather than silently coerced into a deadline nobody chose.
      if (!Number.isInteger(field)) throw new McpError('MCP_ARGUMENT_TYPE', `${tool.name}.${key} must be an integer`);
      if (typeof declared.minimum === 'number' && field < declared.minimum) {
        throw new McpError('MCP_ARGUMENT_RANGE', `${tool.name}.${key} must be at least ${declared.minimum}`);
      }
      if (typeof declared.maximum === 'number' && field > declared.maximum) {
        throw new McpError('MCP_ARGUMENT_RANGE', `${tool.name}.${key} must be at most ${declared.maximum}`);
      }
      out[key] = field;
    } else if (declared.type === 'object') {
      if (field === null || typeof field !== 'object' || Array.isArray(field)) {
        throw new McpError('MCP_ARGUMENT_TYPE', `${tool.name}.${key} must be an object`);
      }
      out[key] = field;
    } else if (declared.type === 'array') {
      // An array argument is validated ITEM BY ITEM against the declared item schema, so
      // a caller learns which entry is wrong instead of sending an object the plane must
      // then reject. Only the shapes this catalog declares are accepted: strings, or a
      // closed object with string/string-array fields and a bounded custom string.
      if (!Array.isArray(field)) throw new McpError('MCP_ARGUMENT_TYPE', `${tool.name}.${key} must be an array`);
      out[key] = field.map((entry, index) => validateArrayItem(tool, key, declared.items ?? {}, entry, index));
    } else {
      out[key] = field;
    }
    if (Array.isArray(declared.enum) && !declared.enum.includes(out[key])) {
      throw new McpError('MCP_ARGUMENT_ENUM', `${tool.name}.${key} must be one of ${declared.enum.join(', ')}`);
    }
  }
  if (tool.name === 'delegate_submit') {
    if (out.continueFromTaskId !== undefined && out.reuseWorktreeFromTaskId !== undefined) {
      throw new McpError('MCP_ARGUMENTS_INVALID', 'delegate_submit cannot combine continueFromTaskId and reuseWorktreeFromTaskId');
    }
    if (out.waitSeconds !== undefined && out.wait !== true) {
      throw new McpError('MCP_ARGUMENT_REQUIRED', 'delegate_submit.waitSeconds requires wait: true');
    }
    if (out.allowShared !== undefined && out.autoPreflight !== true) {
      throw new McpError('MCP_ARGUMENT_REQUIRED', 'delegate_submit.allowShared requires autoPreflight: true');
    }
  }
  if (tool.name === 'delegate_result') {
    if (out.reviewNoteLimit !== undefined && out.reviewNoteOffset === undefined) {
      throw new McpError('MCP_ARGUMENT_REQUIRED', 'delegate_result.reviewNoteLimit requires reviewNoteOffset');
    }
    if (out.completionSummaryLimit !== undefined && out.completionSummaryOffset === undefined) {
      throw new McpError('MCP_ARGUMENT_REQUIRED', 'delegate_result.completionSummaryLimit requires completionSummaryOffset');
    }
    if (out.reviewNoteOffset !== undefined && out.completionSummaryOffset !== undefined) {
      throw new McpError('MCP_ARGUMENTS_INVALID', 'delegate_result cannot combine reviewNoteOffset and completionSummaryOffset');
    }
  }
  if (tool.name === 'delegate_plan') {
    validatePlanArgs(out);
  }
  return out;
}

const PLAN_ACTION_ALLOWED = Object.freeze({
  create: Object.freeze(['action', 'title', 'goalDescription', 'parentNodeId', 'workspacePath', 'nodes']),
  update: Object.freeze(['action', 'nodeId', 'title', 'goalDescription', 'workspacePath']),
  review: Object.freeze(['action', 'nodeId', 'decision', 'note', 'completionSummary']),
  get: Object.freeze(['action', 'nodeId']),
  list: Object.freeze(['action', 'workspacePath']),
});

function validatePlanArgs(out) {
  const action = out.action;
  const allowed = PLAN_ACTION_ALLOWED[action];
  for (const key of Object.keys(out)) {
    if (!allowed.includes(key)) {
      throw new McpError('MCP_ARGUMENTS_INVALID', `delegate_plan action "${action}" does not accept ${JSON.stringify(key)}`);
    }
  }
  if (action === 'create') {
    if (out.nodes !== undefined) {
      if (out.nodes.length === 0 || out.nodes.length > MAX_PLAN_BATCH) {
        throw new McpError('MCP_ARGUMENT_RANGE', `delegate_plan.nodes must contain 1..${MAX_PLAN_BATCH} items`);
      }
      if (out.title !== undefined || out.goalDescription !== undefined) {
        throw new McpError('MCP_ARGUMENTS_INVALID', 'delegate_plan cannot combine batch `nodes` with top-level `title` or `goalDescription`');
      }
    } else if (typeof out.title !== 'string' || out.title.trim() === '') {
      throw new McpError('MCP_ARGUMENT_REQUIRED', 'delegate_plan create requires `title` (or a non-empty `nodes` batch)');
    }
    return;
  }
  if (action === 'update') {
    if (typeof out.nodeId !== 'string' || out.nodeId.trim() === '') {
      throw new McpError('MCP_ARGUMENT_REQUIRED', 'delegate_plan update requires `nodeId`');
    }
    if (out.title === undefined && out.goalDescription === undefined && out.workspacePath === undefined) {
      throw new McpError('MCP_ARGUMENT_REQUIRED', 'delegate_plan update requires at least one of `title`, `goalDescription` or `workspacePath`');
    }
    return;
  }
  if (action === 'review') {
    for (const req of ['nodeId', 'decision', 'note']) {
      if (typeof out[req] !== 'string' || out[req].trim() === '') {
        throw new McpError('MCP_ARGUMENT_REQUIRED', `delegate_plan review requires a non-empty \`${req}\``);
      }
    }
    return;
  }
  if (action === 'get') {
    if (typeof out.nodeId !== 'string' || out.nodeId.trim() === '') {
      throw new McpError('MCP_ARGUMENT_REQUIRED', 'delegate_plan get requires `nodeId`');
    }
  }
}

// ---------------------------------------------------------------------------
// Bounded projection
// ---------------------------------------------------------------------------
//
// A tool result is consumed by `JSON.parse`, not by a human reading a wall of
// text. The previous implementation enforced the bound by slicing the raw
// serialized JSON and appending a plain note, which produced text that began as
// JSON and ended as prose: every `delegate_result` over the bound was unparsable,
// and a coordinator whose audit diff was large enough to cross it saw
// `JSON.parse` fail and had to abandon the delegation. An unparsable answer is
// worse than a smaller answer, so the bound is now enforced *before*
// serialization, on the structure itself.
//
// The projection is deliberately field-aware rather than generic. A truncated
// result must still let a caller act, so identity, state, phase, routing,
// refusal and acceptance status are always kept intact; heavy evidence
// (diff/evidence/prompt) is trimmed to a headline first, and bounded prose
// (execution and review text) second. Everything that was cut is listed by path
// under a top-level `truncation` object, so "this list is short" is never
// mistaken for "this list was short".
//
// If even that cannot fit — a single critical field too large to serialize — the
// result is not labelled full and is not silently returned: it becomes an
// explicit `MCP_RESULT_OVER_BUDGET` tool error that still carries the task
// identity, so a caller can tell "the content did not fit" from "no such task".

/** Fields trimmed first: evidence whose size is the caller's, not the answer's. */
const HEAVY_FIELDS = Object.freeze(['diff', 'evidence', 'prompt']);

/**
 * Field-level caps that survive into a truncated answer. Each is a *ceiling*, not
 * a target: a projection over the overall bound is shrunk further, in the order
 * named above, until it fits.
 */
const TRUNCATED_FIELD_CAPS = Object.freeze({
  /** Diff patch text kept when the whole result does not fit (0 = headline only). */
  diffPatchChars: 0,
  /** Captured validation evidence kept per entry and overall. */
  evidenceEntryChars: 160,
  evidenceChars: 800,
  evidenceEntries: 8,
  /** The submitted prompt is never quoted in a truncated answer. */
  promptChars: 0,
  /** Bounded execution prose. */
  executionTextChars: 1_200,
  /** Bounded review prose. */
  reviewTextChars: 1_200,
  /** Per-entry cap for a list that is itself being cut (tasks, files, changes). */
  listItemChars: 2_000,
});

/** How deep the projection descends before it states a depth limit. */
const MAX_PROJECTION_DEPTH = 10;
const DEPTH_LIMIT_MARKER = '[depth limit: nested value not projected]';

/**
 * Whether a value can be serialized at all.
 *
 * `JSON.stringify` throws on a bigint and on a cycle, and silently turns a
 * function into nothing. All three would make the projected answer describe
 * something other than what was received, so they are checked up front and are
 * what `MCP_RESULT_UNSERIALIZABLE` reports.
 * @param {unknown} value - value to test.
 * @returns {boolean} true when the value round-trips through JSON.
 */
function isJsonProjectable(value) {
  const stack = new Set();
  const walk = (node) => {
    if (node === null) return true;
    const type = typeof node;
    if (type === 'string' || type === 'boolean') return true;
    if (type === 'number') return Number.isFinite(node);
    if (type === 'bigint' || type === 'function' || type === 'symbol' || type === 'undefined') return false;
    if (type !== 'object') return false;
    if (stack.has(node)) return false;
    stack.add(node);
    const values = Array.isArray(node) ? node : Object.values(node);
    const ok = values.every(walk);
    stack.delete(node);
    return ok;
  };
  return walk(value);
}

/**
 * Serialize once, at one indentation. JSON's escaping rules do not depend on
 * indentation, so a length measured compact is a valid upper bound for the same
 * value measured pretty, and {@link fitsBound} accepts either encoding.
 * @param {unknown} value - JSON value.
 * @returns {string} compact JSON text.
 */
function compactJson(value) {
  return JSON.stringify(value);
}

/**
 * Whether a projected value fits the tool-text bound when serialized compactly.
 *
 * Compact JSON (no indentation whitespace) is what {@link boundedJson} publishes to MCP
 * clients so wait, permission, and result turns avoid wasting commander context tokens
 * on formatting spaces.
 * @param {unknown} value - projected JSON value.
 * @returns {boolean} true when the value fits.
 */
function fitsBound(value) {
  return compactJson(value).length <= MAX_TOOL_TEXT_CHARS;
}

/**
 * Explain what was cut out of a container, in the index space of the returned
 * list, so a reader is never left inferring that the short list was all there was.
 * @param {string} path - JSON path of the container.
 * @param {object} options - `total`, `omitted` (count), `detail` (extra note).
 * @returns {object} truncation record.
 */
function truncationRecord(path, options) {
  const record = { path, field: 'list', omitted: options.omitted };
  if (options.total !== undefined) record.total = options.total;
  if (typeof options.detail === 'string') record.detail = options.detail;
  return record;
}

/**
 * Trim one string to a cap, stating the trim.
 * @param {string} text - source text.
 * @param {number} cap - characters to keep.
 * @param {string} path - JSON path, for the truncation record.
 * @param {object[]} out - records collected so far.
 * @returns {string} kept text (possibly empty).
 */
function boundedText(text, cap, path, out) {
  if (text.length <= cap) return text;
  out.push({ path, field: 'text', keptChars: cap, omittedChars: text.length - cap });
  return text.slice(0, cap);
}

/**
 * Recursively trim every string in a value to one cap, stating each cut.
 *
 * Used only by the terminal projection stage, where the answer is already
 * skeletonized and this catches whatever prose is left (a path list, a refusal
 * message). It is a safety net, not the primary strategy: field-aware trimming
 * above keeps the actionable parts intact, and this runs after them.
 * @param {unknown} value - value to trim.
 * @param {string} path - JSON path.
 * @param {number} cap - characters to keep per string.
 * @param {object[]} collect - truncation records.
 * @param {number} [depth] - recursion depth.
 * @returns {unknown} trimmed value.
 */
function trimAllStrings(value, path, cap, collect, depth = 0) {
  if (typeof value === 'string') return boundedText(value, cap, path, collect);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_PROJECTION_DEPTH) {
    collect.push({ path, field: 'value', detail: DEPTH_LIMIT_MARKER });
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => trimAllStrings(entry, `${path}[${index}]`, cap, collect, depth + 1));
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (isDescriptionField(key, item, path)) {
      out[key] = item;
      continue;
    }
    out[key] = trimAllStrings(item, childPath, cap, collect, depth + 1);
  }
  return out;
}

/** True when `value` is a legal description string at a published task/acceptance position. */
function isDescriptionField(key, value, parentPath) {
  if (key !== TASK_DESCRIPTION_FIELDS.goal && key !== TASK_DESCRIPTION_FIELDS.summary) return false;
  if (typeof value !== 'string') return false;
  if (key === TASK_DESCRIPTION_FIELDS.goal) {
    if (parentPath !== '' && parentPath !== 'task' && !/^tasks\[\d+\]$/u.test(parentPath)) return false;
  } else if (parentPath !== 'hostAcceptance'
    && parentPath !== 'task.hostAcceptance'
    && !/^tasks\[\d+\]\.hostAcceptance$/u.test(parentPath)) {
    return false;
  }
  return reviewNoteLength(value) <= TASK_DESCRIPTION_MAX_CHARS;
}

/**
 * Replace one heavy field with a bounded summary that keeps its shape.
 * @param {unknown} source - field value.
 * @param {string} path - JSON path.
 * @param {object[]} collect - truncation records.
 * @returns {unknown} bounded replacement.
 */
function reduceHeavy(source, path, collect) {
  if (source === null || source === undefined) return source;
  if (typeof source === 'string') {
    return boundedText(source, 0, path, collect);
  }
  if (typeof source !== 'object') return source;
  if (Array.isArray(source)) {
    const keep = Math.min(source.length, TRUNCATED_FIELD_CAPS.evidenceEntries);
    if (source.length > keep) collect.push(truncationRecord(path, { total: source.length, omitted: source.length - keep }));
    return source.slice(0, keep).map((entry, index) => {
      if (typeof entry === 'string') {
        return boundedText(entry, TRUNCATED_FIELD_CAPS.evidenceEntryChars, `${path}[${index}]`, collect);
      }
      return entry;
    });
  }
  const out = {};
  // Recorded rather than assigned in the loop: `patchTruncated` normally precedes
  // `patchText` in the source object, so an assignment made while visiting
  // `patchText` would be overwritten by the original `false` a moment later.
  let patchCut = false;
  for (const [key, value] of Object.entries(source)) {
    const childPath = `${path}.${key}`;
    if (typeof value === 'string') {
      const cap = key === 'patchText' ? TRUNCATED_FIELD_CAPS.diffPatchChars : TRUNCATED_FIELD_CAPS.evidenceEntryChars;
      out[key] = boundedText(value, cap, childPath, collect);
      if (key === 'patchText' && value.length > cap) patchCut = true;
      continue;
    }
    if (Array.isArray(value)) {
      const keep = Math.min(value.length, TRUNCATED_FIELD_CAPS.evidenceEntries);
      if (value.length > keep) collect.push(truncationRecord(childPath, { total: value.length, omitted: value.length - keep }));
      out[key] = value.slice(0, keep).map((entry, index) => (typeof entry === 'string'
        ? boundedText(entry, TRUNCATED_FIELD_CAPS.evidenceEntryChars, `${childPath}[${index}]`, collect)
        : entry));
      continue;
    }
    out[key] = value;
  }
  // Only ever turns the flag on: the engine's own `patchTruncated` (a patch it had
  // already cut) must not be cleared by this projection.
  if (patchCut) out.patchTruncated = true;
  return out;
}

/**
 * Bound the pending-question block of a wait answer, keeping it WHOLE or marking it unusable.
 *
 * A question is answerable only when the commander received it EXACTLY as the worker asked —
 * every question, header, detail, option label and description. A generic per-string cap
 * would shorten `question`/`detail` while the answer still advertised
 * `questionAnswerable: true`, so the commander could answer a question it never actually saw.
 * That is the defect this function exists to remove.
 *
 * The rule is therefore all-or-nothing on the block:
 *
 *  * it fits at its real serialised width → published VERBATIM;
 *  * it does not → published as an explicit omission (`questionsOmitted`, `questionAnswerable:
 *    false`, `reason: 'question-too-large'`), with identity and the count of questions kept so
 *    the host knows a question exists and must ask the worker to narrow it. No question text
 *    is carried, because a shortened one is worse than none: it invites a wrong answer.
 *
 * `deadlineAt` is kept in both forms so a host can still see how long the wait has left.
 * @param {object} block - the pending question block from the engine.
 * @param {string} path - JSON path for truncation records.
 * @param {object[]} collect - truncation records.
 * @param {number} budget - characters the whole block may occupy.
 * @returns {object | null} the bounded block, or null when there is none.
 */
function boundQuestionBlock(block, path, collect, budget) {
  if (block === null || block === undefined || typeof block !== 'object' || Array.isArray(block)) return null;
  if (block.pending !== null && typeof block.pending === 'object' && !Array.isArray(block.questions)) {
    if (Array.isArray(block.evidence) && block.evidence.length > 0) {
      collect.push(truncationRecord(`${path}.evidence`, { total: block.evidence.length, omitted: block.evidence.length }));
    }
    return {
      bridged: block.bridged === true,
      waiting: block.waiting === true,
      pending: boundQuestionBlock(block.pending, `${path}.pending`, collect, budget),
      evidence: [],
      pausedExecutionMs: block.pausedExecutionMs ?? 0,
    };
  }
  const dropped = truncationRecord(path, {
    total: Array.isArray(block.questions) ? block.questions.length : 0,
    omitted: Array.isArray(block.questions) ? block.questions.length : 0,
    detail: 'the question set did not fit the tool-text bound, so it is not published and cannot be answered',
  });
  let serialised;
  try {
    serialised = JSON.stringify(block);
  } catch {
    serialised = null;
  }
  if (serialised !== null && serialised.length <= budget) {
    // Whole: the exact questions the worker asked, untouched.
    return {
      ...block,
      questionsOmitted: block.questionsOmitted === true,
    };
  }
  collect.push(dropped);
  return {
    requestId: typeof block.requestId === 'string' ? block.requestId : null,
    taskId: typeof block.taskId === 'string' ? block.taskId : null,
    sessionId: typeof block.sessionId === 'string' ? block.sessionId : null,
    callId: typeof block.callId === 'string' ? block.callId : null,
    state: block.state ?? null,
    createdAt: block.createdAt ?? null,
    deadlineAt: block.deadlineAt ?? null,
    questionCount: Array.isArray(block.questions) ? block.questions.length : 0,
    // Stated three ways so no reader or older client can read this as answerable:
    questions: [],
    questionsOmitted: true,
    questionAnswerable: false,
    grantsAccess: false,
    reason: 'question-too-large',
  };
}

/**
 * Whether a published pending question can actually be answered from what the host received.
 *
 * One rule, in one place, so the flag and the block can never disagree: the state must be
 * `pending`, the question list must be non-empty, and the block must NOT be an omission. An
 * omission (`questionsOmitted: true`) is explicitly not answerable even though it has a
 * `requestId` — the host has no question text to answer, and answering would guess.
 * @param {object} question - the published question block.
 * @returns {boolean} true only when the whole question set was published.
 */
export function isQuestionAnswerable(question) {
  if (question === null || typeof question !== 'object') return false;
  if (!Array.isArray(question.questions) && question.pending !== undefined) return isQuestionAnswerable(question.pending);
  if (question.questionsOmitted === true) return false;
  if (question.state !== undefined && question.state !== 'pending') return false;
  return Array.isArray(question.questions) && question.questions.length > 0;
}

/**
 * The character budget a pending question block may occupy in one answer.
 *
 * The engine refuses to accept a question set whose serialised form exceeds 12 000
 * characters, so a legitimate block always fits this; anything larger can only be a
 * projection artifact and is therefore published as an explicit omission.
 */
const QUESTION_WIRE_BUDGET = 16_000;

/**
 * Copy a value without losing JSON-compatible structure.
 * @param {unknown} value - JSON value.
 * @returns {unknown} independent copy.
 */
function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Paths of the task-shaped objects inside one answer, keyed by identity.
 * @param {object} value - answer.
 * @returns {Map<object, string>} object → JSON path.
 */
function pathsFor(value) {
  const map = new Map();
  if (value?.task !== null && typeof value?.task === 'object' && !Array.isArray(value.task)) map.set(value.task, 'task.');
  if (Array.isArray(value?.tasks)) {
    for (let index = 0; index < value.tasks.length; index += 1) {
      const task = value.tasks[index];
      if (task !== null && typeof task === 'object' && !Array.isArray(task)) map.set(task, `tasks[${index}].`);
    }
  }
  return map;
}

/**
 * Trim the projected answer until it fits the bound, in a fixed order that
 * sacrifices the least actionable content last.
 *
 * Every stage keeps the task identity, state, phase, routing, refusal and
 * acceptance fields; they differ only in how much evidence and prose survives.
 * The first stage drops the patch text and the whole prompt (their file lists and
 * counts remain); later stages shorten execution and review prose, then cap list
 * lengths, and the last stage skeletonizes the task down to those critical fields
 * with a short per-string cap. Every cut is stated in `truncation.fields`.
 * @param {object} value - answer.
 * @param {{executionText: number, reviewText: number, lists: number, skeletonChars?: number}} stage - caps.
 * @param {object[]} collect - truncation records.
 * @returns {unknown} projected answer.
 */
function projectWithStage(value, stage, collect) {
  const projected = structuredCloneSafe(value);
  // The acknowledgment verdict is a fact the engine already acted on. Whatever a stage
  // trims elsewhere, this trio is restored verbatim on every stage so a compressed or
  // skeletonised answer cannot turn an applied confirmation into an unknown outcome.
  const projectedAck = minimalFailureAck(projected.failureAck);
  if (projectedAck !== null) projected.failureAck = projectedAck;
  for (const key of ['decisionReceipt', 'answerReceipt']) {
    const receipt = minimalReceipt(projected[key]);
    if (receipt !== null) {
      projected[key] = receipt;
      collect.push({ path: key, field: 'receipt', detail: 'identity and application facts retained; bulky evidence omitted' });
    }
  }
  if (projected.question !== null && typeof projected.question === 'object') {
    projected.question = boundQuestionBlock(projected.question, 'question', collect, QUESTION_WIRE_BUDGET);
  }
  const targets = pathsFor(projected);
  for (const [target, prefix] of targets) {
    for (const key of HEAVY_FIELDS) {
      if (!(key in target)) continue;
      target[key] = reduceHeavy(target[key], `${prefix}${key}`, collect);
    }
    if (target.execution !== null && typeof target.execution === 'object' && typeof target.execution.text === 'string') {
      target.execution.text = boundedText(
        target.execution.text, stage.executionText, `${prefix}execution.text`, collect,
      );
    }
    if (target.review !== null && typeof target.review === 'object' && typeof target.review.text === 'string') {
      target.review.text = boundedText(target.review.text, stage.reviewText, `${prefix}review.text`, collect);
    }
    if (typeof target.reviewRouteError === 'string') {
      target.reviewRouteError = boundedText(target.reviewRouteError, stage.skeletonChars ?? 400, `${prefix}reviewRouteError`, collect);
    }
    // A full result KEEPS the whole note while it fits; when a stage has to give it up it
    // is marked `noteOmitted` and read back in pages, never shortened. (`prefix` already
    // ends in a dot.) Skeleton stages bound `hostAcceptance` once inside `skeletonize`.
    if (stage.skeletonChars === undefined) {
      const acceptance = target.hostAcceptance;
      if (acceptance !== null && typeof acceptance === 'object' && !Array.isArray(acceptance)) {
        target.hostAcceptance = boundAcceptance(
          acceptance, `${prefix}hostAcceptance`, collect, stage.omitNote === true, stage.omitSummary === true,
        );
      }
    }
    // The settled decision trail is HISTORY; the pending request is the thing the
    // commander must act on NOW. Under a bound the history goes first, so a running
    // task can never keep an outstanding request invisible behind old evidence.
    const permission = target.permission;
    if (permission !== null && typeof permission === 'object' && Array.isArray(permission.evidence)) {
      const keep = Math.min(permission.evidence.length, stage.permissionEvidence);
      if (permission.evidence.length > keep) {
        collect.push(truncationRecord(`${prefix}permission.evidence`, {
          total: permission.evidence.length,
          omitted: permission.evidence.length - keep,
          detail: 'the live pending request is prioritised over settled history',
        }));
        // `slice(-0)` keeps EVERY entry, so the zero-keep stage would claim a drop
        // it did not perform and then still publish the history it said it removed.
        permission.evidence = keep === 0 ? [] : permission.evidence.slice(-keep);
      }
    }
  }
  if (stage.skeletonChars === undefined && projected.hostAcceptance !== null
    && typeof projected.hostAcceptance === 'object' && !Array.isArray(projected.hostAcceptance)) {
    projected.hostAcceptance = boundAcceptance(
      projected.hostAcceptance, 'hostAcceptance', collect, stage.omitNote === true, stage.omitSummary === true,
    );
  }
  if (Array.isArray(projected.tasks) && projected.tasks.length > stage.lists) {
    collect.push(truncationRecord('tasks', { total: projected.tasks.length, omitted: projected.tasks.length - stage.lists }));
    projected.tasks = projected.tasks.slice(0, stage.lists);
  }
  if (stage.skeletonChars !== undefined) {
    const cap = stage.skeletonChars;
    if (projected.task !== undefined) projected.task = skeletonize(projected.task, 'task', cap, collect, stage);
    if (Array.isArray(projected.tasks)) {
      projected.tasks = projected.tasks.map((task, index) => skeletonize(task, `tasks[${index}]`, cap, collect, stage));
    }
    // Anything else at the top level (a status answer's grants, a list's extras)
    // is trimmed rather than dropped, so nothing disappears unexplained. The
    // exception is `permission`: a wait answer publishes the pending operation there,
    // and a generic per-string cut would shorten the operation WITHOUT updating
    // `argumentsComplete`/`allowBlocked`, publishing a shortened operation that still
    // reads as complete. It is bounded by the permission rule instead. A top-level
    // `hostAcceptance` (the review answer) is the recorded conclusion and is bounded by
    // its own rule, so a small per-string cap cannot shorten it.
    for (const [key, item] of Object.entries(projected)) {
      if (key === 'task' || key === 'tasks' || key === 'ok') continue;
      if (key === 'permission') {
        projected[key] = boundPermissionBlock(item, key, collect);
        continue;
      }
      // A pending QUESTION is the other decision surface a wait answer publishes, and it is
      // held to the same rule: published whole, or explicitly unusable. A generic per-string
      // cut here would shorten `question`/`detail` while the answer still said
      // `questionAnswerable: true`, which is the defect this branch removes.
      if (key === 'question') {
        projected[key] = boundQuestionBlock(item, key, collect, stage.questionBudget ?? QUESTION_WIRE_BUDGET);
        continue;
      }
      if (key === 'answerReceipt' || key === 'decisionReceipt') continue;
      if (key === 'hostAcceptance' && item !== null && typeof item === 'object' && !Array.isArray(item)) {
        projected[key] = boundAcceptance(item, key, collect, stage.omitNote === true, stage.omitSummary === true);
        continue;
      }
      projected[key] = trimAllStrings(item, key, cap, collect);
    }
  }
  guardDescriptionFields(projected, stage.skeletonChars ?? TRUNCATED_FIELD_CAPS.listItemChars, collect);
  return projected;
}

/** Bound any anomalous value sitting at `goalDescription` or `hostAcceptance.completionSummary`. */
function guardDescriptionFields(answer, cap, collect) {
  const inspect = (task, prefix) => {
    if (task === null || typeof task !== 'object' || Array.isArray(task)) return;
    if (Object.hasOwn(task, TASK_DESCRIPTION_FIELDS.goal)) {
      const goal = task[TASK_DESCRIPTION_FIELDS.goal];
      if (typeof goal !== 'string' || reviewNoteLength(goal) > TASK_DESCRIPTION_MAX_CHARS) {
        task[TASK_DESCRIPTION_FIELDS.goal] = boundValue(
          goal,
          `${prefix}${TASK_DESCRIPTION_FIELDS.goal}`,
          cap,
          collect,
        );
      }
    }
    const acceptance = task.hostAcceptance;
    if (acceptance !== null && typeof acceptance === 'object' && !Array.isArray(acceptance)
      && Object.hasOwn(acceptance, TASK_DESCRIPTION_FIELDS.summary)) {
      const summary = acceptance[TASK_DESCRIPTION_FIELDS.summary];
      if (typeof summary !== 'string' || reviewNoteLength(summary) > TASK_DESCRIPTION_MAX_CHARS) {
        acceptance[TASK_DESCRIPTION_FIELDS.summary] = boundValue(
          summary,
          `${prefix}hostAcceptance.${TASK_DESCRIPTION_FIELDS.summary}`,
          cap,
          collect,
        );
      }
    }
  };
  inspect(answer.task ?? null, 'task.');
  if (Array.isArray(answer.tasks)) {
    for (let index = 0; index < answer.tasks.length; index += 1) inspect(answer.tasks[index], `tasks[${index}].`);
  }
  if (answer.hostAcceptance !== null && typeof answer.hostAcceptance === 'object') {
    inspect({ hostAcceptance: answer.hostAcceptance }, '');
  }
}

/**
 * The identity, state, routing, refusal and acceptance block that is never
 * dropped, renderable even when nothing else fits.
 * @param {object} task - task view.
 * @param {string} path - JSON path prefix.
 * @param {number} cap - per-string cap.
 * @param {object[]} collect - truncation records.
 * @returns {object} skeleton.
 */
function skeletonize(task, path, cap, collect, stage = {}) {
  if (task === null || typeof task !== 'object' || Array.isArray(task)) return task ?? null;
  const pick = (key) => (key in task ? boundValue(task[key], `${path}.${key}`, cap, collect) : undefined);
  const out = {};
  for (const key of ['taskId', 'state', 'phase', 'route', 'reviewRoute', 'reviewRouteError', 'execution', 'error',
    'hostAcceptance', 'selfApproved', 'cancelledBy', 'createdAt', 'endedAt',
    // The Agent Teams verdict is four booleans and a short reason: it survives every
    // bound so a compressed answer still says whether teams are on for this run. The
    // origin is one closed word, and it is what separates "you asked for this" from
    // "the operator's new-task default decided it".
    'agentTeams', 'agentTeamsOrigin', 'team']) {
    if (key === 'hostAcceptance') {
      // Projected directly from the uncut review block so the generic per-string cap never
      // shortens `completionSummary` or `note` before their field-specific rules run.
      if (!('hostAcceptance' in task)) continue;
      const raw = task.hostAcceptance;
      out.hostAcceptance = raw === null || typeof raw !== 'object' || Array.isArray(raw)
        ? (raw ?? null)
        : boundAcceptance(raw, `${path}.hostAcceptance`, collect, stage.omitNote === true, stage.omitSummary === true);
      continue;
    }
    const value = pick(key);
    if (value === undefined) continue;
    if (key === 'execution' && value !== null && typeof value === 'object') {
      out.execution = {};
      for (const field of ['outcome', 'reasoningOnly', 'usage', 'turnEnd', 'agentId', 'cancelCause', 'error']) {
        if (field in value) out.execution[field] = boundValue(value[field], `${path}.execution.${field}`, cap, collect);
      }
    } else if (key === 'route' || key === 'reviewRoute') {
      out[key] = value === null ? null : boundValue(value, `${path}.${key}`, cap, collect);
    } else {
      out[key] = value;
    }
  }
  // The LIVE pending permission request is the one thing a commander must keep when
  // everything else is trimmed: without its `requestId`/`fingerprint`/operation the
  // task stays `awaiting-permission` and nothing can be decided. It gets its OWN,
  // generous caps rather than the skeleton's per-string cap, so the identity and the
  // operation survive, and its completeness flags are carried VERBATIM so a shortened
  // operation can never read as complete.
  const pending = pendingPermissionsOf(task, path, collect);
  if (pending !== undefined) out.permission = pending;
  const goal = verbatimDescription(task);
  if (goal !== null) {
    out.goalDescription = goal;
  } else if (task?.goalDescription !== undefined) {
    out.goalDescription = boundValue(task.goalDescription, `${path}.goalDescription`, cap, collect);
  }
  if (task.question?.pending !== null && typeof task.question?.pending === 'object') {
    out.question = boundQuestionBlock(task.question, `${path}.question`, collect, QUESTION_WIRE_BUDGET);
  }
  out.truncation = { path, field: 'result', detail: 'only identity, state, routing, refusal, acceptance and the live pending permission request are shown' };
  collect.push(out.truncation);
  return out;
}

function verbatimDescription(source) {
  const value = source?.goalDescription;
  if (typeof value !== 'string') return null;
  return reviewNoteLength(value) <= TASK_DESCRIPTION_MAX_CHARS ? value : null;
}

/**
 * Bound a recorded host review for a skeletonised answer.
 *
 * The conclusion fields are carried as the engine states them — `accepted`, `state`,
 * `acceptedAt`, `by` — because they are the answer to "was this accepted?", and the note
 * keeps its own generous cap rather than the skeleton's per-string one. The completion
 * summary is bounded the same way as the note: kept whole when the record carries one, and
 * omitted explicitly with its length when the body has to be given up, so it is never
 * silently cut. Anything else present is bounded generically, so a widened record cannot
 * smuggle a long value in through this exception.
 * @param {object} acceptance - host-acceptance record.
 * @param {string} path - JSON path.
 * @param {object[]} collect - truncation records.
 * @returns {object} bounded record.
 */
function boundAcceptance(acceptance, path, collect, omitNoteText = false, omitSummaryText = false) {
  if (omitNoteText) return omitNote(acceptance, `${path}.note`, collect, omitSummaryText);
  const out = {};
  for (const [key, value] of Object.entries(acceptance)) {
    if (key === 'note' && typeof value === 'string') {
      out[key] = reviewNoteLength(value) <= REVIEW_NOTE_MAX_CHARS
        ? value
        : boundValue(value, `${path}.note`, REVIEW_NOTE_MAX_CHARS, collect);
      continue;
    }
    if (key === 'completionSummary') {
      if (value === undefined || value === null) continue;
      if (typeof value === 'string' && reviewNoteLength(value) <= TASK_DESCRIPTION_MAX_CHARS) {
        if (omitSummaryText) {
          const summaryLen = reviewNoteLength(value);
          out.completionSummaryChars = acceptance.completionSummaryChars ?? summaryLen;
          out.completionSummaryOmitted = true;
          collect.push({
            path: `${path}.completionSummary`,
            field: 'text',
            keptChars: 0,
            omittedChars: summaryLen,
            detail: 'the completion summary is read with delegate_result completionSummaryOffset/completionSummaryLimit',
          });
        } else {
          out[key] = value;
        }
      } else {
        out[key] = boundValue(value, `${path}.completionSummary`, 240, collect);
      }
      continue;
    }
    if (['accepted', 'state', 'acceptedAt', 'by', 'noteChars', 'noteOmitted',
      'completionSummaryChars', 'completionSummaryOmitted'].includes(key)) {
      out[key] = value;
      continue;
    }
    out[key] = boundValue(value, `${path}.${key}`, 240, collect);
  }
  return out;
}

/**
 * Drop the note body (it is pageable) and keep a legal summary unless explicitly omitted.
 * @param {object} acceptance - host-acceptance record.
 * @param {string} path - JSON path of the note.
 * @param {object[]} collect - truncation records.
 * @param {boolean} [omitSummaryText] - omit a legal summary explicitly when even it cannot fit.
 * @returns {object} the acceptance with an explicitly omitted note and bounded summary.
 */
function omitNote(acceptance, path, collect, omitSummaryText = false) {
  const basePath = path.replace(/\.note$/u, '');
  const length = typeof acceptance.note === 'string' ? Array.from(acceptance.note).length : 0;
  if (acceptance.note !== undefined && acceptance.note !== null) {
    collect.push({
      path,
      field: 'text',
      keptChars: 0,
      omittedChars: length,
      detail: 'the review note is read with delegate_result reviewNoteOffset/reviewNoteLimit',
    });
  }
  const { note, completionSummary, ...rest } = acceptance;
  void note;
  const out = {};
  for (const [key, value] of Object.entries(rest)) {
    if (['accepted', 'state', 'acceptedAt', 'by', 'noteChars', 'noteOmitted',
      'completionSummaryChars', 'completionSummaryOmitted'].includes(key)) {
      out[key] = value;
    } else {
      out[key] = boundValue(value, `${basePath}.${key}`, 240, collect);
    }
  }
  out.noteChars = acceptance.noteChars ?? length;
  out.noteOmitted = true;
  if (completionSummary !== undefined && completionSummary !== null) {
    if (typeof completionSummary === 'string' && reviewNoteLength(completionSummary) <= TASK_DESCRIPTION_MAX_CHARS) {
      if (omitSummaryText) {
        const summaryLen = reviewNoteLength(completionSummary);
        out.completionSummaryChars = acceptance.completionSummaryChars ?? summaryLen;
        out.completionSummaryOmitted = true;
        collect.push({
          path: `${basePath}.completionSummary`,
          field: 'text',
          keptChars: 0,
          omittedChars: summaryLen,
          detail: 'the completion summary is read with delegate_result completionSummaryOffset/completionSummaryLimit',
        });
      } else {
        out.completionSummary = completionSummary;
      }
    } else {
      // Not a description this build would have stored: bound it and state the cut.
      out.completionSummary = boundValue(
        completionSummary,
        `${basePath}.completionSummary`,
        240,
        collect,
      );
    }
  }
  return out;
}

/**
 * The live pending permission request of one task, bounded but never skeletal.
 *
 * Only `state === 'pending'` qualifies: settled evidence is history and is the first
 * thing the bound gives up, while an outstanding request is the decision surface
 * itself. The per-field caps are fixed and generous (identity and fingerprint are
 * never cut; the argument blobs get their own cap), and `completeness` /
 * `argumentsComplete` / `allowBlocked` are copied unchanged so a shortened operation
 * cannot be presented as reviewable.
 *
 * Only FINAL cuts are recorded. The generic walk applies a small per-string cap to
 * every field, and then the decision surface is restored to its real value (or its
 * own 4000-character blob cap). A walk cut on a restored field no longer describes
 * the output — the walk once left `truncation.fields` naming a phantom cut on a
 * fully restored 1500-character operation — so the walk collects into a scratch list
 * and only the cuts that survive into the published block are reported.
 * `argumentsComplete: false` / `allowBlocked` still come from the engine, so a
 * genuinely shortened operation can never read as complete.
 * @param {object} task - task view.
 * @param {string} path - JSON path prefix for truncation records.
 * @param {object[]} collect - truncation records.
 * @returns {object | undefined} the bounded pending block, or undefined when none.
 */
function pendingPermissionsOf(task, path, collect) {
  const permission = task?.permission;
  if (permission === null || typeof permission !== 'object') return undefined;
  const pending = permission.pending;
  if (pending === null || typeof pending !== 'object' || pending.state !== 'pending') return undefined;
  const prefix = `${path}.permission.pending`;
  // Provisional cuts, discarded: every field they touch is restored or re-cut below.
  const scratched = [];
  const out = { ...boundValue(pending, prefix, 512, scratched) };
  // Restore the decision surface EXACTLY after the generic walk.
  for (const key of ['requestId', 'taskId', 'toolName', 'callId', 'fingerprint', 'sessionId']) {
    if (pending[key] !== undefined) out[key] = pending[key];
  }
  for (const key of ['state', 'completeness', 'argumentsComplete', 'allowBlocked', 'reasonSource', 'boundsApplied', 'omitted', 'requestedAccess', 'argumentKeys']) {
    if (pending[key] !== undefined) out[key] = pending[key];
  }
  // The two blobs get their own cap, stated when it fires. This is the only cut for
  // them, because the capped value is what is published. `arguments` uses the
  // engine's own bound so this layer never re-cuts an operation the engine published
  // whole; `reason` is the worker's claim, not the operation, and keeps a smaller cap.
  for (const key of ['arguments', 'reason']) {
    if (typeof pending[key] === 'string') {
      const cap = key === 'arguments' ? PERMISSION_ARGUMENTS_CAP : PERMISSION_REASON_CAP;
      out[key] = boundedText(pending[key], cap, `${prefix}.${key}`, collect);
    }
  }
  // One identified: the provisional cap still applies to it, so the scratch list
  // holds no final cut to forward. Report the exception explicitly instead of a cut,
  // so the record explains why an unexpected field may be shorter than the original.
  if (scratched.length > 0) {
    collect.push({
      path: `${path}.permission.pending`,
      field: 'detail',
      keptChars: 512,
      detail: 'fields other than the decision surface are bounded to 512 characters each',
    });
  }
  return { bridged: permission.bridged === true, waiting: true, pending: out };
}

/**
 * The keys of a pending permission request that a decision is bound to.
 *
 * A value under one of these keys is copied VERBATIM: cutting an identity would
 * make the request undecidable, and cutting the `completeness` flags would let a
 * shortened operation read as a decidable one — which is exactly the property the
 * per-call permission boundary depends on.
 */
const PERMISSION_IDENTITY_KEYS = Object.freeze([
  'requestId', 'taskId', 'sessionId', 'toolName', 'callId', 'state', 'completeness',
  'argumentsComplete', 'allowBlocked', 'reasonSource', 'boundsApplied', 'omitted',
  'requestedAccess', 'argumentKeys', 'argumentsRedacted', 'fingerprint', 'standingModeUnchanged',
]);

/**
 * The blobs of a pending permission request, and the cap applied to each.
 *
 * `reason` is the worker's claim and `arguments` is the operation; both are prose
 * from a model, so both are bounded — but at a cap large enough for a real tool
 * call. When the cap fires, `boundsApplied` gains this server's own marker and
 * `argumentsComplete` is forced to `false` in {@link boundPermissionRequest}, so a
 * shortened operation is never presented as complete.
 *
 * The argument cap is the ENGINE's own bound, not a second, smaller number. A
 * smaller value here silently re-cut an operation the engine had already published
 * whole, which turned a complete, reviewable request into an unapprovable one at the
 * last layer before the host saw it — the exact failure the engine's own bound was
 * raised to remove. `reason` keeps its separate, smaller cap: it is a claim, never
 * the operation.
 */
const PERMISSION_ARGUMENTS_CAP = PERMISSION_BOUNDS.argumentsChars;
const PERMISSION_REASON_CAP = 4_000;

/**
 * Bound one pending permission request without ever making it look decidable when
 * it is not.
 *
 * The rule this encodes: `boundedJson` may shorten anything, but it may not change
 * the MEANING of the permission surface. Identity fields and the completeness flags
 * pass through untouched; the two prose blobs are capped, and a fired cap is
 * recorded in `boundsApplied` and reflected in `argumentsComplete: false` /
 * `allowBlocked`. The engine's own `completeness` label is left as it is (this
 * projection never upgrades `truncated` to `complete`), and no path here can set any
 * of those flags back to a permissive value.
 * @param {object} pending - pending permission record.
 * @param {string} path - JSON path for the truncation records.
 * @param {object[]} collect - truncation records.
 * @returns {object} bounded pending record.
 */
function boundPermissionRequest(pending, path, collect) {
  if (pending === null || typeof pending !== 'object' || Array.isArray(pending)) return pending ?? null;
  const out = {};
  const ownCuts = [];
  for (const [key, value] of Object.entries(pending)) {
    if (PERMISSION_IDENTITY_KEYS.includes(key)) {
      out[key] = value;
      continue;
    }
    if (key === 'arguments' || key === 'reason') {
      if (typeof value !== 'string') {
        out[key] = value;
        continue;
      }
      const cap = key === 'arguments' ? PERMISSION_ARGUMENTS_CAP : PERMISSION_REASON_CAP;
      if (value.length > cap) {
        out[key] = boundedText(value, cap, `${path}.${key}`, collect);
        ownCuts.push(key);
      } else {
        out[key] = value;
      }
      continue;
    }
    out[key] = boundValue(value, `${path}.${key}`, 512, collect);
  }
  if (ownCuts.length > 0) {
    // Both flags are only ever made LESS permissive. `completeness` is downgraded
    // because the published operation is no longer the whole one; `argumentsComplete`
    // becomes false for the same reason; `allowBlocked` gains a reason when the
    // engine had not already supplied one.
    out.completeness = pending.completeness === 'complete' ? 'truncated' : (pending.completeness ?? 'truncated');
    out.argumentsComplete = false;
    if (out.allowBlocked === null || out.allowBlocked === undefined) {
      out.allowBlocked = 'the operation was shortened by the tool-text bound, so an allow cannot be granted on it';
    }
    const applied = Array.isArray(pending.boundsApplied) ? pending.boundsApplied.slice() : [];
    if (!applied.includes('mcp-text')) applied.push('mcp-text');
    out.boundsApplied = applied;
    collect.push({
      path: `${path}`,
      field: 'permission',
      detail: 'the published operation was shortened by the tool-text bound; it remains marked unapprovable',
    });
  }
  return out;
}

/**
 * Whether a pending operation, as it stands, can be decided `allow-once`.
 *
 * One place, one rule: the answer a host reads and the flag this server publishes
 * must agree, so the rule is a function rather than a duplicated expression.
 * @param {object} pendingOperation - pending operation (possibly bounded).
 * @returns {boolean} true only for a whole, unblocked operation.
 */
export function isPermissionDecidable(pendingOperation) {
  if (pendingOperation === null || typeof pendingOperation !== 'object') return false;
  if (pendingOperation.state !== undefined && pendingOperation.state !== 'pending') return false;
  if (pendingOperation.argumentsComplete !== true) return false;
  if (pendingOperation.allowBlocked !== null && pendingOperation.allowBlocked !== undefined) return false;
  if (pendingOperation.completeness !== undefined && pendingOperation.completeness !== 'complete') return false;
  return true;
}

/**
 * Bound a leaf value for a skeleton.
 * @param {unknown} value - value.
 * @param {string} path - JSON path.
 * @param {number} cap - per-string cap.
 * @param {object[]} collect - records.
 * @returns {unknown} bounded value.
 */
function boundValue(value, path, cap, collect) {
  if (typeof value === 'string') return boundedText(value, cap, path, collect);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((entry, index) => boundValue(entry, `${path}[${index}]`, cap, collect));
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    // A pending permission request nested in ANY task-shaped record (a list answer,
    // a skeletonised task) still has to be decidable, so it is bounded by its own
    // rule rather than by the generic per-string cap. Recognising it here, at every
    // depth, is what makes the guarantee hold for every tool answer and not only
    // for the shapes this file happens to special-case.
    if (key === 'permission' && item !== null && typeof item === 'object' && !Array.isArray(item)) {
      out[key] = boundPermissionBlock(item, `${path}.permission`, collect);
      continue;
    }
    out[key] = boundValue(item, `${path}.${key}`, cap, collect);
  }
  return out;
}

/**
 * Bound a task's permission block, preserving its live pending request.
 * @param {object} permission - permission block.
 * @param {string} path - JSON path.
 * @param {object[]} collect - truncation records.
 * @returns {object} bounded block.
 */
function boundPermissionBlock(permission, path, collect) {
  // A bare pending operation (the shape a wait answer publishes, and the shape the
  // engine's `observeTask` contract describes) is bounded as a REQUEST, not as a
  // block: recognising it by its own identity fields means the same rule applies
  // however a particular answer happens to nest it.
  if (typeof permission.requestId === 'string' && typeof permission.state === 'string'
    && permission.state === 'pending') {
    return boundPermissionRequest(permission, path, collect);
  }
  const out = {};
  let preserved = false;
  for (const [key, value] of Object.entries(permission)) {
    if (key === 'pending' && value !== null && typeof value === 'object' && value.state === 'pending') {
      out[key] = boundPermissionRequest(value, `${path}.pending`, collect);
      preserved = true;
      // A preserved request is DECISION MATERIAL, not history. It is restored the
      // way the skeleton stage restores it: not reported as a cut merely because it
      // was bounded on its own terms.
      collect.push({
        path: `${path}.pending`,
        field: 'detail',
        detail: 'the live pending request is carried in full except for its own blob caps, and stays marked unapprovable when shortened',
      });
      continue;
    }
    out[key] = boundValue(value, `${path}.${key}`, 512, collect);
  }
  if (preserved) out.waiting = true;
  return out;
}

/**
 * Build a structurally bounded, still-valid JSON answer.
 *
 * `ok` keeps its meaning: the payload is either the real answer or an explicit
 * failure object. A result that cannot be projected writes itself is never
 * returned as if it were complete, and never returned as truncated raw text.
 *
 * `isError` is true only when the answer could not be delivered at all
 * (`MCP_RESULT_UNSERIALIZABLE`, `MCP_RESULT_OVER_BUDGET`). A structurally trimmed
 * answer is *not* an error: it is a real answer with an explicit, machine-readable
 * `truncation` block, which lets a caller act on the parts that survived. The
 * distinction matters because a truncated result must never be presented as a
 * failure when the task itself succeeded.
 * @param {unknown} value - JSON-serializable answer.
 * @returns {{ text: string, isError: boolean }} bounded, valid JSON text.
 */
function boundedJson(value) {
  if (!isJsonProjectable(value)) {
    return refuseResult('MCP_RESULT_UNSERIALIZABLE', 'the delegated call answered with a value that cannot be represented as JSON');
  }
  let compact;
  try {
    compact = compactJson(value);
  } catch {
    return refuseResult('MCP_RESULT_UNSERIALIZABLE', 'the delegated call answered with a value that could not be serialized');
  }
  if (fitsBound(value)) return { text: JSON.stringify(redactDeepStrings(value)), isError: false };

  const stages = [
    { executionText: TRUNCATED_FIELD_CAPS.executionTextChars, reviewText: TRUNCATED_FIELD_CAPS.reviewTextChars, lists: 50, permissionEvidence: 8 },
    { executionText: 400, reviewText: 400, lists: 20, permissionEvidence: 4 },
    { executionText: 200, reviewText: 200, lists: 5, permissionEvidence: 2 },
    { executionText: 120, reviewText: 120, lists: 1, permissionEvidence: 1 },
    // Before the answer is skeletonised (whose small per-string cap would otherwise CUT the
    // note), the note is given up explicitly: identity, state and everything else stay at
    // full width, and only the body becomes `noteOmitted`, readable in pages.
    { executionText: 120, reviewText: 120, lists: 1, permissionEvidence: 1, omitNote: true },
    { executionText: 80, reviewText: 80, lists: 1, permissionEvidence: 0, skeletonChars: 240 },
    { executionText: 80, reviewText: 80, lists: 1, permissionEvidence: 0, skeletonChars: 240, omitNote: true },
    { executionText: 40, reviewText: 40, lists: 1, permissionEvidence: 0, skeletonChars: 96, omitNote: true },
    { executionText: 40, reviewText: 40, lists: 1, permissionEvidence: 0, skeletonChars: 96, omitNote: true, omitSummary: true },
  ];
  const apply = (stage) => {
    const records = [];
    const projected = projectWithStage(value, stage, records);
    projected.truncation = {
      truncated: true,
      reason: 'the full answer exceeded the tool-text bound',
      fullTextChars: compact.length,
      boundChars: MAX_TOOL_TEXT_CHARS,
      // Stated so a caller can tell a structurally trimmed answer from a short
      // one, and so "bounded" is never read as "complete".
      fullResultIncluded: false,
      fields: dedupeRecords(records),
    };
    // A wait answer publishes `permissionDecidable`, and a bound may have shortened
    // the operation it describes. Recomputing the flag from the PUBLISHED operation
    // is what stops a cut operation from being advertised as decidable.
    if (projected.permission !== undefined && projected.permission !== null) {
      projected.permissionDecidable = isPermissionDecidable(projected.permission);
    }
    // The same rule for a question, and for the same reason: the flag must describe what
    // was PUBLISHED. `boundQuestionBlock` either kept the questions whole or replaced them
    // with an explicit omission, so this is derived from the surviving block, never from the
    // pre-bound value.
    if (projected.question !== undefined && projected.question !== null) {
      projected.questionAnswerable = isQuestionAnswerable(projected.question);
      projected.grantsAccess = false;
    }
    return JSON.stringify(redactDeepStrings(projected));
  };
  for (const stage of stages) {
    const text = apply(stage);
    if (text.length <= MAX_TOOL_TEXT_CHARS) return { text, isError: false };
  }

  // The refusal path is reached only when nothing above fits. An answer that carries
  // a LIVE pending permission request — or a DECISION RECEIPT — is different from any
  // other oversized answer: dropping the request leaves the task paused and undecidable
  // from what the host was told, and dropping the receipt makes a coordinator believe an
  // authorization it applied never happened (or that it must be resent). So before
  // refusing, the answer is reduced to those alone — with their blobs re-capped to
  // whatever the bound leaves — and published under an explicit `permissionOnly` marker
  // that states the rest was not included. When even this does not fit, the refusal below
  // still carries the minimal receipt, so the refusal itself is never a lost decision.
  const questionRescue = rescueQuestion(value, compact.length);
  if (questionRescue !== null) return questionRescue;
  const rescue = permissionRescue(value, compact.length);
  if (rescue !== null) {
    // The first rung is the engine's own operation bound, so a request that the
    // engine published WHOLE is rescued whole whenever it fits at all; only an answer
    // that still does not fit steps down. Every rung below it re-cuts the operation
    // and marks the request unapprovable.
    for (const cap of [PERMISSION_ARGUMENTS_CAP, 4_000, 1_000, 400, 160, 0]) {
      const text = rescue(cap);
      if (text.length <= MAX_TOOL_TEXT_CHARS) return { text, isError: false };
    }
  }

  // Nothing projected fits. The answer is refused as data, carrying the task
  // identity when it can: the caller learns which task the content belonged to
  // and why the result was not delivered, instead of receiving a cut fragment
  // that looks like an answer. A decision receipt the refusal cannot carry in full
  // is carried minimally, because "the answer did not fit" must never mean "the
  // decision is lost".
  const identity = {};
  if (value?.task !== null && typeof value?.task === 'object' && !Array.isArray(value.task)) {
    if (value.task.taskId !== undefined) identity.taskId = truncateScalar(value.task.taskId);
    if (value.task.state !== undefined) identity.state = truncateScalar(value.task.state);
  }
  if (Array.isArray(value?.tasks)) {
    identity.tasks = value.tasks.slice(0, 5).map((task) => ({ taskId: truncateScalar(task?.taskId) }));
  }
  const refusedReceipt = minimalReceipt(value?.decisionReceipt);
  if (refusedReceipt !== null) identity.decisionReceipt = refusedReceipt;
  const refusedAnswer = minimalReceipt(value?.answerReceipt);
  if (refusedAnswer !== null) identity.answerReceipt = refusedAnswer;
  // "The answer did not fit" must never mean "the acknowledgement is lost": the same
  // rule the decision receipt obeys above applies to the ack verdict, which the engine
  // has already acted on.
  const refusedAck = minimalFailureAck(value?.failureAck);
  if (refusedAck !== null) identity.failureAck = refusedAck;
  return refuseResult(
    'MCP_RESULT_OVER_BUDGET',
    'the critical fields alone exceed the tool-text bound, so no usable projection could be produced',
    { ...identity, fullTextChars: compact.length, boundChars: MAX_TOOL_TEXT_CHARS },
  );
}

/**
 * The minimum facts a failure acknowledgment must keep under ANY bound.
 *
 * A `failureAck` is the producer's verdict on the receiver's `ackFailureEventId`: the
 * reminder was cleared (or refused) at the engine, and the host that does not learn
 * this fact may resend the ack or assume an unknown outcome. So the exact `eventId`,
 * `acknowledged` and `reason` are carried VERBATIM — never rewritten, never invented —
 * and this projection is applied wherever an answer is compressed, refused or reduced
 * to its critical fields.
 * @param {object} ack - the engine's ack result.
 * @returns {object | null} the verbatim trio, or null when there is nothing to keep.
 */
function minimalFailureAck(ack) {
  if (ack === null || typeof ack !== 'object' || Array.isArray(ack)) return null;
  const out = {
    acknowledged: ack.acknowledged === true,
    eventId: typeof ack.eventId === 'string' ? ack.eventId : null,
    reason: typeof ack.reason === 'string' ? ack.reason : null,
  };
  // A result with no verdict at all is not an acknowledgment fact: do not publish
  // a fabricated `acknowledged: false`.
  if (ack.acknowledged !== true && ack.acknowledged !== false) return null;
  return out;
}

/**
 * The minimum facts a decision receipt must keep under ANY bound.
 *
 * A receipt is the one answer a coordinator cannot recover by asking again: a decision was
 * applied (or may have been), and losing the fact makes it either resend an authorization
 * or assume one that never happened. So this projection keeps identity, `applied` and
 * `confirmation` VERBATIM, and drops the bulky evidence (`verified`, `grant`, `outcome`) that
 * can be re-read from `delegate_result`. It states the omission rather than pretending the
 * receipt was complete, and it never invents a field: a value it did not receive is absent.
 * @param {object} receipt - the receipt as produced by the decision path.
 * @returns {object} a bounded receipt with its own identity intact.
 */
function minimalReceipt(receipt) {
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const out = {};
  for (const key of ['receiptId', 'taskId', 'requestId', 'decision', 'fingerprint', 'applied', 'confirmation', 'outcome']) {
    if (receipt[key] !== undefined) out[key] = receipt[key];
  }
  // An ANSWER receipt also carries the answer batch, which can be huge; its identity and
  // verdict are what must survive, so the batch is replaced by its size. Stated, never
  // silently dropped: a coordinator can re-read the task.
  if (Array.isArray(receipt.answers)) {
    out.answerCount = receipt.answers.length;
    out.answersOmitted = true;
  }
  if (receipt.grantsAccess !== undefined) out.grantsAccess = receipt.grantsAccess === true;
  if (receipt.rejectionFeedback !== undefined) out.rejectionFeedback = feedbackDeliveryFact(receipt.rejectionFeedback);
  // `applied` and `confirmation` are the whole point; if the source lacked one, the
  // omission is stated rather than filled with a guess.
  if (!('applied' in out) || !('confirmation' in out)) return null;
  out.evidenceOmitted = true;
  return out;
}

/** Keep the whole live question and both receipt identities when other result data is large. */
function rescueQuestion(value, fullTextChars) {
  if (value?.question === null || typeof value?.question !== 'object') return null;
  for (const budget of [QUESTION_WIRE_BUDGET, 0]) {
    const records = [];
    const question = boundQuestionBlock(value.question, 'question', records, budget);
    const payload = {
      ok: value.ok,
      taskId: value.taskId ?? value.task?.taskId ?? null,
      state: value.state ?? value.task?.state ?? null,
      phase: value.phase ?? value.task?.phase ?? null,
      reason: value.reason,
      actionable: value.actionable,
      terminal: value.terminal,
      question,
      questionAnswerable: isQuestionAnswerable(question),
      grantsAccess: false,
      truncation: { truncated: true, fullResultIncluded: false, fullTextChars, boundChars: MAX_TOOL_TEXT_CHARS, fields: records },
    };
    for (const key of ['decisionReceipt', 'answerReceipt']) {
      const receipt = minimalReceipt(value[key]);
      if (receipt !== null) payload[key] = receipt;
    }
    // A long QUESTION answer can equally follow an applied acknowledgment: the rescue
    // must keep that verdict verbatim, or the host re-asks what already happened.
    const questionRescueAck = minimalFailureAck(value.failureAck);
    if (questionRescueAck !== null) {
      records.push({ path: 'failureAck', field: 'ack', detail: 'the acknowledgment verdict is retained verbatim' });
      payload.failureAck = questionRescueAck;
    }
    const redacted = redactDeepStrings(payload);
    const compact = JSON.stringify(redacted);
    if (compact.length <= MAX_TOOL_TEXT_CHARS) return { text: compact, isError: false };
  }
  return null;
}

/**
 * The short rejection-feedback DELIVERY FACT a decision receipt may carry.
 *
 * The full note text is already the worker's own message and is stored in history; repeating
 * it in every receipt would multiply the answer for no gain. What a receipt must state is
 * whether the reason actually reached the worker and, when it did not, why — the two fields
 * that make the delivery checkable instead of claimed.
 * @param {object | null} feedback - the settled `rejectionFeedback` record.
 * @returns {{ delivered: boolean, reason: string | null } | null} the short fact.
 */
function feedbackDeliveryFact(feedback) {
  if (feedback === null || typeof feedback !== 'object' || Array.isArray(feedback)) return null;
  return {
    delivered: feedback.delivered === true,
    reason: typeof feedback.reason === 'string' ? feedback.reason : null,
  };
}

/**
 * Build a last-resort projection that keeps the live pending permission request(s) of an
 * oversized answer — and the decision receipt, when the answer carries one.
 *
 * The ORDER is fixed and the caps are tried by the caller: identity first, then a
 * smaller operation blob. `completeness`/`argumentsComplete`/`allowBlocked` are
 * always carried as the engine states them (or downgraded by the capping), so a
 * shortened request still cannot be allowed.
 *
 * The receipt is projected by {@link minimalReceipt} for EVERY cap, including `cap === 0`:
 * a huge `grant` or `verified` blob can be dropped, but the receipt's identity and its
 * `applied`/`confirmation` survive, because this answer is the only place they exist.
 * @param {unknown} value - the answer that did not fit.
 * @param {number} fullTextChars - size of the original answer, for the record.
 * @returns {((cap: number) => string) | null} renderer, or null when the answer carries
 *   neither a live pending request nor a decision receipt.
 */
function permissionRescue(value, fullTextChars) {
  const entries = [];
  const collectTask = (task, path) => {
    const block = task?.permission;
    const pending = block?.pending;
    if (pending === null || typeof pending !== 'object' || pending.state !== 'pending') return;
    entries.push({ path, taskId: task.taskId, state: task.state, phase: task.phase, block, pending });
  };
  if (value?.task !== null && typeof value?.task === 'object' && !Array.isArray(value.task)) collectTask(value.task, 'task');
  if (Array.isArray(value?.tasks)) value.tasks.forEach((task, index) => collectTask(task, `tasks[${index}]`));
  // A WAIT answer publishes the pending operation directly as `permission` rather
  // than under `task.permission.pending`. It is the one shape where the whole point
  // of the answer is the operation, so it earns the same rescue: shorten the
  // operation, never drop it and never let it read as complete.
  const bare = value?.permission;
  if (bare !== null && typeof bare === 'object' && bare.state === 'pending' && typeof bare.requestId === 'string') {
    entries.push({
      path: 'permission', taskId: value.taskId, state: value.state, phase: value.phase, block: null, pending: bare, bare: true,
    });
  }
  const receipt = minimalReceipt(value?.decisionReceipt);
  const answerReceipt = minimalReceipt(value?.answerReceipt);
  // The acknowledgment verdict is critical for the same reason a receipt is: the engine
  // already acted on it, so a rescue that dropped it would report an applied confirmation
  // as unknown. It is kept verbatim and counted as part of what "survived".
  const failureAck = minimalFailureAck(value?.failureAck);
  if (entries.length === 0 && receipt === null && answerReceipt === null && failureAck === null) return null;
  return (cap) => {
    const records = [];
    const render = (entry) => {
      const pending = boundPermissionRequest(
        cap === 0 ? { ...entry.pending, arguments: '', reason: '' } : entry.pending,
        `${entry.path === 'permission' ? 'permission' : `${entry.path}.permission.pending`}`,
        records,
      );
      if (cap === 0) {
        pending.arguments = null;
        pending.argumentsComplete = false;
        pending.completeness = 'truncated';
        pending.allowBlocked = pending.allowBlocked ?? 'the operation could not be included within the tool-text bound';
        records.push({ path: 'permission.arguments', field: 'text', keptChars: 0, detail: 'the operation did not fit' });
      } else if (cap < PERMISSION_ARGUMENTS_CAP && typeof pending.arguments === 'string' && pending.arguments.length > cap) {
        pending.arguments = boundedText(pending.arguments, cap, 'permission.arguments', records);
        pending.argumentsComplete = false;
        pending.completeness = pending.completeness === 'complete' ? 'truncated' : pending.completeness;
        pending.allowBlocked = pending.allowBlocked ?? 'the operation was shortened by the tool-text bound, so an allow cannot be granted on it';
      }
      return pending;
    };
    /** Attach the receipt(s) and the failure acknowledgment, with the omission stated where it happened. */
    const withReceipt = (payload) => {
      for (const [key, item] of [['decisionReceipt', receipt], ['answerReceipt', answerReceipt]]) {
        if (item === null) continue;
        records.push({ path: key, field: 'receipt', detail: 'identity and application facts retained; bulky evidence omitted' });
        payload[key] = item;
      }
      // The ack verdict is a fact about what ALREADY happened at the producer. Losing it
      // here made the host believe an applied confirmation was unknown (TB151-01), so it
      // is carried verbatim at the same top-level place the normal answer publishes it.
      if (failureAck !== null) {
        records.push({ path: 'failureAck', field: 'ack', detail: 'the acknowledgment verdict is retained verbatim' });
        payload.failureAck = failureAck;
      }
      return payload;
    };
    if (entries.length === 1 && entries[0].bare === true) {
      const payload = withReceipt({
        ok: value.ok,
        taskId: entries[0].taskId,
        state: entries[0].state,
        phase: entries[0].phase,
        reason: value.reason,
        actionable: true,
        permission: render(entries[0]),
        permissionDecidable: false,
        truncation: truncationBlock(records, fullTextChars, entries),
      });
      return JSON.stringify(redactDeepStrings(payload));
    }
    if (entries.length === 0) {
      // A RECEIPT-ONLY rescue: no live request survived to publish, but the decision must
      // not vanish with the rest of the answer.
      const payload = withReceipt({
        ok: value.ok,
        taskId: value.taskId ?? receipt?.taskId ?? answerReceipt?.taskId ?? null,
        state: value.state ?? null,
        phase: value.phase ?? null,
        reason: value.reason ?? null,
        actionable: true,
        truncation: truncationBlock(records, fullTextChars, entries),
      });
      return JSON.stringify(redactDeepStrings(payload));
    }
    const tasks = entries.map((entry) => {
      const pending = render(entry);
      const block = { bridged: entry.block?.bridged === true, waiting: true, pending };
      return {
        taskId: entry.taskId,
        state: entry.state,
        phase: entry.phase,
        permissionOnly: true,
        permission: block,
      };
    });
    const payload = withReceipt(entries.length === 1 && entries[0].path === 'task'
      ? { ok: value.ok, task: tasks[0], truncation: truncationBlock(records, fullTextChars, entries) }
      : { ok: value.ok, tasks, truncation: truncationBlock(records, fullTextChars, entries) });
    return JSON.stringify(redactDeepStrings(payload));
  };
}

/**
 * The truncation record of a permission-only answer.
 * @param {object[]} records - per-field cuts.
 * @param {number} fullTextChars - size of the original answer.
 * @param {object[]} entries - the requests that survived.
 * @returns {object} truncation block.
 */
function truncationBlock(records, fullTextChars, entries) {
  return {
    truncated: true,
    reason: 'the answer exceeded the tool-text bound; only the live pending permission request(s) were returned',
    fullTextChars,
    boundChars: MAX_TOOL_TEXT_CHARS,
    fullResultIncluded: false,
    permissionOnly: true,
    tasksWithPendingPermission: entries.map((entry) => truncateScalar(entry.taskId)),
    fields: dedupeRecords(records),
  };
}

/**
 * Run every string in a value through {@link redactText}.
 *
 * This server is the last hop before a model reads the answer, so it does not
 * rely solely on the plane having redacted first: a task view is assembled from
 * many sources (model prose, diff text, captured evidence), and one unredacted
 * string reaching a model is the failure this guard exists to prevent. Key-based
 * masking is not repeated here — the plane already masks secret-named fields, and
 * re-masking a field this module only forwards would change a value it did not
 * read.
 * @param {unknown} value - JSON value.
 * @param {number} [depth] - recursion depth guard.
 * @returns {unknown} copy with credential-shaped substrings masked.
 */
function redactDeepStrings(value, depth = 0) {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object' || depth > MAX_PROJECTION_DEPTH) return value;
  if (Array.isArray(value)) return value.map((entry) => redactDeepStrings(entry, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = redactDeepStrings(item, depth + 1);
  return out;
}

/**
 * An answer this server could not deliver, as valid bounded JSON.
 * @param {string} code - stable failure code.
 * @param {string} message - explanation.
 * @param {object} [extra] - additional fields merged into the error object.
 * @returns {{ text: string, isError: true }} refusal payload.
 */
function refuseResult(code, message, extra = {}) {
  const text = JSON.stringify(redactDeepStrings({
    ok: false,
    error: { code, message, ...extra },
    truncation: { truncated: true, fullResultIncluded: false },
  }));
  if (text.length <= MAX_TOOL_TEXT_CHARS) return { text, isError: true };
  // The refusal itself is larger than the bound, which only happens if the bound
  // is configured absurdly small. This minimal form is still valid JSON and still
  // says the answer was refused rather than delivered.
  return {
    text: JSON.stringify({ ok: false, error: { code, truncated: true }, truncation: { truncated: true, fullResultIncluded: false } }),
    isError: true,
  };
}

/**
 * Keep a scalar leaf small enough to always serialize.
 * @param {unknown} value - scalar.
 * @returns {unknown} value or its first 200 characters.
 */
function truncateScalar(value) {
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return null;
}

/**
 * Remove duplicate truncation records for the same path and field.
 * @param {object[]} records - collected records.
 * @returns {object[]} deduplicated records.
 */
function dedupeRecords(records) {
  const seen = new Map();
  for (const record of records) {
    const key = `${record.path}\u0000${record.field}`;
    if (!seen.has(key)) seen.set(key, record);
  }
  return [...seen.values()].slice(0, 64);
}

/**
 * Create the MCP request handler.
 *
 * `callExecution` is injected so this module holds no transport knowledge and can
 * be tested without a socket: it receives `(route, payload, context?)` and resolves
 * to the execution plane's parsed `ok:true` body, throwing on any refusal.
 * `context.signal` is the caller's per-REQUEST cancellation, used by
 * `delegate_wait` so `notifications/cancelled` ends that wait and nothing else.
 *
 * `now` and `sleep` are seams, not configuration: a test drives a twenty-minute
 * wait in milliseconds by handing in its own clock, and production takes the real
 * ones. Nothing else about the wait depends on them.
 * @param {object} options - `callExecution`, optional `logger`, `now`, `sleep`.
 * @returns {{ handle: Function, tools: readonly object[], calls: object[], isInitialized: () => boolean }} server.
 */
export function createMcpServer(options) {
  if (typeof options?.callExecution !== 'function') {
    throw new TypeError('createMcpServer needs a callExecution function');
  }
  const callExecution = options.callExecution;
  const logger = options.logger ?? null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
  // Records what was asked for, so a test can prove which plane route a tool
  // reached instead of trusting the tool result. Bounded: a long session issues
  // thousands of calls, and an unbounded array here would be a memory leak that
  // only shows up in the field.
  const calls = [];
  let initialized = false;
  // The per-process census behind `delegate_metrics` and the exit diagnostics line.
  // Counts, durations, byte sizes and closed-vocabulary reasons only.
  const metrics = createCallMetrics({
    now,
    limit: Number.isInteger(options.metricsSamples) && options.metricsSamples > 0 ? options.metricsSamples : 64,
  });
  /** Per-server sequence, so every wait chain has its own identifier. */
  let correlationSequence = 0;

  /**
   * The identifier of the next wait chain in this process.
   * @param {string} prefix - `wait` or `decision`.
   * @returns {string} identifier.
   */
  function nextCorrelationId(prefix) {
    correlationSequence += 1;
    return correlationId(prefix, correlationSequence);
  }

  /**
   * Remember one call without growing without bound.
   * @param {object} record - call record.
   * @returns {void}
   */
  function recordCall(record) {
    calls.push(record);
    if (calls.length > MAX_CALL_LOG) calls.splice(0, calls.length - MAX_CALL_LOG);
  }

  /**
   * Run one tool call and wrap the answer as MCP content.
   * @param {string} name - tool name.
   * @param {unknown} args - arguments.
   * @param {{ signal?: AbortSignal }} [context] - per-request cancellation.
   * @returns {Promise<object>} `{ content, isError? }`.
   */
  async function callTool(name, args, context = {}) {
    const route = TOOL_ROUTES[name];
    if (route === undefined) {
      throw new McpError('MCP_TOOL_UNKNOWN', `no tool named ${JSON.stringify(name)}`, {
        rpcCode: RPC_ERRORS.invalidParams,
      });
    }
    const tool = TOOLS.find((entry) => entry.name === name);
    let payload;
    try {
      payload = validateArgs(tool, args);
    } catch (error) {
      // A malformed argument is a *tool* error, not a protocol error: the client's
      // session is healthy, the call was wrong, and `isError` is how MCP says so.
      // The code and field name go back so a model can correct itself.
      const code = typeof error?.code === 'string' ? error.code : 'MCP_ARGUMENTS_INVALID';
      return {
        content: [{ type: 'text', text: boundedJson({ ok: false, error: { code, message: error?.message ?? 'invalid arguments' } }).text }],
        isError: true,
      };
    }
    recordCall({ tool: name, route, payload });
    // Counted AFTER validation: a refused argument never reached the program, so it is
    // not evidence of what this surface was asked to do.
    metrics.recordToolCall(name);
    // Every answer this call produces is measured in ONE place, after it has been bounded
    // and redacted: `boundedJson` output IS the tool text the host parses, so its UTF-8
    // size is the only honest byte count. Measuring earlier (on the raw plane body, or on
    // the compact answer) would count something the host never receives, and measuring
    // inside the answer would be self-referential. Not a delivery receipt: this is the
    // size handed to the transport, not proof the host read it.
    let producedText = null;
    try {
      let result;
      if (name === 'delegate_wait') {
        result = await waitAnswer(payload, context);
      } else if (name === 'delegate_submit') {
        result = await submitAnswer(payload, context);
      } else if (name === 'delegate_result') {
        const { includeDiff, ...resultBody } = payload;
        result = await callExecution(route, resultBody);
        if (includeDiff === false && result?.ok === true && result.task?.diff && typeof result.task.diff === 'object') {
          result = {
            ...result,
            task: {
              ...result.task,
              diff: {
                ...result.task.diff,
                patchText: '',
                patchOmitted: true,
                omittedByRequest: true,
              },
            },
          };
        }
      } else if (name === 'delegate_permission_decide') {
        result = await decidePermissionAnswer(payload, context);
      } else if (name === 'delegate_question_answer') {
        result = await answerQuestionCall(payload, context);
      } else if (name === 'delegate_metrics') {
        // A census of THIS process: no plane route, no task identity, nothing to change.
        result = { ok: true, metrics: metrics.snapshot() };
      } else if (name === 'delegate_review') {
        const { receiptOnly, ...review } = payload;
        result = await callExecution(route, review);
        if (receiptOnly && result?.ok === true) {
          result = {
            ok: true,
            taskId: result.task?.taskId ?? review.taskId,
            reviewPersistence: result.reviewPersistence ?? result.task?.reviewPersistence ?? null,
          };
        } else if (result?.ok === true && result.reviewPersistence !== undefined) {
          result = {
            ok: true,
            reviewPersistence: result.reviewPersistence,
            ...(result.hostAcceptance !== undefined ? { hostAcceptance: result.hostAcceptance } : {}),
            ...result,
          };
        }
      } else {
        result = await callExecution(route, payload);
      }
      // A paged read of the review note or completion summary returns only its slice:
      // it is a different, small ANSWER shape, not a projection of the big one.
      const page = name === 'delegate_result'
        ? (reviewNotePage(payload, result) ?? completionSummaryPage(payload, result))
        : null;
      const bounded = boundedJson(page ?? result);
      producedText = bounded.text;
      // A structurally trimmed answer is a real answer, so `isError` stays unset;
      // only an answer that could not be delivered at all is reported as an error.
      return bounded.isError
        ? { content: [{ type: 'text', text: bounded.text }], isError: true }
        : { content: [{ type: 'text', text: bounded.text }] };
    } catch (error) {
      // A refusal is a tool-level error, not a protocol error: the client must see
      // the harness's stable code so it can act on it, and `isError` tells it the
      // call failed without tearing down the session.
      const code = typeof error?.code === 'string' ? error.code : 'MCP_CALL_FAILED';
      const message = diagnostic(error?.message ?? String(error), 400) ?? 'the delegated call was refused';
      logger?.warn?.('dsh-delegate-mcp: call refused', code);
      // A refusal that carries structured facts (a decision receipt whose outcome nobody
      // established) publishes them as `error.details`. The refusal still REFUSES — nothing
      // here turns it into a success — but a coordinator keeps the identity it needs to
      // query the task instead of resending blindly.
      const details = error instanceof McpError && error.details !== null && error.details !== undefined
        ? error.details
        : undefined;
      // An acknowledgment verdict the wait loop already learned survives this refusal:
      // whether the host's ack landed (or was refused) is a fact about the past that a
      // transport failure or a cancellation must not erase, and the host must never
      // have to resend an ack blindly. Attached verbatim as `details.failureAck`.
      const ackFact = error !== null && typeof error === 'object' && error.failureAck !== undefined
        ? error.failureAck
        : (details !== undefined && details.failureAck !== undefined ? details.failureAck : undefined);
      const boundedDetails = ackFact !== undefined
        ? { ...(details ?? {}), failureAck: ackFact }
        : details;
      producedText = boundedJson({
        ok: false,
        error: { code, message, ...(boundedDetails === undefined ? {} : { details: boundedDetails }) },
      }).text;
      return {
        content: [{ type: 'text', text: producedText }],
        isError: true,
      };
    } finally {
      // Counted for every outcome, including a refusal and a cancellation: the size is of
      // the text this process handed back, whatever that text said. `null` means no text
      // existed at all, which the census reports as an unmeasured return.
      metrics.recordReturn(producedText);
    }
  }

  /**
   * Reject with `MCP_REQUEST_CANCELLED` when this MCP request has already been cancelled.
   * @param {{ signal?: AbortSignal }} [context] - per-request cancellation.
   * @returns {void}
   */
  function throwIfRequestCancelled(context) {
    if (context?.signal?.aborted !== true) return;
    const reason = context.signal.reason;
    const code = typeof reason?.code === 'string' && reason.code !== ''
      ? reason.code
      : 'MCP_REQUEST_CANCELLED';
    const message = typeof reason?.message === 'string' && reason.message !== ''
      ? reason.message
      : 'the request was cancelled by the host';
    throw new McpError(code, message);
  }

  /**
   * One `delegate_submit` call, optionally performing automatic preflight and/or
   * single-chain waiting inside the same MCP call to eliminate round-trip turns.
   * @param {object} payload - validated submit arguments.
   * @param {{ signal?: AbortSignal }} context - per-request cancellation.
   * @returns {Promise<object>} submit answer, preflight block, or compact wait answer + receipt.
   */
  async function submitAnswer(payload, context) {
    throwIfRequestCancelled(context);
    const { autoPreflight, allowShared, wait, waitSeconds, ...rawSubmitBody } = payload;
    let submitBody = rawSubmitBody;
    let preflightResult = null;
    if (autoPreflight === true
      && submitBody.continueFromTaskId === undefined
      && submitBody.reuseWorktreeFromTaskId === undefined) {
      try {
        preflightResult = await callExecution(
          'preflight',
          {
            workspacePath: submitBody.workspacePath,
            ...(allowShared === true ? { allowShared: true } : {}),
          },
          ...(context?.signal !== undefined ? [{ signal: context.signal }] : []),
        );
      } catch (error) {
        throwIfRequestCancelled(context);
        throw error;
      }
      throwIfRequestCancelled(context);
      const resolvedIso = preflightResult?.isolation ?? preflightResult?.preflight?.isolation ?? null;
      if (preflightResult?.ok !== true || resolvedIso === 'block' || resolvedIso === null) {
        return { ok: true, submitted: false, preflight: preflightResult };
      }
      if (resolvedIso === 'shared' && submitBody.overrides?.isolation === undefined) {
        submitBody = {
          ...submitBody,
          overrides: { ...(submitBody.overrides ?? {}), isolation: 'shared' },
        };
      }
    }
    throwIfRequestCancelled(context);
    const submitted = await callExecution('submit', submitBody);
    if (wait !== true) {
      if (autoPreflight === true) {
        return {
          ...submitted,
          submitted: true,
          ...(preflightResult === null ? {} : { preflight: preflightResult }),
        };
      }
      return submitted;
    }
    const t = submitted?.task ?? {};
    const taskId = typeof t.taskId === 'string' && t.taskId !== '' ? t.taskId : null;
    const submitReceipt = {
      taskId,
      sourcePath: t.sourcePath ?? null,
      executionWorkspacePath: t.executionWorkspacePath ?? t.workspacePath ?? null,
      isolation: t.isolation ?? null,
      reusedWorktree: t.worktree?.reused === true,
      ...(typeof t.reuseWorktreeFromTaskId === 'string' && t.reuseWorktreeFromTaskId !== ''
        ? { reuseWorktreeFromTaskId: t.reuseWorktreeFromTaskId }
        : {}),
      ...(typeof t.continueFromTaskId === 'string' && t.continueFromTaskId !== ''
        ? { continueFromTaskId: t.continueFromTaskId }
        : {}),
      agentTeams: t.agentTeams ?? null,
      ...(t.agentTeamsOrigin !== undefined ? { agentTeamsOrigin: t.agentTeamsOrigin } : {}),
    };
    if (taskId === null) {
      return {
        ...submitted,
        submitted: true,
        submitReceipt,
        ...(preflightResult === null ? {} : { preflight: preflightResult }),
      };
    }
    try {
      const waited = await waitAnswer(
        { taskId, ...(waitSeconds === undefined ? {} : { waitSeconds }) },
        context,
      );
      return {
        ...waited,
        submitted: true,
        submitReceipt,
        ...(preflightResult === null ? {} : { preflight: preflightResult }),
      };
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'MCP_WAIT_FAILED';
      const message = diagnostic(error?.message ?? String(error), 400) ?? 'the follow-up wait failed after submission';
      return {
        ok: true,
        submitted: true,
        taskId,
        submitReceipt,
        ...(preflightResult === null ? {} : { preflight: preflightResult }),
        reason: null,
        waitError: { code, message },
      };
    }
  }

  /**
   * One `delegate_wait` call: a bounded loop of internal observations.
   *
   * The loop lives in `./wait.js`, and this function only supplies the pieces the
   * loop must not own itself — the transport call, the clock and the caller's
   * cancellation — so the loop can be tested without a server and a test can drive
   * twenty minutes of activity in milliseconds.
   * @param {object} payload - validated arguments.
   * @param {{ signal?: AbortSignal }} context - per-request cancellation.
   * @returns {Promise<object>} `{ ok: true, ...answer }`.
   */
  async function waitAnswer(payload, context, options = {}) {
    const waitSeconds = payload.waitSeconds ?? DEFAULT_WAIT_SECONDS;
    // The receiver's acknowledgment of an earlier reminder. It is consumed HERE and
    // forwarded to the internal observations; it never reaches the plane as part of
    // any other tool call.
    const ackFailureEventId = typeof payload.ackFailureEventId === 'string' && payload.ackFailureEventId !== ''
      ? payload.ackFailureEventId
      : null;
    const correlation = {
      waitId: nextCorrelationId('wait'),
      afterDecisionId: options.afterDecisionId ?? null,
    };
    const result = await waitForTask({
      callExecution,
      taskId: payload.taskId,
      waitMs: waitSeconds * 1_000,
      signal: context?.signal,
      now,
      sleep,
      correlation,
      skipPermission: options.skipPermission,
      skipQuestion: options.skipQuestion,
      ...(ackFailureEventId === null ? {} : { ackFailureEventId }),
      // The loop reports its own accounting once, on every exit path, so a wait that
      // threw is counted too. Counting lives HERE, not in the answer: a thrown call has
      // no answer to carry a count.
      waitMetrics: (summary) => metrics.recordWait(summary),
    });
    if (result?.error !== undefined) {
      // The loop could not obtain an observation at all. That is a refusal with the
      // harness's own code, raised so the standard refusal path shapes it — never an
      // answer that would look like a task state. An ack verdict the loop already
      // learned survives the refusal: the wait loop attaches it at the TOP LEVEL of
      // the refusal answer (`result.failureAck`); older shapes that carried it inside
      // `result.error.failureAck` are still honoured, so the host learns from the
      // refusal whether its acknowledgment landed instead of guessing.
      const ackFact = result.failureAck ?? result.error?.failureAck;
      if (ackFact !== null && ackFact !== undefined) {
        throw new McpError(result.error.code, result.error.message, { details: { failureAck: ackFact } });
      }
      throw new McpError(result.error.code, result.error.message);
    }
    return { ok: true, ...result };
  }

  /**
   * One `delegate_permission_decide` call.
   *
   * Two shapes, and the flag selects between them:
   *
   *  * **`waitAfterDecision` absent or `false` — the historical call, unchanged.** The
   *    permission route's answer is returned verbatim, with no receipt and no added
   *    field, so an existing client sees exactly what it saw in 1.4.2. Only the internal
   *    census knows the call happened.
   *  * **`waitAfterDecision: true` — decide, then continue in the SAME call.** The answer
   *    is the flat wait shape a `delegate_wait` returns (`reason`/`state`/`permission`/
   *    `task` at the top level, the whole redacted pending operation with its
   *    `completeness`/`fingerprint`) plus a `decisionReceipt`. That shape is deliberate:
   *    it is the shape `boundedJson` already protects, so a very large answer still keeps
   *    the receipt AND the live request — `minimalReceipt` guarantees the identity and
   *    `applied`/`confirmation` survive even the last-resort rescue, while a cut operation
   *    is explicitly marked unapprovable rather than silently shortened.
   *
   * Five invariants, in order:
   *
   *  1. **The decision goes to the existing permission route, unchanged.** It is the only
   *     thing that can apply it, and it re-validates ownership, the switch, the deadline,
   *     the fingerprint and the completeness flags. It is sent FIRST and alone, so a
   *     refused decision issues no other request and raises the same refusal code it always
   *     did.
   *  2. **`waitAfterDecision` never reaches the plane.** It is stripped here, at the MCP
   *     boundary, and the decision route's existing unknown-field validation is the guard
   *     for a caller that tries anyway. No route change is needed for this flag.
   *  3. **`applied` is only claimed from matching evidence.** The receipt is built by
   *     `decisionReceipt`, which requires the answer to name the SAME task, the SAME request
   *     and the SAME operation the decision was bound to, plus a settled `state` and the
   *     `outcome` this decision asked for. An answer that is `ok: false`, that lacks that
   *     evidence, or that CONTRADICTS the decision is `applied: null` with
   *     `confirmation: "unknown"` — never a fabricated `false` and never a silent
   *     substitution of the quoted fingerprint — and it is refused and NOT continued.
   *  4. **A new request is never inherited.** The shared wait loop skips an observation
   *     that still describes the request this call decided, matching on requestId AND
   *     fingerprint; anything else is answered as the new question it is.
   *  5. **An applied decision is never unsaid.** If the follow-up wait then fails, is
   *     cancelled or is interrupted, this call still SUCCEEDS with the receipt,
   *     `reason: null` and a `waitError` block, instead of falling into the generic refusal
   *     path that would replace the answer with a bare error and swallow the receipt.
   * @param {object} payload - validated arguments (may carry `waitAfterDecision`).
   * @param {{ signal?: AbortSignal }} context - per-request cancellation.
   * @returns {Promise<object>} the permission answer, or the flat wait answer plus a receipt.
   */
  async function decidePermissionAnswer(payload, context) {
    const { waitAfterDecision, ...decisionBody } = payload;
    const receiptId = nextCorrelationId('decision');
    let result;
    try {
      result = await callExecution('permission', decisionBody);
    } catch (error) {
      // Nothing was confirmed. Two cases, and they are NOT the same fact:
      //
      //  * the HARNESS answered with its own refusal code — the decision is definitely NOT
      //    applied, which is the refusal every earlier client already handles;
      //  * the call failed before an answer existed (transport, timeout, malformed body) —
      //    whether it was applied is genuinely UNKNOWN, and that must never be reported as
      //    a clean failure that invites a resend.
      const code = typeof error?.code === 'string' ? error.code : 'MCP_CALL_FAILED';
      const unconfirmed = UNCONFIRMED_DECISION_CODES.has(code);
      const receipt = {
        receiptId,
        ...decisionReceipt({
          taskId: decisionBody.taskId ?? null,
          requestId: decisionBody.requestId ?? null,
          decision: decisionBody.decision ?? null,
          fingerprint: typeof decisionBody.fingerprint === 'string' ? decisionBody.fingerprint : null,
          error: { code },
          refusedByHarness: !unconfirmed,
        }),
      };
      metrics.recordDecision({
        receiptId,
        taskId: receipt.taskId,
        requestId: receipt.requestId,
        decision: receipt.decision,
        fingerprint: receipt.fingerprint,
        applied: receipt.applied,
        confirmation: receipt.confirmation,
      });
      // The historical protocol is unchanged: without the flag the refusal is rethrown
      // exactly as before, with no added field.
      if (waitAfterDecision !== true) throw error;
      // With the flag, an UNCONFIRMED decision is still refused (nothing awaits it), but the
      // refusal now CARRIES its identity so a coordinator can query the task by name instead
      // of resending blindly. A harness refusal keeps its own code and its own shape.
      if (!unconfirmed) throw error;
      throw new McpError(code, `${error?.message ?? 'the decision could not be confirmed'} `
        + '(unknown whether it was applied; read the task with delegate_result before sending it again)', {
        details: { decisionReceipt: receipt },
      });
    }
    const receipt = { receiptId, ...decisionReceipt({
      taskId: decisionBody.taskId ?? null,
      requestId: decisionBody.requestId ?? null,
      decision: decisionBody.decision ?? null,
      fingerprint: typeof decisionBody.fingerprint === 'string' ? decisionBody.fingerprint : null,
      answer: result,
    }) };
    metrics.recordDecision({
      receiptId,
      taskId: receipt.taskId,
      requestId: receipt.requestId,
      decision: receipt.decision,
      fingerprint: receipt.fingerprint,
      applied: receipt.applied,
      confirmation: receipt.confirmation,
    });
    if (waitAfterDecision !== true) return result;
    // A decision that could not be CONFIRMED must never continue: the answer would look like
    // a running task whose state nobody established. It is refused with its identity instead.
    if (receipt.applied !== true) {
      throw new McpError('MCP_DECISION_UNCONFIRMED',
        `the decision was not confirmed by the harness (${receipt.reason ?? 'no usable confirmation evidence'}); `
        + 'read the task with delegate_result before deciding whether to send it again',
        { details: { decisionReceipt: receipt } });
    }
    // The same wait loop a plain `delegate_wait` uses: its default deadline, its 25-second
    // observation bound, its heartbeat handling and its interruption classification. The
    // ONLY addition is the rollover predicate.
    let answer;
    try {
      answer = await waitAnswer({ taskId: receipt.taskId }, context, {
        afterDecisionId: receipt.receiptId,
        skipPermission: decidedRequestMatcher(receipt),
      });
    } catch (error) {
      // The decision was ALREADY APPLIED. The general refusal path would replace this answer
      // with a bare error and swallow the receipt, which is exactly how a coordinator loses
      // track of an authorization that IS in force. So a follow-up failure — a transport
      // error, an abort, a spent deadline — is reported WITH the receipt, and says plainly
      // that only the waiting failed.
      const code = typeof error?.code === 'string' ? error.code : 'MCP_CALL_FAILED';
      const message = diagnostic(error?.message ?? String(error), 400) ?? 'the follow-up wait could not be completed';
      logger?.warn?.('dsh-delegate-mcp: decision applied, follow-up wait ended', code);
      return {
        ok: true,
        // A wait outcome, not a decision outcome: `reason: null` states that no task state was
        // observed, so nothing can be read as "still running" or "finished".
        reason: null,
        taskId: receipt.taskId,
        actionable: false,
        terminal: false,
        instruction: 'The decision WAS applied and stands — do not resend it. This call\'s follow-up wait '
          + 'failed or was interrupted; the execution was NOT stopped, cancelled or reassigned. Keep the taskId '
          + 'and call delegate_wait again on the SAME task to resume following it.',
        waitError: { code, message, phase: 'follow-up-wait' },
        decisionReceipt: receipt,
      };
    }
    return { ...answer, decisionReceipt: receipt };
  }

  /**
   * The request id of a pending block, in either published shape.
   *
   * A wait answer may publish the block directly (`{ requestId, questions }`) or wrap it
   * (`{ pending: { requestId, questions } }`), and both are accepted everywhere else in this
   * file. Reading only one shape here would make the post-answer rollover skip nothing — the
   * answered question would be offered again as if it were new — so both are read in one place.
   * @param {unknown} block - the published question block.
   * @returns {string | null} the request id, or null.
   */
  function pendingRequestIdOf(block) {
    if (block === null || typeof block !== 'object') return null;
    const inner = block.questions === undefined && block.pending !== null && typeof block.pending === 'object'
      ? block.pending
      : block;
    return typeof inner?.requestId === 'string' && inner.requestId !== '' ? inner.requestId : null;
  }

  /**
   * Whether a route's echoed answer batch is the one this call sent.
   *
   * Compared entry by entry, because a route that normalised an answer differently (dropped
   * a label, changed custom text, duplicated a question) did NOT apply what was sent. Order
   * is not significant: answers are identified by question id.
   * @param {unknown} echoed - the route's answers.
   * @param {unknown} sent - the answers this call sent.
   * @returns {boolean} true only when both batches are equal by id.
   */
  function sameAnswerBatch(echoed, sent) {
    if (!Array.isArray(echoed) || !Array.isArray(sent)) return false;
    if (echoed.length !== sent.length) return false;
    const byId = new Map();
    for (const entry of echoed) {
      if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') return false;
      if (byId.has(entry.id)) return false;
      byId.set(entry.id, entry);
    }
    for (const entry of sent) {
      const other = byId.get(entry?.id);
      if (other === undefined) return false;
      const left = Array.isArray(other.selected) ? other.selected : [];
      const right = Array.isArray(entry.selected) ? entry.selected : [];
      if (left.length !== right.length || left.some((label, index) => label !== right[index])) return false;
      const leftCustom = typeof other.custom === 'string' ? other.custom : null;
      const rightCustom = typeof entry.custom === 'string' ? entry.custom : null;
      if (leftCustom !== rightCustom) return false;
    }
    return true;
  }

  /**
   * One `delegate_question_answer` call.
   *
   * The same two shapes the permission decision has, for the same reasons:
   *
   *  * **`waitAfterAnswer` absent or `false` — the plain call.** The question route's
   *    answer is returned verbatim, so a client that only answers sees exactly the route
   *    reply and nothing it must learn.
   *  * **`waitAfterAnswer: true` — answer, then keep following in the SAME call.** The
   *    answer is the flat wait shape plus an `answerReceipt`.
   *
   * Four invariants:
   *
   *  1. **The answer goes to the question route, unchanged.** It is the only thing that
   *     can apply it: ownership, the switch, the deadline, the single-use rule and the
   *     per-question validation all live behind it. It is sent FIRST and alone, so a
   *     refused answer issues no other request.
   *  2. **`waitAfterAnswer` never reaches the plane.** It is stripped at this boundary.
   *  3. **The receipt is evidence, not optimism.** `applied: true` is claimed only when
   *     the route answered `ok: true` AND its `answer.receiptId`/`requestId` match the
   *     ones this call sent. A transport failure is `applied: null` with
   *     `confirmation: "unknown"`, because whether it landed is genuinely unknown — and
   *     the receipt then tells the caller to read the task rather than resend.
   *  4. **An applied answer is never unsaid.** A failed follow-up wait still SUCCEEDS
   *     with the receipt, `reason: null` and a `waitError`, saying plainly that only the
   *     waiting ended.
   * @param {object} payload - validated arguments (may carry `waitAfterAnswer`).
   * @param {{ signal?: AbortSignal }} context - per-request cancellation.
   * @returns {Promise<object>} the question answer, or the flat wait answer plus a receipt.
   */
  async function answerQuestionCall(payload, context) {
    const { waitAfterAnswer, ...answerBody } = payload;
    const receiptId = nextCorrelationId('answer');
    const receiptFor = (applied, confirmation, extra = {}) => ({
      receiptId,
      taskId: answerBody.taskId ?? null,
      requestId: answerBody.requestId ?? null,
      answers: Array.isArray(answerBody.answers)
        ? answerBody.answers.map((entry) => ({
          id: entry?.id ?? null,
          selected: Array.isArray(entry?.selected) ? [...entry.selected] : [],
          ...(typeof entry?.custom === 'string' ? { custom: entry.custom } : {}),
        }))
        : [],
      applied,
      confirmation,
      // Stated on every receipt so no reader can mistake this for an approval.
      grantsAccess: false,
      ...extra,
    });
    let result;
    try {
      result = await callExecution('question', answerBody);
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'MCP_CALL_FAILED';
      const unconfirmed = UNCONFIRMED_DECISION_CODES.has(code);
      const receipt = receiptFor(
        unconfirmed ? null : false,
        unconfirmed ? 'unknown' : 'refused',
        { reason: code },
      );
      // The historical protocol is unchanged: without the flag the refusal is rethrown as
      // it is, with no added field.
      if (waitAfterAnswer !== true) throw error;
      if (!unconfirmed) throw error;
      throw new McpError(code, `${error?.message ?? 'the answer could not be confirmed'} `
        + '(unknown whether it was applied; read the task with delegate_result before sending it again)', {
        details: { answerReceipt: receipt },
      });
    }
    const answered = result?.answer ?? null;
    // Confirmation requires the route to echo the SAME task, request AND the answers it
    // actually normalised. A route that answers `ok: true` for a different request, or
    // whose stored answers differ from what was sent, established nothing about THIS
    // answer — so `applied` becomes `null` with `confirmation: "unknown"`, never `false`
    // (which would read as "definitely not applied" and invite a resend).
    const confirmed = result?.ok === true
      && answered !== null && typeof answered === 'object'
      && answered.requestId === answerBody.requestId
      && answered.taskId === answerBody.taskId
      && sameAnswerBatch(answered.answers, answerBody.answers);
    const receipt = receiptFor(confirmed ? true : null, confirmed ? 'confirmed' : 'unknown', {
      ...(confirmed ? {} : { reason: 'the route answered without matching this request and its answers' }),
    });
    metrics.recordDecision({
      receiptId,
      taskId: receipt.taskId,
      requestId: receipt.requestId,
      decision: QUESTION_ANSWER_KIND,
      fingerprint: null,
      applied: receipt.applied,
      confirmation: receipt.confirmation,
    });
    if (waitAfterAnswer !== true) return result;
    if (receipt.applied !== true) {
      throw new McpError('MCP_ANSWER_UNCONFIRMED',
        `the answer was not confirmed by the harness (${receipt.reason ?? 'no usable confirmation evidence'}); `
        + 'read the task with delegate_result before answering again',
        { details: { answerReceipt: receipt } });
    }
    let answer;
    try {
      answer = await waitAnswer({ taskId: receipt.taskId }, context, {
        afterDecisionId: receipt.receiptId,
        // The set this call just answered can occupy the engine's slot for a moment. Skip
        // exactly that request id; a different one is a NEW question and returns at once.
        // The id is read from the block directly AND from a `{ pending: … }` wrapper,
        // because a harness may publish either shape — a matcher that knew one would let the
        // answered question be re-offered as a new one.
        skipQuestion: (observation) => pendingRequestIdOf(observation?.question) === receipt.requestId,
      });
    } catch (error) {
      // The answer WAS applied. Reporting the generic refusal here would swallow the
      // receipt, which is how a coordinator loses track of an answer that is in force.
      const code = typeof error?.code === 'string' ? error.code : 'MCP_CALL_FAILED';
      const message = diagnostic(error?.message ?? String(error), 400) ?? 'the follow-up wait could not be completed';
      logger?.warn?.('dsh-delegate-mcp: answer applied, follow-up wait ended', code);
      return {
        ok: true,
        reason: null,
        taskId: receipt.taskId,
        actionable: false,
        terminal: false,
        instruction: 'The answer WAS applied and stands — do not resend it. This call\'s follow-up wait failed or '
          + 'was interrupted; the execution was NOT stopped, cancelled or reassigned. Keep the taskId and call '
          + 'delegate_wait again on the SAME task to resume following it.',
        waitError: { code, message, phase: 'follow-up-wait' },
        answerReceipt: receipt,
      };
    }
    return { ...answer, answerReceipt: receipt };
  }

  /**
   * Answer one JSON-RPC message.
   *
   * Returns `null` for a notification (the protocol forbids a response) so the
   * transport writes nothing.
   *
   * `context.signal` cancels THIS request only. It is passed down to the one place
   * a request can be long — the wait loop — so a host that gives up on a wait stops
   * the observations it is making without touching the worker, the task or any
   * other request.
   * @param {unknown} message - parsed JSON-RPC message.
   * @param {{ signal?: AbortSignal }} [context] - per-request cancellation.
   * @returns {Promise<object | null>} response, or null.
   */
  async function handle(message, context = {}) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return errorResponse(null, RPC_ERRORS.invalidRequest, 'a JSON-RPC message must be an object');
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;
    if (typeof method !== 'string' || method === '') {
      // A message with no method is a response to something this server never
      // asked; it is not an error the client must see.
      return isNotification ? null : errorResponse(id, RPC_ERRORS.invalidRequest, 'a JSON-RPC message needs a method');
    }

    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          const version = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
          initialized = true;
          return result(id, {
            protocolVersion: version,
            // Only what this server actually implements. Advertising `resources`
            // or `prompts` would invite calls that must then fail.
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: 'Delegated coding on the DSH host. Submission is allowed only while the operator '
              + 'has enabled the delegation switch in the authenticated DSH settings page. '
              + 'For delegate_submit, workspacePath is the operator-authorized SOURCE repository or checkout '
              + '(a Git checkout or an operator-authorized Git worktree are both legitimate), not a location a '
              + 'task execution ran in; delegate_preflight is a separate read-only inspection of a path. '
              + 'Every submission starts a new task conversation unless it passes continueFromTaskId naming the '
              + 'earlier delegated task it is a follow-up to; that explicit id is the only way to continue an '
              + 'existing task thread. A follow-up continues the parent\u2019s DSH Workspace and Session and reuses '
              + 'the parent\u2019s recorded execution checkout and DSH Session internally, so it passes the parent\u2019s original '
              + 'source path again and never substitutes an internal execution location for it. A parent that '
              + 'is unknown, still running, removed or belongs to another source repository is refused '
              + 'instead of starting a new conversation. For a new downstream subtask that starts a fresh DSH '
              + 'Session directly on an earlier finished isolated worktree under the same source repository, '
              + 'pass reuseWorktreeFromTaskId instead (never combined with continueFromTaskId). A worker that needs wider access for ONE tool call '
              + 'pauses that call and reports it as `permission.pending` in delegate_result; while it waits the '
              + 'task stays `running` with phase `awaiting-permission`. Answer one such request with '
              + 'delegate_permission_decide (`allow-once` or `reject`). That decision '
              + 'covers only that call, is never a standing grant, and never widens the sandbox or crosses task '
              + 'boundaries. Each later escalation requires a new decision. When your channel supports it, pass '
              + '`waitAfterDecision: true`: the decision and the following wait then happen in ONE call, and the '
              + 'answer is the same compact shape delegate_wait returns plus `decisionReceipt`. Deciding and then '
              + 'waiting is what resumes the task; a client without the flag decides first and then calls '
              + 'delegate_wait on the same taskId. `decisionReceipt.applied: true` is claimed only when the harness '
              + 'confirmed the same task, request and operation. `applied: null` with `confirmation: "unknown"` '
              + 'means nothing was established — the call failed before an answer, or the answer contradicted or '
              + 'lacked the evidence to confirm it (the refusal carries `error.details.decisionReceipt`) — so read '
              + 'the task with delegate_result before sending the decision again, and never resend automatically. '
              + 'When an APPLIED decision\'s follow-up wait fails or is cancelled, the call still succeeds with that '
              + 'receipt, `reason: null` and a `waitError` block: only the waiting ended, the execution was not '
              + 'stopped, and the decision must not be resent. To follow a task without polling, use '
              + 'delegate_wait({ taskId }): one call blocks until the task needs you (permission, question, '
              + 'attention, ready, failed, cancelled, interrupted) or until its own one-hour deadline, in which '
              + 'case it answers reason '
              + '`wait-limit` with `actionable: false` and you call it again with the same taskId instead of '
              + 'reviewing or resubmitting anything. Omit waitSeconds for normal waiting: the default already '
              + 'covers an hour, it cannot be raised above 3600, and a shorter value is only for a one-off '
              + 'diagnostic you were explicitly asked for. The approximately 25-second observation cadence '
              + 'inside delegate_wait is internal to this program, not a polling rate: while nothing has '
              + 'changed, do not read intermediate code or diff, do not research or implement in parallel, and '
              + 'do not narrate unchanged snapshots — wait, and review once on delivery. A wait ending, or your '
              + 'own client tool timeout firing, does not prove the execution stopped or that it is alive: keep '
              + 'the taskId and check one compact fact if you need to, and never duplicate, restart or cancel a '
              + 'task merely because a wait or a client timeout ended. '
              + 'Four different things must not be confused. (a) `wait-limit` is this call\'s OWN deadline: nothing '
              + 'changed, wait again on the same taskId. (b) Your client handing the call back on its own tool/exec '
              + 'time limit is an OUTER limit: the observation did not end and the worker did not stop, so continue '
              + 'the SAME exec cell and ask for the longest yield the host supports (roughly 1200000 ms when a '
              + 'yield/pragmas parameter exists, not a minute) instead of re-issuing every second. (c) `attention` '
              + 'is either a run progress check (nothing new was delivered back to the host for the operator-configured '
              + 'delivery interval in DSH settings — 40 minutes by default; internal worker activity, heartbeats, '
              + 'permission/question waits and the local self-check do not reset it, and it does NOT imply the run is '
              + 'stuck) or a `repeated-tool-failure` reminder while the task still runs. (d) There is NO default total '
              + 'execution timeout: an execution timeout (`JOB_TIMEOUT`, reported as a terminal state) only applies when '
              + 'an explicit cap is supplied via `overrides.timeoutSeconds` — it is not `wait-limit`, not `attention` '
              + 'and not a client-side event. A real '
              + 'failure is worth one de-duplicated reminder; an ordinary single failing test inside the worker is '
              + 'the worker\'s job to fix and is not a host event. '
              + '`interrupted` never means the execution stopped by itself: this call returns it at once '
              + 'with `terminal: false` while the task is still pending or running (wait again on the same '
              + 'taskId); only a task record that is itself interrupted (a restart history) is `terminal: true`. '
              + 'A one-minute return is a caller choice, not a documented hard limit, and not every client offers '
              + 'the same yield. This plugin cannot create a background waiter or wake the agent, so a client with '
              + 'only a short yield and no automatic continuation costs one resumed turn per yield window; there is '
              + 'no zero-wake guarantee across clients — state that plainly instead of inventing a wake-up. '
              + 'An `attention` answer that carries a `failure` '
              + 'block means the worker repeated the same failed operation several times while still running: '
              + 'it is a question for the host, redelivered with the SAME eventId until you acknowledge it via '
              + '`ackFailureEventId`, and nothing is cancelled or reconfigured for it. '
              + 'If a host serialises tool calls so that this '
              + 'connection is blocked by a long wait, the independently installed `dsh-delegate-control` '
              + 'binary can report or cancel one task from a separate process; it cannot submit, configure or '
              + 'change the switch. '
              + '`delegate_metrics` is a read-only census of THIS MCP process: tool calls, wait returns and their '
              + 'reasons, the UTF-8 bytes of the tool text it returned, and applied decisions. It counts the '
              + 'PROGRAM, not the host model: the host\'s own turns, token usage and cost are reported as '
              + '`not-integrated` because this process cannot observe them. '
              + 'When a task reaches `ready`/`awaiting-host-review`, finish YOUR review and record it with '
              + 'delegate_review ({ taskId, decision: "accepted" | "changes-requested", note, completionSummary? }): '
              + 'that call is the '
              + 'only thing that records host acceptance, and until it is made the task stays unreviewed. '
              + 'Completion is never acceptance on its own, and a review cannot approve permissions, change '
              + 'settings or models, merge the diff or create work. The first decision is final for that task; '
              + 'to request a correction, send a follow-up with `continueFromTaskId`.',
          });
        }
        case 'notifications/initialized':
          return null;
        case 'notifications/cancelled':
          // Handled by the transport, which owns the in-flight table: this server
          // cannot see a request that is still running from inside a handler.
          return null;
        case 'ping':
          return result(id, {});
        case 'tools/list': {
          if (!initialized) return errorResponse(id, RPC_ERRORS.invalidRequest, 'initialize must be sent before tools/list');
          // The JSON Schema objects are shared and never mutated, so the catalog is
          // returned by reference; a client cannot corrupt it because it only reads.
          return result(id, { tools: TOOLS.map((tool) => ({ ...tool })) });
        }
        case 'tools/call': {
          if (!initialized) return errorResponse(id, RPC_ERRORS.invalidRequest, 'initialize must be sent before tools/call');
          const name = params?.name;
          if (typeof name !== 'string' || name === '') {
            return errorResponse(id, RPC_ERRORS.invalidParams, 'tools/call requires a tool name');
          }
          return result(id, await callTool(name, params?.arguments, context));
        }
        default:
          return errorResponse(id, RPC_ERRORS.methodNotFound, `this server does not implement ${JSON.stringify(method)}`);
      }
    } catch (error) {
      if (error instanceof McpError && error.rpcCode !== null) {
        return errorResponse(id, error.rpcCode, error.message);
      }
      // An unexpected failure is reported with its code only: a stack or a
      // message may quote configuration this server must not disclose.
      const code = typeof error?.code === 'string' ? error.code : 'MCP_INTERNAL';
      return errorResponse(id, RPC_ERRORS.internal, `the delegation server failed (${code})`);
    }
  }

  return {
    handle,
    tools: TOOLS,
    calls,
    isInitialized: () => initialized,
    /** The bounded census behind `delegate_metrics`; counts and sizes only. */
    metrics: () => metrics.snapshot(),
    /** One line for the exit diagnostics; counts and byte totals, no task content. */
    diagnosticsLine: () => metrics.diagnosticsLine(),
  };
}

/**
 * Build a JSON-RPC success response.
 * @param {unknown} id - request id.
 * @param {unknown} value - result.
 * @returns {object} response envelope.
 */
function result(id, value) {
  return { jsonrpc: '2.0', id: id ?? null, result: value };
}

/**
 * Build a JSON-RPC error response.
 * @param {unknown} id - request id.
 * @param {number} code - JSON-RPC error code.
 * @param {string} message - explanation.
 * @returns {object} response envelope.
 */
function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Run the newline-delimited JSON-RPC loop over a pair of streams.
 *
 * MCP's stdio transport is one JSON-RPC message per line: there is no
 * `Content-Length` framing here, and adding it would break the client. Malformed
 * input produces a parse error and the loop continues, because a single bad line
 * must not end a session the model is still using.
 *
 * Two properties of this loop are load-bearing and were added for `delegate_wait`:
 *
 *   1. **A request that takes minutes must not stop the others.** Each request is
 *      dispatched and its reply written when it settles, so a host can send a
 *      status read or a cancel while a wait is outstanding. Replies are written one
 *      line at a time through a single writer, so two concurrent answers can never
 *      interleave inside a line.
 *   2. **Cancellation is per request.** `notifications/cancelled` aborts exactly the
 *      request it names: that request's wait ends, its reply is a normal refusal,
 *      and every other request (including another wait on the same task) continues.
 *
 * The concurrency bound is a refusal, not a queue: a host that sends a 33rd
 * simultaneous request is told so explicitly. Stdin EOF stops accepting new work,
 * aborts nothing on the worker side, and the loop returns only once every
 * outstanding reply has been written, so nothing is truncated at shutdown.
 * @param {object} options - `input`, `output` streams, `server`, optional `onError`,
 *   `maxInflight`.
 * @returns {Promise<void>} resolves when the input stream ends and replies are drained.
 */
export async function serveStdio(options) {
  const { input, output, server } = options;
  const onError = options.onError ?? (() => {});
  const maxInflight = Number.isInteger(options.maxInflight) && options.maxInflight > 0
    ? options.maxInflight
    : MAX_INFLIGHT_REQUESTS;

  /**
   * Serialize every write so a line is never split by another request's answer.
   *
   * Each write waits for the previous one, and also for `drain` when the stream
   * applies backpressure. A rejected write (a closed pipe) must not leave the queue
   * permanently blocked, which is why the chain continues even after a failure.
   * @param {object} payload - JSON-RPC message.
   * @returns {Promise<void>} resolves after this line is written (or fails to be).
   */
  let writeChain = Promise.resolve();
  const write = (payload) => {
    const line = `${JSON.stringify(payload)}\n`;
    writeChain = writeChain.then(() => new Promise((resolvePromise) => {
      let ok = true;
      try {
        ok = output.write(line) !== false;
      } catch (error) {
        onError(error);
        resolvePromise();
        return;
      }
      if (ok) {
        resolvePromise();
        return;
      }
      output.once('drain', resolvePromise);
      // A stream destroyed while waiting for `drain` never emits it; without this
      // the writer would wait forever and EOF would hang instead of draining.
      output.once('close', resolvePromise);
    }));
    return writeChain;
  };

  /** Requests currently in flight, by the JSON-RPC id as a map key. */
  const inflight = new Map();
  /** Every outstanding request promise, so EOF can drain them all. */
  const pending = new Set();
  let inputEnded = false;
  /** Set once the transport is shutting down: no new work is accepted. */
  let closed = false;

  /**
   * A stable map key for a request id. JSON-RPC ids are strings or numbers; a
   * string `"1"` and a number `1` are distinct ids, so the type is part of the key.
   * @param {unknown} id - request id.
   * @returns {string} map key.
   */
  const idKey = (id) => `${typeof id}:${String(id)}`;

  /**
   * Ask one in-flight request to stop.
   * @param {unknown} requestId - the id named by the notification.
   * @returns {boolean} whether a request was actually cancelled.
   */
  const cancel = (requestId) => {
    const entry = inflight.get(idKey(requestId));
    if (entry === undefined) return false;
    const error = new Error('the request was cancelled by the host');
    error.name = 'AbortError';
    error.code = 'MCP_REQUEST_CANCELLED';
    entry.controller.abort(error);
    return true;
  };

  /**
   * Handle one parsed line: a request is started, a notification is acted on.
   * @param {object} message - parsed JSON-RPC message.
   * @returns {void}
   */
  const dispatch = (message) => {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      void write(errorResponse(null, RPC_ERRORS.invalidRequest, 'a JSON-RPC message must be an object'));
      return;
    }
    const { id, method } = message;
    if (method === 'notifications/cancelled') {
      // Never answered: the protocol forbids a response to a notification. The
      // cancellation request id travels in `params.requestId`.
      cancel(message.params?.requestId);
      return;
    }
    if (id === undefined || id === null) {
      // Any other notification is handled for its effect only.
      void (async () => {
        try {
          await server.handle(message);
        } catch (error) {
          onError(error);
        }
      })();
      return;
    }
    const key = idKey(id);
    if (inflight.has(key)) {
      // Two live requests with one id would make the answers unassignable, and the
      // second would silently replace the first's cancellation handle. Refusing is
      // the only honest answer; the original request keeps running.
      void write(errorResponse(id, RPC_ERRORS.invalidRequest, 'a request with this id is already in flight'));
      return;
    }
    if (inflight.size >= maxInflight) {
      void write(errorResponse(id, RPC_ERRORS.invalidRequest, `too many requests in flight (limit ${maxInflight})`));
      return;
    }

    const controller = new AbortController();
    inflight.set(key, { controller });
    const run = (async () => {
      let response = null;
      try {
        response = await server.handle(message, { signal: controller.signal });
      } catch (error) {
        onError(error);
        response = errorResponse(message?.id ?? null, RPC_ERRORS.internal, 'the request could not be handled');
      } finally {
        inflight.delete(key);
      }
      if (response !== null && response !== undefined) await write(response);
    })();
    pending.add(run);
    void run.finally(() => pending.delete(run));
  };

  let buffer = '';
  try {
    for await (const chunk of input) {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line === '') continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          await write(errorResponse(null, RPC_ERRORS.parse, 'the message is not valid JSON'));
          continue;
        }
        // Awaited so the next line is not read before this one has been attributed,
        // but the request it starts is NOT awaited: that is what keeps a long wait
        // from blocking the transport.
        dispatch(message);
      }
    }
  } catch (error) {
    onError(error);
  }
  inputEnded = true;
  closed = true;

  // Drain: every reply that was already being produced is written before the loop
  // returns. Readers are ended here, but nothing is aborted on the worker side — a
  // wait that ends because its host vanished is the host's decision, not a cancel.
  while (pending.size > 0) await Promise.allSettled([...pending]);
  await writeChain;
  return { inflight: inputEnded, closed, drained: pending.size === 0 };
}

// ---------------------------------------------------------------------------
// Paged review-note reads (R5)
// ---------------------------------------------------------------------------
//
// A review note may be up to 8000 code points, and the same note appears twice in a full
// result (`hostAcceptance` and inside the task), which can exceed the tool-text bound. The
// full result therefore states `noteOmitted` when it had to give the body up, and this
// reader returns the body a page at a time: every page carries its own total, so a caller
// can reassemble the EXACT text and can tell a complete read from a partial one.

/**
 * Build the page answer for one `reviewNoteOffset` read, or null for a normal result.
 * @param {object} payload - validated `delegate_result` arguments.
 * @param {object} result - the plane's answer.
 * @returns {object | null} the page answer, or null when this is not a paged read.
 */
function reviewNotePage(payload, result) {
  if (payload?.reviewNoteOffset === undefined) return null;
  const task = result?.task !== null && typeof result?.task === 'object' ? result.task : null;
  const acceptance = task?.hostAcceptance ?? result?.hostAcceptance ?? null;
  const note = typeof acceptance?.note === 'string' ? acceptance.note : '';
  const points = Array.from(note);
  const offset = Math.min(payload.reviewNoteOffset, points.length);
  const limit = payload.reviewNoteLimit ?? DEFAULT_REVIEW_NOTE_PAGE_CHARS;
  const slice = points.slice(offset, offset + limit).join('');
  const next = offset + (offset + limit < points.length ? limit : points.length - offset);
  return {
    ok: true,
    taskId: task?.taskId ?? payload.taskId,
    state: task?.state ?? null,
    reviewNote: {
      offset,
      limit,
      text: slice,
      noteChars: points.length,
      nextOffset: next < points.length ? next : null,
      complete: next >= points.length,
      // Stated so a paged read is never confused with "the task has no analysis".
      present: note !== '',
    },
    hostAcceptance: acceptance === null
      ? null
      : {
        accepted: acceptance.accepted === true,
        state: acceptance.state ?? null,
        acceptedAt: acceptance.acceptedAt ?? null,
        by: acceptance.by ?? null,
        noteChars: points.length,
        noteOmitted: true,
        ...(typeof acceptance.completionSummary === 'string' && acceptance.completionSummary !== ''
          ? {
            completionSummaryChars: Array.from(acceptance.completionSummary).length,
            completionSummaryOmitted: true,
          }
          : {}),
      },
    reviewPersistence: task?.reviewPersistence ?? null,
  };
}

/**
 * Build the page answer for one `completionSummaryOffset` read, or null for a normal result.
 * @param {object} payload - validated `delegate_result` arguments.
 * @param {object} result - the plane's answer.
 * @returns {object | null} the page answer, or null when this is not a summary paged read.
 */
function completionSummaryPage(payload, result) {
  if (payload?.completionSummaryOffset === undefined) return null;
  const task = result?.task !== null && typeof result?.task === 'object' ? result.task : null;
  const acceptance = task?.hostAcceptance ?? result?.hostAcceptance ?? null;
  const summary = typeof acceptance?.completionSummary === 'string' ? acceptance.completionSummary : '';
  const points = Array.from(summary);
  const offset = Math.min(payload.completionSummaryOffset, points.length);
  const limit = payload.completionSummaryLimit ?? DEFAULT_COMPLETION_SUMMARY_PAGE_CHARS;
  const slice = points.slice(offset, offset + limit).join('');
  const next = offset + (offset + limit < points.length ? limit : points.length - offset);
  const noteChars = typeof acceptance?.note === 'string'
    ? Array.from(acceptance.note).length
    : (typeof acceptance?.noteChars === 'number' ? acceptance.noteChars : 0);
  return {
    ok: true,
    taskId: task?.taskId ?? payload.taskId,
    state: task?.state ?? null,
    completionSummary: {
      offset,
      limit,
      text: slice,
      summaryChars: points.length,
      nextOffset: next < points.length ? next : null,
      complete: next >= points.length,
      present: summary !== '',
    },
    hostAcceptance: acceptance === null
      ? null
      : {
        accepted: acceptance.accepted === true,
        state: acceptance.state ?? null,
        acceptedAt: acceptance.acceptedAt ?? null,
        by: acceptance.by ?? null,
        noteChars,
        noteOmitted: true,
        ...(summary !== '' ? { completionSummaryChars: points.length, completionSummaryOmitted: true } : {}),
      },
    reviewPersistence: task?.reviewPersistence ?? null,
  };
}
