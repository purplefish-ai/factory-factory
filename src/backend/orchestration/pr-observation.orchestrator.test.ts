import { afterEach, expect, it, vi } from 'vitest';
import {
  defaultPRMonitoringServices,
  type PRMonitoringServices,
} from './pr-monitoring-dependencies';
import { recipientCanDispatch } from './pr-observation.orchestrator';
afterEach(() => vi.useRealTimers());
it('fails closed within five seconds when the recipient lookup stalls', async () => {
  vi.useFakeTimers();
  const services = {
    ...defaultPRMonitoringServices,
    sessionDataService: {
      ...defaultPRMonitoringServices.sessionDataService,
      findAgentSessionsByWorkspaceId: vi.fn(
        () =>
          new Promise<never>(() => {
            /* Simulate a stalled query. */
          })
      ),
    },
  };
  const pending = recipientCanDispatch('w', 'main', services as unknown as PRMonitoringServices);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it('fails closed on query failure and blocks another working session', async () => {
  const query = vi
    .fn()
    .mockRejectedValueOnce(new Error('database unavailable'))
    .mockResolvedValueOnce([{ id: 'other' }]);
  const services = {
    ...defaultPRMonitoringServices,
    sessionDataService: {
      ...defaultPRMonitoringServices.sessionDataService,
      findAgentSessionsByWorkspaceId: query,
    },
    acpRuntimeManager: {
      ...defaultPRMonitoringServices.acpRuntimeManager,
      isSessionWorking: vi.fn(() => true),
    },
  };
  expect(await recipientCanDispatch('w', 'main', services as unknown as PRMonitoringServices)).toBe(
    false
  );
  expect(await recipientCanDispatch('w', 'main', services as unknown as PRMonitoringServices)).toBe(
    false
  );
});
