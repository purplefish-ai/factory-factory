// ABANDON with acceptUnprovenStop: ending a run whose stop or work proof is unavailable.
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { agentRecoveryInputSchema } from '@/shared/event-agent-recovery';
import {
  consumer,
  context,
  db,
  h,
  launch,
  providers,
  strictStop,
} from '@/test-utils/event-generic-retry.test-support';

const row = () => db.prisma.agentRun.findUniqueOrThrow({ where: { id: h.claim.runId } });
const delivery = () =>
  db.prisma.agentInitialDelivery.findUniqueOrThrow({ where: { runId: h.claim.runId } });

async function freshConsumer() {
  const { createEventRunConsumer } = await vi.importActual<
    typeof import('@/backend/orchestration/agents/event-run-consumer.orchestrator')
  >('@/backend/orchestration/agents/event-run-consumer.orchestrator');
  return createEventRunConsumer();
}

/** A second matching event of the same automation, queued behind the run under test. */
async function queueNextRun() {
  const first = await row();
  const event = await db.prisma.agentEvent.findUniqueOrThrow({ where: { id: first.eventId! } });
  const { id: _eventId, ...eventFields } = event;
  const next = await db.prisma.agentEvent.create({
    data: {
      ...eventFields,
      providerEventId: `${event.providerEventId}-next`,
      sourceOrder: event.sourceOrder === null ? null : event.sourceOrder + 1,
      payload: eventFields.payload ?? undefined,
    } as never,
  });
  const messageId = randomUUID();
  const input = { ...(first.input as Record<string, unknown>), eventId: next.id };
  const run = await db.prisma.agentRun.create({
    data: {
      agentDefinitionId: first.agentDefinitionId,
      triggerId: first.triggerId,
      eventId: next.id,
      idempotencyKey: `event:${next.id}`,
      activationGeneration: first.activationGeneration,
      definitionSnapshot: first.definitionSnapshot ?? undefined,
      triggerSnapshot: first.triggerSnapshot ?? undefined,
      input,
      reservedWorkspaceId: randomUUID(),
      reservedSessionId: randomUUID(),
      initialMessageId: messageId,
      expiresAt: new Date(Date.now() + 86_400_000),
      initialDelivery: { create: { sendAttemptId: randomUUID(), messageId } },
    } as never,
  });
  return run.id;
}

/**
 * The provider transport drops mid-send: the first message is AMBIGUOUS. The
 * periodic job then hands the failed launch to an observer, as in the app.
 */
async function disconnect() {
  await launch();
  providers[0]!.response.reject(new Error('Transport disconnected'));
  await consumer.drain();
  await consumer.maintain(new AbortController().signal);
  await consumer.drain();
  expect((await delivery()).state).toBe('AMBIGUOUS');
}

/** Restart: the lease lapses, launch recovery holds the run, and live tracking is gone. */
async function restart() {
  h.session.eventOwnedWork.forget(h.attempt.sessionId);
  await db.prisma.agentRun.update({
    where: { id: h.claim.runId },
    data: { leaseExpiresAt: new Date(Date.now() - 1000) },
  });
  await h.owner.eventRunLaunch.recover([], 4);
  return freshConsumer();
}

async function expectUnprovenEnd(
  reason: string,
  status: 'CANCELLED' | 'COMPLETED' | 'PR_CREATED' = 'CANCELLED'
) {
  const ended = await row();
  expect(ended).toMatchObject({
    status,
    launchPhase: 'FINISHED',
    reasonCode: 'ABANDONED_UNPROVEN',
    leaseExpiresAt: null,
    nextAttemptAt: null,
  });
  const evidence = (await h.read()).evidence;
  expect(evidence?.unprovenAbandon).toMatchObject({ version: 1, reason });
  // Never a proven stop or work proof that was not observed.
  expect(evidence?.work).toBeUndefined();
  expect(evidence?.resolution).toBeUndefined();
  expect(evidence?.stop?.status).not.toBe('LOCAL_RUNTIME_GROUP_STOPPED');
  return ended;
}

it('rejects the opt-in on Resolve and Retry', async () => {
  const input = { ...(await context()), agentId: 'agent' };
  for (const action of ['RESOLVE', 'RETRY'] as const) {
    expect(
      agentRecoveryInputSchema.safeParse({ ...input, action, acceptUnprovenStop: true }).success
    ).toBe(false);
  }
  expect(
    agentRecoveryInputSchema.safeParse({ ...input, action: 'ABANDON', acceptUnprovenStop: true })
      .success
  ).toBe(true);
});

it('abandons a run that lost live coverage in a restart only with the opt-in, and frees its slot', async () => {
  await launch();
  const nextRunId = await queueNextRun();
  expect(await h.owner.claimNextRun()).toMatchObject({ status: 'DEFERRED' });
  const restarted = await restart();
  try {
    const input = await context();
    const inspection = await restarted.inspectRun(input);
    expect(inspection).toMatchObject({
      blocked: 'WORK_PROOF_UNAVAILABLE',
      unprovenAbandonAvailable: true,
    });
    expect(await restarted.resolveAmbiguousRun({ ...input, action: 'ABANDON' })).toMatchObject({
      status: 'BLOCKED',
    });
    expect((await row()).status).toBe('RUNNING');

    const current = await context();
    expect(
      await restarted.resolveAmbiguousRun({
        ...current,
        action: 'ABANDON',
        acceptUnprovenStop: true,
      })
    ).toEqual({ status: 'ABANDONED', unproven: true });
    const ended = await expectUnprovenEnd('WORK_PROOF_UNAVAILABLE');
    const after = await delivery();

    // The provider answers late; maintenance runs; nothing changes and nothing is sent.
    providers[0]!.response.resolve({ stopReason: 'end_turn' });
    await consumer.drain();
    await restarted.drain();
    await consumer.maintain(new AbortController().signal);
    await restarted.maintain(new AbortController().signal);
    await consumer.drain();
    await restarted.drain();
    expect(await row()).toEqual(ended);
    expect(await delivery()).toEqual(after);
    expect(providers).toHaveLength(1);
    expect(providers[0]!.connection.prompt).toHaveBeenCalledOnce();

    // The slot is free: the next queued run of the same automation is claimed.
    expect(await h.owner.claimNextRun()).toMatchObject({ status: 'CLAIMED', runId: nextRunId });
  } finally {
    await restarted.stop();
  }
});

it.each([
  { case: 'completed', pullRequests: [], status: 'COMPLETED' },
  {
    case: 'PR-producing',
    pullRequests: [{ url: 'https://github.com/org/repo/pull/42', number: 42 }],
    status: 'PR_CREATED',
  },
] as const)(
  'keeps the recorded outcome of a $case first turn whose tracking was lost in a restart',
  async ({ pullRequests, status }) => {
    await launch();
    providers[0]!.response.resolve({ stopReason: 'end_turn' });
    await consumer.drain();
    if (pullRequests.length) {
      await db.prisma.agentRun.update({
        where: { id: h.claim.runId },
        data: { result: { version: 1, summary: '', pullRequests: [...pullRequests] } },
      });
    }
    expect((await h.read()).evidence?.outcome?.result).toBe('COMPLETED');
    const restarted = await restart();
    try {
      const input = await context();
      expect(await restarted.inspectRun(input)).toMatchObject({
        blocked: 'WORK_PROOF_UNAVAILABLE',
        unprovenAbandonAvailable: true,
      });
      expect(
        await restarted.resolveAmbiguousRun({
          ...input,
          action: 'ABANDON',
          acceptUnprovenStop: true,
        })
      ).toEqual({ status: 'ABANDONED', unproven: true });
      await expectUnprovenEnd('WORK_PROOF_UNAVAILABLE', status);
    } finally {
      await restarted.stop();
    }
  }
);

it('abandons a run whose first message went ambiguous after a transport disconnect', async () => {
  await disconnect();
  const input = await context();
  expect(await consumer.inspectRun(input)).toMatchObject({
    blocked: 'WORK_PROOF_UNAVAILABLE',
    unprovenAbandonAvailable: true,
  });
  expect(await consumer.resolveAmbiguousRun({ ...input, action: 'ABANDON' })).toMatchObject({
    status: 'BLOCKED',
  });
  expect((await row()).status).toBe('RUNNING');
  const current = await context();
  expect(
    await consumer.resolveAmbiguousRun({ ...current, action: 'ABANDON', acceptUnprovenStop: true })
  ).toEqual({ status: 'ABANDONED', unproven: true });
  const ended = await expectUnprovenEnd('WORK_PROOF_UNAVAILABLE');
  const after = await delivery();

  // Late owner writes for the abandoned attempt are rejected and change nothing.
  const late = h.owner.agentInitialDelivery;
  await expect(
    late.stop(current.attempt, {
      version: 1,
      cause: 'SYSTEM_STOP',
      source: null,
      status: 'LOCAL_RUNTIME_GROUP_STOPPED',
      observedAt: new Date().toISOString(),
    })
  ).rejects.toThrow();
  await expect(late.ambiguous(current.attempt)).rejects.toThrow();
  await consumer.maintain(new AbortController().signal);
  await consumer.drain();
  expect(await row()).toEqual(ended);
  expect(await delivery()).toEqual(after);
  expect(providers[0]!.connection.prompt).toHaveBeenCalledOnce();
});

it('abandons a run whose setup cleanup is uncertain without sending its first message', async () => {
  await h.owner.eventRunLaunch.dispose(h.claim, {
    kind: 'TIMED_OUT',
    cleanup: 'UNKNOWN',
    category: 'TRANSIENT',
  });
  expect(await row()).toMatchObject({
    launchPhase: 'NEEDS_ATTENTION',
    reasonCode: 'PREPARATION_CLEANUP_UNCERTAIN',
  });
  const input = await context();
  expect(await consumer.inspectRun(input)).toMatchObject({
    blocked: 'PREPARATION_CLEANUP_UNCERTAIN',
    unprovenAbandonAvailable: true,
    delivery: 'UNSENT',
  });
  expect(await consumer.resolveAmbiguousRun({ ...input, action: 'ABANDON' })).toMatchObject({
    status: 'BLOCKED',
    reason: 'PREPARATION_CLEANUP_UNCERTAIN',
  });
  const current = await context();
  expect(
    await consumer.resolveAmbiguousRun({ ...current, action: 'ABANDON', acceptUnprovenStop: true })
  ).toEqual({ status: 'ABANDONED', unproven: true });
  await expectUnprovenEnd('PREPARATION_CLEANUP_UNCERTAIN');
  // The never-sent first message cannot be sent later.
  await expect(h.dispatch()).rejects.toThrow();
  await consumer.maintain(new AbortController().signal);
  await consumer.drain();
  expect(providers).toHaveLength(0);
  expect((await delivery()).state).toBe('PENDING');
});

it('rejects a stale context with CONFLICT and changes nothing', async () => {
  await disconnect();
  const input = await context();
  const before = await row();
  await expect(
    consumer.resolveAmbiguousRun({
      ...input,
      attempt: { ...input.attempt, sendAttemptId: 'rotated-elsewhere' },
      action: 'ABANDON',
      acceptUnprovenStop: true,
    })
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await row()).toEqual(before);
});

it('abandons a child-held run that is also unproven without touching the child', async () => {
  await disconnect();
  const child = await h.creation.create({
    projectId: h.workspaceSource.projectId,
    name: 'Child',
    type: 'CHILD_WORKSPACE',
    parentWorkspaceId: h.claim.reservedWorkspaceId,
  });
  const input = await context();
  expect(await consumer.inspectRun(input)).toMatchObject({
    blocked: 'WORK_PROOF_UNAVAILABLE',
    unprovenAbandonAvailable: true,
    childHold: { heldCount: 1 },
  });
  expect(
    await consumer.resolveAmbiguousRun({ ...input, action: 'ABANDON', acceptUnprovenStop: true })
  ).toEqual({ status: 'ABANDONED', unproven: true });
  await expectUnprovenEnd('WORK_PROOF_UNAVAILABLE');
  expect((await h.read()).evidence?.children).toMatchObject({
    counts: { NOT_STARTED: 1 },
    held: [child.id],
  });
  expect(await db.prisma.workspace.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({
    status: 'NEW',
  });
});

it('keeps the proven path when proof is available, even with the opt-in', async () => {
  await launch();
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  await strictStop();
  const input = await context();
  expect(await consumer.inspectRun(input)).toMatchObject({
    blocked: null,
    unprovenAbandonAvailable: false,
  });
  expect(
    await consumer.resolveAmbiguousRun({ ...input, action: 'ABANDON', acceptUnprovenStop: true })
  ).toEqual({ status: 'ABANDONED' });
  expect(await row()).toMatchObject({ status: 'CANCELLED', reasonCode: 'EXPLICIT_ABANDONMENT' });
  const evidence = (await h.read()).evidence;
  expect(evidence?.unprovenAbandon).toBeUndefined();
  expect(evidence?.resolution?.action).toBe('ABANDON');
});
