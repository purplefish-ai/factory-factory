import { SessionStatus } from '@factory-factory/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

// --- Module mocks (before imports) ---

vi.mock('@/backend/domains/github', () => ({
  githubCLIService: {
    getAuthenticatedUsername: vi.fn(),
    getIssue: vi.fn(),
  },
}));

vi.mock('@/backend/domains/run-script', () => ({
  startupScriptService: {
    hasStartupScript: vi.fn(),
    runStartupScript: vi.fn(),
  },
}));

vi.mock('@/backend/domains/session', () => ({
  chatMessageHandlerService: {
    tryDispatchNextMessage: vi.fn(),
  },
  sessionDomainService: {
    enqueue: vi.fn(),
    emitDelta: vi.fn(),
  },
  sessionService: {
    startSession: vi.fn(),
    stopWorkspaceSessions: vi.fn(),
  },
}));

// Mock the deep paths that the source file imports from (vitest intercepts these).
// The test imports from the barrel below to satisfy dependency-cruiser.
vi.mock('@/backend/domains/workspace/lifecycle/state-machine.service', () => ({
  workspaceStateMachine: {
    startProvisioning: vi.fn(),
    markFailed: vi.fn(),
    markReady: vi.fn(),
  },
}));

vi.mock('@/backend/domains/workspace/worktree/worktree-lifecycle.service', () => ({
  worktreeLifecycleService: {
    getInitMode: vi.fn(),
    clearInitMode: vi.fn(),
  },
}));

vi.mock('@/backend/resource_accessors/agent-session.accessor', () => ({
  agentSessionAccessor: {
    findByWorkspaceId: vi.fn(),
  },
}));

vi.mock('@/backend/resource_accessors/workspace.accessor', () => ({
  workspaceAccessor: {
    findById: vi.fn(),
    findByIdWithProject: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('@/backend/services/factory-config.service', () => ({
  FactoryConfigService: {
    readConfig: vi.fn(),
  },
}));

vi.mock('@/backend/services/git-ops.service', () => ({
  gitOpsService: {
    ensureBaseBranchExists: vi.fn(),
    createWorktree: vi.fn(),
    createWorktreeFromExistingBranch: vi.fn(),
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

vi.mock('@/shared/claude', () => ({
  MessageState: { ACCEPTED: 'ACCEPTED' },
  resolveSelectedModel: vi.fn((m: string) => m ?? 'claude-sonnet'),
}));

// --- Imports (after mocks) ---

import { githubCLIService } from '@/backend/domains/github';
import { startupScriptService } from '@/backend/domains/run-script';
import {
  chatMessageHandlerService,
  sessionDomainService,
  sessionService,
} from '@/backend/domains/session';
import { workspaceStateMachine, worktreeLifecycleService } from '@/backend/domains/workspace';
import { agentSessionAccessor } from '@/backend/resource_accessors/agent-session.accessor';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import { FactoryConfigService } from '@/backend/services/factory-config.service';
import { gitOpsService } from '@/backend/services/git-ops.service';
import { initializeWorkspaceWorktree } from './workspace-init.orchestrator';

// --- Test Helpers ---

const WORKSPACE_ID = 'ws-1';

function makeWorkspaceWithProject(overrides = {}) {
  return unsafeCoerce<
    NonNullable<Awaited<ReturnType<typeof workspaceAccessor.findByIdWithProject>>>
  >({
    id: WORKSPACE_ID,
    name: 'test-workspace',
    status: 'NEW',
    githubIssueNumber: null,
    githubIssueUrl: null,
    project: {
      id: 'proj-1',
      defaultBranch: 'main',
      worktreeBasePath: '/base',
      githubOwner: 'owner',
      githubRepo: 'repo',
      startupScriptCommand: null,
      startupScriptPath: null,
    },
    ...overrides,
  });
}

function setupHappyPath() {
  const workspace = makeWorkspaceWithProject();
  vi.mocked(workspaceStateMachine.startProvisioning).mockResolvedValue(unsafeCoerce(workspace));
  vi.mocked(workspaceAccessor.findByIdWithProject).mockResolvedValue(workspace);
  vi.mocked(workspaceAccessor.findById).mockResolvedValue(workspace as never);
  vi.mocked(workspaceAccessor.update).mockResolvedValue(workspace as never);
  vi.mocked(gitOpsService.ensureBaseBranchExists).mockResolvedValue(undefined);
  vi.mocked(gitOpsService.createWorktree).mockResolvedValue({
    worktreePath: '/worktrees/workspace-ws-1',
    branchName: 'user/test-workspace',
  });
  vi.mocked(gitOpsService.createWorktreeFromExistingBranch).mockResolvedValue({
    worktreePath: '/worktrees/workspace-ws-1',
    branchName: 'existing-branch',
  });
  vi.mocked(FactoryConfigService.readConfig).mockResolvedValue(null);
  vi.mocked(startupScriptService.hasStartupScript).mockReturnValue(false);
  vi.mocked(worktreeLifecycleService.getInitMode).mockResolvedValue(undefined);
  vi.mocked(worktreeLifecycleService.clearInitMode).mockResolvedValue(undefined);
  vi.mocked(workspaceStateMachine.markReady).mockResolvedValue(unsafeCoerce(workspace));
  vi.mocked(workspaceStateMachine.markFailed).mockResolvedValue(unsafeCoerce(workspace));
  vi.mocked(githubCLIService.getAuthenticatedUsername).mockResolvedValue('testuser');
  vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([]);
  vi.mocked(sessionService.stopWorkspaceSessions).mockResolvedValue(undefined as never);
  vi.mocked(sessionService.startSession).mockResolvedValue(undefined as never);
  vi.mocked(chatMessageHandlerService.tryDispatchNextMessage).mockResolvedValue(undefined as never);
  return workspace;
}

describe('initializeWorkspaceWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('provisioning gate', () => {
    it('returns early without doing work when provisioning fails', async () => {
      vi.mocked(workspaceStateMachine.startProvisioning).mockRejectedValue(
        new Error('invalid transition')
      );

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(workspaceAccessor.findByIdWithProject).not.toHaveBeenCalled();
      expect(gitOpsService.createWorktree).not.toHaveBeenCalled();
    });
  });

  describe('workspace lookup', () => {
    it('marks failed when workspace has no project', async () => {
      vi.mocked(workspaceStateMachine.startProvisioning).mockResolvedValue(unsafeCoerce({}));
      vi.mocked(workspaceAccessor.findByIdWithProject).mockResolvedValue(null);
      vi.mocked(workspaceStateMachine.markFailed).mockResolvedValue(unsafeCoerce({}));
      vi.mocked(sessionService.stopWorkspaceSessions).mockResolvedValue(undefined as never);
      vi.mocked(worktreeLifecycleService.clearInitMode).mockResolvedValue(undefined);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(workspaceStateMachine.markFailed).toHaveBeenCalledWith(
        WORKSPACE_ID,
        'Workspace project not found'
      );
    });

    it('marks failed when workspace lookup returns workspace without project', async () => {
      vi.mocked(workspaceStateMachine.startProvisioning).mockResolvedValue(unsafeCoerce({}));
      vi.mocked(workspaceAccessor.findByIdWithProject).mockResolvedValue(
        unsafeCoerce({ id: WORKSPACE_ID, project: null })
      );
      vi.mocked(workspaceStateMachine.markFailed).mockResolvedValue(unsafeCoerce({}));
      vi.mocked(sessionService.stopWorkspaceSessions).mockResolvedValue(undefined as never);
      vi.mocked(worktreeLifecycleService.clearInitMode).mockResolvedValue(undefined);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(workspaceStateMachine.markFailed).toHaveBeenCalledWith(
        WORKSPACE_ID,
        'Workspace project not found'
      );
    });
  });

  describe('happy path - no scripts', () => {
    it('creates worktree and marks workspace ready when no scripts exist', async () => {
      setupHappyPath();

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(gitOpsService.createWorktree).toHaveBeenCalled();
      expect(workspaceStateMachine.markReady).toHaveBeenCalledWith(WORKSPACE_ID);
    });

    it('updates workspace with worktree path and branch name', async () => {
      setupHappyPath();

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(workspaceAccessor.update).toHaveBeenCalledWith(
        WORKSPACE_ID,
        expect.objectContaining({
          worktreePath: '/worktrees/workspace-ws-1',
          branchName: 'user/test-workspace',
          isAutoGeneratedBranch: true,
        })
      );
    });

    it('clears init mode in finally block', async () => {
      setupHappyPath();

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(worktreeLifecycleService.clearInitMode).toHaveBeenCalledWith(WORKSPACE_ID, '/base');
    });
  });

  describe('branch options', () => {
    it('uses provided branchName option as base branch', async () => {
      setupHappyPath();

      await initializeWorkspaceWorktree(WORKSPACE_ID, { branchName: 'feature/custom' });

      expect(gitOpsService.ensureBaseBranchExists).toHaveBeenCalledWith(
        expect.anything(),
        'feature/custom',
        'main'
      );
    });

    it('falls back to project defaultBranch when no branchName provided', async () => {
      setupHappyPath();

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(gitOpsService.ensureBaseBranchExists).toHaveBeenCalledWith(
        expect.anything(),
        'main',
        'main'
      );
    });

    it('uses existing branch when useExistingBranch is true', async () => {
      setupHappyPath();

      await initializeWorkspaceWorktree(WORKSPACE_ID, {
        branchName: 'existing-branch',
        useExistingBranch: true,
      });

      expect(gitOpsService.createWorktreeFromExistingBranch).toHaveBeenCalled();
      expect(gitOpsService.createWorktree).not.toHaveBeenCalled();
    });

    it('marks branch as not auto-generated when using existing branch', async () => {
      setupHappyPath();

      await initializeWorkspaceWorktree(WORKSPACE_ID, {
        branchName: 'existing-branch',
        useExistingBranch: true,
      });

      expect(workspaceAccessor.update).toHaveBeenCalledWith(
        WORKSPACE_ID,
        expect.objectContaining({
          isAutoGeneratedBranch: false,
        })
      );
    });

    it('reads init mode from worktreeLifecycleService when useExistingBranch not provided', async () => {
      setupHappyPath();
      vi.mocked(worktreeLifecycleService.getInitMode).mockResolvedValue(true);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(gitOpsService.createWorktreeFromExistingBranch).toHaveBeenCalled();
      expect(gitOpsService.createWorktree).not.toHaveBeenCalled();
    });

    it('falls back to false when getInitMode returns undefined', async () => {
      setupHappyPath();
      vi.mocked(worktreeLifecycleService.getInitMode).mockResolvedValue(undefined);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(gitOpsService.createWorktree).toHaveBeenCalled();
      expect(gitOpsService.createWorktreeFromExistingBranch).not.toHaveBeenCalled();
    });
  });

  describe('GitHub username in branch prefix', () => {
    it('passes GitHub username as branch prefix when creating new worktree', async () => {
      setupHappyPath();

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      // The username is fetched (or cached) and passed as branchPrefix.
      // The module-level cache retains the value from the first call across tests.
      expect(gitOpsService.createWorktree).toHaveBeenCalledWith(
        expect.anything(),
        'workspace-ws-1',
        'main',
        expect.objectContaining({ branchPrefix: 'testuser' })
      );
    });

    it('passes workspace name to createWorktree options', async () => {
      setupHappyPath();

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(gitOpsService.createWorktree).toHaveBeenCalledWith(
        expect.anything(),
        'workspace-ws-1',
        'main',
        expect.objectContaining({ workspaceName: 'test-workspace' })
      );
    });

    it('does not fetch username when using existing branch', async () => {
      setupHappyPath();

      await initializeWorkspaceWorktree(WORKSPACE_ID, {
        branchName: 'existing-branch',
        useExistingBranch: true,
      });

      // When using existing branch, createWorktreeFromExistingBranch is used
      // and getCachedGitHubUsername is never called
      expect(gitOpsService.createWorktreeFromExistingBranch).toHaveBeenCalled();
      expect(gitOpsService.createWorktree).not.toHaveBeenCalled();
    });
  });

  describe('factory config', () => {
    it('stores run and cleanup scripts from factory config', async () => {
      setupHappyPath();
      vi.mocked(FactoryConfigService.readConfig).mockResolvedValue(
        unsafeCoerce({
          scripts: {
            setup: 'npm install',
            run: 'npm start',
            cleanup: 'npm run clean',
          },
        })
      );
      vi.mocked(startupScriptService.runStartupScript).mockResolvedValue({
        success: true,
      } as never);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(workspaceAccessor.update).toHaveBeenCalledWith(
        WORKSPACE_ID,
        expect.objectContaining({
          runScriptCommand: 'npm start',
          runScriptCleanupCommand: 'npm run clean',
        })
      );
    });

    it('stores null for run scripts when no factory config exists', async () => {
      setupHappyPath();

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(workspaceAccessor.update).toHaveBeenCalledWith(
        WORKSPACE_ID,
        expect.objectContaining({
          runScriptCommand: null,
          runScriptCleanupCommand: null,
        })
      );
    });

    it('treats config parse error as no config (returns null safely)', async () => {
      setupHappyPath();
      vi.mocked(FactoryConfigService.readConfig).mockRejectedValue(new Error('invalid JSON'));

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      // Should not throw, should continue with null config
      expect(workspaceAccessor.update).toHaveBeenCalledWith(
        WORKSPACE_ID,
        expect.objectContaining({
          runScriptCommand: null,
          runScriptCleanupCommand: null,
        })
      );
    });
  });

  describe('factory setup script', () => {
    it('runs factory setup script when configured', async () => {
      setupHappyPath();
      vi.mocked(FactoryConfigService.readConfig).mockResolvedValue(
        unsafeCoerce({ scripts: { setup: './setup.sh', run: null, cleanup: null } })
      );
      vi.mocked(startupScriptService.runStartupScript).mockResolvedValue({
        success: true,
      } as never);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(startupScriptService.runStartupScript).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath: '/worktrees/workspace-ws-1' }),
        expect.objectContaining({ startupScriptCommand: './setup.sh' })
      );
    });

    it('does not run project startup script when factory setup ran', async () => {
      setupHappyPath();
      vi.mocked(FactoryConfigService.readConfig).mockResolvedValue(
        unsafeCoerce({ scripts: { setup: './setup.sh', run: null, cleanup: null } })
      );
      vi.mocked(startupScriptService.runStartupScript).mockResolvedValue({
        success: true,
      } as never);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      // hasStartupScript should not be called because factory setup took precedence
      expect(startupScriptService.hasStartupScript).not.toHaveBeenCalled();
    });

    it('does not mark ready when factory setup script ran (script handles state)', async () => {
      setupHappyPath();
      vi.mocked(FactoryConfigService.readConfig).mockResolvedValue(
        unsafeCoerce({ scripts: { setup: './setup.sh', run: null, cleanup: null } })
      );
      vi.mocked(startupScriptService.runStartupScript).mockResolvedValue({
        success: true,
      } as never);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(workspaceStateMachine.markReady).not.toHaveBeenCalled();
    });

    it('stops sessions when factory setup script fails', async () => {
      setupHappyPath();
      vi.mocked(FactoryConfigService.readConfig).mockResolvedValue(
        unsafeCoerce({ scripts: { setup: './setup.sh', run: null, cleanup: null } })
      );
      vi.mocked(startupScriptService.runStartupScript).mockResolvedValue({
        success: false,
      } as never);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(sessionService.stopWorkspaceSessions).toHaveBeenCalledWith(WORKSPACE_ID);
    });

    it('does not throw when stopping sessions fails after setup script failure', async () => {
      setupHappyPath();
      vi.mocked(FactoryConfigService.readConfig).mockResolvedValue(
        unsafeCoerce({ scripts: { setup: './setup.sh', run: null, cleanup: null } })
      );
      vi.mocked(startupScriptService.runStartupScript).mockResolvedValue({
        success: false,
      } as never);
      vi.mocked(sessionService.stopWorkspaceSessions).mockRejectedValue(
        new Error('session stop failed')
      );

      // Should not throw
      await initializeWorkspaceWorktree(WORKSPACE_ID);
    });
  });

  describe('project startup script (fallback)', () => {
    it('runs project startup script when no factory setup exists', async () => {
      setupHappyPath();
      vi.mocked(startupScriptService.hasStartupScript).mockReturnValue(true);
      vi.mocked(startupScriptService.runStartupScript).mockResolvedValue({
        success: true,
      } as never);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(startupScriptService.runStartupScript).toHaveBeenCalled();
    });

    it('does not mark ready when project startup script ran', async () => {
      setupHappyPath();
      vi.mocked(startupScriptService.hasStartupScript).mockReturnValue(true);
      vi.mocked(startupScriptService.runStartupScript).mockResolvedValue({
        success: true,
      } as never);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(workspaceStateMachine.markReady).not.toHaveBeenCalled();
    });

    it('stops sessions when project startup script fails', async () => {
      setupHappyPath();
      vi.mocked(startupScriptService.hasStartupScript).mockReturnValue(true);
      vi.mocked(startupScriptService.runStartupScript).mockResolvedValue({
        success: false,
      } as never);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(sessionService.stopWorkspaceSessions).toHaveBeenCalledWith(WORKSPACE_ID);
    });

    it('does not throw when stopping sessions fails after startup script failure', async () => {
      setupHappyPath();
      vi.mocked(startupScriptService.hasStartupScript).mockReturnValue(true);
      vi.mocked(startupScriptService.runStartupScript).mockResolvedValue({
        success: false,
      } as never);
      vi.mocked(sessionService.stopWorkspaceSessions).mockRejectedValue(
        new Error('session stop failed')
      );

      await initializeWorkspaceWorktree(WORKSPACE_ID);
    });
  });

  describe('default Claude session auto-start', () => {
    it('starts default Claude session when idle session exists', async () => {
      setupHappyPath();
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([
        unsafeCoerce({ id: 'session-1', status: SessionStatus.IDLE, model: 'claude-sonnet' }),
      ]);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(sessionService.startSession).toHaveBeenCalledWith('session-1', {
        initialPrompt: '',
      });
    });

    it('does not start session when no idle session exists', async () => {
      setupHappyPath();
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([]);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(sessionService.startSession).not.toHaveBeenCalled();
    });

    it('dispatches queued messages after session start', async () => {
      setupHappyPath();
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([
        unsafeCoerce({ id: 'session-1', status: SessionStatus.IDLE, model: 'claude-sonnet' }),
      ]);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(chatMessageHandlerService.tryDispatchNextMessage).toHaveBeenCalledTimes(2);
      expect(chatMessageHandlerService.tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    });

    it('does not throw when session auto-start fails', async () => {
      setupHappyPath();
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockRejectedValue(
        new Error('accessor error')
      );

      // Should not throw - session start failure is caught
      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(workspaceStateMachine.markReady).toHaveBeenCalled();
    });
  });

  describe('GitHub issue prompt', () => {
    it('enqueues GitHub issue prompt when workspace has linked issue', async () => {
      const workspace = makeWorkspaceWithProject({ githubIssueNumber: 42 });
      setupHappyPath();
      vi.mocked(workspaceAccessor.findByIdWithProject).mockResolvedValue(workspace);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([
        unsafeCoerce({ id: 'session-1', status: SessionStatus.IDLE, model: 'claude-sonnet' }),
      ]);
      vi.mocked(githubCLIService.getIssue).mockResolvedValue(
        unsafeCoerce({
          number: 42,
          title: 'Fix the bug',
          body: 'Description of the bug',
          url: 'https://github.com/owner/repo/issues/42',
        })
      );
      vi.mocked(sessionDomainService.enqueue).mockReturnValue({ position: 0 });

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(sessionDomainService.enqueue).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          text: expect.stringContaining('Fix the bug'),
        })
      );
    });

    it('emits delta when enqueue succeeds', async () => {
      const workspace = makeWorkspaceWithProject({ githubIssueNumber: 42 });
      setupHappyPath();
      vi.mocked(workspaceAccessor.findByIdWithProject).mockResolvedValue(workspace);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([
        unsafeCoerce({ id: 'session-1', status: SessionStatus.IDLE, model: 'claude-sonnet' }),
      ]);
      vi.mocked(githubCLIService.getIssue).mockResolvedValue(
        unsafeCoerce({
          number: 42,
          title: 'Fix the bug',
          body: 'Description',
          url: 'https://github.com/owner/repo/issues/42',
        })
      );
      vi.mocked(sessionDomainService.enqueue).mockReturnValue({ position: 0 });

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(sessionDomainService.emitDelta).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          type: 'message_state_changed',
          newState: 'ACCEPTED',
        })
      );
    });

    it('logs warning when enqueue returns error', async () => {
      const workspace = makeWorkspaceWithProject({ githubIssueNumber: 42 });
      setupHappyPath();
      vi.mocked(workspaceAccessor.findByIdWithProject).mockResolvedValue(workspace);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([
        unsafeCoerce({ id: 'session-1', status: SessionStatus.IDLE, model: 'claude-sonnet' }),
      ]);
      vi.mocked(githubCLIService.getIssue).mockResolvedValue(
        unsafeCoerce({
          number: 42,
          title: 'Fix the bug',
          body: 'Description',
          url: 'https://github.com/owner/repo/issues/42',
        })
      );
      vi.mocked(sessionDomainService.enqueue).mockReturnValue({ error: 'queue full' } as never);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      // Should not emit delta when enqueue fails
      expect(sessionDomainService.emitDelta).not.toHaveBeenCalled();
    });

    it('returns empty prompt when workspace has no GitHub issue', async () => {
      setupHappyPath();
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([
        unsafeCoerce({ id: 'session-1', status: SessionStatus.IDLE, model: 'claude-sonnet' }),
      ]);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(sessionDomainService.enqueue).not.toHaveBeenCalled();
    });

    it('returns empty prompt when project lacks GitHub owner/repo', async () => {
      const workspace = makeWorkspaceWithProject({
        githubIssueNumber: 42,
        project: unsafeCoerce({
          id: 'proj-1',
          defaultBranch: 'main',
          worktreeBasePath: '/base',
          githubOwner: null,
          githubRepo: null,
        }),
      });
      setupHappyPath();
      vi.mocked(workspaceAccessor.findByIdWithProject).mockResolvedValue(workspace);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([
        unsafeCoerce({ id: 'session-1', status: SessionStatus.IDLE, model: 'claude-sonnet' }),
      ]);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(githubCLIService.getIssue).not.toHaveBeenCalled();
      expect(sessionDomainService.enqueue).not.toHaveBeenCalled();
    });

    it('returns empty prompt when issue fetch fails', async () => {
      const workspace = makeWorkspaceWithProject({ githubIssueNumber: 42 });
      setupHappyPath();
      vi.mocked(workspaceAccessor.findByIdWithProject).mockResolvedValue(workspace);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([
        unsafeCoerce({ id: 'session-1', status: SessionStatus.IDLE, model: 'claude-sonnet' }),
      ]);
      vi.mocked(githubCLIService.getIssue).mockResolvedValue(null);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(sessionDomainService.enqueue).not.toHaveBeenCalled();
    });

    it('returns empty prompt when issue fetch throws', async () => {
      const workspace = makeWorkspaceWithProject({ githubIssueNumber: 42 });
      setupHappyPath();
      vi.mocked(workspaceAccessor.findByIdWithProject).mockResolvedValue(workspace);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([
        unsafeCoerce({ id: 'session-1', status: SessionStatus.IDLE, model: 'claude-sonnet' }),
      ]);
      vi.mocked(githubCLIService.getIssue).mockRejectedValue(new Error('GitHub API error'));

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      // Should not throw - error is caught inside buildInitialPromptFromGitHubIssue
      expect(sessionDomainService.enqueue).not.toHaveBeenCalled();
    });

    it('includes issue body of "(No description provided)" when body is empty', async () => {
      const workspace = makeWorkspaceWithProject({ githubIssueNumber: 42 });
      setupHappyPath();
      vi.mocked(workspaceAccessor.findByIdWithProject).mockResolvedValue(workspace);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([
        unsafeCoerce({ id: 'session-1', status: SessionStatus.IDLE, model: 'claude-sonnet' }),
      ]);
      vi.mocked(githubCLIService.getIssue).mockResolvedValue(
        unsafeCoerce({
          number: 42,
          title: 'No body issue',
          body: '',
          url: 'https://github.com/owner/repo/issues/42',
        })
      );
      vi.mocked(sessionDomainService.enqueue).mockReturnValue({ position: 0 });

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(sessionDomainService.enqueue).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          text: expect.stringContaining('(No description provided)'),
        })
      );
    });
  });

  describe('error handling and cleanup', () => {
    it('marks workspace failed when worktree creation throws', async () => {
      setupHappyPath();
      vi.mocked(gitOpsService.createWorktree).mockRejectedValue(
        new Error('git worktree add failed')
      );

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(workspaceStateMachine.markFailed).toHaveBeenCalledWith(
        WORKSPACE_ID,
        'git worktree add failed'
      );
    });

    it('stops sessions after init failure', async () => {
      setupHappyPath();
      vi.mocked(gitOpsService.createWorktree).mockRejectedValue(
        new Error('git worktree add failed')
      );

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(sessionService.stopWorkspaceSessions).toHaveBeenCalledWith(WORKSPACE_ID);
    });

    it('does not throw when stopping sessions fails after init failure', async () => {
      setupHappyPath();
      vi.mocked(gitOpsService.createWorktree).mockRejectedValue(
        new Error('git worktree add failed')
      );
      vi.mocked(sessionService.stopWorkspaceSessions).mockRejectedValue(new Error('stop failed'));

      // Should not throw
      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(workspaceStateMachine.markFailed).toHaveBeenCalled();
    });

    it('does not clear init mode when worktree was never created', async () => {
      setupHappyPath();
      vi.mocked(gitOpsService.ensureBaseBranchExists).mockRejectedValue(
        new Error('branch not found')
      );

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      // worktreeCreated is false, so clearInitMode should not be called
      expect(worktreeLifecycleService.clearInitMode).not.toHaveBeenCalled();
    });

    it('clears init mode even when error occurs after worktree creation', async () => {
      setupHappyPath();
      vi.mocked(workspaceAccessor.update).mockRejectedValue(new Error('db error'));

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      // worktreeCreated is true, so clearInitMode should still be called via finally
      expect(worktreeLifecycleService.clearInitMode).toHaveBeenCalledWith(WORKSPACE_ID, '/base');
    });

    it('marks workspace failed when workspace update throws', async () => {
      setupHappyPath();
      vi.mocked(workspaceAccessor.update).mockRejectedValue(new Error('db update error'));

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(workspaceStateMachine.markFailed).toHaveBeenCalledWith(
        WORKSPACE_ID,
        'db update error'
      );
    });
  });

  describe('script priority', () => {
    it('prefers factory setup script over project startup script', async () => {
      setupHappyPath();
      vi.mocked(FactoryConfigService.readConfig).mockResolvedValue(
        unsafeCoerce({ scripts: { setup: './factory-setup.sh', run: null, cleanup: null } })
      );
      vi.mocked(startupScriptService.hasStartupScript).mockReturnValue(true);
      vi.mocked(startupScriptService.runStartupScript).mockResolvedValue({
        success: true,
      } as never);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      // Factory setup runs, project startup should not be checked
      expect(startupScriptService.runStartupScript).toHaveBeenCalledTimes(1);
      expect(startupScriptService.runStartupScript).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ startupScriptCommand: './factory-setup.sh' })
      );
    });
  });

  describe('dispatch retry when workspace becomes ready', () => {
    it('retries queue dispatch after successful factory setup', async () => {
      setupHappyPath();
      vi.mocked(FactoryConfigService.readConfig).mockResolvedValue(
        unsafeCoerce({ scripts: { setup: './setup.sh', run: null, cleanup: null } })
      );
      vi.mocked(startupScriptService.runStartupScript).mockResolvedValue({
        success: true,
      } as never);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([
        unsafeCoerce({ id: 'session-1', status: SessionStatus.IDLE, model: 'claude-sonnet' }),
      ]);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(chatMessageHandlerService.tryDispatchNextMessage).toHaveBeenCalledTimes(2);
      expect(chatMessageHandlerService.tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    });

    it('does not retry ready dispatch when factory setup fails', async () => {
      setupHappyPath();
      vi.mocked(FactoryConfigService.readConfig).mockResolvedValue(
        unsafeCoerce({ scripts: { setup: './setup.sh', run: null, cleanup: null } })
      );
      vi.mocked(startupScriptService.runStartupScript).mockResolvedValue({
        success: false,
      } as never);
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([
        unsafeCoerce({ id: 'session-1', status: SessionStatus.IDLE, model: 'claude-sonnet' }),
      ]);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(chatMessageHandlerService.tryDispatchNextMessage).toHaveBeenCalledTimes(1);
      expect(chatMessageHandlerService.tryDispatchNextMessage).toHaveBeenCalledWith('session-1');
    });

    it('retries dispatch using the started session id without re-querying session status', async () => {
      setupHappyPath();
      vi.mocked(agentSessionAccessor.findByWorkspaceId).mockResolvedValue([
        unsafeCoerce({
          id: 'session-idle',
          status: SessionStatus.IDLE,
          model: 'claude-sonnet',
        }),
      ]);

      await initializeWorkspaceWorktree(WORKSPACE_ID);

      expect(agentSessionAccessor.findByWorkspaceId).toHaveBeenCalledTimes(1);
      expect(agentSessionAccessor.findByWorkspaceId).toHaveBeenCalledWith(WORKSPACE_ID, {
        status: SessionStatus.IDLE,
        limit: 1,
      });
      expect(chatMessageHandlerService.tryDispatchNextMessage).toHaveBeenCalledTimes(2);
      expect(chatMessageHandlerService.tryDispatchNextMessage).toHaveBeenNthCalledWith(
        1,
        'session-idle'
      );
      expect(chatMessageHandlerService.tryDispatchNextMessage).toHaveBeenNthCalledWith(
        2,
        'session-idle'
      );
    });
  });
});
