import { describe, expect, it, vi } from 'vitest';
vi.mock('./orchestration/agent-runtime.orchestrator', () => ({
  createAgentRuntime: () => ({ start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) }),
}));
import type { RenamedWorkspace } from '@/backend/orchestration/workspace-rename.orchestrator';
import { createFakeApplicationGraph } from '@/test-utils/application-graph';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  createApplication,
  createDefaultApplicationDependencies,
  disposeApplication,
} from './app-context';
import { serverInstanceService } from './services/server-instance.service';

describe('createApplication', () => {
  it('binds accepted rename to each application service graph without sharing its queue or publication target', async () => {
    const first = createDefaultApplicationDependencies();
    const second = createDefaultApplicationDependencies();
    const a = unsafeCoerce<RenamedWorkspace>({
      id: 'same-id',
      name: 'First graph',
      status: 'READY',
      updatedAt: new Date(200),
    });
    const b = { ...a, name: 'Second graph' };
    let finish!: (workspace: RenamedWorkspace) => void;
    const slow = vi.fn(
      () =>
        new Promise<RenamedWorkspace>((resolve) => {
          finish = resolve;
        })
    );
    const fast = vi.fn(() => Promise.resolve(b));
    const publishA = vi.fn();
    const publishB = vi.fn();
    first.services.workspaceDataService = Object.assign({}, first.services.workspaceDataService, {
      rename: slow,
    });
    second.services.workspaceDataService = Object.assign({}, second.services.workspaceDataService, {
      rename: fast,
    });
    first.services.workspaceSnapshotStore = Object.assign(
      {},
      first.services.workspaceSnapshotStore,
      { publishAcceptedName: publishA }
    );
    second.services.workspaceSnapshotStore = Object.assign(
      {},
      second.services.workspaceSnapshotStore,
      { publishAcceptedName: publishB }
    );
    const pending = first.services.renameWorkspace('same-id', 'Requested A');
    expect(await second.services.renameWorkspace('same-id', 'Requested B')).toEqual(b);
    expect(publishA).not.toHaveBeenCalled();
    expect(publishB).toHaveBeenCalledExactlyOnceWith('same-id', b.name, 200);
    finish(a);
    expect(await pending).toEqual(a);
    expect(publishA).toHaveBeenCalledExactlyOnceWith('same-id', a.name, 200);
  });

  it('searches GitHub issues through the application-owned project and CLI capabilities', async () => {
    const { services } = createDefaultApplicationDependencies();
    services.projectManagementService = Object.assign({}, services.projectManagementService, {
      list: vi
        .fn()
        .mockResolvedValue([
          { id: 'p1', slug: 'factory', name: 'Factory', githubOwner: 'org', githubRepo: 'repo' },
        ]),
    });
    services.githubCLIService = Object.assign({}, services.githubCLIService, {
      searchIssues: vi.fn().mockResolvedValue([
        {
          number: 42,
          title: 'Graph issue',
          body: 'Details',
          url: 'https://github.com/org/repo/issues/42',
          state: 'OPEN',
          createdAt: '2026-01-01T00:00:00Z',
          author: { login: 'martin' },
        },
      ]),
    });
    await expect(
      services.searchGitHubIssues({ query: '#42', limit: 30, includeArchived: false })
    ).resolves.toEqual({
      results: [expect.objectContaining({ projectId: 'p1', title: 'Graph issue' })],
      errors: [],
    });
  });

  it('shares the runtime server endpoint with lifecycle composition', () => {
    const dependencies = createDefaultApplicationDependencies();

    expect(dependencies.services.serverInstanceService).toBe(serverInstanceService);
  });

  it('binds project settings to the graph-owned repository and crypto capabilities', async () => {
    const { services } = createDefaultApplicationDependencies();
    const update = vi.fn().mockRejectedValue(new Error('storage unavailable'));
    const validateRepoPath = vi.fn().mockResolvedValue({ valid: true });
    const encrypt = vi.fn((key: string) => `encrypted:${key}`);
    services.projectManagementService = Object.assign({}, services.projectManagementService, {
      validateRepoPath,
      update,
    });
    services.cryptoService = Object.assign({}, services.cryptoService, { encrypt });
    await expect(
      services.updateProjectSettings({
        id: 'p1',
        repoPath: '/repo',
        issueTrackerConfig: {
          linear: { apiKey: 'new-key', teamId: 'team-1', teamName: 'Core', viewerName: 'Alice' },
        },
      })
    ).rejects.toThrow('storage unavailable');
    expect(validateRepoPath).toHaveBeenCalledWith('/repo');
    expect(encrypt).toHaveBeenCalledExactlyOnceWith('new-key');
    expect(update).toHaveBeenCalledWith('p1', {
      repoPath: '/repo',
      issueTrackerConfig: {
        linear: {
          apiKey: 'encrypted:new-key',
          teamId: 'team-1',
          teamName: 'Core',
          viewerName: 'Alice',
        },
      },
    });
  });

  it('binds conditional project settings writes to the graph-owned project capability', async () => {
    const { services } = createDefaultApplicationDependencies();
    const findById = vi
      .fn()
      .mockResolvedValue({ startupScriptCommand: null, startupScriptPath: null });
    const updateIfStartupUnchanged = vi
      .fn()
      .mockRejectedValue(new Error('conditional storage unavailable'));
    services.projectManagementService = Object.assign({}, services.projectManagementService, {
      findById,
      updateIfStartupUnchanged,
    });
    await expect(
      services.updateProjectSettings({ id: 'p1', startupScriptCommand: 'pnpm dev' })
    ).rejects.toThrow('conditional storage unavailable');
    expect(updateIfStartupUnchanged).toHaveBeenCalledExactlyOnceWith(
      'p1',
      { startupScriptCommand: null, startupScriptPath: null },
      { startupScriptCommand: 'pnpm dev' }
    );
  });

  it('routes child creation through the graph-owned project lookup and launch capability', async () => {
    const actualChildren = await vi.importActual<
      typeof import('@/backend/orchestration/workspace-children.orchestrator')
    >('@/backend/orchestration/workspace-children.orchestrator');
    const children = await vi.importMock<
      typeof import('@/backend/orchestration/workspace-children.orchestrator')
    >('@/backend/orchestration/workspace-children.orchestrator');
    vi.mocked(children.createChildWorkspace).mockImplementationOnce(
      actualChildren.createChildWorkspace
    );
    const { services } = createDefaultApplicationDependencies();
    const findProject = vi.fn().mockResolvedValue({ id: 'project-1', isArchived: false });
    const launch = vi
      .fn()
      .mockResolvedValue({ workspace: { id: 'injected-child' }, defaultSessionId: null });
    services.projectManagementService = new Proxy(services.projectManagementService, {
      get(target, property, receiver) {
        return property === 'findById' ? findProject : Reflect.get(target, property, receiver);
      },
    });
    services.launchWorkspace = launch;
    const input = {
      projectId: 'project-1',
      parentWorkspaceId: 'parent-1',
      name: 'Child',
      initialPrompt: 'Child task',
      reportBackOn: 'Done',
    };
    await expect(services.createChildWorkspace(input)).resolves.toBe('injected-child');
    expect(findProject).toHaveBeenCalledExactlyOnceWith('project-1');
    expect(launch).toHaveBeenCalledExactlyOnceWith({ type: 'CHILD_WORKSPACE', ...input });
  });

  it('keeps two complete fake graphs isolated', () => {
    const firstDependencies = createFakeApplicationGraph('first');
    const secondDependencies = createFakeApplicationGraph('second');

    const first = createApplication(firstDependencies);
    const second = createApplication(secondDependencies);

    expect(first.lifecycle.wireDomainBridges).toHaveBeenCalledWith(first.services);
    expect(second.lifecycle.wireDomainBridges).toHaveBeenCalledWith(second.services);
    expect(vi.mocked(first.lifecycle.wireDomainBridges).mock.calls[0]?.[0]).toBe(
      firstDependencies.services
    );
    expect(vi.mocked(second.lifecycle.wireDomainBridges).mock.calls[0]?.[0]).toBe(
      secondDependencies.services
    );
    expect(first.lifecycle.eventCollector.start).toHaveBeenCalledOnce();
    expect(second.lifecycle.eventCollector.start).toHaveBeenCalledOnce();
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.services).toBe(firstDependencies.services);
    expect(first.lifecycle).toBe(firstDependencies.lifecycle);
    expect(Object.isFrozen(first.services)).toBe(true);
    expect(Object.isFrozen(first.lifecycle)).toBe(true);
  });

  it('creates an isolated config object for every fake graph', () => {
    const first = createFakeApplicationGraph('first');
    const second = createFakeApplicationGraph('second');

    expect(first.config).not.toBe(second.config);
    (first.config.cors.allowedOrigins as string[]).push('https://first.example');
    expect(second.config.cors.allowedOrigins).toEqual([]);
  });

  it('configures ACP from the supplied fake config service', () => {
    const dependencies = createFakeApplicationGraph('supplied');

    createApplication(dependencies);

    expect(dependencies.services.acpRuntimeManager.setAcpStartupTimeoutMs).toHaveBeenCalledWith(
      4321
    );
    expect(dependencies.services.acpRuntimeManager.configureEnvironment).toHaveBeenCalledWith({
      childProcessEnvProvider: expect.any(Function),
    });

    const environment = vi.mocked(dependencies.services.acpRuntimeManager.configureEnvironment).mock
      .calls[0]?.[0];
    expect(environment?.childProcessEnvProvider()).toEqual({ APPLICATION_LABEL: 'supplied' });
    expect(dependencies.services.configService.getChildProcessEnv).toHaveBeenCalledTimes(1);
  });

  it('disposes graph-owned resources before a server can take ownership', async () => {
    const dependencies = createFakeApplicationGraph('construction-failure');
    const application = createApplication(dependencies);

    await disposeApplication(application);

    expect(application.lifecycle.eventCollector.stop).toHaveBeenCalledOnce();
    expect(application.lifecycle.snapshotReconciliation.stop).toHaveBeenCalledOnce();
    expect(application.services.workspaceGitStateService.stop).toHaveBeenCalledOnce();
  });
});
