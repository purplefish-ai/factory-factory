import { describe, expect, it } from 'vitest';
import { MessageEventStore } from './message-event-store';

describe('MessageEventStore', () => {
  it('stores and retrieves events per session', () => {
    const store = new MessageEventStore();
    store.storeEvent('session-1', { type: 'event-1' });
    store.storeEvent('session-1', { type: 'event-2', data: { value: 1 } });
    store.storeEvent('session-2', { type: 'event-3' });

    expect(store.getStoredEvents('session-1')).toEqual([
      { type: 'event-1' },
      { type: 'event-2', data: { value: 1 } },
    ]);
    expect(store.getStoredEvents('session-2')).toEqual([{ type: 'event-3' }]);
  });

  it('clears sessions independently', () => {
    const store = new MessageEventStore();
    store.storeEvent('session-1', { type: 'event-1' });
    store.storeEvent('session-2', { type: 'event-2' });

    store.clearSession('session-1');
    expect(store.getStoredEvents('session-1')).toEqual([]);
    expect(store.getStoredEvents('session-2')).toEqual([{ type: 'event-2' }]);
  });

  it('clears all sessions', () => {
    const store = new MessageEventStore();
    store.storeEvent('session-1', { type: 'event-1' });
    store.storeEvent('session-2', { type: 'event-2' });

    store.clearAllSessions();
    expect(store.getStoredEvents('session-1')).toEqual([]);
    expect(store.getStoredEvents('session-2')).toEqual([]);
  });
});
