import { createHash } from 'node:crypto';
import {
  type ChatMessage,
  type ClaudeMessage,
  DEFAULT_CHAT_SETTINGS,
  MessageState,
  QUEUED_MESSAGE_ORDER_BASE,
  type QueuedMessage,
  type WebSocketMessage as ReplayEventMessage,
  resolveSelectedModel,
  type SessionDeltaEvent,
  shouldPersistClaudeMessage,
  shouldSuppressDuplicateResultMessage,
  type WebSocketMessage,
} from '@/shared/claude';
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
import { sessionFileLogger } from './session-file-logger.service';

const logger = createLogger('session-store-service');

const MAX_QUEUE_SIZE = 100;
interface SessionStore {
  sessionId: string;
  initialized: boolean;
  hydratePromise: Promise<void> | null;
  hydratingKey: string | null;
  hydratedKey: string | null;
  hydrateGeneration: number;
  lastKnownProjectPath: string | null;
  lastKnownClaudeSessionId: string | null;
  transcript: ChatMessage[];
  queue: QueuedMessage[];
  pendingInteractiveRequest: PendingInteractiveRequest | null;
  runtime: SessionRuntimeState;
  nextOrder: number;
  lastHydratedAt: string | null;
}

type SnapshotReason =
  | 'subscribe_load'
  | 'enqueue'
  | 'remove_queued_message'
  | 'dequeue'
  | 'requeue'
  | 'commit_user_message'
  | 'pending_request_set'
  | 'pending_request_cleared'
  | 'process_exit_reset'
  | 'process_exit_rehydrate'
  | 'manual_emit'
  | 'inject_user_message';

function messageSort(a: ChatMessage, b: ChatMessage): number {
  return a.order - b.order;
}

class SessionStoreService {
  private stores = new Map<string, SessionStore>();

  private summarizeAttachment(attachment: NonNullable<ChatMessage['attachments']>[number]): {
    id: string;
    name: string;
    type: string;
    size: number;
    contentType?: 'image' | 'text';
  } {
    return {
      id: attachment.id,
      name: attachment.name,
      type: attachment.type,
      size: attachment.size,
      ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
    };
  }

  private normalizeTranscriptMessage(message: ChatMessage): Record<string, unknown> {
    if (message.source === 'user') {
      return {
        source: 'user',
        order: message.order,
        text: message.text,
        attachments: message.attachments?.map((attachment) => this.summarizeAttachment(attachment)),
      };
    }

    return {
      source: 'claude',
      order: message.order,
      message: message.message,
    };
  }

  private normalizeTranscript(messages: ChatMessage[]): Record<string, unknown>[] {
    return messages.map((message) => this.normalizeTranscriptMessage(message));
  }

  private logParityTrace(sessionId: string, data: Record<string, unknown>): void {
    sessionFileLogger.log(sessionId, 'INFO', {
      type: 'parity_trace',
      ...data,
    });
  }

  private getOrCreate(sessionId: string): SessionStore {
    let store = this.stores.get(sessionId);
    if (!store) {
      store = {
        sessionId,
        initialized: false,
        hydratePromise: null,
        hydratingKey: null,
        hydratedKey: null,
        hydrateGeneration: 0,
        lastKnownProjectPath: null,
        lastKnownClaudeSessionId: null,
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
      toolName: 'toolName' in historyMsg ? (historyMsg.toolName ?? null) : null,
      toolId: 'toolId' in historyMsg ? (historyMsg.toolId ?? null) : null,
      toolInput: 'toolInput' in historyMsg ? (historyMsg.toolInput ?? null) : null,
      isError: 'isError' in historyMsg ? (historyMsg.isError ?? false) : false,
      attachments: historyMsg.attachments ?? null,
      userToolResultContent: historyMsg.type === 'user_tool_result' ? historyMsg.content : null,
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

  private hasPersistedToolUseStart(store: SessionStore, toolUseId: string): boolean {
    return store.transcript.some((entry) => {
      if (entry.source !== 'claude' || !entry.message || entry.message.type !== 'stream_event') {
        return false;
      }
      const event = entry.message.event;
      if (!event || event.type !== 'content_block_start') {
        return false;
      }
      return event.content_block.type === 'tool_use' && event.content_block.id === toolUseId;
    });
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
    const assertNever = (value: never): never => {
      throw new Error(`Unhandled history message type: ${JSON.stringify(value)}`);
    };

    switch (msg.type) {
      case 'user':
        return {
          type: 'user',
          message: { role: 'user', content: msg.content },
        };
      case 'tool_use':
        if (msg.toolName && msg.toolId) {
          return {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: msg.toolId,
                name: msg.toolName,
                input: msg.toolInput || {},
              },
            },
          };
        }
        return {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: msg.content }] },
        };
      case 'tool_result': {
        return {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: msg.toolId || 'unknown',
                content: msg.content,
                ...(msg.isError !== undefined ? { is_error: msg.isError } : {}),
              },
            ],
          },
        };
      }
      case 'user_tool_result':
        return {
          type: 'user',
          message: {
            role: 'user',
            content: msg.content,
          },
        };
      case 'thinking':
        return {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: msg.content },
          },
        };
      case 'assistant':
        return {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: msg.content }] },
        };
    }

    return assertNever(msg);
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
        historyMsg.type === 'thinking' ||
        historyMsg.type === 'user_tool_result'
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
        order: QUEUED_MESSAGE_ORDER_BASE + index,
      });
    });
    snapshot.sort(messageSort);
    return snapshot;
  }

  private forwardSnapshot(
    store: SessionStore,
    options?: { loadRequestId?: string; reason?: SnapshotReason; includeParitySnapshot?: boolean }
  ): void {
    const snapshotMessages = this.buildSnapshotMessages(store);
    const payload: WebSocketMessage = {
      type: 'session_snapshot',
      messages: snapshotMessages,
      queuedMessages: [...store.queue],
      pendingInteractiveRequest: store.pendingInteractiveRequest,
      sessionRuntime: store.runtime,
      ...(options?.loadRequestId ? { loadRequestId: options.loadRequestId } : {}),
    };

    if (options?.includeParitySnapshot) {
      this.logParityTrace(store.sessionId, {
        path: 'snapshot',
        reason: options.reason ?? 'manual_emit',
        loadRequestId: options.loadRequestId ?? null,
        queuedCount: store.queue.length,
        snapshot: this.normalizeTranscript(snapshotMessages),
      });
    }

    chatConnectionService.forwardToSession(store.sessionId, payload);
  }

  private buildReplayEvents(store: SessionStore): ReplayEventMessage[] {
    const replayEvents: ReplayEventMessage[] = [
      {
        type: 'session_runtime_snapshot',
        sessionRuntime: store.runtime,
      },
    ];

    const transcript = [...store.transcript].sort(messageSort);
    for (const message of transcript) {
      if (message.source === 'user') {
        replayEvents.push({
          type: 'message_state_changed',
          id: message.id,
          newState: MessageState.ACCEPTED,
          userMessage: {
            text: message.text ?? '',
            timestamp: message.timestamp,
            attachments: message.attachments,
            settings: {
              selectedModel: resolveSelectedModel(DEFAULT_CHAT_SETTINGS.selectedModel),
              thinkingEnabled: DEFAULT_CHAT_SETTINGS.thinkingEnabled,
              planModeEnabled: DEFAULT_CHAT_SETTINGS.planModeEnabled,
            },
            order: message.order,
          },
        });
        replayEvents.push({
          type: 'message_state_changed',
          id: message.id,
          newState: MessageState.COMMITTED,
        });
        continue;
      }

      if (message.message) {
        replayEvents.push({
          type: 'claude_message',
          data: message.message,
          order: message.order,
        });
      }
    }

    for (const [queuePosition, queued] of store.queue.entries()) {
      replayEvents.push({
        type: 'message_state_changed',
        id: queued.id,
        newState: MessageState.ACCEPTED,
        queuePosition,
        userMessage: {
          text: queued.text,
          timestamp: queued.timestamp,
          attachments: queued.attachments,
          settings: {
            selectedModel: resolveSelectedModel(queued.settings.selectedModel),
            thinkingEnabled: queued.settings.thinkingEnabled,
            planModeEnabled: queued.settings.planModeEnabled,
          },
        },
      });
    }

    if (store.pendingInteractiveRequest) {
      if (store.pendingInteractiveRequest.toolName === 'AskUserQuestion') {
        replayEvents.push({
          type: 'user_question',
          requestId: store.pendingInteractiveRequest.requestId,
          questions: ((store.pendingInteractiveRequest.input as { questions?: unknown[] })
            .questions ?? []) as ReplayEventMessage['questions'],
        });
      } else {
        replayEvents.push({
          type: 'permission_request',
          requestId: store.pendingInteractiveRequest.requestId,
          toolName: store.pendingInteractiveRequest.toolName,
          toolInput: store.pendingInteractiveRequest.input,
          planContent: store.pendingInteractiveRequest.planContent,
        });
      }
    }

    return replayEvents;
  }

  private forwardReplayBatch(
    store: SessionStore,
    options?: { loadRequestId?: string; reason?: SnapshotReason; includeParitySnapshot?: boolean }
  ): void {
    const replayEvents = this.buildReplayEvents(store);
    const payload: WebSocketMessage = {
      type: 'session_replay_batch',
      replayEvents,
      ...(options?.loadRequestId ? { loadRequestId: options.loadRequestId } : {}),
    };

    if (options?.includeParitySnapshot) {
      this.logParityTrace(store.sessionId, {
        path: 'replay_batch',
        reason: options.reason ?? 'manual_emit',
        loadRequestId: options.loadRequestId ?? null,
        replayEventCount: replayEvents.length,
      });
    }

    chatConnectionService.forwardToSession(store.sessionId, payload);
  }

  emitDelta(sessionId: string, event: SessionDeltaEvent): void {
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
    const hasExplicitLastExit = Object.hasOwn(updates, 'lastExit');
    store.runtime = {
      ...store.runtime,
      phase: updates.phase,
      processState: updates.processState,
      activity: updates.activity,
      ...(hasExplicitLastExit ? { lastExit: updates.lastExit } : { lastExit: undefined }),
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
    claudeProjectPath: string | null;
    claudeSessionId: string | null;
    isRunning: boolean;
    isWorking: boolean;
    loadRequestId?: string;
  }): Promise<void> {
    const { sessionId, claudeProjectPath, claudeSessionId, isRunning, isWorking, loadRequestId } =
      options;
    const store = this.getOrCreate(sessionId);
    store.lastKnownProjectPath = claudeProjectPath;
    store.lastKnownClaudeSessionId = claudeSessionId;

    await this.ensureHydrated(store, { claudeSessionId, claudeProjectPath });

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

    this.forwardReplayBatch(store, {
      loadRequestId,
      reason: 'subscribe_load',
      includeParitySnapshot: true,
    });

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
    options: { claudeSessionId: string | null; claudeProjectPath: string | null }
  ): Promise<void> {
    const hydrateKey = `${options.claudeSessionId ?? 'none'}::${options.claudeProjectPath ?? 'none'}`;
    if (store.initialized && store.hydratedKey === hydrateKey) {
      return;
    }

    if (store.hydratePromise && store.hydratingKey === hydrateKey) {
      await store.hydratePromise;
      return;
    }

    const generation = store.hydrateGeneration + 1;
    store.hydrateGeneration = generation;
    store.hydratingKey = hydrateKey;

    const hydratePromise = (async () => {
      let transcript: ChatMessage[] = [];

      if (options.claudeSessionId && options.claudeProjectPath) {
        const history = await SessionManager.getHistoryFromProjectPath(
          options.claudeSessionId,
          options.claudeProjectPath
        );
        transcript = this.buildTranscriptFromHistory(history);
        transcript.sort(messageSort);
        this.logParityTrace(store.sessionId, {
          path: 'jsonl_hydrate',
          claudeSessionId: options.claudeSessionId,
          claudeProjectPath: options.claudeProjectPath,
          historyCount: history.length,
          transcriptCount: transcript.length,
          transcript: this.normalizeTranscript(transcript),
        });
      }

      if (store.hydrateGeneration !== generation) {
        return;
      }

      store.transcript = transcript;
      this.setNextOrderFromTranscript(store);
      store.initialized = true;
      store.hydratedKey = hydrateKey;
      store.lastHydratedAt = new Date().toISOString();
    })().finally(() => {
      if (store.hydrateGeneration === generation) {
        store.hydratePromise = null;
        store.hydratingKey = null;
      }
    });

    store.hydratePromise = hydratePromise;
    await hydratePromise;
  }

  enqueue(sessionId: string, message: QueuedMessage): { position: number } | { error: string } {
    const store = this.getOrCreate(sessionId);
    if (store.queue.length >= MAX_QUEUE_SIZE) {
      return { error: `Queue full (max ${MAX_QUEUE_SIZE} messages)` };
    }

    store.queue.push(message);
    this.forwardSnapshot(store, { reason: 'enqueue' });
    return { position: store.queue.length - 1 };
  }

  removeQueuedMessage(sessionId: string, messageId: string): boolean {
    const store = this.getOrCreate(sessionId);
    const idx = store.queue.findIndex((message) => message.id === messageId);
    if (idx < 0) {
      return false;
    }
    store.queue.splice(idx, 1);
    this.forwardSnapshot(store, { reason: 'remove_queued_message' });
    return true;
  }

  dequeueNext(sessionId: string, options?: { emitSnapshot?: boolean }): QueuedMessage | undefined {
    const store = this.getOrCreate(sessionId);
    const next = store.queue.shift();
    if (next && options?.emitSnapshot !== false) {
      this.forwardSnapshot(store, { reason: 'dequeue' });
    }
    return next;
  }

  requeueFront(sessionId: string, message: QueuedMessage): void {
    const store = this.getOrCreate(sessionId);
    store.queue.unshift(message);
    this.forwardSnapshot(store, { reason: 'requeue' });
  }

  commitSentUserMessage(
    sessionId: string,
    message: QueuedMessage,
    options?: { emitSnapshot?: boolean }
  ): void {
    const store = this.getOrCreate(sessionId);
    const order = store.nextOrder;
    store.nextOrder += 1;
    this.commitSentUserMessageWithOrder(store, message, order, options);
  }

  commitSentUserMessageAtOrder(
    sessionId: string,
    message: QueuedMessage,
    order: number,
    options?: { emitSnapshot?: boolean }
  ): void {
    const store = this.getOrCreate(sessionId);
    this.commitSentUserMessageWithOrder(store, message, order, options);
  }

  private commitSentUserMessageWithOrder(
    store: SessionStore,
    message: QueuedMessage,
    order: number,
    options?: { emitSnapshot?: boolean }
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

    if (options?.emitSnapshot !== false) {
      this.forwardSnapshot(store, { reason: 'commit_user_message' });
    }
  }

  appendClaudeEvent(sessionId: string, claudeMessage: ClaudeMessage): number {
    const store = this.getOrCreate(sessionId);
    const order = store.nextOrder;
    store.nextOrder += 1;

    if (claudeMessage.type === 'stream_event') {
      const event = claudeMessage.event;
      if (
        event &&
        event.type === 'content_block_start' &&
        event.content_block.type === 'tool_use' &&
        this.hasPersistedToolUseStart(store, event.content_block.id)
      ) {
        this.logParityTrace(sessionId, {
          path: 'live_stream_filtered',
          reason: 'duplicate_tool_use_start_suppressed',
          order,
          claudeMessage,
        });
        return order;
      }
    }

    const shouldPersist = shouldPersistClaudeMessage(claudeMessage);
    const isDuplicateResult = shouldSuppressDuplicateResultMessage(store.transcript, claudeMessage);
    if (!shouldPersist || isDuplicateResult) {
      this.logParityTrace(sessionId, {
        path: 'live_stream_filtered',
        reason: !shouldPersist ? 'non_renderable_claude_message' : 'duplicate_result_suppressed',
        order,
        claudeMessage,
      });
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
    this.logParityTrace(sessionId, {
      path: 'live_stream_persisted',
      order,
      claudeMessage,
    });

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
    this.forwardSnapshot(store, { reason: 'pending_request_set' });
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
    this.forwardSnapshot(store, { reason: 'pending_request_cleared' });
  }

  clearPendingInteractiveRequestIfMatches(sessionId: string, requestId: string): void {
    const store = this.getOrCreate(sessionId);
    if (store.pendingInteractiveRequest?.requestId !== requestId) {
      return;
    }
    store.pendingInteractiveRequest = null;
    this.forwardSnapshot(store, { reason: 'pending_request_cleared' });
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
    const canRehydrateNow = Boolean(store.lastKnownProjectPath && store.lastKnownClaudeSessionId);

    // Queue is intentionally ephemeral and dropped on process exit.
    store.queue = [];
    store.pendingInteractiveRequest = null;
    // Drop in-memory transcript immediately to avoid serving stale state.
    store.transcript = [];
    store.nextOrder = 0;
    // Force fresh JSONL rehydration on next subscribe.
    store.initialized = false;
    store.hydratedKey = null;
    store.hydrateGeneration += 1;
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

    // If we can immediately rehydrate from JSONL, keep the existing transcript on
    // connected clients until the refreshed snapshot arrives to avoid a visible empty flash.
    if (!canRehydrateNow) {
      this.forwardSnapshot(store, {
        reason: 'process_exit_reset',
        includeParitySnapshot: true,
      });
    }

    // Best-effort immediate refresh from JSONL so connected clients recover
    // without requiring a manual reload.
    const { lastKnownClaudeSessionId, lastKnownProjectPath } = store;
    if (canRehydrateNow && lastKnownClaudeSessionId && lastKnownProjectPath) {
      void this.ensureHydrated(store, {
        claudeSessionId: lastKnownClaudeSessionId,
        claudeProjectPath: lastKnownProjectPath,
      })
        .then(() => {
          this.forwardSnapshot(store, {
            reason: 'process_exit_rehydrate',
            includeParitySnapshot: true,
          });
        })
        .catch((error) => {
          logger.warn('Failed to rehydrate transcript after process exit', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }

  emitSessionSnapshot(sessionId: string, loadRequestId?: string): void {
    const store = this.getOrCreate(sessionId);
    this.forwardSnapshot(store, {
      loadRequestId,
      reason: 'manual_emit',
      includeParitySnapshot: true,
    });
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
    this.forwardSnapshot(store, { reason: 'inject_user_message' });
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
