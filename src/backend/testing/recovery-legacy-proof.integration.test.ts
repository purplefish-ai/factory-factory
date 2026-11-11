import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup/data-backup.service';
import { createPRDeliveryPorts } from '@/backend/orchestration/pull-requests/pr-delivery-dependencies';
import { recoverPRDeliveries } from '@/backend/orchestration/pull-requests/pr-delivery-recovery';
import {
  preparePRDelivery,
  wakePRDelivery,
} from '@/backend/orchestration/pull-requests/pr-event-delivery.orchestrator';
import type { PRDeliveryPorts } from '@/backend/orchestration/pull-requests/pr-monitoring-ports';
import { createPRMonitoringTestServices } from '@/backend/orchestration/testing/pr-monitoring-services.test-support';
import { sessionDataService } from '@/backend/services/session';
import {
  workspacePRMonitoringService,
  workspacePrSnapshotService,
} from '@/backend/services/workspace';
import type { PRDeliveryRequest } from '@/shared/pr-monitoring';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import type { PrismaClient } from '@prisma-gen/client';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';

const baseDeliveryPorts = createPRDeliveryPorts(createPRMonitoringTestServices());

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
afterAll(async () => destroyIntegrationDatabase(db));
it('publicly round trips complete contradictory legacy proof as BLOCKED through reenable and recovery', async () => {
  await db.prisma.project.create({
    data: { id: 'p', slug: 'p', name: 'P', repoPath: '/p', worktreeBasePath: '/w' },
  });
  for (const id of ['w', 'healthy']) {
    await db.prisma.workspace.create({
      data: { id, projectId: 'p', name: id, status: 'READY', worktreePath: db.tempDir },
    });
  }
  await db.prisma.agentSession.create({
    data: {
      id: 'main',
      workspaceId: 'w',
      workflow: 'implement',
      provider: 'CLAUDE',
      providerSessionId: 'main-provider',
      status: 'IDLE',
    },
  });
  await db.prisma.workspacePR.create({
    data: { id: 'pr', workspaceId: 'w', url: redObservation.url },
  });
  const binding = await workspacePRMonitoringService.setBinding({
    workspaceId: 'w',
    recipientSessionId: 'main',
    enabled: true,
    expectedBindingRevision: 0,
  });
  expect(binding).toEqual({ applied: true, bindingRevision: 1 });
  const config = await workspacePRMonitoringService.get('w');
  const target = { workspaceId: 'w', prId: 'pr' };
  const pr = await workspacePrSnapshotService.find(target);
  const facts = await workspacePrSnapshotService.acceptMonitoredObservation({
    target,
    expectedPrRevision: pr!.revision,
    expectedEventEpoch: config!.eventEpoch,
    observation: { ...redObservation, hasMergeConflict: true },
  });
  expect(facts.applied).toBe(true);
  expect(facts.eventIds).toHaveLength(2);
  // Historical corruption fixture: current claims freeze one agreed tuple per effect.
  for (const [index, id] of facts.eventIds.entries()) {
    await db.prisma.workspacePREvent.update({
      where: { id },
      data: {
        deliveryId: 'legacy-inconsistent',
        deliverySessionId: 'main',
        deliveryProvider: 'CLAUDE',
        deliveryProviderSessionId: 'main-provider',
        deliveryBindingRevision: 1,
        deliveryText: index === 0 ? 'original 🐟\nbytes' : 'contradictory 🐟\nbytes',
        attempts: 3,
        state: 'PENDING',
        claimedAt: new Date('2026-10-01T00:00:00.000Z'),
        deliveredAt: null,
      },
    });
  }
  await workspacePRMonitoringService.resume('main');
  expect(
    await workspacePRMonitoringService.recoverClaim('legacy-inconsistent', true)
  ).toMatchObject({ count: 0, status: 'identity_mismatch' });
  const source = await dataBackupService.exportData('legacy-proof');
  expect(source.meta.schemaVersion).toBe(8);
  expect(exportDataSchema.safeParse(source).success).toBe(true);
  const raw = source.data.workspaces.find((w) => w.id === 'w')!.prEvents;
  expect(raw.map((e) => e.id).sort()).toEqual([...facts.eventIds].sort());
  expect(new Set(raw.map((e) => e.deliveryText)).size).toBe(2);
  expect(raw.every((e) => e.attempts === 3 && e.state === 'PENDING')).toBe(true);
  await clearIntegrationDatabase(db.prisma);
  const imported = await dataBackupService.importData(source);
  expect(imported.workspaces).toEqual({ imported: 2, skipped: 0 });
  expect(imported.inertTransforms).toEqual({
    workspaceWorkflows: 0,
    workspaceInitializations: 0,
    workspaceArchives: 0,
    runScripts: 0,
    terminalSessions: 0,
    agentSessions: 0,
    monitors: 1,
    heldReceipts: 1,
    cancelledFacts: 0,
    explanations: [
      'Restored processes remain stopped. Start them manually when ready.',
      'Unfinished workspace initialization and archiving require manual recovery; original status is retained in the workspace error.',
      'PR monitoring is disabled. Unsettled imported receipts remain blocked even after reenable; unclaimed pending facts are cancelled without claiming delivery.',
    ],
  });
  expect(await db.prisma.workspace.findUnique({ where: { id: 'healthy' } })).toMatchObject({
    status: 'READY',
  });
  const assertPreserved = async () => {
    expect(
      await db.prisma.workspacePRDelivery.findUnique({ where: { id: 'legacy-inconsistent' } })
    ).toMatchObject({
      state: 'BLOCKED',
      eventIds: expect.arrayContaining(facts.eventIds),
      deliveredAt: null,
    });
    const reexport = await dataBackupService.exportData('legacy-proof');
    expect(reexport.data.workspaces.find((w) => w.id === 'w')!.prEvents).toEqual(raw);
  };
  expect(await workspacePRMonitoringService.get('w')).toMatchObject({ enabled: false });
  await assertPreserved();
  const importedConfig = await workspacePRMonitoringService.get('w');
  const enabled = await workspacePRMonitoringService.setBinding({
    workspaceId: 'w',
    recipientSessionId: 'main',
    enabled: true,
    resume: true,
    expectedBindingRevision: importedConfig!.bindingRevision,
  });
  expect(enabled).toEqual({ applied: true, bindingRevision: importedConfig!.bindingRevision + 1 });
  expect(await workspacePRMonitoringService.get('w')).toMatchObject({
    enabled: true,
    deliveryMode: 'MAIN',
    recipientSessionId: 'main',
    bindingRevision: enabled.bindingRevision,
  });
  expect(await sessionDataService.findAgentSessionById('main')).toMatchObject({
    workspace: { status: 'READY' },
    status: 'IDLE',
    providerSessionId: 'main-provider',
  });
  const sends = vi.fn();
  const queued = new Map<string, PRDeliveryRequest>();
  const drains: Promise<void>[] = [];
  const receipt = vi.fn<typeof baseDeliveryPorts.findPRDeliveryReceipt>(async () => 'absent');
  const ports: PRDeliveryPorts = {
    ...baseDeliveryPorts,
    sessionDataService,
    workspacePRMonitoringService,
    acpRuntimeManager: {
      ...baseDeliveryPorts.acpRuntimeManager,
      isSessionPromptInFlight: () => false,
    },
    sessionBackgroundDeliveryService: {
      ...baseDeliveryPorts.sessionBackgroundDeliveryService,
      isDeliveryActive: () => false,
    },
    sessionDomainService: { getPendingInteractiveRequest: () => null },
    sessionLifecycleService: {
      startSession: () => {
        throw new Error('Legacy evidence must not start provider');
      },
    },
    findPRDeliveryReceipt: receipt,
    backgroundDispatch: {
      ...baseDeliveryPorts.backgroundDispatch,
      enqueue: (sessionId, request) => {
        queued.set(sessionId, request);
        return { queued: true };
      },
      wakeSession: (sessionId) => {
        const drain = (async () => {
          const request = queued.get(sessionId);
          if (
            request &&
            (await preparePRDelivery({ sessionId, request }, ports)).status === 'ready'
          ) {
            sends();
          }
        })();
        drains.push(drain);
        return drain;
      },
    },
  };
  for (const proof of ['absent', 'delivered'] as const) {
    receipt.mockResolvedValue(proof);
    await recoverPRDeliveries('main', 'w', ports);
    await workspacePRMonitoringService.resume('main');
    for (const delivered of [false, true]) {
      expect(
        await workspacePRMonitoringService.recoverClaim('legacy-inconsistent', delivered)
      ).toMatchObject({ count: 0, status: 'identity_mismatch' });
    }
    await workspacePRMonitoringService.cancelRecoveredDelivery('legacy-inconsistent', 'main');
    const current = await workspacePRMonitoringService.get('w');
    expect(current).toMatchObject({ enabled: true, recipientSessionId: 'main' });
    expect(
      await workspacePRMonitoringService.claimDelivery(
        { workspaceId: 'w', prId: null, bindingRevision: current!.bindingRevision },
        {
          deliveryId: 'legacy-inconsistent',
          sessionId: 'main',
          eventIds: facts.eventIds,
          text: 'replacement',
        }
      )
    ).toBeNull();
    expect(
      await preparePRDelivery(
        {
          sessionId: 'main',
          request: { workspaceId: 'w', prId: 'pr', bindingRevision: current!.bindingRevision },
        },
        ports
      )
    ).toMatchObject({ status: 'blocked' });
    await wakePRDelivery('w', ports);
    await Promise.all(drains);
    await assertPreserved();
  }
  expect(receipt).toHaveBeenCalled();
  expect(sends).not.toHaveBeenCalled();
});
