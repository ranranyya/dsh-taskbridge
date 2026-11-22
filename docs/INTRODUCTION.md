# DSH TaskBridge

**Let Codex direct DSH. Choose the execution API, model and reasoning effort in the DSH plugin.**

> **Codex is the currently supported client. Claude Code and Claude Desktop integration is planned for version 2.0.**

[简体中文](INTRODUCTION.zh.md) · [Get started](#get-started) · [Settings](#settings) · [FAQ](#faq) · [Changelog](../CHANGELOG.md)

TaskBridge is a task delegation plugin for **DeepSeek Harness (DSH)**. Keep describing your goals in Codex: the commander plans the work, handles requests that need a decision and reviews delivery. The model running in DSH implements changes, runs tools and tests, and returns its results.

**You choose the model. The commander organizes and reviews the work. DSH executes.** TaskBridge connects dispatch, waiting, review and follow-up corrections in one workflow.

![TaskBridge workflow: the commander plans and reviews, TaskBridge connects and waits, and DSH executes; corrections continue the original task](https://raw.githubusercontent.com/ranranyya/dsh-taskbridge/v1.5.2/docs/assets/taskbridge-workflow.en.png)

*Workflow diagram. The program waits during normal execution; decisions return to the commander, and corrections continue the original task.*

## Why TaskBridge?

Use TaskBridge when you want Codex to understand the project and check the result, while a model already connected to DSH does the implementation.

- **Keep tasks and results connected.** The commander dispatches through MCP and reads the delivered changes and verification evidence.
- **Choose execution settings once.** Select the provider, model and reasoning effort in DSH; tasks use the effective plugin configuration.
- **Reduce repetitive progress checks.** The program observes execution and returns when there is something to decide or review.
- **Keep context for corrections.** Send a consolidated correction list back to the original conversation and execution workspace.
- **Distinguish delivery from acceptance.** Execution status and the commander's final conclusion have separate records.

Typical tasks include feature development, bug fixes, test coverage, code cleanup and project documentation. Both the commander and executor still incur their own model usage; quiet waiting reduces repetitive queries and transfers of intermediate results.

## Features at a glance

| Feature | What it gives you |
| --- | --- |
| **Existing API connections** | Select providers enabled in DSH without copying endpoints or API keys. |
| **Worker model and reasoning effort** | Choose the executor and its supported effort, plus timeout, concurrency and isolation. |
| **Codex integration controls** | Install or update the TaskBridge agent, MCP connection and dispatch rules; repair MCP separately. |
| **One delegation switch** | Control whether local task submission is allowed. |
| **Quiet waiting** | Let the program wait and return for approvals, questions, exceptions and delivery. |
| **Per-operation permissions** | Decide a specific request, then continue waiting for the same task. |
| **Task workspaces and continuation** | Name workspaces after the work; start independent tasks separately and explicitly continue corrections. |
| **Agent collaboration default** | Decide the new-task agent-teams default, overridable per dispatch; off by default. |
| **Review after delivery** | Inspect changes and evidence together, then record acceptance or request changes. |
| **Automatic settings saving** | Save selections promptly and text edits after a short pause, with visible save status. |
| **Presets and project overrides** | Reuse worker settings and give projects their own settings. |
| **Task history and details** | Inspect phases, actual routing, activity, permission decisions, changes and complete review notes. |

## Get started

### 1. Install in DSH

Open **Plugins → Add plugin** and enter:

```text
dsh-taskbridge
```

To install this specific release:

```text
dsh-taskbridge
```

Enable **DSH TaskBridge** and open its settings. Use the official npm registry if a regional mirror has not synchronized yet. GitHub Releases also provide `.tgz` packages.

TaskBridge runs tasks through DSH. The local MCP connection to Codex requires Node.js 24 or newer. The Codex integration installer checks for an available runtime.

### 2. Select an API, model and effort

In **API management**, add a provider from DSH's enabled connections. Then open **Execution settings** and choose the provider, worker model and supported reasoning effort.

Credentials remain managed by DSH. If the connection is missing, configure and enable it in DSH's own model/API settings first, then refresh the plugin's catalog.

Settings save automatically. Check for a saved status before dispatching; an invalid or unsaved draft is not the active configuration.

### 3. Connect the commander

Open **Codex integration** and click **Install / update TaskBridge agent**. The button configures:

- **The TaskBridge agent:** writes `agents/dsh-taskbridge.toml`.
- **The MCP connection:** registers the plugin's tool entry.
- **Commander rules:** explicit dispatch, quiet waiting, permission decisions, review and continuation.

Reload Codex afterward. Clients with agent mentions can select `@dsh-taskbridge` and describe a task; availability of the `@` picker depends on the client.

Initial setup requires a button click. Later updates can refresh recognized plugin-managed entries while preserving custom edits. **Claude Code and Claude Desktop are not supported integration clients in this release; their integration is planned for 2.0.**

### 4. Enable delegation and assign a task

Turn on **Allow local MCP calls to DSH delegation** at the top of the page. Tell the commander the goal, the project it may change and the acceptance criteria. For example:

> Use TaskBridge to fix settings changes not taking effect in this project. Plan and review the work; let DSH implement it using the model selected in the plugin. Limit changes to settings persistence, preserve the existing interaction and add regression verification. Review delivery and continue the original task if corrections are needed.

The commander checks the connection and workspace before submission. Follow execution in the DSH workspace conversation and inspect delivery in **Task history**.

## How a task gets completed

| Stage | Commander | DSH / TaskBridge |
| --- | --- | --- |
| **Plan** | Define the scope and acceptance criteria; split work if needed. | Provide connection status and workspace preflight information. |
| **Dispatch** | Submit a clear goal, project path and task title. | Start the task with the effective configuration and create its record and conversation. |
| **Execute** | Wait. | Modify files, run tools and tests, record activity and keep waiting internally. |
| **Request or question** | Decide specific permissions and answer questions needed for execution. | Pause the relevant operation, provide evidence and resume the same task after a decision. |
| **Deliver** | Review actual changes, verification and unresolved issues together. | Return results and evidence. |
| **Accept or correct** | Record a review conclusion or prepare one correction list. | Save the conclusion or continue the original conversation and execution workspace. |

Execution completion means the executor has returned its work. Acceptance means the commander has reviewed it. Task history distinguishes the two.

## Settings

The page has **API management, Execution settings, Task history and Codex integration** tabs, with the local delegation switch above them.

### API, model and execution options

| Setting | Purpose |
| --- | --- |
| **Provider** | Select an enabled DSH API connection added to the plugin. |
| **Worker model** | Choose the implementation model; task details record the actual provider and model used. |
| **Reasoning effort** | Choose from the selected model's declared capabilities. |
| **Timeout** | Total time budget for a task, 1800 seconds by default; inactivity checks do not extend it. |
| **Maximum concurrency** | Limit simultaneous tasks, 1 by default; the commander decides whether to split work. |
| **Workspace isolation** | Use an independent Git worktree or the authorized shared project directory. |
| **Agent collaboration for new tasks** | Decide whether a new dispatch with no per-task choice uses DSH's native agent teams; off by default, a per-task choice wins, continuations keep the chain's choice. |
| **Presets** | Save commonly used worker settings. |
| **Project overrides** | Apply project-specific settings instead of the global selection. |

**You choose the executor.** Managed commander rules preserve the configured provider, model and reasoning effort. An unavailable combination is reported instead of silently switching to another model.

Settings affect subsequent dispatches. A running task keeps its submission-time configuration snapshot.

### Worktree or shared workspace

| Mode | Where files change | When to use it |
| --- | --- | --- |
| **Independent worktree (default)** | An isolated Git worktree created from the source repository's committed baseline. | Keep candidate changes separate from the current checkout and review before integrating. |
| **Shared workspace** | The authorized project directory itself. | Explicitly work in the current directory, including its existing uncommitted content. |

Worktree mode requires a usable Git repository and committed baseline. Preflight blocks a dirty source checkout to avoid handing the executor an older version of the project. Commit the intended baseline first, or explicitly choose shared mode with its implications understood.

**Accepting a review does not merge a worktree, create a commit or push.** Integration into the project remains part of the work you authorize the commander to perform.

### One switch controls local delegation

The switch starts disabled. Installing the plugin or merely mentioning DSH does not start a task. Even with the switch enabled, the commander needs an explicit assignment.

Disabling the switch rejects new tasks and requests that running tasks stop. Local use does not require manually issuing signed connections.

## Quiet waiting

Quiet waiting reduces repeated status checks and intermediate-code reads while the executor is still working.

| Situation | Response |
| --- | --- |
| New output, reasoning activity or tool events | Update the activity timestamp and keep waiting internally. |
| **5 minutes** without new activity | Program-level execution and connection checks; no commander model call just for the check. |
| **10 minutes** without new activity | Return a brief diagnosis for the commander to assess. |
| Permission request or question | Return the information needed for a decision, then continue the same task. |
| Repeated identical operation failures reach the threshold | Send an acknowledged reminder; the default threshold is 3 and is adjustable. |
| Completion, failure, cancellation or interruption | Return for review or exception handling. |

The 5/10-minute values measure **continuous inactivity**. They are not intervals for periodically asking GPT to inspect the work. UI refreshes and connection heartbeats do not count as execution activity, and a lack of file changes alone does not mean the task has stalled.

Advanced settings control inactivity thresholds and repeated-failure reminders. If a waiting limit or client timeout ends a call, continue the same task; that does not automatically cancel, redispatch or switch its model. See [quiet waiting](silent-wait.md) for the detailed contract.

## Conversations and task organization

### Separate independent work

A new task starts a new conversation in the corresponding DSH Workspace, named after the work, such as “Fix settings persistence” or “Add login regression tests.” In worktree mode, independent tasks normally have separate execution directories. A shared directory can map to the same DSH Workspace, while independent tasks still get separate conversations.

### Continue corrections with the original context

After review, tell the commander:

> Continue the previous task. Send the three review findings together to the original executor, keep its conversation and workspace, and review again after the corrections are delivered.

The commander uses `continueFromTaskId` to identify that task explicitly. The original conversation and candidate changes stay available; matching project paths alone do not make unrelated tasks share one chat.

After a DSH restart, the plugin checks the original task and workspace identities before attempting continuation. A missing directory or unverifiable identity is reported.

### Use DSH teams when appropriate

**You set the default; the dispatcher may decide one task.** Execution settings have a
**"Enable agent collaboration for new tasks"** switch, and upgrades and fresh installs
both start it **off**:

- Upgrading or installing never turns it on by itself.
- It decides only what a **new dispatch** does when it states no per-task choice. When the
  dispatcher states `true` or `false` for one dispatch, **that choice wins**.
- **Continuations** with no new choice keep the collaboration choice the task they
  continue **recorded**. If that task recorded none (an older record), the plugin applies
  nothing and writes nothing: the Session keeps the mode it already has.
- It affects **later submissions only**; a task that already started keeps its own
  frozen snapshot.
- It is **not DSH's global switch**: the plugin writes only that one task's own Session
  and never changes DSH's global default or a conversation you adjusted yourself.

On a DSH without agent-teams support, an **explicit** `true` or `false` is refused
**before the prompt** and the task detail states why; it never quietly runs in the previous
mode. The one exception is the implicit off default: such an ordinary dispatch still runs,
but reports **not applied** (not "turned off"), which keeps older dispatches working. This
decision does not change your configured API, model or effort, and team members' additional
permissions currently have to be handled through the main executor. Cancellation works the
same either way.

One outer task always holds **one conversation and one concurrency slot**: enabling
collaboration adds neither, and there is no reason to dispatch extra tasks for it.

## Task history: progress and acceptance

Open **Task history → Details** to inspect:

- **Execution:** phase, recent activity, current tool and inactivity diagnosis.
- **Effective settings:** actual provider, model, effort and isolation.
- **Agent collaboration:** the choice frozen on this task, where it came from (per-task
  request / inherited continuation / TaskBridge default), and what DSH confirmed or why it
  could not be applied.
- **Task relationships:** execution workspace, conversation and continuation links.
- **Decisions:** permission requests and their per-operation allow/deny records.
- **Delivery evidence:** changed files, diffs, verification and results.
- **Review:** commander acceptance and complete review notes.

| Status | Meaning |
| --- | --- |
| **Running / waiting for a tool** | Execution is active; the program keeps waiting. |
| **Awaiting a permission decision** | A specific operation needs commander judgment. |
| **Awaiting host review** | Delivery exists, but final commander acceptance is not yet recorded. |
| **Accepted** | The commander has recorded acceptance. |
| **Changes requested** | Findings are recorded and can be handled by continuing the task. |
| **Review persistence unconfirmed** | Saving has not been confirmed; do not treat the conclusion as durably recorded. |

Background list refreshes are program operations, not model calls. Full review notes can be expanded from task details.

## FAQ

### Will Codex delegate everything after installation?

No. Enable the local switch and explicitly assign work to TaskBridge. Managed rules distinguish discussion from delegation; you can still ask Codex to perform work itself.

### Does dispatch use the model I selected in DSH?

It uses the effective TaskBridge execution configuration. A matching project override can replace the global selection, and running tasks retain their submission-time snapshot. Check the actual routing in task details.

### Do I have to approve every operation manually?

Requests return to the commander using TaskBridge. It assesses the specific operation against your authorized scope and asks you when a new decision is required. A single approval applies only to that operation.

### Does quiet waiting guarantee zero Codex token use?

No. Planning, approvals, answers, exception handling and review still use model calls. Savings depend on the task, client waiting behavior and context size. See the [historical waiting-stage comparison](https://github.com/ranranyya/dsh-taskbridge/blob/master/docs/releases/1.5.0-token-benchmark.zh.md) for measurements and their limits.

### Why does a finished task still say “awaiting host review”?

Reading the result does not record acceptance. The commander must review it, call `delegate_review` and confirm persistence. Managed rules include this step.

### Why is the old introduction or integration still visible after an update?

Check the installed DSH plugin version and refresh the page. Registry mirrors and discovery indexes may be cached; online updates for a local `.tgz` installation depend on DSH's source management.

For Codex, use the install/update button and reload the client. Use the MCP-only repair control when that is the affected entry. Custom edits remain protected and require separate handling.

### Does TaskBridge install every dependency and client integration?

Enable TaskBridge in DSH and keep DSH running during delegated tasks. Set up the dependencies each project needs. To connect Codex for the first time, open **Codex integration** in the plugin and click **Install / update TaskBridge agent**. Claude Code and Claude Desktop integration is planned for 2.0.

## Client support and the 2.0 plan

| Client | Current status | Plan |
| --- | --- | --- |
| **Codex** | Supported, with agent and MCP installation, update and repair controls. | Continue improving delegation and review. |
| **Claude Code** | Not yet available. | Integration planned for **2.0**. |
| **Claude Desktop** | Not yet available. | Integration planned for **2.0**. |

The goal for 2.0 is to let more commanders use the execution models configured in DSH. Setup details and delivery scope will be documented in the 2.0 release notes. Use Codex with the current release.

## Documentation and feedback

| Guide | Covers |
| --- | --- |
| [Codex integration](codex-integration.md) | Installation, updates, repairs, configuration locations and managed rules. |
| [Claude integration plans](claude-code.md) | Planned 2.0 support for Claude Code and Claude Desktop. |
| [Quiet waiting](silent-wait.md) | Activity timing, continuation, reminders and validation scope. |
| [Workspaces and isolation](workspace-contract.md) | Preflight, worktrees, shared mode and task identity. |
| [Conversation placement](conversation-placement.md) | Workspace naming, conversation creation and explicit continuation. |
| [Plugin discovery and updates](plugin-market.md) | Custom indexes, npm and GitHub installation sources. |
| [Migration](taskbridge-upgrade.md) | Upgrading from DSH Delegate / TaskDispatch. |
| [1.5.4 release notes](https://github.com/ranranyya/dsh-taskbridge/blob/master/docs/releases/1.5.4.zh.md) | Persisted task records, explicit goals and summaries, and placement checks. |
| [1.5.3 release notes](https://github.com/ranranyya/dsh-taskbridge/blob/master/docs/releases/1.5.3.zh.md) | Review summaries, full-note layout, mixed line endings, and commander planning rules. |
| [1.5.2 release notes](https://github.com/ranranyya/dsh-taskbridge/blob/master/docs/releases/1.5.2.zh.md) | The introduction update and its validation scope. |

TaskBridge uses runtime capability checks rather than a DSH version whitelist; see [runtime notes](runtime-compatibility.md). A separate CLI execution channel and validation of every runtime environment are not complete. Existing limits are documented in the [1.5.1 notes](https://github.com/ranranyya/dsh-taskbridge/blob/master/docs/releases/1.5.1.zh.md).

Report issues and suggestions on [GitHub Issues](https://github.com/ranranyya/dsh-taskbridge/issues). Include the plugin version, reproduction steps and relevant redacted errors; leave out API keys.

## License

[MIT](../LICENSE)
