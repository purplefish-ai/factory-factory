import { afterEach, expect, it, vi } from 'vitest';
import { AcpObservedStop } from './acp-observed-stop';
import { createDeferred, createTestProcessHandle } from './acp-runtime-manager.test-helpers';
import { AcpRuntimeQuiescence } from './acp-runtime-quiescence';
const source = {
  version: 1 as const,
  provider: 'CLAUDE' as const,
  providerSessionId: 'provider-session-1',
  runtimeIncarnationId: 'runtime',
  lifecycleGeneration: 1,
};
function setup(owned = true) {
  const handle = createTestProcessHandle();
  handle.eventLifecycleGeneration = 1;
  let current = handle;
  const quiescence = new AcpRuntimeQuiescence({ stopClient: async () => undefined });
  const stop = new AcpObservedStop(quiescence, {
    getHandle: () => current,
    getMetadata: () => ({ incarnationId: 'runtime', purpose: 'active', installed: true }),
    beginStop: vi.fn(),
    endStop: vi.fn(),
    markManaged: vi.fn(),
    removeStopped: vi.fn(),
  });
  stop.register('s', handle, owned);
  return {
    handle,
    stop,
    quiescence,
    replace: () => {
      current = createTestProcessHandle();
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
  await h.stop.cleanupUnexpectedExit('s', 'runtime');
  expect(h.handle.child.kill).toHaveBeenCalledWith('SIGTERM');
});
