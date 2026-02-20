import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_TIMEOUT_MS } from '@/backend/services/constants';
import { CIStatus, RatchetState, SessionStatus } from '@/shared/core';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { RatchetGitHubBridge, RatchetPRSnapshotBridge, RatchetSessionBridge } from './bridges';

vi.mock('@/backend/resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: vi.fn(),
    findWithPRsForRatchet: vi.fn(),
    findForRatchetById: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('@/backend/resource_accessors/agent-session.accessor', () => ({
  agentSessionAccessor: {
    findById: vi.fn(),
    findByWorkspaceId: vi.fn(),
  },
}));

vi.mock('@/backend/resource_accessors/user-settings.accessor', () => ({
  userSettingsAccessor: {
    get: vi.fn(),
    getDefaultSessionProvider: vi.fn(),
  },
}));

vi.mock('./fixer-session.service', () => ({
  fixerSessionService: {
    acquireAndDispatch: vi.fn(),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { agentSessionAccessor } from '@/backend/resource_accessors/agent-session.accessor';
import { userSettingsAccessor } from '@/backend/resource_accessors/user-settings.accessor';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import { fixerSessionService } from './fixer-session.service';
import {
  RATCHET_STATE_CHANGED,
  RATCHET_TOGGLED,
  type RatchetStateChangedEvent,
  type RatchetToggledEvent,
  ratchetService,
} from './ratchet.service';

const mockSessionBridge: RatchetSessionBridge = {
  isSessionRunning: vi.fn(),
  isSessionWorking: vi.fn(),
  stopSession: vi.fn(),
  startSession: vi.fn(),
  sendSessionMessage: vi.fn(),
  injectCommittedUserMessage: vi.fn(),
};

const mockGitHubBridge: RatchetGitHubBridge = {
  extractPRInfo: vi.fn(),
  getPRFullDetails: vi.fn(),
  getReviewComments: vi.fn(),
  computeCIStatus: vi.fn(),
  getAuthenticatedUsername: vi.fn(),
  fetchAndComputePRState: vi.fn(),
};

const mockSnapshotBridge: RatchetPRSnapshotBridge = {
  recordCIObservation: vi.fn(),
  recordCINotification: vi.fn(),
  recordReviewCheck: vi.fn(),
};

describe('ratchet service (state-change + idle dispatch)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unsafeCoerce<{ isShuttingDown: boolean }>(ratchetService).isShuttingDown = false;
    unsafeCoerce<{ workspaceCheckTimeoutMs: number }>(ratchetService).workspaceCheckTimeoutMs =
      SERVICE_TIMEOUT_MS.ratchetWorkspaceCheck;
    unsafeCoerce<{ reviewPollTrackers: Map<string, unknown> }>(
      ratchetService
    ).reviewPollTrackers.clear();
    ratchetService.configure({
      session: mockSessionBridge,
      github: mockGitHubBridge,
      snapshot: mockSnapshotBridge,
    });
    vi.mocked(mockGitHubBridge.getAuthenticatedUsername).mockResolvedValue(null);
    vi.mocked(mockSessionBridge.isSessionWorking).mockReturnValue(false);
    vi.mocked(userSettingsAccessor.get).mockResolvedValue({
      id: 'settings-1',
      userId: 'default',
      preferredIde: 'cursor',
      customIdeCommand: null,
      playSoundOnComplete: true,
      notificationSoundPath: null,
      workspaceOrder: null,
      cachedSlashCommands: null,
      ratchetEnabled: false,
      defaultSessionProvider: 'CLAUDE',
      defaultWorkspacePermissions: 'STRICT',
      ratchetPermissions: 'YOLO',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    vi.mocked(userSettingsAccessor.getDefaultSessionProvider).mockResolvedValue('CLAUDE');
  });

  it('checks workspaces and processes each', async () => {
    vi.mocked(workspaceAccessor.findWithPRsForRatchet).mockResolvedValue([
      {
        id: 'ws-1',
        prUrl: 'https://github.com/example/repo/pull/1',
        prNumber: 1,
        prState: 'OPEN',
        prCiStatus: CIStatus.UNKNOWN,
        defaultSessionProvider: 'WORKSPACE_DEFAULT',
        ratchetSessionProvider: 'WORKSPACE_DEFAULT',
        ratchetEnabled: true,
        ratchetState: RatchetState.IDLE,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
      },
    ]);

    vi.spyOn(
      unsafeCoerce<{ processWorkspace: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
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

    const fetchPRStateSpy = vi.spyOn(
      unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
      'fetchPRState'
    );

    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

    const triggerSpy = vi.spyOn(
      unsafeCoerce<{ triggerFixer: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
      'triggerFixer'
    );

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(fetchPRStateSpy).not.toHaveBeenCalled();
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
      unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.SUCCESS,
      snapshotKey: '2026-01-02T00:00:00Z',
      hasChangesRequested: false,
      latestReviewActivityAtMs: new Date('2026-01-02T00:00:00Z').getTime(),
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 3,
      reviewComments: [
        {
          author: 'reviewer',
          body: 'Please update this',
          path: 'src/test.ts',
          line: 3,
          url: 'https://github.com/example/repo/pull/3#discussion_r1',
        },
      ],
    });

    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([
      {
        id: 'chat-1',
        workflow: 'default-followup',
        status: 'RUNNING',
      },
    ] as never);
    vi.mocked(mockSessionBridge.isSessionWorking).mockReturnValue(true);

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(result).toMatchObject({
      action: {
        type: 'WAITING',
        reason: 'Workspace is not idle (active session)',
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
      unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
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
    vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'started',
      sessionId: 'ratchet-session',
      promptSent: true,
    } as never);

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(result).toMatchObject({
      action: { type: 'TRIGGERED_FIXER' },
    });

    const finalUpdatePayload = vi.mocked(workspaceAccessor.update).mock.calls.at(-1)?.[1] as Record<
      string,
      unknown
    >;
    expect(finalUpdatePayload.ratchetLastCiRunId).toBe('2026-01-02T00:00:00Z');
    expect(finalUpdatePayload).not.toHaveProperty('prReviewLastCheckedAt');
    expect(mockSnapshotBridge.recordReviewCheck).toHaveBeenCalledWith(
      'ws-change',
      expect.any(Date)
    );
  });

  it('does dispatch when session is running but idle', async () => {
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
      unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
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
    vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([
      {
        id: 'chat-idle-1',
        workflow: 'default-followup',
        status: 'RUNNING',
      },
    ] as never);
    vi.mocked(mockSessionBridge.isSessionWorking).mockReturnValue(false);

    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'started',
      sessionId: 'ratchet-session-idle-ok',
      promptSent: true,
    } as never);

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

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
      unsafeCoerce<{
        fetchPRState: (...args: unknown[]) => Promise<unknown>;
      }>(ratchetService),
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
    vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(result).toMatchObject({
      action: {
        type: 'WAITING',
        reason: 'PR state unchanged since last ratchet dispatch',
      },
    });
    expect(agentSessionAccessor.findByWorkspaceId).not.toHaveBeenCalled();
    expect(mockSnapshotBridge.recordReviewCheck).not.toHaveBeenCalled();
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
      unsafeCoerce<{
        fetchPRState: (...args: unknown[]) => Promise<unknown>;
      }>(ratchetService),
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.SUCCESS,
      snapshotKey: 'ci:SUCCESS|changes-requested:1735776000000',
      hasChangesRequested: true,
      latestReviewActivityAtMs: new Date('2026-01-02T00:00:00Z').getTime(),
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 55,
      reviewComments: [
        {
          author: 'reviewer',
          body: 'Please revise this',
          path: 'src/example.ts',
          line: 9,
          url: 'https://github.com/example/repo/pull/55#discussion_r1',
        },
      ],
    });
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
    const triggerSpy = vi.spyOn(
      unsafeCoerce<{ triggerFixer: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
      'triggerFixer'
    );

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(triggerSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: {
        type: 'WAITING',
        reason: 'PR state unchanged since last ratchet dispatch',
      },
    });
    expect(agentSessionAccessor.findByWorkspaceId).not.toHaveBeenCalled();
  });

  it('does not dispatch for CHANGES_REQUESTED when there are no PR review comments', async () => {
    const workspace = {
      id: 'ws-review-no-comments',
      prUrl: 'https://github.com/example/repo/pull/56',
      prNumber: 56,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.REVIEW_PENDING,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: 'ci:SUCCESS|changes-requested:old',
      prReviewLastCheckedAt: new Date('2026-01-02T00:00:00Z'),
    };

    vi.spyOn(
      unsafeCoerce<{
        fetchPRState: (...args: unknown[]) => Promise<unknown>;
      }>(ratchetService),
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.SUCCESS,
      snapshotKey: 'ci:SUCCESS|changes-requested:new',
      hasChangesRequested: true,
      latestReviewActivityAtMs: new Date('2026-01-03T00:00:00Z').getTime(),
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 56,
      reviewComments: [],
    });
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
    const triggerSpy = vi.spyOn(
      unsafeCoerce<{ triggerFixer: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
      'triggerFixer'
    );

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(triggerSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: {
        type: 'WAITING',
        reason: 'No CI failures or PR review comments to address',
      },
    });
  });

  it('treats closed PR as IDLE and does not dispatch', () => {
    const state = unsafeCoerce<{
      determineRatchetState: (pr: unknown) => RatchetState;
    }>(ratchetService).determineRatchetState({
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
      unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.SUCCESS,
      snapshotKey: '2026-01-02T00:00:00Z',
      hasChangesRequested: true,
      latestReviewActivityAtMs: new Date('2026-01-02T00:00:00Z').getTime(),
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 7,
      reviewComments: [
        {
          author: 'reviewer',
          body: 'Please fix this',
          path: 'src/example.ts',
          line: 12,
          url: 'https://github.com/example/repo/pull/7#discussion_r1',
        },
      ],
    });

    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'started',
      sessionId: 'ratchet-session',
      promptSent: false,
    } as never);
    vi.mocked(mockSessionBridge.isSessionRunning).mockReturnValue(true);
    vi.mocked(mockSessionBridge.stopSession).mockResolvedValue();

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(result).toMatchObject({
      action: { type: 'ERROR', error: 'Failed to deliver initial ratchet prompt' },
    });
    expect(workspaceAccessor.update).toHaveBeenCalledWith(workspace.id, {
      ratchetActiveSessionId: null,
    });
    expect(mockSessionBridge.stopSession).toHaveBeenCalledWith('ratchet-session');
  });

  it('does not dispatch on a clean PR with no new review activity', async () => {
    const recentCheck = new Date(); // Recent check — not stale
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
      prReviewLastCheckedAt: recentCheck,
    };

    vi.spyOn(
      unsafeCoerce<{
        fetchPRState: (...args: unknown[]) => Promise<unknown>;
      }>(ratchetService),
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.SUCCESS,
      snapshotKey: '2026-01-03T00:00:00Z',
      hasChangesRequested: false,
      latestReviewActivityAtMs: recentCheck.getTime() - 1000, // Activity before the check
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 8,
    });
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
    const triggerSpy = vi.spyOn(
      unsafeCoerce<{ triggerFixer: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
      'triggerFixer'
    );

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(triggerSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      action: {
        type: 'WAITING',
        reason: 'PR is clean (green CI and no new review activity)',
      },
    });
  });

  it('self-heals when review check timestamp is stale with no active session', async () => {
    const staleCheckedAt = new Date(Date.now() - 15 * 60_000); // 15 minutes ago
    const workspace = {
      id: 'ws-stale-check',
      prUrl: 'https://github.com/example/repo/pull/13',
      prNumber: 13,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.READY,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: '2026-01-01T00:00:00Z',
      prReviewLastCheckedAt: staleCheckedAt,
    };

    // Review activity is older than the check timestamp, but the check is stale
    // and there's no active session — so the ratchet should treat it as new activity
    vi.spyOn(
      unsafeCoerce<{
        fetchPRState: (...args: unknown[]) => Promise<unknown>;
      }>(ratchetService),
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.SUCCESS,
      snapshotKey: '2026-01-03T00:00:00Z',
      hasChangesRequested: false,
      latestReviewActivityAtMs: staleCheckedAt.getTime() - 1000, // 1s before the check
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 13,
    });
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    // Should NOT be skipped as clean — the stale check should trigger re-evaluation
    expect(result).not.toMatchObject({
      action: {
        type: 'WAITING',
        reason: 'PR is clean (green CI and no new review activity)',
      },
    });
  });

  it('resets dispatch tracking when ratchet session process is not running', async () => {
    const workspace = {
      id: 'ws-stale-active',
      prUrl: 'https://github.com/example/repo/pull/9',
      prNumber: 9,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_FAILED,
      ratchetActiveSessionId: 'ratchet-session',
      ratchetLastCiRunId: 'previous-snapshot-key',
      prReviewLastCheckedAt: new Date('2026-01-01T00:00:00Z'),
    };

    vi.mocked(agentSessionAccessor.findById).mockResolvedValue({
      id: 'ratchet-session',
      provider: 'CLAUDE',
      status: SessionStatus.RUNNING,
    } as never);
    vi.mocked(mockSessionBridge.isSessionRunning).mockReturnValue(false);
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(mockSnapshotBridge.recordReviewCheck).mockResolvedValue();

    const action = await unsafeCoerce<{
      getActiveRatchetSession: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).getActiveRatchetSession(workspace);

    expect(action).toBeNull();
    expect(workspaceAccessor.update).toHaveBeenCalledWith(workspace.id, {
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: null,
    });
    expect(mockSnapshotBridge.recordReviewCheck).toHaveBeenCalledWith(workspace.id, null);
  });

  it('resets dispatch tracking when ratchet session is not found in database', async () => {
    const workspace = {
      id: 'ws-missing-session',
      prUrl: 'https://github.com/example/repo/pull/12',
      prNumber: 12,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_FAILED,
      ratchetActiveSessionId: 'deleted-session',
      ratchetLastCiRunId: 'previous-snapshot-key',
      prReviewLastCheckedAt: new Date('2026-01-01T00:00:00Z'),
    };

    vi.mocked(agentSessionAccessor.findById).mockResolvedValue(null);
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(mockSnapshotBridge.recordReviewCheck).mockResolvedValue();

    const action = await unsafeCoerce<{
      getActiveRatchetSession: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).getActiveRatchetSession(workspace);

    expect(action).toBeNull();
    expect(workspaceAccessor.update).toHaveBeenCalledWith(workspace.id, {
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: null,
    });
    expect(mockSnapshotBridge.recordReviewCheck).toHaveBeenCalledWith(workspace.id, null);
  });

  it('does not reset dispatch tracking when ratchet session completed normally', async () => {
    const workspace = {
      id: 'ws-idle-active',
      prUrl: 'https://github.com/example/repo/pull/11',
      prNumber: 11,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_FAILED,
      ratchetActiveSessionId: 'ratchet-session',
      ratchetLastCiRunId: 'snapshot-key',
      prReviewLastCheckedAt: new Date('2026-01-01T00:00:00Z'),
    };

    vi.mocked(agentSessionAccessor.findById).mockResolvedValue({
      id: 'ratchet-session',
      provider: 'CLAUDE',
      status: SessionStatus.RUNNING,
    } as never);
    vi.mocked(mockSessionBridge.isSessionRunning).mockReturnValue(true);
    vi.mocked(mockSessionBridge.isSessionWorking).mockReturnValue(false);
    vi.mocked(mockSessionBridge.stopSession).mockResolvedValue();
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

    const action = await unsafeCoerce<{
      getActiveRatchetSession: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).getActiveRatchetSession(workspace);

    expect(action).toBeNull();
    expect(workspaceAccessor.update).toHaveBeenCalledWith(workspace.id, {
      ratchetActiveSessionId: null,
    });
    expect(mockSessionBridge.stopSession).toHaveBeenCalledWith('ratchet-session');
    expect(mockSnapshotBridge.recordReviewCheck).not.toHaveBeenCalled();
  });

  it('decides to trigger fixer when context is actionable', () => {
    const decision = unsafeCoerce<{
      decideRatchetAction: (context: unknown) => { type: string };
    }>(ratchetService).decideRatchetAction({
      workspace: { ratchetEnabled: true },
      prStateInfo: { prState: 'OPEN', ciStatus: CIStatus.FAILURE },
      isCleanPrWithNoNewReviewActivity: false,
      activeRatchetSession: null,
      hasStateChangedSinceLastDispatch: true,
      hasOtherActiveSession: false,
    });

    expect(decision).toEqual({ type: 'TRIGGER_FIXER' });
  });

  it('waits when CI is not in terminal state (PENDING)', () => {
    const decision = unsafeCoerce<{
      decideRatchetAction: (context: unknown) => {
        type: string;
        action?: { type: string; reason: string };
      };
    }>(ratchetService).decideRatchetAction({
      workspace: { ratchetEnabled: true },
      prStateInfo: { prState: 'OPEN', ciStatus: CIStatus.PENDING },
      isCleanPrWithNoNewReviewActivity: false,
      activeRatchetSession: null,
      hasStateChangedSinceLastDispatch: true,
      hasOtherActiveSession: false,
    });

    expect(decision).toEqual({
      type: 'RETURN_ACTION',
      action: { type: 'WAITING', reason: 'Waiting for CI to complete (not in terminal state)' },
    });
  });

  it('waits when CI is not in terminal state (UNKNOWN)', () => {
    const decision = unsafeCoerce<{
      decideRatchetAction: (context: unknown) => {
        type: string;
        action?: { type: string; reason: string };
      };
    }>(ratchetService).decideRatchetAction({
      workspace: { ratchetEnabled: true },
      prStateInfo: { prState: 'OPEN', ciStatus: CIStatus.UNKNOWN },
      isCleanPrWithNoNewReviewActivity: false,
      activeRatchetSession: null,
      hasStateChangedSinceLastDispatch: true,
      hasOtherActiveSession: false,
    });

    expect(decision).toEqual({
      type: 'RETURN_ACTION',
      action: { type: 'WAITING', reason: 'Waiting for CI to complete (not in terminal state)' },
    });
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

    const logContext = unsafeCoerce<{
      buildRatchetingLogContext: (
        workspaceArg: typeof workspace,
        previousState: RatchetState,
        newState: RatchetState,
        action: { type: 'WAITING'; reason: string },
        prStateInfoArg: typeof prStateInfo,
        prNumber: number,
        decisionContext: { hasNewReviewActivitySinceLastDispatch: boolean }
      ) => { reviewTimestampComparison: { hasNewReviewActivitySinceLastDispatch: boolean } };
    }>(ratchetService).buildRatchetingLogContext(
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
    const latestActivity = unsafeCoerce<{
      computeLatestReviewActivityAtMs: (
        prDetails: {
          reviews: Array<{ submittedAt: string | null; author: { login: string } }>;
          comments: Array<{ updatedAt: string; author: { login: string } }>;
        },
        reviewComments: Array<{ updatedAt: string; author: { login: string } }>,
        authenticatedUsername: string | null
      ) => number | null;
    }>(ratchetService).computeLatestReviewActivityAtMs(
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

  describe('determineRatchetState', () => {
    const callDetermineRatchetState = (pr: unknown) =>
      unsafeCoerce<{ determineRatchetState: (pr: unknown) => RatchetState }>(
        ratchetService
      ).determineRatchetState(pr);

    it('returns MERGED for merged PR', () => {
      expect(
        callDetermineRatchetState({
          ciStatus: CIStatus.SUCCESS,
          prState: 'MERGED',
          hasChangesRequested: false,
        })
      ).toBe(RatchetState.MERGED);
    });

    it('returns IDLE for closed (non-merged) PR', () => {
      expect(
        callDetermineRatchetState({
          ciStatus: CIStatus.SUCCESS,
          prState: 'CLOSED',
          hasChangesRequested: false,
        })
      ).toBe(RatchetState.IDLE);
    });

    it('returns CI_RUNNING for PENDING CI on open PR', () => {
      expect(
        callDetermineRatchetState({
          ciStatus: CIStatus.PENDING,
          prState: 'OPEN',
          hasChangesRequested: false,
        })
      ).toBe(RatchetState.CI_RUNNING);
    });

    it('returns CI_RUNNING for UNKNOWN CI on open PR', () => {
      expect(
        callDetermineRatchetState({
          ciStatus: CIStatus.UNKNOWN,
          prState: 'OPEN',
          hasChangesRequested: false,
        })
      ).toBe(RatchetState.CI_RUNNING);
    });

    it('returns CI_FAILED for FAILURE CI on open PR', () => {
      expect(
        callDetermineRatchetState({
          ciStatus: CIStatus.FAILURE,
          prState: 'OPEN',
          hasChangesRequested: false,
        })
      ).toBe(RatchetState.CI_FAILED);
    });

    it('returns REVIEW_PENDING when changes requested on open PR with passing CI', () => {
      expect(
        callDetermineRatchetState({
          ciStatus: CIStatus.SUCCESS,
          prState: 'OPEN',
          hasChangesRequested: true,
        })
      ).toBe(RatchetState.REVIEW_PENDING);
    });

    it('returns READY when open PR with passing CI and no changes requested', () => {
      expect(
        callDetermineRatchetState({
          ciStatus: CIStatus.SUCCESS,
          prState: 'OPEN',
          hasChangesRequested: false,
        })
      ).toBe(RatchetState.READY);
    });

    it('returns CI_FAILED even when changes are requested if CI is failing', () => {
      expect(
        callDetermineRatchetState({
          ciStatus: CIStatus.FAILURE,
          prState: 'OPEN',
          hasChangesRequested: true,
        })
      ).toBe(RatchetState.CI_FAILED);
    });
  });

  describe('computeDispatchSnapshotKey', () => {
    type StatusCheckItem = {
      name?: string;
      status?: string;
      conclusion?: string | null;
      detailsUrl?: string;
    };

    const callComputeSnapshotKey = (
      ciStatus: CIStatus,
      hasChangesRequested: boolean,
      latestReviewActivityAtMs: number | null,
      statusChecks: StatusCheckItem[] | null
    ) =>
      unsafeCoerce<{
        computeDispatchSnapshotKey: (
          ciStatus: CIStatus,
          hasChangesRequested: boolean,
          latestReviewActivityAtMs: number | null,
          statusChecks: StatusCheckItem[] | null
        ) => string;
      }>(ratchetService).computeDispatchSnapshotKey(
        ciStatus,
        hasChangesRequested,
        latestReviewActivityAtMs,
        statusChecks
      );

    it('includes CI status in key for non-failure states', () => {
      const key = callComputeSnapshotKey(CIStatus.SUCCESS, false, null, null);
      expect(key).toContain('ci:SUCCESS');
      expect(key).toContain('no-changes-requested');
      expect(key).toContain('none');
    });

    it('includes failed check details in key for FAILURE status', () => {
      const key = callComputeSnapshotKey(CIStatus.FAILURE, false, null, [
        {
          name: 'test',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/o/r/actions/runs/12345',
        },
      ]);
      expect(key).toContain('ci:FAILURE');
      expect(key).toContain('test:FAILURE:12345');
    });

    it('sorts failed checks for stable key generation', () => {
      const key = callComputeSnapshotKey(CIStatus.FAILURE, false, null, [
        {
          name: 'ztest',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/o/r/actions/runs/2',
        },
        {
          name: 'atest',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/o/r/actions/runs/1',
        },
      ]);
      expect(key.indexOf('atest')).toBeLessThan(key.indexOf('ztest'));
    });

    it('uses unknown for FAILURE with empty check array', () => {
      const key = callComputeSnapshotKey(CIStatus.FAILURE, false, null, []);
      expect(key).toContain('ci:FAILURE:unknown');
    });

    it('includes review activity timestamp in key', () => {
      const ts = 1_735_776_000_000;
      const key = callComputeSnapshotKey(CIStatus.SUCCESS, true, ts, null);
      expect(key).toContain(`changes-requested:${ts}`);
    });
  });

  describe('computeLatestReviewActivityAtMs edge cases', () => {
    type PRDetails = {
      reviews: Array<{ submittedAt: string | null; author: { login: string } }>;
      comments: Array<{ updatedAt: string; author: { login: string } }>;
    };
    type ReviewComment = { updatedAt: string; author: { login: string } };

    const callCompute = (
      prDetails: PRDetails,
      reviewComments: ReviewComment[],
      authenticatedUsername: string | null
    ) =>
      unsafeCoerce<{
        computeLatestReviewActivityAtMs: (
          prDetails: PRDetails,
          reviewComments: ReviewComment[],
          authenticatedUsername: string | null
        ) => number | null;
      }>(ratchetService).computeLatestReviewActivityAtMs(
        prDetails,
        reviewComments,
        authenticatedUsername
      );

    it('returns null when there are no reviews or comments', () => {
      expect(callCompute({ reviews: [], comments: [] }, [], null)).toBeNull();
    });

    it('returns null when all activity is from the authenticated user', () => {
      expect(
        callCompute(
          {
            reviews: [{ submittedAt: '2026-01-01T00:00:00Z', author: { login: 'me' } }],
            comments: [{ updatedAt: '2026-01-02T00:00:00Z', author: { login: 'me' } }],
          },
          [{ updatedAt: '2026-01-03T00:00:00Z', author: { login: 'me' } }],
          'me'
        )
      ).toBeNull();
    });

    it('does not filter when authenticatedUsername is null', () => {
      const result = callCompute(
        {
          reviews: [{ submittedAt: '2026-01-01T00:00:00Z', author: { login: 'bot' } }],
          comments: [],
        },
        [],
        null
      );
      expect(result).toBe(new Date('2026-01-01T00:00:00Z').getTime());
    });

    it('ignores reviews that have null submittedAt', () => {
      const result = callCompute(
        {
          reviews: [{ submittedAt: null, author: { login: 'reviewer' } }],
          comments: [{ updatedAt: '2026-01-02T00:00:00Z', author: { login: 'commenter' } }],
        },
        [],
        null
      );
      expect(result).toBe(new Date('2026-01-02T00:00:00Z').getTime());
    });

    it('returns the latest timestamp across all sources', () => {
      const result = callCompute(
        {
          reviews: [{ submittedAt: '2026-01-01T00:00:00Z', author: { login: 'a' } }],
          comments: [{ updatedAt: '2026-01-03T00:00:00Z', author: { login: 'b' } }],
        },
        [{ updatedAt: '2026-01-02T00:00:00Z', author: { login: 'c' } }],
        null
      );
      expect(result).toBe(new Date('2026-01-03T00:00:00Z').getTime());
    });
  });

  describe('processWorkspace error handling', () => {
    it('returns ERROR action when fetchPRState returns null', async () => {
      const workspace = {
        id: 'ws-fetch-err',
        prUrl: 'https://github.com/example/repo/pull/99',
        prNumber: 99,
        ratchetEnabled: true,
        ratchetState: RatchetState.IDLE,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
      };

      vi.spyOn(
        unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
        'fetchPRState'
      ).mockResolvedValue(null);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

      const result = await unsafeCoerce<{
        processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
      }>(ratchetService).processWorkspace(workspace);

      expect(result).toMatchObject({
        action: { type: 'ERROR', error: 'Failed to fetch PR state' },
        newState: RatchetState.IDLE,
      });
    });

    it('returns WAITING when shutting down', async () => {
      unsafeCoerce<{ isShuttingDown: boolean }>(ratchetService).isShuttingDown = true;

      const workspace = {
        id: 'ws-shutdown',
        prUrl: 'https://github.com/example/repo/pull/1',
        prNumber: 1,
        ratchetEnabled: true,
        ratchetState: RatchetState.CI_FAILED,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
      };

      const result = await unsafeCoerce<{
        processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
      }>(ratchetService).processWorkspace(workspace);

      expect(result).toMatchObject({
        action: { type: 'WAITING', reason: 'Shutting down' },
        previousState: RatchetState.CI_FAILED,
        newState: RatchetState.CI_FAILED,
      });
    });

    it('returns ERROR and preserves state when processWorkspace throws', async () => {
      const workspace = {
        id: 'ws-throw',
        prUrl: 'https://github.com/example/repo/pull/50',
        prNumber: 50,
        ratchetEnabled: true,
        ratchetState: RatchetState.CI_FAILED,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
      };

      vi.spyOn(
        unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
        'fetchPRState'
      ).mockRejectedValue(new Error('Unexpected explosion'));

      const result = await unsafeCoerce<{
        processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
      }>(ratchetService).processWorkspace(workspace);

      expect(result).toMatchObject({
        action: { type: 'ERROR', error: 'Unexpected explosion' },
        previousState: RatchetState.CI_FAILED,
        newState: RatchetState.CI_FAILED,
      });
    });
  });

  describe('checkAllWorkspaces', () => {
    it('returns zero counts when shutting down', async () => {
      unsafeCoerce<{ isShuttingDown: boolean }>(ratchetService).isShuttingDown = true;

      const result = await ratchetService.checkAllWorkspaces();
      expect(result).toEqual({ checked: 0, stateChanges: 0, actionsTriggered: 0, results: [] });
    });

    it('returns zero counts when no workspaces have PRs', async () => {
      vi.mocked(workspaceAccessor.findWithPRsForRatchet).mockResolvedValue([]);

      const result = await ratchetService.checkAllWorkspaces();
      expect(result).toEqual({ checked: 0, stateChanges: 0, actionsTriggered: 0, results: [] });
    });

    it('returns an error result when one workspace check times out', async () => {
      unsafeCoerce<{ workspaceCheckTimeoutMs: number }>(ratchetService).workspaceCheckTimeoutMs = 5;

      vi.mocked(workspaceAccessor.findWithPRsForRatchet).mockResolvedValue([
        {
          id: 'ws-timeout',
          prUrl: 'https://github.com/example/repo/pull/1',
          prNumber: 1,
          prState: 'OPEN',
          prCiStatus: CIStatus.FAILURE,
          defaultSessionProvider: 'WORKSPACE_DEFAULT',
          ratchetSessionProvider: 'WORKSPACE_DEFAULT',
          ratchetEnabled: true,
          ratchetState: RatchetState.IDLE,
          ratchetActiveSessionId: null,
          ratchetLastCiRunId: null,
          prReviewLastCheckedAt: null,
        },
        {
          id: 'ws-fast',
          prUrl: 'https://github.com/example/repo/pull/2',
          prNumber: 2,
          prState: 'OPEN',
          prCiStatus: CIStatus.SUCCESS,
          defaultSessionProvider: 'WORKSPACE_DEFAULT',
          ratchetSessionProvider: 'WORKSPACE_DEFAULT',
          ratchetEnabled: true,
          ratchetState: RatchetState.CI_RUNNING,
          ratchetActiveSessionId: null,
          ratchetLastCiRunId: null,
          prReviewLastCheckedAt: null,
        },
      ] as never);

      vi.spyOn(
        unsafeCoerce<{ processWorkspace: (workspaceArg: { id: string }) => Promise<unknown> }>(
          ratchetService
        ),
        'processWorkspace'
      ).mockImplementation((workspace) => {
        if (workspace.id === 'ws-timeout') {
          return new Promise<never>(() => {
            // Intentionally unresolved to simulate a hung workspace check.
          });
        }

        return Promise.resolve({
          workspaceId: workspace.id,
          previousState: RatchetState.CI_RUNNING,
          newState: RatchetState.CI_RUNNING,
          action: { type: 'WAITING', reason: 'noop' },
        });
      });

      const result = await ratchetService.checkAllWorkspaces();

      expect(result.checked).toBe(2);
      expect(result.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            workspaceId: 'ws-timeout',
            action: expect.objectContaining({
              type: 'ERROR',
              error: expect.stringContaining('timed out'),
            }),
          }),
          expect.objectContaining({
            workspaceId: 'ws-fast',
            action: { type: 'WAITING', reason: 'noop' },
          }),
        ])
      );
    });
  });

  describe('shutdown behavior', () => {
    it('stops immediately while monitor loop is sleeping', async () => {
      vi.useFakeTimers();

      vi.spyOn(ratchetService, 'checkAllWorkspaces').mockResolvedValue({
        checked: 0,
        stateChanges: 0,
        actionsTriggered: 0,
        results: [],
      });

      ratchetService.start();
      await Promise.resolve();
      await Promise.resolve();

      await expect(ratchetService.stop()).resolves.toBeUndefined();

      vi.useRealTimers();
    });
  });

  describe('checkWorkspaceById', () => {
    it('returns null when shutting down', async () => {
      unsafeCoerce<{ isShuttingDown: boolean }>(ratchetService).isShuttingDown = true;

      const result = await ratchetService.checkWorkspaceById('ws-1');
      expect(result).toBeNull();
    });

    it('returns null when workspace not found', async () => {
      unsafeCoerce<{ isShuttingDown: boolean }>(ratchetService).isShuttingDown = false;
      vi.mocked(workspaceAccessor.findForRatchetById).mockResolvedValue(null);

      const result = await ratchetService.checkWorkspaceById('ws-nonexistent');
      expect(result).toBeNull();
    });

    it('deduplicates concurrent checks for the same workspace', async () => {
      unsafeCoerce<{ isShuttingDown: boolean }>(ratchetService).isShuttingDown = false;
      const workspace = {
        id: 'ws-1',
        prUrl: 'https://github.com/example/repo/pull/1',
        prNumber: 1,
        prState: 'OPEN',
        prCiStatus: CIStatus.UNKNOWN,
        defaultSessionProvider: 'WORKSPACE_DEFAULT',
        ratchetSessionProvider: 'WORKSPACE_DEFAULT',
        ratchetEnabled: true,
        ratchetState: RatchetState.IDLE,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
      };
      vi.mocked(workspaceAccessor.findForRatchetById).mockResolvedValue(workspace as never);

      let releaseCheck!: () => void;
      const checkBarrier = new Promise<void>((resolve) => {
        releaseCheck = () => resolve();
      });
      const result = {
        workspaceId: 'ws-1',
        previousState: RatchetState.IDLE,
        newState: RatchetState.IDLE,
        action: { type: 'WAITING' as const, reason: 'noop' },
      };

      const processWorkspaceSpy = vi
        .spyOn(
          unsafeCoerce<{
            processWorkspace: (workspaceArg: typeof workspace) => Promise<typeof result>;
          }>(ratchetService),
          'processWorkspace'
        )
        .mockImplementation(async () => {
          await checkBarrier;
          return result;
        });

      const first = ratchetService.checkWorkspaceById('ws-1');
      const second = ratchetService.checkWorkspaceById('ws-1');

      await Promise.resolve();
      expect(processWorkspaceSpy).toHaveBeenCalledTimes(1);

      releaseCheck();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toEqual(result);
      expect(secondResult).toEqual(result);
      expect(processWorkspaceSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('decideRatchetAction edge cases', () => {
    const callDecide = (context: unknown) =>
      unsafeCoerce<{ decideRatchetAction: (ctx: unknown) => unknown }>(
        ratchetService
      ).decideRatchetAction(context);

    it('returns COMPLETED for merged PR', () => {
      expect(
        callDecide({
          workspace: { ratchetEnabled: true },
          prStateInfo: { prState: 'MERGED', ciStatus: CIStatus.SUCCESS },
          isCleanPrWithNoNewReviewActivity: false,
          activeRatchetSession: null,
          hasStateChangedSinceLastDispatch: true,
          hasOtherActiveSession: false,
        })
      ).toEqual({ type: 'RETURN_ACTION', action: { type: 'COMPLETED' } });
    });

    it('returns WAITING for non-open PR', () => {
      const result = callDecide({
        workspace: { ratchetEnabled: true },
        prStateInfo: { prState: 'CLOSED', ciStatus: CIStatus.SUCCESS },
        isCleanPrWithNoNewReviewActivity: false,
        activeRatchetSession: null,
        hasStateChangedSinceLastDispatch: true,
        hasOtherActiveSession: false,
      }) as { type: string; action?: { reason: string } };
      expect(result.action?.reason).toBe('PR is not open');
    });

    it('returns active session when one exists', () => {
      const activeSession = { type: 'FIXER_ACTIVE', sessionId: 's-1' };
      const result = callDecide({
        workspace: { ratchetEnabled: true },
        prStateInfo: { prState: 'OPEN', ciStatus: CIStatus.FAILURE },
        isCleanPrWithNoNewReviewActivity: false,
        activeRatchetSession: activeSession,
        hasStateChangedSinceLastDispatch: true,
        hasOtherActiveSession: false,
      }) as { type: string; action: unknown };
      expect(result.action).toEqual(activeSession);
    });

    it('returns WAITING when other active session blocks dispatch', () => {
      const result = callDecide({
        workspace: { ratchetEnabled: true },
        prStateInfo: { prState: 'OPEN', ciStatus: CIStatus.FAILURE },
        isCleanPrWithNoNewReviewActivity: false,
        activeRatchetSession: null,
        hasStateChangedSinceLastDispatch: true,
        hasOtherActiveSession: true,
      }) as { type: string; action?: { reason: string } };
      expect(result.action?.reason).toBe('Workspace is not idle (active session)');
    });

    it('returns WAITING when there are no CI failures or PR review comments', () => {
      const result = callDecide({
        workspace: { ratchetEnabled: true },
        prStateInfo: {
          prState: 'OPEN',
          ciStatus: CIStatus.SUCCESS,
          reviewComments: [],
        },
        isCleanPrWithNoNewReviewActivity: false,
        activeRatchetSession: null,
        hasStateChangedSinceLastDispatch: true,
        hasOtherActiveSession: false,
      }) as { type: string; action?: { reason: string } };
      expect(result.action?.reason).toBe('No CI failures or PR review comments to address');
    });
  });

  describe('getActiveRatchetSession edge cases', () => {
    const callGetActiveRatchetSession = (workspace: unknown) =>
      unsafeCoerce<{
        getActiveRatchetSession: (w: unknown) => Promise<unknown>;
      }>(ratchetService).getActiveRatchetSession(workspace);

    it('returns null when ratchetActiveSessionId is null', async () => {
      const result = await callGetActiveRatchetSession({
        id: 'ws-1',
        ratchetActiveSessionId: null,
      });
      expect(result).toBeNull();
    });

    it('returns null and resets dispatch tracking when session DB record is missing', async () => {
      vi.mocked(agentSessionAccessor.findById).mockResolvedValue(null);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
      vi.mocked(mockSnapshotBridge.recordReviewCheck).mockResolvedValue();

      const result = await callGetActiveRatchetSession({
        id: 'ws-2',
        ratchetActiveSessionId: 'gone-session',
      });

      expect(result).toBeNull();
      expect(workspaceAccessor.update).toHaveBeenCalledWith('ws-2', {
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
      });
      expect(mockSnapshotBridge.recordReviewCheck).toHaveBeenCalledWith('ws-2', null);
    });

    it('returns null and resets dispatch tracking when session is not RUNNING', async () => {
      vi.mocked(agentSessionAccessor.findById).mockResolvedValue({
        id: 'completed-session',
        provider: 'CLAUDE',
        status: SessionStatus.IDLE,
      } as never);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
      vi.mocked(mockSnapshotBridge.recordReviewCheck).mockResolvedValue();

      const result = await callGetActiveRatchetSession({
        id: 'ws-3',
        ratchetActiveSessionId: 'completed-session',
      });

      expect(result).toBeNull();
      expect(workspaceAccessor.update).toHaveBeenCalledWith('ws-3', {
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
      });
      expect(mockSnapshotBridge.recordReviewCheck).toHaveBeenCalledWith('ws-3', null);
    });
  });

  describe('review comment polling', () => {
    const cleanWorkspace = {
      id: 'ws-poll',
      prUrl: 'https://github.com/example/repo/pull/100',
      prNumber: 100,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.READY,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: 'old-snapshot',
      prReviewLastCheckedAt: new Date(), // Recent check — not stale
    };

    const cleanPrState = {
      ciStatus: CIStatus.SUCCESS,
      snapshotKey: 'new-snapshot',
      hasChangesRequested: false,
      latestReviewActivityAtMs: new Date('2026-01-01T00:00:00Z').getTime(),
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 100,
      reviewComments: [],
    };

    const prStateWithComments = {
      ...cleanPrState,
      snapshotKey: 'snapshot-with-comments',
      hasChangesRequested: true,
      latestReviewActivityAtMs: new Date('2026-01-03T00:00:00Z').getTime(),
      reviewComments: [
        {
          author: 'reviewer',
          body: 'Please update this line',
          path: 'src/file.ts',
          line: 21,
          url: 'https://github.com/example/repo/pull/100#discussion_r2',
        },
      ],
    };

    const getTrackers = () =>
      unsafeCoerce<{
        reviewPollTrackers: Map<
          string,
          { snapshotKey: string; lastPolledAt: number; pollCount: number }
        >;
      }>(ratchetService).reviewPollTrackers;

    const callProcessWorkspace = (workspace: typeof cleanWorkspace) =>
      unsafeCoerce<{
        processWorkspace: (w: typeof workspace) => Promise<{
          workspaceId: string;
          action: { type: string; reason?: string };
        }>;
      }>(ratchetService).processWorkspace(workspace);

    it('creates tracker when PR is first seen as clean with state change', async () => {
      vi.spyOn(
        unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
        'fetchPRState'
      ).mockResolvedValue(cleanPrState);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);

      const result = await callProcessWorkspace(cleanWorkspace);

      expect(result.action.type).toBe('WAITING');
      expect(getTrackers().has('ws-poll')).toBe(true);
      expect(getTrackers().get('ws-poll')?.snapshotKey).toBe('new-snapshot');
      expect(getTrackers().get('ws-poll')?.pollCount).toBe(0);
    });

    it('creates tracker even when state has not changed (continuous polling)', async () => {
      const workspace = { ...cleanWorkspace, ratchetLastCiRunId: 'new-snapshot' };
      vi.spyOn(
        unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
        'fetchPRState'
      ).mockResolvedValue(cleanPrState);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);

      await callProcessWorkspace(workspace);

      expect(getTrackers().has('ws-poll')).toBe(true);
      expect(getTrackers().get('ws-poll')?.pollCount).toBe(0);
    });

    it('skips re-poll when not enough time has elapsed', async () => {
      getTrackers().set('ws-poll', {
        snapshotKey: 'new-snapshot',
        lastPolledAt: Date.now(),
        pollCount: 0,
      });

      const fetchSpy = vi
        .spyOn(
          unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
          'fetchPRState'
        )
        .mockResolvedValue(cleanPrState);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);

      await callProcessWorkspace(cleanWorkspace);

      // fetchPRState called once for the initial check, but NOT a second time for the poll
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(getTrackers().get('ws-poll')?.pollCount).toBe(0);
    });

    it('re-polls and finds comments when time has elapsed', async () => {
      getTrackers().set('ws-poll', {
        snapshotKey: 'new-snapshot',
        lastPolledAt: Date.now() - 3 * 60_000, // 3 min ago, past the 2-min interval
        pollCount: 0,
      });

      const fetchSpy = vi.spyOn(
        unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
        'fetchPRState'
      );
      // First call: initial fetchPRState returns clean state
      fetchSpy.mockResolvedValueOnce(cleanPrState);
      // Second call: re-poll returns state with comments
      fetchSpy.mockResolvedValueOnce(prStateWithComments);

      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
      vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
        status: 'started',
        sessionId: 'ratchet-poll-session',
        promptSent: true,
      } as never);

      const result = await callProcessWorkspace(cleanWorkspace);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result.action.type).toBe('TRIGGERED_FIXER');
      expect(getTrackers().has('ws-poll')).toBe(false);
    });

    it('increments pollCount when re-poll still finds clean PR', async () => {
      getTrackers().set('ws-poll', {
        snapshotKey: 'new-snapshot',
        lastPolledAt: Date.now() - 3 * 60_000,
        pollCount: 0,
      });

      const fetchSpy = vi.spyOn(
        unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
        'fetchPRState'
      );
      fetchSpy.mockResolvedValue(cleanPrState);

      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);

      await callProcessWorkspace(cleanWorkspace);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(getTrackers().get('ws-poll')?.pollCount).toBe(1);
    });

    it('continues polling after many cycles without exhausting', async () => {
      getTrackers().set('ws-poll', {
        snapshotKey: 'new-snapshot',
        lastPolledAt: Date.now() - 3 * 60_000,
        pollCount: 50,
      });

      const fetchSpy = vi.spyOn(
        unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
        'fetchPRState'
      );
      fetchSpy.mockResolvedValue(cleanPrState);

      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);

      await callProcessWorkspace(cleanWorkspace);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(getTrackers().get('ws-poll')?.pollCount).toBe(51);
    });

    it('resets tracker when snapshotKey changes', async () => {
      getTrackers().set('ws-poll', {
        snapshotKey: 'different-snapshot',
        lastPolledAt: Date.now() - 10 * 60_000,
        pollCount: 3,
      });

      vi.spyOn(
        unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
        'fetchPRState'
      ).mockResolvedValue(cleanPrState);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);

      await callProcessWorkspace(cleanWorkspace);

      const tracker = getTrackers().get('ws-poll');
      expect(tracker?.snapshotKey).toBe('new-snapshot');
      expect(tracker?.pollCount).toBe(0);
    });

    it('cleans up tracker when decision is not clean PR', async () => {
      getTrackers().set('ws-poll', {
        snapshotKey: 'new-snapshot',
        lastPolledAt: Date.now(),
        pollCount: 1,
      });

      const failedPrState = {
        ...cleanPrState,
        ciStatus: CIStatus.FAILURE,
        snapshotKey: 'failed-snapshot',
      };

      vi.spyOn(
        unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
        'fetchPRState'
      ).mockResolvedValue(failedPrState);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
      vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
        status: 'started',
        sessionId: 'fixer',
        promptSent: true,
      } as never);

      await callProcessWorkspace(cleanWorkspace);

      expect(getTrackers().has('ws-poll')).toBe(false);
    });

    it('continues to next cycle when fetchPRState returns null during re-poll', async () => {
      getTrackers().set('ws-poll', {
        snapshotKey: 'new-snapshot',
        lastPolledAt: Date.now() - 3 * 60_000,
        pollCount: 0,
      });

      const fetchSpy = vi.spyOn(
        unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
        'fetchPRState'
      );
      fetchSpy.mockResolvedValueOnce(cleanPrState);
      fetchSpy.mockResolvedValueOnce(null);

      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);

      const result = await callProcessWorkspace(cleanWorkspace);

      expect(result.action.type).toBe('WAITING');
      // pollCount stays at 0 because null fetches don't consume a poll slot
      expect(getTrackers().get('ws-poll')?.pollCount).toBe(0);
    });

    it('skips re-poll when shutting down', async () => {
      getTrackers().set('ws-poll', {
        snapshotKey: 'new-snapshot',
        lastPolledAt: Date.now() - 3 * 60_000,
        pollCount: 0,
      });

      unsafeCoerce<{ isShuttingDown: boolean }>(ratchetService).isShuttingDown = false;
      const fetchSpy = vi.spyOn(
        unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
        'fetchPRState'
      );
      fetchSpy.mockResolvedValueOnce(cleanPrState);
      fetchSpy.mockResolvedValueOnce(cleanPrState);

      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);

      // Set shutting down after buildRatchetDecisionContext runs but before poll
      // We do this by checking at the handleReviewCommentPoll level
      const handlePollSpy = vi.spyOn(
        unsafeCoerce<{
          handleReviewCommentPoll: (...args: unknown[]) => Promise<unknown>;
        }>(ratchetService),
        'handleReviewCommentPoll'
      );
      handlePollSpy.mockImplementationOnce(async (...args: unknown[]) => {
        unsafeCoerce<{ isShuttingDown: boolean }>(ratchetService).isShuttingDown = true;
        handlePollSpy.mockRestore();
        return await unsafeCoerce<{
          handleReviewCommentPoll: (...a: unknown[]) => Promise<unknown>;
        }>(ratchetService).handleReviewCommentPoll(...args);
      });

      const result = await callProcessWorkspace(cleanWorkspace);

      expect(result.action.type).toBe('WAITING');
      // fetchPRState should only have been called once (initial), not for re-poll
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('triggerFixer error handling', () => {
    it('handles acquireAndDispatch throwing an error', async () => {
      const workspace = {
        id: 'ws-trigger-fail',
        prUrl: 'https://github.com/example/repo/pull/20',
        prNumber: 20,
        ratchetEnabled: true,
        ratchetState: RatchetState.CI_FAILED,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
      };

      vi.mocked(fixerSessionService.acquireAndDispatch).mockRejectedValue(
        new Error('Session creation failed')
      );

      const result = await unsafeCoerce<{
        triggerFixer: (w: unknown, prStateInfo: unknown) => Promise<unknown>;
      }>(ratchetService).triggerFixer(workspace, {
        ciStatus: CIStatus.FAILURE,
        prNumber: 20,
      });

      expect(result).toMatchObject({
        type: 'ERROR',
        error: 'Session creation failed',
      });
    });

    it('handles already_active result from acquireAndDispatch', async () => {
      const workspace = {
        id: 'ws-already-active',
        prUrl: 'https://github.com/example/repo/pull/21',
        prNumber: 21,
        ratchetEnabled: true,
        ratchetState: RatchetState.CI_FAILED,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
      };

      vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
        status: 'already_active',
        sessionId: 'existing-session',
      } as never);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

      const result = await unsafeCoerce<{
        triggerFixer: (w: unknown, prStateInfo: unknown) => Promise<unknown>;
      }>(ratchetService).triggerFixer(workspace, {
        ciStatus: CIStatus.FAILURE,
        prNumber: 21,
      });

      expect(result).toMatchObject({
        type: 'FIXER_ACTIVE',
        sessionId: 'existing-session',
      });
    });

    it('handles skipped result from acquireAndDispatch', async () => {
      const workspace = {
        id: 'ws-skipped',
        prUrl: 'https://github.com/example/repo/pull/22',
        prNumber: 22,
        ratchetEnabled: true,
        ratchetState: RatchetState.CI_FAILED,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
      };

      vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
        status: 'skipped',
        reason: 'No worktree path',
      } as never);

      const result = await unsafeCoerce<{
        triggerFixer: (w: unknown, prStateInfo: unknown) => Promise<unknown>;
      }>(ratchetService).triggerFixer(workspace, {
        ciStatus: CIStatus.FAILURE,
        prNumber: 22,
      });

      expect(result).toMatchObject({
        type: 'ERROR',
        error: 'No worktree path',
      });
    });
  });

  describe('workspace ratchet toggle events', () => {
    afterEach(() => {
      ratchetService.removeAllListeners();
    });

    it('emits ratchet_toggled when enabling workspace ratcheting', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue({
        id: 'ws-enable',
        ratchetState: RatchetState.CI_FAILED,
        ratchetActiveSessionId: null,
      } as never);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

      const toggledEvents: RatchetToggledEvent[] = [];
      const stateEvents: RatchetStateChangedEvent[] = [];
      ratchetService.on(RATCHET_TOGGLED, (event: RatchetToggledEvent) => {
        toggledEvents.push(event);
      });
      ratchetService.on(RATCHET_STATE_CHANGED, (event: RatchetStateChangedEvent) => {
        stateEvents.push(event);
      });

      await ratchetService.setWorkspaceRatcheting('ws-enable', true);

      expect(workspaceAccessor.update).toHaveBeenCalledWith('ws-enable', { ratchetEnabled: true });
      expect(toggledEvents).toEqual([
        {
          workspaceId: 'ws-enable',
          enabled: true,
          ratchetState: RatchetState.CI_FAILED,
        },
      ]);
      expect(stateEvents).toHaveLength(0);
    });

    it('emits ratchet_toggled and ratchet_state_changed when disabling non-idle workspace', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue({
        id: 'ws-disable',
        ratchetState: RatchetState.CI_RUNNING,
        ratchetActiveSessionId: null,
      } as never);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

      const toggledEvents: RatchetToggledEvent[] = [];
      const stateEvents: RatchetStateChangedEvent[] = [];
      ratchetService.on(RATCHET_TOGGLED, (event: RatchetToggledEvent) => {
        toggledEvents.push(event);
      });
      ratchetService.on(RATCHET_STATE_CHANGED, (event: RatchetStateChangedEvent) => {
        stateEvents.push(event);
      });

      await ratchetService.setWorkspaceRatcheting('ws-disable', false);

      expect(workspaceAccessor.update).toHaveBeenCalledWith('ws-disable', {
        ratchetEnabled: false,
        ratchetState: RatchetState.IDLE,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
      });
      expect(stateEvents).toEqual([
        {
          workspaceId: 'ws-disable',
          fromState: RatchetState.CI_RUNNING,
          toState: RatchetState.IDLE,
        },
      ]);
      expect(toggledEvents).toEqual([
        {
          workspaceId: 'ws-disable',
          enabled: false,
          ratchetState: RatchetState.IDLE,
        },
      ]);
    });
  });

  describe('event emission', () => {
    afterEach(() => {
      ratchetService.removeAllListeners();
    });

    it('emits ratchet_state_changed when disabled workspace state changes', async () => {
      const workspace = {
        id: 'ws-disabled-change',
        prUrl: 'https://github.com/example/repo/pull/30',
        prNumber: 30,
        ratchetEnabled: false,
        ratchetState: RatchetState.CI_FAILED,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
      };

      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

      const events: RatchetStateChangedEvent[] = [];
      ratchetService.on(RATCHET_STATE_CHANGED, (event: RatchetStateChangedEvent) => {
        events.push(event);
      });

      await unsafeCoerce<{
        processWorkspace: (w: typeof workspace) => Promise<unknown>;
      }>(ratchetService).processWorkspace(workspace);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        workspaceId: 'ws-disabled-change',
        fromState: RatchetState.CI_FAILED,
        toState: RatchetState.IDLE,
      });
    });

    it('does NOT emit when disabled workspace state is already IDLE', async () => {
      const workspace = {
        id: 'ws-disabled-idle',
        prUrl: 'https://github.com/example/repo/pull/31',
        prNumber: 31,
        ratchetEnabled: false,
        ratchetState: RatchetState.IDLE,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
      };

      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

      const events: RatchetStateChangedEvent[] = [];
      ratchetService.on(RATCHET_STATE_CHANGED, (event: RatchetStateChangedEvent) => {
        events.push(event);
      });

      await unsafeCoerce<{
        processWorkspace: (w: typeof workspace) => Promise<unknown>;
      }>(ratchetService).processWorkspace(workspace);

      expect(events).toHaveLength(0);
    });

    it('emits ratchet_state_changed on main path when state changes', async () => {
      const workspace = {
        id: 'ws-state-change',
        prUrl: 'https://github.com/example/repo/pull/32',
        prNumber: 32,
        ratchetEnabled: true,
        ratchetState: RatchetState.IDLE,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
      };

      vi.spyOn(
        unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
        'fetchPRState'
      ).mockResolvedValue({
        ciStatus: CIStatus.FAILURE,
        snapshotKey: 'new-snapshot-key',
        hasChangesRequested: false,
        latestReviewActivityAtMs: null,
        statusCheckRollup: null,
        prState: 'OPEN',
        prNumber: 32,
      });

      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
      vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
        status: 'started',
        sessionId: 'ratchet-session-32',
        promptSent: true,
      } as never);

      const events: RatchetStateChangedEvent[] = [];
      ratchetService.on(RATCHET_STATE_CHANGED, (event: RatchetStateChangedEvent) => {
        events.push(event);
      });

      await unsafeCoerce<{
        processWorkspace: (w: typeof workspace) => Promise<unknown>;
      }>(ratchetService).processWorkspace(workspace);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        workspaceId: 'ws-state-change',
        fromState: RatchetState.IDLE,
        toState: RatchetState.CI_FAILED,
      });
    });

    it('does NOT emit when main path state unchanged', async () => {
      const workspace = {
        id: 'ws-no-change',
        prUrl: 'https://github.com/example/repo/pull/33',
        prNumber: 33,
        ratchetEnabled: true,
        ratchetState: RatchetState.CI_FAILED,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
      };

      vi.spyOn(
        unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
        'fetchPRState'
      ).mockResolvedValue({
        ciStatus: CIStatus.FAILURE,
        snapshotKey: 'new-snapshot-key',
        hasChangesRequested: false,
        latestReviewActivityAtMs: null,
        statusCheckRollup: null,
        prState: 'OPEN',
        prNumber: 33,
      });

      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
      vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
        status: 'started',
        sessionId: 'ratchet-session-33',
        promptSent: true,
      } as never);

      const events: RatchetStateChangedEvent[] = [];
      ratchetService.on(RATCHET_STATE_CHANGED, (event: RatchetStateChangedEvent) => {
        events.push(event);
      });

      await unsafeCoerce<{
        processWorkspace: (w: typeof workspace) => Promise<unknown>;
      }>(ratchetService).processWorkspace(workspace);

      expect(events).toHaveLength(0);
    });

    it('does NOT emit on error path', async () => {
      const workspace = {
        id: 'ws-error',
        prUrl: 'https://github.com/example/repo/pull/34',
        prNumber: 34,
        ratchetEnabled: true,
        ratchetState: RatchetState.CI_FAILED,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
      };

      vi.spyOn(
        unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
        'fetchPRState'
      ).mockResolvedValue(null);

      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

      const events: RatchetStateChangedEvent[] = [];
      ratchetService.on(RATCHET_STATE_CHANGED, (event: RatchetStateChangedEvent) => {
        events.push(event);
      });

      const result = await unsafeCoerce<{
        processWorkspace: (w: typeof workspace) => Promise<unknown>;
      }>(ratchetService).processWorkspace(workspace);

      expect(result).toMatchObject({
        action: { type: 'ERROR' },
      });
      expect(events).toHaveLength(0);
    });
  });
});
