import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStatus } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartupScriptResult } from './startup-script.service';
import { worktreeLifecycleService } from './worktree-lifecycle.service';

const findByIdWithProject = vi.fn();
const updateWorkspace = vi.fn();
const findByWorkspaceId = vi.fn();
const ensureBaseBranchExists = vi.fn();
const createWorktree = vi.fn();
const createWorktreeFromExistingBranch = vi.fn();
const getAuthenticatedUsername = vi.fn();
const readConfig = vi.fn();
const runStartupScript = vi.fn();
const hasStartupScript = vi.fn();
const startClaudeSession = vi.fn();
const startProvisioning = vi.fn();
const markReady = vi.fn();
const markFailed = vi.fn();

vi.mock('../resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findByIdWithProject,
    update: updateWorkspace,
  },
}));

vi.mock('../resource_accessors/claude-session.accessor', () => ({
  claudeSessionAccessor: {
    findByWorkspaceId,
  },
}));

vi.mock('./git-ops.service', () => ({
  gitOpsService: {
    ensureBaseBranchExists,
    createWorktree,
    createWorktreeFromExistingBranch,
  },
}));

vi.mock('./github-cli.service', () => ({
  githubCLIService: {
    getAuthenticatedUsername,
  },
}));

vi.mock('./factory-config.service', () => ({
  FactoryConfigService: {
    readConfig,
  },
}));

vi.mock('./startup-script.service', () => ({
  startupScriptService: {
    runStartupScript,
    hasStartupScript,
  },
}));

vi.mock('./session.service', () => ({
  sessionService: {
    startClaudeSession,
  },
}));

vi.mock('./workspace-state-machine.service', () => ({
  workspaceStateMachine: {
    startProvisioning,
    markReady,
    markFailed,
  },
}));

describe('worktreeLifecycleService initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    startProvisioning.mockResolvedValue(true);
    const worktreeBasePath = path.join(os.tmpdir(), 'ff-worktrees');

    findByIdWithProject.mockResolvedValue({
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

    ensureBaseBranchExists.mockResolvedValue(undefined);
    createWorktree.mockResolvedValue({
      worktreePath: '/worktrees/workspace-1',
      branchName: 'feature-1',
    });
    createWorktreeFromExistingBranch.mockResolvedValue({
      worktreePath: '/worktrees/workspace-1',
      branchName: 'feature-1',
    });
    getAuthenticatedUsername.mockResolvedValue(null);
    updateWorkspace.mockResolvedValue(undefined);
    hasStartupScript.mockReturnValue(false);
    readConfig.mockResolvedValue({
      scripts: {
        setup: 'pnpm install',
        run: null,
        cleanup: null,
      },
    });
    startClaudeSession.mockResolvedValue(undefined);
  });

  it('starts the default Claude session before startup script completes', async () => {
    let resolveScript: ((result: StartupScriptResult) => void) | undefined;
    const scriptPromise = new Promise<StartupScriptResult>((resolve) => {
      resolveScript = resolve;
    });
    runStartupScript.mockReturnValueOnce(scriptPromise);
    findByWorkspaceId.mockResolvedValue([{ id: 'session-1', status: SessionStatus.IDLE }]);

    const initPromise = worktreeLifecycleService.initializeWorkspaceWorktree('workspace-1', {
      branchName: 'main',
      useExistingBranch: false,
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(findByWorkspaceId).toHaveBeenCalledWith('workspace-1', {
      status: SessionStatus.IDLE,
      limit: 1,
    });
    expect(startClaudeSession).toHaveBeenCalledWith('session-1', { initialPrompt: '' });

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
    runStartupScript.mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 10,
    });
    findByWorkspaceId.mockResolvedValue([]);

    await worktreeLifecycleService.initializeWorkspaceWorktree('workspace-1', {
      branchName: 'main',
      useExistingBranch: false,
    });

    expect(startClaudeSession).not.toHaveBeenCalled();
  });
});
