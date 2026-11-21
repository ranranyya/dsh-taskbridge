// The `/session-map` route: the ONE read that lets the grouped sidebar prove ownership.
//
// The route publishes the plugin's durable task → Workspace/Session identity map, and it is
// the only TaskBridge data the grouped browser consumes. Two properties matter and are
// pinned here:
//
//   * it is IDENTITY ONLY — no prompt, no transcript, no model output, no credential has a
//     field, and a stored row's extra fields never leak through;
//   * it is HONEST — a deployment with no identity store answers `503`, an unreadable one
//     answers `503` with its own code, and a row that cannot name both ids is dropped
//     instead of published half-formed (a half row could only be turned into a guess).
//
// It is on the authenticated operator plane like every other settings-area read, reads only,
// and touches no task, no Workspace and no Session.

import test from 'node:test';
import assert from 'node:assert/strict';

import { wrapUserPlaneRoutes, USER_PLANE_PREFIX } from '../src/http/user-plane.js';

/**
 * Call one route as the operator plane serves it.
 *
 * The wrapper is what turns a refusal (`HttpError`) into the JSON envelope the page reads,
 * so it is part of the contract under test, not a shortcut around it.
 */
async function callRoute(deps, path) {
  const routes = wrapUserPlaneRoutes({ ...deps, engine: { authorizationMode: 'switch' } });
  const route = routes.find((entry) => entry.path === `${USER_PLANE_PREFIX}/${path}`);
  assert.ok(route !== undefined, `the route ${path} is registered`);
  assert.deepEqual(route.methods, ['GET'], 'the map is a read');
  const response = await route.fetch(new Request(`http://127.0.0.1:3210${route.path}`, { method: 'GET' }));
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/** A minimal dependency object: the route touches only `sessionStore`. */
function depsWith(sessionStore) {
  return { sessionStore, logger: { warn() {} } };
}

const ROW = Object.freeze({
  taskId: 'task-1',
  sourcePath: 'C:\\work\\alpha',
  executionPath: 'C:\\work\\alpha\\tree',
  sourcePathDigest: 'sha256:aaa',
  executionPathDigest: 'sha256:bbb',
  workspaceId: 'ws-1',
  sessionId: 'session-1',
  isolation: 'worktree',
  worktreeId: 'task-1',
  worktreeState: 'active',
  updatedAt: 1000,
  // Anything a future build might store: carried only if it is on the field list.
  prompt: 'SECRET PROMPT CONTENT',
  transcript: [{ role: 'user', content: 'nope' }],
});

test('the session map publishes identity fields only, newest first', async () => {
  let listed = 0;
  const { status, body } = await callRoute(depsWith({
    async list() {
      listed += 1;
      return [{ ...ROW, taskId: 'task-old', sessionId: 'session-old', updatedAt: 500 }, ROW];
    },
  }), 'session-map');

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(listed, 1, 'one read of the store');
  assert.equal(body.sessions.length, 2);
  assert.deepEqual(body.sessions.map((row) => row.sessionId), ['session-1', 'session-old'],
    'newest first, so a reader can take the first proof');
  const [newest] = body.sessions;
  // Exactly the identity a view model needs, and nothing else.
  assert.deepEqual(Object.keys(newest).sort(), [
    'executionPath', 'executionPathDigest', 'isolation', 'sessionId', 'sourcePath',
    'sourcePathDigest', 'taskId', 'updatedAt', 'workspaceId', 'worktreeId', 'worktreeState',
  ]);
  assert.equal(JSON.stringify(body).includes('SECRET PROMPT'), false, 'a prompt is never published');
  assert.equal(JSON.stringify(body).includes('transcript'), false, 'a transcript is never published');
});

test('a row that cannot name a workspace or a session is dropped, not published half-formed', async () => {
  const { status, body } = await callRoute(depsWith({
    async list() {
      return [
        { ...ROW },
        { ...ROW, sessionId: '', taskId: 'task-2' },
        { ...ROW, workspaceId: '', taskId: 'task-3' },
        { ...ROW, taskId: 'task-4', sessionId: null },
        null,
        'not a row',
      ];
    },
  }), 'session-map');
  assert.equal(status, 200);
  assert.deepEqual(body.sessions.map((row) => row.taskId), ['task-1'],
    'only the row that proves a placement survives');
});

test('an absent or unreadable identity store is a stated refusal, never an empty success', async () => {
  const missing = await callRoute(depsWith(null), 'session-map');
  assert.equal(missing.status, 503);
  assert.equal(missing.body.error.code, 'SESSION_MAP_UNAVAILABLE');

  const noStore = await callRoute({ logger: { warn() {} } }, 'session-map');
  assert.equal(noStore.status, 503);
  assert.equal(noStore.body.error.code, 'SESSION_MAP_UNAVAILABLE');

  const broken = await callRoute(depsWith({
    async list() {
      throw Object.assign(new Error('the document is not valid JSON'), { code: 'EACCES' });
    },
  }), 'session-map');
  assert.equal(broken.status, 503);
  assert.equal(broken.body.error.code, 'SESSION_MAP_UNREADABLE');
  // The refusal must not echo what it could not read.
  assert.equal(JSON.stringify(broken.body).includes('not valid JSON'), false);
});
