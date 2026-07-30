import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AutoIterationSessionBridge,
  autoIterationService,
  logbookService,
} from '@/backend/services/auto-iteration';
import { AutoIterationStatus, SessionStatus } from '@/shared/core';

// --- Module mocks (inline vi.fn() - no top-level variable references) ---

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockWorkspaceCreationService = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => mockLogger,
}));

vi.mock('@/backend/services/ratchet', () => ({
  ratchetService: { configure: vi.fn(), recordSessionEnd: vi.fn() },
  fixerSessionService: {
    configure: vi.fn(),
    acquireAndDispatch: vi.fn(),
    getActiveSession: vi.fn(),
  },
}));

vi.mock('./reconciliation.service', () => ({
  reconciliationService: { configure: vi.fn() },
}));

vi.mock('@/backend/services/workspace', () => ({
  WorkspaceCreationService: class {
    create = mockWorkspaceCreationService.create;
  },
  workspaceAutoIterationService: {
    getExecutionContext: vi.fn(),
    setStatus: vi.fn(),
    setProgress: vi.fn(),
    setSession: vi.fn(),
    finishSessionIfMatching: vi.fn(),
    clearSessionIfMatching: vi.fn(),
  },
  workspaceDataService: {
    findById: vi.fn(),
    findFixerContext: vi.fn(),
    findPRContext: vi.fn(),
    findStatusSnapshot: vi.fn(),
    resetPRDiscoveryBackoff: vi.fn(),
  },
  workspaceMaintenanceService: { findNeedingWorktree: vi.fn() },
  workspacePrSnapshotService: {
    record: vi.fn(),
    attachDiscoveredPRIfClaimMatches: vi.fn(),
    updatePRSnapshotIfUrlMatches: vi.fn(),
  },
  workspaceRatchetService: { recordSessionEnd: vi.fn() },
  workspaceRunScriptService: {
    clearInitOutput: vi.fn(),
    appendInitOutput: vi.fn(),
    setInitScriptPid: vi.fn(),
    clearInitScriptPid: vi.fn(),
  },
  workspaceQueryService: { configure: vi.fn() },
  workspaceSnapshotStore: { configure: vi.fn() },
  workspaceActivityService: {
    markSessionRunning: vi.fn(),
    markSessionIdle: vi.fn(),
    on: vi.fn(),
  },
  workspaceStateMachine: { markFailed: vi.fn(), markReady: vi.fn() },
  worktreeLifecycleService: {
    cleanupUnregisteredProvisioningWorktree: vi.fn(),
  },
  getWorkspaceInitPolicy: vi.fn(),
}));

vi.mock('@/backend/services/session', () => ({
  acpRuntimeManager: {
    isSessionRunning: vi.fn(),
    isSessionWorking: vi.fn(),
    isAnySessionWorking: vi.fn(),
  },
  sessionDataService: {
    findAgentSessionById: vi.fn(),
    createAgentSession: vi.fn(),
    deleteAgentSession: vi.fn(),
    updateAgentSession: vi.fn(),
    findAgentSessionsByWorkspaceId: vi.fn(),
    acquireFixerSession: vi.fn(),
  },
  sessionService: {
    configure: vi.fn(),
    sendSessionMessage: vi.fn(),
    sendAcpMessage: vi.fn(),
  },
  sessionLifecycleService: {
    configure: vi.fn(),
    getRuntimeSnapshot: vi.fn(),
    stopSession: vi.fn(),
    startSession: vi.fn(),
  },
  sessionPromptTurnCompletionService: {
    setHandler: vi.fn(),
  },
  sessionDomainService: {
    clearSession: vi.fn(),
    injectCommittedUserMessage: vi.fn(),
    getTranscriptSnapshot: vi.fn(),
    getQueueLength: vi.fn(),
  },
  chatEventForwarderService: { configure: vi.fn(), getAllPendingRequests: vi.fn() },
  chatMessageHandlerService: { configure: vi.fn(), tryDispatchNextMessage: vi.fn() },
}));

vi.mock('@/backend/services/github', () => ({
  githubCLIService: {
    extractPRInfo: vi.fn(),
    getPRFullDetails: vi.fn(),
    getReviewComments: vi.fn(),
    getResolvedReviewCommentIds: vi.fn(),
    computeCIStatus: vi.fn(),
    getAuthenticatedUsername: vi.fn(),
    fetchAndComputePRState: vi.fn(),
    checkHealth: vi.fn(),
    listReviewRequests: vi.fn(),
  },
  prFetchCoordinator: {
    coordinate: vi.fn(),
  },
  prSnapshotService: { configure: vi.fn(), refreshWorkspace: vi.fn() },
}));

vi.mock('@/backend/services/periodic-task', () => ({
  periodicTaskService: { configure: vi.fn() },
}));

vi.mock('@/backend/services/run-script', () => ({
  startupScriptService: { configure: vi.fn() },
}));

vi.mock('@/backend/services/terminal', () => ({
  terminalSessionService: { recoverOrphanedSessions: vi.fn() },
}));

vi.mock('./workspace-init.orchestrator', () => ({
  initializeWorkspaceWorktree: vi.fn(),
}));

// --- Import mocked modules to get references ---

import { githubCLIService, prFetchCoordinator, prSnapshotService } from '@/backend/services/github';
import { createLogger } from '@/backend/services/logger.service';
import { periodicTaskService } from '@/backend/services/periodic-task';
import { fixerSessionService, ratchetService } from '@/backend/services/ratchet';
import { startupScriptService } from '@/backend/services/run-script';
import {
  acpRuntimeManager,
  chatEventForwarderService,
  chatMessageHandlerService,
  sessionDataService,
  sessionDomainService,
  sessionLifecycleService,
  sessionPromptTurnCompletionService,
  sessionService,
} from '@/backend/services/session';
import { terminalSessionService } from '@/backend/services/terminal';
import {
  getWorkspaceInitPolicy,
  workspaceActivityService,
  workspaceAutoIterationService,
  workspaceDataService,
  workspaceMaintenanceService,
  workspacePrSnapshotService,
  workspaceQueryService,
  workspaceRatchetService,
  workspaceRunScriptService,
  workspaceSnapshotStore,
  workspaceStateMachine,
  worktreeLifecycleService,
} from '@/backend/services/workspace';
import { type BridgeServices, configureDomainBridges } from './domain-bridges.orchestrator';
import { reconciliationService } from './reconciliation.service';
import { initializeWorkspaceWorktree } from './workspace-init.orchestrator';

// Helper to extract bridge argument from a mocked configure call.
function getBridge<T>(mockFn: (arg: T) => void): T {
  return vi.mocked(mockFn).mock.calls[0]![0];
}

type ConfigureDomainBridgeServices = NonNullable<Parameters<typeof configureDomainBridges>[0]>;
type AutoIterationServiceBridge = NonNullable<
  ConfigureDomainBridgeServices['autoIterationService']
>;

function createAutoIterationServiceMock(): AutoIterationServiceBridge {
  return {
    configure: vi.fn(),
    onSessionDeath: vi.fn(),
  } as unknown as AutoIterationServiceBridge;
}

function createBridgeServices(overrides: Partial<BridgeServices> = {}): BridgeServices {
  return {
    acpRuntimeManager,
    autoIterationService,
    chatEventForwarderService,
    chatMessageHandlerService,
    createLogger,
    fixerSessionService,
    getWorkspaceInitPolicy,
    githubCLIService,
    logbookService,
    periodicTaskService,
    prFetchCoordinator,
    prSnapshotService,
    ratchetService,
    reconciliationService,
    sessionDataService,
    sessionDomainService,
    sessionLifecycleService,
    sessionPromptTurnCompletionService,
    sessionService,
    startupScriptService,
    terminalSessionService,
    workspaceActivityService,
    workspaceAutoIterationService,
    workspaceCreationService:
      mockWorkspaceCreationService as unknown as BridgeServices['workspaceCreationService'],
    workspaceDataService,
    workspaceMaintenanceService,
    workspacePrSnapshotService,
    workspaceQueryService,
    workspaceRatchetService,
    workspaceRunScriptService,
    workspaceSnapshotStore,
    workspaceStateMachine,
    worktreeLifecycleService,
    initializeWorkspaceWorktree,
    ...overrides,
  };
}

describe('configureDomainBridges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('configures all ratchet domain services', () => {
    configureDomainBridges(createBridgeServices());

    expect(ratchetService.configure).toHaveBeenCalledTimes(1);
    expect(fixerSessionService.configure).toHaveBeenCalledTimes(1);
    expect(reconciliationService.configure).toHaveBeenCalledTimes(1);
  });

  it('uses the supplied worktree initializer for reconciliation', async () => {
    const injectedInitializer = vi.fn().mockResolvedValue(undefined);
    configureDomainBridges(
      createBridgeServices({ initializeWorkspaceWorktree: injectedInitializer })
    );

    const bridge = getBridge(reconciliationService.configure);
    await bridge.workspace.initializeWorktree('ws-injected', { useExistingBranch: true });

    expect(injectedInitializer).toHaveBeenCalledWith('ws-injected', {
      useExistingBranch: true,
    });
    expect(initializeWorkspaceWorktree).not.toHaveBeenCalled();
  });

  it('configures workspace domain services', () => {
    configureDomainBridges(createBridgeServices());

    expect(workspaceQueryService.configure).toHaveBeenCalledTimes(1);
  });

  it('configures GitHub domain services', () => {
    configureDomainBridges(createBridgeServices());

    expect(prSnapshotService.configure).toHaveBeenCalledTimes(1);
  });

  it('configures session domain services', () => {
    configureDomainBridges(createBridgeServices());

    expect(chatEventForwarderService.configure).toHaveBeenCalledTimes(1);
    expect(chatMessageHandlerService.configure).toHaveBeenCalledTimes(1);
    expect(sessionService.configure).toHaveBeenCalledTimes(1);
    expect(sessionLifecycleService.configure).toHaveBeenCalledTimes(1);
    expect(sessionPromptTurnCompletionService.setHandler).toHaveBeenCalledTimes(1);
  });

  it('configures run-script domain services', () => {
    configureDomainBridges(createBridgeServices());

    expect(startupScriptService.configure).toHaveBeenCalledTimes(1);
  });

  it('configures periodic task domain services', () => {
    configureDomainBridges(createBridgeServices());

    expect(periodicTaskService.configure).toHaveBeenCalledTimes(1);
  });

  it('configures only the caller-supplied periodic task service', () => {
    const configure = vi.fn();
    const suppliedPeriodicTaskService = new Proxy(periodicTaskService, {
      get(target, property, receiver) {
        return property === 'configure' ? configure : Reflect.get(target, property, receiver);
      },
    });

    configureDomainBridges(
      createBridgeServices({ periodicTaskService: suppliedPeriodicTaskService })
    );

    expect(configure).toHaveBeenCalledTimes(1);
    expect(periodicTaskService.configure).not.toHaveBeenCalled();
  });

  describe('ratchet bridge delegation', () => {
    it('session bridge delegates isSessionRunning to acpRuntimeManager', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(ratchetService.configure);

      bridge.session.isSessionRunning('s1');
      expect(acpRuntimeManager.isSessionRunning).toHaveBeenCalledWith('s1');
    });

    it('session bridge delegates stopSession to sessionLifecycleService', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(ratchetService.configure);

      bridge.session.stopSession('s1');
      expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('s1');
    });

    it('session bridge delegates startSession to sessionLifecycleService', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(ratchetService.configure);

      bridge.session.startSession('s1', { initialPrompt: 'hello' });
      expect(sessionLifecycleService.startSession).toHaveBeenCalledWith('s1', {
        initialPrompt: 'hello',
      });
    });

    it('session bridge delegates sendSessionMessage to sessionService', async () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(ratchetService.configure);

      await bridge.session.sendSessionMessage('s1', 'hello');
      expect(sessionService.sendSessionMessage).toHaveBeenCalledWith('s1', 'hello');
    });

    it('session bridge delegates injectCommittedUserMessage to sessionDomainService', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(ratchetService.configure);

      bridge.session.injectCommittedUserMessage('s1', 'msg');
      expect(sessionDomainService.injectCommittedUserMessage).toHaveBeenCalledWith('s1', 'msg');
    });

    it('github bridge delegates extractPRInfo to githubCLIService', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(ratchetService.configure);

      bridge.github.extractPRInfo('https://github.com/owner/repo/pull/1');
      expect(githubCLIService.extractPRInfo).toHaveBeenCalledWith(
        'https://github.com/owner/repo/pull/1'
      );
    });

    it('github bridge forwards abort signals to PR reads', async () => {
      const controller = new AbortController();
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(ratchetService.configure);

      await bridge.github.getPRFullDetails('owner/repo', 42, controller.signal);
      await bridge.github.getReviewComments('owner/repo', 42, undefined, controller.signal);
      await bridge.github.getResolvedReviewCommentIds('owner/repo', 42, controller.signal);
      await bridge.github.getAuthenticatedUsername(controller.signal);

      expect(githubCLIService.getPRFullDetails).toHaveBeenCalledWith(
        'owner/repo',
        42,
        controller.signal
      );
      expect(githubCLIService.getReviewComments).toHaveBeenCalledWith(
        'owner/repo',
        42,
        undefined,
        controller.signal
      );
      expect(githubCLIService.getResolvedReviewCommentIds).toHaveBeenCalledWith(
        'owner/repo',
        42,
        controller.signal
      );
      expect(githubCLIService.getAuthenticatedUsername).toHaveBeenCalledWith(controller.signal);
    });

    it('github bridge delegates computeCIStatus with null input', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(ratchetService.configure);

      bridge.github.computeCIStatus(null);
      expect(githubCLIService.computeCIStatus).toHaveBeenCalledWith(null);
    });

    it('github bridge maps conclusion null to undefined in computeCIStatus', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(ratchetService.configure);

      const checks = [{ name: 'build', status: 'completed', conclusion: null }];
      bridge.github.computeCIStatus(checks);
      expect(githubCLIService.computeCIStatus).toHaveBeenCalledWith([
        { name: 'build', status: 'completed', conclusion: undefined },
      ]);
    });

    it('github bridge delegates coordinatePrFetch to prFetchCoordinator', async () => {
      const value = { prNumber: 1 };
      vi.mocked(prFetchCoordinator.coordinate).mockResolvedValue({ status: 'fetched', value });
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(ratchetService.configure);

      const fetch = vi.fn();
      await expect(
        bridge.github.coordinatePrFetch('ws1', fetch, { ignoreCooldown: true })
      ).resolves.toEqual({ status: 'fetched', value });
      expect(prFetchCoordinator.coordinate).toHaveBeenCalledWith('ws1', fetch, {
        ignoreCooldown: true,
      });
    });
  });

  describe('reconciliation bridge delegation', () => {
    it('workspace bridge cleanup delegates to worktreeLifecycleService', async () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(reconciliationService.configure);

      await bridge.workspace.cleanupUnregisteredProvisioningWorktree('ws1');
      expect(worktreeLifecycleService.cleanupUnregisteredProvisioningWorktree).toHaveBeenCalledWith(
        'ws1'
      );
    });

    it('workspace bridge markFailed delegates to workspaceStateMachine', async () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(reconciliationService.configure);

      await bridge.workspace.markFailed('ws1', 'broken');
      expect(workspaceStateMachine.markFailed).toHaveBeenCalledWith('ws1', 'broken');
    });

    it('workspace bridge initializeWorktree delegates to initializeWorkspaceWorktree', async () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(reconciliationService.configure);

      await bridge.workspace.initializeWorktree('ws1', { branchName: 'feature/test' });
      expect(initializeWorkspaceWorktree).toHaveBeenCalledWith('ws1', {
        branchName: 'feature/test',
      });
    });
  });

  describe('workspace bridge delegation', () => {
    it('workspaceQueryService gets github bridge with checkHealth', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(workspaceQueryService.configure);

      bridge.github.checkHealth();
      expect(githubCLIService.checkHealth).toHaveBeenCalled();
    });

    it('workspaceQueryService gets session bridge with runtime snapshots', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(workspaceQueryService.configure);

      bridge.session.getRuntimeSnapshot('s1');
      expect(sessionLifecycleService.getRuntimeSnapshot).toHaveBeenCalledWith('s1');
    });

    it('workspaceQueryService gets prSnapshot bridge with refreshWorkspace', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(workspaceQueryService.configure);

      bridge.prSnapshot.refreshWorkspace('ws1', 'https://pr.url');
      expect(prSnapshotService.refreshWorkspace).toHaveBeenCalledWith('ws1', 'https://pr.url');
    });
  });

  describe('periodic task bridge delegation', () => {
    it('creates periodic task workspaces and logs background init failures', async () => {
      const workspace = {
        id: 'ws-periodic',
      } as Awaited<ReturnType<typeof mockWorkspaceCreationService.create>>;
      mockWorkspaceCreationService.create.mockResolvedValue(workspace);
      vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
        id: 'session-1',
      } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
      vi.mocked(initializeWorkspaceWorktree).mockRejectedValue(new Error('init failed'));

      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(periodicTaskService.configure);

      await expect(
        bridge.workspace.createWorkspaceForTask({
          projectId: 'project-1',
          name: 'Periodic task run',
          prompt: 'Do the recurring work',
          periodicTaskId: 'periodic-task-1',
        })
      ).resolves.toEqual({ workspaceId: 'ws-periodic' });
      await Promise.resolve();

      expect(mockWorkspaceCreationService.create).toHaveBeenCalledWith({
        type: 'PERIODIC_TASK',
        projectId: 'project-1',
        name: 'Periodic task run',
        periodicTaskId: 'periodic-task-1',
        initialPrompt: 'Do the recurring work',
        ratchetEnabled: true,
      });
      expect(sessionDataService.createAgentSession).toHaveBeenCalledWith({
        workspaceId: 'ws-periodic',
        workflow: 'implement',
        name: 'Periodic task',
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to initialize workspace for periodic task',
        expect.any(Error),
        { workspaceId: 'ws-periodic' }
      );
    });

    it('includes agent working state in periodic task workspace status', async () => {
      vi.mocked(workspaceDataService.findStatusSnapshot).mockResolvedValue({
        status: 'READY',
        prUrl: null,
        prNumber: null,
        initCompletedAt: new Date('2026-05-20T12:00:00Z'),
      } as Awaited<ReturnType<typeof workspaceDataService.findStatusSnapshot>>);
      vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([
        { id: 'session-1' },
        { id: 'session-2' },
      ] as Awaited<ReturnType<typeof sessionDataService.findAgentSessionsByWorkspaceId>>);
      vi.mocked(acpRuntimeManager.isAnySessionWorking).mockReturnValue(true);

      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(periodicTaskService.configure);

      await expect(bridge.status.getWorkspaceStatus('ws-periodic')).resolves.toEqual({
        status: 'READY',
        prUrl: null,
        prNumber: null,
        isAgentWorking: true,
        initCompletedAt: new Date('2026-05-20T12:00:00Z'),
      });
      expect(acpRuntimeManager.isAnySessionWorking).toHaveBeenCalledWith([
        'session-1',
        'session-2',
      ]);
    });

    it('treats queued periodic task session messages as active agent work', async () => {
      vi.mocked(workspaceDataService.findStatusSnapshot).mockResolvedValue({
        status: 'READY',
        prUrl: null,
        prNumber: null,
        initCompletedAt: new Date('2026-05-20T12:00:00Z'),
      } as Awaited<ReturnType<typeof workspaceDataService.findStatusSnapshot>>);
      vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([
        { id: 'session-1' },
        { id: 'session-2' },
      ] as Awaited<ReturnType<typeof sessionDataService.findAgentSessionsByWorkspaceId>>);
      vi.mocked(acpRuntimeManager.isAnySessionWorking).mockReturnValue(false);
      vi.mocked(acpRuntimeManager.isSessionRunning).mockReturnValue(true);
      vi.mocked(sessionDomainService.getQueueLength).mockReturnValueOnce(0).mockReturnValueOnce(1);

      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(periodicTaskService.configure);

      await expect(bridge.status.getWorkspaceStatus('ws-periodic')).resolves.toEqual({
        status: 'READY',
        prUrl: null,
        prNumber: null,
        isAgentWorking: true,
        initCompletedAt: new Date('2026-05-20T12:00:00Z'),
      });
      expect(sessionDomainService.getQueueLength).toHaveBeenCalledWith('session-1');
      expect(sessionDomainService.getQueueLength).toHaveBeenCalledWith('session-2');
    });

    it('does not read queued messages for stopped periodic task sessions', async () => {
      vi.mocked(workspaceDataService.findStatusSnapshot).mockResolvedValue({
        status: 'READY',
        prUrl: null,
        prNumber: null,
        initCompletedAt: new Date('2026-05-20T12:00:00Z'),
      } as Awaited<ReturnType<typeof workspaceDataService.findStatusSnapshot>>);
      vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([
        { id: 'session-1' },
      ] as Awaited<ReturnType<typeof sessionDataService.findAgentSessionsByWorkspaceId>>);
      vi.mocked(acpRuntimeManager.isAnySessionWorking).mockReturnValue(false);
      vi.mocked(acpRuntimeManager.isSessionRunning).mockReturnValue(false);

      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(periodicTaskService.configure);

      await expect(bridge.status.getWorkspaceStatus('ws-periodic')).resolves.toMatchObject({
        isAgentWorking: false,
      });
      expect(acpRuntimeManager.isSessionRunning).toHaveBeenCalledWith('session-1');
      expect(sessionDomainService.getQueueLength).not.toHaveBeenCalled();
    });
  });

  describe('auto-iteration session bridge', () => {
    it('rolls back a created session when initial runtime startup fails', async () => {
      const autoIterationServiceMock = createAutoIterationServiceMock();
      const startupError = new Error('runtime failed to start');
      vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
        id: 'new-session',
      } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
      vi.mocked(sessionLifecycleService.startSession).mockRejectedValueOnce(startupError);

      configureDomainBridges(
        createBridgeServices({ autoIterationService: autoIterationServiceMock })
      );
      const sessionBridge = vi.mocked(autoIterationServiceMock.configure).mock
        .calls[0]![0] as AutoIterationSessionBridge;

      await expect(
        sessionBridge.startSession('ws-1', {
          initialPrompt: 'start prompt',
          startupModePreset: 'non_interactive',
        })
      ).rejects.toThrow(startupError);

      expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('new-session');
      expect(sessionDomainService.clearSession).toHaveBeenCalledWith('new-session');
      expect(sessionDataService.deleteAgentSession).toHaveBeenCalledWith('new-session');
    });

    it('retires the stopped predecessor after a successful recycle', async () => {
      const autoIterationServiceMock = createAutoIterationServiceMock();
      vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
        autoIterationSessionId: 'old-session',
      } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
      vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
        id: 'new-session',
      } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);

      configureDomainBridges(
        createBridgeServices({ autoIterationService: autoIterationServiceMock })
      );
      const sessionBridge = vi.mocked(autoIterationServiceMock.configure).mock
        .calls[0]![0] as AutoIterationSessionBridge;

      await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).resolves.toBe(
        'new-session'
      );

      expect(sessionDataService.updateAgentSession).toHaveBeenCalledWith('old-session', {
        status: SessionStatus.COMPLETED,
        providerProcessPid: null,
      });
      expect(vi.mocked(sessionService.sendAcpMessage).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(sessionDataService.updateAgentSession).mock.invocationCallOrder[0]!
      );
      expect(workspaceAutoIterationService.finishSessionIfMatching).not.toHaveBeenCalled();
    });

    it('keeps the replacement active when predecessor retirement fails after handoff', async () => {
      const autoIterationServiceMock = createAutoIterationServiceMock();
      vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
        autoIterationSessionId: 'old-session',
      } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
      vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
        id: 'new-session',
      } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
      vi.mocked(sessionDataService.updateAgentSession).mockRejectedValueOnce(
        new Error('predecessor retirement failed')
      );

      configureDomainBridges(
        createBridgeServices({ autoIterationService: autoIterationServiceMock })
      );
      const sessionBridge = vi.mocked(autoIterationServiceMock.configure).mock
        .calls[0]![0] as AutoIterationSessionBridge;

      await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).resolves.toBe(
        'new-session'
      );

      expect(sessionService.sendAcpMessage).toHaveBeenCalledWith('new-session', [
        { type: 'text', text: 'handoff prompt' },
      ]);
      expect(sessionLifecycleService.stopSession).not.toHaveBeenCalledWith('new-session');
      expect(sessionDomainService.clearSession).not.toHaveBeenCalledWith('new-session');
      expect(sessionDataService.deleteAgentSession).not.toHaveBeenCalledWith('new-session');
      expect(workspaceAutoIterationService.finishSessionIfMatching).not.toHaveBeenCalled();
    });

    it('rolls back a recycled session when replacement startup fails', async () => {
      const autoIterationServiceMock = createAutoIterationServiceMock();
      const startupError = new Error('runtime failed to start');
      vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
        autoIterationSessionId: 'old-session',
      } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
      vi.mocked(workspaceAutoIterationService.finishSessionIfMatching)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
        id: 'new-session',
      } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
      vi.mocked(sessionLifecycleService.startSession).mockRejectedValueOnce(startupError);

      configureDomainBridges(
        createBridgeServices({ autoIterationService: autoIterationServiceMock })
      );
      const sessionBridge = vi.mocked(autoIterationServiceMock.configure).mock
        .calls[0]![0] as AutoIterationSessionBridge;

      await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).rejects.toThrow(
        startupError
      );

      expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('old-session');
      expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('new-session');
      expect(sessionDomainService.clearSession).toHaveBeenCalledWith('new-session');
      expect(sessionDataService.deleteAgentSession).toHaveBeenCalledWith('new-session');
      expect(sessionDataService.updateAgentSession).toHaveBeenCalledWith('old-session', {
        status: SessionStatus.COMPLETED,
        providerProcessPid: null,
      });
      expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledWith(
        'ws-1',
        'new-session',
        AutoIterationStatus.FAILED
      );
      expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledWith(
        'ws-1',
        'old-session',
        AutoIterationStatus.FAILED
      );
      expect(workspaceAutoIterationService.setSession).not.toHaveBeenCalled();
      expect(sessionService.sendAcpMessage).not.toHaveBeenCalled();
    });

    it('retires the stopped predecessor when replacement creation fails', async () => {
      const autoIterationServiceMock = createAutoIterationServiceMock();
      const creationError = new Error('session row creation failed');
      vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
        autoIterationSessionId: 'old-session',
      } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
      vi.mocked(workspaceAutoIterationService.finishSessionIfMatching).mockResolvedValueOnce(true);
      vi.mocked(sessionDataService.createAgentSession).mockRejectedValueOnce(creationError);

      configureDomainBridges(
        createBridgeServices({ autoIterationService: autoIterationServiceMock })
      );
      const sessionBridge = vi.mocked(autoIterationServiceMock.configure).mock
        .calls[0]![0] as AutoIterationSessionBridge;

      await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).rejects.toThrow(
        creationError
      );

      expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('old-session');
      expect(sessionDataService.updateAgentSession).toHaveBeenCalledWith('old-session', {
        status: SessionStatus.COMPLETED,
        providerProcessPid: null,
      });
      expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledWith(
        'ws-1',
        'old-session',
        AutoIterationStatus.FAILED
      );
      expect(sessionLifecycleService.startSession).not.toHaveBeenCalled();
      expect(sessionDataService.deleteAgentSession).not.toHaveBeenCalled();
    });

    it('clears the stopped predecessor when replacement pointer persistence fails', async () => {
      const autoIterationServiceMock = createAutoIterationServiceMock();
      const persistenceError = new Error('pointer update failed');
      vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
        autoIterationSessionId: 'old-session',
      } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
      vi.mocked(workspaceAutoIterationService.finishSessionIfMatching)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      vi.mocked(workspaceAutoIterationService.setSession).mockRejectedValueOnce(persistenceError);
      vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
        id: 'new-session',
      } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);

      configureDomainBridges(
        createBridgeServices({ autoIterationService: autoIterationServiceMock })
      );
      const sessionBridge = vi.mocked(autoIterationServiceMock.configure).mock
        .calls[0]![0] as AutoIterationSessionBridge;

      await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).rejects.toThrow(
        persistenceError
      );

      expect(sessionDomainService.clearSession).toHaveBeenCalledWith('new-session');
      expect(sessionDataService.deleteAgentSession).toHaveBeenCalledWith('new-session');
      expect(sessionDataService.updateAgentSession).toHaveBeenCalledWith('old-session', {
        status: SessionStatus.COMPLETED,
        providerProcessPid: null,
      });
      expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledWith(
        'ws-1',
        'new-session',
        AutoIterationStatus.FAILED
      );
      expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledWith(
        'ws-1',
        'old-session',
        AutoIterationStatus.FAILED
      );
      expect(sessionService.sendAcpMessage).not.toHaveBeenCalled();
    });

    it('cleans up a recycled session when handoff send fails', async () => {
      const autoIterationServiceMock = createAutoIterationServiceMock();
      const sendError = new Error('prompt failed');
      vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
        autoIterationSessionId: 'old-session',
      } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
      vi.mocked(workspaceAutoIterationService.finishSessionIfMatching).mockResolvedValueOnce(true);
      vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
        id: 'new-session',
      } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
      vi.mocked(sessionService.sendAcpMessage).mockRejectedValue(sendError);

      configureDomainBridges(
        createBridgeServices({ autoIterationService: autoIterationServiceMock })
      );
      const sessionBridge = vi.mocked(autoIterationServiceMock.configure).mock
        .calls[0]![0] as AutoIterationSessionBridge;

      await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).rejects.toThrow(
        sendError
      );

      expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('old-session');
      expect(sessionLifecycleService.startSession).toHaveBeenCalledWith('new-session', {
        startupModePreset: 'non_interactive',
      });
      expect(workspaceAutoIterationService.setSession).toHaveBeenCalledWith('ws-1', 'new-session');
      expect(sessionService.sendAcpMessage).toHaveBeenCalledWith('new-session', [
        { type: 'text', text: 'handoff prompt' },
      ]);
      expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('new-session');
      expect(sessionDomainService.clearSession).toHaveBeenCalledWith('new-session');
      expect(sessionDataService.deleteAgentSession).toHaveBeenCalledWith('new-session');
      expect(sessionDataService.updateAgentSession).toHaveBeenCalledWith('old-session', {
        status: SessionStatus.COMPLETED,
        providerProcessPid: null,
      });
      expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledWith(
        'ws-1',
        'new-session',
        AutoIterationStatus.FAILED
      );
      expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(workspaceAutoIterationService.finishSessionIfMatching).mock.invocationCallOrder[0]
      ).toBeLessThan(vi.mocked(sessionDataService.deleteAgentSession).mock.invocationCallOrder[0]!);
      expect(
        vi.mocked(workspaceAutoIterationService.setSession).mock.invocationCallOrder[0]
      ).toBeLessThan(vi.mocked(sessionService.sendAcpMessage).mock.invocationCallOrder[0]!);
    });

    it('does not clear a newer auto-iteration session after recycle cleanup', async () => {
      const autoIterationServiceMock = createAutoIterationServiceMock();
      vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
        autoIterationSessionId: 'old-session',
      } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
      vi.mocked(workspaceAutoIterationService.finishSessionIfMatching).mockResolvedValue(false);
      vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
        id: 'new-session',
      } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
      vi.mocked(sessionService.sendAcpMessage).mockRejectedValue(new Error('prompt failed'));

      configureDomainBridges(
        createBridgeServices({ autoIterationService: autoIterationServiceMock })
      );
      const sessionBridge = vi.mocked(autoIterationServiceMock.configure).mock
        .calls[0]![0] as AutoIterationSessionBridge;

      await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).rejects.toThrow(
        'prompt failed'
      );

      expect(sessionLifecycleService.stopSession).toHaveBeenCalledWith('new-session');
      expect(sessionDomainService.clearSession).toHaveBeenCalledWith('new-session');
      expect(sessionDataService.deleteAgentSession).toHaveBeenCalledWith('new-session');
      expect(workspaceAutoIterationService.setSession).toHaveBeenCalledTimes(1);
      expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledWith(
        'ws-1',
        'new-session',
        AutoIterationStatus.FAILED
      );
      expect(workspaceAutoIterationService.finishSessionIfMatching).toHaveBeenCalledWith(
        'ws-1',
        'old-session',
        AutoIterationStatus.FAILED
      );
    });

    it('marks a created session failed when recycle rollback deletion fails', async () => {
      const autoIterationServiceMock = createAutoIterationServiceMock();
      const sendError = new Error('prompt failed');
      vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
        autoIterationSessionId: 'old-session',
      } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
      vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
        id: 'new-session',
      } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
      vi.mocked(sessionDataService.deleteAgentSession).mockRejectedValueOnce(
        new Error('delete failed')
      );
      vi.mocked(sessionService.sendAcpMessage).mockRejectedValueOnce(sendError);

      configureDomainBridges(
        createBridgeServices({ autoIterationService: autoIterationServiceMock })
      );
      const sessionBridge = vi.mocked(autoIterationServiceMock.configure).mock
        .calls[0]![0] as AutoIterationSessionBridge;

      await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).rejects.toThrow(
        sendError
      );

      expect(sessionDataService.updateAgentSession).toHaveBeenCalledWith('new-session', {
        status: SessionStatus.FAILED,
        providerProcessPid: null,
        providerMetadata: {
          rollbackReason: 'auto_iteration_recycle_failed_after_create',
        },
      });
    });

    it('preserves the handoff error when recycle rollback repair fails', async () => {
      const autoIterationServiceMock = createAutoIterationServiceMock();
      const sendError = new Error('prompt failed');
      vi.mocked(workspaceAutoIterationService.getExecutionContext).mockResolvedValue({
        autoIterationSessionId: 'old-session',
      } as Awaited<ReturnType<typeof workspaceAutoIterationService.getExecutionContext>>);
      vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
        id: 'new-session',
      } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
      vi.mocked(sessionDataService.deleteAgentSession).mockRejectedValueOnce(
        new Error('delete failed')
      );
      vi.mocked(sessionDataService.updateAgentSession).mockRejectedValueOnce(
        new Error('repair failed')
      );
      vi.mocked(sessionService.sendAcpMessage).mockRejectedValueOnce(sendError);

      configureDomainBridges(
        createBridgeServices({ autoIterationService: autoIterationServiceMock })
      );
      const sessionBridge = vi.mocked(autoIterationServiceMock.configure).mock
        .calls[0]![0] as AutoIterationSessionBridge;

      await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).rejects.toThrow(
        sendError
      );

      expect(sessionDataService.updateAgentSession).toHaveBeenCalledWith('new-session', {
        status: SessionStatus.FAILED,
        providerProcessPid: null,
        providerMetadata: {
          rollbackReason: 'auto_iteration_recycle_failed_after_create',
        },
      });
    });
  });

  describe('session bridge delegation', () => {
    it('chatEventForwarder workspace bridge delegates markSessionRunning', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(chatEventForwarderService.configure);

      bridge.workspace.markSessionRunning('ws1', 's1');
      expect(workspaceActivityService.markSessionRunning).toHaveBeenCalledWith('ws1', 's1');
    });

    it('chatEventForwarder workspace bridge delegates markSessionIdle', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(chatEventForwarderService.configure);

      bridge.workspace.markSessionIdle('ws1', 's1', 12);
      expect(workspaceActivityService.markSessionIdle).toHaveBeenCalledWith('ws1', 's1', 12);
    });

    it('chatEventForwarder workspace bridge delegates on', () => {
      const handler = vi.fn();
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(chatEventForwarderService.configure);

      bridge.workspace.on('request_notification', handler);
      expect(workspaceActivityService.on).toHaveBeenCalledWith('request_notification', handler);
    });

    it('chatMessageHandler initPolicy bridge delegates getWorkspaceInitPolicy', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(chatMessageHandlerService.configure);

      bridge.initPolicy.getWorkspaceInitPolicy({ status: 'READY' });
      expect(getWorkspaceInitPolicy).toHaveBeenCalledWith({ status: 'READY' });
    });

    it('sessionService workspace bridge delegates markSessionRunning', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(sessionService.configure);

      bridge.workspace.markSessionRunning('ws1', 's1');
      expect(workspaceActivityService.markSessionRunning).toHaveBeenCalledWith('ws1', 's1');
    });

    it('sessionService workspace bridge delegates markSessionIdle', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(sessionService.configure);

      bridge.workspace.markSessionIdle('ws1', 's1', 12);
      expect(workspaceActivityService.markSessionIdle).toHaveBeenCalledWith('ws1', 's1', 12);
    });

    it('session lifecycle workspace bridge delegates ratchet session end recording', async () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(sessionLifecycleService.configure);

      await bridge.workspace.recordRatchetSessionEnd('ws1', 's1', 'DIED');
      expect(ratchetService.recordSessionEnd).toHaveBeenCalledWith('ws1', 's1', 'DIED');
    });

    it('session lifecycle message queue bridge delegates pending dispatch to chat handlers', async () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(sessionLifecycleService.configure);

      await bridge.messageQueue?.tryDispatchNextMessage('s1');
      expect(chatMessageHandlerService.tryDispatchNextMessage).toHaveBeenCalledWith('s1');
    });

    it('prompt completion service delegates queue dispatch to chat handlers', async () => {
      configureDomainBridges(createBridgeServices());
      const onPromptTurnComplete = vi.mocked(sessionPromptTurnCompletionService.setHandler).mock
        .calls[0]?.[0];

      expect(onPromptTurnComplete).toBeTypeOf('function');
      await onPromptTurnComplete?.('s1');
      expect(chatMessageHandlerService.tryDispatchNextMessage).toHaveBeenCalledWith('s1', {
        bypassTurnInProgressBackoff: true,
      });
    });
  });

  describe('run-script bridge delegation', () => {
    it('startupScript workspace bridge delegates markReady', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(startupScriptService.configure);

      bridge.workspace.markReady('ws1');
      expect(workspaceStateMachine.markReady).toHaveBeenCalledWith('ws1');
    });

    it('startupScript workspace bridge delegates markFailed', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(startupScriptService.configure);

      bridge.workspace.markFailed('ws1', 'script error');
      expect(workspaceStateMachine.markFailed).toHaveBeenCalledWith('ws1', 'script error');
    });
  });

  describe('idempotency', () => {
    it('can be called multiple times without error', () => {
      configureDomainBridges(createBridgeServices());
      configureDomainBridges(createBridgeServices());

      expect(ratchetService.configure).toHaveBeenCalledTimes(2);
      expect(workspaceQueryService.configure).toHaveBeenCalledTimes(2);
    });
  });
});
