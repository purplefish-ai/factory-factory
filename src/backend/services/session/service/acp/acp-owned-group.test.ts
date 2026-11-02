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
it('confirms disappearance from the final probe after overdue KILL', async () => {
  vi.useFakeTimers();
  try {
    const handle = createTestProcessHandle();
    handle.ownedProcessGroup = handle.child.pid;
    let killed = false;
    const signal = vi.fn((_pid: number, value: NodeJS.Signals | 0) => {
      if (value === 'SIGKILL') {
        killed = true;
      }
      if (value === 0 && killed) {
        missing();
      }
    });
    const stopping = stopOwnedRuntimeGroup(handle, { signal, platform: 'darwin', timeoutMs: 100 });
    vi.setSystemTime(Date.now() + 200);
    await vi.runAllTimersAsync();
    expect(await stopping).toBe('LOCAL_RUNTIME_GROUP_STOPPED');
    expect(signal.mock.calls.map(([, value]) => value)).toEqual([0, 'SIGTERM', 0, 0, 'SIGKILL', 0]);
  } finally {
    vi.useRealTimers();
  }
});

it('waits for fresh absence after the captured post-TERM EPERM sequence', async () => {
  vi.useFakeTimers();
  try {
    const handle = createTestProcessHandle();
    handle.ownedProcessGroup = handle.child.pid;
    let probes = 0;
    const signal = vi.fn((_pid: number, value: NodeJS.Signals | 0) => {
      if (value === 0) {
        probes++;
        if (probes === 2) {
          throw Object.assign(new Error('permission'), { code: 'EPERM' });
        }
        if (probes > 2) {
          missing();
        }
      }
    });
    let settled = false;
    const pending = stopOwnedRuntimeGroup(handle, {
      signal,
      platform: 'darwin',
      timeoutMs: 100,
    }).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toBe('LOCAL_RUNTIME_GROUP_STOPPED');
    expect(signal.mock.calls.map(([, value]) => value)).toEqual([0, 'SIGTERM', 0, 0]);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps persistent post-TERM EPERM unresolved until the unchanged deadline without KILL', async () => {
  vi.useFakeTimers();
  try {
    const handle = createTestProcessHandle();
    handle.ownedProcessGroup = handle.child.pid;
    let terminated = false;
    const signal = vi.fn((_pid: number, value: NodeJS.Signals | 0) => {
      if (value === 'SIGTERM') {
        terminated = true;
      }
      if (value === 0 && terminated) {
        throw Object.assign(new Error('permission'), { code: 'EPERM' });
      }
    });
    let settled = false;
    const pending = stopOwnedRuntimeGroup(handle, {
      signal,
      platform: 'darwin',
      timeoutMs: 100,
    }).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe('UNKNOWN');
    expect(signal.mock.calls.filter(([, value]) => value !== 0).map(([, value]) => value)).toEqual([
      'SIGTERM',
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps initial EPERM unconfirmed without any physical signal', async () => {
  const handle = createTestProcessHandle();
  handle.ownedProcessGroup = handle.child.pid;
  const signal = vi.fn(() => {
    throw Object.assign(new Error('permission'), { code: 'EPERM' });
  });
  expect(await stopOwnedRuntimeGroup(handle, { signal, platform: 'darwin' })).toBe('UNKNOWN');
  expect(signal.mock.calls).toHaveLength(1);
  expect(signal).toHaveBeenCalledWith(-handle.child.pid!, 0);
});

it('does not mistake revoked ownership for retryable post-TERM EPERM', async () => {
  vi.useFakeTimers();
  try {
    const handle = createTestProcessHandle();
    handle.ownedProcessGroup = handle.child.pid;
    let current = true;
    let terminated = false;
    const signal = vi.fn((_pid: number, value: NodeJS.Signals | 0) => {
      if (value === 'SIGTERM') {
        terminated = true;
      }
      if (value === 0 && terminated) {
        throw Object.assign(new Error('permission'), { code: 'EPERM' });
      }
    });
    const pending = stopOwnedRuntimeGroup(handle, {
      signal,
      platform: 'darwin',
      timeoutMs: 100,
      assertOwned: () => {
        if (!current) {
          throw Object.assign(new Error('revoked'), { code: 'EPERM' });
        }
      },
    });
    await vi.advanceTimersByTimeAsync(1);
    const calls = signal.mock.calls.length;
    current = false;
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toBe('UNKNOWN');
    expect(signal).toHaveBeenCalledTimes(calls);
  } finally {
    vi.useRealTimers();
  }
});

it.each(['EPERM', 'ESRCH', 'EIO'])('does not retry a failed TERM signal (%s)', async (code) => {
  const handle = createTestProcessHandle();
  handle.ownedProcessGroup = handle.child.pid;
  const signal = vi.fn((_pid: number, value: NodeJS.Signals | 0) => {
    if (value === 'SIGTERM') {
      throw Object.assign(new Error('signal failed'), { code });
    }
  });
  expect(await stopOwnedRuntimeGroup(handle, { signal, platform: 'darwin' })).toBe('UNKNOWN');
  expect(signal.mock.calls.map(([, value]) => value)).toEqual([0, 'SIGTERM']);
});

it('does not retry unrelated post-TERM probing errors', async () => {
  const handle = createTestProcessHandle();
  handle.ownedProcessGroup = handle.child.pid;
  let terminated = false;
  const signal = vi.fn((_pid: number, value: NodeJS.Signals | 0) => {
    if (value === 'SIGTERM') {
      terminated = true;
    }
    if (value === 0 && terminated) {
      throw Object.assign(new Error('probe failed'), { code: 'EIO' });
    }
  });
  expect(await stopOwnedRuntimeGroup(handle, { signal, platform: 'darwin' })).toBe('UNKNOWN');
  expect(signal.mock.calls.map(([, value]) => value)).toEqual([0, 'SIGTERM', 0]);
});

it('keeps a failed escalation signal unconfirmed without retrying the signal error', async () => {
  vi.useFakeTimers();
  try {
    const handle = createTestProcessHandle();
    handle.ownedProcessGroup = handle.child.pid;
    const signal = vi.fn((_pid: number, value: NodeJS.Signals | 0) => {
      if (value === 'SIGKILL') {
        throw Object.assign(new Error('signal failed'), { code: 'EPERM' });
      }
    });
    const pending = stopOwnedRuntimeGroup(handle, { signal, platform: 'darwin', timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(60);
    expect(await pending).toBe('UNKNOWN');
    expect(signal.mock.calls.at(-1)?.[1]).toBe('SIGKILL');
  } finally {
    vi.useRealTimers();
  }
});
