// Bridge interfaces for orchestration layer wiring
export type {
  WorkspaceGitHubBridge,
  WorkspacePRSnapshotBridge,
  WorkspaceSessionBridge,
} from './service/bridges';

// --- Workspace lifecycle ---
export type { AcceptedWorkspaceBranch } from './service/lifecycle/accepted-branch';
export { workspaceActivityService } from './service/lifecycle/activity.service';
export { archivedWorkspaceBlobRetentionService } from './service/lifecycle/archived-workspace-blob-retention.service';
export { WorkspaceCreationService } from './service/lifecycle/creation.service';
export { workspaceDataService } from './service/lifecycle/data.service';
export {
  type EventWorkspaceClaim,
  EventWorkspaceFenceError,
  eventWorkspaceInitService,
} from './service/lifecycle/event-workspace-init.service';
export type { EventWorkspaceSource } from './service/lifecycle/event-workspace-source';
export {
  WORKSPACE_CREATED,
  type WorkspaceCreatedEvent,
  WORKSPACE_STATE_CHANGED,
  type WorkspaceStateChangedEvent,
  WorkspaceStateMachineError,
  workspaceStateMachine,
} from './service/lifecycle/state-machine.service';
export { workspaceChildHistoryService } from './service/lifecycle/workspace-child-history.service';
export { workspacePRMonitoringService } from './service/lifecycle/workspace-pr-monitoring.service';
export { workspacePrSnapshotService } from './service/lifecycle/workspace-pr-snapshot.service';
export { workspaceRelationshipsService } from './service/lifecycle/workspace-relationships.service';
export {
  type RunScriptExecutionState,
  type RunScriptExecutionUpdate,
  workspaceRunScriptService,
} from './service/lifecycle/workspace-run-script.service';
export { computePRDiscoveryNextCheckAt } from './service/pr-discovery-schedule';

// --- Workspace query/aggregation ---
export { projectManagementService } from './service/query/project-management.service';
export { workspaceMaintenanceService } from './service/query/workspace-maintenance.service';
export { workspaceNotificationService } from './service/query/workspace-notification.service';
export { workspaceQueryService } from './service/query/workspace-query.service';

// --- Workspace snapshots ---
export {
  SNAPSHOT_CHANGED,
  SNAPSHOT_REMOVED,
  type SnapshotChangedEvent,
  type SnapshotRemovedEvent,
  type SnapshotUpdateInput,
  sessionSummariesEqual,
  workspacePullRequestsEqual,
  type WorkspaceSnapshotEntry,
  WorkspaceSnapshotStore,
  workspaceSnapshotStore,
} from './service/snapshot/workspace-snapshot-store.service';

// --- State derivation (pure functions) ---
export {
  deriveWorkspaceFlowState,
  deriveWorkspaceFlowStateFromWorkspace,
} from './service/state/flow-state';
export { getWorkspaceInitPolicy, type WorkspaceInitPolicyInput } from './service/state/init-policy';
export { computePendingRequestType } from './service/state/pending-request-type';
export {
  deriveLastActivityAt,
  toWorkspaceDerivedStateInput,
} from './service/state/workspace-read-state';

// --- Worktree management ---
export { gitCloneService, parseGithubUrl } from './service/worktree/git-clone.service';
export { APP_PRIVATE_REF_PREFIX, gitOpsService } from './service/worktree/git-ops.service';
export {
  type OrphanedWorktree,
  type OrphanedWorktreeCleanupResult,
  orphanedWorktreeService,
} from './service/worktree/orphaned-worktree.service';
export {
  assertWorktreePathSafe,
  worktreeLifecycleService,
} from './service/worktree/worktree-lifecycle.service';

export type { WorkspaceDeletionCapture } from './types';
