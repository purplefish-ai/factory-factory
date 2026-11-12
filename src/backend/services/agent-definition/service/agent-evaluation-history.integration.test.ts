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
