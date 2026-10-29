import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sessionDomainService,
  sessionLifecycleService as publicSessionLifecycleService,
  sessionDispatchService as publicSessionDispatchService,
} from '@/backend/services/session';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { sessionLifecycleService as coreSessionLifecycleService } from './session-core-services';
import {
  createLifecycleHarness,
  createLifecycleTestSession,
} from './session-lifecycle.test-helpers';
import { sessionLifecycleService, sessionDispatchService } from './session-services';

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: { findById: vi.fn() },
  workspaceNotificationService: {
    listPendingForDelivery: vi.fn(() => Promise.resolve([])),
    findForDelivery: vi.fn(() => Promise.resolve(null)),
    markDelivered: vi.fn(() => Promise.resolve()),
  },
}));

describe('session services composition', () => {
  afterEach(() => {
    sessionDomainService.clearAllSessions();
    vi.restoreAllMocks();
  });

  it('composes browse startup through the real startup coordinator', async () => {
    expect(publicSessionLifecycleService).toBe(sessionLifecycleService);
    expect(coreSessionLifecycleService).toBe(sessionLifecycleService);
    expect(publicSessionDispatchService).toBe(sessionDispatchService);
    const { service, runtimeManager } = createLifecycleHarness({
      provider: 'CODEX',
      providerSessionId: 'provider-session-1',
    });
    runtimeManager.getSubagentBrowseCapability.mockImplementation(() =>
      runtimeManager.getOrCreateClient.mock.calls.length > 0
        ? { version: 1, list: true, read: true, notifications: true }
        : null
    );

    await expect(service.ensureSubagentBrowseSession('session-1')).resolves.toBe(true);

    expect(runtimeManager.getOrCreateClient).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        provider: 'CODEX',
        purpose: 'browse',
        resumeProviderSessionId: 'provider-session-1',
      }),
      expect.objectContaining({
        onRuntimeError: expect.any(Function),
        onRuntimeExit: expect.any(Function),
      }),
      {
        workspaceId: 'workspace-1',
        workingDir: '/tmp/workspace',
      }
    );
  });

  it('builds runtime handlers backed by complete lifecycle harness ports', async () => {
    const { service, runtimeManager, sessionDomainService, acpEventProcessor } =
      createLifecycleHarness();
    await service.getOrCreateSessionClient('session-1');
    const handlers = runtimeManager.getOrCreateClient.mock.calls[0]?.[2];
    expect(handlers?.onRuntimeError).toEqual(expect.any(Function));
    expect(handlers?.onAcpLog).toEqual(expect.any(Function));

    await handlers?.onRuntimeError?.({
      sessionId: 'session-1',
      error: new Error('runtime failed'),
      incarnationId: 'incarnation-1',
      purpose: 'active',
    });
    handlers?.onAcpLog?.('session-1', { message: 'provider log' });

    expect(sessionDomainService.markError).toHaveBeenCalledWith('session-1', 'runtime failed');
    expect(acpEventProcessor.handleAcpLog).toHaveBeenCalledWith('session-1', {
      message: 'provider log',
    });
  });

  it('builds workflow finalization with recovery and transient deletion ports', async () => {
    const { service, sessionDomainService } = createLifecycleHarness({
      session: { workflow: 'ratchet' },
    });

    await expect(service.recoverStaleRunningSessions()).resolves.toBe(0);
    await service.stopSession('session-1', {
      cleanupTransientRatchetSession: true,
      recordLifecycleEvent: false,
    });

    expect(sessionDomainService.clearSession).toHaveBeenCalledWith('session-1', {
      permanentlyDeleted: true,
    });
  });

  it('wires a lifecycle coordinator to a later workspace bridge without mutating the singleton', async () => {
    const { service, repository, runtimeManager } = createLifecycleHarness();
    const workspaceBridge = {
      markSessionIdle: vi.fn(),
    };
    service.configure({ workspace: unsafeCoerce(workspaceBridge) });
    repository.getSessionById.mockResolvedValue(
      createLifecycleTestSession({ id: 'session-composed', workspaceId: 'workspace-composed' })
    );
    repository.updateSessionIfStatus.mockResolvedValue(1);

    await service.stopSession('session-composed', {
      recordLifecycleEvent: false,
    });

    expect(runtimeManager.stopAndQuiesce).toHaveBeenCalledWith('session-composed');
    expect(workspaceBridge.markSessionIdle).toHaveBeenCalledWith(
      'workspace-composed',
      'session-composed'
    );
  });
});

vi.mock('@/backend/services/codex-accounts', () => ({
  NATIVE_DEFAULT_CODEX_ACCOUNT_ID: 'codex-native-default',
  codexAccountService: {
    getRuntimeContext: vi.fn(async (accountId = 'codex-native-default') => ({
      accountId,
      homeDir: '/test/codex',
      sessionsDir: '/test/codex/sessions',
      env: { CODEX_HOME: '/test/codex' },
    })),
    getPreviewRuntimeContext: vi.fn(async ({ accountId = 'codex-native-default' } = {}) => ({
      accountId,
      homeDir: '/test/codex',
      sessionsDir: '/test/codex/sessions',
      env: { CODEX_HOME: '/test/codex' },
    })),
    withAccountReservation: vi.fn(async (input, create) =>
      create(input.accountId ?? 'codex-native-default')
    ),
    getUsage: vi.fn(),
  },
}));
