// Install the shared mocks before loading service barrels.
import './pr-event-flow.test-helpers';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ratchetService } from '@/backend/services/ratchet';
import { workspacePrSnapshotService } from '@/backend/services/workspace';
import {
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { createPRFlowIntegrationDatabase } from './pr-event-flow.test-helpers';
import { createPRObservationPorts } from './pr-monitoring-dependencies';
import { observeMonitoredPR } from './pr-observation.orchestrator';
import { createPRMonitoringTestServices } from './testing/pr-monitoring-services.test-support';

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createPRFlowIntegrationDatabase();
}, 30_000);
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});

it('reuses a just-accepted PR-switch observation, then fetches again after cooldown', async () => {
  const workspaceId = 'pr-switch';
  const target = { workspaceId, prId: 'switched-pr' };
  await db.prisma.workspace.create({
    data: {
      id: workspaceId,
      projectId: 'project',
      name: 'PR switch',
      status: 'READY',
      worktreePath: db.tempDir,
      prMonitoring: { create: { enabled: true, bindingRevision: 1, eventEpoch: 1 } },
      prs: { create: { id: target.prId, url: redObservation.url } },
    },
  });
  const ports = createPRObservationPorts(createPRMonitoringTestServices());
  const fetchObservation = vi.fn().mockResolvedValue(redObservation);
  ports.fetchObservation = fetchObservation;
  const wake = vi.fn().mockResolvedValue(undefined);
  ratchetService.configure({
    observe: (pr, signal) => observeMonitoredPR(ports, pr, { signal }),
    wake,
    setMonitoring: vi.fn(),
  });
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    // Attachment/discovery accepts facts before the collector requests its check.
    await observeMonitoredPR(ports, target, { force: true });
    expect(fetchObservation).toHaveBeenCalledOnce();
    expect(await workspacePrSnapshotService.find(target)).toMatchObject({ revision: 1 });

    await ratchetService.checkWorkspaceById(workspaceId);
    expect(fetchObservation).toHaveBeenCalledOnce();
    expect(await workspacePrSnapshotService.find(target)).toMatchObject({ revision: 1 });
    expect(wake).toHaveBeenCalledExactlyOnceWith(workspaceId, expect.any(Function));

    now += 90_001;
    await ratchetService.checkWorkspaceById(workspaceId);
    expect(fetchObservation).toHaveBeenCalledTimes(2);
    expect(fetchObservation).toHaveBeenLastCalledWith(target, expect.any(AbortSignal), {
      includeReviews: true,
    });
    expect(await workspacePrSnapshotService.find(target)).toMatchObject({ revision: 2 });
    expect(wake).toHaveBeenCalledTimes(2);
  } finally {
    clock.mockRestore();
  }
});
