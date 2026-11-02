import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import type { PrismaClient } from '@prisma-gen/client';
import { workspacePrMonitoringAccessor } from './workspace-pr-monitoring.accessor';
import { workspacePrAccessor } from './workspace-pr.accessor';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!database.prisma) {
      throw new Error('Missing database');
    }
    return database.prisma;
  },
}));
let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
  await db.prisma.project.create({
    data: {
      id: 'polling-project',
      name: 'Project',
      slug: 'polling-project',
      repoPath: '/tmp/p',
      worktreeBasePath: '/tmp/w',
    },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'polling-workspace',
      projectId: 'polling-project',
      name: 'Workspace',
      status: 'READY',
      prMonitoring: { create: { enabled: true } },
    },
  });
}, 30_000);
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});

it('applies terminal backoff in stale scheduling without disabling monitoring or dropping siblings', async () => {
  const now = Date.now();
  const base = { workspaceId: 'polling-workspace', ciStatus: 'SUCCESS' as const };
  await db.prisma.workspacePR.createMany({
    data: [
      {
        ...base,
        id: 'merged',
        url: 'https://github.com/org/repo/pull/1',
        state: 'MERGED',
        syncedAt: new Date(now - 60 * 60_000),
        observation: { ...redObservation, prState: 'MERGED' },
      },
      {
        ...base,
        id: 'closed-recent',
        url: 'https://github.com/org/repo/pull/2',
        state: 'CLOSED',
        syncedAt: new Date(now - 10 * 60_000),
        observation: { ...redObservation, prState: 'CLOSED' },
      },
      {
        ...base,
        id: 'closed-due',
        url: 'https://github.com/org/repo/pull/3',
        state: 'CLOSED',
        syncedAt: new Date(now - 31 * 60_000),
        observation: { ...redObservation, prState: 'CLOSED' },
      },
      {
        ...base,
        id: 'open',
        url: 'https://github.com/org/repo/pull/4',
        state: 'OPEN',
        syncedAt: new Date(now - 10 * 60_000),
        observation: redObservation,
      },
      {
        ...base,
        id: 'legacy-merged',
        url: 'https://github.com/org/repo/pull/5',
        state: 'MERGED',
        syncedAt: null,
      },
    ],
  });
  expect((await workspacePrAccessor.findNeedingSync()).map((pr) => pr.prId).sort()).toEqual([
    'closed-due',
    'legacy-merged',
    'open',
  ]);
  await db.prisma.workspacePR.update({
    where: { id: 'closed-recent' },
    data: { state: 'OPEN' },
  });
  expect((await workspacePrAccessor.findNeedingSync()).map((pr) => pr.prId)).toContain(
    'closed-recent'
  );
  const enabled = await workspacePrMonitoringAccessor.listEnabled();
  expect(enabled).toHaveLength(1);
  expect(enabled[0]?.enabled).toBe(true);
  expect(enabled[0]?.workspace.prs).toHaveLength(5);
});
