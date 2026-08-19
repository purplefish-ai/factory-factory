import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateAcpClientParams } from './acp-client-factory';
import type { AcpProcessHandle } from './acp-process-handle';
import type { AcpRuntimeEventHandlers } from './acp-runtime-events';
import {
  createDeferred,
  createTestProcessHandle,
  defaultContext,
  defaultHandlers,
  defaultOptions,
  type MockChildProcess,
} from './acp-runtime-manager.test-helpers';
import { AcpRuntimeSupervisor } from './acp-runtime-supervisor';

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

  it('reports installed runtime identity, liveness, work, and process snapshots', async () => {
    // Catches status queries filtering browse handles or deriving work from public visibility.
    const active = createTestProcessHandle({ provider: 'CLAUDE' });
    const browse = createTestProcessHandle({ provider: 'CODEX' });
    mockChildOf(browse).pid = 54_321;
    const { supervisor, createClient } = createHarness();
    createClient.mockResolvedValueOnce(active).mockResolvedValueOnce(browse);
    await supervisor.getOrCreateClient(
      'active-session',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );
    await supervisor.getOrCreateClient(
      'browse-session',
      { ...defaultOptions(), purpose: 'browse' },
      defaultHandlers(),
      defaultContext()
    );
    active.isPromptInFlight = true;
    browse.isPromptInFlight = true;

    expect(supervisor.isCurrentHandle('active-session', active)).toBe(true);
    expect(supervisor.isCurrentHandle('active-session', browse)).toBe(false);
    expect(supervisor.isSessionRunning('active-session')).toBe(true);
    expect(supervisor.isSessionRunning('browse-session')).toBe(false);
    expect(supervisor.isSessionWorking('browse-session')).toBe(true);
    expect(supervisor.isAnySessionWorking(['missing', 'browse-session'])).toBe(true);
    expect([...supervisor.getAllClients()]).toEqual([
      ['active-session', active],
      ['browse-session', browse],
    ]);
    expect(supervisor.getAllActiveProcesses()).toEqual([
      {
        sessionId: 'active-session',
        pid: 12_345,
        status: 'running',
        isRunning: true,
        isPromptInFlight: true,
        provider: 'CLAUDE',
      },
      {
        sessionId: 'browse-session',
        pid: 54_321,
        status: 'running',
        isRunning: true,
        isPromptInFlight: true,
        provider: 'CODEX',
      },
    ]);

    mockChildOf(browse).killed = true;
    expect(supervisor.getBrowseClient('browse-session')).toBeUndefined();
    expect(supervisor.getInstalledHandle('browse-session')).toBe(browse);
    expect(supervisor.getAllActiveProcesses()[1]).toMatchObject({
      status: 'stopped',
      isRunning: false,
    });
  });
});
