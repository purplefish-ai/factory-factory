import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ discardBlockedDeliveries: vi.fn() }));
vi.mock('@/backend/services/job-runner.service', () => ({
  jobRunner: { register: vi.fn() },
}));
vi.mock('@/backend/services/workspace', () => ({
  workspacePRMonitoringService: mocks,
  workspacePrSnapshotService: { list: vi.fn() },
}));

import { RATCHET_DISPATCH_CHANGED, RatchetService } from './ratchet.service';

beforeEach(() => vi.resetAllMocks());

it('publishes a monitoring change only when a blocked delivery was discarded', async () => {
  const service = new RatchetService({ observe: vi.fn(), wake: vi.fn(), setMonitoring: vi.fn() });
  const changed = vi.fn();
  service.on(RATCHET_DISPATCH_CHANGED, changed);
  mocks.discardBlockedDeliveries
    .mockResolvedValueOnce({ count: 2 })
    .mockResolvedValue({ count: 0 });

  await expect(service.discardBlockedPRDeliveries('w')).resolves.toEqual({ discarded: 2 });
  await expect(service.discardBlockedPRDeliveries('w')).resolves.toEqual({ discarded: 0 });

  expect(mocks.discardBlockedDeliveries.mock.calls).toEqual([['w'], ['w']]);
  expect(changed).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'w' });
});
