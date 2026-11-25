import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@/backend/lib/application-error';
import type { WorkspaceWithProject } from '@/backend/orchestration/types';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

const mockCleanupWorkspaceScopedCaches = vi.hoisted(() => vi.fn());

vi.mock('./workspace-children.orchestrator', () => ({
  fireLifecycleNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/backend/services/workspace', async (importOriginal) => ({
  formatArchiveIncompleteMessage: (
    await importOriginal<typeof import('@/backend/services/workspace')>()
  ).formatArchiveIncompleteMessage,
  archivedWorkspaceBlobRetentionService: {
    releaseAfterArchive: vi.fn(),
  },
  workspaceActivityService: {
    clearWorkspace: vi.fn(),
    withNotificationsSuppressed: (_workspaceId: string, operation: () => Promise<unknown>) =>
      operation(),
  },
  workspaceMaintenanceService: {
    findStaleArchiving: vi.fn(),
  },
  workspaceStateMachine: {
    isValidTransition: vi.fn(),
    startArchivingWithSourceStatus: vi.fn(),
    markArchived: vi.fn(),
    transition: vi.fn(),
  },
  worktreeLifecycleService: {
    archiveRemovalMayHaveStarted: vi.fn(),
    snapshotWorkspaceWorktree: vi.fn(),
    removeWorkspaceWorktree: vi.fn(),
  },
}));

vi.mock('@/backend/lib/worktree-process-sweep', () => ({
  sweepWorktreeProcesses: vi.fn(),
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { sweepWorktreeProcesses } from '@/backend/lib/worktree-process-sweep';
import {
  archivedWorkspaceBlobRetentionService,
  workspaceMaintenanceService,
  workspaceStateMachine,
  worktreeLifecycleService,
} from '@/backend/services/workspace';
import type { ArchiveWorkspaceDependencies } from './workspace-archive.orchestrator';
import {
  archiveWorkspace as archiveWorkspaceWithServices,
  cleanupWorkspaceRuntimeResources,
  recoverStaleArchivingWorkspaces,
} from './workspace-archive.orchestrator';

function makeWorkspace(overrides: Partial<WorkspaceWithProject> = {}): WorkspaceWithProject {
  return unsafeCoerce<WorkspaceWithProject>({
    id: 'ws-1',
    status: 'READY',
    githubIssueNumber: null,
    prState: null,
    prUrl: null,
    project: {
      id: 'proj-1',
      githubOwner: 'owner',
      githubRepo: 'repo',
    },
    ...overrides,
    prs:
      overrides.prs ??
      (overrides.prUrl ? [{ id: 'pr-1', url: overrides.prUrl, state: overrides.prState }] : []),
  });
}

const defaultOptions = {};

const services = unsafeCoerce<ArchiveWorkspaceDependencies>({
  cleanupWorkspaceScopedCaches: mockCleanupWorkspaceScopedCaches,
  githubCLIService: {
    addIssueComment: vi.fn(),
  },
  runScriptService: {
    stopRunScript: vi.fn(),
    evictWorkspaceBuffers: vi.fn(),
  },
  sessionLifecycleService: {
    stopWorkspaceSessions: vi.fn(),
  },
  terminalService: {
    destroyWorkspaceTerminals: vi.fn(),
  },
});

function archiveWorkspace(workspace: WorkspaceWithProject, options = defaultOptions) {
  return archiveWorkspaceWithServices(workspace, options, services);
}

describe('archiveWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceStateMachine.isValidTransition).mockReturnValue(true);
    vi.mocked(workspaceStateMachine.startArchivingWithSourceStatus).mockResolvedValue(
      unsafeCoerce({
        workspace: { id: 'ws-1', status: 'ARCHIVING' },
        previousStatus: 'READY',
      })
    );
    vi.mocked(workspaceStateMachine.markArchived).mockResolvedValue(
      unsafeCoerce({ id: 'ws-1', status: 'ARCHIVED' })
    );
    vi.mocked(workspaceStateMachine.transition).mockResolvedValue(
      unsafeCoerce({ id: 'ws-1', status: 'READY' })
    );
    vi.mocked(workspaceMaintenanceService.findStaleArchiving).mockResolvedValue([]);
    vi.mocked(worktreeLifecycleService.archiveRemovalMayHaveStarted).mockResolvedValue(false);
    vi.mocked(worktreeLifecycleService.snapshotWorkspaceWorktree).mockResolvedValue(undefined);
    vi.mocked(worktreeLifecycleService.removeWorkspaceWorktree).mockResolvedValue(undefined);
    vi.mocked(services.sessionLifecycleService.stopWorkspaceSessions).mockResolvedValue(
      undefined as never
    );
    vi.mocked(services.runScriptService.stopRunScript).mockResolvedValue(
      unsafeCoerce({ success: true } as const)
    );
    vi.mocked(services.runScriptService.evictWorkspaceBuffers).mockReturnValue(undefined);
    vi.mocked(services.terminalService.destroyWorkspaceTerminals).mockReturnValue(undefined);
    vi.mocked(sweepWorktreeProcesses).mockResolvedValue({ status: 'unsupported' });
  });

  describe('leftover worktree process sweep', () => {
    const worktreeWorkspace = () =>
      makeWorkspace({
        worktreePath: '/base/workspace-ws-1',
        project: unsafeCoerce({ id: 'proj-1', worktreeBasePath: '/base' }),
      });

    it('sweeps after owned runtime cleanup and before worktree removal', async () => {
      await archiveWorkspace(worktreeWorkspace());

      expect(sweepWorktreeProcesses).toHaveBeenCalledWith({
        worktreePath: '/base/workspace-ws-1',
        worktreeBasePath: '/base',
      });
      const [sweepOrder] = vi.mocked(sweepWorktreeProcesses).mock.invocationCallOrder;
      const [terminalOrder] = vi.mocked(services.terminalService.destroyWorkspaceTerminals).mock
        .invocationCallOrder;
      const [worktreeOrder] = vi.mocked(worktreeLifecycleService.snapshotWorkspaceWorktree).mock
        .invocationCallOrder;
      expect(terminalOrder).toBeLessThan(sweepOrder ?? 0);
      expect(sweepOrder).toBeLessThan(worktreeOrder ?? 0);
    });

    it('does not block the archive when the sweep fails', async () => {
      vi.mocked(sweepWorktreeProcesses).mockRejectedValue(new Error('lsof failed'));

      await expect(archiveWorkspace(worktreeWorkspace())).resolves.toMatchObject({
        status: 'ARCHIVED',
      });
      expect(worktreeLifecycleService.removeWorkspaceWorktree).toHaveBeenCalledOnce();
    });

    it('does not sweep when owned runtime cleanup fails and the archive rolls back', async () => {
      vi.mocked(services.sessionLifecycleService.stopWorkspaceSessions).mockRejectedValue(
        new Error('session stop failed')
      );

      await expect(archiveWorkspace(worktreeWorkspace())).rejects.toThrow(
        /Failed to cleanup workspace resources before archive/
      );
      expect(sweepWorktreeProcesses).not.toHaveBeenCalled();
    });

    it('skips the sweep without a worktree path or worktree argument', async () => {
      await archiveWorkspace(makeWorkspace({ worktreePath: null }));
      await cleanupWorkspaceRuntimeResources('ws-1', services, 'delete');

      expect(sweepWorktreeProcesses).not.toHaveBeenCalled();
    });

    it('sweeps for delete when given the workspace worktree', async () => {
      await cleanupWorkspaceRuntimeResources('ws-1', services, 'delete', worktreeWorkspace());

      expect(sweepWorktreeProcesses).toHaveBeenCalledOnce();
    });
  });

  describe('state transition validation', () => {
    it('throws an invalid-input application error when transition is invalid', async () => {
      vi.mocked(workspaceStateMachine.isValidTransition).mockReturnValue(false);
      const workspace = makeWorkspace({ status: 'NEW' as never });

      const error = await archiveWorkspace(workspace, defaultOptions).catch(
        (caught: unknown) => caught
      );

      expect(error).toBeInstanceOf(ApplicationError);
      expect(error).toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Cannot archive workspace from status: NEW',
      });
    });

    it('checks transition from current status to ARCHIVING', async () => {
      const workspace = makeWorkspace({ status: 'READY' as never });
      await archiveWorkspace(workspace, defaultOptions);

      expect(workspaceStateMachine.isValidTransition).toHaveBeenCalledWith('READY', 'ARCHIVING');
    });

    it('does not attempt cleanup when transition is invalid', async () => {
      vi.mocked(workspaceStateMachine.isValidTransition).mockReturnValue(false);
      const workspace = makeWorkspace();

      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow();
      expect(services.sessionLifecycleService.stopWorkspaceSessions).not.toHaveBeenCalled();
      expect(worktreeLifecycleService.snapshotWorkspaceWorktree).not.toHaveBeenCalled();
      expect(worktreeLifecycleService.removeWorkspaceWorktree).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('transitions workspace through ARCHIVING before ARCHIVED', async () => {
      const workspace = makeWorkspace();
      await archiveWorkspace(workspace, defaultOptions);

      expect(workspaceStateMachine.startArchivingWithSourceStatus).toHaveBeenCalledWith('ws-1');
      expect(workspaceStateMachine.markArchived).toHaveBeenCalledWith('ws-1');
    });

    it('stops sessions, run scripts, and terminals then cleans up worktree', async () => {
      const workspace = makeWorkspace();
      await archiveWorkspace(workspace, defaultOptions);

      expect(services.sessionLifecycleService.stopWorkspaceSessions).toHaveBeenCalledWith('ws-1', {
        reason: 'WORKSPACE_ARCHIVED',
      });
      expect(services.runScriptService.stopRunScript).toHaveBeenCalledWith('ws-1');
      expect(services.terminalService.destroyWorkspaceTerminals).toHaveBeenCalledWith('ws-1');
      expect(worktreeLifecycleService.snapshotWorkspaceWorktree).toHaveBeenCalledWith(
        workspace,
        defaultOptions
      );
      expect(worktreeLifecycleService.removeWorkspaceWorktree).toHaveBeenCalledWith(workspace);
    });

    it('marks workspace as archived after cleanup', async () => {
      const workspace = makeWorkspace();
      await archiveWorkspace(workspace, defaultOptions);

      expect(workspaceStateMachine.startArchivingWithSourceStatus).toHaveBeenCalledWith('ws-1');
      expect(workspaceStateMachine.markArchived).toHaveBeenCalledWith('ws-1');
      expect(services.runScriptService.evictWorkspaceBuffers).toHaveBeenCalledWith('ws-1');
    });

    it('cleans workspace caches after the archived state is persisted', async () => {
      await archiveWorkspace(makeWorkspace(), defaultOptions);

      expect(mockCleanupWorkspaceScopedCaches).toHaveBeenCalledWith('ws-1');
      const archivedCallOrder = vi.mocked(workspaceStateMachine.markArchived).mock
        .invocationCallOrder[0];
      const cleanupCallOrder = mockCleanupWorkspaceScopedCaches.mock.invocationCallOrder[0];
      expect(archivedCallOrder).toBeDefined();
      expect(cleanupCallOrder).toBeDefined();
      expect(cleanupCallOrder!).toBeGreaterThan(archivedCallOrder!);
    });

    it('releases archived-only data once ARCHIVED is persisted', async () => {
      await archiveWorkspace(makeWorkspace(), defaultOptions);

      const release = vi.mocked(archivedWorkspaceBlobRetentionService.releaseAfterArchive);
      expect(release).toHaveBeenCalledExactlyOnceWith('ws-1');
      expect(release.mock.invocationCallOrder[0]).toBeGreaterThan(
        vi.mocked(workspaceStateMachine.markArchived).mock.invocationCallOrder[0]!
      );
    });

    it('returns the archived workspace', async () => {
      const archivedWs = unsafeCoerce({ id: 'ws-1', status: 'ARCHIVED' });
      vi.mocked(workspaceStateMachine.markArchived).mockResolvedValue(archivedWs as never);
      const workspace = makeWorkspace();

      const result = await archiveWorkspace(workspace, defaultOptions);
      expect(result).toBe(archivedWs);
    });

    it('passes an explicit Git index-lock recovery action to worktree cleanup', async () => {
      const workspace = makeWorkspace();
      await archiveWorkspace(workspace, { removeGitIndexLock: true });

      expect(worktreeLifecycleService.snapshotWorkspaceWorktree).toHaveBeenCalledWith(workspace, {
        removeGitIndexLock: true,
      });
    });
  });

  describe('process cleanup errors (fail closed)', () => {
    it.each([
      ['archive', 'WORKSPACE_ARCHIVED'],
      ['delete', 'SYSTEM_STOP'],
    ] as const)('uses %s stop reason for shared runtime cleanup', async (operation, reason) => {
      await cleanupWorkspaceRuntimeResources('ws-1', services, operation);

      expect(services.sessionLifecycleService.stopWorkspaceSessions).toHaveBeenCalledWith('ws-1', {
        reason,
      });
    });

    it('uses operation-specific wording when shared runtime cleanup fails', async () => {
      vi.mocked(services.runScriptService.stopRunScript).mockResolvedValue(
        unsafeCoerce({ success: false, error: 'stop failed' })
      );

      await expect(cleanupWorkspaceRuntimeResources('ws-1', services, 'delete')).rejects.toThrow(
        /Failed to cleanup workspace resources before delete/
      );
    });

    it('fails archive when session stop fails', async () => {
      vi.mocked(services.sessionLifecycleService.stopWorkspaceSessions).mockRejectedValue(
        new Error('session stop failed')
      );
      const workspace = makeWorkspace();

      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow(
        /Failed to cleanup workspace resources before archive/
      );
      expect(worktreeLifecycleService.snapshotWorkspaceWorktree).not.toHaveBeenCalled();
      expect(worktreeLifecycleService.removeWorkspaceWorktree).not.toHaveBeenCalled();
      expect(workspaceStateMachine.markArchived).not.toHaveBeenCalled();
    });

    it('retains multiple runtime cleanup failures as an aggregate cause', async () => {
      const sessionError = new Error('session stop failed');
      const terminalError = new Error('terminal destroy failed');
      vi.mocked(services.sessionLifecycleService.stopWorkspaceSessions).mockRejectedValue(
        sessionError
      );
      vi.mocked(services.terminalService.destroyWorkspaceTerminals).mockImplementation(() => {
        throw terminalError;
      });

      const error = await cleanupWorkspaceRuntimeResources('ws-1', services, 'archive').catch(
        (caught: unknown) => caught
      );

      expect(error).toBeInstanceOf(ApplicationError);
      expect(error).toMatchObject({ code: 'INTERNAL_ERROR' });
      expect((error as ApplicationError).cause).toBeInstanceOf(AggregateError);
      expect((error as ApplicationError).cause).toMatchObject({
        errors: [sessionError, terminalError],
      });
    });

    it('fails archive when run script stop rejects', async () => {
      vi.mocked(services.runScriptService.stopRunScript).mockRejectedValue(
        new Error('run script stop failed')
      );
      const workspace = makeWorkspace();

      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow(
        /Failed to cleanup workspace resources before archive/
      );
      expect(worktreeLifecycleService.snapshotWorkspaceWorktree).not.toHaveBeenCalled();
      expect(worktreeLifecycleService.removeWorkspaceWorktree).not.toHaveBeenCalled();
      expect(workspaceStateMachine.markArchived).not.toHaveBeenCalled();
    });

    it('fails archive when run script stop returns unsuccessful result', async () => {
      vi.mocked(services.runScriptService.stopRunScript).mockResolvedValue(
        unsafeCoerce({ success: false, error: 'stop failed' })
      );
      const workspace = makeWorkspace();

      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow(
        /Failed to cleanup workspace resources before archive/
      );
      expect(worktreeLifecycleService.snapshotWorkspaceWorktree).not.toHaveBeenCalled();
      expect(worktreeLifecycleService.removeWorkspaceWorktree).not.toHaveBeenCalled();
      expect(workspaceStateMachine.markArchived).not.toHaveBeenCalled();
    });

    it('fails archive when terminal destroy throws', async () => {
      vi.mocked(services.terminalService.destroyWorkspaceTerminals).mockImplementation(() => {
        throw new Error('terminal destroy failed');
      });
      const workspace = makeWorkspace();

      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow(
        /Failed to cleanup workspace resources before archive/
      );
      expect(worktreeLifecycleService.snapshotWorkspaceWorktree).not.toHaveBeenCalled();
      expect(worktreeLifecycleService.removeWorkspaceWorktree).not.toHaveBeenCalled();
      expect(workspaceStateMachine.markArchived).not.toHaveBeenCalled();
    });
  });

  describe('worktree cleanup failure', () => {
    it('re-throws when worktree cleanup fails', async () => {
      const cleanupError = new Error('worktree cleanup failed');
      vi.mocked(worktreeLifecycleService.removeWorkspaceWorktree).mockRejectedValue(cleanupError);
      const workspace = makeWorkspace();

      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow(
        'worktree cleanup failed'
      );
    });

    it('does not mark workspace as archived when worktree cleanup fails', async () => {
      vi.mocked(worktreeLifecycleService.removeWorkspaceWorktree).mockRejectedValue(
        new Error('cleanup failed')
      );
      const workspace = makeWorkspace();

      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow();
      expect(workspaceStateMachine.markArchived).not.toHaveBeenCalled();
      // A rolled-back archive keeps the attachments and log Retry may need.
      expect(archivedWorkspaceBlobRetentionService.releaseAfterArchive).not.toHaveBeenCalled();
    });

    it('releases nothing when the ARCHIVED transition itself fails', async () => {
      vi.mocked(workspaceStateMachine.markArchived).mockRejectedValue(new Error('CAS lost'));

      await expect(archiveWorkspace(makeWorkspace(), defaultOptions)).rejects.toThrow('CAS lost');
      expect(archivedWorkspaceBlobRetentionService.releaseAfterArchive).not.toHaveBeenCalled();
    });

    it('rolls status back when the snapshot fails, before removal starts', async () => {
      vi.mocked(worktreeLifecycleService.snapshotWorkspaceWorktree).mockRejectedValue(
        new Error('snapshot failed')
      );
      const workspace = makeWorkspace();

      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow();
      expect(workspaceStateMachine.transition).toHaveBeenCalledWith('ws-1', 'READY');
      expect(worktreeLifecycleService.removeWorkspaceWorktree).not.toHaveBeenCalled();
    });

    it('rolls status back using the captured source status from ARCHIVING transition', async () => {
      vi.mocked(workspaceStateMachine.startArchivingWithSourceStatus).mockResolvedValue(
        unsafeCoerce({
          workspace: { id: 'ws-1', status: 'ARCHIVING' },
          previousStatus: 'FAILED',
        })
      );
      vi.mocked(worktreeLifecycleService.snapshotWorkspaceWorktree).mockRejectedValue(
        new Error('snapshot failed')
      );
      const workspace = makeWorkspace();

      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow();
      expect(workspaceStateMachine.transition).toHaveBeenCalledWith('ws-1', 'FAILED');
    });

    it('moves forward to FAILED, never READY, once worktree removal fails', async () => {
      vi.mocked(worktreeLifecycleService.removeWorkspaceWorktree).mockRejectedValue(
        new Error('git worktree remove timed out after 300000ms.')
      );

      await expect(archiveWorkspace(makeWorkspace(), defaultOptions)).rejects.toThrow(
        'git worktree remove timed out'
      );
      expect(workspaceStateMachine.transition).toHaveBeenCalledExactlyOnceWith('ws-1', 'FAILED', {
        errorMessage:
          'Archive incomplete: git worktree remove timed out after 300000ms. Archive again to finish.',
      });
    });

    it('moves forward to FAILED when the ARCHIVED write fails after removal', async () => {
      vi.mocked(workspaceStateMachine.markArchived).mockRejectedValue(new Error('CAS lost'));

      await expect(archiveWorkspace(makeWorkspace(), defaultOptions)).rejects.toThrow('CAS lost');
      expect(workspaceStateMachine.transition).toHaveBeenCalledExactlyOnceWith('ws-1', 'FAILED', {
        errorMessage: 'Archive incomplete: CAS lost. Archive again to finish.',
      });
    });

    it('retries an incomplete archive without a snapshot and never rolls it back', async () => {
      const incomplete = makeWorkspace({
        status: 'FAILED' as never,
        initErrorMessage: 'Archive incomplete: removal timed out. Archive again to finish.',
      });
      vi.mocked(worktreeLifecycleService.archiveRemovalMayHaveStarted).mockResolvedValue(true);
      vi.mocked(workspaceStateMachine.startArchivingWithSourceStatus).mockResolvedValue(
        unsafeCoerce({ workspace: { id: 'ws-1', status: 'ARCHIVING' }, previousStatus: 'FAILED' })
      );

      await expect(archiveWorkspace(incomplete, defaultOptions)).resolves.toMatchObject({
        status: 'ARCHIVED',
      });
      expect(worktreeLifecycleService.archiveRemovalMayHaveStarted).toHaveBeenCalledWith(
        incomplete
      );
      expect(worktreeLifecycleService.snapshotWorkspaceWorktree).not.toHaveBeenCalled();
      expect(worktreeLifecycleService.removeWorkspaceWorktree).toHaveBeenCalledWith(incomplete);

      // Even a failure before removal in the retry keeps the marker.
      vi.mocked(services.sessionLifecycleService.stopWorkspaceSessions).mockRejectedValueOnce(
        new Error('session stop failed')
      );
      await expect(archiveWorkspace(incomplete, defaultOptions)).rejects.toThrow(
        /Failed to cleanup workspace resources before archive/
      );
      expect(workspaceStateMachine.transition).toHaveBeenCalledExactlyOnceWith('ws-1', 'FAILED', {
        errorMessage:
          'Archive incomplete: Failed to cleanup workspace resources before archive. Archive again to finish.',
      });
    });
  });

  describe('GitHub issue comment on archive', () => {
    it('adds comment when workspace has merged PR and linked issue', async () => {
      const workspace = makeWorkspace({
        githubIssueNumber: 42,
        prState: 'MERGED' as never,
        prUrl: 'https://github.com/owner/repo/pull/10',
      });

      await archiveWorkspace(workspace, defaultOptions);

      expect(services.githubCLIService.addIssueComment).toHaveBeenCalledWith(
        'owner',
        'repo',
        42,
        expect.stringContaining('https://github.com/owner/repo/pull/10')
      );
    });

    it('skips comment when no GitHub issue is linked', async () => {
      const workspace = makeWorkspace({
        githubIssueNumber: null,
        prState: 'MERGED' as never,
        prUrl: 'https://github.com/owner/repo/pull/10',
      });

      await archiveWorkspace(workspace, defaultOptions);

      expect(services.githubCLIService.addIssueComment).not.toHaveBeenCalled();
    });

    it('skips comment when PR is not merged', async () => {
      const workspace = makeWorkspace({
        githubIssueNumber: 42,
        prState: 'OPEN' as never,
        prUrl: 'https://github.com/owner/repo/pull/10',
      });

      await archiveWorkspace(workspace, defaultOptions);

      expect(services.githubCLIService.addIssueComment).not.toHaveBeenCalled();
    });

    it('skips comment when PR URL is missing even if state is MERGED', async () => {
      const workspace = makeWorkspace({
        githubIssueNumber: 42,
        prState: 'MERGED' as never,
        prUrl: null,
      });

      await archiveWorkspace(workspace, defaultOptions);

      expect(services.githubCLIService.addIssueComment).not.toHaveBeenCalled();
    });

    it('skips comment when project lacks GitHub owner/repo', async () => {
      const workspace = makeWorkspace({
        githubIssueNumber: 42,
        prState: 'MERGED' as never,
        prUrl: 'https://github.com/owner/repo/pull/10',
        project: unsafeCoerce({
          id: 'proj-1',
          githubOwner: null,
          githubRepo: null,
        }),
      });

      await archiveWorkspace(workspace, defaultOptions);

      expect(services.githubCLIService.addIssueComment).not.toHaveBeenCalled();
    });

    it('does not fail archive when GitHub comment fails', async () => {
      vi.mocked(services.githubCLIService.addIssueComment).mockRejectedValue(
        new Error('GitHub API error')
      );
      const workspace = makeWorkspace({
        githubIssueNumber: 42,
        prState: 'MERGED' as never,
        prUrl: 'https://github.com/owner/repo/pull/10',
      });

      const result = await archiveWorkspace(workspace, defaultOptions);

      expect(result).toBeDefined();
      expect(workspaceStateMachine.markArchived).toHaveBeenCalled();
    });

    it('comment includes the PR URL', async () => {
      const workspace = makeWorkspace({
        githubIssueNumber: 42,
        prState: 'MERGED' as never,
        prUrl: 'https://github.com/owner/repo/pull/99',
      });

      await archiveWorkspace(workspace, defaultOptions);

      const commentArg = vi.mocked(services.githubCLIService.addIssueComment).mock.calls[0]?.[3];
      expect(commentArg).toContain('merged');
      expect(commentArg).toContain('https://github.com/owner/repo/pull/99');
    });
  });

  describe('ordering guarantees', () => {
    it('stops processes before cleaning up worktree', async () => {
      const callOrder: string[] = [];
      vi.mocked(services.sessionLifecycleService.stopWorkspaceSessions).mockImplementation((() => {
        callOrder.push('stopSessions');
        return Promise.resolve(undefined);
      }) as never);
      vi.mocked(services.runScriptService.stopRunScript).mockImplementation((() => {
        callOrder.push('stopRunScript');
        return Promise.resolve(unsafeCoerce({ success: true }));
      }) as never);
      vi.mocked(services.terminalService.destroyWorkspaceTerminals).mockImplementation(() => {
        callOrder.push('destroyTerminals');
      });
      vi.mocked(worktreeLifecycleService.snapshotWorkspaceWorktree).mockImplementation((() => {
        callOrder.push('snapshotWorktree');
        return Promise.resolve();
      }) as never);
      vi.mocked(worktreeLifecycleService.removeWorkspaceWorktree).mockImplementation((() => {
        callOrder.push('removeWorktree');
        return Promise.resolve();
      }) as never);
      vi.mocked(workspaceStateMachine.startArchivingWithSourceStatus).mockImplementation((() => {
        callOrder.push('startArchiving');
        return Promise.resolve(
          unsafeCoerce({
            workspace: { id: 'ws-1', status: 'ARCHIVING' },
            previousStatus: 'READY',
          })
        );
      }) as never);
      vi.mocked(workspaceStateMachine.markArchived).mockImplementation((() => {
        callOrder.push('markArchived');
        return Promise.resolve(unsafeCoerce({ id: 'ws-1', status: 'ARCHIVED' }));
      }) as never);

      await archiveWorkspace(makeWorkspace(), defaultOptions);

      const snapshotIdx = callOrder.indexOf('snapshotWorktree');
      const worktreeIdx = callOrder.indexOf('removeWorktree');
      const archiveIdx = callOrder.indexOf('markArchived');
      expect(snapshotIdx).toBeGreaterThan(-1);
      expect(worktreeIdx).toBeGreaterThan(snapshotIdx);
      expect(archiveIdx).toBeGreaterThan(worktreeIdx);
      expect(callOrder.indexOf('stopSessions')).toBeLessThan(snapshotIdx);
    });

    it('archives after worktree cleanup but before GitHub comment', async () => {
      const callOrder: string[] = [];
      vi.mocked(worktreeLifecycleService.snapshotWorkspaceWorktree).mockImplementation((() => {
        callOrder.push('snapshotWorktree');
        return Promise.resolve();
      }) as never);
      vi.mocked(worktreeLifecycleService.removeWorkspaceWorktree).mockImplementation((() => {
        callOrder.push('removeWorktree');
        return Promise.resolve();
      }) as never);
      vi.mocked(workspaceStateMachine.startArchivingWithSourceStatus).mockImplementation((() => {
        callOrder.push('startArchiving');
        return Promise.resolve(
          unsafeCoerce({
            workspace: { id: 'ws-1', status: 'ARCHIVING' },
            previousStatus: 'READY',
          })
        );
      }) as never);
      vi.mocked(workspaceStateMachine.markArchived).mockImplementation((() => {
        callOrder.push('markArchived');
        return Promise.resolve(unsafeCoerce({ id: 'ws-1', status: 'ARCHIVED' }));
      }) as never);
      vi.mocked(services.githubCLIService.addIssueComment).mockImplementation((() => {
        callOrder.push('addIssueComment');
        return Promise.resolve();
      }) as never);

      const workspace = makeWorkspace({
        githubIssueNumber: 42,
        prState: 'MERGED' as never,
        prUrl: 'https://github.com/owner/repo/pull/10',
      });

      await archiveWorkspace(workspace, defaultOptions);

      expect(callOrder).toEqual([
        'startArchiving',
        'snapshotWorktree',
        'removeWorktree',
        'markArchived',
        'addIssueComment',
      ]);
    });
  });
});

describe('recoverStaleArchivingWorkspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceMaintenanceService.findStaleArchiving).mockResolvedValue([]);
    vi.mocked(workspaceStateMachine.markArchived).mockResolvedValue(
      unsafeCoerce({ id: 'ws-1', status: 'ARCHIVED' })
    );
    vi.mocked(workspaceStateMachine.transition).mockResolvedValue(
      unsafeCoerce({ id: 'ws-1', status: 'FAILED' })
    );
    vi.mocked(worktreeLifecycleService.archiveRemovalMayHaveStarted).mockResolvedValue(false);
    vi.mocked(worktreeLifecycleService.snapshotWorkspaceWorktree).mockResolvedValue(undefined);
    vi.mocked(worktreeLifecycleService.removeWorkspaceWorktree).mockResolvedValue(undefined);
    vi.mocked(services.sessionLifecycleService.stopWorkspaceSessions).mockResolvedValue(
      undefined as never
    );
    vi.mocked(services.runScriptService.stopRunScript).mockResolvedValue(
      unsafeCoerce({ success: true } as const)
    );
    vi.mocked(services.runScriptService.evictWorkspaceBuffers).mockReturnValue(undefined);
    vi.mocked(services.terminalService.destroyWorkspaceTerminals).mockReturnValue(undefined);
  });

  it('returns empty result when no stale archiving workspaces exist', async () => {
    const result = await recoverStaleArchivingWorkspaces(services);

    expect(result).toEqual({ archived: [], failed: [] });
    expect(workspaceMaintenanceService.findStaleArchiving).toHaveBeenCalledOnce();
    expect(workspaceStateMachine.markArchived).not.toHaveBeenCalled();
  });

  it('resumes stale ARCHIVING workspaces without starting archiving again', async () => {
    const workspace = makeWorkspace({ status: 'ARCHIVING' as never });
    vi.mocked(workspaceMaintenanceService.findStaleArchiving).mockResolvedValue([workspace]);

    const result = await recoverStaleArchivingWorkspaces(services);

    expect(result).toEqual({ archived: ['ws-1'], failed: [] });
    expect(workspaceStateMachine.startArchivingWithSourceStatus).not.toHaveBeenCalled();
    expect(services.sessionLifecycleService.stopWorkspaceSessions).toHaveBeenCalledWith('ws-1', {
      reason: 'WORKSPACE_ARCHIVED',
    });
    expect(services.runScriptService.stopRunScript).toHaveBeenCalledWith('ws-1');
    expect(services.terminalService.destroyWorkspaceTerminals).toHaveBeenCalledWith('ws-1');
    expect(worktreeLifecycleService.snapshotWorkspaceWorktree).toHaveBeenCalledWith(workspace, {});
    expect(worktreeLifecycleService.removeWorkspaceWorktree).toHaveBeenCalledWith(workspace);
    expect(workspaceStateMachine.markArchived).toHaveBeenCalledWith('ws-1');
    expect(services.runScriptService.evictWorkspaceBuffers).toHaveBeenCalledWith('ws-1');
    expect(archivedWorkspaceBlobRetentionService.releaseAfterArchive).toHaveBeenCalledWith('ws-1');
  });

  it('marks a stale ARCHIVING workspace as FAILED when recovery cannot complete', async () => {
    const workspace = makeWorkspace({ status: 'ARCHIVING' as never });
    vi.mocked(workspaceMaintenanceService.findStaleArchiving).mockResolvedValue([workspace]);
    vi.mocked(worktreeLifecycleService.snapshotWorkspaceWorktree).mockRejectedValue(
      new Error('worktree cleanup failed')
    );

    const result = await recoverStaleArchivingWorkspaces(services);

    expect(result).toEqual({
      archived: [],
      failed: [{ id: 'ws-1', error: 'worktree cleanup failed' }],
    });
    expect(workspaceStateMachine.markArchived).not.toHaveBeenCalled();
    expect(workspaceStateMachine.transition).toHaveBeenCalledWith('ws-1', 'FAILED', {
      errorMessage: 'Archive recovery failed after restart: worktree cleanup failed',
    });
  });

  it('continues recovering remaining stale workspaces after one failure', async () => {
    const failedWorkspace = makeWorkspace({ id: 'ws-failed', status: 'ARCHIVING' as never });
    const archivedWorkspace = makeWorkspace({ id: 'ws-archived', status: 'ARCHIVING' as never });
    vi.mocked(workspaceMaintenanceService.findStaleArchiving).mockResolvedValue([
      failedWorkspace,
      archivedWorkspace,
    ]);
    vi.mocked(worktreeLifecycleService.snapshotWorkspaceWorktree)
      .mockRejectedValueOnce(new Error('cleanup failed'))
      .mockResolvedValueOnce(undefined);

    const result = await recoverStaleArchivingWorkspaces(services);

    expect(result).toEqual({
      archived: ['ws-archived'],
      failed: [{ id: 'ws-failed', error: 'cleanup failed' }],
    });
    expect(workspaceStateMachine.markArchived).toHaveBeenCalledWith('ws-archived');
    expect(workspaceStateMachine.transition).toHaveBeenCalledWith('ws-failed', 'FAILED', {
      errorMessage: 'Archive recovery failed after restart: cleanup failed',
    });
  });

  it('marks an archive incomplete when recovery fails after removal may have started', async () => {
    const resumed = makeWorkspace({ id: 'ws-resumed', status: 'ARCHIVING' as never });
    const removing = makeWorkspace({ id: 'ws-removing', status: 'ARCHIVING' as never });
    vi.mocked(workspaceMaintenanceService.findStaleArchiving).mockResolvedValue([
      resumed,
      removing,
    ]);
    // The first row's snapshot ref exists, so a crash may have interrupted its removal.
    vi.mocked(worktreeLifecycleService.archiveRemovalMayHaveStarted)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    vi.mocked(services.sessionLifecycleService.stopWorkspaceSessions).mockRejectedValueOnce(
      new Error('session stop failed')
    );
    vi.mocked(worktreeLifecycleService.removeWorkspaceWorktree).mockRejectedValueOnce(
      new Error('remove failed')
    );

    await recoverStaleArchivingWorkspaces(services);

    expect(worktreeLifecycleService.snapshotWorkspaceWorktree).toHaveBeenCalledExactlyOnceWith(
      removing,
      {}
    );
    expect(workspaceStateMachine.transition).toHaveBeenCalledWith('ws-resumed', 'FAILED', {
      errorMessage:
        'Archive incomplete: recovery after restart failed: Failed to cleanup workspace resources before archive. Archive again to finish.',
    });
    expect(workspaceStateMachine.transition).toHaveBeenCalledWith('ws-removing', 'FAILED', {
      errorMessage:
        'Archive incomplete: recovery after restart failed: remove failed. Archive again to finish.',
    });
  });
});
