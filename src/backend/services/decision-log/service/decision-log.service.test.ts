import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findByAgentId: vi.fn(),
  findById: vi.fn(),
  findRecent: vi.fn(),
  list: vi.fn(),
}));

vi.mock('@/backend/services/decision-log/resources/decision-log.accessor', () => ({
  decisionLogAccessor: mocks,
}));

import { decisionLogService } from './decision-log.service';

describe('decisionLogService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findByAgentId.mockResolvedValue([{ id: '1' }]);
    mocks.findRecent.mockResolvedValue([{ id: '2' }]);
    mocks.findById.mockResolvedValue({ id: '3' });
    mocks.list.mockResolvedValue([{ id: '4' }]);
  });

  it('delegates decision-log queries', async () => {
    await expect(decisionLogService.findByAgentId('a1', 10)).resolves.toEqual([{ id: '1' }]);
    await expect(decisionLogService.findRecent(25)).resolves.toEqual([{ id: '2' }]);
    await expect(decisionLogService.findById('3')).resolves.toEqual({ id: '3' });
    await expect(decisionLogService.list({ agentId: 'a1', limit: 5 })).resolves.toEqual([
      { id: '4' },
    ]);

    expect(mocks.findByAgentId).toHaveBeenCalledWith('a1', 10);
    expect(mocks.findRecent).toHaveBeenCalledWith(25);
    expect(mocks.findById).toHaveBeenCalledWith('3');
    expect(mocks.list).toHaveBeenCalledWith({ agentId: 'a1', limit: 5 });
  });
});
