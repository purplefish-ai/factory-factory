import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStatus } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartupScriptResult } from './startup-script.service';
import { worktreeLifecycleService } from './worktree-lifecycle.service';

const mocks = vi.hoisted(() => ({
  findByIdWithProject: vi.fn(),
  updateWorkspace: vi.fn(),
  findByWorkspaceId: vi.fn(),
  ensureBaseBranchExists: vi.fn(),
  createWorktree: vi.fn(),
  createWorktreeFromExistingBranch: vi.fn(),
  getAuthenticatedUsername: vi.fn(),
  readConfig: vi.fn(),
  runStartupScript: vi.fn(),
  hasStartupScript: vi.fn(),
  startClaudeSession: vi.fn(),
  startProvisioning: vi.fn(),
  markReady: vi.fn(),
  markFailed: vi.fn(),
}));

vi.mock('../resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
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
  });

  it('starts the default Claude session before startup script completes', async () => {
    let resolveScript: ((result: StartupScriptResult) => void) | undefined;
    const scriptPromise = new Promise<StartupScriptResult>((resolve) => {
      resolveScript = resolve;
    });
    mocks.runStartupScript.mockReturnValueOnce(scriptPromise);
    mocks.findByWorkspaceId.mockResolvedValue([{ id: 'session-1', status: SessionStatus.IDLE }]);

    const initPromise = worktreeLifecycleService.initializeWorkspaceWorktree('workspace-1', {
      branchName: 'main',
      useExistingBranch: false,
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.findByWorkspaceId).toHaveBeenCalledWith('workspace-1', {
      status: SessionStatus.IDLE,
      limit: 1,
    });
    expect(mocks.startClaudeSession).toHaveBeenCalledWith('session-1', { initialPrompt: '' });

    if (!resolveScript) {
      throw new Error('Expected startup script resolver to be defined');
    }

    resolveScript({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 10,
    });

    await initPromise;
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
});
