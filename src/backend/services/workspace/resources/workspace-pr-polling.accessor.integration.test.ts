import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { Prisma, type PrismaClient } from '@prisma-gen/client';
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

it.each(['enable', 'recipient'] as const)(
  'initializes saved terminal facts for the new monitoring epoch after %s changes',
  async (change) => {
    const workspaceId = `epoch-${change}`;
    await db.prisma.workspace.create({
      data: {
        id: workspaceId,
        projectId: 'polling-project',
        name: workspaceId,
        status: 'READY',
        prMonitoring: { create: { enabled: change === 'recipient' } },
      },
    });
    for (const id of ['first', 'second']) {
      await db.prisma.agentSession.create({
        data: {
          id: `${workspaceId}-${id}`,
          workspaceId,
          workflow: 'implement',
          provider: 'CODEX',
          providerSessionId: id,
          model: 'custom',
        },
      });
    }
    await db.prisma.workspacePRMonitoring.update({
      where: { workspaceId },
      data: {
        recipientSessionId: `${workspaceId}-first`,
      },
    });
    const prs = await Promise.all(
      ['MERGED', 'CLOSED'].map((state, index) =>
        db.prisma.workspacePR.create({
          data: {
            workspaceId,
            url: `https://github.com/org/repo/pull/${index + 10}`,
            state: state === 'MERGED' ? 'MERGED' : 'CLOSED',
          },
        })
      )
    );
    for (const pr of prs) {
      await workspacePrAccessor.acceptMonitoredObservation({
        target: { workspaceId, prId: pr.id },
        expectedPrRevision: 0,
        expectedEventEpoch: 0,
        observation: {
          ...redObservation,
          url: pr.url,
          prState: pr.state === 'MERGED' ? 'MERGED' : 'CLOSED',
          ciStatus: 'SUCCESS',
          checks: [],
          observedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        },
      });
    }
    await workspacePrMonitoringAccessor.setBinding({
      workspaceId,
      enabled: true,
      expectedBindingRevision: 0,
      recipientSessionId: `${workspaceId}-${change === 'recipient' ? 'second' : 'first'}`,
    });
    const config = await workspacePrMonitoringAccessor.get(workspaceId);
    expect(config?.eventEpoch).toBe(1);
    expect(config?.recipientSessionId).toBe(
      `${workspaceId}-${change === 'recipient' ? 'second' : 'first'}`
    );
    expect(
      (await workspacePrAccessor.findNeedingSync())
        .filter((pr) => pr.id === workspaceId)
        .map((pr) => pr.prId)
        .sort()
    ).toEqual(prs.map((pr) => pr.id).sort());
    for (const pr of prs) {
      await workspacePrAccessor.acceptMonitoredObservation({
        target: { workspaceId, prId: pr.id },
        expectedPrRevision: 1,
        expectedEventEpoch: 1,
        observation: {
          ...redObservation,
          url: pr.url,
          prState: pr.state === 'MERGED' ? 'MERGED' : 'CLOSED',
          ciStatus: 'SUCCESS',
          checks: [],
          observedAt: new Date().toISOString(),
        },
      });
    }
    const pending = await db.prisma.workspacePREvent.findMany({
      where: { workspaceId, state: 'PENDING' },
    });
    expect(pending.map((event) => event.kind).sort()).toEqual(['PR_CLOSED', 'PR_MERGED']);
    expect(pending.every((event) => event.deduplicationKey.includes(':epoch:1:'))).toBe(true);
    expect(
      (await workspacePrAccessor.findNeedingSync()).filter((pr) => pr.id === workspaceId)
    ).toEqual([]);
  }
);

it('treats SQL NULL and JSON null observations as missing without loading observations', async () => {
  const workspaceId = 'null-observations';
  await db.prisma.workspace.create({
    data: {
      id: workspaceId,
      projectId: 'polling-project',
      name: workspaceId,
      status: 'READY',
      prMonitoring: { create: { enabled: true } },
    },
  });
  const merged = { workspaceId, state: 'MERGED' as const, syncedAt: new Date(0) };
  await db.prisma.workspacePR.createMany({
    data: [
      { ...merged, id: 'sql-null', url: 'https://github.com/org/repo/pull/20' },
      {
        ...merged,
        id: 'json-null',
        url: 'https://github.com/org/repo/pull/21',
        observation: Prisma.JsonNull,
      },
      {
        ...merged,
        id: 'observed',
        url: 'https://github.com/org/repo/pull/22',
        observation: { ...redObservation, prState: 'MERGED' },
      },
      // Stored as the same four bytes long as JSON null, but present.
      {
        ...merged,
        id: 'four-bytes',
        url: 'https://github.com/org/repo/pull/23',
        observation: true,
      },
    ],
  });

  expect(
    (await workspacePrAccessor.findNeedingSync())
      .filter((pr) => pr.id === workspaceId)
      .map((pr) => pr.prId)
      .sort()
  ).toEqual(['json-null', 'sql-null']);
  const config = (await workspacePrMonitoringAccessor.listEnabled()).find(
    (row) => row.workspaceId === workspaceId
  );
  expect(
    Object.fromEntries(config?.workspace.prs.map((pr) => [pr.id, pr.hasObservation]) ?? [])
  ).toEqual({ 'sql-null': false, 'json-null': false, observed: true, 'four-bytes': true });
});
