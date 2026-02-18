import { describe, expect, it } from 'vitest';
import { applyRatchetToggleState, updateWorkspaceRatchetState } from './ratchet-toggle-cache';

describe('ratchet-toggle-cache', () => {
  it('recomputes sidebarStatus when sidebar fields are present', () => {
    const updated = applyRatchetToggleState(
      {
        ratchetEnabled: true,
        ratchetState: 'CI_RUNNING' as const,
        ratchetButtonAnimated: true,
        isWorking: false,
        prUrl: 'https://github.com/purplefish-ai/factory-factory/pull/1080',
        prState: 'OPEN' as const,
        prCiStatus: 'UNKNOWN' as const,
        sidebarStatus: { activityState: 'IDLE' as const, ciState: 'RUNNING' as const },
      },
      false
    );

    expect(updated.ratchetEnabled).toBe(false);
    expect(updated.ratchetState).toBe('IDLE');
    expect(updated.ratchetButtonAnimated).toBe(false);
    expect(updated.sidebarStatus).toEqual({ activityState: 'IDLE', ciState: 'UNKNOWN' });
  });

  it('updates only matching workspace entries', () => {
    const updated = updateWorkspaceRatchetState(
      [
        { id: 'ws-1', ratchetEnabled: true, ratchetState: 'CI_RUNNING' as const },
        { id: 'ws-2', ratchetEnabled: true, ratchetState: 'READY' as const },
      ],
      'ws-1',
      false
    );

    expect(updated).toEqual([
      { id: 'ws-1', ratchetEnabled: false, ratchetState: 'IDLE', ratchetButtonAnimated: false },
      { id: 'ws-2', ratchetEnabled: true, ratchetState: 'READY' },
    ]);
  });
});
