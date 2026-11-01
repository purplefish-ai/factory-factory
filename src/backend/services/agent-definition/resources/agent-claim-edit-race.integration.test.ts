import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { createLedgerFixture } from './agent-ledger.test-support';

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
      winner: 'claim' | 'edit';
      acquired: ReturnType<typeof signal>;
      release: ReturnType<typeof signal>;
    }
  | undefined;

beforeAll(async () => {
  db = await createIntegrationDatabase();
  // Real Prisma queries/transactions: pause only after the winning write acquired SQLite's lock.
  const observed = db.prisma.$extends({
    query: {
      $allOperations: async ({ model, operation, args, query }) => {
        const result = await query(args);
        const selected = gate;
        const isClaim = operation === '$executeRaw';
        const isEdit = model === 'AgentProposal' && operation === 'updateMany';
        if (selected && (selected.winner === 'claim' ? isClaim : isEdit)) {
          gate = undefined;
          selected.acquired.resolve();
          await selected.release.promise;
        }
        return result;
      },
    },
  });
  vi.doMock('@/backend/db', () => ({ prisma: observed }));
  runtime = await vi.importActual<typeof import('../index')>('../index');
}, 30_000);
afterAll(async () => {
  vi.doUnmock('@/backend/db');
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  fixture = await createLedgerFixture(db, runtime);
});

async function authoredRun() {
  const service = new runtime.AgentProposalService();
  const definition = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: fixture.definitionId },
  });
  const workspace = await db.prisma.workspace.create({
    data: { projectId: definition.projectId, name: 'Author' },
  });
  const proposal = await service.propose({
    workspaceId: workspace.id,
    specification: {
      name: 'Saved agent',
      instructions: 'Original task',
      executionConfig: { version: 1, provider: 'CLAUDE', model: 'sonnet' },
      triggers: [
        {
          type: 'GITHUB_ISSUE',
          connectionId: fixture.connectionId,
          description: 'Label',
          config: { version: 1, repositoryIds: ['repo-1'], actions: ['labeled'] },
        },
      ],
    },
  });
  const saved = await service.create({
    workspaceId: workspace.id,
    proposalId: proposal.id,
    revision: 1,
    specification: proposal.specification,
  });
  const definitionId = saved.agentDefinitionId;
  if (!definitionId) {
    throw new Error('The proposal has no definition');
  }
  await db.prisma.agentDefinition.update({
    where: { id: definitionId },
    data: { isEnabled: true },
  });
  const trigger = await db.prisma.agentTrigger.findFirstOrThrow({
    where: { agentDefinitionId: definitionId },
  });
  await db.prisma.agentTrigger.update({
    where: { id: trigger.id },
    data: {
      isEnabled: true,
      activationState: 'ACTIVE',
      activationGeneration: 1,
      activationBoundary: { provider: 'GITHUB', headEventId: null, sourceOrder: 0 },
    },
  });
  const admission = await fixture.admit(await fixture.event(), {
    agentDefinitionId: definitionId,
    triggerId: trigger.id,
  });
  if (admission.status !== 'ADMITTED') {
    throw new Error(JSON.stringify(admission));
  }
  const frozen = await db.prisma.agentRun.findUniqueOrThrow({ where: { id: admission.runId } });
  return {
    frozen,
    runId: admission.runId,
    definitionId,
    triggerId: trigger.id,
    edit: () =>
      service.update({
        workspaceId: workspace.id,
        proposalId: saved.id,
        revision: 1,
        specification: { ...saved.specification, instructions: 'Changed task' },
      }),
  };
}

it.each(['claim', 'edit'] as const)(
  'preserves the %s transaction winning a concurrent public claim/edit race',
  async (winner) => {
    const saved = await authoredRun();
    const held = {
      winner,
      acquired: signal(),
      release: signal(),
    };
    gate = held;
    const first = winner === 'claim' ? runtime.claimNextRun() : saved.edit();
    try {
      await Promise.race([
        held.acquired.promise,
        first.then(() => {
          throw new Error('The winner bypassed its write-lock observation');
        }),
      ]);
      // Start the competing public operation while the first real transaction still holds its lock.
      let contenderSettled = false;
      const second = (winner === 'claim' ? saved.edit() : runtime.claimNextRun()).then((result) => {
        contenderSettled = true;
        return result;
      });
      await Promise.resolve();
      expect(contenderSettled).toBe(false);
      held.release.resolve();
      const outcomes = await Promise.all([first, second]);
      const claim = outcomes[winner === 'claim' ? 0 : 1];
      expect(claim).toMatchObject(
        winner === 'claim'
          ? { status: 'CLAIMED', runId: saved.runId }
          : { status: 'DEFERRED', reason: 'EMPTY' }
      );
      const run = await db.prisma.agentRun.findUniqueOrThrow({ where: { id: saved.runId } });
      expect(run).toMatchObject({
        status: winner === 'claim' ? 'RUNNING' : 'CANCELLED',
        definitionRevision: 1,
        triggerRevision: 1,
        activationGeneration: 1,
        definitionSnapshot: { instructions: 'Original task' },
        workerGeneration: winner === 'claim' ? 1 : 0,
      });
      expect(
        await db.prisma.agentDefinition.findUniqueOrThrow({ where: { id: saved.definitionId } })
      ).toMatchObject({ definitionRevision: 2, instructions: 'Changed task' });
      expect(
        await db.prisma.agentTrigger.findUniqueOrThrow({ where: { id: saved.triggerId } })
      ).toMatchObject({ isEnabled: false, activationState: 'PAUSED', activationGeneration: 2 });
      expect(
        await db.prisma.agentRun.count({ where: { agentDefinitionId: saved.definitionId } })
      ).toBe(1);
      expect(await runtime.claimNextRun()).toEqual({ status: 'DEFERRED', reason: 'EMPTY' });
    } finally {
      gate = undefined;
      held.release.resolve();
    }
  }
);
