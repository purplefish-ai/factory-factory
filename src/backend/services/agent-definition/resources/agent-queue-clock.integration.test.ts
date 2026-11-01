import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { createLedgerFixture } from './testing/agent-ledger.test-support';

let db: IntegrationDatabase;
let runtime: typeof import('../index');
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
function signal() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
let gate:
  | {
      locked: boolean;
      acquired: ReturnType<typeof signal>;
      queued: ReturnType<typeof signal>;
      release: ReturnType<typeof signal>;
    }
  | undefined;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  const observed = db.prisma.$extends({
    query: {
      $allOperations: async ({ operation, args, query }) => {
        const held = gate;
        const result = await query(args);
        if (held && operation === '$executeRaw' && !held.locked) {
          held.locked = true;
          held.acquired.resolve();
          await held.release.promise;
        }
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
        const request = Reflect.apply(value, target, args);
        if (gate?.locked) {
          gate.queued.resolve();
        }
        return request;
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
  gate = undefined;
  vi.useRealTimers();
});
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
});

it.each([
  ['claimNextRun', false],
  ['maintainQueue', false],
  ['claimNextRun', true],
  ['maintainQueue', true],
] as const)(
  '%s checks expiry after acquiring its queued transaction (explicit clock: %s)',
  async (operation, explicitClock) => {
    await fixture.admit(await fixture.event());
    const initialTime = new Date();
    const expiresAt = new Date(initialTime.getTime() + 1000);
    await db.prisma.agentRun.updateMany({ data: { expiresAt } });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(initialTime);
    const held = { locked: false, acquired: signal(), queued: signal(), release: signal() };
    gate = held;
    // This actual ledger transaction acquires SQLite's write lock before the contender starts.
    const blocker = runtime.maintainQueue(initialTime);
    let contender: Promise<unknown> | undefined;
    try {
      await Promise.race([
        held.acquired.promise,
        blocker.then(() => {
          throw new Error('Missing write-lock witness');
        }),
      ]);
      let settled = false;
      contender = runtime[operation](explicitClock ? initialTime : undefined).then((result) => {
        settled = true;
        return result;
      });
      await Promise.race([
        held.queued.promise,
        contender.then(() => {
          throw new Error('Missing transaction-queue witness');
        }),
      ]);
      expect(settled).toBe(false);
      // Only Date is controlled; Prisma and SQLite transaction scheduling remain real.
      vi.setSystemTime(expiresAt);
      held.release.resolve();
      const result = await contender;
      await blocker;
      if (operation === 'claimNextRun') {
        expect(result).toMatchObject({ status: explicitClock ? 'CLAIMED' : 'DEFERRED' });
      }
      expect(await db.prisma.agentRun.findFirstOrThrow()).toMatchObject({
        status: explicitClock ? (operation === 'claimNextRun' ? 'RUNNING' : 'QUEUED') : 'CANCELLED',
        reasonCode: explicitClock ? null : 'QUEUE_EXPIRED',
      });
      expect(await db.prisma.agentInitialDelivery.findFirstOrThrow()).toMatchObject({
        state: explicitClock ? 'PENDING' : 'FINISHED',
      });
    } finally {
      held.release.resolve();
      await Promise.allSettled([blocker, contender]);
    }
  }
);
