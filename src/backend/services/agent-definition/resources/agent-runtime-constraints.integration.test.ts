import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createLedgerFixture } from '@/backend/services/agent-definition/resources/testing/agent-ledger.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let runtime: typeof import('../index');
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual<typeof import('../index')>('../index');
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
});

it('allows independent definitions for one event but enforces four global active slots', async () => {
  const id = await fixture.event();
  await fixture.admit(id);
  const original = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: fixture.definitionId },
  });
  for (let index = 1; index <= 4; index++) {
    const definition = await db.prisma.agentDefinition.create({
      data: {
        projectId: original.projectId,
        name: `Definition ${index}`,
        instructions: 'Investigate',
        isEnabled: true,
      },
    });
    const trigger = await db.prisma.agentTrigger.create({
      data: {
        agentDefinitionId: definition.id,
        connectionId: fixture.connectionId,
        type: 'GITHUB_ISSUE',
        description: 'Label',
        config: { version: 1, repositoryIds: ['repo-1'], actions: ['labeled'] },
        isEnabled: true,
        activationState: 'ACTIVE',
        activationGeneration: 1,
        activationBoundary: { provider: 'GITHUB', headEventId: null, sourceOrder: 0 },
      },
    });
    expect(
      await fixture.admit(id, { agentDefinitionId: definition.id, triggerId: trigger.id })
    ).toMatchObject({ status: 'ADMITTED' });
  }
  const claims = await Promise.all(Array.from({ length: 5 }, () => runtime.claimNextRun()));
  expect(claims.filter((claim) => claim.status === 'CLAIMED')).toHaveLength(4);
  expect(claims.filter((claim) => claim.status === 'DEFERRED')).toEqual([
    { status: 'DEFERRED', reason: 'CAPACITY' },
  ]);
  expect(await db.prisma.agentRun.count()).toBe(5);
  expect(await db.prisma.agentRun.count({ where: { status: 'RUNNING' } })).toBe(4);
});

it('settles queue overflow at 100 waiting runs as a visible terminal skipped evaluation', async () => {
  await db.prisma.agentRun.createMany({
    data: Array.from({ length: 100 }, (_, index) => ({
      agentDefinitionId: fixture.definitionId,
      triggerId: fixture.triggerId,
      idempotencyKey: `queued-${index}`,
      definitionSnapshot: { instructions: 'Frozen' },
      input: { version: 1, context: [] },
    })),
  });
  expect(await fixture.admit(await fixture.event())).toEqual({
    status: 'REJECTED',
    reason: 'QUEUE_OVERFLOW',
  });
  expect(await db.prisma.agentEvaluation.findFirstOrThrow()).toMatchObject({
    status: 'SKIPPED',
    reasonCode: 'QUEUE_OVERFLOW',
    runId: null,
  });
  expect(await db.prisma.agentRun.count()).toBe(100);
});

it('uses exact Slack provider timestamps and verifies team, app and channel ownership', async () => {
  const connection = await db.prisma.agentConnection.create({
    data: {
      provider: 'SLACK',
      externalId: 'T-team',
      name: 'Team',
      credentialsEncrypted: 'encrypted',
      sourceState: { create: { isReady: true } },
    },
  });
  await db.prisma.agentTrigger.update({
    where: { id: fixture.triggerId },
    data: {
      type: 'SLACK_MESSAGE',
      connectionId: connection.id,
      config: { version: 1, channelIds: ['C-feedback'] },
      activationBoundary: {
        provider: 'SLACK',
        workspaceId: 'T-team',
        appId: 'A-app',
        channels: [{ channelId: 'C-feedback', eventTs: '100.000000000000000001' }],
      },
    },
  });
  const payload = {
    version: 1 as const,
    provider: 'SLACK' as const,
    workspaceId: 'T-team',
    appId: 'A-app',
    channelId: 'C-feedback',
    action: 'message' as const,
    actorType: 'HUMAN' as const,
    subtype: null,
    actorId: 'U-person',
    threadTs: null,
    eventTs: '100.000000000000000002',
    text: 'Human feedback',
    sourceUrl: 'https://slack.com/archives/C-feedback/p100',
    occurredAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
  };
  for (const [providerEventId, changed, want] of [
    ['later', {}, 'ADMITTED'],
    ['equal', { eventTs: '100.000000000000000001' }, 'REJECTED'],
    ['wrong-app', { appId: 'A-other' }, 'REJECTED'],
    ['wrong-channel', { channelId: 'C-other' }, 'REJECTED'],
  ] as const) {
    const captured = await runtime.ingestEvent({
      connectionId: connection.id,
      providerEventId,
      payload: { ...payload, ...changed },
    });
    expect(await fixture.admit(captured.eventId)).toMatchObject({ status: want });
  }
});

it('enforces unique canonical source order and connection-owned finalization', async () => {
  const first = await fixture.event('first');
  const second = await fixture.event('second');
  await expect(
    db.prisma.agentEvent.update({ where: { id: second }, data: { sourceOrder: 1 } })
  ).rejects.toMatchObject({ code: 'P2002' });
  await expect(
    runtime.finalizeEventOrder({ connectionId: fixture.connectionId, eventIds: [second, first] })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  const other = await db.prisma.agentConnection.create({
    data: { provider: 'GITHUB', externalId: 'gh:other', name: 'Other' },
  });
  await expect(
    runtime.finalizeEventOrder({ connectionId: other.id, eventIds: [first] })
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(
    await db.prisma.agentSourceState.findUniqueOrThrow({
      where: { connectionId: fixture.connectionId },
    })
  ).toMatchObject({ lastSourceOrder: 2 });
});

it('rejects caller-provided eligibility booleans and malformed resolved execution settings', async () => {
  const id = await fixture.event();
  const decision = await fixture.evaluation(id);
  if (!('evaluationId' in decision)) {
    throw new Error(JSON.stringify(decision));
  }
  await expect(
    runtime.admitRun({
      evaluationId: decision.evaluationId,
      definitionRevision: 1,
      triggerRevision: 1,
      activationGeneration: 1,
      eligible: true,
    } as never)
  ).rejects.toThrow();
  await expect(
    fixture.evaluation(id, {
      executionConfig: { version: 1, provider: 'CLAUDE', model: 'gpt-5.4' },
    })
  ).rejects.toThrow();
  expect(await db.prisma.agentRun.count()).toBe(0);
});

it('expires old waiting runs before applying queue overflow to a fresh event', async () => {
  await db.prisma.agentRun.createMany({
    data: Array.from({ length: 100 }, (_, index) => ({
      agentDefinitionId: fixture.definitionId,
      triggerId: fixture.triggerId,
      idempotencyKey: `expired-${index}`,
      definitionSnapshot: { instructions: 'Frozen' },
      input: { version: 1, context: [] },
      expiresAt: new Date(Date.now() - 1),
    })),
  });
  expect(await fixture.admit(await fixture.event())).toMatchObject({ status: 'ADMITTED' });
  expect(
    await db.prisma.agentRun.count({ where: { status: 'CANCELLED', reasonCode: 'QUEUE_EXPIRED' } })
  ).toBe(100);
});

it('does not choose later context when an earlier active trigger has corrupt eligibility state', async () => {
  await fixture.secondTrigger();
  const id = await fixture.event();
  await fixture.evaluation(id);
  await db.prisma.agentTrigger.update({
    where: { id: fixture.triggerId },
    data: { activationBoundary: { provider: 'GITHUB', sourceOrder: 'invalid' } },
  });
  expect(await fixture.admit(id, { triggerId: 'trigger-b' })).toEqual({
    status: 'DEFERRED',
    reason: 'INVALID_STORED_DATA',
  });
  expect(await db.prisma.agentRun.count()).toBe(0);
});
