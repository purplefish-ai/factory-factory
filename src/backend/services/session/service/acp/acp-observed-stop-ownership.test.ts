import { afterEach, expect, it, vi } from 'vitest';
import { AcpObservedStop } from './acp-observed-stop';
import * as groups from './acp-owned-group';
import { createDeferred, createTestProcessHandle } from './acp-runtime-manager.test-helpers';
import { AcpRuntimeQuiescence } from './acp-runtime-quiescence';
const source = {
  version: 1 as const,
  provider: 'CLAUDE' as const,
  providerSessionId: 'provider-session-1',
  runtimeIncarnationId: 'runtime',
  lifecycleGeneration: 1,
};
function setup(owned = true, removed?: () => void) {
  const handle = createTestProcessHandle({ provider: 'CLAUDE' });
  handle.eventLifecycleGeneration = 1;
  let current: typeof handle | undefined = handle;
  const quiescence = new AcpRuntimeQuiescence({ stopClient: async () => undefined });
  const beginStop = vi.fn();
  const endStop = vi.fn();
  const stop = new AcpObservedStop(quiescence, {
    getHandle: () => current,
    getMetadata: () => ({ incarnationId: 'runtime', purpose: 'active', installed: true }),
    beginStop,
    endStop,
    markManaged: vi.fn(),
    removeStopped: () => {
      current = undefined;
      removed?.();
    },
  });
  stop.register('s', handle, owned);
  return {
    handle,
    stop,
    quiescence,
    beginStop,
    endStop,
    replace: () => {
      current = createTestProcessHandle();
    },
    registerOrdinary: () => {
      current = createTestProcessHandle();
      stop.register('s', current, false);
    },
    removeCurrent: () => {
      current = undefined;
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it.each(['ordinary', 'replaced', 'stale-source'] as const)(
  'does not signal %s runtime',
  async (kind) => {
    const h = setup(kind !== 'ordinary');
    if (kind === 'replaced') {
      h.replace();
    }
    const evidence = await h.stop.stopAndQuiesceObserved(
      's',
      'USER_STOP',
      kind === 'stale-source' ? { ...source, providerSessionId: 'old' } : undefined
    );
    expect(evidence.status).toBe('UNKNOWN');
    expect(h.handle.child.kill).not.toHaveBeenCalled();
  }
);
it('preserves unconfirmed stop for ordinary callers joining observed quiescence', async () => {
  const h = setup();
  const creation = createDeferred<void>();
  const creating = h.quiescence.runClientCreationOperation('s', 'active', () => creation.promise);
  const observed = h.stop.stopAndQuiesceObserved('s', 'USER_STOP');
  const joined = h.quiescence.stopAndQuiesce('s');
  const rejected = expect(joined).rejects.toThrow('unconfirmed');
  creation.resolve();
  await creating;
  expect((await observed).status).toBe('UNKNOWN');
  await rejected;
});

it('forgets a definitively failed spawn but retains a generic no-PID ownership record', () => {
  const h = setup(false);
  Object.defineProperty(h.handle.child, 'pid', { value: undefined });
  h.stop.registerSpawn('failed', h.handle.child, undefined, false);
  expect(h.stop.has('failed')).toBe(true);
  h.handle.child.emit('error', new Error('spawn failed'));
  expect(h.stop.has('failed')).toBe(false);
});
it('cleans only the current event incarnation on unexpected adapter exit', async () => {
  const h = setup();
  await h.stop.cleanupUnexpectedExit('s', 'stale');
  expect(h.handle.child.kill).not.toHaveBeenCalled();
  await expect(h.stop.cleanupUnexpectedExit('s', 'runtime')).rejects.toThrow('unconfirmed');
  expect(h.handle.child.kill).toHaveBeenCalledWith('SIGTERM');
});

it.skipIf(process.platform === 'win32')(
  'shares physical startup cleanup with observed stop and preserves caller causes',
  async () => {
    vi.useFakeTimers();
    const h = setup();
    h.handle.ownedProcessGroup = h.handle.child.pid;
    let live = true;
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => {
      if (!live) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      return true;
    });
    const startup = h.quiescence.runClientCreationOperation('s', 'active', () =>
      h.stop.stopCurrentRuntime('s')
    );
    const repeated = h.stop.stopCurrentRuntime('s');
    const observed = h.stop.stopAndQuiesceObserved('s', 'USER_STOP', source);
    const shutdown = h.stop.stopAndQuiesceObserved('s', 'SHUTDOWN', source);
    const stale = await h.stop.stopAndQuiesceObserved('s', 'TIMEOUT', {
      ...source,
      providerSessionId: 'stale',
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(stale.status).toBe('UNKNOWN');
    expect(h.beginStop).toHaveBeenCalledOnce();
    expect(h.endStop).not.toHaveBeenCalled();
    expect(signal.mock.calls.filter(([, value]) => value === 'SIGTERM')).toHaveLength(1);
    live = false;
    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([startup, repeated]);
    expect(await observed).toMatchObject({
      status: 'LOCAL_RUNTIME_GROUP_STOPPED',
      cause: 'USER_STOP',
      source,
    });
    expect(await shutdown).toMatchObject({
      status: 'LOCAL_RUNTIME_GROUP_STOPPED',
      cause: 'SHUTDOWN',
      source,
    });
    expect(h.endStop).toHaveBeenCalledTimes(h.beginStop.mock.calls.length);
    expect(h.quiescence.getTrackedSessionIds()).toEqual([]);
  }
);
it('a stale exit with a replacement runtime is a cleanup no-op', async () => {
  const h = setup();
  h.replace();
  await expect(h.stop.cleanupUnexpectedExit('s', 'runtime')).resolves.toBeUndefined();
  expect(h.handle.child.kill).not.toHaveBeenCalled();
  expect(h.beginStop).not.toHaveBeenCalled();
});
it.skipIf(process.platform === 'win32')(
  'a timed-out caller cannot release an ongoing physical stop',
  async () => {
    vi.useFakeTimers();
    const h = setup();
    h.handle.ownedProcessGroup = h.handle.child.pid;
    let live = true;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (!live) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      return true;
    });
    const timedOut = expect(
      h.stop.stopWithDeadline('s', 1, () => h.stop.stopCurrentRuntime('s'))
    ).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(2);
    await timedOut;
    expect(h.endStop).not.toHaveBeenCalled();
    const joined = h.stop.stopCurrentRuntime('s');
    expect(h.beginStop).toHaveBeenCalledOnce();
    live = false;
    await vi.advanceTimersByTimeAsync(20);
    await joined;
    expect(h.endStop).toHaveBeenCalledOnce();
  }
);

it.skipIf(process.platform === 'win32')(
  'a compatible caller during confirmed removal shares the completed physical proof',
  async () => {
    let late: Promise<void> | undefined;
    const h = setup(true, () =>
      queueMicrotask(() => {
        late = h.stop.stopCurrentRuntime('s');
      })
    );
    h.handle.ownedProcessGroup = h.handle.child.pid;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    await h.stop.stopCurrentRuntime('s');
    expect(late).toBeDefined();
    await expect(late).resolves.toBeUndefined();
    expect(h.beginStop).toHaveBeenCalledOnce();
    expect(h.endStop).toHaveBeenCalledOnce();
  }
);

it('never reuses retained event stop after an ordinary runtime is registered and removed', async () => {
  const h = setup();
  const physical = vi
    .spyOn(groups, 'stopOwnedRuntimeGroup')
    .mockResolvedValue('LOCAL_RUNTIME_GROUP_STOPPED');
  expect((await h.stop.stopAndQuiesceObserved('s', 'USER_STOP', source)).status).toBe(
    'LOCAL_RUNTIME_GROUP_STOPPED'
  );
  expect(h.stop.getSource('s')).toEqual(source);
  h.registerOrdinary();
  expect(h.stop.getSource('s')).toBeNull();
  h.removeCurrent();
  expect(h.stop.getSource('s')).toBeNull();
  expect((await h.stop.stopAndQuiesceObserved('s', 'TIMEOUT', source)).status).toBe('UNKNOWN');
  expect(physical).toHaveBeenCalledOnce();
});

it('does not republish an old stop after ordinary replacement during physical cleanup', async () => {
  const h = setup();
  const physical = createDeferred<'LOCAL_RUNTIME_GROUP_STOPPED'>();
  const called = vi.spyOn(groups, 'stopOwnedRuntimeGroup').mockReturnValue(physical.promise);
  const pending = h.stop.stopAndQuiesceObserved('s', 'USER_STOP', source);
  await vi.waitFor(() => expect(called).toHaveBeenCalledOnce());
  h.registerOrdinary();
  h.removeCurrent();
  physical.resolve('LOCAL_RUNTIME_GROUP_STOPPED');
  expect((await pending).status).toBe('UNKNOWN');
  expect(h.stop.getSource('s')).toBeNull();
});
