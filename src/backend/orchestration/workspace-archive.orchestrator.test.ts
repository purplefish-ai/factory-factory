import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { WorkspaceWithProject } from './types';

vi.mock('@/backend/domains/workspace', () => ({
  workspaceStateMachine: {
    isValidTransition: vi.fn(),
    startArchiving: vi.fn(),
    startArchivingWithSourceStatus: vi.fn(),
    markArchived: vi.fn(),
    transition: vi.fn(),
  },
  worktreeLifecycleService: {
    cleanupWorkspaceWorktree: vi.fn(),
  },
}));

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { workspaceStateMachine, worktreeLifecycleService } from '@/backend/domains/workspace';
import type { ArchiveWorkspaceDependencies } from './workspace-archive.orchestrator';
import { archiveWorkspace as archiveWorkspaceWithServices } from './workspace-archive.orchestrator';

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
  });
}

const defaultOptions = { commitUncommitted: false };

const services = unsafeCoerce<ArchiveWorkspaceDependencies>({
  githubCLIService: {
    addIssueComment: vi.fn(),
  },
  runScriptService: {
    stopRunScript: vi.fn(),
  },
  sessionService: {
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
    vi.mocked(workspaceStateMachine.startArchiving).mockResolvedValue(
      unsafeCoerce({ id: 'ws-1', status: 'ARCHIVING' })
    );
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
    vi.mocked(worktreeLifecycleService.cleanupWorkspaceWorktree).mockResolvedValue(undefined);
    vi.mocked(services.sessionService.stopWorkspaceSessions).mockResolvedValue(undefined as never);
    vi.mocked(services.runScriptService.stopRunScript).mockResolvedValue(
      unsafeCoerce({ success: true } as const)
    );
    vi.mocked(services.terminalService.destroyWorkspaceTerminals).mockReturnValue(undefined);
  });

  describe('state transition validation', () => {
    it('throws TRPCError when transition is invalid', async () => {
      vi.mocked(workspaceStateMachine.isValidTransition).mockReturnValue(false);
      const workspace = makeWorkspace({ status: 'NEW' as never });

      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow(TRPCError);
      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow(
        /Cannot archive workspace from status: NEW/
      );
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
      expect(services.sessionService.stopWorkspaceSessions).not.toHaveBeenCalled();
      expect(worktreeLifecycleService.cleanupWorkspaceWorktree).not.toHaveBeenCalled();
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

      expect(services.sessionService.stopWorkspaceSessions).toHaveBeenCalledWith('ws-1');
      expect(services.runScriptService.stopRunScript).toHaveBeenCalledWith('ws-1');
      expect(services.terminalService.destroyWorkspaceTerminals).toHaveBeenCalledWith('ws-1');
      expect(worktreeLifecycleService.cleanupWorkspaceWorktree).toHaveBeenCalledWith(
        workspace,
        defaultOptions
      );
    });

    it('marks workspace as archived after cleanup', async () => {
      const workspace = makeWorkspace();
      await archiveWorkspace(workspace, defaultOptions);

      expect(workspaceStateMachine.startArchivingWithSourceStatus).toHaveBeenCalledWith('ws-1');
      expect(workspaceStateMachine.markArchived).toHaveBeenCalledWith('ws-1');
    });

    it('returns the archived workspace', async () => {
      const archivedWs = unsafeCoerce({ id: 'ws-1', status: 'ARCHIVED' });
      vi.mocked(workspaceStateMachine.markArchived).mockResolvedValue(archivedWs as never);
      const workspace = makeWorkspace();

      const result = await archiveWorkspace(workspace, defaultOptions);
      expect(result).toBe(archivedWs);
    });

    it('passes commitUncommitted option to worktree cleanup', async () => {
      const workspace = makeWorkspace();
      await archiveWorkspace(workspace, { commitUncommitted: true });

      expect(worktreeLifecycleService.cleanupWorkspaceWorktree).toHaveBeenCalledWith(workspace, {
        commitUncommitted: true,
      });
    });
  });

  describe('process cleanup errors (fail closed)', () => {
    it('fails archive when session stop fails', async () => {
      vi.mocked(services.sessionService.stopWorkspaceSessions).mockRejectedValue(
        new Error('session stop failed')
      );
      const workspace = makeWorkspace();

      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow(
        /Failed to cleanup workspace resources before archive/
      );
      expect(worktreeLifecycleService.cleanupWorkspaceWorktree).not.toHaveBeenCalled();
      expect(workspaceStateMachine.markArchived).not.toHaveBeenCalled();
    });

    it('fails archive when run script stop rejects', async () => {
      vi.mocked(services.runScriptService.stopRunScript).mockRejectedValue(
        new Error('run script stop failed')
      );
      const workspace = makeWorkspace();

      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow(
        /Failed to cleanup workspace resources before archive/
      );
      expect(worktreeLifecycleService.cleanupWorkspaceWorktree).not.toHaveBeenCalled();
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
      expect(worktreeLifecycleService.cleanupWorkspaceWorktree).not.toHaveBeenCalled();
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
      expect(worktreeLifecycleService.cleanupWorkspaceWorktree).not.toHaveBeenCalled();
      expect(workspaceStateMachine.markArchived).not.toHaveBeenCalled();
    });
  });

  describe('worktree cleanup failure', () => {
    it('re-throws when worktree cleanup fails', async () => {
      const cleanupError = new Error('worktree cleanup failed');
      vi.mocked(worktreeLifecycleService.cleanupWorkspaceWorktree).mockRejectedValue(cleanupError);
      const workspace = makeWorkspace();

      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow(
        'worktree cleanup failed'
      );
    });

    it('does not mark workspace as archived when worktree cleanup fails', async () => {
      vi.mocked(worktreeLifecycleService.cleanupWorkspaceWorktree).mockRejectedValue(
        new Error('cleanup failed')
      );
      const workspace = makeWorkspace();

      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow();
      expect(workspaceStateMachine.markArchived).not.toHaveBeenCalled();
    });

    it('rolls status back when archive fails after entering ARCHIVING', async () => {
      vi.mocked(worktreeLifecycleService.cleanupWorkspaceWorktree).mockRejectedValue(
        new Error('cleanup failed')
      );
      const workspace = makeWorkspace();

      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow();
      expect(workspaceStateMachine.transition).toHaveBeenCalledWith('ws-1', 'READY');
    });

    it('rolls status back using the captured source status from ARCHIVING transition', async () => {
      vi.mocked(workspaceStateMachine.startArchivingWithSourceStatus).mockResolvedValue(
        unsafeCoerce({
          workspace: { id: 'ws-1', status: 'ARCHIVING' },
          previousStatus: 'FAILED',
        })
      );
      vi.mocked(worktreeLifecycleService.cleanupWorkspaceWorktree).mockRejectedValue(
        new Error('cleanup failed')
      );
      const workspace = makeWorkspace();

      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow();
      expect(workspaceStateMachine.transition).toHaveBeenCalledWith('ws-1', 'FAILED');
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
      vi.mocked(services.sessionService.stopWorkspaceSessions).mockImplementation((() => {
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
      vi.mocked(worktreeLifecycleService.cleanupWorkspaceWorktree).mockImplementation((() => {
        callOrder.push('cleanupWorktree');
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

      const worktreeIdx = callOrder.indexOf('cleanupWorktree');
      const archiveIdx = callOrder.indexOf('markArchived');
      expect(worktreeIdx).toBeGreaterThan(-1);
      expect(archiveIdx).toBeGreaterThan(worktreeIdx);
      expect(callOrder.indexOf('stopSessions')).toBeLessThan(worktreeIdx);
    });

    it('archives after worktree cleanup but before GitHub comment', async () => {
      const callOrder: string[] = [];
      vi.mocked(worktreeLifecycleService.cleanupWorkspaceWorktree).mockImplementation((() => {
        callOrder.push('cleanupWorktree');
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
        'cleanupWorktree',
        'markArchived',
        'addIssueComment',
      ]);
    });
  });
});
