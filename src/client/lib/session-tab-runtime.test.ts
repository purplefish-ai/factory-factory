import { ChatCircleDotsIcon } from '@phosphor-icons/react/dist/csr/ChatCircleDots';
import { ClipboardTextIcon } from '@phosphor-icons/react/dist/csr/ClipboardText';
import { ShieldWarningIcon } from '@phosphor-icons/react/dist/csr/ShieldWarning';
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
    expect(result.color).toBe('text-running');
    expect(result.pulse).toBe(true);
    expect(result.isRunning).toBe(true);
  });

  it('prefers runtime summary state over persisted status fallback', () => {
    const summary = createSummary({ runtimePhase: 'idle', activity: 'IDLE' });
    const result = deriveSessionTabRuntime(summary, 'RUNNING');

    expect(result.label).toBe('Idle');
    expect(result.isRunning).toBe(false);
  });

  it.each([
    ['permission_request', 'Needs approval', ShieldWarningIcon],
    ['user_question', 'Needs answer', ChatCircleDotsIcon],
    ['plan_approval', 'Needs plan review', ClipboardTextIcon],
  ] as const)('shows a working session blocked on a %s as needing you', (type, label, icon) => {
    const summary = createSummary({
      runtimePhase: 'running',
      activity: 'WORKING',
      pendingRequestType: type,
    });

    const result = deriveSessionTabRuntime(summary, 'RUNNING');

    expect(result).toMatchObject({
      label,
      icon,
      color: 'text-warning',
      pulse: false,
      spin: false,
      isRunning: false,
      awaitingInput: true,
    });
  });

  it('shows runtime error details when available', () => {
    const summary = createSummary({
      runtimePhase: 'error',
      errorMessage: 'Failed to start agent: spawn failed',
    });

    const result = deriveSessionTabRuntime(summary);

    expect(result.label).toBe('Error');
    expect(result.description).toBe('Failed to start agent: spawn failed');
  });
});
