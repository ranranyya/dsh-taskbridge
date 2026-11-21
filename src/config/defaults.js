// Plugin-owned configuration constants and defaults.
//
// dsh-delegate owns exactly one namespace and one document. Delegation is
// disabled on a fresh install; the operator controls it with one persisted
// switch in the authenticated DSH settings page.

/** Persisted document format version. Unknown versions are refused, never migrated silently. */
export const SCHEMA_VERSION = 1;

/** Settings document file name inside the plugin data directory. */
export const SETTINGS_FILE = 'settings.json';

/** Bounded job history file name inside the plugin data directory. */
export const HISTORY_FILE = 'jobs.json';

/** Provider wire protocols this stage actually supports. */
export const SUPPORTED_PROTOCOLS = Object.freeze(['openai-chat']);

/**
 * Workspace isolation modes, strongest first.
 *
 * `worktree` is the default: a mutation runs in a disposable git worktree so the
 * operator's checkout is untouched. It requires a committed repository, and this
 * stage refuses it rather than downgrading (see `src/jobs/engine.js`). `shared`
 * therefore has to be *chosen* by the operator — it is never a silent fallback.
 */
export const ISOLATION_MODES = Object.freeze(['worktree', 'shared']);

/** Isolation mode stored when a document does not name one. */
export const DEFAULT_ISOLATION = 'worktree';

/**
 * The retired directory-level conversation mode, kept only as accepted input.
 *
 * A stored settings document may still say `conversation.mode: "reuse"` from an
 * earlier build that let an operator make every run in a directory continue the
 * previous one. That setting is GONE: a new submission always starts a new DSH
 * conversation, and a follow-up continues only the task thread named by
 * `continueFromTaskId`. The value is still tolerated on read so an existing
 * document keeps loading, and it is incapable of causing a reuse because no code
 * path consults it. {@link LEGACY_CONVERSATION_MODES} is the complete set of
 * values a document may still carry.
 */
export const LEGACY_CONVERSATION_MODE = 'reuse';

/** Every conversation-mode value a stored document may still carry. */
export const LEGACY_CONVERSATION_MODES = Object.freeze(['new', LEGACY_CONVERSATION_MODE]);

/**
 * Session/task-thread identity map file name inside the plugin data directory.
 *
 * Holds only `task id -> { source/execution path, DSH Workspace id, DSH Session id,
 * isolation, worktree ownership facts }`, so an explicit `continueFromTaskId`
 * follow-up can ask the harness to resume THAT task's conversation in the same
 * execution path it ran in. No transcript, prompt, output, credential or usage
 * figure is stored here: the native session log remains the single owner of
 * conversation content.
 */
export const SESSIONS_FILE = 'sessions.json';

/** Hard bounds. Exceeding any of these is a validation error, not a clamp. */
export const LIMITS = Object.freeze({
  providers: 32,
  manualModelsPerProvider: 128,
  presets: 32,
  /**
   * Bounds on the LEGACY `worker.timeoutSeconds`.
   *
   * The field is no longer offered in the settings page and no longer bounds a
   * normal run: an ordinary delegated task has no total execution deadline, only
   * the explicit per-job override documented in `validateJobOverrides`. The bounds
   * survive because a stored document (or an older client) may still carry the
   * value, and a legacy value must keep loading instead of failing the whole
   * document — see `validateWorkerSettings`.
   */
  timeoutSecondsMin: 30,
  timeoutSecondsMax: 2 * 60 * 60,
  maxParallelismMin: 1,
  maxParallelismMax: 8,
  taskGrantTtlSecondsMin: 30,
  taskGrantTtlSecondsMax: 60 * 60,
  sessionGrantTtlSecondsMin: 60,
  sessionGrantTtlSecondsMax: 12 * 60 * 60,
  // Monitoring. The two thresholds are bounded, and the second one must stay
  // strictly greater than the first: two identical thresholds would deliver a
  // self-check and an attention alert for the same instant, which is exactly the
  // noisy behaviour the whole feature exists to remove.
  //
  // `0` is a legal value for EITHER threshold and means "this reminder is off".
  // The minimum is therefore 0 rather than a duration, and the ordering rule is
  // only enforced when both thresholds are actually enabled.
  selfCheckSecondsMin: 0,
  selfCheckSecondsMax: 60 * 60,
  attentionSecondsMin: 0,
  attentionSecondsMax: 2 * 60 * 60,
  // Repeated-failure reminder. `0` disables it, so the minimum is a switch rather
  // than an error; the ceiling keeps a silly value from being indistinguishable from
  // "off" in practice. This is a COUNT, not a duration.
  repeatFailureThresholdMin: 0,
  repeatFailureThresholdMax: 20,
  promptChars: 200_000,
});

/**
 * Default activity-monitoring thresholds, in seconds of *inactivity*.
 *
 * There is exactly ONE time base: consecutive time without real progress. Real progress
 * — model output, a reasoning step, a tool call or a tool result — resets it; a
 * heartbeat, a result poll, the self-check itself and a plain state read do not.
 *
 * Two reminders are measured on that clock, and each can be switched off with `0`:
 *
 *  * `selfCheckSeconds` — one read-only local inspection (default 10 minutes);
 *  * `attentionSeconds` — one notification to the commander asking it to check the
 *    run's progress (default 40 minutes).
 *
 * Neither depends on total runtime, so a task that keeps working for hours produces
 * neither. Nothing here ever ends, cancels or restarts a run: a reminder is a REPORT,
 * never a verdict.
 */
export const MONITORING_DEFAULTS = Object.freeze({
  /** No-progress span after which one read-only local self-check is performed (0 = off). */
  selfCheckSeconds: 10 * 60,
  /**
   * No-progress span after which the wait reports the run progress check (0 = off).
   *
   * This is the ONE notification interval: it doubles as the point at which a host is
   * asked to confirm the goal, so there is no second duration to configure.
   */
  attentionSeconds: 40 * 60,
  /**
   * How many CONSECUTIVE identical tool failures are reported once, or `0` to disable.
   *
   * Independent of the two silence thresholds: a run can be busy and still be failing
   * the same way, which is the case this exists for.
   */
  repeatFailureThreshold: 3,
});

/**
 * The complete set of native reasoning-effort ids this build understands, in
 * canonical order (weakest first).
 *
 * These are *ids the wire protocol accepts*, not a claim that any model supports
 * them. Whether a given model can take one is declared per model in
 * `provider.models[].efforts`, and both validation and routing refuse anything a
 * model has not declared. `off` is a real id meaning "no reasoning", not an
 * absence of a value: a model must declare it explicitly.
 */
export const KNOWN_EFFORTS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Canonical sort index for declared effort ids. */
export const EFFORT_ORDER = Object.freeze(new Map(KNOWN_EFFORTS.map((id, index) => [id, index])));

/**
 * Default for the operator's per-task Agent Teams choice: OFF.
 *
 * This is a TASK-level default, not DSH's global switch. It decides what a NEW
 * submission does when its dispatcher states no per-task choice of its own:
 * `false` writes that one run's Session to "teams off", `true` writes it to
 * "teams on". It is deliberately `false` on a fresh install and on upgrade, so
 * upgrading never silently turns agent collaboration on for every new task.
 *
 * It never touches DSH's global agent-teams setting and never overrides a
 * dispatcher's explicit per-task `agentTeams` value.
 */
export const DEFAULT_AGENT_TEAMS_FOR_NEW_TASKS = false;

/**
 * Default settings document. Delegation is off until the operator enables it.
 */
export function defaultSettings() {
  return {
    schemaVersion: SCHEMA_VERSION,
    delegationEnabled: false,
    providers: [],
    worker: {
      providerId: null,
      model: null,
      reasoningEffort: null,
      // LEGACY, kept so every reader of this document sees one shape. It is no
      // longer offered in the settings page and no longer bounds an ordinary run;
      // `resolveEffectiveConfig` publishes it as `executionTimeoutSeconds`.
      timeoutSeconds: 1800,
      maxParallelism: 1,
      isolation: DEFAULT_ISOLATION,
    },
    // Kept separate from the legacy in-memory connection/grant compatibility
    // layer. New installations use this one switch for MCP dispatch.
    authorization: {
      taskGrantTtlSeconds: 900,
      sessionGrantTtlSeconds: 4 * 60 * 60,
    },
    // The operator's default for NEW tasks only. Absent in documents written
    // before this block existed; validation fills in the OFF default, so schema
    // version 1 stays readable both ways and an upgrade needs no migration and
    // never turns collaboration on by itself.
    execution: {
      agentTeamsDefault: DEFAULT_AGENT_TEAMS_FOR_NEW_TASKS,
    },
    // Silence thresholds for a running task. Absent in documents written before
    // this block existed; validation fills in the defaults, so schema version 1
    // stays readable both ways and an upgraded document needs no migration step.
    monitoring: {
      selfCheckSeconds: MONITORING_DEFAULTS.selfCheckSeconds,
      attentionSeconds: MONITORING_DEFAULTS.attentionSeconds,
    },
    projectOverrides: {},
    // Named, non-secret worker settings. Empty by default, and absent
    // in documents written before presets existed — validation fills it in, so
    // schema version 1 stays readable both ways.
    presets: [],
    // Deprecated and inert. A document that carries `conversation.mode: "reuse"`
    // from an earlier build still loads, but the value is never consulted: a new
    // submission starts a new DSH conversation and a follow-up continues the task
    // thread named by `continueFromTaskId`. It is written as `new` so an upgraded
    // document stops advertising a capability the plugin no longer has.
    conversation: {
      mode: LEGACY_CONVERSATION_MODES[0],
    },
  };
}
