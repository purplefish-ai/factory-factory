import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import {
  workspacePRMonitoringService,
  workspacePrSnapshotService,
} from '@/backend/services/workspace';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { exportDataSchema, type ExportData } from '@/shared/schemas/export-data.schema';
import type { PrismaClient } from '@prisma-gen/client';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return state.prisma;
  },
}));
let db: IntegrationDatabase;
let source: ExportData;
let receipt: string;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
  await db.prisma.project.create({
    data: { id: 'p', slug: 'p', name: 'P', repoPath: '/p', worktreeBasePath: '/w' },
  });
  for (const id of ['root', 'child', 'healthy']) {
    await db.prisma.workspace.create({
      data: {
        id,
        projectId: 'p',
        name: id,
        status: 'READY',
        parentWorkspaceId: id === 'child' ? 'root' : null,
      },
    });
    if (id === 'child') {
      continue;
    }
    await db.prisma.agentSession.create({
      data: {
        id: `session-${id}`,
        workspaceId: id,
        workflow: 'implement',
        provider: 'CLAUDE',
        providerSessionId: `provider-${id}`,
      },
    });
    await db.prisma.workspacePR.create({
      data: { id: `pr-${id}`, workspaceId: id, url: redObservation.url },
    });
    expect(
      await workspacePRMonitoringService.setBinding({
        workspaceId: id,
        recipientSessionId: `session-${id}`,
        enabled: true,
        expectedBindingRevision: 0,
      })
    ).toMatchObject({ applied: true });
    const config = await workspacePRMonitoringService.get(id);
    const target = { workspaceId: id, prId: `pr-${id}` };
    const pr = await workspacePrSnapshotService.find(target);
    const facts = await workspacePrSnapshotService.acceptMonitoredObservation({
      target,
      expectedPrRevision: pr!.revision,
      expectedEventEpoch: config!.eventEpoch,
      observation: { ...redObservation, hasMergeConflict: true },
    });
    expect(facts.eventIds).toHaveLength(2);
    expect(
      await workspacePRMonitoringService.claimDelivery(
        { workspaceId: id, prId: null, bindingRevision: config!.bindingRevision },
        {
          deliveryId: `receipt-${id}`,
          sessionId: `session-${id}`,
          eventIds: facts.eventIds,
          text: `frozen ${id}`,
        }
      )
    ).not.toBeNull();
  }
  source = await dataBackupService.exportData('receipt-collisions');
  receipt = source.data.workspaces.find((w) => w.id === 'root')!.prEvents[0]!.deliveryId!;
  expect(receipt).toBe('receipt-root');
}, 30_000);
beforeEach(async () => {
  await clearIntegrationDatabase(db.prisma);
  await db.prisma.workspaceChildOrigin.deleteMany();
  await db.prisma.workspaceLaunchOrigin.deleteMany();
  await db.prisma.project.create({
    data: {
      id: 'local',
      slug: 'local',
      name: 'Local',
      repoPath: '/local',
      worktreeBasePath: '/local/w',
    },
  });
  await db.prisma.workspace.create({ data: { id: 'local', projectId: 'local', name: 'Local' } });
});
afterAll(async () => destroyIntegrationDatabase(db));
const localEvent = (id: string) => ({
  id,
  workspaceId: 'local',
  kind: 'MONITORING_ENABLED',
  deduplicationKey: `local-${id}`,
  payload: {
    kind: 'MONITORING_ENABLED',
    workspaceId: 'local',
    bindingRevision: 0,
    replyToPrComments: false,
  },
});
function retained() {
  return Promise.all([
    db.prisma.workspacePREvent.findMany({
      where: { workspaceId: 'local' },
      orderBy: { id: 'asc' },
    }),
    db.prisma.workspacePRDelivery.findMany({
      where: { workspaceId: 'local' },
      orderBy: { id: 'asc' },
    }),
  ]);
}
async function assertSkipped(input: ExportData) {
  expect(exportDataSchema.safeParse(input).success).toBe(true);
  const before = await retained();
  const result = await dataBackupService.importData(input);
  expect(result.workspaces).toEqual({ imported: 1, skipped: 2 });
  expect(result.agentSessions).toEqual({ imported: 1, skipped: 1 });
  expect(result.inertTransforms.heldReceipts).toBe(1);
  expect(result.inertTransforms.monitors).toBe(1);
  expect(await db.prisma.workspace.findUnique({ where: { id: 'root' } })).toBeNull();
  expect(await db.prisma.workspace.findUnique({ where: { id: 'child' } })).toBeNull();
  expect(await db.prisma.workspacePREvent.count({ where: { workspaceId: 'root' } })).toBe(0);
  const healthy = input.data.workspaces.find((w) => w.id === 'healthy')!;
  expect(
    await db.prisma.workspacePRDelivery.findUnique({ where: { id: 'receipt-healthy' } })
  ).toMatchObject({
    state: 'BLOCKED',
    eventIds: healthy.prEvents.map((event) => event.id),
    text: 'frozen healthy',
    deliveredAt: null,
  });
  expect(await retained()).toEqual(before);
  const repeated = await dataBackupService.importData(input);
  expect(repeated.workspaces).toEqual({ imported: 0, skipped: 3 });
  expect(repeated.inertTransforms.heldReceipts).toBe(0);
  expect(await retained()).toEqual(before);
}

it.each(['event', 'normalized', 'raw-only', 'batch-only', 'raw-and-normalized'] as const)(
  'skips every member and child on a target %s collision while healthy receipts commit',
  async (kind) => {
    const root = source.data.workspaces.find((w) => w.id === 'root')!;
    if (kind === 'event') {
      await db.prisma.workspacePREvent.create({ data: localEvent(root.prEvents[1]!.id) });
    }
    if (kind === 'normalized' || kind === 'raw-and-normalized') {
      await db.prisma.workspacePRDelivery.create({
        data: { id: receipt, workspaceId: 'local', state: 'BLOCKED', eventIds: [] },
      });
    }
    if (kind === 'raw-only' || kind === 'raw-and-normalized') {
      await db.prisma.workspacePREvent.create({
        data: {
          ...localEvent('retained-raw'),
          deliveryId: receipt,
          attempts: 3,
          deliveryText: 'local raw proof',
          claimedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      if (kind === 'raw-only') {
        expect(await db.prisma.workspacePRDelivery.count()).toBe(0);
      }
    }
    if (kind === 'batch-only') {
      // Damaged historical evidence is still reserved even when its normalized row is absent.
      await db.prisma.$executeRawUnsafe('PRAGMA foreign_keys = OFF');
      try {
        await db.prisma.workspacePREvent.create({
          data: { ...localEvent('retained-batch'), batchId: receipt },
        });
      } finally {
        await db.prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON');
      }
    }
    await assertSkipped(structuredClone(source));
  }
);

it('excludes a contradictory quarantined receipt on one member collision without changing local raw proof', async () => {
  const input = structuredClone(source);
  const events = input.data.workspaces.find((w) => w.id === 'root')!.prEvents;
  events[0]!.deliveryText = 'original bytes';
  events[1]!.deliveryText = 'contradictory bytes';
  await db.prisma.workspacePREvent.create({
    data: {
      ...localEvent(events[1]!.id),
      deliveryId: 'local-different-receipt',
      deliveryText: 'retained contradiction',
      attempts: 3,
    },
  });
  await assertSkipped(input);
});
it('excludes a colliding unfrozen fact by event ID without fabricating receipt success', async () => {
  const input = structuredClone(source);
  const events = input.data.workspaces.find((w) => w.id === 'root')!.prEvents;
  for (const event of events) {
    Object.assign(event, {
      state: 'PENDING',
      deliveryId: null,
      deliverySessionId: null,
      deliveryProvider: null,
      deliveryProviderSessionId: null,
      deliveryBindingRevision: null,
      deliveryText: null,
      claimedAt: null,
      deliveredAt: null,
    });
  }
  await db.prisma.workspacePREvent.create({ data: localEvent(events[1]!.id) });
  await assertSkipped(input);
});
it('finds a late event conflict beyond 1,000 candidates before admitting any receipt member', async () => {
  const input = structuredClone(source);
  const root = input.data.workspaces.find((w) => w.id === 'root')!;
  const first = root.prEvents[0]!;
  root.prEvents = Array.from({ length: 1101 }, (_, index) => ({
    ...first,
    id: `large-${index}`,
    deduplicationKey: `large-${index}`,
  }));
  await db.prisma.workspacePREvent.create({ data: localEvent('large-1100') });
  await assertSkipped(input);
});
