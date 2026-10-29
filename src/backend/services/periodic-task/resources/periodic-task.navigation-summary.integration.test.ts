import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createLogger } from '@/backend/services/logger.service';
import { PeriodicTaskService } from '@/backend/services/periodic-task';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { PeriodicTaskExecutionStatus } from '@/shared/core';
import type { PrismaClient } from '@prisma-gen/client';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return state.prisma;
  },
}));
let db: IntegrationDatabase;
const service = new PeriodicTaskService(createLogger('navigation-summary-test'));
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
  await db.prisma.periodicTask.deleteMany();
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
function createAgent(name: string, projectId = 'alpha', isEnabled = true) {
  return db.prisma.periodicTask.create({
    data: {
      name,
      projectId,
      isEnabled,
      prompt: 'Instructions',
      cadence: 'DAILY',
      nextRunAt: new Date(),
    },
  });
}
function run(
  periodicTaskId: string,
  status: PeriodicTaskExecutionStatus,
  day: number,
  id?: string
) {
  return db.prisma.periodicTaskExecution.create({
    data: {
      id,
      periodicTaskId,
      status,
      startedAt: new Date(Date.UTC(2026, 9, day)),
    },
  });
}
it('counts paused definitions and agents without history, within their project', async () => {
  const paused = await createAgent('Paused', 'alpha', false);
  await createAgent('No history');
  const other = await createAgent('Other', 'beta');
  await run(paused.id, 'FAILED', 1);
  await run(other.id, 'FAILED', 1);
  expect(await service.getNavigationSummary('alpha')).toEqual({ totalCount: 2, failedCount: 1 });
  expect(await service.getNavigationSummary('beta')).toEqual({ totalCount: 1, failedCount: 1 });
  expect(await service.getNavigationSummary('missing')).toEqual({ totalCount: 0, failedCount: 0 });
});
it('retains a failure beyond five running/skipped rows until the next successful outcome', async () => {
  const agent = await createAgent('Retrying');
  await run(agent.id, 'FAILED', 1);
  for (let day = 2; day <= 8; day++) {
    await run(agent.id, day % 2 ? 'RUNNING' : 'SKIPPED', day);
  }
  expect((await service.list('alpha'))[0]?.executions).toHaveLength(5);
  expect(await service.getNavigationSummary('alpha')).toEqual({ totalCount: 1, failedCount: 1 });
  await run(agent.id, 'PR_CREATED', 9);
  expect(await service.getNavigationSummary('alpha')).toEqual({ totalCount: 1, failedCount: 0 });
  expect(await db.prisma.periodicTaskExecution.count({ where: { status: 'FAILED' } })).toBe(1);
});
it('uses newest startedAt and then descending ID for tied terminal outcomes per agent', async () => {
  const recovered = await createAgent('Recovered');
  const failed = await createAgent('Failed again');
  await run(recovered.id, 'FAILED', 2, 'a-failure');
  await run(recovered.id, 'PR_CREATED', 2, 'z-success');
  await run(recovered.id, 'FAILED', 1, 'zz-older');
  await run(failed.id, 'PR_CREATED', 1);
  await run(failed.id, 'FAILED', 2);
  expect(await service.getNavigationSummary('alpha')).toEqual({ totalCount: 2, failedCount: 1 });
});
