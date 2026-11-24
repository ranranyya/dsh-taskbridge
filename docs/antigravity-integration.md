# Antigravity integration contract

Status: implemented in 1.8.0 (updated in 1.9.0 with layered commander core, isolated worktree reuse, per-task safe command approvals, and Flash subagent token boundaries).

This document defines the contract between the TaskBridge settings page (**Antigravity integration** tab), the host-side installer (`src/antigravity/installer.js`, `src/antigravity/seam.js`), and the self-contained Antigravity plugin bundle it manages.

## 1. Managed directory & files

TaskBridge installs a single self-contained plugin under `<ANTIGRAVITY_CONFIG_DIR>/plugins/dsh-taskbridge/` (default `~/.gemini/config/plugins/dsh-taskbridge/`):

```text
plugins/dsh-taskbridge/
├── plugin.json                     # Antigravity plugin manifest
├── mcp_config.json                 # Plugin-scoped stdio MCP entry (`dsh-taskbridge`)
├── assets/logo.svg                 # TaskBridge icon
├── skills/dsh-taskbridge/SKILL.md  # Progressive-disclosure commander manual
└── agents/dsh-taskbridge.md        # Background dispatcher & watcher subagent
```

TaskBridge **never modifies** `~/.gemini/config/mcp_config.json` or `~/.gemini/config/config.json`. Enabling or disabling the `dsh-taskbridge` plugin inside Antigravity controls the entire bundle (MCP tools, Skill, and Subagent) as one unit.

## 2. Config directory resolution & link boundaries

- Precedence: `ANTIGRAVITY_CONFIG_DIR` → `GEMINI_CONFIG_DIR` → remembered successful install directory → default `~/.gemini/config`.
- Relative overrides are refused with `ANTIGRAVITY_HOME_INVALID`.
- If the config root itself is a normal symlink or Windows junction pointing to a real directory, the installer pins its `realpath` once and operates under that target without modifying the alias.
- Any symlink, junction, or non-directory inside `plugins/dsh-taskbridge/` is refused as `conflict`.

## 3. Ownership, actions, and startup refresh

- Ownership is proved by LF-normalized SHA-256 content digests recorded in `<DSH_HOME>/data/dsh-delegate/antigravity-plugin-ownership/`.
- **Status (`GET /api/dsh-delegate/antigravity`)**: strictly read-only; never creates directories or files.
- **Install / Update (`POST { action: "install" }`)**: writes or updates unmodified managed plugin files and `mcp_config.json`. Operator-edited files are classified as `modified`/`conflict` and preserved verbatim.
- **Repair MCP only (`POST { action: "repair" }`)**: repairs `mcp_config.json` (and ensures `plugin.json` exists if missing/outdated) without touching `SKILL.md` or `agents/dsh-taskbridge.md`.
- **Remove (`POST { action: "remove" }`)**: removes only verified plugin-managed files and cleans empty subdirectories inside `plugins/dsh-taskbridge/`.
- **Startup refresh**: when DSH starts, an already-installed, unmodified outdated Antigravity plugin bundle is refreshed automatically in place. Startup never performs a first-time install and never touches customized files.
- **Local delegation switch**: reported read-only; installing the Antigravity integration never turns on the DSH local-call switch.

## 4. First-time MCP tool authorization in Antigravity

- Antigravity gates newly installed external MCP tools by default, so the first delegated task prompts for approval on each `delegate_*` call (`delegate_status`, `delegate_preflight`, `delegate_submit`, `delegate_wait`, `delegate_result`, `delegate_review`, etc.).
- Operators can choose **Always Allow** (or add Permission Grants for `dsh-taskbridge_dsh-taskbridge` in Antigravity Settings) to avoid repeated prompts during routine dispatches. Turning off DSH's master **Allow local MCP calls to DSH delegation** switch still rejects all new submissions immediately, and DSH workers remain inside their configured worktree/sandbox boundaries.

## 5. Layered rule maintenance (source repository)

- Both `antigravity/skills/dsh-taskbridge/SKILL.md` and `antigravity/agents/dsh-taskbridge.md` (along with `codex/skills/dsh-taskbridge/SKILL.md`) are generated from the layered single-source definitions under `integrations/core/` (Layer 2 shared commander core: activation redlines, decompose-and-steer planning philosophy, dispatch state machine, pragmatic review) and `integrations/adapters/` (Layer 1 host-specific thin adapters).
- After editing layered sources, run `npm run build:integrations`; `npm run check:integrations` and `tests/integrations-layering.test.js` verify byte-for-byte sync.
