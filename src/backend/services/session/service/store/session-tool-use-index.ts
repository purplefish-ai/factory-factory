import type { AgentMessage, ChatMessage } from '@/shared/acp-protocol';
import type { SessionStore } from './session-store.types';

/**
 * Per-transcript index of the entries that start or answer each tool-use id.
 *
 * Candidate sets are a superset of the relevant entries: lookups re-validate
 * each candidate against the live transcript, so a stale candidate can only
 * cost time, never change the answer. Entries are counted by reference so an
 * object that appears twice falls back to the linear scan.
 */
interface ToolUseIndex {
  entriesByToolUseId: Map<string, Map<ChatMessage, number>>;
  /** Transcript length after the last indexed write; a mismatch means a write bypassed the helpers. */
  indexedLength: number;
}

// Keyed by the transcript array so replacing `store.transcript` invalidates the index.
const toolUseIndexes = new WeakMap<ChatMessage[], ToolUseIndex>();

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

function isToolUseStart(message: AgentMessage, toolUseId: string): boolean {
  return (
    message.type === 'stream_event' &&
    message.event?.type === 'content_block_start' &&
    message.event.content_block.type === 'tool_use' &&
    message.event.content_block.id === toolUseId
  );
}

/** Every tool-use id this entry could match in `findPersistedToolUseStart`. */
function referencedToolUseIds(entry: ChatMessage | undefined): Set<string> {
  const ids = new Set<string>();
  const message = entry?.source === 'agent' ? entry.message : undefined;
  if (!message) {
    return ids;
  }
  const content = message.message?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'tool_result') {
        ids.add(item.tool_use_id);
      }
    }
  }
  if (message.type === 'stream_event' && message.event?.type === 'content_block_start') {
    const block = message.event.content_block;
    if (block.type === 'tool_result') {
      ids.add(block.tool_use_id);
    } else if (block.type === 'tool_use') {
      ids.add(block.id);
    }
  }
  return ids;
}

function addEntry(index: ToolUseIndex, entry: ChatMessage | undefined): void {
  if (!entry) {
    return;
  }
  for (const toolUseId of referencedToolUseIds(entry)) {
    let entries = index.entriesByToolUseId.get(toolUseId);
    if (!entries) {
      entries = new Map();
      index.entriesByToolUseId.set(toolUseId, entries);
    }
    entries.set(entry, (entries.get(entry) ?? 0) + 1);
  }
}

function removeEntry(index: ToolUseIndex, entry: ChatMessage | undefined): void {
  if (!entry) {
    return;
  }
  for (const toolUseId of referencedToolUseIds(entry)) {
    const entries = index.entriesByToolUseId.get(toolUseId);
    const count = entries?.get(entry);
    if (!(entries && count)) {
      continue;
    }
    if (count > 1) {
      entries.set(entry, count - 1);
    } else if (entries.size > 1) {
      entries.delete(entry);
    } else {
      index.entriesByToolUseId.delete(toolUseId);
    }
  }
}

function buildToolUseIndex(transcript: ChatMessage[]): ToolUseIndex {
  const index: ToolUseIndex = { entriesByToolUseId: new Map(), indexedLength: transcript.length };
  for (const entry of transcript) {
    addEntry(index, entry);
  }
  return index;
}

function getToolUseIndex(store: SessionStore): ToolUseIndex {
  const existing = toolUseIndexes.get(store.transcript);
  if (existing && existing.indexedLength === store.transcript.length) {
    return existing;
  }
  const rebuilt = buildToolUseIndex(store.transcript);
  toolUseIndexes.set(store.transcript, rebuilt);
  return rebuilt;
}

/** Drop the index so the next lookup rebuilds it from the current transcript. */
export function resetToolUseIndex(store: SessionStore): void {
  toolUseIndexes.delete(store.transcript);
}

function recordChange(
  store: SessionStore,
  change: { removed?: ChatMessage; added?: ChatMessage; lengthDelta: number }
): void {
  const index = toolUseIndexes.get(store.transcript);
  if (!index) {
    return; // Never built: the next lookup indexes the current transcript.
  }
  if (index.indexedLength + change.lengthDelta !== store.transcript.length) {
    toolUseIndexes.delete(store.transcript);
    return;
  }
  removeEntry(index, change.removed);
  addEntry(index, change.added);
  index.indexedLength = store.transcript.length;
}

/** Call after `entry` was pushed or spliced into `store.transcript`. */
export function recordTranscriptEntryAdded(store: SessionStore, entry: ChatMessage): void {
  recordChange(store, { added: entry, lengthDelta: 1 });
}

/** Call after `entry` was spliced out of `store.transcript`. */
export function recordTranscriptEntryRemoved(store: SessionStore, entry: ChatMessage): void {
  recordChange(store, { removed: entry, lengthDelta: -1 });
}

/** Call after `previous` was overwritten by `next` at the same position. */
export function recordTranscriptEntryReplaced(
  store: SessionStore,
  previous: ChatMessage,
  next: ChatMessage
): void {
  recordChange(store, { removed: previous, added: next, lengthDelta: 0 });
}

/** Replace a transcript entry's agent message in place, keeping the index in step. */
export function replaceTranscriptEntryMessage(
  store: SessionStore,
  entry: ChatMessage,
  message: AgentMessage
): void {
  recordChange(store, { removed: entry, lengthDelta: 0 });
  entry.message = message;
  recordChange(store, { added: entry, lengthDelta: 0 });
}

function locateEntry(store: SessionStore, entry: ChatMessage): number {
  const indexed = store.transcriptIdToIndex.get(entry.id);
  if (indexed !== undefined && store.transcript[indexed] === entry) {
    return indexed;
  }
  return store.transcript.lastIndexOf(entry);
}

function scanForPersistedToolUseStart(
  store: SessionStore,
  toolUseId: string
): ChatMessage | undefined {
  for (let index = store.transcript.length - 1; index >= 0; index -= 1) {
    const entry = store.transcript[index];
    if (entry?.source !== 'agent' || !entry.message) {
      continue;
    }
    if (hasMatchingToolResult(entry.message, toolUseId)) {
      return undefined;
    }
    if (isToolUseStart(entry.message, toolUseId)) {
      return entry;
    }
  }
  return undefined;
}

function isRelevantEntry(entry: ChatMessage, toolUseId: string): boolean {
  const message = entry.source === 'agent' ? entry.message : undefined;
  return Boolean(
    message && (hasMatchingToolResult(message, toolUseId) || isToolUseStart(message, toolUseId))
  );
}

/**
 * Latest `tool_use` start for `toolUseId` with no later matching result: the
 * same answer as scanning the transcript backwards to the first entry that
 * answers or starts the tool use, without walking the whole transcript.
 */
export function findPersistedToolUseStart(
  store: SessionStore,
  toolUseId: string
): ChatMessage | undefined {
  const candidates = getToolUseIndex(store).entriesByToolUseId.get(toolUseId);
  if (!candidates) {
    return undefined;
  }

  let latest: ChatMessage | undefined;
  let latestPosition = -1;
  for (const [entry, count] of candidates) {
    if (count > 1) {
      return scanForPersistedToolUseStart(store, toolUseId);
    }
    if (!isRelevantEntry(entry, toolUseId)) {
      continue;
    }
    const position = locateEntry(store, entry);
    if (position < 0) {
      candidates.delete(entry); // Left the transcript without being unindexed.
      continue;
    }
    if (position > latestPosition) {
      latest = entry;
      latestPosition = position;
    }
  }

  if (!latest?.message || hasMatchingToolResult(latest.message, toolUseId)) {
    return undefined;
  }
  return latest;
}
