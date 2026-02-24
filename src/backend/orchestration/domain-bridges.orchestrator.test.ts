import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Module mocks (inline vi.fn() - no top-level variable references) ---

vi.mock('@/backend/domains/ratchet', () => ({
  ratchetService: { configure: vi.fn(), clearRatchetActiveSessionIfMatching: vi.fn() },
  fixerSessionService: {
    configure: vi.fn(),
    acquireAndDispatch: vi.fn(),
    getActiveSession: vi.fn(),
  },
  reconciliationService: { configure: vi.fn() },
}));

vi.mock('@/backend/domains/workspace', () => ({
  kanbanStateService: { configure: vi.fn(), updateCachedKanbanColumn: vi.fn() },
  workspaceQueryService: { configure: vi.fn() },
  workspaceActivityService: {
    markSessionRunning: vi.fn(),
    markSessionIdle: vi.fn(),
    on: vi.fn(),
  },
  workspaceStateMachine: { markFailed: vi.fn(), markReady: vi.fn() },
  getWorkspaceInitPolicy: vi.fn(),
}));

vi.mock('@/backend/domains/session', () => ({
  sessionService: {
    configure: vi.fn(),
    setPromptTurnCompleteHandler: vi.fn(),
    isSessionRunning: vi.fn(),
    isSessionWorking: vi.fn(),
    isAnySessionWorking: vi.fn(),
    stopSession: vi.fn(),
    startSession: vi.fn(),
    sendSessionMessage: vi.fn(),
  },
  sessionDomainService: { injectCommittedUserMessage: vi.fn() },
  chatEventForwarderService: { configure: vi.fn(), getAllPendingRequests: vi.fn() },
  chatMessageHandlerService: { configure: vi.fn(), tryDispatchNextMessage: vi.fn() },
}));

vi.mock('@/backend/domains/github', () => ({
  githubCLIService: {
    extractPRInfo: vi.fn(),
    getPRFullDetails: vi.fn(),
    getReviewComments: vi.fn(),
    computeCIStatus: vi.fn(),
    getAuthenticatedUsername: vi.fn(),
    fetchAndComputePRState: vi.fn(),
    checkHealth: vi.fn(),
    listReviewRequests: vi.fn(),
  },
  prSnapshotService: { configure: vi.fn(), refreshWorkspace: vi.fn() },
}));

vi.mock('@/backend/domains/run-script', () => ({
  startupScriptService: { configure: vi.fn() },
}));

// --- Import mocked modules to get references ---

import { githubCLIService, prSnapshotService } from '@/backend/domains/github';
import {
  fixerSessionService,
  ratchetService,
  reconciliationService,
} from '@/backend/domains/ratchet';
import { startupScriptService } from '@/backend/domains/run-script';
import {
  chatEventForwarderService,
  chatMessageHandlerService,
  sessionDomainService,
  sessionService,
} from '@/backend/domains/session';
import {
  getWorkspaceInitPolicy,
  kanbanStateService,
  workspaceActivityService,
  workspaceQueryService,
  workspaceStateMachine,
} from '@/backend/domains/workspace';
import { configureDomainBridges } from './domain-bridges.orchestrator';

// Helper to extract bridge argument from a mocked configure call.
function getBridge<T>(mockFn: (arg: T) => void): T {
  return vi.mocked(mockFn).mock.calls[0]![0];
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
  });

  describe('reconciliation bridge delegation', () => {
    it('workspace bridge markFailed delegates to workspaceStateMachine', async () => {
      configureDomainBridges();
      const bridge = getBridge(reconciliationService.configure);

      await bridge.workspace.markFailed('ws1', 'broken');
      expect(workspaceStateMachine.markFailed).toHaveBeenCalledWith('ws1', 'broken');
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

    it('workspaceQueryService gets prSnapshot bridge with refreshWorkspace', () => {
      configureDomainBridges();
      const bridge = getBridge(workspaceQueryService.configure);

      bridge.prSnapshot.refreshWorkspace('ws1', 'https://pr.url');
      expect(prSnapshotService.refreshWorkspace).toHaveBeenCalledWith('ws1', 'https://pr.url');
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

      bridge.workspace.markSessionIdle('ws1', 's1');
      expect(workspaceActivityService.markSessionIdle).toHaveBeenCalledWith('ws1', 's1');
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

      bridge.workspace.markSessionIdle('ws1', 's1');
      expect(workspaceActivityService.markSessionIdle).toHaveBeenCalledWith('ws1', 's1');
    });

    it('sessionService workspace bridge delegates ratchet session cleanup', async () => {
      configureDomainBridges();
      const bridge = getBridge(sessionService.configure);

      await bridge.workspace.clearRatchetActiveSessionIfMatching('ws1', 's1');
      expect(ratchetService.clearRatchetActiveSessionIfMatching).toHaveBeenCalledWith('ws1', 's1');
    });

    it('sessionService prompt-turn callback delegates queue dispatch to chat handlers', async () => {
      configureDomainBridges();
      const onPromptTurnComplete = vi.mocked(sessionService.setPromptTurnCompleteHandler).mock
        .calls[0]?.[0];

      expect(onPromptTurnComplete).toBeTypeOf('function');
      await onPromptTurnComplete?.('s1');
      expect(chatMessageHandlerService.tryDispatchNextMessage).toHaveBeenCalledWith('s1');
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
