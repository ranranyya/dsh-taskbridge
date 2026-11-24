---
name: dsh-taskbridge
description: >-
  通过 DSH TaskBridge MCP 服务将明确指派的实现或验证任务派发给 DSH 执行，完成静默等待、单次权限审批、提问答复与交付审查。
  仅在用户明确要求交给 DSH / TaskBridge 执行或提及 dsh-taskbridge 时激活。
---
<!-- Generated from integrations/core/* + integrations/adapters/antigravity-skill.adapter.md — run `npm run build:integrations` after editing layered sources. -->

# DSH TaskBridge 指挥端调用规范

DSH TaskBridge 对本端而言是一个**黑盒代码执行服务**：底层 API 提供方、执行模型、思考强度、Git 工作树隔离与 DSH 原生会话放置均由 DSH 插件内部管理。
你作为**顶层指挥官**，负责理解需求、拆分子任务、指明工作方向与边界、处理运行中的权限/提问决策，并在交付后务实审查验收；不要代写具体实现代码，也不要自行改写正在由 DSH 执行的目标代码。

{{CORE:01-activation-and-redlines:antigravity}}

{{CORE:02-planning-philosophy:antigravity}}

## 3. Antigravity 宿主适配：默认走轻量后台子智能体（隔离等待循环与审批上下文）
- **默认推荐（单任务与并发任务通用）**：主智能体完成第 2 节拆包与方向规划后，直接调用 `invoke_subagent({ TypeName: "dsh-taskbridge", Model: "flash", Role: "...", Prompt: "..." })`（除非用户明确要求其他模型或要求前台直调），把授权 `workspacePath`、短标题 `title`、清晰的方向与边界 `prompt`（及可选 `goalDescription`、`planNodeId`、`parentNodeId`、`continueFromTaskId`、`reuseWorktreeFromTaskId`、`agentTeams`、`allowShared`）交给轻量后台子智能体完成预检、提交、静默等待与常规权限审批。
  - **严格省流边界**：走该默认子智能体路径时，**主智能体派工前不要读取 `delegate_status`、`delegate_preflight`、`delegate_submit`、`delegate_wait`、`delegate_permission_decide`、`delegate_question_answer`、`delegate_result` 的 MCP schema 文件，也不要读取 `agents/dsh-taskbridge.md`**；发出 `invoke_subagent` 后立即停止调用工具被动等待回报，待子智能体回报精简结构化交付证据后，再由主智能体直接完成第 5 节务实审查与 `delegate_review`（第 5 节已给出 `delegate_review` 完整参数签名与 `receiptOnly: true`，可直接调用；仅在需查细则或报错时再读 `delegate_review.json`）。
- **前台直调（仅在用户明确要求前台执行，或仅需单次只读状态/预检查询、补录 `delegate_review` 时）**：直接在主对话按第 4 节调用对应 `delegate_*` MCP 工具。

{{CORE:03-dispatch-state-machine:antigravity}}

{{CORE:04-pragmatic-review:antigravity}}
