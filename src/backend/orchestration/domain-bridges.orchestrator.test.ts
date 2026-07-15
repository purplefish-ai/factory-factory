import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoIterationSessionBridge } from '@/backend/services/auto-iteration';

// --- Module mocks (inline vi.fn() - no top-level variable references) ---

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

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
  kanbanStateService: { configure: vi.fn(), updateCachedKanbanColumn: vi.fn() },
  workspaceAccessor: { create: vi.fn(), findRawById: vi.fn(), update: vi.fn() },
  workspaceQueryService: { configure: vi.fn() },
  workspaceActivityService: {
    markSessionRunning: vi.fn(),
    markSessionIdle: vi.fn(),
    on: vi.fn(),
  },
  workspaceStateMachine: { markFailed: vi.fn(), markReady: vi.fn() },
  getWorkspaceInitPolicy: vi.fn(),
}));

vi.mock('@/backend/services/session', () => ({
  sessionDataService: {
    createAgentSession: vi.fn(),
    findAgentSessionsByWorkspaceId: vi.fn(),
  },
  sessionService: {
    configure: vi.fn(),
    setPromptTurnCompleteHandler: vi.fn(),
    isSessionRunning: vi.fn(),
    isSessionWorking: vi.fn(),
    isAnySessionWorking: vi.fn(),
    getRuntimeSnapshot: vi.fn(),
    stopSession: vi.fn(),
    startSession: vi.fn(),
    sendSessionMessage: vi.fn(),
    sendAcpMessage: vi.fn(),
  },
  sessionDomainService: {
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
  prFetchRegistry: {
    isRecentlyFetched: vi.fn(),
    register: vi.fn(),
    startFetch: vi.fn(),
    cancelFetch: vi.fn(),
  },
  prSnapshotService: { configure: vi.fn(), refreshWorkspace: vi.fn() },
}));

vi.mock('@/backend/services/periodic-task', () => ({
  periodicTaskService: { configure: vi.fn() },
}));

vi.mock('@/backend/services/run-script', () => ({
  startupScriptService: { configure: vi.fn() },
}));

vi.mock('./workspace-init.orchestrator', () => ({
  initializeWorkspaceWorktree: vi.fn(),
}));

// --- Import mocked modules to get references ---

import { githubCLIService, prFetchRegistry, prSnapshotService } from '@/backend/services/github';
import { periodicTaskService } from '@/backend/services/periodic-task';
import { fixerSessionService, ratchetService } from '@/backend/services/ratchet';
import { startupScriptService } from '@/backend/services/run-script';
import {
  chatEventForwarderService,
  chatMessageHandlerService,
  sessionDataService,
  sessionDomainService,
  sessionService,
} from '@/backend/services/session';
import {
  getWorkspaceInitPolicy,
  kanbanStateService,
  workspaceAccessor,
  workspaceActivityService,
  workspaceQueryService,
  workspaceStateMachine,
} from '@/backend/services/workspace';
import { configureDomainBridges } from './domain-bridges.orchestrator';
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

describe('configureDomainBridges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('configures all ratchet domain services', () => {
    configureDomainBridges();

    expect(ratchetService.configure).toHaveBeenCalledTimes(1);
    expect(fixerSessionService.configure).toHaveBeenCalledTimes(1);
    expect(reconciliationService.configure).toHaveBeenCalledTimes(1);
  });

  it('configures workspace domain services', () => {
    configureDomainBridges();

    expect(kanbanStateService.configure).toHaveBeenCalledTimes(1);
    expect(workspaceQueryService.configure).toHaveBeenCalledTimes(1);
  });

  it('configures GitHub domain services', () => {
    configureDomainBridges();

    expect(prSnapshotService.configure).toHaveBeenCalledTimes(1);
  });

  it('configures session domain services', () => {
    configureDomainBridges();

    expect(chatEventForwarderService.configure).toHaveBeenCalledTimes(1);
    expect(chatMessageHandlerService.configure).toHaveBeenCalledTimes(1);
    expect(sessionService.configure).toHaveBeenCalledTimes(1);
    expect(sessionService.setPromptTurnCompleteHandler).toHaveBeenCalledTimes(1);
  });

  it('configures run-script domain services', () => {
    configureDomainBridges();

    expect(startupScriptService.configure).toHaveBeenCalledTimes(1);
  });

  it('configures periodic task domain services', () => {
    configureDomainBridges();

    expect(periodicTaskService.configure).toHaveBeenCalledTimes(1);
  });

  describe('ratchet bridge delegation', () => {
    it('session bridge delegates isSessionRunning to sessionService', () => {
      configureDomainBridges();
      const bridge = getBridge(ratchetService.configure);

      bridge.session.isSessionRunning('s1');
      expect(sessionService.isSessionRunning).toHaveBeenCalledWith('s1');
    });

    it('session bridge delegates stopSession to sessionService', () => {
      configureDomainBridges();
      const bridge = getBridge(ratchetService.configure);

      bridge.session.stopSession('s1');
      expect(sessionService.stopSession).toHaveBeenCalledWith('s1');
    });

    it('session bridge delegates startSession to sessionService', () => {
      configureDomainBridges();
      const bridge = getBridge(ratchetService.configure);

      bridge.session.startSession('s1', { initialPrompt: 'hello' });
      expect(sessionService.startSession).toHaveBeenCalledWith('s1', {
        initialPrompt: 'hello',
      });
    });

    it('session bridge delegates sendSessionMessage to sessionService', async () => {
      configureDomainBridges();
      const bridge = getBridge(ratchetService.configure);

      await bridge.session.sendSessionMessage('s1', 'hello');
      expect(sessionService.sendSessionMessage).toHaveBeenCalledWith('s1', 'hello');
    });

    it('session bridge delegates injectCommittedUserMessage to sessionDomainService', () => {
      configureDomainBridges();
      const bridge = getBridge(ratchetService.configure);

      bridge.session.injectCommittedUserMessage('s1', 'msg');
      expect(sessionDomainService.injectCommittedUserMessage).toHaveBeenCalledWith('s1', 'msg');
    });

    it('github bridge delegates extractPRInfo to githubCLIService', () => {
      configureDomainBridges();
      const bridge = getBridge(ratchetService.configure);

      bridge.github.extractPRInfo('https://github.com/owner/repo/pull/1');
      expect(githubCLIService.extractPRInfo).toHaveBeenCalledWith(
        'https://github.com/owner/repo/pull/1'
      );
    });

    it('github bridge delegates computeCIStatus with null input', () => {
      configureDomainBridges();
      const bridge = getBridge(ratchetService.configure);

      bridge.github.computeCIStatus(null);
      expect(githubCLIService.computeCIStatus).toHaveBeenCalledWith(null);
    });

    it('github bridge maps conclusion null to undefined in computeCIStatus', () => {
      configureDomainBridges();
      const bridge = getBridge(ratchetService.configure);

      const checks = [{ name: 'build', status: 'completed', conclusion: null }];
      bridge.github.computeCIStatus(checks);
      expect(githubCLIService.computeCIStatus).toHaveBeenCalledWith([
        { name: 'build', status: 'completed', conclusion: undefined },
      ]);
    });

    it('github bridge delegates startFetch to prFetchRegistry', () => {
      configureDomainBridges();
      const bridge = getBridge(ratchetService.configure);

      bridge.github.startFetch('ws1');
      expect(prFetchRegistry.startFetch).toHaveBeenCalledWith('ws1');
    });

    it('github bridge delegates isRecentlyFetched to prFetchRegistry', () => {
      vi.mocked(prFetchRegistry.isRecentlyFetched).mockReturnValue(true);
      configureDomainBridges();
      const bridge = getBridge(ratchetService.configure);

      expect(bridge.github.isRecentlyFetched('ws1')).toBe(true);
      expect(prFetchRegistry.isRecentlyFetched).toHaveBeenCalledWith('ws1');
    });

    it('github bridge delegates registerFetch to prFetchRegistry', () => {
      configureDomainBridges();
      const bridge = getBridge(ratchetService.configure);

      bridge.github.registerFetch('ws1');
      expect(prFetchRegistry.register).toHaveBeenCalledWith('ws1');
    });

    it('github bridge delegates cancelFetch to prFetchRegistry', () => {
      configureDomainBridges();
      const bridge = getBridge(ratchetService.configure);

      bridge.github.cancelFetch('ws1');
      expect(prFetchRegistry.cancelFetch).toHaveBeenCalledWith('ws1');
    });
  });

  describe('reconciliation bridge delegation', () => {
    it('workspace bridge markFailed delegates to workspaceStateMachine', async () => {
      configureDomainBridges();
      const bridge = getBridge(reconciliationService.configure);

      await bridge.workspace.markFailed('ws1', 'broken');
      expect(workspaceStateMachine.markFailed).toHaveBeenCalledWith('ws1', 'broken');
    });

    it('workspace bridge initializeWorktree delegates to initializeWorkspaceWorktree', async () => {
      configureDomainBridges();
      const bridge = getBridge(reconciliationService.configure);

      await bridge.workspace.initializeWorktree('ws1', { branchName: 'feature/test' });
      expect(initializeWorkspaceWorktree).toHaveBeenCalledWith('ws1', {
        branchName: 'feature/test',
      });
    });
  });

  describe('workspace bridge delegation', () => {
    it('kanban session bridge delegates isAnySessionWorking', () => {
      configureDomainBridges();
      const bridge = getBridge(kanbanStateService.configure);

      bridge.session.isAnySessionWorking(['s1', 's2']);
      expect(sessionService.isAnySessionWorking).toHaveBeenCalledWith(['s1', 's2']);
    });

    it('kanban session bridge delegates getAllPendingRequests', () => {
      configureDomainBridges();
      const bridge = getBridge(kanbanStateService.configure);

      bridge.session.getAllPendingRequests();
      expect(chatEventForwarderService.getAllPendingRequests).toHaveBeenCalled();
    });

    it('workspaceQueryService gets github bridge with checkHealth', () => {
      configureDomainBridges();
      const bridge = getBridge(workspaceQueryService.configure);

      bridge.github.checkHealth();
      expect(githubCLIService.checkHealth).toHaveBeenCalled();
    });

    it('workspaceQueryService gets session bridge with runtime snapshots', () => {
      configureDomainBridges();
      const bridge = getBridge(workspaceQueryService.configure);

      bridge.session.getRuntimeSnapshot('s1');
      expect(sessionService.getRuntimeSnapshot).toHaveBeenCalledWith('s1');
    });

    it('workspaceQueryService gets prSnapshot bridge with refreshWorkspace', () => {
      configureDomainBridges();
      const bridge = getBridge(workspaceQueryService.configure);

      bridge.prSnapshot.refreshWorkspace('ws1', 'https://pr.url');
      expect(prSnapshotService.refreshWorkspace).toHaveBeenCalledWith('ws1', 'https://pr.url');
    });
  });

  describe('periodic task bridge delegation', () => {
    it('creates periodic task workspaces and logs background init failures', async () => {
      const workspace = {
        id: 'ws-periodic',
      } as Awaited<ReturnType<typeof workspaceAccessor.create>>;
      vi.mocked(workspaceAccessor.create).mockResolvedValue(workspace);
      vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
        id: 'session-1',
      } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
      vi.mocked(initializeWorkspaceWorktree).mockRejectedValue(new Error('init failed'));

      configureDomainBridges();
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

      expect(workspaceAccessor.create).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          name: 'Periodic task run',
          creationSource: 'PERIODIC_TASK',
          periodicTaskId: 'periodic-task-1',
          ratchetEnabled: true,
          creationMetadata: { initialPrompt: 'Do the recurring work' },
        })
      );
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
      vi.mocked(workspaceAccessor.findRawById).mockResolvedValue({
        status: 'READY',
        prUrl: null,
        prNumber: null,
        initCompletedAt: new Date('2026-05-20T12:00:00Z'),
      } as Awaited<ReturnType<typeof workspaceAccessor.findRawById>>);
      vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([
        { id: 'session-1' },
        { id: 'session-2' },
      ] as Awaited<ReturnType<typeof sessionDataService.findAgentSessionsByWorkspaceId>>);
      vi.mocked(sessionService.isAnySessionWorking).mockReturnValue(true);

      configureDomainBridges();
      const bridge = getBridge(periodicTaskService.configure);

      await expect(bridge.status.getWorkspaceStatus('ws-periodic')).resolves.toEqual({
        status: 'READY',
        prUrl: null,
        prNumber: null,
        isAgentWorking: true,
        initCompletedAt: new Date('2026-05-20T12:00:00Z'),
      });
      expect(sessionService.isAnySessionWorking).toHaveBeenCalledWith(['session-1', 'session-2']);
    });

    it('treats queued periodic task session messages as active agent work', async () => {
      vi.mocked(workspaceAccessor.findRawById).mockResolvedValue({
        status: 'READY',
        prUrl: null,
        prNumber: null,
        initCompletedAt: new Date('2026-05-20T12:00:00Z'),
      } as Awaited<ReturnType<typeof workspaceAccessor.findRawById>>);
      vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([
        { id: 'session-1' },
        { id: 'session-2' },
      ] as Awaited<ReturnType<typeof sessionDataService.findAgentSessionsByWorkspaceId>>);
      vi.mocked(sessionService.isAnySessionWorking).mockReturnValue(false);
      vi.mocked(sessionService.isSessionRunning).mockReturnValue(true);
      vi.mocked(sessionDomainService.getQueueLength).mockReturnValueOnce(0).mockReturnValueOnce(1);

      configureDomainBridges();
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
      vi.mocked(workspaceAccessor.findRawById).mockResolvedValue({
        status: 'READY',
        prUrl: null,
        prNumber: null,
        initCompletedAt: new Date('2026-05-20T12:00:00Z'),
      } as Awaited<ReturnType<typeof workspaceAccessor.findRawById>>);
      vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([
        { id: 'session-1' },
      ] as Awaited<ReturnType<typeof sessionDataService.findAgentSessionsByWorkspaceId>>);
      vi.mocked(sessionService.isAnySessionWorking).mockReturnValue(false);
      vi.mocked(sessionService.isSessionRunning).mockReturnValue(false);

      configureDomainBridges();
      const bridge = getBridge(periodicTaskService.configure);

      await expect(bridge.status.getWorkspaceStatus('ws-periodic')).resolves.toMatchObject({
        isAgentWorking: false,
      });
      expect(sessionService.isSessionRunning).toHaveBeenCalledWith('session-1');
      expect(sessionDomainService.getQueueLength).not.toHaveBeenCalled();
    });
  });

  describe('auto-iteration session bridge', () => {
    it('cleans up a recycled session when handoff send fails', async () => {
      const autoIterationServiceMock = createAutoIterationServiceMock();
      const sendError = new Error('prompt failed');
      vi.mocked(workspaceAccessor.findRawById)
        .mockResolvedValueOnce({
          autoIterationSessionId: 'old-session',
        } as Awaited<ReturnType<typeof workspaceAccessor.findRawById>>)
        .mockResolvedValueOnce({
          autoIterationSessionId: 'new-session',
        } as Awaited<ReturnType<typeof workspaceAccessor.findRawById>>);
      vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
        id: 'new-session',
      } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
      vi.mocked(sessionService.sendAcpMessage).mockRejectedValue(sendError);

      configureDomainBridges({ autoIterationService: autoIterationServiceMock });
      const sessionBridge = vi.mocked(autoIterationServiceMock.configure).mock
        .calls[0]![0] as AutoIterationSessionBridge;

      await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).rejects.toThrow(
        sendError
      );

      expect(sessionService.stopSession).toHaveBeenCalledWith('old-session');
      expect(sessionService.startSession).toHaveBeenCalledWith('new-session', {
        startupModePreset: 'non_interactive',
      });
      expect(workspaceAccessor.update).toHaveBeenNthCalledWith(1, 'ws-1', {
        autoIterationSessionId: 'new-session',
      });
      expect(sessionService.sendAcpMessage).toHaveBeenCalledWith('new-session', [
        { type: 'text', text: 'handoff prompt' },
      ]);
      expect(sessionService.stopSession).toHaveBeenCalledWith('new-session');
      expect(workspaceAccessor.update).toHaveBeenNthCalledWith(2, 'ws-1', {
        autoIterationSessionId: null,
      });
      expect(vi.mocked(workspaceAccessor.update).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(sessionService.sendAcpMessage).mock.invocationCallOrder[0]!
      );
    });

    it('does not clear a newer auto-iteration session after recycle cleanup', async () => {
      const autoIterationServiceMock = createAutoIterationServiceMock();
      vi.mocked(workspaceAccessor.findRawById)
        .mockResolvedValueOnce({
          autoIterationSessionId: 'old-session',
        } as Awaited<ReturnType<typeof workspaceAccessor.findRawById>>)
        .mockResolvedValueOnce({
          autoIterationSessionId: 'newer-session',
        } as Awaited<ReturnType<typeof workspaceAccessor.findRawById>>);
      vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
        id: 'new-session',
      } as Awaited<ReturnType<typeof sessionDataService.createAgentSession>>);
      vi.mocked(sessionService.sendAcpMessage).mockRejectedValue(new Error('prompt failed'));

      configureDomainBridges({ autoIterationService: autoIterationServiceMock });
      const sessionBridge = vi.mocked(autoIterationServiceMock.configure).mock
        .calls[0]![0] as AutoIterationSessionBridge;

      await expect(sessionBridge.recycleSession('ws-1', 'handoff prompt')).rejects.toThrow(
        'prompt failed'
      );

      expect(sessionService.stopSession).toHaveBeenCalledWith('new-session');
      expect(workspaceAccessor.update).toHaveBeenCalledTimes(1);
      expect(workspaceAccessor.update).toHaveBeenCalledWith('ws-1', {
        autoIterationSessionId: 'new-session',
      });
    });
  });

  describe('session bridge delegation', () => {
    it('chatEventForwarder workspace bridge delegates markSessionRunning', () => {
      configureDomainBridges();
      const bridge = getBridge(chatEventForwarderService.configure);

      bridge.workspace.markSessionRunning('ws1', 's1');
      expect(workspaceActivityService.markSessionRunning).toHaveBeenCalledWith('ws1', 's1');
    });

    it('chatEventForwarder workspace bridge delegates markSessionIdle', () => {
      configureDomainBridges();
      const bridge = getBridge(chatEventForwarderService.configure);

      bridge.workspace.markSessionIdle('ws1', 's1', 12);
      expect(workspaceActivityService.markSessionIdle).toHaveBeenCalledWith('ws1', 's1', 12);
    });

    it('chatEventForwarder workspace bridge delegates on', () => {
      const handler = vi.fn();
      configureDomainBridges();
      const bridge = getBridge(chatEventForwarderService.configure);

      bridge.workspace.on('request_notification', handler);
      expect(workspaceActivityService.on).toHaveBeenCalledWith('request_notification', handler);
    });

    it('chatMessageHandler initPolicy bridge delegates getWorkspaceInitPolicy', () => {
      configureDomainBridges();
      const bridge = getBridge(chatMessageHandlerService.configure);

      bridge.initPolicy.getWorkspaceInitPolicy({ status: 'READY' });
      expect(getWorkspaceInitPolicy).toHaveBeenCalledWith({ status: 'READY' });
    });

    it('sessionService workspace bridge delegates markSessionRunning', () => {
      configureDomainBridges();
      const bridge = getBridge(sessionService.configure);

      bridge.workspace.markSessionRunning('ws1', 's1');
      expect(workspaceActivityService.markSessionRunning).toHaveBeenCalledWith('ws1', 's1');
    });

    it('sessionService workspace bridge delegates markSessionIdle', () => {
      configureDomainBridges();
      const bridge = getBridge(sessionService.configure);

      bridge.workspace.markSessionIdle('ws1', 's1', 12);
      expect(workspaceActivityService.markSessionIdle).toHaveBeenCalledWith('ws1', 's1', 12);
    });

    it('sessionService workspace bridge delegates ratchet session end recording', async () => {
      configureDomainBridges();
      const bridge = getBridge(sessionService.configure);

      await bridge.workspace.recordRatchetSessionEnd('ws1', 's1', 'DIED');
      expect(ratchetService.recordSessionEnd).toHaveBeenCalledWith('ws1', 's1', 'DIED');
    });

    it('sessionService message queue bridge delegates pending dispatch to chat handlers', async () => {
      configureDomainBridges();
      const bridge = getBridge(sessionService.configure);

      await bridge.messageQueue?.tryDispatchNextMessage('s1');
      expect(chatMessageHandlerService.tryDispatchNextMessage).toHaveBeenCalledWith('s1');
    });

    it('sessionService prompt-turn callback delegates queue dispatch to chat handlers', async () => {
      configureDomainBridges();
      const onPromptTurnComplete = vi.mocked(sessionService.setPromptTurnCompleteHandler).mock
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
      configureDomainBridges();
      const bridge = getBridge(startupScriptService.configure);

      bridge.workspace.markReady('ws1');
      expect(workspaceStateMachine.markReady).toHaveBeenCalledWith('ws1');
    });

    it('startupScript workspace bridge delegates markFailed', () => {
      configureDomainBridges();
      const bridge = getBridge(startupScriptService.configure);

      bridge.workspace.markFailed('ws1', 'script error');
      expect(workspaceStateMachine.markFailed).toHaveBeenCalledWith('ws1', 'script error');
    });
  });

  describe('github domain bridge delegation', () => {
    it('prSnapshotService gets kanban bridge with updateCachedKanbanColumn', () => {
      configureDomainBridges();
      const bridge = getBridge(prSnapshotService.configure);

      bridge.kanban.updateCachedKanbanColumn('ws1');
      expect(kanbanStateService.updateCachedKanbanColumn).toHaveBeenCalledWith('ws1');
    });
  });

  describe('idempotency', () => {
    it('can be called multiple times without error', () => {
      configureDomainBridges();
      configureDomainBridges();

      expect(ratchetService.configure).toHaveBeenCalledTimes(2);
      expect(kanbanStateService.configure).toHaveBeenCalledTimes(2);
    });
  });
});
