import { CIStatus, RatchetState } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    findById: vi.fn(),
    findByWorkspaceId: vi.fn(),
  },
}));

vi.mock('./github-cli.service', () => ({
  githubCLIService: {
    extractPRInfo: vi.fn(),
    getPRFullDetails: vi.fn(),
    getReviewComments: vi.fn(),
    computeCIStatus: vi.fn(),
  },
}));

vi.mock('./fixer-session.service', () => ({
  fixerSessionService: {
    acquireAndDispatch: vi.fn(),
  },
}));

vi.mock('./session.service', () => ({
  sessionService: {
    getClient: vi.fn(),
    isSessionRunning: vi.fn(),
    isSessionWorking: vi.fn(),
    startClaudeSession: vi.fn(),
    stopClaudeSession: vi.fn(),
  },
}));

vi.mock('./message-state.service', () => ({
  messageStateService: {
    injectCommittedUserMessage: vi.fn(),
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
import { fixerSessionService } from './fixer-session.service';
import { ratchetService } from './ratchet.service';
import { sessionService } from './session.service';

describe('ratchet service (simplified loop)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (ratchetService as unknown as { isShuttingDown: boolean }).isShuttingDown = false;

    vi.mocked(userSettingsAccessor.get).mockResolvedValue({
      ratchetEnabled: true,
      ratchetAutoFixCi: true,
      ratchetAutoFixReviews: true,
      ratchetAutoMerge: false,
      ratchetAllowedReviewers: null,
    } as Awaited<ReturnType<typeof userSettingsAccessor.get>>);
  });

  it('checks workspaces even when global ratchet default is off', async () => {
    vi.mocked(userSettingsAccessor.get).mockResolvedValue({
      ratchetEnabled: false,
      ratchetAutoFixCi: true,
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
        prReviewLastCheckedAt: null,
      },
    ]);

    vi.spyOn(
      ratchetService as unknown as { processWorkspace: (...args: unknown[]) => Promise<unknown> },
      'processWorkspace'
    ).mockResolvedValue({
      workspaceId: 'ws-1',
      previousState: RatchetState.IDLE,
      newState: RatchetState.IDLE,
      action: { type: 'WAITING', reason: 'noop' },
    });

    const result = await ratchetService.checkAllWorkspaces();
    expect(result.checked).toBe(1);
  });

  it('does not dispatch when workspace ratcheting is disabled', async () => {
    const workspace = {
      id: 'ws-disabled',
      prUrl: 'https://github.com/example/repo/pull/2',
      prNumber: 2,
      ratchetEnabled: false,
      ratchetState: RatchetState.IDLE,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: null,
      prReviewLastCheckedAt: null,
    };

    vi.spyOn(
      ratchetService as unknown as { fetchPRState: (...args: unknown[]) => Promise<unknown> },
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.FAILURE,
      hasChangesRequested: false,
      hasNewReviewComments: false,
      failedChecks: [],
      ciRunId: 'run-1',
      reviews: [],
      comments: [],
      reviewComments: [],
      newReviewComments: [],
      newPRComments: [],
      prState: 'OPEN',
      prNumber: 2,
    });

    vi.mocked(workspaceAccessor.findById).mockResolvedValue({ ratchetEnabled: false } as never);
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

    const triggerSpy = vi.spyOn(
      ratchetService as unknown as { triggerFixer: (...args: unknown[]) => Promise<unknown> },
      'triggerFixer'
    );

    const result = await (
      ratchetService as unknown as {
        processWorkspace: (workspaceArg: typeof workspace, settings: unknown) => Promise<unknown>;
      }
    ).processWorkspace(workspace, {
      autoFixCi: true,
      autoFixReviews: true,
      allowedReviewers: [],
    });

    expect(triggerSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: { type: 'DISABLED', reason: 'Workspace ratcheting disabled' },
      newState: RatchetState.IDLE,
    });
  });

  it('does not dispatch when non-ratchet chat session is active', async () => {
    const workspace = {
      id: 'ws-busy',
      prUrl: 'https://github.com/example/repo/pull/3',
      prNumber: 3,
      ratchetEnabled: true,
      ratchetState: RatchetState.IDLE,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: null,
      prReviewLastCheckedAt: null,
    };

    vi.spyOn(
      ratchetService as unknown as { fetchPRState: (...args: unknown[]) => Promise<unknown> },
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.FAILURE,
      hasChangesRequested: false,
      hasNewReviewComments: false,
      failedChecks: [],
      ciRunId: 'run-2',
      reviews: [],
      comments: [],
      reviewComments: [],
      newReviewComments: [],
      newPRComments: [],
      prState: 'OPEN',
      prNumber: 3,
    });

    vi.mocked(workspaceAccessor.findById).mockResolvedValue({ ratchetEnabled: true } as never);
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([
      {
        id: 'chat-1',
        workflow: 'default-followup',
      },
    ] as never);
    vi.mocked(sessionService.isSessionRunning).mockImplementation(
      (sessionId: string) => sessionId === 'chat-1'
    );

    const triggerSpy = vi.mocked(fixerSessionService.acquireAndDispatch);

    const result = await (
      ratchetService as unknown as {
        processWorkspace: (workspaceArg: typeof workspace, settings: unknown) => Promise<unknown>;
      }
    ).processWorkspace(workspace, {
      autoFixCi: true,
      autoFixReviews: true,
      allowedReviewers: [],
    });

    expect(triggerSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: {
        type: 'WAITING',
        reason: 'Workspace is not idle (active non-ratchet chat session)',
      },
    });
  });

  it('dispatches ratchet fixer for a new CI failure signature', async () => {
    const workspace = {
      id: 'ws-ci',
      prUrl: 'https://github.com/example/repo/pull/4',
      prNumber: 4,
      ratchetEnabled: true,
      ratchetState: RatchetState.IDLE,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: 'old-sig',
      prReviewLastCheckedAt: null,
    };

    vi.spyOn(
      ratchetService as unknown as { fetchPRState: (...args: unknown[]) => Promise<unknown> },
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.FAILURE,
      hasChangesRequested: false,
      hasNewReviewComments: false,
      failedChecks: [],
      ciRunId: 'new-sig',
      reviews: [],
      comments: [],
      reviewComments: [],
      newReviewComments: [],
      newPRComments: [],
      prState: 'OPEN',
      prNumber: 4,
    });

    vi.mocked(workspaceAccessor.findById).mockResolvedValue({ ratchetEnabled: true } as never);
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'started',
      sessionId: 'ratchet-session',
      promptSent: true,
    } as never);

    const result = await (
      ratchetService as unknown as {
        processWorkspace: (workspaceArg: typeof workspace, settings: unknown) => Promise<unknown>;
      }
    ).processWorkspace(workspace, {
      autoFixCi: true,
      autoFixReviews: true,
      allowedReviewers: [],
    });

    expect(result).toMatchObject({
      action: {
        type: 'TRIGGERED_FIXER',
        fixerType: 'ratchet',
      },
    });

    const finalUpdatePayload = vi.mocked(workspaceAccessor.update).mock.calls.at(-1)?.[1] as Record<
      string,
      unknown
    >;
    expect(finalUpdatePayload.ratchetLastCiRunId).toBe('new-sig');
  });

  it('does not dispatch for already handled CI signature', async () => {
    const result = (
      ratchetService as unknown as {
        determineRatchetState: (pr: unknown) => RatchetState;
      }
    ).determineRatchetState({
      ciStatus: CIStatus.FAILURE,
      hasChangesRequested: false,
      hasNewReviewComments: false,
      prState: 'OPEN',
    });

    expect(result).toBe(RatchetState.CI_FAILED);

    const workspace = {
      id: 'ws-ci-dup',
      prUrl: 'https://github.com/example/repo/pull/5',
      prNumber: 5,
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_FAILED,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: 'same-sig',
      prReviewLastCheckedAt: null,
    };

    vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);

    const action = await (
      ratchetService as unknown as {
        evaluateAndDispatch: (
          workspaceArg: typeof workspace,
          prState: unknown,
          settings: unknown
        ) => Promise<unknown>;
      }
    ).evaluateAndDispatch(
      workspace,
      {
        ciStatus: CIStatus.FAILURE,
        hasChangesRequested: false,
        hasNewReviewComments: false,
        failedChecks: [],
        ciRunId: 'same-sig',
        reviews: [],
        comments: [],
        reviewComments: [],
        newReviewComments: [],
        newPRComments: [],
        prState: 'OPEN',
        prNumber: 5,
      },
      {
        autoFixCi: true,
        autoFixReviews: true,
        allowedReviewers: [],
      }
    );

    expect(action).toEqual({
      type: 'WAITING',
      reason: 'No actionable CI failures or review activity',
    });
  });

  it('treats closed PR as IDLE state and does not dispatch', async () => {
    const state = (
      ratchetService as unknown as {
        determineRatchetState: (pr: unknown) => RatchetState;
      }
    ).determineRatchetState({
      ciStatus: CIStatus.SUCCESS,
      hasChangesRequested: false,
      hasNewReviewComments: false,
      prState: 'CLOSED',
    });

    expect(state).toBe(RatchetState.IDLE);

    const action = await (
      ratchetService as unknown as {
        evaluateAndDispatch: (
          workspace: unknown,
          pr: unknown,
          settings: unknown
        ) => Promise<unknown>;
      }
    ).evaluateAndDispatch(
      {
        id: 'ws-closed',
        prUrl: 'https://github.com/example/repo/pull/7',
        prNumber: 7,
        ratchetEnabled: true,
        ratchetState: RatchetState.IDLE,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
      },
      {
        ciStatus: CIStatus.SUCCESS,
        hasChangesRequested: false,
        hasNewReviewComments: false,
        failedChecks: [],
        ciRunId: null,
        reviews: [],
        comments: [],
        reviewComments: [],
        newReviewComments: [],
        newPRComments: [],
        prState: 'CLOSED',
        prNumber: 7,
      },
      {
        autoFixCi: true,
        autoFixReviews: true,
        allowedReviewers: [],
      }
    );

    expect(action).toEqual({ type: 'WAITING', reason: 'PR is not open' });
  });

  it('only advances review cursor after a successful dispatch', async () => {
    const workspace = {
      id: 'ws-review',
      prUrl: 'https://github.com/example/repo/pull/8',
      prNumber: 8,
      ratchetEnabled: true,
      ratchetState: RatchetState.IDLE,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: null,
      prReviewLastCheckedAt: null,
    };

    vi.spyOn(
      ratchetService as unknown as { fetchPRState: (...args: unknown[]) => Promise<unknown> },
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.SUCCESS,
      hasChangesRequested: false,
      hasNewReviewComments: true,
      failedChecks: [],
      ciRunId: null,
      reviews: [],
      comments: [],
      reviewComments: [],
      newReviewComments: [
        {
          id: 1,
          author: { login: 'reviewer' },
          body: 'please fix',
          path: 'a.ts',
          line: 1,
          createdAt: '2026-01-01T00:00:00Z',
          url: 'https://example.com',
        },
      ],
      newPRComments: [],
      prState: 'OPEN',
      prNumber: 8,
    });

    vi.mocked(workspaceAccessor.findById).mockResolvedValue({ ratchetEnabled: true } as never);
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);

    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'started',
      sessionId: 'ratchet-session',
      promptSent: false,
    } as never);
    vi.mocked(sessionService.isSessionRunning).mockReturnValue(true);
    vi.mocked(sessionService.stopClaudeSession).mockResolvedValue();

    await (
      ratchetService as unknown as {
        processWorkspace: (workspaceArg: typeof workspace, settings: unknown) => Promise<unknown>;
      }
    ).processWorkspace(workspace, {
      autoFixCi: true,
      autoFixReviews: true,
      allowedReviewers: [],
    });

    const finalUpdatePayload = vi.mocked(workspaceAccessor.update).mock.calls.at(-1)?.[1] as Record<
      string,
      unknown
    >;
    expect(finalUpdatePayload).not.toHaveProperty('prReviewLastCheckedAt');
    expect(workspaceAccessor.update).toHaveBeenCalledWith(workspace.id, {
      ratchetActiveSessionId: null,
    });
    expect(sessionService.stopClaudeSession).toHaveBeenCalledWith('ratchet-session');
  });
});
