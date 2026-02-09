import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStatus } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSelectedModel } from '@/shared/claude';
import { worktreeLifecycleService } from './worktree-lifecycle.service';

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
}));

vi.mock('../resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: mocks.findById,
    findByIdWithProject: mocks.findByIdWithProject,
    update: mocks.updateWorkspace,
  },
}));

vi.mock('../resource_accessors/claude-session.accessor', () => ({
  claudeSessionAccessor: {
    findByWorkspaceId: mocks.findByWorkspaceId,
  },
}));

vi.mock('./git-ops.service', () => ({
  gitOpsService: {
    ensureBaseBranchExists: mocks.ensureBaseBranchExists,
    createWorktree: mocks.createWorktree,
    createWorktreeFromExistingBranch: mocks.createWorktreeFromExistingBranch,
  },
}));

vi.mock('./github-cli.service', () => ({
  githubCLIService: {
    getAuthenticatedUsername: mocks.getAuthenticatedUsername,
    getIssue: mocks.getIssue,
  },
}));

vi.mock('./factory-config.service', () => ({
  FactoryConfigService: {
    readConfig: mocks.readConfig,
  },
}));

vi.mock('./startup-script.service', () => ({
  startupScriptService: {
    runStartupScript: mocks.runStartupScript,
    hasStartupScript: mocks.hasStartupScript,
  },
}));

vi.mock('./session.service', () => ({
  sessionService: {
    startClaudeSession: mocks.startClaudeSession,
    stopWorkspaceSessions: mocks.stopWorkspaceSessions,
  },
}));

vi.mock('@/backend/domains/session/session-domain.service', () => ({
  sessionDomainService: {
    enqueue: mocks.enqueue,
    emitDelta: mocks.emitDelta,
  },
}));

vi.mock('./chat-message-handlers.service', () => ({
  chatMessageHandlerService: {
    tryDispatchNextMessage: mocks.tryDispatchNextMessage,
  },
}));

vi.mock('./workspace-state-machine.service', () => ({
  workspaceStateMachine: {
    startProvisioning: mocks.startProvisioning,
    markReady: mocks.markReady,
    markFailed: mocks.markFailed,
  },
}));

describe('worktreeLifecycleService initialization', () => {
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

    await worktreeLifecycleService.initializeWorkspaceWorktree('workspace-1', {
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

    await worktreeLifecycleService.initializeWorkspaceWorktree('workspace-1', {
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

    await worktreeLifecycleService.initializeWorkspaceWorktree('workspace-1', {
      branchName: 'main',
      useExistingBranch: false,
    });

    expect(mocks.startClaudeSession).not.toHaveBeenCalled();
  });

  it('does not start session when initialization fails', async () => {
    mocks.runStartupScript.mockRejectedValue(new Error('boom'));
    mocks.findByWorkspaceId.mockResolvedValue([{ id: 'session-1', status: SessionStatus.IDLE }]);

    await worktreeLifecycleService.initializeWorkspaceWorktree('workspace-1', {
      branchName: 'main',
      useExistingBranch: false,
    });

    expect(mocks.startClaudeSession).not.toHaveBeenCalled();
    expect(mocks.stopWorkspaceSessions).toHaveBeenCalledWith('workspace-1');
    expect(mocks.markFailed).toHaveBeenCalled();
  });

  it('stops sessions when startup script reports failure', async () => {
    mocks.runStartupScript.mockResolvedValue({
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: 'fail',
      timedOut: false,
      durationMs: 10,
    });
    mocks.findByWorkspaceId.mockResolvedValue([{ id: 'session-1', status: SessionStatus.IDLE }]);

    await worktreeLifecycleService.initializeWorkspaceWorktree('workspace-1', {
      branchName: 'main',
      useExistingBranch: false,
    });

    // Should NOT start session when script fails
    expect(mocks.startClaudeSession).not.toHaveBeenCalled();
    // stopWorkspaceSessions is still called but is a no-op (no sessions running)
    expect(mocks.stopWorkspaceSessions).toHaveBeenCalledWith('workspace-1');
  });
});
