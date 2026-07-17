import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_TIMEOUT_MS } from '@/backend/services/constants';
import { CIStatus, RatchetState, SessionStatus } from '@/shared/core';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { RatchetGitHubBridge, RatchetPRSnapshotBridge, RatchetSessionBridge } from './bridges';

vi.mock('@/backend/services/workspace', () => ({
  workspaceAccessor: {
    findById: vi.fn(),
    findWithPRsForRatchet: vi.fn(),
    findForRatchetById: vi.fn(),
    update: vi.fn(),
    transitionRatchetStateIfEnabled: vi.fn(),
    settleRatchetIdleWhileDisabled: vi.fn(),
    recordRatchetDispatchIfEnabled: vi.fn(),
    adoptRatchetActiveSessionIfEnabled: vi.fn(),
    recordRatchetSessionEnd: vi.fn(),
  },
}));

vi.mock('@/backend/services/session', () => ({
  agentSessionAccessor: {
    findById: vi.fn(),
    findByWorkspaceId: vi.fn(),
  },
}));

vi.mock('@/backend/services/settings', () => ({
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

import { agentSessionAccessor } from '@/backend/services/session';
import { userSettingsAccessor } from '@/backend/services/settings';
import { workspaceAccessor } from '@/backend/services/workspace';
import { fixerSessionService } from './fixer-session.service';
import {
  RATCHET_STATE_CHANGED,
  RATCHET_TOGGLED,
  type RatchetStateChangedEvent,
  type RatchetToggledEvent,
  ratchetService,
  type WorkspaceRatchetResult,
} from './ratchet.service';
import { buildRatchetingLogContext } from './ratchet-decision-logging.helpers';
import {
  computeDispatchSnapshotKey,
  computeLatestReviewActivityAtMs,
  determineRatchetState,
} from './ratchet-pr-state.helpers';

const mockSessionBridge: RatchetSessionBridge = {
  findSessionsByWorkspaceId: vi.fn(),
  isSessionRunning: vi.fn(),
  isSessionWorking: vi.fn(),
  stopSession: vi.fn(),
  startSession: vi.fn(),
  restartSession: vi.fn(),
  sendSessionMessage: vi.fn(),
  injectCommittedUserMessage: vi.fn(),
};

const mockGitHubBridge: RatchetGitHubBridge = {
  extractPRInfo: vi.fn(),
  getPRFullDetails: vi.fn(),
  getReviewComments: vi.fn(),
  getResolvedReviewCommentIds: vi.fn(),
  computeCIStatus: vi.fn(),
  getAuthenticatedUsername: vi.fn(),
  fetchAndComputePRState: vi.fn(),
  isRecentlyFetched: vi.fn(),
  isFetchInFlight: vi.fn(),
  startFetch: vi.fn(() => 41),
  registerFetch: vi.fn(),
  cancelFetch: vi.fn(),
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
    ratchetService.configure({
      session: mockSessionBridge,
      github: mockGitHubBridge,
      snapshot: mockSnapshotBridge,
    });
    vi.mocked(workspaceAccessor.transitionRatchetStateIfEnabled).mockResolvedValue(true);
    vi.mocked(workspaceAccessor.settleRatchetIdleWhileDisabled).mockResolvedValue(true);
    vi.mocked(workspaceAccessor.recordRatchetDispatchIfEnabled).mockResolvedValue(true);
    vi.mocked(workspaceAccessor.adoptRatchetActiveSessionIfEnabled).mockResolvedValue(true);
    vi.mocked(workspaceAccessor.recordRatchetSessionEnd).mockResolvedValue(true);
    vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
    vi.mocked(mockSessionBridge.findSessionsByWorkspaceId).mockResolvedValue([]);
    vi.mocked(mockGitHubBridge.getAuthenticatedUsername).mockResolvedValue(null);
    vi.mocked(mockGitHubBridge.getResolvedReviewCommentIds).mockResolvedValue(new Set());
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
      ratchetReplyToPrComments: true,
      ratchetReviewTriggerMode: 'CHANGES_REQUESTED',
      defaultSessionProvider: 'CLAUDE',
      defaultClaudeModel: 'sonnet',
      defaultCodexModel: 'default',
      defaultClaudeReasoningEffort: null,
      defaultCodexReasoningEffort: null,
      defaultWorkspacePermissions: 'STRICT',
      ratchetPermissions: 'YOLO',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    vi.mocked(userSettingsAccessor.getDefaultSessionProvider).mockResolvedValue('CLAUDE');
  });

  afterEach(() => {
    // Listener-registering tests must not leak into later tests even when an
    // assertion fails before their inline cleanup.
    ratchetService.removeAllListeners();
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
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
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
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
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
    expect(workspaceAccessor.settleRatchetIdleWhileDisabled).toHaveBeenCalledWith(
      'ws-disabled',
      RatchetState.IDLE
    );
  });

  it('settles a disabled workspace to IDLE via CAS and emits an accurate fromState', async () => {
    const workspace = {
      id: 'ws-disabled-settle',
      prUrl: 'https://github.com/example/repo/pull/2',
      prNumber: 2,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: false,
      ratchetState: RatchetState.CI_FAILED,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: null,
      prReviewLastCheckedAt: null,
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
    };

    vi.mocked(workspaceAccessor.settleRatchetIdleWhileDisabled).mockResolvedValue(true);

    const events: RatchetStateChangedEvent[] = [];
    ratchetService.on(RATCHET_STATE_CHANGED, (event: RatchetStateChangedEvent) => {
      events.push(event);
    });

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<WorkspaceRatchetResult>;
    }>(ratchetService).processWorkspace(workspace);

    expect(workspaceAccessor.settleRatchetIdleWhileDisabled).toHaveBeenCalledWith(
      'ws-disabled-settle',
      RatchetState.CI_FAILED
    );
    expect(result).toMatchObject({
      previousState: RatchetState.CI_FAILED,
      newState: RatchetState.IDLE,
      action: { type: 'DISABLED' },
    });
    expect(events).toEqual([
      {
        workspaceId: 'ws-disabled-settle',
        fromState: RatchetState.CI_FAILED,
        toState: RatchetState.IDLE,
      },
    ]);
  });

  it('does not emit for a disabled workspace when the settle CAS loses', async () => {
    const workspace = {
      id: 'ws-disabled-settle-race',
      prUrl: 'https://github.com/example/repo/pull/2',
      prNumber: 2,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: false,
      ratchetState: RatchetState.CI_FAILED,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: null,
      prReviewLastCheckedAt: null,
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
    };

    vi.mocked(workspaceAccessor.settleRatchetIdleWhileDisabled).mockResolvedValue(false);

    const events: RatchetStateChangedEvent[] = [];
    ratchetService.on(RATCHET_STATE_CHANGED, (event: RatchetStateChangedEvent) => {
      events.push(event);
    });

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<WorkspaceRatchetResult>;
    }>(ratchetService).processWorkspace(workspace);

    // The settle did not persist, so the result must not report a state
    // change this check never committed.
    expect(result).toMatchObject({
      previousState: RatchetState.CI_FAILED,
      newState: RatchetState.CI_FAILED,
      action: { type: 'DISABLED' },
    });
    expect(events).toEqual([]);
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
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
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
    vi.mocked(mockSessionBridge.isSessionRunning).mockReturnValue(true);
    vi.mocked(mockSessionBridge.isSessionWorking).mockReturnValue(true);

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(result).toMatchObject({
      action: {
        type: 'WAITING',
        reason: 'Workspace has another working session',
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
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
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

    expect(workspaceAccessor.recordRatchetDispatchIfEnabled).toHaveBeenCalledWith('ws-change', {
      sessionId: 'ratchet-session',
      snapshotKey: '2026-01-02T00:00:00Z',
      retryCount: 0,
    });
    const finalUpdatePayload = vi
      .mocked(workspaceAccessor.transitionRatchetStateIfEnabled)
      .mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(finalUpdatePayload).not.toHaveProperty('ratchetLastCiRunId');
    expect(finalUpdatePayload).not.toHaveProperty('prReviewLastCheckedAt');
    expect(mockSnapshotBridge.recordReviewCheck).toHaveBeenCalledWith(
      'ws-change',
      expect.any(Date)
    );
  });

  it('stops fixer and returns disabled when active-session recording loses disable race', async () => {
    const workspace = {
      id: 'ws-disable-race-dispatch',
      prUrl: 'https://github.com/example/repo/pull/40',
      prNumber: 40,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.IDLE,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: 'old-snapshot',
      prReviewLastCheckedAt: new Date('2026-01-01T00:00:00Z'),
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
    };

    vi.spyOn(
      unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.FAILURE,
      snapshotKey: 'new-snapshot',
      hasChangesRequested: false,
      latestReviewActivityAtMs: null,
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 40,
    });

    vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'started',
      sessionId: 'raced-session',
      promptSent: true,
    } as never);
    vi.mocked(workspaceAccessor.recordRatchetDispatchIfEnabled).mockResolvedValue(false);
    vi.mocked(workspaceAccessor.transitionRatchetStateIfEnabled).mockResolvedValue(false);
    vi.mocked(workspaceAccessor.findById).mockResolvedValue({
      id: 'ws-disable-race-dispatch',
      ratchetEnabled: false,
    } as never);
    vi.mocked(mockSessionBridge.isSessionRunning).mockReturnValue(true);

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(result).toMatchObject({
      newState: RatchetState.IDLE,
      action: { type: 'DISABLED', reason: 'Workspace ratcheting disabled' },
    });
    expect(workspaceAccessor.recordRatchetDispatchIfEnabled).toHaveBeenCalledWith(
      'ws-disable-race-dispatch',
      { sessionId: 'raced-session', snapshotKey: 'new-snapshot', retryCount: 0 }
    );
    expect(mockSessionBridge.stopSession).toHaveBeenCalledWith('raced-session');
    expect(mockSnapshotBridge.recordReviewCheck).not.toHaveBeenCalled();
  });

  it('dispatches when session is running but idle', async () => {
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
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
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
    vi.mocked(mockSessionBridge.isSessionRunning).mockReturnValue(true);
    vi.mocked(mockSessionBridge.isSessionWorking).mockReturnValue(false);
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
    expect(mockSessionBridge.isSessionWorking).toHaveBeenCalledWith('chat-idle-1');
    expect(fixerSessionService.acquireAndDispatch).toHaveBeenCalled();
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
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
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
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
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
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
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

  it('dispatches for PR review summary feedback in all-feedback mode', async () => {
    const workspace = {
      id: 'ws-review-summary',
      prUrl: 'https://github.com/example/repo/pull/57',
      prNumber: 57,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.READY,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: 'ci:SUCCESS|no-changes-requested:old|merge:clean',
      prReviewLastCheckedAt: new Date('2026-01-02T00:00:00Z'),
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
    };

    vi.mocked(userSettingsAccessor.get).mockResolvedValue({
      ratchetReviewTriggerMode: 'ALL_REVIEW_FEEDBACK',
      ratchetReplyToPrComments: true,
      ratchetPermissions: 'YOLO',
    } as never);
    const fetchPRStateSpy = vi
      .spyOn(
        unsafeCoerce<{
          fetchPRState: (...args: unknown[]) => Promise<unknown>;
        }>(ratchetService),
        'fetchPRState'
      )
      .mockResolvedValue({
        ciStatus: CIStatus.SUCCESS,
        snapshotKey: 'ci:SUCCESS|no-changes-requested:1767315600000|merge:clean',
        hasChangesRequested: false,
        hasMergeConflict: false,
        latestReviewActivityAtMs: new Date('2026-01-02T01:00:00Z').getTime(),
        statusCheckRollup: null,
        prState: 'OPEN',
        prNumber: 57,
        reviewComments: [
          {
            author: 'cubic-dev-ai',
            body: 'Please fix the hydration edge case.',
            path: 'PR review',
            line: null,
            url: 'https://github.com/example/repo/pull/57#pullrequestreview-1',
          },
        ],
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
      newState: RatchetState.READY,
    });
    expect(fixerSessionService.acquireAndDispatch).toHaveBeenCalled();
    expect(fetchPRStateSpy).toHaveBeenCalledWith(
      workspace,
      null,
      expect.objectContaining({ reviewTriggerMode: 'ALL_REVIEW_FEEDBACK' }),
      expect.any(AbortSignal)
    );
  });

  it('treats closed PR as IDLE and does not dispatch', () => {
    const state = determineRatchetState({
      ciStatus: CIStatus.SUCCESS,
      snapshotKey: '2026-01-02T00:00:00Z',
      hasChangesRequested: false,
      latestReviewActivityAtMs: null,
      prState: 'CLOSED',
      prNumber: 6,
    } as never);

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
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
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

  it('routes an aborted prompt-failure path through orphan cleanup', async () => {
    const controller = new AbortController();
    const timeoutError = new Error('Workspace check timed out');
    let finishPointerClear!: () => void;
    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'started',
      sessionId: 'aborted-prompt-session',
      promptSent: false,
    });
    vi.mocked(workspaceAccessor.update).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPointerClear = () => resolve({} as never);
        })
    );
    vi.mocked(mockSessionBridge.isSessionRunning).mockReturnValue(true);

    const trigger = unsafeCoerce<{
      triggerFixer: (
        w: unknown,
        prStateInfo: unknown,
        retryCount: number,
        signal: AbortSignal
      ) => Promise<unknown>;
    }>(ratchetService).triggerFixer(
      {
        id: 'ws-aborted-prompt',
        prUrl: 'https://github.com/example/repo/pull/7',
      },
      {
        ciStatus: CIStatus.FAILURE,
        snapshotKey: 'failed:7',
        prNumber: 7,
        reviewComments: [],
        hasMergeConflict: false,
      },
      0,
      controller.signal
    );
    await vi.waitFor(() => expect(workspaceAccessor.update).toHaveBeenCalled());
    controller.abort(timeoutError);
    finishPointerClear();

    await expect(trigger).rejects.toBe(timeoutError);
    expect(workspaceAccessor.recordRatchetSessionEnd).toHaveBeenCalledWith(
      'ws-aborted-prompt',
      'aborted-prompt-session',
      'COMPLETED'
    );
    expect(mockSessionBridge.stopSession).toHaveBeenCalledWith('aborted-prompt-session');
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
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
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

  it('returns disabled when stale check-state update loses disable race', async () => {
    const recentCheck = new Date();
    const workspace = {
      id: 'ws-disable-race-state',
      prUrl: 'https://github.com/example/repo/pull/41',
      prNumber: 41,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.READY,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: 'old-snapshot',
      prReviewLastCheckedAt: recentCheck,
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
    };

    vi.spyOn(
      unsafeCoerce<{
        fetchPRState: (...args: unknown[]) => Promise<unknown>;
      }>(ratchetService),
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.SUCCESS,
      snapshotKey: 'new-snapshot',
      hasChangesRequested: false,
      latestReviewActivityAtMs: recentCheck.getTime() - 1000,
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 41,
    });
    vi.mocked(workspaceAccessor.transitionRatchetStateIfEnabled).mockResolvedValue(false);
    vi.mocked(workspaceAccessor.findById).mockResolvedValue({
      id: 'ws-disable-race-state',
      ratchetEnabled: false,
    } as never);
    vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);

    const events: RatchetStateChangedEvent[] = [];
    ratchetService.on(RATCHET_STATE_CHANGED, (event: RatchetStateChangedEvent) => {
      events.push(event);
    });

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(result).toMatchObject({
      newState: RatchetState.IDLE,
      action: { type: 'DISABLED', reason: 'Workspace ratcheting disabled' },
    });
    expect(events).toHaveLength(0);
    ratchetService.removeAllListeners();
  });

  it('reports a concurrent state change without emitting when the check loses the CAS while still enabled', async () => {
    const recentCheck = new Date();
    const workspace = {
      id: 'ws-superseded',
      prUrl: 'https://github.com/example/repo/pull/42',
      prNumber: 42,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_RUNNING,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: 'old-snapshot',
      prReviewLastCheckedAt: recentCheck,
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
    };

    vi.spyOn(
      unsafeCoerce<{
        fetchPRState: (...args: unknown[]) => Promise<unknown>;
      }>(ratchetService),
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.SUCCESS,
      snapshotKey: 'new-snapshot',
      hasChangesRequested: false,
      latestReviewActivityAtMs: recentCheck.getTime() - 1000,
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 42,
    });
    // The CAS on fromState loses (e.g. markPrClosed settled the workspace to
    // IDLE mid-check) while ratcheting remains enabled.
    vi.mocked(workspaceAccessor.transitionRatchetStateIfEnabled).mockResolvedValue(false);
    vi.mocked(workspaceAccessor.findById).mockResolvedValue({
      id: 'ws-superseded',
      ratchetEnabled: true,
      ratchetState: RatchetState.IDLE,
    } as never);
    vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);

    const events: RatchetStateChangedEvent[] = [];
    ratchetService.on(RATCHET_STATE_CHANGED, (event: RatchetStateChangedEvent) => {
      events.push(event);
    });

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<WorkspaceRatchetResult>;
    }>(ratchetService).processWorkspace(workspace);

    expect(workspaceAccessor.transitionRatchetStateIfEnabled).toHaveBeenCalledWith(
      'ws-superseded',
      RatchetState.CI_RUNNING,
      expect.objectContaining({ ratchetState: RatchetState.READY })
    );
    expect(result).toMatchObject({
      previousState: RatchetState.CI_RUNNING,
      newState: RatchetState.CI_RUNNING,
      action: {
        type: 'WAITING',
        reason: 'Ratchet state changed concurrently during this check; re-evaluating next cycle',
      },
    });
    expect(events).toHaveLength(0);
    expect(mockSnapshotBridge.recordCIObservation).not.toHaveBeenCalled();
    expect(mockSnapshotBridge.recordReviewCheck).not.toHaveBeenCalled();
  });

  it('redispatches with an incremented retry count when the previous fixer died', async () => {
    const workspace = {
      id: 'ws-died-retry',
      prUrl: 'https://github.com/example/repo/pull/13',
      prNumber: 13,
      prState: 'OPEN',
      prCiStatus: CIStatus.FAILURE,
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_FAILED,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: 'same-snapshot',
      prReviewLastCheckedAt: new Date('2026-01-01T00:00:00Z'),
      ratchetDispatchOutcome: 'DIED',
      ratchetDispatchRetryCount: 1,
    };

    vi.spyOn(
      unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.FAILURE,
      snapshotKey: 'same-snapshot',
      hasChangesRequested: false,
      latestReviewActivityAtMs: null,
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 13,
    });
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'started',
      sessionId: 'retry-session',
      promptSent: true,
    } as never);

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(result).toMatchObject({
      action: { type: 'TRIGGERED_FIXER' },
    });
    expect(workspaceAccessor.recordRatchetDispatchIfEnabled).toHaveBeenCalledWith('ws-died-retry', {
      sessionId: 'retry-session',
      snapshotKey: 'same-snapshot',
      retryCount: 2,
    });
  });

  it('redispatches a died fixer even when the PR is otherwise clean', async () => {
    // A fixer dispatched for review comments (green CI) that crashed must be
    // retried; the clean-PR skip gate must not swallow the retry.
    const checkedAt = new Date('2026-01-02T00:00:00Z');
    const workspace = {
      id: 'ws-died-clean',
      prUrl: 'https://github.com/example/repo/pull/14',
      prNumber: 14,
      prState: 'OPEN',
      prCiStatus: CIStatus.SUCCESS,
      ratchetEnabled: true,
      ratchetState: RatchetState.READY,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: 'clean-snapshot',
      prReviewLastCheckedAt: checkedAt,
      ratchetDispatchOutcome: 'DIED',
      ratchetDispatchRetryCount: 0,
    };

    vi.spyOn(
      unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.SUCCESS,
      snapshotKey: 'clean-snapshot',
      hasChangesRequested: false,
      latestReviewActivityAtMs: checkedAt.getTime() - 1000,
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 14,
      reviewComments: [],
    });
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'started',
      sessionId: 'retry-session',
      promptSent: true,
    } as never);

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(result).toMatchObject({
      action: { type: 'TRIGGERED_FIXER' },
    });
    expect(workspaceAccessor.recordRatchetDispatchIfEnabled).toHaveBeenCalledWith('ws-died-clean', {
      sessionId: 'retry-session',
      snapshotKey: 'clean-snapshot',
      retryCount: 1,
    });
  });

  it('stops retrying a died fixer once the retry budget is exhausted', async () => {
    const workspace = {
      id: 'ws-died-exhausted',
      prUrl: 'https://github.com/example/repo/pull/15',
      prNumber: 15,
      prState: 'OPEN',
      prCiStatus: CIStatus.FAILURE,
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_FAILED,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: 'same-snapshot',
      prReviewLastCheckedAt: new Date('2026-01-01T00:00:00Z'),
      ratchetDispatchOutcome: 'DIED',
      ratchetDispatchRetryCount: 3,
    };

    vi.spyOn(
      unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.FAILURE,
      snapshotKey: 'same-snapshot',
      hasChangesRequested: false,
      latestReviewActivityAtMs: null,
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 15,
    });
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(result).toMatchObject({
      action: {
        type: 'WAITING',
        reason: 'Fixer died 4 times for this PR state; waiting for PR state to change',
      },
    });
    expect(fixerSessionService.acquireAndDispatch).not.toHaveBeenCalled();
  });

  it('resets the retry count when the PR state changes after a death', async () => {
    const workspace = {
      id: 'ws-died-changed',
      prUrl: 'https://github.com/example/repo/pull/16',
      prNumber: 16,
      prState: 'OPEN',
      prCiStatus: CIStatus.FAILURE,
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_FAILED,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: 'old-snapshot',
      prReviewLastCheckedAt: new Date('2026-01-01T00:00:00Z'),
      ratchetDispatchOutcome: 'DIED',
      ratchetDispatchRetryCount: 3,
    };

    vi.spyOn(
      unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.FAILURE,
      snapshotKey: 'new-snapshot',
      hasChangesRequested: false,
      latestReviewActivityAtMs: null,
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 16,
    });
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
    vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([] as never);
    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'started',
      sessionId: 'fresh-session',
      promptSent: true,
    } as never);

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(result).toMatchObject({
      action: { type: 'TRIGGERED_FIXER' },
    });
    expect(workspaceAccessor.recordRatchetDispatchIfEnabled).toHaveBeenCalledWith(
      'ws-died-changed',
      { sessionId: 'fresh-session', snapshotKey: 'new-snapshot', retryCount: 0 }
    );
  });

  it('does not redispatch when the previous fixer completed and PR state is unchanged', async () => {
    const workspace = {
      id: 'ws-completed-unchanged',
      prUrl: 'https://github.com/example/repo/pull/17',
      prNumber: 17,
      prState: 'OPEN',
      prCiStatus: CIStatus.FAILURE,
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_FAILED,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: 'same-snapshot',
      prReviewLastCheckedAt: new Date('2026-01-01T00:00:00Z'),
      ratchetDispatchOutcome: 'COMPLETED',
      ratchetDispatchRetryCount: 2,
    };

    vi.spyOn(
      unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.FAILURE,
      snapshotKey: 'same-snapshot',
      hasChangesRequested: false,
      latestReviewActivityAtMs: null,
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 17,
    });
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(result).toMatchObject({
      action: {
        type: 'WAITING',
        reason: 'PR state unchanged since last ratchet dispatch',
      },
    });
    expect(fixerSessionService.acquireAndDispatch).not.toHaveBeenCalled();
  });

  it('dispatches a fresh fixer after switching PRs with identical merge-conflict state', async () => {
    const previousSnapshotKey = computeDispatchSnapshotKey(
      123,
      CIStatus.SUCCESS,
      false,
      null,
      null,
      true
    );
    const currentSnapshotKey = computeDispatchSnapshotKey(
      456,
      CIStatus.SUCCESS,
      false,
      null,
      null,
      true
    );
    expect(previousSnapshotKey).toBe('pr:123|ci:SUCCESS|no-changes-requested:none|merge:conflict');
    expect(currentSnapshotKey).toBe('pr:456|ci:SUCCESS|no-changes-requested:none|merge:conflict');

    const workspace = {
      id: 'ws-pr-switch-merge-conflict',
      prUrl: 'https://github.com/example/repo/pull/456',
      prNumber: 456,
      prState: 'OPEN',
      prCiStatus: CIStatus.SUCCESS,
      ratchetEnabled: true,
      ratchetState: RatchetState.MERGE_CONFLICT,
      ratchetActiveSessionId: null,
      ratchetLastCiRunId: previousSnapshotKey,
      prReviewLastCheckedAt: new Date('2026-01-01T00:00:00Z'),
      ratchetDispatchOutcome: 'COMPLETED',
      ratchetDispatchRetryCount: 2,
    };

    vi.spyOn(
      unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.SUCCESS,
      snapshotKey: currentSnapshotKey,
      hasChangesRequested: false,
      hasMergeConflict: true,
      latestReviewActivityAtMs: null,
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 456,
      reviewComments: [],
    });
    vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
      status: 'started',
      sessionId: 'fresh-pr-session',
      promptSent: true,
    } as never);

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(result).toMatchObject({
      action: { type: 'TRIGGERED_FIXER' },
    });
    expect(workspaceAccessor.recordRatchetDispatchIfEnabled).toHaveBeenCalledWith(workspace.id, {
      sessionId: 'fresh-pr-session',
      snapshotKey: currentSnapshotKey,
      retryCount: 0,
    });
  });

  it('settles the dispatch as DIED when ratchet session process is not running', async () => {
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
      ratchetDispatchOutcome: 'RUNNING',
      ratchetDispatchRetryCount: 0,
    };

    vi.mocked(agentSessionAccessor.findById).mockResolvedValue({
      id: 'ratchet-session',
      provider: 'CLAUDE',
      status: SessionStatus.RUNNING,
    } as never);
    vi.mocked(mockSessionBridge.isSessionRunning).mockReturnValue(false);

    const result = await unsafeCoerce<{
      checkActiveFixerSession: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).checkActiveFixerSession(workspace);

    expect(result).toEqual({ kind: 'settled', outcome: 'DIED' });
    expect(workspaceAccessor.recordRatchetSessionEnd).toHaveBeenCalledWith(
      workspace.id,
      'ratchet-session',
      'DIED'
    );
  });

  it('settles the dispatch as DIED when ratchet session is not found in database', async () => {
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
      ratchetDispatchOutcome: 'RUNNING',
      ratchetDispatchRetryCount: 0,
    };

    vi.mocked(agentSessionAccessor.findById).mockResolvedValue(null);

    const result = await unsafeCoerce<{
      checkActiveFixerSession: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).checkActiveFixerSession(workspace);

    expect(result).toEqual({ kind: 'settled', outcome: 'DIED' });
    expect(workspaceAccessor.recordRatchetSessionEnd).toHaveBeenCalledWith(
      workspace.id,
      'deleted-session',
      'DIED'
    );
  });

  it('reports a concurrent end when another path already settled the dispatch', async () => {
    // Race fix: the session row is gone because the fixer just finished
    // normally and the exit hook settled the record first — the check must
    // not record a death (which would trigger a spurious re-dispatch).
    const workspace = {
      id: 'ws-concurrent-end',
      prUrl: 'https://github.com/example/repo/pull/12',
      prNumber: 12,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_FAILED,
      ratchetActiveSessionId: 'finished-session',
      ratchetLastCiRunId: 'previous-snapshot-key',
      prReviewLastCheckedAt: new Date('2026-01-01T00:00:00Z'),
      ratchetDispatchOutcome: 'RUNNING',
      ratchetDispatchRetryCount: 0,
    };

    vi.mocked(agentSessionAccessor.findById).mockResolvedValue(null);
    vi.mocked(workspaceAccessor.recordRatchetSessionEnd).mockResolvedValue(false);

    const result = await unsafeCoerce<{
      checkActiveFixerSession: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).checkActiveFixerSession(workspace);

    expect(result).toEqual({ kind: 'ended_concurrently' });
  });

  it('waits for the next cycle when the fixer ends concurrently mid-check', async () => {
    const workspace = {
      id: 'ws-concurrent-wait',
      prUrl: 'https://github.com/example/repo/pull/12',
      prNumber: 12,
      prState: 'OPEN',
      prCiStatus: CIStatus.UNKNOWN,
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_FAILED,
      ratchetActiveSessionId: 'finished-session',
      ratchetLastCiRunId: 'previous-snapshot-key',
      prReviewLastCheckedAt: new Date('2026-01-01T00:00:00Z'),
      ratchetDispatchOutcome: 'RUNNING',
      ratchetDispatchRetryCount: 0,
    };

    vi.spyOn(
      unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
      'fetchPRState'
    ).mockResolvedValue({
      ciStatus: CIStatus.FAILURE,
      snapshotKey: 'new-snapshot',
      hasChangesRequested: false,
      latestReviewActivityAtMs: null,
      statusCheckRollup: null,
      prState: 'OPEN',
      prNumber: 12,
    });
    vi.mocked(agentSessionAccessor.findById).mockResolvedValue(null);
    vi.mocked(workspaceAccessor.recordRatchetSessionEnd).mockResolvedValue(false);
    vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

    const result = await unsafeCoerce<{
      processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).processWorkspace(workspace);

    expect(result).toMatchObject({
      action: {
        type: 'WAITING',
        reason: 'Fixer session ended during this check; re-evaluating next cycle',
      },
    });
    expect(fixerSessionService.acquireAndDispatch).not.toHaveBeenCalled();
  });

  it('settles the dispatch as COMPLETED when ratchet session finished its work', async () => {
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
      ratchetDispatchOutcome: 'RUNNING',
      ratchetDispatchRetryCount: 0,
    };

    vi.mocked(agentSessionAccessor.findById).mockResolvedValue({
      id: 'ratchet-session',
      provider: 'CLAUDE',
      status: SessionStatus.RUNNING,
    } as never);
    vi.mocked(mockSessionBridge.isSessionRunning).mockReturnValue(true);
    vi.mocked(mockSessionBridge.isSessionWorking).mockReturnValue(false);
    vi.mocked(mockSessionBridge.stopSession).mockResolvedValue();

    const result = await unsafeCoerce<{
      checkActiveFixerSession: (workspaceArg: typeof workspace) => Promise<unknown>;
    }>(ratchetService).checkActiveFixerSession(workspace);

    expect(result).toEqual({ kind: 'settled', outcome: 'COMPLETED' });
    // Settle before stopping, so the stop's exit hook sees an already-settled
    // record and cannot mark the deliberate stop as DIED.
    expect(workspaceAccessor.recordRatchetSessionEnd).toHaveBeenCalledWith(
      workspace.id,
      'ratchet-session',
      'COMPLETED'
    );
    expect(mockSessionBridge.stopSession).toHaveBeenCalledWith('ratchet-session');
  });

  it('decides to trigger fixer when context is actionable', async () => {
    const decision = await unsafeCoerce<{
      decideRatchetAction: (context: unknown) => Promise<{ type: string }>;
    }>(ratchetService).decideRatchetAction({
      workspace: { id: 'ws-decide', ratchetEnabled: true },
      prStateInfo: { prState: 'OPEN', ciStatus: CIStatus.FAILURE },
      isCleanPrWithNoNewReviewActivity: false,
      activeFixerCheck: { kind: 'none' },
      dispatchOutcome: null,
      dispatchRetryCount: 0,
      hasStateChangedSinceLastDispatch: true,
    });

    expect(decision).toEqual({ type: 'TRIGGER_FIXER', retryCount: 0 });
  });

  it('waits when CI is not in terminal state (PENDING)', async () => {
    const decision = await unsafeCoerce<{
      decideRatchetAction: (context: unknown) => Promise<{
        type: string;
        action?: { type: string; reason: string };
      }>;
    }>(ratchetService).decideRatchetAction({
      workspace: { id: 'ws-decide', ratchetEnabled: true },
      prStateInfo: { prState: 'OPEN', ciStatus: CIStatus.PENDING },
      isCleanPrWithNoNewReviewActivity: false,
      activeFixerCheck: { kind: 'none' },
      dispatchOutcome: null,
      dispatchRetryCount: 0,
      hasStateChangedSinceLastDispatch: true,
    });

    expect(decision).toEqual({
      type: 'RETURN_ACTION',
      action: { type: 'WAITING', reason: 'Waiting for CI to complete (not in terminal state)' },
    });
  });

  it('waits when CI is not in terminal state (UNKNOWN)', async () => {
    const decision = await unsafeCoerce<{
      decideRatchetAction: (context: unknown) => Promise<{
        type: string;
        action?: { type: string; reason: string };
      }>;
    }>(ratchetService).decideRatchetAction({
      workspace: { id: 'ws-decide', ratchetEnabled: true },
      prStateInfo: { prState: 'OPEN', ciStatus: CIStatus.UNKNOWN },
      isCleanPrWithNoNewReviewActivity: false,
      activeFixerCheck: { kind: 'none' },
      dispatchOutcome: null,
      dispatchRetryCount: 0,
      hasStateChangedSinceLastDispatch: true,
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
      ratchetDispatchOutcome: null,
      ratchetDispatchRetryCount: 0,
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

    const logContext = buildRatchetingLogContext({
      workspace: workspace as never,
      previousState: RatchetState.READY,
      newState: RatchetState.READY,
      action: { type: 'WAITING', reason: 'noop' },
      prStateInfo: prStateInfo as never,
      prNumber: 10,
      decisionContext: { hasNewReviewActivitySinceLastDispatch: true } as never,
    });

    expect(logContext.reviewTimestampComparison?.hasNewReviewActivitySinceLastDispatch).toBe(true);
  });

  it('ignores review activity authored by the authenticated user', () => {
    const latestActivity = computeLatestReviewActivityAtMs(
      {
        reviews: [
          {
            submittedAt: '2026-01-02T00:00:00Z',
            author: { login: 'ratchet-bot' },
            state: 'CHANGES_REQUESTED',
          },
          {
            submittedAt: '2026-01-01T00:00:00Z',
            author: { login: 'reviewer' },
            state: 'CHANGES_REQUESTED',
          },
        ],
        comments: [{ updatedAt: '2026-01-02T01:00:00Z', author: { login: 'ratchet-bot' } }],
      },
      [{ updatedAt: '2026-01-01T02:00:00Z', author: { login: 'reviewer2' } }],
      'ratchet-bot',
      'CHANGES_REQUESTED'
    );

    expect(latestActivity).toBe(new Date('2026-01-01T02:00:00Z').getTime());
  });

  describe('determineRatchetState', () => {
    const callDetermineRatchetState = (pr: unknown) =>
      determineRatchetState(pr as Parameters<typeof determineRatchetState>[0]);

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
      computeDispatchSnapshotKey(
        123,
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
      reviews: Array<{
        submittedAt: string | null;
        author: { login: string };
        state?: string;
      }>;
      comments: Array<{ updatedAt: string; author: { login: string } }>;
    };
    type ReviewComment = { updatedAt: string; author: { login: string } };

    const callCompute = (
      prDetails: PRDetails,
      reviewComments: ReviewComment[],
      authenticatedUsername: string | null
    ) =>
      computeLatestReviewActivityAtMs(
        prDetails,
        reviewComments,
        authenticatedUsername,
        'CHANGES_REQUESTED'
      );

    it('returns null when there are no reviews or comments', () => {
      expect(callCompute({ reviews: [], comments: [] }, [], null)).toBeNull();
    });

    it('returns null when all activity is from the authenticated user', () => {
      expect(
        callCompute(
          {
            reviews: [
              {
                submittedAt: '2026-01-01T00:00:00Z',
                author: { login: 'me' },
                state: 'CHANGES_REQUESTED',
              },
            ],
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
          reviews: [
            {
              submittedAt: '2026-01-01T00:00:00Z',
              author: { login: 'bot' },
              state: 'CHANGES_REQUESTED',
            },
          ],
          comments: [],
        },
        [],
        null
      );
      expect(result).toBe(new Date('2026-01-01T00:00:00Z').getTime());
    });

    it('ignores reviews with null submittedAt and ordinary PR comments', () => {
      const result = callCompute(
        {
          reviews: [
            {
              submittedAt: null,
              author: { login: 'reviewer' },
              state: 'CHANGES_REQUESTED',
            },
          ],
          comments: [{ updatedAt: '2026-01-02T00:00:00Z', author: { login: 'commenter' } }],
        },
        [],
        null
      );
      expect(result).toBeNull();
    });

    it('returns the latest timestamp across all sources', () => {
      const result = callCompute(
        {
          reviews: [
            {
              submittedAt: '2026-01-01T00:00:00Z',
              author: { login: 'a' },
              state: 'CHANGES_REQUESTED',
            },
          ],
          comments: [{ updatedAt: '2026-01-03T00:00:00Z', author: { login: 'b' } }],
        },
        [{ updatedAt: '2026-01-02T00:00:00Z', author: { login: 'c' } }],
        null
      );
      expect(result).toBe(new Date('2026-01-02T00:00:00Z').getTime());
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
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
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

    it('returns WAITING action when fetchPRState skips a recent fetch', async () => {
      const workspace = {
        id: 'ws-recent-fetch',
        prUrl: 'https://github.com/example/repo/pull/99',
        prNumber: 99,
        ratchetEnabled: true,
        ratchetState: RatchetState.IDLE,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
      };

      vi.spyOn(
        unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
        'fetchPRState'
      ).mockResolvedValue({ skipped: true, reason: 'recently_fetched' });

      const result = await unsafeCoerce<{
        processWorkspace: (workspaceArg: typeof workspace) => Promise<unknown>;
      }>(ratchetService).processWorkspace(workspace);

      expect(result).toMatchObject({
        action: { type: 'WAITING', reason: 'recently_fetched' },
        newState: RatchetState.IDLE,
      });
      expect(workspaceAccessor.update).not.toHaveBeenCalled();
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
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
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
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
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
          ratchetDispatchOutcome: null,
          ratchetDispatchRetryCount: 0,
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
          ratchetDispatchOutcome: null,
          ratchetDispatchRetryCount: 0,
        },
      ] as never);

      vi.spyOn(
        unsafeCoerce<{
          processWorkspace: (
            workspaceArg: { id: string },
            opts: unknown,
            signal: AbortSignal
          ) => Promise<unknown>;
        }>(ratchetService),
        'processWorkspace'
      ).mockImplementation((workspace, _opts, signal) => {
        if (workspace.id === 'ws-timeout') {
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
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

    it('does not count concurrency queue wait toward the workspace timeout', async () => {
      unsafeCoerce<{ workspaceCheckTimeoutMs: number }>(ratchetService).workspaceCheckTimeoutMs = 5;
      const workspaces = Array.from({ length: 4 }, (_, index) => ({
        id: `ws-queued-timeout-${index}`,
        prUrl: `https://github.com/example/repo/pull/${index + 1}`,
        prNumber: index + 1,
        prState: 'OPEN',
        prCiStatus: CIStatus.UNKNOWN,
        defaultSessionProvider: 'WORKSPACE_DEFAULT',
        ratchetSessionProvider: 'WORKSPACE_DEFAULT',
        ratchetEnabled: true,
        ratchetState: RatchetState.IDLE,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
      }));
      vi.mocked(workspaceAccessor.findWithPRsForRatchet).mockResolvedValue(workspaces as never);
      const processWorkspaceSpy = vi.spyOn(
        unsafeCoerce<{
          processWorkspace: (
            workspace: (typeof workspaces)[number],
            opts: unknown,
            signal: AbortSignal
          ) => Promise<WorkspaceRatchetResult>;
        }>(ratchetService),
        'processWorkspace'
      );
      processWorkspaceSpy.mockImplementation((workspace, _opts, signal) => {
        if (workspace.id !== 'ws-queued-timeout-3') {
          return new Promise<WorkspaceRatchetResult>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        return Promise.resolve({
          workspaceId: workspace.id,
          previousState: RatchetState.IDLE,
          newState: RatchetState.IDLE,
          action: { type: 'WAITING', reason: 'ran after queue' },
        });
      });

      const result = await ratchetService.checkAllWorkspaces();

      expect(processWorkspaceSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ws-queued-timeout-3' }),
        undefined,
        expect.any(AbortSignal),
        expect.any(Function)
      );
      expect(result.results[3]).toMatchObject({
        workspaceId: 'ws-queued-timeout-3',
        action: { type: 'WAITING', reason: 'ran after queue' },
      });
    });

    it('lets a committed dispatch finish instead of reporting a timeout error', async () => {
      unsafeCoerce<{ workspaceCheckTimeoutMs: number }>(ratchetService).workspaceCheckTimeoutMs = 5;
      const workspace = {
        id: 'ws-committed-dispatch',
        prUrl: 'https://github.com/example/repo/pull/1',
        prNumber: 1,
        ratchetEnabled: true,
        ratchetState: RatchetState.IDLE,
      };
      vi.mocked(workspaceAccessor.findWithPRsForRatchet).mockResolvedValue([workspace] as never);
      let finishCommit!: () => void;
      const commitBarrier = new Promise<void>((resolve) => {
        finishCommit = resolve;
      });
      vi.spyOn(
        unsafeCoerce<{
          processWorkspace: (
            workspaceArg: typeof workspace,
            opts: unknown,
            signal: AbortSignal,
            commitSideEffects: () => void
          ) => Promise<WorkspaceRatchetResult>;
        }>(ratchetService),
        'processWorkspace'
      ).mockImplementation(async (workspaceArg, _opts, signal, commitSideEffects) => {
        commitSideEffects();
        await commitBarrier;
        signal.throwIfAborted();
        return {
          workspaceId: workspaceArg.id,
          previousState: RatchetState.IDLE,
          newState: RatchetState.IDLE,
          action: { type: 'TRIGGERED_FIXER', sessionId: 'session-1', promptSent: true },
        };
      });

      const resultPromise = ratchetService.checkAllWorkspaces();
      await new Promise((resolve) => setTimeout(resolve, 10));
      finishCommit();
      const result = await resultPromise;

      expect(result.results[0]).toMatchObject({
        workspaceId: workspace.id,
        action: { type: 'TRIGGERED_FIXER', sessionId: 'session-1' },
      });
    });

    it('runs at most three workspace checks concurrently', async () => {
      const workspaces = Array.from({ length: 7 }, (_, index) => ({
        id: `ws-${index}`,
        prUrl: `https://github.com/example/repo/pull/${index + 1}`,
        prNumber: index + 1,
        prState: 'OPEN',
        prCiStatus: CIStatus.UNKNOWN,
        defaultSessionProvider: 'WORKSPACE_DEFAULT',
        ratchetSessionProvider: 'WORKSPACE_DEFAULT',
        ratchetEnabled: true,
        ratchetState: RatchetState.IDLE,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
      }));
      vi.mocked(workspaceAccessor.findWithPRsForRatchet).mockResolvedValue(workspaces as never);
      let active = 0;
      let maximumActive = 0;
      let releaseChecks!: () => void;
      const checkBarrier = new Promise<void>((resolve) => {
        releaseChecks = resolve;
      });
      vi.spyOn(
        unsafeCoerce<{
          processWorkspace: (workspace: (typeof workspaces)[number]) => Promise<unknown>;
        }>(ratchetService),
        'processWorkspace'
      ).mockImplementation(async (workspace) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await checkBarrier;
        active -= 1;
        return {
          workspaceId: workspace.id,
          previousState: RatchetState.IDLE,
          newState: RatchetState.IDLE,
          action: { type: 'WAITING', reason: 'noop' },
        };
      });

      const resultPromise = ratchetService.checkAllWorkspaces();
      await vi.waitFor(() => expect(active).toBe(3));
      expect(maximumActive).toBe(3);
      releaseChecks();
      const result = await resultPromise;

      expect(maximumActive).toBe(3);
      expect(result.checked).toBe(7);
      expect(result.results).toHaveLength(7);
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

  describe('markPrClosed', () => {
    afterEach(() => {
      ratchetService.removeAllListeners();
    });

    it('resets ratchet state to IDLE via CAS on fromState and emits a state change', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue({
        id: 'ws-closed',
        ratchetEnabled: true,
        ratchetState: RatchetState.CI_FAILED,
      } as never);
      vi.mocked(workspaceAccessor.transitionRatchetStateIfEnabled).mockResolvedValue(true);

      const stateEvents: RatchetStateChangedEvent[] = [];
      ratchetService.on(RATCHET_STATE_CHANGED, (event: RatchetStateChangedEvent) => {
        stateEvents.push(event);
      });

      await ratchetService.markPrClosed('ws-closed');

      expect(workspaceAccessor.transitionRatchetStateIfEnabled).toHaveBeenCalledWith(
        'ws-closed',
        RatchetState.CI_FAILED,
        {
          ratchetState: RatchetState.IDLE,
          ratchetLastCheckedAt: expect.any(Date),
        }
      );
      expect(stateEvents).toEqual([
        {
          workspaceId: 'ws-closed',
          fromState: RatchetState.CI_FAILED,
          toState: RatchetState.IDLE,
        },
      ]);
    });

    it('emits the fromState that actually won the compare-and-swap after losing a race', async () => {
      vi.mocked(workspaceAccessor.findById)
        .mockResolvedValueOnce({
          id: 'ws-closed',
          ratchetEnabled: true,
          ratchetState: RatchetState.CI_FAILED,
        } as never)
        .mockResolvedValueOnce({
          id: 'ws-closed',
          ratchetEnabled: true,
          ratchetState: RatchetState.CI_RUNNING,
        } as never);
      vi.mocked(workspaceAccessor.transitionRatchetStateIfEnabled)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      const stateEvents: RatchetStateChangedEvent[] = [];
      ratchetService.on(RATCHET_STATE_CHANGED, (event: RatchetStateChangedEvent) => {
        stateEvents.push(event);
      });

      await ratchetService.markPrClosed('ws-closed');

      expect(workspaceAccessor.transitionRatchetStateIfEnabled).toHaveBeenNthCalledWith(
        1,
        'ws-closed',
        RatchetState.CI_FAILED,
        expect.objectContaining({ ratchetState: RatchetState.IDLE })
      );
      expect(workspaceAccessor.transitionRatchetStateIfEnabled).toHaveBeenNthCalledWith(
        2,
        'ws-closed',
        RatchetState.CI_RUNNING,
        expect.objectContaining({ ratchetState: RatchetState.IDLE })
      );
      expect(stateEvents).toEqual([
        {
          workspaceId: 'ws-closed',
          fromState: RatchetState.CI_RUNNING,
          toState: RatchetState.IDLE,
        },
      ]);
    });

    it('is a no-op when ratchet state is already IDLE', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue({
        id: 'ws-closed',
        ratchetEnabled: true,
        ratchetState: RatchetState.IDLE,
      } as never);

      await ratchetService.markPrClosed('ws-closed');

      expect(workspaceAccessor.transitionRatchetStateIfEnabled).not.toHaveBeenCalled();
    });

    it('does not emit when ratcheting was disabled concurrently', async () => {
      vi.mocked(workspaceAccessor.findById)
        .mockResolvedValueOnce({
          id: 'ws-closed',
          ratchetEnabled: true,
          ratchetState: RatchetState.CI_FAILED,
        } as never)
        .mockResolvedValueOnce({
          id: 'ws-closed',
          ratchetEnabled: false,
          ratchetState: RatchetState.IDLE,
        } as never);
      vi.mocked(workspaceAccessor.transitionRatchetStateIfEnabled).mockResolvedValue(false);

      const stateEvents: RatchetStateChangedEvent[] = [];
      ratchetService.on(RATCHET_STATE_CHANGED, (event: RatchetStateChangedEvent) => {
        stateEvents.push(event);
      });

      await ratchetService.markPrClosed('ws-closed');

      expect(stateEvents).toEqual([]);
    });

    it('is a no-op when workspace is not found', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue(null);

      await ratchetService.markPrClosed('ws-missing');

      expect(workspaceAccessor.transitionRatchetStateIfEnabled).not.toHaveBeenCalled();
    });

    it('does not continue to side effects after a timed-out await completes', async () => {
      unsafeCoerce<{ workspaceCheckTimeoutMs: number }>(ratchetService).workspaceCheckTimeoutMs = 5;
      const workspace = {
        id: 'ws-zombie',
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
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
      };
      vi.mocked(workspaceAccessor.findWithPRsForRatchet).mockResolvedValue([workspace] as never);
      let releaseFetch!: () => void;
      const fetchBarrier = new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      const finishSpy = vi.spyOn(
        unsafeCoerce<{ finishRatchetCheck: (...args: unknown[]) => Promise<unknown> }>(
          ratchetService
        ),
        'finishRatchetCheck'
      );
      vi.spyOn(
        unsafeCoerce<{ fetchPRState: (...args: unknown[]) => Promise<unknown> }>(ratchetService),
        'fetchPRState'
      ).mockImplementation(async () => {
        await fetchBarrier;
        return {
          ciStatus: CIStatus.FAILURE,
          snapshotKey: 'failed:1',
          hasChangesRequested: false,
          hasMergeConflict: false,
          latestReviewActivityAtMs: null,
          statusCheckRollup: [],
          prState: 'OPEN',
          prNumber: 1,
          reviewComments: [],
        };
      });

      const result = await ratchetService.checkAllWorkspaces();
      expect(result.results[0]?.action.type).toBe('ERROR');
      releaseFetch();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(finishSpy).not.toHaveBeenCalled();
      expect(workspaceAccessor.transitionRatchetStateIfEnabled).not.toHaveBeenCalled();
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

    it('skips the PR fetch when the workspace was recently fetched', async () => {
      const workspace = {
        id: 'ws-cooldown',
        prUrl: 'https://github.com/example/repo/pull/9',
        prNumber: 9,
        prState: 'OPEN',
        prCiStatus: CIStatus.UNKNOWN,
        ratchetEnabled: true,
        ratchetState: RatchetState.CI_RUNNING,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
      };
      vi.mocked(workspaceAccessor.findForRatchetById).mockResolvedValue(workspace as never);
      vi.mocked(mockGitHubBridge.extractPRInfo).mockReturnValue({
        owner: 'example',
        repo: 'repo',
        number: 9,
      });
      vi.mocked(mockGitHubBridge.isRecentlyFetched).mockReturnValue(true);

      const result = await ratchetService.checkWorkspaceById('ws-cooldown');

      expect(result?.action).toEqual({ type: 'WAITING', reason: 'recently_fetched' });
      expect(mockGitHubBridge.getPRFullDetails).not.toHaveBeenCalled();
    });

    it('bypasses the PR fetch cooldown when requested by an event-driven check', async () => {
      const workspace = {
        id: 'ws-bypass',
        prUrl: 'https://github.com/example/repo/pull/9',
        prNumber: 9,
        prState: 'OPEN',
        prCiStatus: CIStatus.UNKNOWN,
        defaultSessionProvider: 'WORKSPACE_DEFAULT',
        ratchetSessionProvider: 'WORKSPACE_DEFAULT',
        ratchetEnabled: true,
        ratchetState: RatchetState.CI_RUNNING,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
      };
      vi.mocked(workspaceAccessor.findForRatchetById).mockResolvedValue(workspace as never);
      vi.mocked(mockGitHubBridge.extractPRInfo).mockReturnValue({
        owner: 'example',
        repo: 'repo',
        number: 9,
      });
      vi.mocked(mockGitHubBridge.isRecentlyFetched).mockReturnValue(true);
      vi.mocked(mockGitHubBridge.getPRFullDetails).mockResolvedValue({
        state: 'OPEN',
        number: 9,
        url: 'https://github.com/example/repo/pull/9',
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        reviews: [],
        comments: [],
        statusCheckRollup: null,
      });
      vi.mocked(mockGitHubBridge.getReviewComments).mockResolvedValue([]);
      vi.mocked(mockGitHubBridge.computeCIStatus).mockReturnValue(CIStatus.SUCCESS);

      const result = await ratchetService.checkWorkspaceById('ws-bypass', {
        bypassPrFetchCooldown: true,
      });

      expect(mockGitHubBridge.getPRFullDetails).toHaveBeenCalledWith(
        'example/repo',
        9,
        expect.any(AbortSignal)
      );
      expect(result?.newState).toBe(RatchetState.READY);
      expect(result?.action).not.toEqual({ type: 'WAITING', reason: 'recently_fetched' });
    });

    it('reruns a bypassed check once when the first attempt was dedup-skipped', async () => {
      const workspace = {
        id: 'ws-rerun',
        prUrl: 'https://github.com/example/repo/pull/9',
        prNumber: 9,
        prState: 'OPEN',
        prCiStatus: CIStatus.UNKNOWN,
        defaultSessionProvider: 'WORKSPACE_DEFAULT',
        ratchetSessionProvider: 'WORKSPACE_DEFAULT',
        ratchetEnabled: true,
        ratchetState: RatchetState.CI_RUNNING,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
      };
      vi.mocked(workspaceAccessor.findForRatchetById).mockResolvedValue(workspace as never);
      vi.mocked(mockGitHubBridge.extractPRInfo).mockReturnValue({
        owner: 'example',
        repo: 'repo',
        number: 9,
      });
      // A concurrent fetch is in flight during the first attempt and has
      // settled by the rerun.
      vi.mocked(mockGitHubBridge.isFetchInFlight).mockReturnValueOnce(true).mockReturnValue(false);
      vi.mocked(mockGitHubBridge.getPRFullDetails).mockResolvedValue({
        state: 'OPEN',
        number: 9,
        url: 'https://github.com/example/repo/pull/9',
        reviewDecision: null,
        mergeStateStatus: 'CLEAN',
        reviews: [],
        comments: [],
        statusCheckRollup: null,
      });
      vi.mocked(mockGitHubBridge.getReviewComments).mockResolvedValue([]);
      vi.mocked(mockGitHubBridge.computeCIStatus).mockReturnValue(CIStatus.SUCCESS);

      const result = await ratchetService.checkWorkspaceById('ws-rerun', {
        bypassPrFetchCooldown: true,
      });

      expect(mockGitHubBridge.getPRFullDetails).toHaveBeenCalledTimes(1);
      expect(result?.newState).toBe(RatchetState.READY);
      expect(result?.action).not.toEqual({ type: 'WAITING', reason: 'recently_fetched' });
    });

    it('does not rerun a bypassed check more than once', async () => {
      const workspace = {
        id: 'ws-rerun-cap',
        prUrl: 'https://github.com/example/repo/pull/9',
        prNumber: 9,
        prState: 'OPEN',
        prCiStatus: CIStatus.UNKNOWN,
        ratchetEnabled: true,
        ratchetState: RatchetState.CI_RUNNING,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
      };
      vi.mocked(workspaceAccessor.findForRatchetById).mockResolvedValue(workspace as never);
      vi.mocked(mockGitHubBridge.extractPRInfo).mockReturnValue({
        owner: 'example',
        repo: 'repo',
        number: 9,
      });
      // The concurrent fetch never settles: both attempts skip, no third try.
      vi.mocked(mockGitHubBridge.isFetchInFlight).mockReturnValue(true);

      const result = await ratchetService.checkWorkspaceById('ws-rerun-cap', {
        bypassPrFetchCooldown: true,
      });

      expect(result?.action).toEqual({ type: 'WAITING', reason: 'recently_fetched' });
      expect(mockGitHubBridge.isFetchInFlight).toHaveBeenCalledTimes(2);
      expect(mockGitHubBridge.getPRFullDetails).not.toHaveBeenCalled();
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
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
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

      await vi.waitFor(() => expect(processWorkspaceSpy).toHaveBeenCalledTimes(1));
      expect(processWorkspaceSpy).toHaveBeenCalledTimes(1);

      releaseCheck();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toEqual(result);
      expect(secondResult).toEqual(result);
      expect(processWorkspaceSpy).toHaveBeenCalledTimes(1);
    });

    it('deduplicates a same-workspace check before it enters the concurrency queue', async () => {
      const makeWorkspace = (id: string) => ({
        id,
        prUrl: `https://github.com/example/repo/pull/${id}`,
        prNumber: 1,
        ratchetEnabled: true,
        ratchetState: RatchetState.IDLE,
      });
      const workspaces = [
        makeWorkspace('blocker-1'),
        makeWorkspace('blocker-2'),
        makeWorkspace('blocker-3'),
        makeWorkspace('queued-target'),
      ];
      vi.mocked(workspaceAccessor.findWithPRsForRatchet).mockResolvedValue(workspaces as never);
      vi.mocked(workspaceAccessor.findForRatchetById).mockResolvedValue(workspaces[3] as never);
      let releaseBlockers!: () => void;
      const blockerBarrier = new Promise<void>((resolve) => {
        releaseBlockers = resolve;
      });
      let activeBlockers = 0;
      let targetRuns = 0;
      vi.spyOn(
        unsafeCoerce<{
          processWorkspace: (workspace: { id: string }) => Promise<WorkspaceRatchetResult>;
        }>(ratchetService),
        'processWorkspace'
      ).mockImplementation(async (workspace) => {
        if (workspace.id.startsWith('blocker-')) {
          activeBlockers += 1;
          await blockerBarrier;
        } else {
          targetRuns += 1;
        }
        return {
          workspaceId: workspace.id,
          previousState: RatchetState.IDLE,
          newState: RatchetState.IDLE,
          action: { type: 'WAITING', reason: 'noop' },
        };
      });

      const batch = ratchetService.checkAllWorkspaces();
      await vi.waitFor(() => expect(activeBlockers).toBe(3));
      const direct = ratchetService.checkWorkspaceById('queued-target');
      await Promise.resolve();
      expect(targetRuns).toBe(0);

      releaseBlockers();
      const [batchResult, directResult] = await Promise.all([batch, direct]);

      expect(targetRuns).toBe(1);
      expect(directResult).toEqual(batchResult.results[3]);
    });

    it('keeps a limiter slot occupied until a timed-out runner finishes cleanup', async () => {
      unsafeCoerce<{ workspaceCheckTimeoutMs: number }>(ratchetService).workspaceCheckTimeoutMs = 5;
      const makeWorkspace = (id: string) => ({
        id,
        prUrl: `https://github.com/example/repo/pull/${id}`,
        prNumber: 1,
        ratchetEnabled: true,
        ratchetState: RatchetState.IDLE,
      });
      const workspaces = [
        makeWorkspace('timed-out-1'),
        makeWorkspace('timed-out-2'),
        makeWorkspace('timed-out-3'),
        makeWorkspace('after-timeouts'),
      ];
      vi.mocked(workspaceAccessor.findWithPRsForRatchet).mockResolvedValue(workspaces as never);
      let finishCleanup!: () => void;
      const cleanupBarrier = new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
      let activeTimedOutChecks = 0;
      let targetRuns = 0;
      vi.spyOn(
        unsafeCoerce<{
          processWorkspace: (
            workspace: { id: string },
            opts: unknown,
            signal: AbortSignal
          ) => Promise<WorkspaceRatchetResult>;
        }>(ratchetService),
        'processWorkspace'
      ).mockImplementation(async (workspace, _opts, signal) => {
        if (workspace.id.startsWith('timed-out-')) {
          activeTimedOutChecks += 1;
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          await cleanupBarrier;
          signal.throwIfAborted();
        }
        targetRuns += workspace.id === 'after-timeouts' ? 1 : 0;
        return {
          workspaceId: workspace.id,
          previousState: RatchetState.IDLE,
          newState: RatchetState.IDLE,
          action: { type: 'WAITING', reason: 'noop' },
        };
      });

      const batch = ratchetService.checkAllWorkspaces();
      await vi.waitFor(() => expect(activeTimedOutChecks).toBe(3));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(targetRuns).toBe(0);

      finishCleanup();
      await batch;
      expect(targetRuns).toBe(1);
    });

    it('runs a direct workspace check without waiting for the batch limiter', async () => {
      const makeWorkspace = (id: string) => ({
        id,
        prUrl: `https://github.com/example/repo/pull/${id}`,
        prNumber: 1,
        ratchetEnabled: true,
        ratchetState: RatchetState.IDLE,
      });
      const batchWorkspaces = [
        makeWorkspace('batch-blocker-1'),
        makeWorkspace('batch-blocker-2'),
        makeWorkspace('batch-blocker-3'),
      ];
      const directWorkspace = makeWorkspace('direct-target');
      vi.mocked(workspaceAccessor.findWithPRsForRatchet).mockResolvedValue(
        batchWorkspaces as never
      );
      vi.mocked(workspaceAccessor.findForRatchetById).mockResolvedValue(directWorkspace as never);
      let releaseBatch!: () => void;
      const batchBarrier = new Promise<void>((resolve) => {
        releaseBatch = resolve;
      });
      let activeBatchChecks = 0;
      let directRuns = 0;
      vi.spyOn(
        unsafeCoerce<{
          processWorkspace: (workspace: { id: string }) => Promise<WorkspaceRatchetResult>;
        }>(ratchetService),
        'processWorkspace'
      ).mockImplementation(async (workspace) => {
        if (workspace.id.startsWith('batch-blocker-')) {
          activeBatchChecks += 1;
          await batchBarrier;
        } else {
          directRuns += 1;
        }
        return {
          workspaceId: workspace.id,
          previousState: RatchetState.IDLE,
          newState: RatchetState.IDLE,
          action: { type: 'WAITING', reason: 'noop' },
        };
      });

      const batch = ratchetService.checkAllWorkspaces();
      await vi.waitFor(() => expect(activeBatchChecks).toBe(3));

      const directResult = await ratchetService.checkWorkspaceById(directWorkspace.id);
      expect(directRuns).toBe(1);
      expect(directResult?.workspaceId).toBe(directWorkspace.id);

      releaseBatch();
      await batch;
    });
  });

  describe('decideRatchetAction edge cases', () => {
    const callDecide = (context: unknown) =>
      unsafeCoerce<{ decideRatchetAction: (ctx: unknown) => Promise<unknown> }>(
        ratchetService
      ).decideRatchetAction(context);

    const arrangeOtherWorkingSession = () => {
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([
        { id: 'other-session' },
      ] as never);
      vi.mocked(mockSessionBridge.isSessionWorking).mockReturnValue(true);
    };

    it('returns COMPLETED for merged PR', async () => {
      expect(
        await callDecide({
          workspace: { id: 'ws-decide', ratchetEnabled: true },
          prStateInfo: { prState: 'MERGED', ciStatus: CIStatus.SUCCESS },
          isCleanPrWithNoNewReviewActivity: false,
          activeFixerCheck: { kind: 'none' },
          dispatchOutcome: null,
          dispatchRetryCount: 0,
          hasStateChangedSinceLastDispatch: true,
        })
      ).toEqual({ type: 'RETURN_ACTION', action: { type: 'COMPLETED' } });
    });

    it('returns WAITING for non-open PR', async () => {
      const result = (await callDecide({
        workspace: { id: 'ws-decide', ratchetEnabled: true },
        prStateInfo: { prState: 'CLOSED', ciStatus: CIStatus.SUCCESS },
        isCleanPrWithNoNewReviewActivity: false,
        activeFixerCheck: { kind: 'none' },
        dispatchOutcome: null,
        dispatchRetryCount: 0,
        hasStateChangedSinceLastDispatch: true,
      })) as { type: string; action?: { reason: string } };
      expect(result.action?.reason).toBe('PR is not open');
    });

    it('returns active session when one exists', async () => {
      const activeSession = { type: 'FIXER_ACTIVE', sessionId: 's-1' };
      const result = (await callDecide({
        workspace: { id: 'ws-decide', ratchetEnabled: true },
        prStateInfo: { prState: 'OPEN', ciStatus: CIStatus.FAILURE },
        isCleanPrWithNoNewReviewActivity: false,
        activeFixerCheck: { kind: 'active', action: activeSession },
        dispatchOutcome: 'RUNNING',
        dispatchRetryCount: 0,
        hasStateChangedSinceLastDispatch: true,
      })) as { type: string; action: unknown };
      expect(result.action).toEqual(activeSession);
    });

    it('returns WAITING when other active session blocks dispatch', async () => {
      arrangeOtherWorkingSession();
      const result = (await callDecide({
        workspace: { id: 'ws-decide', ratchetEnabled: true },
        prStateInfo: { prState: 'OPEN', ciStatus: CIStatus.FAILURE },
        isCleanPrWithNoNewReviewActivity: false,
        activeFixerCheck: { kind: 'none' },
        dispatchOutcome: null,
        dispatchRetryCount: 0,
        hasStateChangedSinceLastDispatch: true,
      })) as { type: string; action?: { reason: string } };
      expect(result.action?.reason).toBe('Workspace has another working session');
    });

    it('returns WAITING when there are no CI failures or PR review comments', async () => {
      const result = (await callDecide({
        workspace: { id: 'ws-decide', ratchetEnabled: true },
        prStateInfo: {
          prState: 'OPEN',
          ciStatus: CIStatus.SUCCESS,
          reviewComments: [],
        },
        isCleanPrWithNoNewReviewActivity: false,
        activeFixerCheck: { kind: 'none' },
        dispatchOutcome: null,
        dispatchRetryCount: 0,
        hasStateChangedSinceLastDispatch: true,
      })) as { type: string; action?: { reason: string } };
      expect(result.action?.reason).toBe('No CI failures or PR review comments to address');
    });

    it('waits when the fixer ended concurrently during the check', async () => {
      const result = (await callDecide({
        workspace: { id: 'ws-decide', ratchetEnabled: true },
        prStateInfo: { prState: 'OPEN', ciStatus: CIStatus.FAILURE },
        isCleanPrWithNoNewReviewActivity: false,
        activeFixerCheck: { kind: 'ended_concurrently' },
        dispatchOutcome: 'COMPLETED',
        dispatchRetryCount: 0,
        hasStateChangedSinceLastDispatch: false,
      })) as { type: string; action?: { reason: string } };
      expect(result.action?.reason).toBe(
        'Fixer session ended during this check; re-evaluating next cycle'
      );
    });

    it('retries a died fixer ahead of the unchanged-state gate', async () => {
      const result = await callDecide({
        workspace: { id: 'ws-decide', ratchetEnabled: true },
        prStateInfo: { prState: 'OPEN', ciStatus: CIStatus.FAILURE },
        isCleanPrWithNoNewReviewActivity: false,
        activeFixerCheck: { kind: 'settled', outcome: 'DIED' },
        dispatchOutcome: 'DIED',
        dispatchRetryCount: 2,
        hasStateChangedSinceLastDispatch: false,
      });
      expect(result).toEqual({ type: 'TRIGGER_FIXER', retryCount: 3 });
    });

    it('does not retry a died fixer while another session is working', async () => {
      arrangeOtherWorkingSession();
      const result = (await callDecide({
        workspace: { id: 'ws-decide', ratchetEnabled: true },
        prStateInfo: { prState: 'OPEN', ciStatus: CIStatus.FAILURE },
        isCleanPrWithNoNewReviewActivity: false,
        activeFixerCheck: { kind: 'settled', outcome: 'DIED' },
        dispatchOutcome: 'DIED',
        dispatchRetryCount: 0,
        hasStateChangedSinceLastDispatch: false,
      })) as { type: string; action?: { reason: string } };
      expect(result.action?.reason).toBe('Workspace has another working session');
    });

    it('gives up on a died fixer once the retry budget is spent', async () => {
      const result = (await callDecide({
        workspace: { id: 'ws-decide', ratchetEnabled: true },
        prStateInfo: { prState: 'OPEN', ciStatus: CIStatus.FAILURE },
        isCleanPrWithNoNewReviewActivity: false,
        activeFixerCheck: { kind: 'none' },
        dispatchOutcome: 'DIED',
        dispatchRetryCount: 3,
        hasStateChangedSinceLastDispatch: false,
      })) as { type: string; action?: { reason: string } };
      expect(result.action?.reason).toBe(
        'Fixer died 4 times for this PR state; waiting for PR state to change'
      );
    });
  });

  describe('checkActiveFixerSession edge cases', () => {
    const callCheckActiveFixerSession = (workspace: unknown) =>
      unsafeCoerce<{
        checkActiveFixerSession: (w: unknown) => Promise<unknown>;
      }>(ratchetService).checkActiveFixerSession(workspace);

    it('returns none when ratchetActiveSessionId is null', async () => {
      const result = await callCheckActiveFixerSession({
        id: 'ws-1',
        ratchetActiveSessionId: null,
      });
      expect(result).toEqual({ kind: 'none' });
    });

    it('settles a non-RUNNING session as COMPLETED when its status is not FAILED', async () => {
      vi.mocked(agentSessionAccessor.findById).mockResolvedValue({
        id: 'completed-session',
        provider: 'CLAUDE',
        status: SessionStatus.IDLE,
      } as never);

      const result = await callCheckActiveFixerSession({
        id: 'ws-3',
        ratchetActiveSessionId: 'completed-session',
      });

      expect(result).toEqual({ kind: 'settled', outcome: 'COMPLETED' });
      expect(workspaceAccessor.recordRatchetSessionEnd).toHaveBeenCalledWith(
        'ws-3',
        'completed-session',
        'COMPLETED'
      );
    });

    it('settles a FAILED session as DIED', async () => {
      vi.mocked(agentSessionAccessor.findById).mockResolvedValue({
        id: 'failed-session',
        provider: 'CLAUDE',
        status: SessionStatus.FAILED,
      } as never);

      const result = await callCheckActiveFixerSession({
        id: 'ws-4',
        ratchetActiveSessionId: 'failed-session',
      });

      expect(result).toEqual({ kind: 'settled', outcome: 'DIED' });
      expect(workspaceAccessor.recordRatchetSessionEnd).toHaveBeenCalledWith(
        'ws-4',
        'failed-session',
        'DIED'
      );
    });

    it('settles a provider-mismatched session as DIED and stops it', async () => {
      vi.mocked(agentSessionAccessor.findById).mockResolvedValue({
        id: 'codex-session',
        provider: 'CODEX',
        status: SessionStatus.RUNNING,
      } as never);
      vi.mocked(mockSessionBridge.stopSession).mockResolvedValue();

      const result = await callCheckActiveFixerSession({
        id: 'ws-5',
        ratchetActiveSessionId: 'codex-session',
        defaultSessionProvider: 'WORKSPACE_DEFAULT',
        ratchetSessionProvider: 'WORKSPACE_DEFAULT',
      });

      expect(result).toEqual({ kind: 'settled', outcome: 'DIED' });
      expect(workspaceAccessor.recordRatchetSessionEnd).toHaveBeenCalledWith(
        'ws-5',
        'codex-session',
        'DIED'
      );
      expect(mockSessionBridge.stopSession).toHaveBeenCalledWith('codex-session');
    });

    it('returns the active fixer when the session is working', async () => {
      vi.mocked(agentSessionAccessor.findById).mockResolvedValue({
        id: 'working-session',
        provider: 'CLAUDE',
        status: SessionStatus.RUNNING,
      } as never);
      vi.mocked(mockSessionBridge.isSessionRunning).mockReturnValue(true);
      vi.mocked(mockSessionBridge.isSessionWorking).mockReturnValue(true);

      const result = await callCheckActiveFixerSession({
        id: 'ws-6',
        ratchetActiveSessionId: 'working-session',
      });

      expect(result).toEqual({
        kind: 'active',
        action: { type: 'FIXER_ACTIVE', sessionId: 'working-session' },
      });
      expect(workspaceAccessor.recordRatchetSessionEnd).not.toHaveBeenCalled();
    });

    it('does not settle or stop a fixer after cancellation during session lookup', async () => {
      const controller = new AbortController();
      const timeoutError = new Error('Workspace check timed out');
      let finishLookup!: (value: null) => void;
      vi.mocked(agentSessionAccessor.findById).mockImplementation(
        () =>
          new Promise((resolve) => {
            finishLookup = resolve;
          })
      );

      const check = unsafeCoerce<{
        checkActiveFixerSession: (w: unknown, signal: AbortSignal) => Promise<unknown>;
      }>(ratchetService).checkActiveFixerSession(
        {
          id: 'ws-cancelled-active-check',
          ratchetActiveSessionId: 'session-1',
        },
        controller.signal
      );
      await vi.waitFor(() => expect(agentSessionAccessor.findById).toHaveBeenCalled());
      controller.abort(timeoutError);
      finishLookup(null);

      await expect(check).rejects.toBe(timeoutError);
      expect(workspaceAccessor.recordRatchetSessionEnd).not.toHaveBeenCalled();
      expect(mockSessionBridge.stopSession).not.toHaveBeenCalled();
    });
  });

  describe('triggerFixer error handling', () => {
    it('does not clean up a fixer after its dispatch record is persisted', async () => {
      const controller = new AbortController();
      const timeoutError = new Error('Workspace check timed out');
      let finishRecord!: (value: boolean) => void;
      vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
        status: 'started',
        sessionId: 'cancelled-session',
        promptSent: true,
      });
      vi.mocked(workspaceAccessor.recordRatchetDispatchIfEnabled).mockImplementation(
        () =>
          new Promise((resolve) => {
            finishRecord = resolve;
          })
      );
      vi.mocked(mockSessionBridge.isSessionRunning).mockReturnValue(true);
      const commitSideEffects = vi.fn();

      const trigger = unsafeCoerce<{
        triggerFixer: (
          w: unknown,
          prStateInfo: unknown,
          retryCount: number,
          signal: AbortSignal,
          commitSideEffects: () => void
        ) => Promise<unknown>;
      }>(ratchetService).triggerFixer(
        {
          id: 'ws-cancelled-dispatch',
          prUrl: 'https://github.com/example/repo/pull/20',
        },
        {
          ciStatus: CIStatus.FAILURE,
          snapshotKey: 'failed:20',
          prNumber: 20,
          reviewComments: [],
          hasMergeConflict: false,
        },
        0,
        controller.signal,
        commitSideEffects
      );
      await vi.waitFor(() =>
        expect(workspaceAccessor.recordRatchetDispatchIfEnabled).toHaveBeenCalled()
      );
      controller.abort(timeoutError);
      finishRecord(true);

      await expect(trigger).rejects.toBe(timeoutError);
      expect(commitSideEffects).toHaveBeenCalledTimes(1);
      expect(workspaceAccessor.recordRatchetSessionEnd).not.toHaveBeenCalled();
      expect(mockSessionBridge.stopSession).not.toHaveBeenCalled();
    });

    it('cleans up a started fixer when dispatch persistence fails', async () => {
      vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
        status: 'started',
        sessionId: 'unrecorded-session',
        promptSent: true,
      });
      vi.mocked(workspaceAccessor.recordRatchetDispatchIfEnabled).mockRejectedValue(
        new Error('dispatch record write failed')
      );
      vi.mocked(workspaceAccessor.recordRatchetSessionEnd).mockRejectedValue(
        new Error('dispatch cleanup write failed')
      );
      vi.mocked(mockSessionBridge.isSessionRunning).mockReturnValue(true);
      const commitSideEffects = vi.fn();

      const result = await unsafeCoerce<{
        triggerFixer: (
          w: unknown,
          prStateInfo: unknown,
          retryCount: number,
          signal: AbortSignal,
          commitSideEffects: () => void
        ) => Promise<unknown>;
      }>(ratchetService).triggerFixer(
        {
          id: 'ws-unrecorded-dispatch',
          prUrl: 'https://github.com/example/repo/pull/20',
        },
        {
          ciStatus: CIStatus.FAILURE,
          snapshotKey: 'failed:20',
          prNumber: 20,
          reviewComments: [],
          hasMergeConflict: false,
        },
        0,
        new AbortController().signal,
        commitSideEffects
      );

      expect(result).toMatchObject({ type: 'ERROR', error: 'dispatch record write failed' });
      expect(commitSideEffects).toHaveBeenCalledTimes(1);
      expect(workspaceAccessor.recordRatchetSessionEnd).toHaveBeenCalledWith(
        'ws-unrecorded-dispatch',
        'unrecorded-session',
        'COMPLETED'
      );
      expect(mockSessionBridge.stopSession).toHaveBeenCalledWith('unrecorded-session');
    });

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
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
      };

      vi.mocked(fixerSessionService.acquireAndDispatch).mockRejectedValue(
        new Error('Session creation failed')
      );

      const result = await unsafeCoerce<{
        triggerFixer: (w: unknown, prStateInfo: unknown, retryCount: number) => Promise<unknown>;
      }>(ratchetService).triggerFixer(
        workspace,
        {
          ciStatus: CIStatus.FAILURE,
          prNumber: 20,
        },
        0
      );

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
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
      };

      vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
        status: 'already_active',
        sessionId: 'existing-session',
      } as never);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);

      const result = await unsafeCoerce<{
        triggerFixer: (w: unknown, prStateInfo: unknown, retryCount: number) => Promise<unknown>;
      }>(ratchetService).triggerFixer(
        workspace,
        {
          ciStatus: CIStatus.FAILURE,
          prNumber: 21,
        },
        0
      );

      expect(result).toMatchObject({
        type: 'FIXER_ACTIVE',
        sessionId: 'existing-session',
      });
      // Adoption records the pointer + RUNNING outcome without claiming the
      // current snapshot key was dispatched (no prompt was sent for it).
      expect(workspaceAccessor.adoptRatchetActiveSessionIfEnabled).toHaveBeenCalledWith(
        'ws-already-active',
        'existing-session'
      );
      expect(workspaceAccessor.recordRatchetDispatchIfEnabled).not.toHaveBeenCalled();
    });

    it('stops already-active fixer when active-session recording loses disable race', async () => {
      const workspace = {
        id: 'ws-already-active-disabled',
        prUrl: 'https://github.com/example/repo/pull/24',
        prNumber: 24,
        ratchetEnabled: true,
        ratchetState: RatchetState.CI_FAILED,
        ratchetActiveSessionId: null,
        ratchetLastCiRunId: null,
        prReviewLastCheckedAt: null,
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
      };

      vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
        status: 'already_active',
        sessionId: 'existing-session',
      } as never);
      vi.mocked(workspaceAccessor.adoptRatchetActiveSessionIfEnabled).mockResolvedValue(false);
      vi.mocked(mockSessionBridge.isSessionRunning).mockReturnValue(true);

      const result = await unsafeCoerce<{
        triggerFixer: (w: unknown, prStateInfo: unknown, retryCount: number) => Promise<unknown>;
      }>(ratchetService).triggerFixer(
        workspace,
        {
          ciStatus: CIStatus.FAILURE,
          prNumber: 24,
        },
        0
      );

      expect(result).toMatchObject({
        type: 'DISABLED',
        reason: 'Workspace ratcheting disabled',
      });
      expect(mockSessionBridge.stopSession).toHaveBeenCalledWith('existing-session');
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
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
      };

      vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
        status: 'skipped',
        reason: 'No worktree path',
      } as never);

      const result = await unsafeCoerce<{
        triggerFixer: (w: unknown, prStateInfo: unknown, retryCount: number) => Promise<unknown>;
      }>(ratchetService).triggerFixer(
        workspace,
        {
          ciStatus: CIStatus.FAILURE,
          prNumber: 22,
        },
        0
      );

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
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
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

    it('stops ratchet workflow sessions found after disabling workspace', async () => {
      vi.mocked(workspaceAccessor.findById).mockResolvedValue({
        id: 'ws-disable-raced-session',
        ratchetState: RatchetState.CI_RUNNING,
        ratchetActiveSessionId: null,
      } as never);
      vi.mocked(workspaceAccessor.update).mockResolvedValue({} as never);
      vi.mocked(mockSessionBridge.findSessionsByWorkspaceId).mockResolvedValue([
        {
          id: 'raced-ratchet-session',
          workflow: 'ratchet',
          status: SessionStatus.RUNNING,
        },
        {
          id: 'manual-session',
          workflow: 'default',
          status: SessionStatus.RUNNING,
        },
      ] as never);
      vi.mocked(mockSessionBridge.isSessionRunning).mockImplementation(
        (sessionId) => sessionId === 'raced-ratchet-session'
      );

      await ratchetService.setWorkspaceRatcheting('ws-disable-raced-session', false);

      expect(mockSessionBridge.findSessionsByWorkspaceId).toHaveBeenCalledWith(
        'ws-disable-raced-session'
      );
      expect(mockSessionBridge.stopSession).toHaveBeenCalledTimes(1);
      expect(mockSessionBridge.stopSession).toHaveBeenCalledWith('raced-ratchet-session');
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
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
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
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
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
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
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
        prCiStatus: CIStatus.FAILURE,
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
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
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
        ratchetDispatchOutcome: null,
        ratchetDispatchRetryCount: 0,
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
