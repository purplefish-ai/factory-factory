import { RatchetState } from '@prisma-gen/client';
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

import { userSettingsAccessor } from '../resource_accessors/user-settings.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { ratchetService } from './ratchet.service';

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
        ratchetLastNotifiedState: null,
        prReviewLastCheckedAt: null,
        ratchetCiGreenAt: null,
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
      ratchetLastNotifiedState: null,
      prReviewLastCheckedAt: null,
      ratchetCiGreenAt: null,
    };

    const prStateInfo = {
      ciStatus: 'FAILURE',
      mergeStateStatus: 'CLEAN',
      hasChangesRequested: false,
      hasNewReviewComments: false,
      failedChecks: [],
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
      ratchetLastNotifiedState: null,
      prReviewLastCheckedAt: null,
      ratchetCiGreenAt: null,
    };

    const prStateInfo = {
      ciStatus: 'FAILURE',
      mergeStateStatus: 'CLEAN',
      hasChangesRequested: false,
      hasNewReviewComments: false,
      failedChecks: [],
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
      expect(filteredComments[0].author.login).toBe('reviewer1');
    });
  });

  describe('CI green grace period', () => {
    const greenPrStateInfo = {
      ciStatus: 'SUCCESS' as const,
      mergeStateStatus: 'CLEAN',
      hasChangesRequested: false,
      hasNewReviewComments: false,
      failedChecks: [],
      reviews: [],
      comments: [],
      reviewComments: [],
      newReviewComments: [],
      newPRComments: [],
      prState: 'OPEN',
      prNumber: 100,
    };

    const makeWorkspace = (overrides = {}) => ({
      id: 'ws-grace',
      prUrl: 'https://github.com/example/repo/pull/100',
      prNumber: 100,
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_RUNNING,
      ratchetActiveSessionId: null,
      ratchetLastNotifiedState: null,
      prReviewLastCheckedAt: null,
      ratchetCiGreenAt: null as Date | null,
      ...overrides,
    });

    const settings = {
      autoFixCi: true,
      autoFixConflicts: true,
      autoFixReviews: true,
      autoMerge: false,
      allowedReviewers: [],
    };

    it('applies grace period on first CI green check (ratchetCiGreenAt is null)', async () => {
      const workspace = makeWorkspace({ ratchetCiGreenAt: null });

      vi.spyOn(
        ratchetService as unknown as { fetchPRState: (...args: unknown[]) => unknown },
        'fetchPRState'
      ).mockResolvedValue(greenPrStateInfo);

      vi.mocked(workspaceAccessor.findById).mockResolvedValue({
        ratchetEnabled: true,
      } as never);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

      const result = await (
        ratchetService as unknown as {
          processWorkspace: (ws: typeof workspace, s: typeof settings) => Promise<unknown>;
        }
      ).processWorkspace(workspace, settings);

      expect(result).toMatchObject({
        newState: RatchetState.CI_RUNNING,
      });
    });

    it('stays in CI_RUNNING within grace period when ratchetCiGreenAt is recent', async () => {
      const workspace = makeWorkspace({
        ratchetCiGreenAt: new Date(Date.now() - 30_000), // 30s ago
      });

      vi.spyOn(
        ratchetService as unknown as { fetchPRState: (...args: unknown[]) => unknown },
        'fetchPRState'
      ).mockResolvedValue(greenPrStateInfo);

      vi.mocked(workspaceAccessor.findById).mockResolvedValue({
        ratchetEnabled: true,
      } as never);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

      const result = await (
        ratchetService as unknown as {
          processWorkspace: (ws: typeof workspace, s: typeof settings) => Promise<unknown>;
        }
      ).processWorkspace(workspace, settings);

      expect(result).toMatchObject({
        newState: RatchetState.CI_RUNNING,
      });
    });

    it('moves to READY after grace period expires', async () => {
      const workspace = makeWorkspace({
        ratchetCiGreenAt: new Date(Date.now() - 70_000), // 70s ago
      });

      vi.spyOn(
        ratchetService as unknown as { fetchPRState: (...args: unknown[]) => unknown },
        'fetchPRState'
      ).mockResolvedValue(greenPrStateInfo);

      vi.mocked(workspaceAccessor.findById).mockResolvedValue({
        ratchetEnabled: true,
      } as never);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

      const result = await (
        ratchetService as unknown as {
          processWorkspace: (ws: typeof workspace, s: typeof settings) => Promise<unknown>;
        }
      ).processWorkspace(workspace, settings);

      expect(result).toMatchObject({
        newState: RatchetState.READY,
      });
    });

    it('does not apply grace period when previous state is already READY', async () => {
      const workspace = makeWorkspace({
        ratchetState: RatchetState.READY,
        ratchetCiGreenAt: new Date(Date.now() - 30_000), // 30s ago, within grace
      });

      vi.spyOn(
        ratchetService as unknown as { fetchPRState: (...args: unknown[]) => unknown },
        'fetchPRState'
      ).mockResolvedValue(greenPrStateInfo);

      vi.mocked(workspaceAccessor.findById).mockResolvedValue({
        ratchetEnabled: true,
      } as never);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

      const result = await (
        ratchetService as unknown as {
          processWorkspace: (ws: typeof workspace, s: typeof settings) => Promise<unknown>;
        }
      ).processWorkspace(workspace, settings);

      // Should NOT regress to CI_RUNNING since previous state was READY
      expect(result).toMatchObject({
        newState: RatchetState.READY,
      });
    });

    it('immediately moves to REVIEW_PENDING if comments exist during grace period', async () => {
      const workspace = makeWorkspace({
        ratchetCiGreenAt: new Date(Date.now() - 30_000), // within grace
      });

      const prWithComments = {
        ...greenPrStateInfo,
        hasNewReviewComments: true,
        newReviewComments: [
          {
            id: 1,
            author: { login: 'reviewer1' },
            body: 'Please fix this',
            path: 'test.ts',
            line: 10,
            createdAt: '2024-01-01T12:00:00Z',
            url: 'https://github.com/test/pr/1',
          },
        ],
      };

      vi.spyOn(
        ratchetService as unknown as { fetchPRState: (...args: unknown[]) => unknown },
        'fetchPRState'
      ).mockResolvedValue(prWithComments);

      vi.mocked(workspaceAccessor.findById).mockResolvedValue({
        ratchetEnabled: true,
      } as never);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

      const result = await (
        ratchetService as unknown as {
          processWorkspace: (ws: typeof workspace, s: typeof settings) => Promise<unknown>;
        }
      ).processWorkspace(workspace, settings);

      expect(result).toMatchObject({
        newState: RatchetState.REVIEW_PENDING,
      });
    });

    it('does not reset ratchetCiGreenAt on subsequent polls during grace period', async () => {
      const existingGreenAt = new Date(Date.now() - 30_000); // 30s ago
      const workspace = makeWorkspace({
        ratchetCiGreenAt: existingGreenAt,
      });

      vi.spyOn(
        ratchetService as unknown as { fetchPRState: (...args: unknown[]) => unknown },
        'fetchPRState'
      ).mockResolvedValue(greenPrStateInfo);

      vi.mocked(workspaceAccessor.findById).mockResolvedValue({
        ratchetEnabled: true,
      } as never);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

      await (
        ratchetService as unknown as {
          processWorkspace: (ws: typeof workspace, s: typeof settings) => Promise<unknown>;
        }
      ).processWorkspace(workspace, settings);

      // ratchetCiGreenAt should NOT be overwritten since it's already set
      const updateCall = vi.mocked(workspaceAccessor.update).mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(updateCall).not.toHaveProperty('ratchetCiGreenAt');
    });
  });
});
