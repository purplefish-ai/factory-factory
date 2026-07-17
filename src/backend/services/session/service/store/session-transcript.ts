import { createHash } from 'node:crypto';
import type { HistoryMessage } from '@/shared/acp-protocol';
import {
  type AgentMessage,
  type ChatMessage,
  type QueuedMessage,
  shouldPersistAgentMessage,
  shouldSuppressDuplicateResultMessage,
} from '@/shared/acp-protocol';
import type { SessionStore } from './session-store.types';

export function messageSort(a: ChatMessage, b: ChatMessage): number {
  return a.order - b.order;
}

function buildDeterministicHistoryId(historyMsg: HistoryMessage, index: number): string {
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

function historyToClaudeMessage(msg: HistoryMessage): AgentMessage {
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

export function buildTranscriptFromHistory(history: HistoryMessage[]): ChatMessage[] {
  const transcript: ChatMessage[] = [];
  let order = 0;

  for (const [index, historyMsg] of history.entries()) {
    const messageBaseId = historyMsg.uuid ?? buildDeterministicHistoryId(historyMsg, index);
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
        source: 'agent',
        message: historyToClaudeMessage(historyMsg),
        timestamp: historyMsg.timestamp,
        order,
      });
      order += 1;
    }
  }

  return transcript;
}

export function rebuildTranscriptIndex(store: SessionStore): void {
  store.transcriptIdToIndex.clear();
  for (const [index, message] of store.transcript.entries()) {
    store.transcriptIdToIndex.set(message.id, index);
  }
}

function reindexTranscriptFrom(store: SessionStore, startIndex: number): void {
  for (let index = startIndex; index < store.transcript.length; index += 1) {
    const message = store.transcript[index];
    if (message) {
      store.transcriptIdToIndex.set(message.id, index);
    }
  }
}

function findTranscriptInsertionIndex(transcript: ChatMessage[], order: number): number {
  let low = 0;
  let high = transcript.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const middleMessage = transcript[middle];
    if (middleMessage && middleMessage.order <= order) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function insertTranscriptMessage(store: SessionStore, message: ChatMessage): void {
  const lastMessage = store.transcript.at(-1);
  if (!lastMessage || lastMessage.order <= message.order) {
    store.transcriptIdToIndex.set(message.id, store.transcript.length);
    store.transcript.push(message);
    return;
  }

  const insertionIndex = findTranscriptInsertionIndex(store.transcript, message.order);
  store.transcript.splice(insertionIndex, 0, message);
  reindexTranscriptFrom(store, insertionIndex);
}

export function upsertTranscriptMessage(store: SessionStore, message: ChatMessage): void {
  const existingIndex = store.transcriptIdToIndex.get(message.id);
  const existingMessage = existingIndex === undefined ? undefined : store.transcript[existingIndex];
  if (existingIndex !== undefined && existingMessage?.id === message.id) {
    if (existingMessage.order === message.order) {
      store.transcript[existingIndex] = message;
      return;
    }

    store.transcript.splice(existingIndex, 1);
    store.transcriptIdToIndex.delete(message.id);
    reindexTranscriptFrom(store, existingIndex);
  }

  insertTranscriptMessage(store, message);
}

export function removeTranscriptMessageById(store: SessionStore, messageId: string): boolean {
  const index = store.transcriptIdToIndex.get(messageId);
  if (index === undefined || store.transcript[index]?.id !== messageId) {
    return false;
  }

  store.transcript.splice(index, 1);
  store.transcriptIdToIndex.delete(messageId);
  reindexTranscriptFrom(store, index);
  return true;
}

export function setNextOrderFromTranscript(store: SessionStore): void {
  let maxOrder = -1;
  for (const message of store.transcript) {
    if (message.order > maxOrder) {
      maxOrder = message.order;
    }
  }
  store.nextOrder = maxOrder + 1;
}

function hasMatchingToolResult(message: AgentMessage, toolUseId: string): boolean {
  const content = message.message?.content;
  if (
    Array.isArray(content) &&
    content.some((item) => item.type === 'tool_result' && item.tool_use_id === toolUseId)
  ) {
    return true;
  }

  return (
    message.type === 'stream_event' &&
    message.event?.type === 'content_block_start' &&
    message.event.content_block.type === 'tool_result' &&
    message.event.content_block.tool_use_id === toolUseId
  );
}

function findPersistedToolUseStart(
  store: SessionStore,
  toolUseId: string
): ChatMessage | undefined {
  for (let index = store.transcript.length - 1; index >= 0; index -= 1) {
    const entry = store.transcript[index];
    if (!entry || entry.source !== 'agent' || !entry.message) {
      continue;
    }

    if (hasMatchingToolResult(entry.message, toolUseId)) {
      return undefined;
    }

    if (entry.message.type !== 'stream_event') {
      continue;
    }

    const event = entry.message.event;
    if (!event || event.type !== 'content_block_start') {
      continue;
    }
    if (event.content_block.type === 'tool_use' && event.content_block.id === toolUseId) {
      return entry;
    }
  }

  return undefined;
}

export function appendClaudeEvent(
  store: SessionStore,
  claudeMessage: AgentMessage,
  options: {
    nowIso: () => string;
    onParityTrace: (data: Record<string, unknown>) => void;
  }
): number {
  // When the ACP adapter sends progressive enrichment for the same tool call
  // (same toolCallId, updated title/input), upsert the existing transcript
  // entry and return its original order so the frontend updates in place
  // instead of creating a second tool call.
  if (claudeMessage.type === 'stream_event') {
    const event = claudeMessage.event;
    if (event && event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      const existing = findPersistedToolUseStart(store, event.content_block.id);
      if (existing) {
        existing.message = claudeMessage;
        options.onParityTrace({
          path: 'live_stream_upserted',
          reason: 'duplicate_tool_use_start_enriched',
          order: existing.order,
          claudeMessage,
        });
        return existing.order;
      }
    }
  }

  const order = store.nextOrder;
  store.nextOrder += 1;

  const shouldPersist = shouldPersistAgentMessage(claudeMessage);
  const isDuplicateResult = shouldSuppressDuplicateResultMessage(store.transcript, claudeMessage);
  if (!shouldPersist || isDuplicateResult) {
    options.onParityTrace({
      path: 'live_stream_filtered',
      reason: !shouldPersist ? 'non_renderable_agent_message' : 'duplicate_result_suppressed',
      order,
      claudeMessage,
    });
    return order;
  }

  const entry: ChatMessage = {
    id: `${store.sessionId}-${order}`,
    source: 'agent',
    message: claudeMessage,
    timestamp: claudeMessage.timestamp ?? options.nowIso(),
    order,
  };

  store.transcript.push(entry);
  store.transcriptIdToIndex.set(entry.id, store.transcript.length - 1);
  options.onParityTrace({
    path: 'live_stream_persisted',
    order,
    claudeMessage,
  });

  return order;
}

export function commitSentUserMessageWithOrder(
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
  upsertTranscriptMessage(store, transcriptMessage);

  if (store.nextOrder <= order) {
    store.nextOrder = order + 1;
  }
}

export function injectCommittedUserMessage(
  store: SessionStore,
  text: string,
  options: { messageId?: string; nowIso: () => string; nowMs: () => number }
): void {
  const messageId = options.messageId ?? `injected-${options.nowMs()}`;
  const message: ChatMessage = {
    id: messageId,
    source: 'user',
    text,
    timestamp: options.nowIso(),
    order: store.nextOrder,
  };
  store.nextOrder += 1;
  upsertTranscriptMessage(store, message);
}

function summarizeAttachment(attachment: NonNullable<ChatMessage['attachments']>[number]): {
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

function normalizeTranscriptMessage(message: ChatMessage): Record<string, unknown> {
  if (message.source === 'user') {
    return {
      source: 'user',
      order: message.order,
      text: message.text,
      attachments: message.attachments?.map((attachment) => summarizeAttachment(attachment)),
    };
  }

  return {
    source: 'agent',
    order: message.order,
    message: message.message,
  };
}

export function normalizeTranscript(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((message) => normalizeTranscriptMessage(message));
}
