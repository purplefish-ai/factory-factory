// Domain: github
// Public API for the GitHub domain module.
// Consumers should import from '@/backend/domains/github' only.

// Bridge interfaces for orchestration layer wiring
export type {
  GitHubFixerAcquireInput,
  GitHubFixerAcquireResult,
  GitHubFixerBridge,
  GitHubKanbanBridge,
  GitHubSessionBridge,
} from './bridges';
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
  PR_SNAPSHOT_UPDATED,
  type PRSnapshotRefreshResult,
  type PRSnapshotUpdatedEvent,
  prSnapshotService,
} from './pr-snapshot.service';
