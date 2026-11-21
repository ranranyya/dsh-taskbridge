const NEEDS_ATTENTION = new Set([
  'awaiting-permission', 'awaiting-question', 'awaiting-host-review', 'changes-requested',
  'children-accepted', 'failed', 'interrupted', 'cancelled',
]);
const IN_PROGRESS = new Set(['running', 'in-progress']);

export function viewStatus(status) {
  if (NEEDS_ATTENTION.has(status)) return 'attention';
  if (IN_PROGRESS.has(status)) return 'active';
  return status === 'accepted' ? 'done' : 'planned';
}

const VIEW_ORDER = { attention: 0, active: 1, planned: 2, done: 3 };
const priority = (node) => VIEW_ORDER[viewStatus(node.nodeStatus)];
const ordered = (nodes) => nodes.sort((a, b) => priority(a) - priority(b));

function hits(text, words) {
  const content = text.filter((part) => typeof part === 'string').join(' ').toLowerCase();
  return words.every((word) => content.includes(word));
}

function nodesOf(node) {
  return Array.isArray(node.children) ? node.children : [];
}

function latestActivityIn(nodes) {
  let latest = 0;
  for (const node of nodes) {
    const at = node.updatedAt ?? node.createdAt;
    if (Number.isFinite(at)) latest = Math.max(latest, at);
    latest = Math.max(latest, latestActivityIn(nodesOf(node)));
  }
  return latest;
}

function roundsOf(node) {
  const chains = node.chain ? [node.chain] : node.executions ?? [];
  return chains.flatMap((chain) => chain.rounds ?? []);
}

// ---------------------------------------------------------------------------
// Creation-date filter (a calendar-day range, in the BROWSER's own time zone)
// ---------------------------------------------------------------------------
//
// The value a date input produces is a plain calendar day (`2026-11-20`), not an
// instant. It is therefore compared as a calendar day and never as "now minus
// 24 hours": the local midnight that starts a day is derived through the browser
// `Date` constructor, so a day that is 23 or 25 hours long (a daylight-saving
// transition) still starts and ends where its calendar says. Nothing here uses a
// fixed 86_400_000 offset to step from one day to the next for that reason.
//
// The text form `YYYY-MM-DD` is NOT used for ordering. A four-digit year sorts
// lexically, but the parser accepts `10000-01-01` too, and `'9999-12-31' >
// '10000-01-01'` is true as text — the wrong answer for a calendar. A day is
// therefore carried as a comparable `{ year, month, day }` triple and only
// rendered back to text when the operator reads it.

/**
 * The smallest timestamp a host can record, and the value the task-tree
 * projection publishes when a task never recorded one (`createdAt` is stored as
 * `0`). A node created at exactly that instant is treated as "no date known",
 * because no real task was created at the epoch and a missing date must never be
 * read as "a very long time ago, so inside every range".
 */
const NO_RECORDED_TIME_AT_OR_BEFORE = 0;

/**
 * One calendar day as `{ year, month, day }`, or `null` when the text is not one.
 *
 * Years are accepted from four digits up, so `10000-01-01` is a real day; ordering
 * is done on the triple, never on the text, which is why such a year is safe here.
 * @param {unknown} value - `YYYY-MM-DD` text.
 * @returns {{ year: number, month: number, day: number } | null} the day.
 */
export function parseCalendarDay(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = /^(\d{4,})-(\d{2})-(\d{2})$/u.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || !Number.isSafeInteger(day)) return null;
  // Rebuild through the browser calendar: `2026-02-30` must not silently become
  // 2026-03-02, so every part has to round-trip exactly.
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { year, month, day };
}

/** Render a parsed day back to the `YYYY-MM-DD` text the inputs use. */
export function calendarDayText(day) {
  if (day === null || day === undefined) return null;
  const pad = (part) => String(part).padStart(2, '0');
  return `${String(day.year).padStart(4, '0')}-${pad(day.month)}-${pad(day.day)}`;
}

/** One calendar day as `YYYY-MM-DD`, or `null` when the text is not one. */
export function calendarDay(value) {
  return calendarDayText(parseCalendarDay(value));
}

/** Calendar order of two parsed days: negative, zero or positive. */
export function compareCalendarDays(left, right) {
  return (left.year - right.year) || (left.month - right.month) || (left.day - right.day);
}

/**
 * The calendar day of one timestamp in the browser's local time zone.
 *
 * A timestamp at or before {@link NO_RECORDED_TIME_AT_OR_BEFORE} is "no recorded
 * time" (`null`) rather than the 1970 day the projection would otherwise imply.
 * @param {unknown} at - epoch milliseconds.
 * @returns {{ year: number, month: number, day: number } | null} the day.
 */
export function localCalendarParts(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (at <= NO_RECORDED_TIME_AT_OR_BEFORE) return null;
  const date = new Date(at);
  const year = date.getFullYear();
  if (!Number.isFinite(year)) return null;
  return { year, month: date.getMonth() + 1, day: date.getDate() };
}

/** `YYYY-MM-DD` of one timestamp in the browser's local time zone, or `null`. */
export function localCalendarDay(at) {
  return calendarDayText(localCalendarParts(at));
}

/**
 * Normalise a raw range into parsed bounds plus the text to show back.
 *
 * `from > to` is reported as an error and NOT reinterpreted as a swapped range:
 * swapping would silently answer a different question than the one asked, which
 * is exactly the misreading a reversed range invites.
 * @param {{ from?: unknown, to?: unknown }} [range] - raw input values.
 * @returns {{ from: object | null, to: object | null, fromText: string | null,
 *   toText: string | null, error: string | null }} range.
 */
export function normalizeDayRange(range) {
  const from = parseCalendarDay(range?.from ?? null);
  const to = parseCalendarDay(range?.to ?? null);
  const both = { fromText: calendarDayText(from), toText: calendarDayText(to) };
  if (range?.from != null && range.from !== '' && from === null) return { from: null, to, ...both, error: '开始日期格式无效' };
  if (range?.to != null && range.to !== '' && to === null) return { from, to: null, ...both, error: '结束日期格式无效' };
  if (from !== null && to !== null && compareCalendarDays(from, to) > 0) {
    return { from, to, ...both, error: '开始日期晚于结束日期，请调整后再筛选' };
  }
  return { from, to, ...both, error: null };
}

/** Whether one timestamp's day lies inside a normalised range. */
function inDayRange(at, range) {
  const day = localCalendarParts(at);
  if (day === null) return false;
  if (range.from !== null && compareCalendarDays(day, range.from) < 0) return false;
  if (range.to !== null && compareCalendarDays(day, range.to) > 0) return false;
  return true;
}

/** Whether one CHAIN carries a creation day inside the range, on ANY of its rounds. */
export function chainCreatedInRange(chain, range) {
  if (range?.from === null && range?.to === null) return true;
  return (chain?.rounds ?? []).some((round) => inDayRange(round?.createdAt, range));
}

/**
 * Whether one node belongs in the range, decided by its CREATION date.
 *
 * The node's own creation day is checked first: for a plan node that is the plan
 * node's own `createdAt`, for a task node the first round's. Every round of every
 * chain in the node is checked as well, so a chain that was started earlier but
 * continued inside the range keeps all of its rounds and all of its parent chain
 * rather than being cut in half. A node without a usable timestamp never matches:
 * "no recorded time" (`null`, a non-number, or the projection's `0`) is not
 * evidence of a creation inside the range.
 * @param {object} node - a projected tree node.
 * @param {object} range - a normalised range.
 * @returns {boolean} true when the node carries a creation day inside the range.
 */
export function nodeCreatedInRange(node, range) {
  if (range?.from === null && range?.to === null) return true;
  if (inDayRange(node?.createdAt, range)) return true;
  return roundsOf(node ?? {}).some((round) => inDayRange(round?.createdAt, range));
}

/**
 * Keep only chains with a round created in the range, including on ancestor rows.
 *
 * A plan may hold SEVERAL execution chains (independent parallel executions). The
 * whole chain is kept — every round of it — when any round matches, but a chain
 * that does not match is not shown at all: a sibling chain belongs to a different
 * work item and the range must not expose it. Node status and progress are NOT
 * recomputed from the surviving subset; they keep describing the plan as the host
 * projected it.
 * @param {object} node - a projected tree node.
 * @param {object} range - a normalised range, or `null` for "no date filter".
 * @returns {object} the node, with `executions` narrowed when a range applies.
 */
function withDateFilteredChains(node, range) {
  if (range === null) return node;
  if (node.kind === 'plan' && Array.isArray(node.executions)) {
    const executions = node.executions.filter((chain) => chainCreatedInRange(chain, range));
    return executions.length === node.executions.length ? node : { ...node, executions };
  }
  if (node.chain && !chainCreatedInRange(node.chain, range)) {
    return { ...node, chain: null, rounds: [], roundCount: 0 };
  }
  return node;
}

/**
 * Project the host's task tree into the panel's groups.
 *
 * `dateRange` narrows the tree by CREATION date and composes with the project,
 * the status and the text filters: a node has to satisfy all of them, except that
 * a node needed only as the ANCESTOR of a surviving node is kept as a structural
 * wrapper (it contributes no counts and is not itself a hit), exactly as the text
 * search already keeps such ancestors. The original hierarchy and the per-node
 * child progress are preserved, so an ancestor still reports "2/3 accepted".
 * @param {object} tree - the host's tree projection.
 * @param {object} options - `projectKey`, `filter`, `search`, `selectedTaskId`, `dateRange`.
 * @returns {{ groups: object[], archiveCount: number, dateError: string | null }} view.
 */
export function projectTaskView(tree, { projectKey, filter, search, selectedTaskId, dateRange }) {
  const words = search.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const parsed = normalizeDayRange(dateRange ?? {});
  // A null range means "no date condition at all" — the single value both the node
  // test and the per-chain narrowing read, so an empty or invalid range cannot make
  // one of them filter what the other does not.
  const range = parsed.error === null && (parsed.from !== null || parsed.to !== null) ? parsed : null;
  const projects = new Map(tree.projects.map((project) => [project.projectKey, project]));
  const counts = new Map();
  const groups = new Map();
  const recent = [];
  let archiveCount = 0;
  const projectOf = (key) => projects.get(key) ?? {
    projectKey: key, name: key === 'unverified' ? '来源未确认' : '未命名项目',
  };

  function collect(node, parentArchived) {
    const archiveRoot = node.displayArchived === true && !parentArchived;
    const archived = parentArchived || archiveRoot;
    if (archiveRoot) archiveCount += 1;
    const key = node.projectKey ?? 'unverified';
    if (!archived) {
      const count = counts.get(key) ?? { total: 0, attention: 0 };
      count.total += 1;
      if (viewStatus(node.nodeStatus) === 'attention') count.attention += 1;
      counts.set(key, count);
    }
    for (const child of nodesOf(node)) collect(child, archived);
  }

  function visible(node, parentArchived, parentMatched) {
    const key = node.projectKey ?? 'unverified';
    const project = projectOf(key);
    const archived = parentArchived || node.displayArchived === true;
    const narrowed = withDateFilteredChains(node, range);
    const rounds = roundsOf(narrowed);
    const searchContext = [project.name, project.shortPath, project.sourcePath, node.nodeId, node.title, node.displayTitle];
    const matchesContext = parentMatched || hits(searchContext, words);
    const matchesText = matchesContext || hits([...searchContext, ...rounds.flatMap((round) => [round.title, round.taskId])], words);
    const matchesFilter = filter === 'archive' ? archived : !archived && (filter === 'all' || viewStatus(node.nodeStatus) === filter);
    const matchesDate = range === null || nodeCreatedInRange(node, range);
    const selected = selectedTaskId !== null && rounds.some((round) => round.taskId === selectedTaskId);
    const matchesProject = projectKey === '' || key === projectKey;
    if (matchesProject && archived === (filter === 'archive')) {
      const chains = narrowed.chain ? [narrowed.chain] : narrowed.executions ?? [];
      for (const chain of chains) {
        const matchesStatus = filter === 'all' || filter === 'archive' || viewStatus(chain.nodeStatus) === filter;
        const chainTerms = (chain.rounds ?? []).flatMap((round) => [round.title, round.taskId]);
        if (matchesStatus && (matchesContext || hits([...searchContext, chain.displayTitle, ...chainTerms], words))) {
          recent.push({ chain, node, project, archiveInherited: parentArchived });
        }
      }
    }
    const children = nodesOf(node).map((child) => visible(child, archived, matchesContext)).filter(Boolean);
    if (!(matchesProject && matchesFilter && matchesText && matchesDate) && children.length === 0 && !(selected && !archived)) return null;
    const originalChildren = nodesOf(node);
    const childProgress = { total: originalChildren.length, accepted: originalChildren.filter((item) => item.nodeStatus === 'accepted').length };
    // An ancestor can still label a matching child without showing its own out-of-range runs.
    return { ...narrowed, children, childProgress, displayArchiveInherited: parentArchived };
  }

  for (const root of tree.roots) collect(root, false);
  for (const root of tree.roots) {
    const branch = visible(root, false, false);
    if (branch === null) continue;
    const key = projectKey || (branch.projectKey ?? 'unverified');
    if (!groups.has(key)) groups.set(key, { ...projectOf(key), roots: [] });
    groups.get(key).roots.push(branch);
  }
  const result = [...groups.values()].map((group) => ({
    ...group,
    roots: ordered(group.roots),
    latestActivityAt: latestActivityIn(group.roots),
    count: counts.get(group.projectKey) ?? { total: 0, attention: 0 },
  }));
  result.sort((a, b) => Number(a.unverified === true) - Number(b.unverified === true)
    || priority(a.roots[0]) - priority(b.roots[0])
    || b.latestActivityAt - a.latestActivityAt
    || a.name.localeCompare(b.name));
  return { groups: result, recent, archiveCount, dateError: parsed.error, dateRangeText: { from: parsed.fromText, to: parsed.toText } };
}
