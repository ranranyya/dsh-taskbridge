---
name: dsh-taskbridge
description: >-
  通过 DSH TaskBridge MCP 服务将明确指派的实现或验证任务派发给 DSH 执行，完成静默等待、单次权限审批、提问答复与交付审查。
  仅在用户明确要求交给 DSH / TaskBridge 执行或提及 dsh-taskbridge 时激活。
---

# DSH TaskBridge 指挥端调用规范

DSH TaskBridge 对本端而言是一个**黑盒代码执行服务**：底层 API 提供方、执行模型、思考强度、Git 工作树隔离与 DSH 原生会话放置均由 DSH 插件内部管理。
你作为**顶层指挥官**，负责理解需求、看代码定方案、拆分工作包、处理运行中的权限/提问决策，并在交付后审查验收；不要自行改写正在由 DSH 执行的目标代码。

## 1. 触发边界与前置条件
- 仅在用户明确要求由 DSH 执行代码实现或验证任务（例如“交给 DSH 做”、“用 TaskBridge 派工”或 `@dsh-taskbridge`）时进入派工流程。
- **非代码/非验证类的普通问答**（如查时间、普通聊天、概念咨询，哪怕带了 `@dsh-taskbridge`）以及状态查询、方案讨论：先于预检直接在当前指挥端回答，并简短说明 TaskBridge 仅面向 Git 仓库的代码实现与验证任务，不要调用 `delegate_preflight` / `delegate_submit`。
- **仓库硬性前提**：无论是默认隔离工作区（`worktree`）还是共享工作区（`shared`），都要求授权目标目录是**已初始化且至少有 1 次 commit 的 Git 仓库根目录**。真正的代码/验证任务若因目录不合规被预检拦截，必须停止并向用户报告原因码，严禁指挥端擅自绕过 TaskBridge 在本地接管修改。

## 2. 派工前准备（P0 规划）
1. 先用 `read_file` 查看授权项目的源码与已有交付，明确本轮目标、复用策略、实施步骤、允许修改范围和验收检查，并将这份实施方案写入 `delegate_submit.prompt`（可选配 `goalDescription` 记录高层目标说明）。
2. 简单内聚任务直接单包提交；多阶段大目标先调用 `delegate_plan`（`action: "create"`）创建总目标与子任务树，再按依赖顺序通过 `planNodeId` 关联并派发各子任务；所需子任务通过审查后，再调用 `delegate_plan`（`action: "review"`）记录总目标结论。

## 3. 默认走轻量后台子智能体（隔离等待循环与审批上下文）
- **默认推荐（单任务与并发任务通用）**：主智能体完成第 2 节 P0 规划后，调用 `invoke_subagent({ TypeName: "dsh-taskbridge", Model: "flash", Role: "...", Prompt: "..." })`（除非用户明确要求其他模型或要求前台直调），把授权 `workspacePath`、短标题 `title`、实施方案 `prompt`（及可选 `goalDescription`、`planNodeId`、`continueFromTaskId`、`agentTeams`、`allowShared`）交给轻量后台子智能体完成预检、提交、静默等待与常规权限审批。这样可避免反复审批/等待载荷灌入主旗舰模型上下文；待子智能体回报精简结构化交付证据后，由主智能体直接完成第 5 节审查与 `delegate_review`。
- **前台直调（仅在用户明确要求前台执行，或仅需单次只读查询/补录 `delegate_review` 时）**：直接在主对话按第 4 节调用 `delegate_*` MCP 工具。

## 4. 标准 MCP 调用流
1. **检查与预检（每个新任务链首轮执行；同链 `continueFromTaskId` 续接可直接沿用已验证事实）**：
   - 调用 `delegate_status` 确认本机调用开关已开启；若开关关闭或前置能力缺失，直接向用户说明原因并暂停，不要自行开启开关。
   - 调用 `delegate_preflight({ workspacePath })`：
     - 返回 `isolation: "worktree"`：提交时省略 `overrides`，沿用插件当前配置的隔离模式与项目覆盖。
     - 返回 `isolation: "block"` 且 `decisionRequired: true`（`PREFLIGHT_DIRTY_NEEDS_DECISION`，工作区已有未提交改动）：检查变更路径列表；确认原地执行安全且不会破坏现有改动时，说明理由并再次调用 `delegate_preflight({ workspacePath, allowShared: true })`，提交时仅传 `overrides: { isolation: "shared" }`；若风险不明确则先向用户确认。
     - 其他 `block` 原因（如 `PREFLIGHT_NOT_A_REPOSITORY`、`PREFLIGHT_NOT_A_REPOSITORY_ROOT`、`PREFLIGHT_NO_COMMITS`）：停止并向用户报告原因码（不要擅自在本地接管编码）。
2. **提交工作包**：
   - 调用 `delegate_submit({ workspacePath, title, prompt, ... })`（可按需附带 `goalDescription`）。
   - `title` 使用简短自然语言描述实际工作；不要覆盖插件配置的提供方、模型、思考强度，也不要随意传 `overrides.timeoutSeconds`（默认无总时长上限）。
   - `agentTeams`：仅在用户明确为本次派工指定开启或关闭时传 `true`/`false`，否则省略以沿用插件默认或原任务链选择。若宿主不支持团队协作，显式传 `true` 或 `false` 均会被直接拒绝，须原样回报拒派原因，切勿改传另一值重试；默认关闭且未生效时报告 `applied: false`（切勿表述为已显式关闭团队）。
   - **区分新任务与返工**：独立工作包不传 `continueFromTaskId`（开启新 DSH 会话）；同一任务审查后的返工修正必须传最新 `continueFromTaskId` 与原授权 `workspacePath`。
   - **核对派工回执**：从 `delegate_submit` 与首个可操作 `delegate_wait` / `delegate_result` 回执（切勿为此轮询运行中任务）核对来源仓库、实际执行目录（`executionWorkspacePath`）、隔离模式、DSH 工作区与会话归属（续接须确认沿用原会话），以及实际生效的 `agentTeams` / `agentTeamsOrigin` / `team.applied` / `team.enabled`；发现归属不符立即暂停后续依赖派工并回报。
3. **静默等待与事件响应**：
   - 调用 `delegate_wait({ taskId })`（省略 `waitSeconds`），等待期间保持静默，不循环轮询 `delegate_result` 或 `delegate_status`，不自行修改目标代码。
   - 按返回 `reason` 响应：
     - `wait-limit`、`heartbeat`、`interrupted`（`terminal: false` 且 `state` 为 `pending`/`running`）或宿主单次工具调用超时：任务仍在后台运行，直接对**同一 `taskId`** 再次调用 `delegate_wait`，切勿重复提交、取消或本地接管。若 `interrupted` 为 `terminal: true` 且 `state: "interrupted"`，任务记录已因重启中断不会恢复，调一次 `delegate_result` 后停止等待；若状态缺失或矛盾（unknown），先调一次 `delegate_result` 核实，切勿盲目假设。
     - `permission`：核查完整命令、路径与边界（`argumentsComplete: true`、`completeness: "complete"`、`allowBlocked: null`）；仅批准本任务需要的安全单次操作，传精确 `fingerprint` 调用 `delegate_permission_decide({ taskId, requestId, decision: "allow-once" | "reject", fingerprint, reason, waitAfterDecision: true })`。若 `decisionReceipt.applied === true` 且附带 `waitError`，表示决定已生效，切勿重发决定，直接继续 `delegate_wait`；若 `decisionReceipt.confirmation === "unknown"`（`applied: null`），先调 `delegate_result` 核实真实状态，切勿自动重发。
     - `question`：逐题回答 `question.questions[]`，调用 `delegate_question_answer({ taskId, requestId, answers, waitAfterAnswer: true })`；问答不授予权限，若 `questionAnswerable: false` 则拒绝回答。若 `answerReceipt.applied === true` 且附带 `waitError`，表示回答已生效，切勿重发回答，直接继续 `delegate_wait`；若 `confirmation === "unknown"` 则先调 `delegate_result` 核实。
     - `attention`：`checkpoint: "failure"`（按插件配置的重复失败提醒）时决策后通过 `delegate_wait({ taskId, ackFailureEventId })` 确认事件 ID；`checkpoint: "progress"`（按插件配置的「运行进度检查」间隔未收到新成果回传，可调可关；DSH 内部仍在运行或本机自检不会重置该计时）时查看 `progress` 确认无实质异常则继续等待。
     - **瞬时断线与故障恢复**：遇瞬时 DSH 故障或传输断线，在失败阶段最多顺序重试 3 次；若提交回执丢失，先查只读事实确认任务是否已创建或在跑（在跑则直接 `delegate_wait` 同 `taskId`，不确定先暂停，切勿盲目重发导致重复派工）；3 次仍失败时，先将检查点事实（目标与验收、各次报错、`taskId`、来源/执行路径、隔离模式、DSH 工作区与会话 ID、已完成与剩余工作）保存到工作区再暂停。

## 5. 交付审查与闭环
1. `delegate_wait` 返回 `ready`（执行结束，不等于验收通过）或 `failed` / `cancelled` / 终态 `interrupted` 时，调用一次 `delegate_result({ taskId })` 获取改动文件、diff 与验证证据（如 `noteOmitted: true` 可按 `reviewNoteOffset`/`reviewNoteLimit` 分页读取；如 `completionSummaryOmitted: true` 可按 `completionSummaryOffset`/`completionSummaryLimit` 分页读取）。
2. 核对关键改动与测试结果后，**必须**调用 `delegate_review({ taskId, decision: "accepted" | "changes-requested", note, completionSummary })` 写回审查结论，并确认返回 `reviewPersistence.state === "saved"`（或已返回 `hostAcceptance`）。
3. 需要返工时，将全部问题合并为一轮整改清单，通过 `continueFromTaskId: taskId` 提交后续轮次；绝不跳过审查直接宣告完成。
