import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  launchWorkspace,
  type WorkspaceLaunchPorts,
} from '@/backend/orchestration/workspace-launch.orchestrator';
import { autoIterationService, logbookService } from '@/backend/services/auto-iteration';

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

vi.mock('@/backend/services/ratchet', () => ({ ratchetService: { configure: vi.fn() } }));

vi.mock('./reconciliation.service', () => ({
  reconciliationService: { configure: vi.fn() },
}));

vi.mock('@/backend/services/workspace', () => ({
  workspacePRMonitoringService: { get: vi.fn(), listConfigs: vi.fn() },
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
  getWorkspaceInitPolicy: vi.fn(),
}));

vi.mock('@/backend/services/session', () => ({
  sessionBackgroundDeliveryService: { configure: vi.fn() },
  findPRDeliveryReceipt: vi.fn(),
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
  prObservationService: { configure: vi.fn() },
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
  recoverStaleProvisioningWorkspace: vi.fn(),
}));

import {
  githubCLIService,
  prFetchCoordinator,
  prSnapshotService,
  prObservationService,
} from '@/backend/services/github';
import { createLogger } from '@/backend/services/logger.service';
import { periodicTaskService } from '@/backend/services/periodic-task';
import { ratchetService } from '@/backend/services/ratchet';
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
  workspaceRunScriptService,
  workspaceSnapshotStore,
  workspaceStateMachine,
} from '@/backend/services/workspace';
import { type BridgeServices, configureDomainBridges } from './domain-bridges.orchestrator';
import { defaultPRMonitoringServices } from './pr-monitoring-dependencies';
import { reconciliationService } from './reconciliation.service';
import {
  initializeWorkspaceWorktree,
  recoverStaleProvisioningWorkspace,
} from './workspace-init.orchestrator';

function getBridge<T>(mockFn: (arg: T) => void): T {
  return vi.mocked(mockFn).mock.calls[0]![0];
}

function createBridgeServices(
  overrides: Partial<BridgeServices> = {},
  createWorkspace: WorkspaceLaunchPorts['createWorkspace'] = mockWorkspaceCreationService.create
): BridgeServices {
  const services: BridgeServices = {
    ...defaultPRMonitoringServices,
    autoIterationService,
    chatEventForwarderService,
    createLogger,
    getWorkspaceInitPolicy,
    githubCLIService,
    logbookService,
    periodicTaskService,
    prFetchCoordinator,
    prSnapshotService,
    ratchetService,
    recoverStaleProvisioningWorkspace,
    reconciliationService,
    sessionPromptTurnCompletionService,
    sessionService,
    startupScriptService,
    terminalSessionService,
    workspaceActivityService,
    workspaceAutoIterationService,
    launchWorkspace: (source) =>
      launchWorkspace(source, {
        createWorkspace,
        createDefaultSession: (input) => services.sessionDataService.createAgentSession(input),
        initializeWorktree: (id, options) => services.initializeWorkspaceWorktree(id, options),
        getMaxSessionsPerWorkspace: vi.fn(),
        resolveProvider: vi.fn(),
        checkCliHealth: vi.fn(),
        logger: services.createLogger('domain-bridges'),
      }),
    workspaceDataService,
    workspaceMaintenanceService,
    workspacePrSnapshotService,
    workspaceQueryService,
    workspaceRunScriptService,
    workspaceSnapshotStore,
    workspaceStateMachine,
    initializeWorkspaceWorktree,
    ...overrides,
  };
  return services;
}

describe('configureDomainBridges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('configures all ratchet domain services', () => {
    configureDomainBridges(createBridgeServices());

    expect(ratchetService.configure).toHaveBeenCalledTimes(1);
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

  describe('reconciliation bridge delegation', () => {
    it('workspace bridge recovery delegates to recoverStaleProvisioningWorkspace', async () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(reconciliationService.configure);

      await bridge.workspace.recoverStaleProvisioningWorkspace('ws1', 'timed out');
      expect(recoverStaleProvisioningWorkspace).toHaveBeenCalledWith('ws1', 'timed out');
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
    it('workspaceQueryService gets github bridge with checkHealth', async () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(workspaceQueryService.configure);

      await bridge.github.checkHealth();
      expect(githubCLIService.checkHealth).toHaveBeenCalled();
    });

    it('workspaceQueryService gets session bridge with runtime snapshots', () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(workspaceQueryService.configure);

      bridge.session.getRuntimeSnapshot('s1');
      expect(sessionLifecycleService.getRuntimeSnapshot).toHaveBeenCalledWith('s1');
    });

    it('workspaceQueryService gets prSnapshot bridge with refreshWorkspace', async () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(workspaceQueryService.configure);

      await bridge.prSnapshot.refreshWorkspace('ws1', 'https://pr.url');
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
        workflow: 'periodic-task',
        name: 'Periodic task',
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to initialize workspace for periodic task',
        expect.any(Error),
        { workspaceId: 'ws-periodic' }
      );
    });

    it('adapts the supplied launch result without creating or initializing a second workspace', async () => {
      const launch = vi.fn().mockResolvedValue({
        workspace: { id: 'injected-periodic' },
        defaultSessionId: 'session-injected',
      });
      configureDomainBridges(createBridgeServices({ launchWorkspace: launch }));
      const bridge = getBridge(periodicTaskService.configure);
      await expect(
        bridge.workspace.createWorkspaceForTask({
          projectId: 'p1',
          name: 'Scheduled name',
          prompt: 'Scheduled prompt',
          periodicTaskId: 'task-1',
        })
      ).resolves.toEqual({ workspaceId: 'injected-periodic' });
      expect(launch).toHaveBeenCalledExactlyOnceWith({
        type: 'PERIODIC_TASK',
        projectId: 'p1',
        name: 'Scheduled name',
        initialPrompt: 'Scheduled prompt',
        periodicTaskId: 'task-1',
        ratchetEnabled: true,
      });
      expect(mockWorkspaceCreationService.create).not.toHaveBeenCalled();
      expect(sessionDataService.createAgentSession).not.toHaveBeenCalled();
      expect(initializeWorkspaceWorktree).not.toHaveBeenCalled();
    });

    it('propagates required-session failure without starting background initialization', async () => {
      mockWorkspaceCreationService.create.mockResolvedValue({ id: 'retained-periodic' });
      const failure = new Error('required session failed');
      vi.mocked(sessionDataService.createAgentSession).mockRejectedValueOnce(failure);
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(periodicTaskService.configure);
      await expect(
        bridge.workspace.createWorkspaceForTask({
          projectId: 'p1',
          name: 'Scheduled name',
          prompt: 'Scheduled prompt',
          periodicTaskId: 'task-1',
        })
      ).rejects.toBe(failure);
      expect(mockWorkspaceCreationService.create).toHaveBeenCalledOnce();
      expect(initializeWorkspaceWorktree).not.toHaveBeenCalled();
    });

    it('launches periodic tasks through overridden creation, session and initialization capabilities', async () => {
      const events: string[] = [];
      mockWorkspaceCreationService.create.mockResolvedValue({ id: 'global-workspace' });
      vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
        id: 'global-session',
      } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
      vi.mocked(initializeWorkspaceWorktree).mockResolvedValue(undefined);
      const createWorkspace = vi.fn(() => {
        events.push('workspace');
        return Promise.resolve({ id: 'overridden-workspace' } as Awaited<
          ReturnType<BridgeServices['launchWorkspace']>
        >['workspace']);
      });
      const createAgentSession = vi.fn(() => {
        events.push('session');
        return Promise.resolve({ id: 'overridden-session' } as Awaited<
          ReturnType<typeof sessionDataService.createAgentSession>
        >);
      });
      const initialize = vi.fn(() => {
        events.push('initialize');
        return Promise.resolve();
      });
      const overriddenSessionData = new Proxy(sessionDataService, {
        get(target, property, receiver) {
          return property === 'createAgentSession'
            ? createAgentSession
            : Reflect.get(target, property, receiver);
        },
      });
      configureDomainBridges(
        createBridgeServices(
          {
            sessionDataService: overriddenSessionData,
            initializeWorkspaceWorktree: initialize,
          },
          createWorkspace
        )
      );
      const bridge = getBridge(periodicTaskService.configure);
      const input = {
        projectId: 'p1',
        name: 'Overridden task',
        prompt: 'Run scheduled work',
        periodicTaskId: 'task-override',
      };
      await expect(bridge.workspace.createWorkspaceForTask(input)).resolves.toEqual({
        workspaceId: 'overridden-workspace',
      });
      expect(events).toEqual(['workspace', 'session', 'initialize']);
      expect(createWorkspace).toHaveBeenCalledExactlyOnceWith({
        type: 'PERIODIC_TASK',
        projectId: 'p1',
        name: 'Overridden task',
        initialPrompt: 'Run scheduled work',
        periodicTaskId: 'task-override',
        ratchetEnabled: true,
      });
      expect(createAgentSession).toHaveBeenCalledExactlyOnceWith({
        workspaceId: 'overridden-workspace',
        workflow: 'periodic-task',
        name: 'Periodic task',
      });
      expect(initialize).toHaveBeenCalledExactlyOnceWith('overridden-workspace', undefined);
      expect(mockWorkspaceCreationService.create).not.toHaveBeenCalled();
      expect(sessionDataService.createAgentSession).not.toHaveBeenCalled();
      expect(initializeWorkspaceWorktree).not.toHaveBeenCalled();
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

  it('wires auto-iteration session capabilities through the configured service graph', async () => {
    const configure = vi.spyOn(autoIterationService, 'configure').mockReturnValue(undefined);
    const injectedCreate = vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
      id: 'injected-session',
    } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
    const injectedStart = vi.mocked(sessionLifecycleService.startSession);
    const injectedStop = vi.mocked(sessionLifecycleService.stopSession);
    const injectedSend = vi.mocked(sessionService.sendAcpMessage);
    configureDomainBridges(createBridgeServices());
    const [sessionBridge, workspaceBridge, logbookBridge] = configure.mock.calls[0]!;

    await expect(sessionBridge.startSession('ws-wired', { initialPrompt: 'start' })).resolves.toBe(
      'injected-session'
    );
    await sessionBridge.sendPrompt('injected-session', 'next', 123);
    await sessionBridge.stopSession('injected-session');
    expect(injectedCreate).toHaveBeenCalledWith({
      workspaceId: 'ws-wired',
      name: 'Auto-iteration',
      workflow: 'auto-iteration',
    });
    expect(injectedStart).toHaveBeenCalledWith('injected-session', {
      initialPrompt: 'start',
      startupModePreset: undefined,
    });
    expect(injectedSend).toHaveBeenCalledWith(
      'injected-session',
      [{ type: 'text', text: 'next' }],
      123,
      { timeoutKind: 'configured' }
    );
    expect(injectedStop).toHaveBeenCalledWith('injected-session');
    expect(workspaceBridge.updateAutoIterationSessionId).toBeTypeOf('function');
    expect(logbookBridge).toBe(logbookService);
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
      expect(defaultPRMonitoringServices.workspacePRMonitoringService.get).toHaveBeenCalledWith(
        'ws1'
      );
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
      expect(defaultPRMonitoringServices.workspacePRMonitoringService.get).toHaveBeenCalledWith(
        'ws1'
      );
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
    it('startupScript workspace bridge delegates markReady', async () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(startupScriptService.configure);

      await bridge.workspace.markReady('ws1');
      expect(workspaceStateMachine.markReady).toHaveBeenCalledWith('ws1');
    });

    it('startupScript workspace bridge delegates markFailed', async () => {
      configureDomainBridges(createBridgeServices());
      const bridge = getBridge(startupScriptService.configure);

      await bridge.workspace.markFailed('ws1', 'script error');
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

it('wires PR monitoring through the injected graph rather than global instances', async () => {
  const monitoring = {
    ...defaultPRMonitoringServices.workspacePRMonitoringService,
    listConfigs: vi.fn(async () => []),
    get: vi.fn(async () => null),
  };
  const observer = { ...prObservationService, configure: vi.fn() };
  const background = {
    ...defaultPRMonitoringServices.sessionBackgroundDeliveryService,
    configure: vi.fn(),
  };
  const settings = {
    ...defaultPRMonitoringServices.userSettingsService,
    get: vi.fn(async () => ({ ratchetReviewTriggerMode: 'all' })),
  };
  configureDomainBridges(
    createBridgeServices({
      workspacePRMonitoringService:
        monitoring as unknown as BridgeServices['workspacePRMonitoringService'],
      prObservationService: observer as unknown as BridgeServices['prObservationService'],
      sessionBackgroundDeliveryService:
        background as unknown as BridgeServices['sessionBackgroundDeliveryService'],
      userSettingsService: settings as unknown as BridgeServices['userSettingsService'],
    })
  );
  await getBridge(vi.mocked(ratchetService.configure)).retireLegacy?.();
  await getBridge(vi.mocked(ratchetService.configure)).wake('custom-workspace');
  expect(monitoring.listConfigs).toHaveBeenCalledOnce();
  expect(monitoring.get).toHaveBeenCalledWith('custom-workspace');
  expect(background.configure).toHaveBeenCalledOnce();
  await getBridge(observer.configure).readPolicy();
  expect(settings.get).toHaveBeenCalledOnce();
});
