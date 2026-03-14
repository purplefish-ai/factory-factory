import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AcpClientHandler, type AcpEventCallback, type AcpLogCallback } from './acp-client-handler';
import type { AcpPermissionBridge } from './acp-permission-bridge';

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
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
  });
});
