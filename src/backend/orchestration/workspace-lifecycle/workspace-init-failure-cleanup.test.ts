// Register the shared mocks before any service or orchestrator module loads.
import './workspace-init.test-harness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionLifecycleService } from '@/backend/services/session';
import {
  gitOpsService,
  workspaceDataService,
  workspaceStateMachine,
} from '@/backend/services/workspace';
import {
  clearWorkspaceInitOrchestratorStateForTests,
  initializeWorkspaceWorktree,
} from './workspace-init.orchestrator';
import { mockWorkspaceUpdate, setupHappyPath, WORKSPACE_ID } from './workspace-init.test-harness';

describe('initializeWorkspaceWorktree failure cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearWorkspaceInitOrchestratorStateForTests();
  });

  // The workspace is deleted while `git worktree add` is running, so registering
  // the worktree fails and markFailed throws "Workspace not found". Cleanup must
  // still run, or the worktree directory and its branch leak on disk.
  it('removes the freshly created worktree when the workspace was deleted mid-provisioning', async () => {
    const workspace = setupHappyPath();
    vi.mocked(mockWorkspaceUpdate).mockRejectedValue(new Error('Record to update not found.'));
    vi.mocked(workspaceStateMachine.markFailed).mockRejectedValue(
      new Error(`Workspace not found: ${WORKSPACE_ID}`)
    );
    vi.mocked(workspaceDataService.findById).mockResolvedValue(null);

    await expect(initializeWorkspaceWorktree(WORKSPACE_ID)).resolves.toBeUndefined();

    expect(gitOpsService.removeWorktree).toHaveBeenCalledWith(
      '/worktrees/workspace-ws-1',
      workspace.project
    );
    expect(sessionLifecycleService.stopWorkspaceSessions).toHaveBeenCalledWith(WORKSPACE_ID);
  });
});
