import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/backend/services/codex-accounts', () => ({
  codexAccountService: {
    getPreviewRuntimeContext: vi.fn(async () => ({ accountId: 'codex-native-default', env: {} })),
    withAccountReservation: vi.fn(async (input, create) =>
      create(input.accountId ?? 'codex-native-default')
    ),
  },
}));
import { createDefaultApplicationDependencies } from '@/backend/app-context';
import { sessionProviderResolverService } from '@/backend/services/session';
import {
  agentSessionAccessor,
  type CreateAgentSessionInput,
} from '@/backend/services/session/resources/agent-session.accessor';
import { prDedicatedSessionAccessor } from '@/backend/services/session/resources/pr-dedicated-session.accessor';
import { userSettingsService } from '@/backend/services/settings';
import { workspaceDataService } from '@/backend/services/workspace';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { AgentSession, SessionProvider, Workspace } from '@prisma-gen/client';

const workspace = unsafeCoerce<Workspace>({
  id: 'same-workspace',
  defaultSessionProvider: 'WORKSPACE_DEFAULT',
});
function persisted(input: CreateAgentSessionInput): AgentSession {
  return {
    id: 'session',
    workspaceId: input.workspaceId,
    name: input.name ?? null,
    workflow: input.workflow,
    workspacePrId: input.workspacePrId ?? null,
    model: input.model,
    provider: input.provider,
    codexAccountId: input.codexAccountId ?? null,
    status: 'IDLE',
    providerSessionId: null,
    providerProjectPath: input.providerProjectPath ?? null,
    providerProcessPid: null,
    providerMetadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}
function graph(provider: SessionProvider, claude: string, codex: string) {
  const { services } = createDefaultApplicationDependencies();
  services.workspaceDataService = Object.assign({}, services.workspaceDataService, {
    findById: vi.fn().mockResolvedValue(workspace),
  });
  services.userSettingsQueryService = Object.assign({}, services.userSettingsQueryService, {
    getDefaultSessionProvider: vi.fn().mockResolvedValue(provider),
    get: vi.fn().mockResolvedValue({ defaultClaudeModel: claude, defaultCodexModel: codex }),
  });
  return services;
}
function guardGlobals() {
  const forbidden = () => {
    throw new Error('process-default lookup escaped graph');
  };
  vi.spyOn(sessionProviderResolverService, 'resolveSessionDefaults').mockImplementation(forbidden);
  vi.spyOn(userSettingsService, 'get').mockImplementation(forbidden);
  vi.spyOn(userSettingsService, 'getDefaultSessionProvider').mockImplementation(forbidden);
  vi.spyOn(workspaceDataService, 'findById').mockImplementation(forbidden);
}

beforeEach(() => {
  vi.spyOn(agentSessionAccessor, 'create').mockImplementation(async (input) => persisted(input));
  vi.spyOn(agentSessionAccessor, 'createWithinWorkspaceLimit').mockImplementation(
    async (input) => ({ outcome: 'created', session: persisted(input) })
  );
  vi.spyOn(prDedicatedSessionAccessor, 'find').mockResolvedValue(null);
  vi.spyOn(prDedicatedSessionAccessor, 'findWorkspace').mockResolvedValue(workspace);
  vi.spyOn(prDedicatedSessionAccessor, 'acquire').mockImplementation(async (input) => ({
    outcome: 'created',
    session: persisted({ ...input, workflow: 'pr-monitoring', workspacePrId: input.prId }),
  }));
});
afterEach(() => vi.restoreAllMocks());

describe('real application session creation defaults', () => {
  it.each(['ordinary', 'limited'] as const)(
    'persists independent defaults from two real graphs through %s creation',
    async (kind) => {
      const a = graph('CLAUDE', 'haiku', 'gpt-a');
      const b = graph('CODEX', 'opus', 'gpt-b');
      guardGlobals();
      const create = async (services: typeof a) => {
        const input = { workspaceId: workspace.id, workflow: 'followup' };
        if (kind === 'ordinary') {
          return services.sessionDataService.createAgentSession(input);
        }
        const result = await services.sessionDataService.createAgentSessionWithinWorkspaceLimit({
          ...input,
          maxSessions: 3,
        });
        if (result.outcome !== 'created') {
          throw new Error('Expected creation');
        }
        return result.session;
      };
      expect(await create(a)).toMatchObject({ provider: 'CLAUDE', model: 'haiku' });
      expect(await create(b)).toMatchObject({ provider: 'CODEX', model: 'gpt-b' });
      expect(await create(a)).toMatchObject({ provider: 'CLAUDE', model: 'haiku' });
      expect(a.sessionDataService).not.toBe(b.sessionDataService);
      expect(a.sessionProviderResolverService).not.toBe(b.sessionProviderResolverService);
      const write =
        kind === 'ordinary'
          ? agentSessionAccessor.create
          : agentSessionAccessor.createWithinWorkspaceLimit;
      expect(vi.mocked(write).mock.calls.map(([input]) => [input.provider, input.model])).toEqual([
        ['CLAUDE', 'haiku'],
        ['CODEX', 'gpt-b'],
        ['CLAUDE', 'haiku'],
      ]);
    }
  );

  it('uses each graph settings for dedicated acquisition and keeps the validated workspace', async () => {
    const a = graph('CLAUDE', 'haiku', 'gpt-a');
    const b = graph('CODEX', 'opus', 'gpt-b');
    guardGlobals();
    const input = { workspaceId: workspace.id, prId: 'pr', maxSessions: 3 };
    expect(await a.sessionDataService.acquirePRDedicatedSession(input)).toMatchObject({
      outcome: 'created',
      session: { provider: 'CLAUDE', model: 'haiku' },
    });
    expect(await b.sessionDataService.acquirePRDedicatedSession(input)).toMatchObject({
      outcome: 'created',
      session: { provider: 'CODEX', model: 'gpt-b' },
    });
    expect(a.workspaceDataService.findById).not.toHaveBeenCalled();
    expect(b.workspaceDataService.findById).not.toHaveBeenCalled();
  });

  it('keeps creation settings on the query capability when only the PR bridge alias is replaced', async () => {
    const services = graph('CLAUDE', 'haiku', 'gpt-query');
    services.userSettingsService = Object.assign({}, services.userSettingsService, {
      getDefaultSessionProvider: vi.fn().mockResolvedValue('CODEX'),
      get: vi
        .fn()
        .mockResolvedValue({ defaultClaudeModel: 'opus', defaultCodexModel: 'gpt-bridge' }),
    });
    guardGlobals();
    expect(
      await services.sessionDataService.createAgentSession({
        workspaceId: workspace.id,
        workflow: 'followup',
      })
    ).toMatchObject({ provider: 'CLAUDE', model: 'haiku' });
    expect(services.userSettingsService.get).not.toHaveBeenCalled();
    expect(services.userSettingsService.getDefaultSessionProvider).not.toHaveBeenCalled();
  });

  it('follows settings, workspace and resolver replacements after dependency construction', async () => {
    const a = graph('CLAUDE', 'haiku', 'gpt-a');
    const b = graph('CODEX', 'opus', 'gpt-b');
    guardGlobals();
    const input = { workspaceId: workspace.id, workflow: 'followup' };
    expect(await a.sessionDataService.createAgentSession(input)).toMatchObject({
      provider: 'CLAUDE',
      model: 'haiku',
    });
    a.userSettingsQueryService = Object.assign({}, a.userSettingsQueryService, {
      getDefaultSessionProvider: vi.fn().mockResolvedValue('CODEX'),
      get: vi
        .fn()
        .mockResolvedValue({ defaultClaudeModel: 'opus', defaultCodexModel: 'gpt-replaced' }),
    });
    expect(await a.sessionDataService.createAgentSession(input)).toMatchObject({
      provider: 'CODEX',
      model: 'gpt-replaced',
    });
    a.workspaceDataService = Object.assign({}, a.workspaceDataService, {
      findById: vi.fn().mockResolvedValue({ ...workspace, defaultSessionProvider: 'CLAUDE' }),
    });
    expect(await a.sessionDataService.createAgentSession(input)).toMatchObject({
      provider: 'CLAUDE',
      model: 'opus',
    });
    a.sessionProviderResolverService = Object.assign({}, a.sessionProviderResolverService, {
      resolveSessionDefaults: vi
        .fn()
        .mockResolvedValue({ provider: 'CODEX', model: 'gpt-sentinel' }),
    });
    expect(await a.sessionDataService.createAgentSession(input)).toMatchObject({
      provider: 'CODEX',
      model: 'gpt-sentinel',
    });
    expect(await b.sessionDataService.createAgentSession(input)).toMatchObject({
      provider: 'CODEX',
      model: 'gpt-b',
    });
  });
});

const manual = { type: 'MANUAL', projectId: 'project', name: 'Manual', provider: 'CODEX' } as const;
const periodic = {
  type: 'PERIODIC_TASK',
  projectId: 'project',
  periodicTaskId: 'task',
  name: 'Task',
  initialPrompt: 'Work',
  ratchetEnabled: true,
} as const;
const child = {
  type: 'CHILD_WORKSPACE',
  projectId: 'project',
  parentWorkspaceId: 'parent',
  name: 'Child',
  initialPrompt: 'Work',
  reportBackOn: 'Done',
} as const;
function launchGraph(provider: SessionProvider, claude: string, codex: string) {
  const services = graph(provider, claude, codex);
  const events: string[] = [];
  const create = vi.fn(() => {
    events.push('workspace');
    return Promise.resolve(
      unsafeCoerce<Awaited<ReturnType<typeof services.workspaceCreationService.create>>>(workspace)
    );
  });
  services.createWorkspaceCreationService = () =>
    unsafeCoerce<ReturnType<typeof services.createWorkspaceCreationService>>({ create });
  services.workspaceCreationService = Object.assign({}, services.workspaceCreationService, {
    create,
  });
  services.configService = Object.assign({}, services.configService, {
    getMaxSessionsPerWorkspace: vi.fn(() => 2),
  });
  services.cliHealthService = Object.assign({}, services.cliHealthService, {
    checkHealth: vi.fn(() => {
      events.push('health');
      return Promise.resolve({
        claude: { isInstalled: true },
        codex: { isInstalled: true, isAuthenticated: true },
      });
    }),
  });
  services.initializeWorkspaceWorktree = vi.fn(() => {
    events.push('initialize');
    return Promise.resolve();
  });
  const logger = { warn: vi.fn(), error: vi.fn() };
  services.createLogger = () => unsafeCoerce<ReturnType<typeof services.createLogger>>(logger);
  const resolve = services.sessionProviderResolverService.resolveProviderForWorkspaceCreation.bind(
    services.sessionProviderResolverService
  );
  vi.spyOn(
    services.sessionProviderResolverService,
    'resolveProviderForWorkspaceCreation'
  ).mockImplementation((...args) => {
    events.push('provider');
    return resolve(...args);
  });
  vi.mocked(agentSessionAccessor.create).mockImplementation((input) => {
    events.push('session');
    return Promise.resolve(persisted(input));
  });
  return { services, create, events, logger };
}

describe('real final creation through application launch', () => {
  it('uses both graphs saved models after explicit-provider interactive preflight', async () => {
    const a = launchGraph('CLAUDE', 'haiku', 'gpt-a');
    guardGlobals();
    expect(await a.services.launchWorkspace(manual)).toMatchObject({ defaultSessionId: 'session' });
    const b = launchGraph('CODEX', 'opus', 'gpt-b');
    expect(await b.services.launchWorkspace(manual)).toMatchObject({ defaultSessionId: 'session' });
    expect(
      vi
        .mocked(agentSessionAccessor.create)
        .mock.calls.map(([input]) => [input.provider, input.model])
    ).toEqual([
      ['CODEX', 'gpt-a'],
      ['CODEX', 'gpt-b'],
    ]);
    expect(a.events).toEqual(['provider', 'health', 'workspace', 'session', 'initialize']);
    expect(b.events).toEqual(['provider', 'health', 'workspace', 'session', 'initialize']);
    expect(
      a.services.sessionProviderResolverService.resolveProviderForWorkspaceCreation
    ).toHaveBeenCalledWith('CODEX');
  });

  it('validates launch access through the graph configuration service before real persistence', async () => {
    const { services, create } = launchGraph('CODEX', 'haiku', 'gpt-saved');
    const discover = vi.spyOn(services.sessionConfigService, 'getLaunchOptions').mockResolvedValue({
      provider: 'CODEX',
      model: 'gpt-explicit',
      reasoning: { options: [] },
      planMode: { supported: true, selected: false },
      accessMode: { options: [{ value: 'agent', label: 'Auto review' }] },
    });
    guardGlobals();
    await expect(
      services.launchWorkspace({
        ...manual,
        model: 'gpt-explicit',
        accessMode: 'bypassPermissions',
      })
    ).rejects.toThrow('access mode');
    expect(create).not.toHaveBeenCalled();
    expect(agentSessionAccessor.create).not.toHaveBeenCalled();
    await services.launchWorkspace({ ...manual, model: 'gpt-explicit', accessMode: 'agent' });
    expect(discover).toHaveBeenLastCalledWith({ provider: 'CODEX', model: 'gpt-explicit' });
    expect(agentSessionAccessor.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'CODEX',
        model: 'gpt-explicit',
        providerMetadata: { launchSettings: { accessMode: 'agent', applied: false } },
      })
    );
  });

  it('preserves an explicit compatible model through real persistence', async () => {
    const { services, events } = launchGraph('CLAUDE', 'haiku', 'gpt-saved');
    guardGlobals();
    await services.launchWorkspace({ ...manual, model: 'gpt-explicit' });
    expect(agentSessionAccessor.create).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'CODEX', model: 'gpt-explicit' })
    );
    expect(events).toEqual(['provider', 'health', 'workspace', 'session', 'initialize']);
  });

  it.each([0, 2])(
    'rejects incompatible explicit models before persistence at capacity %s',
    async (capacity) => {
      const { services, create } = launchGraph('CLAUDE', 'haiku', 'gpt-saved');
      vi.mocked(services.configService.getMaxSessionsPerWorkspace).mockReturnValue(capacity);
      guardGlobals();
      await expect(services.launchWorkspace({ ...manual, model: 'haiku' })).rejects.toThrow(
        'not compatible'
      );
      expect(create).not.toHaveBeenCalled();
      expect(agentSessionAccessor.create).not.toHaveBeenCalled();
    }
  );

  it('skips creation and preflight at zero capacity without an explicit model', async () => {
    const { services, events } = launchGraph('CLAUDE', 'haiku', 'gpt-saved');
    vi.mocked(services.configService.getMaxSessionsPerWorkspace).mockReturnValue(0);
    guardGlobals();
    expect(await services.launchWorkspace(manual)).toMatchObject({ defaultSessionId: null });
    expect(events).toEqual(['workspace', 'initialize']);
  });

  it('resolves periodic defaults after persistence without interactive gates', async () => {
    const { services, events } = launchGraph('CLAUDE', 'haiku', 'gpt-saved');
    guardGlobals();
    expect(await services.launchWorkspace(periodic)).toMatchObject({ defaultSessionId: 'session' });
    expect(agentSessionAccessor.create).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'CLAUDE', model: 'haiku' })
    );
    expect(events).toEqual(['workspace', 'session', 'initialize']);
    expect(services.configService.getMaxSessionsPerWorkspace).not.toHaveBeenCalled();
  });

  it.each([manual, child, periodic])(
    'retains $type settings failure policy at the final creation boundary',
    async (source) => {
      const { services, events, logger } = launchGraph('CLAUDE', 'haiku', 'gpt-saved');
      vi.mocked(services.userSettingsQueryService.get).mockRejectedValue(
        new Error('settings unavailable')
      );
      guardGlobals();
      if (source.type === 'PERIODIC_TASK') {
        await expect(services.launchWorkspace(source)).rejects.toThrow('settings unavailable');
        expect(events).toEqual(['workspace']);
      } else {
        expect(await services.launchWorkspace(source)).toMatchObject({ defaultSessionId: null });
        expect(logger.warn).toHaveBeenCalledOnce();
        expect(services.initializeWorkspaceWorktree).toHaveBeenCalledOnce();
      }
      expect(agentSessionAccessor.create).not.toHaveBeenCalled();
    }
  );

  it('persists a child before resolving provider and uses graph model defaults without capacity or health gates', async () => {
    const { services, events } = launchGraph('CLAUDE', 'haiku', 'gpt-saved');
    guardGlobals();
    expect(await services.launchWorkspace(child)).toMatchObject({ defaultSessionId: 'session' });
    expect(agentSessionAccessor.create).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'CLAUDE', model: 'haiku' })
    );
    expect(events).toEqual(['workspace', 'provider', 'session', 'initialize']);
    expect(services.configService.getMaxSessionsPerWorkspace).not.toHaveBeenCalled();
  });
});
