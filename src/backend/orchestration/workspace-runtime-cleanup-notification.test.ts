import { afterEach, expect, it, vi } from 'vitest';
import { workspaceActivityService } from '@/backend/services/workspace';
import { cleanupWorkspaceRuntimeResources } from './workspace-archive.orchestrator';

vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: vi.fn().mockResolvedValue({ name: 'Busy workspace', agentSessions: [] }),
  },
}));

const workspaceId = 'cleanup-notification';
afterEach(() => {
  workspaceActivityService.clearWorkspace(workspaceId);
});

it.each(['archive', 'delete'] as const)(
  'suppresses completion before %s stops sessions and enters slow worktree cleanup',
  async (operation) => {
    const notify = vi.fn();
    workspaceActivityService.on('request_notification', notify);
    workspaceActivityService.markSessionRunning(workspaceId, 'session-1');
    try {
      await cleanupWorkspaceRuntimeResources(
        workspaceId,
        {
          sessionLifecycleService: {
            stopWorkspaceSessions: async () => {
              workspaceActivityService.markSessionIdle(workspaceId, 'session-1');
              // Let the fast workspace lookup complete before runtime cleanup returns.
              await new Promise<void>((resolve) => setImmediate(resolve));
            },
          },
          runScriptService: { stopRunScript: async () => ({ success: true }) },
          terminalService: { destroyWorkspaceTerminals: vi.fn() },
        },
        operation
      );
      expect(notify).not.toHaveBeenCalled();
      // An unsuccessful archive can later restart work and notify normally.
      workspaceActivityService.markSessionRunning(workspaceId, 'session-2');
      workspaceActivityService.markSessionIdle(workspaceId, 'session-2');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(notify).toHaveBeenCalledOnce();
    } finally {
      workspaceActivityService.off('request_notification', notify);
    }
  }
);
