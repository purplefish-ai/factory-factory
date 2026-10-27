import { describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@/backend/lib/application-error';
import {
  type CreatedWorkspace,
  launchWorkspace,
  type WorkspaceLaunchPorts,
  type WorkspaceLaunchSource,
} from '@/backend/orchestration/workspace-launch.orchestrator';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

const sources = [
  {
    source: {
      type: 'MANUAL',
      projectId: 'p1',
      name: 'Manual',
      branchName: 'feature/manual',
      provider: 'CODEX',
    },
    provider: 'CODEX',
    branchName: 'feature/manual',
    useExistingBranch: false,
  },
  {
    source: { type: 'RESUME_BRANCH', projectId: 'p1', branchName: 'feature/resume' },
    provider: undefined,
    branchName: 'feature/resume',
    useExistingBranch: true,
  },
  {
    source: {
      type: 'GITHUB_ISSUE',
      projectId: 'p1',
      issueNumber: 42,
      issueUrl: 'https://github.com/org/repo/issues/42',
      provider: 'CODEX',
    },
    provider: 'CODEX',
    branchName: undefined,
    useExistingBranch: false,
  },
  {
    source: {
      type: 'LINEAR_ISSUE',
      projectId: 'p1',
      issueId: 'linear-42',
      issueIdentifier: 'ENG-42',
      issueUrl: 'https://linear.app/org/issue/ENG-42',
      provider: 'CODEX',
    },
    provider: 'CODEX',
    branchName: undefined,
    useExistingBranch: false,
  },
] as const satisfies readonly {
  source: WorkspaceLaunchSource;
  provider: 'CODEX' | undefined;
  branchName: string | undefined;
  useExistingBranch: boolean;
}[];

function createPorts() {
  const workspace = unsafeCoerce<CreatedWorkspace>({ id: 'w-created', name: 'Persisted name' });
  const events: string[] = [];
  const ports = {
    getMaxSessionsPerWorkspace: vi.fn(() => 2),
    resolveProvider: vi.fn(() => {
      events.push('provider');
      return Promise.resolve('CODEX' as const);
    }),
    checkCliHealth: vi.fn(() => {
      events.push('health');
      return Promise.resolve({
        claude: { isInstalled: true },
        codex: { isInstalled: true, isAuthenticated: true },
      });
    }),
    createWorkspace: vi.fn(() => {
      events.push('workspace');
      return Promise.resolve(workspace);
    }),
    createDefaultSession: vi.fn(() => {
      events.push('session');
      return Promise.resolve({ id: 'session-1' });
    }),
    initializeWorktree: vi.fn(() => {
      events.push('initialize');
      return Promise.resolve();
    }),
    logger: { warn: vi.fn(), error: vi.fn() },
  } satisfies WorkspaceLaunchPorts;
  return { ports, workspace, events };
}

describe.each(sources)(
  '$source.type launch',
  ({ source, provider, branchName, useExistingBranch }) => {
    it('preflights, persists, provisions, then starts background initialization', async () => {
      const { ports, workspace, events } = createPorts();
      await expect(launchWorkspace(source, ports)).resolves.toEqual({
        workspace,
        defaultSessionId: 'session-1',
      });
      expect(events).toEqual(['provider', 'health', 'workspace', 'session', 'initialize']);
      expect(ports.resolveProvider).toHaveBeenCalledWith(provider);
      expect(ports.createWorkspace).toHaveBeenCalledWith(source);
      expect(ports.createDefaultSession).toHaveBeenCalledWith({
        workspaceId: 'w-created',
        workflow: 'followup',
        name: 'Chat 1',
        provider: 'CODEX',
        providerProjectPath: null,
      });
      expect(ports.initializeWorktree).toHaveBeenCalledWith('w-created', {
        branchName,
        useExistingBranch,
      });
    });

    it('uses capacity only as the provisioning enable gate', async () => {
      const { ports, workspace, events } = createPorts();
      ports.getMaxSessionsPerWorkspace.mockReturnValue(0);
      await expect(launchWorkspace(source, ports)).resolves.toEqual({
        workspace,
        defaultSessionId: null,
      });
      expect(events).toEqual(['workspace', 'initialize']);
    });

    it('rejects an unavailable effective provider before persistence', async () => {
      const { ports, events } = createPorts();
      ports.checkCliHealth.mockResolvedValue({
        claude: { isInstalled: true },
        codex: { isInstalled: true, isAuthenticated: false },
      });
      await expect(launchWorkspace(source, ports)).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message:
          'Cannot create workspace: Codex provider is unavailable: Codex CLI is not authenticated.',
      });
      expect(events).toEqual(['provider']);
      expect(ports.createWorkspace).not.toHaveBeenCalled();
      expect(ports.createDefaultSession).not.toHaveBeenCalled();
      expect(ports.initializeWorktree).not.toHaveBeenCalled();
    });

    it('propagates failed preflight without persistence', async () => {
      const { ports, events } = createPorts();
      const failure = new Error('Health check failed');
      ports.checkCliHealth.mockRejectedValue(failure);
      await expect(launchWorkspace(source, ports)).rejects.toBe(failure);
      expect(events).toEqual(['provider']);
    });

    it('propagates persistence failure without session provisioning or initialization', async () => {
      const { ports, events } = createPorts();
      const failure = new ApplicationError('NOT_FOUND', 'Project missing');
      ports.createWorkspace.mockRejectedValue(failure);
      await expect(launchWorkspace(source, ports)).rejects.toBe(failure);
      expect(events).toEqual(['provider', 'health']);
    });

    it('retains the workspace and initializes after failed session provisioning', async () => {
      const { ports, workspace } = createPorts();
      ports.createDefaultSession.mockRejectedValue('Session insert failed');
      await expect(launchWorkspace(source, ports)).resolves.toEqual({
        workspace,
        defaultSessionId: null,
      });
      expect(ports.logger.warn).toHaveBeenCalledWith(
        'Failed to create default session for workspace',
        { workspaceId: 'w-created', error: 'Session insert failed' }
      );
      expect(ports.initializeWorktree).toHaveBeenCalledWith('w-created', {
        branchName,
        useExistingBranch,
      });
    });

    it.each([new Error('Worktree failed'), 'Worktree failed'])(
      'returns before initialization settles and logs background failure %s',
      async (failure) => {
        const { ports, workspace } = createPorts();
        let rejectInit!: (reason: unknown) => void;
        ports.initializeWorktree.mockReturnValue(
          new Promise((_, reject) => {
            rejectInit = reject;
          })
        );
        await expect(launchWorkspace(source, ports)).resolves.toEqual({
          workspace,
          defaultSessionId: 'session-1',
        });
        rejectInit(failure);
        await vi.waitFor(() =>
          expect(ports.logger.error).toHaveBeenCalledWith(
            'Unexpected error during background workspace initialization',
            expect.objectContaining({ message: 'Worktree failed' }),
            { workspaceId: 'w-created' }
          )
        );
      }
    );
  }
);
