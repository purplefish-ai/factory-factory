import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { prAssociationBackupSchema } from '@/shared/schemas/pr-monitoring-backup.schema';
import type { PrismaClient } from '@prisma-gen/client';
import { projectWorkspacePRCollection, workspacePrAccessor } from './workspace-pr.accessor';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return database.prisma;
  },
}));
let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
}, 30_000);
beforeEach(async () => {
  await clearIntegrationDatabase(db.prisma);
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'P',
      slug: 'p',
      repoPath: '/tmp/p',
      worktreeBasePath: '/tmp/w',
    },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'ws',
      projectId: 'project',
      name: 'W',
      status: 'READY',
      prMonitoring: { create: { enabled: false } },
    },
  });
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

async function observe(prId: string, prState: 'MERGED' | 'CLOSED', observedAt: string) {
  const row = await db.prisma.workspacePR.findUniqueOrThrow({ where: { id: prId } });
  expect(
    await workspacePrAccessor.acceptMonitoredObservation({
      target: { workspaceId: 'ws', prId },
      expectedPrRevision: row.revision,
      expectedEventEpoch: 0,
      observation: { ...redObservation, prState, observedAt },
    })
  ).toMatchObject({ applied: true });
}

it('counts a merge after a dismissed close when a reopen was missed between polls', async () => {
  const { prId } = await workspacePrAccessor.attach('ws', redObservation.url);
  await observe(prId, 'CLOSED', '2026-11-04T12:00:00.000Z');
  await workspacePrAccessor.dismissCompletedPRs('ws', new Date('2026-11-04T12:01:00.000Z'));
  expect(await db.prisma.workspacePR.findUniqueOrThrow({ where: { id: prId } })).toMatchObject({
    completionDismissed: true,
    revision: 2,
    terminalObservedAt: new Date('2026-11-04T12:00:00.000Z'),
  });
  expect(
    projectWorkspacePRCollection(await workspacePrAccessor.list('ws'), true).prs[0]
  ).toMatchObject({ revision: 2 });
  expect(
    await workspacePrAccessor.acceptMonitoredObservation({
      target: { workspaceId: 'ws', prId },
      expectedPrRevision: 1,
      expectedEventEpoch: 0,
      observation: {
        ...redObservation,
        prState: 'MERGED',
        observedAt: '2026-11-04T12:02:00.000Z',
      },
    })
  ).toMatchObject({ applied: false });

  await observe(prId, 'MERGED', '2026-11-04T12:02:00.000Z');
  expect(await db.prisma.workspacePR.findUniqueOrThrow({ where: { id: prId } })).toMatchObject({
    completionDismissed: false,
    terminalObservedAt: new Date('2026-11-04T12:02:00.000Z'),
  });
  expect(
    projectWorkspacePRCollection(await workspacePrAccessor.list('ws'), true).prSummary.state
  ).toBe('MERGED');

  // An admission accepted before this merge cannot dismiss its new completion.
  await workspacePrAccessor.dismissCompletedPRs('ws', new Date('2026-11-04T12:01:30.000Z'));
  await observe(prId, 'MERGED', '2026-11-04T12:03:00.000Z');
  expect(await db.prisma.workspacePR.findUniqueOrThrow({ where: { id: prId } })).toMatchObject({
    completionDismissed: false,
    terminalObservedAt: new Date('2026-11-04T12:02:00.000Z'),
  });
});

it('keeps a first terminal observation after human acceptance eligible for completion', async () => {
  const { prId } = await workspacePrAccessor.attach('ws', redObservation.url);
  const acceptedAt = new Date('2026-11-04T12:00:00.000Z');
  await observe(prId, 'MERGED', '2026-11-04T12:01:00.000Z');

  // The human admission began earlier but its persistence resumes after the poll.
  expect(await workspacePrAccessor.dismissCompletedPRs('ws', acceptedAt)).toBeNull();
  expect(await db.prisma.workspacePR.findUniqueOrThrow({ where: { id: prId } })).toMatchObject({
    completionDismissed: false,
    terminalObservedAt: new Date('2026-11-04T12:01:00.000Z'),
  });
  expect(
    projectWorkspacePRCollection(await workspacePrAccessor.list('ws'), true).prSummary.state
  ).toBe('MERGED');
});

it('persists historical completion, preserves polling history, and completes subsequent PRs', async () => {
  const { prId } = await workspacePrAccessor.attach('ws', redObservation.url);
  const observe = async (prState: 'MERGED' | 'OPEN' | 'CLOSED', observedAt: string) => {
    const row = await db.prisma.workspacePR.findUniqueOrThrow({ where: { id: prId } });
    expect(
      await workspacePrAccessor.acceptMonitoredObservation({
        target: { workspaceId: 'ws', prId },
        expectedPrRevision: row.revision,
        expectedEventEpoch: 0,
        observation: { ...redObservation, prState, observedAt },
      })
    ).toMatchObject({ applied: true });
  };
  const projection = async () =>
    projectWorkspacePRCollection(await workspacePrAccessor.list('ws'), true);
  await observe('MERGED', '2026-11-04T12:00:00.000Z');
  expect((await projection()).prSummary.state).toBe('MERGED');
  await observe('MERGED', '2026-11-04T12:02:00.000Z');
  await workspacePrAccessor.dismissCompletedPRs('ws', new Date('2026-11-04T12:01:00.000Z'));
  const reopened = await projection();
  expect(reopened.prSummary.state).toBe('NONE');
  expect(reopened.prs).toEqual([
    expect.objectContaining({ id: prId, state: 'MERGED', completionDismissed: true }),
  ]);
  await observe('MERGED', '2026-11-04T12:03:00.000Z');
  expect((await projection()).prSummary.state).toBe('NONE');
  expect(await db.prisma.workspacePR.findUniqueOrThrow({ where: { id: prId } })).toMatchObject({
    completionDismissed: true,
    terminalObservedAt: new Date('2026-11-04T12:00:00.000Z'),
  });

  const { prId: second } = await workspacePrAccessor.attach(
    'ws',
    'https://github.com/org/repo/pull/2'
  );
  expect((await projection()).prSummary.hasNonterminal).toBe(true);
  await db.prisma.workspacePR.update({ where: { id: second }, data: { state: 'MERGED' } });
  expect((await projection()).prSummary.state).toBe('MERGED');
  await workspacePrAccessor.dismissCompletedPRs('ws', new Date('2026-11-04T12:03:00.000Z'));
  expect((await projection()).prSummary.state).toBe('NONE');

  await observe('OPEN', '2026-11-04T12:04:00.000Z');
  expect((await projection()).prs.find((pr) => pr.id === prId)?.completionDismissed).toBe(false);
  await observe('CLOSED', '2026-11-04T12:05:00.000Z');
  expect((await projection()).prSummary.state).toBe('CLOSED');

  // A delayed admission write must not dismiss a subsequent terminal observation.
  await workspacePrAccessor.dismissCompletedPRs('ws', new Date('2026-11-04T12:04:30.000Z'));
  expect((await projection()).prSummary.state).toBe('CLOSED');
  await db.prisma.workspace.update({ where: { id: 'ws' }, data: { status: 'ARCHIVED' } });
  expect(
    await workspacePrAccessor.dismissCompletedPRs('ws', new Date('2026-11-04T13:00:00.000Z'))
  ).toBeNull();

  const row = await db.prisma.workspacePR.findUniqueOrThrow({ where: { id: second } });
  const { workspaceId: _workspaceId, ...backupRow } = row;
  const backup = {
    ...backupRow,
    syncedAt: null,
    terminalObservedAt: null,
    detachedAt: null,
    ciFailedAt: null,
    ciLastNotifiedAt: null,
    reviewLastCheckedAt: null,
  };
  expect(prAssociationBackupSchema.parse(backup).completionDismissed).toBe(true);
  const { completionDismissed: _dismissed, ...legacy } = backup;
  expect(prAssociationBackupSchema.parse(legacy).completionDismissed).toBe(false);
});
