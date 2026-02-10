import { describe, expect, it } from 'vitest';
import {
  // Worktree
  assertWorktreePathSafe,
  // State derivation
  computeKanbanColumn,
  deriveWorkspaceFlowState,
  deriveWorkspaceFlowStateFromWorkspace,
  getWorkspaceInitPolicy,
  kanbanStateService,
  // Lifecycle
  WorkspaceCreationService,
  WorkspaceStateMachineError,
  WorktreePathSafetyError,
  workspaceActivityService,
  workspaceDataService,
  // Query
  workspaceQueryService,
  workspaceStateMachine,
  worktreeLifecycleService,
} from './index';

/**
 * Domain barrel export smoke test.
 *
 * Verifies that every public export from the workspace domain barrel is a real
 * value (not `undefined` due to circular dependency breakage). Static imports
 * ensure the barrel can be loaded at module resolution time.
 */
describe('Workspace domain exports', () => {
  // --- State derivation ---
  it('exports deriveWorkspaceFlowState as a function', () => {
    expect(typeof deriveWorkspaceFlowState).toBe('function');
  });

  it('exports deriveWorkspaceFlowStateFromWorkspace as a function', () => {
    expect(typeof deriveWorkspaceFlowStateFromWorkspace).toBe('function');
  });

  it('exports computeKanbanColumn as a function', () => {
    expect(typeof computeKanbanColumn).toBe('function');
  });

  it('exports kanbanStateService as an object', () => {
    expect(kanbanStateService).toBeDefined();
  });

  it('exports getWorkspaceInitPolicy as a function', () => {
    expect(typeof getWorkspaceInitPolicy).toBe('function');
  });

  // --- Lifecycle ---
  it('exports workspaceStateMachine as an object', () => {
    expect(workspaceStateMachine).toBeDefined();
  });

  it('exports WorkspaceStateMachineError as a constructor', () => {
    expect(typeof WorkspaceStateMachineError).toBe('function');
  });

  it('exports workspaceDataService as an object', () => {
    expect(workspaceDataService).toBeDefined();
  });

  it('exports workspaceActivityService as an object', () => {
    expect(workspaceActivityService).toBeDefined();
  });

  it('exports WorkspaceCreationService as a constructor', () => {
    expect(typeof WorkspaceCreationService).toBe('function');
  });

  // --- Worktree ---
  it('exports worktreeLifecycleService as an object', () => {
    expect(worktreeLifecycleService).toBeDefined();
  });

  it('exports assertWorktreePathSafe as a function', () => {
    expect(typeof assertWorktreePathSafe).toBe('function');
  });

  it('exports WorktreePathSafetyError as a constructor', () => {
    expect(typeof WorktreePathSafetyError).toBe('function');
  });

  // --- Query ---
  it('exports workspaceQueryService as an object', () => {
    expect(workspaceQueryService).toBeDefined();
  });
});
