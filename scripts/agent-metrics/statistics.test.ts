import { describe, expect, it } from 'vitest';
import { distribution, percentile } from './statistics';

describe('percentile and distribution', () => {
  it('interpolates between closest ranks', () => {
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 0.9)).toBe(10);
    expect(percentile([1, 2], 0.9)).toBeCloseTo(1.9);
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([], 0.5)).toBeNull();
  });

  it('rounds the median and p90', () => {
    expect(distribution([1, 2, 2.2], 1)).toEqual({ count: 3, median: 2, p90: 2.2 });
    expect(distribution([], 1)).toEqual({ count: 0, median: null, p90: null });
  });
});
