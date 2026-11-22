---
name: dsh-taskbridge
description: >-
  通过 DSH TaskBridge MCP 服务将明确指派的实现或验证任务派发给 DSH 执行，完成静默等待、单次权限审批、提问答复与交付审查。
  仅在用户明确要求交给 DSH / TaskBridge 执行或提及 dsh-taskbridge 时激活。
---

# DSH TaskBridge 指挥端调用规范

DSH TaskBridge 对本端而言是一个**黑盒代码执行服务**：底层 API 提供方、执行模型、思考强度、Git 工作树隔离与 DSH 原生会话放置均由 DSH 插件内部管理。
你作为**顶层指挥官**，负责理解需求、看代码定方案、拆分工作包、处理运行中的权限/提问决策，并在交付后审查验收；不要自行改写正在由 DSH 执行的目标代码。

## 1. 触发边界
- 仅在用户明确要求由 DSH 执行任务（例如“交给 DSH 做”、“用 TaskBridge 派工”或 `@dsh-taskbridge`）时调用本流程。
- 普通问答、方案讨论、仅查询状态或未指派给 DSH 的本地改动，直接在当前对话完成，不要调用 `delegate_submit`。

## 2. 派工前准备（P0 规划）
1. 先用 `read_file` 查看授权项目的源码与已有交付，明确本轮目标、复用策略、实施步骤、允许修改范围和验收检查，并将这份实施方案写入 `delegate_submit.prompt`。
2. 简单内聚任务直接单包提交；多阶段大目标先调用 `delegate_plan`（`action: "create"`）创建总目标与子任务树，再按依赖顺序通过 `planNodeId` 关联并派发各子任务；所需子任务通过审查后，再调用 `delegate_plan`（`action: "review"`）记录总目标结论。

## 3. 选择调用方式（前台直调 / 后台子智能体）
- **前台直调（适合单任务）**：直接在主对话按第 4 节调用 `delegate_*` MCP 工具。
- **后台子智能体（适合长耗时任务或多个独立隔离任务并发）**：
  调用 `invoke_subagent`（指定 `TypeName: "dsh-taskbridge"`；若当前会话子智能体需显式继承 MCP 工具，也可使用 `TypeName: "self"` 或通过 `define_subagent` 开启 `EnableMCPTools: true`），把授权 `workspacePath`、短标题 `title`、实施方案 `prompt`（及可选 `planNodeId`、`continueFromTaskId`、`agentTeams`）交给子智能体在后台完成预检、提交与静默等待；待其回报交付证据后，由主智能体完成第 5 节审查与验收。

## 4. 标准 MCP 调用流
1. **检查与预检（每个新任务链首轮执行；同链 `continueFromTaskId` 续接可直接沿用已验证事实）**：
   - 调用 `delegate_status` 确认本机调用开关已开启；若开关关闭或前置能力缺失，直接向用户说明原因并暂停，不要自行开启开关。
   - 调用 `delegate_preflight({ workspacePath })`：
     - 返回 `isolation: "worktree"`：提交时省略 `overrides`，沿用插件当前配置的隔离模式与项目覆盖。
     - 返回 `isolation: "block"` 且 `decisionRequired: true`（`PREFLIGHT_DIRTY_NEEDS_DECISION`，工作区已有未提交改动）：检查变更路径列表；确认原地执行安全且不会破坏现有改动时，说明理由并再次调用 `delegate_preflight({ workspacePath, allowShared: true })`，提交时仅传 `overrides: { isolation: "shared" }`；若风险不明确则先向用户确认。
     - 其他 `block` 原因（如 `PREFLIGHT_NOT_A_REPOSITORY_ROOT`）：停止并向用户报告原因码。
2. **提交工作包**：
   - 调用 `delegate_submit({ workspacePath, title, prompt, ... })`。
   - `title` 使用简短自然语言描述实际工作；不要覆盖插件配置的提供方、模型、思考强度，也不要随意传 `overrides.timeoutSeconds`（默认无总时长上限）。
   - `agentTeams`：仅在用户明确为本次派工指定开启或关闭时传 `true`/`false`，否则省略以沿用插件默认或原任务链选择。
   - **区分新任务与返工**：独立工作包不传 `continueFromTaskId`（开启新 DSH 会话）；同一任务审查后的返工修正必须传最新 `continueFromTaskId` 与原授权 `workspacePath`。
   - **核对派工回执**：从 `delegate_submit` 与首个可操作 `delegate_wait` / `delegate_result` 回执（切勿为此轮询运行中任务）核对来源仓库、实际执行目录（`executionWorkspacePath`）、隔离模式、DSH 工作区与会话归属（续接须确认沿用原会话），以及实际生效的 `agentTeams` / `agentTeamsOrigin` / `team.applied` / `team.enabled`；发现归属不符立即暂停后续依赖派工并回报。
3. **静默等待与事件响应**：
   - 调用 `delegate_wait({ taskId })`（省略 `waitSeconds`），等待期间保持静默，不循环轮询 `delegate_result` 或 `delegate_status`，不自行修改目标代码。
   - 按返回 `reason` 响应：
     - `wait-limit`、`heartbeat`、`interrupted`（`terminal: false`）或宿主单次工具调用超时：任务仍在后台运行，直接对**同一 `taskId`** 再次调用 `delegate_wait`，切勿重复提交、取消或本地接管。
     - `permission`：核查完整命令、路径与边界（`argumentsComplete: true`、`completeness: "complete"`、`allowBlocked: null`）；仅批准本任务需要的安全单次操作，传精确 `fingerprint` 调用 `delegate_permission_decide({ taskId, requestId, decision: "allow-once" | "reject", fingerprint, reason, waitAfterDecision: true })`。若 `decisionReceipt.applied === true` 且附带 `waitError`，表示决定已生效，切勿重发决定，直接继续 `delegate_wait`。
     - `question`：逐题回答 `question.questions[]`，调用 `delegate_question_answer({ taskId, requestId, answers, waitAfterAnswer: true })`；问答不授予权限，若 `questionAnswerable: false` 则拒绝回答。
     - `attention`：`checkpoint: "failure"`（按插件配置的重复失败提醒）时决策后通过 `delegate_wait({ taskId, ackFailureEventId })` 确认事件 ID；`checkpoint: "progress"`（按插件配置的「运行进度检查」间隔未收到新成果回传，可调可关；DSH 内部仍在运行或本机自检不会重置该计时）时查看 `progress` 确认无实质异常则继续等待。
     - **瞬时断线与故障恢复**：遇瞬时 DSH 故障或传输断线，在失败阶段最多顺序重试 3 次；若提交回执丢失，先查只读事实确认任务是否已创建或在跑（在跑则直接 `delegate_wait` 同 `taskId`，不确定先暂停，切勿盲目重发导致重复派工）；3 次仍失败时，先将检查点事实（目标与验收、各次报错、`taskId`、来源/执行路径、隔离模式、DSH 工作区与会话 ID、已完成与剩余工作）保存到工作区再暂停。

## 5. 交付审查与闭环
1. `delegate_wait` 返回 `ready`（执行结束，不等于验收通过）或 `failed` / `cancelled` 时，调用一次 `delegate_result({ taskId })` 获取改动文件、diff 与验证证据（如 `noteOmitted: true` 可按 `reviewNoteOffset` 分页读取）。
2. 核对关键改动与测试结果后，**必须**调用 `delegate_review({ taskId, decision: "accepted" | "changes-requested", note, completionSummary })` 写回审查结论，并确认返回 `reviewPersistence.state === "saved"`（或已返回 `hostAcceptance`）。
3. 需要返工时，将全部问题合并为一轮整改清单，通过 `continueFromTaskId: taskId` 提交后续轮次；绝不跳过审查直接宣告完成。
