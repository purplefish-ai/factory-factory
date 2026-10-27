import { expect, it, vi } from 'vitest';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import type { PRObservationPorts } from './pr-observation-ports';
import { observeMonitoredPR } from './pr-observation.orchestrator';

vi.mock('@/backend/services/session', () => {
  throw new Error('Observation must not initialize session runtime');
});
vi.mock('@/backend/services/ratchet', () => {
  throw new Error('Observation must not initialize ratchet');
});
vi.mock('@/backend/services/github', () => {
  throw new Error('Observation must not initialize the GitHub service barrel');
});
vi.mock('@/backend/services/workspace', () => {
  throw new Error('Observation must not initialize workspace services');
});
vi.mock('./pr-delivery-dependencies', () => {
  throw new Error('Observation must not initialize delivery composition');
});
vi.mock('./pr-event-delivery.orchestrator', () => {
  throw new Error('Observation must not initialize delivery');
});
vi.mock('./pr-monitoring-dependencies', () => {
  throw new Error('Observation must not initialize the default application graph');
});

it('loads and accepts an observation with only five supplied capabilities', async () => {
  const publish = vi.fn();
  const ports = {
    cacheScope: {},
    findPR: async () => ({ revision: 7, state: 'NONE' }),
    getMonitoring: async () => ({ eventEpoch: 3 }),
    fetchObservation: async () => redObservation,
    acceptObservation: async () => ({ applied: true }),
    publishAcceptedObservation: publish,
  } satisfies PRObservationPorts;

  expect(await observeMonitoredPR(ports, { workspaceId: 'w', prId: 'p' })).toBe(true);
  expect(publish).toHaveBeenCalledWith({
    workspaceId: 'w',
    prId: 'p',
    prUrl: redObservation.url,
    prNumber: 1,
    prState: 'OPEN',
    previousPrState: 'NONE',
    prCiStatus: 'FAILURE',
    prReviewState: null,
  });
});
