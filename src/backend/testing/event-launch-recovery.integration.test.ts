import { afterEach, beforeEach, expect, it } from 'vitest';
import { createEventDeliveryFixture } from '@/backend/orchestration/testing/event-delivery.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let h: Awaited<ReturnType<typeof createEventDeliveryFixture>>;
beforeEach(async () => {
  db = await createIntegrationDatabase();
  h = await createEventDeliveryFixture(db, 'CLAUDE', false, true);
}, 30_000);
afterEach(async () => {
  await destroyIntegrationDatabase(db);
});
const row = () => db.prisma.agentRun.findUniqueOrThrow({ where: { id: h.claim.runId } });
async function expire() {
  await db.prisma.agentRun.update({
    where: { id: h.claim.runId },
    data: { leaseExpiresAt: new Date(0) },
  });
}
it('takes over safe durable-only work without spending a retry or accepting old worker writes', async () => {
  await expire();
  const recovered = await h.owner.eventRunLaunch.recover([], 4);
  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({
    claim: { ...h.claim, workerGeneration: h.claim.workerGeneration + 1 },
    attemptCount: 1,
  });
  await expect(h.owner.eventRunLaunch.renew(h.claim)).rejects.toThrow('no longer current');
  await h.owner.eventRunLaunch.renew(recovered[0]!.claim);
});
it.each(['SETUP', 'STARTUP'] as const)(
  'holds crashed %s work as unsent preparation uncertainty, preserving script evidence',
  async (state) => {
    await h.owner.eventRunLaunch.preparation(h.claim, state);
    await expire();
    expect(await h.owner.eventRunLaunch.recover([], 4)).toHaveLength(0);
    expect(await row()).toMatchObject({
      status: 'RUNNING',
      launchPhase: 'NEEDS_ATTENTION',
      reasonCode: 'PREPARATION_CLEANUP_UNCERTAIN',
      launchPreparation: { state: 'UNKNOWN' },
    });
    expect(
      await db.prisma.agentInitialDelivery.findUnique({ where: { runId: h.claim.runId } })
    ).toMatchObject({ state: 'PENDING' });
  }
);
it('persists shared retry budget and Retry-After without returning claimed work to authoring queue', async () => {
  await db.prisma.agentRun.update({ where: { id: h.claim.runId }, data: { attemptCount: 3 } });
  const before = Date.now();
  await h.owner.eventRunLaunch.dispose(h.claim, {
    kind: 'FAILED',
    cleanup: 'CONFIRMED',
    category: 'TRANSIENT',
    retryAfterMs: 700_000,
  });
  const pending = await row();
  expect(pending).toMatchObject({
    status: 'RUNNING',
    attemptCount: 3,
    reasonCode: 'PROVISIONING_RETRY',
    launchPreparation: { state: 'SAFE' },
  });
  expect(pending.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 700_000);
  expect(await h.owner.eventRunLaunch.recover([], 4)).toHaveLength(0);
  await db.prisma.agentRun.update({
    where: { id: h.claim.runId },
    data: { nextAttemptAt: new Date(0) },
  });
  const [retry] = await h.owner.eventRunLaunch.recover([], 4);
  expect(retry).toMatchObject({
    attemptCount: 4,
    claim: { attemptGeneration: h.claim.attemptGeneration },
  });
  await h.owner.eventRunLaunch.dispose(retry!.claim, {
    kind: 'FAILED',
    cleanup: 'CONFIRMED',
    category: 'TRANSIENT',
  });
  expect(await row()).toMatchObject({ status: 'FAILED', attemptCount: 4, nextAttemptAt: null });
});
it('does not revalidate claimed authoring revisions on safe retry', async () => {
  await db.prisma.agentDefinition.updateMany({
    data: { definitionRevision: { increment: 1 }, instructions: 'Edited', isEnabled: false },
  });
  await h.owner.eventRunLaunch.dispose(h.claim, {
    kind: 'SHUTDOWN',
    cleanup: 'CONFIRMED',
    category: 'UNKNOWN',
  });
  const [retry] = await h.owner.eventRunLaunch.recover([], 4);
  expect(retry?.definition.instructions).toBe('Frozen task');
  expect(retry?.attemptCount).toBe(1);
});
it.each(['SENDING', 'ACCEPTED'] as const)(
  'never replays %s after takeover, even with stop evidence missing its ambiguity projection',
  async (state) => {
    const source = {
      version: 1,
      provider: 'CLAUDE',
      providerSessionId: 'native',
      runtimeIncarnationId: 'incarnation',
      lifecycleGeneration: 1,
    };
    // Crash-state fixture: the real owner stop write committed but its projection did not.
    await db.prisma.agentInitialDelivery.update({
      where: { runId: h.claim.runId },
      data: {
        state,
        evidence: {
          version: 1,
          attempt: h.attempt,
          source,
          stop: {
            version: 1,
            cause: 'SHUTDOWN',
            source,
            status: 'UNKNOWN',
            observedAt: new Date().toISOString(),
          },
        },
      },
    });
    await expire();
    expect(await h.owner.eventRunLaunch.recover([], 4)).toHaveLength(0);
    expect(await row()).toMatchObject({ status: 'RUNNING', launchPhase: 'NEEDS_ATTENTION' });
    expect(
      await db.prisma.agentInitialDelivery.findUnique({ where: { runId: h.claim.runId } })
    ).toMatchObject({ state: 'AMBIGUOUS' });
  }
);
it('unknown cleanup never releases capacity or schedules retry', async () => {
  await h.owner.eventRunLaunch.dispose(h.claim, {
    kind: 'TIMED_OUT',
    cleanup: 'UNKNOWN',
    category: 'TRANSIENT',
  });
  expect(await row()).toMatchObject({
    status: 'RUNNING',
    launchPhase: 'NEEDS_ATTENTION',
    nextAttemptAt: null,
  });
});

it('does not overwrite a physical-work marker with a duplicate setup entry', async () => {
  await h.owner.eventRunLaunch.preparation(h.claim, 'SETUP');
  await expect(h.owner.eventRunLaunch.preparation(h.claim, 'SETUP')).rejects.toThrow(
    'no longer current'
  );
});

it('permits observation-only adoption of finished initial work without rotating the send identity', async () => {
  await db.prisma.agentInitialDelivery.update({
    where: { runId: h.claim.runId },
    data: { state: 'FINISHED', finishedAt: new Date() },
  });
  await db.prisma.agentRun.update({
    where: { id: h.claim.runId },
    data: { launchPhase: 'ACTIVE' },
  });
  await expect(h.owner.eventRunLaunch.adopt(h.claim)).rejects.toThrow('no longer current');
  await expire();
  const adopted = await h.owner.eventRunLaunch.adopt(h.claim);
  expect(adopted).toMatchObject({
    claim: {
      workerGeneration: h.claim.workerGeneration + 1,
      attemptGeneration: h.claim.attemptGeneration,
    },
    delivery: {
      state: 'FINISHED',
      messageId: h.attempt.messageId,
      sendAttemptId: h.attempt.sendAttemptId,
    },
    attemptCount: 1,
  });
  expect((await h.owner.eventRunLaunch.list())[0]?.claim).toEqual(adopted.claim);
  await expect(
    h.owner.eventRunLaunch.dispose(h.claim, {
      kind: 'FAILED',
      cleanup: 'CONFIRMED',
      category: 'UNKNOWN',
    })
  ).rejects.toThrow('no longer current');
});
