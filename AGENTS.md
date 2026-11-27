# Execution task rules

This directory is an isolated plugin development repository. For delegated
development tasks, the host agent is the coordinator and final reviewer; the assigned
DeepSeek worker implements only the work unit in its task and `docs/SPEC.md`.

Do not delegate again or create subagents. Do not modify installed Crew/DSH,
user credentials or other repositories. Do not commit or push unless explicitly asked.
Other edits may be present; preserve them. Report changed files, actual checks and limitations.
The coordinator's comments do not authorize you to expand scope independently.

## Repository layout & build conventions

- **Host integrations (single source of truth):** Edit `integrations/core/` and `integrations/adapters/` only, then run `npm run build:integrations` to assemble `integrations/targets/{codex,antigravity}/` (`npm run check:integrations` verifies byte-for-byte sync). Never hand-edit `integrations/targets/**` or recreate top-level `codex/` or `antigravity/` directories.
- **Client bundle:** After editing `src/client/**`, run `npm run build:client` to update `lib/client.js` (`npm run check:client` verifies sync).
- **Root hygiene:** Maintain `package-lock.json` only (`npm ci`, no `pnpm-lock.yaml`). Keep internal specs and extra doc images under `docs/` (`docs/SPEC.md`, `docs/assets/`), and never place handoff notes in the repository root.
