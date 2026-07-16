import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyRatchetToggleState,
  clearPendingRatchetToggle,
  overridePendingRatchetToggle,
  resetPendingRatchetTogglesForTests,
  setPendingRatchetToggle,
  updateWorkspaceRatchetState,
} from './ratchet-toggle-cache';

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

describe('pending ratchet toggle override', () => {
  beforeEach(() => {
    resetPendingRatchetTogglesForTests();
  });

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

  it('returns the entry unchanged when the pending value matches', () => {
    setPendingRatchetToggle('ws-1', true);
    const entry = makeEntry(true);
    expect(overridePendingRatchetToggle(entry)).toBe(entry);
  });

  it('overrides a snapshot entry that would revert an in-flight toggle', () => {
    setPendingRatchetToggle('ws-1', false);
    const overridden = overridePendingRatchetToggle(makeEntry(true));

    expect(overridden.ratchetEnabled).toBe(false);
    expect(overridden.ratchetState).toBe('IDLE');
    expect(overridden.ratchetButtonAnimated).toBe(false);
    expect(overridden.sidebarStatus).toEqual({ activityState: 'IDLE', ciState: 'UNKNOWN' });
  });

  it('only overrides the workspace with the pending toggle', () => {
    setPendingRatchetToggle('ws-other', false);
    const entry = makeEntry(true);
    expect(overridePendingRatchetToggle(entry)).toBe(entry);
  });

  it('stops overriding after the toggle is cleared', () => {
    setPendingRatchetToggle('ws-1', false);
    clearPendingRatchetToggle('ws-1');
    const entry = makeEntry(true);
    expect(overridePendingRatchetToggle(entry)).toBe(entry);
  });
});
