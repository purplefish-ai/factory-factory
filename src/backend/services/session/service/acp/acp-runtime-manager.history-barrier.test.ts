import { beforeEach, expect, it, vi } from 'vitest';
import {
  createManagerTestHarness,
  mockInitialize,
  mockLoadSession,
  mockNewSession,
  setupSuccessfulSpawn,
} from './acp-runtime-manager.test-harness';
import {
  createDeferred,
  defaultContext,
  defaultHandlers,
  defaultOptions,
  exitChildAfterSigterm,
} from './acp-runtime-manager.test-helpers';

beforeEach(() => vi.clearAllMocks());

it.each([false, true])(
  'initializes concurrently but waits for hydration before provider session creation (resume=%s)',
  async (resume) => {
    const { manager } = createManagerTestHarness();
    const child = setupSuccessfulSpawn({ loadSession: true });
    exitChildAfterSigterm(child);
    const history = createDeferred<void>();
    const hydrationStarted = vi.fn();
    const hydrationFinished = vi.fn();
    const hydration = (async () => {
      hydrationStarted();
      await history.promise;
      hydrationFinished();
    })();
    expect(hydrationStarted).toHaveBeenCalledOnce();
    expect(hydrationFinished).not.toHaveBeenCalled();
    mockInitialize.mockImplementation(() => {
      expect(hydrationStarted).toHaveBeenCalledOnce();
      expect(hydrationFinished).not.toHaveBeenCalled();
      return Promise.resolve({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    });
    const barrierEntered = createDeferred<void>();
    const creation = manager.getOrCreateClient(
      'session-1',
      {
        ...defaultOptions(),
        ...(resume ? { resumeProviderSessionId: 'existing' } : {}),
        beforeSessionCreation: () => {
          barrierEntered.resolve();
          return hydration;
        },
      },
      defaultHandlers(),
      defaultContext()
    );
    try {
      expect(
        await Promise.race([
          barrierEntered.promise.then(() => 'hydration barrier'),
          creation.then(() => 'provider session created'),
        ])
      ).toBe('hydration barrier');
      expect(mockInitialize).toHaveBeenCalledOnce();
      expect(hydrationFinished).not.toHaveBeenCalled();
      expect(mockLoadSession).not.toHaveBeenCalled();
      expect(mockNewSession).not.toHaveBeenCalled();
    } finally {
      history.resolve();
      await creation;
      expect(hydrationFinished).toHaveBeenCalledOnce();
      expect(resume ? mockLoadSession : mockNewSession).toHaveBeenCalledOnce();
      await manager.stopClient('session-1');
    }
  }
);

it('stops a child awaiting hydration without loading a provider session after hydration finishes', async () => {
  const { manager } = createManagerTestHarness();
  const child = setupSuccessfulSpawn({ loadSession: true });
  exitChildAfterSigterm(child);
  const history = createDeferred<void>();
  const entered = createDeferred<void>();
  const creation = manager
    .getOrCreateClient(
      'session-1',
      {
        ...defaultOptions(),
        resumeProviderSessionId: 'existing',
        beforeSessionCreation: () => {
          entered.resolve();
          return history.promise;
        },
      },
      defaultHandlers(),
      defaultContext()
    )
    .catch((error: unknown) => error);
  await Promise.race([entered.promise, creation]);
  await manager.stopClient('session-1');
  history.resolve();
  expect(await creation).toBeInstanceOf(Error);
  await Promise.resolve();
  expect(mockLoadSession).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalled();
});

it('cancels initialization before the history barrier without resuming after initialize resolves', async () => {
  const { manager } = createManagerTestHarness();
  const child = setupSuccessfulSpawn({ loadSession: true });
  exitChildAfterSigterm(child);
  const initialized = createDeferred<unknown>();
  const entered = createDeferred<void>();
  mockInitialize.mockImplementation(() => {
    entered.resolve();
    return initialized.promise;
  });
  const barrier = vi.fn(async () => undefined);
  const creation = manager
    .getOrCreateClient(
      'session-1',
      {
        ...defaultOptions(),
        resumeProviderSessionId: 'existing',
        beforeSessionCreation: barrier,
      },
      defaultHandlers(),
      defaultContext()
    )
    .catch((error: unknown) => error);
  await entered.promise;
  await manager.stopClient('session-1');
  initialized.resolve({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  expect(await creation).toBeInstanceOf(Error);
  expect(barrier).not.toHaveBeenCalled();
  expect(mockLoadSession).not.toHaveBeenCalled();
});

it('cleans up a child when hydration fails and never invokes the provider session RPC', async () => {
  const { manager } = createManagerTestHarness();
  const child = setupSuccessfulSpawn({ loadSession: true });
  exitChildAfterSigterm(child);
  const failure = new Error('history failed');
  await expect(
    manager.getOrCreateClient(
      'session-1',
      {
        ...defaultOptions(),
        resumeProviderSessionId: 'existing',
        beforeSessionCreation: () => Promise.reject(failure),
      },
      defaultHandlers(),
      defaultContext()
    )
  ).rejects.toThrow('history failed');
  expect(mockLoadSession).not.toHaveBeenCalled();
  expect(mockNewSession).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalled();
});

it('keeps healthy local hydration outside the provider RPC deadline', async () => {
  vi.useFakeTimers();
  const { manager } = createManagerTestHarness();
  manager.setAcpStartupTimeoutMs(10);
  const child = setupSuccessfulSpawn({ loadSession: true });
  exitChildAfterSigterm(child);
  const history = createDeferred<void>();
  const entered = createDeferred<void>();
  const creation = manager
    .getOrCreateClient(
      'session-1',
      {
        ...defaultOptions(),
        resumeProviderSessionId: 'existing',
        beforeSessionCreation: () => {
          entered.resolve();
          return history.promise;
        },
      },
      defaultHandlers(),
      defaultContext()
    )
    .catch((error: unknown) => error);
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).not.toHaveBeenCalled();
    expect(mockLoadSession).not.toHaveBeenCalled();
    history.resolve();
    expect(await creation).toMatchObject({ providerSessionId: 'existing' });
    expect(mockLoadSession).toHaveBeenCalledOnce();
  } finally {
    history.resolve();
    await creation;
    await manager.stopClient('session-1');
    vi.useRealTimers();
  }
});
