import { CIStatus, RatchetState, SessionStatus } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubComment } from '@/shared/github-types';

vi.mock('../db', () => ({
  prisma: {
    $transaction: vi.fn(),
  },
}));

vi.mock('../resource_accessors/user-settings.accessor', () => ({
  userSettingsAccessor: {
    get: vi.fn(),
  },
}));

vi.mock('../resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findWithPRsForRatchet: vi.fn(),
    findForRatchetById: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../resource_accessors/claude-session.accessor', () => ({
  claudeSessionAccessor: {
    create: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock('./github-cli.service', () => ({
  githubCLIService: {
    extractPRInfo: vi.fn(),
    getPRFullDetails: vi.fn(),
    getReviewComments: vi.fn(),
    computeCIStatus: vi.fn(),
    mergePR: vi.fn(),
  },
}));

vi.mock('./session.service', () => ({
  sessionService: {
    getClient: vi.fn(),
    isSessionActive: vi.fn(),
    startClaudeSession: vi.fn(),
  },
}));

vi.mock('./message-state.service', () => ({
  messageStateService: {
    getRecentUserAndAgentMessages: vi.fn(),
    injectCommittedUserMessage: vi.fn(),
  },
}));

vi.mock('./config.service', () => ({
  configService: {
    getMaxSessionsPerWorkspace: vi.fn(() => 5),
  },
}));

vi.mock('./logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import { userSettingsAccessor } from '../resource_accessors/user-settings.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { ratchetService } from './ratchet.service';
import { sessionService } from './session.service';

describe('ratchet service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (ratchetService as unknown as { isShuttingDown: boolean }).isShuttingDown = false;
  });

  it('checks workspaces even when global ratchet default is off', async () => {
    vi.mocked(userSettingsAccessor.get).mockResolvedValue({
      ratchetEnabled: false,
      ratchetAutoFixCi: true,
      ratchetAutoFixConflicts: true,
      ratchetAutoFixReviews: true,
      ratchetAutoMerge: false,
      ratchetAllowedReviewers: null,
    } as Awaited<ReturnType<typeof userSettingsAccessor.get>>);

    vi.mocked(workspaceAccessor.findWithPRsForRatchet).mockResolvedValue([
      {
        id: 'ws-1',
        prUrl: 'https://github.com/example/repo/pull/1',
        prNumber: 1,
        ratchetEnabled: true,
        ratchetState: RatchetState.IDLE,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        ratchetLastNotifiedState: null,
        prReviewLastCheckedAt: null,
      },
    ]);

    const processWorkspaceSpy = vi
      .spyOn(
        ratchetService as unknown as { processWorkspace: (...args: unknown[]) => unknown },
        'processWorkspace'
      )
      .mockResolvedValue({
        workspaceId: 'ws-1',
        previousState: RatchetState.IDLE,
        newState: RatchetState.IDLE,
        action: { type: 'WAITING', reason: 'noop' },
      });

    const result = await ratchetService.checkAllWorkspaces();

    expect(processWorkspaceSpy).toHaveBeenCalledTimes(1);
    expect(result.checked).toBe(1);
  });

  it('does not execute ratchet actions when workspace ratcheting is off', async () => {
    const workspace = {
      id: 'ws-2',
      prUrl: 'https://github.com/example/repo/pull/2',
      prNumber: 2,
      ratchetEnabled: false,
      ratchetState: RatchetState.IDLE,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: null,
      ratchetLastNotifiedState: null,
      prReviewLastCheckedAt: null,
    };

    const prStateInfo = {
      ciStatus: 'FAILURE',
      mergeStateStatus: 'CLEAN',
      hasChangesRequested: false,
      hasNewReviewComments: false,
      failedChecks: [],
      ciRunId: '1001',
      reviews: [],
      comments: [],
      reviewComments: [],
      newReviewComments: [],
      newPRComments: [],
      prState: 'OPEN',
      prNumber: 2,
    };

    vi.spyOn(
      ratchetService as unknown as { fetchPRState: (...args: unknown[]) => unknown },
      'fetchPRState'
    ).mockResolvedValue(prStateInfo);

    vi.spyOn(
      ratchetService as unknown as { determineRatchetState: (...args: unknown[]) => RatchetState },
      'determineRatchetState'
    ).mockReturnValue(RatchetState.CI_FAILED);

    const executeRatchetActionSpy = vi.spyOn(
      ratchetService as unknown as { executeRatchetAction: (...args: unknown[]) => unknown },
      'executeRatchetAction'
    );

    vi.mocked(workspaceAccessor.findById).mockResolvedValue({
      ratchetEnabled: false,
    } as never);
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

    const result = await (
      ratchetService as unknown as {
        processWorkspace: (workspaceArg: typeof workspace, settings: unknown) => Promise<unknown>;
      }
    ).processWorkspace(workspace, {
      autoFixCi: true,
      autoFixConflicts: true,
      autoFixReviews: true,
      autoMerge: false,
      allowedReviewers: [],
    });

    expect(executeRatchetActionSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: { type: 'DISABLED', reason: 'Workspace ratcheting disabled' },
      previousState: RatchetState.IDLE,
      newState: RatchetState.IDLE,
    });
    expect(workspaceAccessor.update).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({ ratchetState: RatchetState.IDLE })
    );
  });

  it('does not execute ratchet actions when ratcheting is disabled mid-check', async () => {
    const workspace = {
      id: 'ws-3',
      prUrl: 'https://github.com/example/repo/pull/3',
      prNumber: 3,
      ratchetEnabled: true,
      ratchetState: RatchetState.IDLE,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: null,
      ratchetLastNotifiedState: null,
      prReviewLastCheckedAt: null,
    };

    const prStateInfo = {
      ciStatus: 'FAILURE',
      mergeStateStatus: 'CLEAN',
      hasChangesRequested: false,
      hasNewReviewComments: false,
      failedChecks: [],
      ciRunId: '1002',
      reviews: [],
      comments: [],
      reviewComments: [],
      newReviewComments: [],
      newPRComments: [],
      prState: 'OPEN',
      prNumber: 3,
    };

    vi.spyOn(
      ratchetService as unknown as { fetchPRState: (...args: unknown[]) => unknown },
      'fetchPRState'
    ).mockResolvedValue(prStateInfo);

    vi.spyOn(
      ratchetService as unknown as { determineRatchetState: (...args: unknown[]) => RatchetState },
      'determineRatchetState'
    ).mockReturnValue(RatchetState.CI_FAILED);

    const executeRatchetActionSpy = vi.spyOn(
      ratchetService as unknown as { executeRatchetAction: (...args: unknown[]) => unknown },
      'executeRatchetAction'
    );

    vi.mocked(workspaceAccessor.findById).mockResolvedValue({
      ratchetEnabled: false,
    } as never);
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

    const result = await (
      ratchetService as unknown as {
        processWorkspace: (workspaceArg: typeof workspace, settings: unknown) => Promise<unknown>;
      }
    ).processWorkspace(workspace, {
      autoFixCi: true,
      autoFixConflicts: true,
      autoFixReviews: true,
      autoMerge: false,
      allowedReviewers: [],
    });

    expect(executeRatchetActionSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: { type: 'DISABLED', reason: 'Workspace ratcheting disabled' },
      newState: RatchetState.IDLE,
    });
    expect(workspaceAccessor.update).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({ ratchetState: RatchetState.IDLE })
    );
  });
});

describe('Ratchet CI regression behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats CI UNKNOWN as CI_RUNNING', () => {
    const state = (
      ratchetService as unknown as {
        determineRatchetState: (pr: unknown) => RatchetState;
      }
    ).determineRatchetState({
      ciStatus: CIStatus.UNKNOWN,
      mergeStateStatus: 'CLEAN',
      hasChangesRequested: false,
      hasNewReviewComments: false,
      failedChecks: [],
      ciRunId: null,
      reviews: [],
      comments: [],
      reviewComments: [],
      newReviewComments: [],
      newPRComments: [],
      prState: 'OPEN',
      prNumber: 12,
    });

    expect(state).toBe(RatchetState.CI_RUNNING);
  });

  it('re-triggers fixer when active session is unreachable and CI fails', async () => {
    const workspace = {
      id: 'ws-unreachable',
      prUrl: 'https://github.com/example/repo/pull/55',
      prNumber: 55,
      ratchetEnabled: true,
      ratchetState: RatchetState.REVIEW_PENDING,
      ratchetActiveSessionId: 'session-stale',
      ratchetLastCiRunId: '2001',
      ratchetLastNotifiedState: RatchetState.CI_FAILED,
      prReviewLastCheckedAt: null,
    };

    vi.mocked(claudeSessionAccessor.findById).mockResolvedValue({
      id: 'session-stale',
      status: SessionStatus.RUNNING,
    } as never);
    vi.mocked(sessionService.getClient).mockReturnValue(undefined);
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

    const triggerFixerSpy = vi
      .spyOn(
        ratchetService as unknown as { triggerFixer: (...args: unknown[]) => Promise<unknown> },
        'triggerFixer'
      )
      .mockResolvedValue({
        type: 'TRIGGERED_FIXER',
        sessionId: 'new-fixer',
        fixerType: 'ci',
        promptSent: true,
      });

    const result = await (
      ratchetService as unknown as {
        executeRatchetAction: (
          workspaceArg: typeof workspace,
          state: RatchetState,
          prStateInfo: unknown,
          settings: unknown
        ) => Promise<unknown>;
      }
    ).executeRatchetAction(
      workspace,
      RatchetState.CI_FAILED,
      {
        ciStatus: CIStatus.FAILURE,
        mergeStateStatus: 'CLEAN',
        hasChangesRequested: false,
        hasNewReviewComments: false,
        failedChecks: [],
        ciRunId: '3001',
        reviews: [],
        comments: [],
        reviewComments: [],
        newReviewComments: [],
        newPRComments: [],
        prState: 'OPEN',
        prNumber: 55,
      },
      {
        autoFixCi: true,
        autoFixConflicts: true,
        autoFixReviews: true,
        autoMerge: false,
        allowedReviewers: [],
      }
    );

    expect(triggerFixerSpy).toHaveBeenCalledTimes(1);
    expect(workspaceAccessor.update).toHaveBeenCalledWith(workspace.id, {
      ratchetActiveSessionId: null,
    });
    expect(result).toEqual({
      type: 'TRIGGERED_FIXER',
      sessionId: 'new-fixer',
      fixerType: 'ci',
      promptSent: true,
    });
  });

  it('notifies on a new CI run even when state is already CI_FAILED', () => {
    const shouldNotify = (
      ratchetService as unknown as {
        shouldNotifyActiveFixer: (
          currentState: RatchetState,
          lastNotifiedState: RatchetState | null,
          currentCiRunId: string | null,
          lastCiRunId: string | null
        ) => boolean;
      }
    ).shouldNotifyActiveFixer(RatchetState.CI_FAILED, RatchetState.CI_FAILED, '4002', '4001');

    expect(shouldNotify).toBe(true);
  });

  it('does not consume CI run id when ratcheting is disabled', async () => {
    const workspace = {
      id: 'ws-disabled',
      prUrl: 'https://github.com/example/repo/pull/77',
      prNumber: 77,
      ratchetEnabled: true,
      ratchetState: RatchetState.IDLE,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: null,
      ratchetLastNotifiedState: null,
      prReviewLastCheckedAt: null,
    };

    vi.spyOn(
      ratchetService as unknown as { fetchPRState: (...args: unknown[]) => unknown },
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.FAILURE,
      mergeStateStatus: 'CLEAN',
      hasChangesRequested: false,
      hasNewReviewComments: false,
      failedChecks: [],
      ciRunId: '5001',
      reviews: [],
      comments: [],
      reviewComments: [],
      newReviewComments: [],
      newPRComments: [],
      prState: 'OPEN',
      prNumber: 77,
    });

    vi.spyOn(
      ratchetService as unknown as { determineRatchetState: (...args: unknown[]) => RatchetState },
      'determineRatchetState'
    ).mockReturnValue(RatchetState.CI_FAILED);

    vi.mocked(workspaceAccessor.findById).mockResolvedValue({ ratchetEnabled: false } as never);
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

    await (
      ratchetService as unknown as {
        processWorkspace: (workspaceArg: typeof workspace, settings: unknown) => Promise<unknown>;
      }
    ).processWorkspace(workspace, {
      autoFixCi: true,
      autoFixConflicts: true,
      autoFixReviews: true,
      autoMerge: false,
      allowedReviewers: [],
    });

    const updateCalls = vi.mocked(workspaceAccessor.update).mock.calls;
    const finalUpdatePayload = updateCalls[updateCalls.length - 1]?.[1] as Record<string, unknown>;
    expect(finalUpdatePayload).not.toHaveProperty('ratchetLastCiRunId');
  });

  it('returns run id "0" when parsed from details url', () => {
    const signature = (
      ratchetService as unknown as {
        extractFailedCiSignature: (
          failedChecks: Array<{
            name: string;
            conclusion: string;
            detailsUrl?: string;
          }>
        ) => string | null;
      }
    ).extractFailedCiSignature([
      {
        name: 'unit-tests',
        conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/acme/repo/actions/runs/0',
      },
      {
        name: 'lint',
        conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/acme/repo/actions/runs/42',
      },
    ]);

    expect(signature).toBe('lint:42|unit-tests:0');
  });

  it('clears stale active session linkage when IDLE session has no client', async () => {
    const workspace = {
      id: 'ws-idle',
      prUrl: 'https://github.com/example/repo/pull/88',
      prNumber: 88,
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_FAILED,
      ratchetActiveSessionId: 'session-idle',
      ratchetLastCiRunId: 'sig-old',
      ratchetLastNotifiedState: RatchetState.CI_FAILED,
      prReviewLastCheckedAt: null,
    };

    vi.mocked(claudeSessionAccessor.findById).mockResolvedValue({
      id: 'session-idle',
      status: SessionStatus.IDLE,
    } as never);
    vi.mocked(sessionService.getClient).mockReturnValue(undefined);
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

    const triggerFixerSpy = vi
      .spyOn(
        ratchetService as unknown as { triggerFixer: (...args: unknown[]) => Promise<unknown> },
        'triggerFixer'
      )
      .mockResolvedValue({
        type: 'TRIGGERED_FIXER',
        sessionId: 'session-idle',
        fixerType: 'ci',
        promptSent: true,
      });

    await (
      ratchetService as unknown as {
        executeRatchetAction: (
          workspaceArg: typeof workspace,
          state: RatchetState,
          prStateInfo: unknown,
          settings: unknown
        ) => Promise<unknown>;
      }
    ).executeRatchetAction(
      workspace,
      RatchetState.CI_FAILED,
      {
        ciStatus: CIStatus.FAILURE,
        mergeStateStatus: 'CLEAN',
        hasChangesRequested: false,
        hasNewReviewComments: false,
        failedChecks: [],
        ciRunId: 'sig-new',
        reviews: [],
        comments: [],
        reviewComments: [],
        newReviewComments: [],
        newPRComments: [],
        prState: 'OPEN',
        prNumber: 88,
      },
      {
        autoFixCi: true,
        autoFixConflicts: true,
        autoFixReviews: true,
        autoMerge: false,
        allowedReviewers: [],
      }
    );

    expect(triggerFixerSpy).toHaveBeenCalledTimes(1);
    expect(workspaceAccessor.update).toHaveBeenCalledWith(workspace.id, {
      ratchetActiveSessionId: null,
    });
  });
});

/**
 * Tests for comment filtering logic used in ratchet service
 */
describe('Ratchet Comment Detection', () => {
  const lastCheckedAt = new Date('2024-01-01T12:00:00Z').getTime();

  describe('New comment detection', () => {
    it('should detect comments created after lastCheckedAt', () => {
      const comment: GitHubComment = {
        id: '1',
        author: { login: 'reviewer1' },
        body: 'New comment',
        createdAt: '2024-01-01T13:00:00Z',
        updatedAt: '2024-01-01T13:00:00Z',
        url: 'https://github.com/test/pr/1',
      };

      const createdTime = new Date(comment.createdAt).getTime();
      const updatedTime = new Date(comment.updatedAt).getTime();
      const isNewOrEdited = createdTime > lastCheckedAt || updatedTime > lastCheckedAt;

      expect(isNewOrEdited).toBe(true);
    });

    it('should not detect comments created before lastCheckedAt', () => {
      const comment: GitHubComment = {
        id: '1',
        author: { login: 'reviewer1' },
        body: 'Old comment',
        createdAt: '2024-01-01T11:00:00Z',
        updatedAt: '2024-01-01T11:00:00Z',
        url: 'https://github.com/test/pr/1',
      };

      const createdTime = new Date(comment.createdAt).getTime();
      const updatedTime = new Date(comment.updatedAt).getTime();
      const isNewOrEdited = createdTime > lastCheckedAt || updatedTime > lastCheckedAt;

      expect(isNewOrEdited).toBe(false);
    });
  });

  describe('Edited comment detection', () => {
    it('should detect comments edited after lastCheckedAt', () => {
      const comment: GitHubComment = {
        id: '1',
        author: { login: 'reviewer1' },
        body: 'Edited comment',
        createdAt: '2024-01-01T11:00:00Z',
        updatedAt: '2024-01-01T13:00:00Z',
        url: 'https://github.com/test/pr/1',
      };

      const createdTime = new Date(comment.createdAt).getTime();
      const updatedTime = new Date(comment.updatedAt).getTime();
      const isNewOrEdited = createdTime > lastCheckedAt || updatedTime > lastCheckedAt;

      expect(isNewOrEdited).toBe(true);
    });

    it('should detect comments with updatedAt exactly equal to lastCheckedAt as not new', () => {
      const comment: GitHubComment = {
        id: '1',
        author: { login: 'reviewer1' },
        body: 'Comment at boundary',
        createdAt: '2024-01-01T11:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        url: 'https://github.com/test/pr/1',
      };

      const createdTime = new Date(comment.createdAt).getTime();
      const updatedTime = new Date(comment.updatedAt).getTime();
      const isNewOrEdited = createdTime > lastCheckedAt || updatedTime > lastCheckedAt;

      expect(isNewOrEdited).toBe(false);
    });

    it('should not detect old unedited comments', () => {
      const comment: GitHubComment = {
        id: '1',
        author: { login: 'reviewer1' },
        body: 'Old unedited comment',
        createdAt: '2024-01-01T10:00:00Z',
        updatedAt: '2024-01-01T10:00:00Z',
        url: 'https://github.com/test/pr/1',
      };

      const createdTime = new Date(comment.createdAt).getTime();
      const updatedTime = new Date(comment.updatedAt).getTime();
      const isNewOrEdited = createdTime > lastCheckedAt || updatedTime > lastCheckedAt;

      expect(isNewOrEdited).toBe(false);
    });
  });

  describe('Reviewer filtering with edited comments', () => {
    it('should apply reviewer filter to edited comments', () => {
      const allowedReviewers = ['reviewer1', 'reviewer2'];
      const filterByReviewer = allowedReviewers.length > 0;

      const comments: GitHubComment[] = [
        {
          id: '1',
          author: { login: 'reviewer1' },
          body: 'Allowed reviewer edit',
          createdAt: '2024-01-01T11:00:00Z',
          updatedAt: '2024-01-01T13:00:00Z',
          url: 'https://github.com/test/pr/1',
        },
        {
          id: '2',
          author: { login: 'reviewer3' },
          body: 'Disallowed reviewer edit',
          createdAt: '2024-01-01T11:00:00Z',
          updatedAt: '2024-01-01T13:00:00Z',
          url: 'https://github.com/test/pr/2',
        },
      ];

      const filteredComments = comments.filter((comment) => {
        const createdTime = new Date(comment.createdAt).getTime();
        const updatedTime = new Date(comment.updatedAt).getTime();
        const isNewOrEdited = createdTime > lastCheckedAt || updatedTime > lastCheckedAt;
        const isAllowedReviewer =
          !filterByReviewer || allowedReviewers.includes(comment.author.login);
        return isNewOrEdited && isAllowedReviewer;
      });

      expect(filteredComments).toHaveLength(1);
      expect(filteredComments[0]!.author.login).toBe('reviewer1');
    });
  });
});
