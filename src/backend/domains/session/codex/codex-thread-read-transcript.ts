import type { ChatMessage, ClaudeMessage } from '@/shared/claude';

interface ThreadReadItemRecord {
  type?: unknown;
  id?: unknown;
  text?: unknown;
  content?: unknown;
}

interface ThreadReadTurnRecord {
  id?: unknown;
  items?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeItemType(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    const item = asRecord(block);
    if (!item) {
      continue;
    }
    const text = item.text;
    if (typeof text === 'string' && text.trim().length > 0) {
      parts.push(text.trim());
    }
  }
  return parts.join('\n\n');
}

function extractUserText(item: ThreadReadItemRecord): string {
  const fromContent = extractTextFromContent(item.content);
  if (fromContent.length > 0) {
    return fromContent;
  }
  return typeof item.text === 'string' ? item.text.trim() : '';
}

function extractAssistantText(item: ThreadReadItemRecord): string {
  if (typeof item.text === 'string' && item.text.trim().length > 0) {
    return item.text.trim();
  }
  return extractTextFromContent(item.content);
}

function toAssistantMessage(text: string): ClaudeMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  };
}

function buildMessageId(turnId: unknown, itemId: unknown, fallback: string): string {
  const safeTurnId = typeof turnId === 'string' && turnId.length > 0 ? turnId : 'unknown-turn';
  const safeItemId = typeof itemId === 'string' && itemId.length > 0 ? itemId : fallback;
  return `codex-${safeTurnId}-${safeItemId}`;
}

function createUserChatMessage(
  id: string,
  item: ThreadReadItemRecord,
  nowIso: string,
  order: number
): ChatMessage | null {
  const text = extractUserText(item);
  if (text.length === 0) {
    return null;
  }
  return {
    id,
    source: 'user',
    text,
    timestamp: nowIso,
    order,
  };
}

function createAssistantChatMessage(
  id: string,
  item: ThreadReadItemRecord,
  nowIso: string,
  order: number
): ChatMessage | null {
  const text = extractAssistantText(item);
  if (text.length === 0) {
    return null;
  }
  return {
    id,
    source: 'claude',
    message: toAssistantMessage(text),
    timestamp: nowIso,
    order,
  };
}

function createMessageFromThreadItem(
  turnId: unknown,
  item: ThreadReadItemRecord,
  fallbackId: string,
  nowIso: string,
  order: number
): ChatMessage | null {
  const itemType = normalizeItemType(item.type);
  const id = buildMessageId(turnId, item.id, fallbackId);
  if (itemType === 'usermessage' || itemType === 'user_message') {
    return createUserChatMessage(id, item, nowIso, order);
  }
  if (itemType === 'agentmessage' || itemType === 'agent_message') {
    return createAssistantChatMessage(id, item, nowIso, order);
  }
  return null;
}

function collectTurnMessages(turns: unknown[], nowIso: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let order = 0;
  for (const [turnIndex, turnValue] of turns.entries()) {
    const turn = asRecord(turnValue) as ThreadReadTurnRecord | null;
    if (!turn) {
      continue;
    }
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const [itemIndex, itemValue] of items.entries()) {
      const item = asRecord(itemValue) as ThreadReadItemRecord | null;
      if (!item) {
        continue;
      }
      const message = createMessageFromThreadItem(
        turn.id,
        item,
        `item-${turnIndex}-${itemIndex}`,
        nowIso,
        order
      );
      if (!message) {
        continue;
      }
      messages.push(message);
      order += 1;
    }
  }
  return messages;
}

export function parseCodexThreadReadTranscript(payload: unknown): ChatMessage[] {
  const root = asRecord(payload);
  const thread = asRecord(root?.thread);
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  return collectTurnMessages(turns, new Date().toISOString());
}
