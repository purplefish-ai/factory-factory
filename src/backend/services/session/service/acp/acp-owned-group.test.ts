import { expect, it, vi } from 'vitest';
import { stopOwnedRuntimeGroup } from './acp-owned-group';
import { createTestProcessHandle } from './acp-runtime-manager.test-helpers';
function missing(): never {
  throw Object.assign(new Error('gone'), { code: 'ESRCH' });
}
it('confirms only group disappearance, not adapter exit or signal acknowledgment', async () => {
  const handle = createTestProcessHandle();
  handle.ownedProcessGroup = 12_345;
  const signals: Array<number | string> = [];
  let probes = 0;
  const signal = (_pid: number, value: NodeJS.Signals | 0) => {
    signals.push(value);
    if (value === 0 && ++probes > 2) {
      missing();
    }
  };
  const result = await stopOwnedRuntimeGroup(handle, {
    signal,
    platform: 'darwin',
    timeoutMs: 100,
  });
  expect(result).toBe('LOCAL_RUNTIME_GROUP_STOPPED');
  expect(signals).toContain('SIGTERM');
});
it('returns UNKNOWN when SIGKILL never yields confirmed disappearance', async () => {
  const handle = createTestProcessHandle();
  handle.ownedProcessGroup = 12_345;
  vi.useFakeTimers();
  try {
    const pending = stopOwnedRuntimeGroup(handle, {
      signal: () => undefined,
      platform: 'darwin',
      timeoutMs: 100,
    });
    await vi.runAllTimersAsync();
    expect(await pending).toBe('UNKNOWN');
  } finally {
    vi.useRealTimers();
  }
});
it.each(['win32', 'darwin'] as const)(
  'does not signal without live owned group proof on %s',
  async (platform) => {
    const handle = createTestProcessHandle();
    const signal = vi.fn();
    expect(await stopOwnedRuntimeGroup(handle, { signal, platform })).toBe('UNKNOWN');
    expect(signal).not.toHaveBeenCalled();
  }
);
it('does not interpret EPERM or other probing errors as disappearance', async () => {
  const handle = createTestProcessHandle();
  handle.ownedProcessGroup = 12_345;
  expect(
    await stopOwnedRuntimeGroup(handle, {
      signal: () => {
        throw Object.assign(new Error('permission'), { code: 'EPERM' });
      },
      platform: 'darwin',
      timeoutMs: 1,
    })
  ).toBe('UNKNOWN');
});
