// Domain: workspace
// Public API for the workspace domain module.
// Consumers should import from '@/backend/domains/workspace' only.

// Bridge interfaces for orchestration layer wiring
export type {
  WorkspaceGitHubBridge,
  WorkspacePRSnapshotBridge,
  WorkspaceSessionBridge,
} from './bridges';
export { workspaceActivityService } from './lifecycle/activity.service';
export {
  type WorkspaceCreationDependencies,
  type WorkspaceCreationResult,
  WorkspaceCreationService,
  type WorkspaceCreationSource,
} from './lifecycle/creation.service';
export { workspaceDataService } from './lifecycle/data.service';

// --- Workspace lifecycle ---
export {
  type StartProvisioningOptions,
  type TransitionOptions,
  WorkspaceStateMachineError,
  workspaceStateMachine,
} from './lifecycle/state-machine.service';
// --- Workspace query/aggregation ---
export { workspaceQueryService } from './query/workspace-query.service';
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
// --- Worktree management ---
export {
  assertWorktreePathSafe,
  WorktreePathSafetyError,
  worktreeLifecycleService,
} from './worktree/worktree-lifecycle.service';
