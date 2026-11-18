# Worker session permissions (1.5.4; historical 1.0.0–1.2.0 audits retained)

This document describes the worker sandbox, per-call approval and ordinary-question boundaries. The standing worker sandbox remains `workspace-write`; a question answer never grants access. A single approved operation does not authorize another call.

**1.5.0 acceptance status:** the verified test.2 candidate was installed through native DSH Desktop plugin management. Real provider runs exercised both rejection and a separately approved call, delivery of the rejection reason, native question forwarding, answer-and-wait, and decision-and-wait. An actual Desktop restart retained the source identity, Session and saved host acceptance. A subsequent real-model, twelve-round timing/read-only exercise lasted over twenty minutes with one MCP wait and no intermediate result reads. See [1.5.0 release notes](releases/1.5.0.zh.md).

Historical validation sections below describe their own older builds and do not override this current acceptance statement. These checks do not prove every host/platform combination or turn the same-user loopback switch into per-process authentication.

## The policy

Every delegated worker run drives a DSH session whose policy is fixed by this
plugin before the first prompt is delivered:

| Fact | Value | Event | Read back through |
| --- | --- | --- | --- |
| Sandbox mode | `workspace-write` | `sandbox/mode` | `ctx.sandboxPolicy.resolve({ session })` |
| Approval stance | `never` (no bridge) / `ask` (armed bridge) | `approval/policy` | `ctx.approval.effectivePolicy(session)` |

- **`workspace-write`** means the worker may modify files inside the session's own
  workspace root. Writes outside it are refused by the native sandbox. This value
  is installed for the whole run and **is never widened by a permission decision**:
  nothing here ever writes `danger-full-access` into a Session.
- **`never`** is the stance of every run WITHOUT a permission bridge. It is
  deterministic rejection, not automatic approval: an escalation asked by the
  worker session is refused without reaching any approval answerer.
- **`ask`** is installed for ONE run, and only when that run carries an armed
  permission bridge bound to the Agent it drives (see below). With `ask`, the
  native approval service dispatches the question to the composed answerers, of
  which this run's bridge is one. If the bridge cannot answer (not its request, a
  question already outstanding, a bridge that has been disposed), the question
  still fails closed.

## The per-call permission bridge

This build adds the narrowest possible way for a delegated worker to ask for
wider access **for one call**, and nothing more:

1. A native tool asks for an escalation through `ctx.approval.request(...)`
   (`@deepseek-ai/dsh-sandbox`'s `approveEscalation` is that caller). That tool
   call **pauses** — nothing executes.
2. The request is surfaced through the existing `delegate_result` view as
   `permission.pending`, while the task stays `running` with phase
   `awaiting-permission`. The call's **real arguments** are read from the native
   Session log by matching the request's `callId` to the committed `tool/call`
   event, redacted and bounded. The worker's own `reason` text is carried beside
   them, labelled `reasonSource: "asker-claim"`, and is never treated as the
   operation.
3. The commander answers with the bounded MCP tool `delegate_permission_decide`:
   `allow-once` or `reject`, optionally quoting the request's `fingerprint`.
4. `allow-once` resumes **that one call** with the native `allowed-once` outcome.
   The next escalation asks again. `reject` keeps the call denied.

What the bridge cannot do, stated as the contract:

- it cannot create a request; with nothing pending the tool refuses;
- it cannot create or widen any account, workspace or session grant, change
  settings, credentials, the local-call switch, the provider/model, the reasoning
  effort or the isolation;
- it cannot pre-approve a future operation: the request is single-use, bound to a
  non-reusable request id, one task, one Session, one `callId` and an exact
  fingerprint of the real arguments;
- it is not an automatic allow-all rule, an LLM/API reviewer, or a human-click
  workflow. There is no second model in the loop and no required click;
- it is **not part of the native worker's preset tool surface**, so the worker's model
  is never handed it. That is a *tool-surface restriction*, and it is the only claim
  made here: it is **not** a hard boundary against arbitrary code running as the same
  OS user. Switch mode deliberately uses one shared `local-mcp` connection identity and
  issues no user-managed token, so a local process can present itself as the commander.
  Nothing in this contract depends on a caller-supplied role label.

## What a decision actually requires (and what it never grants)

An `allow-once` is accepted only when ALL of these hold at the moment of the decision:

| Check | Refusal if it fails |
| --- | --- |
| the decision names the request's exact `fingerprint` | `PERMISSION_DECISION_INVALID` |
| the published operation was **complete** — no bound fired | `PERMISSION_EVIDENCE_INCOMPLETE` |
| the recorded `tool/call` is re-read at its stored offset and is byte-identical | `PERMISSION_REQUEST_CHANGED` |
| the turn that asked for the call has not ended | `PERMISSION_REQUEST_CHANGED` |
| the request is still pending and inside its deadline | `PERMISSION_REQUEST_NOT_PENDING` / `PERMISSION_REQUEST_EXPIRED` |

A projection that was shortened by a bound (a `bash.command` whose tail was cut, a
large `write` body) is reported as `permission.pending.completeness: "truncated"` and
**cannot be allowed** — an allow would grant a call whose executable material the
commander never saw. `reject` needs no fingerprint and no completeness, because refusing
is always safe.

### The evidence bounds are sized from real commands

| Bound | Value | What it holds |
| --- | --- | --- |
| one redacted argument scalar (`argumentValueChars`) | 8 192 | a complete PowerShell/`bash` command, including a long Windows path |
| the whole redacted argument object (`argumentsChars`) | 16 384 | that command plus its other fields (`sandbox_permissions`, `justification`, …) |
| `McpPermissionRequest.arguments` at the MCP layer | the engine's own `argumentsChars` | the published operation, never a smaller second cap |

They are finite, and the rule above is what makes them safe: a request past either cap is
still cut, still says so, and still cannot be allowed. The correction was to the **size**,
not to the gate. Two refusals motivated it:

- the per-scalar cap was 400 characters, so a real Windows path plus a write-back command
  (~403 characters) was cut, marking the request `truncated` and unapprovable — a
  reviewable request was turned into an un-reviewable one;
- the MCP text layer separately capped `permission.pending.arguments` at 4 000 characters,
  *below* the engine's own cap, so an operation the engine published whole could be cut
  again at the last layer before the host saw it and forced back to `argumentsComplete:
  false`.

`tests/permission-evidence-bounds.test.js` pins both: a ~403, ~1000 and ~8000 character
command is published whole and decidable, a command past the cap is cut and refused for
`allow-once`, the fingerprint still covers the complete real arguments, and neither the
MCP projection nor the history projection re-cuts an operation the engine kept whole.

A decision is refused when the request is unknown, already settled, past its
deadline, or carries a fingerprint that does not match the pending operation; and
a task of another connection is answered as absent, so the reply cannot be used to
discover other tasks' pending requests.

## Lifetimes: two separate budgets

The approval wait does **not** consume the worker's execution budget:

| Bound | Value | Whose |
| --- | --- | --- |
| Execution timeout | `worker.timeoutSeconds` | the run |
| Permission request deadline | fixed default **10 minutes**, capped at 30 | the request |

The execution deadline is **really paused**, not merely reported as paused. When a request
arrives the run's timer is disarmed and the elapsed span is charged against the remaining
budget; when the request settles the remaining budget is re-armed. A wait that lasts longer
than the whole remaining budget therefore does **not** time the run out, while a run that
keeps executing afterwards still expires on its remaining budget — and repeated waits
accumulate correctly, because each one charges only the execution it actually consumed. The
task's `permission.pausedExecutionMs` reports the total wait for evidence.

Cancellation, switch-off, revocation, agent disposal, plugin teardown and the request's own
deadline all settle the outstanding waiter with a refusal (`cancelled` for a stop,
`unavailable` for a teardown, `rejected` for the deadline), remove the request's timer and
abort listener, and leave the task to reach its own outcome. While any of that is in
progress the task keeps its workspace lock and concurrency slot, because the native
executor has not confirmed it stopped. A restart begins with no tasks, no bridge and no
request: a stored pending request is rewritten as `unavailable` / `decidedBy: "restart"`
history and can never be replayed or decided as an allow.

## Why it is written *and read back*

Appending the two events is only half the job. DSH folds them through
`ctx.sandboxPolicy` and `ctx.approval`, and those two services are what an enforcing
tool layer consults. A session that merely carries the events, without those services
resolving them, would be *reported* as confined while running unconfined. The plugin
therefore:

1. checks that both services and the session's `append` exist **before writing
   anything**, so a refused run never leaves a half-installed policy behind;
2. appends the two events;
3. reads the policy back through both services and compares the resolved mode, the
   effective approval stance, and the resolved workspace root against the session's
   own directory. The stance compared is the one the bridge's own capability
   justifies: `ask` for an armed bridge bound to this Agent, `never` otherwise.

Any missing service, refused read, or disagreement is a fail-closed refusal raised
**before** the prompt is delivered:

```
RUN_SANDBOX_POLICY_UNAVAILABLE
```

with a bounded `details.reason` naming which capability was missing. The worker run
does not start. There is no fallback to a permissive default and no "retry without
the policy". A bridge that was handed to a run but cannot be armed for the Agent it
would have to answer for is refused separately, before the prompt, as:

```
RUN_PERMISSION_BRIDGE_UNAVAILABLE
```

The comparison of the resolved workspace root with the session header's own
directory reuses the plugin's single canonical-directory identity
(`sameSessionPath` from `src/runtime/session-placement.js`), so a separator, a
trailing slash or a letter case on Windows cannot make one directory be mistaken for
another in either direction.

## Per run, including continuations

The policy is applied on **every** worker run, including a `continueFromTaskId`
follow-up. A resumed thread therefore converges on the current contract instead of
inheriting an older, possibly interactive policy. Nothing here touches the
operator's ordinary DSH sessions: the policy is installed only for a delegated
worker session.

## Ordinary questions: a separate channel that grants nothing

A delegated worker may also ask a HUMAN something with the native `ask_user_question`
tool — an ambiguity it must not resolve itself, a choice it must not invent. That is a
different situation from a permission request, and it gets a different channel.

**The seam.** `ask_user_question` dispatches the Agent-scoped Cordis waterfall
`'user-questions/request'` (`@deepseek-ai/dsh-user-questions`):

```js
ctx.on('user-questions/request', (request, next) => …, { prepend: true })
// request = { questions: [{ id, question, header?, detail?, options?, multiSelect?, intent? }],
//             agent?, signal?, wait?: { callId, timed? } }
// → { answers: [{ id, selected: string[], custom?: string }] }
```

Each run registers its own answerer on its own Agent's scoped context, with
`prepend: true` for the same reason the approval answerer needs it: the waterfall gives
the request to the FIRST answerer that returns a value, and this run exists so the
**commander** sees the question. Without it a UI answerer composed earlier would claim
the request and the commander would never learn the worker was asking — which is exactly
what happened in the acceptance run, where the task sat in `execute` for ten minutes
until the silence threshold.

**What the commander sees, and when.** A pending question makes an observation answer
`reason: 'question'` **immediately** — not after a silence threshold — carrying the whole
`question` block: `requestId`, `taskId`, `sessionId`, `callId` and `questions[]` with each
question's text, options and detail. The task stays `running` with phase
`awaiting-question`, keeps its lock, its concurrency slot and its provider lease, and the
wait is charged to the question's own deadline instead of the execution budget.

The timing matters and is enforced in the MONITOR, not only in the engine: an observation
that is already inside its bounded wait polls for a pending question on every slice, so a
question raised mid-wait returns at once instead of after the 25-second bound. A pending
permission request still outranks a question, because that is the one wait that can grant
something.

**Answering.** `delegate_question_answer({ taskId, requestId, answers })`, or
`POST /dsh-delegate/x/tasks/question` on the execution plane. Each asked question is
answered **exactly once**; every selected label must be one of that question's own
options; a single-select question takes exactly one label (a selection AND custom text
together is legal, matching the native tool); a question with no options needs `custom`
text. A refused batch leaves the question **pending**, so a correct answer can still be
made. An answer applies **once**: a repeat is `QUESTION_ALREADY_ANSWERED`, and an expired
or cancelled question cannot be answered.

**Published whole, or refused.** A question set is accepted only if its EXACT serialised
form — every question, header, detail, option label and description, with all JSON
escapes counted — fits `QUESTION_BOUNDS.wireChars` (12 000, deliberately below the
20 000-character tool-text bound so the block, the task summary and a receipt travel
together). A set that does not fit is refused with `QUESTION_PAYLOAD_TOO_LARGE` **before**
anything is published, so the commander is never shown a shortened menu it could answer
from. The id is used verbatim (no trimming, no generated substitute), a duplicate id or a
duplicate option label is refused, and the id is bounded.

**Bound to a real call, with a finite life.** The answer resumes the paused native call, so
the bridge binds that call: `request.wait.callId` is verified against the Session log (it
must be an `ask_user_question` call in the OPEN turn with no recorded result), and a
legacy request that names none is bound only when the open turn holds exactly one such
call — two candidates are an ambiguity, which is a refusal rather than a guess. The call is
re-checked BEFORE the answer is applied: once it has returned or its turn closed, the answer
is refused with `QUESTION_CALL_GONE` and the set is closed instead of left answerable.

A pending question has its own **finite** deadline — ten minutes by default, capped at
thirty — because it pauses the execution budget. An unanswered question therefore ends with
the native `ASK_TIMED_OUT`; cancellation, switch-off and disposal end it with `ASK_ABORTED`.

**It is not an approval, and it cannot become one.**

- A question whose `intent.kind` is `'approval'` is **refused** here with
  `QUESTION_APPROVAL_INTENT`. A permission decision must go through
  `delegate_permission_decide`, which binds one exact tool call and one fingerprint;
  answering it on the question channel would grant access with none of that.
- A `'plan-review'` question is an information answer: the decision text goes back to the
  worker, and any widening it then wants still needs its own approval.
- The published block states `grantsAccess: false`, so no reader has to infer it.

**Lifecycle.** Cancellation, switch-off, revocation, agent disposal, plugin teardown and
the question's own deadline all settle the outstanding wait with the native refusal
(`ASK_ABORTED` / `ASK_TIMED_OUT`) and release the record, so a paused worker is never left
waiting for a commander that can no longer answer. A restart begins with no bridge and no
question, so an interrupted question is history only and is never replayed as an answer.
A harness without the `userQuestions` seam simply gets no answerer: the native call then
fails at once with `NO_PROVIDER` instead of hanging.

## Rejection reasons reach the worker

The native approval protocol cannot carry prose: `ApprovalService.request()` resolves one
of four closed outcomes (`allowed-once`, `rejected`, `cancelled`, `unavailable`). So a
commander's reason used to be recorded in history and nowhere else — the worker saw a bare
`rejected` and could not know that shortening its command would let it ask again.

The reason is now sent into the **same Agent** through the channel that does carry prose
into its next model step: `agent.inject(createUserMessage(...))`, the call the native
approval service itself uses for its policy notices. The note states, in one message:

- **why** that one call was rejected, quoted from the decision (redacted and bounded);
- that the rejection **stands** and the call did not run;
- that nothing was widened — not the sandbox, the switch, the policy or the standing mode;
- that this is **not** a new authorization and grants nothing by itself;
- what to do: change the operation to fit the reason and request approval again.

Delivery is tracked per request id, so a repeated reject, a retried decision or a restart
cannot deliver the same note twice. The note names the task, the request and the call so
the worker can place exactly which operation was refused. The settled evidence records
`rejectionFeedback: { delivered, reason, requestId, callId, messageId, text }` —
`delivered: true` only after an actual injection on the bound Agent — and that record is
carried into durable history, so "the worker was told why" survives a restart and can be
checked instead of claimed. A failed injection is reported as **not delivered** and never
un-rejects the call or claims the worker was told.

The message is built by the REAL native `createUserMessage`, injected by the plugin's own
composition (`src/index.js`); the locally built default exists only for a harness-free
import and uses the same `user-approval` source the native approval service itself emits, so
it is a stand-in rather than a different protocol.

**Metrics.** `delegate_metrics` counts question waits under their own `question` reason and
question answers on their own `questionAnswers` axis. A question answer is **never** counted
as a permission decision or a refusal: it authorizes nothing.

## Reviews: the sandbox policy and the bridge do not apply
The optional read-only review agent uses its own composition (its own provider,
model and effort, read-only tools and its own workspace). It does **not** run through
the worker sandbox path, it gets **no permission bridge**, and this release does not
change its tool surface or its permissions. **Only the sandbox policy and the bridge
are excluded here.** Model selection is a different contract: on `0.2.2-rc.1` the
reviewer's provider/model/effort are applied through the same durable
`agent.model.select(...)` surface and read back like the worker's, because a recorded
route is what makes the reviewer's own composition provable. The exclusion in this
section is about `workspace-write` / `never` / `ask` and the per-call decision, not
about how a model is chosen.

An ordinary DSH session is untouched for the same reason: the bridge is armed only
inside a delegated worker run, it is registered as an answerer on that Agent's own
scoped context, and it declines (falls through to the next answerer) every request
that is not its own Agent's.

## Continuations: same verified connection, proven ownership

A `continueFromTaskId` follow-up is a request to join *one already verified*
connection's own thread. The rule is a rule about identity and evidence, not a
pending hand-off feature:

- **The caller's connection identity comes from authentication.** It is the
  connection record the request was authenticated as
  (`local-mcp` on the local-switch path, a verified connection on the grant path),
  never a value the request body states about itself.
- **Only the same verified `connectionId` may continue the parent.** Another
  connection naming that task id is answered `JOB_TASK_NOT_FOUND` — the same
  answer an unknown id gets — so the reply cannot be used to learn which task ids
  exist for other connections. A different connection **cannot take over** the
  thread. There is **no permission hand-off** between connections, and ownership is
  **never** matched by a connection label or any other visible name.
- **Same process: the live record.** While this process admitted the parent, its own
  record states the connection and the outcome, and the two ids are compared
  exactly.
- **After a restart: the durable history corroborates.** The persisted task→session
  map says only *where* a thread lives — never who owns it, never how the run
  ended. The second authority is therefore the durable job history
  (`HistoryStore`), and the continuation proceeds only when that record states the
  **same** owner, a **terminal state a thread can be continued from**, and the same
  source repository and execution directory.
- **Unprovable ownership and a missing task are one answer.** An id this
  deployment cannot prove belongs to the caller's own connection — an unknown id,
  a record already dropped by the history bounds, unreadable history, a record cut
  to fit its byte budget, a record that states no owner, another connection's task,
  or a request with no verified identity — is answered `JOB_TASK_NOT_FOUND` with
  one message and one set of details. It carries only the id the caller itself
  supplied, so the reply cannot be used to learn which task ids exist for other
  connections, and it never names a Session, a state or any other reason.
- **Only a proven owner is told the reason.** Once the caller's ownership is
  established, a parent that still cannot be continued is a
  `JOB_CONTINUATION_REFUSED` whose cause is a `SESSION_*` code in
  `error.details.session`: a parent left `interrupted` by an earlier process, one
  still `pending`/`running`, a run that never drove a conversation, a recorded path
  that does not match this submission, another source repository, another execution
  directory, a disposed or mismatched worktree, or a Session that no longer exists.
  Each is refused instead of quietly starting a new Session.
- **`local-mcp` is a fixed identity, not a wildcard.** Under the local switch the
  connection is exactly `local-mcp` and is compared like any other id. It is not
  `null`, and it does not stand for "every remote connection". A request with no
  verified identity cannot prove ownership of a persisted parent, so it is refused
  rather than admitted as "anyone's".

This capability is implemented in the released build. Its acceptance is
reported separately by Codex; this document does **not** claim a passing real
install on DSH Desktop, and does **not** claim that a real attack was reproduced.

## DSH 0.2.2: the services are ready only after initialization

In DSH `0.2.2-rc.1` both services this contract depends on register their Session
projections during service initialization: `ctx.sandboxPolicy` for `sandbox/mode` and
`ctx.approval` for `approval/policy`. A plugin that read them during *activation* would
observe services that exist but cannot yet fold a session's events, and would either
misread the policy or fail for the wrong reason.

What that changes here:

- the policy is still **written then read back**, and the read-back is what proves the
  fold happened — it is not replaced by an assumption about ordering;
- the read-back happens **per run**, after the services are able to answer, so a run
  started late in the host's boot is treated the same as one started early;
- a service that cannot answer is still the fail-closed
  `RUN_SANDBOX_POLICY_UNAVAILABLE` raised **before** the prompt, on every supported
  runtime — `0.2.2-rc.1` does not get a more permissive path, and the older runtimes do
  not get a more permissive one either.

`docs/runtime-compatibility.md` states the capability-based modern/legacy split; the
runtime code that implements it lives in `src/runtime/` and is reviewed separately
from this document, which claims only the contract.

## Known limits — not resolved in 1.0.0

- **No process authentication against arbitrary same-user code.** The execution
  plane's switch mode deliberately uses one shared `local-mcp` connection identity,
  and the per-call decision is reached through that identity. The decision is bound
  to the deciding caller's OWN task, so another task's pending request is not
  addressable, but any local process that presents itself as the commander can
  decide that connection's own pending requests. **The switch remains an operator
  control, not a per-process security boundary**, and the bridge does not change
  that. A caller-supplied role label is not used as an identity anywhere.
- **The OS temporary area is a native platform exception.** DSH's own sandbox layer
  admits the platform temp directory in some configurations. That is a property of
  the native platform, **not** a write permission this plugin grants, and it is not a
  statement that a worker may write arbitrary temp paths.
- **A native `reason` string is the asker's claim, not the operation.** The bridge
  binds a decision to the arguments read from the Session log, not to the prose the
  asking tool wrote, precisely because the prose is model-generated.
- **Desktop real-install acceptance is not complete.** Installing this build into the
  DSH Desktop *production* profile and exercising the permission and continuation
  behaviour there has not been performed.

These points are open work, not released features.

### What 1.2.0 changes here: nothing, and that is the point

The 1.2.0 release fixes waiting semantics, adds an independent local control channel and
upgrades installed Codex integrations. None of those widens a permission:

- the control CLI (`bin/dsh-delegate-control.js`) has exactly two verbs, `status <taskId>`
  and `cancel <taskId>`, uses the SAME loopback execution plane as the MCP server, and
  adds no token, grant, switch, settings or configuration surface. It cannot submit a
  task, approve anything, or act on a task other than the one named; the per-call
  permission decision is still made only by `delegate_permission_decide`;
- the startup upgrade of an installed Codex MCP entry writes only values this plugin can
  prove it wrote before (marker + its own Node command + its own `dsh-delegate-mcp.js`
  file name) and only when they are stale. It cannot create the entry, adopt a same-name
  entry, follow a link at `$CODEX_HOME`/`agents`, or edit any other Codex setting;
- the `interrupted` fix is a reporting correction: an interrupted OBSERVATION is no longer
  reported as an ended execution. It changes what a host is told, not what a worker may
  do — the standing sandbox mode stays `workspace-write` and the approval stance is
  unchanged.

The two limitations above that matter for this release are unchanged and restated: the
switch and the per-call bridge are **not** per-process authentication against arbitrary
same-user code, and Desktop production-profile acceptance has still not been performed.

## What *was* verified

With the real native `SandboxPolicyService` and `ApprovalService` (the installed
`0.2.0-rc.2` peers in this repository; the `0.2.2-rc.1` reference sources have the
same `request`/`decide` and `approveEscalation` call shapes), in disposable fixtures
rather than the production Desktop profile:

- the installed `sandbox/mode` and `approval/policy` events read back through both
  services as `workspace-write` and `never`/`ask`, and the resolved workspace root is
  the Session's own directory (a different spelling of the same directory is accepted;
  a genuinely different one is refused);
- an escalation inside a valid turn under `never` is rejected immediately, without
  reaching any approval answerer; under an armed bridge it is answered
  `allowed-once`/`rejected` by that bridge and the paused call resumes with the
  native outcome;
- an unarmed bridge, a disposed bridge and a bridge bound to another Agent all leave
  the run at `never`, so no run installs an `ask` nobody services;
- a second escalation asks again, and the first grant cannot decide it (a
  non-reusable request identity and a per-arguments fingerprint);
- a missing service, a refusing service, or a read-back that disagrees is
  `RUN_SANDBOX_POLICY_UNAVAILABLE` raised before the prompt — no prompt is delivered;
  a bridge that cannot be armed is `RUN_PERMISSION_BRIDGE_UNAVAILABLE`, also before
  the prompt;
- ownership of a continuation is refused across connections and across a restart,
  and the refusal touches nothing native (no Session resolved, none created, no
  Agent driven).

Prompt delivery in those checks was **intercepted inside the fixture**; no real provider
was called and no worker command was executed under the policy. No independent native
boot on `0.2.1-rc.3` was performed for this task, and no real Desktop-process approval
was exercised.

The worker permission contract and the per-call bridge are covered by
`tests/sandbox.test.js` and `tests/permissions.test.js`; continuation ownership by
`tests/continuation-auth.test.js`; the placement and lifecycle behaviour around both
by `tests/controller-lifecycle.test.js`; the MCP surface and the plane route by
`tests/mcp.test.js`.
