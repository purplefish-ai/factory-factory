import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADVERSARIAL_REVIEW_MARKER } from '@/shared/adversarial-review';

vi.mock('@/backend/services/github', async () => {
  const { ReviewSubmissionError } = await vi.importActual<
    typeof import('@/backend/services/github')
  >('@/backend/services/github');
  return {
    ReviewSubmissionError,
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
  };
});
vi.mock('@/backend/services/session', () => ({
  sessionDataService: { createAgentSession: vi.fn(), findAgentSessionsByWorkspaceId: vi.fn() },
  sessionDomainService: { getTranscriptSnapshot: vi.fn() },
  sessionLifecycleService: { startSession: vi.fn(), stopSession: vi.fn() },
  sessionService: { sendSessionMessage: vi.fn() },
}));
vi.mock('@/backend/services/settings', () => ({ userSettingsService: { get: vi.fn() } }));
vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: { findFixerContext: vi.fn(), findPRState: vi.fn() },
}));

import {
  createReviewComment,
  getPRDescription,
  getPRHeadCommitSha,
  githubCLIService,
  ReviewSubmissionError,
  submitCodeReview,
} from '@/backend/services/github';
import {
  sessionDataService,
  sessionDomainService,
  sessionLifecycleService,
  sessionService,
} from '@/backend/services/session';
import { userSettingsService } from '@/backend/services/settings';
import { workspaceDataService } from '@/backend/services/workspace';
import { triggerAdversarialReview } from './adversarial-review.orchestrator';

describe('adversarial-review fallback delivery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(workspaceDataService.findFixerContext).mockResolvedValue({
      id: 'ws',
      worktreePath: '/tmp/worktree',
    } as never);
    vi.mocked(workspaceDataService.findPRState).mockResolvedValue({
      prUrl: 'https://github.com/example/repo/pull/1',
      prNumber: 1,
      prState: 'OPEN',
    });
    vi.mocked(githubCLIService.extractPRInfo).mockReturnValue({
      owner: 'example',
      repo: 'repo',
      number: 1,
    });
    vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([]);
    vi.mocked(sessionDataService.createAgentSession).mockResolvedValue({
      id: 'review-session',
    } as never);
    vi.mocked(userSettingsService.get).mockResolvedValue({
      reviewerSessionProvider: 'CODEX',
      postReviewToGitHub: true,
    } as never);
    vi.mocked(githubCLIService.getPRDiff).mockResolvedValue(
      'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n'
    );
    vi.mocked(githubCLIService.getPRFullDetails).mockResolvedValue({ reviews: [] } as never);
    vi.mocked(getPRDescription).mockResolvedValue('description');
    vi.mocked(getPRHeadCommitSha).mockResolvedValue('abc123');
    vi.mocked(sessionLifecycleService.stopSession).mockResolvedValue(undefined);
    vi.mocked(sessionService.sendSessionMessage).mockResolvedValue(undefined as never);
  });

  async function runReview(comments: unknown[] = []) {
    vi.mocked(sessionDomainService.getTranscriptSnapshot).mockReturnValue([
      {
        message: {
          type: 'assistant',
          message: {
            content: `\x60\x60\x60json\n${JSON.stringify({ summary: 'Cross-file invariant is broken.', comments })}\n\x60\x60\x60`,
          },
        },
      },
    ] as never);
    await triggerAdversarialReview('ws');
    await vi.waitFor(() => expect(sessionLifecycleService.stopSession).toHaveBeenCalled());
  }

  it('delivers a marked summary-only finding after an explicit self-review rejection', async () => {
    vi.mocked(submitCodeReview).mockRejectedValue(new ReviewSubmissionError('self-review', true));
    await runReview();
    expect(githubCLIService.addPRComment).toHaveBeenCalledWith(
      'example/repo',
      1,
      expect.stringContaining(
        `${ADVERSARIAL_REVIEW_MARKER}\n\n## Adversarial Review\n\nCross-file invariant is broken.`
      )
    );
    expect(createReviewComment).not.toHaveBeenCalled();
  });

  it('keeps inline and out-of-diff details in the fallback summary for Ratchet', async () => {
    vi.mocked(submitCodeReview).mockRejectedValue(new ReviewSubmissionError('self-review', true));
    await runReview([
      { path: 'file.ts', line: 1, side: 'RIGHT', body: 'Inline bug details', severity: 'blocking' },
      {
        path: 'other.ts',
        line: 7,
        side: 'RIGHT',
        body: 'Cross-file details',
        severity: 'suggestion',
      },
    ]);
    const body = vi.mocked(githubCLIService.addPRComment).mock.calls[0]?.[2];
    expect(body).toContain(ADVERSARIAL_REVIEW_MARKER);
    expect(body).toContain('file.ts');
    expect(body).toContain('Inline bug details');
    expect(body).toContain('Cross-file details');
    expect(createReviewComment).toHaveBeenCalledTimes(1);
    expect(createReviewComment).toHaveBeenCalledWith(
      'example/repo',
      1,
      expect.objectContaining({ commitId: 'abc123', path: 'file.ts', line: 1 })
    );
  });

  it('delivers the complete fallback summary even if an inline post fails', async () => {
    vi.mocked(submitCodeReview).mockRejectedValue(new ReviewSubmissionError('self-review', true));
    vi.mocked(createReviewComment).mockRejectedValue(new Error('inline anchor is invalid'));
    await runReview([
      { path: 'file.ts', line: 1, side: 'RIGHT', body: 'Inline bug details', severity: 'blocking' },
    ]);
    expect(githubCLIService.addPRComment).toHaveBeenCalledWith(
      'example/repo',
      1,
      expect.stringContaining('Inline bug details')
    );
  });

  it.each([new ReviewSubmissionError('unrelated HTTP 422', false), new Error('timeout')])(
    'does not post duplicate fallback content after %s',
    async (error) => {
      vi.mocked(submitCodeReview).mockRejectedValue(error);
      await runReview();
      expect(githubCLIService.addPRComment).not.toHaveBeenCalled();
      expect(createReviewComment).not.toHaveBeenCalled();
    }
  );

  it('does not post fallback content after a successful COMMENT review', async () => {
    vi.mocked(submitCodeReview).mockResolvedValue(undefined);
    await runReview();
    expect(submitCodeReview).toHaveBeenCalledWith(
      'example/repo',
      1,
      expect.objectContaining({
        comments: [],
        body: expect.stringContaining(ADVERSARIAL_REVIEW_MARKER),
      })
    );
    expect(githubCLIService.addPRComment).not.toHaveBeenCalled();
  });
});
