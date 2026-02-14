import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpPermissionBridge } from './acp-permission-bridge';

function createMockParams(overrides?: Partial<RequestPermissionRequest>): RequestPermissionRequest {
  return {
    sessionId: 'session-1',
    toolCall: {
      toolCallId: 'tc-001',
      title: 'Write file',
      status: 'pending',
    },
    options: [
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Reject once' },
    ],
    ...overrides,
  } as RequestPermissionRequest;
}

describe('AcpPermissionBridge', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waitForUserResponse creates a pending entry', () => {
    const bridge = new AcpPermissionBridge();
    const params = createMockParams();

    // Start waiting (don't await -- it would block)
    void bridge.waitForUserResponse('req-1', params);

    expect(bridge.hasPending('req-1')).toBe(true);
    expect(bridge.pendingCount).toBe(1);
  });

  it('resolvePermission resolves the Promise with correct optionId', async () => {
    const bridge = new AcpPermissionBridge();
    const params = createMockParams();

    const promise = bridge.waitForUserResponse('req-1', params);
    const resolved = bridge.resolvePermission('req-1', 'allow_once');

    expect(resolved).toBe(true);

    const response: RequestPermissionResponse = await promise;
    expect(response).toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'allow_once',
      },
    });

    // Entry should be cleaned up
    expect(bridge.hasPending('req-1')).toBe(false);
    expect(bridge.pendingCount).toBe(0);
  });

  it('resolvePermission returns false for unknown requestId', () => {
    const bridge = new AcpPermissionBridge();

    const result = bridge.resolvePermission('nonexistent', 'allow_once');

    expect(result).toBe(false);
  });

  it('cancelAll resolves all pending with cancelled outcome', async () => {
    const bridge = new AcpPermissionBridge();

    const promise1 = bridge.waitForUserResponse('req-1', createMockParams());
    const promise2 = bridge.waitForUserResponse('req-2', createMockParams());

    bridge.cancelAll();

    const [response1, response2] = await Promise.all([promise1, promise2]);

    expect(response1).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(response2).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('cancelAll clears the pending map', () => {
    const bridge = new AcpPermissionBridge();

    void bridge.waitForUserResponse('req-1', createMockParams());
    void bridge.waitForUserResponse('req-2', createMockParams());
    expect(bridge.pendingCount).toBe(2);

    bridge.cancelAll();

    expect(bridge.pendingCount).toBe(0);
    expect(bridge.hasPending('req-1')).toBe(false);
    expect(bridge.hasPending('req-2')).toBe(false);
  });

  it('handles multiple concurrent permissions with different requestIds', async () => {
    const bridge = new AcpPermissionBridge();

    const params1 = createMockParams({ sessionId: 'session-1' });
    const params2 = createMockParams({ sessionId: 'session-2' });

    const promise1 = bridge.waitForUserResponse('req-1', params1);
    const promise2 = bridge.waitForUserResponse('req-2', params2);

    expect(bridge.pendingCount).toBe(2);

    // Resolve in reverse order
    bridge.resolvePermission('req-2', 'reject_once');
    bridge.resolvePermission('req-1', 'allow_once');

    const [response1, response2] = await Promise.all([promise1, promise2]);

    expect(response1.outcome).toEqual({ outcome: 'selected', optionId: 'allow_once' });
    expect(response2.outcome).toEqual({ outcome: 'selected', optionId: 'reject_once' });
  });

  it('hasPending returns correct boolean', () => {
    const bridge = new AcpPermissionBridge();

    expect(bridge.hasPending('req-1')).toBe(false);

    void bridge.waitForUserResponse('req-1', createMockParams());
    expect(bridge.hasPending('req-1')).toBe(true);

    bridge.resolvePermission('req-1', 'allow_once');
    expect(bridge.hasPending('req-1')).toBe(false);
  });

  it('pendingCount tracks entries correctly', () => {
    const bridge = new AcpPermissionBridge();

    expect(bridge.pendingCount).toBe(0);

    void bridge.waitForUserResponse('req-1', createMockParams());
    expect(bridge.pendingCount).toBe(1);

    void bridge.waitForUserResponse('req-2', createMockParams());
    expect(bridge.pendingCount).toBe(2);

    bridge.resolvePermission('req-1', 'allow_once');
    expect(bridge.pendingCount).toBe(1);

    bridge.resolvePermission('req-2', 'reject_once');
    expect(bridge.pendingCount).toBe(0);
  });

  it('getPendingParams returns params for pending request', () => {
    const bridge = new AcpPermissionBridge();
    const params = createMockParams();

    void bridge.waitForUserResponse('req-1', params);

    expect(bridge.getPendingParams('req-1')).toBe(params);
  });

  it('getPendingParams returns undefined for unknown requestId', () => {
    const bridge = new AcpPermissionBridge();

    expect(bridge.getPendingParams('nonexistent')).toBeUndefined();
  });

  it('auto-cancels pending requests after timeout', async () => {
    vi.useFakeTimers();
    const bridge = new AcpPermissionBridge(1000);

    const promise = bridge.waitForUserResponse('req-timeout', createMockParams());
    expect(bridge.pendingCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1001);
    await expect(promise).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(bridge.pendingCount).toBe(0);
  });

  it('cancels previous pending request when requestId is reused', async () => {
    const bridge = new AcpPermissionBridge(10_000);

    const first = bridge.waitForUserResponse('req-1', createMockParams({ sessionId: 's-1' }));
    const second = bridge.waitForUserResponse('req-1', createMockParams({ sessionId: 's-2' }));
    bridge.resolvePermission('req-1', 'allow_once');

    await expect(first).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    await expect(second).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
  });
});
