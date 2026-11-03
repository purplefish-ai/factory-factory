import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { AgentRunStatus, PrismaClient } from '@prisma-gen/client';
import { agentManagementHistoryAccessor } from './agent-management-history.accessor';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return state.prisma;
  },
}));

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
  await db.prisma.project.createMany({
    data: ['alpha', 'beta'].map((id) => ({
      id,
      slug: id,
      name: id,
      repoPath: `/repo/${id}`,
      worktreeBasePath: `/worktrees/${id}`,
    })),
  });
}, 30_000);
afterEach(async () => {
  await db.prisma.agentRun.deleteMany();
  await db.prisma.agentTrigger.deleteMany();
  await db.prisma.agentDefinition.deleteMany();
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

async function createAgent(name: string, projectId = 'alpha') {
  const definition = await db.prisma.agentDefinition.create({
    data: { projectId, name, instructions: 'Investigate' },
  });
  await db.prisma.agentTrigger.create({
    data: {
      id: `${definition.id}:trigger`,
      agentDefinitionId: definition.id,
      type: 'GITHUB_ISSUE',
      description: 'Labels',
      config: {},
    },
  });
  return definition.id;
}

function run(
  agentDefinitionId: string,
  status: AgentRunStatus,
  options: { day: number; completedDay?: number; id?: string; manual?: boolean }
) {
  return db.prisma.agentRun.create({
    data: {
      id: options.id,
      agentDefinitionId,
      triggerId: options.manual ? null : `${agentDefinitionId}:trigger`,
      idempotencyKey: crypto.randomUUID(),
      status,
      createdAt: new Date(Date.UTC(2026, 0, options.day)),
      completedAt:
        options.completedDay === undefined
          ? null
          : new Date(Date.UTC(2026, 0, options.completedDay)),
      definitionSnapshot: {},
      input: {},
    },
  });
}

it('reads the newest triggered terminal outcome through the partial expression index', async () => {
  const agent = await createAgent('Indexed');
  await run(agent, 'FAILED', { day: 1, completedDay: 2 });
  const raw = vi.spyOn(db.prisma, '$queryRaw');
  try {
    await agentManagementHistoryAccessor.navigationSummary('alpha');
    const [template, ...values] = raw.mock.calls.at(-1) ?? [];
    const sql = z.array(z.string()).parse(template).join('?');
    const plan = z
      .array(z.object({ detail: z.string() }))
      .parse(await db.prisma.$queryRawUnsafe(`EXPLAIN QUERY PLAN ${sql}`, ...values));
    const details = plan.map((row) => row.detail);
    expect(details).toContainEqual(
      expect.stringMatching(/^SEARCH r USING INDEX AgentRun_latest_terminal_idx \(/)
    );
    expect(details.some((detail) => detail.includes('USE TEMP B-TREE'))).toBe(false);
  } finally {
    raw.mockRestore();
  }
});

it('orders by completion, falling back to creation, and ignores manual or active runs', async () => {
  const recovered = await createAgent('Recovered');
  // A failure created later but completed earlier is superseded by the success.
  await run(recovered, 'FAILED', { day: 5, completedDay: 6 });
  await run(recovered, 'COMPLETED', { day: 1, completedDay: 7 });
  await run(recovered, 'FAILED', { day: 8, manual: true, completedDay: 9 });
  await run(recovered, 'RUNNING', { day: 10 });

  const failed = await createAgent('Failed');
  await run(failed, 'PR_CREATED', { day: 1, completedDay: 2 });
  // Without completedAt, createdAt is the terminal timestamp.
  await run(failed, 'FAILED', { day: 3 });
  await run(failed, 'QUEUED', { day: 4 });

  const tied = await createAgent('Tied');
  await run(tied, 'CANCELLED', { day: 1, completedDay: 2, id: 'a-cancelled' });
  await run(tied, 'FAILED', { day: 1, completedDay: 2, id: 'z-failed' });

  await createAgent('No history');
  const foreign = await createAgent('Foreign', 'beta');
  await run(foreign, 'FAILED', { day: 1, completedDay: 2 });

  expect(await agentManagementHistoryAccessor.navigationSummary('alpha')).toEqual({
    totalCount: 4,
    failedCount: 2,
  });
  expect(await agentManagementHistoryAccessor.navigationSummary('beta')).toEqual({
    totalCount: 1,
    failedCount: 1,
  });
});
