import { createHash } from 'node:crypto';
import { JsonDocument } from '../config/store.js';

const MAX_ARCHIVES = 2048;
const ARCHIVABLE = 'accepted';

function chainsOf(node) {
  return node.kind === 'plan' ? node.executions : [node.chain];
}

// Hash only the facts that made this subtree eligible. A continuation, a changed
// review or a missing history entry brings the subtree back into the active view.
function activityStamp(node) {
  const evidence = [node.nodeId, node.nodeStatus, node.hostAcceptance?.acceptedAt ?? null];
  for (const chain of chainsOf(node)) {
    evidence.push(chain.rounds.map((round) => [round.taskId, round.state, round.hostAcceptance?.acceptedAt ?? null]));
  }
  evidence.push(node.children.map(activityStamp));
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

export function findDisplayNode(roots, nodeId) {
  const remaining = [...roots];
  while (remaining.length > 0) {
    const node = remaining.pop();
    if (node.nodeId === nodeId) return node;
    remaining.push(...node.children);
  }
  return null;
}

export class TaskDisplayStore extends JsonDocument {
  constructor(dataDir) {
    super(dataDir, 'task-display.json', {
      schemaVersion: 1,
      initial: () => ({ schemaVersion: 1, archives: {} }),
    });
  }

  async project(tree) {
    const { archives } = await this.load();
    if (!archives || typeof archives !== 'object' || Array.isArray(archives)) throw new Error('invalid display archive');
    const hidden = new Set();
    const visit = (node) => {
      node.displayArchived = node.nodeStatus === ARCHIVABLE
        && Object.hasOwn(archives, node.nodeId)
        && archives[node.nodeId] === activityStamp(node);
      if (node.displayArchived) hidden.add(node.nodeId);
      for (const child of node.children) visit(child);
    };
    for (const root of tree.roots) visit(root);
    for (const node of tree.flatNodes) node.displayArchived = hidden.has(node.nodeId);
  }

  async setArchived(node, archived, knownIds) {
    if (archived && node.nodeStatus !== ARCHIVABLE) return { conflict: 'TASK_DISPLAY_NOT_ACCEPTED' };
    let limitReached = false;
    await this.commit((draft) => {
      if (!draft.archives || typeof draft.archives !== 'object' || Array.isArray(draft.archives)) throw new Error('invalid display archive');
      for (const id of Object.keys(draft.archives)) {
        if (!knownIds.has(id)) delete draft.archives[id];
      }
      if (!archived) {
        delete draft.archives[node.nodeId];
      } else if (Object.hasOwn(draft.archives, node.nodeId) || Object.keys(draft.archives).length < MAX_ARCHIVES) {
        Object.defineProperty(draft.archives, node.nodeId, { value: activityStamp(node), enumerable: true, configurable: true, writable: true });
      } else {
        limitReached = true;
      }
    });
    return limitReached ? { conflict: 'TASK_DISPLAY_LIMIT' } : { archived };
  }
}
