import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SUBAGENTS_CHANGED_METHOD } from '@/shared/acp-protocol/subagents';
import { AcpClientHandler, type AcpEventCallback, type AcpLogCallback } from './acp-client-handler';
import type { AcpPermissionBridge } from './acp-permission-bridge';

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

  describe('requestPermission with autoApprovePolicy', () => {
    it('auto-approves with allow_always when autoApprovePolicy is "all"', async () => {
      const handler = new AcpClientHandler('session-1', onEvent, undefined, onLog, 'all');
      const params = createMockPermissionRequest();

      const response = await handler.requestPermission(params);

      expect(response.outcome).toEqual({
        outcome: 'selected',
        optionId: 'allow_always',
      });
    });

    it('selects first allow option from the options list when auto-approving', async () => {
      const handler = new AcpClientHandler('session-1', onEvent, undefined, onLog, 'all');
      const params = createMockPermissionRequest({
        options: [
          { optionId: 'opt-reject', kind: 'reject_once', name: 'Reject' },
          { optionId: 'opt-allow-always', kind: 'allow_always', name: 'Allow for session' },
          { optionId: 'opt-allow-once', kind: 'allow_once', name: 'Allow once' },
        ],
      } as Partial<RequestPermissionRequest>);

      const response = await handler.requestPermission(params);

      expect(response.outcome).toHaveProperty('optionId');
      expect((response.outcome as Record<string, unknown>).optionId).toBe('opt-allow-always');
    });

    it('falls back to allow_once when allow_always is not available', async () => {
      const handler = new AcpClientHandler('session-1', onEvent, undefined, onLog, 'all');
      const params = createMockPermissionRequest({
        options: [
          { optionId: 'opt-allow-once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'opt-reject', kind: 'reject_once', name: 'Reject' },
        ],
      } as Partial<RequestPermissionRequest>);

      const response = await handler.requestPermission(params);

      expect(response.outcome).toHaveProperty('optionId');
      expect((response.outcome as Record<string, unknown>).optionId).toBe('opt-allow-once');
    });

    it('logs the auto-approved permission request', async () => {
      const logFn = vi.fn();
      const handler = new AcpClientHandler('session-1', onEvent, undefined, logFn, 'all');
      const params = createMockPermissionRequest();

      await handler.requestPermission(params);

      expect(logFn).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          eventType: 'acp_permission_request',
          toolCallId: 'tc-001',
        })
      );
    });

    it('does not emit permission request event to WebSocket when auto-approving', async () => {
      const eventFn = vi.fn();
      const handler = new AcpClientHandler('session-1', eventFn, undefined, onLog, 'all');
      const params = createMockPermissionRequest();

      await handler.requestPermission(params);

      expect(eventFn).not.toHaveBeenCalled();
    });

    it('forwards to permission bridge when autoApprovePolicy is "none"', async () => {
      const bridge = {
        waitForUserResponse: vi.fn().mockResolvedValue({
          outcome: { outcome: 'selected', optionId: 'allow_once' },
        }),
      } as unknown as AcpPermissionBridge;
      const eventFn = vi.fn();
      const handler = new AcpClientHandler('session-1', eventFn, bridge, onLog, 'none');
      const params = createMockPermissionRequest();

      const response = await handler.requestPermission(params);

      expect(bridge.waitForUserResponse).toHaveBeenCalled();
      expect(eventFn).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          type: 'acp_permission_request',
        })
      );
      expect(response.outcome).toHaveProperty('optionId');
      expect((response.outcome as Record<string, unknown>).optionId).toBe('allow_once');
    });

    it('defaults to "none" policy when autoApprovePolicy is not provided', async () => {
      const bridge = {
        waitForUserResponse: vi.fn().mockResolvedValue({
          outcome: { outcome: 'selected', optionId: 'allow_once' },
        }),
      } as unknown as AcpPermissionBridge;
      const handler = new AcpClientHandler('session-1', onEvent, bridge, onLog);
      const params = createMockPermissionRequest();

      await handler.requestPermission(params);

      expect(bridge.waitForUserResponse).toHaveBeenCalled();
    });

    it('auto-approves even when permission bridge is present in "all" mode', async () => {
      const bridge = {
        waitForUserResponse: vi.fn(),
      } as unknown as AcpPermissionBridge;
      const handler = new AcpClientHandler('session-1', onEvent, bridge, onLog, 'all');
      const params = createMockPermissionRequest();

      const response = await handler.requestPermission(params);

      expect(bridge.waitForUserResponse).not.toHaveBeenCalled();
      expect(response.outcome).toEqual({
        outcome: 'selected',
        optionId: 'allow_always',
      });
    });

    it('fails closed when permission bridge is missing and autoApprovePolicy is "none"', async () => {
      const handler = new AcpClientHandler('session-1', onEvent, undefined, onLog, 'none');
      const params = createMockPermissionRequest({
        options: [
          { optionId: 'opt-allow', kind: 'allow_once', name: 'Allow' },
          { optionId: 'opt-reject', kind: 'reject_once', name: 'Reject' },
        ],
      } as Partial<RequestPermissionRequest>);

      const response = await handler.requestPermission(params);

      expect(response.outcome).toEqual({
        outcome: 'selected',
        optionId: 'opt-reject',
      });
    });

    it('cancels when failing closed and no reject option is available', async () => {
      const handler = new AcpClientHandler('session-1', onEvent, undefined, onLog, 'none');
      const params = createMockPermissionRequest({
        options: [{ optionId: 'opt-allow', kind: 'allow_once', name: 'Allow' }],
      } as Partial<RequestPermissionRequest>);

      const response = await handler.requestPermission(params);

      expect(response.outcome).toEqual({
        outcome: 'cancelled',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Permission bridge missing; cancelling ACP permission request',
        expect.objectContaining({
          sessionId: 'session-1',
          toolCallId: 'tc-001',
          requestType: 'permission',
        })
      );
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('rejecting ACP permission request'),
        expect.anything()
      );
    });

    it('does not auto-approve ExitPlanMode requests even in "all" mode', async () => {
      const bridge = {
        waitForUserResponse: vi.fn().mockResolvedValue({
          outcome: { outcome: 'selected', optionId: 'plan' },
        }),
      } as unknown as AcpPermissionBridge;
      const eventFn = vi.fn();
      const handler = new AcpClientHandler('session-1', eventFn, bridge, onLog, 'all');
      const params = createMockPermissionRequest({
        toolCall: {
          toolCallId: 'tc-exit-plan',
          title: 'ExitPlanMode',
          status: 'pending',
          rawInput: { type: 'ExitPlanMode' },
        },
        options: [
          { optionId: 'default', kind: 'allow_once', name: 'Approve Plan' },
          { optionId: 'plan', kind: 'reject_once', name: 'Keep Planning' },
        ],
      });

      const response = await handler.requestPermission(params);

      expect(bridge.waitForUserResponse).toHaveBeenCalled();
      expect(eventFn).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          type: 'acp_permission_request',
        })
      );
      expect(response.outcome).toEqual({
        outcome: 'selected',
        optionId: 'plan',
      });
    });

    it('does not auto-approve requestUserInput prompts even in "all" mode', async () => {
      const bridge = {
        waitForUserResponse: vi.fn().mockResolvedValue({
          outcome: { outcome: 'selected', optionId: 'allow_once' },
        }),
      } as unknown as AcpPermissionBridge;
      const eventFn = vi.fn();
      const handler = new AcpClientHandler('session-1', eventFn, bridge, onLog, 'all');
      const params = createMockPermissionRequest({
        toolCall: {
          toolCallId: 'tc-user-input',
          title: 'item/tool/requestUserInput',
          status: 'pending',
          rawInput: {
            questions: [{ id: 'q1', question: 'Select an option', options: [{ label: 'A' }] }],
          },
        },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Submit' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Cancel' },
        ],
      });

      const response = await handler.requestPermission(params);

      expect(bridge.waitForUserResponse).toHaveBeenCalled();
      expect(eventFn).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          type: 'acp_permission_request',
        })
      );
      expect(response.outcome).toEqual({
        outcome: 'selected',
        optionId: 'allow_once',
      });
    });

    it('fails closed for requestUserInput when permission bridge is missing', async () => {
      const handler = new AcpClientHandler('session-1', onEvent, undefined, onLog, 'all');
      const params = createMockPermissionRequest({
        toolCall: {
          toolCallId: 'tc-user-input-no-bridge',
          title: 'item/tool/requestUserInput',
          status: 'pending',
          rawInput: {
            questions: [{ id: 'q1', question: 'Select an option', options: [{ label: 'A' }] }],
          },
        },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Submit' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Cancel' },
        ],
      });

      const response = await handler.requestPermission(params);

      expect(response.outcome).toEqual({
        outcome: 'selected',
        optionId: 'reject_once',
      });
    });
  });

  describe('extension notifications', () => {
    it('dispatches task activity changes under the DB session ID', async () => {
      const eventFn = vi.fn();
      const handler = new AcpClientHandler('db-session-1', eventFn, undefined, vi.fn(), 'all');

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
      const handler = new AcpClientHandler('db-session-1', eventFn, undefined, logFn, 'all');

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
      const handler = new AcpClientHandler('db-session-1', eventFn, undefined, logFn, 'all');

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
      const handler = new AcpClientHandler('db-session-1', eventFn, undefined, logFn, 'all');
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
