# What the sidebar can do, and what it cannot (verified against the shipped host)

This document replaces the earlier "grouped workspaces view" description. It states what the
shipped DSH `0.2.2-rc.5` client actually publishes, what this plugin therefore does, and the
interface gap that stops the requested arrangement from being built as asked.

## 1. The host contract, as read from the shipped client bundle

`@deepseek-ai/dsh-client-ui-workspace` is the package that draws the sidebar's workspace area.
Its registration, quoted from the bundle actually served by the desktop host (`plugins/??…/
dsh-client-ui-workspace/client.js`, 205 kB):

```js
ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
  name: 'sidebar.workspaces',
  children: {
    'sidebar.workspaces.directoryFlow':      { kind: 'single', scope: 'root' },
    'sidebar.workspaces.session.row.action': { kind: 'list',   scope: 'root' },
    'sidebar.session.row.leading':           { kind: 'list',   scope: 'root', inline: true },
    'sidebar.session.row.trailing':          { kind: 'list',   scope: 'root', inline: true },
    'sidebar.session.row.hover':             { kind: 'list',   scope: 'root' },
  },
  store: viewStore,
  inject: browserInjected,
  locale: NS,
}, WorkspaceBrowser))
```

The same bundle shows how the host itself uses the child slot:

```js
ctx.slots.inject('sidebar.workspaces.session.row.action', function* () {
  yield ctx.slots.register({ name: '…session.row.action', id: 'archive', order: 100, … }, ArchiveSessionRowButton)
  yield ctx.slots.register({ name: '…session.row.action', id: 'pin',     order: 200, … }, PinSessionRowButton)
})
```

Facts this establishes:

| Fact | Consequence |
| --- | --- |
| `sidebar.workspaces` is a **single** slot: one entry renders, at priority `0`. | A registration there **replaces** the native rows. A sibling section *above* the browser inside the same cell is **not expressible**. That is why the earlier build made the native header and every `data-row-key` row disappear from an acceptance run. |
| The entry publishes **child slots**, including `sidebar.workspaces.session.row.action` (`kind: 'list'`, `scope: 'root'`). | A plugin can add material **inside** each native session row. This is the supported seam, and it never replaces or reorders a native row. |
| `workspaceController.create({ path })` registers/reuses **by path**, and no API names a parent Workspace. | One external shared directory cannot be given a second native Workspace, and a chain cannot be given a native TaskBridge parent. |
| The native rows are the shipped component's own DOM (`data-row-key`, `[data-sidebar-workspace-header]`). | Filtering or hiding individual native rows from outside would mean patching the host's DOM, which this plugin does not do. |

**Interface gap (stated, not worked around):** a vertically stacked "TaskBridge section above the
native workspace list, in the same cell" needs either a second slot for that position or a
published way to render the shipped browser from a foreign entry. Neither exists in `0.2.2-rc.5`.

Minimal host extensions that would close it, in order of preference:

1. a sibling slot rendered **above** `sidebar.workspaces` (e.g. `sidebar.workspaces.before`), or
2. a documented row predicate/filter on the browser, if plugins are to suppress native rows, or
3. publishing the shipped `WorkspaceBrowser` component so a foreign entry can compose it.

## 2. What this plugin does instead

1. **The native workspace area is the host's.** `apply()` does **not** register on
   `sidebar.workspaces`. Every native Workspace keeps its name, order, search, session rows, and
   its open / new-session / rename / remove / archive / restore actions and menus — untouched,
   because the plugin draws none of them.
2. **Dispatched conversations are marked inside their own native row** through the published
   child slot `sidebar.workspaces.session.row.action`, as a list entry with id
   `dsh-taskbridge:dispatched` and `order: 900` — after the host's archive (100) and pin (200), so
   it never comes between the operator and a native control. The marker is one quiet inline word:
   `派工` for a shared run, `派工 · 隔离` for a worktree run, with the task title as its tooltip. A
   session this plugin did not dispatch renders **nothing**, so a native row is byte-identical.
3. **The grouping itself — TaskBridge → 任务工作区 → 对话 — is drawn on the plugin's own
   surfaces** (the TaskBridge content panel), where it can be complete and cannot disturb a native
   row. It is strictly three levels, one row per dispatched **chain**: two independent dispatches
   of one project are two task workspaces; a continuation keeps its parent's Workspace and Session
   and stays one row.

## 3. Ownership

Proof, never appearance:

| Question | Rule |
| --- | --- |
| Is this conversation TaskBridge's? | The durable map (`/session-map`) or the conversation's own task record names that exact **(session, workspace)** pair. A title alone never proves anything (it may *describe* a row, never claim one). |
| Which project? | The recorded **source path**, canonicalised as `sessionPathKey` does — an external target's shared and worktree runs are one project; same-named directories elsewhere are two. |
| Which task workspace? | The **chain**, resolved from the records' own `continueFromTaskId` links. |
| What is never claimed? | Any Workspace whose conversations are not fully explained: empty, ordinary, the managed worktree root, or **mixed**. The native browser shows those. |

A **mixed** Workspace (a dispatched conversation plus one the operator opened) appears in the
grouping for its chain, but its node is marked `sharedWithOrdinary`: renaming or removing it would
act on the operator's own conversation, so both are **refused with a stated reason** and the
native row remains the place to manage it.

## 4. Actions

| Row | Action | Call |
| --- | --- | --- |
| Conversation | open | `uiWorkspace.openSession(sessionId)` |
| Conversation | archive | `workspaces.archiveSession(sessionId)` — the host's own protection (a running conversation) applies |
| Archived conversation | restore | `workspaces.unarchiveSession(sessionId)` |
| Task workspace | new conversation | `uiWorkspace.startSession(workspaceId)` |
| Task workspace | rename | `workspaces.rename(workspaceId, title)` after the operator's text; refused when `sharedWithOrdinary` |
| Task workspace | remove | `workspaces.delete(workspaceId)` after a confirmation; refused when `sharedWithOrdinary` |

A TaskBridge or project row is a display node, never a Workspace record: it carries none of these.

## 5. Live behaviour

* The marker and the grouping both subscribe to the host's own `workspaces.list`, so an archive, a
  restore or a new Workspace appears without a reload.
* The durable map is read once per mount; a dispatch made afterwards is proven by its own task
  record, so a new chain is marked and grouped immediately.
* Neither surface starts a read loop: the task panel and records page own that.

## 6. What is verified, and how

| Claim | How |
| --- | --- |
| `apply` registers the child slot and never the parent | `tests/client.test.js`, `tests/workspaces-browser.test.js` (built bundle, fake ctx) |
| The host really declares that child slot, as a list | quoted from the bundle the isolated desktop host serves (§1); the marker registers with matching `id`/`order` |
| The marker appears only for dispatched sessions | `tests/workspaces-browser.test.js` (jsdom, real bundle) |
| Strict three levels, one row per chain | `tests/workspace-groups.test.js`, `tests/workspaces-browser.test.js` |
| A mixed Workspace is never renamed/removed as a whole | both files above |
| The native area is not replaced | `apply` registers no parent entry; asserted in `tests/client.test.js` and `tests/entry.test.js` |

Not verified by this work unit in a live desktop UI: the marker's exact position inside the host's
own row (it depends on the host's row layout), and the grouping panel inside the real desktop
window (the headless browser could not be launched in this environment — its mojo channel is
denied by the sandbox). Both are asserted against the real bundle's contract and in jsdom.
