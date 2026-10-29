// Register the shared mocks before any service or orchestrator module loads.
import './workspace-init.test-harness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionDataService, sessionLifecycleService } from '@/backend/services/session';
import { gitOpsService, workspaceStateMachine } from '@/backend/services/workspace';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  clearWorkspaceInitOrchestratorStateForTests,
  initializeWorkspaceWorktree,
} from './workspace-init.orchestrator';
import { WORKSPACE_ID, setupHappyPath } from './workspace-init.test-harness';

describe('workspace startup for retired workflows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearWorkspaceInitOrchestratorStateForTests();
  });

  it('opens legacy loop workspaces using their existing worktree and ordinary session', async () => {
    setupHappyPath({
      mode: 'AUTO_ITERATION',
      worktreePath: '/worktrees/existing-ws-1',
      branchName: 'legacy-work',
    });
    vi.mocked(sessionDataService.findAgentSessionsByWorkspaceId).mockResolvedValue([
      unsafeCoerce({ id: 'legacy-session', model: 'default', workflow: 'auto-iteration' }),
    ]);

    await initializeWorkspaceWorktree(WORKSPACE_ID);

    expect(sessionLifecycleService.startSession).toHaveBeenCalledWith(
      'legacy-session',
      expect.any(Object)
    );
    expect(workspaceStateMachine.markReady).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(gitOpsService.createWorktree).not.toHaveBeenCalled();
    expect(gitOpsService.removeWorktree).not.toHaveBeenCalled();
    expect(sessionLifecycleService.stopWorkspaceSessions).not.toHaveBeenCalled();
  });
});
