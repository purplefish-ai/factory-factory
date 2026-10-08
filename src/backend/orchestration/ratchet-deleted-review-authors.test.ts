import { execFile } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));
vi.mock('node:util', () => ({ promisify: (fn: unknown) => fn }));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: {},
  workspaceRatchetService: {
    findCandidatesById: vi.fn(async (id: string) => {
      const candidate = await workspaceRatchetService.findCandidateById(id);
      return candidate ? [candidate] : [];
    }),
    findCandidateById: vi.fn(),
    recordCheckIfEnabled: vi.fn(),
    recordDispatchIfEnabled: vi.fn(),
  },
}));
vi.mock('@/backend/services/settings', () => ({
  userSettingsService: { get: vi.fn() },
}));
vi.mock('@/backend/services/ratchet/service/fixer-session.service', () => ({
  fixerSessionService: { acquireAndDispatch: vi.fn() },
}));

import { githubCLIService } from '@/backend/services/github';
import {
  fixerSessionService,
  type RatchetGitHubBridge,
  type RatchetSessionBridge,
  ratchetService,
} from '@/backend/services/ratchet';
import { userSettingsService } from '@/backend/services/settings';
import { workspaceRatchetService } from '@/backend/services/workspace';
import { CIStatus, RatchetState } from '@/shared/core';

const PR_URL = 'https://github.com/owner/repo/pull/1';
const workspace = {
  id: 'deleted-review-author',
  prUrl: PR_URL,
  prNumber: 1,
  prState: 'OPEN',
  prReviewState: null,
  prHasMergeConflict: false,
  prCiStatus: CIStatus.SUCCESS,
  ratchetEnabled: true,
  ratchetState: RatchetState.READY,
  ratchetActiveSessionId: null,
  ratchetDispatchSnapshotKey: null,
  ratchetDispatchOutcome: null,
  ratchetDispatchRetryCount: 0,
  prReviewLastCheckedAt: null,
};

const session: RatchetSessionBridge = {
  findSessionById: vi.fn(),
  findSessionsByWorkspaceId: vi.fn(async () => []),
  acquireFixerSession: vi.fn(),
  isSessionRunning: vi.fn(),
  isSessionWorking: vi.fn(),
  stopSession: vi.fn(),
  startSession: vi.fn(),
  restartSession: vi.fn(),
  sendSessionMessage: vi.fn(),
  injectCommittedUserMessage: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  githubCLIService.clearCaches();
  const github: RatchetGitHubBridge = {
    extractPRInfo: githubCLIService.extractPRInfo.bind(githubCLIService),
    getPRFullDetails: vi.fn(async () => ({
      isDraft: false,
      state: 'OPEN',
      number: 1,
      url: PR_URL,
      reviewDecision: null,
      mergeStateStatus: 'CLEAN',
      reviews: [],
      comments: [],
      statusCheckRollup: [],
    })),
    getReviewComments: githubCLIService.getReviewComments.bind(githubCLIService),
    getResolvedReviewCommentIds: vi.fn(async () => new Set<number>()),
    computeCIStatus: vi.fn(() => CIStatus.SUCCESS),
    computePRState: vi.fn(() => 'OPEN' as const),
    getAuthenticatedUsername: vi.fn(async () => 'app-user'),
    coordinatePrFetch: vi.fn(async (_workspaceId, fetch) => ({
      status: 'fetched' as const,
      value: await fetch(),
    })),
  };
  ratchetService.configure({
    github,
    session,
    snapshot: {
      recordPrObservation: vi.fn(),
      recordReviewCheck: vi.fn(),
    },
    workspace: {
      findFixerContext: vi.fn(),
      recordSessionEnd: vi.fn(),
      markDispatchStalled: vi.fn(),
    },
  });
  vi.mocked(workspaceRatchetService.findCandidateById).mockResolvedValue(workspace as never);
  vi.mocked(workspaceRatchetService.recordCheckIfEnabled).mockResolvedValue(true);
  vi.mocked(workspaceRatchetService.recordDispatchIfEnabled).mockResolvedValue(true);
  vi.mocked(userSettingsService.get).mockResolvedValue({
    ratchetReviewTriggerMode: 'CHANGES_REQUESTED',
    ratchetReplyToPrComments: false,
  } as never);
  vi.mocked(fixerSessionService.acquireAndDispatch).mockResolvedValue({
    status: 'started',
    sessionId: 'fixer-session',
    promptSent: true,
  });
});

describe('Ratchet with deleted inline review authors', () => {
  it.each([true, false])(
    'dispatches deleted-author feedback and filters the app identity (include named reviewer: %s)',
    async (includeNamedReviewer) => {
      const comments = [
        { id: 3, user: { login: 'app-user' }, body: 'Own reply' },
        { id: 2, user: null, body: 'Fix the deleted reviewer finding' },
        ...(includeNamedReviewer
          ? [{ id: 1, user: { login: 'human-reviewer' }, body: 'Fix the human reviewer finding' }]
          : []),
      ].map((comment) => ({
        ...comment,
        path: 'src/index.ts',
        line: 42,
        created_at: new Date(comment.id * 1000).toISOString(),
        updated_at: new Date(comment.id * 1000).toISOString(),
        html_url: `${PR_URL}#discussion_r${comment.id}`,
      }));
      vi.mocked(execFile).mockResolvedValue({
        stdout: JSON.stringify(comments),
        stderr: '',
      } as never);

      const result = await ratchetService.checkWorkspaceById(workspace.id);

      expect(result?.action).toEqual({
        type: 'TRIGGERED_FIXER',
        sessionId: 'fixer-session',
        promptSent: true,
      });
      const dispatch = vi.mocked(fixerSessionService.acquireAndDispatch).mock.calls[0]?.[0];
      const prompt = await dispatch?.buildPrompt();
      expect(prompt).toContain('"author": ""');
      expect(prompt).toContain('Fix the deleted reviewer finding');
      if (includeNamedReviewer) {
        expect(prompt).toContain('"author": "human-reviewer"');
      }
      expect(prompt).not.toContain('Own reply');
      expect(workspaceRatchetService.recordDispatchIfEnabled).toHaveBeenCalledWith(workspace.id, {
        sessionId: 'fixer-session',
        snapshotKey: 'pr:1|ci:SUCCESS|no-changes-requested:2000|merge:clean',
        retryCount: 0,
      });
    }
  );
});
