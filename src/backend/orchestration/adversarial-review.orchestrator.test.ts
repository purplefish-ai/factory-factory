import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@/backend/lib/application-error';

// --- Module mocks (before imports) ---

vi.mock('@/backend/services/github', () => ({
  githubCLIService: {
    extractPRInfo: vi.fn(),
    getPRDiff: vi.fn(),
    getPRFullDetails: vi.fn(),
    addPRComment: vi.fn(),
  },
  getPRDescription: vi.fn(),
  getPRHeadCommitSha: vi.fn(),
  submitCodeReview: vi.fn(),
  createReviewComment: vi.fn(),
}));

vi.mock('@/backend/services/session', () => ({
  sessionDataService: {
    createAgentSession: vi.fn(),
    findAgentSessionsByWorkspaceId: vi.fn(),
  },
  sessionDomainService: {
    getTranscriptSnapshot: vi.fn(),
  },
  sessionLifecycleService: {
    startSession: vi.fn(),
    stopSession: vi.fn(),
  },
  sessionService: {
    sendSessionMessage: vi.fn(),
  },
}));

vi.mock('@/backend/services/settings', () => ({
  userSettingsService: {
    get: vi.fn(),
  },
}));

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: {
    findFixerContext: vi.fn(),
    findPRState: vi.fn(),
  },
}));

import { getPRHeadCommitSha, githubCLIService } from '@/backend/services/github';
import { sessionDataService, sessionLifecycleService } from '@/backend/services/session';
import { userSettingsService } from '@/backend/services/settings';
import { workspaceDataService } from '@/backend/services/workspace';
import { triggerAdversarialReview } from './adversarial-review.orchestrator';

const WORKSPACE_ID = 'ws-1';

function mockOpenPrWorkspace() {
  vi.mocked(workspaceDataService.findFixerContext).mockResolvedValue({
    id: WORKSPACE_ID,
    worktreePath: '/tmp/worktree',
    defaultSessionProvider: 'WORKSPACE_DEFAULT',
    ratchetSessionProvider: 'WORKSPACE_DEFAULT',
  });
  vi.mocked(workspaceDataService.findPRState).mockResolvedValue({
    prUrl: 'https://github.com/example/repo/pull/42',
    prNumber: 42,
    prState: 'OPEN',
  });
  vi.mocked(githubCLIService.extractPRInfo).mockReturnValue({
    owner: 'example',
    repo: 'repo',
    number: 42,
  });
  vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([]);
  vi.mocked(userSettingsService.get).mockResolvedValue({
    reviewerSessionProvider: 'CODEX',
    reviewerClaudeModel: null,
    reviewerCodexModel: null,
    postReviewToGitHub: true,
  } as never);
  vi.mocked(githubCLIService.getPRDiff).mockResolvedValue('');
  vi.mocked(githubCLIService.getPRFullDetails).mockResolvedValue({ reviews: [] } as never);
  vi.mocked(getPRHeadCommitSha).mockResolvedValue('abc123');
  vi.mocked(sessionLifecycleService.stopSession).mockResolvedValue(undefined);
}

describe('triggerAdversarialReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws NOT_FOUND when the workspace does not exist', async () => {
    vi.mocked(workspaceDataService.findFixerContext).mockResolvedValue(null);
    vi.mocked(workspaceDataService.findPRState).mockResolvedValue(null);

    const rejection = triggerAdversarialReview(WORKSPACE_ID);
    await expect(rejection).rejects.toThrow(ApplicationError);
    await expect(rejection).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('throws PRECONDITION_FAILED when the workspace has no worktree yet', async () => {
    vi.mocked(workspaceDataService.findFixerContext).mockResolvedValue({
      id: WORKSPACE_ID,
      worktreePath: null,
      defaultSessionProvider: 'WORKSPACE_DEFAULT',
      ratchetSessionProvider: 'WORKSPACE_DEFAULT',
    });
    vi.mocked(workspaceDataService.findPRState).mockResolvedValue(null);

    await expect(triggerAdversarialReview(WORKSPACE_ID)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('throws PRECONDITION_FAILED when there is no open PR', async () => {
    vi.mocked(workspaceDataService.findFixerContext).mockResolvedValue({
      id: WORKSPACE_ID,
      worktreePath: '/tmp/worktree',
      defaultSessionProvider: 'WORKSPACE_DEFAULT',
      ratchetSessionProvider: 'WORKSPACE_DEFAULT',
    });
    vi.mocked(workspaceDataService.findPRState).mockResolvedValue({
      prUrl: null,
      prNumber: null,
      prState: 'NONE',
    });

    await expect(triggerAdversarialReview(WORKSPACE_ID)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('returns the existing session instead of starting a new one when a review is already active', async () => {
    mockOpenPrWorkspace();
    vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([
      {
        id: 'existing-session',
        workflow: 'adversarial_review',
        status: 'RUNNING',
        provider: 'CODEX',
        createdAt: new Date(),
      } as never,
    ]);

    const result = await triggerAdversarialReview(WORKSPACE_ID);

    expect(result).toEqual({ status: 'already_active', sessionId: 'existing-session' });
    expect(sessionDataService.createAgentSession).not.toHaveBeenCalled();
  });

  it('creates and starts a session with the admin-configured reviewer provider/model', async () => {
    mockOpenPrWorkspace();
    vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
      id: 'new-session',
    } as never);

    const result = await triggerAdversarialReview(WORKSPACE_ID);

    expect(result).toEqual({ status: 'started', sessionId: 'new-session' });
    expect(sessionDataService.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        workflow: 'adversarial_review',
        provider: 'CODEX',
        model: 'default',
      })
    );
    expect(sessionLifecycleService.startSession).toHaveBeenCalledWith(
      'new-session',
      expect.objectContaining({ initialPrompt: '', startupModePreset: 'plan' })
    );
  });

  it('serializes concurrent triggers for the same workspace instead of racing', async () => {
    mockOpenPrWorkspace();
    vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
      id: 'new-session',
    } as never);

    const [first, second] = await Promise.all([
      triggerAdversarialReview(WORKSPACE_ID),
      triggerAdversarialReview(WORKSPACE_ID),
    ]);

    expect(first).toEqual({ status: 'started', sessionId: 'new-session' });
    expect(second).toEqual(first);
    expect(sessionDataService.createAgentSession).toHaveBeenCalledTimes(1);
  });
});
