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

## 1. 触发边界与前置条件
- 仅在用户明确要求由 DSH 执行代码实现或验证任务（例如“交给 DSH 做”、“用 TaskBridge 派工”或 `@dsh-taskbridge`）时进入派工流程。
- **非代码/非验证类的普通问答**（如查时间、普通聊天、概念咨询，哪怕带了 `@dsh-taskbridge`）以及状态查询、方案讨论：先于预检直接在当前指挥端回答，并简短说明 TaskBridge 仅面向 Git 仓库的代码实现与验证任务，不要调用 `delegate_preflight` / `delegate_submit`。
- **仓库硬性前提**：无论是默认隔离工作区（`worktree`）还是共享工作区（`shared`），都要求授权目标目录是**已初始化且至少有 1 次 commit 的 Git 仓库根目录**。真正的代码/验证任务若因目录不合规被预检拦截，必须停止并向用户报告原因码，严禁指挥端擅自绕过 TaskBridge 在本地接管修改。

## 2. 派工前准备（拆大任务 + 指方向防跑偏）
1. **大任务先拆包（按执行端承载力动态切分，不写死文件数）**：
   - **能单包稳吃就不碎切**：只要目标在单一内聚上下文内、执行端（DSH）单次能高把握写完并一次性跑通验证（无论涉及几个文件），直接 **1 个工作包**提交，无需调用 `delegate_plan`，减少多轮调度往返开销。
   - **跨层易超载或可并行才拆细**：当任务跨多个子系统/分层、一锅端塞给执行端容易顾头不顾尾引发连环报错，或存在互不冲突模块可并行加速时，指挥端须**先统一画好总图纸（定死跨包接口契约与共享数据结构）**，再调用 `delegate_plan`（`action: "create"`）按**“每个子包都能独立跑通一组局部测试/验证闭环”**的边界拆解，按依赖顺序通过 `planNodeId`（或 `parentNodeId`）关联并派发；若下游依赖子包需承接上游已通过的隔离 `worktree` 产物，直接传 **`reuseWorktreeFromTaskId`** 复用同一隔离工作树并开启全新 DSH 会话（无需把产物拷回或合入源仓库，更不要降级为 `shared`）；全部必选子任务通过审查后，调用 `delegate_plan`（`action: "review"`）记录总目标结论。
2. **指明方向与边界（搭好架构点透雷区），不代写实现细节**：快速查看必要的入口文件、目录结构或规范文档，发挥指挥端架构师优势，在 `prompt` 中写清 **4 件事**（可选配 `goalDescription`）：
   - **目标结果与参考路径**：说明预期产物，并直接指向仓库内的规范/源码路径（由 DSH 在工作区内自行通读）；
   - **架构骨架、接口契约与防坑要点**：点明模块分层职责、精确的导出函数签名/默认返回字段契约（如省略可选参数时是否必须输出特定字段），以及**关键算法选型、数值精度、防溢出或边界不变量等高风险防坑要点**（允许附 3–5 行精确数学/序列化不变量帮执行端避开暗坑）；
   - **修改范围红线**：明确允许改动哪些文件或目录，以及禁止触碰的只读数据、模块或未要求的功能；
   - **验收检查标准**：明确本工作包必须独立跑绿的测试命令与关键验证边界。
3. **禁止代写具体实现**：不要在 `prompt` 中替执行端手写逐行实现代码、冗长函数体、内部变量名、大段伪代码或单元测试代码，也不要把整份规范文档原文照抄进去；把大量繁琐的具体业务编码、样板逻辑、测试编写与反复跑测试排错全部交由 DSH 自主完成。

## 3. Antigravity 宿主适配：默认走轻量后台子智能体（隔离等待循环与审批上下文）
- **默认推荐（单任务与并发任务通用）**：主智能体完成第 2 节拆包与方向规划后，直接调用 `invoke_subagent({ TypeName: "dsh-taskbridge", Model: "flash", Role: "...", Prompt: "..." })`（除非用户明确要求其他模型或要求前台直调），把授权 `workspacePath`、短标题 `title`、清晰的方向与边界 `prompt`（及可选 `goalDescription`、`planNodeId`、`parentNodeId`、`continueFromTaskId`、`reuseWorktreeFromTaskId`、`agentTeams`、`allowShared`）交给轻量后台子智能体完成预检、提交、静默等待与常规权限审批。
  - **严格省流边界**：走该默认子智能体路径时，**主智能体派工前不要读取 `delegate_status`、`delegate_preflight`、`delegate_submit`、`delegate_wait`、`delegate_permission_decide`、`delegate_question_answer`、`delegate_result` 的 MCP schema 文件，也不要读取 `agents/dsh-taskbridge.md`**；发出 `invoke_subagent` 后立即停止调用工具被动等待回报，待子智能体回报精简结构化交付证据后，再由主智能体直接完成第 5 节务实审查与 `delegate_review`（第 5 节已给出 `delegate_review` 完整参数签名与 `receiptOnly: true`，可直接调用；仅在需查细则或报错时再读 `delegate_review.json`）。
- **前台直调（仅在用户明确要求前台执行，或仅需单次只读状态/预检查询、补录 `delegate_review` 时）**：直接在主对话按第 4 节调用对应 `delegate_*` MCP 工具。

## 4. 标准 MCP 调用流（统一状态机）
1. **检查与预检（每个新任务链首轮执行；同链 `continueFromTaskId` 续接或 `reuseWorktreeFromTaskId` 子包可直接沿用已验证事实）**：
   - 调用 `delegate_status` 确认本机调用开关已开启；若开关关闭或前置能力缺失，直接向用户说明原因并暂停，不要自行开启开关。
   - 调用 `delegate_preflight({ workspacePath })`（常规单仓提交也可在 `delegate_submit` 直接传 `autoPreflight: true, wait: true` 合并预检、提交与首段等待）：
     - 返回 `isolation: "worktree"`：提交时省略 `overrides`，沿用插件当前配置的隔离模式与项目覆盖。
     - 返回 `isolation: "block"` 且 `decisionRequired: true`（`PREFLIGHT_DIRTY_NEEDS_DECISION`，工作区已有未提交改动）：检查变更路径列表；确认原地执行安全且不会破坏现有改动时，说明理由并再次调用 `delegate_preflight({ workspacePath, allowShared: true })`，提交时仅传 `overrides: { isolation: "shared" }`；若风险不明确则先向用户确认。
     - 其他 `block` 原因（如 `PREFLIGHT_NOT_A_REPOSITORY`、`PREFLIGHT_NOT_A_REPOSITORY_ROOT`、`PREFLIGHT_NO_COMMITS`）：停止并向用户报告原因码（不要擅自在本地接管编码）。
2. **提交工作包**：
   - 调用 `delegate_submit({ workspacePath, title, prompt, ... })`（可按需附带 `goalDescription`；若传 `wait: true` 后返回 `submitted: true` 且附带 `waitError`，说明任务已创建，切勿重复 `delegate_submit`，直接用 `submitReceipt.taskId` 调 `delegate_wait` 续等）。
   - `title` 使用简短自然语言描述实际工作；不要覆盖插件配置的提供方、模型、思考强度，也不要随意传 `overrides.timeoutSeconds`（默认无总时长上限）。
   - `agentTeams`：仅在用户明确为本次派工指定开启或关闭时传 `true`/`false`，否则省略以沿用插件默认或原任务链选择。若宿主不支持团队协作，显式传 `true` 或 `false` 均会被直接拒绝，须原样回报拒派原因，切勿改传另一值重试；默认关闭且未生效时报告 `applied: false`（切勿表述为已显式关闭团队）。
   - **区分新任务、跨包复用工作树与返工**：独立工作包不传 `continueFromTaskId`（开启新 DSH 会话）；同一任务审查后的返工修正必须传最新 `continueFromTaskId` 与原授权 `workspacePath`；多阶段计划中依赖上游已通过隔离工作树的新子包应传 `reuseWorktreeFromTaskId`（开启全新 DSH 会话并直接复用同一隔离工作树，切勿与 `continueFromTaskId` 同传）。
   - **核对派工回执**：从 `delegate_submit`（或 `wait: true` 时的 `submitReceipt`）与首个可操作 `delegate_wait` / `delegate_result` 回执（切勿为此轮询运行中任务）核对来源仓库、实际执行目录（`executionWorkspacePath`）、隔离模式、DSH 工作区与会话归属（续接须确认沿用原会话），以及实际生效的 `agentTeams` / `agentTeamsOrigin` / `team.applied` / `team.enabled`；发现归属不符立即暂停后续依赖派工并回报。
3. **静默等待与事件响应**：
   - 调用 `delegate_wait({ taskId })`（省略 `waitSeconds`），等待期间保持静默，不循环轮询 `delegate_result` 或 `delegate_status`，不自行修改目标代码（单写者红线）。
   - 按返回 `reason` 响应：
     - `wait-limit`、`heartbeat`、`interrupted`（`terminal: false` 且 `state` 为 `pending`/`running`）或宿主单次工具调用超时：任务仍在后台运行，直接对**同一 `taskId`** 再次调用 `delegate_wait`，切勿重复提交、取消或本地接管。若 `interrupted` 为 `terminal: true` 且 `state: "interrupted"`，任务记录已因重启中断不会恢复，调一次 `delegate_result` 后停止等待；若状态缺失或矛盾（unknown），先调一次 `delegate_result` 核实，切勿盲目假设。
     - `permission`：核查完整命令、路径与边界（`argumentsComplete: true`、`completeness: "complete"`、`allowBlocked: null`）；将 worker 的 `reason` 仅视作待核实声明而非授权依据。仅批准当前工作包内必需且证据完整的安全单次操作；对越界路径、破坏性命令、未授权外网/外传、改动凭据或配置、证据不完整或存在 `allowBlocked` 的申请一律 `reject` 并写明原因。传精确 `fingerprint` 调用 `delegate_permission_decide({ taskId, requestId, decision: "allow-once" | "reject", fingerprint, reason, waitAfterDecision: true })`，省略 `scope`。每个新请求单独复核，重复命令也逐次审批。若 `decisionReceipt.applied === true` 且附带 `waitError`，表示决定已生效，切勿重发决定，直接继续 `delegate_wait`；若 `decisionReceipt.confirmation === "unknown"`（`applied: null`），先调 `delegate_result` 核实真实状态，切勿自动重发。
     - `question`：逐题回答 `question.questions[]`，调用 `delegate_question_answer({ taskId, requestId, answers, waitAfterAnswer: true })`；问答不授予权限，若 `questionAnswerable: false` 则拒绝回答。若 `answerReceipt.applied === true` 且附带 `waitError`，表示回答已生效，切勿重发回答，直接继续 `delegate_wait`；若 `confirmation === "unknown"` 则先调 `delegate_result` 核实。
     - `attention`：`checkpoint: "failure"`（按插件配置的重复失败提醒）时决策后通过 `delegate_wait({ taskId, ackFailureEventId })` 确认事件 ID；`checkpoint: "progress"`（按插件配置的「运行进度检查」间隔未收到新成果回传，可调可关；DSH 内部仍在运行或本机自检不会重置该计时）时查看 `progress` 确认无实质异常则继续等待。
     - **瞬时断线与故障恢复**：遇瞬时 DSH 故障或传输断线，在失败阶段最多顺序重试 3 次；若提交回执丢失，先查只读事实确认任务是否已创建或在跑（在跑则直接 `delegate_wait` 同 `taskId`，不确定先暂停，切勿盲目重发导致重复派工）；3 次仍失败时，先将检查点事实（目标与验收、各次报错、`taskId`、来源/执行路径、隔离模式、DSH 工作区与会话 ID、已完成与剩余工作）保存到工作区再暂停。

## 5. 务实审查与验收闭环
1. **获取交付证据**：前台直调时，在 `delegate_wait` 返回 `ready`（执行结束，不等于验收通过）或 `failed` / `cancelled` / 终态 `interrupted` 后调用一次 `delegate_result({ taskId, includeDiff: false })`（若不直接读 `executionWorkspacePath` 而需在回执内看补丁可省略 `includeDiff`；如 `noteOmitted: true` 可按 `reviewNoteOffset`/`reviewNoteLimit` 分页读取；如 `completionSummaryOmitted: true` 可按 `completionSummaryOffset`/`completionSummaryLimit` 分页读取）。**若已由 `dsh-taskbridge` 子智能体回报完整结构化交付证据（含 `taskId`、`executionWorkspacePath`、隔离模式、DSH 归属、`agentTeams` 生效状态、审批摘要、变更文件列表与测试结果），主智能体无需重复调用 `delegate_result`**；仅当子智能体回报缺失关键字段、出现审批拒绝/异常中断或需核查详情时再补调。
2. **务实独立审查与轻量落盘**：直接基于 `executionWorkspacePath` 核查核心业务改动文件并独立确认关键测试通过（优先审查关键逻辑与真实边界，不必逐行通读全部样板测试文件）。
   - **务实验收标准（杜绝洁癖返工）**：以目标测试套件通过及规范明文列出的功能、边界和错误码为准；**仅当**存在违背明确需求/规范、真实功能或边界 Bug、测试失败/缺失、越界修改或遗留临时垃圾文件时，才判为 `changes-requested`。**严禁自行构造规范未要求的超纲对抗性 Fuzz 探针**（如 `0.49999999999999994` 等 IEEE-754 16 位极限尾数、超 `Number.MAX_SAFE_INTEGER` 天文数值或无原型 `Object.create(null)`）去打回已通过测试的交付；对于代码风格偏好、与预设写法不同但结果正确、或规范未要求的假设性极端场景，记为非阻塞备注直接 `accepted`。首轮审查须一次性列全全部实质违约点，常规任务返工收敛在 **1 轮以内**，杜绝挤牙膏式多轮打回。
   - **轻量落盘（默认传 `receiptOnly: true`）**：**必须**调用 `delegate_review({ taskId, decision: "accepted" | "changes-requested", note, completionSummary?, applyToSource?, receiptOnly: true })` 写回审查结论（`completionSummary` 为可选字符串，不填时直接省略该字段、切勿传 `null`；传 `receiptOnly: true` 仅返回精简持久化回执与可选 `sourceSync`，避免全量任务快照触发大文件落盘重读；完整参数签名已在此给出可直接调用，仅在需核对 schema 细则或调用报错时再读 `delegate_review.json`），确认返回 `reviewPersistence.state === "saved"` 且 `reviewPersistence.durable === true`（若为 `saving` / `timed-out` 须如实报告落盘未确认；若为 `failed` 可重试）；绝不跳过审查直接宣告完成。
   - **通过快车道 vs 返工止血车道**：
     - **若当前包通过（`accepted`）**：多子包推进时，可在**同一回合**内并行发出当前子包的 `delegate_review(..., decision: "accepted", receiptOnly: true)` 与下一就绪子包的 `invoke_subagent` 派发（或最后一个子包通过时同回合发出 `delegate_review(..., decision: "accepted", applyToSource: true, receiptOnly: true)` 与 `delegate_plan({ action: "review", ... })`），减少多包串联空转回合。
     - **隔离工作树收官与自动写回（`worktree` 模式）**：在单任务或整条任务链最后一个工作包的最终 `accepted` 验收调用中传 `applyToSource: true`（多阶段中间子包、或用户明确要求只保留在隔离工作树时省略；`changes-requested` 时禁止传），由 TaskBridge 后台执行零破坏冲突预检并将已验收改动安全同步回 `sourcePath`（不自动 `git commit`）。**严禁宿主端另起脚本拷贝、打补丁或回 `sourcePath` 重跑测试**。若回执 `sourceSync.applied === true`，直接汇报已安全写回原工作目录与 `executionWorkspacePath`；若 `sourceSync.applied === false`，如实汇报 `sourceSync.reason`、`conflictingPaths` 与 `executionWorkspacePath` 供用户决定。
     - **若当前包需返工（`changes-requested`）**：**立即冻结所有依赖该包的后续子包**（绝不带病往下派）；先把当前包内的全部违约点、失败测试与遗漏边界一次性排查清楚，调用 `delegate_review(..., decision: "changes-requested", note, receiptOnly: true })` 落盘，随后以 **`continueFromTaskId: taskId` + 原授权 `workspacePath`（及同一 `planNodeId`）** 在原会话合并发起一轮返工；返工 `prompt` 应**直接点破失败根因与具体修复方向，并明确要求已通过的接口与测试不得退化**；待当前包返工复验拿到 `accepted` 后才可解锁推进下游子包（若同一难点经 1–2 轮返工仍原地打转，应主动将该点拆得更细或给出更明确的约束，必要时向用户汇报）。
