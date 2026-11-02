// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { managedAgentSchema, savedAgentSpecificationSchema } from '@/shared/agent-management';
import { waitForReact } from '@/test-utils/react-act';

let db: IntegrationDatabase;
let root: Root | undefined;
let container: HTMLDivElement;
let queryClient: QueryClient;
let runtime: typeof import('@/backend/services/agent-definition');
let workspace: typeof import('@/backend/services/workspace');
let router: typeof import('@/backend/trpc/agent.trpc');
let orchestration: typeof import('@/backend/orchestration/agent-management.orchestrator');
beforeAll(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  db = await createIntegrationDatabase();
  runtime = await vi.importActual('@/backend/services/agent-definition');
  workspace = await vi.importActual('@/backend/services/workspace');
  router = await vi.importActual('@/backend/trpc/agent.trpc');
  orchestration = await vi.importActual('@/backend/orchestration/agent-management.orchestrator');
  const { captureWorkspaceRunResults } = await vi.importActual<
    typeof import('@/backend/orchestration/workspace-deletion.orchestrator')
  >('@/backend/orchestration/workspace-deletion.orchestrator');
  workspace.workspaceDataService.configureDeletionCapture(captureWorkspaceRunResults);
}, 30_000);
afterAll(async () => {
  if (root) {
    await act(() => root?.unmount());
  }
  queryClient?.clear();
  container?.remove();
  await destroyIntegrationDatabase(db);
  vi.unstubAllGlobals();
});
function button(label: string) {
  const result = [...container.querySelectorAll('button')].find(
    (item) => item.textContent === label
  );
  if (!result) {
    throw new Error(`Missing button: ${label}`);
  }
  return result;
}
it('edits the exact saved set through the mixed page after real proposal removal and workspace deletion', async () => {
  // All external/native capabilities are fake before any discovery or validation can acquire them.
  const native = vi.fn(() => Promise.reject(new Error('No native discovery expected')));
  const sources = vi.fn(async () => ({ id: 'repo-1', name: 'org/repo', labels: ['agent'] }));
  const project = await db.prisma.project.create({
    data: {
      name: 'Owner',
      slug: 'owner',
      repoPath: '/fixture/repo',
      worktreeBasePath: '/fixture/worktrees',
      githubOwner: 'org',
      githubRepo: 'repo',
    },
  });
  const connection = await db.prisma.agentConnection.create({
    data: { provider: 'GITHUB', externalId: 'gh:repo-1', name: 'org/repo' },
  });
  const author = await db.prisma.workspace.create({
    data: { projectId: project.id, name: 'Author' },
  });
  const proposalService = new runtime.AgentProposalService();
  const proposal = await proposalService.propose({
    workspaceId: author.id,
    specification: {
      name: 'Saved after deletion',
      instructions: 'Original instructions',
      executionConfig: { version: 1 },
      triggers: ['first', 'second'].map((id) => ({
        id,
        type: 'GITHUB_ISSUE',
        connectionId: connection.id,
        description: id,
        config: { version: 1, repositoryIds: ['repo-1'], actions: ['labeled'] },
      })),
    },
  });
  const accepted = await proposalService.create({
    workspaceId: author.id,
    proposalId: proposal.id,
    revision: proposal.revision,
    specification: proposal.specification,
  });
  const reduced = await proposalService.update({
    workspaceId: author.id,
    proposalId: proposal.id,
    revision: accepted.revision,
    specification: {
      ...accepted.specification,
      triggers: accepted.specification.triggers.slice(0, 1),
    },
  });
  await workspace.workspaceDataService.delete(author.id);
  expect(await db.prisma.agentProposal.count({ where: { id: proposal.id } })).toBe(0);
  expect(await db.prisma.workspace.count({ where: { id: author.id } })).toBe(0);
  const services = {
    agentManagementService: new runtime.AgentManagementService(),
    agentProposalService: proposalService,
    projectManagementService: workspace.projectManagementService,
    workspaceDataService: workspace.workspaceDataService,
    slackConnectionService: new runtime.SlackConnectionService(
      { encrypt: (value) => value, decrypt: (value) => value },
      () => Promise.reject(new Error('No Slack calls'))
    ),
    githubCLIService: { getAgentRepository: sources },
    sessionConfigService: { getLaunchOptions: native },
    sessionProviderResolverService: {
      resolveDefaultsForWorkspaceCreation: async () => ({
        provider: 'CLAUDE' as const,
        model: 'sonnet',
      }),
    },
    userSettingsQueryService: {
      get: async () => ({ defaultClaudeReasoningEffort: null, defaultCodexReasoningEffort: null }),
    },
  };
  const caller = router.agentRouter.createCaller({
    appContext: {
      services: {
        ...services,
        agentManagement: orchestration.createAgentManagement(() => services),
      },
    },
  } as never);
  const owner = { projectId: project.id, agentId: reduced.agentDefinitionId! };
  const before = managedAgentSchema.parse(await caller.get(owner));
  expect(before.specification?.triggers.map((trigger) => trigger.id)).toEqual([
    `${proposal.id}:first`,
  ]);
  expect(before.retainedTriggers).toEqual([
    expect.objectContaining({ id: `${proposal.id}:second`, isConfigured: false }),
  ]);
  const { trpc } = await vi.importActual<typeof import('@/client/lib/trpc')>('@/client/lib/trpc');
  const { AgentsPage } = await vi.importActual<
    typeof import('@/client/features/agents/agents-page')
  >('@/client/features/agents/agents-page');
  const writes: unknown[] = [];
  const calls: string[] = [];
  const scheduled = {
    id: owner.agentId,
    projectId: project.id,
    name: 'Scheduled control',
    prompt: 'Keep history',
    cadence: 'DAILY',
    scheduledTime: null,
    timezone: null,
    scheduledDayOfMonth: null,
    isEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    nextRunAt: new Date(),
    lastRunAt: null,
    executions: [],
  };
  const scheduledResponses = new Map<string, unknown>([
    ['periodicTask.list', [scheduled]],
    ['periodicTask.get', scheduled],
    ['periodicTask.navigationSummary', { totalCount: 1, failedCount: 0 }],
    [
      'periodicTask.listExecutions',
      [
        {
          id: 'control-run',
          periodicTaskId: owner.agentId,
          workspaceId: null,
          status: 'FAILED',
          startedAt: new Date(),
          completedAt: new Date(),
          errorMessage: 'Scheduled history preserved',
          prUrl: null,
          prNumber: null,
        },
      ],
    ],
  ]);
  const respond = (path: string, input: unknown) => {
    calls.push(path);
    if (path === 'agent.list') {
      return caller.list({ projectId: project.id });
    }
    if (path === 'agent.get') {
      return caller.get(
        z
          .object({
            projectId: z.string(),
            agentId: z.string(),
            retainedCursor: z.string().optional(),
          })
          .parse(input)
      );
    }
    if (path === 'agent.navigationSummary') {
      return caller.navigationSummary({ projectId: project.id });
    }
    if (path === 'agent.updateSaved') {
      writes.push(input);
      return caller.updateSaved(
        z
          .object({
            projectId: z.string(),
            agentId: z.string(),
            expectedManagementRevision: z.number(),
            specification: savedAgentSpecificationSchema,
          })
          .parse(input)
      );
    }
    if (scheduledResponses.has(path)) {
      return scheduledResponses.get(path);
    }
    throw new Error(`Unexpected public call ${path}`);
  };
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            void Promise.resolve()
              .then(() => respond(op.path, op.input))
              .then(
                (data) => {
                  observer.next({ result: { data } });
                  observer.complete();
                },
                (error) => observer.error(TRPCClientError.from(error))
              );
          }),
    ],
  });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const route = createElement(Route, {
    path: '/projects/:slug/agents/:id?',
    element: createElement(AgentsPage, { project }),
  });
  const routes = createElement(
    MemoryRouter,
    { initialEntries: [`/projects/owner/agents/${owner.agentId}?kind=event`] },
    createElement(Routes, null, route)
  );
  const children = createElement(QueryClientProvider, { client: queryClient }, routes);
  await act(() => root?.render(createElement(trpc.Provider, { client, queryClient, children })));

  await waitForReact(() =>
    expect(container.querySelector('h2')?.textContent).toBe('Saved after deletion')
  );
  expect(container.textContent).toContain('Scheduled control');
  expect(calls).not.toContain('periodicTask.get');
  expect(calls).not.toContain('periodicTask.listExecutions');
  expect(sources).not.toHaveBeenCalled();
  expect(native).not.toHaveBeenCalled();
  await act(() => button('Edit Agent').click());
  const instructions = container.querySelector('textarea[aria-label="Instructions"]');
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      instructions,
      'Edited independently of author'
    );
    instructions?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() =>
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  );
  await waitForReact(() => expect(container.querySelector('form')).toBeNull());
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    ...owner,
    expectedManagementRevision: before.managementRevision,
  });
  const after = managedAgentSchema.parse(await caller.get(owner));
  expect(after.managementRevision).toBe(before.managementRevision + 1);
  expect(after.instructions).toBe('Edited independently of author');
  expect(after.executionConfig).toEqual({ version: 1 });
  expect(after.specification?.triggers.map((trigger) => trigger.id)).toEqual([
    `${proposal.id}:first`,
  ]);
  expect(after.retainedTriggers).toEqual([
    expect.objectContaining({
      id: `${proposal.id}:second`,
      isConfigured: false,
      configuration: before.retainedTriggers[0]!.configuration,
      activationState: 'PAUSED',
      triggerRevision: before.retainedTriggers[0]!.triggerRevision + 1,
    }),
  ]);
  expect(after.configuredTriggers[0]).toMatchObject({
    activationState: 'PAUSED',
    isEnabled: false,
  });
  await expect(
    caller.updateSaved({
      ...owner,
      expectedManagementRevision: before.managementRevision,
      specification: after.specification!,
    })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await db.prisma.agentProposal.count({ where: { id: proposal.id } })).toBe(0);
  expect(native).not.toHaveBeenCalled();
  const scheduledLink = container.querySelector<HTMLAnchorElement>(
    `a[href="/projects/owner/agents/${owner.agentId}"]`
  );
  await act(() =>
    scheduledLink?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    )
  );
  await waitForReact(() => expect(container.textContent).toContain('Scheduled history preserved'));
  expect(calls).toContain('periodicTask.listExecutions');
  // Legacy/invalid stored data is inspection-only until an explicit full replacement.
  await db.prisma.agentTrigger.update({
    where: { id: `${proposal.id}:first` },
    data: { isConfigured: null, config: { invalid: true } },
  });
  const eventLink = container.querySelector<HTMLAnchorElement>(
    `a[href="/projects/owner/agents/${owner.agentId}?kind=event"]`
  );
  await act(() =>
    eventLink?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    )
  );
  await act(() => queryClient.invalidateQueries({ queryKey: [['agent', 'get']] }));
  await waitForReact(() => expect(container.textContent).toContain('Exact membership is unknown'));
  await act(() => button('Edit Agent').click());
  expect(container.querySelector('form')).toBeNull();
  await act(() => button('Replace complete specification').click());
  const replacement = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Full saved specification JSON"]'
  );
  expect(replacement?.value).toBe('');
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      replacement,
      JSON.stringify(after.specification)
    );
    replacement?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() =>
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  );
  await waitForReact(() => expect(container.querySelector('form')).toBeNull());
  const repaired = managedAgentSchema.parse(await caller.get(owner));
  expect(repaired.configurationMembership).toBe('KNOWN');
  expect(repaired.managementRevision).toBe(after.managementRevision + 1);
  expect(repaired.configuredTriggers[0]).toMatchObject({
    id: `${proposal.id}:first`,
    isConfigured: true,
    activationState: 'PAUSED',
    isEnabled: false,
    triggerRevision: after.configuredTriggers[0]!.triggerRevision + 1,
    activationGeneration: after.configuredTriggers[0]!.activationGeneration + 1,
  });
}, 30_000);
