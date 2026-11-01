import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createLedgerFixture,
  executionConfig,
} from '@/backend/services/agent-definition/resources/testing/agent-ledger.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { Prisma } from '@prisma-gen/client';
let db: IntegrationDatabase;
let runtime: typeof import('../index');
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
let definitionId: string;
let connectionId: string;
let triggerId: string;
const github = (id?: string) => fixture.github(id);
const event = (id?: string) => fixture.event(id);
const evaluation = (id: string, overrides?: Record<string, unknown>) =>
  fixture.evaluation(id, overrides);
const admit = (id: string, overrides?: Record<string, unknown>) => fixture.admit(id, overrides);
const secondTrigger = () => fixture.secondTrigger();
beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual<typeof import('../index')>('../index');
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
  ({ definitionId, connectionId, triggerId } = fixture);
});

it('deduplicates normalized events without replacing payload, dates or API-order witnesses', async () => {
  const id = await event();
  const original = await db.prisma.agentEvent.findUniqueOrThrow({ where: { id } });
  const duplicate = await runtime.ingestEvent({
    ...github(),
    payload: {
      ...github().payload,
      issue: { number: 1, title: 'Edited', body: 'Changed', addedLabel: 'other' },
    },
  });
  expect(duplicate).toEqual({ eventId: id, duplicate: true });
  expect(await db.prisma.agentEvent.findUniqueOrThrow({ where: { id } })).toEqual(original);
});

it('refuses provider identity mismatches and unrestricted/invalid provider JSON', async () => {
  expect(runtime.ingestEvent).toBeTypeOf('function');
  await expect(
    runtime.ingestEvent({ ...github(), payload: { ...github().payload, repositoryId: 'wrong' } })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    runtime.ingestEvent({
      ...github(),
      payload: { ...github().payload, raw: { token: 'secret' } },
    } as never)
  ).rejects.toThrow();
  await expect(
    runtime.ingestEvent({
      ...github(),
      payload: {
        ...github().payload,
        issue: { ...github().payload.issue, body: 'x'.repeat(100_001) },
      },
    })
  ).rejects.toThrow();
  expect(await db.prisma.agentEvent.count()).toBe(0);
});

it('defers unfinalized GitHub events and never compares numerical provider event IDs', async () => {
  expect(runtime.ingestEvent).toBeTypeOf('function');
  const first = await runtime.ingestEvent(github('99999999999999999999'));
  const waiting = await evaluation(first.eventId);
  expect(waiting).toMatchObject({ status: 'DEFERRED', reason: 'SOURCE_ORDER_PENDING' });
  await fixture.finalize({ connectionId, eventIds: [first.eventId] });
  await db.prisma.agentTrigger.update({
    where: { id: triggerId },
    data: {
      activationBoundary: {
        provider: 'GITHUB',
        headEventId: '99999999999999999999',
        sourceOrder: 1,
      },
    },
  });
  expect(await admit(first.eventId)).toMatchObject({
    status: 'REJECTED',
    reason: 'BEFORE_ACTIVATION',
  });
  const later = await event('1');
  expect(await admit(later)).toMatchObject({ status: 'ADMITTED' });
});

it('admits a definition/event exactly once across concurrent delivery and admission retries', async () => {
  const incoming = github();
  const deliveries = await Promise.all(
    Array.from({ length: 3 }, () => runtime.ingestEvent(incoming))
  );
  expect(deliveries.filter((delivery) => !delivery.duplicate)).toHaveLength(1);
  expect(new Set(deliveries.map((delivery) => delivery.eventId)).size).toBe(1);
  expect(await db.prisma.agentEvent.count()).toBe(1);
  const id = deliveries[0]?.eventId;
  if (!id) {
    throw new Error('Concurrent delivery returned no event');
  }
  await fixture.finalize({ connectionId, eventIds: [id] });
  const outcomes = await Promise.all([admit(id), admit(id), admit(id)]);
  expect(outcomes.map((result) => result.status).sort()).toEqual([
    'ADMITTED',
    'COALESCED',
    'COALESCED',
  ]);
  expect(await db.prisma.agentRun.count()).toBe(1);
  expect(await db.prisma.agentEvaluation.count()).toBe(1);
  const run = await db.prisma.agentRun.findFirstOrThrow();
  expect(run).toMatchObject({
    status: 'QUEUED',
    launchPhase: 'RESERVED',
    definitionRevision: 1,
    triggerRevision: 1,
    activationGeneration: 1,
  });
  expect(run.reservedWorkspaceId).toBeTruthy();
  expect(run.reservedSessionId).toBeTruthy();
  expect(
    await db.prisma.agentInitialDelivery.findUniqueOrThrow({ where: { runId: run.id } })
  ).toMatchObject({ state: 'PENDING', messageId: run.initialMessageId, attemptGeneration: 1 });
});

it('chooses the first matched trigger in stable ID order and coalesces later matches', async () => {
  await secondTrigger();
  const id = await event();
  const later = await evaluation(id, {
    triggerId: 'trigger-b',
    input: { version: 1, eventId: id, context: [{ id: 'later', text: 'Later context' }] },
  });
  if (!('evaluationId' in later)) {
    throw new Error(JSON.stringify(later));
  }
  expect(
    await runtime.admitRun({
      evaluationId: later.evaluationId,
      definitionRevision: 1,
      triggerRevision: 1,
      activationGeneration: 1,
    })
  ).toMatchObject({ status: 'DEFERRED', reason: 'EARLIER_EVALUATION_PENDING' });
  await evaluation(id);
  expect(
    await runtime.admitRun({
      evaluationId: later.evaluationId,
      definitionRevision: 1,
      triggerRevision: 1,
      activationGeneration: 1,
    })
  ).toMatchObject({ status: 'ADMITTED' });
  const run = await db.prisma.agentRun.findFirstOrThrow();
  expect(run).toMatchObject({
    triggerId: 'trigger-a',
    input: { context: [{ text: 'Frozen issue context' }] },
  });
  expect(await db.prisma.agentEvaluation.findMany()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ triggerId: 'trigger-a', runId: run.id }),
      expect.objectContaining({ triggerId: 'trigger-b', runId: run.id }),
    ])
  );
});

it('does not let a later match bypass an earlier error', async () => {
  await secondTrigger();
  const id = await event();
  await evaluation(id, { status: 'ERROR', reasonCode: 'CLASSIFIER_FAILED' });
  expect(await admit(id, { triggerId: 'trigger-b' })).toMatchObject({
    status: 'DEFERRED',
    reason: 'EARLIER_EVALUATION_ERROR',
  });
  expect(await db.prisma.agentRun.count()).toBe(0);
});

it('rejects evaluations borrowing a trigger from another definition or connection', async () => {
  const id = await event();
  expect(await evaluation(id, { agentDefinitionId: 'another-definition' })).toMatchObject({
    status: 'REJECTED',
    reason: 'OWNERSHIP_MISMATCH',
  });
  const other = await db.prisma.agentConnection.create({
    data: { provider: 'GITHUB', externalId: 'gh:other', name: 'Other' },
  });
  await db.prisma.agentTrigger.update({
    where: { id: triggerId },
    data: { connectionId: other.id },
  });
  expect(await evaluation(id)).toMatchObject({ status: 'REJECTED', reason: 'OWNERSHIP_MISMATCH' });
  expect(await db.prisma.agentEvaluation.count()).toBe(0);
});

it.each([
  'definition',
  'trigger',
  'generation',
  'paused',
  'disconnected',
  'not-ready',
  'archived',
] as const)('rechecks %s changes between evaluation and admission', async (change) => {
  const id = await event();
  const decision = await evaluation(id);
  if (!('evaluationId' in decision)) {
    throw new Error(JSON.stringify(decision));
  }
  if (change === 'definition') {
    await db.prisma.agentDefinition.update({
      where: { id: definitionId },
      data: { definitionRevision: 2 },
    });
  }
  if (change === 'trigger') {
    await db.prisma.agentTrigger.update({ where: { id: triggerId }, data: { triggerRevision: 2 } });
  }
  if (change === 'generation') {
    await db.prisma.agentTrigger.update({
      where: { id: triggerId },
      data: { activationGeneration: 2 },
    });
  }
  if (change === 'paused') {
    await db.prisma.agentTrigger.update({ where: { id: triggerId }, data: { isEnabled: false } });
  }
  if (change === 'disconnected') {
    await db.prisma.agentConnection.update({
      where: { id: connectionId },
      data: { isEnabled: false },
    });
  }
  if (change === 'not-ready') {
    await db.prisma.agentSourceState.update({ where: { connectionId }, data: { isReady: false } });
  }
  if (change === 'archived') {
    await db.prisma.project.updateMany({ data: { isArchived: true } });
  }
  expect(
    await runtime.admitRun({
      evaluationId: decision.evaluationId,
      definitionRevision: 1,
      triggerRevision: 1,
      activationGeneration: 1,
    })
  ).toMatchObject({ status: 'REJECTED' });
  expect(await db.prisma.agentRun.count()).toBe(0);
});

it('holds STARTING candidates without recording a terminal disabled decision', async () => {
  const id = await event();
  await db.prisma.agentTrigger.update({
    where: { id: triggerId },
    data: { isEnabled: false, activationState: 'STARTING' },
  });
  expect(await evaluation(id, { status: 'SKIPPED', reasonCode: 'TRIGGER_DISABLED' })).toMatchObject(
    { status: 'DEFERRED', reason: 'ACTIVATION_STARTING' }
  );
  expect(await db.prisma.agentEvaluation.count()).toBe(0);
});

it('freezes validated snapshots and preserves compact results through workspace and event deletion', async () => {
  const id = await event();
  await admit(id);
  const run = await db.prisma.agentRun.findFirstOrThrow();
  const definition = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: definitionId },
  });
  const workspace = await db.prisma.workspace.create({
    data: { projectId: definition.projectId, name: 'Result' },
  });
  await db.prisma.agentRun.update({
    where: { id: run.id },
    data: {
      workspaceId: workspace.id,
      status: 'PR_CREATED',
      result: {
        version: 1,
        summary: 'Fixed',
        pullRequests: [{ url: 'https://github.com/org/repo/pull/2', number: 2 }],
      },
    },
  });
  await db.prisma.agentDefinition.update({
    where: { id: definitionId },
    data: {
      instructions: 'Changed',
      executionConfig: { version: 1, provider: 'CODEX', model: 'gpt-5.4' },
    },
  });
  await db.prisma.workspace.delete({ where: { id: workspace.id } });
  await db.prisma.agentEvaluation.deleteMany();
  await db.prisma.agentEvent.delete({ where: { id } });
  expect(await db.prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
    eventId: null,
    workspaceId: null,
    definitionSnapshot: { instructions: 'Investigate bugs', executionConfig },
    input: { context: [{ text: 'Frozen issue context' }] },
    result: { summary: 'Fixed', pullRequests: [{ number: 2 }] },
  });
});

it('rejects corrupted stored snapshots before allocating capacity', async () => {
  const id = await event();
  const decision = await evaluation(id);
  if (!('evaluationId' in decision)) {
    throw new Error(JSON.stringify(decision));
  }
  await db.prisma.agentEvaluation.update({
    where: { id: decision.evaluationId },
    data: { configurationSnapshot: { version: 99 } },
  });
  expect(
    await runtime.admitRun({
      evaluationId: decision.evaluationId,
      definitionRevision: 1,
      triggerRevision: 1,
      activationGeneration: 1,
    })
  ).toEqual({ status: 'REJECTED', reason: 'INVALID_STORED_DATA' });
  expect(await db.prisma.agentRun.count()).toBe(0);
});

it('does not revive skipped or error cohorts after revision or activation changes', async () => {
  const id = await event();
  await evaluation(id, { status: 'SKIPPED', reasonCode: 'FILTER_SKIPPED' });
  await db.prisma.agentTrigger.update({
    where: { id: triggerId },
    data: { triggerRevision: 2, activationGeneration: 2 },
  });
  expect(await evaluation(id, { triggerRevision: 2, activationGeneration: 2 })).toEqual({
    status: 'REJECTED',
    reason: 'STALE_EVENT_COHORT',
  });
});

it('rejects automatic admission for event text older than 30 days despite a fresh observation', async () => {
  expect(runtime.ingestEvent).toBeTypeOf('function');
  const old = {
    ...github('old'),
    payload: {
      ...github().payload,
      occurredAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
    },
  };
  const captured = await runtime.ingestEvent(old);
  await fixture.finalize({ connectionId, eventIds: [captured.eventId] });
  expect(await evaluation(captured.eventId)).toEqual({
    status: 'REJECTED',
    reason: 'EVENT_EXPIRED',
  });
});

it('admits finalized events after a non-executable provider control anchor', async () => {
  await db.prisma.agentTrigger.update({
    where: { id: triggerId },
    data: { activationBoundary: { provider: 'GITHUB', headEventId: 'pr-control', sourceOrder: 0 } },
  });
  expect(await admit(await event('future-issue'))).toMatchObject({ status: 'ADMITTED' });
});

it('keeps canonical source ordinals monotonic after event identity pruning', async () => {
  await event('first');
  await db.prisma.agentEvent.deleteMany();
  const id = await event('later');
  expect(await db.prisma.agentEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
    sourceOrder: 2,
  });
});

it('reports expired pruned payloads before attempting stored payload validation', async () => {
  const id = await event();
  await db.prisma.agentEvent.update({
    where: { id },
    data: { payload: Prisma.DbNull, payloadExpiresAt: new Date(Date.now() - 1) },
  });
  expect(await evaluation(id)).toEqual({ status: 'REJECTED', reason: 'EVENT_EXPIRED' });
  expect(await db.prisma.agentEvaluation.count()).toBe(0);
});

it.each(['trigger', 'definition'] as const)(
  'rejects corrupt stored %s snapshots with a typed result',
  async (target) => {
    const id = await event();
    if (target === 'trigger') {
      await db.prisma.agentTrigger.update({
        where: { id: triggerId },
        data: { config: { version: 999 } },
      });
    } else {
      await db.prisma.agentDefinition.update({
        where: { id: definitionId },
        data: { instructions: '' },
      });
    }
    expect(await evaluation(id)).toEqual({ status: 'REJECTED', reason: 'INVALID_STORED_DATA' });
    expect(await db.prisma.agentEvaluation.count()).toBe(0);
    expect(await db.prisma.agentRun.count()).toBe(0);
  }
);

it('enforces the absolute event-age limit at admission even with a future payload deadline', async () => {
  const incoming = github('ancient');
  incoming.payload.occurredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const captured = await runtime.ingestEvent(incoming);
  await fixture.finalize({ connectionId, eventIds: [captured.eventId] });
  await db.prisma.agentEvent.update({
    where: { id: captured.eventId },
    data: { payloadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
  });
  const decision = await evaluation(captured.eventId);
  expect(decision.status).toBe('RECORDED');
  if (!('evaluationId' in decision)) {
    throw new Error(JSON.stringify(decision));
  }
  expect(
    await runtime.admitRun({
      evaluationId: decision.evaluationId,
      definitionRevision: 1,
      triggerRevision: 1,
      activationGeneration: 1,
    })
  ).toEqual({ status: 'REJECTED', reason: 'EVENT_EXPIRED' });
  expect(await db.prisma.agentRun.count()).toBe(0);
});
