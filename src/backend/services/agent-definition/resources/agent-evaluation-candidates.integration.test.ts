import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { createLedgerFixture } from './testing/agent-ledger.test-support';
let db: IntegrationDatabase;
let runtime: typeof import('../index');
let candidates: typeof import('./agent-evaluation-candidates.accessor');
let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual('../index');
  candidates = await vi.importActual('./agent-evaluation-candidates.accessor');
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
});
it('hydrates a bounded candidate page with bulk reads while preserving pair ownership and order', async () => {
  await fixture.secondTrigger();
  const first = await fixture.event('first');
  const second = await fixture.event('second');
  await fixture.evaluation(first);
  const triggerReads = vi.spyOn(db.prisma.agentTrigger, 'findUnique');
  const eventReads = vi.spyOn(db.prisma.agentEvent, 'findUnique');
  const evaluationReads = vi.spyOn(db.prisma.agentEvaluation, 'findFirst');
  const triggerBatches = vi.spyOn(db.prisma.agentTrigger, 'findMany');
  const eventBatches = vi.spyOn(db.prisma.agentEvent, 'findMany');
  const evaluationBatches = vi.spyOn(db.prisma.agentEvaluation, 'findMany');
  const result = await candidates.agentEvaluationCandidatesAccessor.pending(null);
  expect(
    result.candidates.map(({ trigger, event, evaluation }) => [
      trigger.id,
      event.id,
      evaluation?.status ?? null,
    ])
  ).toEqual([
    ['trigger-a', first, 'MATCHED'],
    ['trigger-a', second, null],
    ['trigger-b', first, null],
    ['trigger-b', second, null],
  ]);
  expect(
    triggerReads.mock.calls.length +
      eventReads.mock.calls.length +
      evaluationReads.mock.calls.length
  ).toBe(0);
  expect(triggerBatches).toHaveBeenCalledOnce();
  expect(eventBatches).toHaveBeenCalledOnce();
  expect(evaluationBatches).toHaveBeenCalledOnce();
});
