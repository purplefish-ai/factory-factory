import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindByAgentId = vi.hoisted(() => vi.fn());
const mockFindRecent = vi.hoisted(() => vi.fn());
const mockFindById = vi.hoisted(() => vi.fn());
const mockList = vi.hoisted(() => vi.fn());
const mockCreateAutomatic = vi.hoisted(() => vi.fn());
const mockCreateManual = vi.hoisted(() => vi.fn());

vi.mock('@/backend/resource_accessors/decision-log.accessor', () => ({
  decisionLogAccessor: {
    findByAgentId: (...args: unknown[]) => mockFindByAgentId(...args),
    findRecent: (...args: unknown[]) => mockFindRecent(...args),
    findById: (...args: unknown[]) => mockFindById(...args),
    list: (...args: unknown[]) => mockList(...args),
    createAutomatic: (...args: unknown[]) => mockCreateAutomatic(...args),
    createManual: (...args: unknown[]) => mockCreateManual(...args),
  },
}));

import { decisionLogQueryService } from './decision-log-query.service';

describe('decisionLogQueryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards read operations to the accessor', async () => {
    mockFindByAgentId.mockResolvedValue([{ id: '1' }]);
    mockFindRecent.mockResolvedValue([{ id: '2' }]);
    mockFindById.mockResolvedValue({ id: '3' });
    mockList.mockResolvedValue([{ id: '4' }]);

    await expect(decisionLogQueryService.findByAgentId('a1', 10)).resolves.toEqual([{ id: '1' }]);
    await expect(decisionLogQueryService.findRecent(25)).resolves.toEqual([{ id: '2' }]);
    await expect(decisionLogQueryService.findById('3')).resolves.toEqual({ id: '3' });
    await expect(decisionLogQueryService.list({ agentId: 'a1', limit: 5 })).resolves.toEqual([
      { id: '4' },
    ]);
  });

  it('forwards write operations to the accessor', async () => {
    mockCreateAutomatic.mockResolvedValue({ id: 'auto' });
    mockCreateManual.mockResolvedValue({ id: 'manual' });

    await expect(
      decisionLogQueryService.createAutomatic('a1', 'Bash', 'result', { ok: true })
    ).resolves.toEqual({ id: 'auto' });

    await expect(
      decisionLogQueryService.createManual('a1', 'Title', 'Body', 'ctx')
    ).resolves.toEqual({ id: 'manual' });

    expect(mockCreateAutomatic).toHaveBeenCalledWith('a1', 'Bash', 'result', { ok: true });
    expect(mockCreateManual).toHaveBeenCalledWith('a1', 'Title', 'Body', 'ctx');
  });
});
