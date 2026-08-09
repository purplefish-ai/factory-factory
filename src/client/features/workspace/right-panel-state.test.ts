import { describe, expect, it, vi } from 'vitest';
import { loadPersistedTopPanelState, parseStoredTopTab } from './right-panel-state';

function memoryStorage(entries: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(entries));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe('right panel persisted state', () => {
  it('round-trips the Agents tab', () => {
    expect(parseStoredTopTab('agents')).toBe('agents');
    const storage = memoryStorage({ 'workspace-right-panel-tab-workspace-1': 'agents' });
    expect(loadPersistedTopPanelState(storage, 'workspace-1')).toEqual({ topTab: 'agents' });
  });

  it('migrates the legacy child-workspaces tab and rewrites storage', () => {
    const storage = memoryStorage({
      'workspace-right-panel-tab-workspace-1': 'child-workspaces',
    });
    const setItem = vi.spyOn(storage, 'setItem');

    expect(loadPersistedTopPanelState(storage, 'workspace-1')).toEqual({ topTab: 'agents' });
    expect(setItem).toHaveBeenCalledWith('workspace-right-panel-tab-workspace-1', 'agents');
  });

  it.each(['unstaged', 'diff-vs-main'])('keeps the existing %s migration', (legacyTab) => {
    const storage = memoryStorage({ 'workspace-right-panel-tab-workspace-1': legacyTab });
    const setItem = vi.spyOn(storage, 'setItem');

    expect(loadPersistedTopPanelState(storage, 'workspace-1')).toEqual({ topTab: 'changes' });
    expect(setItem).toHaveBeenCalledWith('workspace-right-panel-tab-workspace-1', 'changes');
  });

  it('falls back to changes for unknown values and storage failures', () => {
    expect(parseStoredTopTab('mystery')).toBeNull();
    expect(
      loadPersistedTopPanelState(
        memoryStorage({ 'workspace-right-panel-tab-workspace-1': 'mystery' }),
        'workspace-1'
      )
    ).toEqual({ topTab: 'changes' });

    const failingStorage = memoryStorage();
    vi.spyOn(failingStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadPersistedTopPanelState(failingStorage, 'workspace-1')).toEqual({
      topTab: 'changes',
    });
  });
});
