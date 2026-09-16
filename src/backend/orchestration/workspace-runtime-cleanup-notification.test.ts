import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  workspaceActivityService,
  workspaceMaintenanceService,
  workspaceStateMachine,
  worktreeLifecycleService,
} from '@/backend/services/workspace';
import { workspaceCoreRouter } from '@/backend/trpc/workspace.trpc';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  archiveWorkspace,
  cleanupWorkspaceRuntimeResources,
  recoverStaleArchivingWorkspaces,
} from './workspace-archive.orchestrator';

vi.mock('@/backend/services/workspace/resources/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: vi.fn().mockResolvedValue({ name: 'Busy workspace', agentSessions: [] }),
  },
}));

vi.mock('./workspace-children.orchestrator', () => ({
  fireLifecycleNotification: vi.fn().mockResolvedValue(undefined),
}));

const workspaceId = 'cleanup-notification';
beforeEach(() => {
  vi.spyOn(workspaceStateMachine, 'isValidTransition').mockReturnValue(true);
  vi.spyOn(workspaceStateMachine, 'startArchivingWithSourceStatus').mockResolvedValue(
    unsafeCoerce({ previousStatus: 'READY' })
  );
  vi.spyOn(workspaceStateMachine, 'markArchived').mockResolvedValue(
    unsafeCoerce({ status: 'ARCHIVED' })
  );
  vi.spyOn(workspaceStateMachine, 'transition').mockResolvedValue(
    unsafeCoerce({ status: 'READY' })
  );
});
afterEach(() => {
  workspaceActivityService.clearWorkspace(workspaceId);
  vi.restoreAllMocks();
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

it.each([
  { rollback: false, recovery: false },
  { rollback: true, recovery: false },
  { rollback: false, recovery: true },
  { rollback: true, recovery: true },
])(
  'suppresses late activity throughout archive cleanup (rollback: $rollback, recovery: $recovery)',
  async ({ rollback, recovery }) => {
    const notify = vi.fn();
    workspaceActivityService.on('request_notification', notify);
    const counts: number[] = [];
    const finishLatePrompt = async () => {
      workspaceActivityService.markSessionRunning(workspaceId, 'late-prompt');
      workspaceActivityService.markSessionIdle(workspaceId, 'late-prompt');
      await new Promise<void>((resolve) => setImmediate(resolve));
      counts.push(notify.mock.calls.length);
    };
    vi.spyOn(worktreeLifecycleService, 'cleanupWorkspaceWorktree').mockImplementation(async () => {
      await finishLatePrompt();
      if (rollback) {
        throw new Error('worktree cleanup failed');
      }
    });
    vi.mocked(workspaceStateMachine.transition).mockImplementation(async () => {
      await finishLatePrompt();
      return unsafeCoerce({ status: 'READY' });
    });
    const services = {
      cleanupWorkspaceScopedCaches: () => workspaceActivityService.clearWorkspace(workspaceId),
      githubCLIService: { addIssueComment: vi.fn() },
      sessionLifecycleService: { stopWorkspaceSessions: finishLatePrompt },
      runScriptService: {
        stopRunScript: async () => ({ success: true }),
        evictWorkspaceBuffers: vi.fn(),
      },
      terminalService: { destroyWorkspaceTerminals: vi.fn() },
    };
    try {
      const workspace = unsafeCoerce<Parameters<typeof archiveWorkspace>[0]>({
        id: workspaceId,
        status: 'READY',
      });
      vi.spyOn(workspaceMaintenanceService, 'findStaleArchiving').mockResolvedValue([workspace]);
      const archive = recovery
        ? recoverStaleArchivingWorkspaces(services)
        : archiveWorkspace(workspace, {}, services);
      if (rollback) {
        if (recovery) {
          await expect(archive).resolves.toMatchObject({
            failed: [{ id: workspaceId, error: 'worktree cleanup failed' }],
          });
        } else {
          await expect(archive).rejects.toThrow('worktree cleanup failed');
        }
        expect(counts).toEqual([0, 0, 0]);
        workspaceActivityService.markSessionRunning(workspaceId, 'restarted');
        workspaceActivityService.markSessionIdle(workspaceId, 'restarted');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(notify).toHaveBeenCalledOnce();
      } else {
        await archive;
        expect(counts).toEqual([0, 0]);
        expect(notify).not.toHaveBeenCalled();
      }
    } finally {
      workspaceActivityService.off('request_notification', notify);
    }
  }
);

it.each([false, true])(
  'suppresses late activity throughout deletion (failure: %s)',
  async (failure) => {
    const notify = vi.fn();
    const counts: number[] = [];
    workspaceActivityService.on('request_notification', notify);
    const finishLatePrompt = async () => {
      workspaceActivityService.markSessionRunning(workspaceId, 'late-delete-prompt');
      workspaceActivityService.markSessionIdle(workspaceId, 'late-delete-prompt');
      await new Promise<void>((resolve) => setImmediate(resolve));
      counts.push(notify.mock.calls.length);
    };
    const caller = workspaceCoreRouter.createCaller(
      unsafeCoerce({
        appContext: {
          services: {
            workspaceActivityService,
            cleanupWorkspaceRuntimeResources,
            cleanupWorkspaceScopedCaches: () =>
              workspaceActivityService.clearWorkspace(workspaceId),
            createLogger: () => ({ error: vi.fn() }),
            workspaceDataService: {
              findByIdWithProject: async () => ({ id: workspaceId }),
              delete: async () => {
                await finishLatePrompt();
                if (failure) {
                  throw new Error('delete failed');
                }
                return { deleted: true };
              },
            },
            sessionLifecycleService: { stopWorkspaceSessions: finishLatePrompt },
            runScriptService: {
              stopRunScript: async () => ({ success: true }),
              evictWorkspaceBuffers: vi.fn(),
            },
            terminalService: { destroyWorkspaceTerminals: vi.fn() },
            worktreeLifecycleService: { cleanupWorkspaceWorktree: finishLatePrompt },
          },
        },
      })
    );
    try {
      const deletion = caller.delete({ id: workspaceId });
      if (failure) {
        await expect(deletion).rejects.toThrow('delete failed');
        expect(counts).toEqual([0, 0, 0]);
        workspaceActivityService.markSessionRunning(workspaceId, 'restarted');
        workspaceActivityService.markSessionIdle(workspaceId, 'restarted');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(notify).toHaveBeenCalledOnce();
      } else {
        await expect(deletion).resolves.toEqual({ deleted: true });
        expect(counts).toEqual([0, 0, 0]);
      }
    } finally {
      workspaceActivityService.off('request_notification', notify);
    }
  }
);
