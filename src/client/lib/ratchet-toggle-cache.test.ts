import { describe, expect, it } from 'vitest';
import { applyRatchetToggleState, overridePendingRatchetToggle } from './ratchet-toggle-cache';

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
});

describe('pending ratchet toggle override', () => {
  function makeEntry(ratchetEnabled: boolean) {
    return {
      workspaceId: 'ws-1',
      ratchetEnabled,
      ratchetState: 'CI_RUNNING' as const,
      ratchetButtonAnimated: true,
      isWorking: false,
      prUrl: 'https://github.com/purplefish-ai/factory-factory/pull/1080',
      prState: 'OPEN' as const,
      prCiStatus: 'UNKNOWN' as const,
      sidebarStatus: { activityState: 'IDLE' as const, ciState: 'RUNNING' as const },
    };
  }

  it('returns the entry unchanged when no toggle is pending', () => {
    const entry = makeEntry(true);
    expect(overridePendingRatchetToggle(entry)).toBe(entry);
  });
});
