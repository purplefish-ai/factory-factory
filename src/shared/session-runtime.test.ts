import { describe, expect, it } from 'vitest';
import {
  getSessionRuntimeErrorMessage,
  getSessionSummaryErrorMessage,
  type SessionRuntimeLastExit,
  type SessionRuntimePhase,
} from './session-runtime';

interface RuntimeErrorCase {
  name: string;
  phase: SessionRuntimePhase;
  errorMessage?: string | null;
  lastExit?: SessionRuntimeLastExit | null;
  expected: string | null;
}

const unexpectedExit: SessionRuntimeLastExit = {
  code: 42,
  timestamp: '2026-02-20T00:00:00.000Z',
  unexpected: true,
};

const expectedCases: RuntimeErrorCase[] = [
  {
    name: 'returns trimmed explicit error while in error phase',
    phase: 'error',
    errorMessage: '  runtime failed  ',
    expected: 'runtime failed',
  },
  {
    name: 'falls back to unexpected exit message in error phase',
    phase: 'error',
    lastExit: unexpectedExit,
    expected: 'Exited unexpectedly (code 42)',
  },
  {
    name: 'uses explicit message for unexpected exit outside error phase',
    phase: 'running',
    errorMessage: '  process crashed  ',
    lastExit: unexpectedExit,
    expected: 'process crashed',
  },
  {
    name: 'returns null when there is no error signal',
    phase: 'running',
    expected: null,
  },
];

describe('session runtime error message helpers', () => {
  for (const testCase of expectedCases) {
    it(`summary helper ${testCase.name}`, () => {
      expect(
        getSessionSummaryErrorMessage({
          runtimePhase: testCase.phase,
          errorMessage: testCase.errorMessage,
          lastExit: testCase.lastExit ?? null,
        })
      ).toBe(testCase.expected);
    });

    it(`runtime helper ${testCase.name}`, () => {
      expect(
        getSessionRuntimeErrorMessage({
          phase: testCase.phase,
          errorMessage: testCase.errorMessage ?? undefined,
          lastExit: testCase.lastExit ?? undefined,
        })
      ).toBe(testCase.expected);
    });
  }
});
