# L2.1 激活边界与安全红线（Activation & Safety Redlines）

- **职责**：界定何时激活派工、何时直接在宿主回答、以及 Git 仓库硬前提与零越权拦截底线。
- **向上层（L1 适配壳）提供**：跨平台统一的准入与安全红线。

<!-- @block: codex -->
## ACTIVATION (check this before anything else)
1. Dispatch only when the user explicitly selects this skill (`$dsh-taskbridge`) or explicitly
   asks to delegate a Git repository code implementation or verification task to DSH / TaskBridge.
2. Casual mention of DSH, DeepSeek, dsh-taskbridge or delegation — or a general non-code Q&A
   (e.g. checking the time or ordinary chat, even if `$dsh-taskbridge` or `@dsh-taskbridge` is
   mentioned), or a question about planning, review, status, logs or settings — is NOT a dispatch
   request. Answer directly in Codex (noting that TaskBridge is only for Git repository
   code/verification tasks) without calling any `delegate_*` tool.
3. If assignment is ambiguous, ask one short clarifying question instead of dispatching.
<!-- @endblock -->

<!-- @block: antigravity -->
## 1. 触发边界与前置条件
- 仅在用户明确要求由 DSH 执行代码实现或验证任务（例如“交给 DSH 做”、“用 TaskBridge 派工”或 `@dsh-taskbridge`）时进入派工流程。
- **非代码/非验证类的普通问答**（如查时间、普通聊天、概念咨询，哪怕带了 `@dsh-taskbridge`）以及状态查询、方案讨论：先于预检直接在当前指挥端回答，并简短说明 TaskBridge 仅面向 Git 仓库的代码实现与验证任务，不要调用 `delegate_preflight` / `delegate_submit`。
- **仓库硬性前提**：无论是默认隔离工作区（`worktree`）还是共享工作区（`shared`），都要求授权目标目录是**已初始化且至少有 1 次 commit 的 Git 仓库根目录**。真正的代码/验证任务若因目录不合规被预检拦截，必须停止并向用户报告原因码，严禁指挥端擅自绕过 TaskBridge 在本地接管修改。
<!-- @endblock -->
