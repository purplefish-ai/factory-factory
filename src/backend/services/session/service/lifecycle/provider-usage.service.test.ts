import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderUsageService } from './provider-usage.service';

const available = {
  status: 'available' as const,
  windows: [{ id: 'five_hour', label: '5-hour window', usedPercent: 12, resetsAt: null }],
};

afterEach(() => vi.useRealTimers());

describe('ProviderUsageService', () => {
  it('delegates account-scoped Codex usage without wrapping it in a provider cache', async () => {
    const first = { ...available, provider: 'CODEX' as const, updatedAt: new Date().toISOString() };
    const second = { ...first, windows: [] };
    const accounts = {
      getUsage: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
    };
    const fetchUsage = vi.fn();
    const service = new ProviderUsageService({ fetchUsage, accounts });
    expect(await service.getUsage('CODEX', 'saved')).toEqual(first);
    expect(await service.getUsage('CODEX', 'other')).toEqual(second);
    expect(accounts.getUsage.mock.calls).toEqual([['saved'], ['other']]);
    expect(fetchUsage).not.toHaveBeenCalled();
  });
  it('isolates delegated account snapshots from consumer mutation', async () => {
    const snapshot = {
      ...available,
      provider: 'CODEX' as const,
      updatedAt: new Date().toISOString(),
    };
    const service = new ProviderUsageService({
      fetchUsage: vi.fn(),
      accounts: { getUsage: vi.fn().mockResolvedValue(snapshot) },
    });
    const first = await service.getUsage('CODEX', 'saved');
    first.windows[0]!.usedPercent = 99;
    first.windows.push({ ...first.windows[0]! });
    expect((await service.getUsage('CODEX', 'saved')).windows).toEqual(available.windows);
  });
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
    expect(await service.getUsage('CODEX')).toMatchObject({
      provider: 'CODEX',
      status: 'available',
      windows: available.windows,
    });
    expect(await service.getUsage('CLAUDE')).toMatchObject({
      provider: 'CLAUDE',
      status: 'available',
      windows: available.windows,
    });
    expect(fetchUsage).toHaveBeenCalledTimes(3);
    expect(fetchUsage.mock.calls).toEqual([['CODEX'], ['CODEX'], ['CLAUDE']]);
  });
});
