import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@/shared/session-runtime';
import { describeSessionCloseRisk, getSessionCloseRisk } from './session-close-guard';

function summary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: 's',
    name: null,
    workflow: null,
    model: null,
    persistedStatus: 'IDLE',
    runtimePhase: 'idle',
    processState: 'alive',
    activity: 'IDLE',
    updatedAt: '2026-11-03T00:00:00Z',
    lastExit: null,
    ...overrides,
  };
}

describe('getSessionCloseRisk', () => {
  it('lets idle, stopped and errored sessions close immediately', () => {
    expect(getSessionCloseRisk({ summary: summary({}) })).toBeNull();
    expect(getSessionCloseRisk({ summary: summary({ processState: 'stopped' }) })).toBeNull();
    expect(getSessionCloseRisk({ summary: summary({ runtimePhase: 'error' }) })).toBeNull();
    expect(getSessionCloseRisk({ persistedStatus: 'IDLE' })).toBeNull();
  });

  it('flags working and starting sessions as running', () => {
    expect(getSessionCloseRisk({ summary: summary({ activity: 'WORKING' }) })).toEqual({
      running: true,
      queuedMessageCount: 0,
    });
    expect(getSessionCloseRisk({ summary: summary({ runtimePhase: 'starting' }) })?.running).toBe(
      true
    );
  });

  it('uses the persisted status only when no live summary exists', () => {
    expect(getSessionCloseRisk({ persistedStatus: 'RUNNING' })?.running).toBe(true);
    expect(getSessionCloseRisk({ summary: summary({}), persistedStatus: 'RUNNING' })).toBeNull();
  });

  it('flags queued messages even when the session is idle', () => {
    expect(getSessionCloseRisk({ summary: summary({}), queuedMessageCount: 2 })).toEqual({
      running: false,
      queuedMessageCount: 2,
    });
  });
});

describe('describeSessionCloseRisk', () => {
  it('describes each risk with a matching action', () => {
    expect(describeSessionCloseRisk('Chat 1', { running: true, queuedMessageCount: 0 })).toEqual({
      title: 'Stop and close Chat 1?',
      description:
        'Chat 1 is still working. Closing the tab stops the agent and its transcript moves to Closed sessions.',
      confirmText: 'Stop and close',
    });
    expect(
      describeSessionCloseRisk('Chat 1', { running: true, queuedMessageCount: 2 }).description
    ).toContain('has 2 queued messages. Closing the tab stops the agent, discards the queued');
    expect(describeSessionCloseRisk('Chat 1', { running: false, queuedMessageCount: 2 })).toEqual({
      title: 'Discard queued messages in Chat 1?',
      description:
        'Chat 1 has 2 queued messages that have not been sent. Closing the tab discards them and its transcript moves to Closed sessions.',
      confirmText: 'Discard and close',
    });
  });
});
