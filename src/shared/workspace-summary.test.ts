import { describe, expect, it } from 'vitest';
import {
  projectAutoIterationSummary,
  WorkspaceAutoIterationSummarySchema,
} from '@/shared/workspace-summary';

describe('compact auto-iteration summary', () => {
  it('keeps absent and malformed iteration values unknown instead of applying UI defaults', () => {
    expect(
      projectAutoIterationSummary({
        mode: 'AUTO_ITERATION',
        autoIterationStatus: 'RUNNING',
        autoIterationConfig: null,
        autoIterationProgress: null,
      })
    ).toEqual({
      status: 'RUNNING',
      currentIteration: null,
      maxIterations: null,
      currentMetricSummary: null,
    });
    expect(
      projectAutoIterationSummary({
        mode: 'AUTO_ITERATION',
        autoIterationStatus: null,
        autoIterationConfig: { maxIterations: '25' },
        autoIterationProgress: { currentIteration: -1, currentMetricSummary: 42 },
      })
    ).toEqual({
      status: null,
      currentIteration: null,
      maxIterations: null,
      currentMetricSummary: null,
    });
  });

  it('projects only validated compact fields, preserving zero as unlimited and empty metrics', () => {
    expect(
      projectAutoIterationSummary({
        mode: 'AUTO_ITERATION',
        autoIterationStatus: 'PAUSED',
        autoIterationConfig: { maxIterations: 0 },
        autoIterationProgress: {
          currentIteration: 0,
          currentMetricSummary: '',
          lastTestOutput: 'large output',
        },
      })
    ).toEqual({
      status: 'PAUSED',
      currentIteration: 0,
      maxIterations: 0,
      currentMetricSummary: '',
    });
    expect(
      projectAutoIterationSummary({
        mode: 'STANDARD',
        autoIterationStatus: null,
        autoIterationConfig: null,
        autoIterationProgress: null,
      })
    ).toBeNull();
  });

  it('validates compact counters and status without accepting arbitrary JSON', () => {
    expect(
      WorkspaceAutoIterationSummarySchema.safeParse({
        status: 'RUNNING',
        currentIteration: 3,
        maxIterations: 25,
        currentMetricSummary: '12 tests',
      }).success
    ).toBe(true);
    for (const invalid of [
      {
        status: 'UNKNOWN',
        currentIteration: null,
        maxIterations: null,
        currentMetricSummary: null,
      },
      { status: null, currentIteration: -1, maxIterations: null, currentMetricSummary: null },
      { status: null, currentIteration: 1.5, maxIterations: null, currentMetricSummary: null },
      { status: null, currentIteration: null, maxIterations: '25', currentMetricSummary: null },
    ]) {
      expect(WorkspaceAutoIterationSummarySchema.safeParse(invalid).success).toBe(false);
    }
  });
});
