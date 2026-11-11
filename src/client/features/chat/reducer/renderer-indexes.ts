import type { ChatMessage } from '@/lib/chat-protocol';
import {
  compareTranscriptMessageOrder,
  getToolUseIdFromEvent,
  isSafeRendererWindowStart,
  isStreamEventMessage,
  trimTranscriptForRenderer,
} from '@/lib/chat-protocol';

/** Lookups derived from one renderer transcript array. */
export interface RendererIndexes {
  toolUseIdToIndex: Map<string, number>;
  agentMessageOrderToIndex: Map<number, number>;
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

/**
 * Extra messages a full renderer window may hold before it is trimmed back to
 * the limit. Trimming the front changes every index and grouping position, so
 * trimming on each append at the limit made every later message pay for full
 * rebuilds; with slack, that cost is paid once per `slack` appends.
 */
export function getRendererTrimSlack(limit: number): number {
  return Math.floor(limit / 10);
}

/**
 * The renderer trim with hysteresis. Within the limit it matches
 * `trimTranscriptForRenderer`. Above the limit but within the slack it keeps
 * the previous window start if that start is render-safe, so appends leave the
 * front untouched while messages that sort before the start are still dropped,
 * as a strict trim would. Otherwise it trims back to the limit at a render-safe
 * start.
 */
function trimRendererWindow(
  previous: ChatMessage[],
  messages: ChatMessage[],
  limit: number
): ChatMessage[] {
  if (messages.length > limit + getRendererTrimSlack(limit)) {
    return trimTranscriptForRenderer(messages, limit);
  }
  // A limit of at least the length only sorts.
  const sorted = trimTranscriptForRenderer(messages, messages.length);
  if (sorted.length <= limit) {
    return sorted;
  }
  const startId = previous[0]?.id;
  const startIndex = sorted.findIndex((message) => message.id === startId);
  const start = sorted[startIndex];
  if (!start || sorted.length - startIndex < limit || !isSafeRendererWindowStart(start)) {
    return trimTranscriptForRenderer(sorted, limit);
  }
  return startIndex === 0 ? sorted : sorted.slice(startIndex);
}

/**
 * Whether `trimRendererWindow` returns `messages` unchanged after an append or
 * same-id replacement at `changedIndex`, which keeps the first message: the
 * window is within the slack, still sorted, and render-safe once over the limit.
 */
function keepsRendererWindow(
  messages: ChatMessage[],
  changedIndex: number,
  limit: number
): boolean {
  if (messages.length > limit + getRendererTrimSlack(limit)) {
    return false;
  }
  if (!isOrderedAround(messages, changedIndex)) {
    return false;
  }
  const start = messages[0];
  return messages.length <= limit || (start !== undefined && isSafeRendererWindowStart(start));
}

function deriveFromPrevious(
  previous: ChatMessage[],
  messages: ChatMessage[],
  limit: number | null
): { retained: ChatMessage[]; indexes: RendererIndexes } | null {
  const cached = transcriptCache.get(previous);
  if (!cached || (limit !== null && !cached.ordered)) {
    return null;
  }
  const change = findSingleChange(previous, messages);
  if (!change) {
    return null;
  }
  const changedIndex = change.type === 'append' ? messages.length - 1 : change.index;
  if (limit !== null && !keepsRendererWindow(messages, changedIndex, limit)) {
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
 * Applies the renderer trim (with hysteresis relative to `previous`) to
 * `messages` and returns lookups for the result.
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
    derived?.retained ??
    (limit === null ? messages : trimRendererWindow(previous, messages, limit));
  let indexes = derived?.indexes ?? transcriptCache.get(retained)?.indexes;
  if (!indexes) {
    indexes = buildIndexes(retained);
    batchOwnedIndexes?.add(indexes);
  }
  transcriptCache.set(retained, { indexes, ordered: limit !== null });
  return { retained, indexes };
}
