import { describe, expect, it } from 'vitest';
import { type ChannelConnectionState, ConnectionHealthStore } from './websocket-connection-health';

function connectionOf(states: ChannelConnectionState[]) {
  const store = new ConnectionHealthStore();
  states.forEach((state, index) => store.setChannelState(`channel-${index}`, state));
  return store.getSnapshot().connection;
}

describe('ConnectionHealthStore', () => {
  it('reports the worst state of its channels, whatever their order', () => {
    expect(connectionOf(['unresponsive', 'reconnecting'])).toBe('reconnecting');
    expect(connectionOf(['reconnecting', 'unresponsive'])).toBe('reconnecting');
    expect(connectionOf(['connected', 'unresponsive'])).toBe('unresponsive');
    expect(connectionOf(['unresponsive', 'connected'])).toBe('unresponsive');
    expect(connectionOf(['connecting', 'connected'])).toBe('ok');
  });

  it('recovers when the channel in the worst state goes away', () => {
    const store = new ConnectionHealthStore();
    store.setChannelState('snapshots', 'unresponsive');
    store.setChannelState('chat', 'reconnecting');
    store.removeChannel('chat');
    expect(store.getSnapshot().connection).toBe('unresponsive');
    store.setChannelState('snapshots', 'connected');
    expect(store.getSnapshot().connection).toBe('ok');
  });
});
