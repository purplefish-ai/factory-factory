// Register the shared mocks before any service or orchestrator module loads.
import './workspace-init.test-harness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chatMessageHandlerService,
  sessionDataService,
  sessionDomainService,
  sessionLifecycleService,
} from '@/backend/services/session';
import { SessionStatus } from '@/shared/core';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { bindIssueMonitoringSession } from './pr-monitoring.orchestrator';
import {
  clearWorkspaceInitOrchestratorStateForTests,
  initializeWorkspaceWorktree,
  retryQueuedDispatchAfterWorkspaceReady,
} from './workspace-init.orchestrator';
import { WORKSPACE_ID, mockLogger, setupHappyPath } from './workspace-init.test-harness';

describe('workspace startup PR binding recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(bindIssueMonitoringSession).mockReset();
    clearWorkspaceInitOrchestratorStateForTests();
  });
  it.each([false, true])(
    'keeps startup and human dispatch successful when monitoring binding fails (persistent: %s)',
    async (persistent) => {
      setupHappyPath({ creationMetadata: { initialPrompt: 'Implement the issue' } });
      vi.mocked(sessionDomainService.enqueue).mockReturnValue({ position: 0 });
      vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([
        unsafeCoerce({ id: 'session-main', status: SessionStatus.IDLE, model: 'claude-sonnet' }),
      ]);
      vi.mocked(bindIssueMonitoringSession).mockRejectedValueOnce(
        new Error('Binding database unavailable')
      );
      if (persistent) {
        vi.mocked(bindIssueMonitoringSession).mockRejectedValueOnce(
          new Error('Binding database still unavailable')
        );
      }
      await initializeWorkspaceWorktree(WORKSPACE_ID);
      expect(bindIssueMonitoringSession).toHaveBeenCalledTimes(2);
      expect(bindIssueMonitoringSession).toHaveBeenLastCalledWith(WORKSPACE_ID, 'session-main');
      expect(sessionLifecycleService.startSession).toHaveBeenCalledTimes(1);
      expect(sessionDomainService.enqueue).toHaveBeenCalledTimes(1);
      expect(chatMessageHandlerService.tryDispatchNextMessage).toHaveBeenCalledTimes(2);
      expect(sessionDataService.findAgentSessionsByWorkspaceId).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        'Failed to auto-start default Claude session for workspace',
        expect.anything()
      );
    }
  );
});

describe('workspace-ready recovery selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(bindIssueMonitoringSession).mockReset();
    vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockReset();
  });
  it.each(['ratchet', 'auto-iteration', 'adversarial_review'])(
    'skips running %s workflow and binds the ordinary candidate',
    async (workflow) => {
      vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([
        unsafeCoerce({ id: 'workflow-session', status: SessionStatus.RUNNING, workflow }),
        unsafeCoerce({
          id: 'ordinary-session',
          status: SessionStatus.RUNNING,
          workflow: 'implementation',
        }),
      ]);
      await retryQueuedDispatchAfterWorkspaceReady(WORKSPACE_ID, null);
      expect(bindIssueMonitoringSession).toHaveBeenCalledExactlyOnceWith(
        WORKSPACE_ID,
        'ordinary-session'
      );
      expect(chatMessageHandlerService.tryDispatchNextMessage).toHaveBeenCalledExactlyOnceWith(
        'ordinary-session'
      );
      expect(sessionDataService.findAgentSessionsByWorkspaceId).toHaveBeenCalledWith(WORKSPACE_ID, {
        status: SessionStatus.RUNNING,
      });
      expect(sessionLifecycleService.startSession).not.toHaveBeenCalled();
    }
  );
  it('finds an eligible idle candidate when only non-recipient workflows are running', async () => {
    vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId)
      .mockResolvedValueOnce([
        unsafeCoerce({
          id: 'review',
          status: SessionStatus.RUNNING,
          workflow: 'adversarial_review',
        }),
      ])
      .mockResolvedValueOnce([
        unsafeCoerce({ id: 'fixer', status: SessionStatus.IDLE, workflow: 'ratchet' }),
        unsafeCoerce({ id: 'idle-main', status: SessionStatus.IDLE, workflow: 'implementation' }),
      ]);
    await retryQueuedDispatchAfterWorkspaceReady(WORKSPACE_ID, null);
    expect(bindIssueMonitoringSession).toHaveBeenCalledExactlyOnceWith(WORKSPACE_ID, 'idle-main');
    expect(chatMessageHandlerService.tryDispatchNextMessage).toHaveBeenCalledExactlyOnceWith(
      'idle-main'
    );
    expect(sessionDataService.findAgentSessionsByWorkspaceId).toHaveBeenCalledWith(WORKSPACE_ID, {
      status: SessionStatus.IDLE,
    });
    expect(sessionLifecycleService.startSession).not.toHaveBeenCalled();
  });
  it('does not bind or dispatch an excluded workflow when there is no eligible recovery candidate', async () => {
    vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId)
      .mockResolvedValueOnce([
        unsafeCoerce({
          id: 'review',
          status: SessionStatus.RUNNING,
          workflow: 'adversarial_review',
        }),
      ])
      .mockResolvedValueOnce([
        unsafeCoerce({ id: 'fixer', status: SessionStatus.IDLE, workflow: 'ratchet' }),
      ]);
    await retryQueuedDispatchAfterWorkspaceReady(WORKSPACE_ID, null);
    expect(bindIssueMonitoringSession).not.toHaveBeenCalled();
    expect(chatMessageHandlerService.tryDispatchNextMessage).not.toHaveBeenCalled();
    expect(sessionLifecycleService.startSession).not.toHaveBeenCalled();
  });
});
