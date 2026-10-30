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
  it.each(['following', 'reading'] as const)(
    'round-trips %s chat intent and keyed anchors in v1',
    (intent) => {
      const storage = createStorage();
      const chatPosition = { intent, top: 250, left: 8, anchor: { key: 'message-7', offset: 20 } };
      const record = upsertScrollState({}, 'chat-session', 'chat', {
        top: 250,
        left: 8,
        chatPosition,
      });
      saveScrollStateRecord(storage, 'w', record);
      expect(loadScrollStateRecord(storage, 'w')['chat-session:chat']).toEqual({
        top: 250,
        left: 8,
        stickToBottom: undefined,
        chatPosition,
      });
      expect(JSON.parse(storage.getItem('workspace-panel-scroll-w') ?? '{}').v).toBe(1);
    }
  );

  it('round-trips signed chat gap offsets while retaining nonnegative document coordinates', () => {
    const storage = createStorage();
    const chatPosition = {
      intent: 'reading' as const,
      top: 120,
      left: 0,
      anchor: { key: 'b', offset: -4 },
    };
    saveScrollStateRecord(
      storage,
      'w',
      upsertScrollState({}, 'session', 'chat', { top: 120, left: 0, chatPosition })
    );
    expect(loadScrollStateRecord(storage, 'w')['session:chat']?.chatPosition).toEqual(chatPosition);
  });

  it.each([
    { key: '', offset: 1 },
    { key: 'row', offset: 'invalid' },
    { key: 'row', offset: Infinity },
    null,
  ])(
    'preserves valid chat pixels and intent when an optional anchor is malformed: %j',
    (anchor) => {
      const storage = createStorage();
      storage.setItem(
        'workspace-panel-scroll-w',
        JSON.stringify({
          v: 1,
          states: {
            'chat-session:chat': {
              top: 10,
              left: 2,
              chatPosition: { intent: 'reading', top: 10, left: 2, anchor },
            },
          },
        })
      );
      const record = loadScrollStateRecord(storage, 'w');
      expect(record['chat-session:chat']?.chatPosition).toEqual({
        intent: 'reading',
        top: 10,
        left: 2,
      });
    }
  );

  it('drops invalid optional chat positions while preserving viewer pixels and ignores unknown fields', () => {
    const storage = createStorage();
    storage.setItem(
      'workspace-panel-scroll-w',
      JSON.stringify({
        v: 1,
        ignored: true,
        states: {
          invalid: {
            top: 10,
            left: 2,
            extra: true,
            chatPosition: { intent: 'reading', top: -1, left: 0 },
          },
          valid: {
            top: 5,
            left: 0,
            chatPosition: { intent: 'following', top: 5, left: 0, extra: 'unknown' },
          },
        },
      })
    );
    expect(loadScrollStateRecord(storage, 'w')).toEqual({
      invalid: { top: 10, left: 2, stickToBottom: undefined },
      valid: {
        top: 5,
        left: 0,
        stickToBottom: undefined,
        chatPosition: { intent: 'following', top: 5, left: 0 },
      },
    });
    storage.setItem(
      'workspace-panel-scroll-w',
      JSON.stringify({ v: 2, states: { valid: { top: 1, left: 0 } } })
    );
    expect(loadScrollStateRecord(storage, 'w')).toEqual({});
  });

  it('round-trips a wrapped diff row anchor and ignores invalid anchors', () => {
    const storage = createStorage();
    storage.setItem(
      makeScrollStorageKey('w'),
      JSON.stringify({
        v: 1,
        states: {
          valid: { top: 8000, left: 0, diffAnchor: { index: 500, offset: 7 } },
          invalid: { top: 80, left: 0, diffAnchor: { index: -1, offset: 0 } },
        },
      })
    );
    const loaded = loadScrollStateRecord(storage, 'w');
    expect(loaded.valid).toMatchObject({ diffAnchor: { index: 500, offset: 7 } });
    expect(loaded.invalid).toMatchObject({ top: 80, left: 0 });
    expect(loaded.invalid).not.toHaveProperty('diffAnchor');
    saveScrollStateRecord(storage, 'w', upsertScrollState({}, 'tab', 'code', loaded.valid!));
    expect(loadScrollStateRecord(storage, 'w')['tab:code']).toEqual(loaded.valid);
  });

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
