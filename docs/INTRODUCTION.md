# DSH TaskBridge

**Let Claude Code / Codex direct DSH, connecting planning, execution and review in one task workflow.**

Describe your goal in Claude Code or Codex. The commander plans the work, dispatches tasks and reviews delivery; TaskBridge hands implementation to DSH using the API connection, worker model and reasoning effort you selected in the plugin. Execution remains visible in DSH, results return to the commander, and corrections can continue the original task.

TaskBridge is for people who want to keep their familiar commander while using DSH's existing model connections for code changes, feature development, test fixes and documentation work.

## From a goal to a reviewed result

> Describe the goal → Commander plans and dispatches → DSH executes → Commander reviews delivery → Continue the original task if changes are needed

The program waits during execution. Permission requests, questions and exceptions return control to the commander when a decision is needed. After delivery, the commander examines the actual changes and verification evidence, then records an accepted or changes-requested review in the task history.

## Features

### Choose execution settings inside DSH

- **Reuse existing API connections.** Select providers already configured in DSH, without entering their endpoint addresses or API keys again.
- **Keep control of the worker model.** Select the model and its supported reasoning effort, plus task timeout, maximum concurrency and workspace isolation.
- **Save settings automatically.** Changes save without scrolling to a separate save button. Store non-sensitive configuration presets and use project-specific overrides.

### Wait quietly and handle the moments that need judgment

The program observes execution activity internally and keeps waiting while work proceeds, reducing repeated status queries and intermediate-code reads by the commander model. Approvals, questions, delivery and failures return control when there is something to handle.

By default, the program checks for problems after 5 minutes without new activity and asks the commander to assess the situation after 10 minutes. Thresholds are adjustable in advanced settings. Client-side waiting limits may still end a call early; continue waiting on the same task in that case.

### Give new tasks their own workspace; keep corrections in the same conversation

New tasks create DSH Workspaces named after the work, making their conversations easier to find. When review identifies a correction, the commander explicitly continues the original task, retaining its conversation and execution checkout. Independent tasks start separately.

### Decide permissions per operation and review after delivery

Operations requiring additional permissions are presented to the commander for a decision about the specific tool call. Delivery still requires review: the commander checks the result and records a conclusion.

An optional **additional read-only model review** can use its own API connection, model and reasoning effort to provide a second assessment. Final acceptance remains with the commander.

### Control delegation with one switch and follow the task history

A local delegation switch controls whether tasks can be submitted. It starts disabled on a new installation. Enabling it allows delegation; disabling it rejects new tasks and requests that running tasks stop.

Task records show execution status, the actual API and model used, changed files, verification evidence and review decisions. Open task details and full review notes to follow work from dispatch through acceptance.

### Set up Codex with plugin controls; connect Claude Code through MCP

- **Codex:** The settings page provides installation, update and repair controls for the agent and MCP connection, including dispatch, waiting, permission and review rules. Reload the client afterward. Clients that support agent mentions can select `@dsh-taskbridge`.
- **Claude Code:** Connect manually using standard stdio MCP and the [setup guide](claude-code.md). A one-click installer and real Claude Code client validation are not yet available.

## Get started

1. Install and enable **DSH TaskBridge** in DSH's plugin manager. The package name is `dsh-taskbridge`.
2. Open the plugin settings, select an existing DSH API connection, worker model and reasoning effort, then enable the local delegation switch.
3. Set up the Codex integration using the plugin controls and reload the client, or follow the manual MCP guide for Claude Code.
4. Tell the commander the goal, the project it may change and the acceptance criteria. Explicitly ask it to execute through TaskBridge.

For example:

> Use TaskBridge to fix this project's settings-saving issue. Plan and review the work; let DSH implement it with the model selected in the plugin. Check the changes and tests after delivery. Continue the original task if corrections are needed.

Model selection and reasoning effort follow the effective plugin configuration and runtime capabilities. Agent mention availability depends on the Codex client; quiet waiting does not guarantee zero model wake-ups in every client.

## Installation and documentation

- [Project and installation guide](../README.md): requirements, installation and detailed configuration.
- [Plugin discovery and updates](plugin-market.md): add this project's custom plugin index to discover and update it in DSH. This is not inclusion in the built-in official marketplace.
- [Codex integration](codex-integration.md) · [Claude Code setup](claude-code.md).
- [Migration from DSH Delegate / TaskDispatch](taskbridge-upgrade.md): guidance for existing installations. Do not enable old and new plugins together.
- [Changelog](../CHANGELOG.md) · [1.5.2 release notes](releases/1.5.2.zh.md).
