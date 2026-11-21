// dsh-delegate settings UI — stylesheet, injected once by the client entry.
//
// The page lives *inside* the native settings dialog, so it must not restyle
// anything it does not own: every rule below is scoped to `.dshdg-*` class names
// this plugin is the only producer of, and every colour/radius/font reads a
// native design token (`--dsw-*`, `--ds-*`) with a safe literal fallback. That is
// how the page follows the operator's light/dark theme and locale-specific font
// without shipping a second design system or touching the shell's CSS.
//
// Injection contract (from the native client module system,
// `@deepseek-ai/dsh-client-modules` 0.2.0-rc.2): a `<style>` element authored
// inside the bundle factory is claimed for the materializing plugin by
// `data-plugin`, and the loader removes exactly the tags carrying this plugin's
// id when the plugin is disabled. We therefore tag the element ourselves and
// also return a disposer, so HMR/unload cannot leave an orphaned sheet behind.

/** Attribute the native module system uses to attribute and clean up styles. */
export const STYLE_PLUGIN_ATTRIBUTE = 'data-plugin';

/** Plugin id used for style ownership; matches the bundle registration id. */
export const STYLE_PLUGIN_ID = 'dsh-delegate';

/** Stable element id so a second injection replaces instead of stacking. */
export const STYLE_ELEMENT_ID = 'dsh-delegate-settings';

/**
 * The stylesheet text.
 *
 * Layout notes worth keeping: the authorization block is rendered before the
 * tab bar in the DOM (not merely first visually), so reading order, keyboard
 * order and screen-reader order all put authorization above the four areas. Grid
 * tracks use `minmax(0, 1fr)` so a long model id or diff line cannot push the
 * form wider than the settings panel.
 */
export const CSS_TEXT = `
.dshdg-root {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 2px 24px;
  color: var(--dsw-alias-label-primary, #1f2329);
  font-family: var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif);
  font-size: 13px;
  line-height: 1.55;
}
.dshdg-root * { box-sizing: border-box; }
.dshdg-root h3, .dshdg-root h4 { margin: 0; font-weight: 600; }
.dshdg-root h3 { font-size: 15px; }
.dshdg-root h4 { font-size: 13px; }
.dshdg-root p { margin: 0; }
.dshdg-muted { color: var(--dsw-alias-label-secondary, #61666d); }
.dshdg-faint { color: var(--dsw-alias-label-tertiary, #8a9098); }
.dshdg-mono {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 12px;
}
.dshdg-card {
  border: 1px solid var(--dsw-alias-border-l2, #e2e5e9);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3, #fff);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.dshdg-card-danger { border-color: var(--dsw-alias-label-error, #d92d20); }
.dshdg-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-width: 0; }
.dshdg-row-end { justify-content: flex-end; }
.dshdg-switch { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
.dshdg-switch input { width: 18px; height: 18px; margin: 0; accent-color: #087e8b; }
.dshdg-spacer { flex: 1 1 auto; }
.dshdg-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); min-width: 0; }
.dshdg-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dshdg-field > label { font-weight: 500; color: var(--dsw-alias-label-secondary, #61666d); font-size: 12px; }
.dshdg-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a9098); }
.dshdg-root input[type="text"],
.dshdg-root input[type="password"],
.dshdg-root input[type="number"],
.dshdg-root select,
.dshdg-root textarea {
  width: 100%;
  padding: 5px 8px;
  color: inherit;
  font: inherit;
  background: var(--dsw-alias-bg-base, #f7f8f9);
  border: 1px solid var(--dsw-alias-border-l3, #d3d7dd);
  border-radius: var(--dsw-radius-sm, 6px);
  min-width: 0;
}
.dshdg-root textarea { resize: vertical; min-height: 76px; }
.dshdg-root input:focus-visible,
.dshdg-root select:focus-visible,
.dshdg-root textarea:focus-visible,
.dshdg-root button:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #3457d5);
  outline-offset: 1px;
}
.dshdg-root input:disabled, .dshdg-root select:disabled, .dshdg-root textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.dshdg-root button {
  font: inherit;
  padding: 5px 12px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l3, #d3d7dd);
  background: var(--dsw-alias-button-tool-bar-fill, #f2f3f5);
  color: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.dshdg-root button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #e9ebee); }
.dshdg-root button:disabled { opacity: 0.55; cursor: not-allowed; }
.dshdg-root button.dshdg-primary {
  background: var(--dsw-alias-button-primary-fill, #3457d5);
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.dshdg-root button.dshdg-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #2b49b8); }
.dshdg-root button.dshdg-danger { color: var(--dsw-alias-label-error, #d92d20); }
.dshdg-check { display: flex; flex-wrap: wrap; gap: 6px 12px; }
.dshdg-check label { display: inline-flex; gap: 5px; align-items: center; font-size: 12px; }
.dshdg-check input { margin: 0; }
.dshdg-tabs { display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 1px solid var(--dsw-alias-border-l2, #e2e5e9); }
.dshdg-tab {
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: var(--dsw-radius-sm, 6px) var(--dsw-radius-sm, 6px) 0 0;
  background: transparent;
  padding: 6px 14px;
}
.dshdg-tab[aria-selected="true"] {
  background: var(--dsw-alias-bg-layer-3, #fff);
  border-color: var(--dsw-alias-border-l2, #e2e5e9);
  font-weight: 600;
}
.dshdg-panel { display: flex; flex-direction: column; gap: 14px; }
.dshdg-notices { display: flex; flex-direction: column; gap: 6px; }
.dshdg-notice {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 7px 10px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px solid var(--dsw-alias-border-l2, #e2e5e9);
  background: var(--dsw-alias-bg-layer-4, #f7f8f9);
}
.dshdg-notice-error { border-color: var(--dsw-alias-label-error, #d92d20); }
.dshdg-notice-success { border-color: var(--dsw-alias-state-business-primary, #12b76a); }
.dshdg-notice > span { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.dshdg-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l3, #d3d7dd);
  font-size: 11px;
  white-space: nowrap;
}
.dshdg-badge-on { border-color: var(--dsw-alias-state-business-primary, #12b76a); }
.dshdg-badge-off { border-color: var(--dsw-alias-label-tertiary, #8a9098); color: var(--dsw-alias-label-secondary, #61666d); }
.dshdg-badge-warn { border-color: var(--dsw-alias-label-error, #d92d20); color: var(--dsw-alias-label-error, #d92d20); }
.dshdg-list { display: flex; flex-direction: column; gap: 8px; }
.dshdg-item {
  border: 1px solid var(--dsw-alias-border-l2, #e2e5e9);
  border-radius: var(--dsw-radius-sm, 6px);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.dshdg-item-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-width: 0; }
.dshdg-item-head strong { overflow-wrap: anywhere; }
.dshdg-secret-warning {
  border: 1px solid var(--dsw-alias-label-error, #d92d20);
  border-radius: var(--dsw-radius-sm, 6px);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dshdg-token {
  display: block;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-sm, 6px);
  border: 1px dashed var(--dsw-alias-border-l3, #d3d7dd);
  background: var(--dsw-alias-bg-base, #f7f8f9);
  overflow-wrap: anywhere;
  user-select: all;
}
.dshdg-pre {
  margin: 0;
  padding: 8px 10px;
  max-height: 320px;
  overflow: auto;
  background: var(--dsw-alias-markdown-code-block, #f5f6f8);
  border-radius: var(--dsw-radius-sm, 6px);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 12px;
}
.dshdg-layers { display: grid; gap: 6px; }
.dshdg-layer { display: grid; grid-template-columns: minmax(120px, 180px) minmax(0, 1fr); gap: 8px; align-items: start; }
.dshdg-layer-detail { overflow-wrap: anywhere; }
.dshdg-ok { color: var(--dsw-alias-state-business-primary, #12b76a); }
.dshdg-fail { color: var(--dsw-alias-label-error, #d92d20); }
.dshdg-unknown { color: var(--dsw-alias-label-tertiary, #8a9098); }
.dshdg-table { display: grid; gap: 4px; }
.dshdg-kv {
  display: grid;
  grid-template-columns: minmax(96px, 140px) minmax(0, 1fr);
  gap: 4px 10px;
  min-width: 0;
}
.dshdg-kv dt { color: var(--dsw-alias-label-secondary, #61666d); }
.dshdg-kv dd {
  margin: 0;
  /* A grid item defaults to min-width: auto, i.e. "at least as wide as my longest
     unbreakable run" — the single place that pushed a long review note past the panel. */
  min-width: 0;
  overflow-wrap: anywhere;
}
/* A recorded review note: shown whole, wrapped inside its own track, never clipped.
   pre-wrap keeps every paragraph break and every space the host stored; anywhere breaks a
   long unbroken run (a path, a URL, 270 code points of Chinese with no spaces). Nothing
   here shortens, hides or line-clamps the body: the block keeps its natural height. */
.dshdg-note {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.dshdg-note-full {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.dshdg-note-preview {
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}
/* ---- task tree (G09) -------------------------------------------------------
   The tree is drawn with indentation measured in em units, so a deep level adds
   its own small step and a narrow window still fits the text before wrapping.
   Every row is a flex line that WRAPS: a long node title or a long status never
   pushes the round buttons out of the panel, and nothing is clipped. */
.dshdg-tree-filters { display: flex; flex-wrap: wrap; gap: 8px; margin-block: 8px; }
.dshdg-tree-filters label { display: grid; gap: 2px; flex: 1 1 132px; min-width: 0; }
.dshdg-tree-filters label > * { width: 100%; min-width: 0; }
/* ---- creation-date range ---------------------------------------------------
   Two native date inputs plus a clear button. The inputs stay inside the same
   wrapping filter row, so a narrow window stacks them instead of overflowing;
   the native picker supplies the calendar, so no date widget is shipped. */
.dshdg-root input[type="date"] {
  width: 100%;
  min-width: 0;
  padding: 5px 8px;
  color: inherit;
  font: inherit;
  background: var(--dsw-alias-bg-base, #f7f8f9);
  border: 1px solid var(--dsw-alias-border-l3, #d3d7dd);
  border-radius: var(--dsw-radius-sm, 6px);
}
.dshdg-root input[type="date"]:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #3457d5);
  outline-offset: 1px;
}
.dshdg-root input[type="date"][aria-invalid="true"] { border-color: var(--dsw-alias-label-error, #d92d20); }
/* The clear control sits on the row's baseline with the inputs, not under them. */
.dshdg-tree-day-actions { display: flex; align-items: flex-end; flex: 0 1 auto; min-width: 0; }
.dshdg-tree-day-actions button { padding: 5px 10px; font-size: 12px; }
.dshdg-record-views { display: flex; flex-wrap: wrap; gap: 4px; }
.dshdg-record-views button[aria-pressed="true"] { font-weight: 600; background: var(--dsw-alias-interactive-bg-hover, #e9ebee); }
.dshdg-records-overflow { overflow-x: auto; margin-top: 12px; }
.dshdg-records-table { width: 100%; border-collapse: collapse; min-width: 36em; }
.dshdg-records-table th, .dshdg-records-table td {
  padding: 8px 10px; text-align: start; vertical-align: top; border-bottom: 1px solid var(--dshdg-line);
}
.dshdg-records-table th { font-size: 12px; white-space: nowrap; }
.dshdg-records-table td[data-column="title"] { width: 42%; }
.dshdg-records-table td[data-column="updatedAt"] { font-variant-numeric: tabular-nums; }
.dshdg-records-table td[data-column="project"] { overflow-wrap: anywhere; }
.dshdg-record-name { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
.dshdg-records-table .dshdg-record-toggle, .dshdg-records-table .dshdg-record-sort {
  display: inline-flex; align-items: baseline; gap: 6px; text-align: start;
  border: 0; background: transparent; padding: 0; color: inherit; font: inherit;
}
.dshdg-records-table .dshdg-record-toggle { font-weight: 600; overflow-wrap: anywhere; }
.dshdg-records-table .dshdg-record-toggle:hover, .dshdg-records-table .dshdg-record-sort:hover { text-decoration: underline; }
.dshdg-record-detail { display: grid; gap: 8px; justify-items: start; }
.dshdg-record-detail p { margin: 0; }
.dshdg-record-detail .dshdg-tree-execution { width: 100%; }
.dshdg-record-selection { display: grid; gap: 3px; justify-items: start; }
.dshdg-tree-project { border-top: 1px solid var(--dshdg-line); margin-top: 12px; padding-top: 8px; }
.dshdg-tree-project h4 { margin: 0; overflow-wrap: anywhere; }
.dshdg-tree-project h4 small { font-weight: normal; }
.dshdg-tree-roots, .dshdg-tree-children, .dshdg-tree-rounds { list-style: none; margin: 0; padding: 0; }
.dshdg-tree-roots { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dshdg-tree-node { min-width: 0; }
.dshdg-tree-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; padding: 3px 0; }
.dshdg-tree-title { font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
.dshdg-tree-toggle { padding: 1px 8px; font-size: 12px; }
.dshdg-tree-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* One indent step per level, bounded so a 16-level plan cannot march off-screen. */
  margin-inline-start: 1.25em;
  padding-inline-start: 10px;
  border-inline-start: 1px dashed var(--dsw-alias-border-l2, #e2e5e9);
  min-width: 0;
}
.dshdg-tree-children { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dshdg-tree-round { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dshdg-tree-round-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
.dshdg-tree-round-head > span { overflow-wrap: anywhere; min-width: 0; }
.dshdg-tree-round-head button { padding: 1px 8px; font-size: 12px; }
/* ---- task-record cleanup ---------------------------------------------------
   One bar above the tree while selection mode is on, one checkbox line per
   execution chain, and a confirmation block that wraps instead of squeezing. The
   warning keeps the error colour because the action is irreversible. */
.dshdg-cleanup-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-block: 8px;
  padding: 8px;
  border: 1px solid var(--dsw-alias-border-l2, #e2e5e9);
  border-radius: 6px;
  min-width: 0;
}
.dshdg-cleanup-bar p { margin: 0; overflow-wrap: anywhere; }
.dshdg-cleanup-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; padding: 2px 0; }
.dshdg-cleanup-check { display: inline-flex; gap: 6px; align-items: center; min-width: 0; }
.dshdg-cleanup-row span { overflow-wrap: anywhere; min-width: 0; }
.dshdg-cleanup-bar .dshdg-row { flex-wrap: wrap; }

@media (max-width: 560px) {
  /* Narrow window: halve the indent so the deepest level still leaves room for
     text, and let the round controls wrap under the title instead of squeezing. */
  .dshdg-tree-body { margin-inline-start: 0.6em; padding-inline-start: 6px; }
  .dshdg-tree-round-head { gap: 4px; }
}
@media (max-width: 560px) {
  .dshdg-layer, .dshdg-kv { grid-template-columns: minmax(0, 1fr); }
}
/* ---- native left navigation (G08) ------------------------------------------
   This panel is NOT inside the settings dialog: it renders in the shell's own
   sidebar, whose width the host owns. So it uses the same .dshdg-* names (same
   tokens, same theme handling) but repeats no layout assumptions from the page:
   every row wraps, every title may shrink, and nothing may force a minimum width
   the sidebar does not have. */
.dshdg-nav {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 2px;
  min-width: 0;
  color: var(--dsw-alias-label-primary, #1f2329);
  font-family: var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif);
  font-size: 13px;
  line-height: 1.5;
}
.dshdg-nav * { box-sizing: border-box; }
.dshdg-nav h3 { margin: 0; font-size: 13px; font-weight: 600; min-width: 0; }
.dshdg-nav p { margin: 0; }
.dshdg-nav-head, .dshdg-nav-project-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
.dshdg-nav-note { font-size: 12px; }
.dshdg-nav-projects, .dshdg-nav-sessions { list-style: none; margin: 0; padding: 0; min-width: 0; }
.dshdg-nav-projects { display: flex; flex-direction: column; gap: 4px; }
.dshdg-nav-project { min-width: 0; }
.dshdg-nav-project-title {
  font-weight: 600;
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.dshdg-nav-sessions {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-inline-start: 0.8em;
  padding-inline-start: 8px;
  border-inline-start: 1px dashed var(--dsw-alias-border-l2, #e2e5e9);
}
.dshdg-nav-session { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
.dshdg-nav-session-title {
  min-width: 0;
  flex: 1 1 6em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshdg-nav-session button { padding: 1px 8px; font-size: 12px; }
.dshdg-nav-toggle-row { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
.dshdg-nav-archived { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dshdg-nav-icon { display: block; }
/* ---- grouped workspaces browser (sidebar.workspaces) -----------------------
   This block renders in the shell's workspace cell, which the shell sizes. It
   therefore assumes NOTHING about width: every row is a wrapping flex line, a
   title shrinks and ellipsises, and the actions wrap under the title rather than
   pushing the row wider. Colours, radii and fonts are the shell's own tokens, so
   the tree follows light/dark and the shared menu blur without a second theme. */
.dshdg-ws {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  color: var(--dsw-alias-label-primary, #1f2329);
  font-family: var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif);
  font-size: 13px;
  line-height: 1.45;
}
.dshdg-ws * { box-sizing: border-box; }
.dshdg-ws p { margin: 0; }
.dshdg-ws-tree, .dshdg-ws-projects, .dshdg-ws-workspaces, .dshdg-ws-sessions {
  list-style: none;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.dshdg-ws-tree, .dshdg-ws-projects, .dshdg-ws-workspaces, .dshdg-ws-sessions { display: flex; flex-direction: column; gap: 1px; }
/* One indent step per level, and the same dashed guide the task tree uses, so the two
   trees read as one product without sharing a component. */
.dshdg-ws-projects, .dshdg-ws-workspaces, .dshdg-ws-sessions {
  margin-inline-start: 0.9em;
  padding-inline-start: 8px;
  border-inline-start: 1px dashed var(--dsw-alias-border-l2, #e2e5e9);
}
.dshdg-ws-row { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; min-width: 0; padding: 2px 0; }
.dshdg-ws-caret {
  flex: 0 0 auto;
  width: 18px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1;
  cursor: pointer;
  opacity: 0.75;
}
.dshdg-ws-caret:hover { opacity: 1; }
.dshdg-ws-title {
  flex: 1 1 5em;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshdg-ws-title:hover { text-decoration: underline; }
.dshdg-ws-root-row .dshdg-ws-title { font-weight: 600; }
.dshdg-ws-project-row .dshdg-ws-title { font-weight: 500; }
.dshdg-ws-workspace .dshdg-ws-title { font-weight: 400; }
.dshdg-ws-count { flex: 0 1 auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a9098); }
.dshdg-ws-spacer { flex: 1 1 auto; }
.dshdg-ws-actions { display: inline-flex; flex-wrap: wrap; gap: 2px; min-width: 0; }
.dshdg-ws button + button { margin: 0; }
.dshdg-ws-actions button, .dshdg-ws-session-action {
  padding: 0 6px;
  font-size: 11px;
  line-height: 18px;
  border: 1px solid var(--dsw-alias-border-l2, #e2e5e9);
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.dshdg-ws-actions button:hover:not(:disabled), .dshdg-ws-session-action:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, #e9ebee);
}
.dshdg-ws-actions button:disabled, .dshdg-ws-session-action:disabled { opacity: 0.45; cursor: not-allowed; }
.dshdg-ws-session { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-width: 0; }
.dshdg-ws-open {
  display: flex;
  flex: 1 1 5em;
  gap: 6px;
  align-items: center;
  min-width: 0;
  padding: 2px 4px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.dshdg-ws-open:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #e9ebee); }
.dshdg-ws-open:disabled { cursor: not-allowed; opacity: 0.6; }
.dshdg-ws-session-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshdg-ws-badge {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l3, #d3d7dd);
  font-size: 10px;
  color: var(--dsw-alias-label-secondary, #61666d);
}
/* ---- the per-session marker inside a NATIVE sidebar row --------------------
   Rendered through the host's published child slot (sidebar.workspaces.session.row.action),
   so it sits inside the host's own row. Deliberately tiny and quiet: the operator sees a native
   row with one extra word, never a restyled or reordered one. Host density is respected — the
   host's own row actions are icon buttons, so this only adds an inline label. */
.dshdg-row-marker {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  padding: 0 4px;
  border-radius: var(--dsw-radius-sm, 4px);
  border: 1px solid var(--dsw-alias-border-l3, #d3d7dd);
  font-size: 10px;
  line-height: 14px;
  color: var(--dsw-alias-label-secondary, #61666d);
  white-space: nowrap;
  user-select: none;
}
.dshdg-row-marker[data-dshdg-row-marker-isolation="worktree"] {
  border-color: var(--dsw-alias-state-business-primary, #12b76a);
  color: var(--dsw-alias-state-business-primary, #12b76a);
}
/* ---- the plugin's own grouping surface ------------------------------------
   This is drawn on the plugin's OWN panel, not inside the shell's workspace cell, so it may use
   a full title row; it still wraps instead of pushing a control off a narrow sidebar. */
.dshdg-ws { display: flex; flex-direction: column; min-width: 0; }
.dshdg-ws-section {
  padding: 6px 0 2px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8a9098);
}
/* A project's action bar: the Workspace target picker plus its operations. Both wrap under the
   title so a narrow sidebar never pushes a control off-screen, and the picker is a CONTROL, not
   a level: it stays on the project's own row block. */
.dshdg-ws-project-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: center;
  min-width: 0;
  margin-inline-start: 1.4em;
  padding: 1px 0 3px;
}
.dshdg-ws-target { display: inline-flex; flex-wrap: wrap; gap: 4px; align-items: center; min-width: 0; }
.dshdg-ws-target select {
  max-width: 14em;
  min-width: 0;
  padding: 0 4px;
  font: inherit;
  font-size: 11px;
  color: inherit;
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, #e2e5e9);
  border-radius: var(--dsw-radius-sm, 6px);
}
/* The conversations of one project: one indent step, and the same dashed guide as the
   Workspace rows, so the three levels read as one tree. */
.dshdg-ws-conversations {
  list-style: none;
  margin: 0;
  padding: 0;
  margin-inline-start: 1.4em;
  padding-inline-start: 8px;
  border-inline-start: 1px dashed var(--dsw-alias-border-l2, #e2e5e9);
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.dshdg-ws-faint { color: var(--dsw-alias-label-tertiary, #8a9098); font-size: 10px; }
.dshdg-ws-empty { padding: 2px 4px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a9098); }
.dshdg-ws-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a9098); padding: 0 2px; }
.dshdg-ws-warn { font-size: 11px; color: var(--dsw-alias-label-error, #d92d20); padding: 0 2px; }
.dshdg-ws-archived > summary { cursor: pointer; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a9098); }
.dshdg-ws:focus-visible, .dshdg-ws button:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #3457d5);
  outline-offset: 1px;
}
`;

/**
 * Inject the stylesheet once.
 *
 * @param {Document | null | undefined} doc - document to inject into; a non-browser
 *   or test composition passes `null` and receives a no-op disposer.
 * @returns {() => void} disposer removing exactly the element this call created.
 */
export function injectStyles(doc) {
  const document_ = doc ?? (typeof document === 'undefined' ? null : document);
  if (document_ === null || typeof document_.createElement !== 'function') return () => {};

  const existing = typeof document_.getElementById === 'function'
    ? document_.getElementById(STYLE_ELEMENT_ID)
    : null;
  if (existing !== null && existing !== undefined) {
    // A previous instance of this plugin (HMR, re-enable) owns the sheet. Take it
    // over instead of stacking a duplicate, and give the caller a disposer for it.
    return () => {
      existing.remove?.();
    };
  }

  const element = document_.createElement('style');
  element.id = STYLE_ELEMENT_ID;
  element.setAttribute(STYLE_PLUGIN_ATTRIBUTE, STYLE_PLUGIN_ID);
  element.textContent = CSS_TEXT;
  const parent = document_.head ?? document_.documentElement ?? document_.body;
  parent.appendChild(element);
  return () => {
    element.remove?.();
  };
}
