import { describe, expect, it } from 'vitest';
import { sparklinePoints, summarizeHostLoad } from './host-load';

/** Samples five seconds apart, the desktop poll rate. */
function series(...readings: (number | [number, number])[]) {
  return readings.map((reading, index) => {
    const [cpuPercent, memoryPercent] = typeof reading === 'number' ? [reading, 30] : reading;
    return { at: index * 5000, cpuPercent, memoryPercent };
  });
}

describe('summarizeHostLoad', () => {
  it('stays neutral for an idle machine and reports the latest readings', () => {
    expect(summarizeHostLoad(series(10, [12, 41]))).toEqual({
      cpu: { percent: 12, tone: 'neutral' },
      memory: { percent: 41, tone: 'neutral' },
      tone: 'neutral',
    });
  });

  it('ignores a single busy tick among quiet ones', () => {
    expect(summarizeHostLoad(series(10, 10, 100)).tone).toBe('neutral');
  });

  it('warns on sustained load and escalates to danger', () => {
    expect(summarizeHostLoad(series(85, 82, 90)).cpu.tone).toBe('warning');
    expect(summarizeHostLoad(series(96, 99, 100)).cpu.tone).toBe('danger');
  });

  it('shows the worse of CPU and memory as the overall tone', () => {
    const summary = summarizeHostLoad(series([10, 97], [10, 98], [10, 99]));
    expect(summary.cpu.tone).toBe('neutral');
    expect(summary.tone).toBe('danger');
  });

  it('judges by the last fifteen seconds, not the last three samples', () => {
    // A phone polling every 15 s: each sample already averages CPU over 15 s.
    const slow = [
      { at: 0, cpuPercent: 10, memoryPercent: 30 },
      { at: 15_000, cpuPercent: 10, memoryPercent: 30 },
      { at: 30_000, cpuPercent: 97, memoryPercent: 30 },
    ];
    expect(summarizeHostLoad(slow).cpu.tone).toBe('danger');
  });

  it('counts the same samples when polls arrive a little early or late', () => {
    const at = (times: number[], cpu: number[]) =>
      times.map((time, index) => ({ at: time, cpuPercent: cpu[index] ?? 0, memoryPercent: 30 }));
    // A phone poll a little early: the previous reading must still stay out.
    expect(summarizeHostLoad(at([0, 14_800], [10, 97])).cpu.tone).toBe('danger');
    // Desktop polls a little late: still the last three readings, not two.
    expect(summarizeHostLoad(at([0, 5200, 10_400], [99, 99, 10])).cpu.tone).toBe('neutral');
    // Desktop polls a little early: still three, not four.
    expect(summarizeHostLoad(at([0, 4900, 9800, 14_700], [10, 99, 99, 99])).cpu.tone).toBe(
      'danger'
    );
  });

  it('is neutral with no samples', () => {
    expect(summarizeHostLoad([]).tone).toBe('neutral');
  });
});

/** Points five seconds apart unless times are given. */
const points = (values: number[], times = values.map((_, index) => index * 5000)) =>
  values.map((value, index) => ({ at: times[index] ?? 0, value }));

describe('sparklinePoints', () => {
  it('draws on a fixed 0–100 scale across the full width', () => {
    expect(sparklinePoints(points([0, 50, 100]), 20, 10)).toBe('0.0,10.0 10.0,5.0 20.0,0.0');
  });

  it('places each reading by when it was taken, so slower polls do not stretch time', () => {
    expect(sparklinePoints(points([0, 0, 100], [0, 15_000, 20_000]), 20, 10)).toBe(
      '0.0,10.0 15.0,10.0 20.0,0.0'
    );
  });

  it('draws a single reading as a flat line', () => {
    expect(sparklinePoints(points([25]), 8, 4)).toBe('0.0,3.0 8.0,3.0');
  });

  it('clamps out-of-range values and draws nothing without data', () => {
    expect(sparklinePoints(points([-5, 140]), 4, 4)).toBe('0.0,4.0 4.0,0.0');
    expect(sparklinePoints([], 4, 4)).toBe('');
  });
});
