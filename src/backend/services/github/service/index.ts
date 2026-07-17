// Domain: github
// Public API for the GitHub domain module.
// Consumers should import from '@/backend/services/github' only.

// Bridge interfaces for orchestration layer wiring
export type { GitHubKanbanBridge } from './bridges';
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
// --- PR fetch registry ---
export { prFetchRegistry } from './pr-fetch-registry';
// --- PR snapshot ---
export {
  type AttachAndRefreshResult,
  PR_DISPATCH_INVALIDATED,
  PR_SNAPSHOT_UPDATED,
  type PRDispatchInvalidatedEvent,
  type PRSnapshotRefreshResult,
  type PRSnapshotUpdatedEvent,
  prSnapshotService,
} from './pr-snapshot.service';
