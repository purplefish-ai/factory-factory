import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createLedgerFixture } from '@/backend/services/agent-definition/resources/testing/agent-ledger.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { AgentGitHubSourcePort, AgentIssueEventPage } from '@/shared/agent-source';

let db: IntegrationDatabase;
let runtime: typeof import('../index');
let source: typeof import('../resources/agent-source.accessor').agentSourceAccessor;
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
let feed: AgentIssueEventPage['events'];
let calls: number[];
let port: AgentGitHubSourcePort;
const signal = new AbortController().signal;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual<typeof import('../index')>('../index');
  source = (
    await vi.importActual<typeof import('../resources/agent-source.accessor')>(
      '../resources/agent-source.accessor'
    )
  ).agentSourceAccessor;
}, 30_000);
afterAll(async () => destroyIntegrationDatabase(db));
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
  await db.prisma.project.updateMany({ data: { githubOwner: 'org', githubRepo: 'repo' } });
  await db.prisma.agentSourceState.deleteMany();
  feed = [{ providerEventId: 'boundary', payload: null }];
  calls = [];
  port = {
    getRepositoryIdentity: async () => ({ id: 'repo-1', name: 'org/repo' }),
    listIssueEvents: async ({ page }) => {
      calls.push(page);
      return {
        events: feed.slice((page - 1) * 100, page * 100),
        nextPage: page * 100 < feed.length ? page + 1 : null,
      };
    },
    classifyError: () => 'unknown',
  };
  await service(10).prepareBaseline(fixture.connectionId, signal);
  feed = [
    ...Array.from({ length: 205 }, (_, i) => ({
      providerEventId: `event-${i}`,
      payload: fixture.github(`event-${i}`).payload,
    })),
    ...feed,
  ];
  calls = [];
});
function service(budget: number) {
  return new runtime.AgentSourcePollService(port, () => budget);
}
async function state() {
  return await db.prisma.agentSourceState.findUniqueOrThrow({
    where: { connectionId: fixture.connectionId },
  });
}
async function finish() {
  await service(10).pollCycle(signal);
  expect((await state()).health).toMatchObject({ state: 'READY' });
  expect((await state()).cursor).toMatchObject({ committedHeadEventId: 'event-0', scan: null });
  expect(await db.prisma.agentEvent.count({ where: { sourceOrder: { not: null } } })).toBe(205);
  for (let i = 0; i < 8; i++) {
    await source.maintainCheckpoints(fixture.connectionId);
  }
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({ status: 'COMPLETE' });
}

it('keeps a source operational when another prepend shifts an already anchored capture overlap', async () => {
  await service(1).pollCycle(signal);
  feed.unshift({ providerEventId: 'new-1', payload: null });
  await service(1).pollCycle(signal);
  expect((await state()).cursor).toMatchObject({ scan: { overlapOffset: 99, nextPage: 2 } });
  feed.unshift({ providerEventId: 'new-2', payload: null });
  await service(1).pollCycle(signal);
  expect((await state()).health).toMatchObject({ state: 'CATCHING_UP' });
  expect((await state()).cursor).toMatchObject({ scan: { overlapOffset: null, nextPage: 3 } });
  await finish();
});

it('does not spend every cycle replaying the same overlap-only page', async () => {
  await service(1).pollCycle(signal);
  await service(1).pollCycle(signal);
  feed.unshift({ providerEventId: 'new-after-overlap', payload: null });
  await service(1).pollCycle(signal);
  expect(calls).toEqual([1, 1, 2]);
  expect(await db.prisma.agentEvent.count()).toBe(199);
  await finish();
});

it('fences a removed captured tail before publishing any source order', async () => {
  await service(1).pollCycle(signal);
  await service(1).pollCycle(signal);
  feed.splice(99, 1);
  await service(10).pollCycle(signal);
  expect((await state()).health).toMatchObject({ state: 'RECOVERY_REQUIRED' });
  expect(await db.prisma.agentEvent.count({ where: { sourceOrder: { not: null } } })).toBe(0);
});
