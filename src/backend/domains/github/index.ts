// Domain: github
// Public API for the GitHub domain module.
// Consumers should import from '@/backend/domains/github' only.

// --- GitHub CLI wrapper ---
export {
  type GitHubCLIErrorType,
  type GitHubCLIHealthStatus,
  type GitHubIssue,
  githubCLIService,
  type PRInfo,
  type PRStatusFromGitHub,
  type ReviewRequestedPR,
} from './github-cli.service';
// --- PR review fixer ---
export {
  type PRReviewFixResult,
  prReviewFixerService,
  type ReviewCommentDetails,
} from './pr-review-fixer.service';
// --- PR review monitor ---
export { prReviewMonitorService } from './pr-review-monitor.service';
// --- PR snapshot ---
export {
  type AttachAndRefreshResult,
  type PRSnapshotRefreshResult,
  prSnapshotService,
} from './pr-snapshot.service';
