export type StoredEvent = { type: string; data?: unknown };

/**
 * Stores raw WebSocket events per session for replay on reconnect.
 */
export class MessageEventStore {
  private sessionEvents = new Map<string, StoredEvent[]>();

  storeEvent(sessionId: string, event: StoredEvent): void {
    let events = this.sessionEvents.get(sessionId);
    if (!events) {
      events = [];
      this.sessionEvents.set(sessionId, events);
    }
    events.push(event);
  }

  getStoredEvents(sessionId: string): StoredEvent[] {
    return this.sessionEvents.get(sessionId) ?? [];
  }

  clearSession(sessionId: string): void {
    this.sessionEvents.delete(sessionId);
  }

  clearAllSessions(): void {
    this.sessionEvents.clear();
  }
}
