// @factory-factory/core
// Core library for Factory Factory workspace execution primitives.

// Shared utilities
export {
  type CiVisualState,
  deriveCiVisualStateFromChecks,
  deriveCiVisualStateFromPrCiStatus,
  getCiVisualLabel,
} from './shared/ci-status.js';
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
// Types & Enums
export {
  CIStatus,
  IssueProvider,
  KanbanColumn,
  PRState,
  RatchetState,
  RunScriptStatus,
  SessionStatus,
  WorkspaceCreationSource,
  WorkspaceStatus,
} from './types/index.js';
