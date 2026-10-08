import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { RatchetGitHubBridge, RatchetSessionBridge } from './bridges';
import type { PRStateInfo, WorkspaceWithPR } from './ratchet.types';

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: {},
  workspaceRatchetService: {
    findCandidates: vi.fn(),
    findCandidateById: vi.fn(),
    recordCheckIfEnabled: vi.fn(),
    recordDispatchIfEnabled: vi.fn(),
    clearActiveSession: vi.fn(),
    recordSessionEnd: vi.fn(),
  },
}));
vi.mock('@/backend/services/settings', () => ({ userSettingsService: { get: vi.fn() } }));
vi.mock('./fixer-session.service', () => ({
  fixerSessionService: { acquireAndDispatch: vi.fn() },
}));

import { userSettingsService } from '@/backend/services/settings';
import { workspaceRatchetService } from '@/backend/services/workspace';
import { fixerSessionService } from './fixer-session.service';
import { ratchetService } from './ratchet.service';

const candidate = (prId: string): WorkspaceWithPR => ({
  id: 'w',
  prId,
  prRevision: 0,
  prHeadRefName: prId,
  prUrl: `https://github.com/org/${prId}/pull/42`,
  prNumber: 42,
  prState: 'OPEN',
  prReviewState: null,
  prCiStatus: 'FAILURE',
  prHasMergeConflict: false,
  ratchetState: 'CI_FAILED',
  ratchetEnabled: true,
  ratchetActivePrId: null,
  ratchetActiveSessionId: null,
  ratchetLastCheckedAt: null,
  ratchetDispatchSnapshotKey: null,
  ratchetDispatchOutcome: null,
  ratchetDispatchRetryCount: 0,
  ratchetDispatchStalled: false,
  prReviewLastCheckedAt: null,
  defaultSessionProvider: 'WORKSPACE_DEFAULT',
  ratchetSessionProvider: 'WORKSPACE_DEFAULT',
});
beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => vi.restoreAllMocks());
it('observes both PRs, dispatches one fixer, and advances the sibling after ownership settles', async () => {
  const rows = [candidate('a'), candidate('b')];
  let owner: string | null = null;
  vi.mocked(workspaceRatchetService.findCandidates).mockImplementation(() => Promise.resolve(rows));
  vi.mocked(workspaceRatchetService.findCandidateById).mockImplementation((_id, prId) => {
    const row = rows.find((row) => row.prId === prId);
    return Promise.resolve(
      row
        ? { ...row, ratchetActivePrId: owner, ratchetActiveSessionId: owner === prId ? 's' : null }
        : null
    );
  });
  vi.mocked(workspaceRatchetService.recordCheckIfEnabled).mockResolvedValue(true);
  vi.mocked(workspaceRatchetService.recordDispatchIfEnabled).mockImplementation((_id, input) => {
    if (owner && owner !== input.prId) {
      return Promise.resolve(false);
    }
    owner = input.prId ?? null;
    return Promise.resolve(true);
  });
  vi.mocked(userSettingsService.get).mockResolvedValue({
    ratchetReviewTriggerMode: 'CHANGES_REQUESTED',
    ratchetReplyToPrComments: false,
  } as never);
  const session = unsafeCoerce<RatchetSessionBridge>({
    findSessionsByWorkspaceId: vi.fn().mockResolvedValue([]),
    findSessionById: vi.fn().mockResolvedValue(null),
    isSessionRunning: vi.fn().mockReturnValue(false),
    isSessionWorking: vi.fn().mockReturnValue(false),
    injectCommittedUserMessage: vi.fn(),
    stopSession: vi.fn(),
  });
  ratchetService.configure({
    session,
    github: unsafeCoerce<RatchetGitHubBridge>({
      getAuthenticatedUsername: vi.fn().mockResolvedValue(null),
    }),
    snapshot: { recordPrObservation: vi.fn(), recordReviewCheck: vi.fn() },
    workspace: {
      findFixerContext: vi.fn(),
      recordSessionEnd: vi.fn(),
      markDispatchStalled: vi.fn(),
    },
  });
  const fetch = vi
    .spyOn(
      unsafeCoerce<{ fetchPRState: (workspace: WorkspaceWithPR) => Promise<PRStateInfo> }>(
        ratchetService
      ),
      'fetchPRState'
    )
    .mockImplementation(async (workspace) => ({
      ciStatus: 'FAILURE',
      snapshotKey: workspace.prId,
      hasChangesRequested: false,
      hasMergeConflict: false,
      latestReviewActivityAtMs: null,
      statusCheckRollup: null,
      prState: 'OPEN',
      cachedPrState: 'OPEN',
      reviewDecision: null,
      prNumber: 42,
      reviewComments: [],
    }));
  vi.mocked(fixerSessionService.acquireAndDispatch).mockImplementation(async (input) => {
    await input.beforeStart?.({ sessionId: 's', prompt: await input.buildPrompt() });
    return { status: 'started', sessionId: 's', promptSent: true };
  });
  const first = await ratchetService.checkAllWorkspaces();
  expect(first.checked).toBe(2);
  expect(first.actionsTriggered).toBe(1);
  expect(fetch.mock.calls.map(([pr]) => pr.prId)).toEqual(['a', 'b']);
  expect(owner).toBe('a');
  expect(fixerSessionService.acquireAndDispatch).toHaveBeenCalledWith(
    expect.objectContaining({ workspacePrId: 'a' })
  );
  owner = null;
  rows[0]!.ratchetDispatchOutcome = 'COMPLETED';
  rows[0]!.ratchetDispatchSnapshotKey = 'a';
  const second = await ratchetService.checkAllWorkspaces();
  expect(second.actionsTriggered).toBe(1);
  expect(owner).toBe('b');
  expect(fixerSessionService.acquireAndDispatch).toHaveBeenCalledTimes(2);
  expect(fixerSessionService.acquireAndDispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({ workspacePrId: 'b' })
  );
});

it.each(['MERGED', 'CLOSED'] as const)(
  'cleans up cached %s ownership without a live fixer or GitHub fetch',
  async (state) => {
    vi.mocked(userSettingsService.get).mockResolvedValue({
      ratchetReviewTriggerMode: 'CHANGES_REQUESTED',
    } as never);
    const workspace = {
      ...candidate('a'),
      prState: state,
      ratchetActivePrId: 'a',
      ratchetActiveSessionId: 'old',
    };
    const session = unsafeCoerce<RatchetSessionBridge>({
      findSessionsByWorkspaceId: vi.fn().mockResolvedValue([]),
      isSessionRunning: vi.fn().mockReturnValue(false),
      stopSession: vi.fn(),
    });
    ratchetService.configure({
      session,
      github: unsafeCoerce<RatchetGitHubBridge>({
        getAuthenticatedUsername: vi.fn().mockResolvedValue(null),
      }),
      snapshot: { recordPrObservation: vi.fn(), recordReviewCheck: vi.fn() },
      workspace: {
        findFixerContext: vi.fn(),
        recordSessionEnd: vi.fn(),
        markDispatchStalled: vi.fn(),
      },
    });
    const service = unsafeCoerce<{
      fetchPRState: (workspace: WorkspaceWithPR) => Promise<PRStateInfo | null>;
      processWorkspace: (workspace: WorkspaceWithPR) => Promise<unknown>;
    }>(ratchetService);
    const fetch = vi.spyOn(service, 'fetchPRState').mockResolvedValue(null);
    await service.processWorkspace(workspace);
    expect(workspaceRatchetService.recordSessionEnd).toHaveBeenCalledWith('w', 'old', 'COMPLETED');
    expect(fetch).not.toHaveBeenCalled();
  }
);
