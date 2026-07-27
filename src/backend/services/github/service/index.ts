// Domain: github
// Public API for the GitHub domain module.
// Consumers should import from '@/backend/services/github' only.

export { classifyError as classifyGitHubCLIError } from './github-cli/errors';
// --- GitHub CLI wrapper ---
export {
  type GitHubCLIErrorType,
  type GitHubCLIHealthStatus,
  type GitHubIssue,
  githubCLIService,
  type OpenPullRequest,
  type PRInfo,
  type PRStatusFromGitHub,
  type ReviewRequestedPR,
} from './github-cli.service';
// --- PR fetch coordinator ---
export { type CoordinatedFetch, prFetchCoordinator } from './pr-fetch-coordinator';
// --- PR snapshot ---
export {
  type AttachAndRefreshResult,
  PR_SNAPSHOT_UPDATED,
  PR_URL_ATTACHED,
  type PRSnapshotRefreshResult,
  type PRSnapshotUpdatedEvent,
  type PRUrlAttachedEvent,
  prSnapshotService,
} from './pr-snapshot.service';
