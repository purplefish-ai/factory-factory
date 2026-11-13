export type { AgentIssueEventPage, AgentIssueEventRequest } from '@/shared/agent-source';

// --- GitHub CLI auth check ---
export { type AuthCheckResult, checkGithubAuth } from './service/github-cli/auth-check';

// --- Adversarial-review code review posting ---
export {
  type CodeReviewComment,
  type CodeReviewCommentSide,
  createReviewComment,
  getPRDescription,
  getPRHeadCommitSha,
  ReviewSubmissionError,
  type SubmitCodeReviewInput,
  submitCodeReview,
} from './service/github-cli/code-review';
export { classifyError as classifyGitHubCLIError } from './service/github-cli/errors';

// --- GitHub CLI wrapper ---
export {
  type GitHubCLIErrorType,
  type GitHubCLIHealthStatus,
  type GitHubIssue,
  githubCLIService,
  type OpenPullRequest,
  type PRInfo,
  type ReviewRequestedPR,
} from './service/github-cli.service';

// --- PR review activity ---
export {
  buildReviewSummariesForPrompt,
  computeLatestReviewActivityAtMs,
  isIgnoredReviewAuthor,
} from './service/pr-actionable-review';

// --- PR fetch coordinator ---
export { type CoordinatedFetch, prFetchCoordinator } from './service/pr-fetch-coordinator';
export { prObservationService } from './service/pr-observation.service';

// --- PR snapshot ---
export {
  type AttachAndRefreshResult,
  PR_DETACHED,
  PR_SNAPSHOT_UPDATED,
  PR_URL_ATTACHED,
  type PRSnapshotRefreshResult,
  type PRSnapshotUpdatedEvent,
  type PRUrlAttachedEvent,
  prSnapshotService,
} from './service/pr-snapshot.service';
