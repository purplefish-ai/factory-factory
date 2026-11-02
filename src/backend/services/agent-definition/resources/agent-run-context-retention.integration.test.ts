import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { createLedgerFixture } from './testing/agent-ledger.test-support';

let db: IntegrationDatabase;
let runtime: typeof import('../index');
let config: typeof import('@/backend/services/config.service');
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
let afterQuery:
  | ((model: string | undefined, operation: string) => Promise<void> | void)
  | undefined;
let onTransaction: (() => void) | undefined;
let retention: InstanceType<typeof runtime.AgentLedgerRetentionService>;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  const observed = db.prisma.$extends({
    query: {
      $allOperations: async ({ model, operation, args, query }) => {
        const result = await query(args);
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
it('retains terminal context with surviving child work/provenance dependencies', async () => {
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
  expect(await read()).toEqual(run);
});
