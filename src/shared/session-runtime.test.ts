import { describe, expect, it } from 'vitest';
import {
  deriveSessionUiStatusKind,
  getSessionRuntimeErrorMessage,
  getSessionSummaryErrorMessage,
  hasWorkingSessionSummary,
  isSessionSummaryWorking,
  type SessionRuntimeLastExit,
  type SessionRuntimePhase,
  type SessionUiStatusInput,
  sessionUiStatusKindFromSummary,
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

describe('deriveSessionUiStatusKind', () => {
  function makeInput(overrides: Partial<SessionUiStatusInput> = {}): SessionUiStatusInput {
    return {
      phase: 'idle',
      processState: 'alive',
      activity: 'IDLE',
      lastExit: null,
      ...overrides,
    };
  }

  it('maps lifecycle transition phases directly', () => {
    expect(deriveSessionUiStatusKind(makeInput({ phase: 'loading' }))).toBe('loading');
    expect(deriveSessionUiStatusKind(makeInput({ phase: 'starting' }))).toBe('starting');
    expect(deriveSessionUiStatusKind(makeInput({ phase: 'stopping' }))).toBe('stopping');
  });

  it('reports error phase before process state', () => {
    expect(deriveSessionUiStatusKind(makeInput({ phase: 'error', processState: 'stopped' }))).toBe(
      'error'
    );
  });

  it('reports stopped process before working, distinguishing unexpected exits', () => {
    expect(
      deriveSessionUiStatusKind(
        makeInput({ phase: 'running', processState: 'stopped', activity: 'WORKING' })
      )
    ).toBe('stopped');
    expect(
      deriveSessionUiStatusKind(
        makeInput({ phase: 'running', processState: 'stopped', lastExit: unexpectedExit })
      )
    ).toBe('unexpected-exit');
  });

  it('treats activity WORKING or phase running as working', () => {
    expect(deriveSessionUiStatusKind(makeInput({ activity: 'WORKING' }))).toBe('working');
    expect(deriveSessionUiStatusKind(makeInput({ phase: 'running' }))).toBe('working');
  });

  it('falls back to idle', () => {
    expect(deriveSessionUiStatusKind(makeInput())).toBe('idle');
    expect(deriveSessionUiStatusKind(makeInput({ processState: 'unknown' }))).toBe('idle');
  });
});

describe('sessionUiStatusKindFromSummary', () => {
  it('adapts summary field names to the runtime input shape', () => {
    expect(
      sessionUiStatusKindFromSummary({
        runtimePhase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        lastExit: unexpectedExit,
      })
    ).toBe('unexpected-exit');
    expect(
      sessionUiStatusKindFromSummary({
        runtimePhase: 'idle',
        processState: 'alive',
        activity: 'WORKING',
        lastExit: null,
      })
    ).toBe('working');
  });
});

describe('session runtime working helpers', () => {
  it('treats activity WORKING as working even when lifecycle phase has not caught up', () => {
    expect(isSessionSummaryWorking({ activity: 'WORKING', runtimePhase: 'idle' })).toBe(true);
  });

  it('treats runtime phase running as working even when activity has not caught up', () => {
    expect(isSessionSummaryWorking({ activity: 'IDLE', runtimePhase: 'running' })).toBe(true);
  });

  it('treats idle activity and idle phase as not working', () => {
    expect(isSessionSummaryWorking({ activity: 'IDLE', runtimePhase: 'idle' })).toBe(false);
  });

  it('detects any working summary in a list', () => {
    expect(
      hasWorkingSessionSummary([
        { activity: 'IDLE', runtimePhase: 'idle' },
        { activity: 'IDLE', runtimePhase: 'running' },
      ])
    ).toBe(true);
  });
});
