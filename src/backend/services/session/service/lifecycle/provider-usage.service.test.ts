import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderUsageService } from './provider-usage.service';

const available = {
  status: 'available' as const,
  windows: [{ id: 'five_hour', label: '5-hour window', usedPercent: 12, resetsAt: null }],
};

afterEach(() => vi.useRealTimers());

describe('ProviderUsageService', () => {
  it('coalesces concurrent reads and caches successful snapshots for 30 seconds', async () => {
    vi.useFakeTimers();
    const fetchUsage = vi.fn(async () => available);
    const service = new ProviderUsageService({ fetchUsage });
    const [first, second] = await Promise.all([
      service.getUsage('CLAUDE'),
      service.getUsage('CLAUDE'),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ provider: 'CLAUDE', status: 'available' });
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    first.windows[0]!.usedPercent = 90;
    expect((await service.getUsage('CLAUDE')).windows[0]?.usedPercent).toBe(12);
    await vi.advanceTimersByTimeAsync(30_001);
    await service.getUsage('CLAUDE');
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it('isolates provider caches and retries failed reads without leaking errors', async () => {
    const fetchUsage = vi
      .fn()
      .mockRejectedValueOnce(new Error('sensitive provider diagnostic'))
      .mockResolvedValue(available);
    const service = new ProviderUsageService({ fetchUsage });
    expect(await service.getUsage('CODEX')).toMatchObject({
      provider: 'CODEX',
      status: 'error',
      windows: [],
      message: 'Could not refresh plan limits.',
    });
    await service.getUsage('CODEX');
    await service.getUsage('CLAUDE');
    expect(fetchUsage).toHaveBeenCalledTimes(3);
  });
});
