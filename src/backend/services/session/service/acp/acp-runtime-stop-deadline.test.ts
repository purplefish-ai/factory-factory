import { afterEach, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { AcpClientFactory } from './acp-client-factory';
import { AcpRuntimeManager } from './acp-runtime-manager';
import {
  createDeferred,
  createTestProcessHandle,
  defaultContext,
  defaultHandlers,
  defaultOptions,
} from './acp-runtime-manager.test-helpers';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function installed() {
  const manager = new AcpRuntimeManager();
  const handle = createTestProcessHandle();
  handle.ownedProcessGroup = handle.child.pid;
  handle.eventLifecycleGeneration = 1;
  vi.spyOn(AcpClientFactory.prototype, 'createClient').mockResolvedValue(handle);
  let live = true;
  const signal = vi.spyOn(process, 'kill').mockImplementation((_pid, value) => {
    if (!live) {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    }
    if (value === 'SIGTERM') {
      live = false;
    }
    return true;
  });
  await manager.getOrCreateClient(
    'event',
    { ...defaultOptions(), ownedProcessGroup: true },
    defaultHandlers(),
    defaultContext()
  );
  return { manager, signal };
}
it.skipIf(process.platform === 'win32')(
  'bounds strict quiescence, returns UNKNOWN and fences startup while a creation remains stalled',
  async () => {
    vi.useFakeTimers();
    const { manager, signal } = await installed();
    const read = createDeferred<void>();
    const creation = manager.runClientCreationOperation('event', 'active', () => read.promise);
    let outcome: unknown = 'pending';
    const stopped = manager.stopAndQuiesceObserved('event', 'USER_STOP').then((result) => {
      outcome = result;
    });
    try {
      await vi.advanceTimersByTimeAsync(5001);
      expect(outcome).toMatchObject({ status: 'UNKNOWN', cause: 'USER_STOP' });
      expect(signal).toHaveBeenCalledWith(-12_345, 'SIGTERM');
      await expect(
        manager.getOrCreateClient('event', defaultOptions(), defaultHandlers(), defaultContext())
      ).rejects.toThrow();
      await expect(
        manager.runClientCreationOperation('event', 'active', async () => undefined)
      ).rejects.toThrow();
    } finally {
      read.resolve();
      await creation;
      await stopped;
    }
  }
);
it.skipIf(process.platform === 'win32')(
  'bounds global creation drain and keeps late startup fenced after shutdown rejects',
  async () => {
    vi.useFakeTimers();
    const { manager, signal } = await installed();
    const read = createDeferred<void>();
    const creation = manager.runClientCreationOperation('event', 'active', () => read.promise);
    let result: unknown = 'pending';
    const shutdown = manager.stopAllClients(25).then(
      () => {
        result = 'success';
      },
      (error: unknown) => {
        result = error;
      }
    );
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(result).toBeInstanceOf(Error);
      expect(signal).toHaveBeenCalledWith(-12_345, 'SIGTERM');
      await expect(
        manager.getOrCreateClient('event', defaultOptions(), defaultHandlers(), defaultContext())
      ).rejects.toThrow('shutting down');
    } finally {
      read.resolve();
      await creation;
      await shutdown;
    }
  }
);

it.skipIf(process.platform === 'win32')(
  'retains stop generations through timed-out creation and releases them after quiescence',
  async () => {
    vi.useFakeTimers();
    const { manager } = await installed();
    const generations = unsafeCoerce<{ supervisor: { stopGenerations: Map<string, number> } }>(
      manager
    ).supervisor.stopGenerations;
    const read = createDeferred<void>();
    const creation = manager.runClientCreationOperation('event', 'active', () => read.promise);
    const stopping = manager.stopAndQuiesceObserved('event', 'USER_STOP');
    await vi.advanceTimersByTimeAsync(5001);
    expect((await stopping).status).toBe('UNKNOWN');
    expect(generations.has('event')).toBe(true);
    read.resolve();
    await creation;
    await vi.runAllTimersAsync();
    expect(generations.has('event')).toBe(false);
  }
);
