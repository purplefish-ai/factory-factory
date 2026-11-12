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
let owner: { projectId: string; agentId: string };
let runIds: string[];
let evaluationIds: string[];

beforeAll(async () => {
  db = await createIntegrationDatabase();
  ({ agentRouter } = await vi.importActual<typeof import('./agent.trpc')>('./agent.trpc'));
  const runtime = await vi.importActual<typeof import('@/backend/services/agent-definition')>(
    '@/backend/services/agent-definition'
  );
  service = new runtime.AgentManagementService();
  const project = await db.prisma.project.create({
    data: { name: 'Agents', slug: 'agents', repoPath: '/repo', worktreeBasePath: '/worktrees' },
  });
  const definition = await db.prisma.agentDefinition.create({
    data: { projectId: project.id, name: 'Investigator', instructions: 'Investigate' },
  });
  owner = { projectId: project.id, agentId: definition.id };
  const connection = await db.prisma.agentConnection.create({
    data: { provider: 'GITHUB', externalId: 'gh:repo-1', name: 'Repo' },
  });
  const trigger = await db.prisma.agentTrigger.create({
    data: {
      agentDefinitionId: definition.id,
      connectionId: connection.id,
      type: 'GITHUB_ISSUE',
      description: 'Agent labels',
      config: { version: 1, repositoryIds: ['repo-1'], actions: ['labeled'] },
      isConfigured: true,
    },
  });
  const expires = new Date('2099-01-01T00:00:00.000Z');
  runIds = [];
  evaluationIds = [];
  // Oldest first; history pages are newest first.
  for (const [index, name] of ['older', 'newer'].entries()) {
    const createdAt = new Date(Date.UTC(2026, 0, index + 1));
    const event = await db.prisma.agentEvent.create({
      data: {
        connectionId: connection.id,
        providerEventId: name,
        occurredAt: createdAt,
        observedAt: createdAt,
        payloadExpiresAt: expires,
        identityExpiresAt: expires,
      },
    });
    const evaluation = await db.prisma.agentEvaluation.create({
      data: {
        eventId: event.id,
        connectionId: connection.id,
        agentDefinitionId: definition.id,
        triggerId: trigger.id,
        definitionRevision: 1,
        triggerRevision: 1,
        activationGeneration: 1,
        status: 'SKIPPED',
        reasonCode: 'LABEL_MISMATCH',
        explanation: 'The added label does not match.',
        configurationSnapshot: {},
        expiresAt: expires,
        createdAt,
      },
    });
    const run = await db.prisma.agentRun.create({
      data: {
        agentDefinitionId: definition.id,
        triggerId: trigger.id,
        idempotencyKey: name,
        status: 'CANCELLED',
        definitionSnapshot: {},
        input: {},
        createdAt,
      },
    });
    evaluationIds.unshift(evaluation.id);
    runIds.unshift(run.id);
  }
}, 30_000);

afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

function context() {
  return {
    appContext: {
      services: {
        agentManagementService: service,
        // The orchestrator adds workspace origins; none of these runs has a workspace.
        agentManagement: { runs: (input: unknown) => service.runs(input) },
      },
    },
  } as never;
}

type Pages = { data?: { pages: Array<{ items: Array<{ id: string }> }> } };
/** The structural part of an InfiniteQueryObserver this test drives. */
interface PageObserver {
  refetch(options: { throwOnError: true }): Promise<Pages>;
  fetchNextPage(options: { throwOnError: true }): Promise<Pages & { hasNextPage: boolean }>;
  getCurrentResult(): { hasNextPage: boolean };
}

function queryUtils(queryClient: QueryClient) {
  const client = createTRPCClient<typeof agentRouter>({
    links: [
      unstable_localLink({
        router: agentRouter,
        createContext: async () => context(),
        transformer: superjson,
      }),
    ],
  });
  return createTRPCQueryUtils({ client, queryClient });
}

async function expectTwoPages(observer: PageObserver, expected: string[]) {
  const first = await observer.refetch({ throwOnError: true });
  expect(first.data?.pages[0]?.items.map((item) => item.id)).toEqual([expected[0]]);
  expect(observer.getCurrentResult().hasNextPage).toBe(true);

  const next = await observer.fetchNextPage({ throwOnError: true });
  expect(next.data?.pages.map((page) => page.items.map((item) => item.id))).toEqual([
    [expected[0]],
    [expected[1]],
  ]);
  expect(next.hasNextPage).toBe(false);
}

const nextPage = { getNextPageParam: (page: { nextCursor: string | null }) => page.nextCursor };

it('loads the first and next runs pages through tRPC infinite queries', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const options = queryUtils(queryClient).runs.infiniteQueryOptions(
      { ...owner, limit: 1 },
      nextPage
    );
    await expectTwoPages(new InfiniteQueryObserver(queryClient, options), runIds);
  } finally {
    queryClient.clear();
  }
});

it('loads the first and next evaluations pages through tRPC infinite queries', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const options = queryUtils(queryClient).evaluations.infiniteQueryOptions(
      { ...owner, limit: 1 },
      nextPage
    );
    await expectTwoPages(new InfiniteQueryObserver(queryClient, options), evaluationIds);
  } finally {
    queryClient.clear();
  }
});

it.each(['runs', 'evaluations'] as const)(
  'keeps ordinary %s calls compatible and rejects unrelated input fields',
  async (procedure) => {
    const caller = agentRouter.createCaller(context());
    expect((await caller[procedure](owner)).items).toHaveLength(2);
    const unexpected = { ...owner, unexpected: true };
    await expect(caller[procedure](unexpected)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // Only forward pages exist; the input type already refuses any other direction.
    const backward = { ...owner, direction: 'backward' } as never;
    await expect(caller[procedure](backward)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  }
);
