import { describe, expect, it } from 'vitest';
import { computePRDiscoveryNextCheckAt } from './pr-discovery-schedule';

describe('computePRDiscoveryNextCheckAt', () => {
  const checkedAt = new Date('2026-07-17T12:00:00.000Z');

  it.each([
    [1, 3],
    [2, 6],
    [3, 12],
  ])('schedules retry %i after %i minutes without jitter', (retryCount, minutes) => {
    const nextCheckAt = computePRDiscoveryNextCheckAt(checkedAt, retryCount, () => 0.5);

    expect(nextCheckAt.getTime()).toBe(checkedAt.getTime() + minutes * 60 * 1000);
  });

  it('applies symmetric twenty-percent jitter', () => {
    const lowerBound = computePRDiscoveryNextCheckAt(checkedAt, 1, () => 0);
    const upperBound = computePRDiscoveryNextCheckAt(checkedAt, 1, () => 1);

    expect(lowerBound.getTime()).toBe(checkedAt.getTime() + 2.4 * 60 * 1000);
    expect(upperBound.getTime()).toBe(checkedAt.getTime() + 3.6 * 60 * 1000);
  });

  it('never schedules more than six hours after the check', () => {
    const nextCheckAt = computePRDiscoveryNextCheckAt(checkedAt, 20, () => 1);

    expect(nextCheckAt.getTime()).toBeLessThanOrEqual(checkedAt.getTime() + 6 * 60 * 60 * 1000);
  });
});
