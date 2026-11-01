import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { newScan } from '@/backend/services/agent-definition/resources/agent-source-scan';
import { createLedgerFixture } from '@/backend/services/agent-definition/resources/testing/agent-ledger.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { AgentGitHubSourcePort, AgentIssueEventPage } from '@/shared/agent-source';

let db: IntegrationDatabase;
let runtime: typeof import('../index');
let accessor: typeof import('../resources/agent-source.accessor').agentSourceAccessor;
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
let feed: AgentIssueEventPage['events'];
let calls: number[];
let port: AgentGitHubSourcePort;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual<typeof import('../index')>('../index');
  accessor = (
    await vi.importActual<typeof import('../resources/agent-source.accessor')>(
      '../resources/agent-source.accessor'
    )
  ).agentSourceAccessor;
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
  await db.prisma.agentSourceState.deleteMany();
  feed = [{ providerEventId: 'B', payload: null }];
  calls = [];
  port = {
    getRepositoryIdentity: () => Promise.resolve({ id: 'repo-1', name: 'org/repo' }),
    listIssueEvents: (input) => {
      calls.push(input.page);
      return Promise.resolve({
        events: feed.slice((input.page - 1) * 100, input.page * 100),
        nextPage: input.page * 100 < feed.length ? input.page + 1 : null,
      });
    },
    classifyError: () => 'rate_limit',
  };
  await service().prepareBaseline(fixture.connectionId, new AbortController().signal);
});
function service() {
  return new runtime.AgentSourcePollService(port, () => 10);
}
function cycle() {
  return service().pollCycle(new AbortController().signal);
}
function state() {
  return db.prisma.agentSourceState.findUniqueOrThrow({
    where: { connectionId: fixture.connectionId },
  });
}
const label = (id: string) => ({ providerEventId: id, payload: fixture.github(id).payload });

it('preserves the original recovery fence when preparation fails at the provider', async () => {
  await accessor.setFailure(fixture.connectionId, 'ORIGINAL_CONTINUITY_FAILURE', true);
  const before = await state();
  port.listIssueEvents = () => Promise.reject(new Error('provider unavailable'));
  await expect(
    service().prepareBaseline(fixture.connectionId, new AbortController().signal)
  ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(await state()).toEqual(before);
  await accessor.setFailure(fixture.connectionId, 'LATER_CONTINUITY_FAILURE', true);
  expect(await state()).toEqual(before);
});

it('refuses a successful page that arrives after recovery was recorded', async () => {
  let entered!: () => void;
  let release!: (page: AgentIssueEventPage) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  port.listIssueEvents = () =>
    new Promise<AgentIssueEventPage>((resolve) => {
      release = resolve;
      entered();
    });
  const polling = cycle();
  await started;
  await accessor.setFailure(fixture.connectionId, 'ORIGINAL_CONTINUITY_FAILURE', true);
  const before = await state();
  release({ events: [label('late'), ...feed], nextPage: null });
  await polling;
  expect(await state()).toEqual(before);
  expect(await db.prisma.agentEvent.count()).toBe(0);
  expect(await db.prisma.agentSourcePage.count()).toBe(0);
});

it('refuses finalization, resumption and baseline writes behind a recovery fence', async () => {
  const page = { events: [label('head'), ...feed], nextPage: null };
  await accessor.savePage(fixture.connectionId, 1, page);
  await accessor.savePage(fixture.connectionId, 1, page);
  await accessor.setFailure(fixture.connectionId, 'ORIGINAL_CONTINUITY_FAILURE', true);
  const before = await state();
  await expect(accessor.finalizeNextChunk(fixture.connectionId)).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  await expect(accessor.resume(fixture.connectionId)).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(accessor.prepareBaseline(fixture.connectionId, 'head')).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  expect(await state()).toEqual(before);
  expect(await db.prisma.agentEvent.count({ where: { sourceOrder: { not: null } } })).toBe(0);
});

it.each([250, 1250])(
  'resumes VERIFY after %s head insertions within the shared ten-page budget',
  async (prefixLength) => {
    feed = [
      ...Array.from({ length: 701 }, (_, i) => ({ providerEventId: `old-${i}`, payload: null })),
      ...feed,
    ];
    calls = [];
    await cycle();
    expect(calls).toHaveLength(10);
    expect(await state()).toMatchObject({
      cursor: {
        committedHeadEventId: 'B',
        scan: { phase: 'VERIFY', nextPage: 3, verifiedCount: 200 },
      },
    });
    feed = [
      ...Array.from({ length: prefixLength }, (_, i) => ({
        providerEventId: `new-${i}`,
        payload: null,
      })),
      ...feed,
    ];
    for (let i = 0; i < 5; i++) {
      calls = [];
      await cycle();
      expect(calls.length).toBeLessThanOrEqual(10);
      const current = await state();
      expect(current.health).not.toMatchObject({ state: 'RECOVERY_REQUIRED' });
      if (JSON.stringify(current.cursor).includes('"scan":null')) {
        break;
      }
    }
    expect(await state()).toMatchObject({ cursor: { committedHeadEventId: 'old-0', scan: null } });
    for (let i = 0; i < 5; i++) {
      calls = [];
      await cycle();
      expect(calls.length).toBeLessThanOrEqual(10);
      if (JSON.stringify((await state()).cursor).includes('"scan":null')) {
        break;
      }
    }
    expect(await state()).toMatchObject({ cursor: { committedHeadEventId: 'new-0', scan: null } });
  }
);

it('still rejects an inserted middle item after verification overlap is rewound', async () => {
  feed = [
    ...Array.from({ length: 701 }, (_, i) => ({ providerEventId: `old-${i}`, payload: null })),
    ...feed,
  ];
  await cycle();
  feed.splice(100, 0, { providerEventId: 'unknown-middle', payload: null });
  await cycle();
  expect(await state()).toMatchObject({
    health: { state: 'RECOVERY_REQUIRED' },
    cursor: { committedHeadEventId: 'B' },
    lastSourceOrder: 0,
  });
});

it('ignores incomplete paths in a shared source but keeps an all-incomplete source unavailable', async () => {
  const project = await db.prisma.project.create({
    data: {
      name: 'Incomplete',
      slug: 'incomplete',
      repoPath: '/incomplete',
      worktreeBasePath: '/incomplete-wt',
    },
  });
  await db.prisma.agentDefinition.create({
    data: {
      name: 'Incomplete agent',
      instructions: 'Inspect',
      isEnabled: true,
      projectId: project.id,
      triggers: {
        create: {
          type: 'GITHUB_ISSUE',
          connectionId: fixture.connectionId,
          description: 'Shared',
          config: { version: 1, repositoryIds: ['repo-1'], actions: ['labeled'] },
          isEnabled: true,
          activationState: 'ACTIVE',
        },
      },
    },
  });
  const queried: string[] = [];
  port.getRepositoryIdentity = (repository) => {
    queried.push(repository);
    return repository
      ? Promise.resolve({ id: 'repo-1', name: repository })
      : Promise.reject(new Error('Empty path'));
  };
  feed.unshift(label('head'));
  await cycle();
  expect(queried).toEqual(['org/repo']);
  expect(await state()).toMatchObject({ isReady: true, lastSourceOrder: 1 });
  await db.prisma.project.updateMany({ data: { githubOwner: null } });
  queried.length = 0;
  calls = [];
  await cycle();
  expect(queried).toEqual([]);
  expect(calls).toEqual([]);
  expect(await state()).toMatchObject({ isReady: false, health: { state: 'ERROR' } });
});

it.each([null, 0, 2_147_483_647])(
  'accepts source-order evidence at valid nullable boundary %s',
  async (order) => {
    const id = crypto.randomUUID();
    await expect(
      db.prisma
        .$executeRaw`INSERT INTO "AgentSourceBaseline" ("id", "connectionId", "sourceOrder") VALUES (${id}, ${fixture.connectionId}, ${order})`
    ).resolves.toBe(1);
    await expect(
      db.prisma
        .$executeRaw`INSERT INTO "AgentSourcePage" ("id", "connectionId", "scanId", "ordinal", "phase", "requestPage", "evidence", "sourceOrder") VALUES (${id}, ${fixture.connectionId}, ${id}, 0, 'FINALIZED', 1, '{}', ${order})`
    ).resolves.toBe(1);
  }
);
it.each([-1, 2_147_483_648])('rejects out-of-range source-order evidence %s', async (order) => {
  const id = crypto.randomUUID();
  await expect(
    db.prisma
      .$executeRaw`INSERT INTO "AgentSourceBaseline" ("id", "connectionId", "sourceOrder") VALUES (${id}, ${fixture.connectionId}, ${order})`
  ).rejects.toThrow();
  await expect(
    db.prisma
      .$executeRaw`INSERT INTO "AgentSourcePage" ("id", "connectionId", "scanId", "ordinal", "phase", "requestPage", "evidence", "sourceOrder") VALUES (${id}, ${fixture.connectionId}, ${id}, 0, 'FINALIZED', 1, '{}', ${order})`
  ).rejects.toThrow();
});

it('uses the application graph GitHub reads and page limit lazily', async () => {
  feed = [
    ...Array.from({ length: 201 }, (_, i) => ({ providerEventId: `old-${i}`, payload: null })),
    ...feed,
  ];
  const { createAgentRuntime } = await vi.importActual<
    typeof import('@/backend/orchestration/agent-runtime.orchestrator')
  >('@/backend/orchestration/agent-runtime.orchestrator');
  const { jobRunner } = await vi.importActual<
    typeof import('@/backend/services/job-runner.service')
  >('@/backend/services/job-runner.service');
  const graph = {
    githubCLIService: {
      getAgentRepositoryIdentity: (
        _repository: string,
        _signal?: AbortSignal
      ): Promise<{ id: string; name: string }> =>
        Promise.reject(new Error('Original graph service must not be captured')),
      listAgentIssueEvents: port.listIssueEvents,
    },
    configService: { getAgentRuntimeLimits: () => ({ githubPagesPerCycle: 5 }) },
  };
  const runtime = createAgentRuntime(() => graph);
  const identities: string[] = [];
  graph.githubCLIService.getAgentRepositoryIdentity = (repository) => {
    identities.push(repository);
    return Promise.resolve({ id: 'repo-1', name: 'org/repo' });
  };
  graph.configService.getAgentRuntimeLimits = () => ({ githubPagesPerCycle: 1 });
  calls = [];
  try {
    runtime.start();
    await jobRunner.waitForCurrentRun('agent-source-poll');
  } finally {
    await runtime.stop();
  }
  expect(identities).toEqual(['org/repo']);
  expect(calls).toEqual([1]);
  expect(await state()).toMatchObject({ cursor: { scan: { phase: 'CAPTURE', nextPage: 2 } } });
});

it('rolls back a page instead of persisting an overflowed observation cursor', async () => {
  await db.prisma.agentSourceState.update({
    where: { connectionId: fixture.connectionId },
    data: {
      cursor: {
        version: 1,
        provider: 'GITHUB',
        committedHeadEventId: 'B',
        scan: { ...newScan('head', 'B'), observationCount: 2_147_483_647 },
      },
    },
  });
  const before = await state();
  await expect(
    accessor.savePage(fixture.connectionId, 1, { events: [label('head'), ...feed], nextPage: null })
  ).rejects.toThrow();
  expect(await state()).toEqual(before);
  expect(await db.prisma.agentEvent.count()).toBe(0);
  expect(await db.prisma.agentSourcePage.count()).toBe(0);
});
