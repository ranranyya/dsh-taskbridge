# L2.4 务实审查与验收闭环（Pragmatic Review & Closure）

- **职责**：定义统一的独立验收标准——**严守规范与真实缺陷，拒绝因个人代码洁癖或超纲假设反复打回返工**，并确保审查结论持久化落盘。
- **向上层（L1 适配壳）提供**：跨平台一致的审查尺度、返工合并策略与持久化验收契约。

<!-- @block: codex -->
## REVIEW BOUNDARY (PRAGMATIC ACCEPTANCE)
1. Report task state, actual provider/model/effort from the result, confirmed `agentTeams` /
   `agentTeamsOrigin` / `team.applied` / `team.enabled`, actual execution directory, DSH
   workspace/session identity, changed-file summary, verification evidence and limitations. Codex
   remains responsible for reviewing changes/tests, accepting or requesting changes, and deciding
   any follow-up. Never commit, push, or read/store/relay credentials or connection tokens.
2. **Pragmatic acceptance bar (prevent nitpick rework)**: judge against the designated test suite,
   explicit spec contracts, error codes and documented boundaries. Request changes
   (`changes-requested`, consolidated into ONE follow-up via `continueFromTaskId`, freezing
   dependent downstream packets) ONLY for genuine spec/requirement violations, real functional or
   edge-case bugs, failing/missing required tests, out-of-scope edits, or leftover temp/junk files.
   **Do NOT invent adversarial out-of-spec fuzz probes** (e.g. 16-digit IEEE-754 ULP boundaries,
   inputs beyond `Number.MAX_SAFE_INTEGER`, or null-prototype objects when not in spec) to reject
   passing deliveries. Consolidate all defects in the first review (converging within 1 rework
   round); record minor style preferences or out-of-spec extremes as non-blocking notes and accept
   (`accepted`).
<!-- @endblock -->

<!-- @block: antigravity -->
## 5. 务实审查与验收闭环
1. **获取交付证据**：前台直调时，在 `delegate_wait` 返回 `ready`（执行结束，不等于验收通过）或 `failed` / `cancelled` / 终态 `interrupted` 后调用一次 `delegate_result({ taskId, includeDiff: false })`（若不直接读 `executionWorkspacePath` 而需在回执内看补丁可省略 `includeDiff`；如 `noteOmitted: true` 可按 `reviewNoteOffset`/`reviewNoteLimit` 分页读取；如 `completionSummaryOmitted: true` 可按 `completionSummaryOffset`/`completionSummaryLimit` 分页读取）。**若已由 `dsh-taskbridge` 子智能体回报完整结构化交付证据（含 `taskId`、`executionWorkspacePath`、隔离模式、DSH 归属、`agentTeams` 生效状态、审批摘要、变更文件列表与测试结果），主智能体无需重复调用 `delegate_result`**；仅当子智能体回报缺失关键字段、出现审批拒绝/异常中断或需核查详情时再补调。
2. **务实独立审查与轻量落盘**：直接基于 `executionWorkspacePath` 核查核心业务改动文件并独立确认关键测试通过（优先审查关键逻辑与真实边界，不必逐行通读全部样板测试文件）。
   - **务实验收标准（杜绝洁癖返工）**：以目标测试套件通过及规范明文列出的功能、边界和错误码为准；**仅当**存在违背明确需求/规范、真实功能或边界 Bug、测试失败/缺失、越界修改或遗留临时垃圾文件时，才判为 `changes-requested`。**严禁自行构造规范未要求的超纲对抗性 Fuzz 探针**（如 `0.49999999999999994` 等 IEEE-754 16 位极限尾数、超 `Number.MAX_SAFE_INTEGER` 天文数值或无原型 `Object.create(null)`）去打回已通过测试的交付；对于代码风格偏好、与预设写法不同但结果正确、或规范未要求的假设性极端场景，记为非阻塞备注直接 `accepted`。首轮审查须一次性列全全部实质违约点，常规任务返工收敛在 **1 轮以内**，杜绝挤牙膏式多轮打回。
   - **轻量落盘（默认传 `receiptOnly: true`）**：**必须**调用 `delegate_review({ taskId, decision: "accepted" | "changes-requested", note, completionSummary?, receiptOnly: true })` 写回审查结论（`completionSummary` 为可选字符串，不填时直接省略该字段、切勿传 `null`；传 `receiptOnly: true` 仅返回精简持久化回执，避免全量任务快照触发大文件落盘重读；完整参数签名已在此给出可直接调用，仅在需核对 schema 细则或调用报错时再读 `delegate_review.json`），确认返回 `reviewPersistence.state === "saved"` 且 `reviewPersistence.durable === true`（若为 `saving` / `timed-out` 须如实报告落盘未确认；若为 `failed` 可重试）；绝不跳过审查直接宣告完成。
   - **通过快车道 vs 返工止血车道**：
     - **若当前包通过（`accepted`）**：多子包推进时，可在**同一回合**内并行发出当前子包的 `delegate_review(..., decision: "accepted", receiptOnly: true)` 与下一就绪子包的 `invoke_subagent` 派发（或最后一个子包通过时同回合发出 `delegate_review` 与 `delegate_plan({ action: "review", ... })`），减少多包串联空转回合。
     - **若当前包需返工（`changes-requested`）**：**立即冻结所有依赖该包的后续子包**（绝不带病往下派）；先把当前包内的全部违约点、失败测试与遗漏边界一次性排查清楚，调用 `delegate_review(..., decision: "changes-requested", note, receiptOnly: true })` 落盘，随后以 **`continueFromTaskId: taskId` + 原授权 `workspacePath`（及同一 `planNodeId`）** 在原会话合并发起一轮返工；返工 `prompt` 应**直接点破失败根因与具体修复方向，并明确要求已通过的接口与测试不得退化**；待当前包返工复验拿到 `accepted` 后才可解锁推进下游子包（若同一难点经 1–2 轮返工仍原地打转，应主动将该点拆得更细或给出更明确的约束，必要时向用户汇报）。
<!-- @endblock -->
