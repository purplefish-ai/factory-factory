import { createLogger } from '@/backend/services/logger.service';
import type { CodexPendingInteractiveRequest, CodexThreadMappingStore } from './types';

const logger = createLogger('codex-session-registry');
const TERMINAL_TURN_HISTORY_LIMIT = 32;

class InMemoryCodexThreadMappingStore implements CodexThreadMappingStore {
  private readonly mappings = new Map<string, string>();

  getMappedThreadId(sessionId: string): Promise<string | null> {
    return Promise.resolve(this.mappings.get(sessionId) ?? null);
  }

  setMappedThreadId(sessionId: string, threadId: string): Promise<void> {
    this.mappings.set(sessionId, threadId);
    return Promise.resolve();
  }

  clearMappedThreadId(sessionId: string): Promise<void> {
    this.mappings.delete(sessionId);
    return Promise.resolve();
  }
}

export class CodexSessionRegistry {
  private readonly sessionToThread = new Map<string, string>();
  private readonly threadToSession = new Map<string, string>();
  private readonly sessionToTurn = new Map<string, string>();
  private readonly terminalTurnsBySession = new Map<string, string[]>();
  private readonly pendingBySession = new Map<
    string,
    Map<string, CodexPendingInteractiveRequest>
  >();

  constructor(
    private readonly mappingStore: CodexThreadMappingStore = new InMemoryCodexThreadMappingStore()
  ) {}

  async resolveThreadId(sessionId: string): Promise<string | null> {
    const inMemory = this.sessionToThread.get(sessionId);
    if (inMemory) {
      return inMemory;
    }

    const persisted = await this.mappingStore.getMappedThreadId(sessionId);
    if (!persisted) {
      return null;
    }

    this.bindSessionToThread(sessionId, persisted, false);
    return persisted;
  }

  async setMappedThreadId(sessionId: string, threadId: string): Promise<void> {
    this.bindSessionToThread(sessionId, threadId, true);
    await this.mappingStore.setMappedThreadId(sessionId, threadId);
  }

  getSessionIdByThreadId(threadId: string): string | null {
    return this.threadToSession.get(threadId) ?? null;
  }

  isThreadBoundToSession(threadId: string, sessionId: string): boolean {
    return this.threadToSession.get(threadId) === sessionId;
  }

  setActiveTurnId(sessionId: string, turnId: string | null): void {
    if (!turnId) {
      this.sessionToTurn.delete(sessionId);
      return;
    }
    this.trySetActiveTurnId(sessionId, turnId);
  }

  trySetActiveTurnId(sessionId: string, turnId: string): boolean {
    if (this.isTerminalTurn(sessionId, turnId)) {
      return false;
    }

    this.sessionToTurn.set(sessionId, turnId);
    return true;
  }

  markTurnTerminal(sessionId: string, turnId: string | null): void {
    if (!turnId) {
      this.sessionToTurn.delete(sessionId);
      return;
    }

    this.rememberTerminalTurn(sessionId, turnId);
    const activeTurnId = this.sessionToTurn.get(sessionId);
    if (!activeTurnId || activeTurnId === turnId) {
      this.sessionToTurn.delete(sessionId);
    }
  }

  getActiveTurnId(sessionId: string): string | null {
    return this.sessionToTurn.get(sessionId) ?? null;
  }

  addPendingInteractiveRequest(request: CodexPendingInteractiveRequest): void {
    const pending = this.pendingBySession.get(request.sessionId) ?? new Map();
    pending.set(request.requestId, request);
    this.pendingBySession.set(request.sessionId, pending);
  }

  getPendingInteractiveRequest(
    sessionId: string,
    requestId: string
  ): CodexPendingInteractiveRequest | null {
    return this.pendingBySession.get(sessionId)?.get(requestId) ?? null;
  }

  consumePendingInteractiveRequest(
    sessionId: string,
    requestId: string
  ): CodexPendingInteractiveRequest | null {
    const pending = this.pendingBySession.get(sessionId);
    if (!pending) {
      return null;
    }

    const request = pending.get(requestId) ?? null;
    if (!request) {
      return null;
    }

    pending.delete(requestId);
    if (pending.size === 0) {
      this.pendingBySession.delete(sessionId);
    }

    return request;
  }

  async clearSession(sessionId: string): Promise<void> {
    const threadId = this.sessionToThread.get(sessionId);
    if (threadId) {
      this.threadToSession.delete(threadId);
      this.sessionToThread.delete(sessionId);
    }
    this.sessionToTurn.delete(sessionId);
    this.terminalTurnsBySession.delete(sessionId);
    this.pendingBySession.delete(sessionId);
    await this.mappingStore.clearMappedThreadId(sessionId);
  }

  getActiveSessionCount(): number {
    return this.sessionToThread.size;
  }

  getBoundSessions(): Array<{ sessionId: string; threadId: string }> {
    return [...this.sessionToThread.entries()].map(([sessionId, threadId]) => ({
      sessionId,
      threadId,
    }));
  }

  private bindSessionToThread(sessionId: string, threadId: string, warnOnRebind: boolean): void {
    const currentSession = this.threadToSession.get(threadId);
    if (currentSession && currentSession !== sessionId) {
      throw new Error(
        `Thread ${threadId} is already bound to session ${currentSession}; refusing to bind to ${sessionId}`
      );
    }

    const currentThread = this.sessionToThread.get(sessionId);
    if (warnOnRebind && currentThread && currentThread !== threadId) {
      logger.warn('Rebinding session to different threadId', {
        sessionId,
        fromThreadId: currentThread,
        toThreadId: threadId,
      });
      this.threadToSession.delete(currentThread);
    }

    this.sessionToThread.set(sessionId, threadId);
    this.threadToSession.set(threadId, sessionId);
  }

  private isTerminalTurn(sessionId: string, turnId: string): boolean {
    return this.terminalTurnsBySession.get(sessionId)?.includes(turnId) ?? false;
  }

  private rememberTerminalTurn(sessionId: string, turnId: string): void {
    const history = this.terminalTurnsBySession.get(sessionId) ?? [];
    if (history.includes(turnId)) {
      return;
    }

    history.push(turnId);
    if (history.length > TERMINAL_TURN_HISTORY_LIMIT) {
      history.shift();
    }
    this.terminalTurnsBySession.set(sessionId, history);
  }
}

export { InMemoryCodexThreadMappingStore };
