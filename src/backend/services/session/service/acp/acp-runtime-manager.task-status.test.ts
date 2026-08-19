import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn, mockInitialize, mockLoadSession, mockNewSession, mockAcpClients } = vi.hoisted(
  () => ({
    mockSpawn: vi.fn(),
    mockInitialize: vi.fn(),
    mockLoadSession: vi.fn(),
    mockNewSession: vi.fn(),
    mockAcpClients: [] as unknown[],
  })
);

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('@agentclientprotocol/sdk', () => {
  class MockClientSideConnection {
    initialize = mockInitialize;
    loadSession = mockLoadSession;
    newSession = mockNewSession;
    cancel = vi.fn();

    constructor(toClient: (agent: unknown) => unknown, _stream: unknown) {
      mockAcpClients.push(toClient({}));
    }
  }

  return {
    ClientSideConnection: MockClientSideConnection,
    ndJsonStream: () => ({ writable: {}, readable: { pipeThrough: () => ({}) } }),
    PROTOCOL_VERSION: 1,
  };
});

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getCurrentProcessEnv: () => ({ ...process.env }),
}));

import type { AcpClientHandler } from './acp-client-handler';
import type { AcpRuntimeEventHandlers } from './acp-runtime-events';
import { AcpRuntimeManager } from './acp-runtime-manager';
import {
  codexOptions,
  createDeferred,
  createMockChildProcess,
  defaultConfigOptions,
  defaultContext,
  exitChildAfterSigterm,
} from './acp-runtime-manager.test-helpers';

function defaultHandlers(): AcpRuntimeEventHandlers {
  return {
    onSessionId: vi.fn().mockResolvedValue(undefined),
    onExit: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
    onAcpEvent: vi.fn(),
  };
}

function setupSuccessfulSpawn() {
  const child = createMockChildProcess();
  mockSpawn.mockReturnValue(child);
  mockInitialize.mockResolvedValue({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
    agentInfo: { name: 'codex-app-server-acp' },
  });
  mockLoadSession.mockResolvedValue({ configOptions: defaultConfigOptions() });
  mockNewSession.mockResolvedValue({
    sessionId: 'provider-session-new',
    configOptions: defaultConfigOptions(),
  });
  return child;
}

describe('AcpRuntimeManager startup task status', () => {
  let manager: AcpRuntimeManager;

  beforeEach(() => {
    mockSpawn.mockReset();
    mockInitialize.mockReset();
    mockLoadSession.mockReset();
    mockNewSession.mockReset();
    mockAcpClients.length = 0;
    manager = new AcpRuntimeManager();
  });

  it('ignores task status events from a superseded startup runtime', async () => {
    const staleLoad = createDeferred<{
      configOptions: ReturnType<typeof defaultConfigOptions>;
    }>();
    const firstChild = setupSuccessfulSpawn();
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
    await vi.waitFor(() => expect(mockLoadSession).toHaveBeenCalledOnce());

    await manager.stopClient('session-1');
    await expect(firstCreation).resolves.toMatchObject({
      message: expect.stringContaining('ACP session stop requested'),
    });

    const replacementChild = setupSuccessfulSpawn();
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
    const child = setupSuccessfulSpawn();
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
