// Domain: workspace
export type {
  PRDiscoveryClaim,
  PRSnapshotFields,
  WorkspaceFixerContext,
  WorkspacePRContext,
  WorkspaceProviderSelectionSnapshot,
  WorkspaceStatusSnapshot,
} from '@/backend/services/workspace/types';
// Public API for the workspace domain module.
// Consumers should import from '@/backend/services/workspace' only.

// Bridge interfaces for orchestration layer wiring
export type {
  WorkspaceGitHubBridge,
  WorkspacePRSnapshotBridge,
  WorkspaceSessionBridge,
} from './bridges';
export { workspaceActivityService } from './lifecycle/activity.service';
export {
  type WorkspaceCreationDependencies,
  WorkspaceCreationService,
  type WorkspaceCreationSource,
} from './lifecycle/creation.service';
export { workspaceDataService } from './lifecycle/data.service';
// --- Workspace lifecycle ---
export {
  type StartProvisioningOptions,
  type TransitionOptions,
  WORKSPACE_STATE_CHANGED,
  type WorkspaceStateChangedEvent,
  WorkspaceStateMachineError,
  workspaceStateMachine,
} from './lifecycle/state-machine.service';
export { workspaceAutoIterationService } from './lifecycle/workspace-auto-iteration.service';
export { workspacePrSnapshotService } from './lifecycle/workspace-pr-snapshot.service';
export { workspaceRatchetService } from './lifecycle/workspace-ratchet.service';
export { workspaceRelationshipsService } from './lifecycle/workspace-relationships.service';
export {
  type RunScriptExecutionState,
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
  type SnapshotDerivationFns,
  type SnapshotFieldGroup,
  type SnapshotRemovedEvent,
  type SnapshotUpdateInput,
  type SnapshotUpsertResult,
  type WorkspaceSessionSummary,
  type WorkspaceSnapshotEntry,
  WorkspaceSnapshotStore,
  workspaceSnapshotStore,
} from './snapshot/workspace-snapshot-store.service';
// --- State derivation (pure functions) ---
export {
  deriveWorkspaceFlowState,
  deriveWorkspaceFlowStateFromWorkspace,
  type WorkspaceCiObservation,
  type WorkspaceFlowPhase,
  type WorkspaceFlowState,
  type WorkspaceFlowStateInput,
  type WorkspaceFlowStateSource,
} from './state/flow-state';
export {
  getWorkspaceInitPolicy,
  type WorkspaceInitPolicy,
  type WorkspaceInitPolicyInput,
} from './state/init-policy';
export {
  computeKanbanColumn,
  type KanbanStateInput,
  kanbanStateService,
  type WorkspaceWithKanbanState,
} from './state/kanban-state';
export {
  computePendingRequestType,
  type WorkspacePendingRequestType,
} from './state/pending-request-type';
// --- Worktree management ---
export {
  type ExistingCloneStatus,
  type GithubRepo,
  gitCloneService,
  parseGithubUrl,
} from './worktree/git-clone.service';
export { gitOpsService, type WorkspaceGitStats } from './worktree/git-ops.service';
export {
  assertWorktreePathSafe,
  WorktreePathSafetyError,
  worktreeLifecycleService,
} from './worktree/worktree-lifecycle.service';
