import { afterEach, expect, it, vi } from 'vitest';
import { timeLaunchDiscovery } from './launch-discovery-timing';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('@/backend/services/logger.service', () => ({ createLogger: () => logs }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it('records successful stage latency without changing its result', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const result = { confirmed: true };
  expect(
    await timeLaunchDiscovery('account resolution', { provider: 'CODEX' }, () => {
      vi.setSystemTime(1234);
      return Promise.resolve(result);
    })
  ).toBe(result);
  expect(logs.info).toHaveBeenCalledWith('Launch discovery stage completed', {
    provider: 'CODEX',
    stage: 'account resolution',
    durationMs: 1234,
  });
});
it('records failed stage latency and preserves the original failure', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const error = new Error('provider diagnostic containing a secret', {
    cause: { credential: 'secret' },
  });
  await expect(
    timeLaunchDiscovery('session creation', { provider: 'CLAUDE' }, () => {
      vi.setSystemTime(30_000);
      return Promise.reject(error);
    })
  ).rejects.toBe(error);
  expect(logs.warn).toHaveBeenCalledWith('Launch discovery stage failed', {
    provider: 'CLAUDE',
    stage: 'session creation',
    durationMs: 30_000,
  });
});
