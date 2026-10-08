import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@/backend/lib/application-error';

// --- Module mocks (before imports) ---

vi.mock('@/backend/services/github', () => ({
  githubCLIService: {
    extractPRInfo: vi.fn(),
    getPRDiff: vi.fn(),
    getPRFullDetails: vi.fn(),
    addPRComment: vi.fn(),
    getAuthenticatedUsername: vi.fn(),
  },
  getPRDescription: vi.fn(),
  getPRHeadCommitSha: vi.fn(),
  submitCodeReview: vi.fn(),
  createReviewComment: vi.fn(),
}));

vi.mock('@/backend/services/session', () => ({
  sessionDataService: {
    createAgentSessionWithinWorkspaceLimit: vi.fn(),
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

import { configService } from '@/backend/services/config.service';
import { getPRDescription, getPRHeadCommitSha, githubCLIService } from '@/backend/services/github';
import { sessionDataService, sessionLifecycleService } from '@/backend/services/session';
import { userSettingsService } from '@/backend/services/settings';
import { workspaceDataService } from '@/backend/services/workspace';
import { ADVERSARIAL_REVIEW_MARKER } from '@/shared/adversarial-review';
import {
  summarizeExistingActivity,
  triggerAdversarialReview,
} from './adversarial-review.orchestrator';

const WORKSPACE_ID = 'ws-1';

function mockOpenPrWorkspace() {
  vi.mocked(workspaceDataService.findFixerContext).mockResolvedValue({
    id: WORKSPACE_ID,
    worktreePath: '/tmp/worktree',
    defaultSessionProvider: 'WORKSPACE_DEFAULT',
  });
  vi.mocked(workspaceDataService.findPRState).mockResolvedValue({
    prId: 'pr1',
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
  vi.mocked(getPRDescription).mockResolvedValue('');
  vi.mocked(githubCLIService.getPRDiff).mockResolvedValue('');
  vi.mocked(githubCLIService.getPRFullDetails).mockResolvedValue({ reviews: [] } as never);
  vi.mocked(githubCLIService.getAuthenticatedUsername).mockResolvedValue('factory-factory[bot]');
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
    });
    vi.mocked(workspaceDataService.findPRState).mockResolvedValue(null);

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
    expect(sessionDataService.createAgentSessionWithinWorkspaceLimit).not.toHaveBeenCalled();
  });

  it('refuses to start a reviewer when the workspace session limit is reached', async () => {
    mockOpenPrWorkspace();
    vi.mocked(sessionDataService.createAgentSessionWithinWorkspaceLimit).mockResolvedValue({
      outcome: 'limit_reached',
    });

    await expect(triggerAdversarialReview(WORKSPACE_ID)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('session limit'),
    });
    expect(sessionLifecycleService.startSession).not.toHaveBeenCalled();
  });

  it('creates and starts a session with the admin-configured reviewer provider/model', async () => {
    mockOpenPrWorkspace();
    vi.mocked(sessionDataService.createAgentSessionWithinWorkspaceLimit).mockResolvedValue({
      outcome: 'created',
      session: { id: 'new-session' },
    } as never);

    const result = await triggerAdversarialReview(WORKSPACE_ID);

    expect(result).toEqual({ status: 'started', sessionId: 'new-session' });
    expect(sessionDataService.createAgentSessionWithinWorkspaceLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        maxSessions: configService.getMaxSessionsPerWorkspace(),
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
    vi.mocked(sessionDataService.createAgentSessionWithinWorkspaceLimit).mockResolvedValue({
      outcome: 'created',
      session: { id: 'new-session' },
    } as never);

    const [first, second] = await Promise.all([
      triggerAdversarialReview(WORKSPACE_ID),
      triggerAdversarialReview(WORKSPACE_ID),
    ]);

    expect(first).toEqual({ status: 'started', sessionId: 'new-session' });
    expect(second).toEqual(first);
    expect(sessionDataService.createAgentSessionWithinWorkspaceLimit).toHaveBeenCalledTimes(1);
  });
});

describe('summarizeExistingActivity', () => {
  it('drops other automated review bots but keeps human reviews', () => {
    const summary = summarizeExistingActivity(
      {
        reviews: [
          { author: { login: 'cubic-dev-ai[bot]' }, state: 'COMMENTED', body: 'No issues found.' },
          { author: { login: 'alice' }, state: 'CHANGES_REQUESTED', body: 'Please add a test.' },
        ],
      },
      'factory-factory[bot]'
    );

    expect(summary).not.toContain('cubic-dev-ai');
    expect(summary).not.toContain('No issues found.');
    expect(summary).toContain('alice');
    expect(summary).toContain('Please add a test.');
  });

  it('keeps a prior adversarial-review verdict posted by our own authenticated identity', () => {
    const summary = summarizeExistingActivity(
      {
        reviews: [
          {
            author: { login: 'factory-factory[bot]' },
            state: 'COMMENTED',
            body: `${ADVERSARIAL_REVIEW_MARKER}\n\n## Adversarial Review\n\nFound a race condition.`,
          },
        ],
      },
      'factory-factory[bot]'
    );

    expect(summary).toContain('Found a race condition.');
  });

  it('drops a spoofed marker from a bot that is not our authenticated identity', () => {
    const summary = summarizeExistingActivity(
      {
        reviews: [
          {
            author: { login: 'cubic-dev-ai[bot]' },
            state: 'COMMENTED',
            body: `${ADVERSARIAL_REVIEW_MARKER}\n\n## Adversarial Review\n\nNo issues found.`,
          },
        ],
      },
      'factory-factory[bot]'
    );

    expect(summary).not.toContain('No issues found.');
    expect(summary).toBe('');
  });
});
