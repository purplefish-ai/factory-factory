import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindByAgentId = vi.hoisted(() => vi.fn());
const mockFindRecent = vi.hoisted(() => vi.fn());
const mockFindById = vi.hoisted(() => vi.fn());

vi.mock('@/backend/orchestration/decision-log-query.service', () => ({
  decisionLogQueryService: {
    findByAgentId: (...args: unknown[]) => mockFindByAgentId(...args),
    findRecent: (...args: unknown[]) => mockFindRecent(...args),
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}));

import { decisionLogRouter } from './decision-log.trpc';

function createCaller() {
  return decisionLogRouter.createCaller({ appContext: {} } as never);
}

describe('decisionLogRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists logs by agent and recent logs with defaults', async () => {
    mockFindByAgentId.mockResolvedValue([{ id: 'd1' }]);
    mockFindRecent.mockResolvedValue([{ id: 'd2' }]);

    const caller = createCaller();
    await expect(caller.listByAgent({ agentId: 'a1' })).resolves.toEqual([{ id: 'd1' }]);
    await expect(caller.listRecent()).resolves.toEqual([{ id: 'd2' }]);

    expect(mockFindByAgentId).toHaveBeenCalledWith('a1', 50);
    expect(mockFindRecent).toHaveBeenCalledWith(100);
  });

  it('gets decision log by id and throws when missing', async () => {
    mockFindById.mockResolvedValueOnce({ id: 'd1', decision: 'ok' });
    mockFindById.mockResolvedValueOnce(null);

    const caller = createCaller();
    await expect(caller.getById({ id: 'd1' })).resolves.toEqual({ id: 'd1', decision: 'ok' });
    await expect(caller.getById({ id: 'missing' })).rejects.toThrow(
      'Decision log not found: missing'
    );
  });
});
