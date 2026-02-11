import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStatus } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSelectedModel } from '@/shared/claude';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findByIdWithProject: vi.fn(),
  updateWorkspace: vi.fn(),
  findByWorkspaceId: vi.fn(),
  ensureBaseBranchExists: vi.fn(),
  createWorktree: vi.fn(),
  createWorktreeFromExistingBranch: vi.fn(),
  getAuthenticatedUsername: vi.fn(),
  getIssue: vi.fn(),
  readConfig: vi.fn(),
  runStartupScript: vi.fn(),
  hasStartupScript: vi.fn(),
  startClaudeSession: vi.fn(),
  stopWorkspaceSessions: vi.fn(),
  enqueue: vi.fn(),
  emitDelta: vi.fn(),
  tryDispatchNextMessage: vi.fn(),
  startProvisioning: vi.fn(),
  markReady: vi.fn(),
  markFailed: vi.fn(),
  getInitMode: vi.fn(),
  clearInitMode: vi.fn(),
}));

vi.mock('@/backend/resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: mocks.findById,
    findByIdWithProject: mocks.findByIdWithProject,
    update: mocks.updateWorkspace,
  },
}));

vi.mock('@/backend/resource_accessors/claude-session.accessor', () => ({
  claudeSessionAccessor: {
    findByWorkspaceId: mocks.findByWorkspaceId,
  },
}));

vi.mock('@/backend/services/git-ops.service', () => ({
  gitOpsService: {
    ensureBaseBranchExists: mocks.ensureBaseBranchExists,
    createWorktree: mocks.createWorktree,
    createWorktreeFromExistingBranch: mocks.createWorktreeFromExistingBranch,
  },
}));

vi.mock('@/backend/domains/github', () => ({
  githubCLIService: {
    getAuthenticatedUsername: mocks.getAuthenticatedUsername,
    getIssue: mocks.getIssue,
  },
}));

vi.mock('@/backend/services/factory-config.service', () => ({
  FactoryConfigService: {
    readConfig: mocks.readConfig,
  },
}));

vi.mock('@/backend/domains/run-script', () => ({
  startupScriptService: {
    runStartupScript: mocks.runStartupScript,
    hasStartupScript: mocks.hasStartupScript,
  },
}));

vi.mock('@/backend/domains/session', () => ({
  sessionService: {
    startClaudeSession: mocks.startClaudeSession,
    stopWorkspaceSessions: mocks.stopWorkspaceSessions,
  },
  sessionDomainService: {
    enqueue: mocks.enqueue,
    emitDelta: mocks.emitDelta,
  },
  chatMessageHandlerService: {
    tryDispatchNextMessage: mocks.tryDispatchNextMessage,
  },
}));

vi.mock('@/backend/domains/workspace/lifecycle/state-machine.service', () => ({
  workspaceStateMachine: {
    startProvisioning: mocks.startProvisioning,
    markReady: mocks.markReady,
    markFailed: mocks.markFailed,
  },
}));

vi.mock('@/backend/domains/workspace/worktree/worktree-lifecycle.service', () => ({
  worktreeLifecycleService: {
    getInitMode: mocks.getInitMode,
    clearInitMode: mocks.clearInitMode,
  },
}));

// Import orchestrator after mocks
import { initializeWorkspaceWorktree } from '@/backend/orchestration/workspace-init.orchestrator';

describe('initializeWorkspaceWorktree orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.startProvisioning.mockResolvedValue(true);
    const worktreeBasePath = path.join(os.tmpdir(), 'ff-worktrees');

    mocks.findByIdWithProject.mockResolvedValue({
      id: 'workspace-1',
      name: 'Workspace 1',
      description: null,
      projectId: 'project-1',
      worktreePath: null,
      branchName: null,
      project: {
        id: 'project-1',
        repoPath: '/repo',
        worktreeBasePath,
        defaultBranch: 'main',
        startupScriptCommand: null,
        startupScriptPath: null,
        startupScriptTimeout: 300,
      },
    });
    mocks.findById.mockResolvedValue({ initErrorMessage: 'failed' });

    mocks.ensureBaseBranchExists.mockResolvedValue(undefined);
    mocks.createWorktree.mockResolvedValue({
      worktreePath: '/worktrees/workspace-1',
      branchName: 'feature-1',
    });
    mocks.createWorktreeFromExistingBranch.mockResolvedValue({
      worktreePath: '/worktrees/workspace-1',
      branchName: 'feature-1',
    });
    mocks.getAuthenticatedUsername.mockResolvedValue(null);
    mocks.getIssue.mockResolvedValue(null);
    mocks.updateWorkspace.mockResolvedValue(undefined);
    mocks.hasStartupScript.mockReturnValue(false);
    mocks.readConfig.mockResolvedValue({
      scripts: {
        setup: 'pnpm install',
        run: null,
        cleanup: null,
      },
    });
    mocks.startClaudeSession.mockResolvedValue(undefined);
    mocks.stopWorkspaceSessions.mockResolvedValue(undefined);
    mocks.enqueue.mockReturnValue({ position: 0 });
    mocks.tryDispatchNextMessage.mockResolvedValue(undefined);
    mocks.getInitMode.mockResolvedValue(undefined);
    mocks.clearInitMode.mockResolvedValue(undefined);
  });

  it('short-circuits when startProvisioning returns null (max retries exceeded)', async () => {
    mocks.startProvisioning.mockResolvedValue(null);

    await initializeWorkspaceWorktree('workspace-1', {
      branchName: 'main',
      useExistingBranch: false,
    });

    expect(mocks.findByIdWithProject).not.toHaveBeenCalled();
    expect(mocks.createWorktree).not.toHaveBeenCalled();
  });

  it('starts the default Claude session after startup script completes', async () => {
    mocks.runStartupScript.mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 10,
    });
    mocks.findByWorkspaceId.mockResolvedValue([{ id: 'session-1', status: SessionStatus.IDLE }]);

    await initializeWorkspaceWorktree('workspace-1', {
      branchName: 'main',
      useExistingBranch: false,
    });

    expect(mocks.findByWorkspaceId).toHaveBeenCalledWith('workspace-1', {
      status: SessionStatus.IDLE,
      limit: 1,
    });
    expect(mocks.startClaudeSession).toHaveBeenCalledWith('session-1', {
      initialPrompt: '',
    });
    expect(mocks.tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
  });

  it('emits accepted delta with resolved selectedModel for auto-issue prompt', async () => {
    mocks.runStartupScript.mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 10,
    });
    mocks.findByIdWithProject.mockResolvedValue({
      id: 'workspace-1',
      name: 'Workspace 1',
      description: null,
      projectId: 'project-1',
      worktreePath: '/worktrees/workspace-1',
      branchName: 'feature-1',
      githubIssueNumber: 123,
      project: {
        id: 'project-1',
        repoPath: '/repo',
        worktreeBasePath: path.join(os.tmpdir(), 'ff-worktrees'),
        defaultBranch: 'main',
        githubOwner: 'owner',
        githubRepo: 'repo',
        startupScriptCommand: null,
        startupScriptPath: null,
        startupScriptTimeout: 300,
      },
    });
    mocks.getIssue.mockResolvedValue({
      number: 123,
      title: 'Issue title',
      body: 'Issue body',
      url: 'https://github.com/owner/repo/issues/123',
    });
    mocks.findByWorkspaceId.mockResolvedValue([{ id: 'session-1', status: SessionStatus.IDLE }]);
    mocks.enqueue.mockReturnValue({ position: 0 });

    await initializeWorkspaceWorktree('workspace-1', {
      branchName: 'main',
      useExistingBranch: false,
    });

    expect(mocks.emitDelta).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'message_state_changed',
        newState: 'ACCEPTED',
        userMessage: expect.objectContaining({
          settings: expect.objectContaining({
            selectedModel: resolveSelectedModel(null),
          }),
        }),
      })
    );
  });

  it('skips auto-start when no idle Claude session exists', async () => {
    mocks.runStartupScript.mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 10,
    });
    mocks.findByWorkspaceId.mockResolvedValue([]);

    await initializeWorkspaceWorktree('workspace-1', {
      branchName: 'main',
      useExistingBranch: false,
    });

    expect(mocks.startClaudeSession).not.toHaveBeenCalled();
  });

  it('stops eagerly-started session when initialization fails', async () => {
    mocks.runStartupScript.mockRejectedValue(new Error('boom'));
    mocks.findByWorkspaceId.mockResolvedValue([{ id: 'session-1', status: SessionStatus.IDLE }]);

    await initializeWorkspaceWorktree('workspace-1', {
      branchName: 'main',
      useExistingBranch: false,
    });

    expect(mocks.startClaudeSession).toHaveBeenCalledWith('session-1', { initialPrompt: '' });
    expect(mocks.stopWorkspaceSessions).toHaveBeenCalledWith('workspace-1');
    expect(mocks.markFailed).toHaveBeenCalled();
  });

  it('stops eagerly-started session when startup script reports failure', async () => {
    mocks.runStartupScript.mockResolvedValue({
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: 'fail',
      timedOut: false,
      durationMs: 10,
    });
    mocks.findByWorkspaceId.mockResolvedValue([{ id: 'session-1', status: SessionStatus.IDLE }]);

    await initializeWorkspaceWorktree('workspace-1', {
      branchName: 'main',
      useExistingBranch: false,
    });

    expect(mocks.startClaudeSession).toHaveBeenCalledWith('session-1', { initialPrompt: '' });
    expect(mocks.stopWorkspaceSessions).toHaveBeenCalledWith('workspace-1');
  });

  it('refreshes cached GitHub username after TTL expiry', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      mocks.readConfig.mockResolvedValue(null);
      mocks.getAuthenticatedUsername
        .mockResolvedValueOnce('user-a')
        .mockResolvedValueOnce('user-b');

      await initializeWorkspaceWorktree('workspace-1', {
        branchName: 'main',
        useExistingBranch: false,
      });

      vi.setSystemTime(new Date('2026-01-01T00:06:00.000Z'));

      await initializeWorkspaceWorktree('workspace-1', {
        branchName: 'main',
        useExistingBranch: false,
      });

      expect(mocks.getAuthenticatedUsername).toHaveBeenCalledTimes(2);
      expect(mocks.createWorktree).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        'workspace-workspace-1',
        'main',
        expect.objectContaining({ branchPrefix: 'user-a' })
      );
      expect(mocks.createWorktree).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        'workspace-workspace-1',
        'main',
        expect.objectContaining({ branchPrefix: 'user-b' })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
