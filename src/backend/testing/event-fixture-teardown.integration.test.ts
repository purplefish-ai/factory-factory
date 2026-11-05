import { expect, it, vi } from 'vitest';
import {
  boundary,
  drainEventFixtureTasks,
} from '@/backend/orchestration/testing/event-delivery.test-support';
import { h, consumer, launch, providers } from '@/test-utils/event-generic-retry.test-support';

it('awaits a real production idle PR wake before fixture teardown can finish', async () => {
  await launch();
  const { createDefaultApplicationDependencies } =
    await vi.importActual<typeof import('@/backend/app-context')>('@/backend/app-context');
  const graph = createDefaultApplicationDependencies();
  graph.lifecycle.wireDomainBridges(graph.services);
  const wake = boundary();
  const monitoring = h.workspace.workspacePRMonitoringService;
  const get = monitoring.get.bind(monitoring);
  vi.spyOn(monitoring, 'get').mockImplementationOnce(async (...args) => {
    await wake.wait();
    return get(...args);
  });
  providers[0]!.response.resolve({ stopReason: 'end_turn' });
  await wake.entered;
  await consumer.drain();
  let drained = false;
  const teardown = drainEventFixtureTasks().then(() => {
    drained = true;
  });
  try {
    // Advancing the event loop cannot finish teardown while the wake still owns DB work.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
  } finally {
    wake.release();
    await teardown;
  }
  expect(drained).toBe(true);
  expect(monitoring.get).toHaveBeenCalledWith(h.claim.reservedWorkspaceId);
});
