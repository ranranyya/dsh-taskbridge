# DSH TaskBridge

**Keep architecture planning and final code review in Codex or Antigravity. Delegate heavy coding and test loops to DeepSeek Harness (DSH) inside a clean black-box MCP bridge.**

> **Version `1.9.0` · Native one-click integration for Codex and Antigravity. Claude Code / Claude Desktop support is planned for 2.0.**

[简体中文](INTRODUCTION.zh.md) · [Why TaskBridge](#why-taskbridge) · [1.9.0 Benchmark Results & Takeaways](#190-benchmark-results--takeaways) · [Key Capabilities](#key-capabilities) · [Quick Start](#quick-start) · [How It Works](#how-it-works) · [FAQ](#faq) · [Changelog](../CHANGELOG.md)

**DSH TaskBridge** is a cross-client task delegation plugin for **DeepSeek Harness (DSH)**.
Stay inside **Codex** or **Antigravity** to inspect repositories, design interfaces, decompose multi-stage work, and review delivered diffs — while offloading verbose code generation and iterative test-fixing loops to cost-effective or custom models configured in DSH over 11 bounded `delegate_*` MCP tools.

To the commander, execution is a **controlled black-box workshop**: API credentials, provider/model routing, reasoning effort, Git `worktree` isolation, cross-subtask worktree reuse, and native DSH sessions stay encapsulated inside the plugin. The commander focuses strictly on **direction, boundary approvals, and pragmatic acceptance**.

![DSH TaskBridge four-layer architecture. Users and developers access the shared dispatch core, MCP protocol, and DSH execution engine through host adapters.](./assets/taskbridge-workflow.en.svg)

## Why TaskBridge

Frontier reasoning models excel at system design and code review, yet burning their quota on boilerplate implementation and repetitive test debugging gets expensive fast — while manually copying prompts and diffs across windows quickly loses context. TaskBridge connects both sides through a four-layer architecture:

- **L1 Host-native zero-busy-wait adapters:**
  - **Codex (`1.9.0` Native Skill):** Installs a compact entry `skills/dsh-taskbridge/SKILL.md` plus an on-demand reference appendix so the active Codex session drives a single direct `delegate_submit({ autoPreflight: true, wait: true })` + `delegate_wait` chain (`tool_timeout_sec = 3660`), completely eliminating legacy `spawn_agent` + short-timeout `wait_agent` polling loops while safely retiring untouched legacy `.toml` subagents.
  - **Antigravity (Self-contained plugin bundle):** Offloads preflight, silent wait loops, and routine approvals to a lightweight `flash` background subagent so the flagship commander stays asleep until a compact structured delivery receipt is ready for review.
- **L2 Shared architect-style commander core:** Unified single-source rules across hosts — **decompose large multi-subsystem goals (`delegate_plan`) + steer architecture, exported contracts, and scope redlines (never dictating line-by-line code or pseudocode in prompts) + enforce pragmatic review (consolidate real spec/bug/test defects into one rework round; never invent out-of-spec fuzz probes)**.
- **L3 Bounded compact MCP protocol:** Single-line JSON payloads, one-call `autoPreflight` + `wait` submission, and diff-free local review receipts (`includeDiff: false` / `receiptOnly: true`).
- **L4 Isolated Git worktrees & seamless continuations:** Runs in isolated Git worktrees by default; downstream multi-stage subtasks can reuse an accepted isolated worktree with a fresh DSH Session via `reuseWorktreeFromTaskId` without touching the user's source checkout; follow-up fixes resume the exact session via `continueFromTaskId`; linked cleanup removes histories, archived sessions, and temporary worktrees in one click.

---

## 1.9.0 Benchmark Results & Takeaways

We evaluated the **`1.9.0-test6` candidate build** across a 7-task deterministic black-box benchmark suite (`T0A` non-dispatch chat boundary, `T0B` 3 invalid/uncommitted Git directory blocks, `T1` core quota-ledger implementation, `T2` tiered overage billing & audit report, `T3` discount engine & export CLI, `T4` dirty-checkout uncommitted draft preservation, and `T5` an enterprise 3-domain billing platform refactor with **235 unit tests + 6 read-only SHA-256 fixture checks**), pairing each host against its own no-plugin strong-model baseline under identical fixtures and black-box grading scripts. DSH ran `deepseek-v4.1-flash` as the worker.

### 1. Cross-Host Summary

| Host & Commander | Mode | Full Suite Passed | `T1–T5` Paired Passed | `T1–T5` Avg. Commander Turns | `T1–T5` Strong-Model Effective Tokens (Uncached In + Out) | Effective Token Savings | `T1–T5` Strong-Model Total Tokens (incl. Cache) | Auxiliary / DSH Worker Tokens |
| --- | --- | :---: | :---: | ---: | ---: | ---: | ---: | ---: |
| **Antigravity**<br>`gemini-4-neon-xhigh` | No-plugin baseline | — | 5/5 (Avg. 100) | 11.00 | 618,861 | Baseline | 3,276,639 | 0 |
| **Antigravity**<br>`gemini-4-neon-xhigh` | **`1.9.0-test6` Plugin**<br>(`flash` subagent + DSH) | **7/7 (Avg. 100)** | **5/5 (Avg. 100)** | **11.80**<br>*(7-task avg: 9.57)* | **420,450**<br>*(7-task total: 484,480)* | **Saved 32.06%** | 3,724,763<br>*(+13.68%)* | Flash aux: 2,298,138<br>+ DSH worker |
| **Codex CLI**<br>`gpt-6.2-sol (xhigh)` | No-plugin baseline | — | 4/5 (Avg. 96) | 11.20 | 608,065 | Baseline | 1,966,145 | 0 |
| **Codex CLI**<br>`gpt-6.2-sol (xhigh)` | **`1.9.0-test6` Plugin**<br>(Native Skill + DSH) | **6/7 Passed** | **4/5 (Avg. 96)**<br>*100% per-task score parity* | **28.60**<br>*(7-task avg: 21.29)* | **459,102**<br>*(7-task total: 503,180)* | **Saved 24.50%** | 9,060,958<br>*(4.61×, >94% cache read)* | DSH worker: 745,409 |

> **Verification notes:** (1) On `T0A` (ordinary non-code Q&A), Codex answered in 1 turn with zero tool calls and Antigravity used zero auxiliary turns — proving zero false dispatch; `T0B` cleanly blocked all three invalid repository layouts without touching fixtures. (2) On `T2`, both the Codex baseline and `1.9.0-test6` scored 80/100 due to an omitted-policy `overageUnits` grader check and passed 100% when `charge-overage-tier` was passed explicitly. (3) Compared with the pre-upgrade `test5` polling run on Codex (`2,367,661` effective tokens / `18.63M` total tokens across 7 tasks), `1.9.0-test6` cut Codex effective tokens by **78.7%**.

### 2. Per-Task Strong-Model Effective Token (`Uncached Input + Output`) Breakdown (`T1–T5`)

| Task & Scope | Antigravity Baseline → `1.9.0-test6` | Antigravity Effective Savings | Codex Baseline → `1.9.0-test6` | Codex Effective Savings |
| --- | ---: | ---: | ---: | ---: |
| **`T4`** · Small dirty-repo fix preserving uncommitted drafts (7 tests) | 44,731 → 56,269 | -25.79% *(fixed dispatch overhead)* | 81,590 → 86,816 | -6.40% *(fixed dispatch overhead)* |
| **`T1`** · Core quota-ledger implementation (20 tests) | 73,559 → 46,177 | **+37.22%** *(total tokens -9.8%)* | 52,768 → 52,446 | **+0.61%** *(break-even)* |
| **`T2`** · Tiered overage billing & audit report (39 tests) | 92,737 → 53,542 | **+42.26%** *(total tokens -19.2%)* | 100,570 → 87,502 | **+13.00%** |
| **`T3`** · Discount engine, ledger integration & CLI (51 tests) | 85,481 → 64,440 | **+24.61%** *(total tokens -15.9%)* | 82,885 → 67,827 | **+18.17%** |
| **`T5`** · Enterprise 3-domain billing platform (235 tests + 6 SHA-256 contracts) | 322,353 → 200,022 | **+37.95%** | 290,252 → 164,511 | **+43.32%** *(output tokens -47.9%)* |

### 3. Key Benchmark Conclusions

1. **Lightweight worker + strong commander review achieves full per-task score parity with frontier baselines:** Even with a lightweight `deepseek-v4.1-flash` worker, clear upfront contract briefs combined with independent commander test/diff verification (including 1–3 targeted `continueFromTaskId` rework rounds on Codex) delivered **100/100** on the 235-test 3-domain `T5` architecture task — matching no-plugin frontier baselines point-for-point on both hosts.
2. **Savings scale with task complexity (38%–43% effective token reduction on heavy tasks):** Multi-file features and cross-module refactors (`T2`, `T3`, `T5`) are the sweet spot, saving **13.0%–43.3%** of expensive uncached input and code-output tokens on the strong model. Trivial single-point edits (`T4`) incur fixed preflight/review overhead (`+6.4%` to `+25.8%`) and are simpler to edit directly in the commander.
3. **Host architectures shape prefix-cache behavior differently:** Antigravity's `flash` subagent absorbs 67.5% of intermediate turns on `T5`, keeping paired `T1–T5` flagship turns nearly flat (`11.80` vs. `11.00` baseline; `9.57` across all 7 tasks) and even reducing total cached+uncached tokens on `T1`/`T2`/`T3`. Codex runs a single direct MCP chain in the main session: multi-round approvals and rework (`33–54` turns on `T2`/`T5`) replay main-session prefix cache (`4.61×` total tokens, over 94% low-cost `cacheRead`), while high-cost uncached input + output still drops by **24.5%**.
4. **Trades background wall-clock time for flagship quota:** Paired `T1–T5` end-to-end duration averaged `1.76×` baseline on Antigravity (`656s` vs. `372s`; `481s` across all 7 tasks) and `3.11×` cumulative CLI time on Codex (`~1.9×` after excluding ~9-minute initial queueing under 7-way full concurrency) — ideal for background or parallel worktree delegation.

---

## Key Capabilities

| Capability | What You Get |
| --- | --- |
| **Codex & Antigravity one-click setup** | Dedicated settings tabs to install, update, repair MCP only, or cleanly remove managed integrations (including automatic retirement of untouched legacy Codex `.toml` subagents) while preserving any user edits via SHA-256 content digests. |
| **Reuse DSH APIs, models & effort** | Select providers, worker models, and reasoning effort already configured in DSH; API keys never leave DSH. |
| **Plan trees, worktree reuse & linked cleanup** | Decompose multi-stage goals with `delegate_plan`; pass `reuseWorktreeFromTaskId` so dependent subtasks start a fresh DSH Session on an accepted isolated worktree; filter **Task history** by date, jump to native sessions, and clean task chains, archived sessions, and isolated worktrees in one click. |
| **Parallel worktree isolation & workspace tree** | Run isolated parallel Git worktrees (nested under DSH's `TaskBridge` sidebar root and titled per task) or explicit shared checkouts (preserving the project's native workspace name). |
| **Tiered silent monitoring** | No default total execution cap; runs one local read-only self-check 10 minutes after start, checks in with the commander after 40 minutes without a new delivery, and deduplicates repeated tool-failure reminders (all configurable). |
| **Single-call approvals & native questions** | The commander approves each out-of-sandbox call using its exact argument fingerprint. Native DSH questions forward and resume waiting in one call. |
| **Optional Agent Teams & project overrides** | `agentTeams` is off by default and configurable globally or per dispatch; settings auto-save with reusable presets and per-project path overrides. |

## Quick Start

### 1. Install in DSH

Open **Plugins → Add plugin** in DSH, install and enable:

```text
dsh-taskbridge
```

> Switch to the official npm registry if a regional mirror lags behind, or install a `.tgz` archive from [GitHub Releases](https://github.com/ranranyya/dsh-taskbridge/releases). Requires Node.js 24+ (automatically resolved without ever writing the Electron GUI executable).

### 2. Configure the Worker Model

1. Open **Plugins → Installed plugins → dsh-taskbridge → API management** and enable a DSH provider.
2. Open **Execution settings** and pick the provider, worker model, and supported reasoning effort.
3. Confirm changes show as saved.

### 3. Connect Your Commander

- **Codex:** Open **Codex integration** and click **Install / update TaskBridge skill** (writes `skills/dsh-taskbridge/SKILL.md`, its rules reference appendix, and `config.toml` MCP entry while retiring untouched legacy `agents/dsh-taskbridge.toml`). Start a new Codex session and dispatch with `$dsh-taskbridge` or an explicit DSH / TaskBridge instruction.
- **Antigravity:** Open **Antigravity integration** and click **Install / update Antigravity plugin** (installed cleanly under `~/.gemini/config/plugins/dsh-taskbridge/`). Dispatch with `@[plugin:dsh-taskbridge]` / `@dsh-taskbridge` or an explicit instruction; select **Always Allow** on the first `delegate_*` prompt so background waiting runs uninterrupted.

### 4. Enable the Switch and Dispatch

Turn on **Allow local MCP calls to DSH delegation** at the top of the settings page (off by default), then assign a task from Codex or Antigravity:

> Use TaskBridge to have DSH implement the tiered overage billing module and export CLI in this repository. Inspect the specs first, define the module contracts and boundaries, dispatch the implementation and unit tests to DSH, and review the delivered diff and test suite before accepting.

## How It Works

### Isolation Modes

- **Independent worktree (`worktree`, default):** Branches an isolated Git worktree from `HEAD` under DSH's `TaskBridge` sidebar node; multi-stage subtasks can chain onto the same isolated worktree with clean sessions via `reuseWorktreeFromTaskId`.
- **Shared workspace (`shared`):** Runs in place inside a dirty checkout only after explicit preflight confirmation; reuses the project's native workspace and is strictly protected from linked cleanup deletion.

> **Git repository requirement:** Both modes require an initialized Git repository root with at least one commit. Recording `accepted` via `delegate_review` stores your verdict only — it never auto-merges, commits, or pushes.

### Quiet Waiting & Monitoring

- **10 minutes after start (default):** One read-only local self-check with zero LLM cost.
- **40 minutes with no new delivery (default):** Returns a compact progress check-in to `delegate_wait` without cancelling the run.
- **Repeated identical tool failures (default: 3):** Surfaces an acknowledged `eventId` reminder to prevent runaway loops. See [Silent waiting](silent-wait.md).

## FAQ

**Does installing TaskBridge send ordinary chat or code questions to DSH?**
No. Both the local delegation switch AND an explicit assignment of a Git-repository implementation/verification task are required. General Q&A stays directly in Codex or Antigravity with zero tool calls.

**Will updates overwrite my edits to `SKILL.md` or legacy `dsh-taskbridge.toml`?**
No. Ownership is proved by SHA-256 content digests; customized files are preserved verbatim. Use **Repair MCP only** to refresh just the MCP entry.

**When should I delegate vs. edit directly in the commander?**
Edit tiny one-file tweaks directly in the commander. Delegate multi-file features, test suites, CLI/service modules, and cross-domain refactors to TaskBridge to save 25%–43% of strong-model effective tokens while maintaining full review control.

## Client Support & Roadmap

| Client | Status | Integration |
| --- | --- | --- |
| **Codex** | Supported (`1.9.0` Native Skill) | One-click `skills/dsh-taskbridge/SKILL.md` + reference appendix + MCP (auto-retires untouched legacy subagents) |
| **Antigravity** | Supported | One-click self-contained plugin (`plugins/dsh-taskbridge/`: Skill + `flash` Subagent + MCP) |
| **Claude Code / Claude Desktop** | Planned (`2.0`) | Shares the same layered commander core and MCP surface; see [Claude roadmap](claude-code.md) |

## Documentation & Feedback

- [1.9.0 Release Notes (ZH)](releases/1.9.0.zh.md) · [Codex integration](codex-integration.md) · [Antigravity integration](antigravity-integration.md) · [Claude roadmap](claude-code.md)
- [Silent waiting](silent-wait.md) · [Workspace isolation](workspace-contract.md) · [Conversation placement](conversation-placement.md)
- [Runtime compatibility](runtime-compatibility.md) · [Plugin market](plugin-market.md) · [Legacy migration](taskbridge-upgrade.md)

Report issues or suggestions on [GitHub Issues](https://github.com/ranranyya/dsh-taskbridge/issues) with your plugin version, reproduction steps, and redacted diagnostics (never include API keys).

## License

[MIT](../LICENSE)
