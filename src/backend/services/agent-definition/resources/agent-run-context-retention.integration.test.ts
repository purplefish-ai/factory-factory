import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { initialDeliveryEvidenceSchema } from '@/shared/event-agent-delivery';
import { Prisma } from '@prisma-gen/client';
import { createLedgerFixture } from './testing/agent-ledger.test-support';

let db: IntegrationDatabase;
let runtime: typeof import('../index');
let config: typeof import('@/backend/services/config.service');
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
let afterQuery:
  | ((model: string | undefined, operation: string) => Promise<void> | void)
  | undefined;
let onTransaction: (() => void) | undefined;
let measuredQueries:
  | { model: string | undefined; operation: string; durationMs: number; finishedAt: number }[]
  | undefined;
let retention: InstanceType<typeof runtime.AgentLedgerRetentionService>;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  const observed = db.prisma.$extends({
    query: {
      $allOperations: async ({ model, operation, args, query }) => {
        const started = performance.now();
        const result = await query(args);
        measuredQueries?.push({
          model,
          operation,
          durationMs: performance.now() - started,
          finishedAt: performance.now(),
        });
        await afterQuery?.(model, operation);
        return result;
      },
    },
  });
  const queued = new Proxy(observed, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== '$transaction') {
        return value;
      }
      return (...args: unknown[]) => {
        const promise = Reflect.apply(value, target, args);
        onTransaction?.();
        return promise;
      };
    },
  });
  vi.doMock('@/backend/db', () => ({ prisma: queued }));
  runtime = await vi.importActual('../index');
  config = await vi.importActual('@/backend/services/config.service');
}, 30_000);
afterAll(async () => {
  vi.doUnmock('@/backend/db');
  await destroyIntegrationDatabase(db);
});
afterEach(() => {
  afterQuery = undefined;
  onTransaction = undefined;
  measuredQueries = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  config.configService.reload();
});
beforeEach(async () => {
  vi.stubEnv('AGENT_RUN_CONTEXT_RETENTION_DAYS', '');
  config.configService.reload();
  fixture = await createLedgerFixture(db, runtime);
  retention = new runtime.AgentLedgerRetentionService();
});
const prune = () => retention.pruneExpired(new AbortController().signal);
const read = () => db.prisma.agentRun.findFirstOrThrow();
async function terminal() {
  await fixture.admit(await fixture.event());
  const run = await read();
  return db.prisma.agentRun.update({
    where: { id: run.id },
    data: {
      status: 'CANCELLED',
      launchPhase: 'FINISHED',
      completedAt: new Date(Date.now() - 2 * 86_400_000),
      errorMessage: 'copied source or instruction text',
      result: {
        version: 1,
        summary: 'Cancelled before sending',
        pullRequests: [{ number: 7, url: 'https://github.com/org/repo/pull/7' }],
      },
    },
  });
}
function enable() {
  vi.stubEnv('AGENT_RUN_CONTEXT_RETENTION_DAYS', '1');
  config.configService.reload();
}

it('retains terminal context indefinitely by default', async () => {
  const before = await terminal();
  await prune();
  expect(await read()).toEqual(before);
});
it('expires eligible terminal copied context only with explicit opt-in, retaining compact results', async () => {
  const before = await terminal();
  const delivery = await db.prisma.agentInitialDelivery.findMany();
  enable();
  const batches = await prune();
  const after = await read();
  expect(after.definitionSnapshot).toMatchObject({ state: 'EXPIRED' });
  expect(after.input).toEqual(after.definitionSnapshot);
  expect(after.triggerSnapshot).toEqual(after.definitionSnapshot);
  expect(after.errorMessage).toBeNull();
  expect(after).toMatchObject({
    id: before.id,
    status: before.status,
    result: before.result,
    reservedWorkspaceId: before.reservedWorkspaceId,
    reservedSessionId: before.reservedSessionId,
  });
  expect(await db.prisma.agentInitialDelivery.findMany()).toEqual(delivery);
  expect(batches.find((batch) => batch.kind === 'runContext')).toMatchObject({
    inspected: 1,
    changed: 1,
  });
});

it.each(['QUEUED', 'RUNNING'] as const)(
  'retains %s even with a stale completedAt',
  async (status) => {
    const before = await terminal();
    await db.prisma.agentRun.update({ where: { id: before.id }, data: { status } });
    enable();
    const batches = await prune();
    expect((await read()).input).toEqual(before.input);
    expect(batches.find((batch) => batch.kind === 'runContext')?.retained).toEqual({
      ACTIVE_RUN: 1,
    });
  }
);
it.each([
  { launchPhase: 'NEEDS_ATTENTION' as const },
  { nextAttemptAt: new Date(0) },
  { leaseExpiresAt: new Date(0) },
  { launchPreparation: { version: 1, state: 'UNKNOWN', setupStartedAt: null } },
])('retains terminal recovery dependency %j', async (data) => {
  await terminal();
  await db.prisma.agentRun.updateMany({ data });
  const before = await read();
  enable();
  await prune();
  expect(await read()).toEqual(before);
});
it.each(['SENDING', 'ACCEPTED', 'AMBIGUOUS'] as const)(
  'retains %s delivery evidence',
  async (state) => {
    await terminal();
    await db.prisma.agentInitialDelivery.updateMany({ data: { state } });
    const before = await read();
    enable();
    await prune();
    expect(await read()).toEqual(before);
  }
);
it.each([
  { input: {} },
  { definitionSnapshot: {} },
  { triggerSnapshot: {} },
  { input: { version: 1, eventId: 'wrong', context: [] } },
  { result: {} },
  { effectiveExecution: {} },
  { launchPreparation: {} },
])('fails closed on corrupted stored context or outcome %j', async (data) => {
  await terminal();
  await db.prisma.agentRun.updateMany({ data });
  const before = await read();
  enable();
  const batches = await prune();
  expect(await read()).toEqual(before);
  expect(batches.find((batch) => batch.kind === 'runContext')?.retained).toEqual({
    INVALID_STORED_DATA: 1,
  });
});
it('retains unresolved evaluation retries in the event cohort', async () => {
  const before = await terminal();
  const trigger = await fixture.secondTrigger();
  await fixture.evaluation(before.eventId!, { triggerId: trigger.id, status: 'ERROR' });
  await db.prisma.agentEvaluation.updateMany({
    where: { triggerId: trigger.id },
    data: { nextAttemptAt: new Date(0) },
  });
  enable();
  await prune();
  expect(await read()).toEqual(before);
});
it('retains a recently completed run until the configured boundary', async () => {
  await terminal();
  await db.prisma.agentRun.updateMany({ data: { completedAt: new Date() } });
  const before = await read();
  enable();
  await prune();
  expect(await read()).toEqual(before);
});
it('rolls back context expiry on shutdown and retries without publishing its cursor', async () => {
  const before = await terminal();
  enable();
  const controller = new AbortController();
  afterQuery = (model, operation) => {
    if (model === 'AgentRun' && operation === 'update') {
      controller.abort();
    }
  };
  await retention.pruneExpired(controller.signal);
  expect(await read()).toEqual(before);
  afterQuery = undefined;
  expect((await prune()).find((batch) => batch.kind === 'runContext')?.changed).toBe(1);
});
it('bounds metrics and rotates past retained candidates, excluding already expired contexts', async () => {
  const eligible = await terminal();
  await db.prisma.agentRun.createMany({
    data: Array.from({ length: 102 }, (_, i) => ({
      id: `a-${String(i).padStart(3, '0')}`,
      agentDefinitionId: eligible.agentDefinitionId,
      idempotencyKey: `blocked-${i}`,
      status: 'RUNNING',
      completedAt: eligible.completedAt,
      definitionSnapshot: eligible.definitionSnapshot!,
      input: eligible.input!,
    })),
  });
  enable();
  expect((await prune()).find((batch) => batch.kind === 'runContext')).toMatchObject({
    inspected: 100,
    changed: 0,
    retained: { ACTIVE_RUN: 100 },
    cursor: 'a-099',
  });
  expect((await prune()).find((batch) => batch.kind === 'runContext')).toMatchObject({
    inspected: 3,
    changed: 1,
    retained: { ACTIVE_RUN: 2 },
  });
  expect((await prune()).find((batch) => batch.kind === 'runContext')).toMatchObject({
    inspected: 100,
    changed: 0,
  });
  const expired = await db.prisma.agentRun.findUniqueOrThrow({ where: { id: eligible.id } });
  expect((await prune()).find((batch) => batch.kind === 'runContext')).toMatchObject({
    inspected: 2,
    changed: 0,
    retained: { ACTIVE_RUN: 2 },
  });
  expect(await db.prisma.agentRun.findUniqueOrThrow({ where: { id: eligible.id } })).toEqual(
    expired
  );
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it('rechecks terminal state after a concurrent ledger transition commits', async () => {
  const before = await terminal();
  enable();
  const { ledgerTransaction } = await vi.importActual<typeof import('./agent-ledger-transaction')>(
    './agent-ledger-transaction'
  );
  const { agentRunContextRetentionAccessor } = await vi.importActual<
    typeof import('./agent-run-context-retention.accessor')
  >('./agent-run-context-retention.accessor');
  const acquired = deferred();
  const release = deferred();
  const queued = deferred();
  const blocker = ledgerTransaction(async (tx) => {
    acquired.resolve();
    await release.promise;
    await tx.agentRun.update({
      where: { id: before.id },
      data: { status: 'RUNNING', nextAttemptAt: new Date() },
    });
  });
  let contender: ReturnType<typeof agentRunContextRetentionAccessor.pruneBatch> | undefined;
  try {
    await acquired.promise;
    onTransaction = queued.resolve;
    contender = agentRunContextRetentionAccessor.pruneBatch(null, () => undefined);
    await queued.promise;
    release.resolve();
    await blocker;
    expect(await contender).toMatchObject({ changed: 0, retained: { ACTIVE_RUN: 1 } });
    expect(
      (await db.prisma.agentRun.findUniqueOrThrow({ where: { id: before.id } })).input
    ).toEqual(before.input);
  } finally {
    release.resolve();
    await Promise.allSettled([blocker, contender]);
  }
});

async function sentTerminal() {
  const before = await terminal();
  const source = {
    version: 1,
    provider: 'CLAUDE',
    providerSessionId: 'provider-session',
    runtimeIncarnationId: 'incarnation',
    lifecycleGeneration: 1,
  };
  const delivery = await db.prisma.agentInitialDelivery.findUniqueOrThrow({
    where: { runId: before.id },
  });
  await db.prisma.agentRun.update({
    where: { id: before.id },
    data: {
      status: 'PR_CREATED',
      workerGeneration: 1,
      launchPreparation: { version: 1, state: 'STARTUP', setupStartedAt: new Date().toISOString() },
    },
  });
  await db.prisma.agentInitialDelivery.update({
    where: { runId: before.id },
    data: {
      state: 'FINISHED',
      sendingAt: before.completedAt,
      finishedAt: before.completedAt,
      evidence: {
        version: 1,
        attempt: {
          runId: before.id,
          sessionId: before.reservedSessionId!,
          workerGeneration: 1,
          attemptGeneration: 1,
          messageId: delivery.messageId,
          sendAttemptId: delivery.sendAttemptId,
        },
        source,
        outcome: { source, result: 'COMPLETED', stopReason: 'end_turn' },
        work: {
          version: 1,
          source,
          revision: 1,
          coverageGeneration: 1,
          mode: 'LIVE',
          observedAt: new Date().toISOString(),
        },
      },
    },
  });
  const definition = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: before.agentDefinitionId },
  });
  await db.prisma.workspaceLaunchOrigin.create({
    data: {
      runId: before.id,
      workspaceId: before.reservedWorkspaceId!,
      projectId: definition.projectId,
      childHistoryVersion: 1,
    },
  });
  return { run: await read(), projectId: definition.projectId };
}
/**
 * What ABANDON with `acceptUnprovenStop` writes for an ambiguous send: the
 * delivery stays AMBIGUOUS with an UNKNOWN observed stop and no work proof.
 */
async function unprovenAbandoned(markerGeneration: number | null = 1) {
  const before = await terminal();
  const delivery = await db.prisma.agentInitialDelivery.findUniqueOrThrow({
    where: { runId: before.id },
  });
  const attempt = {
    runId: before.id,
    sessionId: before.reservedSessionId!,
    workerGeneration: 1,
    attemptGeneration: 1,
    messageId: delivery.messageId,
    sendAttemptId: delivery.sendAttemptId,
  };
  const source = {
    version: 1,
    provider: 'CLAUDE',
    providerSessionId: 'provider-session',
    runtimeIncarnationId: 'incarnation',
    lifecycleGeneration: 1,
  } as const;
  await db.prisma.agentRun.update({
    where: { id: before.id },
    data: {
      reasonCode: 'ABANDONED_UNPROVEN',
      workerGeneration: 2,
      launchPreparation: { version: 1, state: 'STARTUP', setupStartedAt: new Date().toISOString() },
    },
  });
  await db.prisma.agentInitialDelivery.update({
    where: { runId: before.id },
    data: {
      state: 'AMBIGUOUS',
      sendingAt: before.completedAt,
      evidence: initialDeliveryEvidenceSchema.parse({
        version: 1,
        attempt,
        source,
        stop: {
          version: 1,
          cause: 'SYSTEM_STOP',
          source,
          status: 'UNKNOWN',
          observedAt: new Date().toISOString(),
        },
        ...(markerGeneration !== null
          ? {
              unprovenAbandon: {
                version: 1,
                attempt: { ...attempt, workerGeneration: markerGeneration },
                reason: 'WORK_PROOF_UNAVAILABLE',
                decidedAt: new Date().toISOString(),
              },
            }
          : {}),
      }),
    },
  });
  return read();
}
it('expires the context of a run a person abandoned without a proven stop', async () => {
  await unprovenAbandoned();
  enable();
  const batches = await prune();
  expect(batches.find((batch) => batch.kind === 'runContext')).toMatchObject({ changed: 1 });
  expect((await read()).contextExpiredAt).not.toBeNull();
});
it.each([
  { case: 'no marker', markerGeneration: null },
  // The decision's own write increments the generation, so its marker is exactly one behind.
  { case: 'a marker from another generation', markerGeneration: 2 },
])('fails closed on an unproven-abandonment reason with $case', async ({ markerGeneration }) => {
  const before = await unprovenAbandoned(markerGeneration);
  enable();
  const batches = await prune();
  expect(await read()).toEqual(before);
  expect(batches.find((batch) => batch.kind === 'runContext')?.retained).toEqual({
    INVALID_STORED_DATA: 1,
  });
});
it('keeps retaining an ambiguous send that was not abandoned', async () => {
  const before = await unprovenAbandoned(null);
  await db.prisma.agentRun.update({ where: { id: before.id }, data: { reasonCode: null } });
  enable();
  const batches = await prune();
  expect(batches.find((batch) => batch.kind === 'runContext')?.retained).toEqual({
    RECOVERY_DEPENDENCY: 1,
  });
});
it('keeps history, compact outcome, delivery evidence and origins readable after sent context expires', async () => {
  const { run, projectId } = await sentTerminal();
  const delivery = await db.prisma.agentInitialDelivery.findMany();
  const origins = await db.prisma.workspaceLaunchOrigin.findMany();
  enable();
  await prune();
  const management = new runtime.AgentManagementService();
  const history = await management.runs({ projectId, agentId: run.agentDefinitionId });
  expect(history.items[0]).toMatchObject({
    id: run.id,
    status: 'PR_CREATED',
    result: run.result,
    context: { state: 'EXPIRED' },
    initialOutcome: { result: 'COMPLETED', stopReason: 'end_turn' },
  });
  expect(await db.prisma.agentInitialDelivery.findMany()).toEqual(delivery);
  expect(await db.prisma.workspaceLaunchOrigin.findMany()).toEqual(origins);
});
it('expires terminal context while its workspace has retained child work', async () => {
  await sentTerminal();
  await db.prisma.agentRun.updateMany({
    data: { launchPreparation: { version: 1, state: 'SAFE', setupStartedAt: null } },
  });
  const run = await read();
  await db.prisma.workspaceChildOrigin.create({
    data: { parentWorkspaceId: run.reservedWorkspaceId!, childWorkspaceId: 'retained-child' },
  });
  enable();
  await prune();
  expect((await read()).contextExpiredAt).not.toBeNull();
});

it.each(['missing', 'legacy', 'workspace', 'project'] as const)(
  'expires sent terminal context with %s child-history coverage',
  async (corruption) => {
    const { run } = await sentTerminal();
    if (corruption === 'missing') {
      await db.prisma.workspaceLaunchOrigin.delete({ where: { runId: run.id } });
    } else {
      await db.prisma.workspaceLaunchOrigin.update({
        where: { runId: run.id },
        data: {
          ...(corruption === 'legacy' ? { childHistoryVersion: null } : {}),
          ...(corruption === 'workspace' ? { workspaceId: 'other-workspace' } : {}),
          ...(corruption === 'project' ? { projectId: 'other-project' } : {}),
        },
      });
    }
    enable();
    await prune();
    expect((await read()).contextExpiredAt).not.toBeNull();
  }
);

it('retains inconsistent abandonment proof even when the initial outcome completed', async () => {
  const { run } = await sentTerminal();
  const delivery = await db.prisma.agentInitialDelivery.findUniqueOrThrow({
    where: { runId: run.id },
  });
  const proof = initialDeliveryEvidenceSchema.parse(delivery.evidence);
  const stop = {
    version: 1,
    cause: 'USER_STOP',
    source: proof.source!,
    status: 'UNKNOWN',
    observedAt: new Date().toISOString(),
  } as const;
  await db.prisma.agentInitialDelivery.update({
    where: { runId: run.id },
    data: {
      state: 'AMBIGUOUS',
      evidence: {
        ...proof,
        stop,
        resolution: {
          action: 'ABANDON',
          attempt: proof.attempt,
          outcome: proof.outcome!,
          stop,
          work: proof.work!,
          resolvedAt: new Date().toISOString(),
        },
      },
    },
  });
  await db.prisma.agentRun.update({ where: { id: run.id }, data: { status: 'CANCELLED' } });
  const before = await read();
  enable();
  await prune();
  expect(await read()).toEqual(before);
});

it('previews prospective expiry without writes or enabling policy and matches actual byte impact', async () => {
  const before = await terminal();
  const rowsBefore = await db.prisma.agentRun.findMany();
  const deliveriesBefore = await db.prisma.agentInitialDelivery.findMany();
  const evaluationsBefore = await db.prisma.agentEvaluation.findMany();
  measuredQueries = [];
  const preview = await retention.inspectRunContexts(
    { retentionDays: 1 },
    new AbortController().signal
  );
  const operations = measuredQueries.map((query) => query.operation);
  measuredQueries = undefined;
  expect(preview).toMatchObject({
    inspected: 1,
    eligible: 1,
    retained: {},
    retentionDays: 1,
    policySource: 'PREVIEW',
  });
  expect(operations.length).toBeGreaterThan(0);
  expect(operations.every((operation) => operation.startsWith('find'))).toBe(true);
  expect(await db.prisma.agentRun.findMany()).toEqual(rowsBefore);
  expect(await db.prisma.agentInitialDelivery.findMany()).toEqual(deliveriesBefore);
  expect(await db.prisma.agentEvaluation.findMany()).toEqual(evaluationsBefore);
  expect(config.configService.getAgentRuntimeLimits().runContextRetentionMs).toBeNull();
  enable();
  await prune();
  const after = await read();
  const bytes = (row: typeof before) =>
    [row.definitionSnapshot, row.triggerSnapshot, row.input].reduce<number>(
      (sum, value) => sum + (value === null ? 0 : Buffer.byteLength(JSON.stringify(value))),
      0
    ) + Buffer.byteLength(row.errorMessage ?? '');
  expect(preview.byteImpact.eligibleBefore).toBe(bytes(before));
  expect(preview.byteImpact.eligibleAfter).toBe(bytes(after));
  expect(preview.byteImpact.eligibleDelta).toBe(bytes(after) - bytes(before));
});

it('retains by default during inspection and does not advance the maintenance cursor', async () => {
  const before = await terminal();
  expect(await retention.inspectRunContexts({}, new AbortController().signal)).toMatchObject({
    retentionDays: null,
    policySource: 'CONFIGURED',
    inspected: 0,
    eligible: 0,
  });
  const preview = await retention.inspectRunContexts(
    { retentionDays: 1 },
    new AbortController().signal
  );
  expect(preview.eligible).toBe(1);
  expect(await read()).toEqual(before);
  enable();
  expect((await prune()).find((batch) => batch.kind === 'runContext')).toMatchObject({
    inspected: 1,
    changed: 1,
  });
});

it.each(['missing', 'corrupt'] as const)(
  'inspection does not depend on %s child-history origin proof once terminal',
  async (corruption) => {
    const { run } = await sentTerminal();
    if (corruption === 'missing') {
      await db.prisma.workspaceLaunchOrigin.delete({ where: { runId: run.id } });
    } else {
      await db.prisma.workspaceLaunchOrigin.update({
        where: { runId: run.id },
        data: { projectId: 'other-project' },
      });
    }
    const preview = await retention.inspectRunContexts(
      { retentionDays: 1 },
      new AbortController().signal
    );
    expect(preview).toMatchObject({ inspected: 1, eligible: 1 });
    expect(preview.retained).toEqual({});
    // Preview is read-only.
    expect(await read()).toEqual(run);
  }
);

it('bounds a mixed fixture preview, measures its impact and preserves the maintenance cursor', async () => {
  await terminal();
  await db.prisma.agentRun.updateMany({
    data: {
      definitionSnapshot: {
        name: 'Fixture',
        instructions: 'fixture instruction '.repeat(256),
        isEnabled: true,
        executionConfig: { version: 1, provider: 'CLAUDE', model: 'sonnet' },
      },
      input: {
        version: 1,
        eventId: (await read()).eventId!,
        context: [{ id: 'fixture-source', text: 'context-🧵'.repeat(512) }],
      },
    },
  });
  const original = await read();
  const fixtureRows = Array.from({ length: 100 }, (_, i) => ({
    id: `m-${String(i).padStart(3, '0')}`,
    agentDefinitionId: original.agentDefinitionId,
    triggerId: original.triggerId,
    idempotencyKey: `measurement-${i}`,
    status: i < 50 ? ('CANCELLED' as const) : ('RUNNING' as const),
    launchPhase: 'FINISHED' as const,
    completedAt: original.completedAt,
    reservedWorkspaceId: `fixture-workspace-${i}`,
    reservedSessionId: `fixture-session-${i}`,
    initialMessageId: `fixture-message-${i}`,
    definitionSnapshot: original.definitionSnapshot!,
    triggerSnapshot: original.triggerSnapshot!,
    input: original.input!,
    errorMessage: original.errorMessage,
  }));
  await db.prisma.agentRun.createMany({ data: fixtureRows });
  await db.prisma.agentInitialDelivery.createMany({
    data: fixtureRows.map((row, i) => ({
      runId: row.id,
      messageId: row.initialMessageId,
      sendAttemptId: `fixture-send-${i}`,
    })),
  });
  const before = await db.prisma.agentRun.findMany({ orderBy: { id: 'asc' } });
  measuredQueries = [];
  const inspectStarted = performance.now();
  const preview = await retention.inspectRunContexts(
    { retentionDays: 1 },
    new AbortController().signal
  );
  const inspectElapsedMs = performance.now() - inspectStarted;
  const inspectQueries = measuredQueries;
  measuredQueries = undefined;
  expect(preview).toMatchObject({ inspected: 100, eligible: 51, retained: { ACTIVE_RUN: 49 } });
  expect(inspectQueries.length).toBeGreaterThan(0);
  expect(inspectQueries.every((query) => query.operation.startsWith('find'))).toBe(true);
  expect(await db.prisma.agentRun.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  expect(
    await retention.inspectRunContexts(
      { retentionDays: 1, after: preview.cursor },
      new AbortController().signal
    )
  ).toMatchObject({ inspected: 1, eligible: 0, retained: { ACTIVE_RUN: 1 } });
  enable();
  measuredQueries = [];
  const pruneStarted = performance.now();
  const results = await prune();
  const pruneFinished = performance.now();
  const pruneQueries = measuredQueries;
  measuredQueries = undefined;
  expect(results.find((batch) => batch.kind === 'runContext')).toMatchObject({
    inspected: 100,
    changed: 51,
    retained: { ACTIVE_RUN: 49 },
  });
  const after = await db.prisma.agentRun.findMany({ orderBy: { id: 'asc' } });
  expect(after.filter((run) => run.contextExpiredAt !== null)).toHaveLength(51);
  expect(after.filter((run) => run.status === 'RUNNING')).toEqual(
    before.filter((run) => run.status === 'RUNNING')
  );
  const bytes = (rows: typeof before) =>
    rows.reduce(
      (sum, row) =>
        sum +
        [row.definitionSnapshot, row.triggerSnapshot, row.input].reduce<number>(
          (subtotal, value) =>
            subtotal + (value === null ? 0 : Buffer.byteLength(JSON.stringify(value))),
          0
        ) +
        Buffer.byteLength(row.errorMessage ?? ''),
      0
    );
  expect(bytes(after) - bytes(before)).toBe(preview.byteImpact.eligibleDelta);
  const lookups = (queries: typeof inspectQueries) =>
    queries.filter((query) => query.operation.startsWith('find'));
  const lookupMs = (queries: typeof inspectQueries) =>
    lookups(queries).reduce((sum, query) => sum + query.durationMs, 0);
  const lockAcquired = pruneQueries
    .filter((query) => query.operation === '$executeRaw')
    .at(-1)!.finishedAt;
  const measurement = {
    fixture: {
      candidates: 101,
      inspected: preview.inspected,
      eligible: preview.eligible,
      retained: preview.retained,
      textRepeat: 512,
      instructionRepeat: 256,
    },
    byteImpact: preview.byteImpact,
    inspection: {
      elapsedMs: inspectElapsedMs,
      prismaLookupCount: lookups(inspectQueries).length,
      prismaLookupMs: lookupMs(inspectQueries),
      writeStatements: 0,
    },
    pruning: {
      elapsedMs: pruneFinished - pruneStarted,
      contextLockScopeObservedMs: pruneFinished - lockAcquired,
      prismaLookupCount: lookups(pruneQueries).length,
      prismaLookupMs: lookupMs(pruneQueries),
    },
  };
  process.stdout.write(`RUN_CONTEXT_FIXTURE_MEASUREMENT ${JSON.stringify(measurement)}\n`);
}, 30_000);

it.each(['launchPreparation', 'effectiveExecution', 'result', 'deliveryEvidence'] as const)(
  'retains malformed JSON null %s while preserving legitimate SQL null',
  async (field) => {
    const run = await terminal();
    const writeNull = async (value: typeof Prisma.JsonNull | typeof Prisma.DbNull) => {
      if (field === 'deliveryEvidence') {
        await db.prisma.agentInitialDelivery.update({
          where: { runId: run.id },
          data: { evidence: value },
        });
      } else {
        await db.prisma.agentRun.update({ where: { id: run.id }, data: { [field]: value } });
      }
    };
    await writeNull(Prisma.JsonNull);
    const before = await read();
    const delivery = await db.prisma.agentInitialDelivery.findUniqueOrThrow({
      where: { runId: run.id },
    });
    expect(
      await retention.inspectRunContexts({ retentionDays: 1 }, new AbortController().signal)
    ).toMatchObject({
      inspected: 1,
      eligible: 0,
      retained: { INVALID_STORED_DATA: 1 },
    });
    enable();
    await prune();
    expect(await read()).toEqual(before);
    expect(
      await db.prisma.agentInitialDelivery.findUniqueOrThrow({ where: { runId: run.id } })
    ).toEqual(delivery);
    await writeNull(Prisma.DbNull);
    expect((await prune()).find((batch) => batch.kind === 'runContext')).toMatchObject({
      inspected: 1,
      changed: 1,
    });
  }
);

it('ends an inspection scan without wrapping or changing the maintenance cursor', async () => {
  const before = await terminal();
  const first = await retention.inspectRunContexts(
    { retentionDays: 1 },
    new AbortController().signal
  );
  expect(first).toMatchObject({ inspected: 1, eligible: 1, cursor: before.id });
  expect(
    await retention.inspectRunContexts(
      { retentionDays: 1, after: first.cursor },
      new AbortController().signal
    )
  ).toMatchObject({
    inspected: 0,
    eligible: 0,
    cursor: null,
  });
  expect(
    await retention.inspectRunContexts({ after: first.cursor }, new AbortController().signal)
  ).toMatchObject({
    inspected: 0,
    eligible: 0,
    retentionDays: null,
    cursor: null,
  });
  expect(await read()).toEqual(before);
  enable();
  expect((await prune()).find((batch) => batch.kind === 'runContext')).toMatchObject({
    inspected: 1,
    changed: 1,
  });
});
