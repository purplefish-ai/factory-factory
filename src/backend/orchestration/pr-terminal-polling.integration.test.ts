// Install the shared mocks before loading service barrels.
import './pr-event-flow.test-helpers';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ratchetService } from '@/backend/services/ratchet';
import { sessionBackgroundDeliveryService } from '@/backend/services/session';
import {
  workspacePRMonitoringService,
  workspacePrSnapshotService,
} from '@/backend/services/workspace';
import {
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { createPRDeliveryPorts } from './pr-delivery-dependencies';
import { createPRBackgroundDeliveryPort } from './pr-event-delivery-port';
import { preparePRDelivery, wakePRDelivery } from './pr-event-delivery.orchestrator';
import { createPRFlowIntegrationDatabase } from './pr-event-flow.test-helpers';
import { createPRMonitoringTestServices } from './testing/pr-monitoring-services.test-support';

const deliveryPorts = createPRDeliveryPorts(createPRMonitoringTestServices());
const prBackgroundDeliveryPort = createPRBackgroundDeliveryPort(deliveryPorts);

let db: IntegrationDatabase;
beforeEach(() => {
  // Match the delivery integration seam: freshness is supplied by its own port.
  vi.spyOn(deliveryPorts, 'refreshObservation').mockResolvedValue(true);
});
beforeAll(async () => {
  db = await createPRFlowIntegrationDatabase();
}, 30_000);
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});

it('delivers and retries a saved merge event when all associations stop background observation', async () => {
  const workspaceId = 'terminal-polling';
  const sessionId = `${workspaceId}-main`;
  const prId = `${workspaceId}-pr`;
  await db.prisma.workspace.create({
    data: {
      id: workspaceId,
      projectId: 'project',
      name: 'Merged',
      status: 'READY',
      worktreePath: db.tempDir,
      prMonitoring: { create: { enabled: true, bindingRevision: 1, eventEpoch: 1 } },
      prs: { create: { id: prId, url: redObservation.url } },
    },
  });
  await db.prisma.agentSession.create({
    data: {
      id: sessionId,
      workspaceId,
      workflow: 'implement',
      model: 'custom',
      provider: 'CODEX',
      providerSessionId: sessionId,
    },
  });
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId },
    data: { recipientSessionId: sessionId },
  });
  await workspacePrSnapshotService.acceptMonitoredObservation({
    target: { workspaceId, prId },
    expectedPrRevision: 0,
    expectedEventEpoch: 1,
    observation: { ...redObservation, prState: 'MERGED', ciStatus: 'SUCCESS', checks: [] },
  });
  expect((await workspacePRMonitoringService.listPending(workspaceId)).map((e) => e.kind)).toEqual([
    'PR_MERGED',
  ]);
  const observe = vi.fn().mockResolvedValue(true);
  ratchetService.configure({
    observe,
    wake: (id, isCurrent) => wakePRDelivery(id, deliveryPorts, isCurrent),
    setMonitoring: vi.fn(),
  });
  vi.mocked(sessionBackgroundDeliveryService.enqueue).mockClear();
  await ratchetService.checkWorkspaceById(workspaceId);
  expect(observe).not.toHaveBeenCalled();
  expect(sessionBackgroundDeliveryService.enqueue).toHaveBeenCalledExactlyOnceWith(sessionId, {
    workspaceId,
    prId,
    bindingRevision: 1,
  });
  const request = { workspaceId, prId, bindingRevision: 1 };
  const prepared = await preparePRDelivery({ sessionId, request }, deliveryPorts);
  if (prepared.status !== 'ready') {
    throw new Error('Expected terminal delivery');
  }
  await prBackgroundDeliveryPort.fail(prepared.delivery, {
    reason: 'failed',
    error: new Error('temporary transport failure'),
  });
  await ratchetService.checkWorkspaceById(workspaceId);
  const retry = await preparePRDelivery({ sessionId, request }, deliveryPorts);
  if (retry.status !== 'ready') {
    throw new Error('Expected terminal retry');
  }
  expect(retry.delivery.deliveryId).toBe(prepared.delivery.deliveryId);
  await prBackgroundDeliveryPort.complete(retry.delivery);
  expect(await workspacePRMonitoringService.listPending(workspaceId)).toEqual([]);
  expect(observe).not.toHaveBeenCalled();
  expect(await workspacePRMonitoringService.get(workspaceId)).toMatchObject({
    enabled: true,
    recipientSessionId: sessionId,
  });
});
