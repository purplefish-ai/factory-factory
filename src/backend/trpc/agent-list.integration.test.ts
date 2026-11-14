import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { createTRPCClient, unstable_localLink } from '@trpc/client';
import { createTRPCQueryUtils } from '@trpc/react-query';
import superjson from 'superjson';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let agentRouter: typeof import('./agent.trpc').agentRouter;
let service: InstanceType<
  typeof import('@/backend/services/agent-definition').AgentManagementService
>;
let projectId: string;

beforeAll(async () => {
  db = await createIntegrationDatabase();
  ({ agentRouter } = await vi.importActual<typeof import('./agent.trpc')>('./agent.trpc'));
  const { AgentManagementService } = await vi.importActual<
    typeof import('@/backend/services/agent-definition')
  >('@/backend/services/agent-definition');
  service = new AgentManagementService();
  const project = await db.prisma.project.create({
    data: { name: 'Agents', slug: 'agents', repoPath: '/repo', worktreeBasePath: '/worktrees' },
  });
  projectId = project.id;
  const foreign = await db.prisma.project.create({
    data: { name: 'Other', slug: 'other', repoPath: '/other', worktreeBasePath: '/other-trees' },
  });
  await db.prisma.agentDefinition.createMany({
    data: [
      {
        id: 'older',
        projectId,
        name: 'Older event agent',
        instructions: 'Investigate',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 'newer',
        projectId,
        name: 'Newer event agent',
        instructions: 'Investigate',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      },
      {
        id: 'foreign',
        projectId: foreign.id,
        name: 'Foreign event agent',
        instructions: 'Investigate',
        createdAt: new Date('2026-01-03T00:00:00Z'),
      },
    ],
  });
}, 30_000);

afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

function context() {
  return { appContext: { services: { agentManagementService: service } } } as never;
}

it('loads the first and next event-agent pages through tRPC infinite queries', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = createTRPCClient<typeof agentRouter>({
    links: [
      unstable_localLink({
        router: agentRouter,
        createContext: async () => context(),
        transformer: superjson,
      }),
    ],
  });
  const utils = createTRPCQueryUtils({ client, queryClient });
  const observer = new InfiniteQueryObserver(
    queryClient,
    utils.list.infiniteQueryOptions(
      { projectId, limit: 1 },
      { getNextPageParam: (page) => page.nextCursor ?? undefined }
    )
  );
  try {
    const first = await observer.refetch({ throwOnError: true });
    expect(first.data?.pages[0]?.items.map((agent) => agent.id)).toEqual(['newer']);
    expect(observer.getCurrentResult().hasNextPage).toBe(true);

    const next = await observer.fetchNextPage({ throwOnError: true });
    expect(next.data?.pages.map((page) => page.items.map((agent) => agent.id))).toEqual([
      ['newer'],
      ['older'],
    ]);
    expect(next.hasNextPage).toBe(false);
  } finally {
    queryClient.clear();
  }
});

it('keeps ordinary list calls compatible and rejects unrelated input fields', async () => {
  const caller = agentRouter.createCaller(context());
  expect((await caller.list({ projectId })).items.map((agent) => agent.id)).toEqual([
    'newer',
    'older',
  ]);
  const input = { projectId, unexpected: true };
  await expect(caller.list(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await expect(caller.list({ projectId, limit: 101 })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
});

it('summarizes each automation by its configured triggers states as the backend writes them', async () => {
  const connection = await db.prisma.agentConnection.create({
    data: { provider: 'GITHUB', externalId: 'gh:list-repo', name: 'Repo' },
  });
  const trigger = (
    id: string,
    agentDefinitionId: string,
    state: { activationState: 'ACTIVE' | 'STARTING' | 'PAUSED'; isEnabled: boolean },
    isConfigured = true
  ) => ({
    id,
    agentDefinitionId,
    connectionId: connection.id,
    type: 'GITHUB_ISSUE' as const,
    description: id,
    config: { version: 1, repositoryIds: ['list-repo'], actions: ['labeled'] },
    isConfigured,
    ...state,
  });
  // Only activation stores isEnabled: true, together with ACTIVE; STARTING and PAUSED store false.
  await db.prisma.agentTrigger.createMany({
    data: [
      trigger('newer-listening', 'newer', { activationState: 'ACTIVE', isEnabled: true }),
      trigger('newer-starting', 'newer', { activationState: 'STARTING', isEnabled: false }),
      trigger('newer-paused', 'newer', { activationState: 'PAUSED', isEnabled: false }),
      // A removed trigger is history, not configuration.
      trigger('newer-removed', 'newer', { activationState: 'ACTIVE', isEnabled: true }, false),
      trigger('older-starting', 'older', { activationState: 'STARTING', isEnabled: false }),
      trigger('older-paused', 'older', { activationState: 'PAUSED', isEnabled: false }),
      trigger('foreign-listening', 'foreign', { activationState: 'ACTIVE', isEnabled: true }),
    ],
  });
  try {
    const caller = agentRouter.createCaller(context());
    const page = await caller.list({ projectId });
    expect(page.items.map(({ id, triggerStates }) => ({ id, triggerStates }))).toEqual([
      { id: 'newer', triggerStates: { listening: 1, starting: 1, paused: 1 } },
      { id: 'older', triggerStates: { listening: 0, starting: 1, paused: 1 } },
    ]);
    // A shorter page summarizes only its own automations.
    const first = await caller.list({ projectId, limit: 1 });
    expect(first.items.map(({ id, triggerStates }) => ({ id, triggerStates }))).toEqual([
      { id: 'newer', triggerStates: { listening: 1, starting: 1, paused: 1 } },
    ]);
  } finally {
    await db.prisma.agentTrigger.deleteMany({ where: { connectionId: connection.id } });
    await db.prisma.agentConnection.delete({ where: { id: connection.id } });
  }
});
