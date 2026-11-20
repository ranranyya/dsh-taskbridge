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

function roundsOf(node) {
  const chains = node.chain ? [node.chain] : node.executions ?? [];
  return chains.flatMap((chain) => chain.rounds ?? []);
}

export function projectTaskView(tree, { projectKey, filter, search, selectedTaskId }) {
  const words = search.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const projects = new Map(tree.projects.map((project) => [project.projectKey, project]));
  const counts = new Map();
  const groups = new Map();
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
    const rounds = roundsOf(node);
    const matchesText = parentMatched || hits([
      project.name, project.shortPath, project.sourcePath, node.nodeId,
      node.title, node.displayTitle, ...rounds.flatMap((round) => [round.title, round.taskId]),
    ], words);
    const matchesFilter = filter === 'archive' ? archived : !archived && (filter === 'all' || viewStatus(node.nodeStatus) === filter);
    const selected = selectedTaskId !== null && rounds.some((round) => round.taskId === selectedTaskId);
    const children = nodesOf(node).map((child) => visible(child, archived, matchesText)).filter(Boolean);
    const matchesProject = projectKey === '' || key === projectKey;
    if (!(matchesProject && matchesFilter && matchesText) && children.length === 0 && !(selected && !archived)) return null;
    const originalChildren = nodesOf(node);
    const childProgress = { total: originalChildren.length, accepted: originalChildren.filter((item) => item.nodeStatus === 'accepted').length };
    return { ...node, children, childProgress, displayArchiveInherited: parentArchived };
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
    count: counts.get(group.projectKey) ?? { total: 0, attention: 0 },
  }));
  result.sort((a, b) => Number(a.unverified === true) - Number(b.unverified === true)
    || priority(a.roots[0]) - priority(b.roots[0])
    || a.name.localeCompare(b.name));
  return { groups: result, archiveCount };
}
