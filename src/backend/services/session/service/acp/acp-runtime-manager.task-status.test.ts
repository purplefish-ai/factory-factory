import { beforeEach, describe, expect, it } from 'vitest';
import type { AcpClientHandler } from './acp-client-handler';
import type { AcpRuntimeManager } from './acp-runtime-manager';
import {
  createManagerTestHarness,
  mockAcpClients,
  mockInitialize,
  mockLoadSession,
  mockNewSession,
  mockSpawn,
} from './acp-runtime-manager.test-harness';
import {
  codexOptions,
  createDeferred,
  defaultConfigOptions,
  defaultContext,
  defaultHandlers,
  exitChildAfterSigterm,
} from './acp-runtime-manager.test-helpers';

describe('AcpRuntimeManager task status', () => {
  let manager: AcpRuntimeManager;

  beforeEach(() => {
    mockSpawn.mockReset();
    mockInitialize.mockReset();
    mockLoadSession.mockReset();
    mockNewSession.mockReset();
    mockAcpClients.length = 0;
    manager = createManagerTestHarness().manager;
  });

  it('ignores task status events from a superseded startup runtime', async () => {
    // Catches stale startup handlers mutating or forwarding status after replacement.
    const staleLoad = createDeferred<{
      configOptions: ReturnType<typeof defaultConfigOptions>;
    }>();
    const firstChild = createManagerTestHarness().setupSuccessfulSpawn({ loadSession: true });
    exitChildAfterSigterm(firstChild);
    mockLoadSession.mockReturnValueOnce(staleLoad.promise);
    const firstHandlers = defaultHandlers();
    const firstCreation = manager
      .getOrCreateClient(
        'session-1',
        { ...codexOptions(), resumeProviderSessionId: 'provider-session-existing' },
        firstHandlers,
        defaultContext()
      )
      .catch((error: unknown) => error);
    await expect.poll(() => mockLoadSession.mock.calls.length).toBe(1);

    await manager.stopClient('session-1');
    await expect(firstCreation).resolves.toMatchObject({
      message: expect.stringContaining('ACP session stop requested'),
    });

    const replacementChild = createManagerTestHarness().setupSuccessfulSpawn({ loadSession: true });
    exitChildAfterSigterm(replacementChild);
    await manager.getOrCreateClient(
      'session-1',
      { ...codexOptions(), resumeProviderSessionId: 'provider-session-existing' },
      defaultHandlers(),
      defaultContext()
    );

    const staleClient = mockAcpClients[0] as AcpClientHandler;
    await staleClient.extNotification('factoryfactory.ai/task/status-changed', {
      sessionId: 'provider-session-existing',
      active: true,
    });

    expect(manager.isSessionWorking('session-1')).toBe(false);
    expect(firstHandlers.onAcpEvent).not.toHaveBeenCalled();

    staleLoad.resolve({ configOptions: defaultConfigOptions() });
    await manager.stopClient('session-1');
  });

  it('accepts task status emitted while the current runtime is starting', async () => {
    // Catches incarnation gating that recognizes only installed runtimes.
    const child = createManagerTestHarness().setupSuccessfulSpawn({ loadSession: true });
    exitChildAfterSigterm(child);
    mockLoadSession.mockImplementationOnce(async () => {
      const currentClient = mockAcpClients.at(-1) as AcpClientHandler;
      await currentClient.extNotification('factoryfactory.ai/task/status-changed', {
        sessionId: 'provider-session-existing',
        active: true,
      });
      return { configOptions: defaultConfigOptions() };
    });

    await manager.getOrCreateClient(
      'session-1',
      { ...codexOptions(), resumeProviderSessionId: 'provider-session-existing' },
      defaultHandlers(),
      defaultContext()
    );

    expect(manager.isSessionWorking('session-1')).toBe(true);
    await manager.stopClient('session-1');
  });
});
