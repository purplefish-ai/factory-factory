import { describe, expect, it } from 'vitest';
import { deriveRunningSessionIds } from './session-tab-status';

describe('deriveRunningSessionIds', () => {
  it('keeps selected session running immediately from websocket state', () => {
    const result = deriveRunningSessionIds(new Set(), {
      sessions: [{ id: 'session-a', isWorking: false }],
      selectedDbSessionId: 'session-a',
      sessionStatus: { phase: 'running' },
      processStatus: { state: 'alive' },
    });

    expect(Array.from(result)).toEqual(['session-a']);
  });

  it('does not carry stale running state across tab switch', () => {
    const previous = new Set(['session-a']);
    const result = deriveRunningSessionIds(previous, {
      sessions: [
        { id: 'session-a', isWorking: false },
        { id: 'session-b', isWorking: false },
      ],
      selectedDbSessionId: 'session-b',
      sessionStatus: { phase: 'loading' },
      processStatus: { state: 'unknown' },
    });

    expect(result.size).toBe(0);
  });

  it('clears stale running state when polling reports session idle', () => {
    const previous = new Set(['session-a']);
    const result = deriveRunningSessionIds(previous, {
      sessions: [{ id: 'session-a', isWorking: false }],
      selectedDbSessionId: 'session-b',
      sessionStatus: { phase: 'ready' },
      processStatus: { state: 'stopped' },
    });

    expect(result.size).toBe(0);
  });

  it('uses polled status as source of truth when selected session is ready', () => {
    const previous = new Set<string>();
    const result = deriveRunningSessionIds(previous, {
      sessions: [{ id: 'session-a', isWorking: true }],
      selectedDbSessionId: 'session-a',
      sessionStatus: { phase: 'ready' },
      processStatus: { state: 'alive' },
    });

    expect(Array.from(result)).toEqual(['session-a']);
  });
});
