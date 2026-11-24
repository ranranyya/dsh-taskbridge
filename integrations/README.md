# TaskBridge 分层集成规范（单一真源）

本目录是所有顶层 Agent 宿主（Codex、Antigravity 及后续接入的宿主）派工规则的**唯一维护入口**。修改跨平台派工原则、规划理念、状态机或审查标准时，只修改本目录源文件，再运行 `npm run build:integrations` 自动生成各端安装产物；**禁止直接手改产物文件**（单测 `tests/integrations-layering.test.js` 会校验逐字节一致）。

## 四层整体架构（自底向上）

| 层级 | 名称 | 源码位置 | 负责什么 | 给上层提供什么服务 |
| --- | --- | --- | --- | --- |
| **L4** | DSH 黑盒执行与隔离引擎层 | `src/jobs/`、`src/runtime/worker-prompt.js` | 底层模型路由、Git `worktree`/`shared` 隔离与草稿保护、Worker 沙箱/工具/清理行为约束 | 受控隔离代码执行车间：交付干净 diff 与真实测试证据，遇越权或疑问可挂起恢复 |
| **L3** | MCP 协议与状态机契约层 | `bin/dsh-delegate-mcp.js`、`src/mcp/server.js` | 权限开关检查、仓库预检、`delegate_wait` 阻塞事件归并、幂等回执与审查持久化 | 平台无关的 11 个标准 `delegate_*` MCP 原语与阻塞事件流 |
| **L2** | **跨平台共享派工指挥内核层** | **`integrations/core/01..04.md`** | 统一触发红线、**拆大任务 + 指方向防跑偏（禁代写实现细节）**的指挥哲学、标准派工状态机、**务实审查防洁癖返工**标准 | 跨平台完全一致的指挥官业务逻辑，新平台接入直接复用 |
| **L1** | **顶层宿主平台适配层** | **`integrations/adapters/*.adapter.md`** | 只写各 Agent 平台独有运行机制（Codex 单链直等 3660s；Antigravity 主控 + Flash 托管省流） | 装配为各宿主原生格式的安装文件，给用户提供低耗、零空转的派工体验 |

## 目录结构

- `integrations/core/`（L2 共享指挥内核，按职责拆分为 4 个文件）：
  1. `01-activation-and-redlines.md` — 触发边界、非代码普通问答直答、Git 仓库根目录与至少 1 次 Commit 硬前提、零本地越权接管。
  2. `02-planning-philosophy.md` — 核心指挥哲学：大任务拆小包（`delegate_plan`）+ 指明方向、接口契约与范围红线（防跑偏），**禁止代写具体实现代码或逐行伪代码**。
  3. `03-dispatch-state-machine.md` — 统一派工状态机：`preflight` → `submit`（`agentTeams` / `continueFromTaskId` / 回执核对）→ `wait`（`wait-limit` / `heartbeat` / `permission` / `question` / `attention` / `interrupted` / 3 次瞬时断线重试 / 单写者禁令）。
  4. `04-pragmatic-review.md` — 务实审查标准：独立核查真实改动与测试；仅对违背需求/规范、真 Bug、测试失败/缺失、越界修改或遗留临时文件合并一轮打回；风格偏好与超纲假设记为非阻塞备注直接 `accepted`，并验证 `reviewPersistence.state === "saved"`。
- `integrations/adapters/`（L1 极薄宿主适配壳）：
  - `codex-skill.adapter.md` 和 `codex-reference.adapter.md` 从 L2 装配 Codex 首读入口和同目录的 `rules-reference-<sha256>.md`。入口提供常规流程，多阶段规划和低频事件按需读取同源附页。构建为每份 Codex 文件设置 12,000 UTF-8 字节预算。
  - `antigravity-skill.adapter.md` → 组装生成 `antigravity/skills/dsh-taskbridge/SKILL.md`
  - `antigravity-subagent.adapter.md` → 组装生成 `antigravity/agents/dsh-taskbridge.md`

## 维护命令

```bash
# 从 integrations/core + integrations/adapters 重新组装各端安装产物
npm run build:integrations

# 检查各端安装产物是否与分层源文件一致
npm run check:integrations
```
