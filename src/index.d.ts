// Type declarations for the dsh-delegate native plugin entry (`src/index.js`).
//
// These describe only the package's own public surface — the Cordis plugin object
// DSH imports, the optional-config shape, and the two exported helpers. They are
// hand-written against the runtime module because this package ships plain ESM
// JavaScript; there is no build step that emits declarations.
//
// Every declared member below exists on the runtime module today. Adding a member
// to `src/index.js` without adding it here leaves the package usable but
// under-declared; removing one here before removing it from the runtime would make
// the declaration lie.

/** Stable Cordis plugin name; also the settings/document namespace. */
export declare const name: 'dsh-taskbridge';

/**
 * Injected native services. While any of these is absent Cordis does not activate
 * the plugin, so no handler can run against a half-built harness.
 */
export declare const inject: readonly ['agents', 'sessions', 'llm', 'tools', 'webServer', 'connection'];

/**
 * Plugin configuration schema.
 *
 * This is a `@deepseek-ai/schemastery` schema object, not a plain structural
 * shape: Cordis validates it through the Standard Schema interface
 * (`Config['~standard'].validate`), which a plain object does not implement.
 * The schema's value type is `{ dataDir: string }`.
 */
export declare const Config: import('@deepseek-ai/schemastery').default.Schema<{ dataDir: string }>;

/** One operator-facing provider profile after validation. Never carries a secret. */
export interface DelegateProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  protocol: string;
  /** Reference into the harness credential seam, or `null` when unset. */
  credentialRef: string | null;
  models: Array<{ id: string; name?: string; efforts?: string[] }>;
  [field: string]: unknown;
}

/** Bounded diagnostic shape shared by the connectivity fan-out and the HTTP planes. */
export interface DelegateError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Per-provider connectivity report: HTTP, auth and catalog layers reported separately from the model probe. */
export interface DelegateProviderConnectivity {
  providerId: string;
  providerName?: string;
  error?: DelegateError | null;
  [layer: string]: unknown;
}

/** Whole-configuration connectivity report produced by {@link checkConnectivity}. */
export interface DelegateConnectivityReport {
  ok: boolean;
  providers: DelegateProviderConnectivity[];
  error?: DelegateError;
}

/**
 * Dependency object the exported helpers accept. Only the fields they read are
 * required; the plugin's own engine passes a much wider object.
 */
export interface DelegateRuntimeDeps {
  llm?: unknown;
  settings?: { read?: () => Promise<unknown> } | unknown;
  [key: string]: unknown;
}

/** One routable provider/model/effort selection that has already been validated. */
export interface DelegateSelection {
  providerId: string;
  providerRoute?: string;
  model: string;
  reasoningEffort?: string | null;
  [field: string]: unknown;
}

/** Routable descriptor returned by {@link resolveRoute}. */
export interface DelegateResolvedRoute {
  providerRoute: string;
  model: string;
  reasoningEffort?: string | null;
  [field: string]: unknown;
}

/** One provider's catalog row returned by {@link describeCatalog}. */
export interface DelegateCatalogEntry {
  providerId: string;
  route: string;
  models: Array<{ id: string; name?: string; efforts?: string[] }>;
  error: DelegateError | null;
}

/** Options accepted by {@link resolveRoute} and {@link describeCatalog}. */
export interface DelegateRouteOptions {
  signal?: AbortSignal;
  routes?: Map<string, string> | null;
  requireEffort?: boolean;
}

/** Commander-supplied submission fields (`delegate_submit`, `POST /tasks`; prose <= 2000 code points). */
export interface DelegateSubmitRequest {
  workspacePath: string;
  prompt: string;
  title?: string;
  goalDescription?: string;
  continueFromTaskId?: string;
  reuseWorktreeFromTaskId?: string;
  planNodeId?: string;
  parentNodeId?: string;
  autoPreflight?: boolean;
  allowShared?: boolean;
  wait?: boolean;
  waitSeconds?: number;
  overrides?: {
    model?: string;
    reasoningEffort?: string;
    timeoutSeconds?: number;
    [field: string]: unknown;
  };
  agentTeams?: boolean;
}

export interface DelegatePlanNode {
  nodeId: string;
  parentNodeId: string | null;
  title: string;
  goalDescription?: string;
  sourcePath: string | null;
  sourcePathDigest: string | null;
  connectionId: string;
  sequence: number;
  createdAt: number;
  updatedAt: number;
  hostAcceptance: {
    accepted: boolean;
    state: 'accepted' | 'changes-requested';
    decision: 'accepted' | 'changes-requested';
    acceptedAt: number;
    by: 'commander';
    note: string;
    noteChars: number;
    completionSummary?: string;
  } | null;
  reviewHistory?: Array<{
    accepted: boolean;
    state: 'accepted' | 'changes-requested';
    decision: 'accepted' | 'changes-requested';
    acceptedAt: number;
    by: 'commander';
    note: string;
    noteChars: number;
    completionSummary?: string;
  }>;
}

export interface DelegatePlanRequest {
  action: 'create' | 'update' | 'review' | 'get' | 'list';
  nodeId?: string;
  parentNodeId?: string;
  workspacePath?: string;
  title?: string;
  goalDescription?: string;
  decision?: 'accepted' | 'changes-requested';
  note?: string;
  completionSummary?: string;
  nodes?: Array<{
    key?: string;
    parentKey?: string;
    parentNodeId?: string;
    title: string;
    goalDescription?: string;
    workspacePath?: string;
  }>;
}

/**
 * One pending per-call permission request, as the task view publishes it.
 *
 * Every field is redacted at construction time: `arguments` is a bounded JSON
 * rendering whose string values have passed through the plugin's own redaction,
 * and `reason` is the WORKER's own claim about why it asks — never the operation
 * being decided.
 */
export interface DelegatePendingPermission {
  /** Non-reusable identity of this request. */
  requestId: string;
  taskId: string;
  sessionId: string | null;
  /** The tool whose call is paused. */
  toolName: string;
  /** The exact native tool-call id the decision is bound to. */
  callId: string;
  turn: number | null;
  step: number | null;
  tool: { name: string; callId: string };
  /** `pending` while the call waits; a settled request leaves the pending slot. */
  state: 'pending' | 'decided' | 'expired' | 'cancelled' | 'unavailable';
  /** The worker's own one-line justification. Evidence, not the operation. */
  reason: string | null;
  reasonSource: 'asker-claim';
  /** The access the REAL arguments ask for. */
  requestedAccess: { kind: string; mode: string | null };
  argumentKeys: string[];
  /** Redacted, bounded JSON of the real tool arguments. */
  arguments: string | null;
  argumentsRedacted: true;
  /**
   * Whether the published operation is the WHOLE operation. An `allow-once`
   * decision is refused when this is not `complete`, because an allow must not grant
   * a call whose executable material (a command tail, a write body) was cut by a
   * bound. `reject` is unaffected.
   */
  completeness: 'complete' | 'truncated' | 'unbounded';
  argumentsComplete: boolean;
  /** Which bounds fired, e.g. `value`, `key`, `depth`, `item`. */
  boundsApplied: string[];
  omitted: { valueChars: number; keys: number; depth: number; items: number };
  /** Why an `allow-once` would be refused, or `null` when an allow is decidable. */
  allowBlocked: string | null;
  /** Exact fingerprint of the real arguments; REQUIRED by `allow-once`. */
  fingerprint: string;
  createdAt: number;
  /** Fixed bound: the wait never outlives this (default 10 minutes). */
  deadlineAt: number;
  decision: 'allow-once' | 'reject' | null;
  decidedAt: number | null;
  decidedBy: 'commander' | 'commander-task-command' | 'deadline' | 'asker' | 'stop' | 'binding' | 'restart' | null;
  decisionReason: string | null;
  /** Closed native outcome: `allowed-once` is the only grant. */
  outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | null;
  /** Present only for an `allowed-once`: which checks the grant actually passed. */
  verified?: {
    fingerprintQuoted: boolean;
    argumentsComplete: boolean;
    callReread: boolean;
    turnOpen: boolean;
    /** Effective scope. `task-command` can appear in historical preview receipts. */
    scope?: 'once' | 'task-command';
    reusedFromRequestId?: string;
    boundsApplied: string[];
  } | null;
  /** Present only for an `allowed-once`; states that it covers one call. */
  grant: { kind: 'allowed-once'; appliesTo: 'this-call-only'; callId: string; reusable: false } | null;
  /** Always true: a decision never changes the Session's standing mode. */
  standingModeUnchanged: true;
  /** Present after a commander rejection; delivery is independent of the rejection outcome. */
  rejectionFeedback?: { delivered: boolean; reason: string | null; text?: string } | null;
}

/** The per-call permission block every task view carries. */
export interface DelegateTaskPermission {
  /** Whether this run was offered a bridge at all. */
  bridged: boolean;
  /** Whether a request is outstanding right now. */
  waiting: boolean;
  pending: DelegatePendingPermission | null;
  /** Bounded settled trail, oldest first. */
  evidence: DelegatePendingPermission[];
  /** Time the run spent waiting, which was NOT charged to the execution budget. */
  pausedExecutionMs: number;
  /** The standing sandbox mode, which no decision changes. */
  standingSandboxMode: 'workspace-write';
  /** Stated so no reader can mistake a decision for a standing grant. */
  grantScope: 'single-call';
  /**
   * Present in a STORED record only: the process stopped while this request was
   * pending, so it was rewritten as history and can never be decided or replayed.
   */
  interrupted?: true;
}

/**
 * One option a question offers.
 */
export interface DelegateQuestionOption {
  /** The label an answer selects. */
  label: string;
  /** Optional extra context for the option. */
  description: string | null;
}

/**
 * One question a delegated worker asked, as the task view publishes it.
 *
 * Nothing here is model output: these are the questions the worker composed with the
 * native `ask_user_question` tool. No reasoning, transcript or tool argument has a field.
 */
export interface DelegateQuestion {
  /** Stable caller-provided id, echoed in the answer. */
  id: string;
  /** The question text. */
  question: string;
  /** Optional short heading. */
  header: string | null;
  /** Optional supporting detail, kept out of the option labels. */
  detail: string | null;
  /** Choices the question offered; empty when it expects free text. */
  options: DelegateQuestionOption[];
  /** Whether more than one option may be selected. */
  multiSelect: boolean;
  /**
   * The caller's presentation intent, when it declared one.
   *
   * `'approval'` questions are REFUSED on this channel: a permission decision belongs to
   * `delegate_permission_decide`, which binds one exact tool call. `'plan-review'` is an
   * information answer and grants nothing either.
   */
  intent: 'plan-review' | 'approval' | null;
}

/** One pending ordinary question set. */
export interface DelegatePendingQuestion {
  requestId: string;
  taskId: string;
  sessionId: string | null;
  /** The native tool call the question is keyed by, when the harness supplied one. */
  callId: string | null;
  state: 'pending' | 'answered' | 'expired' | 'cancelled' | 'refused';
  createdAt: number;
  /** Finite absolute deadline; defaults to ten minutes after the question was published. */
  deadlineAt: number;
  questions: DelegateQuestion[];
  /** An omitted question must never be answered using partial text. */
  questionsOmitted?: boolean;
  questionAnswerable?: boolean;
  questionCount?: number;
  /** Always `false`: answering a question never grants access. */
  grantsAccess: false;
}

/** One answer the commander gave. */
export interface DelegateQuestionAnswerItem {
  id: string;
  /** Labels this question actually offered. */
  selected: string[];
  /** Optional free text; required when the question offered no options. */
  custom?: string;
}

/** The ordinary-question block every task view carries. */
export interface DelegateTaskQuestion {
  /** Whether this run was offered a question bridge at all. */
  bridged: boolean;
  /** Whether a question is outstanding right now. */
  waiting: boolean;
  pending: DelegatePendingQuestion | null;
  /** Bounded settled trail, oldest first. */
  evidence: {
    requestId: string;
    taskId: string;
    callId: string | null;
    state: string;
    questions: { id: string; question: string }[];
    answers: DelegateQuestionAnswerItem[] | null;
    reason: string | null;
    createdAt: number;
    settledAt: number | null;
    answeredAt: number | null;
  }[];
  /** Time the run spent waiting for an answer, NOT charged to the execution budget. */
  pausedExecutionMs: number;
  /** Always `false`, stated so no reader mistakes a question answer for a grant. */
  grantsAccess: false;
}

/**
 * The receipt of ONE question answer.
 *
 * `applied: true` is claimed only when the route confirmed the SAME task and request.
 * `applied: null` with `confirmation: "unknown"` means nothing was established — read the
 * task before answering again, and never resend automatically.
 */
export interface DelegateAnswerReceipt {
  receiptId: string;
  taskId: string | null;
  requestId: string | null;
  answers?: DelegateQuestionAnswerItem[];
  answersOmitted?: true;
  answerCount?: number;
  evidenceOmitted?: true;
  applied: boolean | null;
  confirmation: 'confirmed' | 'unknown' | 'refused';
  /** Always `false`: an answer is not an authorization. */
  grantsAccess: false;
  reason?: string | null;
}

/**
 * Bounded activity metadata for one task.
 *
 * Every field is a count, a timestamp or an identifier. Model text, reasoning,
 * tool arguments and tool results have no field here: the monitor that produces
 * this summary never retains them, so no projection of it can leak them.
 */
export interface DelegateTaskActivity {
  /** Clock time of the last genuine progress, or `null` before any. */
  lastActivityAt: number | null;
  /**
   * The true silence span. It is never substituted with a tool's elapsed time: an
   * open tool call that emits nothing is still silence, which is why a hung tool
   * reaches the attention threshold like any other silent executor.
   */
  idleForMs: number | null;
  /** Whether the run is silent between model turns or executing a tool. */
  waitingOn: 'idle' | 'tool' | null;
  /** The native tool call in flight, bounded to its identifiers. */
  currentTool: { name: string | null; callId: string | null; startedAt: number; elapsedMs: number } | null;
  /** The most recent tool call and how long it took. */
  lastTool: { name: string | null; durationMs: number | null } | null;
  /** Total events observed, and how many of them were genuine progress. */
  events: number;
  activityEvents: number;
  toolCallsStarted: number;
  toolCallsFinished: number;
  /** The thresholds this task froze at admission. */
  selfCheckSeconds: number;
  attentionSeconds: number;
  /**
   * The repeated-failure reminder: how many consecutive identical tool failures are
   * reported once (`0` = off), and the bounded trail of episodes already reported.
   *
   * Optional and nullable: a record stored by an older build has no such field, and
   * `repeatFailureOf` projects one as `null`, so a stored history row may omit it.
   */
  repeatFailure?: {
    threshold: number;
    reported: DelegateRepeatedFailure[];
  } | null;
  /**
   * `null` while the run is live. Once the task ended it holds the recorded end, and
   * every elapsed value above is measured against it — a stored or queried record
   * therefore does not keep growing.
   */
  finalizedAt: number | null;
  /** The last self-check verdict, which explains a silent run. */
  selfCheck: { episode: number | null; checkedAt: number | null; verdict: string | null } | null;
  /** Counts per event kind, bounded. */
  kinds: Record<string, number>;
  /** Present only in a STORED record: the run did not survive a restart. */
  interrupted?: true;
  /** Present only in a STORED record: the tool that was cut off by the restart. */
  interruptedTool?: { name: string | null; callId: string | null; startedAt: number | null; elapsedMs: number | null } | null;
}

/**
 * One reported repeated-failure episode.
 *
 * Only identifiers, a digest and counts: the native tool arguments, the result content,
 * the error's free text and any model output are never retained, so nothing here can
 * carry them.
 */
export interface DelegateRepeatedFailure {
  /** Fixed discriminator, so a client can tell this apart from a silence report. */
  kind: 'repeated-tool-failure';
  /**
   * The stable identity of THIS notification: 16 hex chars digesting the episode's
   * own hashed identity under a per-monitor 16-byte random nonce — never the raw
   * arguments or error prose. The reminder is redelivered with the SAME eventId
   * until the receiver acknowledges it by this id, so a lost answer is recoverable
   * and one repeated failure is one notification; two tasks failing identically at
   * the same instant never share an identity.
   */
  eventId: string;
  /** The native tool name. */
  toolName: string;
  /**
   * A recognized common tool failure code (for example `ENOENT`, `EACCES`, `TIMEOUT`), or
   * `TOOL_ERROR` for anything this build does not positively recognize. An arbitrary
   * `error.code`/`error.name` is never echoed: it is free text that can carry a path or a
   * token.
   */
  failureCode: string;
  /** 16-hex digest of the operation, never the operation itself. */
  operationDigest: string;
  /** How many identical failures were counted when the reminder fired. */
  consecutive: number;
  /** The threshold in force for this task. */
  threshold: number;
  /**
   * When the FIRST failure of this episode happened, not when the threshold was reached:
   * the episode is older than the reminder.
   */
  firstSeenAt: number;
  /** When the failure that completed the threshold happened. */
  lastSeenAt: number;
}

/** Why one observation of a running task returned. */
export type DelegateObserveReason =
  | 'heartbeat'
  | 'attention'
  | 'permission'
  /**
   * The worker asked an ordinary question and is paused until it is answered.
   *
   * Reported IMMEDIATELY, not after a silence threshold, and it grants nothing: any
   * widening still needs its own `permission` request.
   */
  | 'question'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** Compact task summary one observation returns (carries summary length/omission flag, no prose). */
export interface DelegateObservationSummary {
  taskId: string;
  state: 'pending' | 'running' | 'awaiting-host-review' | 'failed' | 'cancelled' | 'interrupted';
  phase: string;
  createdAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  elapsedMs: number;
  lastActivityAt: number | null;
  currentTool: DelegateTaskActivity['currentTool'];
  idleForMs: number | null;
  waitingOn: DelegateTaskActivity['waitingOn'];
  activity: DelegateTaskActivity | null;
  selfCheck: { episode: number | null; checkedAt: number | null; verdict: string | null } | null;
  /** The route this task froze at admission, never a re-resolved one. */
  route: {
    providerId: string | null;
    providerRoute: string | null;
    model: string | null;
    reasoningEffort: string | null;
    isolation: string | null;
    monitoring: {
      selfCheckSeconds: number | null;
      attentionSeconds: number | null;
      repeatFailureThreshold: number | null;
    };
  } | null;
  connectionId: string | null;
  /** Always false: execution completion is not host acceptance. */
  selfApproved: false;
  /**
   * The commander's DSH Agent Teams decision frozen on the task at admission
   * (`true`/`false`), or `null` when they made no choice (the Session keeps its own
   * mode). This is the REQUEST, never the applied state — read `team` for that.
   */
  agentTeams: boolean | null;
  /** What DSH's own Agent Teams service confirmed for the run, or `null` when unasked. */
  team: DelegateAgentTeamsOutcome | null;
  /** The commander's recorded delivery review, or null while none exists. */
  hostAcceptance: DelegateCompactHostAcceptance | null;
  reviewPersistence: DelegateReviewPersistence;
}

/**
 * The outcome of one run's Agent Teams selection.
 *
 * DSH owns the switch: the run's own root Session stores `team/mode`, the same selection
 * the model menu's「Use Agent Teams」control writes. `requested` is what the dispatcher
 * asked for, `applied` is what the service CONFIRMED by reading the saved selection back,
 * and `reason` explains every non-application (`not-requested`,
 * `agent-teams-unavailable`, `agent-teams-failed: …`, `agent-teams-unconfirmed`,
 * `agent-teams-mismatch: …`, `aborted`) so an operator can tell "asked and on" from
 * "asked and could not be applied".
 */
export interface DelegateAgentTeamsOutcome {
  requested: boolean | null;
  /** Whether this harness composed the Agent Teams service at all. */
  supported: boolean;
  /** True only after the service's own read-back agreed with the request. */
  applied: boolean;
  /** The selection the Session reports, or `null` when it could not be read. */
  enabled: boolean | null;
  reason: string | null;
}

/**
 * A replayed (idempotent) review request and its answer.
 *
 * `decision` is the closed vocabulary the review verb accepts; a note is required and
 * bounded. Repeating the same decision with the same note — and the same optional
 * completion summary — is a no-op; a different conclusion is refused.
 */
export interface DelegateReviewRequest {
  taskId: string;
  decision: 'accepted' | 'changes-requested';
  /** Required after trimming; at most 8000 Unicode code points; stored redacted. */
  note: string;
  /** Optional completion summary (<= 2000 code points, redacted, part of review identity). */
  completionSummary?: string;
  /** Optional (only valid with `accepted`): safely sync an isolated worktree back to `sourcePath` without committing. */
  applyToSource?: boolean;
  /** Optional: return only `taskId`, `reviewPersistence`, and optional `sourceSync`. */
  receiptOnly?: boolean;
}

/** Bounded receipt describing optional post-acceptance worktree-to-source synchronization. */
export interface DelegateSourceSyncResult {
  applied: boolean;
  reason: string;
  changedFiles: string[];
  changedFilesTotal?: number;
  changedFilesTruncated?: boolean;
  conflictingPaths: string[];
  conflictingPathsTotal?: number;
  error?: string;
}

/** Answer of one recorded delivery review. */
export interface DelegateReviewResult {
  /**
   * The public task view after the decision. Its `state` stays `awaiting-host-review`
   * (that is the compatible underlying state); the conclusion is `hostAcceptance`.
   */
  task: {
    taskId: string;
    state: string;
    phase: string;
    hostAcceptance: DelegateHostAcceptance | null;
    reviewPersistence: DelegateReviewPersistence;
  };
  /** Null until persistence is confirmed; a timed-out write may still finish. */
  hostAcceptance: DelegateHostAcceptance | null;
  reviewPersistence: DelegateReviewPersistence;
  /** Present only when `applyToSource: true` was requested on an `accepted` review. */
  sourceSync?: DelegateSourceSyncResult;
}

/** Persistence state is separate from execution and from a proposed conclusion. */
export interface DelegateReviewPersistence {
  state: 'none' | 'saving' | 'timed-out' | 'saved' | 'failed';
  decision: 'accepted' | 'changes-requested' | null;
  accepted: boolean;
  durable: boolean;
  pending: boolean;
  startedAt: number | null;
  confirmedAt: number | null;
  retryable: boolean;
  error: { code: string; message: string } | null;
}

/** Wait/compact review projection: carries lengths and omission flags, never prose bodies. */
export interface DelegateCompactHostAcceptance extends Omit<DelegateHostAcceptance, 'note' | 'completionSummary'> {
  noteChars: number;
  noteOmitted: true;
  completionSummaryChars?: number;
  completionSummaryOmitted?: true;
}

/** Bounded review projection where `note` is paged out while a legal `completionSummary` stays whole unless omitted. */
export interface DelegateOmittedHostAcceptance extends Omit<DelegateHostAcceptance, 'note' | 'completionSummary'> {
  noteChars: number;
  noteOmitted: true;
  completionSummary?: string;
  completionSummaryChars?: number;
  completionSummaryOmitted?: true;
}

/** Optional paged note read on delegate_result; omit offset for the old result shape. */
export interface DelegateReviewNotePageRequest {
  taskId: string;
  /** Nonnegative Unicode code-point offset. */
  reviewNoteOffset: number;
  /** Integer from 1 to 2000, default 2000. Requires reviewNoteOffset. */
  reviewNoteLimit?: number;
}

export interface DelegateReviewNotePageResult {
  ok: true;
  taskId: string;
  state: string | null;
  reviewNote: {
    offset: number;
    limit: number;
    text: string;
    noteChars: number;
    nextOffset: number | null;
    complete: boolean;
    present: boolean;
  };
  hostAcceptance: DelegateCompactHostAcceptance | null;
  reviewPersistence: DelegateReviewPersistence | null;
}

/** Optional paged completion-summary read on delegate_result when completionSummaryOmitted is true. */
export interface DelegateCompletionSummaryPageRequest {
  taskId: string;
  /** Nonnegative Unicode code-point offset. */
  completionSummaryOffset: number;
  /** Integer from 1 to 2000, default 2000. Requires completionSummaryOffset. */
  completionSummaryLimit?: number;
}

export interface DelegateCompletionSummaryPageResult {
  ok: true;
  taskId: string;
  state: string | null;
  completionSummary: {
    offset: number;
    limit: number;
    text: string;
    summaryChars: number;
    nextOffset: number | null;
    complete: boolean;
    present: boolean;
  };
  hostAcceptance: DelegateCompactHostAcceptance | null;
  reviewPersistence: DelegateReviewPersistence | null;
}

/**
 * The commander's recorded delivery review of one finished task.
 *
 * This is the ONLY record that turns "execution finished" into a host conclusion. It is
 * written by the review verb, never derived from a task's state, and the first decision is
 * final for that task.
 */
export interface DelegateHostAcceptance {
  /** True only when the recorded decision was `accepted`. */
  accepted: boolean;
  /** The recorded conclusion. */
  state: 'accepted' | 'changes-requested';
  /** When the decision was recorded, in epoch milliseconds. */
  acceptedAt: number;
  /** Fixed marker for who recorded it; never a caller-supplied name. */
  by: string;
  /** The redacted, bounded conclusion. */
  note: string;
  /** Optional redacted summary recorded with `note` (absent when omitted; never implies acceptance). */
  completionSummary?: string;
}

/**
 * The receipt of ONE per-call permission decision.
 *
 * `applied` is the only field that answers "did this take effect", and it is deliberately
 * three-valued: `null` with `confirmation: 'unknown'` means the decision could not be
 * confirmed — the call failed before the harness answered, OR the answer lacked the identity
 * and outcome evidence, OR it CONTRADICTED the request that was decided. Such a decision must
 * never be resent without reading the task's real state first.
 *
 * `applied: true` is claimed ONLY from a permission answer that names the SAME task, the SAME
 * request and the SAME operation fingerprint the decision was bound to, reports a settled
 * `state`, and carries the outcome this decision asked for (`allowed-once` for an allow,
 * `rejected` for a reject). An allow additionally needs its `verified` evidence; a reject
 * needs none. The quoted fingerprint is never replaced by a conflicting backend value.
 */
export interface DelegateDecisionReceipt {
  taskId: string | null;
  requestId: string | null;
  decision: 'allow-once' | 'reject' | null;
  /** The exact operation the decision was bound to; `null` when none could be proven. */
  fingerprint: string | null;
  /** `true` only for a confirmed decision; `false` for a harness refusal; `null` if unknown. */
  applied: boolean | null;
  confirmation: 'applied' | 'unknown' | 'refused';
  /** The closed native outcome, when the harness reported one. */
  outcome?: DelegatePendingPermission['outcome'];
  /** Which checks an `allowed-once` actually passed. Absent for a reject. */
  verified?: DelegatePendingPermission['verified'];
  decidedAt?: number;
  grant?: DelegatePendingPermission['grant'];
  /** Whether the rejection reason reached the executor; the note itself is not repeated. */
  rejectionFeedback?: { delivered: boolean; reason: string | null } | null;
  /** Why the decision is not confirmed. Present only when `confirmation` is not `applied`. */
  reason?: string;
  /**
   * The contradicting evidence, when the answer disagreed with what was decided. Present only
   * for an `unknown` outcome, and bounded.
   */
  evidence?: Record<string, unknown>;
  /** Present only when a bound forced the bulky evidence out of a rescued receipt. */
  evidenceOmitted?: true;
  /** Present only for an unconfirmed decision: the failure that prevented confirmation. */
  error?: { code: string; message: string };
}

/**
 * The answer of `delegate_permission_decide({ waitAfterDecision: true })`.
 *
 * It is the SAME flat shape {@link DelegateObservation} publishes for a wait — a plain
 * `delegate_wait` answer plus `decisionReceipt` — so a host reads one vocabulary for both.
 * There is no nested follow-up block: the top-level `permission` is the live pending
 * operation, and `boundedJson` keeps it (and the receipt) even when the answer must be cut.
 *
 * When the decision WAS applied but the following wait failed, was interrupted or was
 * cancelled, this is still a SUCCESS carrying `decisionReceipt` (`applied: true`) plus
 * `reason: null`, `actionable: false` and a `waitError` block: the decision stands, only the
 * waiting ended, and the execution was not stopped. The receipt is never swallowed.
 */
export interface DelegateDecisionWithWait extends DelegateObservation {
  decisionReceipt: DelegateDecisionReceipt;
  /** Present only when the applied decision's follow-up wait ended in a refusal. */
  waitError?: { code: string; message: string; phase: 'follow-up-wait' };
}

/**
 * The refusal of a decision whose outcome nobody established or confirmed.
 *
 * `applied` is `null`, `confirmation` is `'unknown'`, and the caller must read the task with
 * `delegate_result` before deciding whether to send the decision again. Nothing is retried
 * automatically and no wait is started.
 */
export interface DelegateUnconfirmedDecisionFacts {
  decisionReceipt: DelegateDecisionReceipt;
}

/**
 * One bounded accounting census of an MCP process.
 *
 * These are counts of the PROGRAM — the tool calls a host made and the waits it ran — never
 * of the host model. The host's own turns, token usage and cost are not observable from this
 * process and are reported as `'not-integrated'`, never as zero.
 */
export interface DelegateMcpMetrics {
  schemaVersion: 1;
  definitions: Record<string, string>;
  hostObservability: {
    hostModelResponses: 'not-integrated';
    hostTokenUsage: 'not-integrated';
    hostCost: 'not-integrated';
    reason: string;
  };
  tools: Record<string, number>;
  returnedText: {
    count: number;
    /** UTF-8 bytes of the final bounded, redacted tool text. Not a delivery receipt. */
    bytes: number;
    /** Returns whose size could not be measured (no text, or unencodable). */
    unmeasured: number;
    unit: 'utf8-bytes-of-serialized-tool-text';
  };
  waits: {
    count: number;
    totalMs: number;
    observations: number;
    reasons: Record<string, number>;
  };
  decisions: {
    count: number;
    applied: number;
    unknown: number;
    refused: number;
    allowed: number;
    rejected: number;
  };
  questionAnswers: { count: number; applied: number; unknown: number; refused: number };
  correlation: {
    waitsAfterDecisions: number;
    waitQuestionsAnswered: number;
    recentWaits: Array<{
      waitId: string | null;
      afterDecisionId: string | null;
      taskId: string | null;
      reason: string;
      durationMs: number;
      observationRequests: number;
      heartbeatsConsumed: number;
      settledRequestObservations: number;
      waitReturns: number;
      at: number;
    }>;
    recentDecisions: Array<{
      receiptId: string | null;
      taskId: string | null;
      requestId: string | null;
      decision: 'allow-once' | 'reject' | 'question-answer' | null;
      fingerprint: string | null;
      /**
       * The same three-valued fact the permission receipt publishes: `true` for `applied`,
       * `false` for `refused`, `null` for `unknown`. An unconfirmed attempt is `null`, never
       * `false`, so a reader cannot mistake it for an established refusal.
       */
      applied: boolean | null;
      state: 'applied' | 'unknown' | 'refused';
      at: number;
    }>;
  };
}

/** Result of one bounded observation of a delegated task. */
export interface DelegateObservation {
  task: DelegateObservationSummary;
  reason: DelegateObserveReason;
  /**
   * The FULL redacted pending request, present only for `reason: 'permission'`.
   * Carries the exact fingerprint and completeness facts a decision needs; it is
   * never shortened into an undecidable summary.
   */
  permission: DelegatePendingPermission | null;
  /**
   * The FULL pending question set, present only for `reason: 'question'`.
   *
   * Carries the questions, their options, and the identity an answer is bound to, so one
   * reply is enough to answer — exactly like the permission block. It never carries
   * model text.
   */
  question: DelegatePendingQuestion | null;
  /** Present only on a `question` answer: derived from the operation as published. */
  questionAnswerable?: boolean;
  /** Present only on a `question` answer: always `false`, restated where it matters. */
  grantsAccess?: false;
  /**
   * Present only when `reason` is `attention` AND the reminder is about repeated
   * failures rather than silence. `null`/absent for an ordinary silence report, which
   * keeps the two distinguishable without a new reason value.
   */
  failure?: DelegateRepeatedFailure | null;
  /**
   * Present only when the caller asked to acknowledge one delivered reminder by its
   * `eventId` (an `ackFailureEventId` on the observe/wait call). `acknowledged` is
   * `true` when the exact pending event was cleared (or had already been cleared by
   * an idempotent repeat); `false` with a `reason` (`unknown-event`, `superseded`,
   * `no-pending`, `event-id-required`) when nothing was cleared — a wrong ack never
   * silences a live reminder.
   */
  /**
   * Present only when the caller asked to acknowledge one delivered reminder by its
   * `eventId` (an `ackFailureEventId` on the observe/wait call). `acknowledged` is
   * `true` when the exact pending event was cleared (or had already been cleared by
   * an idempotent repeat); `false` with a `reason` (`unknown-event`, `superseded`,
   * `no-pending`, `event-id-required`) when nothing was cleared — a wrong ack never
   * silences a live reminder, and an empty id is refused, not ignored. The FIRST
   * verdict reported on a wait is frozen for that call: later observations do not
   * overwrite it with an `unknown-event` from a disposed monitor or a settled task.
   */
  failureAck?: {
    acknowledged: boolean;
    eventId: string | null;
    reason: string | null;
  };
  activity: DelegateTaskActivity | null;
  selfCheck: { episode: number | null; checkedAt: number | null; verdict: string | null } | null;
  /**
   * The wait that produced this result. `activitySinceWait` reports that the run
   * moved during the wait; it is NOT a reason to wake the host, so such an
   * observation still ends as `heartbeat` unless a threshold or an outcome says
   * otherwise.
   */
  wait: { waitMs: number; waitedMs: number; activitySinceWait: boolean };
}

/**
 * Mount the delegation service.
 *
 * After this resolves the plugin holds no grant, owns no agent, and refuses to
 * dispatch work until an operator authorizes a connection through the
 * authenticated user plane.
 * @param ctx - Cordis plugin context.
 * @param config - plugin config.
 */
export declare function apply(ctx: unknown, config?: { dataDir?: string }): Promise<void>;

/** Whole-configuration connectivity report; one entry per configured provider. */
export declare function checkConnectivity(deps: DelegateRuntimeDeps): Promise<DelegateConnectivityReport>;

/** Resolve and validate one explicit selection against the native LLM service. */
export declare function resolveRoute(
  deps: DelegateRuntimeDeps,
  selection: DelegateSelection,
  options?: DelegateRouteOptions,
): Promise<DelegateResolvedRoute>;

/** Describe each provider's available models, with per-provider status. */
export declare function describeCatalog(
  deps: DelegateRuntimeDeps,
  providers: DelegateProviderProfile[],
  options?: DelegateRouteOptions,
): Promise<DelegateCatalogEntry[]>;
