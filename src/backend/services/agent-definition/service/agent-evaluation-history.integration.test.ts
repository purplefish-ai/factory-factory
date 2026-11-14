import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { evaluationExplanations } from '@/backend/services/agent-definition/resources/agent-evaluation-explanations';
import { createLedgerFixture } from '@/backend/services/agent-definition/resources/testing/agent-ledger.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let runtime: typeof import('../index');

beforeAll(async () => {
  db = await createIntegrationDatabase();
  runtime = await vi.importActual<typeof import('../index')>('../index');
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it('returns the stored explanation only when the system wrote it', async () => {
  const fixture = await createLedgerFixture(db, runtime);
  const { projectId } = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: fixture.definitionId },
  });
  await fixture.evaluation(await fixture.event('event-skipped'), {
    status: 'SKIPPED',
    reasonCode: 'LABEL_MISMATCH',
    explanation: evaluationExplanations.addedLabelMismatch,
  });
  // Any other text, such as an older wording or another writer's, is not shown.
  await fixture.evaluation(await fixture.event('event-other'), {
    explanation: 'Investigate this issue',
  });

  const page = await new runtime.AgentManagementService().evaluations({
    projectId,
    agentId: fixture.definitionId,
  });
  expect(Object.fromEntries(page.items.map((item) => [item.reasonCode, item.explanation]))).toEqual(
    {
      LABEL_MISMATCH: 'The added label does not match.',
      DETERMINISTIC_MATCH: null,
    }
  );
});

it('reads a stored reason that is not a reason code as INVALID_STORED_DATA', async () => {
  const fixture = await createLedgerFixture(db, runtime);
  const owner = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: fixture.definitionId },
  });
  const freeText = 'Provider said: secret token abc';
  await fixture.evaluation(await fixture.event('event-free-text'));
  await db.prisma.agentEvaluation.updateMany({
    where: { agentDefinitionId: owner.id },
    data: { reasonCode: freeText },
  });
  await db.prisma.agentRun.create({
    data: {
      agentDefinitionId: owner.id,
      idempotencyKey: crypto.randomUUID(),
      reasonCode: freeText,
      definitionSnapshot: {},
      input: {},
    },
  });
  const input = { projectId: owner.projectId, agentId: owner.id };
  const management = new runtime.AgentManagementService();
  const evaluations = await management.evaluations(input);
  const runs = await management.runs(input);
  expect(evaluations.items.map((item) => item.reasonCode)).toEqual(['INVALID_STORED_DATA']);
  expect(runs.items.map((item) => item.reasonCode)).toEqual(['INVALID_STORED_DATA']);
  expect(JSON.stringify([evaluations, runs])).not.toContain('secret token');
});
