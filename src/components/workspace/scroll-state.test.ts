import { describe, expect, it } from 'vitest';

import {
  getScrollStateFromRecord,
  loadScrollStateRecord,
  makeScrollStateKey,
  makeScrollStorageKey,
  removeScrollStatesForTab,
  saveScrollStateRecord,
  upsertScrollState,
} from './scroll-state';

function createStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    dump: () => store,
  };
}

describe('scroll-state', () => {
  it('round-trips scroll state records with versioned payload', () => {
    const storage = createStorage();
    const workspaceId = 'workspace-1';
    const record = upsertScrollState({}, 'file-a', 'code', {
      top: 120,
      left: 10,
      stickToBottom: true,
    });

    saveScrollStateRecord(storage, workspaceId, record);
    const loaded = loadScrollStateRecord(storage, workspaceId);

    expect(loaded).toEqual(record);
    expect(storage.dump().get(makeScrollStorageKey(workspaceId))).toContain('"v":1');
  });

  it('filters invalid scroll state entries', () => {
    const storage = createStorage();
    const workspaceId = 'workspace-2';
    storage.setItem(
      makeScrollStorageKey(workspaceId),
      JSON.stringify({
        v: 1,
        states: {
          good: { top: 10, left: 20, stickToBottom: true },
          bad: { top: -5, left: 'oops' },
          alsoBad: { top: 5, left: 5, stickToBottom: 'nope' },
        },
      })
    );

    const loaded = loadScrollStateRecord(storage, workspaceId);

    expect(loaded).toEqual({ good: { top: 10, left: 20, stickToBottom: true } });
  });

  it('removes all scroll states for a tab', () => {
    const record = {
      [makeScrollStateKey('tab-1', 'code')]: { top: 1, left: 2 },
      [makeScrollStateKey('tab-1', 'markdown')]: { top: 3, left: 4 },
      [makeScrollStateKey('tab-2', 'code')]: { top: 5, left: 6 },
    };

    const next = removeScrollStatesForTab(record, 'tab-1');

    expect(next).toEqual({
      [makeScrollStateKey('tab-2', 'code')]: { top: 5, left: 6 },
    });
  });

  it('returns null when no scroll state exists for a tab', () => {
    const record = upsertScrollState({}, 'tab-1', 'code', { top: 1, left: 2 });

    expect(getScrollStateFromRecord(record, 'tab-2', 'code')).toBeNull();
  });
});
