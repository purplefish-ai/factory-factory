import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { expect, vi } from 'vitest';
import type { JobDefinition } from '@/backend/services/job-runner.service';
import type { classifyAgentEvent } from '@/backend/services/session';
import type { IntegrationDatabase } from '@/backend/testing/integration-db';
import type { AgentEventPayload } from '@/shared/agent-runtime';
import type { AgentIssueEventPage } from '@/shared/agent-source';
import { configureEventSessionServices } from './event-delivery.test-support';
import { eventProviderCollection } from './event-provider.test-support';

type GithubPayload = Extract<AgentEventPayload, { provider: 'GITHUB' }>;
type FeedRow = AgentIssueEventPage['events'][number];
type Classify = typeof classifyAgentEvent;
const JOBS = {
  poll: 'agent-source-poll',
  evaluate: 'agent-event-evaluation',
  maintain: 'agent-launch-maintenance',
} as const;

/** The modules the flow composes, loaded once per test after its database binds. */
async function importFlowModules() {
  const load = <T>(path: string) => vi.importActual<T>(path);
  return {
    owner: await load<typeof import('@/backend/services/agent-definition')>(
      '@/backend/services/agent-definition'
    ),
    workspace: await load<typeof import('@/backend/services/workspace')>(
      '@/backend/services/workspace'
    ),
    session: await load<typeof import('@/backend/services/session')>('@/backend/services/session'),
    github: await load<typeof import('@/backend/services/github')>('@/backend/services/github'),
    jobs: await load<typeof import('@/backend/services/job-runner.service')>(
      '@/backend/services/job-runner.service'
    ),
    config: await load<typeof import('@/backend/services/config.service')>(
      '@/backend/services/config.service'
    ),
    admission: await load<typeof import('@/backend/services/application-update-admission.service')>(
      '@/backend/services/application-update-admission.service'
    ),
    router: await load<typeof import('@/backend/trpc/agent.trpc')>('@/backend/trpc/agent.trpc'),
    management: await load<
      typeof import('@/backend/orchestration/agents/agent-management.orchestrator')
    >('@/backend/orchestration/agents/agent-management.orchestrator'),
    runtime: await load<typeof import('@/backend/orchestration/agents/agent-runtime.orchestrator')>(
      '@/backend/orchestration/agents/agent-runtime.orchestrator'
    ),
    deletion: await load<
      typeof import('@/backend/orchestration/workspace-lifecycle/workspace-deletion.orchestrator')
    >('@/backend/orchestration/workspace-lifecycle/workspace-deletion.orchestrator'),
  };
}

/** A GitHub issue-events feed row as the `gh` parser returns it. */
export function githubEvent(
  providerEventId: string,
  options: {
    action?: 'labeled' | 'reopened';
    number?: number;
    label?: string;
    labels?: string[];
    title?: string;
    body?: string;
  } = {}
): FeedRow {
  const action = options.action ?? 'labeled';
  const number = options.number ?? 7;
  const label = options.label ?? 'agent';
  const now = new Date().toISOString();
  const payload: GithubPayload = {
    version: 1,
    provider: 'GITHUB',
    repositoryId: 'repo-1',
    repositoryFullName: 'org/repo',
    action,
    actorId: 'human',
    creatorId: 'human',
    occurredAt: now,
    observedAt: now,
    sourceUrl: `https://github.com/org/repo/issues/${number}`,
    issue: {
      number,
      title: options.title ?? `Issue ${number}`,
      body: options.body ?? `Body of issue ${number}`,
      addedLabel: action === 'labeled' ? label : null,
      labels: options.labels ?? [label],
    },
  };
  return { providerEventId, payload };
}

/** A non-executable feed row: GitHub's other issue events only advance the cursor. */
export const githubControl = (providerEventId: string): FeedRow => ({
  providerEventId,
  payload: null,
});

/**
 * The event runtime composed as `app-context.ts` composes it, driven by stepping
 * its registered jobs instead of their timers. GitHub, the classifier, native
 * launch options, Git and the provider transport are fakes; procedures,
 * activation, intake, evaluation, admission, launch, delivery, settlement and
 * history are real. Suites replace the ACP client factory themselves (service
 * internals are importable only from test files) and add each fake provider to
 * `providers`.
 */
export async function createRuntimeFlow(db: IntegrationDatabase) {
  const m = await importFlowModules();
  const jobs = new Map<string, JobDefinition['run']>();
  const register = m.jobs.jobRunner.register.bind(m.jobs.jobRunner);
  vi.spyOn(m.jobs.jobRunner, 'register').mockImplementation((definition) => {
    jobs.set(definition.name, definition.run);
    register(definition);
  });
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('Host process signalling forbidden');
  });
  const providers = eventProviderCollection();
  vi.spyOn(m.workspace.gitOpsService, 'prepareWorktreeCreation').mockImplementation(
    async (project, name) => ({
      worktreePath: join(project.worktreeBasePath, name),
      canonicalBasePath: project.worktreeBasePath,
    })
  );
  vi.spyOn(m.workspace.gitOpsService, 'ensureBaseBranchExists').mockResolvedValue();
  vi.spyOn(m.workspace.gitOpsService, 'createWorktree').mockImplementation(
    async (project, name) => {
      const worktreePath = join(project.worktreeBasePath, name);
      await mkdir(worktreePath, { recursive: true });
      return { worktreePath, branchName: `branch-${name}` };
    }
  );
  vi.spyOn(m.github.githubCLIService, 'getAuthenticatedUsername').mockResolvedValue('fixture');
  m.workspace.workspaceDataService.configureDeletionCapture(m.deletion.captureWorkspaceRunResults);
  configureEventSessionServices(m.workspace, m.session);

  const project = await db.prisma.project.create({
    data: {
      name: 'Factory',
      slug: crypto.randomUUID(),
      repoPath: db.tempDir,
      worktreeBasePath: db.tempDir,
      githubOwner: 'org',
      githubRepo: 'repo',
    },
  });
  // A source no automation has read yet. Its first Enable initializes it from the
  // current head; a hand-built cursor would lack the proof later baselines check.
  const connection = await db.prisma.agentConnection.create({
    data: {
      provider: 'GITHUB',
      externalId: 'gh:repo-1',
      name: 'org/repo',
      sourceState: { create: { isReady: true } },
    },
  });
  /** Newest first, as GitHub returns it. */
  const feed: FeedRow[] = [githubControl('head')];
  /** Source paging the runtime reads per poll; tests lower it to leave an interval open. */
  const limits = { githubPagesPerCycle: 10 };
  const classify = vi.fn<Classify>(() =>
    Promise.reject(new Error('No classifier decision was arranged'))
  );
  const services = {
    githubCLIService: {
      getAgentRepository: async () => ({ id: 'repo-1', name: 'org/repo', labels: ['agent'] }),
      getAgentRepositoryIdentity: async () => ({ id: 'repo-1', name: 'org/repo' }),
      listAgentIssueEvents: async (input: { page: number }) => ({
        events: feed.slice((input.page - 1) * 100, input.page * 100),
        nextPage: input.page * 100 < feed.length ? input.page + 1 : null,
      }),
    },
    slackConnectionService: new m.owner.SlackConnectionService(
      { encrypt: (value) => value, decrypt: (value) => value },
      () => Promise.reject(new Error('Unexpected Slack call'))
    ),
    configService: {
      getAgentRuntimeLimits: () => ({
        ...m.config.configService.getAgentRuntimeLimits(),
        ...limits,
      }),
    },
    classifyAgentEvent: classify,
    sessionProviderResolverService: {
      resolveDefaultsForWorkspaceCreation: async (
        provider?: 'CLAUDE' | 'CODEX',
        model?: string
      ) => ({ provider: provider ?? 'CLAUDE', model: model ?? 'sonnet' }),
    },
    userSettingsQueryService: {
      get: async () => ({ defaultClaudeReasoningEffort: null, defaultCodexReasoningEffort: null }),
    },
    sessionConfigService: {
      getLaunchOptions: async () => ({
        provider: 'CLAUDE' as const,
        model: 'sonnet',
        reasoning: { options: [{ value: 'high', label: 'High' }], defaultValue: 'high' },
        planMode: { supported: true, selected: false },
      }),
    },
    agentManagementService: new m.owner.AgentManagementService(),
    agentProposalService: new m.owner.AgentProposalService(),
    projectManagementService: m.workspace.projectManagementService,
    workspaceDataService: m.workspace.workspaceDataService,
  };
  type Runtime = ReturnType<typeof m.runtime.createAgentRuntime>;
  const runtimes: Runtime[] = [];
  type Composed = typeof services & {
    readonly agentRuntime: Runtime;
    agentManagement: ReturnType<typeof m.management.createAgentManagement>;
  };
  const composed: Composed = {
    ...services,
    // The procedures use the newest runtime, as after a server restart.
    get agentRuntime() {
      const current = runtimes.at(-1);
      if (!current) {
        throw new Error('No runtime was composed');
      }
      return current;
    },
    agentManagement: m.management.createAgentManagement(() => composed),
  };
  /** A fresh runtime, composed as a restarted server composes it. */
  const boot = () => {
    const runtime = m.runtime.createAgentRuntime(() => composed);
    runtimes.push(runtime);
    return runtime;
  };
  boot();
  const caller = m.router.agentRouter.createCaller({
    appContext: { services: composed },
  } as never);
  const step = async (name: keyof typeof JOBS) => {
    const run = jobs.get(JOBS[name]);
    if (!run) {
      throw new Error(`Job ${JOBS[name]} is not registered`);
    }
    await run(new AbortController().signal);
  };

  async function save(triggers: ReturnType<typeof trigger>[], instructions = 'Investigate') {
    const author = await db.prisma.workspace.create({
      data: { projectId: project.id, name: 'Author' },
    });
    const draft = await services.agentProposalService.propose({
      workspaceId: author.id,
      specification: {
        name: 'Investigator',
        instructions,
        executionConfig: { version: 1 },
        triggers,
      },
    });
    const accepted = await services.agentProposalService.create({
      workspaceId: author.id,
      proposalId: draft.id,
      revision: 1,
      specification: draft.specification,
    });
    // The authoring workspace is not part of any run.
    await db.prisma.workspace.delete({ where: { id: author.id } });
    if (!accepted.agentDefinitionId) {
      throw new Error('Creating the automation returned no definition');
    }
    return { projectId: project.id, agentId: accepted.agentDefinitionId };
  }
  function trigger(
    options: {
      actions?: Array<'labeled' | 'reopened' | 'opened'>;
      labels?: string[];
      filterInstructions?: string | null;
    } = {}
  ) {
    const actions = options.actions ?? ['labeled'];
    return {
      type: 'GITHUB_ISSUE' as const,
      connectionId: connection.id,
      description: actions.join(' '),
      filterInstructions: options.filterInstructions ?? null,
      isEnabled: false as const,
      config: {
        version: 1 as const,
        repositoryIds: ['repo-1'],
        actions,
        labels: options.labels ?? ['agent'],
      },
    };
  }
  /** Enable through the procedure and poll once, so the baseline resolves to ACTIVE. */
  async function enable(owner: { projectId: string; agentId: string }) {
    const current = await caller.get(owner);
    const enabled = await caller.enable({
      ...owner,
      expectedManagementRevision: current.managementRevision,
    });
    await step('poll');
    return enabled;
  }
  /** Event arrivals and their poll; the feed lists newest first. */
  async function arrive(...rows: FeedRow[]) {
    feed.unshift(...[...rows].reverse());
    await step('poll');
  }
  /** One evaluation job pass per expected claim: evaluate, admit, claim and hand off. */
  async function evaluate(passes = 1) {
    for (let pass = 0; pass < passes; pass++) {
      await step('evaluate');
    }
  }
  const delivery = (runId: string) =>
    db.prisma.agentInitialDelivery.findUniqueOrThrow({ where: { runId } });
  /** The background launch has persisted its initial outcome. */
  async function delivered(runId: string, state = 'FINISHED') {
    await vi.waitFor(async () => expect((await delivery(runId)).state).toBe(state), {
      timeout: 5000,
    });
  }
  async function counts() {
    return {
      events: await db.prisma.agentEvent.count(),
      evaluations: await db.prisma.agentEvaluation.count(),
      runs: await db.prisma.agentRun.count(),
      workspaces: await db.prisma.workspace.count(),
      sessions: await db.prisma.agentSession.count(),
      prompts: providers.providers.reduce(
        (sum, provider) => sum + provider.connection.prompt.mock.calls.length,
        0
      ),
    };
  }
  const promptText = (provider: (typeof providers.providers)[number]) => {
    const [input] = provider.connection.prompt.mock.calls[0] ?? [];
    const [part] = input?.prompt ?? [];
    return part?.type === 'text' ? part.text : null;
  };
  /** Resolve a provider's first turn the way the ACP adapter reports a finished turn. */
  async function finishTurn(index: number) {
    await providers.waitForProviders(index + 1);
    const provider = providers.providers[index];
    if (!provider) {
      throw new Error(`Provider ${index} was not created`);
    }
    await provider.called;
    provider.response.resolve({ stopReason: 'end_turn' });
    return provider;
  }
  /** Releases held fixture work and stops every runtime the test composed. */
  async function teardown() {
    for (const provider of providers.providers) {
      provider.response.resolve({ stopReason: 'end_turn' });
    }
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
    await m.session.acpRuntimeManager.stopAllClients(10).catch(() => undefined);
    // Let the controlled children's exit callbacks finish while SQLite is still open.
    await nextTurn();
    m.session.sessionPromptTurnCompletionService.clearAll();
    m.session.sessionDomainService.clearAllSessions();
    expect(process.kill).not.toHaveBeenCalled();
  }
  return {
    ...m,
    db,
    project,
    connection,
    feed,
    limits,
    classify,
    providers,
    caller,
    boot,
    step,
    save,
    trigger,
    enable,
    arrive,
    evaluate,
    delivery,
    delivered,
    counts,
    promptText,
    finishTurn,
    teardown,
  };
}
export type RuntimeFlow = Awaited<ReturnType<typeof createRuntimeFlow>>;
