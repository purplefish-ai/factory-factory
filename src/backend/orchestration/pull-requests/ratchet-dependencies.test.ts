import { expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { PRMonitoringServices } from './pr-monitoring-dependencies';
import { createRatchetService } from './ratchet-dependencies';

const jobs = vi.hoisted(() => ({ register: vi.fn(), start: vi.fn(), stop: vi.fn() }));
vi.mock('@/backend/services/job-runner.service', () => ({ jobRunner: jobs }));
// The poll loop still reads its own monitoring rows through the workspace barrel.
vi.mock('@/backend/services/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/backend/services/workspace')>()),
  workspacePRMonitoringService: { get: vi.fn(async () => null) },
}));

function createGraph() {
  const monitoring = {
    listLegacyRetirementCandidates: vi.fn(async () => []),
    get: vi.fn(async () => null),
  };
  const snapshots = { find: vi.fn(async () => null) };
  const services = unsafeCoerce<PRMonitoringServices>({
    workspacePRMonitoringService: monitoring,
    workspacePrSnapshotService: snapshots,
  });
  return { monitoring, snapshots, services };
}

it('registers the poll and retention jobs without reading the graph', () => {
  jobs.register.mockClear();
  const getServices = vi.fn();
  createRatchetService(getServices);
  expect(jobs.register.mock.calls.map(([job]) => job.name)).toEqual([
    'pr-event-poll',
    'pr-event-retention',
  ]);
  expect(getServices).not.toHaveBeenCalled();
});

it('drives cutover, observation, wakes and monitoring changes through the supplied graph', async () => {
  const { monitoring, snapshots, services } = createGraph();
  const ratchet = createRatchetService(() => services);

  await ratchet.start();
  expect(monitoring.listLegacyRetirementCandidates).toHaveBeenCalledOnce();
  expect(jobs.start.mock.calls).toEqual([['pr-event-poll'], ['pr-event-retention']]);

  await ratchet.wakePendingEvents('custom-workspace');
  expect(monitoring.get).toHaveBeenCalledWith('custom-workspace');

  monitoring.get.mockClear();
  await expect(
    ratchet.setWorkspaceRatcheting('custom-workspace', true, { expectedBindingRevision: 5 })
  ).rejects.toThrow();
  expect(monitoring.get).toHaveBeenCalledExactlyOnceWith('custom-workspace');

  await ratchet.stop();
  expect(snapshots.find).not.toHaveBeenCalled();
});
