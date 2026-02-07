import { CIStatus, RatchetState, SessionStatus } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findWithPRsForRatchet: vi.fn(),
    findForRatchetById: vi.fn(),
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
    getAuthenticatedUsername: vi.fn(),
  },
}));

vi.mock('./fixer-session.service', () => ({
  fixerSessionService: {
    acquireAndDispatch: vi.fn(),
  },
}));

vi.mock('./session.service', () => ({
  sessionService: {
    isSessionRunning: vi.fn(),
    isSessionWorking: vi.fn(),
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
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { fixerSessionService } from './fixer-session.service';
import { githubCLIService } from './github-cli.service';
import { ratchetService } from './ratchet.service';
import { sessionService } from './session.service';

describe('ratchet service (state-change + idle dispatch)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (ratchetService as unknown as { isShuttingDown: boolean }).isShuttingDown = false;
    vi.mocked(githubCLIService.getAuthenticatedUsername).mockResolvedValue(null);
    vi.mocked(sessionService.isSessionWorking).mockReturnValue(false);
  });

  it('checks workspaces and processes each', async () => {
    vi.mocked(workspaceAccessor.findWithPRsForRatchet).mockResolvedValue([
      {
        id: 'ws-1',
        prUrl: 'https://github.com/example/repo/pull/1',
        prNumber: 1,
        prState: 'OPEN',
        prCiStatus: CIStatus.UNKNOWN,
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
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
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
      snapshotKey: '2026-01-02T00:00:00Z',
      hasChangesRequested: false,
      latestReviewActivityAtMs: null,
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 2,
    });

    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

    const triggerSpy = vi.spyOn(
      ratchetService as unknown as { triggerFixer: (...args: unknown[]) => Promise<unknown> },
      'triggerFixer'
    );

    const result = await (
      ratchetService as unknown as {
        processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
      }
    ).processWorkspace(workspace);

    expect(triggerSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: { type: 'DISABLED', reason: 'Workspace ratcheting disabled' },
      newState: RatchetState.IDLE,
    });
  });

  it('does not dispatch when workspace is not idle', async () => {
    const workspace = {
      id: 'ws-busy',
      prUrl: 'https://github.com/example/repo/pull/3',
      prNumber: 3,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.IDLE,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: null,
      prReviewLastCheckedAt: new Date('2026-01-01T00:00:00Z'),
    };

    vi.spyOn(
      ratchetService as unknown as { fetchPRState: (...args: unknown[]) => Promise<unknown> },
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.SUCCESS,
      snapshotKey: '2026-01-02T00:00:00Z',
      hasChangesRequested: false,
      latestReviewActivityAtMs: new Date('2026-01-02T00:00:00Z').getTime(),
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 3,
    });

    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([
      {
        id: 'chat-1',
        workflow: 'default-followup',
        status: 'RUNNING',
      },
    ] as never);
    vi.mocked(sessionService.isSessionWorking).mockReturnValue(true);

    const result = await (
      ratchetService as unknown as {
        processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
      }
    ).processWorkspace(workspace);

    expect(result).toMatchObject({
      action: {
        type: 'WAITING',
        reason: 'Workspace is not idle (active non-ratchet chat session)',
      },
    });
  });

  it('dispatches when PR state changed since last ratchet', async () => {
    const workspace = {
      id: 'ws-change',
      prUrl: 'https://github.com/example/repo/pull/4',
      prNumber: 4,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.IDLE,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: '2026-01-01T00:00:00Z',
      prReviewLastCheckedAt: new Date('2026-01-01T00:00:00Z'),
    };

    vi.spyOn(
      ratchetService as unknown as { fetchPRState: (...args: unknown[]) => Promise<unknown> },
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.FAILURE,
      snapshotKey: '2026-01-02T00:00:00Z',
      hasChangesRequested: false,
      latestReviewActivityAtMs: null,
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 4,
    });

    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'started',
      sessionId: 'ratchet-session',
      promptSent: true,
    } as never);

    const result = await (
      ratchetService as unknown as {
        processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
      }
    ).processWorkspace(workspace);

    expect(result).toMatchObject({
      action: { type: 'TRIGGERED_FIXER' },
    });

    const finalUpdatePayload = vi.mocked(workspaceAccessor.update).mock.calls.at(-1)?.[1] as Record<
      string,
      unknown
    >;
    expect(finalUpdatePayload.ratchetLastCiRunId).toBe('2026-01-02T00:00:00Z');
    expect(finalUpdatePayload).toHaveProperty('prReviewLastCheckedAt');
  });

  it('does dispatch when non-ratchet session is running but idle', async () => {
    const workspace = {
      id: 'ws-idle-session',
      prUrl: 'https://github.com/example/repo/pull/44',
      prNumber: 44,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.IDLE,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: '2026-01-01T00:00:00Z',
      prReviewLastCheckedAt: new Date('2026-01-01T00:00:00Z'),
    };

    vi.spyOn(
      ratchetService as unknown as { fetchPRState: (...args: unknown[]) => Promise<unknown> },
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.FAILURE,
      snapshotKey: '2026-01-02T00:00:00Z',
      hasChangesRequested: false,
      latestReviewActivityAtMs: null,
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 44,
    });

    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([
      {
        id: 'chat-idle-1',
        workflow: 'default-followup',
        status: 'RUNNING',
      },
    ] as never);
    vi.mocked(sessionService.isSessionWorking).mockReturnValue(false);

    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'started',
      sessionId: 'ratchet-session-idle-ok',
      promptSent: true,
    } as never);

    const result = await (
      ratchetService as unknown as {
        processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
      }
    ).processWorkspace(workspace);

    expect(result).toMatchObject({
      action: { type: 'TRIGGERED_FIXER', sessionId: 'ratchet-session-idle-ok' },
    });
  });

  it('does not dispatch when PR state unchanged since last dispatch', async () => {
    const workspace = {
      id: 'ws-unchanged',
      prUrl: 'https://github.com/example/repo/pull/5',
      prNumber: 5,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.READY,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: '2026-01-02T00:00:00Z',
      prReviewLastCheckedAt: new Date('2026-01-02T00:00:00Z'),
    };

    vi.spyOn(
      ratchetService as unknown as {
        fetchPRState: (...args: unknown[]) => Promise<unknown>;
      },
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.FAILURE,
      snapshotKey: '2026-01-02T00:00:00Z',
      hasChangesRequested: false,
      latestReviewActivityAtMs: null,
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 5,
    });
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);

    const result = await (
      ratchetService as unknown as {
        processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
      }
    ).processWorkspace(workspace);

    expect(result).toMatchObject({
      action: {
        type: 'WAITING',
        reason: 'PR state unchanged since last ratchet dispatch',
      },
    });
    expect(claudeSessionAccessor.findByWorkspaceId).not.toHaveBeenCalled();
  });

  it('does not dispatch repeatedly for unchanged CHANGES_REQUESTED state', async () => {
    const workspace = {
      id: 'ws-review-unchanged',
      prUrl: 'https://github.com/example/repo/pull/55',
      prNumber: 55,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.REVIEW_PENDING,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: 'ci:SUCCESS|changes-requested:1735776000000',
      prReviewLastCheckedAt: new Date('2026-01-02T00:00:00Z'),
    };

    vi.spyOn(
      ratchetService as unknown as {
        fetchPRState: (...args: unknown[]) => Promise<unknown>;
      },
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.SUCCESS,
      snapshotKey: 'ci:SUCCESS|changes-requested:1735776000000',
      hasChangesRequested: true,
      latestReviewActivityAtMs: new Date('2026-01-02T00:00:00Z').getTime(),
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 55,
    });
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
    const triggerSpy = vi.spyOn(
      ratchetService as unknown as { triggerFixer: (...args: unknown[]) => Promise<unknown> },
      'triggerFixer'
    );

    const result = await (
      ratchetService as unknown as {
        processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
      }
    ).processWorkspace(workspace);

    expect(triggerSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: {
        type: 'WAITING',
        reason: 'PR state unchanged since last ratchet dispatch',
      },
    });
    expect(claudeSessionAccessor.findByWorkspaceId).not.toHaveBeenCalled();
  });

  it('treats closed PR as IDLE and does not dispatch', () => {
    const state = (
      ratchetService as unknown as {
        determineRatchetState: (pr: unknown) => RatchetState;
      }
    ).determineRatchetState({
      ciStatus: CIStatus.SUCCESS,
      snapshotKey: '2026-01-02T00:00:00Z',
      hasChangesRequested: false,
      latestReviewActivityAtMs: null,
      prState: 'CLOSED',
      prNumber: 6,
    });

    expect(state).toBe(RatchetState.IDLE);
  });

  it('handles prompt delivery failure by clearing active session and stopping runner', async () => {
    const workspace = {
      id: 'ws-prompt-fail',
      prUrl: 'https://github.com/example/repo/pull/7',
      prNumber: 7,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
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
      snapshotKey: '2026-01-02T00:00:00Z',
      hasChangesRequested: true,
      latestReviewActivityAtMs: new Date('2026-01-02T00:00:00Z').getTime(),
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 7,
    });

    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'started',
      sessionId: 'ratchet-session',
      promptSent: false,
    } as never);
    vi.mocked(sessionService.isSessionRunning).mockReturnValue(true);
    vi.mocked(sessionService.stopClaudeSession).mockResolvedValue();

    const result = await (
      ratchetService as unknown as {
        processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
      }
    ).processWorkspace(workspace);

    expect(result).toMatchObject({
      action: { type: 'ERROR', error: 'Failed to deliver initial ratchet prompt' },
    });
    expect(workspaceAccessor.update).toHaveBeenCalledWith(workspace.id, {
      ratchetActiveSessionId: null,
    });
    expect(sessionService.stopClaudeSession).toHaveBeenCalledWith('ratchet-session');
  });

  it('does not dispatch on a clean PR with no new review activity', async () => {
    const workspace = {
      id: 'ws-clean',
      prUrl: 'https://github.com/example/repo/pull/8',
      prNumber: 8,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.READY,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: '2026-01-01T00:00:00Z',
      prReviewLastCheckedAt: new Date('2026-01-02T00:00:00Z'),
    };

    vi.spyOn(
      ratchetService as unknown as {
        fetchPRState: (...args: unknown[]) => Promise<unknown>;
      },
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.SUCCESS,
      snapshotKey: '2026-01-03T00:00:00Z',
      hasChangesRequested: false,
      latestReviewActivityAtMs: new Date('2026-01-02T00:00:00Z').getTime(),
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 8,
    });
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(claudeSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
    const triggerSpy = vi.spyOn(
      ratchetService as unknown as { triggerFixer: (...args: unknown[]) => Promise<unknown> },
      'triggerFixer'
    );

    const result = await (
      ratchetService as unknown as {
        processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
      }
    ).processWorkspace(workspace);

    expect(triggerSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: {
        type: 'WAITING',
        reason: 'PR is clean (green CI and no new review activity)',
      },
    });
  });

  it('clears active ratchet session immediately when runtime is not running', async () => {
    const workspace = {
      id: 'ws-stale-active',
      prUrl: 'https://github.com/example/repo/pull/9',
      prNumber: 9,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_FAILED,
      ratchetActiveSessionId: 'ratchet-session',
      ratchetLastCiRunId: null,
      prReviewLastCheckedAt: null,
    };

    vi.mocked(claudeSessionAccessor.findById).mockResolvedValue({
      id: 'ratchet-session',
      status: SessionStatus.RUNNING,
    } as never);
    vi.mocked(sessionService.isSessionRunning).mockReturnValue(false);
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

    const action = await (
      ratchetService as unknown as {
        getActiveRatchetSession: (workspaceArg: typeof workspace) => Promise<unknown>;
      }
    ).getActiveRatchetSession(workspace);

    expect(action).toBeNull();
    expect(workspaceAccessor.update).toHaveBeenCalledWith(workspace.id, {
      ratchetActiveSessionId: null,
    });
  });

  it('decides to trigger fixer when context is actionable', () => {
    const decision = (
      ratchetService as unknown as {
        decideRatchetAction: (context: unknown) => { type: string };
      }
    ).decideRatchetAction({
      workspace: { ratchetEnabled: true },
      prStateInfo: { prState: 'OPEN' },
      isCleanPrWithNoNewReviewActivity: false,
      activeRatchetSession: null,
      hasStateChangedSinceLastDispatch: true,
      hasOtherActiveSession: false,
    });

    expect(decision).toEqual({ type: 'TRIGGER_FIXER' });
  });

  it('prefers precomputed review-activity diagnostics from decision context', () => {
    const workspace = {
      id: 'ws-log-diag',
      prUrl: 'https://github.com/example/repo/pull/10',
      prNumber: 10,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.READY,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: 'prev-snapshot',
      prReviewLastCheckedAt: null,
    };

    const prStateInfo = {
      ciStatus: CIStatus.SUCCESS,
      snapshotKey: 'next-snapshot',
      hasChangesRequested: false,
      latestReviewActivityAtMs: null,
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 10,
    };

    const logContext = (
      ratchetService as unknown as {
        buildRatchetingLogContext: (
          workspaceArg: typeof workspace,
          previousState: RatchetState,
          newState: RatchetState,
          action: { type: 'WAITING'; reason: string },
          prStateInfoArg: typeof prStateInfo,
          prNumber: number,
          decisionContext: { hasNewReviewActivitySinceLastDispatch: boolean }
        ) => { reviewTimestampComparison: { hasNewReviewActivitySinceLastDispatch: boolean } };
      }
    ).buildRatchetingLogContext(
      workspace,
      RatchetState.READY,
      RatchetState.READY,
      { type: 'WAITING', reason: 'noop' },
      prStateInfo,
      10,
      { hasNewReviewActivitySinceLastDispatch: true }
    );

    expect(logContext.reviewTimestampComparison.hasNewReviewActivitySinceLastDispatch).toBe(true);
  });

  it('ignores review activity authored by the authenticated user', () => {
    const latestActivity = (
      ratchetService as unknown as {
        computeLatestReviewActivityAtMs: (
          prDetails: {
            reviews: Array<{ submittedAt: string; author: { login: string } }>;
            comments: Array<{ updatedAt: string; author: { login: string } }>;
          },
          reviewComments: Array<{ updatedAt: string; author: { login: string } }>,
          authenticatedUsername: string | null
        ) => number | null;
      }
    ).computeLatestReviewActivityAtMs(
      {
        reviews: [
          { submittedAt: '2026-01-02T00:00:00Z', author: { login: 'ratchet-bot' } },
          { submittedAt: '2026-01-01T00:00:00Z', author: { login: 'reviewer' } },
        ],
        comments: [{ updatedAt: '2026-01-02T01:00:00Z', author: { login: 'ratchet-bot' } }],
      },
      [{ updatedAt: '2026-01-01T02:00:00Z', author: { login: 'reviewer2' } }],
      'ratchet-bot'
    );

    expect(latestActivity).toBe(new Date('2026-01-01T02:00:00Z').getTime());
  });
});
