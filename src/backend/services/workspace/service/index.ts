// Domain: workspace
// Public API for the workspace domain module.
// Consumers should import from '@/backend/services/workspace' only.

// Bridge interfaces for orchestration layer wiring
export type {
  WorkspaceGitHubBridge,
  WorkspacePRSnapshotBridge,
  WorkspaceSessionBridge,
} from './bridges';
export { workspaceActivityService } from './lifecycle/activity.service';
export { WorkspaceCreationService } from './lifecycle/creation.service';
export type { AcceptedWorkspaceBranch } from './lifecycle/accepted-branch';
export { workspaceDataService } from './lifecycle/data.service';
// --- Workspace lifecycle ---
export {
  WORKSPACE_CREATED,
  type WorkspaceCreatedEvent,
  WORKSPACE_STATE_CHANGED,
  type WorkspaceStateChangedEvent,
  workspaceStateMachine,
} from './lifecycle/state-machine.service';
export { workspacePRMonitoringService } from './lifecycle/workspace-pr-monitoring.service';
export { workspacePrSnapshotService } from './lifecycle/workspace-pr-snapshot.service';
export { workspaceRelationshipsService } from './lifecycle/workspace-relationships.service';
export {
  type RunScriptExecutionState,
  type RunScriptExecutionUpdate,
  workspaceRunScriptService,
} from './lifecycle/workspace-run-script.service';
export { computePRDiscoveryNextCheckAt } from './pr-discovery-schedule';
// --- Workspace query/aggregation ---
export { projectManagementService } from './query/project-management.service';
export { workspaceMaintenanceService } from './query/workspace-maintenance.service';
export { workspaceNotificationService } from './query/workspace-notification.service';
export { workspaceQueryService } from './query/workspace-query.service';
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
} from './snapshot/workspace-snapshot-store.service';
// --- State derivation (pure functions) ---
export {
  deriveWorkspaceFlowState,
  deriveWorkspaceFlowStateFromWorkspace,
} from './state/flow-state';
export { getWorkspaceInitPolicy, type WorkspaceInitPolicyInput } from './state/init-policy';
export { computePendingRequestType } from './state/pending-request-type';
export { deriveLastActivityAt, toWorkspaceDerivedStateInput } from './state/workspace-read-state';
// --- Worktree management ---
export { gitCloneService, parseGithubUrl } from './worktree/git-clone.service';
export { gitOpsService } from './worktree/git-ops.service';
export {
  type OrphanedWorktree,
  type OrphanedWorktreeCleanupResult,
  orphanedWorktreeService,
} from './worktree/orphaned-worktree.service';
export {
  assertWorktreePathSafe,
  worktreeLifecycleService,
} from './worktree/worktree-lifecycle.service';
