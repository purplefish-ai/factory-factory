import type { RequestPermissionRequest } from '@agentclientprotocol/sdk/unstable';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SUBAGENTS_CHANGED_METHOD } from '@/shared/acp-protocol/subagents';
import { AcpClientHandler, type AcpEventCallback, type AcpLogCallback } from './acp-client-handler';
import { AcpPermissionBridge } from './acp-permission-bridge';

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => mockLogger,
}));

function createMockPermissionRequest(
  overrides?: Partial<RequestPermissionRequest>
): RequestPermissionRequest {
  return {
    sessionId: 'session-1',
    toolCall: {
      toolCallId: 'tc-001',
      title: 'Write file',
      status: 'pending',
    },
    options: [
      { optionId: 'allow_always', kind: 'allow_always', name: 'Allow for session' },
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
    ],
    ...overrides,
  } as RequestPermissionRequest;
}

describe('AcpClientHandler', () => {
  const onEvent: AcpEventCallback = vi.fn();
  const onLog: AcpLogCallback = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('permission requests', () => {
    it('warns when a missing permission bridge fails closed', async () => {
      const handler = new AcpClientHandler('session-1', onEvent);
      await expect(handler.requestPermission(createMockPermissionRequest())).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'reject_once' },
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Permission bridge missing; failing closed on ACP permission request',
        { sessionId: 'session-1', toolCallId: 'tc-001' }
      );
    });

    it('warns when a missing permission bridge cancels elicitation', async () => {
      const handler = new AcpClientHandler('session-1', onEvent);
      await expect(
        handler.createElicitation({
          mode: 'form',
          sessionId: 'provider-1',
          message: 'Input',
          requestedSchema: { properties: {} },
        })
      ).resolves.toEqual({ action: 'cancel' });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Permission bridge missing; cancelling ACP elicitation',
        { sessionId: 'session-1', mode: 'form' }
      );
    });

    it('requires an explicit choice for ordinary tool requests', async () => {
      const bridge = new AcpPermissionBridge();
      const eventFn = vi.fn();
      const handler = new AcpClientHandler('session-1', eventFn, bridge, onLog);
      const response = handler.requestPermission(createMockPermissionRequest());
      const event = eventFn.mock.calls[0]![1];
      expect(bridge.pendingCount).toBe(1);
      expect(event.params.toolCall.title).toBe('Write file');
      bridge.resolvePermission(event.requestId, 'allow_once');
      await expect(response).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'allow_once' },
      });
    });

    it.each([true, false])(
      'normalizes upstream plan review (metadata=%s) and preserves provider options',
      async (metadata) => {
        const bridge = new AcpPermissionBridge();
        const eventFn = vi.fn();
        const handler = new AcpClientHandler('session-1', eventFn, bridge, onLog);
        const params = createMockPermissionRequest({
          ...(metadata ? { _meta: { codex: { kind: 'plan_review' } } } : {}),
          toolCall: {
            toolCallId: 'plan-review:1',
            title: metadata ? 'Review this proposal' : 'Implement this plan?',
            kind: 'switch_mode',
            rawInput: { plan: '# Plan' },
          },
          options: [
            { optionId: 'implement_plan', kind: 'allow_once', name: 'Implement' },
            { optionId: 'revise_plan', kind: 'reject_once', name: 'Revise' },
          ],
        });
        const response = handler.requestPermission(params);
        const event = eventFn.mock.calls[0]![1];
        expect(event.params.toolCall).toMatchObject({
          title: 'ExitPlanMode',
          rawInput: { type: 'ExitPlanMode', plan: '# Plan', providerContinuesAfterApproval: true },
        });
        expect(event.params.options).toEqual(params.options);
        bridge.resolvePermission(event.requestId, 'implement_plan');
        await expect(response).resolves.toEqual({
          outcome: { outcome: 'selected', optionId: 'implement_plan' },
        });
      }
    );

    it('preserves the reviewer automatic rejection policy', async () => {
      const bridge = new AcpPermissionBridge(undefined, () => ({
        outcome: { outcome: 'selected', optionId: 'reject_once' },
      }));
      const handler = new AcpClientHandler('session-1', onEvent, bridge, onLog);
      await expect(handler.requestPermission(createMockPermissionRequest())).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'reject_once' },
      });
      expect(onEvent).not.toHaveBeenCalled();
    });
  });

  describe('extension notifications', () => {
    it('dispatches task activity changes under the DB session ID', async () => {
      const eventFn = vi.fn();
      const handler = new AcpClientHandler('db-session-1', eventFn, undefined, vi.fn());

      await handler.extNotification('factoryfactory.ai/task/status-changed', {
        sessionId: 'provider-session-123',
        active: true,
      });

      expect(eventFn).toHaveBeenCalledWith('db-session-1', {
        type: 'acp_task_status_changed',
        active: true,
      });
    });

    it('logs then dispatches a valid sub-agent change under the DB session ID', async () => {
      const eventFn = vi.fn();
      const logFn = vi.fn();
      const handler = new AcpClientHandler('db-session-1', eventFn, undefined, logFn);

      await handler.extNotification(SUBAGENTS_CHANGED_METHOD, {
        sessionId: 'provider-session-123',
        subagentId: 'child-1',
        change: 'updated',
      });

      expect(logFn).toHaveBeenCalledWith('db-session-1', {
        eventType: 'acp_extension_notification',
        method: SUBAGENTS_CHANGED_METHOD,
        data: {
          sessionId: 'provider-session-123',
          subagentId: 'child-1',
          change: 'updated',
        },
      });
      expect(eventFn).toHaveBeenCalledWith('db-session-1', {
        type: 'acp_subagents_changed',
        subagentId: 'child-1',
        change: 'updated',
      });
      expect(logFn.mock.invocationCallOrder[0]).toBeLessThan(eventFn.mock.invocationCallOrder[0]!);
    });

    it('logs and ignores unknown extension notifications', async () => {
      const eventFn = vi.fn();
      const logFn = vi.fn();
      const handler = new AcpClientHandler('db-session-1', eventFn, undefined, logFn);

      await expect(
        handler.extNotification('example.invalid/changed', { value: 1 })
      ).resolves.toBeUndefined();

      expect(logFn).toHaveBeenCalledWith('db-session-1', {
        eventType: 'acp_extension_notification',
        method: 'example.invalid/changed',
        data: { value: 1 },
      });
      expect(eventFn).not.toHaveBeenCalled();
    });

    it('logs and ignores malformed known extension notifications', async () => {
      const eventFn = vi.fn();
      const logFn = vi.fn();
      const handler = new AcpClientHandler('db-session-1', eventFn, undefined, logFn);
      const malformed = {
        sessionId: 'provider-session-123',
        subagentId: '',
        change: 'invalid',
      };

      await expect(
        handler.extNotification(SUBAGENTS_CHANGED_METHOD, malformed)
      ).resolves.toBeUndefined();

      expect(logFn).toHaveBeenCalledWith('db-session-1', {
        eventType: 'acp_extension_notification',
        method: SUBAGENTS_CHANGED_METHOD,
        data: malformed,
      });
      expect(eventFn).not.toHaveBeenCalled();
    });
  });
});

describe('AcpClientHandler callbacks', () => {
  it('AcpEventCallback is a discriminated ACP runtime event union', () => {
    expect.assertions(7);
    const onEvent: AcpEventCallback = (_sessionId, event) => {
      if (event.type === 'acp_session_update') {
        expect(event.update.sessionUpdate).toBe('agent_message_chunk');
        return;
      }

      if (event.type === 'acp_permission_request') {
        expect(event.params.toolCall.toolCallId).toBe('tc-1');
        return;
      }

      if (event.type === 'acp_task_status_changed') {
        expect(event.active).toBe(true);
        return;
      }

      if (event.type === 'acp_subagent_tool_update') {
        expect(event.subagentId).toBe('child-1');
        expect(event.update.toolCallId).toBe('tc-1');
        return;
      }

      expect(event.subagentId).toBe('child-1');
      expect(event.change).toBe('updated');
    };

    onEvent('test-session', {
      type: 'acp_session_update',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
      },
    });

    onEvent('test-session', {
      type: 'acp_permission_request',
      requestId: 'req-1',
      params: {
        sessionId: 'provider-session-1',
        toolCall: { toolCallId: 'tc-1', title: 'Write file' },
        options: [{ optionId: 'allow-1', kind: 'allow_once', name: 'Allow once' }],
      },
    });

    onEvent('test-session', {
      type: 'acp_task_status_changed',
      active: true,
    });

    onEvent('test-session', {
      type: 'acp_subagent_tool_update',
      subagentId: 'child-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Terminal',
        rawInput: { command: 'gh pr create --fill' },
      },
    });

    onEvent('test-session', {
      type: 'acp_subagents_changed',
      subagentId: 'child-1',
      change: 'updated',
    });
  });

  it('sessionUpdate emits logs through onLog callback', async () => {
    const onEvent = vi.fn();
    const onLog = vi.fn();

    const handler = new AcpClientHandler('test-session', onEvent, undefined, onLog);

    await handler.sessionUpdate({
      sessionId: 'provider-session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
      },
    });

    expect(onLog).toHaveBeenCalledWith('test-session', {
      eventType: 'acp_session_update',
      sessionUpdate: 'agent_message_chunk',
      data: expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
    });
  });

  it('sessionUpdate forwards all events as acp_session_update wrapper', async () => {
    const onEvent = vi.fn();

    const handler = new AcpClientHandler('test-session', onEvent);

    await handler.sessionUpdate({
      sessionId: 'provider-session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
      },
    });

    expect(onEvent).toHaveBeenCalledWith('test-session', {
      type: 'acp_session_update',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
      },
    });
  });

  it('sessionUpdate forwards tool_call events as acp_session_update wrapper', async () => {
    const onEvent = vi.fn();

    const handler = new AcpClientHandler('test-session', onEvent);

    await handler.sessionUpdate({
      sessionId: 'provider-session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Read file',
        kind: 'read',
        status: 'in_progress',
      },
    });

    expect(onEvent).toHaveBeenCalledWith('test-session', {
      type: 'acp_session_update',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Read file',
        kind: 'read',
        status: 'in_progress',
      },
    });
  });

  it('sessionUpdate forwards all event types including previously deferred ones', async () => {
    const onEvent = vi.fn();

    const handler = new AcpClientHandler('test-session', onEvent);

    await handler.sessionUpdate({
      sessionId: 'provider-session-1',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking...' },
      },
    });

    expect(onEvent).toHaveBeenCalledWith('test-session', {
      type: 'acp_session_update',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking...' },
      },
    });
  });

  it('requestPermission fails closed by default when no bridge exists', async () => {
    const onEvent = vi.fn();

    const handler = new AcpClientHandler('test-session', onEvent);

    const result = await handler.requestPermission({
      sessionId: 'provider-session-1',
      toolCall: { toolCallId: 'tc-1', title: 'Write file' },
      options: [
        { optionId: 'reject-1', kind: 'reject_once', name: 'Deny' },
        { optionId: 'allow-1', kind: 'allow_always', name: 'Allow Always' },
        { optionId: 'allow-2', kind: 'allow_once', name: 'Allow Once' },
      ],
    });

    expect(result).toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'reject-1',
      },
    });
  });

  it('requestPermission selects a reject option when no bridge exists', async () => {
    const onEvent = vi.fn();

    const handler = new AcpClientHandler('test-session', onEvent);

    const result = await handler.requestPermission({
      sessionId: 'provider-session-1',
      toolCall: { toolCallId: 'tc-1', title: 'Write file' },
      options: [
        { optionId: 'reject-1', kind: 'reject_once', name: 'Deny' },
        { optionId: 'reject-2', kind: 'reject_always', name: 'Deny Always' },
      ],
    });

    expect(result).toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'reject-1',
      },
    });
  });
});
