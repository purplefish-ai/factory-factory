import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { EventAgentExecution } from '@/shared/event-agent-launch';
import { createLedgerFixture } from './testing/agent-ledger.test-support';
let db: IntegrationDatabase;
let runtime: typeof import('@/backend/services/agent-definition/index');
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
const execution: EventAgentExecution = {
  version: 1,
  provider: 'CLAUDE',
  model: 'sonnet',
  reasoningEffort: null,
  codexAccountId: null,
  startupModePreset: 'non_interactive',
  accessMode: 'bypassPermissions',
  planModeEnabled: false,
};
const source = {
  version: 1 as const,
  provider: 'CLAUDE' as const,
  providerSessionId: 'native-session',
  runtimeIncarnationId: 'runtime-1',
  lifecycleGeneration: 1,
};
beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual<typeof import('@/backend/services/agent-definition/index')>(
    '@/backend/services/agent-definition/index'
  );
}, 30_000);
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
async function setup() {
  await fixture.admit(await fixture.event());
  const claim = await runtime.claimNextRun();
  if (claim.status !== 'CLAIMED') {
    throw new Error('Expected claim');
  }
  const binding = await runtime.readEventExecutionBinding(claim);
  await runtime.freezeEventExecution({ claim, ...binding, execution });
  return {
    runId: claim.runId,
    sessionId: claim.reservedSessionId,
    workerGeneration: claim.workerGeneration,
    attemptGeneration: claim.attemptGeneration,
    messageId: binding.messageId,
    sendAttemptId: binding.sendAttemptId,
  };
}
it('persists correlated terminal evidence without settling capacity or changing original identity', async () => {
  const attempt = await setup();
  await runtime.agentInitialDelivery.beforeSend(attempt, source);
  await runtime.agentInitialDelivery.outcome(attempt, {
    source,
    stopReason: 'end_turn',
    result: 'COMPLETED',
  });
  const fence = await runtime.agentInitialDelivery.readFence(attempt.runId, attempt.sessionId);
  expect(fence.state).toBe('FINISHED');
  expect(fence.evidence?.outcome?.result).toBe('COMPLETED');
  const run = await db.prisma.agentRun.findUniqueOrThrow({ where: { id: attempt.runId } });
  expect(run.status).toBe('RUNNING');
  expect(run.initialMessageId).toBe(attempt.messageId);
});
it('rejects expired pre-send claims and never re-sends SENDING', async () => {
  const attempt = await setup();
  await db.prisma.agentRun.update({
    where: { id: attempt.runId },
    data: { leaseExpiresAt: new Date(0) },
  });
  await expect(runtime.agentInitialDelivery.beforeSend(attempt, source)).rejects.toThrow();
  await db.prisma.agentRun.update({
    where: { id: attempt.runId },
    data: { leaseExpiresAt: new Date(Date.now() + 60_000) },
  });
  await runtime.agentInitialDelivery.beforeSend(attempt, source);
  await expect(runtime.agentInitialDelivery.beforeSend(attempt, source)).rejects.toThrow();
});
it.each([
  'workerGeneration',
  'attemptGeneration',
  'sendAttemptId',
  'messageId',
  'sessionId',
] as const)('fences late callbacks by %s', async (key) => {
  const attempt = await setup();
  await runtime.agentInitialDelivery.beforeSend(attempt, source);
  const stale = {
    ...attempt,
    [key]: typeof attempt[key] === 'number' ? Number(attempt[key]) + 1 : 'old',
  };
  await expect(
    runtime.agentInitialDelivery.outcome(stale, {
      source,
      stopReason: 'end_turn',
      result: 'COMPLETED',
    })
  ).rejects.toThrow();
  expect(
    (await runtime.agentInitialDelivery.readFence(attempt.runId, attempt.sessionId)).state
  ).toBe('SENDING');
});
it('rejects stale provider incarnation and does not overwrite a terminal outcome', async () => {
  const attempt = await setup();
  await runtime.agentInitialDelivery.beforeSend(attempt, source);
  await expect(
    runtime.agentInitialDelivery.outcome(attempt, {
      source: { ...source, runtimeIncarnationId: 'old' },
      stopReason: 'end_turn',
      result: 'COMPLETED',
    })
  ).rejects.toThrow();
  await runtime.agentInitialDelivery.outcome(attempt, {
    source,
    stopReason: 'end_turn',
    result: 'COMPLETED',
  });
  await expect(
    runtime.agentInitialDelivery.outcome(attempt, {
      source,
      stopReason: 'cancelled',
      result: 'CANCELLED',
    })
  ).rejects.toThrow();
});
it('keeps shutdown stop evidence separate from ambiguous initial outcome', async () => {
  const attempt = await setup();
  await runtime.agentInitialDelivery.beforeSend(attempt, source);
  await runtime.agentInitialDelivery.ambiguous(attempt);
  await runtime.agentInitialDelivery.stop(attempt, {
    version: 1,
    cause: 'SHUTDOWN',
    source,
    status: 'LOCAL_RUNTIME_GROUP_STOPPED',
    observedAt: new Date().toISOString(),
  });
  const fence = await runtime.agentInitialDelivery.readFence(attempt.runId, attempt.sessionId);
  expect(fence.state).toBe('AMBIGUOUS');
  expect(fence.evidence?.outcome).toBeUndefined();
  expect(fence.evidence?.stop?.cause).toBe('SHUTDOWN');
});
it('allows a new worker to fence the same interrupted attempt while rejecting the old worker', async () => {
  const attempt = await setup();
  await runtime.agentInitialDelivery.beforeSend(attempt, source);
  await db.prisma.agentRun.update({
    where: { id: attempt.runId },
    data: { workerGeneration: attempt.workerGeneration + 1 },
  });
  await runtime.agentInitialDelivery.ambiguous({
    ...attempt,
    workerGeneration: attempt.workerGeneration + 1,
  });
  await expect(
    runtime.agentInitialDelivery.outcome(attempt, {
      source,
      stopReason: 'end_turn',
      result: 'COMPLETED',
    })
  ).rejects.toThrow();
  expect(
    (await runtime.agentInitialDelivery.readFence(attempt.runId, attempt.sessionId)).state
  ).toBe('AMBIGUOUS');
});

it('records a later human runtime stop without changing the original initial outcome', async () => {
  const attempt = await setup();
  await runtime.agentInitialDelivery.beforeSend(attempt, source);
  const laterSource = {
    ...source,
    runtimeIncarnationId: 'later-human-runtime',
    lifecycleGeneration: 2,
  };
  const stop = {
    version: 1 as const,
    cause: 'USER_STOP' as const,
    source: laterSource,
    status: 'LOCAL_RUNTIME_GROUP_STOPPED' as const,
    observedAt: new Date().toISOString(),
  };
  await expect(runtime.agentInitialDelivery.stop(attempt, stop)).rejects.toThrow();
  await runtime.agentInitialDelivery.outcome(attempt, {
    source,
    stopReason: 'end_turn',
    result: 'COMPLETED',
  });
  await runtime.agentInitialDelivery.stop(attempt, stop);
  const fence = await runtime.agentInitialDelivery.readFence(attempt.runId, attempt.sessionId);
  expect(fence.evidence?.outcome?.source).toEqual(source);
  expect(fence.evidence?.stop?.source).toEqual(laterSource);
  expect(fence.state).toBe('FINISHED');
});
it.each(['COMPLETED', 'CANCELLED'] as const)(
  'rejects inconsistent %s terminal evidence',
  async (result) => {
    const attempt = await setup();
    await runtime.agentInitialDelivery.beforeSend(attempt, source);
    await expect(
      runtime.agentInitialDelivery.outcome(attempt, {
        source,
        result,
        stopReason: result === 'COMPLETED' ? 'cancelled' : 'end_turn',
      })
    ).rejects.toThrow();
    expect(
      (await runtime.agentInitialDelivery.readFence(attempt.runId, attempt.sessionId)).state
    ).toBe('SENDING');
  }
);
it('rejects ambiguous callbacks after run settlement', async () => {
  const attempt = await setup();
  await runtime.agentInitialDelivery.beforeSend(attempt, source);
  await db.prisma.agentRun.update({ where: { id: attempt.runId }, data: { status: 'CANCELLED' } });
  await expect(runtime.agentInitialDelivery.ambiguous(attempt)).rejects.toThrow();
  expect(
    (await runtime.agentInitialDelivery.readFence(attempt.runId, attempt.sessionId)).state
  ).toBe('SENDING');
});
it('rejects inconsistent stored delivery generation before startup', async () => {
  const attempt = await setup();
  await db.prisma.agentInitialDelivery.update({
    where: { runId: attempt.runId },
    data: { attemptGeneration: attempt.attemptGeneration + 1 },
  });
  await expect(
    runtime.agentInitialDelivery.readFence(attempt.runId, attempt.sessionId)
  ).rejects.toThrow();
});
