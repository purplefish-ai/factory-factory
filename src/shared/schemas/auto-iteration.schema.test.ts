import { describe, expect, it } from 'vitest';
import {
  agentLogbookSchema,
  autoIterationConfigSchema,
  autoIterationProgressSchema,
} from './auto-iteration.schema';

const validConfig = {
  testCommand: 'pnpm test',
  targetDescription: 'Improve coverage',
  maxIterations: 5,
  testTimeoutSeconds: 120,
  sessionRecycleInterval: 3,
};

const validProgress = {
  currentIteration: 2,
  baselineMetricSummary: '10 tests passing',
  currentMetricSummary: '12 tests passing',
  acceptedCount: 1,
  rejectedRegressionCount: 0,
  rejectedCritiqueCount: 1,
  crashedCount: 0,
  sessionRecycleCount: 0,
  startedAt: '2026-05-17T12:00:00.000Z',
  lastIterationAt: null,
  currentPhase: 'idle',
  lastTestOutput: 'ok',
};

const validEntry = {
  iteration: 1,
  startedAt: '2026-05-17T12:01:00.000Z',
  completedAt: '2026-05-17T12:02:00.000Z',
  status: 'accepted',
  changeDescription: 'Added coverage',
  commitSha: 'abc123',
  commitReverted: false,
  metricBefore: '10 tests passing',
  metricAfter: '12 tests passing',
  testOutput: 'ok',
  metricImproved: true,
  crashError: null,
  fixAttempts: 0,
  critiqueNotes: 'Looks good',
  critiqueApproved: true,
};

describe('auto-iteration schemas', () => {
  it('defaults optional config fields and preserves prompt timeout', () => {
    const parsed = autoIterationConfigSchema.parse({
      testCommand: 'pnpm test',
      targetDescription: 'Improve coverage',
      promptTimeoutSeconds: 0,
    });

    expect(parsed).toEqual({
      testCommand: 'pnpm test',
      targetDescription: 'Improve coverage',
      maxIterations: 25,
      testTimeoutSeconds: 600,
      sessionRecycleInterval: 10,
      promptTimeoutSeconds: 0,
    });
  });

  it('rejects invalid config values', () => {
    expect(() =>
      autoIterationConfigSchema.parse({
        testCommand: '',
        targetDescription: 'Improve coverage',
        maxIterations: -1,
      })
    ).toThrow();
  });

  it('parses the full persisted progress shape', () => {
    expect(autoIterationProgressSchema.parse(validProgress)).toEqual(validProgress);
  });

  it('rejects malformed progress phases', () => {
    expect(() =>
      autoIterationProgressSchema.parse({ ...validProgress, currentPhase: 'unknown' })
    ).toThrow();
  });

  it('parses the full logbook shape', () => {
    const logbook = {
      workspaceId: 'ws-1',
      config: validConfig,
      baseline: {
        testOutput: 'baseline',
        metricSummary: '10 tests passing',
        evaluatedAt: '2026-05-17T12:00:00.000Z',
      },
      iterations: [validEntry],
    };

    expect(agentLogbookSchema.parse(logbook)).toEqual(logbook);
  });

  it('rejects malformed logbook entries', () => {
    expect(() =>
      agentLogbookSchema.parse({
        workspaceId: 'ws-1',
        config: validConfig,
        baseline: {
          testOutput: 'baseline',
          metricSummary: '10 tests passing',
          evaluatedAt: '2026-05-17T12:00:00.000Z',
        },
        iterations: [{ ...validEntry, fixAttempts: -1 }],
      })
    ).toThrow();
  });
});
