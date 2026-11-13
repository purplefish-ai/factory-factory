import { describe, expect, it } from 'vitest';
import { sparklinePoints, summarizeHostLoad } from './host-load';

const sample = (cpuPercent: number, memoryPercent = 30) => ({ cpuPercent, memoryPercent });

describe('summarizeHostLoad', () => {
  it('stays neutral for an idle machine and reports the latest readings', () => {
    expect(summarizeHostLoad([sample(10), sample(12, 41)])).toEqual({
      cpu: { percent: 12, tone: 'neutral' },
      memory: { percent: 41, tone: 'neutral' },
      tone: 'neutral',
    });
  });

  it('ignores a single busy tick among quiet ones', () => {
    expect(summarizeHostLoad([sample(10), sample(10), sample(100)]).tone).toBe('neutral');
  });

  it('warns on sustained load and escalates to danger', () => {
    expect(summarizeHostLoad([sample(85), sample(82), sample(90)]).cpu.tone).toBe('warning');
    expect(summarizeHostLoad([sample(96), sample(99), sample(100)]).cpu.tone).toBe('danger');
  });

  it('shows the worse of CPU and memory as the overall tone', () => {
    const summary = summarizeHostLoad([sample(10, 97), sample(10, 98), sample(10, 99)]);
    expect(summary.cpu.tone).toBe('neutral');
    expect(summary.tone).toBe('danger');
  });

  it('is neutral with no samples', () => {
    expect(summarizeHostLoad([]).tone).toBe('neutral');
  });
});

describe('sparklinePoints', () => {
  it('draws on a fixed 0–100 scale across the full width', () => {
    expect(sparklinePoints([0, 50, 100], 20, 10)).toBe('0.0,10.0 10.0,5.0 20.0,0.0');
  });

  it('draws a single reading as a flat line', () => {
    expect(sparklinePoints([25], 8, 4)).toBe('0.0,3.0 8.0,3.0');
  });

  it('clamps out-of-range values and draws nothing without data', () => {
    expect(sparklinePoints([-5, 140], 4, 4)).toBe('0.0,4.0 4.0,0.0');
    expect(sparklinePoints([], 4, 4)).toBe('');
  });
});
