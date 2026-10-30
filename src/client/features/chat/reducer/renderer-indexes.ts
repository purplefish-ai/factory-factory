import type { ChatMessage } from '@/lib/chat-protocol';
import {
  compareTranscriptMessageOrder,
  getToolUseIdFromEvent,
  isStreamEventMessage,
  trimTranscriptForRenderer,
} from '@/lib/chat-protocol';

/** Lookups derived from one renderer transcript array. */
export interface RendererIndexes {
  toolUseIdToIndex: Map<string, number>;
  agentMessageOrderToIndex: Map<number, number>;
  /** Built on first use; most transcripts never need it. */
  ids?: Set<string>;
}

interface CachedTranscript {
  indexes: RendererIndexes;
  /** True when the array came out of the renderer trim, which sorts it. */
  ordered: boolean;
}

// Reducer transcript arrays are never mutated, so each array's lookups can be
// cached by identity. When the next transcript differs by one appended or
// replaced message, the next lookups are derived from these instead of
// rescanning. Session replay applies one message per event, so a full rescan
// per event made replay cost events × transcript length.
const transcriptCache = new WeakMap<ChatMessage[], CachedTranscript>();

// Lookups created inside the running batch. Its intermediate states are never
// committed, so appends may extend these maps in place instead of copying them.
let batchOwnedIndexes: WeakSet<RendererIndexes> | null = null;

/**
 * Runs `apply` as one batch, such as a session replay inside a single reducer
 * call. Only the batch's final state may escape `apply`.
 */
export function runRendererTranscriptBatch<T>(apply: () => T): T {
  const outer = batchOwnedIndexes;
  batchOwnedIndexes = new WeakSet();
  try {
    return apply();
  } finally {
    batchOwnedIndexes = outer;
  }
}

function getToolUseId(message: ChatMessage): string | null {
  if (!(message.message && isStreamEventMessage(message.message))) {
    return null;
  }
  return getToolUseIdFromEvent(message.message.event);
}

function getAgentOrder(message: ChatMessage): number | null {
  return message.source === 'agent' && message.order >= 0 ? message.order : null;
}

function addMessage(indexes: RendererIndexes, message: ChatMessage, index: number): void {
  const toolUseId = getToolUseId(message);
  if (toolUseId) {
    indexes.toolUseIdToIndex.set(toolUseId, index);
  }
  const order = getAgentOrder(message);
  if (order !== null) {
    indexes.agentMessageOrderToIndex.set(order, index);
  }
  indexes.ids?.add(message.id);
}

function buildIndexes(messages: ChatMessage[]): RendererIndexes {
  const indexes: RendererIndexes = {
    toolUseIdToIndex: new Map(),
    agentMessageOrderToIndex: new Map(),
  };
  messages.forEach((message, index) => addMessage(indexes, message, index));
  return indexes;
}

type TranscriptChange = { type: 'append' } | { type: 'replace'; index: number } | null;

/** Identity comparison only: finds a single appended or replaced message. */
function findSingleChange(previous: ChatMessage[], next: ChatMessage[]): TranscriptChange {
  if (next.length === previous.length + 1) {
    for (let index = 0; index < previous.length; index += 1) {
      if (previous[index] !== next[index]) {
        return null;
      }
    }
    return { type: 'append' };
  }
  if (next.length !== previous.length) {
    return null;
  }
  let changedIndex = -1;
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) {
      if (changedIndex !== -1) {
        return null;
      }
      changedIndex = index;
    }
  }
  return changedIndex === -1 ? null : { type: 'replace', index: changedIndex };
}

function isOrderedAround(messages: ChatMessage[], index: number): boolean {
  const message = messages[index];
  const before = messages[index - 1];
  const after = messages[index + 1];
  if (!message) {
    return false;
  }
  return (
    (!before || compareTranscriptMessageOrder(before, message) <= 0) &&
    (!after || compareTranscriptMessageOrder(message, after) <= 0)
  );
}

function deriveFromPrevious(
  previous: ChatMessage[],
  messages: ChatMessage[],
  limit: number | null
): { retained: ChatMessage[]; indexes: RendererIndexes } | null {
  const cached = transcriptCache.get(previous);
  if (!cached || (limit !== null && (!cached.ordered || messages.length > limit))) {
    return null;
  }
  const change = findSingleChange(previous, messages);
  if (!change) {
    return null;
  }
  const changedIndex = change.type === 'append' ? messages.length - 1 : change.index;
  // Within the limit and still sorted, the renderer trim returns the input unchanged.
  if (limit !== null && !isOrderedAround(messages, changedIndex)) {
    return null;
  }
  const { indexes } = cached;
  const message = messages[changedIndex];
  if (!message) {
    return null;
  }
  if (change.type === 'append') {
    if (batchOwnedIndexes?.has(indexes)) {
      // The previous transcript is an uncommitted batch intermediate; drop its
      // cache entry because its lookups now describe the longer transcript.
      transcriptCache.delete(previous);
      addMessage(indexes, message, changedIndex);
      return { retained: messages, indexes };
    }
    const next: RendererIndexes = {
      toolUseIdToIndex: new Map(indexes.toolUseIdToIndex),
      agentMessageOrderToIndex: new Map(indexes.agentMessageOrderToIndex),
      ids: indexes.ids && new Set(indexes.ids),
    };
    addMessage(next, message, changedIndex);
    batchOwnedIndexes?.add(next);
    return { retained: messages, indexes: next };
  }
  const replaced = previous[changedIndex];
  if (
    !replaced ||
    replaced.id !== message.id ||
    getAgentOrder(replaced) !== getAgentOrder(message) ||
    getToolUseId(replaced) !== getToolUseId(message)
  ) {
    return null;
  }
  return { retained: messages, indexes };
}

/**
 * Applies the renderer trim to `messages` and returns lookups for the result.
 * Equivalent to trimming and rescanning, but O(1) lookup work (plus identity
 * checks) when one message was appended to or replaced in `previous`.
 */
export function resolveRendererTranscript(
  previous: ChatMessage[],
  messages: ChatMessage[],
  limit: number | null
): { retained: ChatMessage[]; indexes: RendererIndexes } {
  const derived = deriveFromPrevious(previous, messages, limit);
  const retained =
    derived?.retained ?? (limit === null ? messages : trimTranscriptForRenderer(messages, limit));
  let indexes = derived?.indexes ?? transcriptCache.get(retained)?.indexes;
  if (!indexes) {
    indexes = buildIndexes(retained);
    batchOwnedIndexes?.add(indexes);
  }
  transcriptCache.set(retained, { indexes, ordered: limit !== null });
  return { retained, indexes };
}

/** The set of message ids in a resolved transcript, built once per array. */
export function getRendererTranscriptIds(
  retained: ChatMessage[],
  indexes: RendererIndexes
): Set<string> {
  if (!indexes.ids) {
    indexes.ids = new Set(retained.map((message) => message.id));
  }
  return indexes.ids;
}
