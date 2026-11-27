import { createContext, useContext, useSyncExternalStore } from 'react';

/**
 * App-wide connection health, read by the connection banner.
 *
 * Every WebSocket transport under the provider reports the server version from
 * its hello. Transports created with `announceConnectionLoss` (the channels
 * every page depends on: `/snapshots`, and `/chat` while a chat is open) also
 * report whether they are reconnecting, so one banner speaks for all of them.
 */

/**
 * - `connecting`: the first attempt for the current URL, not yet open.
 * - `connected`: open.
 * - `reconnecting`: an attempt failed or an open connection was lost; the
 *   transport keeps retrying.
 */
export type ChannelConnectionState = 'connecting' | 'connected' | 'reconnecting';

export interface ConnectionHealth {
  /** At least one announced channel is reconnecting. */
  reconnecting: boolean;
  /** The version the server last reported in a hello; null before any, or from an older server. */
  serverVersion: string | null;
}

const INITIAL_HEALTH: ConnectionHealth = { reconnecting: false, serverVersion: null };

export class ConnectionHealthStore {
  private readonly channels = new Map<string, ChannelConnectionState>();
  private readonly listeners = new Set<() => void>();
  private health: ConnectionHealth = INITIAL_HEALTH;
  private serverVersion: string | null = null;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ConnectionHealth => this.health;

  setChannelState(channelId: string, state: ChannelConnectionState): void {
    this.channels.set(channelId, state);
    this.publish();
  }

  removeChannel(channelId: string): void {
    if (this.channels.delete(channelId)) {
      this.publish();
    }
  }

  reportServerVersion(version: string): void {
    this.serverVersion = version;
    this.publish();
  }

  private publish(): void {
    const reconnecting = [...this.channels.values()].includes('reconnecting');
    const { health, serverVersion } = this;
    if (health.reconnecting === reconnecting && health.serverVersion === serverVersion) {
      return;
    }
    this.health = { reconnecting, serverVersion };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const ConnectionHealthContext = createContext<ConnectionHealthStore | null>(null);

const noSubscription = () => () => undefined;
const readInitialHealth = () => INITIAL_HEALTH;

/** The app-wide connection health; constant outside a `ConnectionHealthContext` provider. */
export function useConnectionHealth(): ConnectionHealth {
  const store = useContext(ConnectionHealthContext);
  return useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.getSnapshot ?? readInitialHealth,
    store?.getSnapshot ?? readInitialHealth
  );
}
