import { createContext, useContext, useSyncExternalStore } from 'react';

/**
 * App-wide connection health, read by the connection banner.
 *
 * Every WebSocket transport under the provider reports the server version from
 * its hello. Transports created with `announceConnectionLoss` (the channels
 * every page depends on: `/snapshots`, and `/chat` while a chat is open) also
 * report their state, so one banner speaks for all of them.
 */

/**
 * - `connecting`: the first attempt for the current URL, not yet open.
 * - `connected`: open and answering.
 * - `unresponsive`: open, but a ping has gone unanswered; the socket is kept
 *   in case the server is only slow (`ConnectionLiveness`).
 * - `reconnecting`: an attempt failed or an open connection was lost or
 *   abandoned; the transport keeps retrying.
 */
export type ChannelConnectionState = 'connecting' | 'connected' | 'unresponsive' | 'reconnecting';

/** The worst state among announced channels; `reconnecting` outranks `unresponsive`. */
export type AppConnectionState = 'ok' | 'unresponsive' | 'reconnecting';

export interface ConnectionHealth {
  connection: AppConnectionState;
  /**
   * The version the server last reported in a hello; null until one arrives.
   * An older server sends none, so the last reported version is kept.
   */
  serverVersion: string | null;
}

const INITIAL_HEALTH: ConnectionHealth = { connection: 'ok', serverVersion: null };

function worstState(states: Iterable<ChannelConnectionState>): AppConnectionState {
  let worst: AppConnectionState = 'ok';
  for (const state of states) {
    if (state === 'reconnecting') {
      return 'reconnecting';
    }
    if (state === 'unresponsive') {
      worst = 'unresponsive';
    }
  }
  return worst;
}

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
    const connection = worstState(this.channels.values());
    const { health, serverVersion } = this;
    if (health.connection === connection && health.serverVersion === serverVersion) {
      return;
    }
    this.health = { connection, serverVersion };
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
