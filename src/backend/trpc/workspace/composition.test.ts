import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultApplicationDependencies } from '@/backend/app-context';
import type { CreatedWorkspace } from '@/backend/orchestration/workspace-launch.orchestrator';
import { createFakeApplicationGraph } from '@/test-utils/application-graph';

const mockListForProject = vi.hoisted(() => vi.fn());
const mockCountPending = vi.hoisted(() => vi.fn());
const mockGetWorkspaceWithWorktree = vi.hoisted(() => vi.fn());

vi.mock('@/backend/trpc/workspace/workspace-helpers', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/backend/trpc/workspace/workspace-helpers')>();
  return {
    ...original,
    getWorkspaceWithWorktree: mockGetWorkspaceWithWorktree,
  };
});

import { workspaceRouter } from '@/backend/trpc/workspace.trpc';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

describe('workspace router composition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListForProject.mockResolvedValue({ workspaces: [], reviewCount: 0 });
    mockCountPending.mockResolvedValue(0);
    mockGetWorkspaceWithWorktree.mockResolvedValue(null);
  });

  it('does not read internal procedure definitions', () => {
    const workspaceRouterSource = readFileSync(
      new URL('../workspace.trpc.ts', import.meta.url),
      'utf8'
    );

    expect(workspaceRouterSource).not.toContain('_def.procedures');
  });

  it('returns only the workspace from the injected interactive launch capability', async () => {
    const fakeGraph = createFakeApplicationGraph('workspace-launch-composition');
    const workspace = unsafeCoerce<CreatedWorkspace>({ id: 'workspace-1', name: 'Created' });
    const launchWorkspace = vi.fn(async () => ({ workspace, defaultSessionId: 'session-1' }));
    const caller = workspaceRouter.createCaller({
      appContext: { ...fakeGraph, services: { ...fakeGraph.services, launchWorkspace } },
    });

    await expect(
      caller.create({
        type: 'MANUAL',
        projectId: 'project-1',
        name: 'Created',
        initialPrompt: 'Start here',
        startupModePreset: 'plan',
        provider: 'CODEX',
      })
    ).resolves.toEqual(workspace);
    expect(launchWorkspace).toHaveBeenCalledWith({
      type: 'MANUAL',
      projectId: 'project-1',
      name: 'Created',
      initialPrompt: 'Start here',
      startupModePreset: 'plan',
      provider: 'CODEX',
    });
  });

  it('wires the launch use case to the supplied composition capabilities', async () => {
    const fakeGraph = createFakeApplicationGraph('workspace-launch-ports');
    const { services, lifecycle } = createDefaultApplicationDependencies();
    const workspace = unsafeCoerce<CreatedWorkspace>({ id: 'workspace-1', name: 'Created' });
    const createWorkspace = vi.fn().mockResolvedValue(workspace);
    const createAgentSession = vi.fn().mockResolvedValue({ id: 'session-1' });
    const initializeWorkspaceWorktree = vi.fn().mockResolvedValue(undefined);
    const resolveProviderForWorkspaceCreation = vi.fn().mockResolvedValue('CLAUDE');
    const checkHealth = vi
      .fn()
      .mockResolvedValue({ claude: { isInstalled: true }, codex: { isInstalled: true } });
    services.configService = Object.assign({}, fakeGraph.services.configService, {
      getMaxSessionsPerWorkspace: () => 2,
    });
    services.sessionProviderResolverService = Object.assign(
      {},
      fakeGraph.services.sessionProviderResolverService,
      { resolveProviderForWorkspaceCreation }
    );
    services.cliHealthService = Object.assign({}, fakeGraph.services.cliHealthService, {
      checkHealth,
    });
    services.createWorkspaceCreationService = () => ({ create: createWorkspace });
    services.sessionDataService = Object.assign({}, fakeGraph.services.sessionDataService, {
      createAgentSession,
    });
    services.initializeWorkspaceWorktree = initializeWorkspaceWorktree;
    const caller = workspaceRouter.createCaller({
      appContext: { services, lifecycle, config: fakeGraph.config },
    });

    await expect(
      caller.create({ type: 'RESUME_BRANCH', projectId: 'project-1', branchName: 'feature/resume' })
    ).resolves.toEqual(workspace);
    expect(resolveProviderForWorkspaceCreation).toHaveBeenCalledWith(undefined);
    expect(checkHealth).toHaveBeenCalledOnce();
    expect(createWorkspace).toHaveBeenCalledWith({
      type: 'RESUME_BRANCH',
      projectId: 'project-1',
      branchName: 'feature/resume',
    });
    expect(createAgentSession).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      workflow: 'followup',
      name: 'Chat 1',
      provider: 'CLAUDE',
      providerProjectPath: null,
    });
    expect(initializeWorkspaceWorktree).toHaveBeenCalledWith('workspace-1', {
      branchName: 'feature/resume',
      useExistingBranch: true,
    });
    resolveProviderForWorkspaceCreation.mockRejectedValueOnce(new Error('Mismatched model'));
    await expect(
      caller.create({
        type: 'MANUAL',
        projectId: 'project-1',
        name: 'Explicit model',
        provider: 'CLAUDE',
        model: 'gpt-6-luna',
      })
    ).rejects.toThrow('Mismatched model');
    expect(resolveProviderForWorkspaceCreation).toHaveBeenCalledWith('CLAUDE', 'gpt-6-luna');
    expect(createWorkspace).toHaveBeenCalledOnce();
  });

  it('rejects invalid input before invoking interactive launch', async () => {
    const fakeGraph = createFakeApplicationGraph('workspace-launch-validation');
    const launchWorkspace = vi.fn();
    const caller = workspaceRouter.createCaller({
      appContext: { ...fakeGraph, services: { ...fakeGraph.services, launchWorkspace } },
    });

    await expect(
      caller.create({ type: 'MANUAL', projectId: 'project-1', name: '' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(launchWorkspace).not.toHaveBeenCalled();
  });

  it('keeps core, child-workspace, and file procedures on the public flat caller', async () => {
    const fakeGraph = createFakeApplicationGraph('workspace-composition');
    const services = {
      ...fakeGraph.services,
      workspaceQueryService: Object.assign({}, fakeGraph.services.workspaceQueryService, {
        listForProject: mockListForProject,
      }),
      workspaceNotificationService: Object.assign(
        {},
        fakeGraph.services.workspaceNotificationService,
        { countPending: mockCountPending }
      ),
    };
    const caller = workspaceRouter.createCaller(
      unsafeCoerce({
        appContext: {
          services,
          lifecycle: fakeGraph.lifecycle,
          config: fakeGraph.config,
        },
      })
    );

    await expect(caller.listForProject({ projectId: 'project-1' })).resolves.toEqual({
      workspaces: [],
      reviewCount: 0,
    });
    await expect(caller.getPendingNotificationCount({ workspaceId: 'workspace-1' })).resolves.toBe(
      0
    );
    await expect(caller.listAllFiles({ workspaceId: 'workspace-1', limit: 50 })).resolves.toEqual({
      files: [],
      hasWorktree: false,
    });
  });
});
