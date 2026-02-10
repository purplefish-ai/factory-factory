import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { WorkspaceWithProject } from './types';

vi.mock('@/backend/domains/github', () => ({
  githubCLIService: {
    addIssueComment: vi.fn(),
  },
}));

vi.mock('@/backend/domains/run-script', () => ({
  runScriptService: {
    stopRunScript: vi.fn(),
  },
}));

vi.mock('@/backend/domains/session', () => ({
  sessionService: {
    stopWorkspaceSessions: vi.fn(),
  },
}));

vi.mock('@/backend/domains/terminal', () => ({
  terminalService: {
    destroyWorkspaceTerminals: vi.fn(),
  },
}));

vi.mock('@/backend/domains/workspace', () => ({
  workspaceStateMachine: {
    isValidTransition: vi.fn(),
    archive: vi.fn(),
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

import { githubCLIService } from '@/backend/domains/github';
import { runScriptService } from '@/backend/domains/run-script';
import { sessionService } from '@/backend/domains/session';
import { terminalService } from '@/backend/domains/terminal';
import { workspaceStateMachine, worktreeLifecycleService } from '@/backend/domains/workspace';
import { archiveWorkspace } from './workspace-archive.orchestrator';

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

describe('archiveWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceStateMachine.isValidTransition).mockReturnValue(true);
    vi.mocked(workspaceStateMachine.archive).mockResolvedValue(
      unsafeCoerce({ id: 'ws-1', status: 'ARCHIVED' })
    );
    vi.mocked(worktreeLifecycleService.cleanupWorkspaceWorktree).mockResolvedValue(undefined);
    vi.mocked(sessionService.stopWorkspaceSessions).mockResolvedValue(undefined as never);
    vi.mocked(runScriptService.stopRunScript).mockResolvedValue(undefined as never);
    vi.mocked(terminalService.destroyWorkspaceTerminals).mockReturnValue(undefined);
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

    it('checks transition from current status to ARCHIVED', async () => {
      const workspace = makeWorkspace({ status: 'READY' as never });
      await archiveWorkspace(workspace, defaultOptions);

      expect(workspaceStateMachine.isValidTransition).toHaveBeenCalledWith('READY', 'ARCHIVED');
    });

    it('does not attempt cleanup when transition is invalid', async () => {
      vi.mocked(workspaceStateMachine.isValidTransition).mockReturnValue(false);
      const workspace = makeWorkspace();

      await expect(archiveWorkspace(workspace, defaultOptions)).rejects.toThrow();
      expect(sessionService.stopWorkspaceSessions).not.toHaveBeenCalled();
      expect(worktreeLifecycleService.cleanupWorkspaceWorktree).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('stops sessions, run scripts, and terminals then cleans up worktree', async () => {
      const workspace = makeWorkspace();
      await archiveWorkspace(workspace, defaultOptions);

      expect(sessionService.stopWorkspaceSessions).toHaveBeenCalledWith('ws-1');
      expect(runScriptService.stopRunScript).toHaveBeenCalledWith('ws-1');
      expect(terminalService.destroyWorkspaceTerminals).toHaveBeenCalledWith('ws-1');
      expect(worktreeLifecycleService.cleanupWorkspaceWorktree).toHaveBeenCalledWith(
        workspace,
        defaultOptions
      );
    });

    it('marks workspace as archived after cleanup', async () => {
      const workspace = makeWorkspace();
      await archiveWorkspace(workspace, defaultOptions);

      expect(workspaceStateMachine.archive).toHaveBeenCalledWith('ws-1');
    });

    it('returns the archived workspace', async () => {
      const archivedWs = unsafeCoerce({ id: 'ws-1', status: 'ARCHIVED' });
      vi.mocked(workspaceStateMachine.archive).mockResolvedValue(archivedWs as never);
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

  describe('process cleanup errors', () => {
    it('continues to worktree cleanup when session stop fails', async () => {
      vi.mocked(sessionService.stopWorkspaceSessions).mockRejectedValue(
        new Error('session stop failed')
      );
      const workspace = makeWorkspace();

      await archiveWorkspace(workspace, defaultOptions);

      expect(worktreeLifecycleService.cleanupWorkspaceWorktree).toHaveBeenCalled();
      expect(workspaceStateMachine.archive).toHaveBeenCalled();
    });

    it('continues to worktree cleanup when run script stop fails', async () => {
      vi.mocked(runScriptService.stopRunScript).mockRejectedValue(
        new Error('run script stop failed')
      );
      const workspace = makeWorkspace();

      await archiveWorkspace(workspace, defaultOptions);

      expect(worktreeLifecycleService.cleanupWorkspaceWorktree).toHaveBeenCalled();
      expect(workspaceStateMachine.archive).toHaveBeenCalled();
    });

    it('continues to worktree cleanup when terminal destroy throws', async () => {
      vi.mocked(terminalService.destroyWorkspaceTerminals).mockImplementation(() => {
        throw new Error('terminal destroy failed');
      });
      const workspace = makeWorkspace();

      await archiveWorkspace(workspace, defaultOptions);

      expect(worktreeLifecycleService.cleanupWorkspaceWorktree).toHaveBeenCalled();
      expect(workspaceStateMachine.archive).toHaveBeenCalled();
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
      expect(workspaceStateMachine.archive).not.toHaveBeenCalled();
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

      expect(githubCLIService.addIssueComment).toHaveBeenCalledWith(
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

      expect(githubCLIService.addIssueComment).not.toHaveBeenCalled();
    });

    it('skips comment when PR is not merged', async () => {
      const workspace = makeWorkspace({
        githubIssueNumber: 42,
        prState: 'OPEN' as never,
        prUrl: 'https://github.com/owner/repo/pull/10',
      });

      await archiveWorkspace(workspace, defaultOptions);

      expect(githubCLIService.addIssueComment).not.toHaveBeenCalled();
    });

    it('skips comment when PR URL is missing even if state is MERGED', async () => {
      const workspace = makeWorkspace({
        githubIssueNumber: 42,
        prState: 'MERGED' as never,
        prUrl: null,
      });

      await archiveWorkspace(workspace, defaultOptions);

      expect(githubCLIService.addIssueComment).not.toHaveBeenCalled();
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

      expect(githubCLIService.addIssueComment).not.toHaveBeenCalled();
    });

    it('does not fail archive when GitHub comment fails', async () => {
      vi.mocked(githubCLIService.addIssueComment).mockRejectedValue(new Error('GitHub API error'));
      const workspace = makeWorkspace({
        githubIssueNumber: 42,
        prState: 'MERGED' as never,
        prUrl: 'https://github.com/owner/repo/pull/10',
      });

      const result = await archiveWorkspace(workspace, defaultOptions);

      expect(result).toBeDefined();
      expect(workspaceStateMachine.archive).toHaveBeenCalled();
    });

    it('comment includes the PR URL', async () => {
      const workspace = makeWorkspace({
        githubIssueNumber: 42,
        prState: 'MERGED' as never,
        prUrl: 'https://github.com/owner/repo/pull/99',
      });

      await archiveWorkspace(workspace, defaultOptions);

      const commentArg = vi.mocked(githubCLIService.addIssueComment).mock.calls[0]?.[3];
      expect(commentArg).toContain('merged');
      expect(commentArg).toContain('https://github.com/owner/repo/pull/99');
    });
  });

  describe('ordering guarantees', () => {
    it('stops processes before cleaning up worktree', async () => {
      const callOrder: string[] = [];
      vi.mocked(sessionService.stopWorkspaceSessions).mockImplementation((() => {
        callOrder.push('stopSessions');
        return Promise.resolve(undefined);
      }) as never);
      vi.mocked(runScriptService.stopRunScript).mockImplementation((() => {
        callOrder.push('stopRunScript');
        return Promise.resolve(undefined);
      }) as never);
      vi.mocked(terminalService.destroyWorkspaceTerminals).mockImplementation(() => {
        callOrder.push('destroyTerminals');
      });
      vi.mocked(worktreeLifecycleService.cleanupWorkspaceWorktree).mockImplementation((() => {
        callOrder.push('cleanupWorktree');
        return Promise.resolve();
      }) as never);
      vi.mocked(workspaceStateMachine.archive).mockImplementation((() => {
        callOrder.push('archive');
        return Promise.resolve(unsafeCoerce({ id: 'ws-1', status: 'ARCHIVED' }));
      }) as never);

      await archiveWorkspace(makeWorkspace(), defaultOptions);

      const worktreeIdx = callOrder.indexOf('cleanupWorktree');
      const archiveIdx = callOrder.indexOf('archive');
      expect(worktreeIdx).toBeGreaterThan(-1);
      expect(archiveIdx).toBeGreaterThan(worktreeIdx);
      // Process stops happen before worktree cleanup
      expect(callOrder.indexOf('stopSessions')).toBeLessThan(worktreeIdx);
    });

    it('archives after worktree cleanup but before GitHub comment', async () => {
      const callOrder: string[] = [];
      vi.mocked(worktreeLifecycleService.cleanupWorkspaceWorktree).mockImplementation((() => {
        callOrder.push('cleanupWorktree');
        return Promise.resolve();
      }) as never);
      vi.mocked(workspaceStateMachine.archive).mockImplementation((() => {
        callOrder.push('archive');
        return Promise.resolve(unsafeCoerce({ id: 'ws-1', status: 'ARCHIVED' }));
      }) as never);
      vi.mocked(githubCLIService.addIssueComment).mockImplementation((() => {
        callOrder.push('addIssueComment');
        return Promise.resolve();
      }) as never);

      const workspace = makeWorkspace({
        githubIssueNumber: 42,
        prState: 'MERGED' as never,
        prUrl: 'https://github.com/owner/repo/pull/10',
      });

      await archiveWorkspace(workspace, defaultOptions);

      expect(callOrder).toEqual(['cleanupWorktree', 'archive', 'addIssueComment']);
    });
  });
});
