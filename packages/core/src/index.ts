// @factory-factory/core
// Core library for Factory Factory workspace execution primitives.

// Infrastructure interfaces
export type { CoreServiceConfig, CreateLogger, Logger } from './infra/index.js';
// Shared utilities
export {
  type CiVisualState,
  deriveCiVisualStateFromChecks,
  deriveCiVisualStateFromPrCiStatus,
  getCiVisualLabel,
} from './shared/ci-status.js';
export type {
  WorkspaceInitBanner,
  WorkspaceInitPhase,
} from './shared/workspace-init.js';
export {
  deriveWorkspaceSidebarStatus,
  getWorkspaceActivityTooltip,
  getWorkspaceCiLabel,
  getWorkspaceCiTooltip,
  getWorkspacePrTooltipSuffix,
  type WorkspaceSidebarActivityState,
  type WorkspaceSidebarCiState,
  type WorkspaceSidebarStatus,
  type WorkspaceSidebarStatusInput,
} from './shared/workspace-sidebar-status.js';
// Storage interfaces
export type {
  AcquireFixerSessionInput,
  CIMonitoringView,
  CreateSessionInput,
  FixerSessionAcquisition,
  RatchetWorkspaceView,
  ReviewMonitoringView,
  SessionRecord,
  SessionStorage,
  SessionWithWorkspace,
  WorkspaceRecord,
  WorkspaceStorage,
} from './storage/index.js';
// Types & Enums
export {
  CIStatus,
  KanbanColumn,
  PRState,
  RatchetState,
  RunScriptStatus,
  SessionStatus,
  WorkspaceCreationSource,
  WorkspaceStatus,
} from './types/index.js';
// Workspace pure derivation functions
export {
  computeKanbanColumn,
  deriveWorkspaceFlowState,
  deriveWorkspaceFlowStateFromWorkspace,
  deriveWorkspaceRuntimeState,
  getWorkspaceInitPolicy,
  type KanbanStateInput,
  type WorkspaceCiObservation,
  type WorkspaceFlowPhase,
  type WorkspaceFlowState,
  type WorkspaceFlowStateInput,
  type WorkspaceFlowStateSource,
  type WorkspaceInitPolicy,
  type WorkspaceInitPolicyInput,
  type WorkspaceRuntimeState,
  type WorkspaceRuntimeStateSource,
} from './workspace/index.js';
