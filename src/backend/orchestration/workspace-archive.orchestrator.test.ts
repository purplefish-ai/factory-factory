import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addIssueComment: vi.fn(),
  stopRunScript: vi.fn(),
  stopWorkspaceSessions: vi.fn(),
  destroyWorkspaceTerminals: vi.fn(),
  isValidTransition: vi.fn(),
  archive: vi.fn(),
  cleanupWorkspaceWorktree: vi.fn(),
}));

vi.mock('@/backend/domains/github', () => ({
  githubCLIService: {
    addIssueComment: mocks.addIssueComment,
  },
}));

vi.mock('@/backend/domains/run-script', () => ({
  runScriptService: {
    stopRunScript: mocks.stopRunScript,
  },
}));

vi.mock('@/backend/domains/session', () => ({
  sessionService: {
    stopWorkspaceSessions: mocks.stopWorkspaceSessions,
  },
}));

vi.mock('@/backend/domains/terminal', () => ({
  terminalService: {
    destroyWorkspaceTerminals: mocks.destroyWorkspaceTerminals,
  },
}));

vi.mock('@/backend/domains/workspace', () => ({
  workspaceStateMachine: {
    isValidTransition: mocks.isValidTransition,
    archive: mocks.archive,
  },
  worktreeLifecycleService: {
    cleanupWorkspaceWorktree: mocks.cleanupWorkspaceWorktree,
  },
}));

import { archiveWorkspace } from './workspace-archive.orchestrator';

describe('archiveWorkspace', () => {
  const workspace = {
    id: 'ws-1',
    status: 'READY',
    prState: 'MERGED',
    prUrl: 'https://github.com/owner/repo/pull/1',
    githubIssueNumber: 12,
    project: { githubOwner: 'owner', githubRepo: 'repo' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isValidTransition.mockReturnValue(true);
    mocks.stopWorkspaceSessions.mockResolvedValue(undefined);
    mocks.stopRunScript.mockResolvedValue({ success: true });
    mocks.destroyWorkspaceTerminals.mockReturnValue(undefined);
    mocks.cleanupWorkspaceWorktree.mockResolvedValue(undefined);
    mocks.archive.mockResolvedValue({ ...workspace, status: 'ARCHIVED' });
    mocks.addIssueComment.mockResolvedValue(undefined);
  });

  it('throws BAD_REQUEST when transition is invalid', async () => {
    mocks.isValidTransition.mockReturnValue(false);

    await expect(
      archiveWorkspace(workspace as never, { commitUncommitted: false })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it('fails closed when session cleanup fails and does not archive', async () => {
    mocks.stopWorkspaceSessions.mockRejectedValue(new Error('session cleanup failed'));

    await expect(
      archiveWorkspace(workspace as never, { commitUncommitted: false })
    ).rejects.toThrow('Failed to cleanup workspace resources before archive');

    expect(mocks.stopRunScript).toHaveBeenCalledWith('ws-1');
    expect(mocks.destroyWorkspaceTerminals).toHaveBeenCalledWith('ws-1');
    expect(mocks.cleanupWorkspaceWorktree).not.toHaveBeenCalled();
    expect(mocks.archive).not.toHaveBeenCalled();
  });
});
