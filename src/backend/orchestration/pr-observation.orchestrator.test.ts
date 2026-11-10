import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PRObservation } from '@/shared/pr-monitoring';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import type { PRObservationPorts } from './pr-observation-ports';
import {
  observeMonitoredPR,
  resetStablePRBackoff,
  STABLE_PR_POLL_INTERVAL_MS,
  STABLE_PR_REPEATS,
} from './pr-observation.orchestrator';

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
    getMonitoring: vi.fn().mockResolvedValue({ eventEpoch: 3, enabled: true }),
    findPR: vi.fn().mockResolvedValue({
      revision: 7,
      state: 'NONE',
      observation: null,
      observationEpoch: 0,
      syncedAt: null,
    }),
    acceptObservation: vi.fn().mockResolvedValue({ applied: true, eventIds: [] }),
    fetchObservation: vi.fn().mockResolvedValue(redObservation),
    publishAcceptedObservation: vi.fn(),
  } satisfies PRObservationPorts;
}

it('accepts and publishes a normalized observation using only producer ports', async () => {
  const ports = observationPorts();
  const target = { workspaceId: 'w', prId: 'p' };
  expect(await observeMonitoredPR(ports, target, { force: true })).toBe(true);
  expect(ports.fetchObservation).toHaveBeenCalledWith(target, undefined, { includeReviews: true });
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
  ports.getMonitoring.mockResolvedValue({ eventEpoch: 4, enabled: true });
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

function storedPR(
  state: string,
  overrides: { observationEpoch?: number; syncedAt?: Date; revision?: number } = {}
) {
  return {
    revision: 7,
    state,
    observation: redObservation,
    observationEpoch: 3,
    syncedAt: new Date(),
    ...overrides,
  };
}

it('skips GitHub for a committed MERGED PR unless the observation is forced', async () => {
  const ports = observationPorts();
  const target = { workspaceId: 'w', prId: 'p' };
  ports.findPR.mockResolvedValue(storedPR('MERGED'));
  expect(await observeMonitoredPR(ports, target)).toBe(true);
  expect(ports.fetchObservation).not.toHaveBeenCalled();
  expect(ports.acceptObservation).not.toHaveBeenCalled();

  expect(await observeMonitoredPR(ports, target, { force: true })).toBe(true);
  expect(ports.fetchObservation).toHaveBeenCalledOnce();
});

it('still observes a merge that has not been committed for the current epoch', async () => {
  const ports = observationPorts();
  const target = { workspaceId: 'w', prId: 'p' };
  // GitHub may already report MERGED while the stored facts are still OPEN.
  ports.findPR.mockResolvedValueOnce(storedPR('OPEN'));
  await observeMonitoredPR({ ...ports, cacheScope: {} }, target);
  expect(ports.fetchObservation).toHaveBeenCalledTimes(1);
  // A merge observed under an earlier monitoring epoch is re-initialized.
  ports.findPR.mockResolvedValueOnce(storedPR('MERGED', { observationEpoch: 2 }));
  await observeMonitoredPR({ ...ports, cacheScope: {} }, target);
  expect(ports.fetchObservation).toHaveBeenCalledTimes(2);
});

it('does not let an explicit refresh settle on an in-flight automatic terminal skip', async () => {
  const ports = observationPorts();
  const target = { workspaceId: 'w', prId: 'p' };
  const lookup = deferred<ReturnType<typeof storedPR>>();
  ports.findPR.mockReturnValueOnce(lookup.promise).mockResolvedValue(storedPR('MERGED'));
  const automatic = observeMonitoredPR(ports, target);
  const explicit = [
    observeMonitoredPR({ ...ports }, target, { force: true }),
    observeMonitoredPR({ ...ports }, target, { force: true }),
  ];
  lookup.resolve(storedPR('MERGED'));
  expect(await Promise.all([automatic, ...explicit])).toEqual([true, true, true]);
  // The automatic call kept committed facts; both explicit calls share one forced read.
  expect(ports.fetchObservation).toHaveBeenCalledOnce();
});

it('paces unforced CLOSED PR observations with the background reopen interval', async () => {
  const ports = observationPorts();
  const target = { workspaceId: 'w', prId: 'p' };
  ports.findPR.mockResolvedValue(storedPR('CLOSED'));
  await observeMonitoredPR(ports, target);
  expect(ports.fetchObservation).not.toHaveBeenCalled();
  ports.findPR.mockResolvedValue(
    storedPR('CLOSED', { syncedAt: new Date(Date.now() - 31 * 60_000) })
  );
  await observeMonitoredPR(ports, target);
  expect(ports.fetchObservation).toHaveBeenCalledOnce();
});

it('fetches review data only while monitoring is enabled', async () => {
  const ports = observationPorts();
  const target = { workspaceId: 'w', prId: 'p' };
  ports.getMonitoring.mockResolvedValue({ eventEpoch: 3, enabled: false });
  expect(await observeMonitoredPR(ports, target, { force: true })).toBe(true);
  expect(ports.fetchObservation).toHaveBeenLastCalledWith(target, undefined, {
    includeReviews: false,
  });

  // Enabling renews the epoch, so the next automatic poll reads review data again.
  ports.getMonitoring.mockResolvedValue({ eventEpoch: 4, enabled: true });
  ports.findPR.mockResolvedValue(storedPR('OPEN', { observationEpoch: 3 }));
  expect(await observeMonitoredPR(ports, target)).toBe(true);
  expect(ports.fetchObservation).toHaveBeenCalledTimes(2);
  expect(ports.fetchObservation).toHaveBeenLastCalledWith(target, undefined, {
    includeReviews: true,
  });
  expect(ports.acceptObservation).toHaveBeenLastCalledWith(
    expect.objectContaining({ expectedEventEpoch: 4 })
  );
});

describe('stable-PR backoff', () => {
  const target = { workspaceId: 'w', prId: 'p' };
  let now = 0;
  beforeEach(() => {
    now = 1_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Ports whose stored revision advances with each accepted observation, like the accessor. */
  function pollingPorts(observation: PRObservation = redObservation) {
    const ports = observationPorts();
    const revisions = new Map<string, number>();
    const revision = (input: { workspaceId: string }) => revisions.get(input.workspaceId) ?? 7;
    ports.findPR.mockImplementation(async (input) =>
      storedPR('OPEN', { revision: revision(input) })
    );
    ports.acceptObservation.mockImplementation(({ target: input }) => {
      revisions.set(input.workspaceId, revision(input) + 1);
      return Promise.resolve({ applied: true, eventIds: [] });
    });
    ports.fetchObservation.mockImplementation(async () => ({
      ...observation,
      // A new observation time alone is not a change.
      observedAt: new Date(now).toISOString(),
    }));
    return ports;
  }
  /** One two-minute poll cycle; returns whether it read GitHub. */
  async function poll(ports: ReturnType<typeof observationPorts>, prTarget = target) {
    now += 2 * 60_000;
    const before = ports.fetchObservation.mock.calls.length;
    expect(await observeMonitoredPR(ports, prTarget)).toBe(true);
    return ports.fetchObservation.mock.calls.length > before;
  }
  async function pollTimes(ports: ReturnType<typeof observationPorts>, times: number) {
    const fetched: boolean[] = [];
    for (let i = 0; i < times; i += 1) {
      fetched.push(await poll(ports));
    }
    return fetched;
  }

  it('stretches an unchanged settled PR to the stable interval after three identical reads', async () => {
    expect(STABLE_PR_REPEATS).toBe(2);
    expect(STABLE_PR_POLL_INTERVAL_MS).toBe(10 * 60_000);
    const ports = pollingPorts();
    expect(await pollTimes(ports, 3)).toEqual([true, true, true]);
    // The next four polls keep the committed facts; the fifth is ten minutes on.
    expect(await pollTimes(ports, 5)).toEqual([false, false, false, false, true]);
    expect(await pollTimes(ports, 5)).toEqual([false, false, false, false, true]);
  });

  it('returns to the normal cadence as soon as an observation changes', async () => {
    const ports = pollingPorts();
    await pollTimes(ports, 3);
    now += STABLE_PR_POLL_INTERVAL_MS;
    ports.fetchObservation.mockResolvedValue({ ...redObservation, headSha: 'head-2' });
    expect(await pollTimes(ports, 4)).toEqual([true, true, true, false]);
  });

  it.each([
    ['running CI', { ciStatus: 'PENDING' }],
    ['unknown CI', { ciStatus: 'UNKNOWN' }],
    ['incomplete review facts', { reviewsComplete: false }],
  ] as const)('keeps the normal cadence while a PR has %s', async (_name, overrides) => {
    const ports = pollingPorts({ ...redObservation, ...overrides });
    expect(await pollTimes(ports, 6)).toEqual(Array(6).fill(true));
  });

  it('backs off a core-only observation whose reviews were not requested', async () => {
    const ports = pollingPorts({ ...redObservation, reviewsComplete: false });
    ports.getMonitoring.mockResolvedValue({ eventEpoch: 3, enabled: false });
    expect(await pollTimes(ports, 4)).toEqual([true, true, true, false]);
  });

  it('returns to the normal cadence after a forced read', async () => {
    const ports = pollingPorts();
    await pollTimes(ports, 3);
    expect(await observeMonitoredPR(ports, target, { force: true })).toBe(true);
    expect(ports.fetchObservation).toHaveBeenCalledTimes(4);
    // The forced read starts a new run of identical reads; two more polls complete it.
    expect(await pollTimes(ports, 3)).toEqual([true, true, false]);
  });

  it('returns only the reset workspace to the normal cadence', async () => {
    const ports = pollingPorts();
    const other = { workspaceId: 'w2', prId: 'p' };
    for (let i = 0; i < 3; i += 1) {
      await poll(ports);
      now -= 2 * 60_000;
      await poll(ports, other);
    }
    resetStablePRBackoff(ports, 'w');
    expect(await poll(ports)).toBe(true);
    now -= 2 * 60_000;
    expect(await poll(ports, other)).toBe(false);
  });

  it('reads again when another writer changed the stored revision', async () => {
    const ports = pollingPorts();
    await pollTimes(ports, 3);
    ports.findPR.mockResolvedValue(storedPR('OPEN', { revision: 99 }));
    expect(await poll(ports)).toBe(true);
  });
});
