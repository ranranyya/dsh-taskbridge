# Changelog

## 1.9.2 — Codex Code Mode 低耗直调、全链路长等待收口与隔离工作树回写确认（2026-11-26）

- **Codex Code Mode 低耗直调与零截断治理**：在 `codex/skills/dsh-taskbridge/SKILL.md` 的 frontmatter `description` 与 `## CODE MODE CALLS` 中明确直调 `tools.mcp__dsh_delegate__*`，禁止整组打印 `ALL_TOOLS`（消除全局 MCP `instructions` 重复拼接引发的首轮 10k Token 输出截断与后续纯查工具回合），仅按需对单一精确工具名切片打印 `exec tool declaration:`；同步在主入口与按需附页内联 `delegate_plan`（单节点与 `nodes` 批量建树）、`allowShared + autoPreflight`、`continueFromTaskId`、`delegate_permission_decide`（精确拷贝 `fingerprint`）与 `delegate_question_answer` 标准调用模板。
- **全链路长等待（`yield_time_ms: 1200000`）统一收口**：在首次 `delegate_submit({ wait: true })`、单链 `delegate_wait`、返工/子包复用提交、`waitAfterDecision: true` 与 `waitAfterAnswer: true` 全部等待入口统一固化 `// @exec: {"yield_time_ms": 1200000}`（杜绝回退为 60 秒短等待），规范 `Script running with cell ID` 单链续等与附页完整章节读取。
- **本地审查合并与隔离工作树（`worktree`）收官回写询问**：Codex 端收紧 `delegate_result({ taskId, includeDiff: false })` 回执校验与 `executionWorkspacePath` 单次组合验证串联；Codex 与 Antigravity 双端统一规定在整条任务链完成 `accepted` 持久化（含最终 `delegate_plan` 总评）后，默认保持 `sourcePath` 原目录不改动并汇报 `executionWorkspacePath`，同时在对话中以纯文本询问用户是否需要将已验收改动写回原工作目录（用户确认后先做冲突检查再本地同步且不自动 `git commit`）。
- **7 题基准省流复验、产品简介数据刷新与无感升级支持**：Codex 7 题基准连续四轮 `7/7`（`700/700`）满分通过，较 `1.9.1` 满分场（`179` 步 / `1,139.2 万` 总 Token）主控步数压降 **29.6%–36.9%**（`113–126` 步）、含缓存总 Token 压降 **34.1%–43.7%**（`641.4 万–751.1 万`，`T5` 单题总 Token 降 **45.5%–60.4%**、主控输出较无插件基线省 **44.2%–69.5%**）；同步刷新 `README.md`、`docs/INTRODUCTION.zh.md` 与 `docs/INTRODUCTION.md` 中的双端基准与省流实测章节，并在 `src/codex/installer.js` 与 `src/antigravity/installer.js` 中补登已发布 `1.9.1`（LF / CRLF）及 `1.9.2-test1`–`test4` 托管技能的精确 SHA-256 哈希。详见 [1.9.2 更新说明](docs/releases/1.9.2.zh.md)。

## 1.9.1 — 插件简介与介绍文案统一为「宿主端」表述、前端提示清理（2026-11-25）

- **插件清单与市场索引简介优化**：重写 `package.json`、`locale/zh.json` 与 `locale/en.json` 中的安装预览简介，去除具体基准测试百分比，改为概括表达插件的设计意图与核心功能，并统一以「上层宿主端」为主语（末尾保留已适配宿主及 2.0 路线说明）。
- **中英文介绍与支持路线术语统一**：将 `README.md`、`docs/INTRODUCTION.zh.md`、`docs/INTRODUCTION.md` 及 `docs/claude-code.md` 中混用的“顶层指挥端 / 指挥端 / 指挥官 / 跨客户端 / 客户端支持路线”等表述统一收口为「宿主端 / 跨宿主 / host」，仅在具体集成操作、兼容范围与实测对照组中点名具体宿主。
- **DSH 设置界面前端文案同步**：修正 `src/client/api.js` 与 `src/client/index.jsx` 中残留的「等待宿主（Codex）审查」「等待本机指挥官决定」等旧提示，统一改为「等待宿主端审查」「等待宿主端决定」，并重新构建 `lib/client.js`。
- **1.9.0 无感升级哈希补登**：在 `src/codex/installer.js` 中补登 `1.9.0` 正式版 Codex 原生技能 `SKILL.md` 的 LF / CRLF 双哈希，确保既有 `1.9.0` 托管安装可无缝刷新到 `1.9.1` 且完整保留用户自定义修改。详见 [1.9.1 更新说明](docs/releases/1.9.1.zh.md)。

## 1.9.0 — Codex 原生技能单链直等架构、分层指挥内核、跨包工作树复用与双端省流实测（2026-11-24）

- **Codex 全面切换为原生技能（Skill + 按需附页）单链直等架构**：
  - 托管目标从旧子智能体文件 `agents/dsh-taskbridge.toml` 升级为 Codex 原生技能 `$CODEX_HOME/skills/dsh-taskbridge/SKILL.md` 及同目录哈希固定附页 `rules-reference-<sha256>.md`（标准 YAML frontmatter + 托管版本注释 + 独立所有权记录 `codex-skill-ownership`），让当前 Codex 会话在明确指派时读入紧凑入口并直调 `delegate_submit` 与单链 `delegate_wait`（配合 `config.toml` 的 `tool_timeout_sec = 3660` 静默长等），彻底根除主会话通过 `spawn_agent` + 短超时 `wait_agent` 每 45–55 秒空转轮询的问题。
  - Antigravity 端继续保留 `SKILL.md` + `Model: "flash"` 后台子智能体架构（适配其 3 分钟 MCP 调用硬上限与主旗舰模型被动零唤醒挂起）。
- **旧版 Codex 子智能体安全自动退役**：
  - 保留对 `0.1.6`–`1.8.x` 已发布模板精确哈希与历史 `codex-agent-ownership` 记录的识别能力。DSH 启动自动刷新、点击「安装 / 更新 TaskBridge 技能」或点击「移除插件托管项」时，会在先确认 `skills/dsh-taskbridge/SKILL.md` 与附页落盘且写入前再次逐字节复验后，自动移除未经用户修改的旧 `agents/dsh-taskbridge.toml` 与 `agents/dsh-delegate.toml`；任何被用户手动改过的旧文件或同名技能文件一律原样保留并在面板提示。
  - 扩展边界保护至 `$CODEX_HOME`、`skills/`、`skills/dsh-taskbridge/` 与 `agents/`（Windows 下合并为单次批量路径属性探测以消除冷启动延迟），拒绝穿过符号链接或 Windows reparse point / junction 读写。
- **跨宿主分层派工内核重构与双端指挥理念统一**：
  - 将跨平台公共派工规则收拢至单一真源 `integrations/core/`（激活红线、规划哲学、派工状态机、务实审查），各宿主独有运行机制收拢至极薄适配壳 `integrations/adapters/`，通过 `npm run build:integrations` 自动组装出各端产物，并由 `npm run check:integrations` 与 `tests/integrations-layering.test.js` 锁死逐字节一致。
  - 双端统一为「大任务先用 `delegate_plan` 拆小包 + 指明架构方向/接口契约/范围红线/验收标准（禁止指挥端代写逐行实现代码或伪代码）+ 务实审查防洁癖返工（仅真缺陷/违背规范/测试失败/遗留垃圾文件合并一轮返工，严禁自行构造超纲对抗性 Fuzz 探针打回合格交付）」。
  - Antigravity 宿主适配层补齐省流边界：主控默认走 `flash` 后台子智能体时禁止预读子智能体专用 MCP schema 与 `agents/dsh-taskbridge.md`、禁止重复调用 `delegate_result`，Flash 子智能体禁止越界通读业务源码；两端安装器补登历史及 `test1`–`test6` 精确哈希保障无感升级。
- **跨子包隔离工作树复用与 MCP 往返压缩**：
  - `delegate_submit` 新增 `reuseWorktreeFromTaskId`：多阶段规划中下游子包可在上游已完成任务的隔离 `worktree` 上直接开启全新干净 DSH 会话继续构建，全程零污染用户源仓库，且联动清理自动保护仍被下游任务引用的共享工作树；同时新增 `autoPreflight: true` 与 `wait: true` 支持单次 MCP 调用完成预检、提交与首段等待（若后续等待中断仍完整返回 `submitReceipt` 与 `taskId` 防重复派工）。
  - `delegate_permission_decide` 按本次调用的精确指纹逐次审批。为兼容预览版客户端，`allow-once` 带 `scope: "task-command"` 时按 `scope: "once"` 处理。
  - `delegate_result` 新增 `includeDiff: false` 供本地直接审查 `executionWorkspacePath` 时省略重复大段补丁；任务执行回执新增 `execution.usage.delta` 与 `cumulative` 双口径 Token 统计；底层 `worker-prompt.js` 明确禁建工作区内 `.cache/` 临时垃圾日志。
- **修复「立刻启用」瞬间 404 竞态与前端冷启动重试**：
  - 在 `src/index.js` 中优先注册用户面 `/api/dsh-delegate/*` 与执行面 HTTP 路由，再并行执行 Codex / Antigravity 启动自动刷新（`/codex` 与 `/antigravity` 路由会在读写前等待启动刷新落定），彻底消除启动期路径校验阻塞路由注册导致的 404 窗口；前端 `store.init()` 增加冷启动短暂 404 自动短退避重试与同文案提示去重。
- **双端 7 题黑盒基准实测验证（`1.9.0-test6` 候选构建）**：同宿主配对无插件强模型基线（DSH 执行后端为 `deepseek-v4.1-flash`），Antigravity 端 `7/7` 满分通过（`T1–T5` 同题 `5/5` 与基线持平，同题主控均步 `11.00 → 11.80`）、`T1–T5` 强模型有效 Token（非缓存输入 + 输出）净省 **32.06%**（重型题 `T5` 省 **37.95%**）；Codex 端 `6/7` 通过、`T1–T5`（`4/5`，均分 `96`）与无插件基线逐题得分 100% 一致，`T1–T5` 主控有效 Token 净省 **24.50%**（`T5` 省 **43.32%**，7 题有效 Token 较旧轮询态下降 **78.7%**）。详见 [1.9.0 更新说明](docs/releases/1.9.0.zh.md)。

## 1.8.1 — 任务联动清理、指挥端低耗优化、共享工作区保护与全新架构图（2026-11-23）

- **任务记录联动清理、快捷预设与历史孤儿扫除**：
  - 设置页「任务记录」支持快捷批量勾选预设（全部可清理 / 仅已通过验收 / 仅失败·取消·中断），以及三项按需勾选的联动清理：归档关联 DSH 派工会话、移除隔离工作树与临时工作区、递归清理空规划父节点；严格按隔离模式区分保护，绝不删除主项目源码与共享工作区。
  - 打通 `interrupted`（DSH 重启中断且不可恢复）终态历史记录的手动清理与底层 `HistoryStore.deleteMany` 删除，并新增 `POST /api/dsh-delegate/tasks/cleanup-orphans` 一键扫除历史残留工作树与孤儿会话映射。
- **三重指挥端省 Token 优化**：
  - Antigravity 规则默认走轻量 `dsh-taskbridge`（`Model: "flash"`）后台子智能体隔离等待与常规审批并只回传结构化精简摘要；修正 `agents/dsh-taskbridge.md` 的 YAML `tools:` 声明（不手写由 `mcp_config.json` 自动注入的 `call_mcp_tool`）。
  - 底层 `worker-prompt.js` 要求优先使用原生文件/搜索工具代替 Shell 读写日志并禁止未要求的外部网络请求，实测大幅减少沙箱审批回合。
  - MCP 全量响应改为单行紧凑 JSON，且 `permission` / `question` 交互暂停回合裁剪 `task.activity`、`selfCheck`、`route`、`reviewPersistence` 冗余监控大块。
- **共享模式工作区命名保护**：仅 `worktree` 隔离模式首次新建工作区时以任务 `title` 命名，`shared` 共享模式保留项目原生工作区名称。
- **规则、MCP 契约与全新介绍图同步**：修正 MCP `initialize` `instructions`、`delegate_wait` Schema 与兜底提示中的旧版 10 分钟静默口径；写透两种模式均需已提交 Git 仓库根目录及非代码问答边界；补齐双端防重发与三态中断对称规则并登记 `1.8.0` 升级哈希；替换中英文架构图并修复 `README.md` 全部断链与过时参考区。详见 [1.8.1 更新说明](docs/releases/1.8.1.zh.md)。

## 1.8.0 — Antigravity 一键集成、三层黑盒优化与文档润色（2026-11-22）

- **新增 Antigravity 一键集成**：设置页新增独立「Antigravity 集成」标签页与托管安装器（`src/antigravity/`），可将自包含插件包安装至 `~/.gemini/config/plugins/dsh-taskbridge/`（内含 `plugin.json`、按需加载的 `SKILL.md`、仅含只读与 MCP 权限的后台派工子智能体 `agents/dsh-taskbridge.md` 与插件内独立 `mcp_config.json`），不修改 Antigravity 全局配置。
- **逐文件所有权与升级保护**：Antigravity 集成支持安装/更新、仅修复 MCP 配置、移除托管项与 DSH 启动自动刷新；通过内容哈希逐文件保护用户自定义修改（例如编辑过 `SKILL.md` 时原样保留，同时不影响其余托管文件的补装与升级），并支持在缺失所有权记录时自动识别未修改的旧版 `plugin.json`。
- **三层黑盒架构优化（Codex 端大幅瘦身）**：
  - 将共享工作区保留已有未提交修改与测试后清理新建未追踪临时日志的约束收归底层 `worker-prompt.js`。
  - 精简 `codex/dsh-taskbridge.toml`（移除顶层手管底层工作区与重复等待段落，篇幅缩减约 73%），保留完整的 P0 规划、静默等待、单次权限审批、原生提问、派工回执核对（含 `agentTeamsOrigin` 与 `team.enabled`）、断线防重与检查点保存纪律。
  - 去除顶层派工规则与设置页说明中对用户可配监控阈值（自检/运行进度检查分钟数）的硬编码表述，统一对齐 DSH 设置页动态配置与 `1.7.0+` 实际计时口径。
  - 登记已发布 `1.7.1` 托管模板精确哈希（LF / CRLF），老用户升级自动刷新未修改的 Codex 模板并保留自定义改动。
- **产品介绍与文档润色**：重写中英文插件介绍（`docs/INTRODUCTION.zh.md`、`docs/INTRODUCTION.md`、`README.md` 开头及 `locale/*.json`），新增 `docs/antigravity-integration.md`（含 Antigravity 首次 MCP 工具放行说明），更新 `docs/claude-code.md`（2.0 接入规划）并补齐历史文档口径一致性。
- **接口与工程细节**：补齐 `ANTIGRAVITY_*` / `CODEX_*` 错误码 HTTP 映射与前端中文提示，补全客户端入口导出与 `lib/client.d.ts` 类型声明对齐。详见 [1.8.0 更新说明](docs/releases/1.8.0.zh.md)。

## 1.7.1 — Codex 派工前制定实施方案

- Codex 先查看项目和已有交付，确定当前工作包、复用决策、实施步骤和验收方法，再把方案写入 DSH 收到的指令。
- DSH 按方案执行。发现前提与实际不符时，先向 Codex 回报证据，由 Codex 决定调整并验收交付。
- 支持升级未修改的 1.7.0 托管智能体，保留自定义内容。

## 1.7.0 — 任务记录、并行会话与静默监控

- 「任务记录」会自动显示新任务，保留工作标题。可按日期筛选，按执行链清理记录，也可打开任务原来的 DSH 会话。清理记录会保留源码和 DSH 会话。**入口在插件设置页的「任务记录」标签**；左侧侧栏不再有独立的「TaskBridge 任务」行。
- 左侧「工作区」保留 DSH 原生树：隔离任务工作区归在 TaskBridge 根工作区下，共享任务沿用原项目中的原生工作区。经 TaskBridge 派出的会话在它自己的原生行里带一个很小的标记（「派工」／「派工 · 隔离」）。
- 同一项目可同时派发多个独立的隔离任务。每个工作包有自己的 DSH 会话和执行目录，各占一个并发名额。同一个共享目录一次只允许一个执行任务。
- 任务实际运行满 10 分钟时，插件在本机自检一次。Codex 连续 40 分钟未收到新成果时，插件会提醒 Codex 检查。两项可分别调整或关闭，提醒不会中止任务。
- 智能体协作默认关闭，可由用户设置，也可随单次派工选择。续接默认保留原会话的选择。任务的规划与交付验收由 Codex 负责。
- Codex 集成可识别和升级插件托管的旧智能体文件，保留用户的自定义设置。「安装 / 更新 TaskBridge 智能体」可重新配置集成，「仅修复 MCP 配置」只处理连接。

## 1.6.0 — 多层任务树、项目分组与 DSH 会话导航

- 新增独立持久化 `PlanStore`（`plan.json`）与 `delegate_plan` MCP 工具，支持在派工前创建未执行的总目标与多层子任务规划节点、批量建树及目标级审查验收。
- `delegate_submit` 与历史记录新增显式 `planNodeId` / `parentNodeId` 层级关联；严格区分多层子任务拆解（各自新建 DSH Session）与 `continueFromTaskId`（同节点整改续接轮次）。
- 新增确定性任务树投影（`task-tree.js`），完整处理跨进程重载、源项目摘要归类、同名项目与同名节点隔离、缺失父节点孤儿标记及异常环路拆解，绝不猜测旧记录关系或标题。
- 在任务记录页创建总目标及多个子任务。首次执行与整改轮次显示在同一个节点内。状态以已保存的审查结论为准，分支仍需处理时整链不会提前完成。
- 用已核实的源项目分组。支持标题和编号搜索、按状态筛选，以及在对应轮次内展开审查详情。
- 已验收的任务可归档或恢复显示。新增执行轮次后，任务重新进入主列表。展示归档和历史保留各自沿用独立规则。
- 在 DSH 左侧打开 TaskBridge 任务入口，可按项目查看记录并打开已核实的原生会话。DSH 原来的工作区列表仍负责会话管理。
- 修复与 DSH 思考强度插件同时使用时，明确指定档位的派工在续接中被自动降档。未指定档位时仍由 DSH 处理。
- 登记 1.5.4 受管 Codex 模板身份（CRLF／LF），保护用户自定义修改。详见 [1.6.0 更新说明](docs/releases/1.6.0.zh.md)。

## 1.5.4 — 任务记录保存与派工归属规则修复（2026-11-18）

- 保存任务已有标题和明确续接关系，重启后仍可读取，不推测旧记录缺失信息。
- 提交支持可选目标说明，审查支持可选完成说明；同次确认落盘后公开，最多2000 Unicode码点，保留中文、emoji与内部换行。
- 修复直接历史写入的脱敏后长度、异常读取裁剪幂等和旧审查结论补写保护，保留并发、超时、重试及快照保护。
- 补齐授权项目、执行目录、原生Workspace与Session的归属核查规则，说明新会话可能复用旧分组；不新增原生工作区路由。
- 保留正式1.5.3模板准确升级身份和自定义内容保护；规划节点、父子树及界面留待后续。详见docs/releases/1.5.4.zh.md。

## 1.5.3 — 验收展示、混合换行与指挥规则修复（2026-11-17）

- 验收摘要仅显示结论、时间与保存状态；完整意见在详情中阅读，未确认保存成功时不提前显示通过。
- 修复完整审查意见的长路径与连续字符串换行，保留全部正文、原始换行及按需读取、复制和刷新。
- Codex 托管模板按全文准确识别 LF／CRLF／混合换行；额外独立 CR、BOM、空白、正文或版本改动仍受保护，新写入统一 LF，写删前精确复核原字节。
- 增加指挥端规划与按需拆单规则：先明确目标、方案、责任和验收，再派当前可执行工单，交付后集中审查。该规则不构成运行时行为拦截。
- 保留已发布 1.5.2 及真实本地 test.1／test.2 模板的准确升级身份；沿用现有提供方、模型、权限和等待协议。
- 本版汇总已验收测试候选；任务名称保存、分组与目标树不在本次更新内。验证范围与更新方法见 docs/releases/1.5.3.zh.md。

## 1.5.3-test.2 — 验收展示、全文排版与混合换行修复（本地测试版，2026-11-17）

- 纳入 G10：验收摘要只显示结论、时间和保存状态，避免与完整意见正文重复；未确认保存成功时不提前显示通过。
- 纳入 G11：完整意见保留所有字符与换行，长路径及连续字符串在容器内换行，保留全文读取、复制和刷新。
- 纳入 G12：准确识别已知模板的 LF／CRLF／混合形式；额外独立 CR、正文或版本改动仍不认领，新受管文件统一 LF，写删并发保护保持精确。
- 保留 test.1 的 P0 指挥规则，并以实际已安装模板的准确样本支持 test.1 升级，不从当前正文推导历史身份。
- 此为新的本地测试包；任务名称／分组／目标树尚未实现。包前回归和真实安装结果另存验证报告，未发布 npm／GitHub。

## 1.5.3-test.1 — 指挥端规划与按需拆单（本地测试版，2026-11-16）

- 新增 P0 指挥规则：指挥端先确定目标、方案、接口、依赖和验收，再派当前可执行的小工单。简单内聚任务可一次完成；多阶段目标按需拆分，不能把整个待办清单交给执行端自行规划。
- 每单明确工作目标、已选方案、文件责任、约束及验收；交付后由指挥端集中审查并记录结论，再推进有依赖的工作。修正续接原任务，独立工作另建会话。
- 规划、规则、用户报告、审查结论与更新日志由指挥端负责。只验证的工单不得自行修改规则、实现或测试断言。
- 在派工工具及 prompt 说明中加入简短提醒；保留用户选择的 API、模型、思考强度及原有审批、静默等待和续接协议。
- 登记已发布 1.5.2 模板的准确 LF／CRLF 身份，验证原版升级、幂等和自定义内容保留。包清单、锁文件和托管模板同步标记为测试版。
- 本包只交付以上规则和迁移支持。任务名称／任务树、审阅显示和 Codex 混合换行识别问题仍待后续修复；不包含真实安装生效或新 token 节省比例的声明。

## 1.5.2 — 产品介绍更新（2026-11-15）

- 重写插件列表与 npm 简介，突出让 Codex 指挥 DSH，并在插件中配置已有 API、执行模型和思考强度。
- 重写中英文详情页，按用途、任务流程、核心功能和上手步骤组织，补充设置表、任务状态、使用示例、常见问题和中英文任务流程图。
- 同步 README 开头的产品介绍，将历史更新与测量材料放回对应文档入口。
- 明确当前仅支持 Codex 端，Claude Code 与 Claude Desktop 接入预计在 2.0 上线；同步旧接入文档为路线说明。
- 功能沿用 1.5.1；同步发布版本和旧版 Codex 托管模板身份，保持原版集成可升级、自定义内容不覆盖。无新增执行功能或 token 节省比例声明。

## 1.5.1 — 自动保存、集成升级与可靠提醒（2026-11-15）

- 连续工具失败提醒增加稳定事件 ID；取出提醒不再提前消费，HTTP 或 MCP 回包丢失后可重新取得同一事件。
- `delegate_wait` 新增可选 `ackFailureEventId` 并返回 `failureAck`；确认幂等，错误 ID 不会清除待处理提醒。已收到的确认事实在后续网络错误、取消及审查落盘等待中保留，并发观察各自携带自己的回执。
- 更新托管 Codex 规则，按任务 ID 与事件 ID 去重、处理后确认；识别正式 1.5.0 的 LF／CRLF 原版模板以支持迁移，保留用户自定义规则。旧参数仍可调用；未确认事件会重放，旧宿主需同步更新处理规则。
- 修复长会话 `delegate_metrics` 因历史样本过多而整体报 `MCP_RESULT_OVER_BUDGET`：等待和决定样本各显示最近 8 条，累计数完整保留，明确列出全部未展示记录数，普通问答计入共享样本轴。
- 修复长审批与问答压缩时丢失 `failureAck` 的问题；问答救援路径补充生产桥接受的超大问题集回归。最终 `MCP_RESULT_OVER_BUDGET` 拒绝兜底尚未独立复现，不宣称覆盖。
- 设置页自动保存：文本输入防抖、离散选择及时保存、串行写入避免旧响应覆盖新输入；无效草稿可继续修正，移除底部两个保存按钮。
- 修复任务详情与完整审查意见展示，重复打开或切换任务时定位到详情；后台刷新不抢焦点，不用摘要替换已加载全文。
- 新增逐任务 `agentTeams` 选择，由指挥官按复杂度决定 DSH 团队模式；不改变用户选定的 API、模型和思考强度。续接继承原决定，显式值可覆盖，实际应用读回验证。原生子成员提权不由本插件桥接，需额外权限的操作仍由 root 执行并逐次审批。
- 修复 DSH 重启后隔离工作区无法续接：从已验证任务身份、真实目录和 Git 登记恢复原工作区，保留候选修改，不创建替代副本；缺失、身份不符、分支替换或已处置的目录继续拒绝。
- 统一托管规则：正常执行只静默等待；审批核验具体操作；交付后集中、有界读取与审查；同链身份无变化时复用预检事实，审查结果确认持久化。用真实 1.5.0 的 LF／CRLF 发布模板验证迁移、幂等和自定义规则保护。
- 修复迁移过 Codex 配置目录的机器每次更新都误报冲突：允许选定的 home 根目录为正常 symlink／Windows junction，将各安装、修复、移除和启动刷新操作固定到真实目录；保留根目录链接和用户自定义配置保护，不改变全局 CODEX_HOME。
- 登记已安装的 1.5.1-test.1 托管模板的准确 LF／CRLF 身份，支持后续候选升级；补充经真实 junction 升级原版模板、再次幂等及自定义文件保留的回归。
- 修复热更新时沿用旧清单缓存、将新规则误写成旧版本的问题：每次激活从当前包清单刷新版本；登记已观察到的本地测试版旧版本戳模板，支持准确迁移，继续保留自定义文件。真实热更新和重启结果见本轮验收报告。
- 本轮候选完整回归 1566 项通过；同步正式版本和补充 test.3 升级验证后，正式源码完整回归 1567 项通过，无失败、跳过或取消；前端构建产物检查通过。原生设置自动保存、任务详情与完整审查意见已实测；真实 DSH 任务确认团队关闭成功。夹具注入的事件测试不冒充全真模型验收。
- 真实模型验收通过失败提醒重放、错误确认保留、正确与重复确认、90 秒静默等待以及集中审查持久化；支持已安装 test.3 候选准确迁移到正式版。版本范围、升级方式和已知限制见 docs/releases/1.5.1.zh.md；未新增跨进程提醒持久化，不宣称新的 token 节省比例。

## 1.5.0 — 静默等待、提问与审批闭环（2026-11-15）

- 新增 `delegate_question_answer`，转交 DSH 原生普通问题；回答后可在同一次调用继续静默等待。问题有有效期，并绑定原 Agent、Session 和工具调用；回答不授予权限。
- 审批工具支持 `waitAfterDecision: true`。已确认生效后直接续等；决定答复未知不自动重送，已生效后的等待故障仍保留回执。省略新选项保留旧协议。
- 新增只读 `delegate_metrics`，统计程序调用、内部观察、等待原因、字节数与决定/回答事实。宿主模型 token 和费用仍标记未接入，账单对照单独核算。
- 修复正常 `dsh-delegate` / `dsh-taskbridge` 路径误脱敏；分离显示投影和可恢复身份，重启后核验真实路径/摘要并续接原对话。已丢失可信证据的旧记录不猜测恢复。
- 审批证据上限提高至单项8192字符、总计16384字符；超限仍明确阻止允许。拒绝理由送达同一个执行Agent，原操作继续拒绝，后续申请独立决定。
- 问题完整提供或明确不可答；需要脱敏改义的题目拒绝发布。裁剪优先保留待处理问题和已应用回执，避免重复作答或重复审批。
- MCP/插件版本从自身包清单读取；更新Codex托管规则和等待配置。识别已发布1.4.2及本地test.1/test.2原版模板，保留用户自定义规则。
- 候选真实验收：原生提问、拒绝反馈、972字符审批、90秒操作、集中审查、DSH实际重启续接、约21分23秒真实模型通道验收均通过。20分钟内无中间结果查询，外层客户端到期后续接同一调用。
- 1.5.0版本戳及测试版升级规则更新后，完整自动回归1468项通过，发布针对性检查160项通过。
- 等待阶段账单样本：token总量从9,986,839降至457,224，少95.42%；按任务时长折算少94.46%。这是不同任务的等待样本对照，旧任务含审批、新验收无审批，不代表整任务或所有用户的固定降幅；完整方法和同类动作对照见 `docs/releases/1.5.0-token-benchmark.zh.md`。
- 保留默认通用加载策略；不新增CLI执行通道或Claude Code一键安装。更新方法、验收范围与客户端限制见 `docs/releases/1.5.0.zh.md`。

## 1.4.2 — 移除 DSH 版本白名单，默认通用加载（2026-11-14）

- 删除 `engines.dsh`，将宿主提供的 `@deepseek-ai/dsh-*` peer 范围改为 `*`，不再因 DSH 版本号不在枚举列表中而拒绝安装或加载；包含截图所示的 `0.2.2-rc.3` 场景。
- 自定义插件索引不再生成 `engines` 字段，避免发现与安装通道继续使用旧白名单。Node 要求、开发依赖固定版本和现有运行时能力检查保持原有作用。
- 同步当前版本、安装说明和运行时说明，识别已发布 1.4.1 Codex 模板以支持升级，保留用户修改的规则。
- 本版仅调整版本准入与分发元数据，延续 1.4.1 的审查修复；不包含后续静默等待优化，也不声称所有宿主版本均已端到端实测。

## 1.4.1 — 历史补审、可靠保存与长审查意见（2026-11-14）

- **重启后仍能完成审查。** 原指挥端可用原任务 ID 读取已结束的历史记录并补审，再次重启后仍保留结论。沿用原任务归属校验，不恢复旧执行对象或旧审批权限；历史缺少的执行证据明确标记。
- **保存状态与实际落盘一致。** 区分保存中、等待超时但尚未确认、已保存和确定失败；保存前不显示已通过，晚到结果同步更新。相同审查并发共享写入，冲突结论明确拒绝，失败可重试；修复任务收尾覆盖已保存结论的竞态。
- **审查备注统一为 8000 Unicode 码点。** MCP、HTTP、引擎与历史存储使用同一约定；合法正文完整保存，超限或容量不足明确拒绝。以前已经丢失的备注尾部无法凭升级恢复。
- **页面自动更新审查结论。** 待审和保存中的记录继续每 5 秒后台刷新；隐藏暂停、恢复立即读取、保存确认后停止。历史补审保存状态同步显示；刷新失败保留已显示内容。
- **长备注按需读取。** 列表预览最多 200 码点，详情展开／收起和复制全文；复制不可用或失败时准确提示。等待只返回状态和长度，结果过大时明确省略正文，使用 `delegate_result` 的可选备注分页取回。
- **更新托管 Codex 规则。** 明确集中审查、保存确认及按需读取；识别原版 1.4.0 模板的 LF／CRLF 字节并升级，保留用户自行修改的文件。技术 MCP 名称与既有配置目录保持兼容。
- 完整自动回归 1283 项通过，源码同步后针对性验证 48 项通过；隔离安装包的真实 stdio MCP／本机 HTTP 通道完成跨两次重启补审与 8000 码点备注分页验证。正式 Desktop 人工点击和真实提供方任务不在本轮验收范围内。
- API／模型选择与现有执行通道保持兼容。本版不包含后续规划的外层静默等待优化、审批后直接续等和减少不必要提权申请，也不宣称新的 token 节省比例。验证边界见 `docs/releases/1.4.1.zh.md`。

## 1.4.0 — 静默等待、重复失败提醒与宿主审查闭环

- **长等待与集中审查。** Codex companion、MCP 说明和文档统一要求正常调用 `delegate_wait({ taskId })` 时省略短 `waitSeconds`。外层工具允许长 yield 时保持同一次等待；提前返回仍运行的单元则续接同一个单元，不重复派工、不反复读取中间代码。执行期间由程序观察，交付后由指挥端集中审查，需要修正时续接原任务。
- **澄清无活动监控。** 保留默认连续 5 分钟无活动时程序自检、10 分钟时请求指挥端判断。真实输出、思考和工具事件重新计时；心跳和页面刷新不重置。等待结束不代表执行结束，提醒不自动取消、重派、换模型或延长时限。
- **新增重复失败提醒。** `monitoring.repeatFailureThreshold` 默认 3，允许 0–20，0 关闭。只对相同工具、相同操作的连续相同结构化失败提醒一次；成功或失败身份变化重新计数。审批和任务结局优先，原始参数、错误正文和思考内容不进入提醒记录。高级设置、任务详情、历史与公开类型同步支持。
- **宿主审查写回。** 新增 `delegate_review`，由宿主审查后明确记录 accepted／changes-requested；任务页显示“审查通过”或“需要修正”。保留旧执行状态兼容，执行者不能通过交付自动验收，旧记录不补写虚构结论。审查写回不授予权限、不合并工作树、不修改执行路由。
- **阶段和兼容修复。** 执行尚未开始时保留 before-create，失败后同步失败阶段；晚到事件不覆盖审批或终态。补齐已发布 1.3.2 Codex 模板的精确识别和启动刷新；保留自定义智能体。旧监控配置及历史字段兼容，修复表单校验与保存时丢失其他草稿的问题。
- **验证与测量口径。** 当前客户端已完成真实墙钟 20 分 2 秒的模拟活动等待，中途零 GPT 续等；它不是提供方连续执行 20 分钟的任务。另做同聊天、同模型、每组约 45 秒的实际用量对照，等待阶段输入加输出从 507,885 降至 169,734 token，样本减少 66.58%。不将该比例宣传为完整任务、账单或所有客户端的固定节省。
- 本版未新增 CLI 执行通道或 Claude Code 一键安装。更新方法和验证边界见 `docs/releases/1.4.0.zh.md`，测量方法见 `docs/releases/1.4.0-token-benchmark.zh.md`。

## 1.3.2 — TaskBridge companion and descriptive task workspace names

- Rename the shipped Codex companion to `dsh-taskbridge` (`agents/dsh-taskbridge.toml`). Install and startup migrate an unchanged, recognized published `dsh-delegate.toml` and remove the old managed file; edited agent files remain operator-owned. Add TaskBridge CLI aliases while retaining the existing binaries and internal MCP identifiers.
- Add an optional `title` to `delegate_submit` and carry it through HTTP, the job engine and the native Workspace controller. Newly created Workspaces use a short description of the work rather than the worktree's `task-UUID` directory name. Older callers derive a title from the prompt's goal. Follow-ups and existing Workspaces keep their titles; duplicate titles receive a short suffix. No additional model call is made for naming.
- Explicit Codex install/repair can migrate a marked legacy MCP entry after the old package was uninstalled, when its missing package path is a known sibling of the current `dsh-taskbridge` installation. Custom wrappers, unrelated paths and automatic startup path adoption remain excluded.
- Update the settings page, companion dispatch rules and upgrade instructions. Model selection, delegation authorization, quiet waiting and host review retain their existing behavior.

- Make loopback HTTP test fixtures avoid Fetch-blocked ports, which Windows can allocate from a customized low dynamic-port range. This only affects tests.

## 1.3.1 — DSH TaskBridge identity and npm distribution

- Unify the project, GitHub repository, plugin title, package and bundle identity as **DSH TaskBridge** / `dsh-taskbridge`. The previous GitHub-only `dsh-taskdispatch` name was rejected by npm's similarity protection; it never became an npm package.
- Add npm installation instructions alongside the pinned-Git custom plugin index. Keep the 1.3.0 release and tag intact; use a new patch release for the different package identity.
- Retain existing task data, `delegate_*` tools, CLI names and managed Codex identifiers. Recognize the exact published 1.3.0 agent template and this project's historical repository identities during explicit migration.
- Update bilingual introductions and migration guidance. Execution, wait, permission and review behavior remains the same as 1.2.0; this release changes identity, distribution and compatibility metadata.
- Forward the control CLI's injected test dependencies into `runControl`; the entry-point refusal test now stays isolated from the operator's actual harness instead of accidentally depending on its response. Default CLI behavior is unchanged.

## 1.3.0 — DSH TaskDispatch identity and public plugin index

- Public package/bundle identity changes from `dsh-delegate` to `dsh-taskdispatch`; the display title is **DSH TaskDispatch**. Existing data paths, endpoint discovery, environment variables, MCP `delegate_*` tools, binaries and the managed Codex agent/server identifiers remain stable.
- Add English/Chinese plugin metadata, an SVG icon, a Chinese product introduction and manual Claude Code MCP instructions. The intro emphasizes configuring DSH's already-connected APIs, models and supported reasoning effort. No new context-window selector or Claude one-click installer is claimed.
- Enumerate the exact published 1.2.0 agent-template bytes so existing managed integrations remain refreshable. Explicit moved-install adoption requires this project's old/new repository provenance as well as real files and the exact bin mapping; an unrelated same-name npm package is refused.
- Add a dependency-free, exact-commit format-1 DSH plugin-index generator and an official-actions GitHub Pages deployment workflow. Search requires adding the project's custom index; this does not claim universal official marketplace inclusion or npm publication.
- Package identity migration requires stopping/uninstalling the old bundle while retaining plugin data, then installing the new bundle and explicitly repairing the managed Codex entry. Do not activate both bundles at once. Full real Desktop migration/restart and real Claude Code acceptance remain separate checks.

## 1.2.0 — waiting that cannot be mistaken for completion, and an independent control channel

Fixes the three problems the 1.1.0 real acceptance run reported: an `interrupted`
observation no longer claims the execution stopped, a local control channel serves
`status`/`cancel` while a host is blocked in a wait, and an already-installed managed Codex
integration upgrades itself. The operator's formally installed Desktop profile is still on
`1.1.0`; this change does not install `1.2.0` there. The complete Desktop upgrade/restart
acceptance and the actual token-saving ratio have not been measured; candidate-channel
acceptance evidence belongs in the Release notes.

### `interrupted` no longer claims the execution stopped

- The engine reports `interrupted` when an OBSERVER's own request ends — the caller's
  signal aborted, the connection dropped, the engine released the waiter during teardown.
  `delegate_wait` treated that as a terminal answer, so a host was told a healthy run had
  ended.
- The wait now decides from the TASK RECORD, not from the reason label
  (`classifyInterruption` / `resolveInterruption` in `src/mcp/wait.js`), and answers
  ONCE per observation:
  - `state` `pending`/`running` with no `endedAt` → the observation ended, the task did
    not. The answer is `reason: "interrupted"`, `terminal: false`, the REAL task state,
    and an instruction to wait again on the SAME `taskId`. The call does NOT re-issue
    an observation internally: a disposed observer answers `interrupted` to every
    request, so looping made one `delegate_wait` an unbounded request storm.
  - `state: "interrupted"` (a restart history this build never writes for a live run) →
    terminal, with an instruction to stop blind waiting and read `delegate_result`.
  - a settled state carried by an `interrupted` observation → the REAL outcome:
    `awaiting-host-review` is `ready` (so a finished run still reaches review),
    `failed`/`cancelled` report themselves.
  - a missing or UNRECOGNIZED state → nothing is asserted (`terminal: false`); an unknown
    state string is never treated as a restart history, and neither "stopped" nor "still
    running" is claimed.
  - `ready` never invents `state: "ready"`: with no task record the state is `null`.
- The task panel shows a real `interrupted` history as 「已中断（进程重启后不会继续执行）」 —
  never as "still running".

### An independent local control channel

- The plugin's own stdio MCP transport already serves concurrent requests; a serialising
  HOST is what blocks a session behind one long `delegate_wait`.
- New `dsh-delegate-control` binary (`bin/dsh-delegate-control.js`, registered in `bin`):
  `status <taskId>` (one bounded `observe` with `waitMs: STATUS_WAIT_MS`, i.e. 1 ms —
  the smallest positive bound the engine and the monitor both keep — compact JSON) and
  `cancel <taskId>` (stops exactly that task). Both use the existing
  `createExecutionClient` and endpoint discovery against the existing loopback plane.
- `status` used to send `waitMs: 0`. The HTTP route accepts 0, but the engine
  (`clampObserveWait`) and the monitor (`boundedWait`) both read a non-positive wait as
  "no bound requested" and substitute their 25 s default. Against a real running plane
  that made one status read last 25 s, past the command's own 10 s budget, and the
  observation retry then extended the command further — observed as an independent
  `status` timeout during the 1.2.0 candidate acceptance. The wait is now the smallest
  POSITIVE value, and the mock-only assertion on the request payload is replaced by
  tests that pin the real behaviour (see Tests).
- One whole-command budget now bounds everything: 10 s by default,
  `DSH_DELEGATE_CONTROL_TIMEOUT_MS` may only lower it, and a config with no usable
  `timeoutMs` still gets the 10 s default. It is enforced through a single caller
  `AbortSignal` composed with the request timeout, plus `{ retry: false }` on this call —
  the observation retry (1 s/2 s/5 s) is disabled for the control command so a dead or
  slow endpoint cannot outlive the budget or leave a request running after the answer.
  There is no `Promise.race` and no background request or process.
- Any disconnect or timeout is a bounded JSON document and a non-zero exit
  (`CONTROL_TIMEOUT` for an exhausted budget), with no stack trace and no secrets.
- No submit, no settings, no switch, no grant, no batch cancel, no daemon, no new endpoint,
  permission or configuration surface. Stable JSON on stdout, diagnostics on stderr,
  exit code 0/1/2 for answered/refused-or-timed-out/usage.
- The default MCP behaviour is unchanged: `delegate_wait` keeps its bounded retry, which
  is what lets a wait survive a DSH restart onto a new port. A normal wait never polls
  the control binary.
- A wait listener that goes away releases only that observation: cancellation is always an
  explicit `cancel`.
- The Codex companion gains one narrow rule: when the operator asks to stop or inspect the
  task AND the host is blocking the same MCP connection, it may run this binary from the
  same package directory as the configured MCP script. It may not call any other script,
  resubmit, or switch models, and during a normal wait it stays silent.
- Tool catalog now carries accurate MCP `annotations` (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`). They help a concurrency-aware client; they are not a
  fix for a serialising one, and nothing claims they are.

### Installed Codex integrations now upgrade themselves

- Plugin startup used to refresh only the agent file, so an MCP table installed by an
  earlier release stayed without `tool_timeout_sec = 3660`. A client may still end a wait
  earlier through its own default tool timeout (Codex's historical default is one minute);
  the managed entry now requests 3660 s, which a client that honours the field can grant,
  while a client-side cap that ignores it remains a client limit this plugin cannot lift.
- The startup check now also upgrades an ALREADY INSTALLED `mcp_servers.dsh-delegate` entry,
  and writes only what it can PROVE is its own: the marker comment, exactly this package's
  Node command, exactly ONE argument that is this installation's exact entry point
  (`isOwnedStaleEntry` / `isOwnedEntryScript`), and no foreign env key. A wrapper that
  reuses the marker, the command or even the file name is a `conflict` and is never
  rewritten; a differing arg count is a conflict too.
- Accepted migrations: an exact `args` match with only `tool_timeout_sec` missing (the core
  upgrade), and — by an EXPLICIT `install`/`repair` only — a different path that is proved to
  be a real installation of this package: real root/bin/entry objects, a manifest whose
  `name` is this package AND whose `bin["dsh-delegate-mcp"]` maps that entry (a `./` prefix
  is allowed; absolute, out-of-package, wrong or missing mappings are refused). The
  automatic startup check never adopts a moved path; it reports `conflict` and points at the
  button. The owned timeout and a proved moved entry script migrate in ONE write.
- The plan records a SHA-256 of the whole `config.toml` and the write re-reads the file and
  requires that digest to match — for the automatic migration AND for the explicit
  moved-install adoption, which re-proves the boundary, the digest and the current entry
  immediately before writing. A re-classification alone was NOT enough: a concurrent edit to
  an owned value still looks stale-and-managed, so it is now refused (`config-changed`) and
  the file is kept. The boundary (`$CODEX_HOME`, `agents/`) is re-inspected immediately
  before the write as well, and the pre-write document is copied to the plugin data
  directory (never into the package, never into the Codex home). The backup destination's
  ENTIRE ancestor chain is proved to be real directories — a link/junction above the backup
  directory refuses the upgrade, and missing levels are created one at a time and
  re-inspected.
- It never creates the entry, never adopts an unmarked or operator-edited entry, never
  follows a symlink/junction at `$CODEX_HOME` or `agents/` — the MCP half is now not even
  REPORTED by reading through a link — and never touches another MCP table or setting.
- The startup target is the SEAM's decision, not a second read of `process.env`: an explicit
  `CODEX_HOME` first, then the home a successful explicit install recorded in the plugin data
  directory, then the default only when it is a real directory. A default that is a link is
  reported (`default-is-link`) instead of walked, and a first run with no Codex home creates
  nothing.
- The 1.0.0 and 1.1.0 companions are enumerated by exact SHA-256 in both byte forms (CRLF and
  LF), taken from their RELEASE commits (`git show 2750047:…`, `git show 2d71708:…`) and kept as
  test fixtures, so an existing installation upgrades instead of being reported as somebody
  else's file. The explicit 安装 / 更新 button stays, and the status document now reports
  `mcp.drift` (which owned facts are stale) and a per-fact note.

### Tests

- `tests/mcp-wait.test.js`: the case that only proved one heartbeat is now a full
  1,200,000 ms simulation — 48 bounded 25-second observations, 47 heartbeats, ONE return,
  no heartbeat/diff/execution text in the answer. The interruption cases assert the
  single-observation contract: ONE observe per live interruption, a non-terminal answer on
  the same `taskId`, a terminal restart history, a settled record reported as `ready`/
  `failed`/`cancelled`, an UNKNOWN state asserted neither way, and no invented
  `state: "ready"`. Plus a listener-cancellation case that proves no task cancel is issued.
- `tests/control-cli.test.js`: the command contract, its refusals and exit codes, the
  lower-only request bound, bounded nested output, and — through REAL, asynchronously spawned
  `node dsh-delegate-control.js` child processes while the parent holds an HTTP plane and a
  parked MCP wait — that `status` and `cancel` both arrive before the wait ends and cancel
  exactly the named task. A bad environment, a missing discovery file and a dead endpoint
  are each bounded JSON refusals with a non-zero exit. The `status` case now pins the
  defect it exists for with the REAL serving side — a `JobEngine` running a real task over a
  real temporary workspace with its own `TaskMonitor`, behind the real
  `createExecutionHandler` on a loopback HTTP server (only the native services every engine
  test fakes are faked; the task really stays `running` because its prompt never finishes):
  a separate `node dsh-delegate-control.js` child must report that running task inside its
  own budget while the parent's `delegate_wait` is still parked, and a second child must
  cancel the SAME task so the parked wait then returns `cancelled`. Because the engine's
  own `clampObserveWait` and the monitor's own `boundedWait` decide the wait, a `status`
  that sent `waitMs: 0` again would be parked for their real 25 s fallback and fail the
  child's 10 s budget with `CONTROL_TIMEOUT` — the failure observed on the live plane. The
  request is asserted to carry `waitMs: 1` and `{ retry: false }`; and separate cases
  cover the whole-command budget (`CONTROL_TIMEOUT`), a missing/unusable config timeout,
  and refusals thrown with unusual error shapes.
- `tests/mcp.test.js`: a caller's `{ retry: false }` makes exactly one `observe` attempt
  with no backoff, while no context, `{}` and `{ retry: true }` all keep the documented
  1 s/2 s/5 s schedule — the MCP wait's restart-following behaviour is unchanged.
- `tests/codex-integration.test.js`: the write gate (wrapper refused, extra args refused, the
  core missing-timeout case accepted), an end-to-end startup run that never rewrites a
  wrapper, the DETERMINISTIC check-then-write race (the config changes after the plan; the
  digest comparison refuses and the edit survives), the same race between the explicit
  moved-install proof and its write, the boundary re-check (including a link appearing after
  the proof), the backup (including a linked ANCESTOR and a non-directory ancestor, plus
  missing levels that must be created), the seam-resolved startup target (explicit /
  recorded / real default / linked default / none), the moved-install proof matrix (real
  manifest + `bin` mapping accepted; missing, wrong, absolute, out-of-package and trailing-
  slash mappings refused; POSIX package root preserved), and the real 1.0.0 and 1.1.0
  fixture upgrades (packed and LF, unchanged and edited).
  Both guards are mutation-tested: disabling the digest check or the ownership rule makes
  these tests fail.

### Known limits

- The operator's formally installed Desktop profile is still on `1.1.0`; `1.2.0` was not
  installed there by this change. The complete Desktop upgrade/restart acceptance and the
  actual token-saving ratio have not been measured; the candidate MCP/CLI channel is
  exercised against the currently running plane before release, and that evidence belongs
  in the Release notes rather than being pre-filled here.
- The control channel's behaviour against a specifically serialising host was not observed
  live; the tests use a mock plane and a real stdio fixture.
- Annotations do not make a serialising client concurrent.
- `tool_timeout_sec` is a request to the client. A client that ignores it (or applies its
  own default tool timeout) can still end a wait early; the plugin cannot prove otherwise
  for every client.
- The 1.1.0 published agent bytes are enumerated as packed (CRLF) and as LF; any other byte
  form of that release is not claimed to be refreshable.

## 1.1.0 — silent waiting and concentrated host review

Candidate feature release. Ships the monitoring foundation, the browser settings and task
panels, the Codex companion's wait-based dispatch rules and the managed Codex config
migration. It is **not** published and **not** installed by this change.

The transport that actually returns `delegate_wait` results (HTTP execution-plane and MCP
tool) lands in the same release but a separate change; until both are present, the
companion's new rules describe the contract the tool will honour, and the legacy
`delegate_result` polling path still works.

### Waiting no longer means polling

- New global setting `monitoring = { selfCheckSeconds: 300, attentionSeconds: 600 }`,
  stored as whole seconds, validated (self-check 30–3600, attention greater than the
  self-check and at most 7200). Missing blocks use the defaults, so an existing
  document keeps loading unchanged.
- A running task now reports bounded activity metadata: last activity time, how long it
  has been idle, the current tool call and how long it has run, event counters, and the
  last self-check verdict. It carries **no** transcript, reasoning, tool arguments or
  diff, so a task view can show progress without becoming a second transcript.
- At the self-check interval the engine performs one read-only local inspection of the
  executor it already holds (alive, phase, pending permission, current tool). No model
  call, no workspace read, no state change, no deadline change.
- At the attention interval it reports `attention` instead of staying silent. Idle time
  is the only trigger: a single long tool call is not proof of progress, and nothing is
  failed, cancelled or restarted for duration alone.
- Real progress resets the silence and stays internal, so a healthy run never wakes the
  dispatcher. Connection heartbeats, result polling and page refreshes never reset it.
- Attention reports are delivered once per silence and then cooled down; concurrent
  observers cannot both deliver the same one.

### Settings page

- New advanced monitoring controls in the existing execution panel: 5 and 10 minutes by
  default, shown in minutes, stored as integer seconds, with local validation and a
  narrow "save monitoring only" action. A general settings save persists them too.
- The page states the behaviour it relies on: the checks are local, no LLM is called,
  no-progress is not failure, and changes apply to newly submitted tasks only.
- New authenticated route `POST /api/dsh-delegate/monitoring`. It is a browser-plane
  operator action; the MCP surface still has no settings write.

### Task records

- Task rows and the detail view show the phase, the last activity, the current tool and
  its elapsed time, and the no-progress diagnostic in plain Chinese. A record written
  before this feature says "no progress information was collected" instead of inventing
  an idle time.
- The task tab refreshes itself every 5 seconds **only** while it is visible and at least
  one task is still pending or running. It skips a hidden document, never overlaps a
  request, cleans up its timer on tab change and unmount, and never reads or writes
  settings. Terminal tasks stop the refresh.
- No completion percentage is estimated or displayed.

### Codex companion

- Dispatch is now submit → `delegate_wait` on the same task id, repeated until a reason
  is actionable. `heartbeat` is internal and never reaches the model.
- Each reason has a stated policy: `attention` is a question and the default answer is to
  keep waiting; `permission` is a decision on one call followed by waiting the same task;
  `ready`/`failed`/`cancelled` read `delegate_result` once for full evidence;
  `interrupted` and `wait-limit` immediately re-wait the same task.
- Corrections are consolidated into a follow-up `continueFromTaskId` submission using the
  same authorized source path.
- Explicitly forbids the parent commander and the dispatch companion from implementing
  locally while a delegated worker runs, except for an explicit user-authorized takeover.

### Managed Codex config

- The managed `[mcp_servers.dsh-delegate]` entry now carries `tool_timeout_sec = 3660`,
  so a default 60-minute wait can complete. The value is written on this entry only.
- A managed entry from an earlier release without the field is repaired in place, and
  unrelated configuration is preserved byte for byte. An unmarked or differently shaped
  same-name entry is still treated as operator-owned and never overwritten.
- The published 1.0.0 companion is enumerated by exact SHA-256 (CRLF and LF byte forms),
  so an existing 1.0.0 installation updates through the settings page instead of being
  reported as somebody else's file.

### Known limits

- This release does not promise zero model tokens or a measured token saving. It changes
  what a dispatcher is told and when.
- Wait-return counts and timing metrics come from the transport change, not from this one.

## 1.0.0 — first formal release

The first public major release of `dsh-delegate`. It is distributed from the GitHub
Release as `dsh-delegate-1.0.0.tgz`.

- Adds the commander-mediated, per-call permission decision tool while keeping the
  local switch as the single enable/disable control.
- Publishes the Codex companion migration for existing managed `0.1.14` installations.
- Includes workspace isolation, continuation placement, model/provider selection,
  optional read-only review, Codex integration, and the documented fail-closed runtime
  checks.
- Production Desktop provider execution, sandbox commands, and permission-resume flows
  remain explicitly marked as unverified where the compatibility documents say so.

## 0.1.14 — local build (candidate package, not a public release)

Per-call, commander-mediated approval for delegated worker runs, plus the release
packaging that was deferred from the core batch. The package is built and packed locally
as `dsh-delegate-0.1.14.tgz` for review; it is **not** published to npm and it is **not**
installed on the production Desktop profile.

### Status: what is and is not proven

- **Proven by tests in this repository:** the bridge, its refusals, its redaction, its
  deadlines, the durable evidence and the MCP projection all pass their own suites, and
  the archived manifest contains the updated native module, the sixth MCP tool, the current
  client bundle, the managed Codex companion and the docs.
- **NOT yet proven: production acceptance.** The `0.1.13` build currently installed on the
  production Desktop profile must be upgraded through the Desktop plugin manager, and the
  MCP server must be reconnected (or a new session started) before the sixth tool
  `delegate_permission_decide` is visible to a host. Until a real end-to-end
  provider → commander → resume run has been observed on that profile, the production
  feature is **unverified**. A passing unit-test count, and any mock or scripted stand-in,
  is **not** that test and must not be reported as one.

### The worker can now ask for wider access for ONE call, and only the commander answers

Every delegated worker run previously installed `approval/policy: "never"`, because the
plugin had no way to answer a native approval prompt: an escalation was refused
deterministically. That is still the default. What is added is one narrow, armed path:

- A new module `src/runtime/permissions.js` holds the bridge. While the commander follows
  a task, a native DSH approval request (`ctx.on('approval/request', …)` on that Agent's
  own scope) **pauses exactly that tool call**, and the request is exposed through the
  existing `delegate_result` view as `permission.pending`.
- The real operation is read from the **native Session log**: the committed `tool/call`
  event is matched by `callId` and its model-produced `arguments` JSON is parsed. The
  asker's own `reason` prose is carried beside it labelled `reasonSource: "asker-claim"`
  and is never treated as the operation.
- A new bounded MCP tool `delegate_permission_decide` (route
  `POST /dsh-delegate/x/tasks/permission`) answers `allow-once` or `reject`. It refuses an
  unknown task, another connection's task, an unknown or already-settled request, a
  request past its deadline, and a fingerprint that does not match the pending operation.
- The approval stance is `ask` **only** when the run carries an armed bridge bound to the
  Agent it drives; otherwise it stays `never`. Both are written and **read back** through
  `ctx.approval.effectivePolicy(session)`, so an `ask` nobody services is never installed.
  A bridge that cannot be armed refuses the run before the prompt with
  `RUN_PERMISSION_BRIDGE_UNAVAILABLE`.
- The standing sandbox mode stays `workspace-write` for the whole run; no decision writes
  `danger-full-access` into a Session, and a grant is `appliesTo: this-call-only`,
  `reusable: false`.

### State, lifetimes and evidence

- Task state semantics are unchanged: a waiting task is still `running`, with phase
  `awaiting-permission` and a `permission` block. It is neither failed nor
  execution-complete, and it keeps its workspace lock, concurrency slot and provider
  lease until the native executor actually settles.
- The approval wait has its **own** fixed, bounded deadline (default 10 minutes, capped at
  30) and is NOT charged to `worker.timeoutSeconds`; `permission.pausedExecutionMs`
  reports the time actually spent waiting.
- Cancellation, switch-off, revocation, agent disposal, plugin teardown and that deadline
  all settle the outstanding waiter and release the request's timer and abort listener.
  A restart begins with no tasks, no bridge and no request, so an interrupted request can
  never be replayed as an allow.
- The settled trail is bounded (last 8) and every published string is redacted and
  truncated; the exact private fingerprint still binds the decision.

### UI, docs and contracts

- The task panel shows, in plain Chinese, that a task is waiting on one call, the
  redacted arguments, the worker's claimed reason (labelled as a claim), the deadline and
  the decision trail. It offers **no** manual approve button: the decision belongs to the
  commander over MCP.
- `SPEC.md` states the narrow exception to the "MCP cannot widen a grant" rule, including
  what the tool cannot do. `docs/worker-permissions.md`, `docs/auth-contract.md`,
  `docs/runtime-compatibility.md` and `README.md` are updated to match, and the
  same-local-user threat-model limitation is stated rather than glossed over.
- `tests/permissions.test.js` covers the bridge against the installed native
  `ApprovalService`: locating the real call, the `ask`/`never` stance split, allow-once
  resuming one call exactly once and the next escalation asking again, reject, expiry,
  fingerprint substitution, redaction, cancellation, disposal, foreign requests, the
  engine's phase/slot behaviour, cross-owner and post-terminal refusals, restart, and the
  plane route's validation and switch gate.

### Repair round: independent review R1–R9

The provisional review found that several claims were not backed by behaviour. Each is now
a checked fact with a regression test:

- **R1 (live re-verification).** A decision no longer trusts the copy captured at ask time.
  An `allow-once` re-reads the `tool/call` at its recorded Session offset and requires
  byte-identical arguments, the same `callId`, the same tool name, and a turn that is still
  OPEN. A mutated record, a missing record and a closed turn are all
  `PERMISSION_REQUEST_CHANGED`. (The turn check had to scan from the END of the log — a scan
  starting at the call would stop at the `turn/start` behind it and never see a later close.)
- **R2 (key-aware redaction).** A key whose NAME holds a credential has its whole value
  masked, so `{"apiKey":"…"}` can no longer be published verbatim; the module's default
  redaction now also mirrors the production `NAME=value` / bearer patterns so a bridge built
  without injection is not weaker. Applied to the pending view, the decision reason and the
  stored trail.
- **R3 (completeness gates an allow).** Every bound that fires is counted, and the request
  publishes `completeness` / `argumentsComplete` / `boundsApplied` / `omitted` /
  `allowBlocked`. An `allow-once` on a shortened operation (a `bash.command` whose tail was
  cut) is refused with `PERMISSION_EVIDENCE_INCOMPLETE`; `reject` stays available because
  refusing is always safe.
- **R4 (exact Agent identity).** `owns()` now requires the exact bound live Agent object and
  rejects a request with no Agent at all — the previous `agent ?? null` check made a missing
  agent match every bridge.
- **R5 (honest wording).** "The worker cannot self-approve" is restated as a **tool-surface
  restriction**, explicitly NOT a hard boundary against arbitrary same-OS-user code; the
  shared `local-mcp` identity and the absence of a user-managed token are stated, and no
  claim rests on a caller-supplied role label.
- **R6 (the execution deadline really pauses).** The single `setTimeout` is replaced by
  `ExecutionDeadline`: a wait clears the timer and charges the elapsed span, resume re-arms
  only what is left, and repeated waits accumulate. A regression drives a REAL native
  approval wait of 220 ms inside a run whose budget is 40 ms and proves the run is not
  reported `timed_out`.
- **R7 (durable evidence).** `HistoryStore.projectView` now stores a bounded, re-redacted
  `permission` block. A restart rewrites a stored pending request as
  `unavailable` / `decidedBy: "restart"` history; the private fingerprint and exact argument
  text are never stored, so a record cannot be replayed into an allow.
- **R8 (waterfall ordering).** The bridge registers its `approval/request` listener with
  `prepend: true`, because the native seam is a cordis waterfall and an appended listener
  never runs once a pre-existing UI answerer claims the question. Proven against a real
  `ApprovalService` with a pre-existing answerer: the delegated request reaches the
  commander, the UI answerer is never consulted, and an ordinary session still falls through
  to its own answerer.
- **R9 (proto-safe hashing).** The fingerprint is computed over a hand-written canonical
  serializer instead of a `JSON.stringify` replacer, so a key named `__proto__` is no longer
  swallowed by the prototype setter and two different JSON objects cannot collide.
- **Fingerprint is mandatory for `allow-once`** (optional for `reject`), and decisions are
  validated before any request lookup or mutation.
- Also proven behaviourally, not by constants: switching delegation OFF settles the wait as
  `cancelled`, a plugin dispose settles it as `unavailable`, and a task whose native executor
  has not settled keeps its workspace lock and concurrency slot (`JOB_NATIVE_NOT_STOPPED`).

`tests/permissions.test.js` grew from 25 to 51 tests covering all of the above.

### Release packaging in this build

- Version `0.1.14` is set consistently in `package.json`, both `package-lock.json` root
  fields, the native `PLUGIN_VERSION`, the MCP `SERVER_INFO`, the managed Codex companion's
  `version` marker and the release-test constants.
- The managed Codex companion now carries the commander's **per-call decision rules**:
  a task in phase `awaiting-permission` is still running (never duplicate, fail or cancel it
  for waiting), the coordinating Codex is the decider (no second approval model, no operator
  prompt for routine within-task calls, no delegation of the decision to the worker), the
  worker's `reason` is a claim rather than authority, and an allow requires
  `argumentsComplete: true`, `completeness: complete`, no `allowBlocked`, no transport
  truncation, a still-pending request and its exact fingerprint. Its existing activation,
  explicit-continuation, route-from-DSH and source-path rules are unchanged.
- The published `0.1.13` companion template is now enumerated in `KNOWN_AGENT_TEMPLATES`
  by its exact SHA-256 (`b3a1d2f0…`, 9191 bytes, CRLF, verified against the packed
  `dsh-delegate-0.1.13.tgz`). An unchanged `0.1.13` file is refreshed; a file the operator
  edited still hashes differently and is preserved and reported `modified`. There is no
  implicit new installation and no startup edit of `config.toml` or the MCP entry.
- Two small corrections: a fully restored pending operation no longer reports a phantom
  `truncation.fields` entry at the skeleton projection stage (only real final cuts are
  reported, and a genuinely cut operation still cannot be allowed), the zero-keep stage
  really drops the settled evidence it declares dropped, and a successful task checkpoint is
  no longer discarded by a *different* task's newer checkpoint.

### Known unfinished work (not claimed as solved in this build)

- **No process authentication against arbitrary same-user code.** Switch mode
  deliberately uses one shared `local-mcp` identity; the decision is scoped to that
  connection's OWN tasks, but this is not a per-process boundary and the docs say so.
  `delegate_permission_decide` is absent from the native worker's declared tool catalog,
  which is a **tool-surface restriction** on what the worker's model is handed — it is not
  a claim that a shell process running as the same OS user could not call the shared local
  MCP endpoint directly.
- **Not published and not installed.** This is a candidate package: no npm publication, no
  Desktop profile upgrade, no switch change, no production acceptance run. See the status
  section above for the exact steps still required.
- 12 test failures in `tests/continuation-auth.test.js` (11) and
  `tests/controller-lifecycle.test.js` (1) are **pre-existing** in the source baseline
  (`ff`-identical failure sets before and after this batch) and are unrelated to it.

## 0.1.13 — local build (not a public release)

A source-path contract fix. It is packed locally for review; it is not published to npm
and is not a distribution release. Nothing about the execution engine changed.

### The MCP description no longer invites the wrong `workspacePath` on a follow-up

Observed on a real Desktop `0.2.2` / Delegate `0.1.12` session: a caller read the tool
description, passed the **previous task's execution worktree** as `workspacePath`, and
was refused with `JOB_CONTINUATION_REFUSED` (`another source repository`). The engine was
already correct — an authorization and a continuation are both bound to the source
repository, and a continuation reuses the parent's worktree internally — so the defect
was purely in what the tool surface told the caller. Passing the original source
repository instead continued the same session successfully on the same machine.

- `delegate_submit`'s description, the `workspacePath` and `continueFromTaskId` parameter
  descriptions, and the `initialize` instructions now state one rule: `workspacePath` is
  the operator-authorized **source repository or checkout**, and a follow-up keeps
  passing the parent's **original** source path while the plugin reuses the parent's
  execution worktree or session internally.
- The rule is scoped to `delegate_submit` and continuation. It does not claim every tool
  is bound to the authorization (`delegate_preflight` is a read-only inspection), and it
  does **not** exclude legitimate sources: a source root may itself be a Git checkout or
  an operator-authorized Git worktree. Only substituting an internal
  `execution.workspacePath` for the parent's original source path is refused.
- The wording is a clarification only. No parameter, tool or behaviour was added; the
  five-tool closed set, the closed input schemas and every path / ownership / isolation
  check in the engine are unchanged, and no validation was relaxed.
- `tests/mcp.test.js` gains a public-contract regression that reads the real `initialize`
  and `tools/list` responses off a real server — not a private constant — and asserts the
  source-path rule for both parameters plus the handshake, the automatic internal reuse,
  the fail-closed refusal (never a silent new conversation), the unchanged tool set and
  the closed schema. It asserts properties rather than exact sentences.

### Codex agent-template migration

- The published `0.1.12` template is now enumerated in `KNOWN_AGENT_TEMPLATES`
  (`ff04a4bf…`). The digest was verified byte for byte, before this release's template
  edit, against `package/codex/dsh-delegate.toml` inside the packed
  `dsh-delegate-0.1.12.tgz` and against the saved release baseline; both were identical
  to the pre-fix working tree. An unchanged `0.1.12` file is refreshed to `0.1.13` on
  plugin startup and by an explicit install.
- **No earlier digest was removed or replaced.** The `0.1.6`, both `0.1.7` builds,
  `0.1.8`, `0.1.9`, both `0.1.10` byte forms and `0.1.11` remain enumerated, so a machine
  that skipped `0.1.12` is migrated directly to this build.
- Ownership is still byte identity, never the version line: a user-edited agent file is
  reported `modified` and is never written, refreshed or removed, by startup migration or
  by an explicit install. The `0.1.11` migration coverage is retained and generalized, and
  the `0.1.12` → `0.1.13` step is covered for startup refresh, explicit status/install,
  and edit preservation.
- Because the companion body did not change in this release, the older release bytes are
  rebuilt for the tests from the current template by rewriting only the version line, and
  against an explicitly stated CRLF byte form; each reconstruction is proved against a
  fixed published digest. The tests depend on no saved cache, fixture or machine-specific
  path.

### Packaging and metadata

- Version bumped to `0.1.13` in `package.json`, both `package-lock.json` root fields,
  `PLUGIN_VERSION`, the MCP `SERVER_INFO` and the shipped Codex agent template
  (`codex/dsh-delegate.toml`). `README.md` and `docs/codex-integration.md` name the
  current package and release; historical release facts are unchanged.
- No dependency was installed or upgraded, no locked `resolved` version moved, the
  production dependency graph and `pnpm-lock.yaml` are unchanged, and no agent body rule
  was edited.

### Known unfinished work (not claimed as solved)

- **Not verified:** `0.1.13` has not been installed or accepted on a Desktop profile. The
  successful three-round real-machine continuation evidence belongs to **`0.1.12`**, the
  previous build, and is the reason this fix exists — it is not an acceptance of this
  build.
- The delegation switch being `OFF` and cancellation of an in-flight task were **not**
  exercised against this build; their coverage here remains the earlier automated tests.
- Real attached review (a review agent reading a live run) was not exercised in this
  build.
- The wording is regression-tested as a property of the advertised strings, not against a
  live model's interpretation; only a real host session can show how a caller reads it.

## 0.1.12 — local build (not a public release)

A runtime-compatibility build for DSH `0.2.2-rc.1`. It is packed locally for review;
it is not published to npm and is not a distribution release.

### DSH 0.2.2-rc.1 is now an admitted runtime

- `engines.dsh` and every `@deepseek-ai/dsh-*` peer range now read
  `0.2.0-rc.2 || 0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.2-rc.1`.
- **Nothing was dropped.** Every previously declared exact version is still admitted;
  the development cohort (`devDependencies`, all `0.2.0-rc.2`) is unchanged, the
  production dependency graph is unchanged, and no locked `resolved` version moved.
  No `pnpm install` was run.
- A plugin build that does not declare `0.2.2-rc.1` (`0.1.11` and earlier) is skipped by
  that host's native gate (`skippedBundles` / denied row) rather than loaded with
  unknown behaviour.

### What 0.2.2 changed, and how the plugin adapts

Detailed in the new `docs/runtime-compatibility.md`; the runtime implementation is
reviewed separately from this release-metadata work.

- **Durable model selection.** `0.2.2` gives each agent
  `agent.model.select({ provider, model, reasoningEffort? })`, which appends a durable
  `model/selection` event, and `agent.model.current()`, which returns the recorded
  selection (falling back to the agent's own options). The agent loop fixes a step's
  route from that record and rejects a request that proposes a different one, so the
  route that executes is the one the runtime *records*.
- **Asynchronous native policy initialization.** `ctx.sandboxPolicy` and
  `ctx.approval` register their Session projections during service initialization. The
  worker contract is unchanged — write, then read back through the native services —
  but the read-back now happens per run, after those services can answer, and a service
  that cannot answer remains the fail-closed `RUN_SANDBOX_POLICY_UNAVAILABLE` raised
  before the prompt.
- The plugin branches on **observed capabilities**, not on a version string: a modern
  path where the selection API and the initialized services exist, a legacy path
  otherwise. A selection read-back that cannot be obtained is a strict failure before
  the prompt on every path — never a run under an unstated route, and never a claimed
  concrete reasoning effort for a selection that omitted one.

### Codex agent-template migration

- The published `0.1.11` agent template is now enumerated in
  `KNOWN_AGENT_TEMPLATES` (`b6ca7c32…`, the digest of the packed
  `dsh-delegate-0.1.11.tgz`). An unchanged `0.1.11` file is refreshed to `0.1.12` on
  plugin startup and by an explicit install; a user-edited file is still reported
  `modified` and is never written, refreshed or removed.
- **`0.1.10` now carries two exact digests instead of one.** The packed
  `dsh-delegate-0.1.10.tgz` contains a CRLF `package/codex/dsh-delegate.toml`
  (`fc7b2710…`); the same template kept as LF text is `6583f08a…`. Either form can be an
  installed file, so both are enumerated and neither replaces the other. The product
  compares exact bytes: it never normalizes line endings and never rewrites a file to
  change them, and no earlier hash was removed.
- `0.1.11` was delivered as an uncommitted candidate plus a verified tarball (the last
  commit, `a750c0b`, is `0.1.10`), so its digest `b6ca7c32…` is cited from the tarball and
  the saved baseline, not from a `0.1.11` commit.
- Ownership protection is unchanged and is not weakened: content identity, not the
  version line, remains the proof, and every earlier digest is still enumerated.

### Packaging and metadata

- Version bumped to `0.1.12` in `package.json`, both `package-lock.json` root fields,
  `PLUGIN_VERSION`, the MCP `SERVER_INFO`, and the shipped Codex agent template
  (`codex/dsh-delegate.toml`).
- `docs/runtime-compatibility.md` is added to the published `files` allowlist. Unlike
  the internal notes, it is an operator-facing document: it is the supported-version
  table and the upgrade guidance a consumer needs.

### Documentation

- New `docs/runtime-compatibility.md`: the supported-version table, what `0.2.2`
  introduces, the capability-based modern/legacy split, the upgrade path, and an
  explicit list of what is *not* claimed.
- `README.md`: the supported-version row, the version-gate note, the `0.2.2` behaviour
  summary and the honest limits section.
- `docs/codex-integration.md`: the digest table for `0.1.10` (both byte forms) and
  `0.1.11`, and the statement that the product does not normalize line endings.
- `docs/worker-permissions.md`: the `0.2.2` asynchronous initialization note, and the
  corrected scope of the review exclusion (only the sandbox policy is worker-only; the
  reviewer uses the same model-selection adapter).

### Known unfinished work (not released as solved)

- **Not verified:** a real provider call, an actual sandbox command under the installed
  policy, and an end-to-end run on the production DSH Desktop profile. The native checks
  below intercepted prompt delivery inside a disposable fixture.
- `0.2.1-rc.3` was **not** independently native-boot validated for this release. It stays
  declared as supported on the strength of the previous host build.
- The OS temporary area remains a native platform exception; on Windows the native
  sandbox admits `GetTempPathW` in some configurations, which is not a permission this
  plugin grants.
- Node child-process checks that capture piped stdio hit `EPERM` in this repository's
  confined Windows sandbox; that is a boundary of that confinement.
- A verification run outside the Desktop process is not evidence about the Desktop
  process's own sandbox.

### Native verification on 0.2.2-rc.1 (contract checks, not an acceptance run)

- The full base + web + delegate profile loads with no skipped bundles; a real stdio MCP
  `initialize` returns `0.1.12` with five tools and discovers the endpoint;
  `delegate_status` works and an `OFF` submit is refused with `DELEGATION_DISABLED`.
- Real native Workspace/Session controllers, Agent and AgentModel were used. The runner
  selected and read back its route and effort before prompt delivery, a follow-up reused
  the native session and changed both, and a deliberately wrong readback was refused
  before the prompt. The native create/setup runner path also passed.
- The policy read back `workspace-write` / `never`, and an escalation inside a valid turn
  was rejected in under 1 ms.
- The `SessionSeq` / `surfaceOp` failures seen in intermediate runs were **coordinator
  test-driver mistakes** — the synthetic event driver omitted native event sequence and
  surface metadata. They were fixed in the driver with no product code change and are not
  open product bugs.

## 0.1.11 — local build (not a public release)

A permission and continuity build. It is packed locally for review; it is not
published to npm and is not a distribution release.

### Delegated worker sessions are confined and verified

- A worker run now installs `sandbox/mode: workspace-write` and
  `approval/policy: never` on its own DSH session **before** the prompt is
  delivered, and then **reads the policy back** through the native
  `ctx.sandboxPolicy.resolve({ session })` and
  `ctx.approval.effectivePolicy(session)` services.
- The policy is applied on every run, including a `continueFromTaskId` follow-up, so
  a resumed thread converges on the current contract.
- A missing service, a refused read, or a read-back that disagrees with what was
  written is a fail-closed refusal (`RUN_SANDBOX_POLICY_UNAVAILABLE`) raised before
  the prompt: the worker does not start, and no permissive default is substituted.
- `never` is deterministic rejection of an escalation, not automatic approval.
- The read-only review agent is unchanged: its own composition and tool surface are
  not affected by worker permissions.

### Path identity

- The sandbox module compares a session's workspace root with its own directory
  through the shared `sameSessionPath` identity instead of a private copy, so
  Windows separators, trailing slashes, root paths and letter case are judged in one
  place. The fail-closed checks and the policy read-back are unchanged.

### Worktrees stay in the plugin data directory

- Plugin-managed worktrees continue to live under
  `<dataDir>/worktrees`, inside the plugin's persistent data directory, so a review
  still finds the evidence and a follow-up still finds its parent tree. No real
  directory or ACL was changed by this release.

### Packaging and metadata

- Version bumped to `0.1.11` in `package.json`, both `package-lock.json` root fields,
  `PLUGIN_VERSION`, the MCP `SERVER_INFO`, and the shipped Codex agent template
  (`codex/dsh-delegate.toml`).
- The endpoint-discovery error no longer hard-codes a release version in its text.
- The native packages the tests load directly are now declared as devDependencies:
  `@deepseek-ai/dsh-sandbox-policy`, `@deepseek-ai/dsh-user-approval`,
  `@deepseek-ai/dsh-session-projection`, `@deepseek-ai/dsh-session` (all
  `0.2.0-rc.2`, matching the existing development cohort) and
  `@deepseek-ai/cordis` (`4.0.5`, as already locked). Both lockfiles were updated in
  place from entries that already existed; no dependency was upgraded.
- The Codex agent-template migration table still lists every earlier published hash
  and still refuses to touch a user-modified file.

### Continuations belong to one verified connection

- A `continueFromTaskId` follow-up may join a thread only when the **same verified
  `connectionId`** submits it. The caller's identity is the authenticated connection
  record, never a field the request states about itself.
- In the same process the live parent record states the owner and the outcome, and the
  two ids are compared exactly.
- After a restart the persisted task→session map only says where a thread lives, so a
  second authority is consulted: the durable job history (`HistoryStore`) must state
  the same owner, a terminal state a thread can be continued from, and the same
  source repository and execution directory.
- A missing, damaged, pruned or otherwise unprovable record is refused. So is another
  connection's task: it is reported as `JOB_TASK_NOT_FOUND`, indistinguishable from an
  unknown id, so the response cannot be used to probe other connections' task ids.
  There is no cross-connection take-over, no permission hand-off, and no matching by
  connection label.
- `local-mcp` (the local-switch path) is a fixed identity compared exactly like any
  other; it is not `null` and it does not stand for every remote connection.
- This capability is implemented in the current candidate build. Its acceptance is
  reported separately by Codex; this changelog does not claim a passing real install
  on DSH Desktop, nor a reproduced real attack.

### Documentation

- `README.md`: current package filename, a short summary of the worker permission
  contract, the continuation identity rule, and the stale test count removed.
- `docs/worker-permissions.md`: the full contract, the continuation ownership rule,
  what was verified, and what is still open.

### Known unfinished work (not released as solved)

- Real-install acceptance on DSH Desktop.
- The OS temporary area remains a native platform exception.
- Node child-process checks that capture piped stdio currently hit `EPERM` in this
  repository's confined Windows sandbox; that is a boundary of that confinement, not
  a failure of the approval fix.
- A verification run outside the Desktop process is not evidence about the Desktop
  process's own sandbox.
