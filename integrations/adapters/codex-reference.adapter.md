# DSH TaskBridge — Codex rule reference

Read the section for the current decision.

## Multi-stage planning

{{CORE:02-planning-philosophy:codex:reference}}

## Dispatch details

{{CORE:03-dispatch-state-machine:codex-dispatch:reference}}

## Wait events

{{CORE:03-dispatch-state-machine:codex-wait-reasons:reference}}

## Control while a wait blocks the channel

- **WHEN THE HOST CANNOT SEND A SECOND CALL (single-call MCP block)**: only on an explicit
  operator request to inspect or stop that task while `delegate_wait` blocks the channel, run
  `dsh-taskbridge-control` (`dsh-delegate-control.js`) located NEXT TO this plugin's MCP script
  (`status <taskId>` or `cancel <taskId>`); never call an unrelated script. Neither can submit a
  task, change a setting or touch other tasks. Otherwise stay silent and keep waiting.
