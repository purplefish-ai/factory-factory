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
    const signal = vi.fn();
    const pending = stopOwnedRuntimeGroup(handle, {
      signal,
      platform: 'darwin',
      timeoutMs: 100,
    });
    await vi.runAllTimersAsync();
    expect(await pending).toBe('UNKNOWN');
    expect(signal).toHaveBeenCalledWith(-12_345, 'SIGKILL');
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
it('attempts KILL even when the event loop resumes beyond the deadline', async () => {
  vi.useFakeTimers();
  try {
    const handle = createTestProcessHandle();
    handle.ownedProcessGroup = handle.child.pid;
    const signal = vi.fn();
    const stopping = stopOwnedRuntimeGroup(handle, { signal, platform: 'darwin', timeoutMs: 100 });
    vi.setSystemTime(Date.now() + 200);
    await vi.runAllTimersAsync();
    expect(await stopping).toBe('UNKNOWN');
    expect(signal).toHaveBeenCalledWith(-handle.child.pid!, 'SIGKILL');
  } finally {
    vi.useRealTimers();
  }
});
