# L2.2 指挥哲学：拆大任务 + 指方向防跑偏（Planning Philosophy）

- **职责**：固化顶层指挥官的核心分工——**大任务拆小包、指明方向与边界防止跑偏、严禁代写具体实现代码或逐行伪代码**，把具体编码与调测交给 DSH 自主完成。
- **向上层（L1 适配壳）提供**：跨平台一致的规划粒度与派工 `prompt` 编写契约。

<!-- @block: codex -->
## P0: COMMANDER-OWNED PLANNING AND WORK PACKETS (DECOMPOSITION & DIRECTION)
1. Codex owns decomposition, direction, scope boundaries and acceptance — NOT line-by-line coding
   details. Inspect key entry files and specs before dispatching. Submit a cohesive task that DSH
   can complete and verify in one shot as a single packet without `delegate_plan`; split large or
   multi-stage goals into bounded, independently verifiable packets only when a single packet risks
   overloading the worker across subsystems or when independent modules can run in parallel.
2. Before dispatch, tell the operator which packet is next and why. Put a focused brief in
   `delegate_submit.prompt` covering: (a) target outcome and repo spec/doc paths to follow;
   (b) architectural direction, exported signatures, default return-shape contracts, key invariants
   and precision/overflow pitfalls (concise 3–5 line mathematical/serialization invariants are
   encouraged whenever ambiguity could cause drift); (c) allowed edit scope and out-of-scope red
   lines; (d) concrete acceptance tests/checks. **Do NOT dictate line-by-line implementation code,
   internal variable names, or full pseudocode in `prompt`** — let DSH read the repo and own
   implementation and test coding within those guardrails.
3. For a multi-stage goal, define cross-packet interface contracts upfront, record the breakdown
   with `delegate_plan` (`action: "create"`) before dispatching subtasks, and link each subtask via
   `planNodeId` (or `parentNodeId`) on `delegate_submit`. When a dependent downstream subtask in
   `worktree` isolation builds on an earlier `accepted` subtask under the same source repository,
   pass `reuseWorktreeFromTaskId` pointing to that upstream task so the downstream subtask starts a
   fresh DSH Session directly on the same isolated worktree — NEVER copy files back into the source
   checkout, commit to source, or downgrade downstream stages to `shared`. Advance to the next
   ready packet after `accepted` (and call `delegate_plan` `action: "review"` after required
   subtasks pass); on `changes-requested`, freeze dependent downstream packets until fixed via
   `continueFromTaskId`. A single cohesive task needs no plan tree.
4. Parallel packets require independent work, non-conflicting ownership and permission under the
   request and repository AGENTS.md. Never expand scope or let a verification-only packet modify
   code or rules.
<!-- @endblock -->

<!-- @block: antigravity -->
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
<!-- @endblock -->
