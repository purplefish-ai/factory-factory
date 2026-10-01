import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindSessionsByWorkspaceId = vi.hoisted(() => vi.fn());
const mockEnqueue = vi.hoisted(() => vi.fn());
const mockTryDispatchNextMessage = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock('@/backend/services/session', () => ({
  chatMessageHandlerService: {
    tryDispatchNextMessage: (...args: unknown[]) => mockTryDispatchNextMessage(...args),
  },
  sessionDataService: {
    findAgentSessionsByWorkspaceId: (...args: unknown[]) => mockFindSessionsByWorkspaceId(...args),
  },
  sessionDomainService: {
    enqueue: (...args: unknown[]) => mockEnqueue(...args),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ warn: (...args: unknown[]) => mockWarn(...args) }),
}));

import { deliverWorkspaceWake } from './workspace-wake-delivery.orchestrator';

function session(id: string, updatedAt: string, status: 'RUNNING' | 'IDLE' | 'COMPLETED') {
  return { id, status, updatedAt: new Date(updatedAt) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnqueue.mockReturnValue({ position: 1 });
  mockTryDispatchNextMessage.mockResolvedValue(undefined);
});

describe('deliverWorkspaceWake', () => {
  it('returns not-delivered when the workspace has never had a session', async () => {
    mockFindSessionsByWorkspaceId.mockResolvedValue([]);

    const result = await deliverWorkspaceWake('ws-1', 'check the logs');

    expect(result).toEqual({ delivered: false });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('resumes a dormant session, unlike notification delivery which only targets RUNNING/IDLE', async () => {
    mockFindSessionsByWorkspaceId.mockResolvedValue([
      session('session-old', '2026-01-01T00:00:00.000Z', 'RUNNING'),
      session('session-new', '2026-01-02T00:00:00.000Z', 'COMPLETED'),
    ]);

    const result = await deliverWorkspaceWake('ws-1', 'check the logs');

    expect(result).toEqual({ delivered: true });
    expect(mockEnqueue).toHaveBeenCalledWith(
      'session-new',
      expect.objectContaining({ text: 'check the logs' })
    );
    expect(mockTryDispatchNextMessage).toHaveBeenCalledWith('session-new');
  });

  it('returns not-delivered when enqueue fails', async () => {
    mockFindSessionsByWorkspaceId.mockResolvedValue([
      session('session-1', '2026-01-01T00:00:00.000Z', 'IDLE'),
    ]);
    mockEnqueue.mockReturnValue({ error: 'queue full' });

    const result = await deliverWorkspaceWake('ws-1', 'check the logs');

    expect(result).toEqual({ delivered: false });
    expect(mockWarn).toHaveBeenCalledWith(
      'deliverWorkspaceWake: enqueue failed',
      expect.objectContaining({ error: 'queue full' })
    );
    expect(mockTryDispatchNextMessage).not.toHaveBeenCalled();
  });
});
