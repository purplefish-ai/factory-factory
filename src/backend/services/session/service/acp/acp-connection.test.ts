import { describe, expect, it, vi } from 'vitest';
import type { Stream } from '@/shared/acp-protocol/sdk-types';
import { AcpClientHandler } from './acp-client-handler';
import { createAcpConnection } from './acp-connection';
import { AcpPermissionBridge } from './acp-permission-bridge';
import { agent, methods, PROTOCOL_VERSION } from './acp-sdk-values';
import { TASK_STATUS_CHANGED_METHOD } from './acp-task-status-protocol';

function createStreams(): [Stream, Stream] {
  const outbound = new TransformStream();
  const inbound = new TransformStream();
  return [
    { readable: inbound.readable, writable: outbound.writable },
    { readable: outbound.readable, writable: inbound.writable },
  ];
}

describe('ACP SDK connection', () => {
  it('preserves draft capabilities and routes session, permission, and elicitation callbacks', async () => {
    const [clientStream, agentStream] = createStreams();
    const onEvent = vi.fn();
    const onLog = vi.fn();
    const server = agent()
      .onRequest(methods.agent.initialize, ({ params }) => {
        expect(params.clientCapabilities).toMatchObject({
          subagents: {},
          elicitation: { form: {}, url: {} },
        });
        return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
      })
      .onRequest(methods.agent.session.prompt, async ({ client }) => {
        await client.notify(methods.client.session.update, {
          sessionId: 'provider-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello' },
          },
        });
        expect(
          await client.request(methods.client.session.requestPermission, {
            sessionId: 'provider-session',
            toolCall: { toolCallId: 'tool-1', title: 'Shell' },
            options: [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
          })
        ).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
        expect(
          await client.request(methods.client.elicitation.create, {
            mode: 'form',
            sessionId: 'provider-session',
            message: 'Choose',
            requestedSchema: { type: 'object', properties: {} },
          })
        ).toEqual({ action: 'cancel' });
        await client.notify(methods.client.elicitation.complete, { elicitationId: 'form-1' });
        await client.notify(TASK_STATUS_CHANGED_METHOD, {
          sessionId: 'provider-session',
          active: true,
        });
        return { stopReason: 'end_turn' };
      })
      .connect(agentStream);
    const connection = createAcpConnection(
      new AcpClientHandler('local-session', onEvent, undefined, onLog),
      clientStream
    );
    try {
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { subagents: {}, elicitation: { form: {}, url: {} } },
      });
      await expect(
        connection.prompt({ sessionId: 'provider-session', prompt: [] })
      ).resolves.toMatchObject({ stopReason: 'end_turn' });
      expect(onEvent).toHaveBeenCalledWith('local-session', {
        type: 'acp_session_update',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
      });
      expect(onEvent).toHaveBeenCalledWith('local-session', {
        type: 'acp_task_status_changed',
        active: true,
      });
      expect(onLog).toHaveBeenCalledWith('local-session', {
        eventType: 'acp_elicitation_complete',
        elicitationId: 'form-1',
      });
    } finally {
      connection.close();
      server.close();
    }
  });

  it('cancels a pending local elicitation when the ACP requester aborts', async () => {
    const [clientStream, agentStream] = createStreams();
    const server = agent().connect(agentStream);
    const shown = Promise.withResolvers<string>();
    const cancelled = Promise.withResolvers<string>();
    const bridge = new AcpPermissionBridge(cancelled.resolve);
    const connection = createAcpConnection(
      new AcpClientHandler(
        'local-session',
        (_id, event) => {
          if (event.type === 'acp_permission_request') {
            shown.resolve(event.requestId);
          }
        },
        bridge
      ),
      clientStream
    );
    const abort = new AbortController();
    try {
      const request = server.client.request(
        methods.client.elicitation.create,
        {
          mode: 'form',
          sessionId: 'provider-session',
          message: 'Choose',
          requestedSchema: { type: 'object', properties: { note: { type: 'string' } } },
        },
        { cancellationSignal: abort.signal, stopWaitingOnCancel: true }
      );
      const rejected = expect(request).rejects.toMatchObject({ code: -32_800 });
      const requestId = await shown.promise;
      abort.abort();
      await rejected;
      await expect(cancelled.promise).resolves.toBe(requestId);
      expect(bridge.resolvePermission(requestId, 'accept', { note: ['stale'] })).toBe(false);
    } finally {
      connection.close();
      server.close();
    }
  });

  it('keeps extension requests and rejects unsupported client requests', async () => {
    const [clientStream, agentStream] = createStreams();
    const server = agent()
      .onRequest('*', ({ method, params }) => ({ method, params }))
      .connect(agentStream);
    const connection = createAcpConnection(
      new AcpClientHandler('local-session', vi.fn()),
      clientStream
    );
    try {
      await expect(
        connection.extMethod('factoryfactory.ai/subagents/list', { sessionId: 'provider-session' })
      ).resolves.toEqual({
        method: 'factoryfactory.ai/subagents/list',
        params: { sessionId: 'provider-session' },
      });
      await expect(
        server.client.request(methods.client.fs.writeTextFile, {
          sessionId: 'provider-session',
          path: '/tmp/unsupported',
          content: 'content',
        })
      ).rejects.toMatchObject({ code: -32_601 });
    } finally {
      connection.close();
      server.close();
    }
  });
});
