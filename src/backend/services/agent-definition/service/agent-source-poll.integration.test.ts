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
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
let feed: AgentIssueEventPage['events'];
let calls: number[];
let port: AgentGitHubSourcePort;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual<typeof import('../index')>('../index');
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
  await db.prisma.project.updateMany({ data: { githubOwner: 'org', githubRepo: 'repo' } });
  await db.prisma.agentSourceState.deleteMany();
  feed = [];
  calls = [];
  port = {
    getRepositoryIdentity: async () => ({ id: 'repo-1', name: 'renamed/repo' }),
    listIssueEvents: (input, signal) => {
      signal?.throwIfAborted();
      calls.push(input.page);
      return Promise.resolve({
        events: feed.slice((input.page - 1) * 100, input.page * 100),
        nextPage: input.page * 100 < feed.length ? input.page + 1 : null,
      });
    },
    classifyError: () => 'auth_required',
  };
});
const label = (id: string) => ({ providerEventId: id, payload: fixture.github(id).payload });
function service() {
  return new runtime.AgentSourcePollService(port);
}
async function baseline() {
  return await service().prepareBaseline(fixture.connectionId, new AbortController().signal);
}
async function cycle() {
  await service().pollCycle(new AbortController().signal);
}
async function state() {
  return await db.prisma.agentSourceState.findUniqueOrThrow({
    where: { connectionId: fixture.connectionId },
  });
}

it('prepares lightweight empty and control-head baselines without historical event content', async () => {
  expect(runtime.AgentSourcePollService).toBeTypeOf('function');
  const empty = await baseline();
  expect(empty.boundary).toEqual({ provider: 'GITHUB', headEventId: null, sourceOrder: 0 });
  feed = [{ providerEventId: 'pr-head', payload: null }];
  const pending = await baseline();
  await cycle();
  expect((await service().getBaseline(fixture.connectionId, pending.id))?.boundary).toEqual({
    provider: 'GITHUB',
    headEventId: 'pr-head',
    sourceOrder: 0,
  });
  expect(await db.prisma.agentEvent.count()).toBe(0);
});

it('establishes a nonempty first baseline using only its actual head', async () => {
  feed = [label('head'), label('old')];
  expect((await baseline()).boundary).toEqual({
    provider: 'GITHUB',
    headEventId: 'head',
    sourceOrder: 0,
  });
  expect(calls).toEqual([1]);
  expect(await db.prisma.agentEvent.count()).toBe(0);
});

it('orders repeated labels oldest-first after capture and verification, excluding removals and PRs', async () => {
  feed = [{ providerEventId: 'B', payload: null }];
  await baseline();
  feed = [
    { providerEventId: 'PR', payload: null },
    label('1'),
    { providerEventId: 'unlabel', payload: null },
    label('99999999999999999'),
    ...feed,
  ];
  await cycle();
  expect(
    await db.prisma.agentEvent.findMany({
      orderBy: { sourceOrder: 'asc' },
      select: { providerEventId: true, sourceOrder: true },
    })
  ).toEqual([
    { providerEventId: '99999999999999999', sourceOrder: 1 },
    { providerEventId: '1', sourceOrder: 2 },
  ]);
  expect((await state()).cursor).toMatchObject({ committedHeadEventId: 'PR', scan: null });
  await cycle();
  expect(await db.prisma.agentEvent.count()).toBe(2);
});

it('persists ten-page budget progress across restarts, verifies before chunk finalization, and resolves a shared baseline', async () => {
  feed = [{ providerEventId: 'B', payload: null }];
  await baseline();
  feed = [...Array.from({ length: 1205 }, (_, i) => label(`opaque-${1205 - i}`)), ...feed];
  const pending = await baseline();
  expect(pending.boundary).toBeNull();
  calls = [];
  await cycle();
  expect(calls.length).toBeLessThanOrEqual(10);
  expect((await state()).cursor).toMatchObject({
    committedHeadEventId: 'B',
    scan: { fixedHeadEventId: 'opaque-1205' },
  });
  expect(await db.prisma.agentEvent.count({ where: { sourceOrder: { not: null } } })).toBe(0);
  for (
    let i = 0;
    i < 8 &&
    (await state()).cursor &&
    (await db.prisma.agentEvent.count({ where: { sourceOrder: { not: null } } })) < 1205;
    i++
  ) {
    calls = [];
    await cycle();
    expect(calls.length).toBeLessThanOrEqual(10);
  }
  expect((await state()).lastSourceOrder).toBe(1205);
  expect(await db.prisma.agentEvent.findFirst({ orderBy: { sourceOrder: 'asc' } })).toMatchObject({
    providerEventId: 'opaque-1',
    sourceOrder: 1,
  });
  expect((await service().getBaseline(fixture.connectionId, pending.id))?.boundary).toEqual({
    provider: 'GITHUB',
    headEventId: 'opaque-1205',
    sourceOrder: 1205,
  });
}, 30_000);

it('fails closed when an already captured interval changes during verification', async () => {
  feed = [{ providerEventId: 'B', payload: null }];
  await baseline();
  feed = [...Array.from({ length: 1100 }, (_, i) => label(`e-${i}`)), ...feed];
  await cycle();
  feed.splice(30, 1);
  for (let i = 0; i < 4; i++) {
    await cycle();
  }
  expect(await state()).toMatchObject({
    isReady: false,
    lastSourceOrder: 0,
    health: { state: 'RECOVERY_REQUIRED' },
    cursor: { committedHeadEventId: 'B' },
  });
  expect(await db.prisma.agentEvent.count({ where: { sourceOrder: { not: null } } })).toBe(0);
});

it('keeps the committed boundary on missing anchor, auth failure, or archived project', async () => {
  feed = [{ providerEventId: 'B', payload: null }];
  await baseline();
  feed = [label('new')];
  await cycle();
  expect(await state()).toMatchObject({
    health: { state: 'RECOVERY_REQUIRED' },
    cursor: { committedHeadEventId: 'B' },
  });
  await db.prisma.agentSourceState.deleteMany();
  await baseline();
  port.listIssueEvents = () => Promise.reject(new Error('secret diagnostic'));
  await cycle();
  expect(await state()).toMatchObject({
    isReady: false,
    health: { reasonCode: 'GITHUB_AUTH_REQUIRED' },
    cursor: { committedHeadEventId: 'new' },
  });
  expect(JSON.stringify(await state())).not.toContain('secret diagnostic');
  await db.prisma.project.updateMany({ data: { isArchived: true } });
  calls = [];
  await cycle();
  expect(calls).toEqual([]);
});

it('rejects finalization without durable verified page evidence', async () => {
  const event = await runtime.ingestEvent(fixture.github());
  await expect(
    runtime.finalizeEventOrder({ connectionId: fixture.connectionId, eventIds: [event.eventId] })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(
    (await db.prisma.agentEvent.findUniqueOrThrow({ where: { id: event.eventId } })).sourceOrder
  ).toBeNull();
});

it('finishes the fixed interval after more than a page of head insertions, then captures the newer interval', async () => {
  feed = [{ providerEventId: 'B', payload: null }];
  await baseline();
  feed = [...Array.from({ length: 1100 }, (_, i) => label(`old-${1100 - i}`)), ...feed];
  await cycle();
  feed = [...Array.from({ length: 250 }, (_, i) => label(`new-${250 - i}`)), ...feed];
  for (let i = 0; i < 8 && (await state()).lastSourceOrder < 1100; i++) {
    await cycle();
  }
  expect(await state()).toMatchObject({
    lastSourceOrder: 1100,
    cursor: { committedHeadEventId: 'old-1100', scan: null },
  });
  expect(
    await db.prisma.agentEvent.count({ where: { providerEventId: { startsWith: 'new-' } } })
  ).toBe(0);
  await cycle();
  expect(await state()).toMatchObject({
    lastSourceOrder: 1350,
    cursor: { committedHeadEventId: 'new-250' },
  });
}, 30_000);

it('recovers a committed finalization chunk without interleaving a newer interval', async () => {
  feed = [{ providerEventId: 'B', payload: null }];
  await baseline();
  feed = [...Array.from({ length: 1001 }, (_, i) => label(`e-${1001 - i}`)), ...feed];
  const { agentSourceAccessor } = await vi.importActual<
    typeof import('../resources/agent-source.accessor')
  >('../resources/agent-source.accessor');
  const original = agentSourceAccessor.finalizeNextChunk;
  const controller = new AbortController();
  const spy = vi.spyOn(agentSourceAccessor, 'finalizeNextChunk').mockImplementation(async (id) => {
    const result = await original(id);
    controller.abort();
    return result;
  });
  try {
    for (let i = 0; i < 6 && !controller.signal.aborted; i++) {
      await service().pollCycle(controller.signal);
    }
  } finally {
    spy.mockRestore();
  }
  expect(await state()).toMatchObject({
    lastSourceOrder: 1000,
    cursor: { committedHeadEventId: 'B', scan: { phase: 'FINALIZE', finalizedCount: 1000 } },
  });
  feed.unshift(label('newer'));
  calls = [];
  await cycle();
  expect(calls).toEqual([]);
  expect(await state()).toMatchObject({
    lastSourceOrder: 1001,
    cursor: { committedHeadEventId: 'e-1001', scan: null },
  });
  expect(await db.prisma.agentEvent.count({ where: { providerEventId: 'newer' } })).toBe(0);
}, 30_000);

it('rolls back both the page and executable inserts if a later item fails ownership', async () => {
  await baseline();
  const { agentSourceAccessor } = await vi.importActual<
    typeof import('../resources/agent-source.accessor')
  >('../resources/agent-source.accessor');
  const before = await state();
  const wrong = label('wrong');
  wrong.payload.repositoryId = 'other';
  await expect(
    agentSourceAccessor.savePage(fixture.connectionId, 1, {
      events: [label('valid'), wrong],
      nextPage: null,
    })
  ).rejects.toThrow();
  expect(await state()).toEqual(before);
  expect(await db.prisma.agentEvent.count()).toBe(0);
  expect(await db.prisma.agentSourcePage.count()).toBe(0);
});

it('keeps paused sources inert and rejects a configured path rebound to another repository', async () => {
  await baseline();
  port.getRepositoryIdentity = () => Promise.resolve({ id: 'different', name: 'org/repo' });
  await cycle();
  expect(calls).toEqual([1]);
  expect(await state()).toMatchObject({ isReady: false, health: { state: 'RECOVERY_REQUIRED' } });
  await db.prisma.agentTrigger.updateMany({
    data: { isEnabled: false, activationState: 'PAUSED' },
  });
  await expect(baseline()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  calls = [];
  await cycle();
  expect(calls).toEqual([]);
});

it('retains the cursor on cancellation and exposes a sanitized rate-limit health reason', async () => {
  await baseline();
  const before = await state();
  const controller = new AbortController();
  port.listIssueEvents = (_input, signal) => {
    controller.abort();
    signal?.throwIfAborted();
    return Promise.reject(new Error('aborted'));
  };
  await service().pollCycle(controller.signal);
  expect(await state()).toEqual(before);
  port.listIssueEvents = () => Promise.reject(new Error('provider diagnostic'));
  port.classifyError = () => 'rate_limit';
  await cycle();
  expect(await state()).toMatchObject({
    isReady: false,
    health: { reasonCode: 'GITHUB_RATE_LIMITED' },
  });
});

it('resolves a prepared head even when a newer interval commits before the preparation write', async () => {
  feed = [{ providerEventId: 'B', payload: null }];
  await baseline();
  feed.unshift(label('H'));
  const original = port.listIssueEvents;
  port.listIssueEvents = async (input, signal) => {
    const observed = await original(input, signal);
    port.listIssueEvents = original;
    feed.unshift(label('H2'));
    await cycle();
    return observed;
  };
  expect((await baseline()).boundary).toEqual({
    provider: 'GITHUB',
    headEventId: 'H',
    sourceOrder: 1,
  });
  expect((await state()).lastSourceOrder).toBe(2);
});

it('sanitizes baseline preparation failures and persists readiness failure', async () => {
  port.listIssueEvents = () => Promise.reject(new Error('secret provider diagnostic'));
  await expect(baseline()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(await state()).toMatchObject({
    isReady: false,
    health: { reasonCode: 'GITHUB_AUTH_REQUIRED' },
  });
});

it('requires recovery when a pending activation head disappears from its next interval', async () => {
  feed = [{ providerEventId: 'B', payload: null }];
  await baseline();
  feed.unshift(label('activation-head'));
  const pending = await baseline();
  expect(pending.boundary).toBeNull();
  feed = [label('newer'), { providerEventId: 'B', payload: null }];
  await cycle();
  expect(await state()).toMatchObject({
    lastSourceOrder: 0,
    health: { state: 'RECOVERY_REQUIRED' },
    cursor: { committedHeadEventId: 'B' },
  });
});
