import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { Prisma } from '@prisma-gen/client';
import { createLedgerFixture } from './testing/agent-ledger.test-support';

const DAY = 86_400_000;
let db: IntegrationDatabase;
let runtime: typeof import('../index');
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
let retention: InstanceType<typeof runtime.AgentLedgerRetentionService>;
let onTransaction: (() => void) | undefined;
let afterQuery:
  | ((model: string | undefined, operation: string) => Promise<void> | void)
  | undefined;
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
}, 30_000);
afterAll(async () => {
  vi.doUnmock('@/backend/db');
  await destroyIntegrationDatabase(db);
});
afterEach(() => {
  afterQuery = undefined;
  onTransaction = undefined;
  vi.useRealTimers();
});
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
  retention = new runtime.AgentLedgerRetentionService();
});
const prune = () => retention.pruneExpired(new AbortController().signal);
function time(value: Date) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(value);
}
async function row(eventId: string) {
  return await db.prisma.agentEvent.findUniqueOrThrow({ where: { id: eventId } });
}
async function terminal(status: 'FAILED' | 'CANCELLED' | 'COMPLETED' = 'FAILED') {
  const eventId = await fixture.event();
  await fixture.admit(eventId);
  const run = await db.prisma.agentRun.findFirstOrThrow();
  const updated = await db.prisma.agentRun.update({
    where: { id: run.id },
    data: {
      status,
      launchPhase: 'FINISHED',
      completedAt: new Date(),
      reasonCode: 'RETAINED_OUTCOME',
      result: {
        version: 1,
        summary: 'Retained outcome',
        pullRequests: [{ number: 7, url: 'https://github.com/org/repo/pull/7' }],
      },
    },
  });
  const definition = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: fixture.definitionId },
  });
  await db.prisma.workspaceLaunchOrigin.create({
    data: {
      runId: run.id,
      workspaceId: run.reservedWorkspaceId!,
      projectId: definition.projectId,
      childHistoryVersion: 1,
    },
  });
  await db.prisma.agentSessionLaunchOrigin.create({
    data: {
      runId: run.id,
      sessionId: run.reservedSessionId!,
      workspaceId: run.reservedWorkspaceId!,
      execution: { version: 1, retained: true },
    },
  });
  await db.prisma.workspaceChildOrigin.create({
    data: { parentWorkspaceId: run.reservedWorkspaceId!, childWorkspaceId: 'deleted-child' },
  });
  return { eventId, run: updated, event: await row(eventId) };
}

it.each(['FAILED', 'CANCELLED', 'COMPLETED'] as const)(
  'prunes evaluations before real-FK identity deletion, preserving %s histories and origins',
  async (status) => {
    const { eventId, event, run } = await terminal(status);
    const origins = [
      await db.prisma.workspaceLaunchOrigin.findMany(),
      await db.prisma.agentSessionLaunchOrigin.findMany(),
      await db.prisma.workspaceChildOrigin.findMany(),
    ];
    const delivery = await db.prisma.agentInitialDelivery.findMany();
    time(new Date(event.payloadExpiresAt.getTime() - 1));
    await prune();
    expect((await row(eventId)).payload).not.toBeNull();
    expect(await db.prisma.agentEvaluation.count()).toBe(1);
    vi.setSystemTime(event.payloadExpiresAt);
    await prune();
    expect((await row(eventId)).payload).toBeNull();
    expect(await db.prisma.agentEvaluation.count()).toBe(0);
    vi.setSystemTime(new Date(event.identityExpiresAt.getTime() - 1));
    await prune();
    expect(await db.prisma.agentEvent.count()).toBe(1);
    vi.setSystemTime(event.identityExpiresAt);
    await prune();
    expect(await db.prisma.agentEvent.count()).toBe(0);
    expect(await db.prisma.agentRun.findFirstOrThrow()).toEqual({ ...run, eventId: null });
    expect([
      await db.prisma.workspaceLaunchOrigin.findMany(),
      await db.prisma.agentSessionLaunchOrigin.findMany(),
      await db.prisma.workspaceChildOrigin.findMany(),
    ]).toEqual(origins);
    expect(await db.prisma.agentInitialDelivery.findMany()).toEqual(delivery);
    expect(await db.prisma.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
  }
);

it.each(['AgentEvaluation', 'AgentEvent'])(
  'rolls back %s deletion and retries its unpublished cursor',
  async (model) => {
    const { eventId, event } = await terminal();
    time(event.identityExpiresAt);
    afterQuery = (queried, operation) => {
      if (queried === model && operation === 'delete') {
        throw new Error('injected rollback');
      }
    };
    await expect(prune()).rejects.toThrow('injected rollback');
    expect(await db.prisma.agentEvent.count()).toBe(1);
    // An identity-batch failure leaves the already committed evaluation pass removed.
    expect(await db.prisma.agentEvaluation.count()).toBe(model === 'AgentEvaluation' ? 1 : 0);
    afterQuery = undefined;
    await prune();
    expect(await db.prisma.agentEvent.findUnique({ where: { id: eventId } })).toBeNull();
    expect(await db.prisma.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
  }
);

it('uses occurredAt expiry despite delayed observation', async () => {
  const input = fixture.github('delayed');
  const occurredAt = new Date(Date.now() - 91 * DAY);
  input.payload.occurredAt = occurredAt.toISOString();
  const { eventId } = await runtime.ingestEvent(input);
  await fixture.finalize({ connectionId: fixture.connectionId, eventIds: [eventId] });
  expect((await row(eventId)).identityExpiresAt.getTime()).toBe(occurredAt.getTime() + 90 * DAY);
  await prune();
  expect(await db.prisma.agentEvent.count()).toBe(0);
});

it('advances bounded inspected candidates past retained prefixes and wraps after resolution', async () => {
  const { event } = await terminal();
  await db.prisma.agentEvent.deleteMany();
  // Independent malformed source identities must not hide a later eligible connection.
  const blocked = await db.prisma.agentConnection.create({
    data: {
      provider: 'GITHUB',
      externalId: 'gh:blocked',
      name: 'Blocked',
      sourceState: { create: { cursor: { invalid: true } } },
    },
  });
  await db.prisma.agentEvent.createMany({
    data: Array.from({ length: 102 }, (_, i) => ({
      id: `a-${String(i).padStart(3, '0')}`,
      connectionId: blocked.id,
      providerEventId: `bad-${i}`,
      sourceOrder: i + 1,
      occurredAt: event.occurredAt,
      observedAt: event.observedAt,
      payloadExpiresAt: event.payloadExpiresAt,
      identityExpiresAt: event.identityExpiresAt,
    })),
  });
  await db.prisma.agentEvent.create({
    data: {
      id: 'z-eligible',
      connectionId: fixture.connectionId,
      providerEventId: 'eligible',
      sourceOrder: 1,
      occurredAt: event.occurredAt,
      observedAt: event.observedAt,
      payloadExpiresAt: event.payloadExpiresAt,
      identityExpiresAt: event.identityExpiresAt,
    },
  });
  time(event.identityExpiresAt);
  const first = await prune();
  expect(first.find((batch) => batch.kind === 'identity')).toMatchObject({
    inspected: 100,
    changed: 0,
    cursor: 'a-099',
  });
  const second = await prune();
  expect(second.find((batch) => batch.kind === 'identity')).toMatchObject({
    inspected: 3,
    changed: 1,
    cursor: 'z-eligible',
  });
  expect(await db.prisma.agentEvent.findUnique({ where: { id: 'z-eligible' } })).toBeNull();
  await db.prisma.agentSourceState.update({
    where: { connectionId: blocked.id },
    data: {
      isReady: true,
      lastSourceOrder: 102,
      cursor: { version: 1, provider: 'GITHUB', committedHeadEventId: 'bad-101', scan: null },
    },
  });
  await prune();
  expect(await db.prisma.agentEvent.count()).toBe(2);
  await prune();
  expect(await db.prisma.agentEvent.count()).toBe(0);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it.each(['payloadExpiresAt', 'identityExpiresAt'] as const)(
  'samples %s only after the queued ledger lock',
  async (expiry) => {
    const { event, eventId } = await terminal();
    time(new Date(event[expiry].getTime() - 1));
    const acquired = deferred();
    const release = deferred();
    const queued = deferred();
    let held = false;
    afterQuery = async (_model, operation) => {
      if (operation === '$executeRaw' && !held) {
        held = true;
        acquired.resolve();
        await release.promise;
      }
    };
    const blocker = runtime.maintainQueue();
    let contender: ReturnType<typeof prune> | undefined;
    try {
      await acquired.promise;
      onTransaction = queued.resolve;
      contender = prune();
      await queued.promise;
      vi.setSystemTime(event[expiry]);
      release.resolve();
      await contender;
      await blocker;
      if (expiry === 'payloadExpiresAt') {
        expect((await row(eventId)).payload).toBeNull();
        expect(await db.prisma.agentEvaluation.count()).toBe(0);
      } else {
        expect(await db.prisma.agentEvent.count()).toBe(0);
      }
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, contender]);
    }
  }
);

it.each(['QUEUED', 'RUNNING'] as const)(
  'retains %s event dependencies despite old deadlines and finished delivery',
  async (status) => {
    const { run, event, eventId } = await terminal();
    const finishedAt = new Date();
    await db.prisma.agentInitialDelivery.update({
      where: { runId: run.id },
      data: { state: 'FINISHED', finishedAt },
    });
    expect(
      await db.prisma.agentInitialDelivery.findUniqueOrThrow({ where: { runId: run.id } })
    ).toMatchObject({ state: 'FINISHED', finishedAt });
    await db.prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status,
        launchPhase: 'NEEDS_ATTENTION',
        leaseExpiresAt: new Date(0),
        nextAttemptAt: new Date(0),
      },
    });
    time(event.identityExpiresAt);
    await prune();
    expect((await row(eventId)).payload).not.toBeNull();
    expect(await db.prisma.agentEvaluation.count()).toBe(1);
  }
);

it.each(['MATCHED', 'ERROR', 'QUEUE_OVERFLOW'] as const)(
  'preserves overlapping trigger %s ownership/barrier while later admission is unresolved',
  async (earlier) => {
    const eventId = await fixture.event();
    const earlierDecision = await fixture.evaluation(
      eventId,
      earlier === 'ERROR' ? { status: 'ERROR' } : {}
    );
    if (!('evaluationId' in earlierDecision)) {
      throw new Error('missing evaluation');
    }
    if (earlier === 'QUEUE_OVERFLOW') {
      await db.prisma.agentEvaluation.update({
        where: { id: earlierDecision.evaluationId },
        data: { status: 'SKIPPED', reasonCode: 'QUEUE_OVERFLOW' },
      });
    }
    const second = await fixture.secondTrigger();
    const later = await fixture.evaluation(eventId, {
      triggerId: second.id,
      input: {
        version: 1,
        eventId,
        context: [{ id: 'later', text: 'Later context must not win' }],
      },
    });
    if (!('evaluationId' in later)) {
      throw new Error('missing later evaluation');
    }
    const before = await db.prisma.agentEvaluation.findMany();
    const now = new Date();
    time((await row(eventId)).identityExpiresAt);
    await prune();
    expect(await db.prisma.agentEvaluation.findMany()).toEqual(before);
    expect((await row(eventId)).payload).not.toBeNull();
    vi.setSystemTime(now);
    const admitted = await runtime.admitRun({
      evaluationId: later.evaluationId,
      definitionRevision: 1,
      triggerRevision: 1,
      activationGeneration: 1,
    });
    if (earlier === 'MATCHED') {
      expect(admitted.status).toBe('ADMITTED');
      expect((await db.prisma.agentRun.findFirstOrThrow()).input).toMatchObject({
        context: [{ text: 'Frozen issue context' }],
      });
    } else {
      expect(admitted).toMatchObject({
        reason: earlier === 'ERROR' ? 'EARLIER_EVALUATION_ERROR' : 'QUEUE_OVERFLOW',
      });
    }
  }
);

it('retains a retryable ERROR and its cohort until the evaluator resolves it', async () => {
  const eventId = await fixture.event();
  const decision = await fixture.evaluation(eventId, { status: 'ERROR' });
  if (!('evaluationId' in decision)) {
    throw new Error('missing evaluation');
  }
  await db.prisma.agentEvaluation.update({
    where: { id: decision.evaluationId },
    data: { nextAttemptAt: new Date(0) },
  });
  time((await row(eventId)).identityExpiresAt);
  await prune();
  expect((await row(eventId)).payload).not.toBeNull();
  expect(await db.prisma.agentEvaluation.count()).toBe(1);
});

it.each([
  'starting',
  'boundary',
  'pending',
  'config',
  'cursor',
  'health',
  'missing-source',
  'evaluation',
  'pending-owner',
  'boundary-provider',
] as const)('conservatively retains %s dependency proof', async (corruption) => {
  const { event, eventId } = await terminal();
  if (corruption === 'starting') {
    await db.prisma.agentTrigger.updateMany({
      data: { activationState: 'STARTING', pendingActivation: { expired: true } },
    });
  }
  if (corruption === 'boundary') {
    await db.prisma.agentTrigger.updateMany({ data: { activationBoundary: { invalid: true } } });
  }
  if (corruption === 'pending') {
    await db.prisma.agentTrigger.updateMany({ data: { pendingActivation: { invalid: true } } });
  }
  if (corruption === 'config') {
    await db.prisma.agentTrigger.updateMany({ data: { config: { invalid: true } } });
  }
  if (corruption === 'pending-owner') {
    await db.prisma.agentTrigger.updateMany({
      data: {
        pendingActivation: {
          version: 1,
          activationGeneration: 1,
          definitionRevision: 1,
          triggerRevision: 1,
          connectionId: 'wrong-owner',
          nonce: 'pending',
          expiresAt: new Date(0).toISOString(),
          channels: [],
        },
      },
    });
  }
  if (corruption === 'boundary-provider') {
    await db.prisma.agentTrigger.updateMany({
      data: {
        activationBoundary: {
          provider: 'SLACK',
          workspaceId: 'T',
          appId: 'A',
          channels: [{ channelId: 'C', eventTs: '1.0' }],
        },
      },
    });
  }
  if (corruption === 'cursor') {
    await db.prisma.agentSourceState.updateMany({ data: { cursor: { invalid: true } } });
  }
  if (corruption === 'health') {
    await db.prisma.agentSourceState.updateMany({ data: { health: { invalid: true } } });
  }
  if (corruption === 'missing-source') {
    await db.prisma.agentSourceState.deleteMany();
  }
  if (corruption === 'evaluation') {
    await db.prisma.agentEvaluation.updateMany({
      data: { configurationSnapshot: { invalid: true } },
    });
  }
  time(event.identityExpiresAt);
  const batches = await prune();
  expect(await db.prisma.agentEvent.count()).toBe(1);
  expect(await db.prisma.agentEvaluation.count()).toBe(1);
  expect(batches[0]?.retained).not.toEqual({});
  expect((await row(eventId)).payload).not.toBeNull();
});

it('bounds evaluation fanout separately and delays identity deletion until every dependent is gone', async () => {
  const { event } = await terminal();
  const decision = await db.prisma.agentEvaluation.findFirstOrThrow();
  const { id: _id, ...data } = decision;
  await db.prisma.agentEvaluation.createMany({
    data: Array.from({ length: 102 }, (_, i) => ({
      ...data,
      configurationSnapshot: runtime.agentEvaluationSnapshotSchema.parse(
        data.configurationSnapshot
      ),
      classifier: Prisma.DbNull,
      id: `fanout-${i}`,
      triggerRevision: i + 2,
    })),
  });
  time(event.identityExpiresAt);
  const first = await prune();
  expect(first[0]).toMatchObject({ inspected: 100, changed: 100 });
  expect(await db.prisma.agentEvaluation.count()).toBe(3);
  expect(await db.prisma.agentEvent.count()).toBe(1);
  await prune();
  expect(await db.prisma.agentEvent.count()).toBe(0);
  expect(await db.prisma.agentRun.count()).toBe(1);
});

it.each(['waiting-lock', 'dependency-read', 'after-delete'] as const)(
  'shutdown at %s rolls back the current batch',
  async (point) => {
    const { event, eventId } = await terminal();
    time(event.identityExpiresAt);
    const controller = new AbortController();
    const operations: string[] = [];
    afterQuery = (model, operation) => {
      operations.push(`${model}.${operation}`);
      if (
        (point === 'waiting-lock' && operation === '$executeRaw') ||
        (point === 'dependency-read' && model === 'AgentTrigger' && operation === 'findMany') ||
        (point === 'after-delete' && model === 'AgentEvaluation' && operation === 'delete')
      ) {
        controller.abort();
      }
    };
    expect(await retention.pruneExpired(controller.signal)).toEqual([]);
    expect(await db.prisma.agentEvent.count()).toBe(1);
    expect(await db.prisma.agentEvaluation.count()).toBe(1);
    if (point !== 'after-delete') {
      expect(operations.some((operation) => operation.endsWith('.delete'))).toBe(false);
    }
    afterQuery = undefined;
    await prune();
    expect(await db.prisma.agentEvent.findUnique({ where: { id: eventId } })).toBeNull();
  }
);

it('stops between committed batches without discarding the committed evaluation deletion', async () => {
  const { event, eventId } = await terminal();
  time(event.identityExpiresAt);
  const { agentLedgerRetentionAccessor } = await vi.importActual<
    typeof import('./agent-ledger-retention.accessor')
  >('./agent-ledger-retention.accessor');
  const original = agentLedgerRetentionAccessor.pruneBatch;
  const controller = new AbortController();
  const spy = vi
    .spyOn(agentLedgerRetentionAccessor, 'pruneBatch')
    .mockImplementation(async (...args) => {
      const result = await original(...args);
      controller.abort();
      return result;
    });
  try {
    expect(await retention.pruneExpired(controller.signal)).toHaveLength(1);
  } finally {
    spy.mockRestore();
  }
  expect(await db.prisma.agentEvaluation.count()).toBe(0);
  expect((await row(eventId)).payload).not.toBeNull();
  await prune();
  expect(await db.prisma.agentEvent.count()).toBe(0);
});

it('retries the same bounded candidate page after an identity mutation rolls back', async () => {
  const { event } = await terminal();
  await db.prisma.agentEvaluation.deleteMany();
  await db.prisma.agentEvent.deleteMany();
  await db.prisma.agentEvent.createMany({
    data: Array.from({ length: 103 }, (_, i) => ({
      id: `retry-${String(i).padStart(3, '0')}`,
      connectionId: fixture.connectionId,
      providerEventId: `retry-${i}`,
      sourceOrder: i + 1,
      occurredAt: event.occurredAt,
      observedAt: event.observedAt,
      payloadExpiresAt: event.payloadExpiresAt,
      identityExpiresAt: event.identityExpiresAt,
    })),
  });
  await db.prisma.agentSourceState.updateMany({ data: { lastSourceOrder: 103 } });
  time(event.identityExpiresAt);
  afterQuery = (model, operation) => {
    if (model === 'AgentEvent' && operation === 'delete') {
      throw new Error('identity rollback');
    }
  };
  await expect(prune()).rejects.toThrow('identity rollback');
  expect(await db.prisma.agentEvent.count()).toBe(103);
  afterQuery = undefined;
  const retried = await prune();
  expect(retried.find((batch) => batch.kind === 'identity')).toMatchObject({
    inspected: 100,
    changed: 100,
    cursor: 'retry-099',
  });
  expect(await db.prisma.agentEvent.count()).toBe(3);
});

it('aborts while queued behind a real ledger lock without starting a later mutation', async () => {
  const { event } = await terminal();
  time(event.identityExpiresAt);
  const acquired = deferred();
  const release = deferred();
  const queued = deferred();
  let held = false;
  afterQuery = async (_model, operation) => {
    if (operation === '$executeRaw' && !held) {
      held = true;
      acquired.resolve();
      await release.promise;
    }
  };
  const blocker = runtime.maintainQueue();
  const controller = new AbortController();
  let contender: ReturnType<typeof prune> | undefined;
  try {
    await acquired.promise;
    onTransaction = queued.resolve;
    contender = retention.pruneExpired(controller.signal);
    await queued.promise;
    controller.abort();
    release.resolve();
    expect(await contender).toEqual([]);
    await blocker;
    expect(await db.prisma.agentEvent.count()).toBe(1);
    expect(await db.prisma.agentEvaluation.count()).toBe(1);
  } finally {
    release.resolve();
    await Promise.allSettled([blocker, contender]);
  }
});

it('rejects ancient replay after its tombstone expires through actual evaluation and admission', async () => {
  const { event, eventId } = await terminal();
  const input = fixture.github();
  input.payload.occurredAt = event.occurredAt.toISOString();
  time(event.identityExpiresAt);
  await prune();
  expect(await db.prisma.agentEvent.count()).toBe(0);
  const replay = await runtime.ingestEvent(input);
  expect(replay).toMatchObject({ duplicate: false });
  expect(replay.eventId).not.toBe(eventId);
  expect(await fixture.evaluation(replay.eventId)).toEqual({
    status: 'REJECTED',
    reason: 'EVENT_EXPIRED',
  });
  await db.prisma.agentEvent.update({
    where: { id: replay.eventId },
    data: { payloadExpiresAt: new Date(Date.now() + DAY), sourceOrder: 1 },
  });
  const recorded = await fixture.evaluation(replay.eventId);
  expect(recorded.status).toBe('RECORDED');
  if (!('evaluationId' in recorded)) {
    throw new Error('Replay evaluation was not recorded');
  }
  expect(
    await runtime.admitRun({
      evaluationId: recorded.evaluationId,
      definitionRevision: 1,
      triggerRevision: 1,
      activationGeneration: 1,
    })
  ).toEqual({ status: 'REJECTED', reason: 'EVENT_EXPIRED' });
  expect(await db.prisma.agentRun.count()).toBe(1); // only the original terminal history
});

it.each(['evaluation', 'payload', 'identity'] as const)(
  'each %s batch samples expiry after its own queued write lock',
  async (kind) => {
    const { event } = await terminal();
    if (kind === 'identity') {
      await db.prisma.agentEvaluation.deleteMany();
    }
    const expiry = kind === 'identity' ? event.identityExpiresAt : event.payloadExpiresAt;
    time(new Date(expiry.getTime() - 1));
    const acquired = deferred();
    const release = deferred();
    const queued = deferred();
    let held = false;
    afterQuery = async (_model, operation) => {
      if (operation === '$executeRaw' && !held) {
        held = true;
        acquired.resolve();
        await release.promise;
      }
    };
    const { agentLedgerRetentionAccessor } = await vi.importActual<
      typeof import('./agent-ledger-retention.accessor')
    >('./agent-ledger-retention.accessor');
    const blocker = runtime.maintainQueue();
    let contender: ReturnType<typeof agentLedgerRetentionAccessor.pruneBatch> | undefined;
    try {
      await acquired.promise;
      onTransaction = queued.resolve;
      contender = agentLedgerRetentionAccessor.pruneBatch(kind, null, () => undefined);
      await queued.promise;
      vi.setSystemTime(expiry);
      release.resolve();
      expect(await contender).toMatchObject({ inspected: 1, changed: 1 });
      await blocker;
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, contender]);
    }
  }
);

it.each(['database', 'json'] as const)(
  'characterizes %s null payload storage and Prisma filters on real SQLite',
  async (kind) => {
    const { eventId } = await terminal();
    await db.prisma.agentEvent.update({
      where: { id: eventId },
      data: { payload: kind === 'database' ? Prisma.DbNull : Prisma.JsonNull },
    });
    expect((await row(eventId)).payload).toBeNull();
    const stored = await db.prisma
      .$queryRaw`SELECT payload IS NULL AS "sqlNull", typeof(payload) AS "storageType", json_type(payload) AS "jsonType" FROM AgentEvent WHERE id = ${eventId}`;
    expect(stored).toEqual(
      kind === 'database'
        ? [{ sqlNull: 1n, storageType: 'null', jsonType: null }]
        : [{ sqlNull: 0n, storageType: 'text', jsonType: 'null' }]
    );
    expect(
      await db.prisma.agentEvent.count({
        where: { id: eventId, payload: { equals: Prisma.DbNull } },
      })
    ).toBe(kind === 'database' ? 1 : 0);
    expect(
      await db.prisma.agentEvent.count({
        where: { id: eventId, payload: { equals: Prisma.JsonNull } },
      })
    ).toBe(kind === 'json' ? 1 : 0);
  }
);

it.each(['evaluation', 'payload', 'identity'] as const)(
  'preserves malformed JSON-null proof during the %s batch while collecting real SQL-null',
  async (kind) => {
    const { event, eventId } = await terminal();
    if (kind === 'identity') {
      await db.prisma.agentEvaluation.deleteMany();
    }
    const { agentLedgerRetentionAccessor } = await vi.importActual<
      typeof import('./agent-ledger-retention.accessor')
    >('./agent-ledger-retention.accessor');
    time(event.identityExpiresAt);
    await db.prisma.agentEvent.update({
      where: { id: eventId },
      data: { payload: Prisma.JsonNull },
    });
    const malformed = await agentLedgerRetentionAccessor.pruneBatch(kind, null, () => undefined);
    expect(malformed).toMatchObject({
      inspected: 1,
      changed: 0,
      retained: { INVALID_STORED_DATA: 1 },
    });
    expect(
      await db.prisma.agentEvent.count({
        where: { id: eventId, payload: { equals: Prisma.JsonNull } },
      })
    ).toBe(1);
    expect(await db.prisma.agentEvaluation.count()).toBe(kind === 'identity' ? 0 : 1);
    await db.prisma.agentEvent.update({ where: { id: eventId }, data: { payload: Prisma.DbNull } });
    const pruned = await agentLedgerRetentionAccessor.pruneBatch(
      kind,
      malformed.cursor,
      () => undefined
    );
    expect(pruned).toMatchObject({
      inspected: kind === 'payload' ? 0 : 1,
      changed: kind === 'payload' ? 0 : 1,
    });
    expect(await db.prisma.agentEvent.count()).toBe(kind === 'identity' ? 0 : 1);
  }
);

it('retains paused pending proof from a different owning definition revision', async () => {
  const { event, eventId } = await terminal();
  await db.prisma.agentTrigger.updateMany({
    data: {
      activationState: 'PAUSED',
      pendingActivation: {
        version: 1,
        activationGeneration: 1,
        definitionRevision: 2,
        triggerRevision: 1,
        connectionId: fixture.connectionId,
        nonce: 'stale-definition',
        expiresAt: new Date(0).toISOString(),
        channels: [],
      },
    },
  });
  time(event.identityExpiresAt);
  const batches = await prune();
  expect((await row(eventId)).payload).not.toBeNull();
  expect(await db.prisma.agentEvaluation.count()).toBe(1);
  expect(batches.every((batch) => batch.changed === 0)).toBe(true);
  await db.prisma.agentDefinition.update({
    where: { id: fixture.definitionId },
    data: { definitionRevision: 2 },
  });
  await prune();
  expect(await db.prisma.agentEvent.count()).toBe(0);
});

function slackPayload() {
  return runtime.agentEventPayloadSchema.parse({
    version: 1,
    provider: 'SLACK',
    occurredAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    sourceUrl: 'https://slack.com/archives/C/p1',
    actorId: 'human',
    workspaceId: 'T',
    appId: 'A',
    channelId: 'C',
    action: 'message',
    eventTs: '1.0',
    threadTs: null,
    actorType: 'HUMAN',
    subtype: null,
    text: 'Retained source text',
  });
}
const slackBoundary = {
  provider: 'SLACK',
  workspaceId: 'T',
  appId: 'A',
  channels: [{ channelId: 'C', eventTs: '1.0' }],
};
async function configureSlackSource(eventId: string) {
  await db.prisma.agentConnection.update({
    where: { id: fixture.connectionId },
    data: { provider: 'SLACK', externalId: 'T' },
  });
  await db.prisma.agentTrigger.updateMany({
    data: {
      type: 'SLACK_MESSAGE',
      config: { version: 1, channelIds: ['C'] },
      activationBoundary: slackBoundary,
    },
  });
  await db.prisma.agentEvent.update({ where: { id: eventId }, data: { payload: slackPayload() } });
}
it.each([
  'cross-provider',
  'repository',
  'connection',
  'trigger',
  'pruned-trigger',
  'slack-workspace',
  'slack-app',
  'pruned-slack-boundary',
] as const)('retains schema-valid but inconsistent %s source identities', async (corruption) => {
  const { event, eventId } = await terminal();
  if (corruption.startsWith('slack') || corruption === 'pruned-slack-boundary') {
    await configureSlackSource(eventId);
  }
  if (corruption === 'cross-provider') {
    await db.prisma.agentEvent.update({
      where: { id: eventId },
      data: { payload: slackPayload() },
    });
  }
  if (corruption === 'repository') {
    await db.prisma.agentEvent.update({
      where: { id: eventId },
      data: { payload: { ...fixture.github().payload, repositoryId: 'other' } },
    });
  }
  if (corruption === 'connection') {
    await db.prisma.agentConnection.update({
      where: { id: fixture.connectionId },
      data: { externalId: 'gh:other' },
    });
  }
  if (corruption === 'trigger' || corruption === 'pruned-trigger') {
    await db.prisma.agentTrigger.updateMany({
      data: {
        type: 'SLACK_MESSAGE',
        config: { version: 1, channelIds: ['C'] },
        activationBoundary: slackBoundary,
      },
    });
    if (corruption === 'pruned-trigger') {
      await db.prisma.agentEvent.update({
        where: { id: eventId },
        data: { payload: Prisma.DbNull },
      });
    }
  }
  if (corruption === 'slack-workspace') {
    await db.prisma.agentEvent.update({
      where: { id: eventId },
      data: { payload: { ...slackPayload(), workspaceId: 'other' } },
    });
  }
  if (corruption === 'slack-app') {
    await db.prisma.agentEvent.update({
      where: { id: eventId },
      data: { payload: { ...slackPayload(), appId: 'other' } },
    });
  }
  if (corruption === 'pruned-slack-boundary') {
    await db.prisma.agentEvent.update({ where: { id: eventId }, data: { payload: Prisma.DbNull } });
    await db.prisma.agentTrigger.updateMany({
      data: { activationBoundary: { ...slackBoundary, workspaceId: 'other' } },
    });
  }
  const before = await row(eventId);
  time(event.identityExpiresAt);
  expect((await prune()).every((batch) => batch.changed === 0)).toBe(true);
  expect(await row(eventId)).toEqual(before);
  expect(await db.prisma.agentEvaluation.count()).toBe(1);
});

it.each([false, true])(
  'collects consistent Slack source proof including SQL-null payload (already pruned: %s)',
  async (pruned) => {
    const { event, eventId } = await terminal();
    await configureSlackSource(eventId);
    // A different channel can simply be a filter non-match, not identity corruption.
    await db.prisma.agentTrigger.updateMany({
      data: { config: { version: 1, channelIds: ['other-channel'] } },
    });
    if (pruned) {
      await db.prisma.agentEvent.update({
        where: { id: eventId },
        data: { payload: Prisma.DbNull },
      });
    }
    time(event.identityExpiresAt);
    await prune();
    expect(await db.prisma.agentEvent.count()).toBe(0);
    expect(await db.prisma.agentEvaluation.count()).toBe(0);
  }
);

it('rolls back shutdown during the new persisted-null dependency read', async () => {
  const { event, eventId } = await terminal();
  await db.prisma.agentEvent.update({ where: { id: eventId }, data: { payload: Prisma.DbNull } });
  time(event.identityExpiresAt);
  const controller = new AbortController();
  afterQuery = (model, operation) => {
    if (model === 'AgentEvent' && operation === 'findFirst') {
      controller.abort();
    }
  };
  expect(await retention.pruneExpired(controller.signal)).toEqual([]);
  expect(controller.signal.aborted).toBe(true);
  expect(await db.prisma.agentEvaluation.count()).toBe(1);
  expect(await db.prisma.agentEvent.count()).toBe(1);
  afterQuery = undefined;
  await prune();
  expect(await db.prisma.agentEvent.count()).toBe(0);
});
