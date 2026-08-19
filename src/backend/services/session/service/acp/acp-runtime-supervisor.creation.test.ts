import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateAcpClientParams } from './acp-client-factory';
import type { AcpProcessHandle } from './acp-process-handle';
import { wireAcpRuntimeErrorHandler } from './acp-runtime-error-handler';
import type { AcpRuntimeEventHandlers } from './acp-runtime-events';
import {
  createDeferred,
  createTestProcessHandle,
  defaultContext,
  defaultHandlers,
  defaultOptions,
  exitChildAfterSigterm,
  type MockChildProcess,
} from './acp-runtime-manager.test-helpers';
import { AcpRuntimeSupervisor } from './acp-runtime-supervisor';

const loggerMocks = vi.hoisted(() => {
  const manager = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const other = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    manager,
    other,
    createLogger: vi.fn((category: string) =>
      category === 'acp-runtime-manager' ? manager : other
    ),
  };
});

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: loggerMocks.createLogger,
  getCurrentProcessEnv: () => ({}),
}));

type FactoryImplementation = (params: CreateAcpClientParams) => Promise<AcpProcessHandle>;
type CancelPrompt = (sessionId: string, handle: AcpProcessHandle) => Promise<boolean>;

function mockChildOf(handle: AcpProcessHandle): MockChildProcess {
  return handle.child as unknown as MockChildProcess;
}

function createHarness(implementation?: FactoryImplementation) {
  const createClient = vi.fn<FactoryImplementation>(
    implementation ?? (() => Promise.resolve(createTestProcessHandle()))
  );
  const cancelPrompt = vi.fn<CancelPrompt>(() => Promise.resolve(false));
  const supervisor = new AcpRuntimeSupervisor({
    clientFactory: { createClient },
    cancelPrompt,
  });
  return { supervisor, createClient, cancelPrompt };
}

describe('AcpRuntimeSupervisor creation and exit ownership', () => {
  beforeEach(() => {
    vi.useRealTimers();
    loggerMocks.manager.debug.mockClear();
    loggerMocks.manager.info.mockClear();
    loggerMocks.manager.warn.mockClear();
    loggerMocks.manager.error.mockClear();
    loggerMocks.other.debug.mockClear();
    loggerMocks.other.info.mockClear();
    loggerMocks.other.warn.mockClear();
    loggerMocks.other.error.mockClear();
  });

  it('logs new client creation under the manager category', async () => {
    const handle = createTestProcessHandle();
    const { supervisor } = createHarness(() => Promise.resolve(handle));

    await supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );

    expect(loggerMocks.manager.info).toHaveBeenCalledOnce();
    expect(loggerMocks.manager.info).toHaveBeenCalledWith('Creating new ACP client', {
      sessionId: 'session-1',
      provider: 'CLAUDE',
    });
    expect(loggerMocks.other.info).not.toHaveBeenCalledWith(
      'Creating new ACP client',
      expect.anything()
    );
  });

  it('logs reuse of an existing running client under the manager category', async () => {
    const handle = createTestProcessHandle();
    const { supervisor } = createHarness(() => Promise.resolve(handle));
    await supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );
    loggerMocks.manager.debug.mockClear();

    await supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );

    expect(loggerMocks.manager.debug).toHaveBeenCalledWith(
      'Returning existing running ACP client',
      { sessionId: 'session-1' }
    );
    expect(loggerMocks.other.debug).not.toHaveBeenCalledWith(
      'Returning existing running ACP client',
      expect.anything()
    );
  });

  it('coalesces same-session creation while allowing different sessions to start concurrently', async () => {
    // Catches a global lock or duplicate same-session factory invocation.
    const firstHandle = createTestProcessHandle({ providerSessionId: 'provider-1' });
    const secondHandle = createTestProcessHandle({ providerSessionId: 'provider-2' });
    const firstCreation = createDeferred<AcpProcessHandle>();
    const secondCreation = createDeferred<AcpProcessHandle>();
    const { supervisor, createClient } = createHarness((params) =>
      params.sessionId === 'session-1' ? firstCreation.promise : secondCreation.promise
    );

    const first = supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );
    const duplicate = supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );
    const concurrent = supervisor.getOrCreateClient(
      'session-2',
      { ...defaultOptions(), sessionId: 'session-2' },
      defaultHandlers(),
      defaultContext()
    );

    await vi.waitFor(() => expect(createClient).toHaveBeenCalledTimes(2));
    expect(supervisor.getPendingClient('session-1')).toBeDefined();
    expect(supervisor.getPendingClient('session-2')).toBeDefined();

    secondCreation.resolve(secondHandle);
    await expect(concurrent).resolves.toBe(secondHandle);
    let duplicateSettled = false;
    void duplicate.then(() => {
      duplicateSettled = true;
    });
    await Promise.resolve();
    expect(duplicateSettled).toBe(false);

    firstCreation.resolve(firstHandle);
    await expect(first).resolves.toBe(firstHandle);
    await expect(duplicate).resolves.toBe(firstHandle);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(supervisor.getPendingClient('session-1')).toBeUndefined();
  });

  it('promotes a browse runtime to active without replacing its incarnation', async () => {
    // Catches browse-only state or metadata remaining stale after active reuse.
    const handle = createTestProcessHandle();
    const onRuntimeExit = vi.fn(() => Promise.resolve());
    const { supervisor, createClient } = createHarness(() => Promise.resolve(handle));

    const browse = await supervisor.getOrCreateClient(
      'session-1',
      { ...defaultOptions(), purpose: 'browse' },
      { ...defaultHandlers(), onRuntimeExit },
      defaultContext()
    );

    expect(supervisor.getClient('session-1')).toBeUndefined();
    expect(supervisor.getBrowseClient('session-1')).toBe(browse);
    expect(supervisor.getInstalledHandle('session-1')).toBe(browse);
    expect(supervisor.isBrowseOnlySession('session-1')).toBe(true);

    const active = await supervisor.getOrCreateClient(
      'session-1',
      { ...defaultOptions(), purpose: 'active' },
      defaultHandlers(),
      defaultContext()
    );

    expect(active).toBe(browse);
    expect(createClient).toHaveBeenCalledOnce();
    expect(supervisor.getClient('session-1')).toBe(active);
    expect(supervisor.isBrowseOnlySession('session-1')).toBe(false);

    mockChildOf(handle).exitCode = 1;
    handle.child.emit('exit', 1, null);
    await vi.waitFor(() => expect(onRuntimeExit).toHaveBeenCalledOnce());
    expect(onRuntimeExit).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'active', managed: false })
    );
  });

  it('requires all installed and registered work to be browse-only', async () => {
    // Catches classifying a mixed active/browse session from only one state source.
    for (const [runtimePurpose, operationPurpose, expected] of [
      ['active', 'browse', false],
      ['browse', 'active', false],
      ['browse', 'browse', true],
    ] as const) {
      const sessionId = `${runtimePurpose}-${operationPurpose}`;
      const { supervisor } = createHarness();
      await supervisor.getOrCreateClient(
        sessionId,
        { ...defaultOptions(), purpose: runtimePurpose },
        defaultHandlers(),
        defaultContext()
      );
      const barrier = createDeferred<void>();
      const operation = supervisor.runClientCreationOperation(
        sessionId,
        operationPurpose,
        () => barrier.promise
      );

      expect(supervisor.isBrowseOnlySession(sessionId)).toBe(expected);
      expect(supervisor.hasClientCreationOperation(sessionId)).toBe(true);
      barrier.resolve(undefined);
      await operation;
      expect(supervisor.hasClientCreationOperation(sessionId)).toBe(false);
    }
  });

  it('releases failed creation locks so a later attempt can install a client', async () => {
    // Catches rejected pending work poisoning the per-session lock or purpose registry.
    const handle = createTestProcessHandle();
    const { supervisor, createClient } = createHarness();
    createClient.mockRejectedValueOnce(new Error('factory failed')).mockResolvedValueOnce(handle);

    await expect(
      supervisor.getOrCreateClient(
        'session-1',
        { ...defaultOptions(), purpose: 'browse' },
        defaultHandlers(),
        defaultContext()
      )
    ).rejects.toThrow('factory failed');

    expect(supervisor.getPendingClient('session-1')).toBeUndefined();
    expect(supervisor.isBrowseOnlySession('session-1')).toBe(false);
    await expect(
      supervisor.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      )
    ).resolves.toBe(handle);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it('lets a same-tick direct stop cancel creation admitted only to the session lock', async () => {
    // Catches stop returning before a p-limit-queued creation becomes pending.
    const handle = createTestProcessHandle();
    const { supervisor, createClient } = createHarness(() => Promise.resolve(handle));

    const creation = supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );
    const stopping = supervisor.stopClient('session-1');

    await expect(stopping).resolves.toBeUndefined();
    await expect(creation).rejects.toThrow('ACP session stop requested');
    expect(createClient).not.toHaveBeenCalled();
    expect(supervisor.getInstalledHandle('session-1')).toBeUndefined();
  });

  it('fences replacement creation until the current exit callback settles', async () => {
    // Catches a replacement overtaking lifecycle reconciliation for the prior incarnation.
    const firstHandle = createTestProcessHandle({ providerSessionId: 'provider-old' });
    const replacementHandle = createTestProcessHandle({ providerSessionId: 'provider-new' });
    const exitCallback = createDeferred<void>();
    const onRuntimeExit = vi.fn(() => exitCallback.promise);
    const { supervisor, createClient } = createHarness();
    createClient.mockResolvedValueOnce(firstHandle).mockResolvedValueOnce(replacementHandle);
    await supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      { ...defaultHandlers(), onRuntimeExit },
      defaultContext()
    );

    mockChildOf(firstHandle).exitCode = 7;
    firstHandle.child.emit('exit', 7, null);
    await vi.waitFor(() => expect(onRuntimeExit).toHaveBeenCalledOnce());
    const replacement = supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );
    await Promise.resolve();
    expect(createClient).toHaveBeenCalledOnce();
    expect(supervisor.getInstalledHandle('session-1')).toBeUndefined();

    exitCallback.resolve(undefined);
    await expect(replacement).resolves.toBe(replacementHandle);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it('lets stop cancel a creation queued behind an exit fence', async () => {
    // Catches an exit-fenced creation forgetting a stop that completed before the fence opened.
    const firstHandle = createTestProcessHandle();
    const replacementHandle = createTestProcessHandle();
    const exitCallback = createDeferred<void>();
    const { supervisor, createClient } = createHarness();
    createClient.mockResolvedValueOnce(firstHandle).mockResolvedValueOnce(replacementHandle);
    await supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      {
        ...defaultHandlers(),
        onRuntimeExit: vi.fn(() => exitCallback.promise),
      },
      defaultContext()
    );
    mockChildOf(firstHandle).exitCode = 1;
    firstHandle.child.emit('exit', 1, null);
    await vi.waitFor(() => expect(supervisor.getInstalledHandle('session-1')).toBeUndefined());

    const replacement = supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );
    const stopping = supervisor.stopClient('session-1');
    await stopping;
    exitCallback.resolve(undefined);

    await expect(replacement).rejects.toThrow('ACP session stop requested');
    expect(createClient).toHaveBeenCalledOnce();
    expect(supervisor.getInstalledHandle('session-1')).toBeUndefined();
  });

  it('rejects same-session reentrant creation from an exit callback without retaining its fence', async () => {
    // Catches a deadlock when an exit callback recursively waits on its own exit fence.
    const firstHandle = createTestProcessHandle();
    const replacementHandle = createTestProcessHandle();
    let reentrantError: unknown;
    const { supervisor, createClient } = createHarness();
    createClient.mockResolvedValueOnce(firstHandle).mockResolvedValueOnce(replacementHandle);
    const onRuntimeExit = vi.fn(async () => {
      try {
        await supervisor.getOrCreateClient(
          'session-1',
          defaultOptions(),
          defaultHandlers(),
          defaultContext()
        );
      } catch (error) {
        reentrantError = error;
      }
    });
    await supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      { ...defaultHandlers(), onRuntimeExit },
      defaultContext()
    );

    mockChildOf(firstHandle).exitCode = 1;
    firstHandle.child.emit('exit', 1, null);
    await vi.waitFor(() => expect(onRuntimeExit).toHaveBeenCalledOnce());
    expect(reentrantError).toMatchObject({
      message: 'Cannot create ACP client for session session-1 from its runtime exit handler',
    });

    await expect(
      supervisor.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      )
    ).resolves.toBe(replacementHandle);
  });

  it('allows an exit callback to create a different session concurrently', async () => {
    // Catches over-broad exit fencing across independent session IDs.
    const firstHandle = createTestProcessHandle();
    const secondHandle = createTestProcessHandle();
    const { supervisor, createClient } = createHarness();
    createClient.mockResolvedValueOnce(firstHandle).mockResolvedValueOnce(secondHandle);
    const onRuntimeExit = vi.fn(() =>
      supervisor
        .getOrCreateClient(
          'session-2',
          { ...defaultOptions(), sessionId: 'session-2' },
          defaultHandlers(),
          defaultContext()
        )
        .then(() => undefined)
    );
    await supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      { ...defaultHandlers(), onRuntimeExit },
      defaultContext()
    );

    mockChildOf(firstHandle).exitCode = 1;
    firstHandle.child.emit('exit', 1, null);
    await vi.waitFor(() => expect(supervisor.getClient('session-2')).toBe(secondHandle));
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it('exposes an incarnation-aware runtime-error predicate to the factory', async () => {
    // Catches stale child errors being attributed to a removed or replacement runtime.
    const handle = createTestProcessHandle();
    let params: CreateAcpClientParams | undefined;
    const { supervisor } = createHarness((factoryParams) => {
      params = factoryParams;
      expect(factoryParams.metadata.installed).toBe(false);
      expect(factoryParams.shouldDispatchRuntimeError(handle.child)).toBe(true);
      return Promise.resolve(handle);
    });

    await supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );
    expect(params?.metadata.incarnationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(params?.metadata.installed).toBe(true);
    expect(params?.shouldDispatchRuntimeError(handle.child)).toBe(true);

    mockChildOf(handle).exitCode = 1;
    handle.child.emit('exit', 1, null);
    await vi.waitFor(() => expect(supervisor.getInstalledHandle('session-1')).toBeUndefined());
    expect(params?.shouldDispatchRuntimeError(handle.child)).toBe(false);
  });

  it.each([
    'stop',
    'shutdown',
  ] as const)('disables startup error dispatch before %s cleans a cancelled candidate', async (termination) => {
    // Catches late child errors dispatching forever because a cancelled candidate was never installed.
    const handle = createTestProcessHandle();
    exitChildAfterSigterm(mockChildOf(handle));
    const factoryResult = createDeferred<AcpProcessHandle>();
    let factoryParams: CreateAcpClientParams | undefined;
    const onRuntimeError = vi.fn();
    const handlers = { ...defaultHandlers(), onRuntimeError };
    const { supervisor } = createHarness((params) => {
      factoryParams = params;
      wireAcpRuntimeErrorHandler(
        handle.child,
        params.sessionId,
        params.handlers,
        params.metadata,
        () => params.shouldDispatchRuntimeError(handle.child)
      );
      return factoryResult.promise;
    });
    const creation = supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      handlers,
      defaultContext()
    );
    await vi.waitFor(() => expect(factoryParams).toBeDefined());

    const terminating =
      termination === 'stop' ? supervisor.stopClient('session-1') : supervisor.stopAllClients(50);
    factoryResult.resolve(handle);
    await expect(creation).rejects.toThrow(
      termination === 'stop' ? 'ACP session stop requested' : 'ACP runtime manager is shutting down'
    );
    await terminating;

    if (!factoryParams) {
      throw new Error('Factory parameters were not captured');
    }
    expect(factoryParams.shouldDispatchRuntimeError(handle.child)).toBe(false);
    handle.child.emit('error', new Error(`late ${termination} cleanup error`));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onRuntimeError).not.toHaveBeenCalled();
  });

  it.each([
    'stop',
    'shutdown',
  ] as const)('rejects an installed candidate when %s begins during provider ID notification', async (termination) => {
    // Catches creation fulfilling with a handle killed while its final callback was pending.
    const handle = createTestProcessHandle();
    exitChildAfterSigterm(mockChildOf(handle));
    const notification = createDeferred<void>();
    const onSessionId = vi.fn(() => notification.promise);
    const { supervisor } = createHarness(() => Promise.resolve(handle));
    const creation = supervisor.getOrCreateClient(
      'session-1',
      defaultOptions(),
      { ...defaultHandlers(), onSessionId },
      defaultContext()
    );
    await vi.waitFor(() => expect(onSessionId).toHaveBeenCalledOnce());
    expect(supervisor.getInstalledHandle('session-1')).toBe(handle);

    const terminating =
      termination === 'stop' ? supervisor.stopClient('session-1') : supervisor.stopAllClients(50);
    notification.resolve(undefined);

    await expect(creation).rejects.toThrow(
      termination === 'stop' ? 'ACP session stop requested' : 'ACP runtime manager is shutting down'
    );
    await terminating;
    expect(supervisor.getInstalledHandle('session-1')).toBeUndefined();
    expect(handle.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('installs the handle before invoking creation callbacks in callback order', async () => {
    // Catches callbacks observing a half-installed runtime or provider ID racing the local callback.
    const handle = createTestProcessHandle({ providerSessionId: 'provider-ordered' });
    const order: string[] = [];
    const { supervisor } = createHarness(() => Promise.resolve(handle));
    supervisor.setOnClientCreated((sessionId, created, context) => {
      expect(sessionId).toBe('session-1');
      expect(created).toBe(handle);
      expect(context).toEqual(defaultContext());
      expect(supervisor.getInstalledHandle(sessionId)).toBe(handle);
      order.push('created');
    });
    const handlers: AcpRuntimeEventHandlers = {
      onSessionId: vi.fn((sessionId, providerSessionId) => {
        expect(supervisor.getInstalledHandle(sessionId)).toBe(handle);
        expect(providerSessionId).toBe('provider-ordered');
        order.push('provider-id');
        return Promise.resolve();
      }),
    };

    await supervisor.getOrCreateClient('session-1', defaultOptions(), handlers, defaultContext());

    expect(order).toEqual(['created', 'provider-id']);
  });
});
