import { afterEach, expect, it, vi } from 'vitest';
import { AcpClientFactory } from './acp-client-factory';
import { AcpRuntimeManager } from './acp-runtime-manager';
import {
  createTestProcessHandle,
  defaultContext,
  defaultHandlers,
  defaultOptions,
} from './acp-runtime-manager.test-helpers';
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('keeps missing runtime uncertain rather than accepting a local idle state', async () => {
  const manager = new AcpRuntimeManager();
  expect(await manager.stopAndQuiesceObserved('missing', 'USER_STOP')).toMatchObject({
    status: 'UNKNOWN',
    source: null,
    cause: 'USER_STOP',
  });
});
it.skipIf(process.platform === 'win32')(
  'reports local group proof with incarnation separately from user outcome',
  async () => {
    const manager = new AcpRuntimeManager();
    const handle = createTestProcessHandle();
    handle.ownedProcessGroup = handle.child.pid;
    handle.eventLifecycleGeneration = 8;
    vi.spyOn(AcpClientFactory.prototype, 'createClient').mockResolvedValue(handle);
    let live = true;
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (!live) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      if (signal === 'SIGTERM') {
        live = false;
      }
      return true;
    });
    await manager.getOrCreateClient(
      'session',
      { ...defaultOptions(), ownedProcessGroup: true },
      defaultHandlers(),
      defaultContext()
    );
    const stopped = await manager.stopAndQuiesceObserved('session', 'SHUTDOWN');
    expect(stopped).toMatchObject({
      status: 'LOCAL_RUNTIME_GROUP_STOPPED',
      cause: 'SHUTDOWN',
      source: {
        providerSessionId: 'provider-session-1',
        runtimeIncarnationId: expect.any(String),
        lifecycleGeneration: 8,
      },
    });
    expect(manager.getClient('session')).toBeUndefined();
  }
);
it('retains uncertainty when a signaled process group still exists', async () => {
  vi.useFakeTimers();
  const manager = new AcpRuntimeManager();
  const handle = createTestProcessHandle();
  handle.ownedProcessGroup = handle.child.pid;
  handle.eventLifecycleGeneration = 8;
  vi.spyOn(AcpClientFactory.prototype, 'createClient').mockResolvedValue(handle);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  await manager.getOrCreateClient(
    'session',
    { ...defaultOptions(), ownedProcessGroup: true },
    defaultHandlers(),
    defaultContext()
  );
  const stopped = manager.stopAndQuiesceObserved('session', 'TIMEOUT');
  await vi.runAllTimersAsync();
  expect(await stopped).toMatchObject({ status: 'UNKNOWN', cause: 'TIMEOUT' });
  expect(manager.getClient('session')).toBe(handle);
});

it.skipIf(process.platform === 'win32')(
  'cleans an event candidate group when installation fails instead of stopping only the adapter',
  async () => {
    const manager = new AcpRuntimeManager();
    const handle = createTestProcessHandle();
    handle.ownedProcessGroup = handle.child.pid;
    handle.eventLifecycleGeneration = 8;
    vi.spyOn(handle.child, 'kill').mockImplementation(() => {
      handle.child.emit('exit', 0);
      return true;
    });
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
    await expect(
      manager.getOrCreateClient(
        'candidate',
        { ...defaultOptions(), ownedProcessGroup: true },
        {
          ...defaultHandlers(),
          onRuntimeCreated: () => {
            throw new Error('install failed');
          },
        },
        defaultContext()
      )
    ).rejects.toThrow('install failed');
    expect(signal).toHaveBeenCalledWith(-handle.child.pid!, 'SIGTERM');
    expect(handle.child.kill).not.toHaveBeenCalled();
    expect(await manager.stopAndQuiesceObserved('candidate', 'USER_STOP')).toMatchObject({
      status: 'LOCAL_RUNTIME_GROUP_STOPPED',
    });
  }
);

it.skipIf(process.platform === 'win32')(
  'retains an event spawn for strict cleanup when startup fails before returning a handle',
  async () => {
    const manager = new AcpRuntimeManager();
    const handle = createTestProcessHandle();
    vi.spyOn(AcpClientFactory.prototype, 'createClient').mockImplementation((params) => {
      params.onOwnedProcessSpawned?.(handle.child, handle.child.pid, false);
      return Promise.reject(new Error('initialize failed'));
    });
    await expect(
      manager.getOrCreateClient(
        'spawn',
        { ...defaultOptions(), ownedProcessGroup: true },
        defaultHandlers(),
        defaultContext()
      )
    ).rejects.toThrow('initialize failed');
    let live = true;
    vi.spyOn(process, 'kill').mockImplementation((_pid, value) => {
      if (!live) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      if (value === 'SIGTERM') {
        live = false;
      }
      return true;
    });
    expect(manager.beginShutdown()).toContain('spawn');
    expect(await manager.stopAndQuiesceObserved('spawn', 'SHUTDOWN')).toMatchObject({
      status: 'LOCAL_RUNTIME_GROUP_STOPPED',
      source: null,
    });
  }
);

it('attempts cleanup without claiming proof when live event runtime has no owned group', async () => {
  const manager = new AcpRuntimeManager();
  const handle = createTestProcessHandle();
  vi.spyOn(AcpClientFactory.prototype, 'createClient').mockResolvedValue(handle);
  await manager.getOrCreateClient(
    'uncontained',
    { ...defaultOptions(), ownedProcessGroup: true },
    defaultHandlers(),
    defaultContext()
  );
  expect(await manager.stopAndQuiesceObserved('uncontained', 'USER_STOP')).toMatchObject({
    status: 'UNKNOWN',
    source: null,
  });
  expect(handle.child.kill).toHaveBeenCalledWith('SIGTERM');
});

it.skipIf(process.platform === 'win32')(
  'cleans the inherited group after adapter exit before failing durable exit observation',
  async () => {
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
    let cleanupCompletedAtObservation = false;
    const onRuntimeExit = vi.fn(() => {
      cleanupCompletedAtObservation =
        !live && signal.mock.calls.some(([pid, value]) => pid === -12_345 && value === 'SIGTERM');
      return Promise.reject(new Error('durable observation unavailable'));
    });
    await manager.getOrCreateClient(
      'exit',
      { ...defaultOptions(), ownedProcessGroup: true },
      { ...defaultHandlers(), onRuntimeExit },
      defaultContext()
    );
    handle.child.emit('exit', 1);
    await vi.waitFor(() => expect(onRuntimeExit).toHaveBeenCalledOnce());
    expect(cleanupCompletedAtObservation).toBe(true);
    expect(await manager.stopAndQuiesceObserved('exit', 'USER_STOP')).toMatchObject({
      status: 'LOCAL_RUNTIME_GROUP_STOPPED',
    });
  }
);
