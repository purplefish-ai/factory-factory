import { createHash } from 'node:crypto';
import type { ChatMessage, ClaudeMessage, QueuedMessage, WebSocketMessage } from '@/shared/claude';
import type { PendingInteractiveRequest } from '@/shared/pending-request-types';
import {
  createInitialSessionRuntimeState,
  type SessionRuntimeState,
} from '@/shared/session-runtime';
import type { HistoryMessage } from '../claude';
import { SessionManager } from '../claude';
import type { ConnectionInfo } from './chat-connection.service';
import { chatConnectionService } from './chat-connection.service';
import { createLogger } from './logger.service';

const logger = createLogger('session-store-service');

const MAX_QUEUE_SIZE = 100;
const QUEUE_BASE_ORDER = 1_000_000_000;

interface SessionStore {
  sessionId: string;
  initialized: boolean;
  hydratePromise: Promise<void> | null;
  transcript: ChatMessage[];
  queue: QueuedMessage[];
  pendingInteractiveRequest: PendingInteractiveRequest | null;
  runtime: SessionRuntimeState;
  nextOrder: number;
  lastHydratedAt: string | null;
}

function messageSort(a: ChatMessage, b: ChatMessage): number {
  return a.order - b.order;
}

function extractAssistantText(message: ClaudeMessage): string {
  if (message.type !== 'assistant' || !message.message) {
    return '';
  }

  const content = message.message.content;
  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join('')
    .trim();
}

class SessionStoreService {
  private stores = new Map<string, SessionStore>();

  private shouldSuppressDuplicateResultMessage(
    store: SessionStore,
    claudeMessage: ClaudeMessage
  ): boolean {
    if (claudeMessage.type !== 'result' || typeof claudeMessage.result !== 'string') {
      return false;
    }

    const incomingText = claudeMessage.result.trim();
    if (!incomingText) {
      return true;
    }

    for (let i = store.transcript.length - 1; i >= 0; i -= 1) {
      // biome-ignore lint/style/noNonNullAssertion: index bounded by loop condition
      const candidate = store.transcript[i]!;
      if (
        candidate.source !== 'claude' ||
        !candidate.message ||
        candidate.message.type === 'result'
      ) {
        continue;
      }

      const existingText = extractAssistantText(candidate.message);
      if (!existingText) {
        continue;
      }

      return existingText === incomingText;
    }

    return false;
  }

  private getOrCreate(sessionId: string): SessionStore {
    let store = this.stores.get(sessionId);
    if (!store) {
      store = {
        sessionId,
        initialized: false,
        hydratePromise: null,
        transcript: [],
        queue: [],
        pendingInteractiveRequest: null,
        runtime: createInitialSessionRuntimeState(),
        nextOrder: 0,
        lastHydratedAt: null,
      };
      this.stores.set(sessionId, store);
    }
    return store;
  }

  private buildDeterministicHistoryId(historyMsg: HistoryMessage, index: number): string {
    const fingerprint = JSON.stringify({
      index,
      type: historyMsg.type,
      timestamp: historyMsg.timestamp,
      content: historyMsg.content,
      toolName: historyMsg.toolName ?? null,
      toolId: historyMsg.toolId ?? null,
      toolInput: historyMsg.toolInput ?? null,
      isError: historyMsg.isError ?? false,
      attachments: historyMsg.attachments ?? null,
    });
    const digest = createHash('sha1').update(fingerprint).digest('hex').slice(0, 12);
    return `history-${index}-${digest}`;
  }

  private upsertTranscriptMessage(store: SessionStore, message: ChatMessage): void {
    const idx = store.transcript.findIndex((m) => m.id === message.id);
    if (idx >= 0) {
      store.transcript[idx] = message;
    } else {
      store.transcript.push(message);
    }
    store.transcript.sort(messageSort);
  }

  private setNextOrderFromTranscript(store: SessionStore): void {
    let maxOrder = -1;
    for (const message of store.transcript) {
      if (message.order > maxOrder) {
        maxOrder = message.order;
      }
    }
    store.nextOrder = maxOrder + 1;
  }

  private historyToClaudeMessage(msg: HistoryMessage): ClaudeMessage {
    switch (msg.type) {
      case 'tool_use':
        if (msg.toolName && msg.toolId) {
          return {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: msg.toolId,
                  name: msg.toolName,
                  input: msg.toolInput || {},
                },
              ],
            },
          };
        }
        return {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: msg.content }] },
        };
      case 'tool_result': {
        const content: string | Array<{ type: 'text'; text: string }> = msg.content;
        return {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: msg.toolId || 'unknown', content }],
          },
        };
      }
      case 'thinking':
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: msg.content }],
          },
        };
      case 'assistant':
        return {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: msg.content }] },
        };
      default:
        return {
          type: 'user',
          message: { role: 'user', content: msg.content },
        };
    }
  }

  private buildTranscriptFromHistory(history: HistoryMessage[]): ChatMessage[] {
    const transcript: ChatMessage[] = [];
    let order = 0;

    for (const [index, historyMsg] of history.entries()) {
      const messageBaseId = historyMsg.uuid ?? this.buildDeterministicHistoryId(historyMsg, index);
      const messageId = `${messageBaseId}-${order}`;

      if (historyMsg.type === 'user') {
        transcript.push({
          id: messageId,
          source: 'user',
          text: historyMsg.content,
          attachments: historyMsg.attachments,
          timestamp: historyMsg.timestamp,
          order,
        });
        order += 1;
        continue;
      }

      if (
        historyMsg.type === 'assistant' ||
        historyMsg.type === 'tool_use' ||
        historyMsg.type === 'tool_result' ||
        historyMsg.type === 'thinking'
      ) {
        transcript.push({
          id: messageId,
          source: 'claude',
          message: this.historyToClaudeMessage(historyMsg),
          timestamp: historyMsg.timestamp,
          order,
        });
        order += 1;
      }
    }

    return transcript;
  }

  private buildSnapshotMessages(store: SessionStore): ChatMessage[] {
    const snapshot = [...store.transcript];
    store.queue.forEach((queued, index) => {
      snapshot.push({
        id: queued.id,
        source: 'user',
        text: queued.text,
        attachments: queued.attachments,
        timestamp: queued.timestamp,
        order: QUEUE_BASE_ORDER + index,
      });
    });
    snapshot.sort(messageSort);
    return snapshot;
  }

  private forwardSnapshot(store: SessionStore, options?: { loadRequestId?: string }): void {
    const payload: WebSocketMessage = {
      type: 'session_snapshot',
      messages: this.buildSnapshotMessages(store),
      queuedMessages: [...store.queue],
      pendingInteractiveRequest: store.pendingInteractiveRequest,
      sessionRuntime: store.runtime,
      ...(options?.loadRequestId ? { loadRequestId: options.loadRequestId } : {}),
    };
    chatConnectionService.forwardToSession(store.sessionId, payload);
  }

  emitDelta(sessionId: string, event: { type: string; [key: string]: unknown }): void {
    const payload: WebSocketMessage = {
      type: 'session_delta',
      data: event,
    };
    chatConnectionService.forwardToSession(sessionId, payload);
  }

  private markRuntime(
    store: SessionStore,
    updates: Pick<SessionRuntimeState, 'phase' | 'processState' | 'activity'> & {
      lastExit?: SessionRuntimeState['lastExit'];
    },
    options?: { emitDelta?: boolean }
  ): void {
    store.runtime = {
      ...store.runtime,
      phase: updates.phase,
      processState: updates.processState,
      activity: updates.activity,
      ...(updates.lastExit ? { lastExit: updates.lastExit } : {}),
      updatedAt: new Date().toISOString(),
    };

    if (options?.emitDelta !== false) {
      this.emitDelta(store.sessionId, {
        type: 'session_runtime_updated',
        sessionRuntime: store.runtime,
      });
    }
  }

  async subscribe(options: {
    sessionId: string;
    workingDir: string;
    claudeSessionId: string | null;
    isRunning: boolean;
    isWorking: boolean;
    loadRequestId?: string;
  }): Promise<void> {
    const { sessionId, workingDir, claudeSessionId, isRunning, isWorking, loadRequestId } = options;
    const store = this.getOrCreate(sessionId);

    await this.ensureHydrated(store, { claudeSessionId, workingDir });

    if (isRunning) {
      this.markRuntime(
        store,
        {
          phase: isWorking ? 'running' : 'idle',
          processState: 'alive',
          activity: isWorking ? 'WORKING' : 'IDLE',
        },
        { emitDelta: false }
      );
    } else {
      this.markRuntime(
        store,
        {
          phase: 'idle',
          processState: 'stopped',
          activity: 'IDLE',
        },
        { emitDelta: false }
      );
    }

    this.forwardSnapshot(store, { loadRequestId });

    logger.info('Session subscribed', {
      sessionId,
      isRunning,
      isWorking,
      transcriptCount: store.transcript.length,
      queueCount: store.queue.length,
    });
  }

  private async ensureHydrated(
    store: SessionStore,
    options: { claudeSessionId: string | null; workingDir: string }
  ): Promise<void> {
    if (store.initialized) {
      return;
    }

    if (!store.hydratePromise) {
      store.hydratePromise = (async () => {
        // Rehydration always starts from a clean in-memory transcript state.
        store.transcript = [];
        store.nextOrder = 0;
        store.lastHydratedAt = null;

        if (options.claudeSessionId) {
          const history = await SessionManager.getHistory(
            options.claudeSessionId,
            options.workingDir
          );
          store.transcript = this.buildTranscriptFromHistory(history);
          store.transcript.sort(messageSort);
        }
        this.setNextOrderFromTranscript(store);
        store.initialized = true;
        store.lastHydratedAt = new Date().toISOString();
      })().finally(() => {
        store.hydratePromise = null;
      });
    }

    await store.hydratePromise;
  }

  enqueue(sessionId: string, message: QueuedMessage): { position: number } | { error: string } {
    const store = this.getOrCreate(sessionId);
    if (store.queue.length >= MAX_QUEUE_SIZE) {
      return { error: `Queue full (max ${MAX_QUEUE_SIZE} messages)` };
    }

    store.queue.push(message);
    this.forwardSnapshot(store);
    return { position: store.queue.length - 1 };
  }

  removeQueuedMessage(sessionId: string, messageId: string): boolean {
    const store = this.getOrCreate(sessionId);
    const idx = store.queue.findIndex((message) => message.id === messageId);
    if (idx < 0) {
      return false;
    }
    store.queue.splice(idx, 1);
    this.forwardSnapshot(store);
    return true;
  }

  dequeueNext(sessionId: string, options?: { emitSnapshot?: boolean }): QueuedMessage | undefined {
    const store = this.getOrCreate(sessionId);
    const next = store.queue.shift();
    if (next && options?.emitSnapshot !== false) {
      this.forwardSnapshot(store);
    }
    return next;
  }

  requeueFront(sessionId: string, message: QueuedMessage): void {
    const store = this.getOrCreate(sessionId);
    store.queue.unshift(message);
    this.forwardSnapshot(store);
  }

  commitSentUserMessage(sessionId: string, message: QueuedMessage): void {
    const store = this.getOrCreate(sessionId);
    const order = store.nextOrder;
    store.nextOrder += 1;
    this.commitSentUserMessageWithOrder(store, message, order);
  }

  commitSentUserMessageAtOrder(sessionId: string, message: QueuedMessage, order: number): void {
    const store = this.getOrCreate(sessionId);
    this.commitSentUserMessageWithOrder(store, message, order);
  }

  private commitSentUserMessageWithOrder(
    store: SessionStore,
    message: QueuedMessage,
    order: number
  ): void {
    const transcriptMessage: ChatMessage = {
      id: message.id,
      source: 'user',
      text: message.text,
      attachments: message.attachments,
      timestamp: message.timestamp,
      order,
    };
    this.upsertTranscriptMessage(store, transcriptMessage);

    // Ensure nextOrder remains strictly greater than all committed message orders.
    if (store.nextOrder <= order) {
      store.nextOrder = order + 1;
    }

    this.forwardSnapshot(store);
  }

  appendClaudeEvent(sessionId: string, claudeMessage: ClaudeMessage): number {
    const store = this.getOrCreate(sessionId);
    const order = store.nextOrder;
    store.nextOrder += 1;

    if (this.shouldSuppressDuplicateResultMessage(store, claudeMessage)) {
      return order;
    }

    const entry: ChatMessage = {
      id: `${sessionId}-${order}`,
      source: 'claude',
      message: claudeMessage,
      timestamp: claudeMessage.timestamp ?? new Date().toISOString(),
      order,
    };

    store.transcript.push(entry);
    store.transcript.sort(messageSort);

    return order;
  }

  allocateOrder(sessionId: string): number {
    const store = this.getOrCreate(sessionId);
    const order = store.nextOrder;
    store.nextOrder += 1;
    return order;
  }

  setPendingInteractiveRequest(sessionId: string, request: PendingInteractiveRequest): void {
    const store = this.getOrCreate(sessionId);
    store.pendingInteractiveRequest = request;
    this.forwardSnapshot(store);
  }

  getPendingInteractiveRequest(sessionId: string): PendingInteractiveRequest | null {
    const store = this.getOrCreate(sessionId);
    return store.pendingInteractiveRequest;
  }

  clearPendingInteractiveRequest(sessionId: string): void {
    const store = this.getOrCreate(sessionId);
    if (!store.pendingInteractiveRequest) {
      return;
    }
    store.pendingInteractiveRequest = null;
    this.forwardSnapshot(store);
  }

  clearPendingInteractiveRequestIfMatches(sessionId: string, requestId: string): void {
    const store = this.getOrCreate(sessionId);
    if (store.pendingInteractiveRequest?.requestId !== requestId) {
      return;
    }
    store.pendingInteractiveRequest = null;
    this.forwardSnapshot(store);
  }

  markStarting(sessionId: string): void {
    const store = this.getOrCreate(sessionId);
    this.markRuntime(store, {
      phase: 'starting',
      processState: 'alive',
      activity: 'IDLE',
    });
  }

  markStopping(sessionId: string): void {
    const store = this.getOrCreate(sessionId);
    this.markRuntime(store, {
      phase: 'stopping',
      processState: store.runtime.processState,
      activity: store.runtime.activity,
    });
  }

  markRunning(sessionId: string): void {
    const store = this.getOrCreate(sessionId);
    this.markRuntime(store, {
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
    });
  }

  markIdle(sessionId: string, processState: 'alive' | 'stopped'): void {
    const store = this.getOrCreate(sessionId);
    this.markRuntime(store, {
      phase: 'idle',
      processState,
      activity: 'IDLE',
    });
  }

  markError(sessionId: string): void {
    const store = this.getOrCreate(sessionId);
    this.markRuntime(store, {
      phase: 'error',
      processState: store.runtime.processState,
      activity: store.runtime.activity,
    });
  }

  markProcessExit(sessionId: string, code: number | null): void {
    const store = this.getOrCreate(sessionId);
    const unexpected = code === null || code !== 0;

    // Queue is intentionally ephemeral and dropped on process exit.
    store.queue = [];
    store.pendingInteractiveRequest = null;
    // Force fresh JSONL rehydration on next subscribe.
    store.initialized = false;
    store.hydratePromise = null;

    this.markRuntime(store, {
      phase: unexpected ? 'error' : 'idle',
      processState: 'stopped',
      activity: 'IDLE',
      lastExit: {
        code,
        timestamp: new Date().toISOString(),
        unexpected,
      },
    });

    this.forwardSnapshot(store);
  }

  emitSessionSnapshot(sessionId: string, loadRequestId?: string): void {
    const store = this.getOrCreate(sessionId);
    this.forwardSnapshot(store, { loadRequestId });
  }

  injectCommittedUserMessage(
    sessionId: string,
    text: string,
    options?: { messageId?: string }
  ): void {
    const store = this.getOrCreate(sessionId);
    const messageId = options?.messageId ?? `injected-${Date.now()}`;
    const message: ChatMessage = {
      id: messageId,
      source: 'user',
      text,
      timestamp: new Date().toISOString(),
      order: store.nextOrder,
    };
    store.nextOrder += 1;
    this.upsertTranscriptMessage(store, message);
    this.forwardSnapshot(store);
  }

  getConnectionCount(sessionId: string): number {
    let count = 0;
    for (const info of chatConnectionService.values() as IterableIterator<ConnectionInfo>) {
      if (info.dbSessionId === sessionId) {
        count += 1;
      }
    }
    return count;
  }

  clearSession(sessionId: string): void {
    this.stores.delete(sessionId);
  }

  clearAllSessions(): void {
    this.stores.clear();
  }

  getAllPendingRequests(): Map<string, PendingInteractiveRequest> {
    const pending = new Map<string, PendingInteractiveRequest>();
    for (const [sessionId, store] of this.stores.entries()) {
      if (store.pendingInteractiveRequest) {
        pending.set(sessionId, store.pendingInteractiveRequest);
      }
    }
    return pending;
  }

  getQueueLength(sessionId: string): number {
    return this.getOrCreate(sessionId).queue.length;
  }

  getQueueSnapshot(sessionId: string): QueuedMessage[] {
    return [...this.getOrCreate(sessionId).queue];
  }
}

export const sessionStoreService = new SessionStoreService();
