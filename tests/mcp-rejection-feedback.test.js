import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionBridge } from '../src/runtime/permissions.js';
import { createMcpServer, LATEST_PROTOCOL_VERSION } from '../src/mcp/server.js';

for (const injectFails of [false, true]) {
  for (const waitFails of [false, true]) {
    test(`rejection delivery fact survives the real bridge and MCP continuation (injectFails=${injectFails}, waitFails=${waitFails})`, async () => {
      const events = [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'tool/call', data: { callId: 'c', name: 'bash', arguments: '{"command":"x"}', turn: 1, step: 1 } },
      ];
      const inbox = [];
      const agent = {
        session: { id: 's', header: { cwd: 'C:/work' }, seq: events.length, eventAt: (i) => events[i] },
        inject(message) {
          if (injectFails) throw new Error('inbox closed');
          inbox.push(message);
        },
      };
      const bridge = new PermissionBridge({ taskId: 'task-feedback' });
      bridge.arm(agent);
      const waiting = bridge.answer({ agent, toolName: 'bash', callId: 'c' });
      await new Promise((resolve) => setImmediate(resolve));
      const requestId = bridge.pendingView().requestId;
      const server = createMcpServer({
        async callExecution(route, payload) {
          if (route === 'permission') {
            const permission = bridge.decide(payload);
            // Large native evidence exercises the last-layer receipt projection too.
            permission.grant = { notes: 'evidence'.repeat(8000) };
            return { ok: true, task: { taskId: 'task-feedback' }, permission };
          }
          if (waitFails) throw Object.assign(new Error('connection closed'), { code: 'MCP_REQUEST_TIMEOUT' });
          return { ok: true, reason: 'ready', task: { taskId: 'task-feedback', state: 'awaiting-host-review' } };
        },
      });
      await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION } });
      const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'delegate_permission_decide', arguments: { taskId: 'task-feedback', requestId, decision: 'reject', reason: 'Narrow this command.', waitAfterDecision: true },
      } });
      const result = JSON.parse(response.result.content[0].text);
      assert.equal(response.result.isError, undefined);
      assert.equal(await waiting, 'rejected');
      assert.equal(result.decisionReceipt.applied, true);
      assert.deepEqual(result.decisionReceipt.rejectionFeedback, {
        delivered: !injectFails, reason: injectFails ? 'inject-failed' : 'delivered',
      });
      assert.equal(inbox.length, injectFails ? 0 : 1);
      if (!injectFails) assert.match(inbox[0].content[0].text, /Narrow this command/u);
      if (waitFails) assert.equal(result.waitError.phase, 'follow-up-wait');
      assert.equal(result.decisionReceipt.rejectionFeedback.text, undefined);
      bridge.dispose();
    });
  }
}
