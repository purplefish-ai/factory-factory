import { expect, it, vi } from 'vitest';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import type { PRObservationPorts } from './pr-observation-ports';
import { observeMonitoredPR } from './pr-observation.orchestrator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function observationPorts() {
  return {
    cacheScope: {},
    getMonitoring: vi.fn().mockResolvedValue({ eventEpoch: 3 }),
    findPR: vi.fn().mockResolvedValue({ revision: 7, state: 'NONE' }),
    acceptObservation: vi.fn().mockResolvedValue({ applied: true, eventIds: [] }),
    fetchObservation: vi.fn().mockResolvedValue(redObservation),
    publishAcceptedObservation: vi.fn(),
  } satisfies PRObservationPorts;
}

it('accepts and publishes a normalized observation using only producer ports', async () => {
  const ports = observationPorts();
  const target = { workspaceId: 'w', prId: 'p' };
  expect(await observeMonitoredPR(ports, target, { force: true })).toBe(true);
  expect(ports.fetchObservation).toHaveBeenCalledWith(target, undefined);
  expect(ports.acceptObservation).toHaveBeenCalledWith({
    target,
    expectedPrRevision: 7,
    expectedEventEpoch: 3,
    observation: redObservation,
  });
  expect(ports.publishAcceptedObservation).toHaveBeenCalledWith({
    workspaceId: 'w',
    prId: 'p',
    prUrl: redObservation.url,
    prNumber: redObservation.number,
    prState: redObservation.prState,
    previousPrState: 'NONE',
    prCiStatus: redObservation.ciStatus,
    prReviewState: redObservation.reviewState,
  });
});

it('does not publish an observation rejected by the atomic revision guard', async () => {
  const ports = observationPorts();
  ports.acceptObservation.mockResolvedValue({ applied: false, eventIds: ['rejected'] });
  expect(await observeMonitoredPR(ports, { workspaceId: 'w', prId: 'p' })).toBe(false);
  expect(ports.publishAcceptedObservation).not.toHaveBeenCalled();
});

it('signals new events only after their observation transaction commits', async () => {
  const ports = observationPorts();
  const committed = deferred<{ applied: boolean; eventIds: string[] }>();
  ports.acceptObservation.mockReturnValue(committed.promise);
  const observing = observeMonitoredPR(ports, { workspaceId: 'w', prId: 'p' });
  await vi.waitFor(() => expect(ports.acceptObservation).toHaveBeenCalledOnce());
  expect(ports.publishAcceptedObservation).not.toHaveBeenCalled();
  committed.resolve({ applied: true, eventIds: ['failure'] });
  await observing;
  expect(ports.publishAcceptedObservation).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: 'w', prId: 'p', prEventsCreated: true })
  );
});

it('coalesces concurrent refreshes and releases the producer after a fetch failure', async () => {
  const ports = observationPorts();
  ports.fetchObservation.mockRejectedValueOnce(new Error('GitHub unavailable'));
  const target = { workspaceId: 'w', prId: 'p' };
  const results = await Promise.allSettled([
    observeMonitoredPR(ports, target, { force: true }),
    observeMonitoredPR(ports, target, { force: true }),
  ]);
  expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
  expect(ports.fetchObservation).toHaveBeenCalledTimes(1);
  expect(ports.acceptObservation).not.toHaveBeenCalled();
  expect(await observeMonitoredPR(ports, target, { force: true })).toBe(true);
  expect(ports.fetchObservation).toHaveBeenCalledTimes(2);
});

it('shares in-flight work across separately created poll, manual, and delivery wrappers', async () => {
  const ports = observationPorts();
  const pending = deferred<typeof redObservation>();
  ports.fetchObservation.mockReturnValue(pending.promise);
  const target = { workspaceId: 'w', prId: 'p' };
  const results = [
    observeMonitoredPR({ ...ports }, target),
    observeMonitoredPR({ ...ports }, target, { force: true }),
    observeMonitoredPR({ ...ports }, target, { force: true }),
  ];
  pending.resolve(redObservation);
  expect(await Promise.all(results)).toEqual([true, true, true]);
  expect(ports.fetchObservation).toHaveBeenCalledTimes(1);
  expect(ports.acceptObservation).toHaveBeenCalledTimes(1);
  expect(ports.publishAcceptedObservation).toHaveBeenCalledTimes(1);
});

it('shares recent acceptance by scope while honoring forced refresh, revision, and epoch', async () => {
  const ports = observationPorts();
  const target = { workspaceId: 'w', prId: 'p' };
  await observeMonitoredPR({ ...ports }, target);
  ports.findPR.mockResolvedValue({ revision: 8, state: 'OPEN' });
  expect(await observeMonitoredPR({ ...ports }, target)).toBe(true);
  expect(ports.fetchObservation).toHaveBeenCalledTimes(1);
  await observeMonitoredPR({ ...ports }, target, { force: true });
  expect(ports.fetchObservation).toHaveBeenCalledTimes(2);
  ports.findPR.mockResolvedValue({ revision: 10, state: 'OPEN' });
  await observeMonitoredPR({ ...ports }, target);
  expect(ports.fetchObservation).toHaveBeenCalledTimes(3);
  ports.findPR.mockResolvedValue({ revision: 11, state: 'OPEN' });
  ports.getMonitoring.mockResolvedValue({ eventEpoch: 4 });
  await observeMonitoredPR({ ...ports }, target);
  expect(ports.fetchObservation).toHaveBeenCalledTimes(4);
});

it('does not share in-flight or recent observations between distinct scopes', async () => {
  const first = observationPorts();
  const second = { ...first, cacheScope: {} };
  const pending = deferred<typeof redObservation>();
  first.fetchObservation.mockReturnValue(pending.promise);
  const target = { workspaceId: 'w', prId: 'p' };
  const results = [observeMonitoredPR(first, target), observeMonitoredPR(second, target)];
  pending.resolve(redObservation);
  expect(await Promise.all(results)).toEqual([true, true]);
  expect(first.fetchObservation).toHaveBeenCalledTimes(2);
  first.findPR.mockResolvedValue({ revision: 8, state: 'OPEN' });
  await observeMonitoredPR({ ...first, cacheScope: {} }, target);
  expect(first.fetchObservation).toHaveBeenCalledTimes(3);
});

it('releases in-flight work after acceptance fails', async () => {
  const ports = observationPorts();
  ports.acceptObservation.mockRejectedValueOnce(new Error('transaction failed'));
  const target = { workspaceId: 'w', prId: 'p' };
  await expect(observeMonitoredPR(ports, target)).rejects.toThrow('transaction failed');
  expect(ports.publishAcceptedObservation).not.toHaveBeenCalled();
  expect(await observeMonitoredPR({ ...ports }, target)).toBe(true);
  expect(ports.acceptObservation).toHaveBeenCalledTimes(2);
});
