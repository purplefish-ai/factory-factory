import type { ChatMessage, GroupedMessageItem, ToolSequence } from '@/lib/chat-protocol';
import {
  extractToolResultInfo,
  filterDuplicateResultMessages,
  groupAdjacentToolCalls,
  isToolResultMessage,
  isToolSequence,
  isToolUseMessage,
} from '@/lib/chat-protocol';

export interface IncrementalChatGroupingOptions {
  filterDuplicateResults?: boolean;
}

interface GroupedSegment {
  item: GroupedMessageItem;
  start: number;
}

interface GroupingSnapshot {
  messages: ChatMessage[];
  grouped: GroupedMessageItem[];
  segments: GroupedSegment[];
}

export interface IncrementalChatGrouper {
  /** Replace the array and changed messages for edits; same-reference length changes are supported. */
  group: (messages: ChatMessage[]) => GroupedMessageItem[];
}

function isRenderableMessage(message: ChatMessage): boolean {
  return (
    message.source !== 'agent' ||
    message.message?.type !== 'result' ||
    (typeof message.message.result === 'string' && message.message.result.trim().length > 0)
  );
}

function isToolMessage(message: ChatMessage | undefined): boolean {
  return Boolean(
    message?.message && (isToolUseMessage(message.message) || isToolResultMessage(message.message))
  );
}

function commonPrefixLength(previous: ChatMessage[], next: ChatMessage[]): number {
  const limit = Math.min(previous.length, next.length);
  let index = 0;
  while (index < limit && previous[index] === next[index]) {
    index += 1;
  }
  return index;
}

function rewindToolRun(messages: ChatMessage[], index: number): number {
  if (!isToolMessage(messages[index])) {
    return index;
  }
  let start = index;
  while (start > 0 && isToolMessage(messages[start - 1])) {
    start -= 1;
  }
  return start;
}

function findMessageIndex(
  messages: ChatMessage[],
  item: GroupedMessageItem,
  fromIndex: number
): number {
  if (!isToolSequence(item)) {
    for (let index = fromIndex; index < messages.length; index += 1) {
      if (messages[index] === item) {
        return index;
      }
    }
    return -1;
  }
  for (let index = fromIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (message && isToolMessage(message) && `tool-seq-${message.id}` === item.id) {
      return index;
    }
  }
  return -1;
}

function deriveSegments(messages: ChatMessage[], grouped: GroupedMessageItem[]): GroupedSegment[] {
  const segments: GroupedSegment[] = [];
  let cursor = 0;
  for (const item of grouped) {
    const start = findMessageIndex(messages, item, cursor);
    if (start < 0) {
      return [];
    }
    segments.push({ item, start });
    cursor = start + 1;
  }
  return segments;
}

function sameToolSequence(left: ToolSequence, right: ToolSequence): boolean {
  if (left.id !== right.id || left.pairedCalls.length !== right.pairedCalls.length) {
    return false;
  }
  return left.pairedCalls.every((call, index) => {
    const other = right.pairedCalls[index];
    return (
      other !== undefined &&
      call.id === other.id &&
      call.name === other.name &&
      call.input === other.input &&
      call.status === other.status &&
      call.result?.content === other.result?.content &&
      call.result?.isError === other.result?.isError
    );
  });
}

function reuseToolSequencesByAnchor(
  previous: GroupingSnapshot,
  messages: ChatMessage[],
  grouped: GroupedMessageItem[],
  nextSegments: GroupedSegment[],
  previousSegments = previous.segments
): GroupedMessageItem[] {
  const previousByAnchor = new Map<ChatMessage, ToolSequence>();
  for (const segment of previousSegments) {
    if (isToolSequence(segment.item)) {
      const anchor = previous.messages[segment.start];
      if (anchor) {
        previousByAnchor.set(anchor, segment.item);
      }
    }
  }

  return grouped.map((item, index) => {
    if (!isToolSequence(item)) {
      return item;
    }
    const segment = nextSegments[index];
    const anchor = segment ? messages[segment.start] : undefined;
    const previousItem = anchor ? previousByAnchor.get(anchor) : undefined;
    return previousItem && sameToolSequence(previousItem, item) ? previousItem : item;
  });
}

function hasChangedHistoricalToolResult(
  previous: ChatMessage[],
  next: ChatMessage[],
  commonPrefix: number
): boolean {
  const oldChanged = previous.slice(commonPrefix).some(isToolMessageResult);
  const nextChangedBeforeOldEnd = next
    .slice(commonPrefix, previous.length)
    .some(isToolMessageResult);
  return oldChanged || nextChangedBeforeOldEnd;
}

function rewindCrossesHistoricalToolResult(
  previous: ChatMessage[],
  next: ChatMessage[],
  commonPrefix: number
): boolean {
  const recomputeStart = Math.min(
    rewindToolRun(previous, commonPrefix),
    rewindToolRun(next, commonPrefix)
  );
  return (
    rangeContainsToolResult(previous, recomputeStart, commonPrefix) ||
    rangeContainsToolResult(next, recomputeStart, commonPrefix)
  );
}

function rangeContainsToolResult(messages: ChatMessage[], start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    const message = messages[index];
    if (message && isToolMessageResult(message)) {
      return true;
    }
  }
  return false;
}

function isToolMessageResult(message: ChatMessage): boolean {
  return Boolean(message.message && isToolResultMessage(message.message));
}

function prepareMessages(messages: ChatMessage[], filterDuplicateResults: boolean): ChatMessage[] {
  const deduplicated = filterDuplicateResults ? filterDuplicateResultMessages(messages) : messages;
  return deduplicated.filter(isRenderableMessage);
}

function createFullSnapshot(
  messages: ChatMessage[],
  previous?: GroupingSnapshot
): GroupingSnapshot {
  const freshlyGrouped = groupAdjacentToolCalls(messages);
  const freshSegments = deriveSegments(messages, freshlyGrouped);
  const grouped = previous
    ? reuseToolSequencesByAnchor(previous, messages, freshlyGrouped, freshSegments)
    : freshlyGrouped;
  const segments = freshSegments.map((segment, index) => ({
    ...segment,
    item: grouped[index] ?? segment.item,
  }));
  return { messages, grouped, segments };
}

function collectToolResultIds(messages: ChatMessage[], fromIndex: number): Set<string> {
  const resultIds = new Set<string>();
  for (let index = fromIndex; index < messages.length; index += 1) {
    const agentMessage = messages[index]?.message;
    const result = agentMessage ? extractToolResultInfo(agentMessage) : null;
    if (result) {
      resultIds.add(result.toolUseId);
    }
  }
  return resultIds;
}

function collectAffectedPendingIds(
  snapshot: GroupingSnapshot,
  resultIds: Set<string>
): Set<string> {
  const affectedIds = new Set<string>();
  for (const segment of snapshot.segments) {
    if (!isToolSequence(segment.item)) {
      continue;
    }
    for (const call of segment.item.pairedCalls) {
      if (call.status === 'pending' && resultIds.has(call.id)) {
        affectedIds.add(call.id);
      }
    }
  }
  return affectedIds;
}

function findEarliestSequenceStart(
  snapshot: GroupingSnapshot,
  affectedIds: Set<string>
): number | undefined {
  for (const segment of snapshot.segments) {
    if (
      isToolSequence(segment.item) &&
      segment.item.pairedCalls.some((call) => affectedIds.has(call.id))
    ) {
      return segment.start;
    }
  }
  return undefined;
}

function findLateResultRecomputeStart(
  snapshot: GroupingSnapshot,
  messages: ChatMessage[],
  fromIndex: number
): number | undefined {
  const resultIds = collectToolResultIds(messages, fromIndex);
  const affectedIds = collectAffectedPendingIds(snapshot, resultIds);
  return findEarliestSequenceStart(snapshot, affectedIds);
}

function createIncrementalSnapshot(
  previous: GroupingSnapshot,
  messages: ChatMessage[],
  commonPrefix: number
): GroupingSnapshot {
  let recomputeStart = Math.min(
    rewindToolRun(previous.messages, commonPrefix),
    rewindToolRun(messages, commonPrefix)
  );
  const lateResultStart = findLateResultRecomputeStart(previous, messages, recomputeStart);
  if (lateResultStart !== undefined) {
    recomputeStart = Math.min(recomputeStart, lateResultStart);
  }
  if (
    rangeContainsToolResult(previous.messages, recomputeStart, commonPrefix) ||
    rangeContainsToolResult(messages, recomputeStart, commonPrefix)
  ) {
    return createFullSnapshot(messages, previous);
  }

  const reusable = previous.segments.filter((segment) => segment.start < recomputeStart);
  const suffixMessages = messages.slice(recomputeStart);
  const freshlyGroupedSuffix = groupAdjacentToolCalls(suffixMessages);
  const freshSuffixSegments = deriveSegments(suffixMessages, freshlyGroupedSuffix).map(
    (segment) => ({ ...segment, start: segment.start + recomputeStart })
  );
  const previousSuffix = previous.segments.slice(reusable.length);
  const groupedSuffix = reuseToolSequencesByAnchor(
    previous,
    messages,
    freshlyGroupedSuffix,
    freshSuffixSegments,
    previousSuffix
  );
  const suffixSegments = freshSuffixSegments.map((segment, index) => ({
    ...segment,
    item: groupedSuffix[index] ?? segment.item,
  }));
  const grouped = [...reusable.map((segment) => segment.item), ...groupedSuffix];
  return { messages, grouped, segments: [...reusable, ...suffixSegments] };
}

export function createIncrementalChatGrouper(
  options: IncrementalChatGroupingOptions = {}
): IncrementalChatGrouper {
  const filterDuplicateResults = options.filterDuplicateResults ?? false;
  let snapshot: GroupingSnapshot | undefined;
  let previousInput: ChatMessage[] | undefined;
  let previousInputLength = 0;

  return {
    group(messages) {
      if (snapshot && messages === previousInput && messages.length === previousInputLength) {
        return snapshot.grouped;
      }

      const prepared = prepareMessages(messages, filterDuplicateResults);
      if (!snapshot) {
        snapshot = createFullSnapshot(prepared);
      } else {
        const commonPrefix = commonPrefixLength(snapshot.messages, prepared);
        if (commonPrefix !== snapshot.messages.length || commonPrefix !== prepared.length) {
          const canReusePrefix =
            commonPrefix > 0 &&
            snapshot.segments.length === snapshot.grouped.length &&
            !hasChangedHistoricalToolResult(snapshot.messages, prepared, commonPrefix) &&
            !rewindCrossesHistoricalToolResult(snapshot.messages, prepared, commonPrefix);
          snapshot = canReusePrefix
            ? createIncrementalSnapshot(snapshot, prepared, commonPrefix)
            : createFullSnapshot(prepared, snapshot);
        }
      }

      previousInput = messages;
      previousInputLength = messages.length;
      return snapshot.grouped;
    },
  };
}
