import { expect, it, vi } from 'vitest';
import { PR_SNAPSHOT_UPDATED } from '@/backend/services/github';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import type { PRObservationPorts } from './pr-monitoring-ports';
import { observeMonitoredPR } from './pr-observation.orchestrator';

function observationPorts() {
  return {
    workspacePRMonitoringService: { get: vi.fn().mockResolvedValue({ eventEpoch: 3 }) },
    workspacePrSnapshotService: {
      find: vi.fn().mockResolvedValue({ revision: 7 }),
      acceptMonitoredObservation: vi.fn().mockResolvedValue({ applied: true }),
    },
    prObservationService: { fetch: vi.fn().mockResolvedValue(redObservation) },
    prSnapshotService: { emit: vi.fn(() => true) },
  } satisfies PRObservationPorts;
}

it('accepts and publishes a normalized observation using only producer ports', async () => {
  const ports = observationPorts();
  const target = { workspaceId: 'w', prId: 'p' };
  expect(await observeMonitoredPR(target, undefined, { force: true }, ports)).toBe(true);
  expect(ports.prObservationService.fetch).toHaveBeenCalledWith(target, undefined);
  expect(ports.workspacePrSnapshotService.acceptMonitoredObservation).toHaveBeenCalledWith({
    target,
    expectedPrRevision: 7,
    expectedEventEpoch: 3,
    observation: redObservation,
  });
  expect(ports.prSnapshotService.emit).toHaveBeenCalledWith(PR_SNAPSHOT_UPDATED, {
    workspaceId: 'w',
    prId: 'p',
    prUrl: redObservation.url,
    prNumber: redObservation.number,
    prState: redObservation.prState,
    prCiStatus: redObservation.ciStatus,
    prReviewState: redObservation.reviewState,
  });
});

it('does not publish an observation rejected by the atomic revision guard', async () => {
  const ports = observationPorts();
  ports.workspacePrSnapshotService.acceptMonitoredObservation.mockResolvedValue({ applied: false });
  expect(
    await observeMonitoredPR({ workspaceId: 'w', prId: 'p' }, undefined, undefined, ports)
  ).toBe(false);
  expect(ports.prSnapshotService.emit).not.toHaveBeenCalled();
});

it('coalesces concurrent refreshes and releases the producer after a fetch failure', async () => {
  const ports = observationPorts();
  ports.prObservationService.fetch.mockRejectedValueOnce(new Error('GitHub unavailable'));
  const target = { workspaceId: 'w', prId: 'p' };
  const results = await Promise.allSettled([
    observeMonitoredPR(target, undefined, { force: true }, ports),
    observeMonitoredPR(target, undefined, { force: true }, ports),
  ]);
  expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
  expect(ports.prObservationService.fetch).toHaveBeenCalledTimes(1);
  expect(ports.workspacePrSnapshotService.acceptMonitoredObservation).not.toHaveBeenCalled();
  expect(await observeMonitoredPR(target, undefined, { force: true }, ports)).toBe(true);
  expect(ports.prObservationService.fetch).toHaveBeenCalledTimes(2);
});
