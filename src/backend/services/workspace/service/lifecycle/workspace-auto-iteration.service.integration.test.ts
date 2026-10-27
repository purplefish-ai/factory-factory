import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  workspaceAutoIterationService,
  type AutoIterationSummaryChangedEvent,
} from '@/backend/services/workspace/service/lifecycle/workspace-auto-iteration.service';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { AutoIterationProgress } from '@/shared/schemas/auto-iteration.schema';
import type { PrismaClient } from '@prisma-gen/client';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return database.prisma;
  },
}));
let db: IntegrationDatabase;
const events: AutoIterationSummaryChangedEvent[] = [];
const progress: AutoIterationProgress = {
  currentIteration: 3,
  baselineMetricSummary: 'score=1',
  currentMetricSummary: 'score=7',
  acceptedCount: 2,
  rejectedRegressionCount: 0,
  rejectedCritiqueCount: 0,
  crashedCount: 0,
  sessionRecycleCount: 0,
  startedAt: '2026-01-01T00:00:00.000Z',
  lastIterationAt: null,
  currentPhase: 'idle',
  lastTestOutput: 'x'.repeat(100_000),
};
beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
}, 30_000);
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});
beforeEach(async () => {
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: '/repo',
      worktreeBasePath: '/worktrees',
    },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'loop',
      projectId: 'project',
      name: 'Loop',
      status: 'READY',
      autoIteration: {
        create: {
          mode: 'AUTO_ITERATION',
          status: 'RUNNING',
          sessionId: 'active',
          config: { maxIterations: 12 },
          progress,
        },
      },
    },
  });
  workspaceAutoIterationService.on('auto_iteration_summary_changed', (event) => events.push(event));
});
afterEach(() => {
  events.length = 0;
  workspaceAutoIterationService.removeAllListeners();
});

it.each(['progress first', 'completion first'])(
  'keeps concurrent %s publications aligned with SQLite state',
  async (order) => {
    const operations = [
      () => workspaceAutoIterationService.setProgress('loop', progress),
      () => workspaceAutoIterationService.finishSessionIfMatching('loop', 'active', 'FAILED'),
    ];
    if (order === 'completion first') {
      operations.reverse();
    }
    await Promise.all(operations.map((start) => start()));
    expect(
      await db.prisma.workspaceAutoIteration.findUniqueOrThrow({ where: { workspaceId: 'loop' } })
    ).toMatchObject({
      status: 'FAILED',
      sessionId: null,
      progress: { currentIteration: 3, currentMetricSummary: 'score=7' },
    });
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toEqual({
      workspaceId: 'loop',
      mode: 'AUTO_ITERATION',
      autoIterationStatus: 'FAILED',
      autoIteration: {
        status: 'FAILED',
        currentIteration: 3,
        maxIterations: 12,
        currentMetricSummary: 'score=7',
      },
    });
    expect(JSON.stringify(events).length).toBeLessThan(800);
    await expect(
      workspaceAutoIterationService.finishSessionIfMatching('loop', 'old', 'COMPLETED')
    ).resolves.toBe(false);
    expect(events).toHaveLength(2);
  }
);

it('recovers only running rows and preserves the accepted config/progress with outward ID results', async () => {
  await db.prisma.workspace.create({
    data: {
      id: 'paused',
      projectId: 'project',
      name: 'Paused',
      autoIteration: {
        create: {
          mode: 'AUTO_ITERATION',
          status: 'PAUSED',
          config: { maxIterations: 0 },
          progress: { currentIteration: 8, currentMetricSummary: 'paused metric' },
        },
      },
    },
  });
  await expect(workspaceAutoIterationService.recoverStaleStatuses()).resolves.toEqual([
    { id: 'loop' },
  ]);
  expect(events).toEqual([
    {
      workspaceId: 'loop',
      mode: 'AUTO_ITERATION',
      autoIterationStatus: 'FAILED',
      autoIteration: {
        status: 'FAILED',
        currentIteration: 3,
        maxIterations: 12,
        currentMetricSummary: 'score=7',
      },
    },
  ]);
  expect(
    await db.prisma.workspaceAutoIteration.findUniqueOrThrow({ where: { workspaceId: 'paused' } })
  ).toMatchObject({ status: 'PAUSED' });
  await expect(workspaceAutoIterationService.recoverStaleStatuses()).resolves.toEqual([]);
  expect(events).toHaveLength(1);
});

it('publishes no fact for missing/deleted rows or a deleted-row completion', async () => {
  await db.prisma.workspace.delete({ where: { id: 'loop' } });
  await expect(workspaceAutoIterationService.setProgress('loop', progress)).rejects.toThrow(
    'not found'
  );
  await expect(
    workspaceAutoIterationService.finishSessionIfMatching('loop', 'active', 'FAILED')
  ).resolves.toBe(false);
  expect(events).toEqual([]);
});
