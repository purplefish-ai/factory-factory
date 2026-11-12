import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
const gate = vi.hoisted(() => ({ proven: ['CLAUDE', 'CODEX'] }));
vi.mock('@/backend/services/agent-definition/service/semantic-filter-gate', () => ({
  isClassifierProven: (provider: string) => gate.proven.includes(provider),
  semanticFilterSupported: (provider: string | undefined) =>
    provider ? gate.proven.includes(provider) : gate.proven.length === 2,
}));
let createAgentManagement: typeof import('@/backend/orchestration/agents/agent-management.orchestrator').createAgentManagement;
let createAgentAuthoring: typeof import('@/backend/orchestration/agents/agent-authoring.orchestrator').createAgentAuthoring;
let createContext: typeof import('./trpc').createContext;
let agentRouter: typeof import('./agent.trpc').agentRouter;

let db: IntegrationDatabase;
let runtime: typeof import('@/backend/services/agent-definition');
let workspace: typeof import('@/backend/services/workspace');
let projectId: string;
let connectionId: string;
let repository: ReturnType<
  typeof vi.fn<(name: string) => Promise<{ id: string; name: string; labels: string[] }>>
>;
let native: ReturnType<
  typeof vi.fn<() => Promise<import('@/shared/session-launch').SessionLaunchOptions>>
>;
let services: ReturnType<typeof makeServices>;
let caller: ReturnType<typeof agentRouter.createCaller>;
function makeServices() {
  return {
    agentManagementService: new runtime.AgentManagementService(),
    agentProposalService: new runtime.AgentProposalService(),
    projectManagementService: workspace.projectManagementService,
    workspaceDataService: workspace.workspaceDataService,
    slackConnectionService: new runtime.SlackConnectionService(
      { encrypt: (value) => value, decrypt: (value) => value },
      () => Promise.reject(new Error('Unexpected Slack call'))
    ),
    githubCLIService: { getAgentRepository: async (name: string) => repository(name) },
    sessionProviderResolverService: {
      resolveDefaultsForWorkspaceCreation: async (
        provider?: 'CLAUDE' | 'CODEX',
        model?: string
      ) => ({
        provider: provider ?? 'CLAUDE',
        model: model ?? 'sonnet',
      }),
    },
    userSettingsQueryService: {
      get: async () => ({
        defaultClaudeReasoningEffort: 'high',
        defaultCodexReasoningEffort: null,
      }),
    },
    sessionConfigService: { getLaunchOptions: async () => native() },
    configService: {
      getCorsConfig: () => ({
        allowedOrigins: ['http://localhost:3000'],
        trustedLocalCidrs: [],
        trustProxyHeaders: false,
        disableCorsChecks: false,
      }),
    },
  };
}
beforeAll(async () => {
  db = await createIntegrationDatabase();
  ({ agentRouter } = await vi.importActual<typeof import('./agent.trpc')>('./agent.trpc'));
  ({ createContext } = await vi.importActual<typeof import('./trpc')>('./trpc'));
  ({ createAgentManagement } = await vi.importActual<
    typeof import('@/backend/orchestration/agents/agent-management.orchestrator')
  >('@/backend/orchestration/agents/agent-management.orchestrator'));
  ({ createAgentAuthoring } = await vi.importActual<
    typeof import('@/backend/orchestration/agents/agent-authoring.orchestrator')
  >('@/backend/orchestration/agents/agent-authoring.orchestrator'));
  runtime = await vi.importActual<typeof import('@/backend/services/agent-definition')>(
    '@/backend/services/agent-definition'
  );
  workspace = await vi.importActual<typeof import('@/backend/services/workspace')>(
    '@/backend/services/workspace'
  );
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await db.prisma.agentConnection.deleteMany();
  const project = await db.prisma.project.create({
    data: {
      name: 'Factory',
      slug: crypto.randomUUID(),
      repoPath: '/repo',
      worktreeBasePath: '/worktrees',
      githubOwner: 'org',
      githubRepo: 'repo',
    },
  });
  projectId = project.id;
  const connection = await db.prisma.agentConnection.create({
    data: { provider: 'GITHUB', externalId: 'gh:repo-1', name: 'org/repo' },
  });
  connectionId = connection.id;
  repository = vi.fn(async () => ({ id: 'repo-1', name: 'org/repo', labels: ['agent'] }));
  native = vi.fn(async () => ({
    provider: 'CLAUDE',
    model: 'claude-sonnet-4-6',
    reasoning: { options: [{ value: 'high', label: 'High' }], defaultValue: 'high' },
    planMode: { supported: true, selected: false },
  }));
  services = makeServices();
  caller = agentRouter.createCaller({
    appContext: {
      services: {
        ...services,
        agentManagement: createAgentManagement(() => services),
        agentAuthoring: createAgentAuthoring(() => services),
      },
    },
  } as never);
});
function specification() {
  return {
    name: 'Investigator',
    instructions: 'Investigate',
    executionConfig: { version: 1 as const },
    triggers: [
      {
        type: 'GITHUB_ISSUE' as const,
        connectionId,
        description: 'Label',
        filterInstructions: null,
        isEnabled: false as const,
        config: {
          version: 1 as const,
          repositoryIds: ['repo-1'],
          actions: ['labeled' as const],
          labels: ['agent'],
        },
      },
    ],
  };
}
async function save() {
  const row = await db.prisma.workspace.create({ data: { projectId, name: 'Author' } });
  const draft = await services.agentProposalService.propose({
    workspaceId: row.id,
    specification: specification(),
  });
  const accepted = await services.agentProposalService.create({
    workspaceId: row.id,
    proposalId: draft.id,
    revision: 1,
    specification: draft.specification,
  });
  return { projectId, agentId: accepted.agentDefinitionId! };
}
it('offers project-owned discovery and truthful explicit preview without native calls on ordinary reads', async () => {
  const owner = await save();
  const sources = await caller.projectSources({ projectId });
  expect(sources.github).toMatchObject({ connectionId, repository: { id: 'repo-1' } });
  expect(sources).not.toHaveProperty('executionAvailable');
  await caller.get(owner);
  await caller.list({ projectId });
  await caller.runs(owner);
  await caller.evaluations(owner);
  await caller.navigationSummary({ projectId });
  expect(native).not.toHaveBeenCalled();
  expect(await caller.validateDraft({ projectId, specification: specification() })).toMatchObject({
    triggers: [{ capability: { status: 'SUPPORTED' } }],
    execution: {
      status: 'VALIDATED',
      intent: { reasoningEffort: 'high', requestedModel: 'sonnet', model: 'claude-sonnet-4-6' },
    },
  });
  expect(native).toHaveBeenCalledTimes(1);
});
it('rejects project source changes during external validation before any saved write', async () => {
  const owner = await save();
  const original = await caller.get(owner);
  repository.mockImplementationOnce(async () => {
    await db.prisma.project.update({ where: { id: projectId }, data: { githubRepo: 'different' } });
    return { id: 'repo-1', name: 'org/repo', labels: ['agent'] };
  });
  await expect(
    caller.updateSaved({
      ...owner,
      expectedManagementRevision: 1,
      specification: { ...original.specification!, name: 'Must not commit' },
    })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect((await caller.get(owner)).name).toBe('Investigator');
  expect((await caller.get(owner)).managementRevision).toBe(1);
});
it('gates natural-language filters on the provider resolved at validation, including inherited ones', async () => {
  gate.proven = ['CLAUDE'];
  try {
    const owner = await save();
    const original = await caller.get(owner);
    const filtered = {
      ...original.specification!,
      triggers: original.specification!.triggers.map((trigger) => ({
        ...trigger,
        filterInstructions: 'Only billing bugs',
      })),
    };
    const capability = async (specification: typeof filtered) =>
      (await caller.validateDraft({ projectId, specification })).triggers[0]?.capability.reasonCode;
    // The inherited provider resolves to Claude, which is proven.
    expect(await capability(filtered)).toBe('SUPPORTED');
    native.mockResolvedValue({
      provider: 'CODEX',
      model: 'gpt-6-luna',
      reasoning: { options: [{ value: 'high', label: 'High' }], defaultValue: 'high' },
      planMode: { supported: true, selected: false },
    });
    expect(
      await capability({
        ...filtered,
        executionConfig: { version: 1, provider: 'CODEX', model: 'gpt-6-luna' },
      })
    ).toBe('UNSUPPORTED_SEMANTIC_FILTER');
  } finally {
    gate.proven = ['CLAUDE', 'CODEX'];
  }
});
it('keeps unsupported settings saveable while rejecting foreign and archived ownership', async () => {
  const owner = await save();
  const original = await caller.get(owner);
  const filtered = {
    ...original.specification!,
    triggers: original.specification!.triggers.map((trigger) => ({
      ...trigger,
      filterInstructions: 'Semantic intent',
    })),
  };
  // Both providers passed the live classifier gate, so an inherited provider supports filters.
  expect(
    (await caller.validateDraft({ projectId, specification: filtered })).triggers[0]?.capability
      .reasonCode
  ).toBe('SUPPORTED');
  const unsupported = {
    ...filtered,
    triggers: filtered.triggers.map((trigger) =>
      trigger.type === 'GITHUB_ISSUE'
        ? {
            ...trigger,
            config: { ...trigger.config, actions: ['labeled' as const, 'opened' as const] },
          }
        : trigger
    ),
  };
  expect(
    await caller.updateSaved({
      ...owner,
      expectedManagementRevision: 1,
      specification: unsupported,
    })
  ).toMatchObject({ managementRevision: 2 });
  expect(
    (await caller.validateDraft({ projectId, specification: unsupported })).triggers[0]?.capability
      .reasonCode
  ).toBe('UNSUPPORTED_GITHUB_ACTION');
  await expect(caller.get({ ...owner, projectId: 'foreign' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await db.prisma.project.update({ where: { id: projectId }, data: { isArchived: true } });
  expect(await caller.get(owner)).toMatchObject({ managementRevision: 2 });
  await expect(caller.projectSources({ projectId })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
  await expect(
    caller.validateDraft({ projectId, specification: specification() })
  ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
});
it.each([{ origin: 'https://evil.invalid' }, { 'x-forwarded-for': '203.0.113.1' }])(
  'reaches the real HTTP guard before management effects: %j',
  async (headers) => {
    const app = express();
    app.use(
      '/api/trpc',
      createExpressMiddleware({
        router: agentRouter,
        createContext: createContext({
          services: {
            ...services,
            agentManagement: createAgentManagement(() => services),
            agentAuthoring: createAgentAuthoring(() => services),
          },
        } as never),
      })
    );
    const response = await request(app)
      .get('/api/trpc/projectSources')
      .query({ input: JSON.stringify({ json: { projectId } }) })
      .set(headers);
    expect(response.status).toBe(403);
    expect(repository).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  }
);

it('does not certify a source disabled while native validation is pending', async () => {
  native.mockImplementationOnce(async () => {
    await db.prisma.agentConnection.update({
      where: { id: connectionId },
      data: { isEnabled: false },
    });
    return {
      provider: 'CLAUDE',
      model: 'claude-sonnet-4-6',
      reasoning: { options: [] },
      planMode: { supported: false, selected: false },
    };
  });
  const preview = await caller.validateDraft({ projectId, specification: specification() });
  expect(preview.triggers[0]?.capability).toMatchObject({
    status: 'UNAVAILABLE',
    reasonCode: 'SOURCE_UNAVAILABLE',
  });
});

it('reads retained workspace origins through the public owner before linkage and after deletion', async () => {
  const owner = await save();
  const creation = new workspace.WorkspaceCreationService({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });
  const runId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const run = await db.prisma.agentRun.create({
    data: {
      id: runId,
      agentDefinitionId: owner.agentId,
      idempotencyKey: runId,
      status: 'COMPLETED',
      launchPhase: 'FINISHED',
      reservedWorkspaceId: workspaceId,
      reservedSessionId: sessionId,
      definitionSnapshot: {},
      input: {},
      result: { version: 1, summary: 'Retained', pullRequests: [] },
    },
  });
  await creation.createEventWorkspaceOnce({
    type: 'EVENT_AGENT',
    projectId,
    runId,
    reservedWorkspaceId: workspaceId,
    reservedSessionId: sessionId,
    initialMessageId: crypto.randomUUID(),
    name: 'Event',
    execution: {
      version: 1,
      provider: 'CLAUDE',
      model: 'sonnet',
      reasoningEffort: null,
      codexAccountId: null,
      startupModePreset: 'non_interactive',
      accessMode: 'bypassPermissions',
      planModeEnabled: false,
    },
    input: { version: 1, context: [] },
  });
  expect(run.workspaceId).toBeNull();
  expect((await caller.runs(owner)).items[0]?.workspaceState).toBe('LIVE');
  await db.prisma.agentRun.update({ where: { id: runId }, data: { workspaceId } });
  expect((await caller.runs(owner)).items[0]?.workspaceState).toBe('LIVE');
  expect(await caller.workspaceOrigin({ projectId, workspaceId })).toMatchObject({
    origin: { runId, workspaceState: 'LIVE' },
    run: { id: runId },
  });
  const { captureWorkspaceRunResults } = await vi.importActual<
    typeof import('@/backend/orchestration/workspace-lifecycle/workspace-deletion.orchestrator')
  >('@/backend/orchestration/workspace-lifecycle/workspace-deletion.orchestrator');
  workspace.workspaceDataService.configureDeletionCapture(captureWorkspaceRunResults);
  await workspace.workspaceDataService.delete(workspaceId);
  expect(await caller.workspaceOrigin({ projectId, workspaceId })).toMatchObject({
    origin: { runId, workspaceState: 'DELETED' },
    run: { result: { summary: 'Retained' } },
  });
  expect((await caller.runs(owner)).items[0]?.workspaceState).toBe('DELETED');
  await expect(caller.workspaceOrigin({ projectId: 'foreign', workspaceId })).rejects.toMatchObject(
    { code: 'NOT_FOUND' }
  );
  await db.prisma.agentRun.update({
    where: { id: runId },
    data: { reservedWorkspaceId: 'mismatched' },
  });
  await expect(caller.workspaceOrigin({ projectId, workspaceId })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

it.each(['remote', 'origin', 'forwarded'] as const)(
  'rejects %s saved mutation at real HTTP middleware before source/write',
  async (mode) => {
    const owner = await save();
    const before = await caller.get(owner);
    const app = express();
    if (mode === 'remote') {
      app.use((req, _res, next) => {
        Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.1' });
        next();
      });
    }
    app.use(
      '/api/trpc',
      createExpressMiddleware({
        router: agentRouter,
        createContext: createContext({
          services: {
            ...services,
            agentManagement: createAgentManagement(() => services),
            agentAuthoring: createAgentAuthoring(() => services),
          },
        } as never),
      })
    );
    const response = await request(app)
      .post('/api/trpc/updateSaved')
      .send({
        json: {
          ...owner,
          expectedManagementRevision: 1,
          specification: { ...before.specification, name: 'Forbidden mutation' },
        },
      })
      .set(
        mode === 'origin'
          ? { Origin: 'https://evil.invalid' }
          : mode === 'forwarded'
            ? { 'x-forwarded-for': '203.0.113.1' }
            : {}
      );
    expect(response.status).toBe(403);
    expect(repository).not.toHaveBeenCalled();
    expect((await caller.get(owner)).managementRevision).toBe(1);
  }
);

it('rejects a live workspace whose retained origin disagrees with its creation identity', async () => {
  const row = await db.prisma.workspace.create({ data: { projectId, name: 'Ordinary' } });
  expect(await caller.workspaceOrigin({ projectId, workspaceId: row.id })).toBeNull();
  await db.prisma.workspaceLaunchOrigin.create({
    data: { projectId, workspaceId: row.id, runId: 'unrelated-retained-run' },
  });
  await expect(caller.workspaceOrigin({ projectId, workspaceId: row.id })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

it('rejects a history run whose live workspace link disagrees with its reservation', async () => {
  const owner = await save();
  const unrelated = await db.prisma.workspace.create({ data: { projectId, name: 'Unrelated' } });
  await db.prisma.agentRun.create({
    data: {
      agentDefinitionId: owner.agentId,
      idempotencyKey: crypto.randomUUID(),
      reservedWorkspaceId: 'different-reservation',
      workspaceId: unrelated.id,
      definitionSnapshot: {},
      input: {},
    },
  });
  await expect(caller.runs(owner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it.each(['matching', 'absent'] as const)(
  'rejects history with a live FK, %s reservation and no retained origin',
  async (reservation) => {
    const owner = await save();
    const ordinary = await db.prisma.workspace.create({ data: { projectId, name: 'Ordinary' } });
    await db.prisma.agentRun.create({
      data: {
        agentDefinitionId: owner.agentId,
        idempotencyKey: crypto.randomUUID(),
        reservedWorkspaceId: reservation === 'matching' ? ordinary.id : null,
        workspaceId: ordinary.id,
        definitionSnapshot: {},
        input: {},
      },
    });
    expect(await caller.workspaceOrigin({ projectId, workspaceId: ordinary.id })).toBeNull();
    await expect(caller.runs(owner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }
);

it('preserves never-created reservations and genuinely unreserved history', async () => {
  const owner = await save();
  for (const reservedWorkspaceId of [null, 'never-created-reservation']) {
    await db.prisma.agentRun.create({
      data: {
        agentDefinitionId: owner.agentId,
        idempotencyKey: crypto.randomUUID(),
        reservedWorkspaceId,
        definitionSnapshot: {},
        input: {},
      },
    });
  }
  const page = await caller.runs(owner);
  expect(page.items).toHaveLength(2);
  expect(page.items.find((run) => run.reservedWorkspaceId)).toMatchObject({
    workspaceId: null,
    workspaceState: 'RESERVED',
  });
  expect(page.items.find((run) => !run.reservedWorkspaceId)).toMatchObject({
    workspaceId: null,
    workspaceState: 'UNRESERVED',
  });
});

function discoveryGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([
  ['channels', 'disconnect', 'management'],
  ['github', 'disconnect', 'management'],
  ['github', 'credentials', 'management'],
  ['github', 'identity', 'management'],
  ['github', 'unchanged', 'management'],
  ['github', 'disconnect', 'authoring'],
  ['github', 'disconnect', 'list'],
] as const)(
  'rechecks Slack after %s lookup for %s through %s discovery',
  async (phase, change, entrypoint) => {
    const slack = await db.prisma.agentConnection.create({
      data: {
        provider: 'SLACK',
        externalId: 'team-1',
        name: 'Team',
        credentialsEncrypted: 'fake-test-token',
      },
    });
    const reached = discoveryGate();
    const release = discoveryGate();
    const hold = async () => {
      reached.resolve();
      await release.promise;
    };
    const slackRequest = vi.fn(async () => {
      if (phase === 'channels') {
        await hold();
      }
      return Response.json({
        ok: true,
        channels: [{ id: 'C1', name: 'agents', is_member: true, is_archived: false }],
      });
    });
    services.slackConnectionService = new runtime.SlackConnectionService(
      { encrypt: (value) => value, decrypt: (value) => value },
      slackRequest
    );
    repository.mockImplementationOnce(async () => {
      if (phase === 'github') {
        await hold();
      }
      return { id: 'repo-1', name: 'org/repo', labels: ['agent'] };
    });
    const author = await db.prisma.workspace.create({ data: { projectId, name: 'Author' } });
    const pending =
      entrypoint === 'authoring'
        ? caller.sources({ workspaceId: author.id, connectionId: slack.id })
        : caller.projectSources({
            projectId,
            ...(entrypoint === 'list' ? {} : { connectionId: slack.id }),
          });
    const outcome = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    await reached.promise;
    if (change === 'disconnect') {
      await services.slackConnectionService.disconnect(slack.id);
    } else if (change !== 'unchanged') {
      await db.prisma.agentConnection.update({
        where: { id: slack.id },
        data: change === 'credentials' ? { credentialsEncrypted: null } : { externalId: 'team-2' },
      });
    }
    release.resolve();
    const result = await outcome;
    expect(slackRequest).toHaveBeenCalledTimes(entrypoint === 'list' ? 0 : 1);
    if (change === 'unchanged') {
      expect(result).toMatchObject({
        value: {
          slack: {
            connections: [
              { id: slack.id, workspaceId: 'team-1', isEnabled: true, hasCredentials: true },
            ],
            channels: [{ id: 'C1', name: 'agents' }],
          },
        },
      });
    } else if (entrypoint === 'list') {
      expect(result).toMatchObject({ value: { slack: { connections: [] } } });
    } else {
      expect(result).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
  }
);

it.each(['missing', 'disabled', 'unknown', 'application'] as const)(
  'preserves only safe authored GitHub hints for %s discovery failures',
  async (failure) => {
    if (failure === 'missing') {
      await db.prisma.project.update({ where: { id: projectId }, data: { githubRepo: null } });
    } else if (failure === 'disabled') {
      await db.prisma.agentConnection.update({
        where: { id: connectionId },
        data: { isEnabled: false },
      });
    } else {
      const { ApplicationError } = await vi.importActual<
        typeof import('@/backend/lib/application-error')
      >('@/backend/lib/application-error');
      repository.mockRejectedValueOnce(
        failure === 'unknown'
          ? new Error('SECRET_TOKEN gh details')
          : new ApplicationError('PRECONDITION_FAILED', 'SECRET_TOKEN application details')
      );
    }
    const result = await caller.projectSources({ projectId });
    expect(result.github).toEqual({
      error:
        failure === 'missing'
          ? 'Configure the project GitHub repository first.'
          : failure === 'disabled'
            ? 'This GitHub connection is disabled.'
            : 'GitHub source discovery failed. Check repository access and retry.',
    });
    expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
  }
);

it.each(['name', 'githubRepo'] as const)(
  'keeps authoring discovery source checks precise when project %s changes',
  async (field) => {
    const author = await db.prisma.workspace.create({ data: { projectId, name: 'Author' } });
    repository.mockImplementationOnce(async () => {
      await db.prisma.project.update({ where: { id: projectId }, data: { [field]: 'Changed' } });
      return { id: 'repo-1', name: 'org/repo', labels: ['agent'] };
    });
    const result = caller.sources({ workspaceId: author.id });
    if (field === 'name') {
      expect(await result).toMatchObject({ github: { repository: { id: 'repo-1' } } });
    } else {
      await expect(result).rejects.toMatchObject({ code: 'CONFLICT' });
    }
  }
);

it.each(['local', 'remote', 'origin', 'forwarded'] as const)(
  'handles long explicit draft validation through %s POST middleware',
  async (mode) => {
    const owner = await save();
    const app = express();
    if (mode === 'remote') {
      app.use((req, _res, next) => {
        Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.1' });
        next();
      });
    }
    app.use(
      '/api/trpc',
      createExpressMiddleware({
        router: agentRouter,
        createContext: createContext({
          services: { ...services, agentManagement: createAgentManagement(() => services) },
        } as never),
      })
    );
    native.mockResolvedValueOnce({
      provider: 'CODEX',
      model: 'gpt-6-sol',
      reasoning: { options: [{ value: 'low', label: 'Low' }] },
      planMode: { supported: true, selected: false },
    });
    const draft = {
      ...specification(),
      instructions: 'Valid long instructions. '.repeat(1900),
      executionConfig: {
        version: 1,
        provider: 'CODEX',
        model: 'gpt-6-sol',
        reasoningEffort: 'low',
      },
    };
    const response = await request(app)
      .post('/api/trpc/validateDraft')
      .send({ json: { projectId, specification: draft } })
      .set(
        mode === 'origin'
          ? { Origin: 'https://evil.invalid' }
          : mode === 'forwarded'
            ? { 'x-forwarded-for': '203.0.113.1' }
            : {}
      );
    expect(response.status).toBe(mode === 'local' ? 200 : 403);
    expect((await caller.get(owner)).managementRevision).toBe(1);
    if (mode === 'local') {
      expect(response.body.result.data.json.execution).toMatchObject({
        status: 'VALIDATED',
        intent: {
          provider: 'CODEX',
          requestedModel: 'gpt-6-sol',
          model: 'gpt-6-sol',
          reasoningEffort: 'low',
          providerIntent: 'EXPLICIT',
          modelIntent: 'EXPLICIT',
          effortIntent: 'EXPLICIT',
        },
      });
      expect(native).toHaveBeenCalledTimes(1);
    } else {
      expect(native).not.toHaveBeenCalled();
      expect(repository).not.toHaveBeenCalled();
    }
  }
);
