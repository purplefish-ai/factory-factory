import { describe, expect, it } from 'vitest';
import {
  deriveSessionTabRuntime,
  type WorkspaceSessionRuntimeSummary,
} from './session-tab-runtime';

function createSummary(
  overrides: Partial<WorkspaceSessionRuntimeSummary> = {}
): WorkspaceSessionRuntimeSummary {
  return {
    sessionId: 's-1',
    name: 'Chat 1',
    workflow: 'followup',
    model: 'claude-sonnet',
    persistedStatus: 'IDLE',
    runtimePhase: 'idle',
    processState: 'alive',
    activity: 'IDLE',
    updatedAt: '2026-02-11T00:00:00.000Z',
    lastExit: null,
    ...overrides,
  };
}

describe('session-tab-runtime', () => {
  it('uses running fallback when persisted status is RUNNING and runtime summary is missing', () => {
    const result = deriveSessionTabRuntime(undefined, 'RUNNING');

    expect(result.label).toBe('Running');
    expect(result.color).toBe('text-brand');
    expect(result.pulse).toBe(true);
    expect(result.isRunning).toBe(true);
  });

  it('prefers runtime summary state over persisted status fallback', () => {
    const summary = createSummary({ runtimePhase: 'idle', activity: 'IDLE' });
    const result = deriveSessionTabRuntime(summary, 'RUNNING');

    expect(result.label).toBe('Idle');
    expect(result.isRunning).toBe(false);
  });
});
